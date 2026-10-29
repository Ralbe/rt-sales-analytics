"""Сохранить сегмент клиента в существующих проектах."""

from alembic import op

revision = "0013_backfill"
down_revision = "0013_expand"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE projects
        SET segment_id = (SELECT clients.segment_id FROM clients WHERE clients.id = projects.client_id)
        WHERE segment_id IS NULL
    """)


def downgrade() -> None:
    # Не удаляем значения: сегменты проектов уже могли измениться независимо.
    # Предыдущая миграция проверяет различия перед удалением столбца.
    pass
