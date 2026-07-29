from __future__ import annotations

from pathlib import Path

import pytest

from app.operations.repository import OperationsRepository
from app.operations.service import OperationsService


@pytest.fixture
def repository(tmp_path: Path) -> OperationsRepository:
    repo = OperationsRepository(
        tmp_path / "operations.db",
        Path(__file__).resolve().parents[1] / "migrations",
    )
    repo.migrate()
    return repo


@pytest.fixture
def service(repository: OperationsRepository) -> OperationsService:
    return OperationsService(repository)


@pytest.fixture
def account_payload() -> dict:
    # Includes every column create_account writes so it can be handed to the
    # repository directly as well as posted to the API (all keys are valid
    # AccountProfileUpsert fields).
    return {
        "account_name": "测试账号",
        "niche": "AI 产品工作方法",
        "target_audience": "正在转型 AI 产品经理的职场人",
        "primary_goal": "90 天验证内容定位",
        "voice": "克制、具体、有一线经验",
        "differentiators": ["真实项目复盘"],
        "forbidden_topics": ["虚构收入"],
        "red_id": "test_red_id",
        "follower_count": 1200,
        "notes_count": 42,
        "intro": "记录一线 AI 产品实践",
        "profile_url": "https://www.xiaohongshu.com/user/profile/xxx",
        "source": "manual",
    }


@pytest.fixture
def topic_payload() -> dict:
    return {
        "title": "我如何拆解一个 AI 功能",
        "angle": "从需求判断到验收的完整过程",
        "pillar": "项目复盘",
        "audience_need": "缺少可复用的方法",
        "hook": "一个功能真正难的不是写 PRD",
        "note_format": "image_text",
        "score": 82,
        "rationale": "与账号定位和读者痛点一致",
        "hashtags": ["AI产品经理"],
        "source_notes": "个人项目复盘",
    }
