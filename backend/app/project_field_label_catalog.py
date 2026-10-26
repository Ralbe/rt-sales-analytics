"""Закрытый каталог подписей. Ключи и единицы не редактируются через API."""

from dataclasses import dataclass
from types import MappingProxyType

LABEL_MAX_LENGTH = 120


@dataclass(frozen=True)
class FieldLabelDefinition:
    default_label: str
    suffix: str = ""
    legacy_label: str | None = None


# Исходные подписи истории фиксированы: legacy_label не зависит от overrides.
FIELD_LABELS = MappingProxyType({
    "id": FieldLabelDefinition("ID"),
    "name": FieldLabelDefinition("Название проекта"),
    "description": FieldLabelDefinition("Суть проекта", legacy_label="Описание"),
    "client_id": FieldLabelDefinition("Клиент"),
    "client_inn": FieldLabelDefinition("ИНН"),
    "segment": FieldLabelDefinition("Сегмент"),
    "manager_id": FieldLabelDefinition("Ответственный"),
    "service_id": FieldLabelDefinition("Услуга"),
    "service_group": FieldLabelDefinition("Группа услуг"),
    "stage": FieldLabelDefinition("Стадия системы"),
    "amount": FieldLabelDefinition("Сумма контракта", ", ₽"),
    "cost": FieldLabelDefinition("Себестоимость", ", ₽"),
    "margin": FieldLabelDefinition("Маржа", ", ₽"),
    "margin_pct": FieldLabelDefinition("Маржа", ", %"),
    "probability": FieldLabelDefinition("Вероятность", ", %"),
    "start_date": FieldLabelDefinition("Дата начала"),
    "expected_close_date": FieldLabelDefinition("Плановое закрытие"),
    "closed_at": FieldLabelDefinition("Дата закрытия"),
    "payment_type_id": FieldLabelDefinition("Тип платежа"),
    "customer_stage_id": FieldLabelDefinition("Этап по ТЗ"),
    "indicator_id": FieldLabelDefinition("Индикатор проекта", legacy_label="Индикатор"),
    "accepted_for_forecast": FieldLabelDefinition("Принимаемый к прогнозу"),
    "assessment_status_id": FieldLabelDefinition("Принимаемый к оценке"),
    "subsidiary_implementation": FieldLabelDefinition("Реализация через ДЗО"),
    "management_control": FieldLabelDefinition("Контроль руководства"),
    "is_industry_solution": FieldLabelDefinition("Отраслевое решение"),
    "industry_manager": FieldLabelDefinition("Отраслевой менеджер"),
    "industry_project_number": FieldLabelDefinition("Номер отраслевого проекта"),
    "implementation_year": FieldLabelDefinition("Год реализации"),
    "project_status": FieldLabelDefinition("Статус проекта"),
    "realized_work": FieldLabelDefinition("Сделано за период"),
    "period_plan": FieldLabelDefinition("Планы на период"),
    "created_at": FieldLabelDefinition("Дата создания", " (UTC)"),
    "updated_at": FieldLabelDefinition("Дата изменения", " (UTC)"),
    "archived_at": FieldLabelDefinition("Архивирование"),
    "financial_entries": FieldLabelDefinition("Помесячная выручка и затраты", legacy_label="Финансовые строки"),
    "financial_entries.kind": FieldLabelDefinition("Тип финансовой строки"),
    "financial_entries.revenue": FieldLabelDefinition("Выручка"),
    "financial_entries.cost": FieldLabelDefinition("Затраты"),
    "financial_entries.year": FieldLabelDefinition("Год"),
    "financial_entries.month": FieldLabelDefinition("Месяц"),
    "financial_entries.amount": FieldLabelDefinition("Сумма", ", тыс. ₽"),
    "financial_entries.vat_included": FieldLabelDefinition("НДС"),
    "financial_entries.status_id": FieldLabelDefinition("Статус"),
    "financial_entries.revenue_status": FieldLabelDefinition("Статус начисления выручки", legacy_label="Статус"),
    "financial_entries.cost_status": FieldLabelDefinition("Статус затрат", legacy_label="Статус"),
    "financial_entries.article_id": FieldLabelDefinition("Статья затрат", legacy_label="Статья"),
    "financial_entries.cost_type_id": FieldLabelDefinition("Вид затрат", legacy_label="Тип затрат"),
})
