import os
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import MetaData, Table, Text, create_engine, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from test_projects import _payload

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.models import Project

TEXT_FIELDS = ("project_status", "realized_work", "period_plan")


@pytest.mark.parametrize("field", TEXT_FIELDS)
@pytest.mark.parametrize("length", [0, 999, 1000, 1001])
@pytest.mark.parametrize("character", ["Я", "🚀"])
@pytest.mark.parametrize("editing", [False, True], ids=["create", "update"])
def test_project_text_boundaries(as_user, db, field, length, character, editing):
    payload = _payload(db)
    path = "/api/projects"
    original = None
    if editing:
        created = as_user.post(path, json=payload)
        assert created.status_code == 201, created.text
        original = created.json()
        path += f"/{original['id']}"
    count = db.scalar(select(func.count()).select_from(Project))
    value = character * length
    response = (as_user.put if editing else as_user.post)(path, json=payload | {field: value})
    if length > 1000:
        assert response.status_code == 422, response.text
        assert any(error["loc"] == ["body", field] for error in response.json()["detail"])
        assert db.scalar(select(func.count()).select_from(Project)) == count
        if editing:
            assert as_user.get(path).json() == original
    else:
        assert response.status_code == (200 if editing else 201), response.text
        saved = response.json()
        assert saved[field] == value
        assert as_user.get(f"/api/projects/{saved['id']}").json()[field] == value
        assert getattr(db.get(Project, saved["id"]), field) == value


def test_optional_texts_and_single_integer_implementation_year(as_user, db):
    response = as_user.post("/api/projects", json=_payload(db, implementation_year=2027))
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["project_status"] is None
    assert saved["realized_work"] == saved["period_plan"] == ""
    assert saved["implementation_year"] == 2027
    assert isinstance(saved["implementation_year"], int)


@pytest.mark.parametrize("year", [2027.5, "2027-01-01", "2027–2028", [2027, 2028], 1899, 2201])
def test_implementation_year_rejects_dates_ranges_and_fractions(as_user, db, year):
    response = as_user.post("/api/projects", json=_payload(db, implementation_year=year))
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "implementation_year"]


def test_created_at_is_server_assigned_and_immutable_on_repeated_updates(as_user, db):
    before = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    supplied = "2000-01-01T00:00:00Z"
    response = as_user.post("/api/projects", json=_payload(db, created_at=supplied))
    assert response.status_code == 201, response.text
    saved = response.json()
    created_at = saved["created_at"]
    actual = datetime.fromisoformat(created_at).replace(tzinfo=None)
    assert before <= actual <= datetime.now(UTC).replace(tzinfo=None)
    for status in ["Первое изменение", "Второе изменение"]:
        response = as_user.put(
            f"/api/projects/{saved['id']}",
            json=_payload(db, created_at=supplied, project_status=status),
        )
        assert response.status_code == 200, response.text
        assert response.json()["created_at"] == created_at
        assert response.json()["project_status"] == status
    db.refresh(db.get(Project, saved["id"]))
    assert db.get(Project, saved["id"]).created_at.replace(tzinfo=None) == actual


@pytest.mark.parametrize("field", ["assessment_status_id", "industry_manager", "industry_project_number"])
@pytest.mark.parametrize("editing", [False, True], ids=["create", "update"])
def test_dependent_fields_reject_missing_parent_flag_without_changing_card(as_user, db, field, editing):
    refs = as_user.get("/api/refs").json()
    payload = _payload(db)
    path = "/api/projects"
    original = None
    if editing:
        original = as_user.post(path, json=payload).json()
        path += f"/{original['id']}"
    value = refs["assessment_statuses"][0]["id"] if field == "assessment_status_id" else "Отраслевой проект"
    response = (as_user.put if editing else as_user.post)(path, json=payload | {field: value})
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"] == ["body"]
    if editing:
        assert as_user.get(path).json() == original


def test_dependent_fields_roundtrip_and_can_be_cleared_with_parent_flags(as_user, db):
    refs = as_user.get("/api/refs").json()
    assessment_id = refs["assessment_statuses"][0]["id"]
    payload = _payload(
        db, accepted_for_forecast=True, assessment_status_id=assessment_id,
        is_industry_solution=True, industry_manager="Иван Петров", industry_project_number="IND-42",
    )
    response = as_user.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["assessment_status"]["id"] == assessment_id
    assert saved["industry_manager"] == "Иван Петров"
    assert saved["industry_project_number"] == "IND-42"
    response = as_user.put(f"/api/projects/{saved['id']}", json=_payload(db))
    assert response.status_code == 200, response.text
    cleared = response.json()
    assert not cleared["accepted_for_forecast"] and not cleared["is_industry_solution"]
    assert cleared["assessment_status"] is cleared["industry_manager"] is cleared["industry_project_number"] is None


