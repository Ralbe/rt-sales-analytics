"""Административные подписи полей проектов без изменения машинных ключей."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_field_labels",
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.CheckConstraint("length(label) BETWEEN 1 AND 120", name="ck_project_field_label_length"),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Безопасный откат подписей требует подключения к базе данных")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE project_field_labels IN ACCESS EXCLUSIVE MODE")
    labels = sa.table("project_field_labels", sa.column("key", sa.String(100)))
    if bind.execute(sa.select(labels.c.key).limit(1)).first() is not None:
        raise RuntimeError("Откат остановлен: сначала сбросьте подписи полей. Настроенные подписи сохранены.")
    op.drop_table("project_field_labels")
