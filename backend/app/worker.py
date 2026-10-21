"""Фоновые задачи Celery (брокер — RabbitMQ)."""

from datetime import date

from celery import Celery

from app.core import cache
from app.core.config import settings
from app.db import SessionLocal
from app.services import analytics
from app.services.analytics import Filters

celery_app = Celery("rt", broker=settings.celery_broker_url)
celery_app.conf.update(
    task_ignore_result=True,
    timezone="Europe/Moscow",
    beat_schedule={
        "warm-analytics-cache": {"task": "app.worker.warm_analytics_cache", "schedule": 600.0},
        "reset-analytics-cache-daily": {"task": "app.worker.reset_analytics_cache", "schedule": 86400.0},
    },
)


@celery_app.task
def warm_analytics_cache() -> None:
    """Прогревает кэш для дашборда без фильтров, чтобы первый экран открывался мгновенно.

    Ключи совпадают с теми, что формирует app.api.analytics.cached.
    """
    f = Filters()
    today = date.today()
    with SessionLocal() as db:
        cache.set_json(cache.make_key("analytics", fn="kpi", filters=f, as_of=today), analytics.kpi(db, f, today))
        for metric in ("funnel", "projects"):
            key = cache.make_key("analytics", fn="trend", filters=f, as_of=today, weeks=6, horizon=14, metric=metric)
            cache.set_json(key, analytics.trend(db, f, today, 6, 14, metric))
        for group_by in ("segment", "service", "stage", "manager"):
            key = cache.make_key(
                "analytics", fn="breakdown", filters=f, as_of=today, group_by=group_by, metric="funnel"
            )
            cache.set_json(key, analytics.breakdown(db, f, today, group_by, "funnel"))


@celery_app.task
def reset_analytics_cache() -> None:
    cache.bump("analytics")
