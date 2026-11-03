from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from conftest import login
from project_factories import customer_payload
from sqlalchemy import select

from app.models import AuditLog, Project, ProjectFinancialEntry, ReferenceValue, User
from app.services.project_timeline import build_intervals, stage_statistics

BASE = datetime(2026, 1, 1, tzinfo=UTC)


def snapshot(stage, *, customer=False, label=None):
    value = {"_stage_scheme": "customer", "customer_stage_id": stage} if customer else {"stage": stage}
    if label:
        value["_labels"] = {"customer_stage_id": label}
    return value


def log(number, day, before=None, after=None, action="update"):
    return AuditLog(
        id=number, action=action, created_at=BASE + timedelta(days=day),
        payload={"before": before, "after": after},
    )


def project(stage="proposal", **kwargs):
    return SimpleNamespace(stage_scheme="legacy", stage=stage, customer_stage_id=None, archived_at=None, **kwargs)


def build(record, rows, days=10):
    return build_intervals(record, rows, now=BASE + timedelta(days=days), reference_names={1: "Лид", 2: "КП"})


def test_no_history_does_not_invent_start_from_project_dates():
    intervals, _, complete = build(project(), [])
    assert intervals == []
    assert complete is False


def test_repeated_stage_visits_and_current_excluded_from_average():
    rows = [
        log(1, 0, after=snapshot("lead"), action="create"),
        log(2, 2, snapshot("lead"), snapshot("proposal")),
        log(3, 5, snapshot("proposal"), snapshot("lead")),
        log(4, 9, snapshot("lead"), snapshot("proposal")),
    ]
    intervals, _, complete = build(project(), rows)
    assert complete
    assert [row.duration_days for row in intervals] == [2, 3, 4, 1]
    assert intervals[-1].is_current
    stats = {row.stage_key: row for row in stage_statistics(intervals)}
    assert stats["legacy:lead"].completed_visits == 2
    assert stats["legacy:lead"].average_days == 3
    assert stats["legacy:proposal"].average_days == 3


def test_same_timestamp_events_order_by_id_and_keep_zero_duration():
    rows = [
        log(1, 0, after=snapshot("lead"), action="create"),
        log(3, 2, snapshot("proposal"), snapshot("lead")),
        log(2, 2, snapshot("lead"), snapshot("proposal")),
    ]
    intervals, _, _ = build(project("lead"), rows)
    assert [row.duration_days for row in intervals] == [2, 0, 8]
    assert stage_statistics(intervals)[1].average_days == 0


def test_archive_pause_excluded_and_interrupted_visit_not_averaged():
    rows = [
        log(1, 0, after=snapshot("lead"), action="create"),
        log(2, 2, action="archive"), log(3, 5, action="restore"),
        log(4, 9, snapshot("lead"), snapshot("proposal")),
    ]
    intervals, archives, complete = build(project(), rows)
    assert complete
    assert [row.duration_days for row in intervals] == [2, 4, 1]
    assert intervals[0].end_reason == "archive"
    assert intervals[1].start_known is False
    assert archives[0].ended_at - archives[0].started_at == timedelta(days=3)
    assert stage_statistics(intervals)[0].completed_visits == 0


def test_archived_project_does_not_extend_stage_until_now():
    record = project("lead")
    record.archived_at = BASE + timedelta(days=2)
    intervals, archives, _ = build(record, [
        log(1, 0, after=snapshot("lead"), action="create"), log(2, 2, action="archive"),
    ])
    assert intervals[0].duration_days == 2
    assert not intervals[0].is_current
    assert archives[0].ended_at == BASE + timedelta(days=10)


def test_first_snapshot_has_unknown_entry_but_next_transition_has_exact_entry():
    intervals, _, complete = build(project(), [
        log(1, 2, snapshot("lead"), snapshot("lead")),
        log(2, 4, snapshot("lead"), snapshot("proposal")),
    ])
    assert not complete
    assert intervals[0].started_at == BASE + timedelta(days=2)
    assert not intervals[0].start_known
    assert intervals[1].start_known
    assert stage_statistics(intervals)[0].average_days is None


def test_missing_transition_does_not_fill_gap_or_pollute_statistics():
    intervals, _, complete = build(project(), [
        log(1, 0, after=snapshot("lead"), action="create"),
        log(2, 1, snapshot("lead"), snapshot("lead")),
        log(3, 5, snapshot("qualification"), snapshot("proposal")),
    ])
    assert not complete
    assert intervals[0].end_reason == "unknown"
    assert intervals[0].ended_at == BASE + timedelta(days=1)
    assert intervals[1].started_at == BASE + timedelta(days=5)
    assert stage_statistics(intervals)[0].completed_visits == 0


