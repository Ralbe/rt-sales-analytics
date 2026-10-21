from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.security import inn_is_valid
from app.models import Role, Stage


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Auth ---------------------------------------------------------------


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class LoginOut(BaseModel):
    mfa_token: str
    setup_required: bool
    otpauth_uri: str | None = None
    secret: str | None = None


class MfaIn(BaseModel):
    mfa_token: str
    code: str = Field(pattern=r"^\d{6}$")


class UserOut(ORM):
    id: int
    email: str
    full_name: str
    role: Role


# --- Справочники --------------------------------------------------------


class RefItem(ORM):
    id: int
    name: str


class CodeItem(BaseModel):
    id: str
    name: str


class ManagerItem(ORM):
    id: int
    full_name: str


class StageItem(CodeItem):
    probability: int


class RefsOut(BaseModel):
    segments: list[RefItem]
    services: list[RefItem]
    managers: list[ManagerItem]
    stages: list[StageItem]
    roles: list[CodeItem]


# --- Клиенты ------------------------------------------------------------


class ClientIn(BaseModel):
    name: str = Field(min_length=2, max_length=300)
    inn: str
    segment_id: int

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Название слишком короткое")
        return v

    @field_validator("inn")
    @classmethod
    def check_inn(cls, v: str) -> str:
        v = v.strip()
        if not inn_is_valid(v):
            raise ValueError("Некорректный ИНН: 10 или 12 цифр с верной контрольной суммой")
        return v


class ClientOut(ORM):
    id: int
    name: str
    inn: str
    segment: RefItem


# --- Проекты ------------------------------------------------------------


class ProjectIn(BaseModel):
    name: str = Field(min_length=3, max_length=300)
    description: str = Field(default="", max_length=5000)
    client_id: int
    manager_id: int | None = None
    service_id: int
    stage: Stage
    amount: Decimal = Field(ge=0, le=Decimal("1e12"), decimal_places=2)
    cost: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("1e12"), decimal_places=2)
    probability: int = Field(ge=0, le=100)
    start_date: date
    expected_close_date: date

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 3:
            raise ValueError("Название слишком короткое")
        return v

    @model_validator(mode="after")
    def check_dates(self) -> "ProjectIn":
        if self.expected_close_date < self.start_date:
            raise ValueError("Плановая дата закрытия раньше даты начала")
        return self


class ProjectOut(ORM):
    id: int
    name: str
    description: str
    client: RefItem
    segment: RefItem
    manager: ManagerItem
    service: RefItem
    stage: Stage
    amount: Decimal
    cost: Decimal
    margin: Decimal
    margin_pct: float | None
    probability: int
    start_date: date
    expected_close_date: date
    closed_at: date | None
    updated_at: datetime


class ProjectPage(BaseModel):
    items: list[ProjectOut]
    total: int
    page: int
    size: int


class NameCheckOut(BaseModel):
    available: bool


# --- Аналитика ----------------------------------------------------------

KpiKey = Literal["funnel", "projects", "won_ytd"]
TrendMetric = Literal["funnel", "projects"]
GroupBy = Literal["segment", "service", "manager", "stage"]


class KpiItem(BaseModel):
    key: KpiKey
    title: str
    unit: Literal["rub", "count"]
    value: float
    previous: float
    delta_pct: float | None


class KpiOut(BaseModel):
    as_of: date
    previous_as_of: date
    items: list[KpiItem]


class TrendPoint(BaseModel):
    date: date
    value: float


class ForecastPoint(TrendPoint):
    lower: float
    upper: float


class TrendOut(BaseModel):
    metric: TrendMetric
    history: list[TrendPoint]
    forecast: list[ForecastPoint]
    method: str


class BreakdownItem(BaseModel):
    key: str
    label: str
    value: float


class BreakdownOut(BaseModel):
    metric: KpiKey
    group_by: GroupBy
    items: list[BreakdownItem]


# --- Дашборды -----------------------------------------------------------


class Widget(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: Literal["kpi", "trend", "breakdown", "projects"]
    title: str = Field(max_length=200)
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=100)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=12)
    config: dict = Field(default_factory=dict)


class DashboardFilters(BaseModel):
    segment_ids: list[int] = []
    service_ids: list[int] = []
    manager_ids: list[int] = []


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    widgets: list[Widget] = Field(default_factory=list, max_length=30)
    filters: DashboardFilters = Field(default_factory=DashboardFilters)
    is_shared: bool = False


class DashboardOut(BaseModel):
    id: int
    name: str
    owner: ManagerItem
    widgets: list[Widget]
    filters: DashboardFilters
    is_shared: bool
    editable: bool
    updated_at: datetime
