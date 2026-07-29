from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import fakeredis
from fakeredis.aioredis import FakeRedis

from agentscope.credential import CredentialFactory
from agentscope.permission import PermissionBehavior

from app.agent_team import hitl_guard
from app.agent_team.credential_vault import PersistentCredentialStorage
from app.agent_team.prompts import (
    ACCOUNT_BENCHMARK_PROMPT,
    INSIGHT_ANALYST_PROMPT,
    TOPIC_PLANNER_PROMPT,
)
from app.agent_team.templates import build_subagent_templates
from app.agent_team.tools import (
    RedFoxAccountBenchmarkTool,
    build_agent_tools_factory,
)
from app.agent_team.workspace import RoleAwareWorkspaceManager
from app.core.middleware import HitlDenialGuardMiddleware


def test_worker_templates_are_bounded() -> None:
    templates = build_subagent_templates()
    assert [item.type for item in templates] == [
        "insight_analyst",
        "account_planner",
        "account_benchmark_analyst",
        "topic_planner",
        "content_creator",
    ]
    by_type = {item.type: item for item in templates}
    assert "不得标记 published" in by_type["content_creator"].system_prompt_template
    assert "严禁用联网搜索" in by_type["account_benchmark_analyst"].system_prompt_template
    assert "严禁用联网搜索" in by_type["insight_analyst"].system_prompt_template


def test_agent_tools_are_scoped_to_current_user(repository, service, account_payload) -> None:
    account_a = repository.create_account("user-a", account_payload)
    repository.create_account("user-b", {**account_payload, "account_name": "另一个账号"})

    class TopicAgentStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="team",
                data=SimpleNamespace(system_prompt=TOPIC_PLANNER_PROMPT),
            )

    factory = build_agent_tools_factory(
        repository,
        service,
        agent_storage=TopicAgentStorage(),
    )
    tools = asyncio.run(factory("user-a", "agent-1", "session-1"))
    assert {tool.name for tool in tools} >= {
        "get_account_context",
        "list_topics",
        "save_topic",
    }
    assert all(tool.name != "publish_xiaohongshu" for tool in tools)
    assert all(tool.name != "update_topic_status" for tool in tools)
    # Account onboarding stays a leader-only capability.
    assert all(tool.name != "create_account_profile" for tool in tools)

    save_topic = next(tool for tool in tools if tool.name == "save_topic")
    response = asyncio.run(
        save_topic.call(
            account_id=account_a["id"],
            title="异步工具测试",
            angle="验证 AgentScope 工具真实调用",
            pillar="工程实践",
            audience_need="需要可靠实现",
            hook="工具调用不能阻塞事件循环",
            rationale="覆盖真实适配层",
        ),
    )
    payload = json.loads(response.content[0].text)
    assert payload["status"] == "idea"
    assert repository.list_topics("user-b") == []


def test_leader_creates_account_profile_in_conversation(repository, service) -> None:
    """The leader can persist account info collected via ask_user directly."""
    factory = build_agent_tools_factory(repository, service)
    tools = asyncio.run(factory("user-a", "leader-1", "session-1"))
    create_tool = next(tool for tool in tools if tool.name == "create_account_profile")
    assert create_tool.is_read_only is False
    response = asyncio.run(
        create_tool.call(
            account_name="职场成长小白",
            niche="职场成长",
            target_audience="18-25 岁大学生",
            primary_goal="涨粉",
            follower_count=120,
        ),
    )
    payload = json.loads(response.content[0].text)
    assert payload["account_name"] == "职场成长小白"
    assert payload["id"]
    accounts = repository.list_accounts("user-a")
    assert [item["id"] for item in accounts] == [payload["id"]]
    assert repository.list_accounts("user-b") == []