def test_current_stage_mismatch_stops_at_last_observation():
    intervals, _, complete = build(project(), [log(1, 0, after=snapshot("lead"), action="create")])
    assert not complete
    assert intervals[0].ended_at == BASE
    assert intervals[0].end_reason == "unknown"


def test_transition_without_before_snapshot_does_not_invent_transition_date():
    intervals, _, complete = build(project(), [
        log(1, 0, after=snapshot("lead"), action="create"),
        log(2, 4, after=snapshot("proposal")),
    ])
    assert not complete
    assert intervals[0].ended_at == BASE
    assert intervals[0].end_reason == "unknown"
    assert not intervals[1].start_known
    assert all(row.average_days is None for row in stage_statistics(intervals))


def test_missing_restore_event_does_not_invent_archive_duration():
    intervals, archives, complete = build(project("lead"), [
        log(1, 0, after=snapshot("lead"), action="create"), log(2, 2, action="archive"),
    ])
    assert not complete
    assert len(intervals) == 1
    assert intervals[0].duration_days == 2
    assert archives == []


def test_customer_stage_labels_are_historical_and_future_events_ignored():
    record = project()
    record.stage_scheme, record.stage, record.customer_stage_id = "customer", None, 2
    intervals, _, complete = build(record, [
        log(1, 0, after=snapshot(1, customer=True, label="Прежний лид"), action="create"),
        log(2, 2, snapshot(1, customer=True), snapshot(2, customer=True, label="Старое КП")),
        log(3, 4, snapshot(2, customer=True), snapshot(2, customer=True, label="Новое имя")),
        log(4, 20, snapshot(2, customer=True), snapshot(1, customer=True)),
    ])
    assert complete
    assert [row.stage_label for row in intervals] == ["Прежний лид", "Старое КП"]


def test_timeline_and_statistics_require_auth(client, db):
    project_id = db.scalar(select(Project.id))
    assert client.get(f"/api/projects/{project_id}/timeline").status_code == 401
    assert client.get("/api/project-timeline/stage-statistics").status_code == 401


def test_user_visibility_and_portfolio_scope(as_user, db):
    me = db.scalar(select(User).where(User.email == "manager1@example.com"))
    hidden = db.scalar(select(Project).where(Project.manager_id != me.id))
    own = db.scalar(select(Project).where(Project.manager_id == me.id))
    assert as_user.get(f"/api/projects/{hidden.id}/timeline").status_code == 404
    own.archived_at = BASE
    db.flush()
    assert as_user.get(f"/api/projects/{own.id}/timeline").status_code == 404
    data = as_user.get("/api/project-timeline/stage-statistics").json()
    expected = len(db.scalars(select(Project.id).where(
        Project.manager_id == me.id, Project.archived_at.is_(None),
    )).all())
    assert data["project_count"] == expected
    assert data["projects_with_history"] == 0
    assert data["stage_statistics"] == []


@pytest.mark.parametrize("email,expected", [("admin@example.com", 200), ("analyst@example.com", 404)])
def test_archived_detail_visible_only_to_admin(client, db, email, expected):
    login(client, db, email)
    record = db.scalar(select(Project))
    record.archived_at = BASE
    db.flush()
    assert client.get(f"/api/projects/{record.id}/timeline").status_code == expected


def test_customer_api_full_creation_history_finance_and_portfolio(as_user, db):
    created = as_user.post("/api/projects", json=customer_payload(db))
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    db.add(ProjectFinancialEntry(
        project_id=project_id, kind="revenue", year=2026, month=10, amount=Decimal("12.345"),
        vat_included=True, status_id=db.scalar(select(ReferenceValue.id).where(
            ReferenceValue.category == "revenue_status",
        )),
    ))
    db.flush()
    response = as_user.get(f"/api/projects/{project_id}/timeline")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["history_complete"]
    assert data["intervals"][0]["stage_key"].startswith("customer:")
    assert data["intervals"][0]["is_current"]
    assert data["finances"][0]["amount"] == "12.345"
    assert data["finances"][0]["vat_included"] is True
    assert data["finances"][0]["status"]
    stats = as_user.get("/api/project-timeline/stage-statistics").json()
    assert stats["projects_with_history"] == 1
    assert stats["stage_statistics"][0]["completed_visits"] == 0
