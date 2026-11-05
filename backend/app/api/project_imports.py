"""Импорт Excel с предпросмотром, сопоставлением столбцов и подтверждением."""

import hashlib
import json
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO
from uuid import uuid4
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from openpyxl import load_workbook
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.reports import actor
from app.core import cache
from app.db import get_db
from app.deps import require_roles
from app.import_faktura import MONTHS, _created_at, _match, _reference, import_rows, lock_imports, norm
from app.models import ProjectImport, Role, User
from app.services import audit

router = APIRouter(prefix="/project-imports", tags=["imports"])
MAX_BYTES = 10 * 1024 * 1024
FIELDS = ["Клиент", "Описание проекта", "Этап", "Сегмент", "Услуга крупно", "Менеджер", "Столбец1",
          "Год реализации", "Дата", "Тип платежа", "Принимаемый к оценке", "Отраслевое решени",
          "Отраслевой менеджер", "№ проекта ПО", "Статус", "Что сделано за 14 дней", "План на 2 недели", *MONTHS]


def admin(db, user):
    user = actor(db, user)
    if user.role != Role.admin:
        raise HTTPException(403, "Импорт доступен администратору")
    return user


@router.post("/preview")
async def preview(
    request: Request, filename: str = Query(max_length=200), header_row: int = Query(3, ge=1, le=30),
    sheet: str = Query("Список проектов", max_length=100), mapping: str = Query("{}", max_length=5000),
    vat_included: bool = False,
    db: Session = Depends(get_db), user: User = Depends(require_roles(Role.admin)),
):
    user = admin(db, user)
    lock_imports(db)
    db.execute(update(ProjectImport).where(
        ProjectImport.created_at < datetime.now(UTC) - timedelta(days=7),
        ProjectImport.status.in_(["preview", "invalid"]),
    ).values(status="expired", source_rows=[]))
    pending = select(func.count()).select_from(ProjectImport).where(
        ProjectImport.status.in_(["preview", "invalid"]),
    )
    if db.scalar(pending.where(ProjectImport.owner_id == user.id)) >= 20 or db.scalar(pending) >= 100:
        raise HTTPException(429, "Достигнут лимит загрузок за неделю. Подтвердите файлы или повторите позже")
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(422, "Выберите файл XLSX")
    try:
        aliases = json.loads(mapping)
        if not isinstance(aliases, dict) or any(k not in FIELDS or not isinstance(v, str) for k, v in aliases.items()):
            raise ValueError
    except (ValueError, TypeError):
        raise HTTPException(422, "Некорректное сопоставление столбцов") from None
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BYTES:
            raise HTTPException(413, "Размер файла не должен превышать 10 МБ")
    try:
        with ZipFile(BytesIO(raw)) as zipped:
            if len(zipped.infolist()) > 2000 or sum(i.file_size for i in zipped.infolist()) > 40 * 1024 * 1024:
                raise HTTPException(413, "Распакованный файл слишком велик")
        book = load_workbook(BytesIO(raw), read_only=True, data_only=True)
    except (BadZipFile, ValueError, KeyError, OSError, ParseError):
        raise HTTPException(422, "Не удалось прочитать XLSX") from None
    if sheet not in book.sheetnames:
        names = ", ".join(book.sheetnames)
        book.close()
        raise HTTPException(422, f"Лист не найден. Доступны: {names}")
    ws = book[sheet]
    if (ws.max_row or 0) > 5000 + header_row or (ws.max_column or 0) > 100:
        book.close()
        raise HTTPException(422, "Допускается до 5000 строк и 100 столбцов")
    try:
        # Ограничиваем чтение независимо от размеров, записанных в метаданных XLSX.
        values_rows = list(ws.iter_rows(min_row=header_row, max_row=header_row + 5001,
                                       max_col=101, values_only=True))
    except (ValueError, KeyError, ParseError, OSError):
        raise HTTPException(422, "Не удалось прочитать строки XLSX") from None
    finally:
        book.close()
    if any(row[100] is not None for row in values_rows) or (
        len(values_rows) > 5001 and any(v is not None for v in values_rows[5001])
    ):
        raise HTTPException(422, "Допускается до 5000 строк и 100 столбцов")
    iterator = iter(values_rows)
    headers = [norm(v) for v in next(iterator, ())[:100]]
    problems = []
    for key in ["Клиент", "Описание проекта", "Этап"]:
        if headers.count(aliases.get(key, key)) != 1:
            problems.append({"row": header_row, "message": f"Выберите однозначный столбец «{key}»"})
    for key in FIELDS:
        chosen = aliases.get(key, key)
        if chosen and headers.count(chosen) > 1 and key not in ["Клиент", "Описание проекта", "Этап"]:
            problems.append({"row": header_row, "message": f"Столбец «{chosen}» повторяется"})
    stages = _reference(db, "customer_stage")
    rows = []
    for number, values in enumerate(iterator, header_row + 1):
        if not any(v is not None and v != "" for v in values):
            continue
        raw_row = dict(zip(headers, values, strict=False))
        row = {key: raw_row.get(aliases.get(key, key)) for key in FIELDS}
        row.update(_source_row=number, _source_file=filename, _vat_included=vat_included)
        try:
            for key, limit in [("Клиент", 300), ("Описание проекта", 300)]:
                if not norm(row[key]) or len(norm(row[key])) > limit:
                    raise ValueError(f"«{key}»: требуется текст до {limit} символов")
            if _match(stages, row["Этап"]) is None:
                raise ValueError("Этап не найден в справочнике")
            year_text = str(row.get("Год реализации") or datetime.now(UTC).year)
            if Decimal(year_text) != int(Decimal(year_text)):
                raise ValueError("Год реализации должен быть целым числом")
            year = int(Decimal(year_text))
            if not 1900 <= year <= 2200:
                raise ValueError("Год реализации должен быть от 1900 до 2200")
            row["Год реализации"] = year
            source_date = row.get("Дата")
            if source_date:
                if not isinstance(source_date, str | date):
                    raise ValueError("Некорректная дата: используйте дату Excel или ГГГГ-ММ-ДД")
                row["Дата"] = _created_at(source_date).isoformat()
            for key, limit in [("Услуга крупно", 100), ("Менеджер", 200), ("Сегмент", 100),
                               ("Отраслевой менеджер", 200), ("№ проекта ПО", 100)]:
                if len(norm(row.get(key))) > limit:
                    raise ValueError(f"«{key}»: не более {limit} символов")
            amounts = [Decimal(str(row[m] or 0)) for m in MONTHS]
            if any(not a.is_finite() or a < 0 or a.as_tuple().exponent < -3 for a in amounts):
                raise ValueError("Месячные суммы должны быть неотрицательными, до трёх знаков после запятой")
            if sum(amounts) * 1000 > Decimal("999999999999.99"):
                raise ValueError("Превышена допустимая сумма проекта")
            for m, amount in zip(MONTHS, amounts, strict=True):
                row[m] = str(amount)
            for key in FIELDS:
                if isinstance(row.get(key), str) and len(row[key]) > 2000:
                    raise ValueError(f"Слишком длинное значение «{key}»")
            rows.append(jsonable_encoder(row))
        except (ValueError, InvalidOperation, OverflowError) as exc:
            problems.append({"row": number, "message": str(exc) or "Некорректная сумма"})
    if not rows and not problems:
        problems.append({"row": header_row, "message": "В файле нет проектов"})
    result = {"rows": len(rows), "errors": problems, "headers": [h for h in headers if h], "fields": FIELDS,
              "preview": [{"row": r["_source_row"], "client": norm(r["Клиент"]),
                           "name": norm(r["Описание проекта"]), "stage": norm(r["Этап"])} for r in rows[:50]]}
    item = ProjectImport(id=str(uuid4()), owner_id=user.id, filename=filename,
                         checksum=hashlib.sha256(raw).hexdigest(), status="invalid" if problems else "preview",
                         source_rows=rows, result=result)
    db.add(item)
    audit.record(db, user.id, "preview", "project_import", None, import_id=item.id,
                 filename=filename, checksum=item.checksum, rows=len(rows), errors=len(problems))
    db.commit()
    return {"id": item.id, "status": item.status, **result}


