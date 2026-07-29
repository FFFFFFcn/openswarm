"""Insight orchestration and safe HTML report generation."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import date, datetime, timezone
from html import escape
import json
import math
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import quote, urlparse
from uuid import UUID, uuid4

from app.artifacts.report_data import write_report_data
from app.core.errors import AppError, NotFoundError
from app.insights.client import RedFoxClient
from app.insights.models import InsightSearchRequest


DATA_NOTICE = (
    "热门笔记范围为互动数 1000 以上的文章，每日早上 7 点更新昨日数据；"
    "互动数据为入库快照，不代表实时数值。"
)

BROAD_KEYWORDS: dict[str, list[str]] = {
    "穿搭": ["小个子穿搭", "通勤穿搭", "春日穿搭", "梨形身材穿搭", "法式穿搭", "松弛感穿搭", "职场穿搭", "显瘦穿搭", "基础款穿搭", "轻户外穿搭"],
    "美食": ["减脂餐", "一人食", "空气炸锅食谱", "低卡甜品", "早餐打卡", "露营美食", "地方小吃", "便当搭配", "懒人食谱", "探店攻略"],
    "美妆": ["通勤妆", "油皮底妆", "新手眼妆", "黄黑皮口红", "敏感肌护肤", "平价彩妆", "春夏底妆", "氛围感妆容", "成分护肤", "防晒测评"],
    "运动": ["新手跑步", "居家健身", "女性力量训练", "瑜伽入门", "体态改善", "骑行入门", "游泳训练", "办公室拉伸", "徒步装备", "核心训练"],
    "职场": ["职场沟通", "职场晋升", "新人入职", "转行经验", "面试复盘", "项目管理", "向上管理", "远程办公", "效率工具", "职业规划"],
    "旅行": ["周末短途旅行", "亲子旅行", "独自旅行", "小众目的地", "城市漫步", "自驾路线", "旅行摄影", "平价住宿", "出境攻略", "避坑指南"],
    "家居": ["小户型收纳", "租房改造", "厨房收纳", "中古家居", "智能家居", "低预算软装", "阳台改造", "儿童房设计", "清洁技巧", "家电选购"],
    "AI": ["AI办公提效", "AI产品经理", "AI写作工具", "AI绘画教程", "AI编程入门", "AI副业实践", "AI学习方法", "企业AI落地", "AI智能体", "AI工作流"],
}
BROAD_CATEGORIES = {
    "穿搭", "美食", "彩妆", "美妆", "影视", "职场", "萌宠", "家居", "旅行",
    "交通", "兴趣", "科技", "互联网", "医疗保健", "星座情感", "婚庆婚礼",
    "拍摄", "教育", "亲子育儿", "个人护理", "潮流鞋包", "生活", "科学探索",
    "新闻资讯", "运动", "AI",
}


def _number(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        try:
            return int(value) if math.isfinite(float(value)) else 0
        except (OverflowError, ValueError):
            return 0
    text = str(value).strip().lower().replace(",", "").replace("+", "")
    try:
        return int(float(text[:-1]) * 10_000) if text.endswith("w") else int(float(text))
    except ValueError:
        return 0


def _score(value: Any) -> float:
    try:
        parsed = float(value or 0)
        return parsed if math.isfinite(parsed) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _safe_url(value: Any, allowed_domains: set[str]) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    allowed = any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)
    return url if parsed.scheme == "https" and allowed else ""


def _item(article: dict[str, Any], include_scores: bool = True) -> dict[str, Any]:
    note_id = str(article.get("id") or article.get("noteId") or "")
    author_id = str(article.get("authorId") or "")
    title = str(article.get("title") or article.get("desc") or "无标题").strip()
    result: dict[str, Any] = {
        "note_id": note_id,
        "title": title[:200],
        "description": str(article.get("desc") or "")[:5000],
        "cover_url": _safe_url(
            article.get("cover"),
            {"xhscdn.com", "xiaohongshu.com"},
        ),
        "note_url": _safe_url(
            article.get("shareInfoLink"),
            {"xiaohongshu.com"},
        ) or (
            f"https://www.xiaohongshu.com/explore/{quote(note_id, safe='')}"
            if note_id
            else ""
        ),
        "author_id": author_id,
        "author_name": str(article.get("authorNickname") or "未知作者")[:120],
        "author_url": (
            f"https://www.xiaohongshu.com/user/profile/{quote(author_id, safe='')}"
            if author_id
            else ""
        ),
        "author_fans": _number(article.get("authorFans")),
        "created_at": str(article.get("createTime") or ""),
        "interactive_count": _number(article.get("interactiveCount")),
        "liked_count": _number(article.get("likedCount")),
        "collected_count": _number(article.get("collectedCount")),
        "comments_count": _number(article.get("commentsCount")),
        "shared_count": _number(article.get("sharedCount")),
    }
    if include_scores:
        result.update(
            {
                "relevance_score": _score(article.get("relevanceScore")),
                "popularity_score": _score(article.get("popularityScore")),
                "recency_score": _score(article.get("recencyScore")),
                "total_score": _score(article.get("totalScore")),
            },
        )
        result["recommendation_reason"] = (
            f"相关性 {result['relevance_score']:g}/10，"
            f"互动 {result['interactive_count']:,}，"
            f"综合得分 {result['total_score']:g}/15。"
        )
    else:
        result["recommendation_reason"] = (
            f"近期高互动推荐，入库时互动量 {result['interactive_count']:,}。"
        )
    return result


class InsightService:
    def __init__(self, client: RedFoxClient, reports_dir: Path) -> None:
        self.client = client
        self.reports_dir = reports_dir
        self._external_lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._request_times: deque[float] = deque()

    @property
    def configured(self) -> bool:
        return self.client.configured

    @staticmethod
    def guide_keyword(keyword: str) -> dict[str, Any]:
        normalized = keyword.strip()
        lookup = "AI" if normalized.casefold() == "ai" else normalized
        suggestions = BROAD_KEYWORDS.get(lookup, [])
        if not suggestions and lookup in BROAD_CATEGORIES:
            suggestions = [
                f"{lookup}入门",
                f"{lookup}避坑",
                f"{lookup}新手",
                f"{lookup}攻略",
                f"{lookup}测评",
                f"{lookup}趋势",
                f"{lookup}清单",
                f"{lookup}教程",
                f"{lookup}经验",
                f"{lookup}好物",
            ]
        return {
            "keyword": normalized,
            "is_broad": bool(suggestions),
            "suggestions": suggestions,
        }

    def search(self, request: InsightSearchRequest) -> dict[str, Any]:
        guide = self.guide_keyword(request.keyword)
        if guide["is_broad"] and not request.broad_keyword_confirmed:
            raise AppError(
                title="Keyword confirmation required",
                status=409,
                detail=(
                    f"'{request.keyword}' is a broad keyword. Choose a specific "
                    "direction or explicitly confirm searching the broad keyword."
                ),
                code="broad-keyword-confirmation-required",
                errors=[{"field": "keyword", "suggestions": guide["suggestions"]}],
            )

        payload = {
            "keyword": request.keyword.strip(),
            "pageNum": request.page_num,
            "pageSize": request.page_size,
            "startDate": request.start_date.isoformat() if request.start_date else "",
            "endDate": request.end_date.isoformat() if request.end_date else "",
            "source": "openswarm-redfox-community",
        }
        data = self._fetch(payload)
        is_full_site = not payload["keyword"]
        articles = data.get("articles") if isinstance(data.get("articles"), list) else []
        latest = (
            data.get("latestHotArticles")
            if isinstance(data.get("latestHotArticles"), list)
            else []
        )
        related_searches = data.get("relatedSearches")
        if not isinstance(related_searches, list):
            related_searches = []
        hot_topics = data.get("hotTopics")
        if not isinstance(hot_topics, list):
            hot_topics = []
        result = {
            "keyword": str(data.get("keyword") or payload["keyword"]),
            "start_date": payload["startDate"],
            "end_date": payload["endDate"],
            "total": _number(data.get("total") or len(articles)),
            "items": [
                _item(article, include_scores=not is_full_site)
                for article in articles[: request.max_items]
                if isinstance(article, dict)
            ],
            "latest_hot_articles": [
                _item(article, include_scores=False)
                for article in latest[:10]
                if isinstance(article, dict)
            ],
            "related_searches": [
                str(item)[:120]
                for item in related_searches[:10]
            ],
            "hot_topics": [
                str(
                    item.get("name")
                    or item.get("title")
                    or item.get("keyword")
                    or ""
                )[:120]
                if isinstance(item, dict)
                else str(item)[:120]
                for item in hot_topics[:10]
            ],
            "data_notice": DATA_NOTICE,
            "sort_notice": (
                "全站热门按互动数排序。"
                if is_full_site
                else "按相关性（10分）、热度（3分）、时效（2分）加权排序。"
            ),
            "queried_at": datetime.now(timezone.utc).isoformat(),
        }
        report_id = str(uuid4())
        self._write_report(report_id, result)
        return {
            **result,
            "report_id": report_id,
            "report_url": f"/api/v1/insights/reports/{report_id}",
        }

    def read_report(self, report_id: UUID) -> str:
        path = self.reports_dir / f"{report_id}.html"
        if not path.is_file():
            raise NotFoundError("insight report", str(report_id))
        return path.read_text(encoding="utf-8")

    def _write_report(self, report_id: str, result: dict[str, Any]) -> None:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup_reports()
        cards = []
        for index, item in enumerate(result["items"], start=1):
            scores = (
                f"<span>相关性 {item.get('relevance_score', 0):g}</span>"
                f"<span>热度 {item.get('popularity_score', 0):g}</span>"
                f"<span>时效 {item.get('recency_score', 0):g}</span>"
                f"<strong>总分 {item.get('total_score', 0):g}</strong>"
                if "total_score" in item
                else ""
            )
            cover = (
                f'<img src="{escape(item["cover_url"], quote=True)}" '
                f'alt="{escape(item["title"], quote=True)}封面" loading="lazy" referrerpolicy="no-referrer">'
                if item["cover_url"]
                else '<div class="cover-empty">暂无封面</div>'
            )
            cards.append(
                f"""
                <article class="card">
                  {cover}
                  <div class="body">
                    <small>#{index} · {escape(item["created_at"])}</small>
                    <h2>{escape(item["title"])}</h2>
                    <p>{escape(item["author_name"])} · {item["author_fans"]:,} 粉丝</p>
                    <p>{item["interactive_count"]:,} 互动 · {item["liked_count"]:,} 赞 · {item["collected_count"]:,} 藏 · {item["comments_count"]:,} 评 · {item["shared_count"]:,} 转</p>
                    <p>{escape(item["recommendation_reason"])}</p>
                    <div class="scores">{scores}</div>
                    <a href="{escape(item["note_url"], quote=True)}" target="_blank" rel="noopener noreferrer">查看原笔记 ↗</a>
                  </div>
                </article>
                """,
            )
        latest_cards = []
        if len(result["items"]) < 10:
            for index, item in enumerate(result["latest_hot_articles"], start=1):
                latest_cards.append(
                    f"""<article class="card"><div class="body">
                    <small>近期推荐 #{index} · {escape(item["created_at"])}</small>
                    <h2>{escape(item["title"])}</h2>
                    <p>{escape(item["author_name"])} · {item["interactive_count"]:,} 互动</p>
                    <p>{escape(item["recommendation_reason"])}</p>
                    <a href="{escape(item["note_url"], quote=True)}" target="_blank" rel="noopener noreferrer">查看原笔记 ↗</a>
                    </div></article>""",
                )
        html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(result["keyword"] or "全站")} · 小红书爆款洞察</title>
<style>
body{{margin:0;background:#f4f0ea;color:#262320;font:15px/1.6 system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:48px 24px}}
h1{{font-size:42px;line-height:1.1;margin:.2em 0}}.notice{{background:#fff;padding:18px;border-left:4px solid #d83b34}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:28px}}.card{{background:#fff;border:1px solid #e6dfd5;border-radius:12px;overflow:hidden}}
.card img,.cover-empty{{width:100%;aspect-ratio:4/3;object-fit:cover;background:#e9e2d8;display:grid;place-items:center}}.body{{padding:18px}}h2{{font-size:20px;line-height:1.35}}
.scores{{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}}.scores span,.scores strong{{background:#f4f0ea;padding:3px 8px;border-radius:999px}}a{{color:#b42f29}}
</style></head><body><main><small>OPEN SWARM / INSIGHT</small>
<h1>{escape(result["keyword"] or "全站热门")}</h1>
<p>{escape(result["start_date"] or "近30天")} — {escape(result["end_date"] or "昨日")} · 共 {result["total"]} 条，展示 {len(result["items"])} 条</p>
<div class="notice">{escape(result["data_notice"])}<br>{escape(result["sort_notice"])}</div>
<section class="grid">{''.join(cards)}</section>
{f'<h2>近期热门推荐</h2><section class="grid">{"".join(latest_cards)}</section>' if latest_cards else ''}
</main></body></html>"""
        path = self.reports_dir / f"{report_id}.html"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(path)
        write_report_data(
            self.reports_dir,
            str(report_id),
            "insight",
            result["keyword"] or "全站热门",
            result,
        )

    def _fetch(self, payload: dict[str, Any]) -> dict[str, Any]:
        cache_key = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self._external_lock:
            now = time.monotonic()
            cached = self._cache.get(cache_key)
            if cached and cached[0] > now:
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
            data = self.client.search(payload)
            self._request_times.append(now)
            self._cache[cache_key] = (now + 300, deepcopy(data))
            return data

    def _cleanup_reports(self) -> None:
        reports = sorted(
            self.reports_dir.glob("*.html"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        cutoff = time.time() - 7 * 24 * 60 * 60
        for index, path in enumerate(reports):
            if index >= 200 or path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
