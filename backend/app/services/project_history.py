from collections import Counter
from datetime import UTC, date
from decimal import Decimal, InvalidOperation

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.history_schemas import ProjectHistoryChange, ProjectHistoryItem
from app.models import STAGE_LABELS, Client, Project, ReferenceValue, Service, User
from app.project_field_label_catalog import FIELD_LABELS
from app.services.project_field_labels import (
    effective_project_field_labels,
    historical_field_label,
    with_snapshot_field_labels,
)

PROJECT_FIELDS = {
    key: FIELD_LABELS[key].legacy_label or FIELD_LABELS[key].default_label
    for key in (
        "name", "description", "client_id", "manager_id", "service_id", "stage", "amount", "cost", "probability",
        "start_date", "expected_close_date", "closed_at", "payment_type_id", "customer_stage_id", "indicator_id",
        "accepted_for_forecast", "assessment_status_id", "subsidiary_implementation", "management_control",
        "is_industry_solution", "industry_manager", "industry_project_number", "implementation_year", "project_status",
        "realized_work", "period_plan", "archived_at",
    )
}
REFERENCE_MODELS = {
    "client_id": Client,
    "manager_id": User,
    "service_id": Service,
    **dict.fromkeys(
        (
            "payment_type_id",
            "customer_stage_id",
            "indicator_id",
            "assessment_status_id",
            "status_id",
            "article_id",
            "cost_type_id",
        ),
        ReferenceValue,
    ),
}
FINANCIAL_FIELDS = ("kind", "year", "month", "amount", "vat_included", "status_id", "article_id", "cost_type_id")


def decimal_text(value, places: int) -> str:
    return format(Decimal(str(value)), f".{places}f")


def _decimal_key(value) -> str:
    try:
        number = Decimal(str(value))
        if number.is_finite():
            return str(number.normalize())
    except InvalidOperation:
        pass
    return str(value)


def financial_key(row: dict) -> tuple:
    # Метки и технические ID строк не участвуют в сравнении содержимого.
    return tuple(
        _decimal_key(row[field]) if field == "amount" and field in row else str(row.get(field))
        for field in FINANCIAL_FIELDS
    )


def same_finances(before: list[dict], after: list[dict]) -> bool:
    return Counter(map(financial_key, before)) == Counter(map(financial_key, after))


