from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.account_benchmark.client import RedFoxAccountClient
from app.account_benchmark.models import AccountBenchmarkSearchRequest
from app.account_benchmark.service import AccountBenchmarkService
from app.core.config import Settings
from app.core.errors import AppError
from app.factory import build_app


class FakeResponse:
    def __init__(self, body: dict) -> None:
        self.body = json.dumps(body).encode()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self.body


class FakeAccountClient:
    configured = True

    def __init__(self) -> None:
        self.payloads: list[dict] = []

    def query(self, payload: dict) -> dict:
        self.payloads.append(payload)
        return {
            "sameLevelAccounts": [
                {
                    "redId": "same-1",
                    "nickname": "<script>alert(1)</script>早餐研究所",
                    "url": "https://evil.example/phishing",
                    "fans": 2800,
                    "level": "素人",
                    "track": "美味佳肴",
                    "interactiveCountThirty": 12000,
                    "interactiveCountSeven": 3200,
                    "noteCountSeven": 5,
                    "totalWork": 130,
                    "liked": 30000,
                    "collected": 9000,
                    "gmtCreate": "2026-07-20 08:00:00",
                    "works": [
                        {
                            "id": "note-1",
                            "title": "<img src=x onerror=alert(1)>5分钟早餐",
                            "likedCount": 1800,
                            "collectedCount": 700,
                            "sharedCount": 50,
                            "shareInfoLink": "https://evil.example/note",
                        },
                    ],
                },
            ],
            "highLevelAccounts": [
                {
                    "redId": "high-1",
                    "nickname": "成熟美食号",
                    "url": "https://www.xiaohongshu.com/user/profile/high-1",
                    "fans": 15000,
                    "level": "腰部kol",
                    "track": "美味佳肴",
                    "interactiveCountThirty": 86000,
                    "interactiveCountSeven": 13000,
                    "noteCountSeven": 7,
                    "totalWork": 520,
                    "liked": 180000,
                    "collected": 70000,
                    "gmtCreate": "2026-07-21 08:00:00",
                },
            ],
        }


def test_account_client_requires_key() -> None:
    client = RedFoxAccountClient(None)
    with pytest.raises(AppError) as captured:
        client.query({})
    assert captured.value.status == 503
    assert captured.value.code == "data-api-key-required"


def test_account_client_uses_fixed_endpoint_and_api_key() -> None:
    observed: dict = {}

    def fake_urlopen(request: urllib.request.Request, timeout: float):
        observed["key"] = request.get_header("X-api-key")
        observed["url"] = request.full_url
        observed["payload"] = json.loads(request.data or b"{}")
        observed["timeout"] = timeout
        return FakeResponse(
            {
                "code": 2000,
                "data": {
                    "sameLevelAccounts": [],
                    "highLevelAccounts": [],
                },
            },
        )

    client = RedFoxAccountClient(
        SecretStr("test-secret"),
        timeout_seconds=12,
        open_request=fake_urlopen,
    )
    assert client.query({"track": "数码科技"}) == {
        "sameLevelAccounts": [],
        "highLevelAccounts": [],
    }
    assert observed == {
        "key": "test-secret",
        "url": "https://redfox.hk/story/api/xhsUser/querySimilarAccounts",
        "payload": {"track": "数码科技"},
        "timeout": 12,
    }


def test_account_client_translates_upstream_filter_error() -> None:
    def fake_urlopen(
        _request: urllib.request.Request,
        timeout: float,
    ) -> FakeResponse:
        assert timeout == 30
        return FakeResponse(
            {
                "code": 5000,
                "msg": "接口执行异常，积分未扣除: null",
            },
        )

    client = RedFoxAccountClient(
        SecretStr("test-secret"),
        open_request=fake_urlopen,
    )

    with pytest.raises(AppError) as captured:
        client.query({"track": "综合全部"})

    assert captured.value.status == 422
    assert captured.value.code == "invalid-account-filters"


