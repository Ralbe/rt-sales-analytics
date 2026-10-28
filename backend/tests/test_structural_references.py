import random

import pytest
from conftest import login
from sqlalchemy import select
from test_projects import _payload

from app.models import AuditLog, Client, Segment, Service
from app.seed import generate_inn


@pytest.fixture
def admin(client, db):
    login(client, db, "admin@example.com")
    return client


@pytest.mark.parametrize("category", ["segments", "services"])
@pytest.mark.parametrize("email", ["analyst@example.com", "manager1@example.com"])
def test_admin_acl(client, db, category, email):
    login(client, db, email)
    assert client.get(f"/api/structural-references/{category}").status_code == 403
    assert client.post(f"/api/structural-references/{category}", json={"name": "Тест"}).status_code == 403
    assert client.put(f"/api/structural-references/{category}/1/name", json={"name": "Тест"}).status_code == 403
    assert client.put(f"/api/structural-references/{category}/1/active", json={"is_active": False}).status_code == 403


@pytest.mark.parametrize("category", ["segments", "services"])
def test_add_and_rename_preserve_id_group_and_audit(admin, db, category):
    data = {"name": "Новое значение"}
    if category == "services":
        data["group_name"] = "Группа"
    response = admin.post(f"/api/structural-references/{category}", json=data)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert admin.post(f"/api/structural-references/{category}", json={"name": "НОВОЕ значение"}).status_code == 409
    updated = admin.put(f"/api/structural-references/{category}/{saved['id']}/name", json={"name": "Переименовано"})
    assert updated.status_code == 200, updated.text
    row = db.get(Segment if category == "segments" else Service, saved["id"])
    assert row.id == saved["id"] and row.name == "Переименовано" and row.is_active
    if category == "services":
        assert row.group_name == "Группа"
    logs = db.scalars(
        select(AuditLog).where(AuditLog.entity == category[:-1], AuditLog.entity_id == row.id).order_by(AuditLog.id)
    ).all()
    assert [log.action for log in logs] == ["create", "update"]
    assert logs[1].payload["before"]["name"] == "Новое значение"
    assert logs[1].payload["after"]["name"] == "Переименовано"
    assert admin.delete(f"/api/structural-references/{category}/{row.id}").status_code == 404


def test_optional_group_and_service_deactivation_and_restore(admin):
    result = admin.post("/api/structural-references/services", json={"name": "Без группы"})
    assert result.status_code == 201 and result.json()["group_name"] is None
    assert (
        admin.post("/api/structural-references/segments", json={"name": "Сегмент", "group_name": "Группа"}).status_code
        == 422
    )
    assert (
        admin.put(
            f"/api/structural-references/services/{result.json()['id']}/name",
            json={"name": "Новая", "group_name": "Другая"},
        ).status_code
        == 422
    )
    assert (
        admin.put(
            f"/api/structural-references/services/{result.json()['id']}/active", json={"is_active": False}
        ).status_code
        == 200
    )
    assert admin.put(
        f"/api/structural-references/services/{result.json()['id']}/active", json={"is_active": True}
    ).status_code == 200


def test_inactive_segment_keeps_old_clients_projects_filters_and_audit(admin, db):
    customer = db.scalar(select(Client).order_by(Client.id))
    segment = db.get(Segment, customer.segment_id)
    assert (
        admin.put(f"/api/structural-references/segments/{segment.id}/active", json={"is_active": False}).status_code
        == 200
    )
    refs = admin.get("/api/refs").json()
    assert segment.id not in {row["id"] for row in refs["segments"]}
    assert any(row["id"] == segment.id and not row["is_active"] for row in refs["filter_segments"])
    created = admin.post("/api/projects", json=_payload(db, client_id=customer.id))
    assert created.status_code == 201, created.text
    assert created.json()["segment"]["id"] == segment.id
    inn = generate_inn(random.Random(32785))
    failed = admin.post("/api/clients", json={"name": "Клиент", "inn": inn, "segment_id": segment.id})
    assert failed.status_code == 422
    assert db.scalar(select(Client).where(Client.inn == inn)) is None
    assert (
        admin.put(f"/api/structural-references/segments/{segment.id}/active", json={"is_active": True}).status_code
        == 200
    )
    assert admin.post("/api/clients", json={"name": "Клиент", "inn": inn, "segment_id": segment.id}).status_code == 201


@pytest.mark.parametrize("category", ["segments", "services"])
def test_failed_audit_rolls_back_reference_rename(admin, db, monkeypatch, category):
    from app.api import structural_references

    model = Segment if category == "segments" else Service
    row = db.scalar(select(model).order_by(model.id))
    old_name = row.name

    def fail(*args, **kwargs):
        raise RuntimeError("Ошибка аудита")

    monkeypatch.setattr(structural_references.audit, "record", fail)
    with pytest.raises(RuntimeError, match="аудита"):
        admin.put(f"/api/structural-references/{category}/{row.id}/name", json={"name": "Не сохранять"})
    assert db.get(model, row.id).name == old_name


@pytest.mark.parametrize("category", ["segments", "services"])
def test_failed_audit_rolls_back_reference_creation(admin, db, monkeypatch, category):
    from app.api import structural_references

    model = Segment if category == "segments" else Service

    def fail(*args, **kwargs):
        raise RuntimeError("Ошибка аудита")

    monkeypatch.setattr(structural_references.audit, "record", fail)
    with pytest.raises(RuntimeError, match="аудита"):
        admin.post(f"/api/structural-references/{category}", json={"name": "Не создавать"})
    assert db.scalar(select(model).where(model.name == "Не создавать")) is None
