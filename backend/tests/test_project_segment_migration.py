from decimal import Decimal

import pytest
from sqlalchemy import MetaData, Table, inspect, select, text
from sqlalchemy.exc import IntegrityError
from test_project_card_validation import card_migration  # noqa: F401

from alembic import command


def rows(engine, name):
    table = Table(name, MetaData(), autoload_with=engine)
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(select(table).order_by(*table.primary_key)).mappings()]


def test_segment_migration_preserves_data_and_guards_downgrade(card_migration):  # noqa: F811
    config, engine, _ = card_migration
    command.upgrade(config, "0012")
    metadata = MetaData()
    metadata.reflect(engine)
    projects = metadata.tables["projects"]
    clients = metadata.tables["clients"]
    segments = metadata.tables["segments"]
    references = metadata.tables["reference_values"]
    with engine.begin() as connection:
        old = dict(connection.execute(select(projects)).mappings().one())
        client_segment = connection.scalar(select(clients.c.segment_id).where(clients.c.id == 1))
        other_segment = connection.scalar(select(segments.c.id).where(segments.c.id != client_segment).limit(1))
        customer_stage = connection.scalar(select(references.c.id).where(references.c.category == "customer_stage"))
        status = connection.scalar(select(references.c.id).where(references.c.category == "revenue_status"))
        connection.execute(projects.insert().values(old | {
            "id": 2, "name": "Проект нового поколения", "stage_scheme": "customer", "stage": None,
            "customer_stage_id": customer_stage,
        }))
        connection.execute(metadata.tables["project_financial_entries"].insert().values(
            project_id=1, kind="revenue", year=2026, month=10, amount=Decimal("123.456"),
            vat_included=True, status_id=status,
        ))
        connection.execute(metadata.tables["audit_log"].insert().values(
            user_id=1, action="update", entity="project", entity_id=1,
            payload={"before": {"segment": "историческое значение"}, "after": {"stage": "lead"}},
        ))
    names = ("projects", "clients", "segments", "project_financial_entries", "audit_log")
    before = {name: rows(engine, name) for name in names}

    command.upgrade(config, "0013_expand")
    project = Table("projects", MetaData(), autoload_with=engine)
    columns = {c["name"]: c for c in inspect(engine).get_columns("projects")}
    assert columns["segment_id"]["nullable"] is True
    assert any(fk["constrained_columns"] == ["segment_id"] and fk["referred_table"] == "segments"
               for fk in inspect(engine).get_foreign_keys("projects"))
    assert rows(engine, "projects") == [row | {"segment_id": None} for row in before["projects"]]
    with engine.begin() as connection:
        # Independent values already written during rollout must survive backfill.
        connection.execute(project.update().where(project.c.id == 2).values(segment_id=other_segment))
        # This insert deliberately mimics an older application without the new column.
        connection.execute(project.insert().values(old | {"id": 3, "name": "Старая версия API"}))
    command.upgrade(config, "0013_backfill")
    upgraded = rows(engine, "projects")
    assert [row["segment_id"] for row in upgraded] == [client_segment, other_segment, client_segment]
    assert [{k: v for k, v in row.items() if k != "segment_id"} for row in upgraded[:2]] == before["projects"]
    for name in names[1:]:
        assert rows(engine, name) == before[name]

    # Downgrading only the data revision must not clear independent values.
    command.downgrade(config, "0013_expand")
    assert rows(engine, "projects") == upgraded
    with pytest.raises(RuntimeError, match="сегмент проекта отличается.*проект id=2"):
        command.downgrade(config, "0012")
    assert rows(engine, "projects") == upgraded
    for name in names[1:]:
        assert rows(engine, name) == before[name]
    with engine.begin() as connection:
        connection.execute(project.update().where(project.c.id == 2).values(segment_id=client_segment))
        # NULL rows created by old code remain safe to roll back.
        connection.execute(project.update().where(project.c.id == 3).values(segment_id=None))
    command.downgrade(config, "0012")
    assert rows(engine, "projects") == before["projects"] + [old | {"id": 3, "name": "Старая версия API"}]
    for name in names[1:]:
        assert rows(engine, name) == before[name]
    command.upgrade(config, "head")
    assert [row["segment_id"] for row in rows(engine, "projects")] == [client_segment] * 3
    command.check(config)


def test_segment_foreign_key_rejects_invalid_value(card_migration):  # noqa: F811
    config, engine, _ = card_migration
    command.upgrade(config, "head")
    with engine.connect() as connection:
        if connection.dialect.name == "sqlite":
            connection.execute(text("PRAGMA foreign_keys=ON"))
            assert connection.scalar(text("PRAGMA foreign_keys")) == 1
        with pytest.raises(IntegrityError):
            connection.execute(text("UPDATE projects SET segment_id = -123456 WHERE id = 1"))
        connection.rollback()
    assert rows(engine, "projects")[0]["segment_id"] is not None


def test_direct_downgrade_rejects_changed_client_segment(card_migration):  # noqa: F811
    config, engine, _ = card_migration
    command.upgrade(config, "head")
    metadata = MetaData()
    metadata.reflect(engine)
    clients, segments = metadata.tables["clients"], metadata.tables["segments"]
    with engine.begin() as connection:
        initial = connection.scalar(select(clients.c.segment_id).where(clients.c.id == 1))
        other = connection.scalar(select(segments.c.id).where(segments.c.id != initial).limit(1))
        connection.execute(clients.update().where(clients.c.id == 1).values(segment_id=other))
    projects_before = rows(engine, "projects")
    with pytest.raises(RuntimeError, match="сегмент проекта отличается"):
        command.downgrade(config, "0012")
    assert rows(engine, "projects") == projects_before
    with engine.connect() as connection:
        # SQLite may persist the no-op backfill downgrade before the guard runs.
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) in {
            "0013_backfill", "0013_expand",
        }
    with engine.begin() as connection:
        connection.execute(clients.update().where(clients.c.id == 1).values(segment_id=initial))
    command.downgrade(config, "0012")
