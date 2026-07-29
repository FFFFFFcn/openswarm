"""Boundary models for RedFox Xiaohongshu insight searches."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, model_validator


class InsightModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KeywordGuideRequest(InsightModel):
    keyword: str = Field(default="", max_length=120)


class InsightSearchRequest(InsightModel):
    keyword: str = Field(default="", max_length=120)
    start_date: date | None = None
    end_date: date | None = None
    page_num: int = Field(default=1, ge=1, le=100)
    page_size: int = Field(default=50, ge=1, le=50)
    max_items: int = Field(default=10, ge=1, le=10)
    broad_keyword_confirmed: bool = False

    @model_validator(mode="after")
    def validate_dates(self) -> "InsightSearchRequest":
        if self.start_date and self.end_date:
            if self.start_date > self.end_date:
                raise ValueError("start_date must not be later than end_date")
            if (self.end_date - self.start_date).days > 30:
                raise ValueError("RedFox insight searches support at most 30 days")
        return self
