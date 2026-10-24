"""add customer project fields and specification references

Revision ID: 0003
Revises: 0002
"""

from alembic import op
import sqlalchemy as sa


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


REFERENCE_DATA = {
    "payment_type": [
        ("installations", "Инсталляции", 10, None),
        ("service", "Сервисная", 20, None),
        ("equipment", "Оборудование", 30, None),
        ("one_time", "Разовые", 40, None),
        ("integration_projects", "Интеграционные проекты", 50, None),
    ],
    "assessment_status": [
        ("assessment", "ОЦЕНКА", 10, None),
        ("pkm", "ПКМ", 20, None),
        ("churn", "ОТТОК", 30, None),
        ("delete", "Delete", 40, None),
        ("dash_pkm", "ДАШ_ПКМ", 50, None),
    ],
    "project_indicator": [
        ("removed", "Снят", 10, None),
        ("new", "Новый", 20, None),
        ("transferred", "Перенос", 30, None),
        ("increased", "Увеличен", 40, None),
        ("reduced", "Снижен", 50, None),
        ("accepted_for_assessment", "Принят в оценку", 60, None),
        ("excluded_from_assessment", "Исключен из оценки", 70, None),
        ("implemented", "Реализован", 80, None),
    ],
    "customer_stage": [
        ("lead", "1. Лид", 10, 10),
        ("lead_work", "2. Проработка лида", 20, 10),
        ("proposal", "3. КП", 30, 30),
        ("pilot", "4. Пилот", 40, 40),
        ("funding", "5. Выделение финансирования", 50, 40),
        ("procurement", "6. Закупка/торги", 60, 50),
        ("contract_dd", "7. Заключение Д Д", 70, 70),
        ("contract_rd", "8. Заключение РД", 80, 80),
        ("delivery", "9. Реализация", 90, 90),
        ("success", "10. Успех", 100, 100),
    ],
}

SEGMENTS = ["Крупный сегмент", "Госсектор", "Средний сегмент", "Малые предприятия"]
SERVICES = [
    ("Интернет", "Традиционный бизнес"),
    ("Телефония", "Традиционный бизнес"),
    ("Инфобез", "Кибербез"),
    ("Цифровые сервисы", "Новый телеком"),
    ("Облачные сервисы", "Новый телеком"),
    ("Отраслевые решения", "Проектная деятельность"),
]


def upgrade() -> None:
    op.create_table(
        "reference_values",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("probability", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.CheckConstraint(
            "probability IS NULL OR probability BETWEEN 0 AND 100", name="ck_reference_probability"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("category", "code", name="uq_reference_category_code"),
    )
    op.create_index("ix_reference_values_category", "reference_values", ["category"])
    op.add_column("services", sa.Column("group_name", sa.String(length=100), nullable=True))
    with op.batch_alter_table("projects") as batch_op:
        batch_op.add_column(
            sa.Column(
                "payment_type_id", sa.Integer(),
                sa.ForeignKey("reference_values.id", name="fk_projects_payment_type_id"), nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "customer_stage_id", sa.Integer(),
                sa.ForeignKey("reference_values.id", name="fk_projects_customer_stage_id"), nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "indicator_id", sa.Integer(),
                sa.ForeignKey("reference_values.id", name="fk_projects_indicator_id"), nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column("accepted_for_forecast", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column(
                "assessment_status_id", sa.Integer(),
                sa.ForeignKey("reference_values.id", name="fk_projects_assessment_status_id"), nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column("subsidiary_implementation", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("management_control", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("is_industry_solution", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(sa.Column("industry_manager", sa.String(length=200), nullable=True))
        batch_op.add_column(sa.Column("industry_project_number", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("implementation_year", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("project_status", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("realized_work", sa.Text(), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("period_plan", sa.Text(), nullable=False, server_default=""))
    bind = op.get_bind()
    refs = sa.table(
        "reference_values",
        sa.column("category", sa.String),
        sa.column("code", sa.String),
        sa.column("name", sa.String),
        sa.column("position", sa.Integer),
        sa.column("probability", sa.Integer),
    )
    bind.execute(
        refs.insert(),
        [
            {
                "category": category,
                "code": code,
                "name": name,
                "position": position,
                "probability": probability,
            }
            for category, entries in REFERENCE_DATA.items()
            for code, name, position, probability in entries
        ],
    )

    segments = sa.table("segments", sa.column("id", sa.Integer), sa.column("name", sa.String))
    for name in SEGMENTS:
        exists = bind.execute(sa.select(segments.c.id).where(segments.c.name == name)).first()
        if exists is None:
            bind.execute(segments.insert().values(name=name))

    services = sa.table(
        "services",
        sa.column("id", sa.Integer),
        sa.column("name", sa.String),
        sa.column("group_name", sa.String),
    )
    for name, group_name in SERVICES:
        exists = bind.execute(sa.select(services.c.id).where(services.c.name == name)).first()
        if exists is None:
            bind.execute(services.insert().values(name=name, group_name=group_name))
        else:
            bind.execute(services.update().where(services.c.name == name).values(group_name=group_name))


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch_op:
        for column in (
            "fk_projects_assessment_status_id",
            "fk_projects_indicator_id",
            "fk_projects_customer_stage_id",
            "fk_projects_payment_type_id",
        ):
            batch_op.drop_constraint(column, type_="foreignkey")
        for column in (
            "period_plan",
            "realized_work",
            "project_status",
            "implementation_year",
            "industry_project_number",
            "industry_manager",
            "is_industry_solution",
            "management_control",
            "subsidiary_implementation",
            "assessment_status_id",
            "accepted_for_forecast",
            "indicator_id",
            "customer_stage_id",
            "payment_type_id",
        ):
            batch_op.drop_column(column)
    op.drop_column("services", "group_name")
    op.drop_index("ix_reference_values_category", table_name="reference_values")
    op.drop_table("reference_values")
