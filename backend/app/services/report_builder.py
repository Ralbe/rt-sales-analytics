"""Закрытый реестр и ограниченная выборка отчётов без пользовательского SQL."""

import enum
import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import aliased

from app.models import (
    STAGE_LABELS,
    Client,
    Project,
    ReferenceValue,
    ReportSnapshot,
    ReportSnapshotQuota,
    Role,
    Segment,
    Service,
    Stage,
    User,
)
from app.models import ProjectFinancialEntry as Finance
from app.report_schemas import Definition
from app.services.project_field_labels import effective_project_field_labels, project_field_heading

MAX_ROWS = 10000
MAX_BYTES = 10 * 1024 * 1024
MAX_SNAPSHOTS = 5
MAX_GLOBAL_SNAPSHOTS = 100
TTL = timedelta(minutes=30)

stage_ref = aliased(ReferenceValue, name="report_stage")
payment_ref = aliased(ReferenceValue, name="report_payment")
indicator_ref = aliased(ReferenceValue, name="report_indicator")
assessment_ref = aliased(ReferenceValue, name="report_assessment")
status_ref = aliased(ReferenceValue, name="report_finance_status")
article_ref = aliased(ReferenceValue, name="report_finance_article")
type_ref = aliased(ReferenceValue, name="report_finance_type")
manager = aliased(User, name="report_manager")


@dataclass(frozen=True)
class FieldSpec:
    expression: object
    type: str
    label: str
    label_key: str | None = None
    financial: bool = False


FIELDS: dict[str, FieldSpec] = {}
CHOICES = {
    "project.stage": {stage.value: label for stage, label in STAGE_LABELS.items()},
    "project.stage_scheme": {"legacy": "Прежняя схема", "customer": "Этапы по ТЗ"},
    "financial.kind": {"revenue": "Выручка", "cost": "Затраты"},
}


def register(key, expression, kind, label, label_key=None, financial=False):
    FIELDS[key] = FieldSpec(expression, kind, label, label_key, financial)


for name, kind, label in [
    ("id", "integer", "ID"),
    ("name", "string", "Название проекта"),
    ("description", "string", "Суть проекта"),
    ("client_id", "integer", "ID клиента"),
    ("manager_id", "integer", "ID ответственного"),
    ("service_id", "integer", "ID услуги"),
    ("stage_scheme", "string", "Схема этапов"),
    ("stage", "string", "Стадия системы"),
    ("amount", "decimal", "Сумма контракта"),
    ("cost", "decimal", "Себестоимость"),
    ("probability", "integer", "Вероятность"),
    ("start_date", "date", "Дата начала"),
    ("expected_close_date", "date", "Плановое закрытие"),
    ("closed_at", "date", "Дата закрытия"),
    ("payment_type_id", "integer", "ID типа платежа"),
    ("customer_stage_id", "integer", "ID этапа по ТЗ"),
    ("indicator_id", "integer", "ID индикатора"),
    ("accepted_for_forecast", "boolean", "Принимаемый к прогнозу"),
    ("assessment_status_id", "integer", "ID статуса оценки"),
    ("subsidiary_implementation", "boolean", "Реализация через ДЗО"),
    ("management_control", "boolean", "Контроль руководства"),
    ("is_industry_solution", "boolean", "Отраслевое решение"),
    ("industry_manager", "string", "Отраслевой менеджер"),
    ("industry_project_number", "string", "Номер отраслевого проекта"),
    ("implementation_year", "integer", "Год реализации"),
    ("project_status", "string", "Статус проекта"),
    ("realized_work", "string", "Сделано за период"),
    ("period_plan", "string", "Планы на период"),
    ("archived_at", "datetime", "Архивирование"),
    ("archived_by_id", "integer", "ID архивировавшего"),
    ("created_at", "datetime", "Дата создания"),
    ("updated_at", "datetime", "Дата изменения"),
]:
    # ID справочника и его человекочитаемое имя имеют разные подписи.
    label_key = (
        name
        if name
        not in {
            "client_id",
            "manager_id",
            "service_id",
            "payment_type_id",
            "customer_stage_id",
            "indicator_id",
            "assessment_status_id",
        }
        else None
    )
    register("project." + name, getattr(Project, name), kind, label, label_key)

