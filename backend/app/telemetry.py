from typing import Any

from fastapi import FastAPI
from opentelemetry import propagate, trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagators.textmap import Getter
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import SpanKind, Status, StatusCode
from starlette.types import ASGIApp, Receive, Scope, Send

_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"})
_EXCLUDED_PATHS = frozenset({"/metrics", "/api/health", "/api/docs", "/api/openapi.json", "/api/redoc"})
class _TraceparentGetter(Getter[dict[str, str]]):
    """Передавать propagator-у только заголовок traceparent."""

    def get(self, carrier: dict[str, str], key: str) -> list[str] | None:
        value = carrier.get(key.lower()) if key.lower() == "traceparent" else None
        return [value] if value is not None else None

    def keys(self, carrier: dict[str, str]) -> list[str]:
        return ["traceparent"] if "traceparent" in carrier else []


_TRACEPARENT_GETTER = _TraceparentGetter()


def _is_excluded(path: str) -> bool:
    return any(
        path == excluded
        or (excluded.endswith(("/health", "/docs", "/redoc")) and path.startswith(excluded + "/"))
        for excluded in _EXCLUDED_PATHS
    )


class _TelemetryMiddleware:
    def __init__(self, app: ASGIApp, tracer: trace.Tracer) -> None:
        self.app = app
        self.tracer = tracer

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _is_excluded(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", ())}
        parent_context = propagate.get_global_textmap().extract(
            headers, getter=_TRACEPARENT_GETTER
        )
        method = scope.get("method", "")
        safe_method = method if method in _METHODS else "_OTHER"
        status_code = 500
        route_path: str | None = None

        with self.tracer.start_as_current_span(
            f"HTTP {safe_method}",
            context=parent_context,
            kind=SpanKind.SERVER,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            span.set_attribute("http.request.method", safe_method)

            async def send_with_status(message: dict[str, Any]) -> None:
                nonlocal status_code
                if message["type"] == "http.response.start":
                    status_code = int(message["status"])
                await send(message)

            try:
                await self.app(scope, receive, send_with_status)
                if status_code >= 500:
                    span.set_status(Status(StatusCode.ERROR))
            except Exception:
                span.set_status(Status(StatusCode.ERROR))
                raise
            finally:
                route = scope.get("route")
                candidate = getattr(route, "path_format", None)
                if isinstance(candidate, str):
                    route_path = candidate
                if route_path is not None:
                    span.set_attribute("http.route", route_path)
                span.set_attribute("http.response.status_code", status_code)


def configure_tracing(
    app: FastAPI,
    *,
    enabled: bool,
    service_name: str,
    sample_ratio: float = 1.0,
    exporter: SpanExporter | None = None,
) -> TracerProvider | None:
    if not enabled:
        return None

    provider = TracerProvider(
        resource=Resource.create({SERVICE_NAME: service_name}),
        sampler=ParentBased(TraceIdRatioBased(sample_ratio)),
    )
    provider.add_span_processor(BatchSpanProcessor(exporter if exporter is not None else OTLPSpanExporter()))
    app.state.tracer_provider = provider
    app.add_middleware(_TelemetryMiddleware, tracer=provider.get_tracer(__name__))
    return provider
