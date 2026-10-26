from collections.abc import Mapping

from openpyxl.worksheet.worksheet import Worksheet

from app.services.project_field_labels import project_field_heading

# Порядок существующей XLSX-выгрузки сохраняется, меняются только подписи.
PROJECT_EXPORT_FIELDS = (
    "id", "name", "client_id", "client_inn", "segment", "service_id", "manager_id", "stage",
    "amount", "cost", "margin", "probability", "start_date", "expected_close_date", "closed_at",
    "payment_type_id", "customer_stage_id", "indicator_id", "accepted_for_forecast", "assessment_status_id",
    "subsidiary_implementation", "management_control", "is_industry_solution", "industry_manager",
    "industry_project_number", "implementation_year", "project_status", "realized_work", "period_plan", "created_at",
)


def write_project_export_headers(worksheet: Worksheet, labels: Mapping[str, str]) -> None:
    worksheet.append([project_field_heading(key, labels) for key in PROJECT_EXPORT_FIELDS])
    for cell in worksheet[1]:
        # Заголовки администратора, как и значения проектов, не исполняются как формулы.
        cell.data_type = "s"
