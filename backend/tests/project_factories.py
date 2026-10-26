"""Раздельные фабрики новых запросов и сохранённых проектов прежнего поколения."""

from sqlalchemy import select

from app.models import Client, Project, ReferenceValue, Service, User
from app.schemas import ProjectIn
from app.services import audit
from app.services.project_history import project_snapshot


def legacy_payload(db, **overrides):
    return {
        "name": "Новый тестовый проект",
        "description": "",
        "client_id": db.scalars(select(Client).order_by(Client.id)).first().id,
        "service_id": db.scalars(select(Service).order_by(Service.id)).first().id,
        "stage": "proposal",
        "amount": "1500000.00",
        "cost": "900000.00",
        "probability": 50,
        "start_date": "2026-10-01",
        "expected_close_date": "2026-12-31",
    } | overrides


def customer_payload(db, **overrides):
    stage_id = db.scalar(select(ReferenceValue.id).where(
        ReferenceValue.category == "customer_stage", ReferenceValue.probability == 50,
    ).order_by(ReferenceValue.id))
    return legacy_payload(db, stage=None, customer_stage_id=stage_id) | overrides


def create_legacy_project(db, **overrides):
    """Историческая запись с исходным событием создания; публичный POST её больше не создаёт."""
    user = db.scalar(select(User).where(User.email == "manager1@example.com"))
    values = ProjectIn.model_validate(legacy_payload(db, **overrides)).model_dump()
    values["manager_id"] = values["manager_id"] or user.id
    project = Project(stage_scheme="legacy", **values)
    db.add(project)
    db.flush()
    audit.record(
        db, user.id, "create", "project", project.id,
        name=project.name, after=project_snapshot(db, project), author_name=user.full_name,
    )
    db.commit()
    return project
