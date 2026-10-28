from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, decode_token_context
from app.db import get_db
from app.models import Role, User

# Проекты могут редактировать все роли, но пользователи ограничены своими проектами.
PROJECT_EDITORS = {Role.user, Role.analyst, Role.admin}
SEES_ALL_PROJECTS = {Role.analyst, Role.admin}
# Настройка и публикация дашбордов доступны аналитику и администратору.
DASHBOARD_EDITORS = {Role.analyst, Role.admin}
DASHBOARD_PUBLISHERS = DASHBOARD_EDITORS


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(ACCESS_COOKIE)
    context = decode_token_context(token, SCOPE_ACCESS) if token else None
    user = db.get(User, context[0]) if context is not None else None
    if user is None or not user.is_active or user.auth_version != context[1]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход в систему")
    return user


def require_roles(*roles: Role) -> Callable[[User], User]:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return user

    return dependency


def lock_actor(db: Session, user: User, *, roles: set[Role] | None = None, exclusive: bool = False) -> User:
    """Не допускает изменения прав пользователя до окончания защищённой операции."""
    version = user.auth_version
    if db.get_bind().dialect.name == "sqlite":
        # SQLite не поддерживает FOR SHARE/FOR UPDATE; резервируем блокировку записи.
        db.execute(update(User).where(User.id == user.id).values(auth_version=User.auth_version))
    locked = db.scalar(
        select(User).where(User.id == user.id)
        .with_for_update(read=not exclusive).execution_options(populate_existing=True)
    )
    if locked is None or not locked.is_active or locked.auth_version != version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход в систему")
    if roles is not None and locked.role not in roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
    return locked


def manager_scope(user: User) -> int | None:
    """Возвращает владельца проектной выборки для ограниченной роли."""
    return None if user.role in SEES_ALL_PROJECTS else user.id
