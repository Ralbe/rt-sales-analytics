"""Новые версии отчётов и импорт на PostgreSQL; база создаётся специально для тестов."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_reports_postgres import report_api, report_engine  # noqa: F401

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.main import app
from app.models import Project, ReferenceValue, ReportArchive, User


def test_parallel_archive_save_is_idempotent(report_api, report_engine):  # noqa: F811
    request, _, _ = report_api
    response = request("admin@example.com", "POST", "/api/reports/preview", {
        "definition": {"grain": "project", "columns": ["project.id", "project.profit"], "filters": [], "sort": []},
    })
    assert response.status_code == 200, response.text
    sid = response.json()["snapshot_id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: request("admin@example.com", "POST", "/api/report-archives",
                                                 {"snapshot_id": sid}), range(2)))
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert results[0].json() == results[1].json()
    with Session(report_engine) as db:
        assert db.scalar(select(func.count()).select_from(ReportArchive).where(
            ReportArchive.source_snapshot_id == sid,
        )) == 1


def test_parallel_import_confirmation_creates_one_project(report_api, report_engine):  # noqa: F811
    request, _, _ = report_api
    with Session(report_engine) as db:
        user = db.scalar(select(User).where(User.email == "admin@example.com"))
        token = create_token(user.id, SCOPE_ACCESS, 60, ver=user.auth_version)
        stage = db.scalar(select(ReferenceValue.name).where(ReferenceValue.category == "customer_stage"))
    book = Workbook()
    book.active.title = "Список проектов"
    book.active.append(["Клиент", "Описание проекта", "Этап", "январь"])
    book.active.append(["PG Import", "Parallel upload", stage, 42])
    buffer = BytesIO()
    book.save(buffer)
    with TestClient(app) as client:
        client.cookies.set(ACCESS_COOKIE, token)
        response = client.post("/api/project-imports/preview", params={"filename": "check.xlsx", "header_row": 1},
                               content=buffer.getvalue())
    assert response.status_code == 200, response.text
    iid = response.json()["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: request("admin@example.com", "POST", f"/api/project-imports/{iid}/commit"),
                                range(2)))
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert results[0].json() == results[1].json() and results[0].json()["created"] == 1
    with Session(report_engine) as db:
        assert db.scalar(select(func.count()).select_from(Project).where(Project.name == "Parallel upload")) == 1


def test_migration_does_not_drop_saved_history(report_api, report_engine, monkeypatch):  # noqa: F811
    request, _, _ = report_api
    source = request("admin@example.com", "POST", "/api/reports/preview", {
        "definition": {"grain": "project", "columns": ["project.id"], "filters": [], "sort": []},
    }).json()
    saved = request("admin@example.com", "POST", "/api/report-archives", {"snapshot_id": source["snapshot_id"]}).json()
    monkeypatch.setattr(settings, "database_url", report_engine.url.render_as_string(hide_password=False))
    with pytest.raises(RuntimeError, match="Откат удалит"):
        command.downgrade(Config("alembic.ini"), "0014_dashboard_titles")
    assert request("admin@example.com", "GET", f"/api/report-archives/{saved['id']}").status_code == 200
