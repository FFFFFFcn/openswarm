"""Admin console API: stats, logs, storage cleanup, credentials, data deletion."""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.config import Settings
from app.core.redfox_key import RedFoxKeyStore
from app.agent_team.credential_vault import CredentialVault
from app.agent_team.prompts import LEADER_SYSTEM_PROMPT
from app.agent_team.runtime import AgentRuntime
from app.agent_team.templates import build_subagent_templates
from app.agent_team.tools import ROLE_PROMPTS
from app.agent_team.workspace import PROMPT_TO_ROLE_DIR, SKILLS_ROOT
from app.operations.repository import OperationsRepository
from app.operations.router import get_user_id


LOG_FILES = {
    "backend": "backend.log",
    "error": "backend.err.log",
}

# Chinese display labels for the leader and each worker role key.
ROLE_LABELS = {
    "leader": "主理人",
    "insight_analyst": "洞察分析",
    "account_planner": "账号规划",
    "account_benchmark_analyst": "账号对标",
    "topic_planner": "选题策划",
    "content_creator": "内容创作",
}

_LEADER_DESCRIPTION = (
    "与用户对话、编排团队并读取上下文；通过 TeamCreate / AgentCreate / TeamSay 创建成员并派发任务。"
)

_LEADER_BUILTIN_NOTE = (
    "除上述业务工具外，主理人还拥有框架内置的团队编排工具（TeamCreate / AgentCreate / TeamSay）与通用工作区工具。"
)

_WORKER_BUILTIN_NOTE = (
    "worker 已被策略剥离通用命令行/文件工具（Bash / Edit / Glob / Grep / Read / Write），"
    "仅保留上述业务工具与 TeamSay 汇报能力。"
)


def _tool_kind(tool: Any) -> str:
    """Classify a tool for display: local business / external data / user ask."""
    if getattr(tool, "is_external_tool", False):
        return "user_interaction"
    if type(tool).__name__.startswith("RedFox"):
        return "external_data"
    return "local"


def _read_skill(role_dir: str) -> str:
    path = SKILLS_ROOT / role_dir / "SKILL.md"
    try:
        return path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        return ""


class WorkspaceBatchDeleteRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


class RedFoxKeyUpdateRequest(BaseModel):
    api_key: str = Field(min_length=8, max_length=256)


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _dir_stats(path: Path) -> tuple[int, int]:
    """Return (file_count, total_size) for a directory tree."""
    files = 0
    size = 0
    if path.is_dir():
        for item in path.rglob("*"):
            try:
                if item.is_file():
                    files += 1
                    size += item.stat().st_size
            except OSError:
                continue
    return files, size


def _mask_secret(value: str | None) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return value[:2] + "…"
    return value[:4] + "…" + value[-4:]


