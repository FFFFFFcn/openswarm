from __future__ import annotations

import json
from pathlib import Path
import urllib.parse
import urllib.request

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.errors import AppError
from app.factory import build_app
from app.title_insights.client import (
    REDFOX_TITLE_TRENDS_URL,
    RedFoxTitleTrendClient,
)
from app.title_insights.models import TitleGenerateRequest, TitleScoreRequest
from app.title_insights.service import TitleInsightService


class FakeResponse:
    def __init__(self, body: object) -> None:
        self.body = json.dumps(body).encode()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self.body


class FakeTitleClient:
    configured = True

    def fetch(self, keyword: str, source: str, start_date: str) -> dict:
        assert keyword == "AI 产品经理"
        assert source == "小红书标题生成与评分-GitHub"
        assert start_date
        return {
            "lowPowderExplosiveArticle": [
                {
                    "photoId": "note-1",
                    "title": "<script>alert(1)</script>AI产品经理的3个坑",
                    "nickname": "作者甲",
                    "interactiveCount": "1.5w",
                    "url": "https://evil.example/phishing",
                },
                {
                    "photoId": "note-2",
                    "title": "AI产品经理清单｜新手先看",
                    "nickname": "作者乙",
                    "interactiveCount": 9000,
                    "url": "https://www.xiaohongshu.com/explore/note-2",
                },
            ],
            "likeTheTop500": [
                {
                    "photoId": "note-1",
                    "title": "重复笔记",
                    "interactiveCount": 1,
                },
            ],
            "singleDayIncrements": [
                {"photoId": "note-3", "title": "为什么AI产品经理要懂Agent？"},
                {"photoId": "note-4", "title": "AI产品经理实测：这点最关键"},
            ],
            "sevenDaysOfIncrements": [
                {"photoId": "note-5", "title": "内行才懂的AI产品经理方法"},
            ],
        }


class EmptyTitleClient:
    configured = True

    def fetch(self, _keyword: str, _source: str, _start_date: str) -> dict:
        return {group: [] for group in (
            "lowPowderExplosiveArticle",
            "likeTheTop500",
            "singleDayIncrements",
            "sevenDaysOfIncrements",
        )}


class QuestionHeavyTitleClient(FakeTitleClient):
    def fetch(self, keyword: str, source: str, start_date: str) -> dict:
        data = super().fetch(keyword, source, start_date)
        data["lowPowderExplosiveArticle"] = [
            {"photoId": f"question-{index}", "title": f"AI 产品经理怎么选？{index}"}
            for index in range(8)
        ]
        data["likeTheTop500"] = []
        data["singleDayIncrements"] = []
        data["sevenDaysOfIncrements"] = []
        return data


def test_title_client_requires_key() -> None:
    with pytest.raises(AppError) as captured:
        RedFoxTitleTrendClient(None).fetch("AI", "openswarm", "2026-07-01")
    assert captured.value.status == 503


def test_title_client_uses_fixed_get_contract_without_exposing_key() -> None:
    observed: dict = {}

    def fake_open(request: urllib.request.Request, timeout: float):
        observed["method"] = request.method
        observed["url"] = request.full_url
        observed["key"] = request.get_header("X-api-key")
        observed["timeout"] = timeout
        return FakeResponse({"code": 2000, "data": {"likeTheTop500": []}})

    client = RedFoxTitleTrendClient(
        SecretStr("private-test-key"),
        timeout_seconds=12,
        open_request=fake_open,
    )
    assert client.fetch("AI 产品经理", "openswarm-redfox-community", "2026-07-01")
    parsed = urllib.parse.urlparse(observed["url"])
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == REDFOX_TITLE_TRENDS_URL
    assert urllib.parse.parse_qs(parsed.query) == {
        "keyword": ["AI 产品经理"],
        "source": ["openswarm-redfox-community"],
        "startDate": ["2026-07-01"],
    }
    assert observed["method"] == "GET"
    assert observed["key"] == "private-test-key"
    assert "private-test-key" not in observed["url"]
    assert observed["timeout"] == 12


