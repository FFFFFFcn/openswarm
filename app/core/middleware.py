"""HTTP request metadata and defensive response headers."""
from __future__ import annotations

import json
import logging
import re
import time
import uuid

from fastapi import FastAPI, Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.agent_team import hitl_guard


logger = logging.getLogger("openswarm.http")


class HitlDenialGuardMiddleware:
    """Make "reject == stop" deterministic for HITL tool confirmations.

    The framework only records a ``DENIED`` tool result when the user clicks
    reject and then leaves the retry decision to the model, which often
    re-issues the same call and pops the confirmation card again.  This
    middleware watches ``POST /chat/`` payloads:

    - ``USER_CONFIRM_RESULT`` with ``confirmed == false`` -> remember the
      denied tool name so the tool's ``check_permissions`` returns a hard
      ``DENY`` on any retry (no card re-shown).
    - A fresh user message -> clear remembered denials (a new task may ask
      for confirmation again).

    Implemented as a pure ASGI middleware so the request body can be buffered
    and replayed downstream without the body-consumption pitfalls of
    ``BaseHTTPMiddleware``.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope.get("path", "").rstrip("/") != "/chat"
        ):
            await self.app(scope, receive, send)
            return

        # Buffer the (small, JSON) request body so it can be inspected and
        # then replayed to the downstream application unchanged.
        chunks: list[bytes] = []
        more_body = True
        disconnected = False
        while more_body:
            message = await receive()
            if message["type"] == "http.disconnect":
                disconnected = True
                break
            if message["type"] == "http.request":
                chunks.append(message.get("body", b""))
                more_body = message.get("more_body", False)
        if disconnected:
            return
        body = b"".join(chunks)

        try:
            self._inspect(body)
        except Exception:  # noqa: BLE001 - the guard must never break chat
            logger.debug(
                "HITL denial guard failed to parse chat payload",
                exc_info=True,
            )

        sent = False

        async def replay_receive() -> dict:
            nonlocal sent
            if sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    def _inspect(body: bytes) -> None:
        if not body:
            return
        payload = json.loads(body)
        if not isinstance(payload, dict):
            return
        inp = payload.get("input")
        if isinstance(inp, dict) and inp.get("type") == "USER_CONFIRM_RESULT":
            for result in inp.get("confirm_results") or []:
                if not isinstance(result, dict):
                    continue
                tool_call = result.get("tool_call") or {}
                name = tool_call.get("name") if isinstance(tool_call, dict) else None
                if not name:
                    continue
                if result.get("confirmed"):
                    hitl_guard.record_approval(name)
                    logger.info("HITL approval recorded for tool %s", name)
                else:
                    hitl_guard.record_denial(name)
                    logger.info("HITL denial recorded for tool %s", name)
        elif isinstance(inp, list) or (
            isinstance(inp, dict) and "type" not in inp
        ):
            # A fresh user message starts a new task: forget past denials.
            hitl_guard.clear_denials()


def register_http_middleware(app: FastAPI) -> None:
    app.add_middleware(HitlDenialGuardMiddleware)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        supplied_id = request.headers.get("X-Request-Id", "")
        request_id = (
            supplied_id
            if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", supplied_id)
            else uuid.uuid4().hex
        )
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if "Content-Security-Policy" not in response.headers:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; "
                "script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "font-src 'self' data:; "
                "connect-src 'self'; frame-ancestors 'none'"
            )
        logger.info(
            "%s %s %s %.2fms",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            extra={"request_id": request_id},
        )
        return response
