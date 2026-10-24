from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import ROLE_LABELS, STAGE_DEFAULT_PROBABILITY, STAGE_LABELS, Segment, Service, User
from app.schemas import RefsOut

router = APIRouter(prefix="/refs", tags=["refs"])


@router.get("", response_model=RefsOut)
def refs(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    """Все справочники для выпадающих списков одним запросом."""
    return {
        "segments": db.scalars(select(Segment).order_by(Segment.name)).all(),
        "services": db.scalars(select(Service).order_by(Service.name)).all(),
        "managers": db.scalars(
            select(User).where(User.is_active).order_by(User.full_name)
        ).all(),
        "stages": [
            {"id": s.value, "name": label, "probability": STAGE_DEFAULT_PROBABILITY[s]}
            for s, label in STAGE_LABELS.items()
        ],
        "roles": [{"id": r.value, "name": label} for r, label in ROLE_LABELS.items()],
    }
