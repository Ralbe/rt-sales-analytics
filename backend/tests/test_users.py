import json
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pyotp
import pytest
from conftest import login
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

from app.api import users
from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, create_token, hash_password, verify_password
from app.db import get_db
from app.main import app
from app.models import AuditLog, Role, User
from app.seed import DEMO_PASSWORD

PASSWORD = "Users-test-2026!"
PUBLIC_FIELDS = {"id", "email", "full_name", "role", "is_active", "created_at"}
AUDIT_FIELDS = {"email", "full_name", "role", "is_active"}


def payload(**overrides):
    return {
        "email": "new@example.test", "full_name": "Новый Пользователь", "role": "user", "password": PASSWORD,
    } | overrides


def update_payload(user, **overrides):
    return {
        "email": user.email, "full_name": user.full_name, "role": user.role.value, "is_active": user.is_active,
    } | overrides


@pytest.fixture
def admin(client, db):
    login(client, db, "admin@example.com")
    return client


def test_unauthenticated_users_api(client):
    assert client.get("/api/users").status_code == 401
    assert client.post("/api/users", json=payload()).status_code == 401
    assert client.put("/api/users/1", json=payload()).status_code == 401


@pytest.mark.parametrize("email", ["manager1@example.com", "analyst@example.com"])
def test_only_admin_can_manage_users(client, db, email):
    actor = login(client, db, email)
    assert client.get("/api/users").status_code == 403
    assert client.post("/api/users", json=payload()).status_code == 403
    assert client.put(f"/api/users/{actor.id}", json=update_payload(actor, role="admin")).status_code == 403
    assert actor.role != Role.admin


def test_list_pagination_search_and_disabled_users(admin, db):
    disabled = db.scalar(select(User).where(User.email == "manager2@example.com"))
    disabled.is_active = False
    db.commit()
    first = admin.get("/api/users", params={"size": 2}).json()
    second = admin.get("/api/users", params={"size": 2, "page": 2}).json()
    assert first["page"] == 1 and first["size"] == 2
    assert len(first["items"]) == len(second["items"]) == 2
    assert {u["id"] for u in first["items"]}.isdisjoint(u["id"] for u in second["items"])
    assert first["total"] == db.scalar(select(func.count(User.id)))
    assert all(set(u) == PUBLIC_FIELDS for u in first["items"])
    by_email = admin.get("/api/users", params={"q": " MANAGER2@EXAMPLE.COM "}).json()
    assert [u["id"] for u in by_email["items"]] == [disabled.id]
    assert by_email["items"][0]["is_active"] is False
    assert admin.get("/api/users", params={"q": disabled.full_name}).json()["total"] == 1
    assert admin.get("/api/users", params={"q": disabled.email, "include_inactive": False}).json()["total"] == 0
    assert admin.get("/api/users", params={"q": "%"}).json()["total"] == 0
    assert admin.get("/api/users", params={"q": "несуществующее имя"}).json()["items"] == []
    assert admin.get("/api/users", params={"page": 999}).json()["items"] == []


@pytest.mark.parametrize("params", [{"page": 0}, {"size": 0}, {"size": 101}, {"q": "я" * 256}])
def test_pagination_bounds(admin, params):
    response = admin.get("/api/users", params=params)
    assert response.status_code == 422
    assert "input" not in response.text


def test_create_normalizes_and_audits_only_public_fields(admin, db):
    response = admin.post("/api/users", json=payload(email=" NEW@Example.Test ", full_name="  Новый   Пользователь  "))
    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == PUBLIC_FIELDS
    assert body["email"] == "new@example.test"
    assert body["full_name"] == "Новый Пользователь"
    assert body["is_active"] is True
    user = db.get(User, body["id"])
    assert verify_password(PASSWORD, user.password_hash)
    assert not user.totp_enabled and user.totp_secret is None
    log = db.scalar(select(AuditLog).where(AuditLog.entity == "user", AuditLog.entity_id == user.id))
    assert log.action == "create"
    assert log.user_id == db.scalar(select(User.id).where(User.email == "admin@example.com"))
    assert set(log.payload) == AUDIT_FIELDS
    assert PASSWORD not in json.dumps(log.payload)
    assert user.password_hash not in response.text


def test_new_user_must_complete_existing_totp_setup(admin, client, db):
    user_id = admin.post("/api/users", json=payload()).json()["id"]
    client.post("/api/auth/logout")
    response = client.post("/api/auth/login", json={"email": "NEW@EXAMPLE.TEST", "password": PASSWORD})
    assert response.status_code == 200
    challenge = response.json()
    assert challenge["setup_required"] is True
    assert challenge["otpauth_uri"].startswith("otpauth://totp/")
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/users").status_code == 401
    user = db.get(User, user_id)
    result = client.post("/api/auth/2fa", json={
        "mfa_token": challenge["mfa_token"], "code": pyotp.TOTP(user.totp_secret).now(),
    })
    assert result.status_code == 200
    assert client.get("/api/auth/me").json()["id"] == user_id
    assert client.get("/api/users").status_code == 403
    assert user.totp_enabled


