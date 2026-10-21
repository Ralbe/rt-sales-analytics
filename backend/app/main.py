from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator

from app.api import analytics, auth, clients, dashboards, projects, refs

app = FastAPI(
    title="RT Analytics API",
    description="Воронка продаж, проекты и конструктор дашбордов",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

for module in (auth, refs, clients, projects, analytics, dashboards):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["system"])
def health() -> dict:
    return {"status": "ok"}


Instrumentator(excluded_handlers=["/metrics", "/api/health"]).instrument(app).expose(
    app, endpoint="/metrics", include_in_schema=False
)
