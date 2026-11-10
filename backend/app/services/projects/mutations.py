from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from app.models import (
    CLOSED_STAGES,
    AuditLog,
    Client,
    Project,
    ProjectFinancialEntry,
    ReferenceValue,
    Role,
    Segment,
    Service,
    User,
)
from app.schemas import ProjectFinancialEntryIn, ProjectIn
from app.services import audit
from app.services.pipeline import SUCCESS_STAGE_CODE
from app.services.project_field_labels import (
    effective_project_field_labels,
    with_snapshot_field_labels,
)
from app.services.project_history import (
    financial_snapshot,
    same_finances,
)


def previous_stage_probabilities(db: Session, project: Project) -> dict[int, int | None]:
    """Возвращает последнюю фактически сохранённую вероятность для каждого посещённого этапа проекта."""
    if project.id is None or project.stage_scheme != "customer":
        return {}
    logs = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity == "project", AuditLog.entity_id == project.id)
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    visited: dict[int, int | None] = {}
    for log in logs:
        if log.action not in {"create", "update", "archive", "restore"} or not isinstance(log.payload, dict):
            continue
        for side in ("before", "after"):
            snap = log.payload.get(side)
            if not isinstance(snap, dict):
                continue
            stage_id = snap.get("customer_stage_id")
            if type(stage_id) is not int:
                continue
            prob = snap.get("probability")
            if type(prob) is int and 0 <= prob <= 100:
                visited[stage_id] = prob
            elif stage_id not in visited:
                visited[stage_id] = None
    return visited


def to_project_out_dict(p: Project) -> dict:
    margin = p.amount - p.cost
    revenue = sum((e.amount for e in p.financial_entries if e.kind == "revenue"), Decimal(0)) * 1000
    costs = sum((e.amount for e in p.financial_entries if e.kind == "cost"), Decimal(0)) * 1000
    months = [date(e.year, e.month, 1) for e in p.financial_entries if e.kind == "revenue" and e.amount > 0]
    session = object_session(p)
    visited = (
        {str(k): v for k, v in previous_stage_probabilities(session, p).items()}
        if session is not None and p.stage_scheme == "customer" and p.id is not None
        else {}
    )
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "client": p.client,
        "client_inn": p.client.inn,
        "segment": p.segment or p.client.segment,
        "manager": p.manager,
        "service": p.service,
        "stage": p.stage,
        "stage_scheme": p.stage_scheme,
        "amount": p.amount,
        "cost": p.cost,
        "margin": margin,
        "revenue": revenue,
        "financial_costs": costs,
        "profit": revenue - costs,
        "last_revenue_month": max(months) if months else None,
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
        "archived_at": p.archived_at,
        "visited_stage_probabilities": visited,
        "financial_entries": p.financial_entries,
    }


def find_duplicate_project(
    db: Session, name: str, client_id: int, exclude_id: int | None
) -> Project | None:
    # Сравнение без учёта регистра в Python: одинаково работает с кириллицей в любой СУБД.
    stmt = select(Project).where(Project.client_id == client_id)
    if exclude_id is not None:
        stmt = stmt.where(Project.id != exclude_id)
    key = name.casefold()
    return next((p for p in db.scalars(stmt).unique() if p.name.casefold() == key), None)


def check_integrity_conflict(
    db: Session, data: ProjectIn, project_id: int | None = None
) -> None:
    db.rollback()
    if find_duplicate_project(db, data.name, data.client_id, project_id) is not None:
        raise HTTPException(
            409, {"field": "name", "message": "У этого клиента уже есть проект с таким названием"}
        ) from None


