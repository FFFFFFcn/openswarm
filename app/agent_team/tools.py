"""Scoped AgentScope tools backed by the editorial repository."""
from __future__ import annotations

import asyncio
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.tool import FunctionTool, ToolBase

from app.account_benchmark.models import AccountBenchmarkSearchRequest
from app.account_benchmark.service import AccountBenchmarkService
from app.cover_design.models import CoverDesignRequest
from app.cover_design.service import CoverDesignService
from app.operations.models import (
    AccountProfileUpsert,
    DraftCreate,
    StrategyCreate,
    TopicCreate,
)
from app.operations.repository import OperationsRepository
from app.operations.service import OperationsService
from app.insights.models import InsightSearchRequest
from app.insights.service import InsightService
from app.title_insights.models import TitleGenerateRequest, TitleScoreRequest
from app.title_insights.service import TitleInsightService
from app.agent_team.prompts import (
    ACCOUNT_BENCHMARK_PROMPT,
    ACCOUNT_PLANNER_PROMPT,
    CONTENT_CREATOR_PROMPT,
    INSIGHT_ANALYST_PROMPT,
    TOPIC_PLANNER_PROMPT,
)


# Role key (SubAgentTemplate type) → worker system prompt. The tool factory
# and the admin role inspector both derive role identity from this table.
ROLE_PROMPTS: dict[str, str] = {
    "insight_analyst": INSIGHT_ANALYST_PROMPT,
    "account_planner": ACCOUNT_PLANNER_PROMPT,
    "account_benchmark_analyst": ACCOUNT_BENCHMARK_PROMPT,
    "topic_planner": TOPIC_PLANNER_PROMPT,
    "content_creator": CONTENT_CREATOR_PROMPT,
}

_PROMPT_TO_ROLE: dict[str, str] = {
    prompt: key for key, prompt in ROLE_PROMPTS.items()
}


class EditorialFunctionTool(FunctionTool):
    """A local-only tool with no side effect outside the user's workspace."""

    async def check_permissions(self, *_args: Any, **_kwargs: Any) -> PermissionDecision:
        return PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="openswarm local editorial operation",
        )


class RedFoxGuardedTool(FunctionTool):
    """External, quota-consuming data tool — auto-approved by policy.

    External data calls are trusted by default: no user confirmation is
    required before execution.
    """

    async def check_permissions(self, *_args: Any, **_kwargs: Any) -> PermissionDecision:
        return PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="外部数据调用已默认授权，自动放行。",
        )


class RedFoxInsightTool(RedFoxGuardedTool):
    """An external, quota-consuming hot-note insight operation."""


class RedFoxAccountBenchmarkTool(RedFoxGuardedTool):
    """An external, quota-consuming account benchmark operation."""


class RedFoxTitleInsightTool(RedFoxGuardedTool):
    """An external, quota-consuming title trend analysis operation."""


class RedFoxCoverDesignTool(RedFoxGuardedTool):
    """An external, quota-consuming cover design operation."""


class AskUserExternalTool(ToolBase):
    """External tool: park the run and wait for the user's answer in the UI.

    Declared with ``is_external_tool=True`` so the agent yields a
    ``RequireExternalExecutionEvent`` instead of executing anything —
    the web client renders a reply card and posts the result back via
    the chat endpoint's ``EXTERNAL_EXECUTION_RESULT`` input.
    """

    name = "ask_user"
    description = (
        "向用户发起一个必须等待回答的提问（如补充账号资料、确认方向、提供站外数据）。"
        "调用后任务会暂停，直到用户在界面上填写并提交答案。"
        "仅在确实缺少必要信息时使用，不要用它问候或汇报进度。"
    )
    input_schema = {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "向用户提出的具体问题，一次只问一件事。",
            },
            "context": {
                "type": "string",
                "description": "可选：为什么需要这个信息，帮助用户理解背景。",
            },
        },
        "required": ["question"],
    }
    is_concurrency_safe = False
    is_read_only = True
    is_external_tool = True

    async def check_permissions(self, *_args: Any, **_kwargs: Any) -> PermissionDecision:
        return PermissionDecision(
            behavior=PermissionBehavior.ALLOW,
            message="向用户提问无需授权。",
        )


