"""REST boundary for listing and serving locally generated report artifacts.

Reports produced by the insight/benchmark/title/cover services are written to
the shared ``reports_dir`` as ``{uuid}.html``.  The agent team UI surfaces them
in a workspace panel via this router: a listing endpoint plus a single-artifact
endpoint that streams the HTML with a restrictive CSP (mirroring the insights
report endpoint).
"""
from __future__ import annotations

import html as html_lib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field


_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_HEAD_CHARS = 8192

_REPORT_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; "
    "img-src https:; base-uri 'none'; frame-ancestors 'self'"
)

# Unified scrollbar CSS injected into every served artifact so that the
# iframe preview matches the Radix ScrollArea look used in the main app.
_SCROLLBAR_STYLE = (
    "<style>"
    "*{scrollbar-width:thin;scrollbar-color:#d4d4d4 transparent;}"
    "::-webkit-scrollbar{width:6px;height:6px;}"
    "::-webkit-scrollbar-track{background:transparent;}"
    "::-webkit-scrollbar-thumb{background:#d4d4d4;border-radius:3px;}"
    "::-webkit-scrollbar-thumb:hover{background:#b0b0b0;}"
    "</style>"
)


class BatchDeleteRequest(BaseModel):
    """Ids of the artifacts to remove from the library."""

    ids: list[str] = Field(min_length=1, max_length=200)


def _extract_title(path: Path) -> str | None:
    """Best-effort extraction of the report's ``<title>`` for a friendly name."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(_HEAD_CHARS)
    except OSError:
        return None
    match = _TITLE_RE.search(head)
    if not match:
        return None
    title = html_lib.unescape(match.group(1)).strip()
    return title or None


def create_artifacts_router(reports_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/v1/artifacts", tags=["artifacts"])
    root = reports_dir.resolve()

    def _resolve_report(artifact_id: str) -> Path:
        if (
            not artifact_id
            or "\x00" in artifact_id
            or "/" in artifact_id
            or "\\" in artifact_id
            or ".." in artifact_id
        ):
            raise HTTPException(status_code=400, detail="Invalid artifact id.")
        path = (root / f"{artifact_id}.html").resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(status_code=404, detail="Artifact not found.")
        return path

    @router.get("")
    def list_artifacts() -> dict:
        if not root.is_dir():
            return {"data": []}
        items = []
        for path in sorted(
            root.glob("*.html"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        ):
            stat = path.stat()
            items.append(
                {
                    "id": path.stem,
                    "name": _extract_title(path) or path.stem,
                    "updated_at": datetime.fromtimestamp(
                        stat.st_mtime,
                        tz=timezone.utc,
                    ).isoformat(),
                    "size": stat.st_size,
                    "has_data": path.with_suffix(".json").is_file(),
                },
            )
        return {"data": items}

    @router.post("/batch-delete")
    def batch_delete_artifacts(payload: BatchDeleteRequest) -> dict:
        """Delete the given artifacts (HTML plus JSON data sibling)."""
        deleted: list[str] = []
        for artifact_id in payload.ids:
            try:
                path = _resolve_report(artifact_id)
            except HTTPException as exc:
                if exc.status_code == 404:
                    continue  # already gone — nothing to delete
                raise
            try:
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail="删除产物文件失败。"
                ) from exc
            deleted.append(artifact_id)
        return {"data": {"deleted": deleted}}

    @router.get("/{artifact_id}/data")
    def read_artifact_data(artifact_id: str) -> JSONResponse:
        html_path = _resolve_report(artifact_id)
        data_path = html_path.with_suffix(".json")
        if not data_path.is_file():
            raise HTTPException(status_code=404, detail="Artifact data not found.")
        try:
            envelope = json.loads(data_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HTTPException(
                status_code=404, detail="Artifact data not found."
            ) from exc
        return JSONResponse(
            {"data": envelope},
            headers={"X-Content-Type-Options": "nosniff"},
        )

    @router.get("/{artifact_id}", response_class=HTMLResponse)
    def read_artifact(artifact_id: str) -> HTMLResponse:
        path = _resolve_report(artifact_id)
        content = path.read_text(encoding="utf-8")
        # Inject unified scrollbar style so iframe previews match the main app.
        if "<head" in content.lower():
            content = re.sub(
                r"(<head[^>]*>)",
                r"\g<1>" + _SCROLLBAR_STYLE,
                content,
                count=1,
                flags=re.IGNORECASE,
            )
        else:
            content = _SCROLLBAR_STYLE + content
        return HTMLResponse(
            content,
            headers={
                "Content-Security-Policy": _REPORT_CSP,
                "X-Content-Type-Options": "nosniff",
            },
        )

    return router
