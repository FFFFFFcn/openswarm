"""Boundary models for Xiaohongshu account benchmark searches."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AccountBenchmarkModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccountBenchmarkSearchRequest(AccountBenchmarkModel):
    query_mode: Literal["red_id", "filters"] = "filters"
    red_id: str | None = Field(default=None, min_length=1, max_length=64)
    track: str | None = Field(default=None, max_length=40)
    min_fans: int | None = Field(default=None, ge=0, le=100_000_000)
    max_fans: int | None = Field(default=None, ge=0, le=100_000_000)
    level: str | None = Field(default=None, max_length=20)
    max_items: int = Field(default=10, ge=1, le=10)

    @field_validator("red_id", "track", "level", mode="before")
    @classmethod
    def normalize_text(cls, value: object) -> object:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    @field_validator("red_id")
    @classmethod
    def validate_red_id(cls, value: str | None) -> str | None:
        if value and not all(character.isalnum() or character in "-_" for character in value):
            raise ValueError("red_id may only contain letters, numbers, hyphens and underscores")
        return value

    @model_validator(mode="after")
    def validate_query(self) -> "AccountBenchmarkSearchRequest":
        if self.query_mode == "red_id":
            if not self.red_id:
                raise ValueError("red_id is required when query_mode is red_id")
        elif not any(
            value is not None
            for value in (self.track, self.min_fans, self.max_fans, self.level)
        ):
            raise ValueError("filter mode requires a track, fan range or account level")
        if (
            self.min_fans is not None
            and self.max_fans is not None
            and self.min_fans > self.max_fans
        ):
            raise ValueError("min_fans must not exceed max_fans")
        return self
