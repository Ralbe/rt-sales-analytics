import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic import ValidationError

from app.core.config import Settings
from app.main import app as api_app
from app.telemetry import configure_tracing


def _app() -> FastAPI:
    app = FastAPI(docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url="/api/redoc")

    @app.get("/items/{item_id}")
    def get_item(item_id: str) -> dict[str, str]:
        return {"item_id": item_id}

    @app.post("/submit")
    async def submit(request_body: dict[str, str]) -> dict[str, str]:
        return request_body

    @app.get("/fail")
    def fail() -> None:
        raise RuntimeError("exception-secret-marker")

    @app.get("/handled-fail")
    def handled_fail() -> None:
        raise HTTPException(status_code=503, detail="handled-secret-marker")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/health/detail")
    def health_detail() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/metrics")
    def metrics() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/private")
    def private() -> dict[str, str]:
        return {"status": "ok"}

    return app


@pytest.fixture
def instrumented_client():
    exporter = InMemorySpanExporter()
    app = _app()
    provider = configure_tracing(app, enabled=True, service_name="test-service", exporter=exporter)
    assert provider is not None
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client, exporter
    finally:
        provider.shutdown()


def _server_spans(client: TestClient, exporter: InMemorySpanExporter) -> list[ReadableSpan]:
    provider = client.app.state.tracer_provider
    assert provider.force_flush(timeout_millis=1_000)
    return [span for span in exporter.get_finished_spans() if span.kind.name == "SERVER"]


def test_disabled_does_not_install_middleware() -> None:
    app = FastAPI()

    assert configure_tracing(app, enabled=False, service_name="test-service") is None
    assert not any("TelemetryMiddleware" in str(middleware.cls) for middleware in app.user_middleware)


def test_unsupported_sampler_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(otel_traces_sampler="always_off")


def test_records_safe_route_and_status(instrumented_client) -> None:
    client, exporter = instrumented_client

    response = client.get("/items/path-secret-marker?token=query-secret-marker")

    assert response.status_code == 200
    [span] = _server_spans(client, exporter)
    assert span.attributes["http.request.method"] == "GET"
    assert span.attributes["http.route"] == "/items/{item_id}"
    assert span.attributes["http.response.status_code"] == 200
    assert span.resource.attributes["service.name"] == "test-service"
    serialized = repr((span.name, span.attributes, span.events, span.links, span.status.description))
    assert "path-secret-marker" not in serialized
    assert "query-secret-marker" not in serialized


def test_sensitive_request_data_is_not_exported(instrumented_client) -> None:
    client, exporter = instrumented_client
    response = client.post(
        "/submit?query-secret-marker=yes",
        headers={"X-Private": "header-secret-marker", "Cookie": "session=cookie-secret-marker"},
        json={"value": "body-secret-marker"},
    )

    assert response.status_code == 200
    spans = _server_spans(client, exporter)
    serialized = repr(
        [(span.name, span.attributes, span.events, span.links, span.status.description) for span in spans]
    )
    for marker in ("query-secret-marker", "header-secret-marker", "cookie-secret-marker", "body-secret-marker"):
        assert marker not in serialized


def test_exception_is_recorded_without_message_and_reraised(instrumented_client) -> None:
    client, exporter = instrumented_client
    response = client.get("/fail")

    assert response.status_code == 500
    [span] = _server_spans(client, exporter)
    assert span.status.status_code.name == "ERROR"
    serialized = repr((span.attributes, span.events, span.links, span.status.description))
    assert "exception-secret-marker" not in serialized
    assert span.events == ()


def test_handled_server_error_is_marked_without_detail(instrumented_client) -> None:
    client, exporter = instrumented_client
    response = client.get("/handled-fail")

    assert response.status_code == 503
    [span] = _server_spans(client, exporter)
    assert span.status.status_code.name == "ERROR"
    serialized = repr((span.attributes, span.events, span.links, span.status.description))
    assert "handled-secret-marker" not in serialized
    assert span.events == ()


def test_excluded_endpoints_have_no_server_spans(instrumented_client) -> None:
    client, exporter = instrumented_client
    for path in (
        "/api/health",
        "/api/health/detail",
        "/metrics",
        "/api/docs",
        "/api/docs/oauth2-redirect",
        "/api/openapi.json",
        "/api/redoc",
        "/api/redoc/example",
    ):
        client.get(path)

    assert _server_spans(client, exporter) == []


def test_traceparent_is_parent_and_baggage_is_ignored(instrumented_client) -> None:
    client, exporter = instrumented_client
    parent_trace_id = "1234567890abcdef1234567890abcdef"
    parent_span_id = "1234567890abcdef"

    response = client.get(
        "/items/123",
        headers={
            "traceparent": f"00-{parent_trace_id}-{parent_span_id}-01",
            "baggage": "customer-secret-marker=private",
        },
    )

    assert response.status_code == 200
    [span] = _server_spans(client, exporter)
    assert span.context.trace_id == int(parent_trace_id, 16)
    assert span.parent is not None
    assert span.parent.span_id == int(parent_span_id, 16)
    serialized = repr((span.attributes, span.events, span.links))
    assert "customer-secret-marker" not in serialized
    assert "private" not in serialized


def test_prometheus_metrics_endpoint_remains_available() -> None:
    with TestClient(api_app) as client:
        response = client.get("/metrics")

    assert response.status_code == 200
    assert "# HELP" in response.text
