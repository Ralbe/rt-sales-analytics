from datetime import datetime

import pytest
from conftest import login
from sqlalchemy import select
from test_project_history import _finance
from test_project_write_concurrency import pg_api as pg_api
from test_project_write_concurrency import pg_engine as pg_engine
from test_projects import _payload

from app.models import AuditLog, ProjectFinancialEntry, ReferenceValue


@pytest.fixture
def admin(client, db):
    login(client, db, "admin@example.com")
    return client


def test_financial_updates_preserve_ids_creation_and_audit(as_user, db):
    rows = [_finance(db, amount="1.234"), _finance(db, "cost", amount="2.345")]
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=rows))
    assert created.status_code == 201, created.text
    project = created.json()
    for item in project["financial_entries"]:
        db.get(ProjectFinancialEntry, item["id"]).created_at = datetime(2020, 1, 1)
    db.commit()
    original = as_user.get(f"/api/projects/{project['id']}").json()["financial_entries"]
    body = [rows[0] | {"id": original[0]["id"], "amount": "8.123"}, rows[1] | {"id": original[1]["id"]}]
    updated = as_user.put(f"/api/projects/{project['id']}/financial-entries", json=body)
    assert updated.status_code == 200, updated.text
    result = updated.json()
    assert [(row["id"], row["created_at"]) for row in result] == [(row["id"], row["created_at"]) for row in original]
    assert result[0]["amount"] == "8.123"
    unchanged = as_user.put(f"/api/projects/{project['id']}/financial-entries", json=list(reversed(body)))
    assert unchanged.status_code == 200, unchanged.text
    assert [(row["id"], row["created_at"]) for row in unchanged.json()] == [
        (row["id"], row["created_at"]) for row in original
    ]
    logs = db.scalars(
        select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == project["id"]).order_by(AuditLog.id)
    ).all()
    assert [log.action for log in logs] == ["create", "replace_financial_entries", "replace_financial_entries"]
    assert logs[-1].payload["before"][0]["amount"] == "1.234"
    assert logs[-1].payload["after"][0]["amount"] == "8.123"
    assert logs[-1].payload["before"][0]["_row_id"] == logs[-1].payload["after"][0]["_row_id"] == original[0]["id"]


def test_foreign_and_duplicate_row_id_are_atomic(as_user, db):
    row = _finance(db, amount="1.234")
    first = as_user.post("/api/projects", json=_payload(db, name="Первый проект", financial_entries=[row])).json()
    second = as_user.post("/api/projects", json=_payload(db, name="Второй проект", financial_entries=[row])).json()
    own = row | {"id": first["financial_entries"][0]["id"]}
    foreign = row | {"id": second["financial_entries"][0]["id"]}
    before = as_user.get(f"/api/projects/{first['id']}").json()
    for rows in ([own, own], [foreign]):
        result = as_user.put(
            f"/api/projects/{first['id']}", json=_payload(db, description="Не сохранять", financial_entries=rows)
        )
        assert result.status_code == 422
        assert as_user.get(f"/api/projects/{first['id']}").json() == before


def test_identical_multiset_with_swapped_ids_still_updates_and_audits(as_user, db):
    rows = [_finance(db, amount="1.234"), _finance(db, amount="2.345")]
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=rows)).json()
    original = created["financial_entries"]
    switched = [rows[1] | {"id": original[0]["id"]}, rows[0] | {"id": original[1]["id"]}]
    response = as_user.put(f"/api/projects/{created['id']}/financial-entries", json=switched)
    assert response.status_code == 200, response.text
    by_id = {row["id"]: row["amount"] for row in response.json()}
    assert by_id == {original[0]["id"]: "2.345", original[1]["id"]: "1.234"}
    logs = db.scalars(
        select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == created["id"]).order_by(AuditLog.id)
    ).all()
    assert len(logs) == 3
    assert logs[-1].payload["before"][0]["_row_id"] == logs[-1].payload["after"][0]["_row_id"]
    assert logs[-1].payload["before"][0]["amount"] == "1.234"
    assert logs[-1].payload["after"][0]["amount"] == "2.345"
    history = as_user.get(f"/api/projects/{created['id']}/history").json()["items"][0]
    assert len(history["changes"]) == 2
    assert all(change["label"] == "Финансовая строка изменена" for change in history["changes"])
    assert "Изменения значений в этой записи не обнаружены" != history["note"]