def test_redfox_tool_requires_permission_and_is_not_read_only(
    repository,
    service,
) -> None:
    class StubInsightService:
        @staticmethod
        def guide_keyword(keyword: str) -> dict:
            return {"keyword": keyword, "is_broad": False, "suggestions": []}

    class StubAccountBenchmarkService:
        pass

    class StubTitleInsightService:
        @staticmethod
        def generate(payload):
            return {"mode": "generate", "keyword": payload.keyword}

        @staticmethod
        def score(payload):
            return {"mode": "score", "keyword": payload.keyword, "title": payload.title}

    class BenchmarkAgentStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="team",
                data=SimpleNamespace(system_prompt=ACCOUNT_BENCHMARK_PROMPT),
            )

    class InsightAgentStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="team",
                data=SimpleNamespace(system_prompt=INSIGHT_ANALYST_PROMPT),
            )

    leader_factory = build_agent_tools_factory(
        repository,
        service,
        StubInsightService(),  # type: ignore[arg-type]
        StubAccountBenchmarkService(),  # type: ignore[arg-type]
    )
    leader_tools = asyncio.run(leader_factory("user-a", "leader-1", "session-1"))
    assert all(
        tool.name
        not in {
            "search_xiaohongshu_hot_notes",
            "search_xiaohongshu_similar_accounts",
            "analyze_xiaohongshu_titles",
            "design_xiaohongshu_cover",
        }
        for tool in leader_tools
    )
    insight_factory = build_agent_tools_factory(
        repository,
        service,
        StubInsightService(),  # type: ignore[arg-type]
        StubAccountBenchmarkService(),  # type: ignore[arg-type]
        agent_storage=InsightAgentStorage(),
        title_insight_service=StubTitleInsightService(),  # type: ignore[arg-type]
    )
    insight_tools = asyncio.run(insight_factory("user-a", "insight-1", "session-1"))
    insight_tool = next(
        tool for tool in insight_tools if tool.name == "search_xiaohongshu_hot_notes"
    )
    title_tool = next(
        tool for tool in insight_tools if tool.name == "analyze_xiaohongshu_titles"
    )
    title_response = asyncio.run(
        title_tool.call(mode="generate", keyword="AI产品经理"),
    )
    assert json.loads(title_response.content[0].text) == {
        "mode": "generate",
        "keyword": "AI产品经理",
    }
    benchmark_factory = build_agent_tools_factory(
        repository,
        service,
        StubInsightService(),  # type: ignore[arg-type]
        StubAccountBenchmarkService(),  # type: ignore[arg-type]
        BenchmarkAgentStorage(),
    )
    benchmark_tools = asyncio.run(
        benchmark_factory("user-a", "benchmark-1", "session-2"),
    )
    benchmark_tool = next(
        tool
        for tool in benchmark_tools
        if tool.name == "search_xiaohongshu_similar_accounts"
    )
    assert {tool.name for tool in benchmark_tools} == {
        "search_xiaohongshu_similar_accounts",
    }
    class TopicAgentStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="team",
                data=SimpleNamespace(system_prompt=TOPIC_PLANNER_PROMPT),
            )

    topic_factory = build_agent_tools_factory(
        repository,
        service,
        StubInsightService(),  # type: ignore[arg-type]
        StubAccountBenchmarkService(),  # type: ignore[arg-type]
        agent_storage=TopicAgentStorage(),
        title_insight_service=StubTitleInsightService(),  # type: ignore[arg-type]
    )
    topic_tools = asyncio.run(topic_factory("user-a", "topic-1", "session-3"))
    assert all(tool.name != "analyze_xiaohongshu_titles" for tool in topic_tools)
    for tool in (insight_tool, title_tool, benchmark_tool):
        decision = asyncio.run(tool.check_permissions())
        assert decision.behavior is PermissionBehavior.ALLOW
        assert tool.is_read_only is False


def test_redfox_tool_is_auto_approved_by_policy() -> None:
    """External data calls are trusted by default: always ALLOW, no re-ASK."""

    def search_xiaohongshu_similar_accounts(red_id: str = "") -> str:
        """demo"""
        return "x"

    tool = RedFoxAccountBenchmarkTool(
        search_xiaohongshu_similar_accounts,
        is_read_only=False,
    )
    hitl_guard.clear_denials()
    try:
        first = asyncio.run(tool.check_permissions())
        assert first.behavior is PermissionBehavior.ALLOW

        # Even a recorded denial does not gate external data tools anymore.
        hitl_guard.record_denial("search_xiaohongshu_similar_accounts")
        second = asyncio.run(tool.check_permissions())
        assert second.behavior is PermissionBehavior.ALLOW
    finally:
        hitl_guard.clear_denials()


def test_hitl_guard_middleware_records_denial_and_clears_on_new_message() -> None:
    """The /chat/ guard records rejections and resets them on a new task."""
    hitl_guard.clear_denials()
    try:
        deny_payload = json.dumps(
            {
                "agent_id": "a",
                "session_id": "s",
                "input": {
                    "type": "USER_CONFIRM_RESULT",
                    "reply_id": "r",
                    "confirm_results": [
                        {
                            "confirmed": False,
                            "tool_call": {
                                "id": "t1",
                                "name": "search_xiaohongshu_similar_accounts",
                                "input": "{}",
                            },
                        },
                    ],
                },
            },
        ).encode()
        HitlDenialGuardMiddleware._inspect(deny_payload)
        assert hitl_guard.is_denied("search_xiaohongshu_similar_accounts")

        approve_payload = json.dumps(
            {
                "agent_id": "a",
                "session_id": "s",
                "input": {
                    "type": "USER_CONFIRM_RESULT",
                    "reply_id": "r",
                    "confirm_results": [
                        {
                            "confirmed": True,
                            "tool_call": {
                                "id": "t2",
                                "name": "analyze_xiaohongshu_titles",
                                "input": "{}",
                            },
                        },
                    ],
                },
            },
        ).encode()
        HitlDenialGuardMiddleware._inspect(approve_payload)
        assert not hitl_guard.is_denied("analyze_xiaohongshu_titles")
        assert hitl_guard.is_approved("analyze_xiaohongshu_titles")

        msg_payload = json.dumps(
            {
                "agent_id": "a",
                "session_id": "s",
                "input": {
                    "name": "user",
                    "role": "user",
                    "content": [{"type": "text", "text": "hi"}],
                },
            },
        ).encode()
        HitlDenialGuardMiddleware._inspect(msg_payload)
        assert not hitl_guard.is_denied("search_xiaohongshu_similar_accounts")
        assert not hitl_guard.is_approved("analyze_xiaohongshu_titles")
    finally:
        hitl_guard.clear_denials()


