"""Расчёт показателей воронки на Pandas.

Проект считается «в воронке» на дату D, если start_date <= D и он ещё не закрыт
(closed_at пуст или closed_at > D). Это позволяет восстановить состояние воронки
на любую дату в прошлом без отдельных снапшотов.

Учитываются проекты обеих схем. У проекта на этапах заказчика датой закрытия считается
день перехода на этап «Успех» по журналу изменений; такой проект считается выигранным.
"""

import warnings
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import cache
from app.models import STAGE_LABELS, Client, Project, ReferenceValue, Segment, Service, Stage, User
from app.schemas import ANALYTICS_SCOPE_NOTE
from app.services.pipeline import SUCCESS_STAGE_CODE, _day, project_events, stage_timeline

FIT_WINDOW_DAYS = 180
STAGE_SCOPE = {"stage_scope": "all", "scope_note": ANALYTICS_SCOPE_NOTE}


def cache_key(name: str, filters: "Filters", **params) -> str:
    return cache.make_key(
        "analytics", fn=name, filters=filters, stage_scope="all", segment_scope="project", **params,
    )


KPI_TITLES = {
    "funnel": ("Объём воронки", "rub"),
    "projects": ("Активные проекты", "count"),
    "won_ytd": ("Выиграно с начала года", "rub"),
}

GROUP_COLUMNS = {
    "segment": "segment_id",
    "service": "service_id",
    "manager": "manager_id",
    "stage": "stage",
}


@dataclass(frozen=True)
class Filters:
    segment_ids: tuple[int, ...] = ()
    service_ids: tuple[int, ...] = ()
    manager_ids: tuple[int, ...] = ()
    # Ограничение по правам: пользователь видит только свои проекты.
    scope_manager_id: int | None = None
    can_view_archive: bool = False


def load_frame(db: Session, f: Filters) -> pd.DataFrame:
    segment_id = func.coalesce(Project.segment_id, Client.segment_id)
    q = select(
        Project.id,
        Project.amount,
        Project.stage,
        Project.start_date,
        Project.closed_at,
        Project.service_id,
        Project.manager_id,
        segment_id.label("segment_id"),
    ).join(Client, Client.id == Project.client_id).where(
        Project.archived_at.is_(None), Project.stage_scheme == "legacy",
    )
    q = _apply_filters(q, f, segment_id)
    columns = ["id", "amount", "stage", "start_date", "closed_at", "service_id", "manager_id", "segment_id"]
    rows = list(db.execute(q).all()) + _customer_rows(db, f)
    df = pd.DataFrame(rows, columns=columns)
    df["amount"] = df["amount"].astype(float)
    df["stage"] = df["stage"].map(lambda s: s.value if isinstance(s, Stage) else s)
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["closed_at"] = pd.to_datetime(df["closed_at"])
    return df


def _apply_filters(q, f: Filters, segment_id):
    if f.scope_manager_id is not None:
        q = q.where(Project.manager_id == f.scope_manager_id)
    if f.segment_ids:
        q = q.where(segment_id.in_(f.segment_ids))
    if f.service_ids:
        q = q.where(Project.service_id.in_(f.service_ids))
    if f.manager_ids:
        q = q.where(Project.manager_id.in_(f.manager_ids))
    return q


def customer_stage_key(stage_id: int) -> str:
    return f"customer:{stage_id}"


def _customer_rows(db: Session, f: Filters) -> list[tuple]:
    """Проекты на этапах заказчика в формате прежней воронки: «Успех» = выигран с датой перехода."""
    segment_id = func.coalesce(Project.segment_id, Client.segment_id)
    q = select(Project).join(Client, Client.id == Project.client_id).where(
        Project.archived_at.is_(None), Project.stage_scheme == "customer",
    )
    projects = list(db.scalars(_apply_filters(q, f, segment_id)).unique().all())
    success = [p for p in projects if p.customer_stage and p.customer_stage.code == SUCCESS_STAGE_CODE]
    events = project_events(db, [p.id for p in success])
    rows = []
    for p in projects:
        segment = p.segment_id or p.client.segment_id
        if p in success:
            timeline = stage_timeline(p, events.get(p.id, []))
            reached = next((at for at, stage_id in reversed(timeline) if stage_id == p.customer_stage_id), None)
            closed = max(_day(reached), p.start_date) if reached is not None else p.start_date
            rows.append((p.id, p.amount, Stage.won.value, p.start_date, closed, p.service_id, p.manager_id, segment))
        else:
            stage = customer_stage_key(p.customer_stage_id)
            rows.append((p.id, p.amount, stage, p.start_date, None, p.service_id, p.manager_id, segment))
    return rows


def year_ago(d: date) -> date:
    return (pd.Timestamp(d) - pd.DateOffset(years=1)).date()


def _open_mask(df: pd.DataFrame, d: date) -> pd.Series:
    ts = pd.Timestamp(d)
    return (df["start_date"] <= ts) & (df["closed_at"].isna() | (df["closed_at"] > ts))


def _won_ytd_mask(df: pd.DataFrame, d: date) -> pd.Series:
    ts = pd.Timestamp(d)
    return (df["stage"] == Stage.won.value) & (df["closed_at"] >= pd.Timestamp(d.year, 1, 1)) & (df["closed_at"] <= ts)


def _metric_values(df: pd.DataFrame, d: date, metric: str) -> pd.Series:
    """Возвращает значения метрики по проектам, попадающим в метрику на дату d."""
    mask = _won_ytd_mask(df, d) if metric == "won_ytd" else _open_mask(df, d)
    sub = df[mask]
    return sub["amount"] if metric in ("funnel", "won_ytd") else pd.Series(1.0, index=sub.index)


