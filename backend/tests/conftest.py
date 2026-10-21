import os

os.environ["REDIS_URL"] = ""  # тесты без кэша
os.environ["DATABASE_URL"] = "sqlite+pysqlite://"

from collections.abc import Iterator  # noqa: E402
from datetime import date  # noqa: E402

import pyotp  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, event, select  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402
from app.seed import DEMO_PASSWORD, seed  # noqa: E402

TODAY = date(2026, 10, 21)


@pytest.fixture(scope="session")
def engine():
    engine = create_engine("sqlite+pysqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    # pysqlite сам управляет транзакциями и ломает SAVEPOINT — отдаём управление SQLAlchemy
    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection, _):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin(connection):
        connection.exec_driver_sql("BEGIN")

    Base.metadata.create_all(engine)
    with Session(engine) as db:
        seed(db, today=TODAY, projects_count=300)
    return engine


@pytest.fixture
def db(engine) -> Iterator[Session]:
    # Каждый тест — в транзакции, которая откатывается в конце
    connection = engine.connect()
    tx = connection.begin()
    session = sessionmaker(bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False)()
    yield session
    session.close()
    tx.rollback()
    connection.close()


@pytest.fixture
def client(db: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def login(client: TestClient, db: Session, email: str) -> User:
    r = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    token = r.json()["mfa_token"]
    user = db.scalar(select(User).where(User.email == email))
    r = client.post("/api/auth/2fa", json={"mfa_token": token, "code": pyotp.TOTP(user.totp_secret).now()})
    assert r.status_code == 200, r.text
    return user


@pytest.fixture
def as_analyst(client, db) -> TestClient:
    login(client, db, "analyst@example.com")
    return client


@pytest.fixture
def as_manager(client, db) -> TestClient:
    login(client, db, "manager1@example.com")
    return client
