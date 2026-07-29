"""Small bridge endpoints used by the first-party web client."""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from agentscope.app._bus_ops import enqueue_run_trigger
from agentscope.app.message_bus import MessageBusKeys
from agentscope.message import Base64Source, DataBlock, HintBlock, TextBlock

from app.agent_team.prompts import LEADER_SYSTEM_PROMPT
from app.agent_team.runtime import AgentRuntime
from app.agent_team.templates import build_subagent_templates

_MODEL_TEST_TIMEOUT_SECONDS = 20
_ERROR_SNIPPET_CHARS = 300
_MAX_STEER_IMAGES = 4
_MAX_STEER_IMAGE_CHARS = 2_800_000  # ≈2MB binary per image, base64-encoded


class ModelTestRequest(BaseModel):
    """Credentials to probe before the user commits a model configuration."""

    api_type: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    model: str = Field(min_length=1)


def _build_probe(payload: ModelTestRequest) -> urllib.request.Request:
    """Build a minimal one-token chat request for the target provider."""
    base = payload.base_url.rstrip("/")
    model = payload.model.strip()
    key = payload.api_key.strip()
    if payload.api_type == "anthropic_credential":
        url = f"{base}/messages" if base.endswith("/v1") else f"{base}/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        body = {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
    elif payload.api_type == "gemini_credential":
        url = f"{base}/models/{model}:generateContent"
        headers = {"x-goog-api-key": key}
        body = {
            "contents": [{"parts": [{"text": "ping"}]}],
            "generationConfig": {"maxOutputTokens": 1},
        }
    else:
        # OpenAI-compatible chat completions (openai / dashscope / deepseek /
        # moonshot / ollama / xai and other compatible gateways).
        url = f"{base}/chat/completions"
        headers = {"Authorization": f"Bearer {key}"}
        body = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
    headers["Content-Type"] = "application/json"
    return urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )


class SteerTarget(BaseModel):
    """One (agent, session) pair that should receive the user's aside."""

    agent_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)


class SteerImage(BaseModel):
    """An inline image attached to a steering message (raw base64)."""

    data: str = Field(min_length=1, max_length=_MAX_STEER_IMAGE_CHARS)
    media_type: str = Field(min_length=1)


class SteerRequest(BaseModel):
    """A mid-run user message pushed into running sessions' inboxes."""

    targets: list[SteerTarget] = Field(min_length=1, max_length=16)
    text: str = ""
    images: list[SteerImage] = Field(default_factory=list, max_length=_MAX_STEER_IMAGES)


def create_agent_team_router(
    redis_mode: str,
    runtime: AgentRuntime | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/agent-team", tags=["agent-team"])

    @router.get("/config")
    def config() -> dict:
        templates = build_subagent_templates()
        return {
            "data": {
                "leader_name": "小红书内容主理人",
                "leader_system_prompt": LEADER_SYSTEM_PROMPT,
                "templates": [
                    {"type": item.type, "description": item.description}
                    for item in templates
                ],
                "redis_mode": redis_mode,
                "publishing": "manual",
            },
        }

    @router.post("/model-test")
    def model_test(payload: ModelTestRequest) -> dict:
        """Fire a minimal chat call so bad credentials fail before saving."""
        request = _build_probe(payload)
        if not request.full_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="接口地址必须以 http:// 或 https:// 开头。",
            )
        try:
            with urllib.request.urlopen(
                request,
                timeout=_MODEL_TEST_TIMEOUT_SECONDS,
            ) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            snippet = ""
            try:
                snippet = exc.read().decode("utf-8", errors="replace")
            except OSError:
                pass
            snippet = " ".join(snippet.split())[:_ERROR_SNIPPET_CHARS]
            raise HTTPException(
                status_code=400,
                detail=f"模型接口返回 {exc.code}：{snippet or exc.reason}",
            ) from exc
        except urllib.error.URLError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"无法连接模型接口：{exc.reason}",
            ) from exc
        except TimeoutError as exc:
            raise HTTPException(
                status_code=400,
                detail="模型接口连接超时，请检查接口地址。",
            ) from exc
        return {"data": {"ok": True}}

    @router.post("/steer")
    async def steer(
        payload: SteerRequest,
        x_user_id: str = Header(alias="X-User-ID"),
    ) -> dict:
        """Push a user aside into running sessions (same path as team_say).

        The HintBlock lands in each session's inbox and is drained at the
        next reasoning step; idle sessions are woken via a run trigger.
        """
        if runtime is None:
            raise HTTPException(status_code=503, detail="智能体运行时未就绪。")
        text = payload.text.strip()
        if not text and not payload.images:
            raise HTTPException(status_code=400, detail="插话内容不能为空。")
        wrapped = f"<user-message>\n{text}\n</user-message>"
        hint_content: str | list[TextBlock | DataBlock]
        if payload.images:
            hint_content = [
                TextBlock(text=wrapped),
                *(
                    DataBlock(
                        source=Base64Source(
                            data=image.data,
                            media_type=image.media_type,
                        ),
                    )
                    for image in payload.images
                ),
            ]
        else:
            hint_content = wrapped
        hint_payload = HintBlock(hint=hint_content, source="用户").model_dump(
            mode="json",
        )
        delivered = 0
        for target in payload.targets:
            # Ownership check: only sessions of this user accept the aside.
            session = await runtime.storage.get_session(
                x_user_id,
                target.agent_id,
                target.session_id,
            )
            if session is None:
                continue
            await runtime.message_bus.queue_push(
                MessageBusKeys.inbox(target.session_id),
                hint_payload,
            )
            await enqueue_run_trigger(
                runtime.message_bus,
                user_id=x_user_id,
                session_id=target.session_id,
                agent_id=target.agent_id,
            )
            delivered += 1
        if delivered == 0:
            raise HTTPException(status_code=404, detail="目标会话不存在或已失效。")
        return {"data": {"delivered": delivered}}

    return router
