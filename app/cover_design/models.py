"""Request models for Xiaohongshu cover design."""
from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CoverDesignModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CoverDesignRequest(CoverDesignModel):
    keyword: str = Field(default="", max_length=200)
    days: int = Field(default=30, ge=1, le=30)
    max_items: int = Field(default=20, ge=1, le=20)
    broad_keyword_confirmed: bool = False

    @field_validator("keyword")
    @classmethod
    def trim_keyword(cls, value: str) -> str:
        value = value.strip()
        terms = [item.strip() for item in re.split(r"[,，]", value) if item.strip()]
        if len(terms) > 5:
            raise ValueError("keyword supports at most 5 comma-separated terms")
        if len(value) > 200:
            raise ValueError("keyword total length must not exceed 200 characters")
        return value
