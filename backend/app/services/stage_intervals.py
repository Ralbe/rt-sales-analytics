"""История этапов: интервалы без архива и статистика завершённых посещений."""

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from statistics import mean, median


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def cutoff(day: date) -> datetime:
    now = datetime.now(UTC)
    if day >= now.date():
        return now
    return datetime.combine(day + timedelta(days=1), time.min, UTC)


@dataclass
class Visit:
    stage: int | str
    label: str | None = None
    pieces: list[tuple[datetime, datetime]] = field(default_factory=list)
    completed: bool = False
    known_start: bool = True

    @property
    def days(self) -> float:
        return sum((end - start).total_seconds() for start, end in self.pieces) / 86400


def visits(project, events, until: datetime) -> list[Visit]:
    """Только наблюдаемая история. Текущий этап не подставляется задним числом."""
    field_name = "customer_stage_id" if project.stage_scheme == "customer" else "stage"
    until = utc(until)
    result: list[Visit] = []
    current: Visit | None = None
    started: datetime | None = None
    archived = False

    def close_piece(at: datetime) -> None:
        nonlocal started
        if current is not None and started is not None and at >= started:
            current.pieces.append((started, at))
        started = None

    for event in sorted(events, key=lambda e: (utc(e.created_at), getattr(e, "id", 0) or 0)):
        at = utc(event.created_at)
        if at > until:
            break
        payload = event.payload or {}
        after = payload.get("after")
        if not isinstance(after, dict):
            continue
        stage = after.get(field_name)
        valid = type(stage) is int if field_name == "customer_stage_id" else isinstance(stage, str)
        if valid and (current is None or current.stage != stage):
            close_piece(at)
            if current is not None:
                current.completed = current.known_start and not archived and event.action == "update"
            labels = after.get("_labels") or {}
            before = payload.get("before") or {}
            before_stage = before.get(field_name)
            valid_before = (type(before_stage) is int if field_name == "customer_stage_id"
                            else isinstance(before_stage, str))
            known_start = event.action == "create" or (valid_before and before_stage != stage) or current is not None
            current = Visit(stage=stage, label=labels.get(field_name), known_start=known_start)
            result.append(current)
            if not archived:
                started = at
        if event.action == "archive":
            close_piece(at)
            archived = True
        elif event.action == "restore":
            archived = False
            if current is not None:
                started = at
    close_piece(until)
    return result


def duration_statistics(values: list[float]) -> dict:
    """Мода по длительностям, округлённым до минуты; среднее и медиана — по точным."""
    if not values:
        return {"avg_days": None, "median_days": None, "mode_days": [], "visits": 0}
    frequencies = Counter(round(value * 1440) for value in values)
    highest = max(frequencies.values())
    modes = sorted(minutes / 1440 for minutes, count in frequencies.items() if count == highest)
    if highest == 1 and len(frequencies) > 1:
        modes = []
    return {"avg_days": mean(values), "median_days": median(values), "mode_days": modes, "visits": len(values)}
