from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import DASHBOARD_EDITORS, DASHBOARD_PUBLISHERS, get_current_user, lock_actor, require_roles
from app.models import Dashboard, Role, User
from app.schemas import DashboardIn, DashboardOut
from app.services import audit
from app.services.dashboards import create_default

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def to_out(d: Dashboard, user: User) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "owner": d.owner,
        "widgets": d.widgets,
        "filters": d.filters or {},
        "is_shared": d.is_shared,
        "editable": user.role in DASHBOARD_EDITORS and (d.owner_id == user.id or user.role == Role.admin),
        "updated_at": d.updated_at,
    }


def _get(db: Session, dashboard_id: int, user: User, *, for_write: bool = False) -> Dashboard:
    d = db.scalar(select(Dashboard).where(Dashboard.id == dashboard_id)
                  .with_for_update(read=not for_write, of=Dashboard).execution_options(populate_existing=True))
    if d is None or (user.role != Role.admin and d.owner_id != user.id and not d.is_shared):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Дашборд не найден")
    if for_write and d.owner_id != user.id and user.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Изменять дашборд может только его автор или администратор")
    return d


def _check_publish(data: DashboardIn, user: User) -> None:
    if data.is_shared and user.role not in DASHBOARD_PUBLISHERS:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Публиковать дашборды могут аналитики и администраторы")


@router.get("", response_model=list[DashboardOut])
def list_dashboards(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """Показывает доступные дашборды; аналитикам и администраторам создаёт дашборд по умолчанию."""
    user = lock_actor(db, user, exclusive=True)
    has_dashboard = db.scalar(select(Dashboard.id).where(Dashboard.owner_id == user.id).limit(1))
    if user.role in DASHBOARD_EDITORS and has_dashboard is None:
        dashboard = create_default(db, user)
        audit.record(db, user.id, "create", "dashboard", dashboard.id, name=dashboard.name)
    stmt = select(Dashboard)
    if user.role != Role.admin:
        stmt = stmt.where(or_(Dashboard.owner_id == user.id, Dashboard.is_shared))
    items = db.scalars(stmt.order_by((Dashboard.owner_id != user.id), Dashboard.id)).all()
    result = [to_out(d, user) for d in items]
    db.commit()
    return result


@router.get("/{dashboard_id}", response_model=DashboardOut)
def get_dashboard(dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    user = lock_actor(db, user)
    return to_out(_get(db, dashboard_id, user), user)


@router.post("", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    data: DashboardIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*DASHBOARD_EDITORS)),
) -> dict:
    user = lock_actor(db, user, roles=DASHBOARD_EDITORS)
    _check_publish(data, user)
    d = Dashboard(owner_id=user.id, **data.model_dump())
    db.add(d)
    db.flush()
    audit.record(db, user.id, "create", "dashboard", d.id, name=d.name)
    db.commit()
    db.refresh(d)
    return to_out(d, user)


@router.put("/{dashboard_id}", response_model=DashboardOut)
def update_dashboard(
    dashboard_id: int,
    data: DashboardIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*DASHBOARD_EDITORS)),
) -> dict:
    user = lock_actor(db, user, roles=DASHBOARD_EDITORS)
    d = _get(db, dashboard_id, user, for_write=True)
    _check_publish(data, user)
    new_values = data.model_dump()
    before = {field: getattr(d, field) for field in new_values}
    for field, value in new_values.items():
        setattr(d, field, value)
    if before != new_values:
        audit.record(db, user.id, "update", "dashboard", d.id, owner_id=d.owner_id, before=before, after=new_values)
    db.commit()
    db.refresh(d)
    return to_out(d, user)


@router.post("/{dashboard_id}/copy", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def copy_dashboard(
    dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(*DASHBOARD_EDITORS))
) -> dict:
    user = lock_actor(db, user, roles=DASHBOARD_EDITORS)
    src = _get(db, dashboard_id, user)
    d = Dashboard(owner_id=user.id, name=f"{src.name} (копия)", widgets=src.widgets, filters=src.filters)
    db.add(d)
    db.flush()
    audit.record(db, user.id, "create", "dashboard", d.id, name=d.name, copied_from=src.id)
    db.commit()
    db.refresh(d)
    return to_out(d, user)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(
    dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(*DASHBOARD_EDITORS))
) -> None:
    user = lock_actor(db, user, roles=DASHBOARD_EDITORS)
    d = _get(db, dashboard_id, user, for_write=True)
    db.delete(d)
    audit.record(db, user.id, "delete", "dashboard", dashboard_id, name=d.name)
    db.commit()
