"""Title generation/scoring grounded in Xiaohongshu trend samples."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import date, timedelta
from html import escape
import json
import math
from pathlib import Path
import re
import threading
import time
from typing import Any
from urllib.parse import quote, urlparse
from uuid import UUID, uuid4

from app.artifacts.report_data import write_report_data
from app.core.errors import AppError, NotFoundError
from app.insights.service import InsightService
from app.title_insights.client import RedFoxTitleTrendClient
from app.title_insights.models import TitleGenerateRequest, TitleScoreRequest


DATA_NOTICE = (
    "分析依据为外部数据接口收录的小红书趋势样本；结果是基于样本特征的创作辅助，"
    "不代表平台官方评分或流量承诺。"
)
LINK_NOTICE = "参考链接仅用于人工复核原笔记，请遵守平台规则与内容版权要求。"
SOURCE = "小红书标题生成与评分-GitHub"
GROUPS = (
    "lowPowderExplosiveArticle",
    "likeTheTop500",
    "singleDayIncrements",
    "sevenDaysOfIncrements",
)
WEIGHTS = {
    "topic": 0.15,
    "structure": 0.20,
    "benefit": 0.25,
    "emotion": 0.20,
    "scarcity": 0.15,
    "compliance": 0.05,
}
DIMENSION_LABELS = {
    "topic": "选题匹配",
    "structure": "标题结构",
    "benefit": "利益点",
    "emotion": "情绪钩子",
    "scarcity": "稀缺感",
    "compliance": "合规性",
}


def _number(value: Any) -> int:
    text = str(value or 0).strip().lower().replace(",", "").replace("+", "")
    try:
        parsed = float(text[:-1]) * 10_000 if text.endswith("w") else float(text)
        return max(0, min(int(parsed), 1_000_000_000)) if math.isfinite(parsed) else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def _safe_note_url(value: Any, note_id: str) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and (
        host == "xiaohongshu.com" or host.endswith(".xiaohongshu.com")
    ):
        return raw
    return (
        f"https://www.xiaohongshu.com/explore/{quote(note_id, safe='')}"
        if note_id
        else ""
    )


def _normalize_title(value: str) -> str:
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE).casefold()


def _grade(score: float) -> str:
    if score >= 9:
        return "S"
    if score >= 7:
        return "A"
    if score >= 5:
        return "B"
    return "C"


class TitleInsightService:
    def __init__(self, client: RedFoxTitleTrendClient, reports_dir: Path) -> None:
        self.client = client
        self.reports_dir = reports_dir
        self._external_lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._request_times: deque[float] = deque()

    @property
    def configured(self) -> bool:
        return self.client.configured

    def generate(self, request: TitleGenerateRequest) -> dict[str, Any]:
        self._ensure_keyword(request.keyword, request.broad_keyword_confirmed)
        if len(request.keyword) > 12:
            raise AppError(
                title="Keyword too long for Xiaohongshu titles",
                status=422,
                detail="为保留完整产品形态且让标题不超过20字，请把核心关键词缩短到12字以内。",
                code="title-keyword-too-long",
            )
        samples, counts = self._samples(request.keyword, 7)
        window_days = 7
        if len(samples) < 5:
            samples, counts = self._samples(request.keyword, 30)
            window_days = 30
        self._require_samples(request.keyword, samples)
        stats = self._sample_stats(samples, request.keyword)
        references = [self._reference(item) for item in samples[:5]]
        patterns = self._patterns(samples)
        candidates = self._generate_candidates(request.keyword, stats)
        titles = []
        score_counts: dict[float, int] = {}
        for index, title in enumerate(candidates):
            related = references[index % len(references):][:2] if references else []
            if not related and references:
                related = references[:2]
            title_features = self._title_features(title)
            sample_signal = patterns[index % len(patterns)] if patterns else "趋势样本标题结构"
            match_score = self._match_score(
                title,
                request.keyword,
                stats,
                index,
            )
            available_scores = [
                round(8 + step * .1, 1)
                for step in range(21)
                if score_counts.get(round(8 + step * .1, 1), 0) < 2
            ]
            match_score = min(
                available_scores,
                key=lambda value: (abs(value - match_score), -value),
            )
            score_counts[match_score] = score_counts.get(match_score, 0) + 1
            titles.append(
                {
                    "rank": index + 1,
                    "title": title,
                    "match_score": match_score,
                    "reason": (
                        f"候选采用{'、'.join(title_features)}，并把「{request.keyword}」放入主要信息位；"
                        f"同时参考了样本信号“{sample_signal}”。匹配指数用于候选排序，"
                        "不代表平台官方流量预测。"
                    ),
                    "references": related,
                },
            )
        result: dict[str, Any] = {
            "mode": "generate",
            "keyword": request.keyword,
            "window_days": window_days,
            "sample_count": len(samples),
            "category_counts": counts,
            "patterns": patterns,
            "sample_warning": (
                "近30天去重样本少于5条，匹配指数仅作低样本参考。"
                if len(samples) < 5
                else ""
            ),
            "titles": titles,
            "data_notice": DATA_NOTICE,
            "link_notice": LINK_NOTICE,
        }
        self._finish_report(result)
        return result

    def score(self, request: TitleScoreRequest) -> dict[str, Any]:
        self._ensure_keyword(request.keyword, request.broad_keyword_confirmed)
        samples, counts = self._samples(request.keyword, 30)
        self._require_samples(request.keyword, samples)
        stats = self._sample_stats(samples, request.keyword)
        exact = next(
            (
                item for item in samples
                if _normalize_title(item["title"]) == _normalize_title(request.title)
            ),
            None,
        )
        dimensions = self._dimension_scores(
            request.title,
            request.keyword,
            bool(exact),
            stats,
        )
        total = round(
            sum(dimensions[key] * weight for key, weight in WEIGHTS.items()),
            1,
        )
        issues = self._issues(request.title, request.keyword, dimensions, bool(exact))
        references = [self._reference(exact)] if exact else []
        references.extend(
            self._reference(item)
            for item in samples
            if not exact or item["note_id"] != exact["note_id"]
        )
        references = references[:5]
        rewrites = self._rewrites(request.title, request.keyword)
        result: dict[str, Any] = {
            "mode": "score",
            "title": request.title,
            "keyword": request.keyword,
            "score": total,
            "grade": _grade(total),
            "exact_sample_match": bool(exact),
            "dimensions": [
                {
                    "key": key,
                    "label": DIMENSION_LABELS[key],
                    "weight": int(weight * 100),
                    "score": dimensions[key],
                    "weighted_score": round(dimensions[key] * weight, 2),
                }
                for key, weight in WEIGHTS.items()
            ],
            "issues": issues,
            "rewrites": rewrites,
            "highlights": [
                f"{DIMENSION_LABELS[key]} {dimensions[key]:g}/10"
                for key in WEIGHTS
                if dimensions[key] >= 8
            ],
            "references": references,
            "window_days": 30,
            "sample_count": len(samples),
            "category_counts": counts,
            "sample_warning": (
                "近30天去重样本少于5条，评分仅作低样本参考。"
                if len(samples) < 5
                else ""
            ),
            "data_notice": DATA_NOTICE,
            "link_notice": LINK_NOTICE,
        }
        self._finish_report(result)
        return result

    def read_report(self, report_id: UUID) -> str:
        path = self.reports_dir / f"title-{report_id}.html"
        if not path.is_file():
            raise NotFoundError("title insight report", str(report_id))
        return path.read_text(encoding="utf-8")

    @staticmethod
    def _ensure_keyword(keyword: str, confirmed: bool) -> None:
        guide = InsightService.guide_keyword(keyword)
        if guide["is_broad"] and not confirmed:
            raise AppError(
                title="Keyword confirmation required",
                status=409,
                detail=f"「{keyword}」范围较大，请先选择细分方向或确认继续分析原词。",
                code="broad-keyword-confirmation-required",
                errors=[{"field": "keyword", "suggestions": guide["suggestions"]}],
            )

    def _samples(
        self,
        keyword: str,
        days: int,
    ) -> tuple[list[dict[str, Any]], dict[str, int]]:
        start_date = (date.today() - timedelta(days=days)).isoformat()
        data = self._fetch(keyword, start_date)
        counts: dict[str, int] = {}
        merged: dict[str, dict[str, Any]] = {}
        if not any(group in data for group in GROUPS):
            raise AppError(
                title="数据接口响应异常",
                status=502,
                detail="标题趋势响应缺少四类数据字段。",
                code="data-response-invalid",
            )
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
                item = self._sample(raw)
                key = item["note_id"] or _normalize_title(item["title"])
                if key and item["title"] and key not in merged:
                    merged[key] = item
        samples = list(merged.values())
        samples.sort(key=lambda item: item["interaction_count"], reverse=True)
        return samples, counts

    @staticmethod
    def _sample(raw: dict[str, Any]) -> dict[str, Any]:
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
        url = (
            raw.get("url")
            or raw.get("shareInfoLink")
            or raw.get("noteUrl")
            or raw.get("link")
        )
        interaction = max(
            _number(raw.get("interactiveCount")),
            _number(raw.get("interactionCount")),
            _number((raw.get("anaAdd") or {}).get("addInteractiveount"))
            if isinstance(raw.get("anaAdd"), dict)
            else 0,
            _number(raw.get("likes"))
            + _number(raw.get("collects"))
            + _number(raw.get("shares"))
            + _number(raw.get("comments")),
            _number(raw.get("likedCount"))
            + _number(raw.get("collectedCount"))
            + _number(raw.get("sharedCount"))
            + _number(raw.get("commentsCount")),
            _number(raw.get("useLikeCount"))
            + _number(raw.get("collectedCount"))
            + _number(raw.get("useShareCount"))
            + _number(raw.get("useCommentCount")),
        )
        return {
            "note_id": note_id,
            "title": title,
            "url": _safe_note_url(url, note_id),
            "author": str(
                raw.get("nickname")
                or raw.get("authorNickname")
                or raw.get("userName")
                or "未知作者"
            )[:100],
            "interaction_count": interaction,
        }

    @staticmethod
    def _reference(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "note_id": item["note_id"],
            "title": item["title"],
            "url": item["url"],
            "author": item["author"],
            "interaction_count": item["interaction_count"],
        }

    @staticmethod
    def _patterns(samples: list[dict[str, Any]]) -> list[str]:
        titles = [item["title"] for item in samples if item["title"]]
        if not titles:
            return []
        checks = (
            ("数字钩子", r"\d"),
            ("问句制造好奇", r"[？?]"),
            ("感叹强化情绪", r"[！!]"),
            ("清单/教程结构", r"清单|教程|攻略|步骤|方法"),
            ("避坑/反差表达", r"避坑|别|不要|竟然|原来"),
        )
        found = []
        for label, pattern in checks:
            count = sum(bool(re.search(pattern, title)) for title in titles)
            if count:
                found.append(f"{label}（{count}/{len(titles)} 条）")
        average = sum(len(title) for title in titles) / len(titles)
        found.append(f"样本平均标题长度 {average:.1f} 字")
        return found

    @staticmethod
    def _require_samples(keyword: str, samples: list[dict[str, Any]]) -> None:
        if samples:
            return
        suggestions = [
            f"{keyword}教程",
            f"{keyword}避坑",
            f"{keyword}清单",
            f"{keyword}测评",
            f"{keyword}入门",
        ]
        raise AppError(
            title="No title trend samples found",
            status=409,
            detail=f"近30天没有找到「{keyword}」的标题趋势样本，无法进行数据驱动分析。",
            code="title-samples-not-found",
            errors=[{"field": "keyword", "suggestions": suggestions}],
        )

    @staticmethod
    def _sample_stats(
        samples: list[dict[str, Any]],
        keyword: str,
    ) -> dict[str, Any]:
        titles = [item["title"] for item in samples]
        total = len(titles)
        patterns = {
            "digit": r"\d",
            "question": r"[？?]",
            "list": r"清单|教程|攻略|步骤|方法|判断|这\d点",
            "benefit": r"方法|清单|教程|攻略|效果|提升|省|选择|入门",
            "emotion": r"避坑|避雷|别|不要|真实|惊|后悔|无效|坑",
            "scarcity": r"私藏|冷门|少有人|内行|独家|第一次|重点|拆解",
        }
        rates = {
            key: sum(bool(re.search(pattern, title)) for title in titles) / total
            for key, pattern in patterns.items()
        }
        keyword_match_rate = (
            sum(keyword.casefold() in title.casefold() for title in titles) / total
        )
        return {
            "total": total,
            "rates": rates,
            "keyword_match_rate": keyword_match_rate,
            "average_length": sum(len(title) for title in titles) / total,
        }

    @staticmethod
    def _generate_candidates(
        keyword: str,
        stats: dict[str, Any],
    ) -> list[str]:
        topic = keyword.strip()
        templates = [
            f"{topic}｜怎么选？",
            f"{topic}｜新手3个坑",
            f"{topic}｜入门5个判断",
            f"{topic}｜低预算选择法",
            f"{topic}｜常见无效原因",
            f"{topic}｜先理清3件事",
            f"{topic}｜选择逻辑拆解",
            f"{topic}｜清单少走弯路",
            f"{topic}｜第一次了解先看5点",
            f"{topic}｜避雷重点看这里",
        ]
        candidates = list(dict.fromkeys(value for value in templates if len(value) <= 20))
        if len(candidates) != 10:
            raise AppError(
                title="Keyword too long for Xiaohongshu titles",
                status=422,
                detail="核心关键词过长，无法在保留完整产品形态的同时生成10个20字内标题。",
                code="title-keyword-too-long",
            )
        return sorted(
            candidates,
            key=lambda value: TitleInsightService._trend_alignment(value, stats),
            reverse=True,
        )

    @staticmethod
    def _trend_alignment(title: str, stats: dict[str, Any]) -> float:
        features = {
            "digit": bool(re.search(r"\d", title)),
            "question": bool(re.search(r"[？?]", title)),
            "list": bool(re.search(r"清单|判断|这\d点|件事", title)),
            "benefit": bool(re.search(r"方法|清单|选择|少走弯路|原因", title)),
            "emotion": bool(re.search(r"避坑|避雷|无效|坑", title)),
            "scarcity": bool(re.search(r"第一次|重点|拆解", title)),
        }
        return sum(
            stats["rates"].get(key, 0) if active else (1 - stats["rates"].get(key, 0)) * .15
            for key, active in features.items()
        )

    @staticmethod
    def _match_score(
        title: str,
        keyword: str,
        stats: dict[str, Any],
        rank_index: int,
    ) -> float:
        alignment = TitleInsightService._trend_alignment(title, stats)
        normalized = alignment / max(len(stats["rates"]), 1)
        score = 8 + min(1.8, normalized * 2) - rank_index * .03
        return round(max(8, min(score, 10)), 1)

    @staticmethod
    def _title_features(title: str) -> list[str]:
        features = []
        checks = (
            ("数字化信息", r"\d"),
            ("问句钩子", r"[？?]"),
            ("感叹强调", r"[！!]"),
            ("清单结构", r"清单|这\d点"),
            ("避坑表达", r"避坑|踩|别|不出错|避雷"),
            ("体验视角", r"实测|用了|第一次"),
            ("稀缺视角", r"内行|只留下|关键"),
        )
        for label, pattern in checks:
            if re.search(pattern, title):
                features.append(label)
        return features[:3] or ["明确利益点"]

    @staticmethod
    def _dimension_scores(
        title: str,
        keyword: str,
        exact: bool,
        stats: dict[str, Any],
    ) -> dict[str, float]:
        if exact:
            return {
                "topic": 10,
                "structure": 10,
                "benefit": 9.5,
                "emotion": 9.5,
                "scarcity": 9,
                "compliance": 10,
            }
        overlap = len(set(keyword.casefold()) & set(title.casefold())) / max(
            len(set(keyword.casefold())),
            1,
        )
        topic = 9 if keyword.casefold() in title.casefold() else (6 if overlap >= .5 else 3)
        structure = min(10, 4 + (2 if len(title) <= 20 else 0) + (2 if re.search(r"\d", title) else 0) + (2 if re.search(r"[？?！!：:｜]", title) else 0))
        benefit = min(10, 4 + (2 if re.search(r"\d|天|分钟", title) else 0) + (2 if re.search(r"方法|清单|教程|攻略|效果|提升|省", title) else 0) + (2 if re.search(r"怎么|如何|这样", title) else 0))
        emotion = min(10, 4 + (3 if re.search(r"避坑|别|不要|真实|惊|后悔|绝", title) else 0) + (2 if re.search(r"[？?！!]", title) else 0))
        scarcity = min(10, 3 + (4 if re.search(r"私藏|冷门|少有人|内行|独家|第一次|只留下", title) else 0) + (2 if re.search(r"关键|秘密|真相", title) else 0))
        risky = re.search(r"根治|100%|百分百|绝对有效|稳赚|包治|国家级|第一名", title)
        compliance = 2 if risky else 10
        rates = stats["rates"]
        title_flags = {
            "digit": bool(re.search(r"\d", title)),
            "question": bool(re.search(r"[？?]", title)),
            "list": bool(re.search(r"清单|攻略|步骤|方法|判断|这\d点", title)),
            "benefit": bool(re.search(r"方法|清单|教程|攻略|效果|提升|省|选择", title)),
            "emotion": bool(re.search(r"避坑|避雷|别|不要|真实|惊|后悔|无效|坑", title)),
            "scarcity": bool(re.search(r"私藏|冷门|少有人|内行|独家|第一次|重点|拆解", title)),
        }
        structure_alignment = sum(
            rates[key] for key in ("digit", "question", "list") if title_flags[key]
        ) / 3
        structure = min(10, structure + structure_alignment * 2)
        benefit = min(10, benefit + (rates["benefit"] * 2 if title_flags["benefit"] else 0))
        emotion = min(10, emotion + (rates["emotion"] * 2 if title_flags["emotion"] else 0))
        scarcity = min(10, scarcity + (rates["scarcity"] * 2 if title_flags["scarcity"] else 0))
        topic = min(10, topic + min(stats["keyword_match_rate"] * 1.5, 1.5))
        return {
            "topic": float(topic),
            "structure": float(structure),
            "benefit": float(benefit),
            "emotion": float(emotion),
            "scarcity": float(scarcity),
            "compliance": float(compliance),
        }

    @staticmethod
    def _issues(
        title: str,
        keyword: str,
        dimensions: dict[str, float],
        exact: bool,
    ) -> list[str]:
        if exact:
            return ["标题与趋势样本中的真实标题一致；发布前仍需核验内容原创性与版权。"]
        issues = []
        if len(title) > 20:
            issues.append("标题超过 20 字，建议压缩到移动端更易扫读的长度。")
        if keyword.casefold() not in title.casefold():
            issues.append(f"标题没有完整出现核心关键词「{keyword}」，检索意图不够明确。")
        if dimensions["benefit"] < 7:
            issues.append("利益点不够具体，可补充数字、时间成本或读者能获得的结果。")
        if dimensions["emotion"] < 7:
            issues.append("情绪钩子较弱，可增加问题、反差或真实体验，但避免夸张承诺。")
        if dimensions["scarcity"] < 7:
            issues.append("稀缺感不足，可使用实测、内行视角或特定人群限定。")
        if dimensions["compliance"] < 10:
            issues.append("检测到绝对化或效果保证表达，建议改成个人体验并补充适用边界。")
        return issues or ["结构较完整，建议结合正文内容继续人工核验事实与承诺边界。"]

    @staticmethod
    def _rewrites(title: str, keyword: str) -> list[dict[str, str]]:
        topic = keyword
        return [
            {
                "style": "A｜干货清单",
                "title": f"{topic}｜新手先看5点"[:20],
                "scene": "教程、知识科普、收藏型内容",
                "expected_effect": "把读者收益具体化，增强收藏动机。",
            },
            {
                "style": "B｜避坑提醒",
                "title": f"{topic}｜3个坑先避开"[:20],
                "scene": "选购、入门、经验复盘内容",
                "expected_effect": "用风险意识制造停留，但不承诺绝对效果。",
            },
            {
                "style": "C｜逻辑拆解",
                "title": f"{topic}｜选择逻辑拆解"[:20],
                "scene": "测评、对比、方法论内容",
                "expected_effect": "强化专业感，适合承接正文论据。",
            },
        ]

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

    def _finish_report(self, result: dict[str, Any]) -> None:
        report_id = uuid4()
        result["report_id"] = str(report_id)
        result["report_url"] = f"/api/v1/title-insights/reports/{report_id}"
        self._write_report(report_id, result)
        self._cleanup_reports()

    def _write_report(self, report_id: UUID, result: dict[str, Any]) -> None:
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        if result["mode"] == "generate":
            content = "".join(
                f"""<article><b>#{item["rank"]} · 匹配度 {item["match_score"]:.1f}</b>