def test_legacy_inactive_row_requires_id_for_ambiguous_edit(admin, db):
    row = _finance(db, "cost", amount="1.234")
    created = admin.post("/api/projects", json=_payload(db, financial_entries=[row])).json()
    original = created["financial_entries"][0]
    ref = db.get(ReferenceValue, row["status_id"])
    assert (
        admin.put(f"/api/reference-admin/{ref.category}/{ref.id}/active", json={"is_active": False}).status_code == 200
    )
    url = f"/api/projects/{created['id']}/financial-entries"
    unchanged = admin.put(url, json=[row])
    assert unchanged.status_code == 200
    assert unchanged.json()[0]["id"] == original["id"]
    edited = row | {"amount": "9.876"}
    failed = admin.put(url, json=[edited])
    assert failed.status_code == 422
    assert "ID" in failed.json()["detail"]["message"]
    assert admin.get(f"/api/projects/{created['id']}").json()["financial_entries"][0]["amount"] == "1.234"
    fixed = admin.put(url, json=[edited | {"id": original["id"]}])
    assert fixed.status_code == 200, fixed.text
    assert (fixed.json()[0]["id"], fixed.json()[0]["created_at"]) == (original["id"], original["created_at"])
    assert fixed.json()[0]["amount"] == "9.876"


@pytest.mark.parametrize("endpoint", ["project", "financial"])
@pytest.mark.parametrize("with_id", [False, True])
def test_ambiguous_replacement_without_id_is_rejected_atomically(as_user, db, endpoint, with_id):
    rows = [_finance(db, amount="1.234"), _finance(db, amount="2.345")]
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=rows)).json()
    original = created["financial_entries"]
    kept = rows[0] | ({"id": original[0]["id"]} if with_id else {})
    changed = rows[1] | {"amount": "9.876"}
    before_logs = db.scalars(select(AuditLog.id).where(
        AuditLog.entity == "project", AuditLog.entity_id == created["id"],
    )).all()
    url = f"/api/projects/{created['id']}"
    response = (as_user.put(url, json=_payload(db, description="Не сохранять", financial_entries=[kept, changed]))
                if endpoint == "project" else as_user.put(url + "/financial-entries", json=[kept, changed]))
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["field"] == "id"
    assert "ID" in response.json()["detail"]["message"]
    assert as_user.get(url).json() == created
    assert db.scalars(select(AuditLog.id).where(
        AuditLog.entity == "project", AuditLog.entity_id == created["id"],
    )).all() == before_logs


@pytest.mark.parametrize("endpoint", ["project", "financial"])
def test_legacy_unambiguous_add_delete_and_id_edit(as_user, db, endpoint):
    first = _finance(db, amount="1.234")
    second = _finance(db, amount="2.345")
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=[first])).json()
    project_url = f"/api/projects/{created['id']}"

    def save(rows):
        response = (as_user.put(project_url, json=_payload(db, financial_entries=rows)) if endpoint == "project"
                    else as_user.put(project_url + "/financial-entries", json=rows))
        assert response.status_code == 200, response.text
        return response.json()["financial_entries"] if endpoint == "project" else response.json()

    added = save([first, second])
    assert added[0]["id"] == created["financial_entries"][0]["id"]
    remaining = save([second])
    assert remaining[0]["id"] == added[1]["id"]
    edited = save([second | {"id": remaining[0]["id"], "amount": "3.456"}])
    assert (edited[0]["id"], edited[0]["amount"]) == (remaining[0]["id"], "3.456")
    assert save([]) == []


