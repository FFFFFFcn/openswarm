"""Role-aware workspace manager: per-role skills plus a worker tool policy.

Each agent type (leader, insight_analyst, etc.) gets only its own
SKILL.md seeded into its workspace, providing hard skill isolation.

Team worker agents additionally have the generic coding-agent builtins
(``Bash`` / ``Edit`` / ``Glob`` / ``Grep`` / ``Read`` / ``Write``)
stripped from their toolkit. Their legitimate operations are fully
covered by the scoped editorial business tools; leaving the shell and
filesystem builtins in place misleads workers into running commands
such as ``cd ... && dir`` that fail and surface confusing approval
cards. The default workspace instructions (which describe project
directories, git and Python environments) are replaced with a minimal
brief so workers never attempt filesystem operations.
"""
from __future__ import annotations

from typing import Any

from agentscope.app.storage import StorageBase
from agentscope.app.workspace_manager import LocalWorkspaceManager

from app.agent_team.prompts import (
    ACCOUNT_BENCHMARK_PROMPT,
    ACCOUNT_PLANNER_PROMPT,
    CONTENT_CREATOR_PROMPT,
    INSIGHT_ANALYST_PROMPT,
    TOPIC_PLANNER_PROMPT,
)
from app.core.config import PROJECT_ROOT

SKILLS_ROOT = PROJECT_ROOT / "skills"

PROMPT_TO_ROLE_DIR: dict[str, str] = {
    INSIGHT_ANALYST_PROMPT: "insight-analyst",
    ACCOUNT_PLANNER_PROMPT: "account-planner",
    ACCOUNT_BENCHMARK_PROMPT: "account-benchmark-analyst",
    TOPIC_PLANNER_PROMPT: "topic-planner",
    CONTENT_CREATOR_PROMPT: "content-creator",
}

# Generic coding-agent builtins that editorial workers must never see.
_RESTRICTED_BUILTIN_TOOLS = frozenset(
    {"Bash", "Edit", "Glob", "Grep", "Read", "Write"},
)

_WORKER_INSTRUCTIONS = (
    "<workspace>\n"
    "你是 openswarm 编辑团队的 worker 成员，运行在受控的应用环境中。\n"
    "你没有命令行或文件系统工具：不要执行 shell 命令，不要读写文件、"
    "创建目录或管理 Python 环境。\n"
    "你只能通过分配给你的业务工具完成数据查询与结果写入，"
    "报告文件由业务工具自动生成。\n"
    "完成后用 TeamSay 向主理人汇报结论与报告位置。\n"
    "</workspace>"
)


def _apply_worker_tool_policy(workspace: Any) -> None:
    """Hide shell/filesystem builtins and re-brief a worker workspace.

    Idempotent: workspaces are cached and reused across chat turns, so
    the guard marker prevents double-wrapping ``list_tools``.
    """
    if getattr(workspace, "_editorial_policy_applied", False):
        return

    original_list_tools = workspace.list_tools

    async def restricted_list_tools() -> list:
        tools = await original_list_tools()
        return [
            tool
            for tool in tools
            if tool.name not in _RESTRICTED_BUILTIN_TOOLS
        ]

    workspace.list_tools = restricted_list_tools
    workspace.instructions = _WORKER_INSTRUCTIONS
    workspace._editorial_policy_applied = True


class RoleAwareWorkspaceManager(LocalWorkspaceManager):
    """Seeds role-specific skills and applies the worker tool policy.

    For single-user local deployments the ``get_workspace`` calls are
    effectively serial (one chat turn at a time), so the temporary
    ``_skill_paths`` override is safe without additional locking.
    """

    def __init__(self, *, basedir: str, storage: StorageBase, **kwargs) -> None:
        super().__init__(basedir=basedir, **kwargs)
        self._storage = storage

    async def _resolve_role(
        self,
        user_id: str,
        agent_id: str,
    ) -> tuple[bool, str | None]:
        """Return ``(is_worker, role_dir)`` for the agent.

        ``is_worker`` is True for team-created agents; ``role_dir`` is
        the skills directory name (None when the prompt is unknown).
        """
        record = await self._storage.get_agent(user_id, agent_id)
        if record is None or record.source != "team":
            return False, None
        return True, PROMPT_TO_ROLE_DIR.get(record.data.system_prompt)

    @staticmethod
    def _skill_paths_for(is_worker: bool, role_dir: str | None) -> list[str]:
        """Map a resolved role to the skill directories to seed."""
        if not is_worker:
            # Leader or user-created agent
            return [str(SKILLS_ROOT / "leader")]
        if role_dir:
            return [str(SKILLS_ROOT / role_dir)]
        return []

    async def _resolve_skill_paths(
        self,
        user_id: str,
        agent_id: str,
    ) -> list[str]:
        """Determine which skill directories to seed for this agent."""
        is_worker, role_dir = await self._resolve_role(user_id, agent_id)
        return self._skill_paths_for(is_worker, role_dir)

    async def get_workspace(
        self,
        user_id: str,
        agent_id: str,
        session_id: str,
        workspace_id: str,
    ):
        """Inject role-specific skill_paths and the worker tool policy."""
        is_worker, role_dir = await self._resolve_role(user_id, agent_id)
        self._skill_paths = self._skill_paths_for(is_worker, role_dir)
        workspace = await super().get_workspace(
            user_id,
            agent_id,
            session_id,
            workspace_id,
        )
        if is_worker:
            _apply_worker_tool_policy(workspace)
        return workspace
