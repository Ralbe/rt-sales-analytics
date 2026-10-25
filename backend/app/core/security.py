from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
import pyotp

from app.core.config import settings

ACCESS_COOKIE = "access_token"
SCOPE_ACCESS = "access"
SCOPE_MFA = "mfa"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_token(user_id: int, scope: str, minutes: int, ver: int = 0) -> str:
    payload = {"sub": str(user_id), "scope": scope, "ver": ver, "exp": datetime.now(UTC) + timedelta(minutes=minutes)}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_token(token: str, scope: str) -> int | None:
    context = decode_token_context(token, scope)
    return context[0] if context is not None else None


def decode_token_context(token: str, scope: str) -> tuple[int, int] | None:
    """Проверяет JWT и возвращает пользователя с версией; старые токены имеют версию 0."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError, OverflowError):
        return None
    version = payload.get("ver", 0)
    if payload.get("scope") != scope or user_id <= 0 or type(version) is not int or version < 0:
        return None
    return user_id, version


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.totp_issuer)


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def inn_is_valid(inn: str) -> bool:
    """Проверка контрольной суммы ИНН (10 цифр — юрлицо, 12 — ИП/физлицо)."""
    if not inn.isdigit() or len(inn) not in (10, 12):
        return False
    digits = [int(c) for c in inn]

    def checksum(coefs: list[int]) -> int:
        return sum(c * d for c, d in zip(coefs, digits, strict=False)) % 11 % 10

    if len(inn) == 10:
        return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) == digits[9]
    return (
        checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == digits[10]
        and checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == digits[11]
    )