def test_legacy_partial_deletion_of_duplicate_rows_requires_id(as_user, db):
    row = _finance(db, amount="1.234")
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=[row, row])).json()
    url = f"/api/projects/{created['id']}/financial-entries"
    response = as_user.put(url, json=[row])
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["field"] == "id"
    assert as_user.get(f"/api/projects/{created['id']}").json() == created
    kept_id = created["financial_entries"][1]["id"]
    response = as_user.put(url, json=[row | {"id": kept_id}])
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()] == [kept_id]


@pytest.mark.parametrize("endpoint", ["project", "financial"])
@pytest.mark.parametrize("keep_one", [False, True])
def test_explicit_null_allows_deletion_and_addition_in_one_request(as_user, db, endpoint, keep_one):
    rows = [_finance(db, amount="1.234"), _finance(db, amount="2.345")]
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=rows)).json()
    old = created["financial_entries"]
    new = _finance(db, amount="3.456") | {"id": None}
    entries = ([rows[0] | {"id": old[0]["id"]}] if keep_one else []) + [new]
    url = f"/api/projects/{created['id']}"
    result = (as_user.put(url, json=_payload(db, financial_entries=entries)) if endpoint == "project"
              else as_user.put(url + "/financial-entries", json=entries))
    assert result.status_code == 200, result.text
    saved = result.json()["financial_entries"] if endpoint == "project" else result.json()
    assert len(saved) == len(entries)
    assert (old[0]["id"] in {item["id"] for item in saved}) is keep_one
    assert old[1]["id"] not in {item["id"] for item in saved}
    assert any(item["amount"] == "3.456" for item in saved)


def test_explicit_null_creates_another_identical_row_and_duplicate_ids_are_rejected(as_user, db):
    row = _finance(db, amount="1.234")
    created = as_user.post("/api/projects", json=_payload(db, financial_entries=[row])).json()
    existing_id = created["financial_entries"][0]["id"]
    url = f"/api/projects/{created['id']}/financial-entries"
    result = as_user.put(url, json=[row | {"id": existing_id}, row | {"id": None}])
    assert result.status_code == 200, result.text
    assert len({item["id"] for item in result.json()}) == 2
    before = as_user.get(f"/api/projects/{created['id']}").json()
    duplicate = row | {"id": existing_id}
    rejected = as_user.put(url, json=[duplicate, duplicate])
    assert rejected.status_code == 422
    assert as_user.get(f"/api/projects/{created['id']}").json() == before


@pytest.mark.parametrize("present", [None, 1])
def test_mixed_explicit_and_omitted_id_is_rejected_even_on_create(as_user, db, present):
    row = _finance(db, amount="1.234")
    result = as_user.post("/api/projects", json=_payload(db, financial_entries=[row, row | {"id": present}]))
    assert result.status_code == 422
    assert result.json()["detail"]["field"] == "id"


def test_postgres_legacy_replacement_rejects_without_changing_ids_or_card(request):
    api = request.getfixturevalue("pg_api")
    payload = api.payload()
    saved = api.create(payload)
    original = saved["financial_entries"][0]
    changed = payload["financial_entries"][0] | {"amount": "9.876"}
    url = f"/{saved['id']}"
    rejected = api.request("PUT", url, payload | {"description": "Не сохранять", "financial_entries": [changed]})
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["detail"]["field"] == "id"
    current = api.request("GET", url).json()
    assert current == saved
    corrected = api.request("PUT", url + "/financial-entries", [changed | {"id": original["id"]}])
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()[0]["id"] == original["id"]
    replacement = api.request("PUT", url + "/financial-entries", [changed | {"id": None}])
    assert replacement.status_code == 200, replacement.text
    assert replacement.json()[0]["id"] != original["id"]
