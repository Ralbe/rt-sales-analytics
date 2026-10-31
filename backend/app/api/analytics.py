from collections.abc import Callable
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core import cache
from app.db import get_db
from app.deps import get_current_user, manager_scope
from app.models import User
from app.schemas import (
    BreakdownOut,
    GroupBy,
    KpiKey,
    KpiOut,
    PeriodChangesOut,
    PipelineOut,
    TrendMetric,
    TrendOut,
)
from app.services import analytics, pipeline
from app.services.analytics import Filters
from app.services.pipeline import PipelineFilters

router = APIRouter(prefix="/analytics", tags=["analytics"])


def get_filters(
    segment_id: list[int] = Query(default=[]),
    service_id: list[int] = Query(default=[]),
    manager_id: list[int] = Query(default=[]),
    user: User = Depends(get_current_user),
) -> Filters:
    return Filters(
        segment_ids=tuple(sorted(segment_id)),
        service_ids=tuple(sorted(service_id)),
        manager_ids=tuple(sorted(manager_id)),
        scope_manager_id=manager_scope(user),
    )


def cached(name: str, f: Filters, compute: Callable[[], Any], **params: Any) -> Any:
    key = analytics.cache_key(name, f, **params)
    result = cache.get_json(key)
    if result is None:
        result = compute()
        cache.set_json(key, result)
    return {**result, **analytics.STAGE_SCOPE}


@router.get("/kpi", response_model=KpiOut)
def kpi(
    as_of: date | None = None,
    f: Filters = Depends(get_filters),
    db: Session = Depends(get_db),
) -> Any:
    d = as_of or date.today()
    return cached("kpi", f, lambda: analytics.kpi(db, f, d), as_of=d)


@router.get("/trend", response_model=TrendOut)
def trend(
    metric: TrendMetric = "funnel",
    weeks: int = Query(default=6, ge=1, le=26),
    horizon: int = Query(default=14, ge=1, le=60),
    as_of: date | None = None,
    f: Filters = Depends(get_filters),
    db: Session = Depends(get_db),
) -> Any:
    d = as_of or date.today()
    return cached(
        "trend", f, lambda: analytics.trend(db, f, d, weeks, horizon, metric),
        as_of=d, weeks=weeks, horizon=horizon, metric=metric,
    )


@router.get("/breakdown", response_model=BreakdownOut)
def breakdown(
    group_by: GroupBy = "segment",
    metric: KpiKey = "funnel",
    as_of: date | None = None,
    f: Filters = Depends(get_filters),
    db: Session = Depends(get_db),
) -> Any:
    d = as_of or date.today()
    return cached(
        "breakdown", f, lambda: analytics.breakdown(db, f, d, group_by, metric),
        as_of=d, group_by=group_by, metric=metric,
    )


def get_pipeline_filters(
    segment_id: list[int] = Query(default=[]),
    service_id: list[int] = Query(default=[]),
    manager_id: list[int] = Query(default=[]),
    customer_stage_id: list[int] = Query(default=[]),
    implementation_year: int | None = Query(default=None, ge=1900, le=2200),
    user: User = Depends(get_current_user),
) -> PipelineFilters:
    return PipelineFilters(
        segment_ids=tuple(sorted(segment_id)),
        service_ids=tuple(sorted(service_id)),
        manager_ids=tuple(sorted(manager_id)),
        customer_stage_ids=tuple(sorted(customer_stage_id)),
        implementation_year=implementation_year,
        scope_manager_id=manager_scope(user),
    )


@router.get("/pipeline", response_model=PipelineOut)
def pipeline_summary(
    as_of: date | None = None,
    f: PipelineFilters = Depends(get_pipeline_filters),
    db: Session = Depends(get_db),
) -> Any:
    d = as_of or date.today()
    key = cache.make_key("analytics", fn="pipeline", filters=f, as_of=d)
    result = cache.get_json(key)
    if result is None:
        result = pipeline.summary(db, f, d)
        cache.set_json(key, result)
    return result


@router.get("/changes", response_model=PeriodChangesOut)
def period_changes(
    date_from: date,
    date_to: date,
    f: PipelineFilters = Depends(get_pipeline_filters),
    db: Session = Depends(get_db),
) -> Any:
    if date_from > date_to:
        raise HTTPException(422, {"field": "date_from", "message": "Начало периода позже конца"})
    return pipeline.period_changes(db, f, date_from, date_to)
