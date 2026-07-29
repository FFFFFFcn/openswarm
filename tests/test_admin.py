from __future__ import annotations

import json
from pathlib import Path

from agentscope.agent import ContextConfig, ReActConfig
from agentscope.app.storage import (
    AgentData,
    AgentRecord,
    TeamData,
    TeamMember,
    TeamRecord,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.admin.router import create_admin_router
from app.agent_team.prompts import INSIGHT_ANALYST_PROMPT, LEADER_SYSTEM_PROMPT
from app.agent_team.tools import build_role_tools_inspector
from app.core.config import Settings
from app.operations.repository import OperationsRepository
from app.operations.service import OperationsService

USER = "local-user"


class _StubStorage:
    """In-memory stand-in for the AgentScope Redis storage.

    Only the read methods the admin router touches are implemented;
    records are the real pydantic models so field access matches
    production behaviour.
    """

    def __init__(self) -> None:
        self.agents: dict[str, list[AgentRecord]] = {}
        self.teams: dict[str, list[TeamRecord]] = {}
        self.sessions: dict[tuple[str, str], list[object]] = {}

    async def list_agents(self, user_id: str) -> list[AgentRecord]:
        return self.agents.get(user_id, [])

    async def list_sessions(
        self,
        user_id: str,
        agent_id: str,
    ) -> list[object]:
        return self.sessions.get((user_id, agent_id), [])

    async def list_teams(self, user_id: str) -> list[TeamRecord]:
        return self.teams.get(user_id, [])


class _StubRuntime:
    def __init__(self, available: bool = True) -> None:
        self.storage = _StubStorage()
        self._available = available

    async def ping(self) -> bool:
        if not self._available:
            raise ConnectionError("runtime down")
        return True


def _agent_record(name: str, source: str, system_prompt: str) -> AgentRecord:
    return AgentRecord(
        user_id=USER,
        source=source,
        data=AgentData(
            name=name,
            system_prompt=system_prompt,
            context_config=ContextConfig(),
            react_config=ReActConfig(),
        ),
    )


def _build_settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        reports_dir=tmp_path / "reports",
        credential_vault_path=tmp_path / "credentials.json",
    )


def _build_client(
    settings: Settings,
    repository: OperationsRepository,
    runtime: _StubRuntime | None = None,
) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_admin_router(settings, repository, runtime or _StubRuntime()),
    )
    return TestClient(app)


def _write_vault(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "credentials": [
                    {
                        "id": "cred-1",
                        "updated_at": "2026-01-01T00:00:00",
                        "created_at": "2026-01-01T00:00:00",
                        "user_id": USER,
                        "data": {
                            "id": "cred-1",
                            "name": "Openai",
                            "type": "openai_credential",
                            "api_key": "sk-secret1234567890",
                            "organization": None,
                            "base_url": "https://example.test/v1",
                        },
                    },
                ],
            },
        ),
        encoding="utf-8",
    )


def _seed_topic(repository: OperationsRepository, topic_payload: dict) -> str:
    account = repository.create_account(
        USER,
        {
            "account_name": "测试账号",
            "niche": "AI",
            "target_audience": "职场人",
            "primary_goal": "验证定位",
            "voice": "克制",
            "differentiators": [],
            "forbidden_topics": [],
            "red_id": "",
            "follower_count": None,
            "notes_count": None,
            "intro": "",
            "profile_url": "",
            "source": "manual",
        },
    )
    topic = repository.create_topic(
        USER,
        account["id"],
        {**topic_payload, "status": "idea"},
    )
    return topic["id"]


def test_admin_overview(
    tmp_path: Path,
    repository: OperationsRepository,
    topic_payload: dict,
) -> None:
    settings = _build_settings(tmp_path)
    _write_vault(settings.resolved_credential_vault_path)
    _seed_topic(repository, topic_payload)
    reports = settings.resolved_reports_dir
    reports.mkdir()
    (reports / "a.html").write_text("<html></html>", encoding="utf-8")
    workspace = settings.resolved_workspace_dir / "ws-1"
    workspace.mkdir(parents=True)
    (workspace / "file.txt").write_text("data", encoding="utf-8")

    client = _build_client(settings, repository)
    payload = client.get("/api/v1/admin/overview").json()["data"]

    assert payload["counts"]["topics"] == 1
    assert payload["counts"]["credentials"] == 1
    assert payload["counts"]["strategies"] == 0
    assert payload["storage"]["database_size"] > 0
    assert payload["storage"]["reports_files"] == 1
    assert payload["storage"]["workspaces_count"] == 1
    assert payload["storage"]["workspaces_size"] > 0
    assert set(payload["storage"]["logs"]) == {"backend", "error"}


