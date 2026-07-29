"""Boundary models for account strategy, topics, and Xiaohongshu drafts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccountProfileUpsert(ApiModel):
    account_name: str = Field(min_length=1, max_length=80)
    niche: str = Field(min_length=1, max_length=120)
    target_audience: str = Field(default="", max_length=500)
    primary_goal: str = Field(default="", max_length=300)
    voice: str = Field(default="", max_length=300)
    differentiators: list[str] = Field(default_factory=list, max_length=12)
    forbidden_topics: list[str] = Field(default_factory=list, max_length=30)
    red_id: str = Field(default="", max_length=64)
    follower_count: int | None = Field(default=None, ge=0)
    notes_count: int | None = Field(default=None, ge=0)
    intro: str = Field(default="", max_length=1000)
    profile_url: str = Field(default="", max_length=500)
    source: Literal["manual", "screenshot"] = "manual"


class AccountExtractRequest(ApiModel):
    image_base64: str = Field(min_length=1, max_length=14_000_000)
    mime_type: str = Field(default="image/png", pattern=r"^image/(png|jpeg|webp)$")
    model: str = Field(min_length=1, max_length=120)
    credential_id: str = Field(min_length=1, max_length=64)


class StrategyCreate(ApiModel):
    account_id: str = Field(min_length=1, max_length=64)
    positioning: str = Field(min_length=1, max_length=1000)
    persona: str = Field(min_length=1, max_length=1000)
    content_pillars: list[str] = Field(min_length=1, max_length=8)
    posting_rhythm: str = Field(min_length=1, max_length=500)
    growth_plan: str = Field(min_length=1, max_length=2000)
    created_by_agent: str | None = Field(default=None, max_length=120)


class StrategyUpdate(ApiModel):
    status: Literal["draft", "approved", "archived"]


class TopicCreate(ApiModel):
    account_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    angle: str = Field(min_length=1, max_length=800)
    pillar: str = Field(min_length=1, max_length=120)
    audience_need: str = Field(min_length=1, max_length=500)
    hook: str = Field(min_length=1, max_length=500)
    note_format: Literal["image_text", "video"] = "image_text"
    score: int = Field(default=70, ge=0, le=100)
    rationale: str = Field(min_length=1, max_length=1000)
    hashtags: list[str] = Field(default_factory=list, max_length=20)
    source_notes: str = Field(default="", max_length=2000)


class TopicUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    angle: str | None = Field(default=None, min_length=1, max_length=800)
    pillar: str | None = Field(default=None, min_length=1, max_length=120)
    score: int | None = Field(default=None, ge=0, le=100)
    status: Literal["idea", "approved", "rejected", "drafting", "ready"] | None = (
        None
    )
    hashtags: list[str] | None = Field(default=None, max_length=20)


class DraftCreate(ApiModel):
    account_id: str = Field(min_length=1, max_length=64)
    topic_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=120)
    cover_text: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=10000)
    hashtags: list[str] = Field(default_factory=list, max_length=20)
    image_prompts: list[str] = Field(default_factory=list, max_length=18)
    compliance_notes: list[str] = Field(default_factory=list, max_length=30)


class DraftUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    cover_text: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = Field(default=None, min_length=1, max_length=10000)
    hashtags: list[str] | None = Field(default=None, max_length=20)
    image_prompts: list[str] | None = Field(default=None, max_length=18)
    compliance_notes: list[str] | None = Field(default=None, max_length=30)
    status: Literal["draft", "review", "approved", "published"] | None = None


class ComplianceRequest(ApiModel):
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=10000)
