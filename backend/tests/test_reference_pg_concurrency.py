"""Изолированные конкурентные HTTP-проверки на PostgreSQL через общую reference_api."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from time import monotonic
from uuid import uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session
from test_project_write_concurrency import WAIT_SECONDS
from test_project_write_concurrency import pg_api as pg_api
from test_project_write_concurrency import pg_engine as pg_engine

from app.api import projects, reference_admin
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token
from app.db import get_db
from app.main import app
from app.models import AuditLog, ReferenceValue, User


@pytest.fixture
def reference_api(request):
    return request.getfixturevalue("pg_api")


def admin_request(reference_api, method, path, body, writer=""):
    with Session(reference_api.engine) as db:
        actor = db.scalar(select(User).where(User.email == "admin@example.com"))
        token = create_token(actor.id, SCOPE_ACCESS, 60, ver=actor.auth_version)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.set(ACCESS_COOKIE, token)
        return client.request(method, f"/api/reference-admin{path}", json=body, headers={"X-Test-Writer": writer})


def instrument_sessions(reference_api, monkeypatch, pids, started):
    def request_db(request: Request):
        with Session(reference_api.engine, autoflush=False, expire_on_commit=False) as db:
            writer = request.headers.get("X-Test-Writer", "")
            db.info["writer"] = writer
            if writer:
                pids[writer] = db.scalar(text("SELECT pg_backend_pid()"))
                started[writer].set()
            yield db

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)


def assert_waits_for(engine, waiting, blocking, future):
    deadline = monotonic() + WAIT_SECONDS - 2
    with engine.connect() as observer:
        while monotonic() < deadline and not future.done():
            blockers = observer.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": waiting})
            if blocking in blockers:
                return
            Event().wait(0.02)
    result = future.result() if future.done() else None
    pytest.fail(f"Не обнаружено ожидание блокировки PostgreSQL: {result.status_code if result else 'нет ответа'}")


@pytest.mark.parametrize("operation", ["card", "atomic_finance", "finance_endpoint"])
@pytest.mark.parametrize("first", ["admin", "project"])
@pytest.mark.parametrize("retained", [False, True])
def test_disable_and_assignment_are_serialized(reference_api, monkeypatch, operation, first, retained):
    category = "payment_type" if operation == "card" else "revenue_status"
    created_ref = admin_request(reference_api, "POST", f"/{category}", {"name": f"Тест {uuid4().hex}"})
    assert created_ref.status_code == 201, created_ref.text
    reference = created_ref.json()
    payload = reference_api.payload()
    if retained:
        if operation == "card":
            payload["payment_type_id"] = reference["id"]
        else:
            payload["financial_entries"][0]["status_id"] = reference["id"]
    saved = reference_api.create(payload)
    row = payload["financial_entries"][0]
    finance = row | {"id": saved["financial_entries"][0]["id"], "status_id": reference["id"], "amount": "7.654"}
    if operation == "card":
        path, body = f"/{saved['id']}", payload | {"payment_type_id": reference["id"], "description": "Изменено"}
    elif operation == "atomic_finance":
        path, body = f"/{saved['id']}", payload | {"financial_entries": [finance], "description": "Изменено"}
    else:
        path, body = f"/{saved['id']}/financial-entries", [finance]

    pids, started = {}, {"admin": Event(), "project": Event()}
    inside, release = Event(), Event()
    instrument_sessions(reference_api, monkeypatch, pids, started)
    original_record = reference_admin.audit.record
    original_project_lock = projects._lock_references

    def held_admin_record(db, user_id, action, entity, *args, **kwargs):
        original_record(db, user_id, action, entity, *args, **kwargs)
        if first == "admin" and db.info.get("writer") == "admin" and entity == "reference_value":
            db.flush()
            inside.set()
            assert release.wait(WAIT_SECONDS)

    def held_project_lock(db, data, entries):
        result = original_project_lock(db, data, entries)
        if first == "project" and db.info.get("writer") == "project":
            inside.set()
            assert release.wait(WAIT_SECONDS)
        return result

    monkeypatch.setattr(reference_admin.audit, "record", held_admin_record)
    monkeypatch.setattr(projects, "_lock_references", held_project_lock)
    calls = {
        "admin": lambda: admin_request(
            reference_api, "PUT", f"/{category}/{reference['id']}/active", {"is_active": False}, "admin"
        ),
        "project": lambda: reference_api.request("PUT", path, body, "project"),
    }
    second = "project" if first == "admin" else "admin"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(calls[first])
        try:
            assert inside.wait(WAIT_SECONDS), "Первый запрос не получил блокировку"
            second_future = pool.submit(calls[second])
            assert started[second].wait(WAIT_SECONDS), "Второй запрос не стартовал"
            assert_waits_for(reference_api.engine, pids[second], pids[first], second_future)
        finally:
            release.set()
        responses = {
            first: first_future.result(timeout=WAIT_SECONDS + 5),
            second: second_future.result(timeout=WAIT_SECONDS + 5),
        }
    assert responses["admin"].status_code == 200, responses["admin"].text
    rejected = first == "admin" and not retained
    assert responses["project"].status_code == (422 if rejected else 200), responses["project"].text
    final = reference_api.request("GET", f"/{saved['id']}").json()
    if rejected:
        assert final == saved
    elif operation == "card":
        assert final["payment_type"]["id"] == reference["id"] and final["description"] == "Изменено"
    else:
        result = final["financial_entries"][0]
        assert result["status"]["id"] == reference["id"] and result["amount"] == "7.654"
        assert result["id"] == saved["financial_entries"][0]["id"]
        assert result["created_at"] == saved["financial_entries"][0]["created_at"]
    with Session(reference_api.engine) as db:
        assert db.get(ReferenceValue, reference["id"]).is_active is False
        ref_logs = db.scalars(
            select(AuditLog)
            .where(AuditLog.entity == "reference_value", AuditLog.entity_id == reference["id"])
            .order_by(AuditLog.id)
        ).all()
        assert [log.action for log in ref_logs] == ["create", "update"]
        assert ref_logs[-1].payload["before"]["is_active"] is True
        assert ref_logs[-1].payload["after"]["is_active"] is False
        project_logs = db.scalars(
            select(AuditLog)
            .where(AuditLog.entity == "project", AuditLog.entity_id == saved["id"])
            .order_by(AuditLog.id)
        ).all()
        expected = ["create", "replace_financial_entries"]
        if not rejected:
            expected += (
                ["update"]
                if operation == "card"
                else (
                    ["update", "replace_financial_entries"]
                    if operation == "atomic_finance"
                    else ["replace_financial_entries"]
                )
            )
        assert [log.action for log in project_logs] == expected
        if not rejected and operation != "card":
            assert project_logs[-1].payload["after"][0]["_row_id"] == saved["financial_entries"][0]["id"]
            assert project_logs[-1].payload["after"][0]["status_id"] == reference["id"]


def test_concurrent_duplicate_reference_has_one_row_and_one_audit(reference_api, monkeypatch):
    name = f"Дубликат {uuid4().hex}"
    pids, started = {}, {"first": Event(), "second": Event()}
    inside, release = Event(), Event()
    instrument_sessions(reference_api, monkeypatch, pids, started)
    original_lock = reference_admin.lock_admin

    def held_lock(db, actor):
        original_lock(db, actor)
        if db.info.get("writer") == "first":
            inside.set()
            assert release.wait(WAIT_SECONDS)

    monkeypatch.setattr(reference_admin, "lock_admin", held_lock)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(admin_request, reference_api, "POST", "/payment_type", {"name": name}, "first")
        try:
            assert inside.wait(WAIT_SECONDS)
            second = pool.submit(
                admin_request, reference_api, "POST", "/payment_type", {"name": name.upper()}, "second"
            )
            assert started["second"].wait(WAIT_SECONDS)
            assert_waits_for(reference_api.engine, pids["second"], pids["first"], second)
        finally:
            release.set()
        responses = [first.result(timeout=WAIT_SECONDS + 5), second.result(timeout=WAIT_SECONDS + 5)]
    assert sorted(response.status_code for response in responses) == [201, 409]
    item_id = next(response.json()["id"] for response in responses if response.status_code == 201)
    with Session(reference_api.engine) as db:
        assert (
            sum(
                row["name"].casefold() == name.casefold()
                for row in admin_request(reference_api, "GET", "/payment_type", None).json()
            )
            == 1
        )
        logs = db.scalars(
            select(AuditLog).where(
                AuditLog.entity == "reference_value",
                AuditLog.entity_id == item_id,
            )
        ).all()
        assert len(logs) == 1 and logs[0].action == "create" and logs[0].payload["after"]["name"] == name


def test_parallel_financial_clients_keep_row_ids_and_creation_times(reference_api, monkeypatch):
    payload = reference_api.payload()
    original_row = payload["financial_entries"][0]
    payload["financial_entries"].append(original_row | {"amount": "2.000", "month": 11})
    saved = reference_api.create(payload)
    original = saved["financial_entries"]
    first_rows = [
        original_row | {"id": original[0]["id"], "amount": "3.000"},
        payload["financial_entries"][1] | {"id": original[1]["id"]},
    ]
    second_rows = [
        original_row | {"id": original[0]["id"], "amount": "4.000"},
        payload["financial_entries"][1] | {"id": original[1]["id"]},
    ]
    pids, started = {}, {"first": Event(), "second": Event()}
    inside, release = Event(), Event()
    instrument_sessions(reference_api, monkeypatch, pids, started)
    original_replace = projects._replace_financial_entries

    def held_replace(db, project, entries, references, user):
        changed = original_replace(db, project, entries, references, user)
        if db.info.get("writer") == "first":
            inside.set()
            assert release.wait(WAIT_SECONDS)
        return changed

    monkeypatch.setattr(projects, "_replace_financial_entries", held_replace)
    path = f"/{saved['id']}/financial-entries"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(reference_api.request, "PUT", path, first_rows, "first")
        try:
            assert inside.wait(WAIT_SECONDS)
            second = pool.submit(reference_api.request, "PUT", path, second_rows, "second")
            assert started["second"].wait(WAIT_SECONDS)
            assert_waits_for(reference_api.engine, pids["second"], pids["first"], second)
        finally:
            release.set()
        responses = [first.result(timeout=WAIT_SECONDS + 5), second.result(timeout=WAIT_SECONDS + 5)]
    assert [response.status_code for response in responses] == [200, 200]
    for response in responses:
        assert [(row["id"], row["created_at"]) for row in response.json()] == [
            (row["id"], row["created_at"]) for row in original
        ]
    assert responses[1].json()[0]["amount"] == "4.000"
    with Session(reference_api.engine) as db:
        logs = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity == "project",
                AuditLog.entity_id == saved["id"],
                AuditLog.action == "replace_financial_entries",
            )
            .order_by(AuditLog.id)
        ).all()
        assert len(logs) == 3
        assert logs[1].payload["after"][0]["amount"] == logs[2].payload["before"][0]["amount"] == "3.000"
        assert logs[2].payload["after"][0]["amount"] == "4.000"
        assert logs[1].payload["after"][0]["_row_id"] == logs[2].payload["after"][0]["_row_id"] == original[0]["id"]


@pytest.mark.parametrize("lock_mode", ["прежний", "упорядоченный"])
def test_opposite_financial_reference_orders_on_postgresql(reference_api, monkeypatch, lock_mode):
    with Session(reference_api.engine) as db:
        ids = db.scalars(
            select(ReferenceValue.id)
            .where(ReferenceValue.category == "revenue_status")
            .order_by(ReferenceValue.id)
            .limit(2)
        ).all()
    assert len(ids) == 2
    original_lock = projects._lock_references
    rendezvous = Barrier(2, timeout=WAIT_SECONDS)
    sqlstates = []
    observed_statements = []

    def record_failure(context):
        sqlstates.append(getattr(context.original_exception, "sqlstate", None))

    def record_statement(conn, cursor, statement, parameters, context, executemany):
        sql = statement.lower()
        if "from reference_values" in sql and ("for update" in sql or "for share" in sql):
            observed_statements.append(sql)

    def simultaneous_lock(db, data, entries):
        if db.info.get("writer") not in {"a", "b"}:
            return original_lock(db, data, entries)
        if lock_mode == "упорядоченный":
            rendezvous.wait()
            return original_lock(db, data, entries)
        # Контролируемая реконструкция прежнего алгоритма: каждая транзакция
        # удерживает первую ссылку и одновременно запрашивает вторую.
        references = {}
        for index, entry in enumerate(entries):
            ref = db.scalar(select(ReferenceValue).where(ReferenceValue.id == entry.status_id).with_for_update())
            references[ref.id] = ref
            if index == 0:
                rendezvous.wait()
        if data.customer_stage_id is not None:
            stage = db.scalar(
                select(ReferenceValue).where(ReferenceValue.id == data.customer_stage_id).with_for_update()
            )
            references[stage.id] = stage
        return references

    payloads = []
    saved = []
    for order in (ids, list(reversed(ids))):
        payload = reference_api.payload(financial_entries=[])
        saved.append(reference_api.create(payload))
        rows = [
            reference_api.payload()["financial_entries"][0] | {"status_id": ref_id, "amount": f"{i + 1}.000"}
            for i, ref_id in enumerate(order)
        ]
        payloads.append(payload | {"description": "Параллельное сохранение", "financial_entries": rows})
    monkeypatch.setattr(projects, "_lock_references", simultaneous_lock)
    event.listen(reference_api.engine, "handle_error", record_failure)
    event.listen(reference_api.engine, "before_cursor_execute", record_statement)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(reference_api.request, "PUT", f"/{project['id']}", payload, writer)
                for project, payload, writer in zip(saved, payloads, ("a", "b"), strict=True)
            ]
            responses = [future.result(timeout=WAIT_SECONDS + 5) for future in futures]
    finally:
        event.remove(reference_api.engine, "handle_error", record_failure)
        event.remove(reference_api.engine, "before_cursor_execute", record_statement)
    if lock_mode == "прежний":
        assert sorted(response.status_code for response in responses) == [200, 500]
        assert "40P01" in sqlstates
    else:
        assert [response.status_code for response in responses] == [200, 200]
        assert "40P01" not in sqlstates
        assert len(observed_statements) == 2
        assert all("order by reference_values.id" in sql for sql in observed_statements)
    for project, payload, response in zip(saved, payloads, responses, strict=True):
        current = reference_api.request("GET", f"/{project['id']}").json()
        with Session(reference_api.engine) as db:
            logs = db.scalars(
                select(AuditLog)
                .where(AuditLog.entity == "project", AuditLog.entity_id == project["id"])
                .order_by(AuditLog.id)
            ).all()
        if response.status_code == 200:
            assert current["description"] == payload["description"]
            assert {row["status"]["id"] for row in current["financial_entries"]} == set(ids)
            assert [log.action for log in logs] == ["create", "update", "replace_financial_entries"]
            assert len(logs[-1].payload["after"]) == 2
        else:
            assert current == project
            assert [log.action for log in logs] == ["create"]