def _delta_pct(value: float, previous: float) -> float | None:
    if previous == 0:
        return None
    return round((value - previous) / previous * 100, 1)


def kpi(db: Session, f: Filters, as_of: date) -> dict:
    df = load_frame(db, f)
    prev = year_ago(as_of)
    items = []
    for key, (title, unit) in KPI_TITLES.items():
        value = float(_metric_values(df, as_of, key).sum())
        previous = float(_metric_values(df, prev, key).sum())
        items.append(
            {
                "key": key,
                "title": title,
                "unit": unit,
                "value": round(value, 2),
                "previous": round(previous, 2),
                "delta_pct": _delta_pct(value, previous),
            }
        )
    return {"as_of": as_of, "previous_as_of": prev, "items": items, **STAGE_SCOPE}


def daily_series(df: pd.DataFrame, start: date, end: date, metric: str) -> pd.Series:
    """Значение метрики «в воронке» на каждый день интервала [start, end]."""
    idx = pd.date_range(start, end, freq="D")
    if df.empty:
        return pd.Series(0.0, index=idx)
    values = df["amount"] if metric == "funnel" else pd.Series(1.0, index=df.index)
    opened = values.groupby(df["start_date"]).sum()
    closed = values[df["closed_at"].notna()].groupby(df["closed_at"].dropna()).sum()
    full_idx = pd.date_range(min(df["start_date"].min(), pd.Timestamp(start)), end, freq="D")
    deltas = opened.reindex(full_idx, fill_value=0.0) - closed.reindex(full_idx, fill_value=0.0)
    return deltas.cumsum().reindex(idx).astype(float)


def forecast(series: pd.Series, horizon: int) -> tuple[np.ndarray, np.ndarray, str]:
    """Прогноз на horizon дней вперёд: демпфированный тренд Холта, при сбое — линейный тренд.

    Возвращает (прогноз, полуширину 95% интервала, метод).
    """
    y = series.to_numpy(dtype=float)
    steps = np.arange(1, horizon + 1)
    if len(y) >= 14 and np.ptp(y) > 0:
        try:
            from statsmodels.tsa.holtwinters import ExponentialSmoothing

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                fit = ExponentialSmoothing(
                    y, trend="add", damped_trend=True, initialization_method="estimated"
                ).fit()
            pred = np.asarray(fit.forecast(horizon), dtype=float)
            sigma = float(np.std(fit.resid))
            if np.all(np.isfinite(pred)):
                return pred, 1.96 * sigma * np.sqrt(steps), "holt_damped"
        except Exception:  # noqa: BLE001 — модель не сошлась, используем запасной вариант
            pass
    tail = y[-28:] if len(y) else np.zeros(1)
    if len(tail) >= 2:
        x = np.arange(len(tail))
        slope, intercept = np.polyfit(x, tail, 1)
        pred = intercept + slope * (len(tail) - 1 + steps)
        sigma = float(np.std(tail - (intercept + slope * x)))
    else:
        pred = np.full(horizon, tail[-1])
        sigma = 0.0
    return pred, 1.96 * sigma * np.sqrt(steps), "linear"


def trend(db: Session, f: Filters, as_of: date, weeks: int, horizon: int, metric: str) -> dict:
    df = load_frame(db, f)
    fit_start = as_of - timedelta(days=FIT_WINDOW_DAYS - 1)
    hist_start = as_of - timedelta(days=weeks * 7 - 1)
    series = daily_series(df, min(fit_start, hist_start), as_of, metric)

    # Прогноз по решению заказчика не показывается: виджет отражает только фактическую динамику.
    digits = 2 if metric == "funnel" else 1
    shown = series[pd.Timestamp(hist_start) :]
    history = [{"date": ts.date(), "value": round(float(v), digits)} for ts, v in shown.items()]
    return {"metric": metric, "history": history, "forecast": [], "method": "none", **STAGE_SCOPE}


def _labels(db: Session, group_by: str) -> dict:
    if group_by == "segment":
        return dict(db.execute(select(Segment.id, Segment.name)).all())
    if group_by == "service":
        return dict(db.execute(select(Service.id, Service.name)).all())
    if group_by == "manager":
        return dict(db.execute(select(User.id, User.full_name)).all())
    labels = {s.value: label for s, label in STAGE_LABELS.items()}
    stages = db.execute(select(ReferenceValue.id, ReferenceValue.name).where(
        ReferenceValue.category == "customer_stage",
    )).all()
    return labels | {customer_stage_key(stage_id): name for stage_id, name in stages}


def breakdown(db: Session, f: Filters, as_of: date, group_by: str, metric: str) -> dict:
    df = load_frame(db, f)
    values = _metric_values(df, as_of, metric)
    grouped = values.groupby(df.loc[values.index, GROUP_COLUMNS[group_by]]).sum().sort_values(ascending=False)
    labels = _labels(db, group_by)
    items = [
        {"key": str(key), "label": labels.get(key, str(key)), "value": round(float(v), 2)}
        for key, v in grouped.items()
        if v
    ]
    return {"metric": metric, "group_by": group_by, "items": items, **STAGE_SCOPE}


def monthly_trend(db: Session, f: Filters, year: int, months: list[int], metric: str, as_of: date) -> dict:
    """Остаток проектов на конец месяца; текущий месяц — на дату расчёта."""
    from calendar import monthrange

    df = load_frame(db, f)
    history = []
    for month in sorted(set(months)):
        start = date(year, month, 1)
        if start > as_of:
            continue
        end = min(date(year, month, monthrange(year, month)[1]), as_of)
        value = float(_metric_values(df, end, metric).sum())
        history.append({"date": start, "value": round(value, 2)})
    return {"metric": metric, "history": history, "forecast": [], "method": "month_end", **STAGE_SCOPE}
