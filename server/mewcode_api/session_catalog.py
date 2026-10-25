"""HTTP 会话目录。只创建空文件并读取，消息由无头执行追加。"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from mewcode_api.models import ConversationDetail, ConversationMessage, ConversationSummary
from mewcode_api.run_manager import check_session_id, now_iso

LABEL_LIMIT = 40
CREATE_ATTEMPTS = 5
SESSIONS_DIRNAME = "api-sessions"


def sessions_dir(workspace: Path) -> Path:
    return workspace / ".mewcode" / SESSIONS_DIRNAME


def new_session_id(now: datetime | None = None) -> str:
    clock = now or datetime.now()
    suffix = os.urandom(3).hex()
    return clock.strftime("%Y%m%d-%H%M%S-") + suffix


def label_from_text(content: str) -> str:
    text = re.sub(r"\s+", " ", content).strip()
    if not text:
        return "新对话"
    if len(text) <= LABEL_LIMIT:
        return text
    return text[:LABEL_LIMIT] + "…"


def file_mtime(path: Path) -> str:
    stamp = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    return stamp.isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def later_time(left: str, right: str) -> str:
    left_at = _parse_time(left)
    right_at = _parse_time(right)
    if left_at is None:
        return right
    if right_at is None:
        return left
    return right if right_at >= left_at else left


def _valid_id(session_id: str) -> bool:
    try:
        check_session_id(session_id)
    except HTTPException:
        return False
    return True


class SessionCatalog:
    def create(self, workspace: Path) -> ConversationSummary:
        root = sessions_dir(workspace)
        root.mkdir(parents=True, exist_ok=True)
        created_at = now_iso()
        for _ in range(CREATE_ATTEMPTS):
            session_id = new_session_id()
            path = root / f"{session_id}.jsonl"
            if path.exists():
                continue
            record = {
                "type": "session",
                "id": session_id,
                "title": "新会话",
                "createdAt": created_at,
            }
            self._write_header(path, record)
            updated_at = file_mtime(path)
            return ConversationSummary(
                sessionId=session_id,
                workspace=str(workspace),
                label="新对话",
                busy=False,
                createdAt=created_at,
                updatedAt=updated_at,
            )
        raise HTTPException(status_code=500, detail="无法分配会话标识")

    def list(
        self,
        workspace: Path,
        busy_ids: set[str],
    ) -> list[ConversationSummary]:
        root = sessions_dir(workspace)
        if not root.is_dir():
            return []
        summaries: list[ConversationSummary] = []
        for path in root.glob("*.jsonl"):
            if not path.is_file():
                continue
            session_id = path.stem
            if not _valid_id(session_id):
                continue
            loaded = self._load(path, session_id)
            if loaded is None:
                continue
            created_at, updated_at, messages = loaded
            label = "新对话"
            for message in messages:
                if message.role == "user":
                    label = label_from_text(message.content)
                    break
            summaries.append(
                ConversationSummary(
                    sessionId=session_id,
                    workspace=str(workspace),
                    label=label,
                    busy=session_id in busy_ids,
                    createdAt=created_at,
                    updatedAt=updated_at,
                )
            )
        summaries.sort(key=lambda item: item.updatedAt, reverse=True)
        return summaries

    def get(self, workspace: Path, session_id: str) -> ConversationDetail:
        checked = check_session_id(session_id)
        if checked is None:
            raise HTTPException(status_code=400, detail="sessionId 不合法")
        path = sessions_dir(workspace) / f"{checked}.jsonl"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="对话不存在")
        loaded = self._load(path, checked)
        if loaded is None:
            raise HTTPException(status_code=404, detail="对话不存在")
        created_at, updated_at, messages = loaded
        visible = [
            message for message in messages if message.role in {"user", "assistant"}
        ]
        label = "新对话"
        for message in visible:
            if message.role == "user":
                label = label_from_text(message.content)
                break
        return ConversationDetail(
            sessionId=checked,
            workspace=str(workspace),
            label=label,
            busy=False,
            createdAt=created_at,
            updatedAt=updated_at,
            messages=visible,
        )

    def _write_header(self, path: Path, record: dict[str, str]) -> None:
        payload = json.dumps(record, ensure_ascii=False)
        tmp = path.with_suffix(".jsonl.tmp")
        tmp.write_text(payload + "\n", encoding="utf-8")
        tmp.replace(path)

    def _load(
        self,
        path: Path,
        session_id: str,
    ) -> tuple[str, str, list[ConversationMessage]] | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        created_at = file_mtime(path)
        updated_at = created_at
        messages: list[ConversationMessage] = []
        saw_header = False
        for line in text.splitlines():
            raw_line = line.strip()
            if not raw_line:
                continue
            try:
                raw = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if not isinstance(raw, dict):
                continue
            if raw.get("type") == "session":
                saw_header = True
                header_time = raw.get("createdAt")
                if isinstance(header_time, str) and header_time:
                    created_at = header_time
                continue
            role = raw.get("role")
            content = raw.get("content")
            message_time = raw.get("createdAt")
            if role not in {"user", "assistant", "tool", "system"}:
                continue
            if not isinstance(content, str) or not isinstance(message_time, str):
                continue
            if role in {"user", "assistant"}:
                messages.append(
                    ConversationMessage(
                        role=role,
                        content=content,
                        createdAt=message_time,
                    )
                )
            updated_at = later_time(updated_at, message_time)
        if not saw_header and not messages:
            return None
        return created_at, updated_at, messages
