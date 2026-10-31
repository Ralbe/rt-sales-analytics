"""Показатели воронки и индикаторы изменений для проектов на этапах заказчика.

Источник истории — журнал `audit_log`: событие создания хранит снимок карточки, события изменения —
снимки до и после, замена финансовых строк — списки строк до и после. Отдельных снапшотов нет.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models import STAGE_LABELS, AuditLog, Client, Project, ReferenceValue

SUCCESS_STAGE_CODE = "success"
INDICATORS = {
    "new": "Новый проект",
    "removed": "Снят с реализации",
    "stage_up": "Переведён на следующий этап",
    "stage_down": "Возвращён на предыдущий этап",
    "revenue_up": "Выручка увеличена",
    "revenue_down": "Выручка снижена",
    "industry": "Передан отраслевому менеджеру",
    "implemented": "Реализован",
}


@dataclass(frozen=True)
class PipelineFilters:
    segment_ids: tuple[int, ...] = ()
    service_ids: tuple[int, ...] = ()
    manager_ids: tuple[int, ...] = ()
    customer_stage_ids: tuple[int, ...] = ()
    implementation_year: int | None = None
    scope_manager_id: int | None = None


def _day(value: datetime) -> date:
    if value.tzinfo is not None:
        value = value.astimezone(UTC)
    return value.date()


def _decimal(value) -> Decimal:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")
    return number if number.is_finite() else Decimal("0")


def load_projects(db: Session, f: PipelineFilters, *, include_archived: bool = False) -> list[Project]:
    q = (
        select(Project)
        .options(selectinload(Project.financial_entries))
        .join(Client, Client.id == Project.client_id)
        .where(Project.stage_scheme == "customer")
    )
    if not include_archived:
        q = q.where(Project.archived_at.is_(None))
    if f.scope_manager_id is not None:
        q = q.where(Project.manager_id == f.scope_manager_id)
    if f.segment_ids:
        q = q.where(func.coalesce(Project.segment_id, Client.segment_id).in_(f.segment_ids))
    if f.service_ids:
        q = q.where(Project.service_id.in_(f.service_ids))
    if f.manager_ids:
        q = q.where(Project.manager_id.in_(f.manager_ids))
    if f.customer_stage_ids:
        q = q.where(Project.customer_stage_id.in_(f.customer_stage_ids))
    if f.implementation_year is not None:
        q = q.where(Project.implementation_year == f.implementation_year)
    return list(db.scalars(q).unique().all())


def project_events(db: Session, project_ids: list[int]) -> dict[int, list[AuditLog]]:
    events: dict[int, list[AuditLog]] = defaultdict(list)
    if not project_ids:
        return events
    rows = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity == "project", AuditLog.entity_id.in_(project_ids))
        .order_by(AuditLog.created_at, AuditLog.id)
    )
    for row in rows:
        events[row.entity_id].append(row)
    return events


def stage_timeline(project: Project, events: list[AuditLog]) -> list[tuple[datetime, int]]:
    """Моменты смены этапа заказчика: [(когда, id этапа), ...] по возрастанию времени."""
    timeline: list[tuple[datetime, int]] = []
    for event in events:
        payload = event.payload or {}
        after = payload.get("after")
        if not isinstance(after, dict):
            continue
        stage_id = after.get("customer_stage_id")
        if type(stage_id) is not int:
            continue
        if event.action == "create" or not timeline or timeline[-1][1] != stage_id:
            timeline.append((event.created_at, stage_id))
    if not timeline and project.customer_stage_id is not None:
        timeline.append((project.created_at, project.customer_stage_id))
    return timeline


def stage_durations(project: Project, events: list[AuditLog], today: date) -> list[tuple[int, int]]:
    """Сколько дней проект провёл на каждом этапе: [(id этапа, дни), ...]."""
    timeline = stage_timeline(project, events)
    end = _day(project.archived_at) if project.archived_at is not None else today
    result = []
    for i, (started, stage_id) in enumerate(timeline):
        finished = _day(timeline[i + 1][0]) if i + 1 < len(timeline) else end
        result.append((stage_id, max((finished - _day(started)).days, 0)))
    return result


def _revenue_total(rows) -> Decimal:
    return sum(
        (_decimal(row.get("amount")) for row in rows if isinstance(row, dict) and row.get("kind") == "revenue"),
        Decimal("0"),
    )


def _entries_revenue(project: Project) -> Decimal:
    return sum((e.amount for e in project.financial_entries if e.kind == "revenue"), Decimal("0"))


def _group(items: dict, key, label: str, project: Project) -> None:
    bucket = items.setdefault(key, {"key": str(key), "label": label, "count": 0, "amount": 0.0, "weighted_amount": 0.0})
    amount = float(project.amount)
    bucket["count"] += 1
    bucket["amount"] += amount
    bucket["weighted_amount"] += amount * project.probability / 100


def _rounded(items: list[dict]) -> list[dict]:
    for item in items:
        for field in ("amount", "weighted_amount", "avg_days"):
            if item.get(field) is not None:
                item[field] = round(item[field], 2 if field != "avg_days" else 1)
    return items


def summary(db: Session, f: PipelineFilters, today: date) -> dict:
    projects = load_projects(db, f)
    stages = db.scalars(
        select(ReferenceValue).where(ReferenceValue.category == "customer_stage").order_by(ReferenceValue.position)
    ).all()
    events = project_events(db, [p.id for p in projects])

    by_stage = {
        s.id: {"key": str(s.id), "label": s.name, "probability": s.probability, "count": 0, "amount": 0.0,
               "weighted_amount": 0.0, "avg_days": None}
        for s in stages
    }
    durations: dict[int, list[int]] = defaultdict(list)
    by_manager: dict = {}
    by_segment: dict = {}
    by_service: dict = {}
    totals = {"count": 0, "amount": 0.0, "weighted_amount": 0.0, "revenue": 0.0, "weighted_revenue": 0.0}
    for p in projects:
        amount = float(p.amount)
        revenue = float(_entries_revenue(p)) * 1000  # месячные строки — в тысячах рублей
        totals["count"] += 1
        totals["amount"] += amount
        totals["weighted_amount"] += amount * p.probability / 100
        totals["revenue"] += revenue
        totals["weighted_revenue"] += revenue * p.probability / 100
        if p.customer_stage_id in by_stage:
            bucket = by_stage[p.customer_stage_id]
            bucket["count"] += 1
            bucket["amount"] += amount
            bucket["weighted_amount"] += amount * p.probability / 100
        _group(by_manager, p.manager_id, p.manager.full_name, p)
        segment = p.segment or p.client.segment
        _group(by_segment, segment.id, segment.name, p)
        _group(by_service, p.service_id, p.service.name, p)
        for stage_id, days in stage_durations(p, events.get(p.id, []), today):
            durations[stage_id].append(days)

    for stage_id, values in durations.items():
        if stage_id in by_stage and values:
            by_stage[stage_id]["avg_days"] = sum(values) / len(values)

    def ordered(items: dict) -> list[dict]:
        return _rounded(sorted(items.values(), key=lambda i: (-i["amount"], i["label"])))

    return {
        "as_of": today,
        "totals": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in totals.items()},
        "by_stage": _rounded(list(by_stage.values())),
        "by_manager": ordered(by_manager),
        "by_segment": ordered(by_segment),
        "by_service": ordered(by_service),
    }


def _stage_at(timeline: list[tuple[datetime, int]], moment: date) -> int | None:
    """Этап на конец дня `moment` (None — проект ещё не создан)."""
    current = None
    for at, stage_id in timeline:
        if _day(at) > moment:
            break
        current = stage_id
    return current


def project_changes(project: Project, events: list[AuditLog], start: date, end: date,
                    positions: dict[int, int], codes: dict[int, str]) -> list[str]:
    """Индикаторы изменений проекта за период [start, end] (даты UTC, включительно)."""
    found: list[str] = []
    in_period = [e for e in events if start <= _day(e.created_at) <= end]
    created = _day(project.created_at)
    if start <= created <= end:
        found.append("new")
    if project.archived_at is not None and start <= _day(project.archived_at) <= end:
        found.append("removed")

    timeline = stage_timeline(project, events)
    if timeline:
        base = _stage_at(timeline, date.fromordinal(start.toordinal() - 1))
        if base is None:
            base = timeline[0][1]
        final = _stage_at(timeline, end)
        if base is not None and final is not None and base != final:
            if positions.get(final, 0) > positions.get(base, 0):
                found.append("stage_up")
            elif positions.get(final, 0) < positions.get(base, 0):
                found.append("stage_down")
            if codes.get(final) == SUCCESS_STAGE_CODE:
                found.append("implemented")

    financial = [e for e in in_period if e.action == "replace_financial_entries"]
    delta = Decimal("0")
    if financial:
        before = financial[0].payload.get("before") or []
        after = financial[-1].payload.get("after") or []
        delta = _revenue_total(after) - _revenue_total(before)
    else:
        updates = [e for e in in_period if e.action == "update" and isinstance(e.payload.get("before"), dict)]
        if updates:
            delta = _decimal(updates[-1].payload["after"].get("amount")) - _decimal(
                updates[0].payload["before"].get("amount")
            )
    if delta > 0:
        found.append("revenue_up")
    elif delta < 0:
        found.append("revenue_down")

    for event in in_period:
        before, after = event.payload.get("before"), event.payload.get("after")
        if event.action != "update" or not isinstance(before, dict) or not isinstance(after, dict):
            continue
        became_industry = not before.get("is_industry_solution") and after.get("is_industry_solution")
        new_manager = after.get("industry_manager") and after.get("industry_manager") != before.get("industry_manager")
        if became_industry or new_manager:
            found.append("industry")
            break
    if "removed" not in found and any(
        e.action == "update" and isinstance(e.payload.get("after"), dict)
        and e.payload["after"].get("_labels", {}).get("indicator_id") == "Снят"
        and e.payload.get("before", {}).get("indicator_id") != e.payload["after"].get("indicator_id")
        for e in in_period
    ):
        found.append("removed")
    return [key for key in INDICATORS if key in found]


def gantt(db: Session, project: Project, today: date) -> dict:
    """Отрезки этапов по истории изменений и месяцы выручки и затрат для диаграммы Ганта."""
    events = project_events(db, [project.id]).get(project.id, [])
    end = _day(project.archived_at) if project.archived_at is not None else today
    stages: list[dict] = []
    if project.stage_scheme == "customer":
        names = dict(db.execute(select(ReferenceValue.id, ReferenceValue.name).where(
            ReferenceValue.category == "customer_stage",
        )).all())
        timeline = stage_timeline(project, events)
        for i, (started, stage_id) in enumerate(timeline):
            finished = _day(timeline[i + 1][0]) if i + 1 < len(timeline) else end
            stages.append({"label": names.get(stage_id, "Этап удалён"), "start": _day(started), "end": finished})
    else:
        label = STAGE_LABELS.get(project.stage, "Прежняя стадия") if project.stage else "Прежняя стадия"
        stages.append({"label": label, "start": project.start_date, "end": project.closed_at or end})

    def months(kind: str) -> list[dict]:
        totals: dict[tuple[int, int], Decimal] = defaultdict(Decimal)
        for entry in project.financial_entries:
            if entry.kind == kind:
                totals[(entry.year, entry.month)] += entry.amount
        return [{"year": y, "month": m, "amount": float(v)} for (y, m), v in sorted(totals.items())]

    return {"stages": stages, "revenue": months("revenue"), "costs": months("cost")}


def period_changes(db: Session, f: PipelineFilters, start: date, end: date) -> dict:
    projects = load_projects(db, f, include_archived=True)
    stages = db.scalars(select(ReferenceValue).where(ReferenceValue.category == "customer_stage")).all()
    positions = {s.id: s.position for s in stages}
    codes = {s.id: s.code for s in stages}
    events = project_events(db, [p.id for p in projects])
    items = []
    for p in projects:
        found = project_changes(p, events.get(p.id, []), start, end, positions, codes)
        if found:
            items.append({"project_id": p.id, "indicators": found})
    counts = {key: sum(key in item["indicators"] for item in items) for key in INDICATORS}
    return {
        "date_from": start,
        "date_to": end,
        "labels": INDICATORS,
        "counts": counts,
        "items": items,
    }
