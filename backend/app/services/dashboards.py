from sqlalchemy.orm import Session

from app.models import Dashboard, User

# Сетка 12 колонок x 12 строк — дашборд всегда помещается в один экран
DEFAULT_WIDGETS = [
    {"id": "kpi-funnel", "type": "kpi", "title": "Объём воронки", "x": 0, "y": 0, "w": 4, "h": 2,
     "config": {"metric": "funnel"}},
    {"id": "kpi-projects", "type": "kpi", "title": "Активные проекты", "x": 4, "y": 0, "w": 4, "h": 2,
     "config": {"metric": "projects"}},
    {"id": "kpi-won", "type": "kpi", "title": "Выиграно с начала года", "x": 8, "y": 0, "w": 4, "h": 2,
     "config": {"metric": "won_ytd"}},
    {"id": "trend", "type": "trend", "title": "Динамика воронки и прогноз", "x": 0, "y": 2, "w": 7, "h": 5,
     "config": {"metric": "funnel", "weeks": 6, "horizon": 14, "chart": "line"}},
    {"id": "by-segment", "type": "breakdown", "title": "Воронка по сегментам", "x": 7, "y": 2, "w": 5, "h": 5,
     "config": {"metric": "funnel", "group_by": "segment", "chart": "bar"}},
    {"id": "by-service", "type": "breakdown", "title": "Воронка по услугам", "x": 0, "y": 7, "w": 5, "h": 5,
     "config": {"metric": "funnel", "group_by": "service", "chart": "donut"}},
    {"id": "top-projects", "type": "projects", "title": "Крупнейшие проекты в работе", "x": 5, "y": 7, "w": 7, "h": 5,
     "config": {"limit": 8}},
]


def create_default(db: Session, owner: User) -> Dashboard:
    dashboard = Dashboard(owner_id=owner.id, name="Дашборд 1", widgets=DEFAULT_WIDGETS, filters={})
    db.add(dashboard)
    db.flush()
    return dashboard