def build_agent_tools_factory(
    repository: OperationsRepository,
    service: OperationsService,
    insight_service: InsightService | None = None,
    account_benchmark_service: AccountBenchmarkService | None = None,
    agent_storage: Any | None = None,
    title_insight_service: TitleInsightService | None = None,
    cover_design_service: CoverDesignService | None = None,
):
    async def extra_agent_tools(
        user_id: str,
        agent_id: str,
        _session_id: str,
    ) -> list[ToolBase]:
        actor = f"agent:{agent_id}"
        role = "leader"
        if agent_storage is not None:
            record = await agent_storage.get_agent(user_id, agent_id)
            if record is not None and record.source == "team":
                role = _PROMPT_TO_ROLE.get(
                    record.data.system_prompt,
                    "unknown_worker",
                )

        async def get_account_context(account_id: str | None = None) -> dict[str, Any]:
            """读取账号库。传 account_id 返回该账号档案、最近策略和工作台摘要；不传则返回账号列表。"""
            def read_context() -> dict[str, Any]:
                if not account_id:
                    accounts = repository.list_accounts(user_id)
                    if not accounts:
                        return {
                            "accounts": [],
                            "message": (
                                "账号库为空。用 ask_user 在对话里收集账号信息，"
                                "再用 create_account_profile 直接录入，"
                                "不要让用户去页面操作。"
                            ),
                        }
                    return {
                        "accounts": [
                            {
                                "account_id": item["id"],
                                "account_name": item["account_name"],
                                "niche": item["niche"],
                                "red_id": item["red_id"],
                            }
                            for item in accounts
                        ],
                        "message": (
                            "未指定 account_id。请从任务说明或用户消息末尾的"
                            "[当前账号: …] 标记中获取，或请用户选择账号后重试。"
                        ),
                    }
                account = service.require_account(user_id, account_id)
                return {
                    "account": account,
                    "strategies": repository.list_strategies(
                        user_id,
                        limit=5,
                        account_id=account["id"],
                    ),
                    "dashboard": repository.dashboard(user_id, account_id=account["id"]),
                }

            return await asyncio.to_thread(read_context)

        async def create_account_profile(
            account_name: str,
            niche: str,
            target_audience: str = "",
            primary_goal: str = "",
            voice: str = "",
            differentiators: list[str] | None = None,
            forbidden_topics: list[str] | None = None,
            red_id: str = "",
            follower_count: int | None = None,
            notes_count: int | None = None,
            intro: str = "",
        ) -> dict[str, Any]:
            """用对话中收集到的信息创建账号档案，返回含 account_id 的新档案。"""
            payload = AccountProfileUpsert(
                account_name=account_name,
                niche=niche,
                target_audience=target_audience,
                primary_goal=primary_goal,
                voice=voice,
                differentiators=differentiators or [],
                forbidden_topics=forbidden_topics or [],
                red_id=red_id,
                follower_count=follower_count,
                notes_count=notes_count,
                intro=intro,
            )
            return await asyncio.to_thread(
                repository.create_account,
                user_id,
                payload.model_dump(),
            )

        async def save_account_strategy(
            account_id: str,
            positioning: str,
            persona: str,
            content_pillars: list[str],
            posting_rhythm: str,
            growth_plan: str,
        ) -> dict[str, Any]:
            """为指定账号保存一版小红书起号策略，默认等待人工确认。"""
            payload = StrategyCreate(
                account_id=account_id,
                positioning=positioning,
                persona=persona,
                content_pillars=content_pillars,
                posting_rhythm=posting_rhythm,
                growth_plan=growth_plan,
                created_by_agent=agent_id,
            )
            return await asyncio.to_thread(
                service.create_strategy,
                user_id,
                payload.model_dump(),
            )

        async def list_topics(
            status: str | None = None,
            limit: int = 20,
            account_id: str | None = None,
        ) -> list[dict[str, Any]]:
            """列出选题卡，可按状态和 account_id 过滤。"""
            return await asyncio.to_thread(
                repository.list_topics,
                user_id,
                status,
                max(1, min(limit, 100)),
                account_id,
            )

        async def save_topic(
            account_id: str,
            title: str,
            angle: str,
            pillar: str,
            audience_need: str,
            hook: str,
            rationale: str,
            note_format: str = "image_text",
            score: int = 70,
            hashtags: list[str] | None = None,
            source_notes: str = "",
        ) -> dict[str, Any]:
            """为指定账号保存一张小红书选题卡为 idea，交给用户审批。"""
            payload = TopicCreate(
                account_id=account_id,
                title=title,
                angle=angle,
                pillar=pillar,
                audience_need=audience_need,
                hook=hook,
                rationale=rationale,
                note_format=note_format,
                score=score,
                hashtags=hashtags or [],
                source_notes=source_notes,
            )
            return await asyncio.to_thread(
                service.create_topic,
                user_id,
                payload.model_dump(),
                actor,
            )

        async def create_xiaohongshu_draft(
            account_id: str,
            topic_id: str,
            title: str,
            cover_text: str,
            body: str,
            hashtags: list[str] | None = None,
            image_prompts: list[str] | None = None,
            compliance_notes: list[str] | None = None,
        ) -> dict[str, Any]:
            """为指定账号的已批准选题创建小红书草稿，不执行平台发布。"""
            payload = DraftCreate(
                account_id=account_id,
                topic_id=topic_id,
                title=title,
                cover_text=cover_text,
                body=body,
                hashtags=hashtags or [],
                image_prompts=image_prompts or [],
                compliance_notes=compliance_notes or [],
            )
            return await asyncio.to_thread(
                service.create_draft,
                user_id,
                payload.model_dump(),
                actor,
            )

        async def list_drafts(
            status: str | None = None,
            limit: int = 20,
            account_id: str | None = None,
        ) -> list[dict[str, Any]]:
            """列出内容草稿，可按状态和 account_id 过滤。"""
            return await asyncio.to_thread(
                repository.list_drafts,
                user_id,
                status,
                max(1, min(limit, 100)),
                account_id,
            )

        def check_xiaohongshu_compliance(title: str, body: str) -> dict[str, Any]:
            """对标题和正文做有限的风险词预检并返回人工核验清单。"""
            return service.check_compliance(title, body)

        async def search_xiaohongshu_hot_notes(
            keyword: str = "",
            days: int = 7,
            broad_keyword_confirmed: bool = False,
        ) -> dict[str, Any]:
            """通过外部数据接口查询近 1-30 天小红书爆款笔记并生成 HTML 报告。"""
            if insight_service is None:
                return {"error": "Insight service is unavailable."}
            guide = insight_service.guide_keyword(keyword)
            if guide["is_broad"] and not broad_keyword_confirmed:
                return {
                    "requires_confirmation": True,
                    **guide,
                    "message": "请先让用户选择细分方向，或明确确认继续搜索原词。",
                }
            window = max(1, min(days, 30))
            end_date = date.today() - timedelta(days=1)
            request = InsightSearchRequest(
                keyword=keyword,
                start_date=end_date - timedelta(days=window - 1),
                end_date=end_date,
                max_items=10,
                broad_keyword_confirmed=broad_keyword_confirmed,
            )
            return await asyncio.to_thread(insight_service.search, request)

        async def search_xiaohongshu_similar_accounts(
            red_id: str = "",
            track: str = "",
            min_fans: int | None = None,
            max_fans: int | None = None,
            level: str = "",
        ) -> dict[str, Any]:
            """通过外部数据接口按账号ID或赛道、粉丝范围、等级查询小红书对标账号。"""
            if account_benchmark_service is None:
                return {"error": "Account benchmark service is unavailable."}
            request = AccountBenchmarkSearchRequest(
                query_mode="red_id" if red_id.strip() else "filters",
                red_id=red_id or None,
                track=track or None,
                min_fans=min_fans,
                max_fans=max_fans,
                level=level or None,
            )
            return await asyncio.to_thread(
                account_benchmark_service.search,
                request,
            )

        async def analyze_xiaohongshu_titles(
            mode: str,
            keyword: str,
            title: str = "",
            broad_keyword_confirmed: bool = False,
        ) -> dict[str, Any]:
            """基于趋势样本生成10个小红书标题，或对一个标题进行六维评分。"""
            if title_insight_service is None:
                return {"error": "Title insight service is unavailable."}
            guide = InsightService.guide_keyword(keyword)
            if guide["is_broad"] and not broad_keyword_confirmed:
                return {
                    "requires_confirmation": True,
                    **guide,
                    "message": "请先让用户选择细分方向，或明确确认继续分析原词。",
                }
            if mode == "generate":
                payload = TitleGenerateRequest(
                    keyword=keyword,
                    broad_keyword_confirmed=broad_keyword_confirmed,
                )
                return await asyncio.to_thread(title_insight_service.generate, payload)
            if mode == "score":
                payload = TitleScoreRequest(
                    title=title,
                    keyword=keyword,
                    broad_keyword_confirmed=broad_keyword_confirmed,
                )
                return await asyncio.to_thread(title_insight_service.score, payload)
            return {"error": "mode 必须是 generate 或 score。"}

        async def design_xiaohongshu_cover(
            keyword: str = "",
            days: int = 30,
            broad_keyword_confirmed: bool = False,
        ) -> dict[str, Any]:
            """获取同赛道爆款封面数据，为 AI 图像分析和方案生成提供素材。"""
            if cover_design_service is None:
                return {"error": "Cover design service is unavailable."}
            guide = InsightService.guide_keyword(keyword)
            if guide["is_broad"] and not broad_keyword_confirmed:
                return {
                    "requires_confirmation": True,
                    **guide,
                    "message": "请先让用户选择细分方向，或明确确认继续搜索原词。",
                }
            request = CoverDesignRequest(
                keyword=keyword,
                days=days,
                broad_keyword_confirmed=broad_keyword_confirmed,
            )
            return await asyncio.to_thread(cover_design_service.search, request)

        specs = [
            (get_account_context, True, {"leader", "account_planner", "topic_planner", "content_creator"}),
            (create_account_profile, False, {"leader"}),
            (save_account_strategy, False, {"account_planner"}),
            (list_topics, True, {"leader", "topic_planner", "content_creator"}),
            (save_topic, False, {"topic_planner"}),
            (create_xiaohongshu_draft, False, {"content_creator"}),
            (list_drafts, True, {"leader", "content_creator"}),
            (check_xiaohongshu_compliance, True, {"content_creator"}),
        ]
        tools: list[ToolBase] = [
            EditorialFunctionTool(func, is_read_only=read_only)
            for func, read_only, allowed_roles in specs
            if role in allowed_roles
        ]
        if role == "leader":
            tools.append(AskUserExternalTool())
        if insight_service is not None and role == "insight_analyst":
            tools.append(
                RedFoxInsightTool(
                    search_xiaohongshu_hot_notes,
                    is_read_only=False,
                ),
            )
        if title_insight_service is not None and role == "insight_analyst":
            tools.append(
                RedFoxTitleInsightTool(
                    analyze_xiaohongshu_titles,
                    is_read_only=False,
                ),
            )
        if cover_design_service is not None and role == "insight_analyst":
            tools.append(
                RedFoxCoverDesignTool(
                    design_xiaohongshu_cover,
                    is_read_only=False,
                ),
            )
        if (
            account_benchmark_service is not None
            and role == "account_benchmark_analyst"
        ):
            tools.append(
                RedFoxAccountBenchmarkTool(
                    search_xiaohongshu_similar_accounts,
                    is_read_only=False,
                ),
            )
        return tools

    return extra_agent_tools


