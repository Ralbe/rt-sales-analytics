from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://rt:rt@localhost:5432/rt"
    # Пустая строка отключает кэш (используется в тестах)
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "amqp://guest:guest@localhost:5672//"

    secret_key: str = "change-me-in-production"
    access_token_minutes: int = 480
    mfa_token_minutes: int = 5
    cookie_secure: bool = False
    totp_issuer: str = "RT Analytics"

    cache_ttl_seconds: int = 300
    login_attempts_limit: int = 10
    login_attempts_window_seconds: int = 300

    # Трассировка отключена по умолчанию; экспортёр включается только явно.
    otel_traces_exporter: Literal["none", "otlp"] = "none"
    otel_traces_sampler: Literal["parentbased_traceidratio"] = "parentbased_traceidratio"
    otel_service_name: str = "rt-analytics-api"
    otel_traces_sampler_arg: float = Field(default=1.0, ge=0.0, le=1.0)


settings = Settings()
