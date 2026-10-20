"""Конфигурация приложения. Все параметры задаются через переменные окружения (12-factor)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "CreditFlow API"
    app_version: str = "1.0.0"
    environment: str = "local"

    database_url: str = "postgresql+psycopg://creditflow:creditflow@localhost:5432/creditflow"

    jwt_secret: str = "change-me-in-production-please-32b"
    jwt_ttl_minutes: int = 480

    # Базовый URL сервиса-симулятора внешних систем (ЕГРЮЛ, ФНС, БКИ, антифрод, АБС)
    mocks_url: str = "http://localhost:8090"
    integration_timeout_sec: float = 3.0
    integration_retries: int = 3

    # Конвейер
    pipeline_step_delay_sec: float = 1.5  # искусственная пауза между этапами, чтобы в демо был виден прогресс
    worker_poll_interval_sec: float = 0.5
    run_pipeline_inline: bool = False  # True: этапы выполняются синхронно (тесты, режим без воркера)

    # Кредитная политика
    key_rate: float = 14.0  # ключевая ставка ЦБ РФ, % годовых (на октябрь 2026)
    auto_decision_limit: float = 10_000_000  # выше этой суммы автоматическое одобрение запрещено
    committee_limit: float = 15_000_000  # выше этой суммы нужно второе подтверждение риск-менеджера
    offer_ttl_days: int = 14

    # LLM (опционально, только open-weights модели через Ollama)
    llm_enabled: bool = False
    ollama_url: str = "http://ollama:11434"
    llm_model: str = "qwen2.5:1.5b-instruct"
    llm_timeout_sec: float = 25.0

    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    seed_demo_data: bool = True
    max_upload_mb: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
