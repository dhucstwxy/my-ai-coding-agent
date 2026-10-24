"""假 worker：按 JSONL 协议立刻完成，或等到 cancel。"""

from __future__ import annotations

import json
import sys


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


def complete(msg: dict, request_id: str) -> None:
    prompt = msg.get("prompt") or ""
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


def main() -> None:
    emit({"type": "ready", "v": 1})
    waiting: str | None = None
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        msg = json.loads(text)
        kind = msg.get("type")
        if kind == "shutdown":
            return
        if kind == "cancel":
            request_id = msg.get("requestId") or waiting
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
        if kind != "run":
            emit({"type": "error", "message": "未知命令"})
            continue
        request_id = msg["requestId"]
        prompt = msg.get("prompt") or ""
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
