"""Администрирование значений существующих закрытых справочников."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_roles
from app.models import ReferenceValue, Role, User
from app.project_field_label_schemas import normalize_label
from app.services import audit

CATEGORIES = {
    "payment_type": "Тип платежа",
    "assessment_status": "Статус оценки",
    "project_indicator": "Индикатор проекта",
    "cost_article": "Статья затрат",
    "cost_type": "Вид затрат",
    "revenue_status": "Статус выручки",
    "cost_status": "Статус затрат",
    "customer_stage": "Этап по ТЗ",
}
router = APIRouter(prefix="/reference-admin", tags=["reference-admin"])


class NameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(strict=True, max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = normalize_label(value)
        if len(value) > 100:
            raise ValueError("Название не должно превышать 100 символов")
        return value


class ActiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool = Field(strict=True)


class ReferenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    category: str
    code: str
    name: str
    is_active: bool
    position: int
    probability: int | None


def check_category(category: str) -> None:
    if category not in CATEGORIES:
        raise HTTPException(404, "Справочник не найден")


def lock_admin(db: Session, actor: User) -> None:
    auth_version = actor.auth_version
    if db.get_bind().dialect.name == "postgresql":
        db.scalar(select(User).where(User.id == actor.id).with_for_update(read=True))
        db.execute(text("LOCK TABLE reference_values IN SHARE ROW EXCLUSIVE MODE"))
    else:
        db.execute(update(User).where(User.id == actor.id).values(is_active=User.is_active))
    db.refresh(actor)
    if not actor.is_active or actor.auth_version != auth_version:
        raise HTTPException(401, "Требуется вход в систему")
    if actor.role != Role.admin:
        raise HTTPException(403, "Недостаточно прав")


def snapshot(row: ReferenceValue) -> dict:
    return {
        "category": row.category,
        "code": row.code,
        "name": row.name,
        "is_active": row.is_active,
        "position": row.position,
        "probability": row.probability,
    }


def unique_name(db: Session, category: str, name: str, exclude: int | None = None) -> None:
    rows = db.scalars(select(ReferenceValue).where(ReferenceValue.category == category)).all()
    if any(row.id != exclude and row.name.casefold() == name.casefold() for row in rows):
        raise HTTPException(409, "Такое название уже существует в справочнике")


@router.get("", response_model=dict[str, str])
def categories(_: User = Depends(require_roles(Role.admin))) -> dict[str, str]:
    return CATEGORIES


@router.get("/{category}", response_model=list[ReferenceOut])
def list_values(category: str, db: Session = Depends(get_db), _: User = Depends(require_roles(Role.admin))):
    check_category(category)
    return db.scalars(
        select(ReferenceValue)
        .where(ReferenceValue.category == category)
        .order_by(ReferenceValue.position, ReferenceValue.id)
    ).all()


@router.post("/{category}", response_model=ReferenceOut, status_code=201)
def add_value(
    category: str, data: NameIn, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin))
):
    check_category(category)
    if category == "customer_stage":
        raise HTTPException(409, "Добавление этапов требует согласования порядка и вероятности")
    try:
        lock_admin(db, actor)
        unique_name(db, category, data.name)
        rows = db.scalars(select(ReferenceValue).where(ReferenceValue.category == category)).all()
        row = ReferenceValue(
            category=category, code="custom_" + uuid4().hex, name=data.name,
            position=max((r.position for r in rows), default=0) + 10,
        )
        db.add(row)
        db.flush()
        audit.record(
            db,
            actor.id,
            "create",
            "reference_value",
            row.id,
            before=None,
            after=snapshot(row),
            author_name=actor.full_name,
        )
        db.commit()
        return row
    except Exception:
        db.rollback()
        raise


@router.put("/{category}/{value_id}/name", response_model=ReferenceOut)
def rename_value(
    category: str,
    value_id: int,
    data: NameIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    return change_value(db, actor, category, value_id, name=data.name)


@router.put("/{category}/{value_id}/active", response_model=ReferenceOut)
def activate_value(
    category: str,
    value_id: int,
    data: ActiveIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    if category == "customer_stage":
        raise HTTPException(409, "Изменение доступности этапов требует согласования")
    return change_value(db, actor, category, value_id, is_active=data.is_active)


def change_value(db: Session, actor: User, category: str, value_id: int, **changes):
    check_category(category)
    try:
        lock_admin(db, actor)
        row = db.get(ReferenceValue, value_id, populate_existing=True)
        if row is None or row.category != category:
            raise HTTPException(404, "Значение справочника не найдено")
        before = snapshot(row)
        if "name" in changes:
            unique_name(db, category, changes["name"], row.id)
        for key, value in changes.items():
            setattr(row, key, value)
        after = snapshot(row)
        if before != after:
            audit.record(
                db,
                actor.id,
                "update",
                "reference_value",
                row.id,
                before=before,
                after=after,
                author_name=actor.full_name,
            )
        db.commit()
        return row
    except Exception:
        db.rollback()
        raise
