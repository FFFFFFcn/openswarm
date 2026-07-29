"""REST boundary for Xiaohongshu insights."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.insights.models import KeywordGuideRequest, InsightSearchRequest
from app.insights.service import DATA_NOTICE, InsightService


def create_insights_router(service: InsightService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/insights", tags=["insights"])

    @router.get("/status")
    def status() -> dict:
        return {
            "data": {
                "provider": "redfox",
                "configured": service.configured,
                "data_notice": DATA_NOTICE,
            },
        }

    @router.post("/keyword-guide")
    def keyword_guide(payload: KeywordGuideRequest) -> dict:
        return {"data": service.guide_keyword(payload.keyword)}

    @router.post("/search")
    def search(payload: InsightSearchRequest) -> dict:
        return {"data": service.search(payload)}

    @router.get("/reports/{report_id}", response_class=HTMLResponse)
    def report(report_id: UUID) -> HTMLResponse:
        return HTMLResponse(
            service.read_report(report_id),
            headers={
                "Content-Security-Policy": (
                    "default-src 'none'; style-src 'unsafe-inline'; "
                    "img-src https:; base-uri 'none'; frame-ancestors 'self'"
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )

    return router
