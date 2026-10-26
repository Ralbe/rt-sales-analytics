"""Расширить статус проекта без изменения существующих текстов.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Сделанное и планы остаются TEXT: прежние значения длиннее 1000 не изменяются.
    with op.batch_alter_table("projects") as batch_op:
        batch_op.alter_column(
            "project_status", existing_type=sa.String(100), type_=sa.String(1000), existing_nullable=True,
        )


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Безопасный откат 0006 требует подключения к БД для проверки длины project_status")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # Блокировка исключает запись длинного статуса между проверкой и сужением столбца.
        op.execute("LOCK TABLE projects IN ACCESS EXCLUSIVE MODE")
    projects = sa.table("projects", sa.column("project_status", sa.String))
    too_long = bind.execute(
        sa.select(projects.c.project_status).where(sa.func.length(projects.c.project_status) > 100).limit(1)
    ).first()
    if too_long is not None:
        raise RuntimeError(
            "Откат 0006 остановлен: project_status длиннее 100 символов. "
            "Данные сохранены; перед откатом требуется согласованное решение владельца по этим статусам."
        )
    with op.batch_alter_table("projects") as batch_op:
        batch_op.alter_column(
            "project_status", existing_type=sa.String(1000), type_=sa.String(100), existing_nullable=True,
        )
