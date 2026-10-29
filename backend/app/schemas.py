from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.security import inn_is_valid
from app.models import Role, Stage

LEGACY_STAGE_SCOPE_NOTE = (
    "Показатели рассчитаны только по проектам с прежними шестью стадиями. "
    "Проекты с новыми этапами не включены."
)


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


class FilterManagerItem(ManagerItem):
    is_active: bool


class ServiceItem(ORM):
    id: int
    name: str
    group_name: str | None = None


class FilterRefItem(RefItem):
    is_active: bool


class FilterServiceItem(ServiceItem):
    is_active: bool


class StageItem(CodeItem):
    probability: int


class CustomerStageItem(ORM):
    id: int
    name: str
    probability: int


class RefsOut(BaseModel):
    segments: list[RefItem]
    services: list[ServiceItem]
    filter_segments: list[FilterRefItem]
    filter_services: list[FilterServiceItem]
    managers: list[ManagerItem]
    filter_managers: list[FilterManagerItem]
    stages: list[StageItem]
    payment_types: list[RefItem]
    assessment_statuses: list[RefItem]
    project_indicators: list[RefItem]
    customer_stages: list[CustomerStageItem]
    cost_articles: list[RefItem]
    cost_types: list[RefItem]
    revenue_statuses: list[RefItem]
    cost_statuses: list[RefItem]
    roles: list[CodeItem]
    project_field_labels: dict[str, str] = Field(default_factory=dict)


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
    segment_id: int | None = None
    manager_id: int | None = None
    service_id: int
    stage: Stage | None = None
    amount: Decimal = Field(ge=0, le=Decimal("999999999999.99"), decimal_places=2)
    cost: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("999999999999.99"), decimal_places=2)
    probability: int | None = Field(default=None, ge=0, le=100)
    start_date: date
    expected_close_date: date
    payment_type_id: int | None = None
    customer_stage_id: int | None = None
    indicator_id: int | None = None
    accepted_for_forecast: bool = False
    assessment_status_id: int | None = None
    subsidiary_implementation: bool = False
    management_control: bool = False
    is_industry_solution: bool = False
    industry_manager: str | None = Field(default=None, max_length=200)
    industry_project_number: str | None = Field(default=None, max_length=100)
    implementation_year: int | None = Field(default=None, ge=1900, le=2200)
    project_status: str | None = Field(default=None, max_length=1000)
    realized_work: str = Field(default="", max_length=1000)
    period_plan: str = Field(default="", max_length=1000)

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
        if not self.accepted_for_forecast and self.assessment_status_id is not None:
            raise ValueError("Статус оценки можно указать только для проекта, принятого к прогнозу")
        if not self.is_industry_solution and (self.industry_manager or self.industry_project_number):
            raise ValueError("Отраслевого менеджера и номер проекта можно указать только для отраслевого решения")
        return self


class ProjectOut(ORM):
    id: int
    archived_at: datetime | None = None
    name: str
    description: str
    client: RefItem
    client_inn: str
    segment: RefItem
    manager: ManagerItem
    service: ServiceItem
    stage_scheme: Literal["legacy", "customer"] = Field(json_schema_extra={"readOnly": True})
    stage: Stage | None
    amount: Decimal
    cost: Decimal
    margin: Decimal
    margin_pct: float | None
    probability: int
    start_date: date
    expected_close_date: date
    closed_at: date | None
    payment_type: RefItem | None
    customer_stage: RefItem | None
    indicator: RefItem | None
    accepted_for_forecast: bool
    assessment_status: RefItem | None
    subsidiary_implementation: bool
    management_control: bool
    is_industry_solution: bool
    industry_manager: str | None
    industry_project_number: str | None
    implementation_year: int | None
    project_status: str | None
    realized_work: str
    period_plan: str
    created_at: datetime
    updated_at: datetime
    financial_entries: list["ProjectFinancialEntryOut"] = Field(default_factory=list)


class ProjectFinancialEntryIn(BaseModel):
    id: int | None = Field(default=None, ge=1)
    kind: Literal["revenue", "cost"]
    year: int = Field(ge=1900, le=2200)
    month: int = Field(ge=1, le=12)
    amount: Decimal = Field(ge=0, le=Decimal("999999999999.999"), decimal_places=3)
    vat_included: bool
    status_id: int
    article_id: int | None = None
    cost_type_id: int | None = None


class ProjectFinancialEntryOut(ORM):
    id: int
    kind: Literal["revenue", "cost"]
    year: int
    month: int
    amount: Decimal
    vat_included: bool
    status: RefItem
    article: RefItem | None
    cost_type: RefItem | None
    created_at: datetime
    updated_at: datetime


class ProjectPage(BaseModel):
    items: list[ProjectOut]
    total: int
    page: int
    size: int
    stage_scope: Literal["legacy", "all"] = "all"
    scope_note: str | None = None


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


class AnalyticsScope(BaseModel):
    stage_scope: Literal["legacy"] = "legacy"
    scope_note: str = LEGACY_STAGE_SCOPE_NOTE


class KpiOut(AnalyticsScope):
    as_of: date
    previous_as_of: date
    items: list[KpiItem]


class TrendPoint(BaseModel):
    date: date
    value: float


class ForecastPoint(TrendPoint):
    lower: float
    upper: float


class TrendOut(AnalyticsScope):
    metric: TrendMetric
    history: list[TrendPoint]
    forecast: list[ForecastPoint]
    method: str


class BreakdownItem(BaseModel):
    key: str
    label: str
    value: float


class BreakdownOut(AnalyticsScope):
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
