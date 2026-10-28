import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ReportFilter(StrictModel):
    field: str = Field(min_length=1, max_length=80)
    operator: str = Field(min_length=1, max_length=20)
    value: bool | Annotated[int, Field(ge=-(2**53 - 1), le=2**53 - 1)] | Annotated[str, Field(max_length=500)]


class ReportSort(StrictModel):
    field: str = Field(min_length=1, max_length=80)
    direction: Literal["asc", "desc"]


class Definition(StrictModel):
    grain: Literal["project", "financial_entry"]
    columns: list[str] = Field(min_length=1, max_length=64)
    filters: list[ReportFilter] = Field(default_factory=list, max_length=20)
    sort: list[ReportSort] = Field(default_factory=list, max_length=5)


class TitleInput(StrictModel):
    title: str = Field(min_length=1, max_length=200, pattern=r"\S")

    @field_validator("title")
    @classmethod
    def title_is_printable(cls, value: str) -> str:
        if any(unicodedata.category(char).startswith("C") or char in "\u2028\u2029" for char in value):
            raise ValueError("Название должно быть одной строкой без управляющих символов")
        return value


class ReportInput(TitleInput):
    definition: Definition


class ReportUpdate(ReportInput):
    version: int = Field(ge=1)


class PreviewInput(StrictModel):
    definition: Definition


class DuplicateInput(TitleInput):
    pass


class PublishInput(StrictModel):
    published: bool
    version: int = Field(ge=1)


class RunInput(StrictModel):
    version: int = Field(ge=1)
