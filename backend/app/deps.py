from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.security import ACCESS_COOKIE, SCOPE_ACCESS, decode_token
from app.db import get_db
from app.models import Role, User

# Кто может создавать и редактировать проекты
PROJECT_EDITORS = {Role.manager, Role.head, Role.admin}
# Кто видит все проекты (менеджер — только свои)
SEES_ALL_PROJECTS = {Role.analyst, Role.head, Role.admin}
# Кто может публиковать дашборды для всех
DASHBOARD_PUBLISHERS = {Role.analyst, Role.head, Role.admin}


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(ACCESS_COOKIE)
    user_id = decode_token(token, SCOPE_ACCESS) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход в систему")
    return user


def require_roles(*roles: Role) -> Callable[[User], User]:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return user

    return dependency


def manager_scope(user: User) -> int | None:
    """Ограничение выборки: id менеджера или None, если пользователь видит всё."""
    return None if user.role in SEES_ALL_PROJECTS else user.id
