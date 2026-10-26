"""Разделить прежние стадии и этапы новых проектов без переноса значений."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

CONSTRAINT = (
    "(stage_scheme = 'legacy' AND stage IS NOT NULL) OR "
    "(stage_scheme = 'customer' AND stage IS NULL AND customer_stage_id IS NOT NULL)"
)
STAGE = sa.Enum("lead", "qualification", "proposal", "negotiation", "won", "lost",
                name="project_stage", native_enum=False, length=20)


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        # Значение по умолчанию помечает все существующие строки, не обновляя их поля и даты.
        batch.add_column(sa.Column("stage_scheme", sa.String(10), nullable=False, server_default="legacy"))
        batch.alter_column("stage", existing_type=STAGE, nullable=True)
    with op.batch_alter_table("projects") as batch:
        batch.alter_column("stage_scheme", existing_type=sa.String(10), server_default="customer")
        batch.create_check_constraint("ck_project_stage_scheme", CONSTRAINT)


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Безопасный откат поколений этапов требует подключения к базе данных")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE projects IN ACCESS EXCLUSIVE MODE")
    projects = sa.table("projects", sa.column("stage_scheme", sa.String(10)))
    if bind.execute(sa.select(projects.c.stage_scheme).where(projects.c.stage_scheme == "customer").limit(1)).first():
        raise RuntimeError("Откат остановлен: существуют проекты с новыми этапами. Данные сохранены.")
    with op.batch_alter_table("projects") as batch:
        batch.drop_constraint("ck_project_stage_scheme", type_="check")
        batch.alter_column("stage", existing_type=STAGE, nullable=False)
        batch.drop_column("stage_scheme")