def test_worker_workspace_hides_shell_and_filesystem_builtins(tmp_path) -> None:
    """Team workers must not be given Bash/Edit/Glob/Grep/Read/Write."""

    class WorkerStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="team",
                data=SimpleNamespace(system_prompt=INSIGHT_ANALYST_PROMPT),
            )

    async def scenario() -> tuple[set[str], str]:
        manager = RoleAwareWorkspaceManager(
            basedir=str(tmp_path / "workspaces"),
            storage=WorkerStorage(),
        )
        workspace = await manager.get_workspace(
            "user-a",
            "insight-1",
            "session-1",
            "ws-worker",
        )
        tool_names = {tool.name for tool in await workspace.list_tools()}
        instructions = await workspace.get_instructions()
        await manager.close_all()
        return tool_names, instructions

    tool_names, instructions = asyncio.run(scenario())
    assert tool_names.isdisjoint(
        {"Bash", "Edit", "Glob", "Grep", "Read", "Write"},
    )
    assert "shell" in instructions


def test_leader_workspace_keeps_builtin_tools(tmp_path) -> None:
    """The leader keeps AgentScope's default workspace toolset."""

    class LeaderStorage:
        async def get_agent(self, _user_id: str, _agent_id: str):
            return SimpleNamespace(
                source="user",
                data=SimpleNamespace(system_prompt=""),
            )

    async def scenario() -> set[str]:
        manager = RoleAwareWorkspaceManager(
            basedir=str(tmp_path / "workspaces"),
            storage=LeaderStorage(),
        )
        workspace = await manager.get_workspace(
            "user-a",
            "leader-1",
            "session-1",
            "ws-leader",
        )
        tool_names = {tool.name for tool in await workspace.list_tools()}
        await manager.close_all()
        return tool_names

    tool_names = asyncio.run(scenario())
    assert "Bash" in tool_names


def test_credential_vault_survives_embedded_restart(tmp_path) -> None:
    """Credentials keep their ids across an embedded-redis restart."""
    vault_path = tmp_path / "credentials.json"

    async def first_boot() -> str:
        server = fakeredis.FakeServer(version=(7,))
        client = FakeRedis(server=server, decode_responses=True)
        storage = PersistentCredentialStorage(
            vault_path=vault_path,
            connection_pool=client.connection_pool,
        )
        async with storage:
            credential = CredentialFactory.from_dict(
                {
                    "type": "openai_credential",
                    "api_key": "sk-persist-me",
                    "base_url": "https://api.example.com/v1",
                },
            )
            credential_id = await storage.upsert_credential(
                "local-user",
                credential,
            )
            assert await storage.get_credential("local-user", credential_id)
        await client.aclose()
        return credential_id

    async def second_boot(credential_id: str) -> tuple[int, dict | None]:
        # A fresh FakeServer simulates the process restart: Redis is empty.
        server = fakeredis.FakeServer(version=(7,))
        client = FakeRedis(server=server, decode_responses=True)
        storage = PersistentCredentialStorage(
            vault_path=vault_path,
            connection_pool=client.connection_pool,
        )
        async with storage:
            assert await storage.get_credential("local-user", credential_id) is None
            restored = await storage.restore_credentials()
            record = await storage.get_credential("local-user", credential_id)
        await client.aclose()
        return restored, record.data if record else None

    credential_id = asyncio.run(first_boot())
    assert vault_path.exists()
    assert credential_id in vault_path.read_text("utf-8")

    restored, data = asyncio.run(second_boot(credential_id))
    assert restored == 1
    assert data is not None
    assert data["api_key"] == "sk-persist-me"
    assert data["base_url"] == "https://api.example.com/v1"

    async def delete_boot() -> bool:
        server = fakeredis.FakeServer(version=(7,))
        client = FakeRedis(server=server, decode_responses=True)
        storage = PersistentCredentialStorage(
            vault_path=vault_path,
            connection_pool=client.connection_pool,
        )
        async with storage:
            await storage.restore_credentials()
            deleted = await storage.delete_credential("local-user", credential_id)
        await client.aclose()
        return deleted

    assert asyncio.run(delete_boot()) is True
    assert credential_id not in vault_path.read_text("utf-8")
