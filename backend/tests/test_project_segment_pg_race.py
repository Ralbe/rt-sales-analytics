"""Гонка отключения сегмента и атомарного сохранения проекта в PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_project_history import _finance
from test_projects import _payload
from test_structural_pg_concurrency import WAIT_SECONDS, admin_request, instrument, wait_for_block
from test_structural_pg_concurrency import ref_api as ref_api
from test_structural_pg_concurrency import structural_engine as structural_engine

from app.api import projects, structural_references
from app.main import app
from app.models import AuditLog, Project, ProjectFinancialEntry, Segment


def project_request(api, method, path, body=None, writer=""):
    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.update(api.cookies)
        return client.request(method, f"/api/projects{path}", json=body, headers={"X-Test-Writer": writer})


def project_state(engine, project_id):
    """Все столбцы карточки, финансовых строк и событий аудита проекта."""
    with engine.connect() as connection:
        statements = (
            select(Project.__table__).where(Project.id == project_id),
            select(ProjectFinancialEntry.__table__)
            .where(ProjectFinancialEntry.project_id == project_id)
            .order_by(ProjectFinancialEntry.id),
            select(AuditLog.__table__)
            .where(AuditLog.entity == "project", AuditLog.entity_id == project_id)
            .order_by(AuditLog.id),
        )
        return tuple([dict(row) for row in connection.execute(statement).mappings()] for statement in statements)


@pytest.mark.parametrize("first", ["admin", "project"])
@pytest.mark.parametrize("retained", [False, True])
def test_segment_deactivation_and_project_save_serialize(request, monkeypatch, first, retained):
    api = request.getfixturevalue("ref_api")
    created = admin_request(api, "POST", "/segments", {"name": f"Сегмент {uuid4().hex}"})
    assert created.status_code == 201, created.text
    segment_id = created.json()["id"]
    with Session(api.engine) as db:
        finance = _finance(db, amount="1.234")
        payload = _payload(db, name=f"Проект {uuid4().hex}", financial_entries=[finance])
    if retained:
        payload["segment_id"] = segment_id

    response = project_request(api, "POST", "", payload)
    assert response.status_code == 201, response.text
    saved = response.json()
    project_id = saved["id"]
    assert (saved["segment"]["id"] == segment_id) == retained
    before = project_state(api.engine, project_id)
    assert len(before[0]) == len(before[1]) == 1
    assert [row["action"] for row in before[2]] == ["create", "replace_financial_entries"]

    changed_finance = finance | {"id": saved["financial_entries"][0]["id"], "amount": "9.876"}
    body = payload | {
        "segment_id": segment_id,
        "description": "Параллельное изменение",
        "amount": "1700000.00",
        "financial_entries": [changed_finance],
    }
    pids, started = {}, {"admin": Event(), "project": Event()}
    inside, release = Event(), Event()
    instrument(api, monkeypatch, pids, started)
    original_record = structural_references.audit.record
    original_apply = projects._apply

    def held_record(db, user_id, action, entity, *args, **kwargs):
        original_record(db, user_id, action, entity, *args, **kwargs)
        if first == "admin" and db.info.get("writer") == "admin" and entity == "segment":
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
        "admin": lambda: admin_request(
            api, "PUT", f"/segments/{segment_id}/active", {"is_active": False}, "admin"
        ),
        "project": lambda: project_request(api, "PUT", f"/{project_id}", body, "project"),
    }
    second = "project" if first == "admin" else "admin"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(calls[first])
        try:
            assert inside.wait(WAIT_SECONDS), f"{first} не захватил блокировку"
            second_future = pool.submit(calls[second])
            assert started[second].wait(WAIT_SECONDS), f"{second} не открыл соединение"
            assert pids[first] != pids[second]
            wait_for_block(api.engine, pids[second], pids[first], second_future)
        finally:
            release.set()
        responses = {
            first: first_future.result(timeout=WAIT_SECONDS + 5),
            second: second_future.result(timeout=WAIT_SECONDS + 5),
        }

    assert responses["admin"].status_code == 200, responses["admin"].text
    rejected = first == "admin" and not retained
    assert responses["project"].status_code == (422 if rejected else 200), responses["project"].text
    after = project_state(api.engine, project_id)
    with Session(api.engine) as db:
        assert db.get(Segment, segment_id).is_active is False
        segment_logs = db.scalars(
            select(AuditLog).where(AuditLog.entity == "segment", AuditLog.entity_id == segment_id).order_by(AuditLog.id)
        ).all()
        assert [row.action for row in segment_logs] == ["create", "update"]
        assert segment_logs[-1].payload["after"]["is_active"] is False

    if rejected:
        assert responses["project"].json()["detail"]["field"] == "segment_id"
        assert after == before
    else:
        saved_after = responses["project"].json()
        assert saved_after["segment"]["id"] == segment_id
        assert saved_after["description"] == body["description"]
        assert saved_after["amount"] == body["amount"]
        assert saved_after["financial_entries"][0]["amount"] == changed_finance["amount"]
        assert after[0][0]["segment_id"] == segment_id
        assert [row["action"] for row in after[2]] == [
            "create", "replace_financial_entries", "update", "replace_financial_entries"
        ]
