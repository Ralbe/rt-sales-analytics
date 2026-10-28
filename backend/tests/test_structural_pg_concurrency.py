"""Проверки сегментов и услуг в отдельной тестовой PostgreSQL-базе."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from random import Random
from threading import Event
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema
from test_projects import _payload

from alembic import command
from alembic.config import Config
from app.api import projects, structural_references
from app.core.config import settings
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import AuditLog, Client, Segment, Service, User
from app.seed import generate_inn, seed

WAIT_SECONDS = 10


@pytest.fixture(scope="module")
def structural_engine():
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Нужен TEST_POSTGRES_URL изолированной PostgreSQL")
    parsed = make_url(url)
    assert parsed.get_backend_name() == "postgresql"
    schema = f"test_structural_{uuid4().hex}"
    control = create_engine(parsed, hide_parameters=True)
    engine = None
    created = False
    try:
        with control.begin() as connection:
            connection.execute(CreateSchema(schema))
        created = True
        test_url = parsed.update_query_dict(
            {"options": f"-csearch_path={schema} -clock_timeout=8000 -cstatement_timeout=10000"}
        )
        backend = Path(__file__).resolve().parents[1]
        config = Config(str(backend / "alembic.ini"))
        config.set_main_option("script_location", str(backend / "alembic"))
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(settings, "database_url", test_url.render_as_string(hide_password=False))
            command.upgrade(config, "head")
        engine = create_engine(test_url, hide_parameters=True, connect_args={"connect_timeout": 5})
        with Session(engine) as db:
            seed(db, today=date(2026, 10, 21), projects_count=0)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        if created:
            with control.begin() as connection:
                connection.execute(DropSchema(schema, cascade=True))
        control.dispose()


@pytest.fixture
def ref_api(structural_engine, monkeypatch):
    def request_db():
        with Session(structural_engine, autoflush=False, expire_on_commit=False) as db:
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    with Session(structural_engine) as db:
        user = db.scalar(select(User).where(User.email == "manager1@example.com"))
        token = create_token(user.id, SCOPE_ACCESS, 60, ver=user.auth_version)
    return SimpleNamespace(engine=structural_engine, cookies={ACCESS_COOKIE: token})


def admin_request(ref_api, method, path, body, writer=""):
    with Session(ref_api.engine) as db:
        actor = db.scalar(select(User).where(User.email == "admin@example.com"))
        token = create_token(actor.id, SCOPE_ACCESS, 60, ver=actor.auth_version)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.set(ACCESS_COOKIE, token)
        return client.request(method, f"/api/structural-references{path}", json=body, headers={"X-Test-Writer": writer})


def instrument(ref_api, monkeypatch, pids, started):
    def request_db(request: Request):
        with Session(ref_api.engine, autoflush=False, expire_on_commit=False) as db:
            writer = request.headers.get("X-Test-Writer", "")
            db.info["writer"] = writer
            if writer:
                pids[writer] = db.scalar(text("SELECT pg_backend_pid()"))
                started[writer].set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)


def wait_for_block(engine, waiting, blocking, future):
    deadline = monotonic() + WAIT_SECONDS - 2
    with engine.connect() as observer:
        while monotonic() < deadline and not future.done():
            if blocking in observer.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": waiting}):
                return
            Event().wait(0.02)
    pytest.fail("Ожидание блокировки PostgreSQL не обнаружено")


@pytest.mark.parametrize("category", ["segments", "services"])
def test_parallel_duplicate_names_one_record_and_audit(ref_api, monkeypatch, category):
    name = f"Справочник {uuid4().hex}"
    pids, started = {}, {"first": Event(), "second": Event()}
    inside, release = Event(), Event()
    instrument(ref_api, monkeypatch, pids, started)
    original = structural_references.lock_admin

    def held(db, actor, name):
        original(db, actor, name)
        if db.info.get("writer") == "first":
            inside.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(structural_references, "lock_admin", held)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(admin_request, ref_api, "POST", f"/{category}", {"name": name}, "first")
        try:
            assert inside.wait(WAIT_SECONDS)
            second = pool.submit(admin_request, ref_api, "POST", f"/{category}", {"name": name.upper()}, "second")
            assert started["second"].wait(WAIT_SECONDS)
            wait_for_block(ref_api.engine, pids["second"], pids["first"], second)
        finally:
            release.set()
        responses = [first.result(timeout=WAIT_SECONDS + 5), second.result(timeout=WAIT_SECONDS + 5)]
    assert sorted(response.status_code for response in responses) == [201, 409]
    item_id = next(response.json()["id"] for response in responses if response.status_code == 201)
    with Session(ref_api.engine) as db:
        model = Segment if category == "segments" else Service
        rows = db.scalars(select(model)).all()
        assert [row.id for row in rows if row.name.casefold() == name.casefold()] == [item_id]
        logs = db.scalars(select(AuditLog).where(AuditLog.entity == category[:-1], AuditLog.entity_id == item_id)).all()
        assert len(logs) == 1 and logs[0].payload["after"]["name"] == name


@pytest.mark.parametrize("first", ["admin", "client"])
def test_segment_deactivation_and_client_creation_serialize(ref_api, monkeypatch, first):
    created = admin_request(ref_api, "POST", "/segments", {"name": f"Сегмент {uuid4().hex}"})
    assert created.status_code == 201
    segment_id = created.json()["id"]
    inn = generate_inn(Random(uuid4().int))
    pids, started = {}, {"admin": Event(), "client": Event()}
    inside, release = Event(), Event()
    instrument(ref_api, monkeypatch, pids, started)
    original = structural_references.audit.record

    def held(db, user_id, action, entity, *args, **kwargs):
        original(db, user_id, action, entity, *args, **kwargs)
        if (
            first == "admin"
            and db.info.get("writer") == "admin"
            and entity == "segment"
            or first == "client"
            and db.info.get("writer") == "client"
            and entity == "client"
        ):
            db.flush()
            inside.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(structural_references.audit, "record", held)

    def create_client():
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.update(ref_api.cookies)
            return client.post(
                "/api/clients",
                json={"name": "Новый клиент", "inn": inn, "segment_id": segment_id},
                headers={"X-Test-Writer": "client"},
            )

    calls = {
        "client": create_client,
        "admin": lambda: admin_request(ref_api, "PUT", f"/segments/{segment_id}/active", {"is_active": False}, "admin"),
    }
    second = "client" if first == "admin" else "admin"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(calls[first])
        try:
            assert inside.wait(WAIT_SECONDS)
            second_future = pool.submit(calls[second])
            assert started[second].wait(WAIT_SECONDS)
            wait_for_block(ref_api.engine, pids[second], pids[first], second_future)
        finally:
            release.set()
        responses = {
            first: first_future.result(timeout=WAIT_SECONDS + 5),
            second: second_future.result(timeout=WAIT_SECONDS + 5),
        }
    assert responses["admin"].status_code == 200
    assert responses["client"].status_code == (422 if first == "admin" else 201)
    with Session(ref_api.engine) as db:
        assert not db.get(Segment, segment_id).is_active
        customer = db.scalar(select(Client).where(Client.inn == inn))
        assert (customer is None) == (first == "admin")
        logs = db.scalars(
            select(AuditLog).where(AuditLog.entity == "segment", AuditLog.entity_id == segment_id).order_by(AuditLog.id)
        ).all()
        assert [log.action for log in logs] == ["create", "update"]
        assert logs[-1].payload["after"]["is_active"] is False
        if customer:
            assert customer.segment_id == segment_id


@pytest.mark.parametrize("first", ["admin", "project"])
@pytest.mark.parametrize("retained", [False, True])
def test_service_deactivation_and_project_assignment_serialize(ref_api, monkeypatch, first, retained):
    created = admin_request(ref_api, "POST", "/services", {"name": f"Услуга {uuid4().hex}"})
    assert created.status_code == 201
    service_id = created.json()["id"]
    with Session(ref_api.engine) as db:
        payload = _payload(db, name=f"Проверка {uuid4().hex}", financial_entries=[])
    if retained:
        payload["service_id"] = service_id

    def project_request(method, path, body, writer=""):
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.update(ref_api.cookies)
            return client.request(method, f"/api/projects{path}", json=body, headers={"X-Test-Writer": writer})

    saved_response = project_request("POST", "", payload)
    assert saved_response.status_code == 201, saved_response.text
    saved = saved_response.json()
    body = payload | {"service_id": service_id, "description": "Параллельная правка"}
    pids, started = {}, {"admin": Event(), "project": Event()}
    inside, release = Event(), Event()
    instrument(ref_api, monkeypatch, pids, started)
    original_record = structural_references.audit.record
    original_apply = projects._apply

    def held_record(db, user_id, action, entity, *args, **kwargs):
        original_record(db, user_id, action, entity, *args, **kwargs)
        if first == "admin" and db.info.get("writer") == "admin" and entity == "service":
            db.flush()
            inside.set()
            assert release.wait(WAIT_SECONDS)

    def held_apply(db, project, data, actor, locked_refs):
        original_apply(db, project, data, actor, locked_refs)
        if first == "project" and db.info.get("writer") == "project":
            inside.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(structural_references.audit, "record", held_record)
    monkeypatch.setattr(projects, "_apply", held_apply)
    calls = {
        "project": lambda: project_request("PUT", f"/{saved['id']}", body, "project"),
        "admin": lambda: admin_request(ref_api, "PUT", f"/services/{service_id}/active", {"is_active": False}, "admin"),
    }
    second = "project" if first == "admin" else "admin"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(calls[first])
        try:
            assert inside.wait(WAIT_SECONDS)
            second_future = pool.submit(calls[second])
            assert started[second].wait(WAIT_SECONDS)
            wait_for_block(ref_api.engine, pids[second], pids[first], second_future)
        finally:
            release.set()
        responses = {
            first: first_future.result(timeout=WAIT_SECONDS + 5),
            second: second_future.result(timeout=WAIT_SECONDS + 5),
        }
    rejected = first == "admin" and not retained
    assert responses["admin"].status_code == 200
    assert responses["project"].status_code == (422 if rejected else 200)
    current = project_request("GET", f"/{saved['id']}", None).json()
    assert current["service"]["id"] == (saved["service"]["id"] if rejected else service_id)
    with Session(ref_api.engine) as db:
        logs = db.scalars(
            select(AuditLog).where(AuditLog.entity == "service", AuditLog.entity_id == service_id).order_by(AuditLog.id)
        ).all()
        assert [log.action for log in logs] == ["create", "update"]
        assert logs[-1].payload["after"]["is_active"] is False
        events = db.scalars(
            select(AuditLog)
            .where(AuditLog.entity == "project", AuditLog.entity_id == saved["id"])
            .order_by(AuditLog.id)
        ).all()
        assert [event.action for event in events] == (["create"] if rejected else ["create", "update"])
