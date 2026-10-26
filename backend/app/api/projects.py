from datetime import UTC, date, datetime
from decimal import Decimal
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core import cache
from app.db import get_db
from app.deps import PROJECT_EDITORS, get_current_user, manager_scope, require_roles
from app.history_schemas import ProjectHistoryPage
from app.models import (
    CLOSED_STAGES,
    STAGE_LABELS,
    AuditLog,
    Client,
    Project,
    ProjectFinancialEntry,
    ReferenceValue,
    Role,
    Service,
    Stage,
    User,
)
from app.schemas import (
    NameCheckOut,
    ProjectFinancialEntryIn,
    ProjectFinancialEntryOut,
    ProjectIn,
    ProjectOut,
    ProjectPage,
)
from app.services import audit
from app.services.project_history import financial_snapshot, history_items, project_snapshot, same_finances

router = APIRouter(prefix="/projects", tags=["projects"])

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


def _xlsx_timestamp(value: datetime) -> str:
    # Excel не поддерживает tzinfo: явный ISO 8601 в UTC сохраняет смысл времени.
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def to_out(p: Project) -> dict:
    margin = p.amount - p.cost
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "client": p.client,
        "client_inn": p.client.inn,
        "segment": p.client.segment,
        "manager": p.manager,
        "service": p.service,
        "stage": p.stage,
        "amount": p.amount,
        "cost": p.cost,
        "margin": margin,
        "margin_pct": round(float(margin / p.amount * 100), 1) if p.amount else None,
        "probability": p.probability,
        "start_date": p.start_date,
        "expected_close_date": p.expected_close_date,
        "closed_at": p.closed_at,
        "payment_type": p.payment_type,
        "customer_stage": p.customer_stage,
        "indicator": p.indicator,
        "accepted_for_forecast": p.accepted_for_forecast,
        "assessment_status": p.assessment_status,
        "subsidiary_implementation": p.subsidiary_implementation,
        "management_control": p.management_control,
        "is_industry_solution": p.is_industry_solution,
        "industry_manager": p.industry_manager,
        "industry_project_number": p.industry_project_number,
        "implementation_year": p.implementation_year,
        "project_status": p.project_status,
        "realized_work": p.realized_work,
        "period_plan": p.period_plan,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "financial_entries": p.financial_entries,
    }


def _filtered_query(
    user: User,
    q: str,
    segment_id: list[int],
    service_id: list[int],
    manager_id: list[int],
    stage: list[Stage],
    open_only: bool,
    customer_stage_id: int | None = None,
    implementation_year: int | None = None,
) -> Select:
    stmt = select(Project).options(selectinload(Project.financial_entries)).join(Client, Client.id == Project.client_id)
    scope = manager_scope(user)
    if scope is not None:
        stmt = stmt.where(Project.manager_id == scope)
    q = q.strip()
    if q:
        stmt = stmt.where(or_(Project.name.ilike(f"%{q}%"), Client.name.ilike(f"%{q}%"), Client.inn.startswith(q)))
    if segment_id:
        stmt = stmt.where(Client.segment_id.in_(segment_id))
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
        stmt = stmt.where(Project.stage.notin_(CLOSED_STAGES))
    return stmt


