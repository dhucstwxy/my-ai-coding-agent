"""假 worker：按 JSONL 协议立刻完成，或等到 cancel。"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def result(request_id: str, exit_code: int, report: dict) -> None:
    emit(
        {
            "type": "result",
            "requestId": request_id,
            "exitCode": exit_code,
            "report": report,
        }
    )


def append_saved_turn(msg: dict) -> None:
    """把这一轮写进已有会话文件。resume 时不再写用户消息。文件不存在则跳过。"""
    sessions_dir = msg.get("sessionsDir")
    session_id = msg.get("sessionId")
    if not isinstance(sessions_dir, str) or not isinstance(session_id, str):
        return
    path = Path(sessions_dir) / f"{session_id}.jsonl"
    if not path.is_file():
        return
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    lines: list[dict[str, str]] = []
    if msg.get("resume") is not True:
        lines.append(
            {
                "type": "message",
                "id": str(uuid4()),
                "role": "user",
                "content": msg.get("prompt") or "",
                "createdAt": now,
            }
        )
    lines.append(
        {
            "type": "message",
            "id": str(uuid4()),
            "role": "assistant",
            "content": "pong",
            "createdAt": now,
        }
    )
    with path.open("a", encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")


def emit_warning(request_id: str, message: str) -> None:
    emit({"type": "warning", "requestId": request_id, "message": message})


def emit_steps(msg: dict, request_id: str, hold: bool) -> None:
    """发出思考、工具和正文。hold 时在工具结束前停住，方便查询未完成步骤。"""
    session_id = msg.get("sessionId") or "sess-new"
    emit({"type": "session", "requestId": request_id, "sessionId": session_id})
    emit_warning(request_id, "启动提示")
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {"type": "thinking_end", "summary": "先看文件"},
        }
    )
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {
                "type": "tool_execution_start",
                "id": "tool-1",
                "name": "read_file",
                "argsSummary": "a.txt",
            },
        }
    )
    if not hold:
        emit_approval(request_id, "allowed", "once")
        emit_warning(request_id, "工具提示")
    else:
        time.sleep(1)
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {
                "type": "tool_execution_end",
                "id": "tool-1",
                "name": "read_file",
                "subject": "a.txt",
                "ok": True,
                "resultSummary": "读完了",
            },
        }
    )
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {"type": "text_delta", "text": "第一步"},
        }
    )
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {"type": "text_delta", "text": "完成"},
        }
    )
    result(
        request_id,
        0,
        {
            "stopReason": "completed",
            "error": None,
            "sessionId": session_id,
            "finalMessage": "第一步完成",
            "exitCode": 0,
            "steps": 3,
            "tools": [],
        },
    )


def complete(msg: dict, request_id: str) -> None:
    prompt = msg.get("prompt") or ""
    if prompt in {"STEPS", "STEPS_HOLD"}:
        emit_steps(msg, request_id, hold=prompt == "STEPS_HOLD")
        return
    session_id = msg.get("sessionId") or "sess-new"
    if prompt == "FAIL":
        emit({"type": "session", "requestId": request_id, "sessionId": session_id})
        result(
            request_id,
            1,
            {
                "stopReason": "error",
                "error": "模型失败",
                "sessionId": session_id,
                "finalMessage": "",
                "exitCode": 1,
            },
        )
        return
    append_saved_turn(msg)
    session_id = msg.get("sessionId") or "sess-new"
    emit({"type": "session", "requestId": request_id, "sessionId": session_id})
    if prompt == "USE_TOOL":
        emit(
            {
                "type": "event",
                "requestId": request_id,
                "event": {
                    "type": "tool_execution_start",
                    "id": "tool-1",
                    "name": "read_file",
                    "argsSummary": "a.txt",
                },
            }
        )
        emit(
            {
                "type": "event",
                "requestId": request_id,
                "event": {
                    "type": "tool_execution_end",
                    "id": "tool-1",
                    "name": "read_file",
                    "ok": True,
                    "resultSummary": "读完了",
                },
            }
        )
    emit(
        {
            "type": "event",
            "requestId": request_id,
            "event": {"type": "text_delta", "text": "pong"},
        }
    )
    result(
        request_id,
        0,
        {
            "stopReason": "completed",
            "error": None,
            "sessionId": session_id,
            "finalMessage": "pong",
            "exitCode": 0,
            "steps": 1,
            "tools": [],
            "resumed": bool(msg.get("resume")),
        },
    )


def emit_approval(request_id: str, status: str, choice: str | None = None) -> None:
    payload: dict[str, object] = {
        "type": "approval",
        "requestId": request_id,
        "approvalId": "ask-1",
        "status": status,
        "tool": "write_file",
        "subject": "a.txt",
        "argsSummary": "写入",
    }
    if status == "pending":
        payload["choices"] = ["deny", "once", "session", "permanent"]
    if choice:
        payload["choice"] = choice
    emit(payload)


def main() -> None:
    emit({"type": "ready", "v": 1})
    waiting: str | None = None
    pending_ask: dict | None = None
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        msg = json.loads(text)
        kind = msg.get("type")
        if kind == "shutdown":
            return
        if kind == "cancel":
            request_id = msg.get("requestId") or (
                pending_ask["requestId"] if pending_ask else waiting
            )
            if pending_ask and pending_ask["requestId"] == request_id:
                emit_approval(request_id, "denied", "deny")
                pending_ask = None
            if isinstance(request_id, str):
                result(
                    request_id,
                    2,
                    {
                        "stopReason": "cancelled",
                        "error": "已取消",
                        "sessionId": "sess-cancel",
                        "finalMessage": "",
                        "exitCode": 2,
                    },
                )
            waiting = None
            continue
        if kind == "approval":
            request_id = msg.get("requestId")
            if (
                pending_ask is None
                or pending_ask["requestId"] != request_id
                or msg.get("approvalId") != "ask-1"
            ):
                emit({"type": "error", "message": "没有待确认的询问"})
                continue
            choice = msg.get("choice")
            saved = pending_ask["msg"]
            pending_ask = None
            if choice == "deny":
                emit_approval(request_id, "denied", "deny")
                result(
                    request_id,
                    1,
                    {
                        "stopReason": "error",
                        "error": "已拒绝",
                        "sessionId": saved.get("sessionId") or "sess-new",
                        "finalMessage": "",
                        "exitCode": 1,
                        "tools": [],
                    },
                )
                continue
            emit_approval(request_id, "allowed", choice if isinstance(choice, str) else "once")
            complete(saved, request_id)
            continue
        if kind not in ("run", "session-run"):
            emit({"type": "error", "message": "未知命令"})
            continue
        request_id = msg["requestId"]
        prompt = msg.get("prompt") or ""
        if kind == "session-run" and prompt == "ASK":
            pending_ask = {"requestId": request_id, "msg": msg}
            emit(
                {
                    "type": "session",
                    "requestId": request_id,
                    "sessionId": msg.get("sessionId") or "sess-new",
                }
            )
            emit_approval(request_id, "pending")
            continue
        if prompt == "WAIT_CANCEL":
            waiting = request_id
            emit(
                {
                    "type": "session",
                    "requestId": request_id,
                    "sessionId": msg.get("sessionId") or "sess-new",
                }
            )
            continue
        complete(msg, request_id)


if __name__ == "__main__":
    main()
