import pytest
from sqlalchemy import MetaData, Table, inspect, select
from test_project_card_validation import card_migration  # noqa: F401

from alembic import command


def rows(engine, name):
    table = Table(name, MetaData(), autoload_with=engine)
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(select(table).order_by(*table.primary_key)).mappings()]


@pytest.mark.parametrize("inactive_category", ["segments", "services"])
def test_activity_migration_preserves_links_and_blocks_lossy_downgrade(card_migration, inactive_category):  # noqa: F811
    config, engine, _ = card_migration
    command.upgrade(config, "0009")
    names = ("segments", "services", "clients", "projects", "audit_log")
    before = {name: rows(engine, name) for name in names}
    command.upgrade(config, "0010")
    for name in names:
        expected = (
            [dict(row, is_active=True) for row in before[name]] if name in {"segments", "services"} else before[name]
        )
        assert rows(engine, name) == expected
    for name in ("segments", "services"):
        columns = {column["name"]: column for column in inspect(engine).get_columns(name)}
        assert columns["is_active"]["nullable"] is False
    selected = Table(inactive_category, MetaData(), autoload_with=engine)
    with engine.begin() as connection:
        connection.execute(
            selected.update().where(selected.c.id == before[inactive_category][0]["id"]).values(is_active=False)
        )
    with pytest.raises(RuntimeError, match="неактивные"):
        command.downgrade(config, "0009")
    assert any(not row["is_active"] for row in rows(engine, inactive_category))
    with engine.begin() as connection:
        connection.execute(selected.update().values(is_active=True))
    command.downgrade(config, "0009")
    assert {name: rows(engine, name) for name in names} == before
    command.upgrade(config, "head")
    command.check(config)
