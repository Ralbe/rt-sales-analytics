from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_roles
from app.models import Role, User
from app.project_field_label_schemas import ProjectFieldLabelOut, ProjectFieldLabelUpdate
from app.services.project_field_labels import (
    effective_project_field_labels,
    field_label_items,
    save_project_field_label,
)

router = APIRouter(prefix="/project-fields", tags=["project-field-labels"])


@router.get("", response_model=list[ProjectFieldLabelOut])
def list_labels(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    return field_label_items(effective_project_field_labels(db))


@router.put("/{key}", response_model=ProjectFieldLabelOut)
def update_label(
    key: str, data: ProjectFieldLabelUpdate,
    db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin)),
) -> dict:
    return save_project_field_label(db, actor, key, data.label)


@router.delete("/{key}", response_model=ProjectFieldLabelOut)
def reset_label(
    key: str, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.admin)),
) -> dict:
    return save_project_field_label(db, actor, key, None)
