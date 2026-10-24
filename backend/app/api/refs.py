from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import ROLE_LABELS, STAGE_DEFAULT_PROBABILITY, STAGE_LABELS, ReferenceValue, Segment, Service, User
from app.schemas import RefsOut

router = APIRouter(prefix="/refs", tags=["refs"])


@router.get("", response_model=RefsOut)
def refs(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    """Все справочники для выпадающих списков одним запросом."""
    reference_values = db.scalars(
        select(ReferenceValue).where(ReferenceValue.is_active).order_by(ReferenceValue.position, ReferenceValue.id)
    ).all()
    by_category: dict[str, list[ReferenceValue]] = {}
    for value in reference_values:
        by_category.setdefault(value.category, []).append(value)

    return {
        "segments": db.scalars(select(Segment).order_by(Segment.name)).all(),
        "services": db.scalars(select(Service).order_by(Service.group_name, Service.name)).all(),
        "managers": db.scalars(
            select(User).where(User.is_active).order_by(User.full_name)
        ).all(),
        "stages": [
            {"id": s.value, "name": label, "probability": STAGE_DEFAULT_PROBABILITY[s]}
            for s, label in STAGE_LABELS.items()
        ],
        "payment_types": by_category.get("payment_type", []),
        "assessment_statuses": by_category.get("assessment_status", []),
        "project_indicators": by_category.get("project_indicator", []),
        "customer_stages": by_category.get("customer_stage", []),
        "roles": [{"id": r.value, "name": label} for r, label in ROLE_LABELS.items()],
    }
