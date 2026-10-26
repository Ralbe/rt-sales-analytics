import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Role(str, enum.Enum):
    analyst = "analyst"
    user = "user"
    admin = "admin"


class Stage(str, enum.Enum):
    lead = "lead"
    qualification = "qualification"
    proposal = "proposal"
    negotiation = "negotiation"
    won = "won"
    lost = "lost"


CLOSED_STAGES = {Stage.won, Stage.lost}

ROLE_LABELS = {
    Role.analyst: "Аналитик",
    Role.user: "Пользователь",
    Role.admin: "Администратор",
}

STAGE_LABELS = {
    Stage.lead: "Лид",
    Stage.qualification: "Квалификация",
    Stage.proposal: "КП отправлено",
    Stage.negotiation: "Переговоры",
    Stage.won: "Выиграно",
    Stage.lost: "Проиграно",
}

STAGE_DEFAULT_PROBABILITY = {
    Stage.lead: 10,
    Stage.qualification: 25,
    Stage.proposal: 50,
    Stage.negotiation: 75,
    Stage.won: 100,
    Stage.lost: 0,
}


def _enum(cls: type[enum.Enum], name: str) -> Enum:
    return Enum(cls, name=name, native_enum=False, length=20, values_callable=lambda e: [m.value for m in e])


class Segment(Base):
    __tablename__ = "segments"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class Service(Base):
    __tablename__ = "services"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    group_name: Mapped[str | None] = mapped_column(String(100))


class ReferenceValue(Base):
    __tablename__ = "reference_values"
    __table_args__ = (
        UniqueConstraint("category", "code", name="uq_reference_category_code"),
        CheckConstraint("probability IS NULL OR probability BETWEEN 0 AND 100", name="ck_reference_probability"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(40), index=True)
    code: Mapped[str] = mapped_column(String(50))
    name: Mapped[str] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    probability: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=func.true())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[Role] = mapped_column(_enum(Role, "user_role"))
    password_hash: Mapped[str] = mapped_column(String(200))
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    auth_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300), index=True)
    inn: Mapped[str] = mapped_column(String(12), unique=True)
    segment_id: Mapped[int] = mapped_column(ForeignKey("segments.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    segment: Mapped[Segment] = relationship(lazy="joined")


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("client_id", "name", name="uq_project_client_name"),
        CheckConstraint(
            "(stage_scheme = 'legacy' AND stage IS NOT NULL) OR "
            "(stage_scheme = 'customer' AND stage IS NULL AND customer_stage_id IS NOT NULL)",
            name="ck_project_stage_scheme",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    manager_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id"), index=True)
    stage_scheme: Mapped[str] = mapped_column(String(10), default="customer", server_default="customer")
    stage: Mapped[Stage | None] = mapped_column(_enum(Stage, "project_stage"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"))
    probability: Mapped[int] = mapped_column(Integer)
    start_date: Mapped[date] = mapped_column(Date, index=True)
    expected_close_date: Mapped[date] = mapped_column(Date)
    closed_at: Mapped[date | None] = mapped_column(Date, index=True)
    payment_type_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    customer_stage_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    indicator_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    accepted_for_forecast: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    assessment_status_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    subsidiary_implementation: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    management_control: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    is_industry_solution: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    industry_manager: Mapped[str | None] = mapped_column(String(200))
    industry_project_number: Mapped[str | None] = mapped_column(String(100))
    implementation_year: Mapped[int | None] = mapped_column(Integer)
    project_status: Mapped[str | None] = mapped_column(String(1000))
    realized_work: Mapped[str] = mapped_column(Text, default="", server_default="")
    period_plan: Mapped[str] = mapped_column(Text, default="", server_default="")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    archived_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", name="fk_projects_archived_by_id_users")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    client: Mapped[Client] = relationship(lazy="joined")
    manager: Mapped[User] = relationship(foreign_keys=[manager_id], lazy="joined")
    service: Mapped[Service] = relationship(lazy="joined")
    payment_type: Mapped[ReferenceValue | None] = relationship(foreign_keys=[payment_type_id], lazy="joined")
    customer_stage: Mapped[ReferenceValue | None] = relationship(foreign_keys=[customer_stage_id], lazy="joined")
    indicator: Mapped[ReferenceValue | None] = relationship(foreign_keys=[indicator_id], lazy="joined")
    assessment_status: Mapped[ReferenceValue | None] = relationship(foreign_keys=[assessment_status_id], lazy="joined")
    financial_entries: Mapped[list["ProjectFinancialEntry"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectFinancialEntry.year, ProjectFinancialEntry.month, ProjectFinancialEntry.id",
    )


class ProjectFinancialEntry(Base):
    __tablename__ = "project_financial_entries"
    __table_args__ = (
        CheckConstraint("kind IN ('revenue', 'cost')", name="ck_project_financial_kind"),
        CheckConstraint("month BETWEEN 1 AND 12", name="ck_project_financial_month"),
        CheckConstraint("year BETWEEN 1900 AND 2200", name="ck_project_financial_year"),
        CheckConstraint("amount >= 0", name="ck_project_financial_amount"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(15, 3), nullable=False)
    vat_included: Mapped[bool] = mapped_column(Boolean, nullable=False)
    article_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    cost_type_id: Mapped[int | None] = mapped_column(ForeignKey("reference_values.id"))
    status_id: Mapped[int] = mapped_column(ForeignKey("reference_values.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="financial_entries")
    article: Mapped[ReferenceValue | None] = relationship(foreign_keys=[article_id], lazy="joined")
    cost_type: Mapped[ReferenceValue | None] = relationship(foreign_keys=[cost_type_id], lazy="joined")
    status: Mapped[ReferenceValue] = relationship(foreign_keys=[status_id], lazy="joined")


class Dashboard(Base):
    __tablename__ = "dashboards"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    widgets: Mapped[list] = mapped_column(JSON, default=list)
    filters: Mapped[dict] = mapped_column(JSON, default=dict)
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    owner: Mapped[User] = relationship(lazy="joined")


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(50))
    entity: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[int | None] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class ProjectFieldLabel(Base):
    __tablename__ = "project_field_labels"
    __table_args__ = (CheckConstraint("length(label) BETWEEN 1 AND 120", name="ck_project_field_label_length"),)

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
