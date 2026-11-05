from datetime import UTC, date, datetime
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace

from conftest import login
from openpyxl import Workbook
from project_factories import customer_payload
from sqlalchemy import select

from app.models import Project, ProjectFinancialEntry, ReferenceValue, ReportSnapshot
from app.services.pipeline import project_changes
from app.services.stage_intervals import duration_statistics, visits


def event(day, action, stage=1):
    return SimpleNamespace(created_at=datetime(2026, 1, day, tzinfo=UTC), action=action,
                           payload={"after": {"customer_stage_id": stage}})


def test_history_excludes_archive_and_future_events():
    project = SimpleNamespace(stage_scheme="customer")
    events = [event(1, "create"), event(11, "archive"), event(21, "restore"), event(25, "update", 2)]
    history = visits(project, events, datetime(2026, 1, 31, tzinfo=UTC))
    assert history[0].days == 14 and history[0].completed
    assert history[1].days == 6 and not history[1].completed
    past = visits(project, events, datetime(2026, 1, 10, tzinfo=UTC))
    assert len(past) == 1 and past[0].days == 9
    assert not past[0].completed
    assert visits(project, [], datetime(2026, 1, 31, tzinfo=UTC)) == []


def test_statistics_keep_all_modes_and_do_not_choose_arbitrary_mode():
    result = duration_statistics([1, 1, 3, 3, 10])
    assert result["avg_days"] == 3.6 and result["median_days"] == 3
    assert result["mode_days"] == [1, 3] and result["visits"] == 5
    assert duration_statistics([1, 2, 3])["mode_days"] == []
    assert duration_statistics([])["avg_days"] is None
    assert duration_statistics([2])["median_days"] == 2


def test_incomplete_history_is_not_used_in_stage_statistics():
    project = SimpleNamespace(stage_scheme="customer")
    history = visits(project, [event(2, "update"), event(5, "update", 2)], datetime(2026, 1, 7, tzinfo=UTC))
    assert history[0].days == 3 and not history[0].known_start and not history[0].completed
    assert history[1].known_start


def test_profit_and_latest_revenue_month_in_registry_and_reports(as_analyst, db):
    pid = as_analyst.post("/api/projects", json=customer_payload(db, name="Calculated profit")).json()["id"]
    statuses = {kind: db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == f"{kind}_status"))
                for kind in ["revenue", "cost"]}
    db.add_all([ProjectFinancialEntry(project_id=pid, kind=kind, year=2026, month=month,
                                     amount=Decimal(value), vat_included=False, status_id=statuses[kind])
                for kind, month, value in [("revenue", 1, "100"), ("revenue", 3, "50"), ("cost", 2, "40")]])
    db.commit()
    row = as_analyst.get(f"/api/projects/{pid}").json()
    assert Decimal(row["profit"]) == 110000 and row["last_revenue_month"] == "2026-03-01"
    for grain in ["project", "financial_entry"]:
        definition = {"grain": grain,
                      "columns": ["project.id", "project.revenue", "project.financial_costs", "project.profit"],
                      "filters": [{"field": "project.id", "operator": "eq", "value": pid}], "sort": []}
        response = as_analyst.post("/api/reports/preview", json={"definition": definition})
        assert response.status_code == 200, response.text
        page = as_analyst.get(f"/api/report-snapshots/{response.json()['snapshot_id']}").json()
        assert len(page["rows"]) == (1 if grain == "project" else 3)
        for item in page["rows"]:
            assert Decimal(item["project.revenue"]) == 150000
            assert Decimal(item["project.financial_costs"]) == 40000
            assert Decimal(item["project.profit"]) == 110000


def test_earliest_date_and_contract_change_are_not_revenue():
    project = SimpleNamespace(created_at=datetime(2026, 1, 1), customer_stage_id=1, archived_at=None)
    events = [event(1, "create"), SimpleNamespace(created_at=datetime(2026, 1, 2), action="update",
              payload={"before": {"amount": "100"}, "after": {"amount": "200"}})]
    found = project_changes(project, events, date.min, date(2026, 1, 31), {1: 1}, {1: "lead"})
    assert "revenue_up" not in found


def test_open_projects_include_new_stages_but_not_success(as_analyst, db):
    response = as_analyst.post("/api/projects", json=customer_payload(db, name="New open stage"))
    pid = response.json()["id"]
    opened = as_analyst.get("/api/projects", params={"open_only": True, "q": "New open stage"}).json()
    assert [p["id"] for p in opened["items"]] == [pid]
    success = db.scalar(select(ReferenceValue.id).where(ReferenceValue.category == "customer_stage",
                                                      ReferenceValue.code == "success"))
    as_analyst.put(f"/api/projects/{pid}", json=customer_payload(db, name="New open stage", customer_stage_id=success))
    assert as_analyst.get("/api/projects", params={"open_only": True, "q": "New open stage"}).json()["total"] == 0


def test_pipeline_uses_open_and_legacy_stage_filters(as_analyst, db):
    response = as_analyst.post("/api/projects", json=customer_payload(db, name="Pipeline selection"))
    assert response.status_code == 201
    params = {"q": "Pipeline selection", "open_only": True}
    assert as_analyst.get("/api/analytics/pipeline", params=params).json()["totals"]["count"] == 1
    params["stage"] = "proposal"
    assert as_analyst.get("/api/analytics/pipeline", params=params).json()["totals"]["count"] == 0


