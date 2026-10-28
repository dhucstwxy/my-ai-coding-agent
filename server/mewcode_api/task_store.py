"""任务与步骤的 SQLite 存储。细粒度事件不进库。"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  workspace TEXT NOT NULL,
  session_id TEXT,
  prompt TEXT NOT NULL,
  partial_text TEXT NOT NULL DEFAULT '',
  error TEXT,
  report TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  timeout_ms INTEGER NOT NULL,
  sessions_dir TEXT NOT NULL,
  input_committed INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  session_turn INTEGER NOT NULL DEFAULT 0,
  resume INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  tool TEXT,
  subject TEXT,
  ok INTEGER,
  summary TEXT,
  approval TEXT,
  warnings TEXT,
  PRIMARY KEY (run_id, seq)
);
"""


class TaskStoreError(RuntimeError):
    """任务库打不开或暂时不能写。"""


class TaskStore:
    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "tasks.sqlite"
        self._lock = threading.Lock()
        self._conn = self._open()

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            return

    def load_tasks(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection().execute(
                "SELECT * FROM tasks ORDER BY created_at"
            ).fetchall()
        return [self._task_from_row(row) for row in rows]

    def save_task(self, record: dict[str, Any]) -> None:
        run_id = record.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return
        report = record.get("report")
        report_text = (
            json.dumps(report, ensure_ascii=False) if isinstance(report, dict) else None
        )
        session_id = record.get("sessionId")
        error = record.get("error")
        started = record.get("startedAt")
        ended = record.get("endedAt")
        key = record.get("idempotencyKey")
        values = (
            run_id,
            str(record.get("status") or "queued"),
            str(record.get("workspace") or ""),
            session_id if isinstance(session_id, str) else None,
            str(record.get("prompt") or ""),
            str(record.get("partialText") or ""),
            error if isinstance(error, str) else None,
            report_text,
            1 if record.get("cancelRequested") else 0,
            str(record.get("createdAt") or ""),
            started if isinstance(started, str) else None,
            ended if isinstance(ended, str) else None,
            int(record["timeoutMs"]) if isinstance(record.get("timeoutMs"), int) else 0,
            str(record.get("sessionsDir") or ""),
            1 if record.get("inputCommitted") else 0,
            int(record["attempt"]) if isinstance(record.get("attempt"), int) else 0,
            key if isinstance(key, str) else None,
            1 if record.get("sessionTurn") is True else 0,
            1 if record.get("resume") else 0,
        )
        with self._lock:
            self._connection().execute(
                """
                INSERT INTO tasks (
                  run_id, status, workspace, session_id, prompt, partial_text, error,
                  report, cancel_requested, created_at, started_at, ended_at, timeout_ms,
                  sessions_dir, input_committed, attempt, idempotency_key, session_turn, resume
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                  status = excluded.status,
                  workspace = excluded.workspace,
                  session_id = excluded.session_id,
                  prompt = excluded.prompt,
                  partial_text = excluded.partial_text,
                  error = excluded.error,
                  report = excluded.report,
                  cancel_requested = excluded.cancel_requested,
                  created_at = excluded.created_at,
                  started_at = excluded.started_at,
                  ended_at = excluded.ended_at,
                  timeout_ms = excluded.timeout_ms,
                  sessions_dir = excluded.sessions_dir,
                  input_committed = excluded.input_committed,
                  attempt = excluded.attempt,
                  idempotency_key = excluded.idempotency_key,
                  session_turn = excluded.session_turn,
                  resume = excluded.resume
                """,
                values,
            )
            self._connection().commit()

    def append_step(self, run_id: str, step: dict[str, Any]) -> int:
        approval = step.get("approval")
        warnings = step.get("warnings")
        ok = step.get("ok")
        with self._lock:
            conn = self._connection()
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            seq = int(row[0])
            conn.execute(
                """
                INSERT INTO steps (
                  run_id, seq, kind, text, tool, subject, ok, summary, approval, warnings
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    seq,
                    str(step.get("kind") or ""),
                    step.get("text") if isinstance(step.get("text"), str) else None,
                    step.get("tool") if isinstance(step.get("tool"), str) else None,
                    step.get("subject") if isinstance(step.get("subject"), str) else None,
                    None if ok is None else (1 if ok else 0),
                    step.get("summary") if isinstance(step.get("summary"), str) else None,
                    json.dumps(approval, ensure_ascii=False)
                    if isinstance(approval, dict)
                    else None,
                    json.dumps(warnings, ensure_ascii=False)
                    if isinstance(warnings, list)
                    else None,
                ),
            )
            conn.commit()
            return seq

    def load_steps(self, run_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection().execute(
                "SELECT * FROM steps WHERE run_id = ? ORDER BY seq",
                (run_id,),
            ).fetchall()
        return [self._step_from_row(row) for row in rows]

    def _open(self) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and not self.path.is_file():
                raise sqlite3.OperationalError("路径不是数据库文件")
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            conn.execute("SELECT COUNT(*) FROM tasks")
            conn.commit()
        except (OSError, sqlite3.Error) as exc:
            if conn is not None:
                conn.close()
            raise TaskStoreError("任务库不可用") from exc
        return conn

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            raise TaskStoreError("任务库不可用")
        return self._conn

    @staticmethod
    def _task_from_row(row: sqlite3.Row) -> dict[str, Any]:
        report = None
        if row["report"]:
            parsed = json.loads(row["report"])
            report = parsed if isinstance(parsed, dict) else None
        return {
            "runId": row["run_id"],
            "status": row["status"],
            "workspace": row["workspace"],
            "sessionId": row["session_id"],
            "prompt": row["prompt"],
            "partialText": row["partial_text"],
            "error": row["error"],
            "report": report,
            "cancelRequested": bool(row["cancel_requested"]),
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
            "timeoutMs": row["timeout_ms"],
            "sessionsDir": row["sessions_dir"],
            "inputCommitted": bool(row["input_committed"]),
            "attempt": row["attempt"],
            "idempotencyKey": row["idempotency_key"],
            "sessionTurn": bool(row["session_turn"]),
            "resume": bool(row["resume"]),
        }

    @staticmethod
    def _step_from_row(row: sqlite3.Row) -> dict[str, Any]:
        kind = row["kind"]
        if kind == "tool":
            warnings = json.loads(row["warnings"]) if row["warnings"] else []
            view: dict[str, Any] = {
                "seq": row["seq"],
                "kind": "tool",
                "tool": row["tool"] or "",
                "subject": row["subject"] or "",
                "ok": bool(row["ok"]),
                "summary": row["summary"] or "",
                "warnings": warnings if isinstance(warnings, list) else [],
            }
            if row["approval"]:
                approval = json.loads(row["approval"])
                if isinstance(approval, dict):
                    view["approval"] = approval
            return view
        return {
            "seq": row["seq"],
            "kind": kind,
            "text": row["text"] or "",
        }
