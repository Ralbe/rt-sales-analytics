from decimal import Decimal

import pytest
from sqlalchemy import MetaData, Table, inspect, select, text
from sqlalchemy.exc import IntegrityError
from test_project_card_validation import card_migration  # noqa: F401 — изолированные SQLite и PostgreSQL

from alembic import command


def _rows(engine, name):
    table = Table(name, MetaData(), autoload_with=engine)
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(select(table).order_by(*table.primary_key)).mappings()]


def test_stage_upgrade_preserves_all_old_fields_and_blocks_lossy_downgrade(card_migration):  # noqa: F811
    config, engine, _ = card_migration
    command.upgrade(config, "0008")
    metadata = MetaData()
    metadata.reflect(engine)
    projects = metadata.tables["projects"]
    references = metadata.tables["reference_values"]
    with engine.begin() as connection:
        customer_id = connection.scalar(select(references.c.id).where(references.c.category == "customer_stage"))
        status_id = connection.scalar(select(references.c.id).where(references.c.category == "revenue_status"))
        # Даже существование обеих систем этапов не переводит старую запись в customer.
        connection.execute(projects.update().values(customer_stage_id=customer_id, probability=37))
        connection.execute(metadata.tables["project_financial_entries"].insert().values(
            project_id=1, kind="revenue", year=2026, month=10, amount=Decimal("123.456"),
            vat_included=True, status_id=status_id,
        ))
        connection.execute(metadata.tables["audit_log"].insert().values(
            user_id=1, action="update", entity="project", entity_id=1,
            payload={"before": {"stage": "proposal"}, "after": {"stage": "lead", "probability": 37}},
        ))
        connection.execute(metadata.tables["project_field_labels"].insert().values(key="name", label="Моя подпись"))
    names = ("projects", "project_financial_entries", "audit_log", "reference_values", "project_field_labels")
    before = {name: _rows(engine, name) for name in names}
    command.upgrade(config, "0009")
    assert _rows(engine, "projects") == [dict(row, stage_scheme="legacy") for row in before["projects"]]
    for name in names[1:]:
        assert _rows(engine, name) == before[name]
    columns = {column["name"]: column for column in inspect(engine).get_columns("projects")}
    assert columns["stage"]["nullable"] is True
    assert columns["stage_scheme"]["nullable"] is False
    assert "customer" in columns["stage_scheme"]["default"]
    table = Table("projects", MetaData(), autoload_with=engine)
    base = {key: value for key, value in before["projects"][0].items() if key != "id"}
    invalid = [
        {"stage_scheme": "legacy", "stage": None},
        {"stage_scheme": "customer", "stage": "lead"},
        {"stage_scheme": "customer", "stage": None, "customer_stage_id": None},
        {"stage_scheme": "other", "stage": "lead"},
        {"stage_scheme": None, "stage": "lead"},
    ]
    for index, fields in enumerate(invalid):
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(table.insert().values(base | {"name": f"Недопустимая строка {index}"} | fields))
    with engine.begin() as connection:
        connection.execute(table.insert().values(base | {"name": "Новый проект", "stage": None}))
    upgraded_rows = _rows(engine, "projects")
    assert upgraded_rows[-1]["stage_scheme"] == "customer"
    assert upgraded_rows[-1]["stage"] is None
    with pytest.raises(RuntimeError, match="существуют проекты с новыми этапами"):
        command.downgrade(config, "0008")
    assert _rows(engine, "projects") == upgraded_rows
    with engine.begin() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0009"
        connection.execute(table.delete().where(table.c.stage_scheme == "customer"))
    command.downgrade(config, "0008")
    assert _rows(engine, "projects") == before["projects"]
    for name in names[1:]:
        assert _rows(engine, name) == before[name]
    restored = {column["name"]: column for column in inspect(engine).get_columns("projects")}
    assert restored["stage"]["nullable"] is False
    assert "stage_scheme" not in restored
    command.upgrade(config, "0009")
    assert _rows(engine, "projects") == [dict(row, stage_scheme="legacy") for row in before["projects"]]