for key, expr, kind, label, label_key in [
    ("client.id", Client.id, "integer", "ID клиента", None),
    ("client.name", Client.name, "string", "Клиент", "client_id"),
    ("client.inn", Client.inn, "string", "ИНН", "client_inn"),
    ("segment.id", Segment.id, "integer", "ID сегмента", None),
    ("segment.name", Segment.name, "string", "Сегмент", "segment"),
    ("service.name", Service.name, "string", "Услуга", "service_id"),
    ("service.group_name", Service.group_name, "string", "Группа услуг", "service_group"),
    ("manager.name", manager.full_name, "string", "Ответственный", "manager_id"),
    ("customer_stage.name", stage_ref.name, "string", "Этап по ТЗ", "customer_stage_id"),
    ("payment_type.name", payment_ref.name, "string", "Тип платежа", "payment_type_id"),
    ("indicator.name", indicator_ref.name, "string", "Индикатор проекта", "indicator_id"),
    ("assessment_status.name", assessment_ref.name, "string", "Статус оценки", "assessment_status_id"),
]:
    register(key, expr, kind, label, label_key)

for name, kind, label in [
    ("id", "integer", "ID финансовой строки"),
    ("project_id", "integer", "ID проекта"),
    ("kind", "string", "Тип финансовой строки"),
    ("year", "integer", "Год"),
    ("month", "integer", "Месяц"),
    ("amount", "decimal", "Сумма"),
    ("vat_included", "boolean", "НДС"),
    ("status_id", "integer", "ID статуса"),
    ("article_id", "integer", "ID статьи"),
    ("cost_type_id", "integer", "ID вида затрат"),
    ("created_at", "datetime", "Создано"),
    ("updated_at", "datetime", "Изменено"),
]:
    label_key = "financial_entries." + name if name in {"kind", "year", "month", "amount", "vat_included"} else None
    register("financial." + name, getattr(Finance, name), kind, label, label_key, True)
for key, expr, label, label_key in [
    ("financial.status", status_ref.name, "Статус", "financial_entries.status_id"),
    ("financial.article", article_ref.name, "Статья затрат", "financial_entries.article_id"),
    ("financial.cost_type", type_ref.name, "Вид затрат", "financial_entries.cost_type_id"),
]:
    register(key, expr, "string", label, label_key, True)


def operators(kind):
    if kind == "string":
        return ["eq", "ne", "contains", "is_null"]
    if kind == "boolean":
        return ["eq", "ne", "is_null"]
    return ["eq", "ne", "lt", "lte", "gt", "gte", "is_null"]


def registry(db):
    labels = effective_project_field_labels(db)
    return [
        dict(
            id=key,
            label=project_field_heading(f.label_key, labels) if f.label_key in labels else f.label,
            type=f.type,
            grains=["financial_entry"] if f.financial else ["project", "financial_entry"],
            operators=["eq", "ne", "is_null"] if key in CHOICES else operators(f.type),
            sortable=True,
            **(
                {"choices": [{"value": value, "label": label} for value, label in CHOICES[key].items()]}
                if key in CHOICES
                else {}
            ),
        )
        for key, f in FIELDS.items()
    ]


def invalid(message):
    raise HTTPException(422, message)


def typed(value, kind):
    try:
        if kind == "string" and isinstance(value, str) and len(value) <= 500:
            return value
        if kind == "integer" and type(value) is int and -(2**53 - 1) <= value <= 2**53 - 1:
            return value
        if kind == "boolean" and type(value) is bool:
            return value
        if kind == "decimal" and isinstance(value, str) and len(value) <= 40:
            num = Decimal(value)
            if num.is_finite() and abs(num) < Decimal("1e18") and num.as_tuple().exponent >= -6:
                return num
        if kind == "date" and isinstance(value, str):
            return date.fromisoformat(value)
        if kind == "datetime" and isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed
    except (ValueError, InvalidOperation, OverflowError):
        pass
    invalid("Неверное значение фильтра")


