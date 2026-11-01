"""Переименовать стандартные виджеты дашбордов и убрать горизонт прогноза."""

import json

import sqlalchemy as sa
from alembic import op

revision = "0014_dashboard_titles"
down_revision = "0013_backfill"
branch_labels = None
depends_on = None

TITLES = {
    "Объём воронки": "Воронка проектов",
    "Динамика воронки и прогноз": "Динамика проектов",
    "Воронка по сегментам": "Распределение по сегментам",
}


def upgrade() -> None:
    conn = op.get_bind()
    dashboards = sa.table("dashboards", sa.column("id", sa.Integer), sa.column("widgets", sa.JSON))
    for row in conn.execute(sa.select(dashboards.c.id, dashboards.c.widgets)).all():
        widgets = row.widgets if isinstance(row.widgets, list) else json.loads(row.widgets or "[]")
        changed = False
        for widget in widgets:
            if not isinstance(widget, dict):
                continue
            title = TITLES.get(widget.get("title"))
            if title:
                widget["title"] = title
                changed = True
            config = widget.get("config")
            if widget.get("type") == "trend" and isinstance(config, dict) and "horizon" in config:
                config.pop("horizon")
                changed = True
        if changed:
            conn.execute(dashboards.update().where(dashboards.c.id == row.id).values(widgets=widgets))


def downgrade() -> None:
    # Переименование не откатывается: прежние названия описывали удалённый прогноз.
    pass