def create_admin_router(
    settings: Settings,
    repository: OperationsRepository,
    runtime: AgentRuntime,
    role_tools_inspector: Callable[[str], Awaitable[list[Any]]] | None = None,
    redfox_keys: RedFoxKeyStore | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

    data_dir = settings.resolved_database_path.parent
    workspace_root = settings.resolved_workspace_dir
    vault = CredentialVault(settings.resolved_credential_vault_path)
    if redfox_keys is None:
        redfox_keys = RedFoxKeyStore(
            data_dir / "redfox_key.json",
            settings.redfox_api_key,
        )

    @router.get("/overview")
    async def overview(user_id: str = Depends(get_user_id)) -> dict[str, Any]:
        reports_files, reports_size = _dir_stats(settings.resolved_reports_dir)
        workspace_dirs = (
            [item for item in workspace_root.iterdir() if item.is_dir()]
            if workspace_root.is_dir()
            else []
        )
        _, workspaces_size = _dir_stats(workspace_root)
        dashboard = repository.dashboard(user_id)
        counts = dict(dashboard.get("counts") or {})
        counts["strategies"] = len(repository.list_strategies(user_id, 100))
        counts["credentials"] = len(vault.load())
        counts["agents"] = len(await runtime.storage.list_agents(user_id))
        counts["teams"] = len(await runtime.storage.list_teams(user_id))
        return {
            "data": {
                "storage": {
                    "database_size": _file_size(settings.resolved_database_path),
                    "reports_files": reports_files,
                    "reports_size": reports_size,
                    "workspaces_count": len(workspace_dirs),
                    "workspaces_size": workspaces_size,
                    "logs": {
                        name: _file_size(data_dir / filename)
                        for name, filename in LOG_FILES.items()
                    },
                },
                "counts": counts,
            },
        }

    @router.get("/agent-team")
    async def agent_team_state(
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        """Aggregated AgentScope runtime state: agents, teams, health."""
        try:
            available = await runtime.ping()
        except Exception:  # noqa: BLE001 - health probe must never raise
            available = False
        agents: list[dict[str, Any]] = []
        for record in await runtime.storage.list_agents(user_id):
            sessions = await runtime.storage.list_sessions(user_id, record.id)
            agents.append(
                {
                    "id": record.id,
                    "name": record.data.name,
                    "source": record.source,
                    "role": (
                        PROMPT_TO_ROLE_DIR.get(record.data.system_prompt)
                        if record.source == "team"
                        else None
                    ),
                    "sessions": len(sessions),
                    "system_prompt": record.data.system_prompt,
                    "created_at": record.created_at.isoformat(),
                },
            )
        teams: list[dict[str, Any]] = []
        for team in await runtime.storage.list_teams(user_id):
            members = team.data.members or team.data.member_ids
            teams.append(
                {
                    "id": team.id,
                    "name": team.data.name,
                    "description": team.data.description,
                    "members": len(members),
                    "created_at": team.created_at.isoformat(),
                },
            )
        return {
            "data": {
                "runtime": {
                    "redis_mode": settings.redis_mode,
                    "available": bool(available),
                },
                "agents": agents,
                "teams": teams,
            },
        }

    @router.get("/agent-team/roles")
    async def agent_team_roles() -> dict[str, Any]:
        """Static role configs: system prompt, SKILL.md and business tools.

        Tool lists come from the real tools factory (via the inspector),
        so what the console shows is exactly what each role receives at
        runtime.
        """
        template_desc = {
            template.type: template.description
            for template in build_subagent_templates()
        }
        roles: list[dict[str, Any]] = []
        for key in ["leader", *ROLE_PROMPTS]:
            is_leader = key == "leader"
            prompt = LEADER_SYSTEM_PROMPT if is_leader else ROLE_PROMPTS[key]
            role_dir = "leader" if is_leader else PROMPT_TO_ROLE_DIR[prompt]
            tools: list[dict[str, Any]] = []
            if role_tools_inspector is not None:
                for tool in await role_tools_inspector(key):
                    tools.append(
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "read_only": bool(getattr(tool, "is_read_only", False)),
                            "kind": _tool_kind(tool),
                        },
                    )
            roles.append(
                {
                    "key": key,
                    "label": ROLE_LABELS.get(key, key),
                    "kind": "leader" if is_leader else "worker",
                    "description": (
                        _LEADER_DESCRIPTION
                        if is_leader
                        else template_desc.get(key, "")
                    ),
                    "system_prompt": prompt,
                    "skill": _read_skill(role_dir),
                    "skill_path": f"skills/{role_dir}/SKILL.md",
                    "tools": tools,
                    "builtin_note": (
                        _LEADER_BUILTIN_NOTE if is_leader else _WORKER_BUILTIN_NOTE
                    ),
                },
            )
        return {"data": roles}

    @router.get("/logs")
    def read_log(
        name: str = Query(pattern="^(backend|error)$"),
        tail: int = Query(default=200, ge=1, le=2000),
    ) -> dict[str, Any]:
        path = data_dir / LOG_FILES[name]
        lines: list[str] = []
        if path.is_file():
            text = path.read_text(encoding="utf-8", errors="replace")
            lines = text.splitlines()[-tail:]
        return {
            "data": {
                "name": name,
                "size": _file_size(path),
                "lines": lines,
            },
        }

    def _resolve_workspace(workspace_id: str) -> Path | None:
        if (
            not workspace_id
            or "\x00" in workspace_id
            or "/" in workspace_id
            or "\\" in workspace_id
            or ".." in workspace_id
        ):
            raise HTTPException(status_code=400, detail="Invalid workspace id.")
        path = (workspace_root / workspace_id).resolve()
        if not path.is_relative_to(workspace_root) or path == workspace_root:
            raise HTTPException(status_code=400, detail="Invalid workspace id.")
        return path if path.is_dir() else None

    @router.get("/workspaces")
    def list_workspaces() -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        if workspace_root.is_dir():
            for entry in workspace_root.iterdir():
                if not entry.is_dir():
                    continue
                files, size = _dir_stats(entry)
                items.append(
                    {
                        "id": entry.name,
                        "files": files,
                        "size": size,
                        "updated_at": entry.stat().st_mtime,
                    },
                )
        items.sort(key=lambda item: item["updated_at"], reverse=True)
        return {"data": items}

    @router.post("/workspaces/batch-delete")
    def batch_delete_workspaces(
        payload: WorkspaceBatchDeleteRequest,
    ) -> dict[str, Any]:
        deleted: list[str] = []
        skipped: list[str] = []
        for workspace_id in dict.fromkeys(payload.ids):
            path = _resolve_workspace(workspace_id)
            if path is None:
                skipped.append(workspace_id)
                continue
            shutil.rmtree(path, ignore_errors=True)
            deleted.append(workspace_id)
        return {"data": {"deleted": deleted, "skipped": skipped}}

    @router.get("/credentials")
    def list_credentials() -> dict[str, Any]:
        items = []
        for record in vault.load():
            data = record.data if isinstance(record.data, dict) else {}
            items.append(
                {
                    "id": record.id,
                    "name": data.get("name"),
                    "type": data.get("type"),
                    "base_url": data.get("base_url"),
                    "api_key_masked": _mask_secret(data.get("api_key")),
                    "created_at": record.created_at,
                },
            )
        return {"data": items}

    @router.delete("/credentials/{credential_id}")
    def delete_credential(credential_id: str) -> dict[str, Any]:
        existing = {record.id for record in vault.load()}
        if credential_id not in existing:
            raise HTTPException(status_code=404, detail="Credential not found.")
        vault.remove(credential_id)
        return {
            "data": {
                "deleted": credential_id,
                "note": "已从凭据保管库移除；运行中的实例需重启后彻底失效。",
            },
        }

    def _redfox_key_state() -> dict[str, Any]:
        key = redfox_keys.get()
        return {
            "configured": bool(key and key.get_secret_value().strip()),
            "source": redfox_keys.source,
            "api_key_masked": _mask_secret(
                key.get_secret_value().strip() if key else None,
            ),
        }

    @router.get("/redfox-key")
    def redfox_key_status() -> dict[str, Any]:
        """Effective data API key state: configured flag, source and mask."""
        return {"data": _redfox_key_state()}

    @router.put("/redfox-key")
    def redfox_key_update(payload: RedFoxKeyUpdateRequest) -> dict[str, Any]:
        try:
            redfox_keys.set(payload.api_key)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        return {"data": _redfox_key_state()}

    @router.delete("/redfox-key")
    def redfox_key_delete() -> dict[str, Any]:
        """Remove the stored key; the env-var fallback (if any) remains."""
        redfox_keys.clear()
        return {"data": _redfox_key_state()}

    @router.delete("/topics/{topic_id}")
    def delete_topic(
        topic_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        try:
            deleted = repository.delete_topic(user_id, topic_id)
        except sqlite3.IntegrityError:
            raise HTTPException(
                status_code=409,
                detail="该选题下仍有草稿，请先删除对应草稿。",
            ) from None
        if not deleted:
            raise HTTPException(status_code=404, detail="Topic not found.")
        return {"data": {"deleted": topic_id}}

    @router.delete("/drafts/{draft_id}")
    def delete_draft(
        draft_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        if not repository.delete_draft(user_id, draft_id):
            raise HTTPException(status_code=404, detail="Draft not found.")
        return {"data": {"deleted": draft_id}}

    @router.delete("/strategies/{strategy_id}")
    def delete_strategy(
        strategy_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        if not repository.delete_strategy(user_id, strategy_id):
            raise HTTPException(status_code=404, detail="Strategy not found.")
        return {"data": {"deleted": strategy_id}}

    return router