def test_title_service_generates_ten_titles_and_safe_report(tmp_path: Path) -> None:
    service = TitleInsightService(FakeTitleClient(), tmp_path / "reports")  # type: ignore[arg-type]
    result = service.generate(TitleGenerateRequest(keyword="AI 产品经理"))
    assert len(result["titles"]) == 10
    assert len({item["title"] for item in result["titles"]}) == 10
    assert all(len(item["title"]) <= 20 for item in result["titles"])
    assert all(8 <= item["match_score"] <= 10 for item in result["titles"])
    assert max(
        sum(item["match_score"] == score for item in result["titles"])
        for score in {item["match_score"] for item in result["titles"]}
    ) <= 2
    assert all("实测" not in item["title"] and "用了" not in item["title"] for item in result["titles"])
    assert result["sample_count"] == 5
    assert result["titles"][0]["references"][0]["url"].endswith("/note-1")
    report = service.read_report(result["report_id"])
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in report
    assert "<script>alert(1)</script>" not in report
    assert "REDFOX_API_KEY" not in report


def test_title_service_scores_exact_sample_as_s(tmp_path: Path) -> None:
    service = TitleInsightService(FakeTitleClient(), tmp_path / "reports")  # type: ignore[arg-type]
    result = service.score(
        TitleScoreRequest(
            keyword="AI 产品经理",
            title="AI 产品经理清单，新手先看！",
        ),
    )
    assert result["exact_sample_match"] is True
    assert result["score"] >= 9.5
    assert result["grade"] == "S"
    assert sum(item["weight"] for item in result["dimensions"]) == 100
    assert round(sum(item["weighted_score"] for item in result["dimensions"]), 1) == result["score"]
    assert len(result["rewrites"]) == 3


def test_title_service_requires_confirmation_for_broad_keyword(tmp_path: Path) -> None:
    service = TitleInsightService(FakeTitleClient(), tmp_path / "reports")  # type: ignore[arg-type]
    with pytest.raises(AppError) as captured:
        service.generate(TitleGenerateRequest(keyword="AI"))
    assert captured.value.status == 409
    assert len(captured.value.errors[0]["suggestions"]) == 10  # type: ignore[index]


def test_title_service_blocks_empty_samples(tmp_path: Path) -> None:
    service = TitleInsightService(EmptyTitleClient(), tmp_path / "reports")  # type: ignore[arg-type]
    with pytest.raises(AppError) as captured:
        service.generate(TitleGenerateRequest(keyword="AI产品经理"))
    assert captured.value.status == 409
    assert captured.value.code == "title-samples-not-found"


def test_samples_change_candidate_order_and_scores(tmp_path: Path) -> None:
    baseline = TitleInsightService(FakeTitleClient(), tmp_path / "a").generate(  # type: ignore[arg-type]
        TitleGenerateRequest(keyword="AI 产品经理"),
    )
    question_heavy = TitleInsightService(QuestionHeavyTitleClient(), tmp_path / "b").generate(  # type: ignore[arg-type]
        TitleGenerateRequest(keyword="AI 产品经理"),
    )
    assert [item["title"] for item in baseline["titles"]] != [
        item["title"] for item in question_heavy["titles"]
    ]
    assert [item["match_score"] for item in baseline["titles"]] != [
        item["match_score"] for item in question_heavy["titles"]
    ]
    baseline_score = TitleInsightService(FakeTitleClient(), tmp_path / "c").score(  # type: ignore[arg-type]
        TitleScoreRequest(keyword="AI 产品经理", title="AI 产品经理怎么选？"),
    )
    question_score = TitleInsightService(QuestionHeavyTitleClient(), tmp_path / "d").score(  # type: ignore[arg-type]
        TitleScoreRequest(keyword="AI 产品经理", title="AI 产品经理怎么选？"),
    )
    assert baseline_score["score"] != question_score["score"]


def test_growth_interaction_and_keyword_count_contract(tmp_path: Path) -> None:
    sample = TitleInsightService._sample(
        {
            "photoId": "growth-1",
            "title": "增长样本",
            "anaAdd": {"addInteractiveount": "1.2w"},
            "useLikeCount": 100,
            "useShareCount": 20,
            "useCommentCount": 30,
        },
    )
    assert sample["interaction_count"] == 12000
    with pytest.raises(ValueError):
        TitleGenerateRequest(keyword="一,二,三,四,五,六")


def test_title_api_reports_missing_configuration(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        reports_dir=tmp_path / "reports",
        redfox_api_key=None,
    )
    with TestClient(build_app(settings)) as client:
        status = client.get("/api/v1/title-insights/status").json()["data"]
        assert status["provider"] == "redfox"
        assert status["configured"] is False
        response = client.post(
            "/api/v1/title-insights/generate",
            json={"keyword": "AI 产品经理"},
        )
        assert response.status_code == 503
        assert response.json()["type"].endswith("data-api-key-required")
