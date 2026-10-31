from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select

from app.import_faktura import import_rows
from app.models import AuditLog, Project, User


def _row(**overrides):
    row = {
        "Дата": datetime(2025, 7, 19, 4, 50, 55),
        "Столбец1": 123456789012,
        "Клиент": "Альфа-Рост",
        "Описание проекта": "Волна Коммуникаций",
        "Этап": "3.\xa0КП",
        "Услуга крупно": "Телефония",
        "Тип платежа": "Интеграционные проекты-ЕГЭ",
        "Менеджер": "Иванов",
        "Сегмент": "#REF!",
        "Год реализации": 2025,
        "Принимаемый к оценке": "ДАШ_ПКМ",
        "Отраслевое решени": "да",
        "январь": 100,
        "март": 250.5,
        "№ проекта ПО": "61/123/2023",
    }
    return row | overrides


def test_import_creates_customer_project_with_history_and_is_idempotent(db):
    author = db.scalar(select(User).where(User.email == "admin@example.com"))
    result = import_rows(db, [_row()], author)
    assert (result.created, result.skipped) == (1, 0)
    project = db.scalar(select(Project).where(Project.name == "Волна Коммуникаций"))
    assert project.stage_scheme == "customer"
    assert project.customer_stage.name == "3. КП"
    assert project.probability == project.customer_stage.probability
    assert project.payment_type.name == "Интеграционные проекты"
    assert project.assessment_status.name == "ДАШ_ПКМ" and project.accepted_for_forecast
    assert project.is_industry_solution and project.industry_project_number == "61/123/2023"
    assert str(project.amount) == "350500.00"
    assert [(e.month, e.amount) for e in project.financial_entries] == [(1, Decimal("100")), (3, Decimal("250.5"))]
    assert project.client.segment.name == "Сегмент не указан"
    assert project.manager.full_name == "Иванов"
    event = db.scalar(select(AuditLog).where(AuditLog.entity_id == project.id, AuditLog.action == "create"))
    assert event.payload["after"]["customer_stage_id"] == project.customer_stage_id

    again = import_rows(db, [_row()], author)
    assert (again.created, again.skipped) == (0, 1)
    assert db.scalar(select(func.count()).select_from(Project).where(Project.name == "Волна Коммуникаций")) == 1


def test_import_skips_unknown_stage(db):
    author = db.scalar(select(User).where(User.email == "admin@example.com"))
    result = import_rows(db, [_row(Этап="Непонятный", **{"Описание проекта": "Другой"})], author)
    assert (result.created, result.skipped) == (0, 1)
    assert "этап" in result.warnings[0]
