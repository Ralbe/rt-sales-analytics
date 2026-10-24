"""Add monthly project financial rows and reference lists."""

import sqlalchemy as sa

from alembic import op
from app.reference_data import REFERENCE_DATA

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

DATA = {
    category: REFERENCE_DATA[category] for category in ("cost_article", "cost_type", "revenue_status", "cost_status")
}


def upgrade() -> None:
    op.create_table(
        "project_financial_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(15, 3), nullable=False),
        sa.Column("vat_included", sa.Boolean(), nullable=False),
        sa.Column("article_id", sa.Integer(), sa.ForeignKey("reference_values.id")),
        sa.Column("cost_type_id", sa.Integer(), sa.ForeignKey("reference_values.id")),
        sa.Column("status_id", sa.Integer(), sa.ForeignKey("reference_values.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('revenue', 'cost')", name="ck_project_financial_kind"),
        sa.CheckConstraint("month BETWEEN 1 AND 12", name="ck_project_financial_month"),
        sa.CheckConstraint("year BETWEEN 1900 AND 2200", name="ck_project_financial_year"),
        sa.CheckConstraint("amount >= 0", name="ck_project_financial_amount"),
    )
    op.create_index("ix_project_financial_entries_project_id", "project_financial_entries", ["project_id"])
    conn = op.get_bind()
    for category, names in DATA.items():
        for code, name, position, _probability in names:
            exists = conn.execute(
                sa.text("SELECT 1 FROM reference_values WHERE category=:c AND code=:k"), {"c": category, "k": code}
            ).first()
            if exists is None:
                conn.execute(
                    sa.text(
                        "INSERT INTO reference_values "
                        "(category, code, name, position, is_active) "
                        "VALUES (:c, :k, :n, :p, true)"
                    ),
                    {"c": category, "k": code, "n": name, "p": position},
                )


def downgrade() -> None:
    op.drop_index("ix_project_financial_entries_project_id", table_name="project_financial_entries")
    op.drop_table("project_financial_entries")
