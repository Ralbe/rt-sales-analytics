from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from io import BytesIO
from threading import Event
from time import monotonic

import pytest
from conftest import login
from fastapi import Request
from openpyxl import load_workbook
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_project_write_concurrency import WAIT_SECONDS
from test_project_write_concurrency import pg_api as pg_api
from test_project_write_concurrency import pg_engine as pg_engine
from test_projects import _payload

from app.api import projects
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import Project, Role, User


def _user(db, name, active):
    user = User(email=f"{name}@history.test", full_name=name, role=Role.user,
                password_hash="unused", is_active=active)
    db.add(user)
    db.flush()
    return user


@pytest.mark.parametrize("email,expected", [
    ("manager1@example.com", {"self"}),
    ("analyst@example.com", {"self", "historical"}),
    ("admin@example.com", {"self", "historical", "archived"}),
])
def test_filter_managers_respects_project_visibility(client, db, email, expected):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    historical = _user(db, "Исторический", False)
    archived = _user(db, "Только архив", False)
    absent = _user(db, "Без проектов", True)
    projects = db.scalars(select(Project).where(Project.manager_id == me.id).limit(3)).all()
    projects[1].manager_id = historical.id
    projects[2].manager_id = archived.id
    projects[2].archived_at = datetime.now(UTC)
    db.commit()
    login(client, db, email)
    response = client.get("/api/refs")
    assert response.status_code == 200, response.text
    refs = response.json()
    by_id = {row["id"]: row for row in refs["filter_managers"]}
    ids = {"self": me.id, "historical": historical.id, "archived": archived.id}
    assert {key for key, value in ids.items() if value in by_id} == expected
    # Активных можно выбрать сразу, даже если у них ещё не было проекта.
    assert absent.id in by_id
    assert all(set(row) == {"id", "full_name", "is_active"} for row in by_id.values())
    if "historical" in expected:
        assert by_id[historical.id] == {"id": historical.id, "full_name": historical.full_name, "is_active": False}
    assert historical.id not in {row["id"] for row in refs["managers"]}
    assert absent.id in {row["id"] for row in refs["managers"]}
    assert all(set(row) == {"id", "full_name"} for row in refs["managers"])


def test_manager_rename_updates_cached_analytics(client, db, monkeypatch):
    from app.core import cache

    class MemoryRedis:
        def __init__(self):
            self.items = {}

        def get(self, key):
            return self.items.get(key)

        def set(self, key, value, **kwargs):
            self.items[key] = value

        def incr(self, key):
            self.items[key] = str(int(self.items.get(key, 0)) + 1)
            return int(self.items[key])

    login(client, db, "admin@example.com")
    manager = db.scalar(select(User).where(User.email == "manager1@example.com"))
    fake = MemoryRedis()
    monkeypatch.setattr(cache, "_redis", lambda: fake)
    params = {"group_by": "manager", "metric": "projects", "as_of": "2026-10-21"}
    before = client.get("/api/analytics/breakdown", params=params)
    assert before.status_code == 200
    old = next(item["label"] for item in before.json()["items"] if item["key"] == str(manager.id))
    updated = client.put(f"/api/users/{manager.id}", json={
        "email": manager.email, "full_name": "Имя после изменения", "role": manager.role.value, "is_active": True,
    })
    assert updated.status_code == 200
    after = client.get("/api/analytics/breakdown", params=params)
    assert after.status_code == 200
    current = next(item["label"] for item in after.json()["items"] if item["key"] == str(manager.id))
    assert old != current == "Имя после изменения"


@pytest.mark.parametrize("email", ["admin@example.com", "analyst@example.com"])
def test_inactive_manager_can_only_be_retained_on_same_project(client, db, email):
    login(client, db, email)
    manager = _user(db, "Отключаемый", True)
    payload = _payload(db, manager_id=manager.id, implementation_year=1900)
    created = client.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    manager.is_active = False
    db.commit()
    url = f"/api/projects/{project_id}"
    saved = client.put(url, json=payload | {"description": "Новое описание"})
    assert saved.status_code == 200, saved.text
    assert saved.json()["manager"]["id"] == manager.id
    assert saved.json()["implementation_year"] == 1900
    rejected = client.post("/api/projects", json=payload | {"name": "Другой проект"})
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["field"] == "manager_id"
    current = db.scalar(select(User).where(User.email == email))
    assert client.put(url, json=payload | {"manager_id": current.id}).status_code == 200
    rejected = client.put(url, json=payload)
    assert rejected.status_code == 422
    assert client.get(url).json()["manager"]["id"] == current.id


