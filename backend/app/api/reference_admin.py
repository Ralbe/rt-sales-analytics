"""Администрирование значений существующих закрытых справочников."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.core import cache
from app.db import get_db
from app.deps import require_roles
from app.models import ReferenceValue, Role, User
from app.project_field_label_schemas import normalize_label
from app.services import audit
from app.services.pipeline import SUCCESS_STAGE_CODE

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


def _validate_stage_name(value: str) -> str:
    value = normalize_label(value)
    if len(value) > 100:
        raise ValueError("Название не должно превышать 100 символов")
    return value


class NameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(strict=True, max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_stage_name(value)


class ActiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool = Field(strict=True)


class StageCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(strict=True, max_length=1000)
    probability: int = Field(strict=True, ge=0, le=100)
    position: int = Field(strict=True, ge=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_stage_name(value)


class StageEditIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(strict=True, max_length=1000)
    probability: int = Field(strict=True, ge=0, le=100)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_stage_name(value)


class StageActiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool = Field(strict=True)
    name: str | None = Field(default=None, strict=True, max_length=1000)
    probability: int | None = Field(default=None, strict=True, ge=0, le=100)
    position: int | None = Field(default=None, strict=True, ge=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return _validate_stage_name(value) if value is not None else None


class StagePositionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: int = Field(strict=True, ge=1)
    expected_position: int | None = Field(default=None, strict=True, ge=1)


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


def _bump_caches() -> None:
    cache.bump("analytics")
    cache.bump("refs")


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


def _ordered_customer_stages(db: Session, *, normalize: bool = True) -> list[ReferenceValue]:
    rows = list(
        db.scalars(
            select(ReferenceValue)
            .where(ReferenceValue.category == "customer_stage")
            .order_by(ReferenceValue.position, ReferenceValue.id)
        ).all()
    )
    non_success = [row for row in rows if row.code != SUCCESS_STAGE_CODE]
    success_rows = [row for row in rows if row.code == SUCCESS_STAGE_CODE]
    ordered = non_success + success_rows
    if normalize:
        for index, row in enumerate(ordered, start=1):
            if row.position != index:
                row.position = index
    return ordered


def _reposition_stage(ordered: list[ReferenceValue], target: ReferenceValue, new_position: int) -> None:
    non_success = [row for row in ordered if row.code != SUCCESS_STAGE_CODE and row.id != target.id]
    success_rows = [row for row in ordered if row.code == SUCCESS_STAGE_CODE]
    max_before_success = len(non_success) + 1
    if not (1 <= new_position <= max_before_success):
        raise HTTPException(422, "Этап можно разместить только на допустимой позиции до этапа «Успех»")
    non_success.insert(new_position - 1, target)
    final_order = non_success + success_rows
    for index, row in enumerate(final_order, start=1):
        row.position = index


@router.get("", response_model=dict[str, str])
def categories(_: User = Depends(require_roles(Role.admin))) -> dict[str, str]:
    return CATEGORIES


@router.get("/{category}", response_model=list[ReferenceOut])
def list_values(category: str, db: Session = Depends(get_db), _: User = Depends(require_roles(Role.admin))):
    check_category(category)
    if category == "customer_stage":
        rows = _ordered_customer_stages(db, normalize=False)
        return [
            ReferenceOut(
                id=row.id,
                category=row.category,
                code=row.code,
                name=row.name,
                is_active=row.is_active,
                position=index,
                probability=row.probability,
            )
            for index, row in enumerate(rows, start=1)
        ]
    return db.scalars(
        select(ReferenceValue)
        .where(ReferenceValue.category == category)
        .order_by(ReferenceValue.position, ReferenceValue.id)
    ).all()


@router.post("/customer_stage", response_model=ReferenceOut, status_code=201)
def add_customer_stage(
    data: StageCreateIn, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin))
):
    try:
        lock_admin(db, actor)
        unique_name(db, "customer_stage", data.name)
        ordered = _ordered_customer_stages(db, normalize=True)
        non_success = [row for row in ordered if row.code != SUCCESS_STAGE_CODE]
        max_position = len(non_success) + 1
        if not (1 <= data.position <= max_position):
            raise HTTPException(422, "Этап должен располагаться на допустимой позиции до этапа «Успех»")
        row = ReferenceValue(
            category="customer_stage",
            code="custom_" + uuid4().hex,
            name=data.name,
            position=data.position,
            probability=data.probability,
            is_active=True,
        )
        db.add(row)
        db.flush()
        _reposition_stage(ordered + [row], row, data.position)
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
        _bump_caches()
        return row
    except Exception:
        db.rollback()
        raise


@router.put("/customer_stage/{value_id}", response_model=ReferenceOut)
def edit_customer_stage(
    value_id: int,
    data: StageEditIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    return change_value(db, actor, "customer_stage", value_id, name=data.name, probability=data.probability)


@router.put("/customer_stage/{value_id}/position", response_model=ReferenceOut)
def move_customer_stage(
    value_id: int,
    data: StagePositionIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    try:
        lock_admin(db, actor)
        ordered = _ordered_customer_stages(db, normalize=True)
        row = next((item for item in ordered if item.id == value_id), None)
        if row is None:
            raise HTTPException(404, "Значение справочника не найдено")
        if row.code == SUCCESS_STAGE_CODE:
            raise HTTPException(409, "Системный этап «Успех» всегда остаётся последним и не может быть перемещён")
        if data.expected_position is not None and row.position != data.expected_position:
            raise HTTPException(
                409, "Порядок этапов был изменён другим администратором. Обновите страницу и повторите действие."
            )
        before = snapshot(row)
        _reposition_stage(ordered, row, data.position)
        after = snapshot(row)
        if before != after:
            audit.record(
                db,
                actor.id,
                "reorder",
                "reference_value",
                row.id,
                before=before,
                after=after,
                from_position=before["position"],
                to_position=after["position"],
                author_name=actor.full_name,
            )
        db.commit()
        _bump_caches()
        return row
    except Exception:
        db.rollback()
        raise


@router.put("/customer_stage/{value_id}/active", response_model=ReferenceOut)
def activate_customer_stage(
    value_id: int,
    data: StageActiveIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_roles(Role.admin)),
):
    try:
        lock_admin(db, actor)
        ordered = _ordered_customer_stages(db, normalize=True)
        row = next((item for item in ordered if item.id == value_id), None)
        if row is None:
            raise HTTPException(404, "Значение справочника не найдено")
        if not data.is_active:
            if row.code == SUCCESS_STAGE_CODE:
                raise HTTPException(409, "Системный этап «Успех» нельзя отключить")
            if data.name is not None or data.probability is not None or data.position is not None:
                raise HTTPException(422, "При отключении этапа изменение параметров не допускается")
            before = snapshot(row)
            row.is_active = False
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
            _bump_caches()
            return row

        before = snapshot(row)
        target_name = data.name if data.name is not None else row.name
        unique_name(db, "customer_stage", target_name, row.id)
        target_prob = data.probability if data.probability is not None else row.probability
        if target_prob is None or not (0 <= target_prob <= 100):
            raise HTTPException(422, "Укажите вероятность от 0 до 100")
        if data.position is not None:
            if row.code == SUCCESS_STAGE_CODE:
                if data.position != len(ordered):
                    raise HTTPException(409, "Системный этап «Успех» всегда остаётся последним")
            else:
                _reposition_stage(ordered, row, data.position)
        row.name = target_name
        row.probability = target_prob
        row.is_active = True
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
        _bump_caches()
        return row
    except Exception:
        db.rollback()
        raise


@router.post("/{category}", response_model=ReferenceOut, status_code=201)
def add_value(
    category: str, data: NameIn, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin))
):
    check_category(category)
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
        _bump_caches()
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
        _bump_caches()
        return row
    except Exception:
        db.rollback()
        raise
