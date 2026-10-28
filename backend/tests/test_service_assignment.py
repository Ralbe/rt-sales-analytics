from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic

import pytest
from fastapi import Request
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_project_write_concurrency import WAIT_SECONDS
from test_project_write_concurrency import pg_api as pg_api
from test_project_write_concurrency import pg_engine as pg_engine
from test_projects import _payload

from app.api import projects
from app.db import get_db
from app.main import app
from app.models import Client, Service


@pytest.fixture
def service_pg_api(request):
    return request.getfixturevalue("pg_api")


def test_inactive_service_cannot_be_newly_assigned_but_can_be_retained(as_user, db):
    payload = _payload(db)
    service = db.get(Service, payload["service_id"])
    created = as_user.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    project = created.json()
    service.is_active = False
    db.commit()
    url = f"/api/projects/{project['id']}"
    retained = as_user.put(url, json=payload | {"description": "Изменено"})
    assert retained.status_code == 200, retained.text
    assert retained.json()["service"]["id"] == service.id
    rejected = as_user.post("/api/projects", json=payload | {"name": "Другой проект"})
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["field"] == "service_id"
    active = db.scalar(select(Service).where(Service.id != service.id, Service.is_active))
    switched = as_user.put(url, json=payload | {"service_id": active.id})
    assert switched.status_code == 200, switched.text
    rejected = as_user.put(url, json=payload)
    assert rejected.status_code == 422
    assert as_user.get(url).json()["service"]["id"] == active.id


def test_inactive_client_segment_does_not_prevent_project_creation(as_user, db):
    payload = _payload(db)
    db.get(Client, payload["client_id"]).segment.is_active = False
    db.commit()
    response = as_user.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("first", ["disable", "project"])
def test_service_disable_and_new_assignment_are_serialized(service_pg_api, monkeypatch, first):
    payload = service_pg_api.payload()
    service_id = payload["service_id"]
    with Session(service_pg_api.engine) as db:
        db.get(Service, service_id).is_active = True
        db.commit()
    pids = {}
    request_started, locked, release = Event(), Event(), Event()

    def request_db(request: Request):
        with Session(service_pg_api.engine, autoflush=False, expire_on_commit=False) as db:
            pids["project"] = db.scalar(text("SELECT pg_backend_pid()"))
            request_started.set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    original_apply = projects._apply

    def held_apply(db, project, data, user, refs):
        original_apply(db, project, data, user, refs)
        if first == "project":
            locked.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(projects, "_apply", held_apply)

    def disable():
        with Session(service_pg_api.engine) as db:
            pids["disable"] = db.scalar(text("SELECT pg_backend_pid()"))
            service = db.get(Service, service_id)
            service.is_active = False
            db.flush()
            if first == "disable":
                locked.set()
                assert release.wait(WAIT_SECONDS)
            db.commit()

    def waits(waiting, blocking, future):
        deadline = monotonic() + WAIT_SECONDS - 2
        with service_pg_api.engine.connect() as observer:
            while monotonic() < deadline and not future.done():
                if blocking in observer.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": waiting}):
                    return
                Event().wait(0.02)
        pytest.fail("Ожидание блокировки услуги PostgreSQL не обнаружено")

    with ThreadPoolExecutor(max_workers=2) as pool:
        try:
            if first == "disable":
                admin_future = pool.submit(disable)
                assert locked.wait(WAIT_SECONDS)
                project_future = pool.submit(service_pg_api.request, "POST", "", payload)
                assert request_started.wait(WAIT_SECONDS)
                waits(pids["project"], pids["disable"], project_future)
            else:
                project_future = pool.submit(service_pg_api.request, "POST", "", payload)
                assert locked.wait(WAIT_SECONDS)
                admin_future = pool.submit(disable)
                deadline = monotonic() + WAIT_SECONDS
                while "disable" not in pids and monotonic() < deadline:
                    Event().wait(0.02)
                assert "disable" in pids
                waits(pids["disable"], pids["project"], admin_future)
        finally:
            release.set()
        response = project_future.result(timeout=WAIT_SECONDS)
        admin_future.result(timeout=WAIT_SECONDS)
    assert response.status_code == (422 if first == "disable" else 201), response.text
    if first == "disable":
        assert response.json()["detail"]["field"] == "service_id"