def test_admin_logs_whitelist(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    (tmp_path / "backend.log").write_text(
        "line1\nline2\nERROR boom\n",
        encoding="utf-8",
    )
    client = _build_client(settings, repository)

    payload = client.get("/api/v1/admin/logs?name=backend&tail=2").json()["data"]
    assert payload["lines"] == ["line2", "ERROR boom"]
    assert payload["size"] > 0

    # Missing error log is served as empty, not an error.
    empty = client.get("/api/v1/admin/logs?name=error").json()["data"]
    assert empty["lines"] == []

    # Only whitelisted names / bounded tail values are accepted.
    assert client.get("/api/v1/admin/logs?name=../../etc").status_code == 422
    assert client.get("/api/v1/admin/logs?name=other").status_code == 422
    assert client.get("/api/v1/admin/logs?name=backend&tail=5000").status_code == 422


def test_admin_workspaces_list_and_batch_delete(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    root = settings.resolved_workspace_dir
    for name in ("ws-old", "ws-new"):
        target = root / name
        target.mkdir(parents=True)
        (target / "artifact.txt").write_text(name, encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    client = _build_client(settings, repository)

    listing = client.get("/api/v1/admin/workspaces").json()["data"]
    assert {item["id"] for item in listing} == {"ws-old", "ws-new"}
    assert all(item["files"] == 1 and item["size"] > 0 for item in listing)

    # Traversal ids are rejected before any deletion happens.
    for bad in ("../outside.txt", "a/b", "a\\b", ".."):
        response = client.post(
            "/api/v1/admin/workspaces/batch-delete",
            json={"ids": [bad]},
        )
        assert response.status_code == 400
    assert outside.exists()

    response = client.post(
        "/api/v1/admin/workspaces/batch-delete",
        json={"ids": ["ws-old", "missing"]},
    )
    assert response.status_code == 200
    body = response.json()["data"]
    assert body["deleted"] == ["ws-old"]
    assert body["skipped"] == ["missing"]
    assert not (root / "ws-old").exists()
    assert (root / "ws-new").exists()

    assert (
        client.post(
            "/api/v1/admin/workspaces/batch-delete",
            json={"ids": []},
        ).status_code
        == 422
    )


def test_admin_credentials_masked_and_delete(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    _write_vault(settings.resolved_credential_vault_path)
    client = _build_client(settings, repository)

    listing = client.get("/api/v1/admin/credentials").json()["data"]
    assert len(listing) == 1
    record = listing[0]
    assert record["id"] == "cred-1"
    assert record["type"] == "openai_credential"
    assert record["api_key_masked"] == "sk-s…7890"
    assert "sk-secret1234567890" not in json.dumps(listing)

    assert client.delete("/api/v1/admin/credentials/unknown").status_code == 404
    deleted = client.delete("/api/v1/admin/credentials/cred-1")
    assert deleted.status_code == 200
    assert deleted.json()["data"]["deleted"] == "cred-1"
    vault = json.loads(
        settings.resolved_credential_vault_path.read_text("utf-8"),
    )
    assert vault["credentials"] == []


def test_admin_business_deletes(
    tmp_path: Path,
    repository: OperationsRepository,
    topic_payload: dict,
) -> None:
    settings = _build_settings(tmp_path)
    client = _build_client(settings, repository)
    topic_id = _seed_topic(repository, topic_payload)
    account_id = repository.list_accounts(USER)[0]["id"]
    draft = repository.create_draft(
        USER,
        account_id,
        {
            "topic_id": topic_id,
            "title": "草稿标题",
            "cover_text": "封面",
            "body": "正文",
            "hashtags": [],
            "image_prompts": [],
            "compliance_notes": [],
            "status": "draft",
        },
    )
    strategy = repository.create_strategy(
        USER,
        account_id,
        {
            "positioning": "定位",
            "persona": "人设",
            "content_pillars": ["支柱"],
            "posting_rhythm": "每周 3 篇",
            "growth_plan": "计划",
            "status": "draft",
        },
    )

    other_user = {"X-User-ID": "someone-else"}
    assert (
        client.delete(f"/api/v1/admin/drafts/{draft['id']}", headers=other_user)
        .status_code
        == 404
    )

    # Topic still has a draft: FK RESTRICT surfaces as a 409 conflict.
    conflict = client.delete(f"/api/v1/admin/topics/{topic_id}")
    assert conflict.status_code == 409

    assert client.delete(f"/api/v1/admin/drafts/{draft['id']}").status_code == 200
    assert repository.get_draft(USER, draft["id"]) is None
    assert client.delete(f"/api/v1/admin/topics/{topic_id}").status_code == 200
    assert repository.get_topic(USER, topic_id) is None
    assert (
        client.delete(f"/api/v1/admin/strategies/{strategy['id']}").status_code
        == 200
    )
    assert repository.get_strategy(USER, strategy["id"]) is None

    # Deleting again yields 404.
    assert client.delete(f"/api/v1/admin/topics/{topic_id}").status_code == 404


def test_admin_agent_team_empty(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    client = _build_client(settings, repository)

    payload = client.get("/api/v1/admin/agent-team").json()["data"]
    assert payload["agents"] == []
    assert payload["teams"] == []
    assert payload["runtime"] == {"redis_mode": "embedded", "available": True}


def test_admin_agent_team_listing_and_isolation(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    runtime = _StubRuntime()
    leader = _agent_record("小红书内容主理人", "user", "leader prompt")
    worker = _agent_record("洞察分析师", "team", INSIGHT_ANALYST_PROMPT)
    runtime.storage.agents[USER] = [leader, worker]
    runtime.storage.sessions[(USER, leader.id)] = [object(), object()]
    runtime.storage.teams[USER] = [
        TeamRecord(
            user_id=USER,
            session_id="session-1",
            data=TeamData(
                name="内容团队",
                description="选题到草稿",
                members=[
                    TeamMember(
                        owner_id=USER,
                        agent_id=worker.id,
                        session_id="session-2",
                        role="created",
                    ),
                ],
            ),
        ),
    ]
    client = _build_client(settings, repository, runtime)

    payload = client.get("/api/v1/admin/agent-team").json()["data"]
    by_id = {item["id"]: item for item in payload["agents"]}
    assert by_id[leader.id]["source"] == "user"
    assert by_id[leader.id]["role"] is None
    assert by_id[leader.id]["sessions"] == 2
    assert by_id[leader.id]["system_prompt"] == "leader prompt"
    assert by_id[worker.id]["source"] == "team"
    assert by_id[worker.id]["role"] == "insight-analyst"
    assert by_id[worker.id]["system_prompt"] == INSIGHT_ANALYST_PROMPT
    assert by_id[worker.id]["sessions"] == 0
    team = payload["teams"][0]
    assert team["name"] == "内容团队"
    assert team["members"] == 1

    counts = client.get("/api/v1/admin/overview").json()["data"]["counts"]
    assert counts["agents"] == 2
    assert counts["teams"] == 1

    # A different user sees nothing (per-user isolation).
    other = client.get(
        "/api/v1/admin/agent-team",
        headers={"X-User-ID": "someone-else"},
    ).json()["data"]
    assert other["agents"] == []
    assert other["teams"] == []


def test_admin_agent_team_runtime_down_reported(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    client = _build_client(settings, repository, _StubRuntime(available=False))

    payload = client.get("/api/v1/admin/agent-team").json()["data"]
    assert payload["runtime"]["available"] is False


def test_admin_agent_team_roles(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    inspector = build_role_tools_inspector(
        repository,
        OperationsService(repository),
    )
    app = FastAPI()
    app.include_router(
        create_admin_router(settings, repository, _StubRuntime(), inspector),
    )
    client = TestClient(app)

    roles = client.get("/api/v1/admin/agent-team/roles").json()["data"]
    by_key = {item["key"]: item for item in roles}
    assert len(roles) == 6

    leader = by_key["leader"]
    assert leader["kind"] == "leader"
    assert leader["system_prompt"] == LEADER_SYSTEM_PROMPT
    assert leader["skill_path"] == "skills/leader/SKILL.md"
    assert leader["skill"]  # SKILL.md exists in the repo
    leader_tools = {tool["name"] for tool in leader["tools"]}
    assert "ask_user" in leader_tools
    assert "get_account_context" in leader_tools
    ask_user = next(t for t in leader["tools"] if t["name"] == "ask_user")
    assert ask_user["kind"] == "user_interaction"
    assert ask_user["read_only"] is True

    creator = by_key["content_creator"]
    assert creator["kind"] == "worker"
    assert creator["system_prompt"]
    assert creator["skill"]
    creator_tools = {tool["name"] for tool in creator["tools"]}
    assert "create_xiaohongshu_draft" in creator_tools
    assert "check_xiaohongshu_compliance" in creator_tools
    draft_tool = next(
        t for t in creator["tools"] if t["name"] == "create_xiaohongshu_draft"
    )
    assert draft_tool["kind"] == "local"
    assert draft_tool["read_only"] is False

    # Without RedFox services wired the data roles expose no tools.
    assert by_key["insight_analyst"]["tools"] == []
    assert by_key["account_benchmark_analyst"]["tools"] == []


def test_admin_agent_team_roles_without_inspector(
    tmp_path: Path,
    repository: OperationsRepository,
) -> None:
    settings = _build_settings(tmp_path)
    client = _build_client(settings, repository)

    roles = client.get("/api/v1/admin/agent-team/roles").json()["data"]
    assert len(roles) == 6
    assert all(item["tools"] == [] for item in roles)
    assert all(item["system_prompt"] for item in roles)


def _redfox_settings(tmp_path: Path) -> Settings:
    # _env_file=None keeps a developer's local .env (which may hold a real
    # REDFOX_API_KEY) out of these assertions; the env var itself is
    # controlled per-test via monkeypatch.
    return Settings(
        _env_file=None,
        database_path=tmp_path / "operations.db",
        workspace_dir=tmp_path / "workspaces",
        reports_dir=tmp_path / "reports",
        credential_vault_path=tmp_path / "credentials.json",
    )


def test_admin_redfox_key_roundtrip(
    tmp_path: Path,
    repository: OperationsRepository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("REDFOX_API_KEY", raising=False)
    settings = _redfox_settings(tmp_path)
    client = _build_client(settings, repository)

    initial = client.get("/api/v1/admin/redfox-key").json()["data"]
    assert initial == {"configured": False, "source": None, "api_key_masked": ""}

    response = client.put(
        "/api/v1/admin/redfox-key",
        json={"api_key": "rf-live-key-0001"},
    )
    assert response.status_code == 200
    updated = response.json()["data"]
    assert updated["configured"] is True
    assert updated["source"] == "stored"
    assert updated["api_key_masked"] == "rf-l…0001"
    assert "rf-live-key-0001" not in response.text
    key_file = tmp_path / "redfox_key.json"
    assert json.loads(key_file.read_text("utf-8"))["api_key"] == "rf-live-key-0001"

    # A fresh router instance reloads the stored key from disk.
    reloaded = _build_client(settings, repository)
    assert (
        reloaded.get("/api/v1/admin/redfox-key").json()["data"]["source"]
        == "stored"
    )

    cleared = client.delete("/api/v1/admin/redfox-key").json()["data"]
    assert cleared == {"configured": False, "source": None, "api_key_masked": ""}
    assert not key_file.exists()

    # Validation: too-short and whitespace-only keys are rejected.
    assert (
        client.put("/api/v1/admin/redfox-key", json={"api_key": "short"})
        .status_code
        == 422
    )
    assert (
        client.put("/api/v1/admin/redfox-key", json={"api_key": " " * 12})
        .status_code
        == 422
    )


def test_admin_redfox_key_env_fallback(
    tmp_path: Path,
    repository: OperationsRepository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REDFOX_API_KEY", "env-key-abcd1234")
    settings = _redfox_settings(tmp_path)
    client = _build_client(settings, repository)

    initial = client.get("/api/v1/admin/redfox-key").json()["data"]
    assert initial["configured"] is True
    assert initial["source"] == "env"

    stored = client.put(
        "/api/v1/admin/redfox-key",
        json={"api_key": "stored-key-9999"},
    ).json()["data"]
    assert stored["source"] == "stored"
    assert stored["api_key_masked"] == "stor…9999"

    # Clearing the stored key falls back to the env-provided one.
    cleared = client.delete("/api/v1/admin/redfox-key").json()["data"]
    assert cleared["configured"] is True
    assert cleared["source"] == "env"
    assert cleared["api_key_masked"] == "env-…1234"