def lock_project_references(
    db: Session, data: ProjectIn | None, entries: list[ProjectFinancialEntryIn]
) -> dict[int, ReferenceValue]:
    if len(entries) > 500:
        raise HTTPException(422, "Не более 500 финансовых строк на проект")
    ids = {
        value for entry in entries for value in (entry.status_id, entry.article_id, entry.cost_type_id)
        if value is not None
    }
    if data is not None:
        ids.update(value for value in (
            data.payment_type_id, data.customer_stage_id, data.indicator_id, data.assessment_status_id,
        ) if value is not None)
    if not ids:
        return {}
    rows = db.scalars(
        select(ReferenceValue).where(ReferenceValue.id.in_(ids)).order_by(ReferenceValue.id)
        .with_for_update(read=True).execution_options(populate_existing=True)
    ).all()
    return {row.id: row for row in rows}


def validate_financial_entries(
    entries: list[ProjectFinancialEntryIn],
    locked_refs: dict[int, ReferenceValue],
    project: Project | None = None,
) -> list[tuple[dict[str, ReferenceValue], ProjectFinancialEntry | None]]:
    category_fields = {
        "revenue": {"status_id": "revenue_status"},
        "cost": {"status_id": "cost_status", "article_id": "cost_article", "cost_type_id": "cost_type"},
    }
    matches = []
    old_rows = {row.id: row for row in project.financial_entries} if project else {}
    used_ids: set[int] = set()
    reserved_ids = {entry.id for entry in entries if entry.id is not None}
    fields = ("kind", "year", "month", "amount", "vat_included", "status_id", "article_id", "cost_type_id")
    explicit_ids = ["id" in entry.model_fields_set for entry in entries]
    if any(explicit_ids) and not all(explicit_ids):
        raise HTTPException(422, {"field": "id", "message": (
            "Укажите ID для каждой финансовой строки: число для существующей, null для новой."
        )})
    explicit_protocol = bool(entries) and all(explicit_ids)
    for entry in entries:
        old = old_rows.get(entry.id) if entry.id is not None else None
        if entry.id is not None:
            if old is None or entry.id in used_ids:
                raise HTTPException(422, {"field": "id", "message": "Недопустимый или повторный ID финансовой строки"})
            used_ids.add(entry.id)
        elif not explicit_protocol:
            old = next((row for row in old_rows.values() if row.id not in used_ids and row.id not in reserved_ids
                        and all(getattr(row, field) == getattr(entry, field) for field in fields)), None)
            if old is not None:
                used_ids.add(old.id)
        if entry.kind == "revenue":
            for field in ("article_id", "cost_type_id"):
                if getattr(entry, field) is not None:
                    raise HTTPException(422, {"field": field, "message": "Поле допустимо только для затрат"})
        row_refs = {}
        for field, category in category_fields[entry.kind].items():
            ref_id = getattr(entry, field)
            if ref_id is None and entry.kind == "cost" and field != "status_id":
                raise HTTPException(422, {"field": field, "message": "Обязательное поле"})
            ref = locked_refs.get(ref_id)
            retained = old is not None and old.kind == entry.kind and getattr(old, field) == ref_id
            if ref is not None and not ref.is_active and not retained and entry.id is None and project is not None:
                raise HTTPException(422, {"field": field, "message": (
                    "Неактивное значение нельзя назначить новой строке. Чтобы изменить существующую строку, "
                    "загрузите карточку заново и передайте её ID."
                )})
            if ref is not None and ((not ref.is_active and not retained) or ref.category != category):
                raise HTTPException(
                    422, {"field": field, "message": "Справочник не соответствует типу финансовой строки"},
                )
            if ref is None:
                raise HTTPException(422, {"field": field, "message": "Значение справочника не найдено"})
            row_refs[field] = ref
        matches.append((row_refs, old))

    unmatched_old = [row for row in old_rows.values() if row.id not in used_ids]
    new_without_id = any(entry.id is None and old is None for entry, (_, old) in zip(entries, matches, strict=True))
    ambiguous_duplicate = any(
        entry.id is None and old is not None
        and any(all(getattr(row, field) == getattr(entry, field) for field in fields) for row in unmatched_old)
        for entry, (_, old) in zip(entries, matches, strict=True)
    )
    if not explicit_protocol and unmatched_old and (new_without_id or ambiguous_duplicate):
        raise HTTPException(422, {"field": "id", "message": (
            "Неоднозначное изменение финансовых строк. Обновите карточку и передайте ID существующих строк; "
            "удаление и добавление без ID выполните раздельно."
        )})
    return matches


