from app.schemas import ProjectFinancialEntryIn, ProjectIn


class ProjectSaveIn(ProjectIn):
    financial_entries: list[ProjectFinancialEntryIn] | None = None
