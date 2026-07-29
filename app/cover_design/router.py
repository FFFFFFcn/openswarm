"""REST boundary for Xiaohongshu cover design."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.cover_design.models import CoverDesignRequest
from app.cover_design.service import DATA_NOTICE, CoverDesignService


def create_cover_design_router(service: CoverDesignService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/cover-design", tags=["cover-design"])

    @router.get("/status")
    def status() -> dict:
        return {
            "data": {
                "provider": "redfox",
                "configured": service.configured,
                "data_notice": DATA_NOTICE,
            },
        }

    @router.post("/search")
    def search(payload: CoverDesignRequest) -> dict:
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
