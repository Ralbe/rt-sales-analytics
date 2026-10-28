"""Ограничение размера только входящих запросов конструктора отчётов."""

from starlette.responses import JSONResponse

MAX_REPORT_REQUEST_BYTES = 65536


class ReportRequestLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope["method"] not in {"POST", "PUT"}
            or not (scope["path"] == "/api/reports" or scope["path"].startswith("/api/reports/"))
        ):
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_REPORT_REQUEST_BYTES:
                response = JSONResponse({"detail": "Запрос отчёта превышает 64 КБ"}, status_code=413)
                await response(scope, receive, send)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        sent = False

        async def buffered_receive():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, buffered_receive, send)
