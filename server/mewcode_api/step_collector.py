"""把执行事件收成已完成的步骤。增量本身不是步骤。"""

from __future__ import annotations

import re
from typing import Any

_SUMMARY_MAX = 200
_SECRET = re.compile(r"sk-[A-Za-z0-9_-]{6,}")
_SECRET_FIELD = re.compile(
    r'("(?:api_key|authorization|token|password|secret)"\s*:\s*")[^"]*"',
    re.IGNORECASE,
)
_APPROVAL_KEYS = (
    "approvalId",
    "runId",
    "status",
    "tool",
    "subject",
    "argsSummary",
    "choice",
)


def _redact(text: str) -> str:
    text = _SECRET.sub("sk-***", text)
    return _SECRET_FIELD.sub(r'\1***"', text)


class StepCollector:
    def __init__(self) -> None:
        self._text = ""
        self._tool_open = False
        self._approval: dict[str, Any] | None = None
        self._warnings: list[str] = []
        self._queued_approval: dict[str, Any] | None = None

    def observe(self, event: dict[str, Any]) -> dict[str, Any] | None:
        kind = event.get("type")
        if kind == "text_delta":
            text = event.get("text")
            if isinstance(text, str):
                self._text += text
            return None
        if kind == "thinking_end":
            summary = event.get("summary")
            return {
                "kind": "thinking",
                "text": summary if isinstance(summary, str) else "",
            }
        if kind == "tool_execution_start":
            step = self._take_text()
            self._tool_open = True
            self._approval = self._queued_approval
            self._queued_approval = None
            self._warnings = []
            return step
        if kind == "tool_execution_end":
            return self._close_tool(event)
        return None

    def note_approval(self, approval: dict[str, Any]) -> None:
        status = approval.get("status")
        if status not in {"allowed", "denied"}:
            return
        kept = {
            key: approval[key]
            for key in _APPROVAL_KEYS
            if key in approval and approval[key] is not None
        }
        if self._tool_open:
            self._approval = kept
        else:
            self._queued_approval = kept

    def note_warning(self, message: str) -> None:
        if self._tool_open and message:
            self._warnings.append(message)

    def flush(self) -> dict[str, Any] | None:
        return self._take_text()

    def _take_text(self) -> dict[str, Any] | None:
        if not self._text:
            return None
        step = {"kind": "text", "text": self._text}
        self._text = ""
        return step

    def _close_tool(self, event: dict[str, Any]) -> dict[str, Any]:
        subject = event.get("subject")
        name = event.get("name")
        summary = event.get("resultSummary")
        approval = self._approval or self._queued_approval
        step: dict[str, Any] = {
            "kind": "tool",
            "tool": name if isinstance(name, str) else "",
            "subject": subject if isinstance(subject, str) else "",
            "ok": bool(event.get("ok")),
            "summary": _redact(summary)[:_SUMMARY_MAX] if isinstance(summary, str) else "",
            "warnings": list(self._warnings),
        }
        if isinstance(approval, dict):
            step["approval"] = approval
        self._tool_open = False
        self._approval = None
        self._queued_approval = None
        self._warnings = []
        return step
