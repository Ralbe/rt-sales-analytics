import unicodedata

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.project_field_label_catalog import LABEL_MAX_LENGTH


def normalize_label(value: str) -> str:
    # HTML остаётся обычной строкой: экранирование выполняет потребитель, не хранилище.
    if any(unicodedata.category(char).startswith("C") or char in "\u2028\u2029" for char in value):
        raise ValueError("Подпись должна быть одной строкой без управляющих и скрытых символов")
    label = value.strip()
    if not 1 <= len(label) <= LABEL_MAX_LENGTH:
        raise ValueError(f"Длина подписи должна быть от 1 до {LABEL_MAX_LENGTH} символов")
    return label


class ProjectFieldLabelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(strict=True, max_length=1000)

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        return normalize_label(value)


class ProjectFieldLabelOut(BaseModel):
    key: str
    label: str
    default_label: str
    suffix: str
    is_overridden: bool
