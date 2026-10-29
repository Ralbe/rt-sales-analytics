"""Расчёт показателей воронки на Pandas.

Проект считается «в воронке» на дату D, если start_date <= D и он ещё не закрыт
(closed_at пуст или closed_at > D). Это позволяет восстановить состояние воронки
на любую дату в прошлом без отдельных снапшотов.
"""

import warnings
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import cache
from app.models import STAGE_LABELS, Client, Project, Segment, Service, Stage, User
from app.schemas import LEGACY_STAGE_SCOPE_NOTE

FIT_WINDOW_DAYS = 180
STAGE_SCOPE = {"stage_scope": "legacy", "scope_note": LEGACY_STAGE_SCOPE_NOTE}


def cache_key(name: str, filters: "Filters", **params) -> str:
    return cache.make_key(
        "analytics", fn=name, filters=filters, stage_scope="legacy", segment_scope="project", **params,
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
    if f.scope_manager_id is not None:
        q = q.where(Project.manager_id == f.scope_manager_id)
    if f.segment_ids:
        q = q.where(segment_id.in_(f.segment_ids))
    if f.service_ids:
        q = q.where(Project.service_id.in_(f.service_ids))
    if f.manager_ids:
        q = q.where(Project.manager_id.in_(f.manager_ids))

    columns = ["id", "amount", "stage", "start_date", "closed_at", "service_id", "manager_id", "segment_id"]
    df = pd.DataFrame(db.execute(q).all(), columns=columns)
    df["amount"] = df["amount"].astype(float)
    df["stage"] = df["stage"].map(lambda s: s.value if isinstance(s, Stage) else s)
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["closed_at"] = pd.to_datetime(df["closed_at"])
    return df


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

    pred, band, method = forecast(series[pd.Timestamp(fit_start) :], horizon)
    digits = 2 if metric == "funnel" else 1
    shown = series[pd.Timestamp(hist_start) :]
    history = [{"date": ts.date(), "value": round(float(v), digits)} for ts, v in shown.items()]
    future = [
        {
            "date": as_of + timedelta(days=i + 1),
            "value": round(max(float(p), 0.0), digits),
            "lower": round(max(float(p - b), 0.0), digits),
            "upper": round(max(float(p + b), 0.0), digits),
        }
        for i, (p, b) in enumerate(zip(pred, band, strict=False))
    ]
    return {"metric": metric, "history": history, "forecast": future, "method": method, **STAGE_SCOPE}


def _labels(db: Session, group_by: str) -> dict:
    if group_by == "segment":
        return dict(db.execute(select(Segment.id, Segment.name)).all())
    if group_by == "service":
        return dict(db.execute(select(Service.id, Service.name)).all())
    if group_by == "manager":
        return dict(db.execute(select(User.id, User.full_name)).all())
    return {s.value: label for s, label in STAGE_LABELS.items()}


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
