"""Editorial workflow rules independent from HTTP and AgentScope."""
from __future__ import annotations

import re
from typing import Any

from app.core.errors import ConflictError, NotFoundError
from app.operations.repository import OperationsRepository


TOPIC_TRANSITIONS = {
    "idea": {"approved", "rejected"},
    "approved": {"idea", "drafting", "rejected"},
    "rejected": {"idea"},
    "drafting": {"approved", "ready"},
    "ready": {"drafting"},
}

DRAFT_TRANSITIONS = {
    "draft": {"review"},
    "review": {"draft", "approved"},
    "approved": {"review", "published"},
    "published": set(),
}

STRATEGY_TRANSITIONS = {
    "draft": {"approved", "archived"},
    "approved": {"draft", "archived"},
    "archived": set(),
}

HIGH_RISK_TERMS = {
    "绝对化表达": ["最好", "最佳", "第一", "唯一", "顶级", "天花板", "无敌"],
    "效果保证": ["100%", "永久", "立竿见影", "包治", "根治", "无效退款"],
    "抢购施压": ["再不抢就没了", "最后一波", "错过就没机会", "全网最低"],
    "虚假权威": ["央视推荐", "国家认证", "专家一致推荐", "全球公认"],
}


class OperationsService:
    def __init__(self, repository: OperationsRepository) -> None:
        self.repository = repository

    def require_account(
        self,
        user_id: str,
        account_id: str | None,
    ) -> dict[str, Any]:
        if not account_id:
            raise ConflictError(
                "No account selected. Pick an account above the composer "
                "or add one to the account library first.",
            )
        account = self.repository.get_account_by_id(user_id, account_id)
        if not account:
            raise NotFoundError("account", account_id)
        return account

    def create_strategy(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        account = self.require_account(user_id, data.get("account_id"))
        data = {**data, "status": "draft"}
        return self.repository.create_strategy(user_id, account["id"], data)

    def update_strategy(
        self,
        user_id: str,
        strategy_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        current = self.repository.get_strategy(user_id, strategy_id)
        if not current:
            raise NotFoundError("strategy", strategy_id)
        new_status = changes.get("status")
        if new_status != current["status"] and new_status not in STRATEGY_TRANSITIONS[current["status"]]:
            raise ConflictError(
                f"Strategy cannot move from {current['status']} to {new_status}.",
            )
        updated = self.repository.update_strategy(
            user_id,
            strategy_id,
            changes,
            current["status"],
        )
        if not updated:
            raise ConflictError("Strategy changed concurrently; refresh and try again.")
        return updated

    def create_topic(
        self,
        user_id: str,
        data: dict[str, Any],
        actor: str = "user",
    ) -> dict[str, Any]:
        account = self.require_account(user_id, data.get("account_id"))
        data = {**data, "status": "idea"}
        return self.repository.create_topic(user_id, account["id"], data, actor)

    def update_topic(
        self,
        user_id: str,
        topic_id: str,
        changes: dict[str, Any],
        actor: str = "user",
    ) -> dict[str, Any]:
        current = self.repository.get_topic(user_id, topic_id)
        if not current:
            raise NotFoundError("topic", topic_id)
        new_status = changes.get("status")
        if new_status and new_status != current["status"]:
            if new_status not in TOPIC_TRANSITIONS[current["status"]]:
                raise ConflictError(
                    f"Topic cannot move from {current['status']} to {new_status}.",
                )
        updated = self.repository.update_topic(
            user_id,
            topic_id,
            changes,
            actor,
            expected_status=current["status"],
        )
        if not updated:
            raise ConflictError("Topic changed concurrently; refresh and try again.")
        return updated

    def create_draft(
        self,
        user_id: str,
        data: dict[str, Any],
        actor: str = "user",
    ) -> dict[str, Any]:
        account = self.require_account(user_id, data.get("account_id"))
        topic = self.repository.get_topic(user_id, data["topic_id"])
        if not topic:
            raise NotFoundError("topic", data["topic_id"])
        if topic["account_id"] != account["id"]:
            raise ConflictError("Topic belongs to a different account.")
        if topic["status"] not in {"approved", "drafting"}:
            raise ConflictError("Only an approved topic can enter content production.")
        compliance = self.check_compliance(data["title"], data["body"])
        data = dict(data)
        data["status"] = "draft"
        data["compliance_notes"] = list(
            dict.fromkeys([*data["compliance_notes"], *compliance["warnings"]]),
        )
        draft = self.repository.create_draft(
            user_id,
            account["id"],
            data,
            actor,
            expected_topic_status=topic["status"],
        )
        if not draft:
            raise ConflictError("Topic changed concurrently; refresh and try again.")
        return draft

    def update_draft(
        self,
        user_id: str,
        draft_id: str,
        changes: dict[str, Any],
        actor: str = "user",
    ) -> dict[str, Any]:
        current = self.repository.get_draft(user_id, draft_id)
        if not current:
            raise NotFoundError("draft", draft_id)
        new_status = changes.get("status")
        if new_status and new_status != current["status"]:
            if new_status not in DRAFT_TRANSITIONS[current["status"]]:
                raise ConflictError(
                    f"Draft cannot move from {current['status']} to {new_status}.",
                )
        if "title" in changes or "body" in changes:
            compliance = self.check_compliance(
                changes.get("title", current["title"]),
                changes.get("body", current["body"]),
            )
            changes = {**changes, "compliance_notes": compliance["warnings"]}
        updated = self.repository.update_draft(
            user_id,
            draft_id,
            changes,
            actor,
            expected_status=current["status"],
        )
        if not updated:
            raise ConflictError("Draft changed concurrently; refresh and try again.")
        return updated

    @staticmethod
    def check_compliance(title: str, body: str) -> dict[str, Any]:
        content = f"{title}\n{body}"
        hits: list[dict[str, str]] = []
        for category, terms in HIGH_RISK_TERMS.items():
            for term in terms:
                if term.lower() in content.lower():
                    hits.append({"category": category, "term": term})
        warnings = [
            f"检测到{item['category']}：{item['term']}。请改为可验证、有限定条件的表述。"
            for item in hits
        ]
        if title and len(re.sub(r"\s", "", title)) > 20:
            warnings.append("标题超过编辑部建议的 20 字目标，请检查移动端展示与信息密度。")
        manual_checks = [
            "确认标题、封面与正文表达一致，不用无关热点诱导点击。",
            "确认人物经历、测试结果和引用来源真实，不虚构人设或权威背书。",
            "确认图片为原创或已获授权，且不带其他平台水印。",
            "商业合作、医疗健康、美妆功效等内容需按最新平台规则人工复核。",
        ]
        return {
            "risk_level": "high" if hits else "review",
            "hits": hits,
            "warnings": warnings,
            "manual_checks": manual_checks,
        }
