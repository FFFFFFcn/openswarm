from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.factory import build_app


def test_app_exposes_agentscope_and_editorial_workflow(
    tmp_path: Path,
    account_payload: dict,
    topic_payload: dict,
) -> None:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        credential_vault_path=tmp_path / "credentials.json",
        redis_mode="embedded",
    )
    with TestClient(build_app(settings)) as client:
        headers = {"X-User-ID": "u-api"}
        assert client.get("/health").json()["status"] == "ok"
        assert client.get("/ready").json() == {
            "status": "ready",
            "redis_mode": "embedded",
        }
        assert client.get("/").headers["content-type"].startswith("text/html")

        config = client.get("/api/v1/agent-team/config").json()["data"]
        assert {item["type"] for item in config["templates"]} == {
            "insight_analyst",
            "account_planner",
            "account_benchmark_analyst",
            "topic_planner",
            "content_creator",
        }
        assert client.get("/credential/schemas").status_code == 200

        account = client.post(
            "/api/v1/account-profiles",
            json=account_payload,
            headers=headers,
        )
        assert account.status_code == 201
        account_id = account.json()["data"]["id"]
        assert client.get("/api/v1/account-profiles", headers=headers).json()["data"][0]["id"] == account_id

        # Screenshot extraction with an unknown credential is a clean 409.
        extract = client.post(
            "/api/v1/account-profiles/extract",
            json={
                "image_base64": "aGVsbG8=",
                "mime_type": "image/png",
                "model": "vision-model",
                "credential_id": "missing-credential",
            },
            headers=headers,
        )
        assert extract.status_code == 409
        assert extract.headers["content-type"].startswith("application/problem+json")

        strategy = client.post(
            "/api/v1/strategies",
            json={
                "account_id": account_id,
                "positioning": "真实 AI 项目复盘",
                "persona": "一线产品经理",
                "content_pillars": ["复盘", "方法"],
                "posting_rhythm": "每周两篇",
                "growth_plan": "先验证收藏率",
            },
            headers=headers,
        )
        assert strategy.status_code == 201
        strategy_location = strategy.headers["Location"]
        assert client.get(strategy_location, headers=headers).status_code == 200
        strategy_id = strategy.json()["data"]["id"]
        approved_strategy = client.patch(
            f"/api/v1/strategies/{strategy_id}",
            json={"status": "approved"},
            headers=headers,
        )
        assert approved_strategy.json()["data"]["status"] == "approved"

        topic_response = client.post(
            "/api/v1/topics",
            json={**topic_payload, "account_id": account_id},
            headers=headers,
        )
        assert topic_response.status_code == 201
        topic_id = topic_response.json()["data"]["id"]

        bypass = client.post(
            "/api/v1/topics",
            json={**topic_payload, "account_id": account_id, "status": "approved"},
            headers=headers,
        )
        assert bypass.status_code == 422

        blocked = client.post(
            "/api/v1/drafts",
            json={
                "account_id": account_id,
                "topic_id": topic_id,
                "title": "一篇测试稿",
                "cover_text": "测试封面",
                "body": "测试正文",
            },
            headers=headers,
        )
        assert blocked.status_code == 409
        assert blocked.headers["content-type"].startswith("application/problem+json")

        approved = client.patch(
            f"/api/v1/topics/{topic_id}",
            json={"status": "approved"},
            headers=headers,
        )
        assert approved.status_code == 200
        created = client.post(
            "/api/v1/drafts",
            json={
                "account_id": account_id,
                "topic_id": topic_id,
                "title": "一篇测试稿",
                "cover_text": "测试封面",
                "body": "这是可供人工审核的正文。",
            },
            headers=headers,
        )
        assert created.status_code == 201
        assert client.get(created.headers["Location"], headers=headers).status_code == 200
        draft_id = created.json()["data"]["id"]
        risky_edit = client.patch(
            f"/api/v1/drafts/{draft_id}",
            json={"body": "这是 100% 立竿见影的最好方法。"},
            headers=headers,
        )
        assert risky_edit.status_code == 200
        notes = risky_edit.json()["data"]["compliance_notes"]
        assert any("100%" in note for note in notes)

        published_bypass = client.post(
            "/api/v1/drafts",
            json={
                "account_id": account_id,
                "topic_id": topic_id,
                "title": "绕过审核",
                "cover_text": "不应成功",
                "body": "不应直接发布。",
                "status": "published",
            },
            headers=headers,
        )
        assert published_bypass.status_code == 422

        agent = client.post(
            "/agent/",
            json={"name": "测试主理人", "system_prompt": "只做测试"},
            headers=headers,
        )
        assert agent.status_code == 201
        credential = client.post(
            "/credential/",
            json={
                "data": {
                    "type": "openai_credential",
                    "api_key": "contract-test-only",
                },
            },
            headers=headers,
        )
        assert credential.status_code == 201
        session = client.post(
            "/sessions/",
            json={
                "agent_id": agent.json()["agent_id"],
                "chat_model_config": {
                    "type": "openai_chat",
                    "credential_id": credential.json()["credential_id"],
                    "model": "contract-test-model",
                    "parameters": {},
                },
            },
            headers=headers,
        )
        assert session.status_code == 201
        sessions = client.get(
            f"/sessions/?agent_id={agent.json()['agent_id']}",
            headers=headers,
        ).json()["sessions"]
        assert sessions[0]["session"]["id"] == session.json()["session_id"]


def test_validation_errors_use_problem_shape(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
    )
    with TestClient(build_app(settings)) as client:
        response = client.post("/api/v1/account-profiles", json={})
        assert response.status_code == 422
        problem = response.json()
        assert problem["type"].endswith("validation-failed")
        assert problem["request_id"] == response.headers["X-Request-Id"]
