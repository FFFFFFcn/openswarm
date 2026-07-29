"""Process-wide record of tool calls the user has denied/approved in the current task.

The HITL confirmation flow lives inside the framework: when the user clicks
"reject" the framework appends a ``DENIED`` tool result and then lets the
model decide the next step.  Models frequently retry the same call, which
pops the confirmation card again — the "点拒绝也依旧重试" bug.

This module records denied *and* approved tool names (captured from the
``POST /chat/`` payload by :class:`app.core.middleware.HitlDenialGuardMiddleware`):

- **Denied**: the tool's ``check_permissions`` returns a hard ``DENY`` on any
  retry within the same task (no card re-shown), making "reject == stop"
  deterministic.
- **Approved**: the tool's ``check_permissions`` returns ``ALLOW`` on
  subsequent calls within the same task, so the user only confirms once per
  tool per task ("approve once == allow rest").

Both sets are cleared when a new user message starts a fresh task.
"""
from __future__ import annotations

import threading

_lock = threading.Lock()
_denied: set[str] = set()
_approved: set[str] = set()


def record_denial(tool_name: str) -> None:
    """Remember that the user denied ``tool_name`` in the current task."""
    with _lock:
        _denied.add(tool_name)
        _approved.discard(tool_name)


def record_approval(tool_name: str) -> None:
    """Remember that the user approved ``tool_name`` in the current task."""
    with _lock:
        _approved.add(tool_name)


def is_denied(tool_name: str) -> bool:
    """Whether ``tool_name`` has been denied in the current task."""
    with _lock:
        return tool_name in _denied


def is_approved(tool_name: str) -> bool:
    """Whether ``tool_name`` has been approved in the current task."""
    with _lock:
        return tool_name in _approved


def clear_denials() -> None:
    """Forget all denials and approvals (called when a new user message starts a task)."""
    with _lock:
        _denied.clear()
        _approved.clear()