@pytest.fixture(params=["sqlite", "postgresql"])
def card_migration(request, tmp_path, monkeypatch):
    backend = Path(__file__).parents[1]
    control = None
    schema = None
    if request.param == "postgresql":
        postgres_url = os.environ.get("TEST_POSTGRES_URL")
        if not postgres_url:
            pytest.skip("Для проверки миграции на PostgreSQL задайте TEST_POSTGRES_URL")
        schema = f"test_card_{uuid4().hex}"
        control = create_engine(postgres_url)
        with control.begin() as connection:
            connection.execute(CreateSchema(schema))
        url = make_url(postgres_url).update_query_dict({"options": f"-csearch_path={schema} -clock_timeout=5000"})
    else:
        url = f"sqlite+pysqlite:///{(tmp_path / 'project-card.db').as_posix()}"
    monkeypatch.setattr(settings, "database_url", str(url) if isinstance(url, str) else url.render_as_string(False))
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    engine = create_engine(url)
    try:
        command.upgrade(config, "0005")
        metadata = MetaData()
        metadata.reflect(engine)
        with engine.begin() as connection:
            connection.execute(metadata.tables["users"].insert().values(
                id=1, email="migration@example.test", full_name="Проверка миграции", role="user",
                password_hash="тестовый хеш", totp_enabled=False, is_active=True,
            ))
            segment_id = connection.scalar(select(metadata.tables["segments"].c.id).limit(1))
            service_id = connection.scalar(select(metadata.tables["services"].c.id).limit(1))
            connection.execute(metadata.tables["clients"].insert().values(
                id=1, name="Клиент миграции", inn="7707083893", segment_id=segment_id,
            ))
            projects = metadata.tables["projects"]
            connection.execute(projects.insert().values(
                id=1, name="Карточка до миграции", description="Исходные данные", client_id=1, manager_id=1,
                service_id=service_id, stage="lead", amount=100, cost=10, probability=10,
                start_date=date(2026, 10, 1), expected_close_date=date(2026, 12, 1),
                project_status="Я" * 100, realized_work="Работа" * 400, period_plan="П" * 5000,
            ))
            before = dict(connection.execute(select(projects)).mappings().one())
        yield config, engine, before
    finally:
        engine.dispose()
        if control is not None:
            try:
                with control.begin() as connection:
                    connection.execute(DropSchema(schema, cascade=True))
            finally:
                control.dispose()


def _migration_snapshot(engine):
    with engine.connect() as connection:
        projects = Table("projects", MetaData(), autoload_with=connection)
        row = dict(connection.execute(select(projects)).mappings().one())
        columns = {column["name"]: column for column in inspect(connection).get_columns("projects")}
        revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
    return row, columns, revision


def test_card_migration_preserves_legacy_texts_and_is_reversible(card_migration):
    config, engine, before = card_migration
    command.upgrade(config, "0006")
    row, columns, revision = _migration_snapshot(engine)
    assert revision == "0006"
    assert row == before
    assert columns["project_status"]["type"].length == 1000
    assert columns["project_status"]["nullable"] is True
    assert all(isinstance(columns[field]["type"], Text) for field in ["realized_work", "period_plan"])
    command.downgrade(config, "0005")
    row, columns, revision = _migration_snapshot(engine)
    assert row == before
    assert revision == "0005"
    assert columns["project_status"]["type"].length == 100
    command.upgrade(config, "0006")
    assert _migration_snapshot(engine)[0] == before
    command.upgrade(config, "head")
    command.check(config)


@pytest.mark.parametrize("length", [101, 1000])
def test_card_migration_refuses_unsafe_downgrade_without_losing_data(card_migration, length):
    config, engine, before = card_migration
    command.upgrade(config, "0006")
    value = "🚀" * length
    with engine.begin() as connection:
        connection.execute(text("UPDATE projects SET project_status = :value"), {"value": value})
    with pytest.raises(RuntimeError, match="project_status.*100"):
        command.downgrade(config, "0005")
    row, columns, revision = _migration_snapshot(engine)
    assert row == before | {"project_status": value}
    assert columns["project_status"]["type"].length == 1000
    assert revision == "0006"


def test_existing_long_texts_remain_readable_and_rejected_update_does_not_truncate(as_user, db):
    response = as_user.post("/api/projects", json=_payload(db))
    assert response.status_code == 201
    saved = response.json()
    project = db.get(Project, saved["id"])
    project.realized_work = "Р" * 2000
    project.period_plan = "П" * 5000
    db.commit()
    path = f"/api/projects/{saved['id']}"
    original = as_user.get(path).json()
    response = as_user.put(
        path, json=_payload(db, realized_work=project.realized_work, period_plan=project.period_plan),
    )
    assert response.status_code == 422
    assert as_user.get(path).json() == original