def test_account_request_validates_modes_and_fan_range() -> None:
    with pytest.raises(ValidationError):
        AccountBenchmarkSearchRequest(query_mode="red_id")
    with pytest.raises(ValidationError):
        AccountBenchmarkSearchRequest(
            query_mode="filters",
            track="美食",
            min_fans=5000,
            max_fans=1000,
        )


def test_account_service_maps_filters_and_generates_safe_report(
    tmp_path: Path,
) -> None:
    client = FakeAccountClient()
    service = AccountBenchmarkService(
        client,  # type: ignore[arg-type]
        tmp_path / "reports",
    )
    result = service.search(
        AccountBenchmarkSearchRequest(
            query_mode="filters",
            track="做饭",
            max_fans=3000,
            level="小白",
        ),
    )
    assert client.payloads == [
        {
            "redId": "",
            "track": "美味佳肴",
            "maxFans": 3000,
            "minFans": 0,
            "level": "素人",
            "source": "openswarm-redfox-community",
        },
    ]
    same = result["same_level_accounts"][0]
    assert same["profile_url"].endswith("/same-1")
    assert same["top_works"][0]["url"].endswith("/note-1")
    assert same["interaction_fan_ratio_30"] == 428.57
    assert result["high_level_accounts"][0]["nickname"] == "成熟美食号"
    assert result["kol_candidates"][0]["nickname"] == "成熟美食号"
    assert result["summary"]["same_level_count"] == 1
    assert result["summary"]["high_level_count"] == 1
    report = service.read_report(result["report_id"])
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in report
    assert "<script>alert(1)</script>" not in report
    assert "evil.example" not in report
    assert "KOL 投放候选数据初筛" in report


def test_account_service_tolerates_null_works_and_extreme_numbers(
    tmp_path: Path,
) -> None:
    class DirtyDataClient(FakeAccountClient):
        def query(self, payload: dict) -> dict:
            self.payloads.append(payload)
            return {
                "sameLevelAccounts": [
                    {
                        "redId": "safe-account",
                        "nickname": "异常上游数据",
                        "fans": "1e999999",
                        "interactiveCountThirty": "NaN",
                        "works": None,
                    },
                ],
                "highLevelAccounts": [],
            }

    client = DirtyDataClient()
    service = AccountBenchmarkService(
        client,  # type: ignore[arg-type]
        tmp_path / "reports",
    )

    result = service.search(
        AccountBenchmarkSearchRequest(
            query_mode="filters",
            track="数码科技",
        ),
    )

    account = result["same_level_accounts"][0]
    assert account["fans"] == 0
    assert account["interactive_30"] == 0
    assert account["top_works"] == []


def test_account_service_rejects_unnarrowed_all_track(
    tmp_path: Path,
) -> None:
    client = FakeAccountClient()
    service = AccountBenchmarkService(
        client,  # type: ignore[arg-type]
        tmp_path / "reports",
    )

    with pytest.raises(AppError) as captured:
        service.search(
            AccountBenchmarkSearchRequest(
                query_mode="filters",
                track="综合全部",
                level="素人",
            ),
        )

    assert captured.value.status == 422
    assert captured.value.code == "account-benchmark-filters-too-broad"
    assert client.payloads == []


def test_account_benchmark_api_reports_missing_configuration(
    tmp_path: Path,
) -> None:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        reports_dir=tmp_path / "reports",
        redfox_api_key=None,
    )
    with TestClient(build_app(settings)) as client:
        status = client.get("/api/v1/account-benchmarks/status").json()["data"]
        assert status["provider"] == "redfox"
        assert status["configured"] is False
        assert "数码科技" in status["categories"]
        response = client.post(
            "/api/v1/account-benchmarks/search",
            json={
                "query_mode": "filters",
                "track": "数码科技",
                "level": "素人",
            },
        )
        assert response.status_code == 503
        assert response.json()["type"].endswith("data-api-key-required")
