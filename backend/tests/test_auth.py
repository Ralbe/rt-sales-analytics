import jwt
import pyotp
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.core.security import SCOPE_ACCESS, SCOPE_MFA, create_token, decode_token, decode_token_context
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


@pytest.mark.parametrize("scope", [SCOPE_ACCESS, SCOPE_MFA])
def test_token_context_preserves_decoder_contract_and_legacy_tokens(scope):
    token = create_token(42, scope, 5, ver=3)
    assert decode_token(token, scope) == 42
    assert decode_token_context(token, scope) == (42, 3)
    assert decode_token_context(token, "другая область") is None
    assert decode_token_context(create_token(42, scope, 5), scope) == (42, 0)
    claims = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    claims.pop("ver")
    legacy = jwt.encode(claims, settings.secret_key, algorithm="HS256")
    assert decode_token(legacy, scope) == 42
    assert decode_token_context(legacy, scope) == (42, 0)


@pytest.mark.parametrize("version", [None, "0", -1, True, [], {}])
def test_token_context_rejects_invalid_versions(version):
    token = jwt.encode({"sub": "42", "scope": SCOPE_ACCESS, "ver": version}, settings.secret_key, algorithm="HS256")
    assert decode_token_context(token, SCOPE_ACCESS) is None
    assert decode_token(token, SCOPE_ACCESS) is None


@pytest.mark.parametrize("subject", [None, "не число", "0", "-1", [], {}])
def test_token_context_rejects_invalid_subjects(subject):
    token = jwt.encode({"sub": subject, "scope": SCOPE_ACCESS}, settings.secret_key, algorithm="HS256")
    assert decode_token_context(token, SCOPE_ACCESS) is None
