from datetime import timedelta

from conftest import login
from project_factories import customer_payload
from sqlalchemy import select

from app.models import AuditLog, Project, ReferenceValue


def _ref(db, category, code):
    return db.scalar(select(ReferenceValue).where(ReferenceValue.category == category, ReferenceValue.code == code))


def _entries(db, revenue, cost):
    revenue_status = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "revenue_status"))
    cost_status = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "cost_status"))
    cost_type = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "cost_type"))
    article = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "cost_article"))
    return [
        {"id": None, "kind": "revenue", "year": 2026, "month": 1, "amount": revenue, "vat_included": False,
         "status_id": revenue_status},
        {"id": None, "kind": "cost", "year": 2026, "month": 1, "amount": cost, "vat_included": False,
         "status_id": cost_status, "cost_type_id": cost_type, "article_id": article},
    ]


def _create(client, db, **changes):
    response = client.post("/api/projects", json=customer_payload(db, **changes))
    assert response.status_code == 201, response.text
    return response.json()


def test_profit_splits_implemented_and_in_progress(as_analyst, db):
    before = as_analyst.get("/api/analytics/profit").json()
    success = _ref(db, "customer_stage", "success")
    done = _create(as_analyst, db, name="Прибыль готов", customer_stage_id=success.id,
                   financial_entries=_entries(db, "500", "200"))
    work = _create(as_analyst, db, name="Прибыль в работе", financial_entries=_entries(db, "100", "150"))
    body = as_analyst.get("/api/analytics/profit", params={"limit": 50}).json()
    groups = {g["key"]: g for g in body["groups"]}
    old = {g["key"]: g for g in before["groups"]}
    assert round(groups["implemented"]["profit"] - old["implemented"]["profit"], 2) == 300_000
    assert round(groups["in_progress"]["profit"] - old["in_progress"]["profit"], 2) == -50_000
    rows = {r["project_id"]: r for r in body["items"]}
    assert rows[done["id"]]["status"] == "implemented" and rows[done["id"]]["margin_pct"] == 60.0
    assert rows[work["id"]]["profit"] == -50_000


def test_failures_explain_removed_churn_and_stalled(client, db):
    admin = login(client, db, "admin@example.com")
    churn = _ref(db, "assessment_status", "churn")
    removed = _create(client, db, name="Снятый проект")
    assert client.post(f"/api/projects/{removed['id']}/archive").status_code == 200
    lost = _create(client, db, name="Отток проекта", accepted_for_forecast=True, assessment_status_id=churn.id)
    stalled = _create(client, db, name="Застрявший проект")
    project = db.get(Project, stalled["id"])
    for event in db.scalars(select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == project.id)):
        event.created_at = event.created_at - timedelta(days=400)
    project.created_at = project.created_at - timedelta(days=400)
    db.commit()

    body = client.get("/api/analytics/failures", params={"limit": 100, "manager_id": admin.id}).json()
    reasons = {r["project_id"]: r["reason"] for r in body["items"]}
    assert reasons[removed["id"]] == "removed"
    assert reasons[lost["id"]] == "churn"
    assert reasons[stalled["id"]] == "stalled"
    counts = {r["key"]: r["count"] for r in body["by_reason"]}
    assert counts["removed"] == 1 and counts["churn"] == 1 and counts["stalled"] == 1
    assert body["total"] == sum(counts.values())
    assert sum(g["count"] for g in body["by_stage"]) == body["total"]


def test_user_sees_only_own_failures(as_user, db):
    body = as_user.get("/api/analytics/failures", params={"limit": 100}).json()
    managers = {r["manager"] for r in body["items"]}
    assert managers <= {"Мария Продажина"}
