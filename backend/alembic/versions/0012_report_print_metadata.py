"""Метаданные печати новых снимков; прежние снимки остаются без них."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("report_snapshots", sa.Column("print_metadata", sa.JSON(), nullable=True))


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Откат требует проверки метаданных снимков")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE report_snapshots IN ACCESS EXCLUSIVE MODE")
    if bind.execute(sa.text("SELECT 1 FROM report_snapshots WHERE print_metadata IS NOT NULL LIMIT 1")).first():
        raise RuntimeError("Откат остановлен: есть метаданные снимков")
    op.drop_column("report_snapshots", "print_metadata")
