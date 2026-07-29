"""REST boundary for Xiaohongshu account benchmarks."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.account_benchmark.models import AccountBenchmarkSearchRequest
from app.account_benchmark.service import AccountBenchmarkService


def create_account_benchmark_router(
    service: AccountBenchmarkService,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/account-benchmarks",
        tags=["account-benchmarks"],
    )

    @router.get("/status")
    def status() -> dict:
        return {
            "data": {
                "provider": "redfox",
                "configured": service.configured,
                **service.options(),
            },
        }

    @router.post("/search")
    def search(payload: AccountBenchmarkSearchRequest) -> dict:
        return {"data": service.search(payload)}

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
