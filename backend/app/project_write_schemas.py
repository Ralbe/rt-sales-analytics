from pydantic import model_validator

from app.schemas import ProjectFinancialEntryIn, ProjectIn


class ProjectSaveIn(ProjectIn):
    financial_entries: list[ProjectFinancialEntryIn] | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_stage_scheme(cls, value):
        if isinstance(value, dict) and "stage_scheme" in value:
            raise ValueError("Схему этапов назначает сервер; поле stage_scheme доступно только для чтения")
        return value
