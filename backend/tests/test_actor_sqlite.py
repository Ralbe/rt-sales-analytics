"""Проверка блокировки роли при локальном запуске на SQLite."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, update
from sqlalchemy.orm import Session

from app.deps import lock_actor
from app.models import Role, User


def test_sqlite_role_lock_serializes_revocation(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{(tmp_path / 'actor.db').as_posix()}")
    User.__table__.create(engine)
    try:
        with Session(engine) as db:
            db.add(User(id=1, email="actor@example.test", full_name="Тест", role=Role.admin, password_hash="unused"))
            db.commit()
        started = Event()

        def revoke():
            with Session(engine) as db:
                started.set()
                db.execute(update(User).where(User.id == 1).values(is_active=False, auth_version=1))
                db.commit()

        with Session(engine) as active, ThreadPoolExecutor(max_workers=1) as pool:
            actor = active.get(User, 1)
            lock_actor(active, actor, roles={Role.admin})
            future = pool.submit(revoke)
            assert started.wait(5)
            try:
                with pytest.raises(TimeoutError):
                    future.result(timeout=0.2)
            finally:
                active.commit()
            future.result(timeout=5)

        with Session(engine) as queued, Session(engine) as revoking:
            revoking.execute(update(User).where(User.id == 1).values(is_active=True, auth_version=1))
            revoking.commit()
            stale_actor = queued.get(User, 1)
            revoking.execute(update(User).where(User.id == 1).values(is_active=False, auth_version=2))
            revoking.commit()
            with pytest.raises(HTTPException) as error:
                lock_actor(queued, stale_actor, roles={Role.admin})
            assert error.value.status_code == 401
    finally:
        engine.dispose()
