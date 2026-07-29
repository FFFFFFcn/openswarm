"""Request models for Xiaohongshu title generation and scoring."""
from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TitleInsightModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TitleGenerateRequest(TitleInsightModel):
    keyword: str = Field(min_length=1, max_length=120)
    broad_keyword_confirmed: bool = False

    @field_validator("keyword")
    @classmethod
    def trim_keyword(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("keyword must not be blank")
        if len([item for item in re.split(r"[,，]", value) if item.strip()]) > 5:
            raise ValueError("keyword supports at most 5 comma-separated terms")
        return value


class TitleScoreRequest(TitleInsightModel):
    title: str = Field(min_length=1, max_length=60)
    keyword: str = Field(min_length=1, max_length=120)
    broad_keyword_confirmed: bool = False

    @field_validator("title", "keyword")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value

    @field_validator("keyword")
    @classmethod
    def limit_keyword_count(cls, value: str) -> str:
        if len([item for item in re.split(r"[,，]", value) if item.strip()]) > 5:
            raise ValueError("keyword supports at most 5 comma-separated terms")
        return value
