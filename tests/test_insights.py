from __future__ import annotations

import json
import urllib.request
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.core.errors import AppError
from app.factory import build_app
from app.insights.client import RedFoxClient
from app.insights.models import InsightSearchRequest
from app.insights.service import InsightService


class FakeResponse:
    def __init__(self, body: dict) -> None:
        self.body = json.dumps(body).encode()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self.body


class FakeRedFoxClient:
    configured = True

    def search(self, payload: dict) -> dict:
        assert payload["source"] == "openswarm-redfox-community"
        return {
            "keyword": payload["keyword"],
            "total": 1,
            "articles": [
                {
                    "id": "note-1",
                    "title": "<script>alert(1)</script>AI 产品复盘",
                    "desc": "真实项目经验",
                    "authorId": "author-1",
                    "authorNickname": "测试作者",
                    "createTime": "2026-07-22",
                    "interactiveCount": "1.5w",
                    "likedCount": 12000,
                    "collectedCount": 2500,
                    "commentsCount": 300,
                    "sharedCount": 200,
                    "relevanceScore": 9.5,
                    "popularityScore": 2.8,
                    "recencyScore": 2,
                    "totalScore": 14.3,
                    "shareInfoLink": "https://evil.example/phishing",
                },
            ],
            "relatedSearches": ["AI智能体"],
            "hotTopics": [{"name": "效率工具"}],
            "latestHotArticles": [
                {
                    "id": "note-2",
                    "title": "近期热门",
                    "authorNickname": "推荐作者",
                    "interactiveCount": 9000,
                    "shareInfoLink": "https://www.xiaohongshu.com/explore/note-2",
                },
            ],
        }


def test_redfox_client_requires_key() -> None:
    client = RedFoxClient(None)
    with pytest.raises(AppError) as captured:
        client.search({})
    assert captured.value.status == 503
    assert captured.value.code == "data-api-key-required"


def test_redfox_client_sends_key_without_exposing_it() -> None:
    observed: dict = {}

    def fake_urlopen(request: urllib.request.Request, timeout: float):
        observed["key"] = request.get_header("X-api-key")
        observed["url"] = request.full_url
        observed["payload"] = json.loads(request.data or b"{}")
        observed["timeout"] = timeout
        return FakeResponse({"code": 2000, "data": {"articles": []}})

    client = RedFoxClient(
        SecretStr("test-secret"),
        timeout_seconds=12,
        open_request=fake_urlopen,
    )
    assert client.search({"keyword": "AI"}) == {"articles": []}
    assert observed == {
        "key": "test-secret",
        "url": "https://redfox.hk/story/api/xhs/search/search",
        "payload": {"keyword": "AI"},
        "timeout": 12,
    }


def test_redfox_client_maps_invalid_root_to_502() -> None:
    def invalid_response(*_args, **_kwargs):
        return FakeResponse(["not", "an", "object"])  # type: ignore[arg-type]

    client = RedFoxClient(
        SecretStr("test-secret"),
        open_request=invalid_response,
    )
    with pytest.raises(AppError) as captured:
        client.search({"keyword": "AI"})
    assert captured.value.status == 502


def test_insight_service_guides_broad_terms_and_generates_safe_report(
    tmp_path: Path,
) -> None:
    service = InsightService(FakeRedFoxClient(), tmp_path / "reports")  # type: ignore[arg-type]
    guide = service.guide_keyword("美食")
    assert guide["is_broad"] is True
    assert len(guide["suggestions"]) == 10

    with pytest.raises(AppError) as captured:
        service.search(InsightSearchRequest(keyword="美食"))
    assert captured.value.status == 409

    result = service.search(
        InsightSearchRequest(
            keyword="AI 产品经理",
            start_date=date(2026, 7, 16),
            end_date=date(2026, 7, 22),
        ),
    )
    assert result["items"][0]["interactive_count"] == 15000
    assert result["items"][0]["total_score"] == 14.3
    assert result["items"][0]["note_url"].endswith("/note-1")
    assert result["hot_topics"] == ["效率工具"]
    assert result["latest_hot_articles"][0]["title"] == "近期热门"
    report = service.read_report(result["report_id"])
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in report
    assert "<script>alert(1)</script>" not in report
    assert "近期热门推荐" in report


def test_insight_api_reports_missing_configuration(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        reports_dir=tmp_path / "reports",
        redfox_api_key=None,
    )
    with TestClient(build_app(settings)) as client:
        status = client.get("/api/v1/insights/status").json()["data"]
        assert status["provider"] == "redfox"
        assert status["configured"] is False
        response = client.post(
            "/api/v1/insights/search",
            json={
                "keyword": "AI 产品经理",
                "start_date": "2026-07-16",
                "end_date": "2026-07-22",
            },
        )
        assert response.status_code == 503
        assert response.json()["type"].endswith("data-api-key-required")
