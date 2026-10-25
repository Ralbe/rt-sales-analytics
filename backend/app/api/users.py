from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db import get_db
from app.deps import require_roles
from app.models import Role, User
from app.services import audit
from app.user_schemas import ManagedUser, UserCreate, UserPage, UserUpdate


class UserRoute(APIRoute):
    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def safe_validation(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # FastAPI по умолчанию возвращает input, в котором может оказаться пароль.
                errors = []
                for error in exc.errors():
                    message = "Некорректное значение поля"
                    if error["type"] == "value_error":
                        message = error["msg"].removeprefix("Value error, ")
                    elif error["type"] == "missing":
                        message = "Обязательное поле"
                    elif error["type"] == "enum":
                        message = "Выберите пользователя, аналитика или администратора"
                    elif error["type"] == "extra_forbidden":
                        message = "Изменение этого поля не поддерживается"
                    errors.append({"loc": error["loc"], "msg": message, "type": error["type"]})
                return JSONResponse(status_code=422, content={"detail": errors})

        return safe_validation


router = APIRouter(prefix="/users", tags=["users"], route_class=UserRoute)


def _lock_users(db: Session, actor: User) -> None:
    # Блокировка до чтения инварианта сериализует создание, смену роли и отключение.
    # SHARE ROW EXCLUSIVE конфликтует с собой и UPDATE, но разрешает обычное чтение.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE"))
    else:
        # SQLite получает блокировку записи до проверки последнего администратора.
        db.execute(update(User).where(User.id == actor.id).values(is_active=User.is_active))
    # Права могли измениться, пока запрос ожидал блокировку.
    db.refresh(actor)
    if not actor.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход в систему")
    if actor.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")


def _check_email(db: Session, email: str, exclude_id: int | None = None) -> None:
    stmt = select(User.id).where(func.lower(func.trim(User.email)) == email)
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    if db.scalar(stmt) is not None:
        raise _duplicate_email()


def _duplicate_email() -> HTTPException:
    return HTTPException(409, {"field": "email", "message": "Пользователь с этим email уже существует"})


def _public_fields(user: User) -> dict:
    # Только разрешённые поля: пароль, его хеш и настройки MFA не попадают в аудит.
    return {"email": user.email, "full_name": user.full_name, "role": user.role.value, "is_active": user.is_active}


@router.get("", response_model=UserPage)
def list_users(
    q: str = Query(default="", max_length=255),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(Role.admin)),
) -> dict:
    stmt = select(User)
    if not include_inactive:
        stmt = stmt.where(User.is_active)
    q = q.strip()
    if q:
        stmt = stmt.where(or_(User.email.icontains(q, autoescape=True), User.full_name.icontains(q, autoescape=True)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = db.scalars(stmt.order_by(User.full_name, User.id).offset((page - 1) * size).limit(size)).all()
    return {"items": items, "total": total, "page": page, "size": size}


@router.post("", response_model=ManagedUser, status_code=status.HTTP_201_CREATED)
def create_user(
    data: UserCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
) -> User:
    password_hash = hash_password(data.password.get_secret_value())
    _lock_users(db, actor)
    _check_email(db, data.email)
    user = User(
        email=data.email, full_name=data.full_name, role=data.role, password_hash=password_hash,
        is_active=True, totp_enabled=False, totp_secret=None,
    )
    db.add(user)
    try:
        db.flush()
        audit.record(db, actor.id, "create", "user", user.id, **_public_fields(user))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _duplicate_email() from None
    return user


@router.put("/{user_id}", response_model=ManagedUser)
def update_user(
    user_id: int,
    data: UserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
) -> User:
    _lock_users(db, actor)
    user = db.get(User, user_id, populate_existing=True)
    if user is None:
        raise HTTPException(404, "Пользователь не найден")
    if user.id == actor.id and not data.is_active:
        raise HTTPException(409, {"field": "is_active", "message": "Нельзя отключить собственную учётную запись"})
    if user.is_active and user.role == Role.admin and (not data.is_active or data.role != Role.admin):
        other_admin = db.scalar(select(User.id).where(User.role == Role.admin, User.is_active, User.id != user.id))
        if other_admin is None:
            raise HTTPException(409, {"field": "role", "message": "Нужен хотя бы один активный администратор"})
    _check_email(db, data.email, exclude_id=user.id)
    before = _public_fields(user)
    for field, value in data.model_dump().items():
        setattr(user, field, value)
    try:
        db.flush()
        audit.record(db, actor.id, "update", "user", user.id, before=before, after=_public_fields(user))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _duplicate_email() from None
    return user
