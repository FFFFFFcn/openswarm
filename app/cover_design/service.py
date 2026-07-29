"""Cover design orchestration backed by trending cover data."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from html import escape
import json
import math
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

from app.artifacts.report_data import write_report_data
from app.core.errors import AppError, NotFoundError
from app.cover_design.models import CoverDesignRequest
from app.insights.service import InsightService
from app.title_insights.client import RedFoxTitleTrendClient


DATA_NOTICE = (
    "封面方案基于外部数据接口收录的小红书爆款笔记数据（昨日至 30 天前），"
    "每日持续收录 2000+ 条。数据为入库快照，不代表实时数值。"
)
LINK_NOTICE = "参考链接仅用于人工复核原笔记，请遵守平台规则与内容版权要求。"
SOURCE = "小红书爆款封面生成-GitHub"
GROUPS = (
    "lowPowderExplosiveArticle",
    "likeTheTop500",
    "singleDayIncrements",
    "sevenDaysOfIncrements",
)
GROUP_LABELS = {
    "lowPowderExplosiveArticle": "低粉高赞",
    "likeTheTop500": "点赞最多",
    "singleDayIncrements": "单日互动爆发",
    "sevenDaysOfIncrements": "七日持续增长",
}


def _number(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        try:
            return int(value) if math.isfinite(float(value)) else 0
        except (OverflowError, ValueError):
            return 0
    text = str(value or 0).strip().lower().replace(",", "").replace("+", "")
    try:
        parsed = float(text[:-1]) * 10_000 if text.endswith("w") else float(text)
        return max(0, min(int(parsed), 1_000_000_000)) if math.isfinite(parsed) else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def _safe_url(value: Any, allowed_domains: set[str]) -> str:
    from urllib.parse import urlparse
    url = str(value or "").strip()
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    allowed = any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)
    return url if parsed.scheme in ("http", "https") and allowed else ""


def _cover_url(value: Any) -> str:
    return _safe_url(value, {
        "xhscdn.com", "xhscdn.net",
        "xiaohongshu.com",
        "rednotecdn.com", "rednotecdn.net",
    })


class CoverDesignService:
    def __init__(self, client: RedFoxTitleTrendClient, reports_dir: Path) -> None:
        self.client = client
        self.reports_dir = reports_dir
        self._external_lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._request_times: deque[float] = deque()

    @property
    def configured(self) -> bool:
        return self.client.configured

    def search(self, request: CoverDesignRequest) -> dict[str, Any]:
        keyword = request.keyword.strip()
        if keyword:
            guide = InsightService.guide_keyword(keyword)
            if guide["is_broad"] and not request.broad_keyword_confirmed:
                raise AppError(
                    title="Keyword confirmation required",
                    status=409,
                    detail=f"「{keyword}」范围较大，请先选择细分方向或确认继续搜索原词。",
                    code="broad-keyword-confirmation-required",
                    errors=[{"field": "keyword", "suggestions": guide["suggestions"]}],
                )

        window = max(1, min(request.days, 30))
        start_date = (date.today() - timedelta(days=window)).isoformat()
        data = self._fetch(keyword, start_date)

        counts: dict[str, int] = {}
        merged: dict[str, dict[str, Any]] = {}
        for group in GROUPS:
            values = data.get(group)
            if values is not None and not isinstance(values, list):
                raise AppError(
                    title="数据接口响应异常",
                    status=502,
                    detail=f"数据字段 {group} 必须是数组。",
                    code="data-response-invalid",
                )
            rows = values or []
            counts[group] = len(rows)
            for raw in rows:
                if not isinstance(raw, dict):
                    continue
                item = self._cover_item(raw, group)
                key = item["note_id"] or item["title"]
                if key and key not in merged:
                    merged[key] = item
                elif key and key in merged:
                    existing = merged[key]
                    if existing.get("interaction_count", 0) < item.get("interaction_count", 0):
                        existing_groups = set(existing.get("source_groups", []))
                        existing_groups.update(item.get("source_groups", []))
                        existing["source_groups"] = sorted(existing_groups)

        items = list(merged.values())
        items.sort(key=lambda item: item.get("interaction_count", 0), reverse=True)
        top = items[: request.max_items]

        if not top:
            suggestions = [
                f"{keyword}教程",
                f"{keyword}避坑",
                f"{keyword}清单",
                f"{keyword}测评",
                f"{keyword}入门",
            ] if keyword else []
            raise AppError(
                title="No cover samples found",
                status=409,
                detail=f"近{window}天没有找到「{keyword or '全站'}」的爆款封面数据。",
                code="cover-samples-not-found",
                errors=[{"field": "keyword", "suggestions": suggestions}],
            )

        result: dict[str, Any] = {
            "keyword": keyword,
            "window_days": window,
            "start_date": start_date,
            "category_counts": counts,
            "total_samples": len(items),
            "items": top,
            "data_notice": DATA_NOTICE,
            "link_notice": LINK_NOTICE,
            "queried_at": datetime.now(timezone.utc).isoformat(),
        }
        report_id = str(uuid4())
        self._write_report(report_id, result)
        result["report_id"] = report_id
        result["report_url"] = f"/api/v1/cover-design/reports/{report_id}"
        return result

    def read_report(self, report_id: UUID) -> str:
        path = self.reports_dir / f"cover-{report_id}.html"
        if not path.is_file():
            raise NotFoundError("cover design report", str(report_id))
        return path.read_text(encoding="utf-8")

    @staticmethod
    def _cover_item(raw: dict[str, Any], group: str) -> dict[str, Any]:
        note_id = str(
            raw.get("photoId")
            or raw.get("noteId")
            or raw.get("id")
            or raw.get("note_id")
            or ""
        )
        title = str(
            raw.get("title")
            or raw.get("photoTitle")
            or raw.get("noteTitle")
            or raw.get("desc")
            or ""
        ).strip()[:200]
        user_id = str(raw.get("userId") or raw.get("authorId") or "")
        user_name = str(
            raw.get("userName")
            or raw.get("nickname")
            or raw.get("authorNickname")
            or "未知作者"
        )[:120]
        fans = _number(raw.get("fans") or raw.get("authorFans"))
        cover = _cover_url(raw.get("coverUrl") or raw.get("cover") or raw.get("thumbnail"))
        note_url = _safe_url(
            raw.get("shareInfoLink") or raw.get("url"),
            {"xiaohongshu.com"},
        ) or (
            f"https://www.xiaohongshu.com/explore/{quote(note_id, safe='')}"
            if note_id
            else ""
        )
        author_url = (
            f"https://www.xiaohongshu.com/user/profile/{quote(user_id, safe='')}"
            if user_id
            else ""
        )
        ana_add = raw.get("anaAdd")
        if isinstance(ana_add, dict):
            interaction = max(
                _number(raw.get("interactiveCount")),
                _number(ana_add.get("addInteractiveount")),
                _number(ana_add.get("interactiveCount")),
            )
            liked = max(
                _number(raw.get("useLikeCount") or raw.get("likedCount")),
                _number(ana_add.get("addLikeCount")),
                _number(ana_add.get("useLikeCount")),
            )
            collected = max(
                _number(raw.get("collectedCount")),
                _number(ana_add.get("addCollectedCunt")),
                _number(ana_add.get("collectedCount")),
            )
            comments = max(
                _number(raw.get("useCommentCount") or raw.get("commentsCount")),
                _number(ana_add.get("addCommentCount")),
                _number(ana_add.get("useCommentCount")),
            )
            shared = max(
                _number(raw.get("useShareCount") or raw.get("sharedCount")),
                _number(ana_add.get("addShareCount")),
                _number(ana_add.get("useShareCount")),
            )
        else:
            interaction = _number(raw.get("interactiveCount")) or (
                _number(raw.get("useLikeCount"))
                + _number(raw.get("collectedCount"))
                + _number(raw.get("useCommentCount"))
                + _number(raw.get("useShareCount"))
            )
            liked = _number(raw.get("useLikeCount") or raw.get("likedCount"))
            collected = _number(raw.get("collectedCount"))
            comments = _number(raw.get("useCommentCount") or raw.get("commentsCount"))
            shared = _number(raw.get("useShareCount") or raw.get("sharedCount"))

        return {
            "note_id": note_id,
            "title": title,
            "description": str(raw.get("desc") or "")[:5000],
            "cover_url": cover,
            "note_url": note_url,
            "user_id": user_id,
            "author_name": user_name,
            "author_url": author_url,
            "author_fans": fans,
            "interaction_count": interaction,
            "liked_count": liked,
            "collected_count": collected,
            "comments_count": comments,
            "shared_count": shared,
            "source_group": GROUP_LABELS.get(group, group),
            "published_at": str(raw.get("publicTime") or raw.get("createTime") or ""),
        }

    def _fetch(self, keyword: str, start_date: str) -> dict[str, Any]:
        cache_key = json.dumps([keyword, SOURCE, start_date], ensure_ascii=False)
        with self._external_lock:
            now = time.monotonic()
            for key, (expires_at, _value) in list(self._cache.items()):
                if expires_at <= now:
                    self._cache.pop(key, None)
            cached = self._cache.get(cache_key)
            if cached:
                return deepcopy(cached[1])
            while self._request_times and self._request_times[0] <= now - 60:
                self._request_times.popleft()
            if len(self._request_times) >= 10:
                raise AppError(
                    title="数据接口限流",
                    status=429,
                    detail="查询过于频繁，请一分钟后重试。",
                    code="data-rate-limit",
                )
            self._request_times.append(now)
            data = self.client.fetch(keyword, SOURCE, start_date)
            while len(self._cache) >= 128:
                self._cache.pop(next(iter(self._cache)))
            self._cache[cache_key] = (now + 300, deepcopy(data))
            return data

    def _write_report(self, report_id: str, result: dict[str, Any]) -> None:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup_reports()
        cards = []
        for index, item in enumerate(result["items"], start=1):
            cover = (
                f'<img src="{escape(item["cover_url"], quote=True)}" '
                f'alt="{escape(item["title"], quote=True)}封面" loading="lazy" referrerpolicy="no-referrer">'
                if item["cover_url"]
                else '<div class="cover-empty">暂无封面</div>'
            )
            author = (
                f'<a href="{escape(item["author_url"], quote=True)}" target="_blank" rel="noopener noreferrer">'
                f'{escape(item["author_name"])}</a>（粉丝 {item["author_fans"]:,}）'
                if item["author_url"]
                else f"{escape(item['author_name'])}（粉丝 {item['author_fans']:,}）"
            )
            note_link = (
                f'<a href="{escape(item["note_url"], quote=True)}" target="_blank" rel="noopener noreferrer">查看原笔记 ↗</a>'
                if item["note_url"]
                else ""
            )
            cards.append(
                f"""
                <article class="card">
                  {cover}
                  <div class="body">
                    <small>#{index} · {escape(item["source_group"])} · {escape(item["published_at"])}</small>
                    <h2>{escape(item["title"])}</h2>
                    <p>{author}</p>
                    <p>{item["interaction_count"]:,} 互动 · {item["liked_count"]:,} 赞 · {item["collected_count"]:,} 藏 · {item["comments_count"]:,} 评 · {item["shared_count"]:,} 转</p>
                    {note_link}
                  </div>
                </article>
                """,
            )
        category_tags = " · ".join(
            f"{GROUP_LABELS.get(g, g)} {result['category_counts'].get(g, 0)}" for g in GROUPS
        )
        html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(result["keyword"] or "全站")} · 小红书爆款封面数据</title>
<style>
body{{margin:0;background:#f4f0ea;color:#262320;font:15px/1.6 system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:48px 24px}}
h1{{font-size:42px;line-height:1.1;margin:.2em 0}}.notice{{background:#fff;padding:18px;border-left:4px solid #d83b34}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:28px}}.card{{background:#fff;border:1px solid #e6dfd5;border-radius:12px;overflow:hidden}}
.card img,.cover-empty{{width:100%;aspect-ratio:3/4;object-fit:cover;background:#e9e2d8;display:grid;place-items:center}}.body{{padding:18px}}h2{{font-size:18px;line-height:1.35}}
a{{color:#b42f29}}
</style></head><body><main><small>OPEN SWARM / COVER DESIGN</small>
<h1>{escape(result["keyword"] or "全站热门")}</h1>
<p>近 {result["window_days"]} 天 · 共 {result["total_samples"]} 条去重样本，展示 {len(result["items"])} 条</p>
<p>{category_tags}</p>
<div class="notice">{escape(result["data_notice"])}</div>
<section class="grid">{''.join(cards)}</section>
</main></body></html>"""
        path = self.reports_dir / f"cover-{report_id}.html"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(path)
        write_report_data(
            self.reports_dir,
            f"cover-{report_id}",
            "cover",
            result["keyword"] or "全站热门",
            result,
        )

    def _cleanup_reports(self) -> None:
        reports = sorted(
            self.reports_dir.glob("cover-*.html"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        cutoff = time.time() - 7 * 24 * 60 * 60
        for index, path in enumerate(reports):
            if index >= 200 or path.stat().st_mtime < cutoff:
                path.with_suffix(".json").unlink(missing_ok=True)
                path.unlink(missing_ok=True)