class HistoryFormatter:
    def __init__(self, db: Session, snapshots: list[dict]):
        self.names: dict[type, dict[int, str]] = {}
        for model in set(REFERENCE_MODELS.values()):
            ids = {
                snapshot[field]
                for snapshot in snapshots
                for field, target in REFERENCE_MODELS.items()
                if target == model and type(snapshot.get(field)) is int
            }
            name = User.full_name if model == User else model.name
            self.names[model] = dict(db.execute(select(model.id, name).where(model.id.in_(ids))).all()) if ids else {}

    def reference(self, field: str, snapshot: dict) -> str:
        value = snapshot.get(field)
        if value is None:
            return "Не задано"
        labels = snapshot.get("_labels")
        if isinstance(labels, dict) and isinstance(labels.get(field), str):
            return labels[field]
        name = self.names[REFERENCE_MODELS[field]].get(value) if type(value) is int else None
        return name or "Значение справочника недоступно"

    def value(self, field: str, snapshot: dict, *, financial: bool = False) -> str | None:
        if field not in snapshot:
            return None
        value = snapshot[field]
        if value is None or value == "":
            return "Не задано"
        if field in REFERENCE_MODELS:
            return self.reference(field, snapshot)
        if isinstance(value, bool):
            return "Да" if value else "Нет"
        if not isinstance(value, str | int | float):
            return "Значение не распознано"
        if field in {"amount", "cost"}:
            try:
                amount = Decimal(str(value))
                if not amount.is_finite() or abs(amount) > Decimal("1e15"):
                    return "Значение не распознано"
                text = format(amount, f",.{3 if financial else 2}f")
                return text.replace(",", " ").replace(".", ",") + (" тыс. ₽" if financial else " ₽")
            except InvalidOperation:
                return "Значение не распознано"
        if field in {"start_date", "expected_close_date", "closed_at"}:
            try:
                return date.fromisoformat(str(value)).strftime("%d.%m.%Y")
            except ValueError:
                return "Дата не распознана"
        if field == "stage":
            return STAGE_LABELS.get(value, "Стадия не распознана")
        if field == "probability":
            return f"{value}%"
        return str(value)

    def financial_row(self, row: dict) -> str:
        kind_value = row.get("kind")
        kind = (
            historical_field_label(f"financial_entries.{kind_value}", row)
            if kind_value in ("revenue", "cost") else "Финансовая строка"
        )
        month, year = row.get("month"), row.get("year")
        period = (
            f"{month:02d}.{year}"
            if type(month) is int and 1 <= month <= 12 and type(year) is int
            else "Период не записан"
        )
        amount = self.value("amount", row, financial=True) or "Сумма не записана"
        vat_value = row.get("vat_included")
        vat = ("с НДС" if vat_value else "без НДС") if type(vat_value) is bool else "Признак НДС не записан"
        parts = [kind, period, amount, vat]
        for field in ("status_id", "article_id", "cost_type_id"):
            if field in row and row[field] is not None:
                key = f"financial_entries.{field}"
                if field == "status_id" and kind_value in ("revenue", "cost"):
                    key = f"financial_entries.{kind_value}_status"
                label = historical_field_label(key, row)
                parts.append(f"{label}: {self.reference(field, row)}")
        return " · ".join(parts)

    def changes(self, action: str, payload: dict) -> list[ProjectHistoryChange]:
        if action == "replace_financial_entries":
            return self.financial_changes(payload)
        before = payload.get("before")
        after = payload.get("after")
        before = before if isinstance(before, dict) else {}
        after = after if isinstance(after, dict) else {}
        if action == "create" and not after and "name" in payload:
            after = {"name": payload["name"]}
        if action not in {"create", "update", "archive", "restore"}:
            return []
        changes = []
        for field in PROJECT_FIELDS:
            if field not in before and field not in after:
                continue
            old, new = self.value(field, before), self.value(field, after)
            unchanged = (
                _decimal_key(before.get(field)) == _decimal_key(after.get(field))
                if field in {"amount", "cost"}
                else before.get(field) == after.get(field)
            )
            if field in before and field in after and unchanged:
                continue
            label = historical_field_label(field, after if field in after else before)
            changes.append(ProjectHistoryChange(field=field, label=label, before=old, after=new))
        return changes

    def financial_changes(self, payload: dict) -> list[ProjectHistoryChange]:
        before, after = payload.get("before"), payload.get("after")
        old = [row for row in before if isinstance(row, dict)] if isinstance(before, list) else []
        new = [row for row in after if isinstance(row, dict)] if isinstance(after, list) else []
        remaining_new = Counter(map(financial_key, new))
        remaining_old = Counter(map(financial_key, old))
        changes = []
        for row in old:
            key = financial_key(row)
            if remaining_new[key]:
                remaining_new[key] -= 1
            else:
                changes.append(
                    ProjectHistoryChange(
                        field="financial_entries",
                        label="Финансовая строка удалена"
                        if isinstance(after, list)
                        else "Финансовая строка до сохранения",
                        before=self.financial_row(row),
                        after="Строка отсутствует" if isinstance(after, list) else None,
                    )
                )
        for row in new:
            key = financial_key(row)
            if remaining_old[key]:
                remaining_old[key] -= 1
            else:
                changes.append(
                    ProjectHistoryChange(
                        field="financial_entries",
                        label=(
                            "Финансовая строка добавлена"
                            if isinstance(before, list)
                            else "Финансовая строка после сохранения"
                        ),
                        before="Строка отсутствовала" if isinstance(before, list) else None,
                        after=self.financial_row(row),
                    )
                )
        if not old and not new and isinstance(before, list) != isinstance(after, list):
            changes.append(
                ProjectHistoryChange(
                    field="financial_entries",
                    label="Финансовые строки",
                    before="Нет финансовых строк" if isinstance(before, list) else None,
                    after="Нет финансовых строк" if isinstance(after, list) else None,
                )
            )
        return changes


