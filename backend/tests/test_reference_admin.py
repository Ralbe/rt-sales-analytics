import pytest
from conftest import login
from sqlalchemy import select
from test_project_history import _finance
from test_projects import _payload

from app.models import AuditLog, ReferenceValue


@pytest.fixture
def admin(client, db):
    login(client, db, "admin@example.com")
    return client


@pytest.mark.parametrize("email", ["analyst@example.com", "manager1@example.com"])
def test_admin_endpoints_reject_non_admin(client, db, email):
    login(client, db, email)
    assert client.get("/api/reference-admin").status_code == 403
    assert client.get("/api/reference-admin/payment_type").status_code == 403
    assert client.post("/api/reference-admin/payment_type", json={"name": "А"}).status_code == 403
    assert client.put("/api/reference-admin/payment_type/1/name", json={"name": "А"}).status_code == 403
    assert client.put("/api/reference-admin/payment_type/1/active", json={"is_active": False}).status_code == 403


def test_admin_lifecycle_allowlist_audit_and_stage_guard(admin, db):
    assert admin.post("/api/reference-admin/roles", json={"name": "А"}).status_code == 404
    assert admin.post("/api/reference-admin/customer_stage", json={"name": "А"}).status_code == 409
    assert admin.post("/api/reference-admin/payment_type", json={"name": "А", "code": "x"}).status_code == 422
    response = admin.post("/api/reference-admin/payment_type", json={"name": " Новый платёж "})
    assert response.status_code == 201, response.text
    item = response.json()
    item_id = item["id"]
    assert item["name"] == "Новый платёж"
    created = admin.post("/api/projects", json=_payload(db, payment_type_id=item_id))
    assert created.status_code == 201, created.text
    assert created.json()["payment_type"]["id"] == item_id
    assert admin.post("/api/reference-admin/payment_type", json={"name": "новый ПЛАТЁЖ"}).status_code == 409
    assert admin.put(f"/api/reference-admin/cost_type/{item_id}/name", json={"name": "X"}).status_code == 404
    assert admin.put(f"/api/reference-admin/payment_type/{item_id}/name", json={"name": "Изменён"}).status_code == 200
    assert (
        admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": False}).status_code == 200
    )
    assert item_id not in [x["id"] for x in admin.get("/api/refs").json()["payment_types"]]
    assert (
        admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": False}).status_code == 200
    )
    assert admin.put(f"/api/reference-admin/payment_type/{item_id}/active", json={"is_active": True}).status_code == 200
    row = db.get(ReferenceValue, item_id)
    assert (row.id, row.code, row.name, row.is_active) == (item_id, item["code"], "Изменён", True)
    logs = db.scalars(select(AuditLog).where(AuditLog.entity == "reference_value", AuditLog.entity_id == item_id)).all()
    assert len(logs) == 4
    assert logs[1].payload["before"]["name"] == "Новый платёж"
    assert logs[1].payload["after"]["name"] == "Изменён"
    assert admin.delete(f"/api/reference-admin/payment_type/{item_id}").status_code == 404
    stage = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "customer_stage"))
    prior = (stage.code, stage.position, stage.probability, stage.is_active)
    assert (
        admin.put(f"/api/reference-admin/customer_stage/{stage.id}/active", json={"is_active": False}).status_code
        == 409
    )
    assert (
        admin.put(
            f"/api/reference-admin/customer_stage/{stage.id}/name", json={"name": "Этап переименован"}
        ).status_code
        == 200
    )
    assert (stage.code, stage.position, stage.probability, stage.is_active) == prior


