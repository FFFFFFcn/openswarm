"""REST boundary for editorial resources."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response, status

from app.agent_team.credential_vault import CredentialVault
from app.core.errors import NotFoundError
from app.operations.models import (
    AccountExtractRequest,
    AccountProfileUpsert,
    ComplianceRequest,
    DraftCreate,
    DraftUpdate,
    StrategyCreate,
    StrategyUpdate,
    TopicCreate,
    TopicUpdate,
)
from app.operations.repository import OperationsRepository
from app.operations.service import OperationsService
from app.operations.vision import ExtractionError, extract_account_profile


def get_user_id(
    x_user_id: Annotated[str | None, Header(alias="X-User-ID")] = None,
) -> str:
    return x_user_id or "local-user"


def create_operations_router(
    repository: OperationsRepository,
    service: OperationsService,
    credential_vault: CredentialVault | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["operations"])

    @router.get("/dashboard")
    def dashboard(
        account_id: str | None = Query(default=None),
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        return {"data": repository.dashboard(user_id, account_id=account_id)}

    @router.get("/account-profiles")
    def list_accounts(user_id: str = Depends(get_user_id)) -> dict[str, Any]:
        return {"data": repository.list_accounts(user_id)}

    @router.post("/account-profiles", status_code=status.HTTP_201_CREATED)
    def create_account(
        payload: AccountProfileUpsert,
        response: Response,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.create_account(user_id, payload.model_dump())
        response.headers["Location"] = f"/api/v1/account-profiles/{data['id']}"
        return {"data": data}

    @router.put("/account-profiles/{account_id}")
    def update_account(
        account_id: str,
        payload: AccountProfileUpsert,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.update_account(user_id, account_id, payload.model_dump())
        if not data:
            raise NotFoundError("account", account_id)
        return {"data": data}

    @router.delete(
        "/account-profiles/{account_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_account(
        account_id: str,
        user_id: str = Depends(get_user_id),
    ) -> None:
        if not repository.delete_account(user_id, account_id):
            raise NotFoundError("account", account_id)

    @router.post("/account-profiles/extract")
    def extract_account(payload: AccountExtractRequest) -> dict[str, Any]:
        if credential_vault is None:
            raise ExtractionError("截图识别未启用，请改用手动录入。", status=503)
        record = next(
            (
                item
                for item in credential_vault.load()
                if item.id == payload.credential_id
            ),
            None,
        )
        if record is None or record.data.get("type") != "openai_credential":
            raise ExtractionError(
                "所选凭据不可用或不是 OpenAI 兼容凭据，请在设置中检查后重试。",
                status=409,
            )
        base_url = (record.data.get("base_url") or "").strip() or "https://api.openai.com/v1"
        api_key = record.data.get("api_key") or ""
        fields = extract_account_profile(
            base_url,
            api_key,
            payload.model,
            payload.image_base64,
            payload.mime_type,
        )
        return {"data": fields}

    @router.get("/strategies")
    def list_strategies(
        limit: int = Query(default=20, ge=1, le=100),
        account_id: str | None = Query(default=None),
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.list_strategies(user_id, limit, account_id=account_id)
        return {"data": data, "pagination": {"limit": limit, "count": len(data)}}

    @router.post("/strategies", status_code=status.HTTP_201_CREATED)
    def create_strategy(
        payload: StrategyCreate,
        response: Response,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = service.create_strategy(user_id, payload.model_dump())
        response.headers["Location"] = f"/api/v1/strategies/{data['id']}"
        return {"data": data}

    @router.get("/strategies/{strategy_id}")
    def get_strategy(
        strategy_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.get_strategy(user_id, strategy_id)
        if not data:
            raise NotFoundError("strategy", strategy_id)
        return {"data": data}

    @router.patch("/strategies/{strategy_id}")
    def update_strategy(
        strategy_id: str,
        payload: StrategyUpdate,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        return {"data": service.update_strategy(user_id, strategy_id, payload.model_dump())}

    @router.get("/topics")
    def list_topics(
        topic_status: str | None = Query(default=None, alias="status"),
        limit: int = Query(default=50, ge=1, le=100),
        account_id: str | None = Query(default=None),
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.list_topics(user_id, topic_status, limit, account_id=account_id)
        return {"data": data, "pagination": {"limit": limit, "count": len(data)}}

    @router.post("/topics", status_code=status.HTTP_201_CREATED)
    def create_topic(
        payload: TopicCreate,
        response: Response,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = service.create_topic(user_id, payload.model_dump())
        response.headers["Location"] = f"/api/v1/topics/{data['id']}"
        return {"data": data}

    @router.patch("/topics/{topic_id}")
    def update_topic(
        topic_id: str,
        payload: TopicUpdate,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        changes = payload.model_dump(exclude_none=True)
        return {"data": service.update_topic(user_id, topic_id, changes)}

    @router.get("/drafts")
    def list_drafts(
        draft_status: str | None = Query(default=None, alias="status"),
        limit: int = Query(default=50, ge=1, le=100),
        account_id: str | None = Query(default=None),
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.list_drafts(user_id, draft_status, limit, account_id=account_id)
        return {"data": data, "pagination": {"limit": limit, "count": len(data)}}

    @router.post("/drafts", status_code=status.HTTP_201_CREATED)
    def create_draft(
        payload: DraftCreate,
        response: Response,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = service.create_draft(user_id, payload.model_dump())
        response.headers["Location"] = f"/api/v1/drafts/{data['id']}"
        return {"data": data}

    @router.patch("/drafts/{draft_id}")
    def update_draft(
        draft_id: str,
        payload: DraftUpdate,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        changes = payload.model_dump(exclude_none=True)
        return {"data": service.update_draft(user_id, draft_id, changes)}

    @router.get("/drafts/{draft_id}")
    def get_draft(
        draft_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.get_draft(user_id, draft_id)
        if not data:
            raise NotFoundError("draft", draft_id)
        return {"data": data}

    @router.post("/compliance-check")
    def compliance_check(payload: ComplianceRequest) -> dict[str, Any]:
        return {"data": service.check_compliance(payload.title, payload.body)}

    @router.get("/topics/{topic_id}")
    def get_topic(
        topic_id: str,
        user_id: str = Depends(get_user_id),
    ) -> dict[str, Any]:
        data = repository.get_topic(user_id, topic_id)
        if not data:
            raise NotFoundError("topic", topic_id)
        return {"data": data}

    return router
