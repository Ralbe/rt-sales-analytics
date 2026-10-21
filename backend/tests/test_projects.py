import random

from sqlalchemy import select

from app.models import Client, Service, User
from app.seed import generate_inn


def _payload(db, **overrides):
    client = db.scalars(select(Client).order_by(Client.id)).first()
    service = db.scalars(select(Service).order_by(Service.id)).first()
    data = {
        "name": "Новый тестовый проект",
        "description": "",
        "client_id": client.id,
        "service_id": service.id,
        "stage": "proposal",
        "amount": "1500000.00",
        "cost": "900000.00",
        "probability": 50,
        "start_date": "2026-10-01",
        "expected_close_date": "2026-12-31",
    }
    return data | overrides


def test_analyst_sees_all_but_cannot_edit(as_analyst, db):
    r = as_analyst.get("/api/projects", params={"size": 5})
    assert r.status_code == 200
    assert r.json()["total"] == 300
    assert as_analyst.post("/api/projects", json=_payload(db)).status_code == 403


def test_manager_sees_only_own(as_manager, db):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    items = as_manager.get("/api/projects", params={"size": 100}).json()["items"]
    assert items and all(p["manager"]["id"] == me.id for p in items)


def test_create_project_and_duplicate(as_manager, db):
    r = as_manager.post("/api/projects", json=_payload(db))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["margin"] == "600000.00"
    assert body["margin_pct"] == 40.0
    assert body["closed_at"] is None

    check = as_manager.get(
        "/api/projects/check-name", params={"name": "новый  тестовый проект", "client_id": body["client"]["id"]}
    )
    assert check.json() == {"available": False}

    dup = as_manager.post("/api/projects", json=_payload(db))
    assert dup.status_code == 409
    assert dup.json()["detail"]["field"] == "name"


def test_validation_errors(as_manager, db):
    r = as_manager.post("/api/projects", json=_payload(db, expected_close_date="2026-09-01", amount="-1"))
    assert r.status_code == 422
    locs = {tuple(e["loc"]) for e in r.json()["detail"]}
    assert ("body", "amount") in locs


def test_closing_sets_closed_at(as_manager, db):
    created = as_manager.post("/api/projects", json=_payload(db, name="Проект на закрытие")).json()
    won = as_manager.put(f"/api/projects/{created['id']}", json=_payload(db, name="Проект на закрытие", stage="won"))
    assert won.status_code == 200
    assert won.json()["closed_at"] is not None


def test_export_xlsx(as_analyst):
    r = as_analyst.get("/api/projects/export.xlsx", params={"open_only": True})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"


def test_client_autocomplete_and_inn_validation(as_manager, db):
    segment_id = db.scalars(select(Client)).first().segment_id
    inn = generate_inn(random.Random(2026))
    assert as_manager.get("/api/clients", params={"q": "7"}).status_code == 200
    bad = as_manager.post("/api/clients", json={"name": "ООО Тест", "inn": "1234567890", "segment_id": segment_id})
    assert bad.status_code == 422
    ok = as_manager.post("/api/clients", json={"name": "ООО Тест", "inn": inn, "segment_id": segment_id})
    assert ok.status_code == 201, ok.text
    dup = as_manager.post("/api/clients", json={"name": "ООО Тест 2", "inn": inn, "segment_id": segment_id})
    assert dup.status_code == 409
