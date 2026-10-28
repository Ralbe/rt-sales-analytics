"""Добавить активность сегментов и услуг без изменения существующих ссылок."""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for name in ("segments", "services"):
        op.add_column(name, sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError("Безопасный откат активности справочников требует подключения к базе данных")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("LOCK TABLE segments, services IN ACCESS EXCLUSIVE MODE")
    for name in ("segments", "services"):
        table = sa.table(name, sa.column("is_active", sa.Boolean()))
        if bind.execute(sa.select(table.c.is_active).where(table.c.is_active.is_(False)).limit(1)).first():
            raise RuntimeError("Откат остановлен: есть неактивные сегменты или услуги. Данные сохранены.")
    for name in ("services", "segments"):
        op.drop_column(name, "is_active")
