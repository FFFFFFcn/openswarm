"""Account benchmark orchestration and safe report generation."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from html import escape
import json
import math
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import quote, urlparse
from uuid import UUID, uuid4

from app.account_benchmark.client import RedFoxAccountClient
from app.account_benchmark.models import AccountBenchmarkSearchRequest
from app.artifacts.report_data import write_report_data
from app.core.errors import AppError, NotFoundError


DATA_NOTICE = (
    "账号数据为外部数据接口入库快照，与小红书实时数据存在差异；"
    "投放候选仅作数据初筛，账号主体身份、报价和商业合作效果均需人工核验。"
)

STANDARD_CATEGORIES = [
    "综合全部", "出行代步", "休闲爱好", "影视娱乐", "数码科技",
    "医疗保健", "综合杂项", "星座情感", "时尚穿搭", "婚庆婚礼",
    "拍摄记录", "学习教育", "化妆美容", "居家装修", "旅行度假",
    "亲子育儿", "个人护理", "美味佳肴", "职业发展", "宠物天地",
    "潮流鞋包", "日常生活", "科学探索", "新闻资讯", "体育锻炼",
]
STANDARD_LEVELS = ["明星", "品牌", "企业", "头部kol", "腰部kol", "尾部kol", "素人"]

CATEGORY_MAPPING = {
    "护肤": "个人护理", "美容": "个人护理", "美妆": "化妆美容",
    "化妆": "化妆美容", "彩妆": "化妆美容", "穿搭": "时尚穿搭",
    "时尚": "时尚穿搭", "服装": "时尚穿搭", "美食": "美味佳肴",
    "做饭": "美味佳肴", "烹饪": "美味佳肴", "菜谱": "美味佳肴",
    "烘焙": "美味佳肴", "探店": "美味佳肴", "旅行": "旅行度假",
    "旅游": "旅行度假", "家居": "居家装修", "装修": "居家装修",
    "健身": "体育锻炼", "运动": "体育锻炼", "减肥": "体育锻炼",
    "母婴": "亲子育儿", "育儿": "亲子育儿", "宝妈": "亲子育儿",
    "宠物": "宠物天地", "猫": "宠物天地", "狗": "宠物天地",
    "数码": "数码科技", "手机": "数码科技", "电脑": "数码科技",
    "科技": "数码科技", "互联网": "数码科技", "ai": "数码科技",
    "人工智能": "数码科技", "教育": "学习教育", "学习": "学习教育",
    "英语": "学习教育", "考研": "学习教育", "瑜伽": "体育锻炼",
    "情感": "星座情感", "恋爱": "星座情感", "职场": "职业发展",
    "工作": "职业发展", "求职": "职业发展", "vlog": "日常生活",
    "日常": "日常生活",
}
LEVEL_MAPPING = {
    "明星": "明星", "艺人": "明星", "爱豆": "明星", "idol": "明星",
    "品牌": "品牌", "牌子": "品牌", "企业": "企业", "公司": "企业",
    "商家": "企业", "官方号": "企业", "头部kol": "头部kol",
    "头部": "头部kol", "大v": "头部kol", "百万粉": "头部kol",
    "腰部kol": "腰部kol", "腰部": "腰部kol", "十万粉": "腰部kol",
    "尾部kol": "尾部kol", "尾部": "尾部kol", "万粉": "尾部kol",
    "素人": "素人", "普通人": "素人", "小白": "素人",
    "新手": "素人", "新人": "素人", "个人号": "素人",
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
    except (OverflowError, ValueError):
        return 0


def _works(account: dict[str, Any]) -> list[dict[str, Any]]:
    works = account.get("works")
    if not isinstance(works, list):
        return []
    return [work for work in works if isinstance(work, dict)]


def _safe_url(value: Any, allowed_domains: set[str]) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    allowed = any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)
    return url if parsed.scheme == "https" and allowed else ""


def _match_category(value: str | None) -> str:
    if not value:
        return "综合全部"
    normalized = value.strip()
    folded = normalized.casefold()
    for keyword, category in CATEGORY_MAPPING.items():
        if keyword.casefold() in folded:
            return category
    for category in STANDARD_CATEGORIES:
        if category in normalized:
            return category
    raise AppError(
        title="Unsupported Xiaohongshu track",
        status=422,
        detail=f"无法识别赛道「{normalized}」，请从标准赛道中选择。",
        code="unsupported-account-track",
        errors=[{"field": "track", "options": STANDARD_CATEGORIES}],
    )


def _match_level(value: str | None) -> str:
    if not value:
        return ""
    normalized = value.strip()
    folded = normalized.casefold()
    for keyword, level in LEVEL_MAPPING.items():
        if keyword.casefold() in folded:
            return level
    raise AppError(
        title="Unsupported Xiaohongshu account level",
        status=422,
        detail=f"无法识别账号等级「{normalized}」，请从标准等级中选择。",
        code="unsupported-account-level",
        errors=[{"field": "level", "options": STANDARD_LEVELS}],
    )


def _best_work(works: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not works:
        return None
    return max(
        works,
        key=lambda work: (
            _number(work.get("likedCount"))
            + _number(work.get("collectedCount"))
            + _number(work.get("sharedCount"))
        ),
    )


def _recommendation_reason(account: dict[str, Any]) -> str:
    fans = _number(account.get("fans"))
    interactive_30 = _number(account.get("interactiveCountThirty"))
    notes_7 = _number(account.get("noteCountSeven"))
    works = _works(account)
    points: list[str] = []
    if fans >= 500_000:
        points.append("头部影响力账号")
    elif fans >= 100_000:
        points.append("中腰部成熟账号")
    elif fans >= 10_000:
        points.append("已具备一定商业化基础")
    elif fans >= 1_000:
        points.append("成长阶段账号")
    else:
        points.append("起号阶段参考样本")
    if notes_7 >= 7:
        points.append("近7天保持日更")
    elif notes_7 >= 4:
        points.append("更新节奏稳定")
    elif notes_7:
        points.append("近期持续更新")
    if interactive_30 >= 100_000:
        points.append("近30天互动突出")
    elif interactive_30 >= 10_000:
        points.append("近30天内容表现稳定")
    elif interactive_30:
        points.append("具备可观察的互动基础")
    best = _best_work(works)
    if best:
        title = str(best.get("title") or "").strip()
        engagement = (
            _number(best.get("likedCount"))
            + _number(best.get("collectedCount"))
            + _number(best.get("sharedCount"))
        )
        if title and engagement >= 100:
            points.append(f"代表作「{title[:16]}」互动较高")
    return "，".join(points[:4]) + "。"


def _content_analysis(account: dict[str, Any]) -> str:
    works = _works(account)
    if not works:
        return "暂无近期作品明细，可先观察更新频率与互动趋势。"
    titles = [str(work.get("title") or "") for work in works if work.get("title")]
    descriptions = [str(work.get("desc") or "") for work in works if work.get("desc")]
    all_text = " ".join(titles + descriptions)
    points: list[str] = []
    if titles:
        average = sum(len(title) for title in titles) / len(titles)
        points.append("标题偏简短" if average < 12 else "标题信息量较高")
        if sum(any(character.isdigit() for character in title) for title in titles) >= len(titles) / 2:
            points.append("常用数字增强点击")
    if any(word in all_text for word in ("教程", "干货", "攻略")):
        points.append("以教程/干货为主要内容抓手")
    if any(word in all_text for word in ("测评", "评测", "避雷")):
        points.append("测评与避坑内容占比较高")
    if any(word in all_text.casefold() for word in ("日常", "vlog")):
        points.append("融入日常化叙事")
    return "；".join(points[:4]) or "可参考其近期作品的选题和表达节奏。"


def _work_item(work: dict[str, Any]) -> dict[str, Any]:
    note_id = str(work.get("id") or work.get("noteId") or "")
    url = _safe_url(
        work.get("url") or work.get("shareInfoLink"),
        {"xiaohongshu.com"},
    )
    if not url and note_id:
        url = f"https://www.xiaohongshu.com/explore/{quote(note_id, safe='')}"
    return {
        "note_id": note_id,
        "title": str(work.get("title") or "无标题")[:200],
        "url": url,
        "cover_url": _safe_url(
            work.get("cover"),
            {"xhscdn.com", "xiaohongshu.com"},
        ),
        "liked_count": _number(work.get("likedCount")),
        "collected_count": _number(work.get("collectedCount")),
        "shared_count": _number(work.get("sharedCount")),
    }


def _account_item(account: dict[str, Any], group: str) -> dict[str, Any]:
    account_id = str(
        account.get("redId")
        or account.get("userId")
        or account.get("id")
        or ""
    )
    profile_url = _safe_url(account.get("url"), {"xiaohongshu.com"})
    if not profile_url and account_id:
        profile_url = (
            "https://www.xiaohongshu.com/user/profile/"
            f"{quote(account_id, safe='')}"
        )
    fans = _number(account.get("fans"))
    interactive_30 = _number(account.get("interactiveCountThirty"))
    works = [_work_item(work) for work in _works(account)[:5]]
    return {
        "account_id": account_id,
        "nickname": str(account.get("nickname") or "未知账号")[:120],
        "profile_url": profile_url,
        "avatar_url": _safe_url(
            account.get("avatar") or account.get("image"),
            {"xhscdn.com", "xiaohongshu.com"},
        ),
        "fans": fans,
        "level": str(account.get("level") or "")[:40],
        "track": str(account.get("track") or account.get("category") or "")[:80],
        "interactive_30": interactive_30,
        "interactive_7": _number(account.get("interactiveCountSeven")),
        "notes_7": _number(account.get("noteCountSeven")),
        "total_works": _number(account.get("totalWork")),
        "liked": _number(account.get("liked")),
        "collected": _number(account.get("collected")),
        "interaction_fan_ratio_30": round(interactive_30 / fans * 100, 2) if fans else 0,
        "recommendation_reason": _recommendation_reason(account),
        "content_analysis": _content_analysis(account),
        "top_works": works[:3],
        "data_updated_at": str(account.get("gmtCreate") or "")[:40],
        "source_group": group,
    }


class AccountBenchmarkService:
    def __init__(self, client: RedFoxAccountClient, reports_dir: Path) -> None:
        self.client = client
        self.reports_dir = reports_dir
        self._external_lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._request_times: deque[float] = deque()

    @property
    def configured(self) -> bool:
        return self.client.configured

    @staticmethod
    def options() -> dict[str, Any]:
        return {
            "categories": STANDARD_CATEGORIES,
            "levels": STANDARD_LEVELS,
            "data_notice": DATA_NOTICE,
        }

    def search(self, request: AccountBenchmarkSearchRequest) -> dict[str, Any]:
        if request.query_mode == "red_id":
            payload = {
                "redId": request.red_id or "",
                "track": "",
                "maxFans": "",
                "minFans": "",
                "level": "",
                "source": "openswarm-redfox-community",
            }
            criteria = {"query_mode": "red_id", "red_id": request.red_id}
        else:
            track = _match_category(request.track)
            level = _match_level(request.level)
            if (
                track == "综合全部"
                and request.min_fans is None
                and request.max_fans is None
            ):
                raise AppError(
                    title="Account benchmark filters too broad",
                    status=422,
                    detail=(
                        "选择“综合全部”时，请同时填写最低或最高粉丝数；"
                        "也可以改选一个具体内容赛道。"
                    ),
                    code="account-benchmark-filters-too-broad",
                    errors=[
                        {
                            "field": "track",
                            "message": "综合全部需要搭配粉丝范围",
                        },
                    ],
                )
            min_fans = request.min_fans
            if request.max_fans is not None and min_fans is None:
                min_fans = 0
            payload = {
                "redId": "",
                "track": track,
                "maxFans": (
                    request.max_fans if request.max_fans is not None else ""
                ),
                "minFans": min_fans if min_fans is not None else "",
                "level": level,
                "source": "openswarm-redfox-community",
            }
            criteria = {
                "query_mode": "filters",
                "track": track,
                "min_fans": min_fans,
                "max_fans": request.max_fans,
                "level": level,
            }

        data = self._fetch(payload)
        same_raw = data.get("sameLevelAccounts", [])
        high_raw = data.get("highLevelAccounts", [])
        if not isinstance(same_raw, list) or not isinstance(high_raw, list):
            raise AppError(
                title="账号数据响应异常",
                status=502,
                detail="相似账号数据响应结构发生变化，请稍后重试。",
                code="invalid-account-response",
            )
        if criteria.get("level") in {"明星", "品牌", "企业", "头部kol"}:
            high_raw = []
        same = [
            _account_item(account, "same_level")
            for account in same_raw[: request.max_items]
            if isinstance(account, dict)
        ]
        high = [
            _account_item(account, "high_level")
            for account in high_raw[: request.max_items]
            if isinstance(account, dict)
        ]
        combined: dict[str, dict[str, Any]] = {}
        for account in same + high:
            key = (
                account["account_id"]
                or account["profile_url"]
                or f"{account['nickname']}:{account['fans']}"
            )
            combined.setdefault(key, account)
        creators = [
            account
            for account in combined.values()
            if account["level"] not in {"明星", "品牌", "企业"}
        ]
        kol_candidates = sorted(
            creators,
            key=lambda account: (
                account["interactive_30"],
                account["interaction_fan_ratio_30"],
                account["fans"],
            ),
            reverse=True,
        )[:20]
        result = {
            "criteria": criteria,
            "same_level_accounts": same,
            "high_level_accounts": high,
            "kol_candidates": kol_candidates,
            "summary": {
                "same_level_count": len(same),
                "high_level_count": len(high),
                "kol_candidate_count": len(kol_candidates),
                "same_level_avg_fans": self._average(same, "fans"),
                "same_level_avg_interactive_30": self._average(
                    same,
                    "interactive_30",
                ),
                "high_level_avg_fans": self._average(high, "fans"),
                "high_level_avg_interactive_30": self._average(
                    high,
                    "interactive_30",
                ),
            },
            "data_updated_at": min(
                (
                    account["data_updated_at"]
                    for account in same + high
                    if account["data_updated_at"]
                ),
                default="入库时刻",
            ),
            "data_notice": DATA_NOTICE,
            "subscription_offer": {
                "available": False,
                "message": "第一版暂不提供每日自动订阅，可保存当前 HTML 报告后按需重新查询。",
            },
            "queried_at": datetime.now(timezone.utc).isoformat(),
        }
        report_id = str(uuid4())
        self._write_report(report_id, result)
        return {
            **result,
            "report_id": report_id,
            "report_url": f"/api/v1/account-benchmarks/reports/{report_id}",
        }

    def read_report(self, report_id: UUID) -> str:
        path = self.reports_dir / f"account-{report_id}.html"
        if not path.is_file():
            raise NotFoundError("account benchmark report", str(report_id))
        return path.read_text(encoding="utf-8")

    @staticmethod
    def _average(accounts: list[dict[str, Any]], field: str) -> int:
        if not accounts:
            return 0
        return round(sum(_number(account.get(field)) for account in accounts) / len(accounts))

    def _fetch(self, payload: dict[str, Any]) -> dict[str, Any]:
        cache_key = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self._external_lock:
            now = time.monotonic()
            cached = self._cache.get(cache_key)
            if cached and cached[0] > now:
                return deepcopy(cached[1])
            self._cache = {
                key: value
                for key, value in self._cache.items()
                if value[0] > now
            }
            while self._request_times and self._request_times[0] <= now - 60:
                self._request_times.popleft()
            if len(self._request_times) >= 10:
                raise AppError(
                    title="数据接口限流",
                    status=429,
                    detail="账号对标查询过于频繁，请一分钟后再试。",
                    code="data-rate-limit",
                )
            self._request_times.append(now)
            data = self.client.query(payload)
            if len(self._cache) >= 256:
                oldest_key = min(
                    self._cache,
                    key=lambda key: self._cache[key][0],
                )
                self._cache.pop(oldest_key, None)
            self._cache[cache_key] = (now + 300, deepcopy(data))
            return data

    def _write_report(self, report_id: str, result: dict[str, Any]) -> None:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup_reports()

        def section(title: str, accounts: list[dict[str, Any]]) -> str:
            rows = []
            for account in accounts:
                link = (
                    f'<a href="{escape(account["profile_url"], quote=True)}" '
                    'target="_blank" rel="noopener noreferrer">'
                    f'{escape(account["nickname"])}</a>'
                    if account["profile_url"]
                    else escape(account["nickname"])
                )
                rows.append(
                    "<tr>"
                    f"<td>{link}</td>"
                    f"<td>{escape(account['level'] or '--')}</td>"
                    f"<td>{account['fans']:,}</td>"
                    f"<td>{account['interactive_30']:,}</td>"
                    f"<td>{account['notes_7']} 篇 / {account['interactive_7']:,} 互动</td>"
                    f"<td>{account['interaction_fan_ratio_30'] / 100:.2f} 倍</td>"
                    f"<td>{escape(account['content_analysis'])}<br>"
                    f"<small>{escape(account['recommendation_reason'])}</small></td>"
                    "</tr>",
                )
            body = "".join(rows) or '<tr><td colspan="7">暂无匹配账号</td></tr>'
            return (
                f"<section><h2>{escape(title)}</h2><div class=\"table-wrap\"><table>"
                "<thead><tr><th>账号</th><th>等级</th><th>粉丝</th>"
                "<th>近30天互动</th><th>近7天活跃</th>"
                "<th>30天互动/粉丝</th><th>内容分析与推荐理由</th>"
                f"</tr></thead><tbody>{body}</tbody></table></div></section>"
            )

        criteria_data = result["criteria"]
        criteria = (
            f"账号 ID：{criteria_data.get('red_id')}"
            if criteria_data["query_mode"] == "red_id"
            else " · ".join(
                item
                for item in (
                    f"赛道：{criteria_data.get('track') or '综合全部'}",
                    (
                        f"粉丝：{criteria_data.get('min_fans') or 0:,}"
                        f"–{criteria_data.get('max_fans'):,}"
                        if criteria_data.get("max_fans") is not None
                        else (
                            f"粉丝：≥{criteria_data.get('min_fans'):,}"
                            if criteria_data.get("min_fans") is not None
                            else ""
                        )
                    ),
                    (
                        f"等级：{criteria_data.get('level')}"
                        if criteria_data.get("level") else ""
                    ),
                )
                if item
            )
        )
        summary = result["summary"]
        html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小红书账号对标报告</title>
<style>
body{{margin:0;background:#f4f0ea;color:#262320;font:15px/1.6 system-ui,sans-serif}}
main{{max-width:1180px;margin:auto;padding:48px 24px}}h1{{font-size:42px;margin:.2em 0}}
.notice{{background:#fff;padding:18px;border-left:4px solid #d83b34}}
section{{margin-top:32px}}.table-wrap{{overflow:auto;background:#fff;border:1px solid #e6dfd5;border-radius:12px}}
table{{width:100%;border-collapse:collapse;min-width:880px}}th,td{{padding:13px 15px;text-align:left;border-bottom:1px solid #eee7de}}
th{{background:#faf6f1}}a{{color:#b42f29}}
</style></head><body><main><small>OPEN SWARM / ACCOUNT BENCHMARK</small>
<h1>小红书账号对标报告</h1>
<p>查询条件：{escape(criteria)} · 数据时间：{escape(result["data_updated_at"])}</p>
<div class="notice">{escape(result["data_notice"])}</div>
<p><strong>结果摘要：</strong>同阶 {summary["same_level_count"]} 个
（平均粉丝 {summary["same_level_avg_fans"]:,}，平均30天互动 {summary["same_level_avg_interactive_30"]:,}）；
高阶 {summary["high_level_count"]} 个
（平均粉丝 {summary["high_level_avg_fans"]:,}，平均30天互动 {summary["high_level_avg_interactive_30"]:,}）；
投放候选 {summary["kol_candidate_count"]} 个。</p>
{section("可直接复制的同阶对标", result["same_level_accounts"])}
{section("可追赶的高阶标杆", result["high_level_accounts"])}
{section("KOL 投放候选数据初筛", result["kol_candidates"])}
</main></body></html>"""
        path = self.reports_dir / f"account-{report_id}.html"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(path)
        write_report_data(
            self.reports_dir,
            f"account-{report_id}",
            "account",
            "小红书账号对标报告",
            result,
        )

    def _cleanup_reports(self) -> None:
        reports = sorted(
            self.reports_dir.glob("account-*.html"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        cutoff = time.time() - 7 * 24 * 60 * 60
        for index, path in enumerate(reports):
            if index >= 199 or path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
