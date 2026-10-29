from copy import deepcopy
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import AuditLog, Client, Project, ProjectFieldLabel, Segment, Service, Stage, User
from app.seed import seed
from app.services.analytics import Filters, breakdown, load_frame
from app.services.project_history import project_snapshot


@pytest.fixture(scope="module")
def engine():
    """Use an isolated PostgreSQL schema when requested; otherwise run on SQLite."""
    import os

    url = os.environ.get("TEST_POSTGRES_URL")
    control = None
    schema = None
    if url:
        schema = "test_segment_" + uuid4().hex
        control = create_engine(url, isolation_level="AUTOCOMMIT", hide_parameters=True)
        with control.connect() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"}, hide_parameters=True)
    else:
        engine = create_engine("sqlite+pysqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

        @event.listens_for(engine, "connect")
        def connect(dbapi_connection, _):
            dbapi_connection.isolation_level = None

        @event.listens_for(engine, "begin")
        def begin(connection):
            connection.exec_driver_sql("BEGIN")

    try:
        if url:
            from alembic import command
            from alembic.config import Config
            from app.core.config import settings

            backend = Path(__file__).resolve().parents[1]
            config = Config(str(backend / "alembic.ini"))
            config.set_main_option("script_location", str(backend / "alembic"))
            schema_url = make_url(url).update_query_dict({"options": f"-csearch_path={schema}"})
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(settings, "database_url", schema_url.render_as_string(hide_password=False))
                command.upgrade(config, "head")
        else:
            Base.metadata.create_all(engine)
        with Session(engine) as db:
            seed(db, today=date(2026, 10, 21), projects_count=30)
        yield engine
    finally:
        engine.dispose()
        if control is not None:
            with control.connect() as connection:
                connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
            control.dispose()


@pytest.fixture
def segment_projects(db):
    first, second = Segment(name="Тест сегмента А"), Segment(name="Тест сегмента Б")
    db.add_all([first, second])
    db.flush()
    client = Client(name="Клиент сегментов", inn="981234567890", segment_id=first.id)
    db.add(client)
    db.flush()
    manager = db.scalar(select(User).where(User.email == "manager1@example.com"))
    other = db.scalar(select(User).where(User.email == "manager2@example.com"))
    service_id = db.scalar(select(Service.id).limit(1))

    def project(name, owner, segment, *, customer=False):
        values = dict(
            name=name, client_id=client.id, manager_id=owner.id, service_id=service_id,
            segment_id=segment, amount=100, cost=0, probability=50,
            start_date=date(2026, 1, 1), expected_close_date=date(2026, 12, 31),
            stage_scheme="customer" if customer else "legacy", stage=None if customer else Stage.proposal,
        )
        if customer:
            from app.models import ReferenceValue

            values["customer_stage_id"] = db.scalar(
                select(ReferenceValue.id).where(ReferenceValue.category == "customer_stage").limit(1)
            )
        return Project(**values)

    projects = [project("Первый", manager, first.id), project("Второй", manager, second.id),
                project("Старый клиент", manager, None), project("Чужой", other, second.id),
                project("Новая схема", manager, second.id, customer=True)]
    db.add_all(projects)
    db.flush()
    return first, second, projects


def _definition(client_id, segment_id=None):
    filters = [{"field": "client.id", "operator": "eq", "value": client_id}]
    if segment_id is not None:
        filters.append({"field": "segment.id", "operator": "eq", "value": segment_id})
    return {"grain": "project", "columns": ["project.id", "segment.id", "segment.name"],
            "filters": filters, "sort": [{"field": "project.id", "direction": "asc"}]}


def _preview(client, definition):
    response = client.post("/api/reports/preview", json={"definition": definition})
    assert response.status_code == 200, response.text
    snapshot = client.get(f"/api/report-snapshots/{response.json()['snapshot_id']}")
    assert snapshot.status_code == 200, snapshot.text
    return snapshot.json()


def test_report_project_segments_filter_and_immutable_snapshot(as_analyst, db, segment_projects):
    first, second, projects = segment_projects
    snapshot = _preview(as_analyst, _definition(projects[0].client_id))
    rows = {row["project.id"]: (row["segment.id"], row["segment.name"]) for row in snapshot["rows"]}
    assert rows == {projects[0].id: (first.id, first.name), projects[1].id: (second.id, second.name),
                    projects[2].id: (first.id, first.name), projects[3].id: (second.id, second.name),
                    projects[4].id: (second.id, second.name)}
    filtered = _preview(as_analyst, _definition(projects[0].client_id, second.id))
    assert {row["project.id"] for row in filtered["rows"]} == {p.id for p in (projects[1], projects[3], projects[4])}
    projects[1].segment_id = first.id
    second.name = "Сегмент переименован"
    db.flush()
    saved = as_analyst.get(f"/api/report-snapshots/{snapshot['snapshot_id']}").json()
    assert saved["rows"] == snapshot["rows"]


def test_analytics_project_segments_fallback_legacy_scope_and_user_rbac(as_user, db, segment_projects):
    first, second, projects = segment_projects
    manager_id = projects[0].manager_id
    frame = load_frame(db, Filters(scope_manager_id=manager_id))
    ids = set(frame.id)
    assert {p.id for p in projects[:3]} <= ids
    assert projects[3].id not in ids and projects[4].id not in ids
    assert dict(zip(frame.id, frame.segment_id, strict=True))[projects[2].id] == first.id
    selected = load_frame(db, Filters(segment_ids=(second.id,), scope_manager_id=manager_id))
    assert projects[1].id in set(selected.id)
    assert all(p.id not in set(selected.id) for p in (projects[0], projects[2], projects[3], projects[4]))
    items = breakdown(db, Filters(segment_ids=(first.id, second.id), scope_manager_id=manager_id),
                      date(2026, 10, 21), "segment", "projects")
    assert {item["key"]: item["value"] for item in items["items"]} == {str(first.id): 2, str(second.id): 1}
    response = as_user.get("/api/analytics/breakdown", params={"segment_id": second.id, "as_of": "2026-10-21",
                                                             "group_by": "segment", "metric": "projects"})
    assert response.status_code == 200
    assert response.json()["items"] == [{"key": str(second.id), "label": second.name, "value": 1.0}]


def test_report_query_respects_user_rbac(db, segment_projects):
    from app.report_schemas import Definition
    from app.services.report_builder import query

    _, _, projects = segment_projects
    user = db.get(User, projects[0].manager_id)
    rows = db.execute(query(Definition.model_validate(_definition(projects[0].client_id)), user)).all()
    assert {row[0] for row in rows} == {p.id for p in projects if p.manager_id == user.id}


def test_history_freezes_segment_names_and_custom_label(as_user, db, segment_projects):
    first, second, projects = segment_projects
    project = projects[2]
    db.add(ProjectFieldLabel(key="segment", label="Направление"))
    db.flush()
    before = project_snapshot(db, project)
    assert before["segment_id"] == first.id and before["_labels"]["segment_id"] == first.name
    project.segment_id = second.id
    after = project_snapshot(db, project)
    log = AuditLog(entity="project", entity_id=project.id, action="update", payload={"before": before, "after": after})
    old = AuditLog(entity="project", entity_id=project.id, action="update", payload={"after": {"name": "Старый"}})
    db.add_all([old, log])
    db.flush()
    original = deepcopy(log.payload)
    first.name, second.name = "Новое имя А", "Новое имя Б"
    db.get(ProjectFieldLabel, "segment").label = "Новое название поля"
    db.flush()
    response = as_user.get(f"/api/projects/{project.id}/history")
    assert response.status_code == 200
    change = response.json()["items"][0]["changes"]
    assert change == [{"field": "segment_id", "label": "Направление", "before": "Тест сегмента А",
                       "after": "Тест сегмента Б"}]
    assert db.get(AuditLog, log.id).payload == original
    assert db.get(AuditLog, old.id).payload == {"after": {"name": "Старый"}}
    assert as_user.get(f"/api/projects/{projects[3].id}/history").status_code == 404


def test_segment_update_records_history_and_invalidates_cache(as_user, db, segment_projects, monkeypatch):
    from project_factories import customer_payload

    from app.core import cache

    first, second, projects = segment_projects
    project = projects[4]
    db.add(ProjectFieldLabel(key="segment", label="Направление"))
    db.flush()
    bumped = []
    monkeypatch.setattr(cache, "bump", bumped.append)
    data = customer_payload(db, name=project.name, client_id=project.client_id, service_id=project.service_id,
                            segment_id=first.id)
    response = as_user.put(f"/api/projects/{project.id}", json=data)
    assert response.status_code == 200, response.text
    assert "analytics" in bumped
    log = db.scalar(select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == project.id,
                                          AuditLog.action == "update").order_by(AuditLog.id.desc()))
    assert log.payload["before"]["segment_id"] == second.id
    assert log.payload["after"]["segment_id"] == first.id
    assert log.payload["before"]["_labels"]["segment_id"] == second.name
    assert log.payload["after"]["_labels"]["segment_id"] == first.name
    first.name, second.name = "Переименован А", "Переименован Б"
    db.get(ProjectFieldLabel, "segment").label = "Новая подпись"
    db.flush()
    history = as_user.get(f"/api/projects/{project.id}/history").json()
    change = next(row for row in history["items"][0]["changes"] if row["field"] == "segment_id")
    assert change == {"field": "segment_id", "label": "Направление", "before": "Тест сегмента Б",
                      "after": "Тест сегмента А"}
