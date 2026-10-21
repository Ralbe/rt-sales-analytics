from sqlalchemy.orm import Session

from app.models import AuditLog


def record(db: Session, user_id: int | None, action: str, entity: str, entity_id: int | None = None, **payload) -> None:
    """Добавляет запись в журнал действий. Коммит выполняет вызывающий код."""
    db.add(AuditLog(user_id=user_id, action=action, entity=entity, entity_id=entity_id, payload=payload))
