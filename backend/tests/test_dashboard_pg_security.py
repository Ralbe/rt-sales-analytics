"""Смена прав и операции с дашбордами в изолированной PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from project_factories import create_legacy_project, legacy_payload
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_structural_pg_concurrency import wait_for_block

from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import AuditLog, Dashboard, Project, Role, User

pytest_plugins = ["test_structural_pg_concurrency"]


@pytest.mark.parametrize("change,expected", [("deactivate", 401), ("demote", 404)])
def test_change_of_admin_rights_serializes_with_dashboard_edit(structural_engine, monkeypatch, change, expected):
    with Session(structural_engine) as db:
        admin = db.scalar(select(User).where(User.email == "admin@example.com"))
        owner = db.scalar(select(User).where(User.email == "analyst@example.com"))
        dashboard = Dashboard(owner_id=owner.id, name="Чужой личный дашборд", widgets=[], filters={})
        db.add(dashboard)
        db.commit()
        admin_id, dashboard_id = admin.id, dashboard.id
        token = create_token(admin.id, SCOPE_ACCESS, 60, ver=admin.auth_version)

    started, pids = Event(), {}

    def request_db(request: Request):
        with Session(structural_engine, autoflush=False, expire_on_commit=False) as db:
            pids["request"] = db.scalar(text("SELECT pg_backend_pid()"))
            started.set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)

    def edit():
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.set(ACCESS_COOKIE, token)
            return client.put(f"/api/dashboards/{dashboard_id}", json={"name": "Попытка", "widgets": []})

    with Session(structural_engine) as revoking:
        admin = revoking.get(User, admin_id)
        pid = revoking.scalar(text("SELECT pg_backend_pid()"))
        if change == "deactivate":
            admin.is_active = False
            admin.auth_version += 1
        else:
            admin.role = Role.analyst
        revoking.flush()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(edit)
            try:
                assert started.wait(10)
                wait_for_block(structural_engine, pids["request"], pid, future)
            finally:
                revoking.commit()
            assert future.result(timeout=15).status_code == expected

    with Session(structural_engine) as db:
        assert db.get(Dashboard, dashboard_id).name == "Чужой личный дашборд"
        admin = db.get(User, admin_id)
        admin.role, admin.is_active = Role.admin, True
        db.commit()


@pytest.mark.parametrize("change,expected", [("deactivate", 401), ("demote", 404)])
@pytest.mark.parametrize("target", ["project", "finances"])
def test_change_of_rights_serializes_with_project_writes(structural_engine, monkeypatch, change, expected, target):
    with Session(structural_engine) as db:
        analyst = db.scalar(select(User).where(User.email == "analyst@example.com"))
        name = f"Проверка доступа {change} {target}"
        project = create_legacy_project(db, name=name)
        project_id, analyst_id = project.id, analyst.id
        body = legacy_payload(db, name=name, description="Попытка изменить") if target == "project" else []
        path = f"/api/projects/{project_id}" + ("/financial-entries" if target == "finances" else "")
        token = create_token(analyst.id, SCOPE_ACCESS, 60, ver=analyst.auth_version)

    started, pids = Event(), {}

    def request_db(request: Request):
        with Session(structural_engine, autoflush=False, expire_on_commit=False) as db:
            pids["request"] = db.scalar(text("SELECT pg_backend_pid()"))
            started.set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)

    def edit():
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.set(ACCESS_COOKIE, token)
            return client.put(path, json=body)

    with Session(structural_engine) as revoking:
        analyst = revoking.get(User, analyst_id)
        pid = revoking.scalar(text("SELECT pg_backend_pid()"))
        if change == "deactivate":
            analyst.is_active = False
            analyst.auth_version += 1
        else:
            analyst.role = Role.user
        revoking.flush()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(edit)
            try:
                assert started.wait(10)
                wait_for_block(structural_engine, pids["request"], pid, future)
            finally:
                revoking.commit()
            assert future.result(timeout=15).status_code == expected

    with Session(structural_engine) as db:
        assert db.get(Project, project_id).description == ""
        changes = db.scalars(select(AuditLog).where(
            AuditLog.entity == "project", AuditLog.entity_id == project_id, AuditLog.action != "create",
        )).all()
        assert not changes
        analyst = db.get(User, analyst_id)
        analyst.role, analyst.is_active = Role.analyst, True
        db.commit()
