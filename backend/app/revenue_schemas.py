from decimal import Decimal
from typing import Literal

from pydantic import BaseModel


class RevenueBucket(BaseModel):
    basis: Literal["with_vat", "without_vat", "unspecified"]
    label: str
    revenue_rub: Decimal
    weighted_revenue_rub: Decimal


class RevenueProjection(BaseModel):
    source: Literal["monthly_revenue", "legacy_amount"]
    has_revenue: bool
    buckets: list[RevenueBucket]


class WeightedRevenueOut(BaseModel):
    stage_scope: Literal["all"] = "all"
    project_count: int
    missing_revenue_count: int
    buckets: list[RevenueBucket]
    scope_note: str
