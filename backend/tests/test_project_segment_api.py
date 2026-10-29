"""Сегмент принадлежит проекту и не меняет другие проекты клиента."""

from io import BytesIO

import pytest
from conftest import login
from openpyxl import load_workbook
from project_factories import customer_payload
from sqlalchemy import select

from app.models import Client, Segment, User


def test_independent_project_segments_register_export_and_history(as_analyst, db):
    customer = db.scalar(select(Client).order_by(Client.id))
    original = customer.segment_id
    different = db.scalar(select(Segment.id).where(Segment.is_active, Segment.id != original).order_by(Segment.id))
    assert different is not None
    common = {"client_id": customer.id, "implementation_year": 2028}
    first = as_analyst.post("/api/projects", json=customer_payload(
        db, name="Сегмент первый", segment_id=original, **common,
    ))
    second = as_analyst.post("/api/projects", json=customer_payload(
        db, name="Сегмент второй", segment_id=different, **common,
    ))
    assert first.status_code == second.status_code == 201
    assert first.json()["segment"]["id"] == original
    assert second.json()["segment"]["id"] == different
    assert customer.segment_id == original
    response = as_analyst.get("/api/projects", params={"q": "Сегмент ", "segment_id": different})
    assert [row["id"] for row in response.json()["items"]] == [second.json()["id"]]
    exported = as_analyst.get("/api/projects/export.xlsx", params={"q": "Сегмент ", "segment_id": different})
    rows = list(load_workbook(BytesIO(exported.content), read_only=True).active.values)
    assert len(rows) == 2 and rows[1][0] == second.json()["id"]
    update = as_analyst.put(f"/api/projects/{first.json()['id']}", json=customer_payload(
        db, name="Сегмент первый", segment_id=different, **common,
    ))
    assert update.status_code == 200
    assert update.json()["segment"]["id"] == different
    assert as_analyst.get(f"/api/projects/{second.json()['id']}").json()["segment"]["id"] == different
    assert customer.segment_id == original
    history = as_analyst.get(f"/api/projects/{first.json()['id']}/history").json()["items"]
    assert any(change["field"] == "segment_id" for item in history for change in item["changes"])


def test_segment_validation_retention_and_legacy_api(as_analyst, db):
    customer = db.scalar(select(Client).order_by(Client.id))
    other = db.scalar(select(Segment).where(Segment.is_active, Segment.id != customer.segment_id).order_by(Segment.id))
    other.is_active = False
    db.flush()
    bad = as_analyst.post("/api/projects", json=customer_payload(db, name="Запрещённый сегмент", segment_id=other.id))
    assert bad.status_code == 422
    bad = as_analyst.post("/api/projects", json=customer_payload(db, name="Нет такого сегмента", segment_id=99999999))
    assert bad.status_code == 422
    bad = as_analyst.post("/api/projects", json=customer_payload(db, name="Пустой сегмент", segment_id=None))
    assert bad.status_code == 422
    legacy = as_analyst.post("/api/projects", json=customer_payload(db, name="Совместимый проект"))
    assert legacy.status_code == 201 and legacy.json()["segment"]["id"] == customer.segment_id
    current_segment = db.get(Segment, customer.segment_id)
    current_segment.is_active = False
    db.flush()
    saved = as_analyst.put(f"/api/projects/{legacy.json()['id']}", json=customer_payload(
        db, name="Совместимый проект", description="Новая заметка", segment_id=current_segment.id,
    ))
    assert saved.status_code == 200 and saved.json()["segment"]["id"] == current_segment.id
    # Прежнее решение владельца: существующий клиент с отключённым сегментом остаётся доступен.
    inherited = as_analyst.post("/api/projects", json=customer_payload(db, name="Наследуемый сегмент"))
    assert inherited.status_code == 201 and inherited.json()["segment"]["id"] == current_segment.id


def test_omitted_year_preserves_value_and_explicit_null_clears(as_analyst, db):
    created = as_analyst.post("/api/projects", json=customer_payload(db, implementation_year=2028))
    assert created.status_code == 201
    project_id = created.json()["id"]
    updated = as_analyst.put(f"/api/projects/{project_id}", json=customer_payload(db, description="Без года"))
    assert updated.status_code == 200 and updated.json()["implementation_year"] == 2028
    cleared = as_analyst.put(f"/api/projects/{project_id}", json=customer_payload(db, implementation_year=None))
    assert cleared.status_code == 200 and cleared.json()["implementation_year"] is None


@pytest.mark.parametrize("year", [1900, 2200, None])
def test_implementation_year_boundaries(as_analyst, db, year):
    result = as_analyst.post("/api/projects", json=customer_payload(db, implementation_year=year))
    assert result.status_code == 201 and result.json()["implementation_year"] == year


@pytest.mark.parametrize("year", [1899, 2201, 2027.5, "2027-01-01"])
def test_invalid_implementation_year_is_rejected(as_analyst, db, year):
    result = as_analyst.post("/api/projects", json=customer_payload(db, implementation_year=year))
    assert result.status_code == 422


def test_other_user_cannot_read_or_edit_project_using_segment_filter(client, db):
    login(client, db, "manager1@example.com")
    result = client.post("/api/projects", json=customer_payload(db, name="Чужой сегментированный проект"))
    assert result.status_code == 201
    project_id, segment_id = result.json()["id"], result.json()["segment"]["id"]
    client.post("/api/auth/logout")
    login(client, db, "manager2@example.com")
    assert client.get(f"/api/projects/{project_id}").status_code == 404
    assert client.put(f"/api/projects/{project_id}", json=customer_payload(
        db, name="Чужой сегментированный проект", segment_id=segment_id,
    )).status_code == 404
    listing = client.get("/api/projects", params={"q": "Чужой сегментированный проект", "segment_id": segment_id})
    assert listing.status_code == 200 and listing.json()["items"] == []


def test_unchanged_fields_in_stale_form_preserve_concurrent_changes(as_analyst, db):
    customer = db.scalar(select(Client).order_by(Client.id))
    segment = db.scalar(select(Segment.id).where(Segment.is_active, Segment.id != customer.segment_id))
    manager = db.scalar(select(User.id).where(User.email == "manager2@example.com"))
    initial = customer_payload(db, name="Карточка для двух пользователей", implementation_year=2028)
    created = as_analyst.post("/api/projects", json=initial)
    assert created.status_code == 201
    project_id = created.json()["id"]
    edited = as_analyst.put(f"/api/projects/{project_id}", json=initial | {
        "manager_id": manager, "segment_id": segment, "implementation_year": 2030,
    })
    assert edited.status_code == 200
    stale_form = customer_payload(db, name=initial["name"], description="Изменено другое поле")
    response = as_analyst.put(f"/api/projects/{project_id}", json=stale_form)
    assert response.status_code == 200
    assert response.json()["manager"]["id"] == manager
    assert response.json()["segment"]["id"] == segment
    assert response.json()["implementation_year"] == 2030