def apply_project_data(
    db: Session,
    project: Project,
    data: ProjectIn,
    user: User,
    locked_refs: dict[int, ReferenceValue],
) -> None:
    customer = project.stage_scheme == "customer"
    stage_changed = customer and (project.id is None or data.customer_stage_id != project.customer_stage_id)
    if customer:
        if data.stage is not None:
            raise HTTPException(422, {
                "field": "stage", "message": "Для новых проектов выберите этап по ТЗ; прежняя стадия не применяется",
            })
        if data.customer_stage_id is None:
            raise HTTPException(422, {"field": "customer_stage_id", "message": "Выберите этап по ТЗ"})
    else:
        if "customer_stage_id" in data.model_fields_set and data.customer_stage_id != project.customer_stage_id:
            raise HTTPException(422, {
                "field": "customer_stage_id", "message": "Вспомогательный этап прежнего проекта изменять нельзя",
            })
        if "stage" in data.model_fields_set and data.stage is None:
            raise HTTPException(422, {"field": "stage", "message": "Укажите прежнюю стадию проекта"})
        if "probability" in data.model_fields_set and data.probability is None:
            raise HTTPException(422, {"field": "probability", "message": "Укажите вероятность проекта"})
    client = db.get(Client, data.client_id)
    if client is None:
        raise HTTPException(422, {"field": "client_id", "message": "Клиент не найден"})
    service = db.scalar(
        select(Service).where(Service.id == data.service_id).with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    retained_service = project.id is not None and data.service_id == project.service_id
    if service is None or (not service.is_active and not retained_service):
        raise HTTPException(422, {"field": "service_id", "message": "Услуга не найдена"})

    segment_supplied = "segment_id" in data.model_fields_set
    if segment_supplied and data.segment_id is None:
        raise HTTPException(422, {"field": "segment_id", "message": "Выберите сегмент проекта"})
    previous_segment_id = (project.segment_id or project.client.segment_id) if project.id is not None else None
    selected_segment_id = (data.segment_id if segment_supplied else
                           previous_segment_id if project.id is not None else client.segment_id)
    segment = db.scalar(
        select(Segment).where(Segment.id == selected_segment_id).with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    retained_segment = project.id is not None and selected_segment_id == previous_segment_id
    inherited_client_segment = project.id is None and not segment_supplied
    if segment is None or (not segment.is_active and not retained_segment and not inherited_client_segment):
        raise HTTPException(422, {"field": "segment_id", "message": "Сегмент не найден или отключён"})

    expected_categories = {
        "payment_type_id": "payment_type",
        "customer_stage_id": "customer_stage",
        "indicator_id": "project_indicator",
        "assessment_status_id": "assessment_status",
    }
    references: dict[str, ReferenceValue] = {}
    for field, category in expected_categories.items():
        if field == "customer_stage_id" and not customer:
            continue
        reference_id = getattr(data, field)
        if reference_id is None:
            continue
        reference = locked_refs.get(reference_id)
        retained = project.id is not None and reference_id == getattr(project, field)
        if reference is None or (not reference.is_active and not retained) or reference.category != category:
            raise HTTPException(422, {"field": field, "message": "Значение справочника не найдено"})
        references[field] = reference

    if user.role == Role.user:
        manager_id = user.id
    else:
        manager_id = data.manager_id if data.manager_id is not None else (
            project.manager_id if project.id is not None else user.id
        )
        manager = db.scalar(
            select(User).where(User.id == manager_id).with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        retained_manager = project.id is not None and manager_id == project.manager_id
        if manager is None or (not manager.is_active and not retained_manager):
            raise HTTPException(422, {"field": "manager_id", "message": "Ответственный не найден"})

    if find_duplicate_project(db, data.name, data.client_id, project.id):
        raise HTTPException(
            409, {"field": "name", "message": "У этого клиента уже есть проект с таким названием"}
        )

    customer_stage = references.get("customer_stage_id")
    if stage_changed and customer_stage is not None and customer_stage.probability is None:
        raise HTTPException(422, {"field": "customer_stage_id", "message": "У этапа не задана вероятность"})

    probability_mode = getattr(data, "probability_mode", None)
    probability_override = getattr(data, "probability_override", None)

    if probability_override is not None:
        if user.role != Role.admin:
            raise HTTPException(
                403,
                {"field": "probability", "message": "Только администратор может вручную изменять вероятность проекта"},
            )
        if not customer:
            raise HTTPException(
                422, {"field": "probability_override", "message": "Поле применяется только к проектам на этапах по ТЗ"}
            )
        if project.id is None or stage_changed:
            raise HTTPException(
                422,
                {
                    "field": "probability_override",
                    "message": "Ручное изменение вероятности доступно только без одновременной смены этапа",
                },
            )

    if probability_mode is not None:
        if not customer or not stage_changed:
            raise HTTPException(
                422,
                {
                    "field": "probability_mode",
                    "message": "Выбор режима вероятности доступен только при смене этапа проекта",
                },
            )
        if project.id is None and probability_mode == "previous":
            raise HTTPException(
                422, {"field": "probability_mode", "message": "У нового проекта нет истории посещения этапов"}
            )

    target_probability: int | None = None
    if customer:
        if stage_changed:
            assert customer_stage is not None and customer_stage.probability is not None
            if project.id is not None and probability_mode == "previous":
                visited = previous_stage_probabilities(db, project)
                if data.customer_stage_id not in visited:
                    raise HTTPException(
                        422, {"field": "probability_mode", "message": "Этап ранее не посещался этим проектом"}
                    )
                prev_prob = visited[data.customer_stage_id]
                if prev_prob is None:
                    raise HTTPException(
                        422,
                        {
                            "field": "probability_mode",
                            "message": "В истории проекта нет достоверной сохранённой вероятности для этого этапа",
                        },
                    )
                target_probability = prev_prob
            else:
                target_probability = customer_stage.probability
        elif probability_override is not None:
            target_probability = probability_override

    was_closed = project.stage in CLOSED_STAGES if project.stage else False
    excluded = {
        "manager_id",
        "segment_id",
        "financial_entries",
        "stage",
        "customer_stage_id",
        "probability",
        "probability_mode",
        "probability_override",
    }
    if project.id is not None and "implementation_year" not in data.model_fields_set:
        excluded.add("implementation_year")
    for field, value in data.model_dump(exclude=excluded).items():
        setattr(project, field, value)
    project.manager_id = manager_id
    project.segment_id = selected_segment_id
    if customer:
        project.stage = None
        project.customer_stage_id = data.customer_stage_id
        if target_probability is not None:
            project.probability = target_probability
        project.closed_at = None
        return
    if data.stage is not None:
        project.stage = data.stage
    if data.probability is not None:
        project.probability = data.probability
    if project.stage in CLOSED_STAGES:
        if not was_closed or project.closed_at is None:
            project.closed_at = max(date.today(), data.start_date)
    else:
        project.closed_at = None


def build_project_update_audit_metadata(
    db: Session,
    project: Project,
    data: ProjectIn,
    old_stage_id: int | None,
    old_probability: int | None,
    locked_refs: dict[int, ReferenceValue],
) -> dict:
    """Формирует метаданные перехода этапа и ручной смены вероятности для журнала аудита."""
    if project.stage_scheme != "customer":
        return {}
    if old_stage_id is not None and project.customer_stage_id is not None and old_stage_id != project.customer_stage_id:
        old_stage = locked_refs.get(old_stage_id) or db.get(ReferenceValue, old_stage_id)
        new_stage = locked_refs.get(project.customer_stage_id) or db.get(ReferenceValue, project.customer_stage_id)
        old_pos = old_stage.position if old_stage is not None else None
        new_pos = new_stage.position if new_stage is not None else None
        old_code = old_stage.code if old_stage is not None else None
        new_code = new_stage.code if new_stage is not None else None
        direction = "unknown"
        if type(old_pos) is int and type(new_pos) is int:
            if new_pos > old_pos:
                direction = "stage_up"
            elif new_pos < old_pos:
                direction = "stage_down"
        return {
            "stage_transition": {
                "from_stage_id": old_stage_id,
                "to_stage_id": project.customer_stage_id,
                "from_position": old_pos,
                "to_position": new_pos,
                "direction": direction,
                "probability_mode": getattr(data, "probability_mode", None) or "current",
                "before_probability": old_probability,
                "after_probability": project.probability,
                "exited_success": old_code == SUCCESS_STAGE_CODE and new_code != SUCCESS_STAGE_CODE,
            }
        }
    if old_probability is not None and old_probability != project.probability:
        return {
            "probability_override": {
                "stage_id": project.customer_stage_id,
                "before_probability": old_probability,
                "after_probability": project.probability,
            }
        }
    return {}


def replace_financial_entries_impl(
    db: Session,
    project: Project,
    entries: list[ProjectFinancialEntryIn],
    references: list[tuple[dict[str, ReferenceValue], ProjectFinancialEntry | None]],
    user: User,
) -> bool:
    field_labels = effective_project_field_labels(db)
    before = [financial_snapshot(row, field_labels=field_labels) | {"_row_id": row.id}
              for row in project.financial_entries]
    after = [financial_snapshot(entry, ref, field_labels=field_labels)
             for entry, (ref, _) in zip(entries, references, strict=True)]
    changed = len(project.financial_entries) != len(entries) or any(
        old is None or not same_finances(
            [financial_snapshot(old, field_labels=field_labels)], [snapshot],
        )
        for snapshot, (_, old) in zip(after, references, strict=True)
    )
    if not changed:
        return False
    keep = {old.id for _, old in references if old is not None}
    for old in list(project.financial_entries):
        if old.id not in keep:
            project.financial_entries.remove(old)
    saved_rows = []
    for entry, (ref, old) in zip(entries, references, strict=True):
        row = old if old is not None else ProjectFinancialEntry()
        if old is None:
            project.financial_entries.append(row)
        for field in ("kind", "year", "month", "amount", "vat_included"):
            setattr(row, field, getattr(entry, field))
        row.status = ref["status_id"]
        row.article = ref.get("article_id")
        row.cost_type = ref.get("cost_type_id")
        saved_rows.append(row)
    db.flush()
    after = [snapshot | {"_row_id": row.id} for snapshot, row in zip(after, saved_rows, strict=True)]
    project.updated_at = func.now()
    audit.record(
        db, user.id, "replace_financial_entries", "project", project.id,
        before=before, after=after, author_name=user.full_name,
    )
    return True


def set_project_archived(
    db: Session, project: Project, user: User, *, archived: bool
) -> dict:
    if (project.archived_at is not None) == archived:
        return to_project_out_dict(project)
    before = project.archived_at.isoformat() if project.archived_at else None
    field_labels = effective_project_field_labels(db)
    project.archived_at = datetime.now(UTC) if archived else None
    project.archived_by_id = user.id if archived else None
    project.updated_at = func.now()
    audit.record(
        db, user.id, "archive" if archived else "restore", "project", project.id,
        before=with_snapshot_field_labels({"archived_at": before, "_stage_scheme": project.stage_scheme}, field_labels),
        after=with_snapshot_field_labels(
            {"archived_at": project.archived_at.isoformat() if project.archived_at else None,
             "_stage_scheme": project.stage_scheme}, field_labels,
        ),
        author_name=user.full_name,
    )
    return to_project_out_dict(project)
