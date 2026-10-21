from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import DASHBOARD_PUBLISHERS, get_current_user
from app.models import Dashboard, User
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
        "editable": d.owner_id == user.id,
        "updated_at": d.updated_at,
    }


def _get(db: Session, dashboard_id: int, user: User, *, for_write: bool = False) -> Dashboard:
    d = db.get(Dashboard, dashboard_id)
    if d is None or (d.owner_id != user.id and not d.is_shared):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Дашборд не найден")
    if for_write and d.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Изменять дашборд может только его автор")
    return d


def _check_publish(data: DashboardIn, user: User) -> None:
    if data.is_shared and user.role not in DASHBOARD_PUBLISHERS:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Публиковать дашборды могут аналитики и руководители")


@router.get("", response_model=list[DashboardOut])
def list_dashboards(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """Свои дашборды и опубликованные коллегами. При первом входе создаётся дашборд по умолчанию."""
    if db.scalar(select(Dashboard.id).where(Dashboard.owner_id == user.id).limit(1)) is None:
        create_default(db, user)
    items = db.scalars(
        select(Dashboard)
        .where(or_(Dashboard.owner_id == user.id, Dashboard.is_shared))
        .order_by((Dashboard.owner_id != user.id), Dashboard.id)
    ).all()
    return [to_out(d, user) for d in items]


@router.get("/{dashboard_id}", response_model=DashboardOut)
def get_dashboard(dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return to_out(_get(db, dashboard_id, user), user)


@router.post("", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def create_dashboard(data: DashboardIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
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
    dashboard_id: int, data: DashboardIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    d = _get(db, dashboard_id, user, for_write=True)
    _check_publish(data, user)
    for field, value in data.model_dump().items():
        setattr(d, field, value)
    db.commit()
    db.refresh(d)
    return to_out(d, user)


@router.post("/{dashboard_id}/copy", response_model=DashboardOut, status_code=status.HTTP_201_CREATED)
def copy_dashboard(dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    src = _get(db, dashboard_id, user)
    d = Dashboard(owner_id=user.id, name=f"{src.name} (копия)", widgets=src.widgets, filters=src.filters)
    db.add(d)
    db.commit()
    db.refresh(d)
    return to_out(d, user)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(dashboard_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    d = _get(db, dashboard_id, user, for_write=True)
    db.delete(d)
    audit.record(db, user.id, "delete", "dashboard", dashboard_id, name=d.name)
    db.commit()
