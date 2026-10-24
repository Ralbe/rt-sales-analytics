from datetime import date

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Client, Project, ReferenceValue, Segment, Service, User
from app.reference_data import REFERENCE_DATA, SPEC_SEGMENTS, SPEC_SERVICES
from app.seed import seed


def test_seed_preserves_existing_catalogs_without_autoflush():
    engine = create_engine("sqlite+pysqlite://")
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False) as db:
        segment = Segment(name=SPEC_SEGMENTS[0])
        service = Service(name="Телефония", group_name="Существующая группа")
        reference = ReferenceValue(
            category="payment_type", code="service", name="Существующее название", position=20,
        )
        db.add_all([segment, service, reference])
        db.commit()
        existing_ids = (segment.id, service.id, reference.id)

        seed(db, today=date(2026, 10, 25), projects_count=12)

        assert (segment.id, service.id, reference.id) == existing_ids
        assert service.group_name == "Существующая группа"
        assert reference.name == "Существующее название"
        assert db.scalar(select(func.count()).select_from(Project)) == 12
        assert db.scalar(select(func.count()).select_from(ReferenceValue)) == sum(
            len(items) for items in REFERENCE_DATA.values()
        )
        assert set(SPEC_SEGMENTS) <= set(db.scalars(select(Segment.name)))
        assert set(SPEC_SERVICES) <= set(db.scalars(select(Service.name)))
        assert all(project.service is not None and project.client.segment is not None
                   for project in db.scalars(select(Project)))

        counts = [db.scalar(select(func.count()).select_from(model))
                  for model in (User, Client, Project, Segment, Service, ReferenceValue)]
        seed(db, today=date(2026, 10, 25), projects_count=12)
        assert counts == [db.scalar(select(func.count()).select_from(model))
                          for model in (User, Client, Project, Segment, Service, ReferenceValue)]
