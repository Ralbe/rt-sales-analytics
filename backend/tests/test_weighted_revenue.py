from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import Client, Project, ProjectFinancialEntry, ReferenceValue, Service, Stage, User
from app.services.weighted_revenue import project_projection


@pytest.fixture
def revenue_projects(db):
    service = Service(name="Изолированная услуга для взвешенной выручки")
    db.add(service)
    owner = db.scalar(select(User).where(User.email == "manager1@example.com"))
    other = db.scalar(select(User).where(User.email == "manager2@example.com"))
    client = db.scalars(select(Client)).first()
    stage = db.scalars(select(ReferenceValue).where(ReferenceValue.category == "customer_stage")).first()
    status = db.scalars(select(ReferenceValue).where(ReferenceValue.category == "revenue_status")).first()
    projects = []
    for index, (scheme, probability, manager, archived) in enumerate([
        ("customer", 37, owner, False), ("legacy", 50, owner, False),
        ("customer", 100, other, False), ("customer", 100, owner, True),
        ("customer", 0, owner, False), ("customer", 100, owner, False),
    ]):
        p = Project(
            name=f"Взвешенная выручка {index}", client=client, manager=manager, service=service,
            segment_id=client.segment_id, stage_scheme=scheme,
            stage=Stage.proposal if scheme == "legacy" else None,
            customer_stage=stage if scheme == "customer" else None,
            amount=Decimal("100.01"), cost=0, probability=probability,
            start_date=date(2026, 1, 1), expected_close_date=date(2026, 12, 31),
            archived_at=datetime.now(UTC) if archived else None,
        )
        if index != 5:
            p.financial_entries = [
                ProjectFinancialEntry(kind="revenue", year=2026, month=1, amount=Decimal("1000.001"),
                                      vat_included=True, status=status),
                ProjectFinancialEntry(kind="revenue", year=2027, month=2, amount=Decimal("2.000"),
                                      vat_included=False, status=status),
                ProjectFinancialEntry(kind="cost", year=2026, month=1, amount=Decimal("999999.999"),
                                      vat_included=True, status=status),
            ]
        db.add(p)
        projects.append(p)
    db.flush()
    return projects


def buckets(data):
    return {item["basis"]: item for item in data["buckets"]}


def test_projection_sources_units_vat_missing_and_probability_extremes(revenue_projects):
    customer, legacy, complete, _, zero, missing = revenue_projects
    projection = project_projection(customer)
    values = buckets(projection)
    assert projection["source"] == "monthly_revenue"
    assert values["with_vat"]["revenue_rub"] == Decimal("1000001.00")
    assert values["with_vat"]["weighted_revenue_rub"] == Decimal("370000.37")
    assert values["without_vat"]["weighted_revenue_rub"] == Decimal("740.00")
    # Legacy monthly rows are ignored; no double counting, and HALF_UP to cents.
    assert buckets(project_projection(legacy))["unspecified"]["weighted_revenue_rub"] == Decimal("50.01")
    for item in project_projection(complete)["buckets"]:
        assert item["revenue_rub"] == item["weighted_revenue_rub"]
    assert all(item["weighted_revenue_rub"] == 0 for item in project_projection(zero)["buckets"])
    assert project_projection(missing) == {"source": "monthly_revenue", "has_revenue": False, "buckets": []}


def test_summary_scope_and_archive(as_user, revenue_projects):
    params = {"service_id": revenue_projects[0].service_id}
    response = as_user.get("/api/analytics/weighted-revenue", params=params)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["stage_scope"] == "all"
    assert data["project_count"] == 4
    assert data["missing_revenue_count"] == 1
    values = buckets(data)
    assert values["with_vat"]["revenue_rub"] == "2000002.00"
    assert values["with_vat"]["weighted_revenue_rub"] == "370000.37"
    assert values["unspecified"]["weighted_revenue_rub"] == "50.01"
    # A manager filter cannot broaden permissions.
    response = as_user.get("/api/analytics/weighted-revenue", params=params | {
        "manager_id": revenue_projects[2].manager_id,
    })
    assert response.json()["project_count"] == 0


def test_summary_filters_and_live_updates(as_analyst, revenue_projects, db):
    first = revenue_projects[0]
    params = {"service_id": first.service_id, "segment_id": first.segment_id, "manager_id": first.manager_id}
    assert as_analyst.get("/api/analytics/weighted-revenue", params=params).json()["project_count"] == 4
    first.probability = 10
    first.financial_entries[0].amount = Decimal("7.001")
    db.flush()
    values = buckets(as_analyst.get("/api/analytics/weighted-revenue", params=params).json())
    assert values["with_vat"]["weighted_revenue_rub"] == "700.10"
    assert as_analyst.get("/api/analytics/weighted-revenue", params={"service_id": -1}).json()["project_count"] == 0


def test_registry_projection_and_report_columns(as_analyst, revenue_projects):
    first = revenue_projects[0]
    item = as_analyst.get(f"/api/projects/{first.id}").json()
    assert buckets(item["revenue_projection"])["with_vat"]["weighted_revenue_rub"] == "370000.37"
    fields = ["project.weighted_revenue_with_vat", "project.weighted_revenue_without_vat",
              "project.weighted_revenue_legacy"]
    response = as_analyst.post("/api/reports/preview", json={"definition": {
        "grain": "project", "columns": ["project.id", *fields], "sort": [],
        "filters": [{"field": "project.id", "operator": "eq", "value": first.id}],
    }})
    assert response.status_code == 200, response.text
    snapshot = as_analyst.get(f"/api/report-snapshots/{response.json()['snapshot_id']}").json()
    assert snapshot["rows"] == [{"project.id": first.id, fields[0]: "370000.37", fields[1]: "740.00", fields[2]: None}]


def test_weighted_summary_requires_login(client):
    assert client.get("/api/analytics/weighted-revenue").status_code == 401


def test_report_rounding_matches_projection(as_analyst, revenue_projects, db):
    legacy = revenue_projects[1]
    legacy.amount = Decimal("100.05")
    db.flush()
    field = "project.weighted_revenue_legacy"
    response = as_analyst.post("/api/reports/preview", json={"definition": {
        "grain": "project", "columns": [field], "sort": [],
        "filters": [{"field": "project.id", "operator": "eq", "value": legacy.id}],
    }})
    assert response.status_code == 200, response.text
    snapshot = as_analyst.get(f"/api/report-snapshots/{response.json()['snapshot_id']}").json()
    assert snapshot["rows"] == [{field: "50.03"}]
    assert buckets(project_projection(legacy))["unspecified"]["weighted_revenue_rub"] == Decimal("50.03")
