"""Постоянные версии отчётов и журнал импорта проектов."""

import sqlalchemy as sa
from alembic import op

revision = "0015_archives_imports"
down_revision = "0014_dashboard_titles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_archives",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source_snapshot_id", sa.String(36), nullable=False, unique=True),
        sa.Column("owner_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("owner_role", sa.String(20), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("report_version", sa.Integer),
        sa.Column("columns", sa.JSON, nullable=False),
        sa.Column("rows", sa.JSON, nullable=False),
        sa.Column("project_ids", sa.JSON, nullable=False),
        sa.Column("print_metadata", sa.JSON(none_as_null=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_report_archives_owner_id", "report_archives", ["owner_id"])
    op.create_table(
        "project_imports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("filename", sa.String(200), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("source_rows", sa.JSON, nullable=False),
        sa.Column("result", sa.JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_project_imports_owner_id", "project_imports", ["owner_id"])


def downgrade() -> None:
    connection = op.get_bind()
    for table in ("report_archives", "project_imports"):
        if connection.scalar(sa.select(sa.func.count()).select_from(sa.table(table))):
            raise RuntimeError("Откат удалит сохранённые версии отчётов или журнал импорта; сначала сохраните эти данные")
    op.drop_table("project_imports")
    op.drop_table("report_archives")
