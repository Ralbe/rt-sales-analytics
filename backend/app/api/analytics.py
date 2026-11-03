from collections.abc import Callable
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core import cache
from app.db import get_db
from app.deps import get_current_user, manager_scope
from app.models import User
from app.schemas import BreakdownOut, GroupBy, KpiKey, KpiOut, TrendMetric, TrendOut
from app.services import analytics
from app.services.analytics import Filters

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
