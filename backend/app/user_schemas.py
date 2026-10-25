import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator

from app.models import Role

EMAIL_PATTERN = re.compile(
    r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
)


class UserFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str
    full_name: str
    role: Role

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if len(value) > 255:
            raise ValueError("Email должен содержать не более 255 символов")
        if not EMAIL_PATTERN.fullmatch(value) or len(value.split("@", 1)[0]) > 64:
            raise ValueError("Введите корректный email")
        return value

    @field_validator("full_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or len(value) > 200 or any(ord(c) < 32 for c in value):
            raise ValueError("ФИО должно содержать от 1 до 200 символов")
        return value


class UserCreate(UserFields):
    password: SecretStr

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        password = value.get_secret_value()
        if len(password) < 8:
            raise ValueError("Пароль должен содержать не менее 8 символов")
        if len(password.encode("utf-8")) > 72:
            raise ValueError("Пароль должен занимать не более 72 байт в UTF-8")
        return value


class UserUpdate(UserFields):
    is_active: bool


class ManagedUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    full_name: str
    role: Role
    is_active: bool
    created_at: datetime


class UserPage(BaseModel):
    items: list[ManagedUser]
    total: int
    page: int
    size: int