def validate(definition: Definition):
    if len(set(definition.columns)) != len(definition.columns):
        invalid("Повторные колонки запрещены")
    if len({s.field for s in definition.sort}) != len(definition.sort):
        invalid("Повторная сортировка запрещена")
    for key in definition.columns + [f.field for f in definition.filters] + [s.field for s in definition.sort]:
        spec = FIELDS.get(key)
        if spec is None or (spec.financial and definition.grain != "financial_entry"):
            invalid("Поле недоступно для выбранной детализации")
    for f in definition.filters:
        spec = FIELDS[f.field]
        allowed_operators = ["eq", "ne", "is_null"] if f.field in CHOICES else operators(spec.type)
        if f.operator not in allowed_operators:
            invalid("Недопустимый оператор фильтра")
        if f.operator == "is_null":
            if type(f.value) is not bool:
                invalid("is_null принимает логическое значение")
        else:
            typed(f.value, spec.type)
            if f.field in CHOICES and f.value not in CHOICES[f.field]:
                invalid("Недопустимое значение перечисления")


def query(definition, user):
    expressions = [FIELDS[key].expression for key in definition.columns]
    stmt = select(Project.id, *expressions).select_from(Project).join(Client, Project.client_id == Client.id)
    stmt = stmt.join(Segment, Client.segment_id == Segment.id).join(Service, Project.service_id == Service.id)
    stmt = stmt.join(manager, Project.manager_id == manager.id)
    for alias, key in [
        (stage_ref, Project.customer_stage_id),
        (payment_ref, Project.payment_type_id),
        (indicator_ref, Project.indicator_id),
        (assessment_ref, Project.assessment_status_id),
    ]:
        stmt = stmt.outerjoin(alias, key == alias.id)
    if definition.grain == "financial_entry":
        stmt = stmt.join(Finance, Finance.project_id == Project.id)
        for alias, key in [
            (status_ref, Finance.status_id),
            (article_ref, Finance.article_id),
            (type_ref, Finance.cost_type_id),
        ]:
            stmt = stmt.outerjoin(alias, key == alias.id)
    stmt = stmt.where(Project.archived_at.is_(None))
    if user.role == Role.user:
        stmt = stmt.where(Project.manager_id == user.id)
    for f in definition.filters:
        expr = FIELDS[f.field].expression
        value = f.value if f.operator == "is_null" else typed(f.value, FIELDS[f.field].type)
        if f.operator == "is_null":
            condition = expr.is_(None) if value else expr.is_not(None)
        elif f.operator == "contains":
            condition = expr.contains(value, autoescape=True)
        elif f.operator == "eq":
            condition = expr == value
        elif f.operator == "ne":
            condition = expr != value
        elif f.operator == "lt":
            condition = expr < value
        elif f.operator == "lte":
            condition = expr <= value
        elif f.operator == "gt":
            condition = expr > value
        else:
            condition = expr >= value
        stmt = stmt.where(condition)
    for order in definition.sort:
        expr = FIELDS[order.field].expression
        stmt = stmt.order_by((expr.asc() if order.direction == "asc" else expr.desc()).nulls_last())
    stmt = stmt.order_by(Project.id.asc())
    if definition.grain == "financial_entry":
        stmt = stmt.order_by(Finance.id.asc())
    return stmt.limit(MAX_ROWS + 1).execution_options(yield_per=100)


def encode(key, value):
    if key == "project.stage" and value is not None:
        return STAGE_LABELS[Stage(value)]
    if key == "project.stage_scheme" and value is not None:
        return CHOICES[key].get(value, value)
    if key == "financial.kind" and value is not None:
        return CHOICES[key].get(value, value)
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, str):
        if len(value) > 32767 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", value):
            invalid("Значение невозможно сохранить в XLSX без потери данных")
    return value


def cleanup(db):
    db.execute(
        delete(ReportSnapshot)
        .where(ReportSnapshot.expires_at <= datetime.now(UTC))
        .execution_options(synchronize_session="fetch")
    )


