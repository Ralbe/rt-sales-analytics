from datetime import UTC, date, datetime
from io import BytesIO

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import manager_scope
from app.models import (
    CLOSED_STAGES,
    STAGE_LABELS,
    Client,
    Project,
    ReferenceValue,
    Role,
    Stage,
    User,
)
from app.services.project_field_label_export import PROJECT_EXPORT_FIELDS, write_project_export_headers
from app.services.project_field_labels import effective_project_field_labels

SORT_FIELDS = {
    "name": Project.name,
    "client_inn": Client.inn,
    "implementation_year": Project.implementation_year,
    "customer_stage_id": Project.customer_stage_id,
    "amount": Project.amount,
    "start_date": Project.start_date,
    "expected_close_date": Project.expected_close_date,
    "updated_at": Project.updated_at,
}
SORT_PATTERN = (
    r"^-?(name|client_inn|implementation_year|customer_stage_id|"
    r"amount|start_date|expected_close_date|updated_at)$"
)
EXPORT_LIMIT = 10_000


def xlsx_timestamp(value: datetime) -> str:
    # Excel не поддерживает tzinfo: явный ISO 8601 в UTC сохраняет смысл времени.
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def build_filtered_query(
    user: User,
    q: str,
    segment_id: list[int],
    service_id: list[int],
    manager_id: list[int],
    stage: list[Stage],
    open_only: bool,
    archived: bool = False,
    customer_stage_id: int | None = None,
    implementation_year: int | None = None,
) -> Select:
    stmt = select(Project).options(selectinload(Project.financial_entries)).join(Client, Client.id == Project.client_id)
    if archived and user.role != Role.admin:
        raise HTTPException(403, "Архив доступен только администратору")
    stmt = stmt.where(Project.archived_at.is_not(None) if archived else Project.archived_at.is_(None))
    scope = manager_scope(user)
    if scope is not None:
        stmt = stmt.where(Project.manager_id == scope)
    q = q.strip()
    if q:
        stmt = stmt.where(or_(Project.name.ilike(f"%{q}%"), Client.name.ilike(f"%{q}%"), Client.inn.startswith(q)))
    if segment_id:
        stmt = stmt.where(func.coalesce(Project.segment_id, Client.segment_id).in_(segment_id))
    if service_id:
        stmt = stmt.where(Project.service_id.in_(service_id))
    if manager_id:
        stmt = stmt.where(Project.manager_id.in_(manager_id))
    if stage:
        stmt = stmt.where(Project.stage.in_(stage))
    if customer_stage_id is not None:
        stmt = stmt.where(Project.customer_stage_id == customer_stage_id)
    if implementation_year is not None:
        stmt = stmt.where(Project.implementation_year == implementation_year)
    if open_only:
        stmt = stmt.where(or_(
            (Project.stage_scheme == "legacy") & Project.stage.notin_(CLOSED_STAGES),
            (Project.stage_scheme == "customer") & Project.customer_stage.has(ReferenceValue.code != "success"),
        ))
    return stmt


def get_visible_project(
    db: Session, project_id: int, user: User, *, for_update: bool = False
) -> Project:
    query = select(Project).where(Project.id == project_id)
    if for_update:
        query = query.with_for_update(of=Project).execution_options(populate_existing=True)
    project = db.scalar(query)
    scope = manager_scope(user)
    if (project is None or (scope is not None and project.manager_id != scope)
            or (project.archived_at is not None and user.role != Role.admin)):
        raise HTTPException(404, "Проект не найден")
    return project


def require_active_project(project: Project) -> None:
    if project.archived_at is not None:
        raise HTTPException(409, "Сначала восстановите проект из архива")


def generate_projects_xlsx(projects: list[Project], db: Session) -> StreamingResponse:
    wb = Workbook()
    ws = wb.active
    ws.title = "Проекты"
    write_project_export_headers(ws, effective_project_field_labels(db))
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for p in projects:
        ws.append(
            [
                p.id,
                p.name,
                p.client.name,
                p.client.inn,
                (p.segment or p.client.segment).name,
                p.service.name,
                p.manager.full_name,
                STAGE_LABELS[p.stage] if p.stage is not None else "Не применяется",
                float(p.amount),
                float(p.cost),
                float(p.amount - p.cost),
                p.probability,
                p.start_date,
                p.expected_close_date,
                p.closed_at,
                p.payment_type.name if p.payment_type else None,
                p.customer_stage.name if p.customer_stage else None,
                p.indicator.name if p.indicator else None,
                p.accepted_for_forecast,
                p.assessment_status.name if p.assessment_status else None,
                p.subsidiary_implementation,
                p.management_control,
                p.is_industry_solution,
                p.industry_manager,
                p.industry_project_number,
                p.implementation_year,
                p.project_status,
                p.realized_work,
                p.period_plan,
                xlsx_timestamp(p.created_at),
            ]
        )
        # Пользовательский текст должен оставаться текстом, даже если начинается с '='.
        for cell in ws[ws.max_row]:
            if cell.data_type == "f":
                cell.data_type = "s"
    widths = [7, 40, 35, 14, 22, 26, 24, 16, 16, 16, 16, 12, 12, 14, 12] + [22] * (len(PROJECT_EXPORT_FIELDS) - 15)
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="projects_{date.today():%Y%m%d}.xlsx"'},
    )