def project_snapshot(db: Session, project: Project, *, field_labels: dict[str, str] | None = None) -> dict:
    snapshot = jsonable_encoder(
        {field: getattr(project, field) for field in PROJECT_FIELDS},
        custom_encoder={Decimal: str},
    )
    for field in ("amount", "cost"):
        snapshot[field] = decimal_text(snapshot[field], 2)
    snapshot["_stage_scheme"] = project.stage_scheme
    formatter = HistoryFormatter(db, [snapshot])
    snapshot["_labels"] = {
        field: formatter.reference(field, snapshot)
        for field in PROJECT_FIELDS
        if field in REFERENCE_MODELS and snapshot[field] is not None
    }
    return with_snapshot_field_labels(
        snapshot, effective_project_field_labels(db) if field_labels is None else field_labels,
    )


def financial_snapshot(row, references: dict | None = None, *, field_labels: dict[str, str] | None = None) -> dict:
    snapshot = {field: getattr(row, field) for field in FINANCIAL_FIELDS}
    snapshot["amount"] = decimal_text(row.amount, 3)
    if references is None:
        references = {"status_id": row.status, "article_id": row.article, "cost_type_id": row.cost_type}
    for field in ("status_id", "article_id", "cost_type_id"):
        reference = references.get(field)
        snapshot[field] = reference.id if reference is not None else None
    snapshot["_labels"] = {field: ref.name for field, ref in references.items() if ref is not None}
    keys = [f"financial_entries.{field}" for field in FINANCIAL_FIELDS if snapshot[field] is not None]
    keys.extend((f"financial_entries.{snapshot['kind']}", f"financial_entries.{snapshot['kind']}_status"))
    return with_snapshot_field_labels(snapshot, field_labels or {}, keys=keys)


def _snapshots(payload: dict) -> list[dict]:
    snapshots = []
    for key in ("before", "after"):
        value = payload.get(key)
        if isinstance(value, dict):
            snapshots.append(value)
        elif isinstance(value, list):
            snapshots.extend(row for row in value if isinstance(row, dict))
    return snapshots


def _history_note(action: str, payload: dict, changes: list[ProjectHistoryChange]) -> str | None:
    if not changes:
        if action in {"update", "replace_financial_entries"} and "before" in payload and "after" in payload:
            return "Изменения значений в этой записи не обнаружены."
        return "Подробности изменения не записаны в журнале."
    if action == "create" and not isinstance(payload.get("after"), dict):
        return "В старой записи сохранено только название проекта."
    for snapshot in _snapshots(payload):
        labels = snapshot.get("_labels")
        for field in REFERENCE_MODELS:
            if snapshot.get(field) is not None and (not isinstance(labels, dict) or field not in labels):
                return "В старой записи названия справочников не сохранены; показаны их текущие значения."
    return None


def history_items(db: Session, rows) -> list[ProjectHistoryItem]:
    snapshots = []
    for log, _ in rows:
        payload = log.payload if isinstance(log.payload, dict) else {}
        snapshots.extend(_snapshots(payload))
    formatter = HistoryFormatter(db, snapshots)
    items = []
    for log, author_name in rows:
        payload = log.payload if isinstance(log.payload, dict) else {}
        changes = formatter.changes(log.action, payload)
        saved_author = payload.get("author_name")
        items.append(
            ProjectHistoryItem(
                id=log.id,
                created_at=log.created_at.replace(tzinfo=UTC) if log.created_at.tzinfo is None else log.created_at,
                action=log.action,
                title={
                    "create": "Создание проекта",
                    "update": "Изменение карточки",
                    "replace_financial_entries": "Изменение финансовых строк",
                    "archive": "Архивирование проекта",
                    "restore": "Восстановление проекта",
                }.get(log.action, "Изменение проекта"),
                author_name=(
                    saved_author if isinstance(saved_author, str) and saved_author else author_name or "Автор не указан"
                ),
                changes=changes,
                note=_history_note(log.action, payload, changes),
            )
        )
    return items