def test_inactive_project_and_finance_retained_but_new_assignments_rejected(admin, db):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    finance = _finance(db, "cost", amount="12.345")
    payload = _payload(db, payment_type_id=ref.id, financial_entries=[finance])
    created = admin.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    project = created.json()
    status_id = finance["status_id"]
    assert admin.put(f"/api/reference-admin/payment_type/{ref.id}/active", json={"is_active": False}).status_code == 200
    assert (
        admin.put(f"/api/reference-admin/cost_status/{status_id}/active", json={"is_active": False}).status_code == 200
    )
    read = admin.get(f"/api/projects/{project['id']}").json()
    assert read["payment_type"]["id"] == ref.id
    assert read["financial_entries"][0]["status"]["id"] == status_id
    unchanged = admin.put(f"/api/projects/{project['id']}", json=payload | {"description": "Изменено"})
    assert unchanged.status_code == 200, unchanged.text
    row_id = unchanged.json()["financial_entries"][0]["id"]
    edited = finance | {"id": row_id, "amount": "55.000"}
    result = admin.put(f"/api/projects/{project['id']}/financial-entries", json=[edited])
    assert result.status_code == 200, result.text
    row_id = result.json()[0]["id"]
    duplicate = edited | {"id": row_id}
    assert admin.put(f"/api/projects/{project['id']}/financial-entries", json=[duplicate, duplicate]).status_code == 422
    assert admin.put(f"/api/projects/{project['id']}/financial-entries", json=[duplicate, finance]).status_code == 422
    assert admin.post("/api/projects", json=payload | {"name": "Другой проект"}).status_code == 422
    assert (
        admin.put(f"/api/projects/{project['id']}/financial-entries", json=[finance | {"id": 999999}]).status_code
        == 422
    )


def test_audit_failure_rolls_back_change(admin, db, monkeypatch):
    from app.api import reference_admin

    row = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    name = row.name

    def fail(*args, **kwargs):
        raise RuntimeError("audit failed")

    monkeypatch.setattr(reference_admin.audit, "record", fail)
    with pytest.raises(RuntimeError):
        admin.put(f"/api/reference-admin/payment_type/{row.id}/name", json={"name": "Не сохранять"})
    assert db.get(ReferenceValue, row.id).name == name


def test_rename_preserves_project_identity_and_historical_snapshot(admin, db):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == "payment_type"))
    original_name = ref.name
    created = admin.post("/api/projects", json=_payload(db, payment_type_id=ref.id))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    assert (
        admin.put(f"/api/reference-admin/payment_type/{ref.id}/name", json={"name": "Другое название"}).status_code
        == 200
    )
    current = admin.get(f"/api/projects/{project_id}").json()
    assert current["payment_type"] == {"id": ref.id, "name": "Другое название"}
    history = admin.get(f"/api/projects/{project_id}/history").json()["items"]
    assert (
        next(change for change in history[0]["changes"] if change["field"] == "payment_type_id")["after"]
        == original_name
    )


@pytest.mark.parametrize(
    ("field", "category"),
    [
        ("payment_type_id", "payment_type"),
        ("indicator_id", "project_indicator"),
        ("assessment_status_id", "assessment_status"),
    ],
)
def test_inactive_project_references_are_only_retained(admin, db, field, category):
    ref = db.scalar(select(ReferenceValue).where(ReferenceValue.category == category))
    payload = _payload(db, **{field: ref.id}, accepted_for_forecast=True)
    created = admin.post("/api/projects", json=payload)
    assert created.status_code == 201, created.text
    assert admin.put(f"/api/reference-admin/{category}/{ref.id}/active", json={"is_active": False}).status_code == 200
    updated = admin.put(f"/api/projects/{created.json()['id']}", json=payload | {"description": "Изменено"})
    assert updated.status_code == 200, updated.text
    assert admin.post("/api/projects", json=payload | {"name": "Новый проект"}).status_code == 422


@pytest.mark.parametrize(
    ("kind", "field", "category"),
    [
        ("revenue", "status_id", "revenue_status"),
        ("cost", "status_id", "cost_status"),
        ("cost", "article_id", "cost_article"),
        ("cost", "cost_type_id", "cost_type"),
    ],
)
def test_inactive_financial_references_are_only_retained(admin, db, kind, field, category):
    row = _finance(db, kind)
    created = admin.post("/api/projects", json=_payload(db, financial_entries=[row]))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    row_id = created.json()["financial_entries"][0]["id"]
    assert (
        admin.put(f"/api/reference-admin/{category}/{row[field]}/active", json={"is_active": False}).status_code == 200
    )
    result = admin.put(f"/api/projects/{project_id}/financial-entries", json=[row | {"id": row_id, "year": 2028}])
    assert result.status_code == 200, result.text
    assert admin.put(f"/api/projects/{project_id}/financial-entries", json=[row]).status_code == 422