class ListParams:
    def __init__(
        self,
        q: str = Query(default="", max_length=100),
        segment_id: list[int] = Query(default=[]),
        service_id: list[int] = Query(default=[]),
        manager_id: list[int] = Query(default=[]),
        stage: list[Stage] = Query(default=[]),
        open_only: bool = False,
        sort: str = Query(default="-updated_at", pattern=SORT_PATTERN),
        customer_stage_id: int | None = Query(default=None, ge=1),
        implementation_year: int | None = Query(default=None, ge=1900, le=2200),
    ):
        self.q, self.segment_id, self.service_id = q, segment_id, service_id
        self.manager_id, self.stage, self.open_only, self.sort = manager_id, stage, open_only, sort
        self.customer_stage_id, self.implementation_year = customer_stage_id, implementation_year

    def query(self, user: User) -> Select:
        stmt = _filtered_query(
            user, self.q, self.segment_id, self.service_id, self.manager_id, self.stage, self.open_only,
            self.customer_stage_id, self.implementation_year,
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
    return {"items": [to_out(p) for p in items], "total": total, "page": page, "size": size}


@router.get("/check-name", response_model=NameCheckOut)
def check_name(
    name: str = Query(min_length=1, max_length=300),
    client_id: int = Query(),
    exclude_id: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """Проверка на дубль во время ввода (до отправки формы)."""
    return {"available": _find_duplicate(db, " ".join(name.split()), client_id, exclude_id) is None}


@router.get("/export.xlsx")
def export_projects(
    params: ListParams = Depends(),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(Role.analyst, Role.admin)),
) -> StreamingResponse:
    projects = db.scalars(params.query(user).limit(EXPORT_LIMIT)).unique().all()
    wb = Workbook()
    ws = wb.active
    ws.title = "Проекты"
    headers = [
        "ID",
        "Проект",
        "Клиент",
        "ИНН",
        "Сегмент",
        "Услуга",
        "Ответственный",
        "Стадия",
        "Сумма, ₽",
        "Себестоимость, ₽",
        "Маржа, ₽",
        "Вероятность, %",
        "Начало",
        "План закрытия",
        "Закрыт",
        "Тип платежа",
        "Этап по ТЗ",
        "Индикатор",
        "Принимаемый к прогнозу",
        "Принимаемый к оценке",
        "Реализация через ДЗО",
        "Контроль руководства",
        "Отраслевое решение",
        "Отраслевой менеджер",
        "Номер отраслевого проекта",
        "Год реализации",
        "Статус проекта",
        "Сделано за период",
        "Планы на период",
        "Создан (UTC)",
    ]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for p in projects:
        ws.append(
            [
                p.id,
                p.name,
                p.client.name,
                p.client.inn,
                p.client.segment.name,
                p.service.name,
                p.manager.full_name,
                STAGE_LABELS[p.stage],
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
                _xlsx_timestamp(p.created_at),
            ]
        )
        # Пользовательский текст должен оставаться текстом, даже если начинается с '='.
        for cell in ws[ws.max_row]:
            if cell.data_type == "f":
                cell.data_type = "s"
    widths = [7, 40, 35, 14, 22, 26, 24, 16, 16, 16, 16, 12, 12, 14, 12] + [22] * (len(headers) - 15)
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


def _get_visible(db: Session, project_id: int, user: User) -> Project:
    project = db.get(Project, project_id)
    scope = manager_scope(user)
    if project is None or (scope is not None and project.manager_id != scope):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проект не найден")
    return project


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return to_out(_get_visible(db, project_id, user))


@router.get("/{project_id}/history", response_model=ProjectHistoryPage)
def get_project_history(
    project_id: int,
    limit: int = Query(default=10, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    _get_visible(db, project_id, user)
    rows = db.execute(
        select(AuditLog, User.full_name)
        .outerjoin(User, User.id == AuditLog.user_id)
        .where(AuditLog.entity == "project", AuditLog.entity_id == project_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(offset)
        .limit(limit + 1)
    ).all()
    return {"items": history_items(db, rows[:limit]), "limit": limit, "offset": offset, "has_more": len(rows) > limit}


def _find_duplicate(db: Session, name: str, client_id: int, exclude_id: int | None) -> Project | None:
    # Сравнение без учёта регистра в Python: одинаково работает с кириллицей в любой СУБД.
    # Проектов у одного клиента немного, поэтому выборка дешёвая.
    stmt = select(Project).where(Project.client_id == client_id)
    if exclude_id is not None:
        stmt = stmt.where(Project.id != exclude_id)
    key = name.casefold()
    return next((p for p in db.scalars(stmt).unique() if p.name.casefold() == key), None)


def _apply(db: Session, project: Project, data: ProjectIn, user: User) -> None:
    if db.get(Client, data.client_id) is None:
        raise HTTPException(422, {"field": "client_id", "message": "Клиент не найден"})
    if db.get(Service, data.service_id) is None:
        raise HTTPException(422, {"field": "service_id", "message": "Услуга не найдена"})

    expected_categories = {
        "payment_type_id": "payment_type",
        "customer_stage_id": "customer_stage",
        "indicator_id": "project_indicator",
        "assessment_status_id": "assessment_status",
    }
    references: dict[str, ReferenceValue] = {}
    for field, category in expected_categories.items():
        reference_id = getattr(data, field)
        if reference_id is None:
            continue
        reference = db.get(ReferenceValue, reference_id)
        if reference is None or not reference.is_active or reference.category != category:
            raise HTTPException(422, {"field": field, "message": "Значение справочника не найдено"})
        references[field] = reference

    if user.role == Role.user:
        manager_id = user.id
    else:
        manager_id = data.manager_id or user.id
        manager = db.get(User, manager_id)
        if manager is None or not manager.is_active:
            raise HTTPException(422, {"field": "manager_id", "message": "Ответственный не найден"})

    if _find_duplicate(db, data.name, data.client_id, project.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, {"field": "name", "message": "У этого клиента уже есть проект с таким названием"}
        )

    was_closed = project.stage in CLOSED_STAGES if project.stage else False
    for field, value in data.model_dump(exclude={"manager_id"}).items():
        setattr(project, field, value)
    customer_stage = references.get("customer_stage_id")
    if customer_stage is not None:
        if customer_stage.probability is None:
            raise HTTPException(422, {"field": "customer_stage_id", "message": "У этапа не задана вероятность"})
        project.probability = customer_stage.probability
    project.manager_id = manager_id
    if data.stage in CLOSED_STAGES:
        if not was_closed or project.closed_at is None:
            project.closed_at = max(date.today(), data.start_date)
    else:
        project.closed_at = None


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    data: ProjectIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> dict:
    project = Project(cost=Decimal("0"))
    _apply(db, project, data, user)
    db.add(project)
    db.flush()
    audit.record(
        db, user.id, "create", "project", project.id,
        name=project.name, after=project_snapshot(db, project), author_name=user.full_name,
    )
    db.commit()
    cache.bump("analytics")
    db.refresh(project)
    return to_out(project)


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    data: ProjectIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*PROJECT_EDITORS)),
) -> dict:
    project = _get_visible(db, project_id, user)
    before = project_snapshot(db, project)
    _apply(db, project, data, user)
    after = project_snapshot(db, project)
    if {key: value for key, value in before.items() if key != "_labels"} != {
        key: value for key, value in after.items() if key != "_labels"
    }:
        audit.record(
            db, user.id, "update", "project", project.id,
            before=before, after=after, author_name=user.full_name,
        )
    db.commit()
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
    project = _get_visible(db, project_id, user)
    if len(entries) > 500:
        raise HTTPException(422, "Не более 500 финансовых строк на проект")
    category_fields = {
        "revenue": {"status_id": "revenue_status"},
        "cost": {"status_id": "cost_status", "article_id": "cost_article", "cost_type_id": "cost_type"},
    }
    references = []
    for entry in entries:
        row_refs = {}
        for field, category in category_fields[entry.kind].items():
            ref_id = getattr(entry, field)
            if ref_id is None and entry.kind == "cost" and field != "status_id":
                raise HTTPException(422, {"field": field, "message": "Обязательное поле"})
            ref = db.get(ReferenceValue, ref_id) if ref_id is not None else None
            if ref is not None and (not ref.is_active or ref.category != category):
                raise HTTPException(
                    422, {"field": field, "message": "Справочник не соответствует типу финансовой строки"}
                )
            if ref is None:
                raise HTTPException(422, {"field": field, "message": "Значение справочника не найдено"})
            row_refs[field] = ref
        references.append(row_refs)
    before = [financial_snapshot(row) for row in project.financial_entries]
    after = [financial_snapshot(entry, ref) for entry, ref in zip(entries, references, strict=True)]
    if same_finances(before, after):
        return project.financial_entries
    project.financial_entries.clear()
    db.flush()
    project.financial_entries.extend(
        ProjectFinancialEntry(
            kind=entry.kind,
            year=entry.year,
            month=entry.month,
            amount=entry.amount,
            vat_included=entry.vat_included,
            status=ref["status_id"],
            article=ref.get("article_id"),
            cost_type=ref.get("cost_type_id"),
        )
        for entry, ref in zip(entries, references, strict=True)
    )
    project.updated_at = func.now()
    audit.record(
        db,
        user.id,
        "replace_financial_entries",
        "project",
        project.id,
        before=before,
        after=after,
        author_name=user.full_name,
    )
    db.commit()
    db.refresh(project)
    return project.financial_entries
