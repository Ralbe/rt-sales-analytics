"""Current probability-weighted revenue, with explicit source and VAT basis.

Customer finance is stored in thousands of rubles; legacy contract amounts are
rubles. Sources are mutually exclusive, so a project is never counted twice.
All months and statuses are included; this is an estimate, not booked revenue
or a historical reconstruction. Round only after summing within a VAT bucket.
"""

from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models import Client, Project
from app.services.analytics import Filters

LABELS = {"with_vat": "С НДС", "without_vat": "Без НДС", "unspecified": "НДС не указан (прежняя схема)"}
SCOPE_NOTE = (
    "Текущая оценка по всем доступным неархивным проектам обеих схем, за все годы. "
    "Выручка × текущая вероятность / 100. Для этапов по ТЗ — помесячная выручка всех статусов "
    "(тыс. ₽ переведены в ₽); для прежней схемы — сумма контракта в ₽. "
    "Признак принятия к прогнозу не ограничивает выборку. Суммы с НДС и без НДС показаны раздельно."
)


def amounts(project: Project) -> dict[str, Decimal]:
    if project.stage_scheme == "legacy":
        return {"unspecified": Decimal(project.amount)}
    totals: dict[str, Decimal] = {}
    for entry in project.financial_entries:
        if entry.kind != "revenue":
            continue
        basis = "with_vat" if entry.vat_included else "without_vat"
        totals[basis] = totals.get(basis, Decimal(0)) + Decimal(entry.amount) * 1000
    return totals


def bucket(basis: str, revenue: Decimal, weighted: Decimal) -> dict:
    return {
        "basis": basis, "label": LABELS[basis],
        "revenue_rub": revenue.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        "weighted_revenue_rub": weighted.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
    }


def project_projection(project: Project) -> dict:
    totals = amounts(project)
    return {
        "source": "legacy_amount" if project.stage_scheme == "legacy" else "monthly_revenue",
        "has_revenue": bool(totals),
        "buckets": [
            bucket(basis, total, total * Decimal(project.probability) / 100)
            for basis, total in sorted(totals.items())
        ],
    }


def summary(db: Session, filters: Filters) -> dict:
    segment = func.coalesce(Project.segment_id, Client.segment_id)
    stmt = select(Project).join(Client, Client.id == Project.client_id).options(
        selectinload(Project.financial_entries),
    ).where(Project.archived_at.is_(None))
    for column, values in (
        (segment, filters.segment_ids), (Project.service_id, filters.service_ids),
        (Project.manager_id, filters.manager_ids),
    ):
        if values:
            stmt = stmt.where(column.in_(values))
    if filters.scope_manager_id is not None:
        stmt = stmt.where(Project.manager_id == filters.scope_manager_id)
    totals = {basis: [Decimal(0), Decimal(0)] for basis in LABELS}
    count = missing = 0
    for project in db.scalars(stmt).unique():
        count += 1
        revenues = amounts(project)
        if not revenues:
            missing += 1
        for basis, value in revenues.items():
            totals[basis][0] += value
            totals[basis][1] += value * Decimal(project.probability) / 100
    return {
        "stage_scope": "all", "project_count": count, "missing_revenue_count": missing,
        "buckets": [bucket(basis, *values) for basis, values in totals.items()],
        "scope_note": SCOPE_NOTE,
    }
