from collections import defaultdict
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.projects import _get_visible
from app.db import get_db
from app.deps import get_current_user, manager_scope
from app.models import AuditLog, Project, ReferenceValue, User
from app.services.project_timeline import FINANCE_NOTE, STATISTICS_NOTE, build_intervals, stage_statistics
from app.timeline_schemas import PortfolioStageStatistics, ProjectTimeline, TimelineFinance

router = APIRouter(tags=["project-timeline"])


def _reference_names(db: Session) -> dict[int, str]:
    return dict(db.execute(select(ReferenceValue.id, ReferenceValue.name).where(
        ReferenceValue.category == "customer_stage",
    )).all())


@router.get("/projects/{project_id}/timeline", response_model=ProjectTimeline)
def project_timeline(
    project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> ProjectTimeline:
    project = _get_visible(db, project_id, user)
    now = datetime.now(UTC)
    logs = db.scalars(select(AuditLog).where(
        AuditLog.entity == "project", AuditLog.entity_id == project_id,
    ).order_by(AuditLog.created_at, AuditLog.id)).all()
    intervals, archives, complete = build_intervals(
        project, logs, now=now, reference_names=_reference_names(db),
    )
    notes = [STATISTICS_NOTE, FINANCE_NOTE]
    notes.append("Названия этапов взяты из событий; если старое событие не сохранило название, показано текущее.")
    if not complete:
        notes.insert(0, "История неполная: показаны только известные периоды; пропуски не восстановлены.")
    return ProjectTimeline(
        project_id=project_id, generated_at=now, history_complete=complete, notes=notes,
        intervals=intervals, archived_periods=archives, stage_statistics=stage_statistics(intervals),
        finances=[TimelineFinance(
            id=row.id, kind=row.kind, year=row.year, month=row.month, amount=format(row.amount, ".3f"),
            vat_included=row.vat_included, status=row.status.name,
        ) for row in project.financial_entries],
    )


@router.get("/project-timeline/stage-statistics", response_model=PortfolioStageStatistics)
def portfolio_stage_statistics(
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> PortfolioStageStatistics:
    now = datetime.now(UTC)
    query = select(Project).where(Project.archived_at.is_(None))
    scope = manager_scope(user)
    if scope is not None:
        query = query.where(Project.manager_id == scope)
    projects = db.scalars(query).unique().all()
    # A subquery keeps SQL parameter counts bounded even for large portfolios.
    ids = query.with_only_columns(Project.id).order_by(None)
    logs = db.scalars(select(AuditLog).where(
        AuditLog.entity == "project", AuditLog.entity_id.in_(ids),
    ).order_by(AuditLog.created_at, AuditLog.id)).all()
    grouped = defaultdict(list)
    for log in logs:
        grouped[log.entity_id].append(log)
    references = _reference_names(db)
    intervals = []
    with_history = 0
    for project in projects:
        observed, _, _ = build_intervals(project, grouped[project.id], now=now, reference_names=references)
        with_history += bool(observed)
        intervals.extend(observed)
    return PortfolioStageStatistics(
        generated_at=now, project_count=len(projects), projects_with_history=with_history,
        stage_statistics=stage_statistics(intervals), notes=[
            "Все доступные активные проекты обеих схем стадий. Проекты без истории не дают длительностей.",
            STATISTICS_NOTE,
        ],
    )
