"""Small, typed client for the Xiaohongshu search data endpoint."""
from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from pydantic import SecretStr

from app.core.errors import AppError


REDFOX_SEARCH_URL = "https://redfox.hk/story/api/xhs/search/search"


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class RedFoxClient:
    def __init__(
        self,
        api_key: SecretStr | Callable[[], SecretStr | None] | None,
        timeout_seconds: float = 30,
        max_retries: int = 3,
        open_request: Callable[..., Any] | None = None,
    ) -> None:
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._max_retries = max_retries
        self._open_request = open_request or urllib.request.build_opener(
            _NoRedirectHandler(),
        ).open

    def _current_key(self) -> str:
        # api_key may be a live provider (admin-configurable key store).
        key = self._api_key() if callable(self._api_key) else self._api_key
        return key.get_secret_value().strip() if key else ""

    @property
    def configured(self) -> bool:
        return bool(self._current_key())

    def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        api_key = self._current_key()
        if not api_key:
            raise AppError(
                title="数据接口密钥未配置",
                status=503,
                detail="请先在管理后台配置数据接口密钥，再发起小红书爆款洞察查询。",
                code="data-api-key-required",
            )

        request = urllib.request.Request(
            REDFOX_SEARCH_URL,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-API-KEY": api_key,
            },
            method="POST",
        )
        last_error = "数据接口请求失败。"
        for attempt in range(self._max_retries):
            retry_after = 0.0
            try:
                with self._open_request(
                    request,
                    timeout=self._timeout_seconds,
                ) as response:
                    raw = response.read(10_000_001)
                if len(raw) > 10_000_000:
                    raise ValueError("数据接口响应超过 10 MB 安全上限。")
                body = json.loads(raw.decode("utf-8"))
                if not isinstance(body, dict):
                    raise ValueError("数据接口响应根节点必须是 JSON 对象。")
                if body.get("code") != 2000:
                    raise ValueError(str(body.get("msg") or "数据接口返回了错误。"))
                data = body.get("data")
                if not isinstance(data, dict):
                    raise ValueError("数据接口响应缺少 data 对象。")
                return data
            except urllib.error.HTTPError as exc:
                last_error = f"数据接口返回 HTTP {exc.code}。"
                if exc.code not in {408, 425, 429} and exc.code < 500:
                    break
                raw_retry = exc.headers.get("Retry-After", "") if exc.headers else ""
                try:
                    retry_after = min(float(raw_retry), 10)
                except ValueError:
                    retry_after = 0.0
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                last_error = f"数据接口连接失败: {reason}。"
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                last_error = str(exc)
                break
            if attempt < self._max_retries - 1:
                time.sleep(retry_after or (2**attempt + random.random()))

        raise AppError(
            title="数据接口暂不可用",
            status=502,
            detail=last_error,
            code="data-service-unavailable",
        )
