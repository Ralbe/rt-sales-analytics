"""Сохранить архивные проекты с возможностью восстановления.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("archived_by_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_projects_archived_by_id_users", "users", ["archived_by_id"], ["id"])
        batch.create_index("ix_projects_archived_at", ["archived_at"])


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Безопасный откат архива требует подключения к базе данных")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE projects IN ACCESS EXCLUSIVE MODE")
    projects = sa.table("projects", sa.column("archived_at", sa.DateTime(timezone=True)))
    if bind.execute(sa.select(projects.c.archived_at).where(projects.c.archived_at.is_not(None)).limit(1)).first():
        raise RuntimeError("Откат остановлен: сначала восстановите проекты из архива. Данные сохранены.")
    with op.batch_alter_table("projects") as batch:
        batch.drop_index("ix_projects_archived_at")
        batch.drop_constraint("fk_projects_archived_by_id_users", type_="foreignkey")
        batch.drop_column("archived_by_id")
        batch.drop_column("archived_at")
