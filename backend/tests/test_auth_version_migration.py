from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from alembic import command
from alembic.config import Config
from app.core.config import settings


def test_auth_version_migration_preserves_users_defaults_and_is_reversible(tmp_path, monkeypatch):
    backend = Path(__file__).parents[1]
    url = f"sqlite+pysqlite:///{(tmp_path / 'auth-version.db').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    command.upgrade(config, "0004")
    engine = create_engine(url)
    insert_user = text(
        "INSERT INTO users (email, full_name, role, password_hash, totp_enabled, is_active) "
        "VALUES (:email, 'Пользователь миграции', 'user', 'тестовый хеш', false, true)"
    )
    try:
        with engine.begin() as connection:
            connection.execute(insert_user, {"email": "existing@example.test"})
        command.upgrade(config, "0005")
        with engine.begin() as connection:
            column = next(c for c in inspect(connection).get_columns("users") if c["name"] == "auth_version")
            assert column["nullable"] is False
            assert column["default"] is not None
            assert connection.scalar(text("SELECT auth_version FROM users")) == 0
            connection.execute(insert_user, {"email": "new@example.test"})
            assert connection.execute(text("SELECT auth_version FROM users ORDER BY id")).scalars().all() == [0, 0]
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(text("UPDATE users SET auth_version = NULL WHERE id = 1"))
            connection.execute(text("UPDATE users SET auth_version = 2 WHERE id = 1"))
        command.downgrade(config, "0004")
        with engine.connect() as connection:
            assert "auth_version" not in {c["name"] for c in inspect(connection).get_columns("users")}
            assert connection.execute(text("SELECT email FROM users ORDER BY id")).scalars().all() == [
                "existing@example.test", "new@example.test",
            ]
        command.upgrade(config, "0005")
        command.check(config)
    finally:
        engine.dispose()
