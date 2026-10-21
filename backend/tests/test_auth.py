import pyotp
from sqlalchemy import select

from app.models import User
from app.seed import DEMO_PASSWORD


def test_wrong_password(client):
    r = client.post("/api/auth/login", json={"email": "analyst@example.com", "password": "nope"})
    assert r.status_code == 401


def test_two_step_login_with_totp_setup(client, db):
    r = client.post("/api/auth/login", json={"email": "Analyst@Example.com", "password": DEMO_PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["setup_required"] is True
    assert body["otpauth_uri"].startswith("otpauth://totp/")

    # Без второго фактора доступа нет
    assert client.get("/api/auth/me").status_code == 401

    bad = client.post("/api/auth/2fa", json={"mfa_token": body["mfa_token"], "code": "000000"})
    assert bad.status_code == 400
    assert bad.json()["detail"]["field"] == "code"

    user = db.scalar(select(User).where(User.email == "analyst@example.com"))
    ok = client.post("/api/auth/2fa", json={"mfa_token": body["mfa_token"], "code": pyotp.TOTP(user.totp_secret).now()})
    assert ok.status_code == 200
    assert client.get("/api/auth/me").json()["role"] == "analyst"

    # Повторный вход уже не требует настройки
    again = client.post("/api/auth/login", json={"email": "analyst@example.com", "password": DEMO_PASSWORD})
    assert again.json()["setup_required"] is False
    assert again.json()["otpauth_uri"] is None


def test_mfa_token_cannot_be_used_as_access(client):
    r = client.post("/api/auth/login", json={"email": "analyst@example.com", "password": DEMO_PASSWORD})
    client.cookies.set("access_token", r.json()["mfa_token"])
    assert client.get("/api/auth/me").status_code == 401


def test_logout(as_analyst):
    assert as_analyst.post("/api/auth/logout").status_code == 204
    assert as_analyst.get("/api/auth/me").status_code == 401
