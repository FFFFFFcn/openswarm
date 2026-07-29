"""Screenshot-based account profile extraction via an OpenAI-compatible API.

The endpoint only extracts structured fields from a Xiaohongshu profile
screenshot; nothing is persisted here. The frontend fills the extraction
result into an editable form and the user confirms before saving.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

from app.core.errors import AppError

EXTRACT_TIMEOUT_SECONDS = 60

EXTRACT_INSTRUCTION = """\
这是一张小红书账号主页截图。请提取以下字段并只输出一个 JSON 对象（不要任何解释文字）：
{
  "account_name": "账号昵称",
  "red_id": "小红书号（通常在昵称下方，形如“小红书号：xxxx”，只要号码本身）",
  "follower_count": 粉丝数（整数；“1.2万”换算为 12000；看不到则为 null）,
  "notes_count": 笔记数（整数；看不到则为 null）,
  "intro": "主页简介原文（没有则为空字符串）",
  "niche": "根据昵称、简介和可见内容推测的账号赛道，如“职场成长”“家常菜谱”，用简短中文"
}
看不清或不存在的字段：字符串用 ""，数字用 null。不要编造。"""


class ExtractionError(AppError):
    def __init__(self, detail: str, status: int = 502) -> None:
        super().__init__(
            title="Account extraction failed",
            status=status,
            detail=detail,
            code="account-extraction-failed",
        )


def _coerce_count(value: Any) -> int | None:
    """Accept ints or Chinese-style count strings like '1.2万'."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 else None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([万wW]?)\+?", text)
        if not match:
            return None
        number = float(match.group(1))
        if match.group(2):
            number *= 10_000
        return int(number)
    return None


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def extract_account_profile(
    base_url: str,
    api_key: str,
    model: str,
    image_base64: str,
    mime_type: str,
) -> dict[str, Any]:
    """Call {base_url}/chat/completions with the screenshot, return fields."""
    request_body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EXTRACT_INSTRUCTION},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{image_base64}",
                            },
                        },
                    ],
                },
            ],
            "temperature": 0,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    url = base_url.rstrip("/") + "/chat/completions"
    request = urllib.request.Request(
        url,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=EXTRACT_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ExtractionError(
            f"视觉模型调用失败（HTTP {exc.code}）。请确认所选模型支持图片输入。",
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ExtractionError("视觉模型服务无法访问，请稍后重试或改用手动录入。") from exc
    except ValueError as exc:
        raise ExtractionError("视觉模型返回了无法解析的响应。") from exc

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ExtractionError("视觉模型响应缺少内容，请重试或改用手动录入。") from exc
    if not isinstance(content, str) or not content.strip():
        raise ExtractionError("视觉模型未返回文本内容，请重试或改用手动录入。")

    try:
        fields = json.loads(_strip_code_fence(content))
    except ValueError as exc:
        raise ExtractionError(
            "无法从模型输出中解析账号信息，请重试或改用手动录入。",
        ) from exc
    if not isinstance(fields, dict):
        raise ExtractionError("模型输出不是预期的字段结构，请改用手动录入。")

    def _text(key: str, limit: int) -> str:
        value = fields.get(key)
        return value.strip()[:limit] if isinstance(value, str) else ""

    return {
        "account_name": _text("account_name", 80),
        "red_id": _text("red_id", 64),
        "follower_count": _coerce_count(fields.get("follower_count")),
        "notes_count": _coerce_count(fields.get("notes_count")),
        "intro": _text("intro", 1000),
        "niche": _text("niche", 120),
    }
