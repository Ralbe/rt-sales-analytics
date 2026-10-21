from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import PROJECT_EDITORS, get_current_user, require_roles
from app.models import Client, Segment, User
from app.schemas import ClientIn, ClientOut
from app.services import audit

router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("", response_model=list[ClientOut])
def search_clients(
    q: str = Query(default="", max_length=100),
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[Client]:
    """Автодополнение: поиск по части названия или началу ИНН."""
    stmt = select(Client).order_by(Client.name).limit(limit)
    q = q.strip()
    if q:
        stmt = stmt.where(or_(Client.name.ilike(f"%{q}%"), Client.inn.startswith(q)))
    return list(db.scalars(stmt).all())


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create_client(
    data: ClientIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> Client:
    if db.get(Segment, data.segment_id) is None:
        raise HTTPException(422, {"field": "segment_id", "message": "Сегмент не найден"})
    existing = db.scalar(select(Client).where(Client.inn == data.inn))
    if existing:
        raise HTTPException(
            status.HTTP_409_CONFLICT, {"field": "inn", "message": f"Клиент с этим ИНН уже есть: {existing.name}"}
        )
    client = Client(**data.model_dump())
    db.add(client)
    db.flush()
    audit.record(db, user.id, "create", "client", client.id, name=client.name)
    db.commit()
    db.refresh(client)
    return client
