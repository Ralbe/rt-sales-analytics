from datetime import UTC, date, datetime, timedelta

from project_factories import customer_payload
from sqlalchemy import select

from app.models import AuditLog, Project, ReferenceValue


def _stage(db, code):
    return db.scalar(select(ReferenceValue).where(
        ReferenceValue.category == "customer_stage", ReferenceValue.code == code,
    ))


def _create(client, db, **changes):
    response = client.post("/api/projects", json=customer_payload(db, **changes))
    assert response.status_code == 201, response.text
    return response.json()


def _shift_history(db, project_id, days):
    """Сдвигает дату создания и события проекта в прошлое, чтобы получить длительность этапа."""
    project = db.get(Project, project_id)
    project.created_at = project.created_at - timedelta(days=days)
    for event in db.scalars(select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == project_id)):
        event.created_at = event.created_at - timedelta(days=days)
    db.commit()


def test_pipeline_counts_customer_stage_projects_with_weighted_amount(as_analyst, db):
    before = as_analyst.get("/api/analytics/pipeline").json()
    stage = _stage(db, "proposal")
    _create(as_analyst, db, name="Воронка А", amount="1000000.00", customer_stage_id=stage.id)
    after = as_analyst.get("/api/analytics/pipeline")
    assert after.status_code == 200, after.text
    body = after.json()
    assert body["totals"]["count"] == before["totals"]["count"] + 1
    assert round(body["totals"]["weighted_amount"] - before["totals"]["weighted_amount"], 2) == round(
        1_000_000 * stage.probability / 100, 2
    )
    row = next(item for item in body["by_stage"] if item["key"] == str(stage.id))
    assert row["count"] >= 1
    assert [item["label"] for item in body["by_stage"]][0].startswith("1.")


def test_pipeline_average_days_on_stage_uses_history(as_analyst, db):
    lead, proposal = _stage(db, "lead"), _stage(db, "proposal")
    project = _create(as_analyst, db, name="Воронка Б", customer_stage_id=lead.id)
    _shift_history(db, project["id"], 10)
    response = as_analyst.put(
        f"/api/projects/{project['id']}", json=customer_payload(db, name="Воронка Б", customer_stage_id=proposal.id)
    )
    assert response.status_code == 200, response.text
    body = as_analyst.get("/api/analytics/pipeline", params={"customer_stage_id": [lead.id, proposal.id]}).json()
    lead_row = next(item for item in body["by_stage"] if item["key"] == str(lead.id))
    assert lead_row["avg_days"] is not None and lead_row["avg_days"] >= 10


def test_period_changes_flags_new_stage_up_and_revenue(as_analyst, db):
    lead, proposal = _stage(db, "lead"), _stage(db, "proposal")
    project = _create(as_analyst, db, name="Воронка В", amount="500000.00", customer_stage_id=lead.id)
    _shift_history(db, project["id"], 40)
    response = as_analyst.put(
        f"/api/projects/{project['id']}",
        json=customer_payload(db, name="Воронка В", amount="900000.00", customer_stage_id=proposal.id),
    )
    assert response.status_code == 200, response.text
    today = datetime.now(UTC).date()

    week = as_analyst.get("/api/analytics/changes", params={
        "date_from": (today - timedelta(days=6)).isoformat(), "date_to": today.isoformat(),
    }).json()
    item = next(i for i in week["items"] if i["project_id"] == project["id"])
    assert item["indicators"] == ["stage_up"]  # Сумма контракта не является выручкой.

    quarter = as_analyst.get("/api/analytics/changes", params={
        "date_from": (today - timedelta(days=90)).isoformat(), "date_to": today.isoformat(),
    }).json()
    item = next(i for i in quarter["items"] if i["project_id"] == project["id"])
    assert "new" in item["indicators"]


