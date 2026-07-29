"""REST routes for Xiaohongshu title analysis."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.title_insights.models import TitleGenerateRequest, TitleScoreRequest
from app.title_insights.service import DATA_NOTICE, TitleInsightService


def create_title_insights_router(service: TitleInsightService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/title-insights", tags=["title-insights"])

    @router.get("/status")
    def status() -> dict:
        return {
            "data": {
                "provider": "redfox",
                "configured": service.configured,
                "data_notice": DATA_NOTICE,
            },
        }

    @router.post("/generate")
    def generate(payload: TitleGenerateRequest) -> dict:
        return {"data": service.generate(payload)}

    @router.post("/score")
    def score(payload: TitleScoreRequest) -> dict:
        return {"data": service.score(payload)}

    @router.get("/reports/{report_id}", response_class=HTMLResponse)
    def report(report_id: UUID) -> HTMLResponse:
        return HTMLResponse(
            service.read_report(report_id),
            headers={
                "Content-Security-Policy": (
                    "default-src 'none'; style-src 'unsafe-inline'; "
                    "base-uri 'none'; frame-ancestors 'self'"
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )

    return router