@pytest.mark.parametrize("email", ["admin@example.com", "analyst@example.com"])
@pytest.mark.parametrize("manager_id", [0, -1, 99999999])
def test_invalid_manager_rejected_for_privileged_editor(client, db, manager_id, email):
    login(client, db, email)
    payload = _payload(db)
    created = client.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    response = client.post("/api/projects", json=payload | {"name": "Второй проект", "manager_id": manager_id})
    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "manager_id"
    response = client.put(f"/api/projects/{created.json()['id']}", json=payload | {"manager_id": manager_id})
    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "manager_id"
    assert client.get(f"/api/projects/{created.json()['id']}").json()["manager"] == created.json()["manager"]


@pytest.mark.parametrize("year", [1900, 2200, None])
def test_historical_manager_filter_export_and_year(as_analyst, db, year):
    manager = _user(db, "Владелец выгрузки", True)
    payload = _payload(db, manager_id=manager.id, implementation_year=year)
    saved = as_analyst.post("/api/projects", json=payload)
    assert saved.status_code == 201, saved.text
    manager.is_active = False
    db.commit()
    saved = as_analyst.put(f"/api/projects/{saved.json()['id']}", json=payload)
    assert saved.status_code == 200, saved.text
    params = {"manager_id": manager.id}
    listing = as_analyst.get("/api/projects", params=params).json()
    assert listing["total"] == 1
    item = listing["items"][0]
    assert item["manager"]["full_name"] == manager.full_name
    assert item["implementation_year"] == year
    result = as_analyst.get("/api/projects/export.xlsx", params=params)
    assert result.status_code == 200
    rows = list(load_workbook(BytesIO(result.content), read_only=True).active.values)
    assert len(rows) == 2
    assert rows[1][0] == item["id"]
    assert rows[1][4] == item["segment"]["name"]
    assert rows[1][6] == manager.full_name
    assert rows[1][25] == year


@pytest.fixture
def manager_pg_api(request):
    return request.getfixturevalue("pg_api")


@pytest.mark.parametrize("first", ["disable", "assignment"])
def test_manager_disable_and_assignment_serialize_on_postgres(manager_pg_api, monkeypatch, first):
    api = manager_pg_api
    with Session(api.engine) as db:
        actor = db.scalar(select(User).where(User.email == "analyst@example.com"))
        manager = db.scalar(select(User).where(User.email == "manager2@example.com"))
        manager.is_active = True
        manager_id = manager.id
        api.cookies = {ACCESS_COOKIE: create_token(actor.id, SCOPE_ACCESS, 60, ver=actor.auth_version)}
        db.commit()
    payload = api.payload(manager_id=manager_id)
    pids = {}
    started, locked, release = Event(), Event(), Event()

    def request_db(request: Request):
        with Session(api.engine, autoflush=False, expire_on_commit=False) as db:
            pids["assignment"] = db.scalar(text("SELECT pg_backend_pid()"))
            started.set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    original_apply = projects._apply

    def held_apply(db, project, data, user, refs):
        original_apply(db, project, data, user, refs)
        if first == "assignment":
            locked.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(projects, "_apply", held_apply)

    def disable():
        with Session(api.engine) as db:
            pids["disable"] = db.scalar(text("SELECT pg_backend_pid()"))
            manager = db.get(User, manager_id)
            manager.is_active = False
            db.flush()
            if first == "disable":
                locked.set()
                assert release.wait(WAIT_SECONDS)
            db.commit()

    def assert_waiting(waiting, blocking, future):
        deadline = monotonic() + WAIT_SECONDS - 2
        with api.engine.connect() as observer:
            while monotonic() < deadline and not future.done():
                if blocking in observer.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": waiting}):
                    return
                Event().wait(0.02)
        pytest.fail("Ожидание блокировки менеджера PostgreSQL не обнаружено")

    with ThreadPoolExecutor(max_workers=2) as pool:
        try:
            if first == "disable":
                disable_future = pool.submit(disable)
                assert locked.wait(WAIT_SECONDS)
                project_future = pool.submit(api.request, "POST", "", payload)
                assert started.wait(WAIT_SECONDS)
                assert_waiting(pids["assignment"], pids["disable"], project_future)
            else:
                project_future = pool.submit(api.request, "POST", "", payload)
                assert locked.wait(WAIT_SECONDS)
                disable_future = pool.submit(disable)
                deadline = monotonic() + WAIT_SECONDS
                while "disable" not in pids and monotonic() < deadline:
                    Event().wait(0.02)
                assert "disable" in pids
                assert_waiting(pids["disable"], pids["assignment"], disable_future)
        finally:
            release.set()
        response = project_future.result(timeout=WAIT_SECONDS)
        disable_future.result(timeout=WAIT_SECONDS)
    assert response.status_code == (422 if first == "disable" else 201), response.text
    if first == "disable":
        assert response.json()["detail"]["field"] == "manager_id"
    else:
        assert response.json()["manager"]["id"] == manager_id
