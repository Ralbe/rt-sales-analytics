from collections.abc import Iterable, Mapping

from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.models import ProjectFieldLabel, Role, User
from app.project_field_label_catalog import FIELD_LABELS
from app.project_field_label_schemas import normalize_label
from app.services import audit


def _check_key(key: str) -> None:
    if key not in FIELD_LABELS:
        raise HTTPException(422, {"field": "key", "message": "Неизвестный ключ подписи проекта"})


def effective_project_field_labels(db: Session) -> dict[str, str]:
    labels = {key: definition.default_label for key, definition in FIELD_LABELS.items()}
    labels.update(db.execute(
        select(ProjectFieldLabel.key, ProjectFieldLabel.label).where(ProjectFieldLabel.key.in_(FIELD_LABELS))
    ).all())
    return labels


def with_project_field_labels(db: Session, refs: dict) -> dict:
    """Добавочное поле /refs, без изменения существующих данных справочников."""
    return {**refs, "project_field_labels": effective_project_field_labels(db)}


def field_label_items(labels: Mapping[str, str]) -> list[dict]:
    return [
        {
            "key": key, "label": labels[key], "default_label": definition.default_label,
            "suffix": definition.suffix, "is_overridden": labels[key] != definition.default_label,
        }
        for key, definition in FIELD_LABELS.items()
    ]


def _lock_admin(db: Session, actor: User) -> None:
    auth_version = actor.auth_version
    # Сериализация защищает одновременную первую вставку одного ключа.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("LOCK TABLE project_field_labels IN SHARE ROW EXCLUSIVE MODE"))
    else:
        db.execute(update(User).where(User.id == actor.id).values(is_active=User.is_active))
    db.refresh(actor)
    if not actor.is_active or actor.auth_version != auth_version:
        raise HTTPException(401, "Требуется вход в систему")
    if actor.role != Role.admin:
        raise HTTPException(403, "Недостаточно прав")


def save_project_field_label(db: Session, actor: User, key: str, label: str | None) -> dict:
    """None и исходная подпись удаляют override; повторное сохранение не создаёт аудит."""
    _check_key(key)
    definition = FIELD_LABELS[key]
    label = normalize_label(label) if label is not None else definition.default_label
    _lock_admin(db, actor)
    row = db.get(ProjectFieldLabel, key, populate_existing=True)
    before = row.label if row is not None else definition.default_label
    if label == definition.default_label:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(ProjectFieldLabel(key=key, label=label))
    else:
        row.label = label
    if before != label:
        audit.record(
            db, actor.id, "reset" if label == definition.default_label else "update", "project_field_label",
            key=key, before=before, after=label, author_name=actor.full_name,
        )
    db.commit()
    return {
        "key": key, "label": label, "default_label": definition.default_label,
        "suffix": definition.suffix, "is_overridden": label != definition.default_label,
    }


def with_snapshot_field_labels(
    snapshot: dict, labels: Mapping[str, str], *, keys: Iterable[str] | None = None,
) -> dict:
    """Снимок копирует подписи независимо от последующих override и reset."""
    return {
        **snapshot,
        "_field_labels": {
            key: labels.get(key, FIELD_LABELS[key].default_label)
            for key in (snapshot if keys is None else keys) if key in FIELD_LABELS
        },
    }


def historical_field_label(key: str, snapshot: dict) -> str:
    """Только подписи снимка либо фиксированные исходные подписи, без чтения БД."""
    definition = FIELD_LABELS[key]
    labels = snapshot.get("_field_labels")
    value = labels.get(key) if isinstance(labels, dict) else None
    if isinstance(value, str):
        try:
            return normalize_label(value)
        except ValueError:
            pass
    return definition.legacy_label or definition.default_label


def project_field_heading(key: str, labels: Mapping[str, str]) -> str:
    """Заголовок текущего поля с неизменяемыми единицами."""
    definition = FIELD_LABELS[key]
    return labels.get(key, definition.default_label) + definition.suffix


def same_project_values(before: dict, after: dict) -> bool:
    metadata = {"_labels", "_field_labels"}
    return {key: value for key, value in before.items() if key not in metadata} == {
        key: value for key, value in after.items() if key not in metadata
    }