class _RolePreviewStorage:
    """Stub agent storage mapping ``agent_id`` (a role key) to its prompt.

    Lets the admin console enumerate the exact business tools a role
    would receive without needing a live agent of that role — the real
    ``build_agent_tools_factory`` wiring stays the single source of truth.
    """

    async def get_agent(self, _user_id: str, agent_id: str) -> Any:
        prompt = ROLE_PROMPTS.get(agent_id)
        if prompt is None:
            return None  # leader / user-created path
        return SimpleNamespace(
            source="team",
            data=SimpleNamespace(system_prompt=prompt),
        )


def build_role_tools_inspector(
    repository: OperationsRepository,
    service: OperationsService,
    insight_service: InsightService | None = None,
    account_benchmark_service: AccountBenchmarkService | None = None,
    title_insight_service: TitleInsightService | None = None,
    cover_design_service: CoverDesignService | None = None,
):
    """Return ``async (role_key) -> list[ToolBase]`` for admin introspection."""
    factory = build_agent_tools_factory(
        repository,
        service,
        insight_service,
        account_benchmark_service,
        agent_storage=_RolePreviewStorage(),
        title_insight_service=title_insight_service,
        cover_design_service=cover_design_service,
    )

    async def inspect_role(role_key: str) -> list[ToolBase]:
        return await factory("__role_preview__", role_key, "")

    return inspect_role