def test_period_changes_flags_stage_down_implemented_industry_and_removed(client, db):
    from conftest import login

    login(client, db, "admin@example.com")
    pilot, success, lead = _stage(db, "pilot"), _stage(db, "success"), _stage(db, "lead")
    up = _create(client, db, name="Воронка Г", customer_stage_id=pilot.id)
    down = _create(client, db, name="Воронка Д", customer_stage_id=pilot.id)
    for project in (up, down):
        _shift_history(db, project["id"], 30)
    client.put(f"/api/projects/{up['id']}", json=customer_payload(
        db, name="Воронка Г", customer_stage_id=success.id, is_industry_solution=True, industry_manager="Отраслевик",
    ))
    client.put(f"/api/projects/{down['id']}", json=customer_payload(db, name="Воронка Д", customer_stage_id=lead.id))
    assert client.post(f"/api/projects/{down['id']}/archive").status_code == 200
    today = date.today()
    body = client.get("/api/analytics/changes", params={
        "date_from": (today - timedelta(days=1)).isoformat(), "date_to": (today + timedelta(days=1)).isoformat(),
    }).json()
    found = {i["project_id"]: i["indicators"] for i in body["items"]}
    assert found[up["id"]] == ["stage_up", "industry", "implemented"]
    assert found[down["id"]] == ["removed", "stage_down"]
    assert body["counts"]["implemented"] >= 1


def test_period_changes_rejects_reversed_period_and_respects_scope(as_user, db):
    today = date.today().isoformat()
    bad = as_user.get("/api/analytics/changes", params={"date_from": "2026-12-01", "date_to": "2026-01-01"})
    assert bad.status_code == 422
    ok = as_user.get("/api/analytics/changes", params={"date_from": "2000-01-01", "date_to": today})
    assert ok.status_code == 200
    ids = {i["project_id"] for i in ok.json()["items"]}
    owners = {p.manager.email for p in db.scalars(select(Project).where(Project.id.in_(ids)))} if ids else set()
    assert owners <= {"manager1@example.com"}


def test_gantt_shows_stage_segments_and_finance_months(as_analyst, db):
    lead, proposal = _stage(db, "lead"), _stage(db, "proposal")
    project = _create(as_analyst, db, name="Воронка Е", customer_stage_id=lead.id)
    _shift_history(db, project["id"], 20)
    status_id = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "revenue_status"))
    payload = customer_payload(db, name="Воронка Е", customer_stage_id=proposal.id, financial_entries=[
        {"kind": "revenue", "year": 2026, "month": 3, "amount": "10", "vat_included": True, "status_id": status_id},
        {"kind": "revenue", "year": 2026, "month": 3, "amount": "5", "vat_included": False, "status_id": status_id},
    ])
    assert as_analyst.put(f"/api/projects/{project['id']}", json=payload).status_code == 200
    body = as_analyst.get(f"/api/projects/{project['id']}/gantt").json()
    assert [s["label"] for s in body["stages"]] == [lead.name, proposal.name]
    segment = body["stages"][0]
    assert (datetime.fromisoformat(segment["end"]) - datetime.fromisoformat(segment["start"])).days == 20
    assert {(r["year"], r["month"], r["amount"], r["vat_included"]) for r in body["revenue"]} == {
        (2026, 3, 10.0, True), (2026, 3, 5.0, False),
    }
    assert body["costs"] == []


def test_stage_reorder_preserves_past_transition_direction_and_applies_to_future(client, db):
    from conftest import login

    login(client, db, "admin@example.com")
    lead, qual = _stage(db, "lead"), _stage(db, "lead_work")
    assert lead.position < qual.position

    p_past = _create(client, db, name="Прошлый переход", customer_stage_id=lead.id)
    _shift_history(db, p_past["id"], 20)
    # Переход lead -> qualification до перестановки (вперёд / stage_up)
    assert (
        client.put(
            f"/api/projects/{p_past['id']}",
            json=customer_payload(db, name="Прошлый переход", customer_stage_id=qual.id),
        ).status_code
        == 200
    )

    # Переставляем qualification на позицию 1 (теперь qualification перед lead)
    assert (
        client.put(
            f"/api/reference-admin/customer_stage/{qual.id}/position",
            json={"position": 1},
        ).status_code
        == 200
    )

    # Новый проект переходит lead -> qualification ПОСЛЕ перестановки (теперь это назад / stage_down)
    p_future = _create(client, db, name="Будущий переход", customer_stage_id=lead.id)
    _shift_history(db, p_future["id"], 20)
    assert (
        client.put(
            f"/api/projects/{p_future['id']}",
            json=customer_payload(db, name="Будущий переход", customer_stage_id=qual.id),
        ).status_code
        == 200
    )

    today = date.today()
    body = client.get(
        "/api/analytics/changes",
        params={
            "date_from": (today - timedelta(days=5)).isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
        },
    ).json()
    found = {i["project_id"]: i["indicators"] for i in body["items"]}
    assert found[p_past["id"]] == ["stage_up"]
    assert found[p_future["id"]] == ["stage_down"]