@pytest.mark.parametrize("overrides,field", [
    ({"email": "broken"}, "email"),
    ({"email": "a" * 65 + "@example.test"}, "email"),
    ({"email": "a@" + "b" * 244 + ".example.test"}, "email"),
    ({"full_name": " "}, "full_name"),
    ({"full_name": "я" * 201}, "full_name"),
    ({"role": "owner"}, "role"),
    ({"password": "short"}, "password"),
    ({"password": "я" * 37}, "password"),
    ({"totp_secret": "секрет"}, "totp_secret"),
    ({"password_hash": "хеш"}, "password_hash"),
    ({"is_active": False}, "is_active"),
])
def test_create_validation_never_echoes_password(admin, overrides, field):
    data = payload(**overrides)
    response = admin.post("/api/users", json=data)
    assert response.status_code == 422, response.text
    assert any(e["loc"][-1] == field for e in response.json()["detail"])
    assert data["password"] not in response.text
    assert "input" not in response.text and "ctx" not in response.text


def test_validation_of_nested_password_does_not_return_input(admin):
    response = admin.post("/api/users", json=payload(password={"secret": "не возвращать"}))
    assert response.status_code == 422
    assert "не возвращать" not in response.text
    assert "input" not in response.text


def test_case_insensitive_duplicates_on_create_and_update(admin, db):
    existing = db.scalar(select(User).where(User.email == "manager1@example.com"))
    existing.email = "Manager1@Example.com"
    db.commit()
    response = admin.post("/api/users", json=payload(email=" MANAGER1@example.com "))
    assert response.status_code == 409
    assert response.json()["detail"]["field"] == "email"
    other = db.scalar(select(User).where(User.email == "manager2@example.com"))
    response = admin.put(f"/api/users/{other.id}", json=update_payload(other, email="MANAGER1@EXAMPLE.COM"))
    assert response.status_code == 409
    assert other.email == "manager2@example.com"


def test_update_keeps_password_and_mfa_and_audits_public_changes(admin, db):
    user = db.scalar(select(User).where(User.email == "manager1@example.com"))
    user.totp_secret = pyotp.random_base32()
    user.totp_enabled = True
    db.commit()
    credentials = user.password_hash, user.totp_secret, user.totp_enabled
    before = update_payload(user)
    response = admin.put(f"/api/users/{user.id}", json=update_payload(
        user, email=" EDITED@Example.Test ", full_name="  Новое   Имя ", role="analyst", is_active=False,
    ))
    assert response.status_code == 200, response.text
    assert set(response.json()) == PUBLIC_FIELDS
    assert response.json()["full_name"] == "Новое Имя"
    assert response.json()["email"] == "edited@example.test"
    assert (user.password_hash, user.totp_secret, user.totp_enabled) == credentials
    log = db.scalar(select(AuditLog).where(
        AuditLog.entity == "user", AuditLog.entity_id == user.id, AuditLog.action == "update",
    ))
    assert log.payload["before"] == before
    assert log.payload["after"] == update_payload(user)
    assert set(log.payload["before"]) == set(log.payload["after"]) == AUDIT_FIELDS
    assert user.totp_secret not in json.dumps(log.payload)
    assert user.password_hash not in response.text


def test_cannot_change_password_or_mfa_on_update(admin, db):
    user = db.scalar(select(User).where(User.email == "manager1@example.com"))
    for field in ("password", "password_hash", "totp_secret", "totp_enabled"):
        response = admin.put(f"/api/users/{user.id}", json=update_payload(user) | {field: "скрытое значение"})
        assert response.status_code == 422
        assert "скрытое значение" not in response.text


def test_disable_revokes_existing_cookie_and_reactivation_preserves_mfa(admin, client, db):
    admin_cookie = client.cookies.get(ACCESS_COOKIE)
    target = login(client, db, "manager1@example.com")
    target_cookie = client.cookies.get(ACCESS_COOKIE)
    mfa_secret = target.totp_secret
    client.cookies.set(ACCESS_COOKIE, admin_cookie)
    assert admin.put(f"/api/users/{target.id}", json=update_payload(target, is_active=False)).status_code == 200
    assert target.id not in {u["id"] for u in client.get("/api/refs").json()["managers"]}
    client.cookies.set(ACCESS_COOKIE, target_cookie)
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/projects").status_code == 401
    assert client.post("/api/auth/login", json={"email": target.email, "password": DEMO_PASSWORD}).status_code == 401
    client.cookies.set(ACCESS_COOKIE, admin_cookie)
    assert admin.put(f"/api/users/{target.id}", json=update_payload(target, is_active=True)).status_code == 200
    assert target.totp_enabled and target.totp_secret == mfa_secret
    assert target.id in {u["id"] for u in client.get("/api/refs").json()["managers"]}