def test_registry_export_does_not_silently_truncate(as_analyst, monkeypatch):
    from app.api import projects
    monkeypatch.setattr(projects, "EXPORT_LIMIT", 2)
    response = as_analyst.get("/api/projects/export.xlsx")
    assert response.status_code == 422 and "Уточните фильтры" in response.json()["detail"]


def test_archived_analytics_obeys_card_access(client, db):
    login(client, db, "admin@example.com")
    pid = client.post("/api/projects", json=customer_payload(db, name="Archive scope")).json()["id"]
    assert client.post(f"/api/projects/{pid}/archive").status_code == 200
    login(client, db, "analyst@example.com")
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert pid not in {p["project_id"] for p in client.get("/api/analytics/failures").json()["items"]}
    changes = client.get("/api/analytics/changes", params={"date_from": "1900-01-01", "date_to": "2200-01-01"})
    assert pid not in {p["project_id"] for p in changes.json()["items"]}


def test_monthly_trend_is_stock_not_sum_of_daily_balances(as_analyst, db):
    before = as_analyst.get("/api/analytics/trend-monthly", params={"year": 2025, "months": [1, 2]}).json()
    as_analyst.post("/api/projects", json=customer_payload(db, name="Monthly stock", amount="1000",
                      start_date="2025-01-01", expected_close_date="2027-01-01"))
    after = as_analyst.get("/api/analytics/trend-monthly", params={"year": 2025, "months": [1, 2]}).json()
    assert [r["date"] for r in after["history"]] == ["2025-01-01", "2025-02-01"]
    assert [n["value"] - o["value"] for n, o in zip(after["history"], before["history"], strict=True)] == [1000, 1000]
    assert as_analyst.get("/api/analytics/trend-monthly", params={"year": 2025, "months": 13}).status_code == 422


def test_saved_report_survives_snapshot_cleanup_and_keeps_values(client, db):
    login(client, db, "admin@example.com")
    spec = {"grain": "project", "columns": ["project.id", "project.name"], "filters": [], "sort": []}
    preview = client.post("/api/reports/preview", json={"definition": spec}).json()
    saved = client.post("/api/report-archives", json={"snapshot_id": preview["snapshot_id"]})
    assert saved.status_code == 201, saved.text
    aid = saved.json()["id"]
    original = client.get(f"/api/report-archives/{aid}").json()
    assert original["rows"]
    project = db.get(Project, original["rows"][0]["project.id"])
    project.name = "Changed after saving"
    project.archived_at = datetime.now(UTC)
    db.delete(db.get(ReportSnapshot, preview["snapshot_id"]))
    db.commit()
    assert client.get(f"/api/report-archives/{aid}").json()["rows"] == original["rows"]
    assert client.get(f"/api/report-archives/{aid}/export").content.startswith(b"PK")
    login(client, db, "analyst@example.com")
    assert client.get(f"/api/report-archives/{aid}").status_code == 404


def workbook(stage, value=10):
    book = Workbook()
    sheet = book.active
    sheet.title = "Список проектов"
    sheet.append(["Клиент", "Описание проекта", "Этап", "Год реализации", "январь"])
    sheet.append(["Import customer", "Import project", stage, 2026, value])
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def test_import_preview_is_read_only_and_confirmation_is_idempotent(client, db):
    login(client, db, "admin@example.com")
    stage = db.scalar(select(ReferenceValue.name).where(ReferenceValue.category == "customer_stage"))
    before = len(db.scalars(select(Project.id)).all())
    preview = client.post("/api/project-imports/preview", params={"filename": "projects.xlsx", "header_row": 1},
                          content=workbook(stage))
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["errors"] == [] and data["rows"] == 1
    assert len(db.scalars(select(Project.id)).all()) == before
    first = client.post(f"/api/project-imports/{data['id']}/commit")
    assert first.status_code == 200, first.text
    assert first.json()["created"] == 1
    second = client.post(f"/api/project-imports/{data['id']}/commit")
    assert second.json() == first.json()
    assert len(db.scalars(select(Project.id)).all()) == before + 1
    assert client.get("/api/project-imports").json()["items"][0]["status"] == "completed"


def test_import_preserves_vat_and_allows_missing_inn_in_separate_files(client, db):
    login(client, db, "admin@example.com")
    stage = db.scalar(select(ReferenceValue.name).where(ReferenceValue.category == "customer_stage"))
    from openpyxl import load_workbook
    for index in [1, 2]:
        book = load_workbook(BytesIO(workbook(stage)))
        book.active.cell(2, 1, f"New importer client {index}")
        buffer = BytesIO()
        book.save(buffer)
        preview = client.post("/api/project-imports/preview",
                              params={"filename": "vat.xlsx", "header_row": 1, "vat_included": True},
                              content=buffer.getvalue())
        assert preview.status_code == 200, preview.text
        result = client.post(f"/api/project-imports/{preview.json()['id']}/commit")
        assert result.json()["created"] == 1, result.text
        project = db.get(Project, result.json()["items"][0]["project_id"])
        assert project.financial_entries[0].vat_included


def test_import_rejects_negative_finance_and_non_admin(client, db):
    login(client, db, "admin@example.com")
    stage = db.scalar(select(ReferenceValue.name).where(ReferenceValue.category == "customer_stage"))
    response = client.post("/api/project-imports/preview", params={"filename": "bad.xlsx", "header_row": 1},
                           content=workbook(stage, -1))
    data = response.json()
    assert data["status"] == "invalid" and data["errors"][0]["row"] == 2
    assert client.post(f"/api/project-imports/{data['id']}/commit").status_code == 422
    login(client, db, "analyst@example.com")
    assert client.get("/api/project-imports").status_code == 403