@router.post("/{import_id}/commit")
def commit(import_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.admin))):
    user = admin(db, user)
    lock_imports(db)
    item = db.scalar(select(ProjectImport).where(ProjectImport.id == import_id).with_for_update())
    if item is None or item.owner_id != user.id:
        raise HTTPException(404, "Загрузка не найдена")
    if item.status == "completed":
        return item.result
    if item.status != "preview":
        raise HTTPException(422, "Исправьте ошибки и повторите предпросмотр")
    created_at = item.created_at.replace(tzinfo=UTC) if item.created_at.tzinfo is None else item.created_at
    if created_at < datetime.now(UTC) - timedelta(days=7):
        raise HTTPException(422, "Срок предпросмотра истёк. Повторите проверку файла")
    # Импорт и журнал подтверждения сохраняются одной транзакцией.
    result = asdict(import_rows(db, item.source_rows, user, commit=False))
    item.status = "completed"
    item.result = result
    item.source_rows = []
    audit.record(db, user.id, "commit", "project_import", None, import_id=item.id,
                 filename=item.filename, checksum=item.checksum, **result)
    db.commit()
    cache.bump("analytics")
    cache.bump("refs")
    return result


@router.get("")
def history(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.admin))):
    admin(db, user)
    items = db.scalars(select(ProjectImport).order_by(ProjectImport.created_at.desc()).limit(100)).all()
    return {"items": [{"id": i.id, "filename": i.filename, "status": i.status, "created_at": i.created_at,
                       "result": {k: v for k, v in i.result.items() if k not in {"headers", "fields", "preview"}}}
                      for i in items]}