<h2>{escape(item["title"])}</h2><p>{escape(item["reason"])}</p>
<p>{self._report_references(item["references"])}</p></article>"""
                for item in result["titles"]
            )
            heading = f"「{escape(result['keyword'])}」标题候选"
            summary = f"{result['sample_count']} 条去重样本 · 近 {result['window_days']} 天"
        else:
            dimensions = "".join(
                f"<li>{escape(item['label'])}：{item['score']:g}/10（权重 {item['weight']}%，"
                f"加权 {item['weighted_score']:g}）</li>"
                for item in result["dimensions"]
            )
            rewrites = "".join(
                f"<article><b>{escape(item['style'])}</b><h2>{escape(item['title'])}</h2>"
                f"<p>{escape(item['scene'])}<br>{escape(item['expected_effect'])}</p></article>"
                for item in result["rewrites"]
            )
            content = (
                f"<div class='score'>{result['score']:.1f}<small>{escape(result['grade'])} 级</small></div>"
                f"<ul>{dimensions}</ul><h2>优化方向</h2><ul>"
                + "".join(f"<li>{escape(item)}</li>" for item in result["issues"])
                + f"</ul><h2>样本参考</h2><p>{self._report_references(result['references'])}</p>"
                + f"<h2>改写建议</h2>{rewrites}"
            )
            heading = escape(result["title"])
            summary = f"关键词：{escape(result['keyword'])} · {result['sample_count']} 条去重样本"
        html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{heading}</title>
<style>body{{margin:0;background:#f4f0ea;color:#262320;font:15px/1.7 system-ui,sans-serif}}
main{{max-width:980px;margin:auto;padding:48px 24px}}h1{{font-size:40px;line-height:1.2}}
.notice,article,ul{{background:#fff;border:1px solid #e6dfd5;border-radius:12px;padding:18px;margin:14px 0}}
.score{{font-size:72px;font-weight:800;color:#d83b34}}.score small{{font-size:18px;margin-left:10px}}</style>
</head><body><main><small>OPEN SWARM / TITLE INSIGHT</small><h1>{heading}</h1>
<p>{summary}</p><div class="notice">{escape(DATA_NOTICE)}<br>{escape(LINK_NOTICE)}
{f'<br><strong>{escape(result["sample_warning"])}</strong>' if result.get("sample_warning") else ''}</div>{content}
</main></body></html>"""
        path = self.reports_dir / f"title-{report_id}.html"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(path)
        write_report_data(
            self.reports_dir,
            f"title-{report_id}",
            "title",
            result.get("title") or f"「{result['keyword']}」标题候选",
            result,
        )

    @staticmethod
    def _report_references(references: list[dict[str, Any]]) -> str:
        links = []
        for item in references:
            label = (
                f"{escape(item['title'])}｜{escape(item['author'])}｜"
                f"互动 {item['interaction_count']:,}"
            )
            if item["url"]:
                links.append(
                    f'<a href="{escape(item["url"], quote=True)}" target="_blank" '
                    f'rel="noopener noreferrer">{label}</a>',
                )
            else:
                links.append(label)
        return " · ".join(links) or "当前样本未返回可复核链接"

    def _cleanup_reports(self) -> None:
        reports = sorted(
            self.reports_dir.glob("title-*.html"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        cutoff = time.time() - 7 * 24 * 60 * 60
        for index, path in enumerate(reports):
            if index >= 200 or path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
