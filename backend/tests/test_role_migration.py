import runpy
from pathlib import Path

from sqlalchemy import create_engine, text

from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_role_migration_maps_existing_roles():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / "0002_align_roles_with_spec.py"
    migration = runpy.run_path(str(migration_path))
    engine = create_engine("sqlite+pysqlite://")

    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, role VARCHAR(20) NOT NULL)"))
        connection.execute(
            text("INSERT INTO users (id, role) VALUES (1, 'manager'), (2, 'head'), (3, 'analyst'), (4, 'admin')")
        )
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration["upgrade"]()

        roles = dict(connection.execute(text("SELECT id, role FROM users")).all())

    assert roles == {1: "user", 2: "admin", 3: "analyst", 4: "admin"}
