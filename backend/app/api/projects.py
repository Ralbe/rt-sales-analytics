from datetime import date
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import cache
from app.db import get_db
from app.deps import PROJECT_EDITORS, get_current_user, lock_actor, require_roles
from app.history_schemas import ProjectHistoryPage
from app.models import (
    AuditLog,
    Project,
    ProjectFinancialEntry,
    Role,
    Stage,
    User,
)
from app.project_write_schemas import ProjectSaveIn
from app.schemas import (
    GanttOut,
    NameCheckOut,
    ProjectFinancialEntryIn,
    ProjectFinancialEntryOut,
    ProjectOut,
    ProjectPage,
)
from app.services import audit, pipeline
from app.services.project_field_labels import (
    effective_project_field_labels,
    same_project_values,
)
from app.services.project_history import financial_snapshot, history_items, project_snapshot
from app.services.projects import (
    EXPORT_LIMIT,
    SORT_FIELDS,
    SORT_PATTERN,
    apply_project_data,
    build_filtered_query,
    build_project_update_audit_metadata,
    check_integrity_conflict,
    find_duplicate_project,
    generate_projects_xlsx,
    get_visible_project,
    lock_project_references,
    replace_financial_entries_impl,
    require_active_project,
    set_project_archived,
    to_project_out_dict,
    validate_financial_entries,
    xlsx_timestamp,
)

# Re-exports for backward compatibility (tests and other modules)
_xlsx_timestamp = xlsx_timestamp
to_out = to_project_out_dict
_filtered_query = build_filtered_query
_get_visible = get_visible_project
_require_active = require_active_project
_find_duplicate = find_duplicate_project
_check_integrity_conflict = check_integrity_conflict
_lock_references = lock_project_references
_validate_financial_entries = validate_financial_entries
_replace_financial_entries = replace_financial_entries_impl
_apply = apply_project_data

router = APIRouter(prefix="/projects", tags=["projects"])


class ListParams:
    def __init__(
        self,
        q: str = Query(default="", max_length=100),
        segment_id: list[int] = Query(default=[]),
        service_id: list[int] = Query(default=[]),
        manager_id: list[int] = Query(default=[]),
        stage: list[Stage] = Query(default=[]),
        open_only: bool = False,
        archived: bool = False,
        sort: str = Query(default="-updated_at", pattern=SORT_PATTERN),
        customer_stage_id: int | None = Query(default=None, ge=1),
        implementation_year: int | None = Query(default=None, ge=1900, le=2200),
        date_from: date | None = None,
        date_to: date | None = None,
        period_preset: Literal["week", "month", "quarter", "custom"] | None = None,
    ):
        if (date_from is None) != (date_to is None) or (period_preset is not None and date_from is None):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Укажите начало и конец периода")
        if date_from is not None and date_to is not None:
            if date_from > date_to:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Начало периода не может быть позже конца")
            if (date_to - date_from).days > 36600:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Период не может превышать 36600 дней")
        self.q, self.segment_id, self.service_id = q, segment_id, service_id
        self.manager_id, self.stage, self.open_only, self.sort = manager_id, stage, open_only, sort
        self.archived = archived
        self.customer_stage_id, self.implementation_year = customer_stage_id, implementation_year

    def query(self, user: User) -> Select:
        stmt = build_filtered_query(
            user, self.q, self.segment_id, self.service_id, self.manager_id, self.stage, self.open_only,
            archived=self.archived, customer_stage_id=self.customer_stage_id,
            implementation_year=self.implementation_year,
        )
        field = self.sort.lstrip("-")
        column = SORT_FIELDS[field]
        order = column.desc() if self.sort.startswith("-") else column.asc()
        if field in {"customer_stage_id", "implementation_year"}:
            order = order.nulls_last()
        return stmt.order_by(order, Project.id.desc())


@router.get("", response_model=ProjectPage)
def list_projects(
    params: ListParams = Depends(),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    stmt = params.query(user)
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    items = db.scalars(stmt.offset((page - 1) * size).limit(size)).unique().all()
    return {
        "items": [to_project_out_dict(p) for p in items],
        "total": total,
        "page": page,
        "size": size,
        "stage_scope": "all",
        "scope_note": None,
    }


@router.get("/check-name", response_model=NameCheckOut)
def check_name(
    name: str = Query(min_length=1, max_length=300),
    client_id: int = Query(),
    exclude_id: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """Проверка на дубль во время ввода (до отправки формы)."""
    return {"available": find_duplicate_project(db, " ".join(name.split()), client_id, exclude_id) is None}


@router.get("/export.xlsx")
def export_projects(
    params: ListParams = Depends(),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(Role.analyst, Role.admin)),
) -> StreamingResponse:
    projects = db.scalars(params.query(user).limit(EXPORT_LIMIT + 1)).unique().all()
    if len(projects) > EXPORT_LIMIT:
        raise HTTPException(422, "В выборке больше 10 000 проектов. Уточните фильтры перед выгрузкой")
    return generate_projects_xlsx(projects, db)


def _set_archived(db: Session, project_id: int, user: User, *, archived: bool) -> dict:
    project = _get_visible(db, project_id, user, for_update=True)
    if (project.archived_at is not None) == archived:
        return to_out(project)
    set_project_archived(db, project, user, archived=archived)
    db.commit()
    cache.bump("analytics")
    db.refresh(project)
    return to_out(project)


@router.post("/{project_id}/archive", response_model=ProjectOut)
def archive_project(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(Role.admin)),
) -> dict:
    user = lock_actor(db, user, roles={Role.admin})
    return _set_archived(db, project_id, user, archived=True)