def lock_projects(db, user, ids):
    if not ids:
        return
    # Блокировки удерживаются до окончания HTTP-запроса, сериализуя смену владельца и архивирование.
    rows = db.execute(
        select(Project.id, Project.manager_id, Project.archived_at)
        .where(Project.id.in_(ids))
        .order_by(Project.id)
        .with_for_update(read=True)
    ).all()
    if len(rows) != len(ids) or any(
        archived is not None or (user.role == Role.user and owner != user.id) for _, owner, archived in rows
    ):
        raise HTTPException(404, "Снимок недоступен")


def set_snapshot_timeouts(db):
    if db.get_bind().dialect.name == "postgresql":
        db.execute(select(func.set_config("statement_timeout", "10000", True)))
        db.execute(select(func.set_config("lock_timeout", "5000", True)))


def lock_quota(db):
    set_snapshot_timeouts(db)
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        db.execute(pg_insert(ReportSnapshotQuota).values(id=1).on_conflict_do_nothing(index_elements=["id"]))
    elif dialect == "sqlite":
        db.execute(sqlite_insert(ReportSnapshotQuota).values(id=1).on_conflict_do_nothing(index_elements=["id"]))
    else:
        raise HTTPException(503, "Хранилище снимков не поддерживается")
    gate = db.scalar(select(ReportSnapshotQuota).where(ReportSnapshotQuota.id == 1).with_for_update())
    if gate is None:
        raise HTTPException(503, "Хранилище снимков недоступно")


def make_snapshot(
    db, user, definition, report_id=None, report_version=None, quota_locked=False, title="Предпросмотр отчёта"
):
    validate(definition)
    if not quota_locked:
        lock_quota(db)
    cleanup(db)
    total = db.scalar(select(func.count()).select_from(ReportSnapshot))
    if total >= MAX_GLOBAL_SNAPSHOTS:
        raise HTTPException(429, "Хранилище снимков заполнено; удалите ненужные снимки или повторите позже")
    count = db.scalar(select(func.count()).select_from(ReportSnapshot).where(ReportSnapshot.owner_id == user.id))
    if count >= MAX_SNAPSHOTS:
        raise HTTPException(429, "Превышено число активных снимков; дождитесь истечения срока")
    rows, project_ids, size = [], set(), 0
    for result in db.execute(query(definition, user)):
        if len(rows) == MAX_ROWS:
            invalid("Более 10000 строк; сузьте фильтры")
        project_ids.add(result[0])
        row = {key: encode(key, value) for key, value in zip(definition.columns, result[1:], strict=True)}
        size += len(json.dumps(row, ensure_ascii=True).encode("utf-8")) + 2
        if size > MAX_BYTES:
            invalid("Размер снимка превышает 10 МБ; сузьте фильтры")
        rows.append(row)
    lock_projects(db, user, sorted(project_ids))
    lookup = {item["id"]: item for item in registry(db)}
    columns = [{k: lookup[key][k] for k in ("id", "label", "type")} for key in definition.columns]
    filters = []
    for item in definition.filters:
        choices = CHOICES.get(item.field, {})
        value_label = choices.get(item.value, item.value) if item.operator != "is_null" else item.value
        filters.append({
            "field": item.field, "label": lookup[item.field]["label"], "operator": item.operator,
            "value": item.value, "value_label": value_label,
        })
    metadata = {
        "filters": filters, "scope": "own" if user.role == Role.user else "all_available",
        "grain": definition.grain, "max_rows": MAX_ROWS, "max_bytes": MAX_BYTES,
    }
    size += len(json.dumps([columns, metadata], ensure_ascii=True).encode("utf-8"))
    size += len(json.dumps(sorted(project_ids))) + 100
    if size > MAX_BYTES:
        invalid("Размер снимка превышает 10 МБ; сузьте фильтры")
    snapshot = ReportSnapshot(
        id=str(uuid4()),
        owner_id=user.id,
        owner_role=user.role.value,
        report_id=report_id,
        report_version=report_version,
        title=encode("title", title),
        expires_at=datetime.now(UTC) + TTL,
        columns=columns,
        rows=rows,
        project_ids=sorted(project_ids),
        print_metadata=metadata,
    )
    db.add(snapshot)
    db.commit()
    return {
        "snapshot_id": snapshot.id,
        "title": snapshot.title,
        "total": len(rows),
        "expires_at": snapshot.expires_at,
        "report_version": report_version,
    }
