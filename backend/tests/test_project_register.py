from datetime import date
from decimal import Decimal

import pytest
from conftest import login
from sqlalchemy import select

from app.models import Client, Project, ProjectFinancialEntry, ReferenceValue, Service, Stage, User

PREFIX = "Независимый реестр"


@pytest.fixture
def register(db):
    manager = db.scalar(select(User).where(User.email == "manager1@example.com"))
    other = db.scalar(select(User).where(User.email == "manager2@example.com"))
    source_client = db.scalars(select(Client)).first()
    clients = [
        Client(name="Организация " + "Я" * 238, inn="0012345678", segment_id=source_client.segment_id),
        Client(name="Вторая организация", inn="001234567801", segment_id=source_client.segment_id),
        Client(name="Третья организация", inn="9912345678", segment_id=source_client.segment_id),
    ]
    db.add_all(clients)
    stages = db.scalars(select(ReferenceValue).where(
        ReferenceValue.category == "customer_stage",
    ).order_by(ReferenceValue.id).limit(2)).all()
    service = db.scalars(select(Service)).first()
    # Legacy-стадия, этап ТЗ и сохранённая вероятность намеренно независимы.
    projects = []
    for index, (client, owner, year, customer_stage) in enumerate([
        (clients[1], manager, 2028, stages[0]),
        (clients[0], manager, 2027, stages[1]),
        (clients[2], manager, None, None),
        (clients[0], other, 2027, stages[1]),
        (clients[1], manager, 2027, stages[1]),
    ]):
        project = Project(
            name=f"{PREFIX} {index} " + "П" * (300 - len(PREFIX) - 3),
            description="Исходное описание",
            client=client, manager=owner, service=service,
            stage=Stage.won if index == 1 else Stage.proposal,
            customer_stage=customer_stage, probability=37,
            amount=Decimal("987654321098.76"), cost=Decimal("123456789012.34"),
            start_date=date(2026, 1, 1), expected_close_date=date(2026, 12, 31),
            implementation_year=year, project_status="Статус " + "С" * 93,
            realized_work="Сделано\n" + "Д" * 1000, period_plan="Планы\n" + "П" * 1000,
        )
        db.add(project)
        projects.append(project)
    status = db.scalars(select(ReferenceValue).where(ReferenceValue.category == "revenue_status")).first()
    projects[0].financial_entries = [
        ProjectFinancialEntry(kind="revenue", year=2027, month=month, amount=Decimal("999.123"),
                              vat_included=True, status=status)
        for month in (1, 2)
    ]
    db.flush()
    return projects


def test_register_preserves_source_fields_and_amounts(as_user, register):
    response = as_user.get("/api/projects", params={"q": PREFIX})
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 4
    item = next(p for p in page["items"] if p["id"] == register[0].id)
    assert item["client_inn"] == "001234567801"
    assert item["name"] == register[0].name
    assert item["implementation_year"] == 2028
    assert item["stage"] == "proposal"
    assert item["customer_stage"]["id"] == register[0].customer_stage_id
    assert item["probability"] == 37
    for field in ("project_status", "realized_work", "period_plan"):
        assert item[field] == getattr(register[0], field)
    assert item["amount"] == "987654321098.76"
    assert item["cost"] == "123456789012.34"
    assert item["margin"] == "864197532086.42"
    assert [entry["amount"] for entry in item["financial_entries"]] == ["999.123", "999.123"]
    assert not any("weighted" in field for field in item)


def test_register_null_fields_are_not_inferred_from_legacy_stage(as_user, register):
    item = next(p for p in as_user.get("/api/projects", params={"q": PREFIX}).json()["items"]
                if p["id"] == register[2].id)
    assert item["client_inn"] == "9912345678"
    assert item["customer_stage"] is None
    assert item["implementation_year"] is None
    assert item["stage"] == "proposal"
    assert item["probability"] == 37


@pytest.mark.parametrize("filters,indices", [
    ({"implementation_year": 2027}, [1, 4]),
    ({"customer_stage_id": "first"}, [0]),
    ({"customer_stage_id": "second", "implementation_year": 2027}, [1, 4]),
    ({"customer_stage_id": "first", "implementation_year": 2027}, []),
    ({"customer_stage_id": "second", "stage": "won"}, [1]),
    ({"customer_stage_id": "second", "open_only": True}, [4]),
    ({"implementation_year": 1900}, []),
    ({"implementation_year": 2200}, []),
    ({"customer_stage_id": 999999999}, []),
])
def test_register_exact_filters(as_user, register, filters, indices):
    params = {"q": PREFIX, **filters}
    if params.get("customer_stage_id") in ("first", "second"):
        params["customer_stage_id"] = register[0 if params["customer_stage_id"] == "first" else 1].customer_stage_id
    response = as_user.get("/api/projects", params=params)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == len(indices)
    assert {p["id"] for p in page["items"]} == {register[i].id for i in indices}


@pytest.mark.parametrize("field", ["client_inn", "implementation_year", "customer_stage_id"])
@pytest.mark.parametrize("descending", [False, True])
def test_register_sort_and_pagination(as_user, register, field, descending):
    own = [register[i] for i in (0, 1, 2, 4)]

    def value(project):
        return project.client.inn if field == "client_inn" else getattr(project, field)

    # Пустые значения в конце в обоих направлениях, ID разрешает совпадения.
    populated = sorted((p for p in own if value(p) is not None), key=lambda p: p.id, reverse=True)
    expected = sorted(populated, key=value, reverse=descending)
    expected += sorted((p for p in own if value(p) is None), key=lambda p: p.id, reverse=True)
    ids = []
    for page_number in (1, 2):
        response = as_user.get("/api/projects", params={
            "q": PREFIX, "sort": ("-" if descending else "") + field, "page": page_number, "size": 2,
        })
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["total"] == 4
        assert page["page"] == page_number
        ids.extend(p["id"] for p in page["items"])
    assert ids == [p.id for p in expected]


@pytest.mark.parametrize("email,indices", [
    ("manager1@example.com", [1, 4]),
    ("analyst@example.com", [1, 3, 4]),
    ("admin@example.com", [1, 3, 4]),
])
def test_register_filter_keeps_server_scope(client, db, register, email, indices):
    login(client, db, email)
    params = {"q": PREFIX, "implementation_year": 2027, "customer_stage_id": register[1].customer_stage_id,
              "sort": "client_inn"}
    response = client.get("/api/projects", params=params)
    assert response.status_code == 200, response.text
    assert response.json()["total"] == len(indices)
    assert {p["id"] for p in response.json()["items"]} == {register[i].id for i in indices}
    if email == "manager1@example.com":
        response = client.get("/api/projects", params={**params, "manager_id": register[3].manager_id})
        assert response.json()["total"] == 0


@pytest.mark.parametrize("params", [
    {"implementation_year": 1899}, {"implementation_year": 2201}, {"implementation_year": "2027.5"},
    {"customer_stage_id": 0}, {"customer_stage_id": "proposal"}, {"sort": "weighted_revenue"},
    {"sort": "client_inn; DROP TABLE projects"},
])
def test_register_rejects_invalid_filter_and_sort(as_user, params):
    assert as_user.get("/api/projects", params=params).status_code == 422


def test_register_requires_authentication(client):
    assert client.get("/api/projects", params={"implementation_year": 2027}).status_code == 401
