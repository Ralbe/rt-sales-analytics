"""Observed stage history, never backfilled from current values or planned dates."""

from collections import defaultdict
from datetime import UTC, datetime
from math import fsum

from app.models import STAGE_LABELS, AuditLog, Project
from app.timeline_schemas import ArchivedPeriod, StageInterval, StageStatistic

STATISTICS_NOTE = (
    "Среднее рассчитано по завершённым переходом посещениям этапа с известной датой входа. "
    "Текущие этапы, неизвестные начала и посещения, прерванные архивированием, исключены. "
    "Повторный вход на этап считается отдельным посещением; день равен 24 часам."
)
FINANCE_NOTE = (
    "Доходы и затраты показаны по месяцам в тыс. ₽ со статусами и признаком НДС. "
    "Месяц — период финансовой строки, а не точная дата оплаты."
)


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _stage(snapshot: object, reference_names: dict[int, str]) -> tuple[str, str] | None:
    if not isinstance(snapshot, dict):
        return None
    labels = snapshot.get("_labels")
    labels = labels if isinstance(labels, dict) else {}
    if snapshot.get("_stage_scheme") == "customer" or (
        snapshot.get("stage") is None and type(snapshot.get("customer_stage_id")) is int
    ):
        stage_id = snapshot.get("customer_stage_id")
        if type(stage_id) is not int:
            return None
        label = labels.get("customer_stage_id")
        if not isinstance(label, str) or not label:
            label = reference_names.get(stage_id, f"Этап #{stage_id}")
        return f"customer:{stage_id}", label
    stage = snapshot.get("stage")
    if isinstance(stage, str) and stage in STAGE_LABELS:
        return f"legacy:{stage}", STAGE_LABELS[stage]
    return None


def stage_statistics(intervals: list[StageInterval]) -> list[StageStatistic]:
    durations: dict[str, list[float]] = defaultdict(list)
    names = {}
    for interval in intervals:
        names[interval.stage_key] = interval.stage_label
        if interval.start_known and interval.end_reason == "stage_change":
            durations[interval.stage_key].append(interval.duration_days)
    return [
        StageStatistic(
            stage_key=key, stage_label=label, completed_visits=len(durations[key]),
            average_days=round(fsum(durations[key]) / len(durations[key]), 6) if durations[key] else None,
        )
        for key, label in names.items()
    ]


def build_intervals(
    project: Project, logs: list[AuditLog], *, now: datetime, reference_names: dict[int, str],
) -> tuple[list[StageInterval], list[ArchivedPeriod], bool]:
    now = utc(now)
    intervals: list[StageInterval] = []
    archives: list[ArchivedPeriod] = []
    state = None
    started = None
    last_evidence = None
    known = False
    complete = False
    archive_start = None

    def close(when: datetime, reason: str) -> None:
        if state is not None and started is not None:
            end = max(started, when)
            intervals.append(StageInterval(
                stage_key=state[0], stage_label=state[1], started_at=started, ended_at=end,
                duration_days=round((end - started).total_seconds() / 86400, 6),
                is_current=reason == "current", start_known=known, end_reason=reason,
            ))

    for log in sorted(logs, key=lambda item: (utc(item.created_at), item.id)):
        when = utc(log.created_at)
        if when > now:
            continue
        payload = log.payload if isinstance(log.payload, dict) else {}
        before = _stage(payload.get("before"), reference_names)
        after = _stage(payload.get("after"), reference_names)
        if log.action == "archive":
            if archive_start is None:
                close(when, "archive")
                started = None
                archive_start = when
            continue
        if log.action == "restore":
            if archive_start is not None:
                archives.append(ArchivedPeriod(started_at=archive_start, ended_at=when))
                archive_start = None
            else:
                complete = False
            # The original entry may predate the archive; do not count this as a new visit.
            started = when if state is not None else None
            known = False
            last_evidence = when
            continue
        if log.action not in {"create", "update"} or after is None:
            continue
        if archive_start is not None:
            complete = False
            state = after
            continue
        if state is None:
            complete = log.action == "create"
            state, started = after, when
            known = log.action == "create" or (before is not None and before[0] != after[0])
        elif before is not None and before[0] != state[0]:
            # A missing transition makes the intervening period unknowable.
            close(last_evidence or started, "unknown")
            complete = False
            state, started = after, when
            known = before[0] != after[0]
        elif state[0] != after[0]:
            # Without a before snapshot the time of the change itself is unproven.
            close(when if before else last_evidence or started, "stage_change" if before else "unknown")
            complete = complete and before is not None
            state, started, known = after, when, before is not None
        else:
            # Preserve the name captured on entry; later reference renames must not rewrite it.
            pass
        last_evidence = when

    current = _stage({
        "_stage_scheme": project.stage_scheme, "stage": project.stage,
        "customer_stage_id": project.customer_stage_id,
    }, reference_names)
    if archive_start is not None:
        if project.archived_at is None:
            # Restoration happened at an unknown time. Neither a continued archive
            # nor an active stage spanning this gap can be asserted.
            complete = False
        else:
            archives.append(ArchivedPeriod(started_at=archive_start, ended_at=now))
    elif state is not None and started is not None:
        if current is None or current[0] != state[0]:
            close(last_evidence or started, "unknown")
            complete = False
        elif project.archived_at is not None:
            when = min(now, utc(project.archived_at))
            close(max(started, when), "archive")
            archives.append(ArchivedPeriod(started_at=when, ended_at=now))
            complete = False
        else:
            close(now, "current")
    return intervals, archives, complete and bool(intervals)
