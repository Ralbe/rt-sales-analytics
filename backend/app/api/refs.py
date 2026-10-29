from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, manager_scope
from app.models import (
    ROLE_LABELS,
    STAGE_DEFAULT_PROBABILITY,
    STAGE_LABELS,
    Project,
    ReferenceValue,
    Role,
    Segment,
    Service,
    User,
)
from app.schemas import RefsOut
from app.services.project_field_labels import with_project_field_labels

router = APIRouter(prefix="/refs", tags=["refs"])


@router.get("", response_model=RefsOut)
def refs(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Все справочники для выпадающих списков одним запросом."""
    reference_values = db.scalars(
        select(ReferenceValue).where(ReferenceValue.is_active).order_by(ReferenceValue.position, ReferenceValue.id)
    ).all()
    by_category: dict[str, list[ReferenceValue]] = {}
    for value in reference_values:
        by_category.setdefault(value.category, []).append(value)
    segments = db.scalars(select(Segment).order_by(Segment.name)).all()
    services = db.scalars(select(Service).order_by(Service.group_name, Service.name)).all()
    visible_projects = select(Project.manager_id)
    if user.role != Role.admin:
        visible_projects = visible_projects.where(Project.archived_at.is_(None))
    scope = manager_scope(user)
    if scope is not None:
        visible_projects = visible_projects.where(Project.manager_id == scope)

    return with_project_field_labels(db, {
        "segments": [row for row in segments if row.is_active],
        "services": [row for row in services if row.is_active],
        "filter_segments": segments,
        "filter_services": services,
        "managers": db.scalars(
            select(User).where(User.is_active).order_by(User.full_name)
        ).all(),
        "filter_managers": db.scalars(
            select(User).where(or_(User.is_active.is_(True), User.id.in_(visible_projects)))
            .order_by(User.full_name, User.id)
        ).all(),
        "stages": [
            {"id": s.value, "name": label, "probability": STAGE_DEFAULT_PROBABILITY[s]}
            for s, label in STAGE_LABELS.items()
        ],
        "payment_types": by_category.get("payment_type", []),
        "assessment_statuses": by_category.get("assessment_status", []),
        "project_indicators": by_category.get("project_indicator", []),
        "customer_stages": by_category.get("customer_stage", []),
        "cost_articles": by_category.get("cost_article", []),
        "cost_types": by_category.get("cost_type", []),
        "revenue_statuses": by_category.get("revenue_status", []),
        "cost_statuses": by_category.get("cost_status", []),
        "roles": [{"id": r.value, "name": label} for r, label in ROLE_LABELS.items()],
    })
