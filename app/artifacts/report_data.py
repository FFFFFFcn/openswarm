"""Structured JSON siblings for HTML report artifacts.

Each report service writes a self-contained ``{stem}.html`` deliverable. To let
the frontend re-render the same report with the app's own design system (instead
of the standalone HTML skin), we persist a ``{stem}.json`` sibling carrying the
structured payload the service already computed. The artifacts router exposes it
via ``GET /api/v1/artifacts/{id}/data`` and the UI assembles the HTML client-side.

Writing is best-effort: a serialization/IO failure must never break the primary
HTML report generation.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Report kind discriminator understood by the frontend ReportView dispatcher.
ReportKind = str  # "insight" | "title" | "account" | "cover"


def write_report_data(
    reports_dir: Path,
    stem: str,
    kind: ReportKind,
    title: str,
    payload: dict[str, Any],
) -> None:
    """Persist ``{stem}.json`` next to the HTML report.

    ``stem`` is the artifact id (already prefixed, e.g. ``title-<uuid>``) so the
    JSON file lines up 1:1 with ``{stem}.html``.
    """
    try:
        reports_dir.mkdir(parents=True, exist_ok=True)
        envelope = {
            "kind": kind,
            "title": title,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
        path = reports_dir / f"{stem}.json"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(envelope, ensure_ascii=False),
            encoding="utf-8",
        )
        temporary.replace(path)
    except (OSError, TypeError, ValueError):
        # Never let structured-data persistence break the HTML deliverable.
        pass
