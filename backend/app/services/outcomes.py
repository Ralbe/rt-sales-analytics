"""Прибыль по проектам и причины невыполнения проектов.

Месячные строки выручки и затрат хранятся в тысячах рублей; здесь суммы переводятся в рубли.
Прибыль = выручка − затраты по месячным строкам. Налоги и НДС не вычитаются: в данных их нет.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models import STAGE_LABELS, Client, Project, Stage
from app.services.analytics import Filters, _apply_filters
from app.services.pipeline import SUCCESS_STAGE_CODE, _day, project_events, stage_durations

THOUSAND = Decimal("1000")
STATUS_LABELS = {"implemented": "Реализованные", "in_progress": "В работе"}
REASON_LABELS = {
    "removed": "Снят с реализации (архив)",
    "lost": "Проигран",
    "churn": "Отток клиента (ОТТОК)",
    "excluded": "Исключён из оценки (Delete)",
    "stalled": "Застрял на этапе",
}
# Проект «застрял», если стоит на этапе дольше среднего по этому этапу в STALL_FACTOR раз и не меньше STALL_MIN_DAYS.
STALL_FACTOR = 2
STALL_MIN_DAYS = 30


def _projects(db: Session, f: Filters, *, include_archived: bool) -> list[Project]:
    segment_id = func.coalesce(Project.segment_id, Client.segment_id)
    q = select(Project).options(selectinload(Project.financial_entries)).join(Client, Client.id == Project.client_id)
    if not include_archived:
        q = q.where(Project.archived_at.is_(None))
    return list(db.scalars(_apply_filters(q, f, segment_id)).unique().all())


def _implemented(p: Project) -> bool:
    if p.stage_scheme == "customer":
        return p.customer_stage is not None and p.customer_stage.code == SUCCESS_STAGE_CODE
    return p.stage == Stage.won


def _stage_label(p: Project) -> str:
    if p.stage_scheme == "customer":
        return p.customer_stage.name if p.customer_stage else "Этап не задан"
    return STAGE_LABELS.get(p.stage, "Стадия не задана") if p.stage else "Стадия не задана"


def _segment(p: Project):
    return p.segment or p.client.segment


def _money(value: Decimal) -> float:
    return round(float(value), 2)


def profit(db: Session, f: Filters, limit: int = 10) -> dict:
    """Выручка, затраты и прибыль по реализованным проектам и проектам в работе."""
    totals = {key: {"key": key, "label": label, "count": 0, "revenue": Decimal(0), "costs": Decimal(0)}
              for key, label in STATUS_LABELS.items()}
    items = []
    for p in _projects(db, f, include_archived=False):
        if p.stage_scheme == "legacy" and p.stage == Stage.lost:
            continue
        revenue = sum((e.amount for e in p.financial_entries if e.kind == "revenue"), Decimal(0)) * THOUSAND
        costs = sum((e.amount for e in p.financial_entries if e.kind == "cost"), Decimal(0)) * THOUSAND
        status = "implemented" if _implemented(p) else "in_progress"
        bucket = totals[status]
        bucket["count"] += 1
        bucket["revenue"] += revenue
        bucket["costs"] += costs
        if revenue or costs:
            items.append({
                "project_id": p.id, "name": p.name, "client": p.client.name, "stage": _stage_label(p),
                "status": status, "revenue": revenue, "costs": costs, "profit": revenue - costs,
            })

    def finish(row: dict) -> dict:
        row["profit"] = row["revenue"] - row["costs"]
        row["margin_pct"] = round(float(row["profit"] / row["revenue"] * 100), 1) if row["revenue"] else None
        return {k: (_money(v) if isinstance(v, Decimal) else v) for k, v in row.items()}

    groups = [finish(row) for row in totals.values()]
    overall = finish({"key": "all", "label": "Всего", "count": sum(g["count"] for g in groups),
                      "revenue": sum((t["revenue"] for t in totals.values()), Decimal(0)),
                      "costs": sum((t["costs"] for t in totals.values()), Decimal(0))})
    items.sort(key=lambda r: r["profit"], reverse=True)
    return {"groups": groups, "total": overall, "items": [finish(r) for r in items[:limit]]}


def _reason(p: Project) -> str | None:
    if p.archived_at is not None:
        return "removed"
    if p.stage_scheme == "legacy" and p.stage == Stage.lost:
        return "lost"
    code = p.assessment_status.code if p.assessment_status else None
    if code == "churn":
        return "churn"
    if code == "delete":
        return "excluded"
    return None


def failures(db: Session, f: Filters, today: date, limit: int = 20) -> dict:
    """Почему проекты не выполнены: снятые, проигранные, отток, исключённые и застрявшие на этапе."""
    projects = _projects(db, f, include_archived=True)
    customer = [p for p in projects if p.stage_scheme == "customer"]
    events = project_events(db, [p.id for p in customer])

    # Среднее время на этапе считается по всем проектам выборки на этапах заказчика.
    durations: dict[int, list[int]] = defaultdict(list)
    current_days: dict[int, int] = {}
    for p in customer:
        spans = stage_durations(p, events.get(p.id, []), today)
        for stage_id, days in spans:
            durations[stage_id].append(days)
        if spans:
            current_days[p.id] = spans[-1][1]
    average = {stage_id: sum(v) / len(v) for stage_id, v in durations.items() if v}

    found = []
    for p in projects:
        reason = _reason(p)
        days = current_days.get(p.id)
        if reason is None and p.stage_scheme == "customer" and not _implemented(p) and days is not None:
            avg = average.get(p.customer_stage_id, 0)
            if days >= max(STALL_MIN_DAYS, avg * STALL_FACTOR):
                reason = "stalled"
        if reason is None:
            continue
        segment = _segment(p)
        found.append({
            "project_id": p.id, "name": p.name, "client": p.client.name, "reason": reason,
            "reason_label": REASON_LABELS[reason], "stage": _stage_label(p), "segment": segment.name,
            "manager": p.manager.full_name, "amount": _money(p.amount), "days_on_stage": days,
            "archived_at": _day(p.archived_at) if p.archived_at else None,
        })

    def group(key: str) -> list[dict]:
        acc: dict[str, dict] = {}
        for row in found:
            bucket = acc.setdefault(row[key], {"label": row[key], "count": 0, "amount": 0.0})
            bucket["count"] += 1
            bucket["amount"] = round(bucket["amount"] + row["amount"], 2)
        return sorted(acc.values(), key=lambda r: (-r["count"], r["label"]))

    by_reason = [
        {"key": key, "label": label, "count": sum(r["reason"] == key for r in found),
         "amount": round(sum(r["amount"] for r in found if r["reason"] == key), 2)}
        for key, label in REASON_LABELS.items()
    ]
    found.sort(key=lambda r: r["amount"], reverse=True)
    return {
        "total": len(found),
        "by_reason": by_reason,
        "by_stage": group("stage"),
        "by_segment": group("segment"),
        "by_manager": group("manager"),
        "items": found[:limit],
        "stall_rule": f"на этапе дольше {STALL_FACTOR}× среднего по этапу и не меньше {STALL_MIN_DAYS} дней",
    }
