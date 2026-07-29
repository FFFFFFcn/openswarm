from __future__ import annotations

import pytest

from app.core.errors import ConflictError, NotFoundError


def _draft_payload(topic_id: str, account_id: str) -> dict:
    return {
        "account_id": account_id,
        "topic_id": topic_id,
        "title": "AI 功能拆解方法",
        "cover_text": "别急着写 PRD",
        "body": "先确认问题，再设计最小闭环。",
        "hashtags": ["AI产品经理"],
        "image_prompts": [],
        "compliance_notes": [],
        "status": "draft",
    }


def _strategy_payload(account_id: str, status: str = "draft") -> dict:
    return {
        "account_id": account_id,
        "positioning": "真实项目复盘",
        "persona": "一线产品经理",
        "content_pillars": ["复盘"],
        "posting_rhythm": "每周两篇",
        "growth_plan": "先验证收藏率",
        "status": status,
    }


def test_editorial_workflow_requires_human_topic_approval(
    repository,
    service,
    account_payload,
    topic_payload,
) -> None:
    user_id = "u1"
    account = repository.create_account(user_id, account_payload)
    topic = service.create_topic(user_id, {**topic_payload, "account_id": account["id"]})
    draft = _draft_payload(topic["id"], account["id"])

    with pytest.raises(ConflictError):
        service.create_draft(user_id, draft)

    service.update_topic(user_id, topic["id"], {"status": "approved"})
    saved = service.create_draft(user_id, draft)
    assert saved["status"] == "draft"
    assert repository.get_topic(user_id, topic["id"])["status"] == "drafting"


def test_invalid_status_jump_is_rejected(repository, service, account_payload, topic_payload) -> None:
    account = repository.create_account("u1", account_payload)
    topic = service.create_topic("u1", {**topic_payload, "account_id": account["id"]})
    with pytest.raises(ConflictError):
        service.update_topic("u1", topic["id"], {"status": "ready"})


def test_compliance_check_flags_guarantees_and_keeps_manual_review(service) -> None:
    result = service.check_compliance("全网最好方法", "保证 100% 立竿见影")
    assert result["risk_level"] == "high"
    assert {hit["term"] for hit in result["hits"]} >= {"最好", "100%", "立竿见影"}
    assert any("图片" in item for item in result["manual_checks"])


def test_create_methods_force_initial_review_states(
    repository,
    service,
    account_payload,
    topic_payload,
) -> None:
    account = repository.create_account("u1", account_payload)
    strategy = service.create_strategy("u1", _strategy_payload(account["id"], status="approved"))
    topic = service.create_topic(
        "u1",
        {**topic_payload, "account_id": account["id"], "status": "approved"},
    )
    assert strategy["status"] == "draft"
    assert topic["status"] == "idea"


def test_account_library_holds_multiple_accounts_with_scoped_listing(
    repository,
    service,
    account_payload,
    topic_payload,
) -> None:
    user_id = "u-multi"
    first = repository.create_account(user_id, account_payload)
    second = repository.create_account(
        user_id,
        {**account_payload, "account_name": "第二账号", "niche": "读书笔记"},
    )
    assert {a["id"] for a in repository.list_accounts(user_id)} == {first["id"], second["id"]}

    t1 = service.create_topic(user_id, {**topic_payload, "account_id": first["id"]})
    t2 = service.create_topic(
        user_id,
        {**topic_payload, "account_id": second["id"], "title": "第二账号选题"},
    )

    assert [t["id"] for t in repository.list_topics(user_id, account_id=first["id"])] == [t1["id"]]
    assert [t["id"] for t in repository.list_topics(user_id, account_id=second["id"])] == [t2["id"]]
    assert len(repository.list_topics(user_id)) == 2


def test_delete_account_cascades_to_owned_records(
    repository,
    service,
    account_payload,
    topic_payload,
) -> None:
    user_id = "u-del"
    account = repository.create_account(user_id, account_payload)
    service.create_strategy(user_id, _strategy_payload(account["id"]))
    topic = service.create_topic(user_id, {**topic_payload, "account_id": account["id"]})
    service.update_topic(user_id, topic["id"], {"status": "approved"})
    service.create_draft(user_id, _draft_payload(topic["id"], account["id"]))

    assert repository.delete_account(user_id, account["id"]) is True
    assert repository.get_account_by_id(user_id, account["id"]) is None
    assert repository.list_topics(user_id, account_id=account["id"]) == []
    assert repository.list_drafts(user_id, account_id=account["id"]) == []
    assert repository.list_strategies(user_id, account_id=account["id"]) == []


def test_require_account_rejects_missing_or_unknown_account(service, topic_payload) -> None:
    with pytest.raises(ConflictError):
        service.create_topic("u-x", {**topic_payload})  # no account_id
    with pytest.raises(NotFoundError):
        service.create_topic("u-x", {**topic_payload, "account_id": "does-not-exist"})


def test_create_draft_rejects_topic_from_another_account(
    repository,
    service,
    account_payload,
    topic_payload,
) -> None:
    user_id = "u-cross"
    first = repository.create_account(user_id, account_payload)
    second = repository.create_account(user_id, {**account_payload, "account_name": "账号二"})
    topic = service.create_topic(user_id, {**topic_payload, "account_id": first["id"]})
    service.update_topic(user_id, topic["id"], {"status": "approved"})
    # Draft claims the second account, but the topic belongs to the first.
    with pytest.raises(ConflictError):
        service.create_draft(user_id, _draft_payload(topic["id"], second["id"]))
