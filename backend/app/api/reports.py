from datetime import UTC, datetime
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from openpyxl import Workbook
from sqlalchemy import delete, func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import ReportDefinition, ReportSnapshot, Role, User
from app.report_schemas import (
    Definition,
    DuplicateInput,
    PreviewInput,
    PublishInput,
    ReportInput,
    ReportUpdate,
    RunInput,
    SnapshotPage,
)
from app.services import audit
from app.services import report_builder as builder

router = APIRouter(tags=["reports"])


def actor(db: Session, user: User) -> User:
    """Сериализует смену роли и создание снимков, повторно проверяя сессию."""
    version = user.auth_version
    locked = db.scalar(
        select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True)
    )
    if locked is None or not locked.is_active or locked.auth_version != version:
        raise HTTPException(401, "Требуется вход в систему")
    return locked


def editor(user):
    if user.role not in (Role.admin, Role.analyst):
        raise HTTPException(403, "Недостаточно прав")


def with_timeout_handling(db, operation):
    try:
        return operation()
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) in {"57014", "55P03", "40P01"}:
            db.rollback()
            raise HTTPException(503, "Отчёт временно недоступен; повторите запрос") from None
        raise


def visible(db, user, report_id, write=False):
    report = db.scalar(
        select(ReportDefinition)
        .where(ReportDefinition.id == report_id)
        .with_for_update(read=not write)
        .execution_options(populate_existing=True)
    )
    if (
        report is None
        or (user.role == Role.user and not report.published)
        or (user.role == Role.analyst and report.owner_id != user.id and not report.published)
    ):
        raise HTTPException(404, "Отчёт не найден")
    if write and user.role != Role.admin and report.owner_id != user.id:
        raise HTTPException(404, "Отчёт не найден")
    return report


def out(report):
    return {
        key: getattr(report, key)
        for key in ("id", "title", "owner_id", "definition", "published", "version", "created_at", "updated_at")
    }


def record(db, user, action, report, before=None):
    audit.record(
        db,
        user.id,
        action,
        "report_definition",
        report.id,
        title=report.title,
        published=report.published,
        version=report.version,
        before=before,
        after={
            "title": report.title,
            "definition": report.definition,
            "published": report.published,
            "version": report.version,
        },
        author_name=user.full_name,
    )


