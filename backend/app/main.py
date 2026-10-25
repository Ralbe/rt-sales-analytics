import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator

from app.api import analytics, auth, clients, dashboards, projects, refs, users
from app.core.config import settings
from app.telemetry import configure_tracing

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(application: FastAPI):
    try:
        yield
    finally:
        provider = getattr(application.state, "tracer_provider", None)
        if provider is not None:
            try:
                flushed = provider.force_flush(timeout_millis=5_000)
            except Exception:
                flushed = False
            try:
                provider.shutdown()
            except Exception:
                logger.warning("Не удалось штатно завершить экспорт трасс.")
            if not flushed:
                logger.warning("Не все трассы удалось отправить перед остановкой API.")

app = FastAPI(
    title="RT Analytics API",
    description="Воронка продаж, проекты и конструктор дашбордов",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

for module in (auth, refs, clients, projects, analytics, dashboards, users):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["system"])
def health() -> dict:
    return {"status": "ok"}


Instrumentator(excluded_handlers=["/metrics", "/api/health"]).instrument(app).expose(
    app, endpoint="/metrics", include_in_schema=False
)

app.state.tracer_provider = configure_tracing(
    app,
    enabled=settings.otel_traces_exporter == "otlp",
    service_name=settings.otel_service_name,
    sample_ratio=settings.otel_traces_sampler_arg,
)
