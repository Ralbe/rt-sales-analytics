from typing import Literal

from pydantic import Field, model_validator

from app.schemas import ProjectFinancialEntryIn, ProjectIn


class ProjectSaveIn(ProjectIn):
    financial_entries: list[ProjectFinancialEntryIn] | None = None
    probability_mode: Literal["current", "previous"] | None = None
    probability_override: int | None = Field(default=None, ge=0, le=100, strict=True)

    @model_validator(mode="before")
    @classmethod
    def reject_stage_scheme(cls, value):
        if isinstance(value, dict) and "stage_scheme" in value:
            raise ValueError("Схему этапов назначает сервер; поле stage_scheme доступно только для чтения")
        return value
