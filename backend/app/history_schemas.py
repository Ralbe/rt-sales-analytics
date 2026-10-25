from datetime import datetime

from pydantic import BaseModel


class ProjectHistoryChange(BaseModel):
    field: str
    label: str
    # None означает, что значение не было записано в старый аудит.
    before: str | None
    after: str | None


class ProjectHistoryItem(BaseModel):
    id: int
    created_at: datetime
    action: str
    title: str
    author_name: str
    changes: list[ProjectHistoryChange]
    note: str | None = None


class ProjectHistoryPage(BaseModel):
    items: list[ProjectHistoryItem]
    limit: int
    offset: int
    has_more: bool
