"""Транзакционные проверки отчётов в специально созданной временной базе PostgreSQL."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from pathlib import Path
from threading import Event
from time import monotonic
from uuid import uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import Project, ProjectFieldLabel, ReportDefinition, ReportSnapshot, ReportSnapshotQuota, Role, User
from app.seed import seed


@pytest.fixture(scope="module")
def report_engine():
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Нужен TEST_POSTGRES_URL")
    parsed = make_url(url)
    assert parsed.get_backend_name() == "postgresql"
    database = "test_reports_" + uuid4().hex
    control = create_engine(parsed, isolation_level="AUTOCOMMIT", hide_parameters=True)
    engine = None
    created = False
    try:
        with control.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
        created = True
        test_url = parsed.set(database=database)
        backend = Path(__file__).resolve().parents[1]
        config = Config(str(backend / "alembic.ini"))
        config.set_main_option("script_location", str(backend / "alembic"))
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(settings, "database_url", test_url.render_as_string(hide_password=False))
            command.upgrade(config, "head")
            command.check(config)
        engine = create_engine(test_url, hide_parameters=True, connect_args={"connect_timeout": 5})
        with Session(engine) as db:
            seed(db, today=date(2026, 10, 21), projects_count=30)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with control.connect() as connection:
                connection.exec_driver_sql(f'DROP DATABASE "{database}" WITH (FORCE)')
        control.dispose()


@pytest.fixture
def report_api(report_engine, monkeypatch):
    pids, started = {}, {}

    def request_db(request: Request):
        with Session(report_engine, autoflush=False, expire_on_commit=False) as db:
            marker = request.headers.get("X-Test-Writer")
            if marker:
                pids[marker] = db.scalar(text("select pg_backend_pid()"))
                started[marker].set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)

    def request(email, method, path, body=None, marker=None):
        with Session(report_engine) as db:
            user = db.scalar(select(User).where(User.email == email))
            token = create_token(user.id, SCOPE_ACCESS, 60, ver=user.auth_version)
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.set(ACCESS_COOKIE, token)
            return client.request(method, path, json=body, headers={"X-Test-Writer": marker or ""})

    return request, pids, started


def wait_block(engine, waiting, blocker, future):
    deadline = monotonic() + 5
    with engine.connect() as observer:
        while monotonic() < deadline and not future.done():
            if blocker in observer.scalar(text("select pg_blocking_pids(:pid)"), {"pid": waiting}):
                return
            Event().wait(0.02)
    pytest.fail("Блокировка PostgreSQL не наблюдалась")


def setup_report(report_api, report_engine):
    request, _, _ = report_api
    assert request("manager1@example.com", "DELETE", "/api/report-snapshots").status_code == 204
    with Session(report_engine) as db:
        manager = db.scalar(select(User).where(User.email == "manager1@example.com"))
        project = db.scalar(select(Project).where(Project.manager_id == manager.id))
        project_id, manager_id = project.id, manager.id
    spec = {
        "grain": "project",
        "columns": ["project.id", "project.name"],
        "filters": [{"field": "project.id", "operator": "eq", "value": project_id}],
        "sort": [],
    }
    response = request("analyst@example.com", "POST", "/api/reports", {"title": "Проверка", "definition": spec})
    assert response.status_code == 201, response.text
    report_id = response.json()["id"]
    response = request(
        "analyst@example.com", "POST", f"/api/reports/{report_id}/publish", {"published": True, "version": 1}
    )
    assert response.status_code == 200, response.text
    response = request("manager1@example.com", "POST", f"/api/reports/{report_id}/run", {"version": 2})
    assert response.status_code == 200, response.text
    return report_id, response.json()["snapshot_id"], project_id, manager_id


@pytest.mark.parametrize("event", ["revoke", "owner", "archive", "role"])
def test_concurrent_access_waits_for_security_change(report_engine, report_api, event):
    request, pids, started = report_api
    report_id, snapshot_id, project_id, manager_id = setup_report(report_api, report_engine)
    started["reader"] = Event()
    with report_engine.connect() as writer:
        tx = writer.begin()
        blocker = writer.scalar(text("select pg_backend_pid()"))
        if event == "revoke":
            writer.execute(update(ReportDefinition).where(ReportDefinition.id == report_id).values(published=False))
            path, method = f"/api/reports/{report_id}/run", "POST"
        elif event == "owner":
            other = writer.scalar(select(User.id).where(User.email == "manager2@example.com"))
            writer.execute(update(Project).where(Project.id == project_id).values(manager_id=other))
            path, method = f"/api/report-snapshots/{snapshot_id}/export", "GET"
        elif event == "archive":
            writer.execute(update(Project).where(Project.id == project_id).values(archived_at=datetime.now(UTC)))
            path, method = f"/api/report-snapshots/{snapshot_id}", "GET"
        else:
            writer.execute(update(User).where(User.id == manager_id).values(role=Role.analyst))
            path, method = f"/api/report-snapshots/{snapshot_id}", "GET"
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(request, "manager1@example.com", method, path, {"version": 2}, "reader")
            try:
                assert started["reader"].wait(5)
                wait_block(report_engine, pids["reader"], blocker, future)
            finally:
                tx.commit()
            result = future.result(timeout=10)
        assert result.status_code == 404, result.text
        assert request("manager1@example.com", "GET", f"/api/report-snapshots/{snapshot_id}").status_code == 404
        assert request("manager1@example.com", "GET", f"/api/report-snapshots/{snapshot_id}/export").status_code == 404
        with writer.begin():
            if event == "owner":
                writer.execute(update(Project).where(Project.id == project_id).values(manager_id=manager_id))
            elif event == "role":
                writer.execute(update(User).where(User.id == manager_id).values(role=Role.user))
            elif event == "archive":
                writer.execute(update(Project).where(Project.id == project_id).values(archived_at=None))
            else:
                writer.execute(update(ReportDefinition).where(ReportDefinition.id == report_id).values(published=True))
        assert request("manager1@example.com", "GET", f"/api/report-snapshots/{snapshot_id}").status_code == 200


def test_other_users_snapshot_read_and_export_do_not_wait_for_quota(report_engine, report_api):
    request, _, _ = report_api
    _, snapshot_id, _, _ = setup_report(report_api, report_engine)
    spec = {"grain": "project", "columns": ["project.id"], "filters": [], "sort": []}
    preview = request("admin@example.com", "POST", "/api/reports/preview", {"definition": spec})
    assert preview.status_code == 200, preview.text
    admin_snapshot = preview.json()["snapshot_id"]
    with report_engine.connect() as holder:
        tx = holder.begin()
        holder.execute(select(ReportSnapshotQuota).where(ReportSnapshotQuota.id == 1).with_for_update())
        try:
            # Блокировка удерживается дольше действующего lock_timeout = 5 с.
            Event().wait(5.2)
            with ThreadPoolExecutor(max_workers=2) as pool:
                page = pool.submit(request, "manager1@example.com", "GET", f"/api/report-snapshots/{snapshot_id}")
                export = pool.submit(
                    request, "admin@example.com", "GET", f"/api/report-snapshots/{admin_snapshot}/export"
                )
                page_response = page.result(timeout=8)
                export_response = export.result(timeout=8)
            assert page_response.status_code == 200, page_response.text
            assert export_response.status_code == 200, export_response.text
            assert page_response.headers["cache-control"] == "private, no-store"
            assert export_response.headers["cache-control"] == "private, no-store"
        finally:
            tx.rollback()


@pytest.mark.parametrize("event", ["revoke", "archive", "owner", "role"])
def test_snapshot_access_serializes_concurrent_security_change(report_engine, report_api, monkeypatch, event):
    from app.services import report_builder

    request, pids, started = report_api
    report_id, snapshot_id, project_id, manager_id = setup_report(report_api, report_engine)
    started["reader"] = Event()
    ready, release = Event(), Event()
    original = report_builder.lock_projects

    def held(db, user, ids):
        original(db, user, ids)
        ready.set()
        assert release.wait(8)

    monkeypatch.setattr(report_builder, "lock_projects", held)
    path = f"/api/report-snapshots/{snapshot_id}"
    if event in {"archive", "owner"}:
        path += "/export"
    with report_engine.connect() as writer:
        writer_pid = writer.scalar(text("select pg_backend_pid()"))
        other_id = writer.scalar(select(User.id).where(User.email == "manager2@example.com"))

        def modify():
            if event == "revoke":
                writer.execute(update(ReportDefinition).where(ReportDefinition.id == report_id).values(published=False))
            elif event == "archive":
                writer.execute(update(Project).where(Project.id == project_id).values(archived_at=datetime.now(UTC)))
            elif event == "owner":
                writer.execute(update(Project).where(Project.id == project_id).values(manager_id=other_id))
            else:
                writer.execute(update(User).where(User.id == manager_id).values(role=Role.analyst))
            writer.commit()

        with ThreadPoolExecutor(max_workers=2) as pool:
            reader = pool.submit(request, "manager1@example.com", "GET", path, None, "reader")
            try:
                assert started["reader"].wait(5)
                assert ready.wait(5)
                change = pool.submit(modify)
                wait_block(report_engine, writer_pid, pids["reader"], change)
            finally:
                release.set()
            response = reader.result(timeout=10)
            change.result(timeout=10)
        assert response.status_code == 200, response.text
        monkeypatch.setattr(report_builder, "lock_projects", original)
        assert request("manager1@example.com", "GET", path).status_code == 404
        if event == "revoke":
            writer.execute(update(ReportDefinition).where(ReportDefinition.id == report_id).values(published=True))
        elif event == "archive":
            writer.execute(update(Project).where(Project.id == project_id).values(archived_at=None))
        elif event == "owner":
            writer.execute(update(Project).where(Project.id == project_id).values(manager_id=manager_id))
        else:
            writer.execute(update(User).where(User.id == manager_id).values(role=Role.user))
        writer.commit()
    assert request("manager1@example.com", "GET", path).status_code == 200


def test_global_quota_serializes_concurrent_creation(report_engine, report_api):
    request, _, _ = report_api
    request("analyst@example.com", "DELETE", "/api/report-snapshots")
    spec = {"grain": "project", "columns": ["project.id"], "filters": [], "sort": []}
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(
            pool.map(
                lambda _: request("analyst@example.com", "POST", "/api/reports/preview", {"definition": spec}), range(6)
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 200, 200, 200, 200, 429]
    with Session(report_engine) as db:
        user_id = db.scalar(select(User.id).where(User.email == "analyst@example.com"))
        assert len(db.scalars(select(ReportSnapshot).where(ReportSnapshot.owner_id == user_id)).all()) == 5


def test_concurrent_label_change_keeps_snapshot_and_export_consistent(report_engine, report_api, monkeypatch):
    from io import BytesIO

    from openpyxl import load_workbook

    from app.services import report_builder

    request, _, _ = report_api
    request("analyst@example.com", "DELETE", "/api/report-snapshots")
    with Session(report_engine) as db:
        label = db.get(ProjectFieldLabel, "name")
        if label is None:
            db.add(ProjectFieldLabel(key="name", label="Подпись до изменения"))
        else:
            label.label = "Подпись до изменения"
        db.commit()
    ready, release = Event(), Event()
    original = report_builder.registry

    def held(db):
        result = original(db)
        ready.set()
        assert release.wait(8)
        return result

    monkeypatch.setattr(report_builder, "registry", held)
    spec = {"grain": "project", "columns": ["project.name"], "filters": [], "sort": []}
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(request, "analyst@example.com", "POST", "/api/reports/preview", {"definition": spec})
        try:
            assert ready.wait(8)
            with Session(report_engine) as db:
                db.get(ProjectFieldLabel, "name").label = "Подпись после изменения"
                db.commit()
        finally:
            release.set()
        result = future.result(timeout=10)
    assert result.status_code == 200, result.text
    sid = result.json()["snapshot_id"]
    page = request("analyst@example.com", "GET", f"/api/report-snapshots/{sid}")
    exported = request("analyst@example.com", "GET", f"/api/report-snapshots/{sid}/export")
    assert page.json()["columns"][0]["label"] == "Подпись до изменения"
    assert load_workbook(BytesIO(exported.content)).active["A1"].value == "Подпись до изменения"


def test_global_quota_between_different_users(report_engine, report_api, monkeypatch):
    from sqlalchemy import delete

    from app.services import report_builder

    with Session(report_engine) as db:
        db.execute(delete(ReportSnapshot))
        db.commit()
    monkeypatch.setattr(report_builder, "MAX_GLOBAL_SNAPSHOTS", 1)
    request, _, _ = report_api
    spec = {"grain": "project", "columns": ["project.id"], "filters": [], "sort": []}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda email: request(email, "POST", "/api/reports/preview", {"definition": spec}),
                ["admin@example.com", "analyst@example.com"],
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 429]
    with Session(report_engine) as db:
        assert len(db.scalars(select(ReportSnapshot)).all()) == 1


def test_migration_refuses_to_drop_existing_reports(report_engine):
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(settings, "database_url", report_engine.url.render_as_string(hide_password=False))
        with pytest.raises(RuntimeError, match="сохранённые отчёты"):
            command.downgrade(config, "0010")
        command.check(config)


def test_empty_migration_downgrade_and_upgrade(report_engine):
    from sqlalchemy import delete, inspect

    with Session(report_engine) as db:
        db.execute(delete(ReportSnapshot))
        db.execute(delete(ReportDefinition))
        db.commit()
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(settings, "database_url", report_engine.url.render_as_string(hide_password=False))
        command.downgrade(config, "0010")
        assert "report_definitions" not in inspect(report_engine).get_table_names()
        command.upgrade(config, "head")
        command.check(config)
