"""Сохранённые отчёты и временные снимки."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_definitions", sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("owner_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("definition", sa.JSON, nullable=False),
        sa.Column("published", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_report_definitions_owner_id", "report_definitions", ["owner_id"])
    op.create_table(
        "report_snapshots", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("owner_role", sa.String(20), nullable=False),
        sa.Column("report_id", sa.Integer, sa.ForeignKey("report_definitions.id", ondelete="CASCADE")),
        sa.Column("report_version", sa.Integer),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("columns", sa.JSON, nullable=False), sa.Column("rows", sa.JSON, nullable=False),
        sa.Column("project_ids", sa.JSON, nullable=False),
    )
    op.create_index("ix_report_snapshots_owner_id", "report_snapshots", ["owner_id"])
    op.create_index("ix_report_snapshots_expires_at", "report_snapshots", ["expires_at"])
    op.create_table("report_snapshot_quota", sa.Column("id", sa.Integer, primary_key=True))
    op.bulk_insert(sa.table("report_snapshot_quota", sa.column("id", sa.Integer)), [{"id": 1}])


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Откат отчётов требует проверки сохранённых шаблонов")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE report_definitions, report_snapshots IN ACCESS EXCLUSIVE MODE")
    if bind.execute(sa.select(sa.literal(1)).select_from(sa.table("report_definitions")).limit(1)).first():
        raise RuntimeError("Откат остановлен: есть сохранённые отчёты")
    op.drop_table("report_snapshots")
    op.drop_table("report_definitions")
    op.drop_table("report_snapshot_quota")
