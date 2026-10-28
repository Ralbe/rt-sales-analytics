"""Безопасное администрирование сегментов и услуг."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.api.reference_admin import ActiveIn, NameIn
from app.core import cache
from app.db import get_db
from app.deps import require_roles
from app.models import Role, Segment, Service, User
from app.project_field_label_schemas import normalize_label
from app.services import audit

router = APIRouter(prefix="/structural-references", tags=["structural-references"])
MODELS = {"segments": Segment, "services": Service}


class CreateIn(NameIn):
    group_name: str | None = Field(default=None, strict=True, max_length=1000)

    @field_validator("group_name")
    @classmethod
    def validate_group(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        value = normalize_label(value)
        if len(value) > 100:
            raise ValueError("Группа не должна превышать 100 символов")
        return value


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    is_active: bool
    group_name: str | None = None


def model_for(category: str):
    if category not in MODELS:
        raise HTTPException(404, "Справочник не найден")
    return MODELS[category]


def lock_admin(db: Session, actor: User, category: str) -> None:
    version = actor.auth_version
    if db.get_bind().dialect.name == "postgresql":
        db.scalar(select(User).where(User.id == actor.id).with_for_update(read=True))
        # Имя таблицы получено исключительно из фиксированного словаря.
        db.execute(text(f"LOCK TABLE {MODELS[category].__tablename__} IN SHARE ROW EXCLUSIVE MODE"))
    else:
        db.execute(update(User).where(User.id == actor.id).values(is_active=User.is_active))
    db.refresh(actor)
    if not actor.is_active or actor.auth_version != version:
        raise HTTPException(401, "Требуется вход в систему")
    if actor.role != Role.admin:
        raise HTTPException(403, "Недостаточно прав")


def snapshot(row: Segment | Service) -> dict:
    result = {"name": row.name, "is_active": row.is_active}
    if isinstance(row, Service):
        result["group_name"] = row.group_name
    return result


def unique_name(db: Session, model, name: str, exclude: int | None = None) -> None:
    rows = db.scalars(select(model)).all()
    if any(row.id != exclude and row.name.casefold() == name.casefold() for row in rows):
        raise HTTPException(409, "Такое название уже существует в справочнике")


@router.get("/{category}", response_model=list[ItemOut])
def list_items(category: str, db: Session = Depends(get_db), _: User = Depends(require_roles(Role.admin))):
    model = model_for(category)
    return db.scalars(select(model).order_by(model.name, model.id)).all()


@router.post("/{category}", response_model=ItemOut, status_code=201)
def add(category: str, data: CreateIn, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin))):
    model = model_for(category)
    if category != "services" and "group_name" in data.model_fields_set:
        raise HTTPException(422, {"field": "group_name", "message": "Группа допустима только для услуги"})
    try:
        lock_admin(db, actor, category)
        unique_name(db, model, data.name)
        row = Service(name=data.name, group_name=data.group_name) if category == "services" else Segment(name=data.name)
        db.add(row)
        db.flush()
        audit.record(
            db, actor.id, "create", category[:-1], row.id, before=None, after=snapshot(row), author_name=actor.full_name
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    cache.bump("analytics")
    return row


def change(db: Session, actor: User, category: str, item_id: int, **values):
    model = model_for(category)
    try:
        lock_admin(db, actor, category)
        row = db.get(model, item_id, populate_existing=True)
        if row is None:
            raise HTTPException(404, "Значение справочника не найдено")
        before = snapshot(row)
        if "name" in values:
            unique_name(db, model, values["name"], row.id)
        for key, value in values.items():
            setattr(row, key, value)
        after = snapshot(row)
        if before != after:
            audit.record(
                db, actor.id, "update", category[:-1], row.id, before=before, after=after, author_name=actor.full_name
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    if before != after:
        cache.bump("analytics")
    return row


@router.put("/{category}/{item_id}/name", response_model=ItemOut)
def rename(
    category: str,
    item_id: int,
    data: NameIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    return change(db, actor, category, item_id, name=data.name)


@router.put("/{category}/{item_id}/active", response_model=ItemOut)
def set_active(
    category: str,
    item_id: int,
    data: ActiveIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    return change(db, actor, category, item_id, is_active=data.is_active)
