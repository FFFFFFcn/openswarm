"""Centralized, validated application configuration."""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


if getattr(sys, "frozen", False):
    # PyInstaller bundle: skills/web/migrations are unpacked next to _MEIPASS.
    _DEFAULT_ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
else:
    _DEFAULT_ROOT = Path(__file__).resolve().parents[2]

PROJECT_ROOT = Path(os.environ.get("OPENSWARM_PROJECT_ROOT", "") or _DEFAULT_ROOT)


class Settings(BaseSettings):
    """Runtime settings loaded from OPENSWARM_* environment variables."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_prefix="OPENSWARM_",
        extra="ignore",
    )

    app_host: str = "127.0.0.1"
    app_port: int = Field(default=8000, ge=1, le=65535)
    database_path: Path = Path(".data/operations.db")
    workspace_dir: Path = Path(".data/workspaces")
    reports_dir: Path = Path(".data/reports")
    credential_vault_path: Path = Path(".data/credentials.json")
    redfox_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="REDFOX_API_KEY",
    )
    redfox_timeout_seconds: float = Field(default=30, ge=1, le=120)
    redis_mode: Literal["embedded", "external"] = "embedded"
    redis_host: str = "127.0.0.1"
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_db: int = Field(default=0, ge=0)
    redis_username: str | None = None
    redis_password: str | None = None
    redis_ssl: bool = False
    allowed_origins: Annotated[list[str], NoDecode] = [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]
    allowed_hosts: Annotated[list[str], NoDecode] = [
        "127.0.0.1",
        "localhost",
        "testserver",
    ]
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    @field_validator("allowed_origins", "allowed_hosts", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("redis_username", "redis_password", mode="before")
    @classmethod
    def normalize_empty_password(cls, value: object) -> object:
        return None if value == "" else value

    def resolve_path(self, value: Path) -> Path:
        return value if value.is_absolute() else (PROJECT_ROOT / value).resolve()

    @property
    def resolved_database_path(self) -> Path:
        return self.resolve_path(self.database_path)

    @property
    def resolved_workspace_dir(self) -> Path:
        return self.resolve_path(self.workspace_dir)

    @property
    def resolved_reports_dir(self) -> Path:
        return self.resolve_path(self.reports_dir)

    @property
    def resolved_credential_vault_path(self) -> Path:
        return self.resolve_path(self.credential_vault_path)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
