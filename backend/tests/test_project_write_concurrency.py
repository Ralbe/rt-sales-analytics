"""Регрессии записи на отдельной PostgreSQL БД, без изменения настроенной БД.

Подключение: TEST_POSTGRES_URL (CI) либо delivery/master-v1-1/test-env.json
в одном из родительских каталогов checkout. Нужны права CREATE DATABASE.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from threading import Barrier, Event
from time import monotonic
from uuid import uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from project_factories import create_legacy_project, legacy_payload
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session
from test_project_history import _finance
from test_projects import _payload

from alembic import command
from alembic.config import Config
from app.api import projects
from app.core.config import settings
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import AuditLog, Project, ProjectFinancialEntry, ReferenceValue, User
from app.seed import seed

WAIT_SECONDS = 10
FINANCIAL_FIELDS = ("kind", "year", "month", "amount", "vat_included", "status_id", "article_id", "cost_type_id")


def _postgres_url():
    value = os.environ.get("TEST_POSTGRES_URL")
    if not value:
        for parent in Path(__file__).resolve().parents:
            config = parent / "delivery" / "master-v1-1" / "test-env.json"
            if config.is_file():
                value = json.loads(config.read_text(encoding="utf-8-sig"))["database_url"]
                break
    if not value:
        pytest.skip("Нужен TEST_POSTGRES_URL или локальный delivery/master-v1-1/test-env.json")
    url = make_url(value)
    assert url.get_backend_name() == "postgresql", "Эти регрессии требуют PostgreSQL"
    return url.set(drivername="postgresql+psycopg")


@pytest.fixture(scope="module")
def pg_engine():
    url = _postgres_url()
    database_name = f"rt_write_regression_{uuid4().hex}"
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT", hide_parameters=True)
    engine = None
    created = False
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
        created = True
        test_url = url.set(database=database_name)
        backend = Path(__file__).resolve().parents[1]
        config = Config(str(backend / "alembic.ini"))
        config.set_main_option("script_location", str(backend / "alembic"))
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(settings, "database_url", test_url.render_as_string(hide_password=False))
            command.upgrade(config, "head")
        engine = create_engine(
            test_url,
            hide_parameters=True,
            connect_args={"options": "-c lock_timeout=8000 -c statement_timeout=10000", "connect_timeout": 5},
        )
        with Session(engine) as db:
            seed(db, today=date(2026, 10, 21), projects_count=0)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        try:
            if created:
                with admin.connect() as connection:
                    connection.exec_driver_sql(f'DROP DATABASE "{database_name}" WITH (FORCE)')
        finally:
            admin.dispose()


@dataclass
class ProjectAPI:
    engine: Engine
    cookies: dict[str, str]

    def request(self, method, path, body=None, writer=""):
        with TestClient(app, raise_server_exceptions=False) as client:
            client.cookies.update(self.cookies)
            return client.request(method, f"/api/projects{path}", json=body, headers={"X-Test-Writer": writer})

    def payload(self, **overrides):
        with Session(self.engine) as db:
            return _payload(
                db,
                **{
                    "name": f"Регрессия записи {uuid4().hex}",
                    "financial_entries": [_finance(db, amount="1.234")],
                    **overrides,
                },
            )

    def create(self, payload):
        response = self.request("POST", "", payload)
        assert response.status_code == 201, response.text
        return response.json()


@pytest.fixture
def pg_api(pg_engine, monkeypatch):
    # Каждый HTTP-запрос получает собственную сессию с настоящим commit, без SAVEPOINT-фикстуры SQLite.
    def request_db(request: Request):
        with Session(pg_engine, autoflush=False, expire_on_commit=False) as db:
            db.info["writer"] = request.headers.get("X-Test-Writer", "")
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    with Session(pg_engine) as db:
        user = db.scalar(select(User).where(User.email == "manager1@example.com"))
        cookie = create_token(user.id, SCOPE_ACCESS, 60, ver=user.auth_version)
    return ProjectAPI(pg_engine, {ACCESS_COOKIE: cookie})


def _counts(engine):
    with Session(engine) as db:
        return tuple(
            db.scalar(select(func.count()).select_from(model)) for model in (Project, ProjectFinancialEntry, AuditLog)
        )


def _financial_values(rows):
    return [{field: row.get(field) for field in FINANCIAL_FIELDS} for row in rows]


def _output_finances(rows):
    return _financial_values(
        [
            {
                **row,
                "status_id": row["status"]["id"],
                "article_id": row["article"]["id"] if row["article"] else None,
                "cost_type_id": row["cost_type"]["id"] if row["cost_type"] else None,
            }
            for row in rows
        ]
    )


@pytest.mark.parametrize("second_endpoint", ["atomic", "legacy"])
def test_concurrent_replacements_are_serialized_with_true_audit(pg_api, monkeypatch, second_endpoint):
    payload = pg_api.payload()
    saved = pg_api.create(payload)
    project_id = saved["id"]
    row_id = saved["financial_entries"][0]["id"]
    first_body = deepcopy(payload)
    first_body.update(
        description="Первый запрос",
        financial_entries=[{**payload["financial_entries"][0], "id": row_id, "amount": "2.345"}],
    )
    second_body = deepcopy(payload)
    second_body.update(
        description="Второй запрос",
        financial_entries=[{**payload["financial_entries"][0], "id": row_id, "amount": "3.456"}],
    )
    first_inside, release_first, second_started = Event(), Event(), Event()
    pids = {}
    deadline = monotonic() + WAIT_SECONDS
    replace = projects._replace_financial_entries

    def request_db(request: Request):
        with Session(pg_api.engine, autoflush=False, expire_on_commit=False) as db:
            writer = request.headers.get("X-Test-Writer", "")
            db.info["writer"] = writer
            if writer:
                pids[writer] = db.scalar(text("SELECT pg_backend_pid()"))
                # Удерживаем старые identity map/коллекцию: lock должен обновить и их.
                cached = db.get(Project, project_id)
                list(cached.financial_entries)
                db.info["cached_project"] = cached
                if writer == "second":
                    second_started.set()
            yield db

    def held_replace(db, project, *args, **kwargs):
        if db.info.get("writer") == "first":
            first_inside.set()
            assert release_first.wait(max(0, deadline - monotonic())), "Первый запрос не освобождён до deadline"
        return replace(db, project, *args, **kwargs)

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    monkeypatch.setattr(projects, "_replace_financial_entries", held_replace)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(pg_api.request, "PUT", f"/{project_id}", first_body, "first")
        try:
            assert first_inside.wait(max(0, deadline - monotonic())), "Первый PUT не дошёл до записи финансов"
            path, body = (
                (f"/{project_id}", second_body)
                if second_endpoint == "atomic"
                else (f"/{project_id}/financial-entries", second_body["financial_entries"])
            )
            second = pool.submit(pg_api.request, "PUT", path, body, "second")
            assert second_started.wait(max(0, deadline - monotonic())), "Второй PUT не запустился"
            # Ждём реальную блокировку, а не прохождение row lock обоими потоками.
            blocked = False
            with pg_api.engine.connect() as observer:
                while monotonic() < deadline and not second.done():
                    blockers = observer.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": pids["second"]})
                    if pids["first"] in blockers:
                        blocked = True
                        break
                    Event().wait(0.02)
            assert blocked, "Второй PUT не ждёт блокировку первого; полная замена не сериализована"
        finally:
            # Освобождаем первый поток и при провале assertion, чтобы не зависнуть в shutdown.
            release_first.set()
        first_response = first.result(timeout=WAIT_SECONDS)
        second_response = second.result(timeout=WAIT_SECONDS)
    assert first_response.status_code == second_response.status_code == 200
    reopened = pg_api.request("GET", f"/{project_id}")
    assert reopened.status_code == 200, reopened.text
    final = reopened.json()
    assert _output_finances(final["financial_entries"]) == _financial_values(second_body["financial_entries"])
    assert final["description"] == (second_body if second_endpoint == "atomic" else first_body)["description"]
    with Session(pg_api.engine) as db:
        logs = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity == "project",
                AuditLog.entity_id == project_id,
            )
            .order_by(AuditLog.id)
        ).all()
        finances = [log.payload for log in logs if log.action == "replace_financial_entries"]
        assert len(finances) == 3
        assert _financial_values(finances[1]["before"]) == _output_finances(saved["financial_entries"])
        assert _financial_values(finances[1]["after"]) == _financial_values(first_body["financial_entries"])
        assert _financial_values(finances[2]["before"]) == _financial_values(first_body["financial_entries"])
        assert _financial_values(finances[2]["after"]) == _output_finances(final["financial_entries"])
        cards = [log.payload for log in logs if log.action == "update"]
        assert len(cards) == (2 if second_endpoint == "atomic" else 1)
        if second_endpoint == "atomic":
            assert cards[1]["before"]["description"] == first_body["description"]
            assert cards[1]["after"]["description"] == second_body["description"]


def test_concurrent_duplicate_create_returns_201_and_409_without_partial_audit(pg_api, monkeypatch):
    payload = pg_api.payload()
    other = deepcopy(payload)
    # Разные справочники позволяют обоим запросам пройти проверку дубликата одновременно,
    # сохраняя реальную гонку по уникальности проекта после введения блокировок ссылок.
    with Session(pg_api.engine) as db:
        other["customer_stage_id"] = db.scalar(select(ReferenceValue.id).where(
            ReferenceValue.category == "customer_stage", ReferenceValue.id != payload["customer_stage_id"],
        ).order_by(ReferenceValue.id))
        other["financial_entries"][0]["status_id"] = db.scalar(select(ReferenceValue.id).where(
            ReferenceValue.category == "revenue_status",
            ReferenceValue.id != payload["financial_entries"][0]["status_id"],
        ).order_by(ReferenceValue.id))
    both_checked = Barrier(2, timeout=WAIT_SECONDS)
    find_duplicate = projects._find_duplicate

    def synchronized_check(db, name, client_id, exclude_id):
        duplicate = find_duplicate(db, name, client_id, exclude_id)
        if name == payload["name"] and not db.info.get("duplicate_checked"):
            db.info["duplicate_checked"] = True
            assert duplicate is None
            # POST ещё не держит блокировку проекта; повторная проверка после rollback сюда не попадёт.
            both_checked.wait()
        return duplicate

    monkeypatch.setattr(projects, "_find_duplicate", synchronized_check)
    before = _counts(pg_api.engine)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(pg_api.request, "POST", "", body) for body in (payload, other)]
        responses = [future.result(timeout=WAIT_SECONDS + 5) for future in futures]
    assert sorted(response.status_code for response in responses) == [201, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json()["detail"]["field"] == "name"
    saved = next(response.json() for response in responses if response.status_code == 201)
    assert _counts(pg_api.engine) == tuple(count + delta for count, delta in zip(before, (1, 1, 2), strict=True))
    with Session(pg_api.engine) as db:
        logs = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity == "project",
                AuditLog.entity_id == saved["id"],
            )
            .order_by(AuditLog.id)
        ).all()
        assert [log.action for log in logs] == ["create", "replace_financial_entries"]
        assert _financial_values(logs[1].payload["after"]) == _output_finances(saved["financial_entries"])


@pytest.mark.parametrize("operation", ["create", "update", "legacy"])
def test_numeric_maxima_preserve_exact_amounts_and_vat(pg_api, operation):
    payload = pg_api.payload()
    saved = pg_api.create(payload) if operation != "create" else None
    with Session(pg_api.engine) as db:
        rows = [
            _finance(db, amount="999999999999.999", vat_included=True),
            _finance(db, "cost", amount="999999999999.999", vat_included=False),
        ]
    rows[0]["id"] = saved["financial_entries"][0]["id"] if saved else None
    rows[1]["id"] = None
    maximum = {**payload, "amount": "999999999999.99", "cost": "999999999999.99", "financial_entries": rows}
    if operation == "legacy":
        response = pg_api.request("PUT", f"/{saved['id']}/financial-entries", rows)
    else:
        response = pg_api.request(
            "POST" if saved is None else "PUT", "" if saved is None else f"/{saved['id']}", maximum
        )
    assert response.status_code == (201 if saved is None else 200), response.text
    project_id = saved["id"] if saved else response.json()["id"]
    reopened = pg_api.request("GET", f"/{project_id}")
    assert reopened.status_code == 200, reopened.text
    project = reopened.json()
    assert project["amount"] == (payload if operation == "legacy" else maximum)["amount"]
    assert project["cost"] == (payload if operation == "legacy" else maximum)["cost"]
    assert _output_finances(project["financial_entries"]) == _financial_values(rows)


@pytest.mark.parametrize(
    ("operation", "field"),
    [(operation, field) for operation in ("create", "update") for field in ("amount", "cost", "financial_entries")]
    + [("legacy", "financial_entries")],
)
def test_one_trillion_is_422_without_mutations(pg_api, operation, field):
    payload = pg_api.payload()
    saved = pg_api.create(payload) if operation != "create" else None
    invalid = deepcopy(payload)
    if field == "financial_entries":
        invalid[field][0]["amount"] = "1000000000000"
    else:
        invalid[field] = "1000000000000"
    before = _counts(pg_api.engine)
    if operation == "legacy":
        response = pg_api.request("PUT", f"/{saved['id']}/financial-entries", invalid["financial_entries"])
    else:
        response = pg_api.request(
            "POST" if saved is None else "PUT", "" if saved is None else f"/{saved['id']}", invalid
        )
    assert response.status_code == 422, response.text
    error_field = "amount" if field == "financial_entries" else field
    assert any(error["loc"][-1] == error_field for error in response.json()["detail"])
    assert _counts(pg_api.engine) == before
    if saved:
        reopened = pg_api.request("GET", f"/{saved['id']}")
        assert reopened.status_code == 200, reopened.text
        assert reopened.json() == saved


def test_pg_stage_scheme_and_probability_survive_separate_request_sessions(pg_api):
    payload = pg_api.payload()
    saved = pg_api.create(payload)
    assert saved["stage_scheme"] == "customer" and saved["stage"] is None
    with Session(pg_api.engine) as db:
        reference = db.get(ReferenceValue, saved["customer_stage"]["id"])
        reference.probability = 13
        reference.is_active = False
        db.commit()
    response = pg_api.request("PUT", f"/{saved['id']}", payload | {"probability": 99, "description": "Правка"})
    assert response.status_code == 200, response.text
    assert response.json()["probability"] == saved["probability"]
    assert response.json()["stage"] is None and response.json()["closed_at"] is None
    with Session(pg_api.engine) as db:
        legacy = create_legacy_project(db, name=f"Прежний проект {uuid4().hex}",
                                       customer_stage_id=saved["customer_stage"]["id"], probability=37)
        legacy_id = legacy.id
        body = legacy_payload(db, name=legacy.name, stage="won", customer_stage_id=legacy.customer_stage_id)
        body.pop("probability")
    response = pg_api.request("PUT", f"/{legacy_id}", body)
    assert response.status_code == 200, response.text
    assert response.json()["stage_scheme"] == "legacy" and response.json()["stage"] == "won"
    assert response.json()["probability"] == 37 and response.json()["closed_at"] is not None
    assert response.json()["customer_stage"]["id"] == saved["customer_stage"]["id"]
    for project_id, project_body in ((saved["id"], payload), (legacy_id, body)):
        before = pg_api.request("GET", f"/{project_id}").json()
        counts = _counts(pg_api.engine)
        response = pg_api.request("PUT", f"/{project_id}", project_body | {"stage_scheme": "customer"})
        assert response.status_code == 422
        assert pg_api.request("GET", f"/{project_id}").json() == before
        assert _counts(pg_api.engine) == counts
