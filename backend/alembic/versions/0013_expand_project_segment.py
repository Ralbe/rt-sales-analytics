"""Добавить независимый сегмент проекта."""

import sqlalchemy as sa
from alembic import op

revision = "0013_expand"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        # Не пересоздаём таблицу проектов: на неё ссылаются финансовые записи.
        op.execute("ALTER TABLE projects ADD COLUMN segment_id INTEGER REFERENCES segments(id)")
    else:
        op.add_column(
            "projects",
            sa.Column("segment_id", sa.Integer(), sa.ForeignKey("segments.id", name="fk_projects_segment_id_segments")),
        )


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Откат сегментов проектов требует проверки данных в базе")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # До удаления столбца исключаем изменения проектов и клиентов.
        op.execute("LOCK TABLE clients, projects IN ACCESS EXCLUSIVE MODE")
    elif bind.dialect.name == "sqlite":
        # Получаем блокировку записи SQLite, не изменяя строки.
        op.execute("UPDATE projects SET segment_id = segment_id WHERE 0")
    conflict = bind.execute(sa.text("""
        SELECT p.id FROM projects AS p
        LEFT JOIN clients AS c ON c.id = p.client_id
        WHERE p.segment_id IS NOT NULL
          AND (c.id IS NULL OR c.segment_id IS NULL OR p.segment_id <> c.segment_id)
        LIMIT 1
    """)).first()
    if conflict:
        raise RuntimeError(
            "Откат остановлен: сегмент проекта отличается от сегмента клиента "
            f"или клиент отсутствует (проект id={conflict[0]}). Сначала сохраните и согласуйте данные."
        )
    if bind.dialect.name != "sqlite":
        op.drop_constraint("fk_projects_segment_id_segments", "projects", type_="foreignkey")
    op.drop_column("projects", "segment_id")