@router.post("/{project_id}/restore", response_model=ProjectOut)
def restore_project(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(Role.admin)),
) -> dict:
    user = lock_actor(db, user, roles={Role.admin})
    return _set_archived(db, project_id, user, archived=False)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return to_project_out_dict(get_visible_project(db, project_id, user))


@router.get("/{project_id}/gantt", response_model=GanttOut)
def get_project_gantt(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    project = get_visible_project(db, project_id, user)
    return pipeline.gantt(db, project, date.today())


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(Role.admin)),
) -> None:
    """Окончательно удаляет проект из архива. Журнал сохраняет снимок карточки и финансов."""
    user = lock_actor(db, user, roles={Role.admin})
    project = get_visible_project(db, project_id, user, for_update=True)
    if project.archived_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Сначала переместите проект в архив")
    field_labels = effective_project_field_labels(db)
    audit.record(
        db, user.id, "delete", "project", project.id,
        name=project.name,
        before=project_snapshot(db, project, field_labels=field_labels),
        financial_entries=[financial_snapshot(row, field_labels=field_labels) for row in project.financial_entries],
        author_name=user.full_name,
    )
    db.delete(project)
    db.commit()
    cache.bump("analytics")


@router.get("/{project_id}/history", response_model=ProjectHistoryPage)
def get_project_history(
    project_id: int,
    limit: int = Query(default=10, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    get_visible_project(db, project_id, user)
    rows = db.execute(
        select(AuditLog, User.full_name)
        .outerjoin(User, User.id == AuditLog.user_id)
        .where(AuditLog.entity == "project", AuditLog.entity_id == project_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(offset)
        .limit(limit + 1)
    ).all()
    return {"items": history_items(db, rows[:limit]), "limit": limit, "offset": offset, "has_more": len(rows) > limit}


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    data: ProjectSaveIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> dict:
    user = lock_actor(db, user, roles=PROJECT_EDITORS)
    project = Project(cost=Decimal("0"), stage_scheme="customer")
    try:
        locked_refs = _lock_references(db, data, data.financial_entries or [])
        references = _validate_financial_entries(data.financial_entries or [], locked_refs)
        _apply(db, project, data, user, locked_refs)
        db.add(project)
        db.flush()
        audit.record(
            db, user.id, "create", "project", project.id,
            name=project.name, after=project_snapshot(db, project), author_name=user.full_name,
        )
        if data.financial_entries is not None:
            _replace_financial_entries(db, project, data.financial_entries, references, user)
        db.commit()
    except IntegrityError:
        _check_integrity_conflict(db, data)
        raise
    except Exception:
        db.rollback()
        raise
    cache.bump("analytics")
    db.refresh(project)
    return to_out(project)


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    data: ProjectSaveIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> dict:
    user = lock_actor(db, user, roles=PROJECT_EDITORS)
    project = _get_visible(db, project_id, user, for_update=True)
    _require_active(project)
    try:
        locked_refs = _lock_references(db, data, data.financial_entries or [])
        references = _validate_financial_entries(data.financial_entries or [], locked_refs, project)
        field_labels = effective_project_field_labels(db)
        old_stage_id = project.customer_stage_id
        old_probability = project.probability
        before = project_snapshot(db, project, field_labels=field_labels)
        _apply(db, project, data, user, locked_refs)
        after = project_snapshot(db, project, field_labels=field_labels)
        changed = not same_project_values(before, after)
        if changed:
            extra_audit = build_project_update_audit_metadata(
                db, project, data, old_stage_id, old_probability, locked_refs
            )
            audit.record(
                db, user.id, "update", "project", project.id,
                before=before, after=after, author_name=user.full_name, **extra_audit,
            )
        if data.financial_entries is not None:
            finances_changed = _replace_financial_entries(db, project, data.financial_entries, references, user)
            changed = changed or finances_changed
        db.commit()
    except IntegrityError:
        _check_integrity_conflict(db, data, project_id)
        raise
    except Exception:
        db.rollback()
        raise
    if changed:
        cache.bump("analytics")
    db.refresh(project)
    return to_out(project)


@router.put("/{project_id}/financial-entries", response_model=list[ProjectFinancialEntryOut])
def replace_financial_entries(
    project_id: int,
    entries: list[ProjectFinancialEntryIn],
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> list[ProjectFinancialEntry]:
    user = lock_actor(db, user, roles=PROJECT_EDITORS)
    project = _get_visible(db, project_id, user, for_update=True)
    _require_active(project)
    try:
        locked_refs = _lock_references(db, None, entries)
        references = _validate_financial_entries(entries, locked_refs, project)
        changed = _replace_financial_entries(db, project, entries, references, user)
        if not changed:
            return project.financial_entries
        db.commit()
    except Exception:
        db.rollback()
        raise
    cache.bump("analytics")
    db.refresh(project)
    return project.financial_entries
