from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class StageInterval(BaseModel):
    stage_key: str
    stage_label: str
    started_at: datetime
    ended_at: datetime
    duration_days: float
    is_current: bool
    start_known: bool
    end_reason: Literal["stage_change", "archive", "current", "unknown"]


class ArchivedPeriod(BaseModel):
    started_at: datetime
    ended_at: datetime


class StageStatistic(BaseModel):
    stage_key: str
    stage_label: str
    completed_visits: int
    average_days: float | None


class TimelineFinance(BaseModel):
    id: int
    kind: Literal["revenue", "cost"]
    year: int
    month: int
    amount: str
    vat_included: bool
    status: str


class ProjectTimeline(BaseModel):
    project_id: int
    generated_at: datetime
    history_complete: bool
    notes: list[str]
    intervals: list[StageInterval]
    archived_periods: list[ArchivedPeriod]
    finances: list[TimelineFinance]
    stage_statistics: list[StageStatistic]


class PortfolioStageStatistics(BaseModel):
    generated_at: datetime
    project_count: int
    projects_with_history: int
    stage_statistics: list[StageStatistic]
    notes: list[str]