@router.get("/report-fields")
def fields(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    actor(db, user)
    return {"fields": builder.registry(db)}


@router.get("/reports")
def list_reports(
    offset: int = Query(0, ge=0, le=2**53 - 1),
    limit: int = Query(100, ge=1, le=200),
    published: bool | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user = actor(db, user)
    stmt = select(ReportDefinition)
    if user.role == Role.user:
        stmt = stmt.where(ReportDefinition.published.is_(True))
    elif user.role == Role.analyst:
        stmt = stmt.where((ReportDefinition.published.is_(True)) | (ReportDefinition.owner_id == user.id))
    if published is not None:
        stmt = stmt.where(ReportDefinition.published.is_(published))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = db.scalars(stmt.order_by(ReportDefinition.id).offset(offset).limit(limit)).all()
    return {"items": [out(item) for item in items], "total": total, "offset": offset, "limit": limit}


@router.post("/reports", status_code=201)
def create(data: ReportInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    editor(user)
    builder.validate(data.definition)
    report = ReportDefinition(
        title=data.title, owner_id=user.id, definition=data.definition.model_dump(), published=False
    )
    db.add(report)
    db.flush()
    record(db, user, "create", report)
    db.commit()
    db.refresh(report)
    return out(report)


@router.post("/reports/preview")
def preview(data: PreviewInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    editor(user)
    return with_timeout_handling(db, lambda: builder.make_snapshot(db, user, data.definition))


@router.get("/reports/{report_id}")
def get_report(report_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return out(visible(db, actor(db, user), report_id))


@router.put("/reports/{report_id}")
def update_report(
    report_id: int, data: ReportUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    user = actor(db, user)
    editor(user)
    report = visible(db, user, report_id, write=True)
    if report.version != data.version:
        raise HTTPException(409, "Отчёт изменён; обновите данные")
    builder.validate(data.definition)
    before = {
        "title": report.title,
        "definition": report.definition,
        "published": report.published,
        "version": report.version,
    }
    report.title = data.title
    report.definition = data.definition.model_dump()
    report.version += 1
    record(db, user, "update", report, before)
    db.commit()
    db.refresh(report)
    return out(report)


@router.post("/reports/{report_id}/duplicate", status_code=201)
def duplicate(
    report_id: int, data: DuplicateInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    user = actor(db, user)
    editor(user)
    source = visible(db, user, report_id)
    report = ReportDefinition(title=data.title, owner_id=user.id, definition=source.definition, published=False)
    db.add(report)
    db.flush()
    record(db, user, "duplicate", report)
    db.commit()
    db.refresh(report)
    return out(report)


@router.post("/reports/{report_id}/publish")
def publish(report_id: int, data: PublishInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    editor(user)
    report = visible(db, user, report_id, write=True)
    if report.version != data.version:
        raise HTTPException(409, "Отчёт изменён; обновите данные")
    if report.published != data.published:
        before = {
            "title": report.title,
            "definition": report.definition,
            "published": report.published,
            "version": report.version,
        }
        report.published = data.published
        report.version += 1
        record(db, user, "publish" if data.published else "unpublish", report, before)
    db.commit()
    db.refresh(report)
    return out(report)


@router.delete("/reports/{report_id}", status_code=204)
def delete_report(
    report_id: int,
    version: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user = actor(db, user)
    editor(user)
    report = visible(db, user, report_id, write=True)
    if report.version != version:
        raise HTTPException(409, "Отчёт изменён; обновите данные")
    record(db, user, "delete", report)
    db.delete(report)
    db.commit()
    return Response(status_code=204)


@router.post("/reports/{report_id}/run")
def run(report_id: int, data: RunInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)

    def execute():
        builder.lock_quota(db)
        report = visible(db, user, report_id)
        if report.version != data.version:
            raise HTTPException(409, "Отчёт изменён; обновите данные")
        try:
            definition = Definition.model_validate(report.definition)
            builder.validate(definition)
        except ValueError:
            raise HTTPException(422, "Определение отчёта недопустимо") from None
        return builder.make_snapshot(
            db, user, definition, report.id, report.version, quota_locked=True, title=report.title
        )

    return with_timeout_handling(db, execute)


@router.delete("/report-snapshots", status_code=204)
def delete_own_snapshots(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    db.execute(delete(ReportSnapshot).where(ReportSnapshot.owner_id == user.id))
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "private, no-store"})


@router.delete("/report-snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(snapshot_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user = actor(db, user)
    item = db.get(ReportSnapshot, snapshot_id)
    if item is None or item.owner_id != user.id:
        raise HTTPException(404, "Снимок недоступен")
    db.delete(item)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "private, no-store"})


def snapshot(db, user, snapshot_id):
    builder.set_snapshot_timeouts(db)
    item = db.get(ReportSnapshot, snapshot_id)
    now = datetime.now(UTC)
    if item is None or item.owner_id != user.id or item.owner_role != user.role.value:
        raise HTTPException(404, "Снимок недоступен")
    expires = item.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires <= now:
        raise HTTPException(404, "Снимок недоступен")
    if item.report_id is not None:
        visible(db, user, item.report_id)
    elif user.role == Role.user:
        raise HTTPException(404, "Снимок недоступен")
    builder.lock_projects(db, user, item.project_ids)
    return item


@router.get("/report-snapshots/{snapshot_id}", response_model=SnapshotPage)
def page(
    snapshot_id: str,
    response: Response,
    offset: int = Query(0, ge=0, le=10000),
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = with_timeout_handling(db, lambda: snapshot(db, actor(db, user), snapshot_id))
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "snapshot_id": item.id,
        "title": item.title,
        "columns": item.columns,
        "rows": item.rows[offset : offset + limit],
        "total": len(item.rows),
        "offset": offset,
        "limit": limit,
        "expires_at": item.expires_at,
        "report_version": item.report_version,
        "metadata": item.print_metadata,
    }


@router.get("/report-snapshots/{snapshot_id}/export")
def export(snapshot_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    def authorized_snapshot():
        current = actor(db, user)
        item = snapshot(db, current, snapshot_id)
        editor(current)
        return item

    item = with_timeout_handling(db, authorized_snapshot)
    wb = Workbook(write_only=True)
    wb.properties.title = item.title
    ws = wb.create_sheet("Отчёт")
    from openpyxl.cell import WriteOnlyCell

    def safe(value):
        cell = WriteOnlyCell(ws, value=value)
        if isinstance(value, str):
            cell.data_type = "s"
        return cell

    ws.append([safe(col["label"]) for col in item.columns])
    for row in item.rows:
        ws.append([safe(row[col["id"]]) for col in item.columns])
    buffer = BytesIO()
    wb.save(buffer)
    return Response(
        buffer.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="report.xlsx"', "Cache-Control": "private, no-store"},
    )