def test_cannot_disable_self(admin, db):
    actor = db.scalar(select(User).where(User.email == "admin@example.com"))
    response = admin.put(f"/api/users/{actor.id}", json=update_payload(actor, is_active=False))
    assert response.status_code == 409
    assert actor.is_active
    assert response.json()["detail"]["field"] == "is_active"


@pytest.mark.parametrize("other_active", [False, True])
def test_last_active_admin_cannot_demote_self(admin, db, other_active):
    actor = db.scalar(select(User).where(User.email == "admin@example.com"))
    others = db.scalars(select(User).where(User.role == Role.admin, User.id != actor.id)).all()
    for other in others:
        other.role = Role.user if other_active else Role.admin
        other.is_active = other_active
    db.commit()
    response = admin.put(f"/api/users/{actor.id}", json=update_payload(actor, role="user"))
    assert response.status_code == 409
    assert "активный администратор" in response.json()["detail"]["message"]
    assert actor.role == Role.admin


def test_self_demotion_is_allowed_with_another_admin_and_revokes_admin_access(admin, db):
    actor = db.scalar(select(User).where(User.email == "admin@example.com"))
    assert admin.put(f"/api/users/{actor.id}", json=update_payload(actor, role="analyst")).status_code == 200
    assert admin.get("/api/auth/me").json()["role"] == "analyst"
    assert admin.get("/api/users").status_code == 403
    assert admin.post("/api/users", json=payload()).status_code == 403


def test_missing_user_and_no_delete(admin):
    data = {"email": "missing@example.test", "full_name": "Нет", "role": "user", "is_active": True}
    assert admin.put("/api/users/999999", json=data).status_code == 404
    assert admin.delete("/api/users/1").status_code == 405


@pytest.fixture
def postgres_users():
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Для конкурентных проверок задайте TEST_POSTGRES_URL тестовой PostgreSQL")
    schema = f"test_users_{uuid4().hex}"
    control = create_engine(url)
    with control.begin() as connection:
        connection.execute(CreateSchema(schema))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema} -clock_timeout=5000"})
    try:
        User.__table__.create(engine)
        AuditLog.__table__.create(engine)
        with Session(engine) as session:
            password_hash = hash_password(PASSWORD)
            session.add_all([
                User(email=f"admin{i}@example.test", full_name=f"Администратор {i}", role=Role.admin,
                     password_hash=password_hash, is_active=True, totp_enabled=True)
                for i in (1, 2)
            ])
            session.commit()

        def get_test_db():
            with Session(engine, autoflush=False, expire_on_commit=False) as session:
                yield session

        app.dependency_overrides[get_db] = get_test_db
        yield engine
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
        with control.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        control.dispose()


@pytest.mark.parametrize("operation", ["demote_self", "disable_other", "duplicate_email"])
def test_postgres_concurrent_changes_preserve_admin_and_email_invariants(postgres_users, monkeypatch, operation):
    barrier = Barrier(2)
    original_lock = users._lock_users

    def synchronized_lock(db, actor):
        # Оба запроса уже прошли начальную проверку роли до ожидания блокировки.
        barrier.wait(timeout=10)
        original_lock(db, actor)

    monkeypatch.setattr(users, "_lock_users", synchronized_lock)

    def mutate(actor_id):
        with TestClient(app) as client:
            client.cookies.set(ACCESS_COOKIE, create_token(actor_id, SCOPE_ACCESS, 5))
            if operation == "duplicate_email":
                return client.post("/api/users", json=payload(email="SAME@example.test" if actor_id == 1
                                                             else "same@EXAMPLE.TEST")).status_code
            target_id = actor_id if operation == "demote_self" else 3 - actor_id
            data = {"email": f"admin{target_id}@example.test", "full_name": f"Администратор {target_id}",
                    "role": "user" if operation == "demote_self" else "admin",
                    "is_active": operation != "disable_other"}
            return client.put(f"/api/users/{target_id}", json=data).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(mutate, (1, 2)))
    expected = {"demote_self": [200, 409], "disable_other": [200, 401], "duplicate_email": [201, 409]}
    assert statuses == expected[operation]
    with Session(postgres_users) as session:
        assert session.scalar(select(func.count(User.id)).where(User.role == Role.admin, User.is_active)) >= 1
        if operation == "duplicate_email":
            assert session.scalar(select(func.count(User.id)).where(User.email == "same@example.test")) == 1
