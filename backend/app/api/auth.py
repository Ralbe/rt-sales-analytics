from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import cache
from app.core.config import settings
from app.core.security import (
    ACCESS_COOKIE,
    SCOPE_ACCESS,
    SCOPE_MFA,
    create_token,
    decode_token,
    new_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)
from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.schemas import LoginIn, LoginOut, MfaIn, UserOut
from app.services import audit

router = APIRouter(prefix="/auth", tags=["auth"])

INVALID_CREDENTIALS = "Неверный email или пароль"


def _check_rate_limit(key: str) -> None:
    if cache.rate_limited(key, settings.login_attempts_limit, settings.login_attempts_window_seconds):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток. Повторите через несколько минут")


@router.post("/login", response_model=LoginOut)
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)) -> LoginOut:
    """Шаг 1: проверка логина и пароля. Возвращает временный токен для второго фактора."""
    email = data.email.strip().lower()
    _check_rate_limit(f"login:{request.client.host if request.client else ''}:{email}")

    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None or not user.is_active or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_CREDENTIALS)

    setup_required = not user.totp_enabled
    if setup_required and not user.totp_secret:
        user.totp_secret = new_totp_secret()
        db.commit()

    return LoginOut(
        mfa_token=create_token(user.id, SCOPE_MFA, settings.mfa_token_minutes),
        setup_required=setup_required,
        otpauth_uri=totp_uri(user.totp_secret, user.email) if setup_required else None,
        secret=user.totp_secret if setup_required else None,
    )


@router.post("/2fa", response_model=UserOut)
def verify_second_factor(data: MfaIn, response: Response, db: Session = Depends(get_db)) -> User:
    """Шаг 2: проверка одноразового кода из приложения-аутентификатора."""
    user_id = decode_token(data.mfa_token, SCOPE_MFA)
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active or not user.totp_secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Сессия входа истекла, войдите заново")
    _check_rate_limit(f"2fa:{user.id}")

    if not verify_totp(user.totp_secret, data.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, {"field": "code", "message": "Неверный код"})

    user.totp_enabled = True
    audit.record(db, user.id, "login", "user", user.id)
    db.commit()

    response.set_cookie(
        ACCESS_COOKIE,
        create_token(user.id, SCOPE_ACCESS, settings.access_token_minutes),
        max_age=settings.access_token_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response) -> None:
    response.delete_cookie(ACCESS_COOKIE, path="/")


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user
