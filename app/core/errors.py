"""Typed application errors and RFC 9457-compatible handlers."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


@dataclass(slots=True)
class AppError(Exception):
    title: str
    status: int
    detail: str
    code: str
    errors: list[dict[str, Any]] | None = None


class NotFoundError(AppError):
    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__(
            title="Resource not found",
            status=404,
            detail=f"{resource} '{resource_id}' does not exist.",
            code="not-found",
        )


class ConflictError(AppError):
    def __init__(self, detail: str) -> None:
        super().__init__("State conflict", 409, detail, "state-conflict")


def _problem(request: Request, exc: AppError) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": f"urn:openswarm:error:{exc.code}",
        "title": exc.title,
        "status": exc.status,
        "detail": exc.detail,
        "instance": request.url.path,
        "request_id": getattr(request.state, "request_id", "unknown"),
    }
    if exc.errors:
        body["errors"] = exc.errors
    return body


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=_problem(request, exc),
            media_type="application/problem+json",
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        errors = [
            {
                "field": ".".join(str(part) for part in item["loc"]),
                "message": item["msg"],
                "code": item["type"],
            }
            for item in exc.errors()
        ]
        app_error = AppError(
            title="Validation failed",
            status=422,
            detail="One or more request fields are invalid.",
            code="validation-failed",
            errors=errors,
        )
        return JSONResponse(
            status_code=422,
            content=_problem(request, app_error),
            media_type="application/problem+json",
        )
