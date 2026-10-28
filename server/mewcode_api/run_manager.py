"""任务队列。全局串行，与单个 worker 的执行模型一致。"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from mewcode_api.models import RunStatus
from mewcode_api.step_collector import StepCollector
from mewcode_api.task_store import TaskStore, TaskStoreError
from mewcode_api.settings import (
    DEFAULT_TIMEOUT_MS,
    EVENT_BUFFER_LIMIT,
    IDEMPOTENCY_TTL_S,
    PARTIAL_TEXT_LIMIT,
    Settings,
)
from mewcode_api.worker_client import WorkerClient

log = logging.getLogger("mewcode.runs")

TERMINAL: frozenset[str] = frozenset({"completed", "failed", "cancelled"})
SESSION_ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
IDEMPOTENCY_OK = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_workspace(raw: str | None, allowed_roots: list[Path]) -> Path:
    if raw:
        path = Path(raw).expanduser()
    else:
        env = os.environ.get("MEWCODE_WORKSPACE", "").strip()
        path = Path(env).expanduser() if env else Path.cwd()
    path = path.resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"工作区不存在：{path}")
    if allowed_roots and not any(is_relative_to(path, root) for root in allowed_roots):
        raise HTTPException(status_code=403, detail="工作区不在允许范围内")
    return path


def check_session_id(session_id: str | None) -> str | None:
    if session_id is None:
        return None
    if not SESSION_ID_OK.fullmatch(session_id) or ".." in session_id:
        raise HTTPException(status_code=400, detail="sessionId 不合法")
    return session_id


def check_idempotency_key(key: str | None) -> str | None:
    if key is None:
        return None
    text = key.strip()
    if not text:
        return None
    if not IDEMPOTENCY_OK.fullmatch(text):
        raise HTTPException(status_code=400, detail="Idempotency-Key 不合法")
    return text


@dataclass
class RunState:
    run_id: str
    workspace: str
    prompt: str
    timeout_ms: int
    sessions_dir: str
    created_at: str
    session_id: str | None = None
    status: RunStatus = "queued"
    partial_text: str = ""
    error: str | None = None
    report: dict[str, Any] | None = None
    cancel_requested: bool = False
    accepts_cancel: bool = False
    started_at: str | None = None
    ended_at: str | None = None
    input_committed: bool = False
    attempt: int = 0
    idempotency_key: str | None = None
    resume: bool = False
    session_turn: bool = False
    pending_approval_id: str | None = None
    pending_tool: str = ""
    pending_subject: str = ""
    pending_summary: str = ""
    approval_answered: bool = False
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    collector: StepCollector = field(default_factory=StepCollector)

    def __post_init__(self) -> None:
        self.done = asyncio.Event()
        self.last_partial_flush = 0.0
        if self.status in TERMINAL:
            self.done.set()

    def to_dict(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "status": self.status,
            "workspace": self.workspace,
            "sessionId": self.session_id,
            "partialText": self.partial_text,
            "error": self.error,
            "report": self.report,
            "cancelRequested": self.cancel_requested,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        }

    def to_record(self) -> dict[str, Any]:
        return {
            **self.to_dict(),
            "timeoutMs": self.timeout_ms,
            "sessionsDir": self.sessions_dir,
            "inputCommitted": self.input_committed,
            "attempt": self.attempt,
            "idempotencyKey": self.idempotency_key,
            "prompt": self.prompt,
            "sessionTurn": self.session_turn,
            "resume": self.resume,
        }

    def done_payload(self) -> dict[str, Any]:
        final = ""
        if isinstance(self.report, dict):
            message = self.report.get("finalMessage")
            if isinstance(message, str) and message:
                final = message
        if not final:
            final = self.partial_text
        return {**self.to_dict(), "text": final}

    def publish(self, item: dict[str, Any]) -> None:
        self.events.append(item)
        if len(self.events) > EVENT_BUFFER_LIMIT:
            self.events = self.events[-EVENT_BUFFER_LIMIT:]
        for queue in list(self.subscribers):
            queue.put_nowait(item)

    def append_text(self, text: str) -> None:
        if len(self.partial_text) >= PARTIAL_TEXT_LIMIT:
            return
        room = PARTIAL_TEXT_LIMIT - len(self.partial_text)
        self.partial_text += text[:room]

    def finish(
        self,
        status: RunStatus,
        error: str | None = None,
        report: dict[str, Any] | None = None,
    ) -> None:
        if self.status in TERMINAL:
            return
        self._deny_unanswered_approval()
        self.status = status
        self.ended_at = now_iso()
        if report is not None:
            self.report = report
            session_id = report.get("sessionId")
            if isinstance(session_id, str) and session_id:
                self.session_id = session_id
        if error:
            self.error = error
        elif status == "failed" and not self.error:
            self.error = "agent 未正常完成"
        self.publish({"event": "done", "data": self.done_payload()})
        self.done.set()

    def _deny_unanswered_approval(self) -> None:
        approval_id = self.pending_approval_id
        if not approval_id:
            return
        self.pending_approval_id = None
        self.approval_answered = True
        self.publish(
            {
                "event": "approval",
                "data": {
                    "approvalId": approval_id,
                    "runId": self.run_id,
                    "status": "denied",
                    "tool": self.pending_tool,
                    "subject": self.pending_subject,
                    "argsSummary": self.pending_summary,
                    "choice": "deny",
                },
            }
        )


class RunManager:
    def __init__(self, worker: WorkerClient, settings: Settings):
        self.worker = worker
        self.settings = settings
        try:
            self.store: TaskStore | None = TaskStore(settings.data_dir)
        except TaskStoreError as exc:
            log.error("%s", exc)
            self.store = None
        self.runs: dict[str, RunState] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.running_id: str | None = None
        self._stopped = False
        self._restored = False

    def submit(
        self,
        prompt: str,
        workspace: str | None,
        session_id: str | None,
        timeout_ms: int | None,
        idempotency_key: str | None = None,
    ) -> tuple[RunState, int]:
        self._require_store()
        self._require_worker()
        key = check_idempotency_key(idempotency_key)
        if key:
            existing = self._fresh_idempotent_run(key)
            if existing is not None:
                if existing.prompt != prompt:
                    raise HTTPException(
                        status_code=409,
                        detail="Idempotency-Key 已用于不同的 prompt",
                    )
                position = 0 if existing.status in TERMINAL else self.queue.qsize()
                return existing, position
        if self._inflight_count() >= self.settings.max_queued:
            raise HTTPException(status_code=429, detail="排队任务已满")
        root = resolve_workspace(workspace, self.settings.allowed_roots)
        session = check_session_id(session_id)
        run = RunState(
            run_id=str(uuid4()),
            workspace=str(root),
            prompt=prompt,
            timeout_ms=timeout_ms or DEFAULT_TIMEOUT_MS,
            sessions_dir=str(root / ".mewcode" / "api-sessions"),
            created_at=now_iso(),
            session_id=session,
            idempotency_key=key,
        )
        self.runs[run.run_id] = run
        self._persist(run)
        self.queue.put_nowait(run.run_id)
        position = self.queue.qsize()
        log.info(
            "排队 run=%s workspace=%s prompt_len=%s",
            run.run_id,
            run.workspace,
            len(prompt),
        )
        return run, position

    def busy_session_ids(self) -> set[str]:
        found: set[str] = set()
        for run in self.runs.values():
            if run.status in TERMINAL or not run.session_id:
                continue
            found.add(run.session_id)
        return found

    def submit_for_session(
        self,
        workspace: Path,
        session_id: str,
        prompt: str,
    ) -> tuple[RunState, int]:
        """为已有对话排入一轮。检查和入队在同一次调用里完成。"""
        self._require_store()
        self._require_worker()
        checked = check_session_id(session_id)
        if checked is None:
            raise HTTPException(status_code=400, detail="sessionId 不合法")
        if checked in self.busy_session_ids():
            raise HTTPException(status_code=409, detail="这段对话正忙")
        if self._inflight_count() >= self.settings.max_queued:
            raise HTTPException(status_code=429, detail="排队任务已满")
        run = RunState(
            run_id=str(uuid4()),
            workspace=str(workspace),
            prompt=prompt,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            sessions_dir=str(workspace / ".mewcode" / "api-sessions"),
            created_at=now_iso(),
            session_id=checked,
            session_turn=True,
        )
        self.runs[run.run_id] = run
        self._persist(run)
        self.queue.put_nowait(run.run_id)
        position = self.queue.qsize()
        log.info(
            "排队会话 run=%s session=%s workspace=%s prompt_len=%s",
            run.run_id,
            checked,
            run.workspace,
            len(prompt),
        )
        return run, position

    async def wait_for(self, run: RunState) -> RunState:
        try:
            await asyncio.wait_for(run.done.wait(), run.timeout_ms / 1000 + 35)
        except TimeoutError:
            log.info("等待超时 run=%s", run.run_id)
        return run

    def get(self, run_id: str) -> RunState:
        run = self.runs.get(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="运行不存在")
        return run

    def list_runs(self, limit: int) -> list[RunState]:
        ordered = sorted(self.runs.values(), key=lambda item: item.created_at, reverse=True)
        return ordered[:limit]

    async def cancel(self, run_id: str) -> RunState:
        run = self.get(run_id)
        run.cancel_requested = True
        self._persist(run)
        if run.status in TERMINAL:
            return run
        if run.status == "queued":
            self._complete(run, "cancelled", error="已取消")
            return run
        if run.accepts_cancel:
            await self.worker.cancel(run.run_id)
        return run

    def stop(self) -> None:
        self._stopped = True

    async def loop(self) -> None:
        self.restore()
        while not self._stopped:
            run_id = await self.queue.get()
            try:
                if self._stopped:
                    return
                await self._execute(run_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("执行失败 run=%s", run_id)
                run = self.runs.get(run_id)
                if run is not None:
                    self._complete(run, "failed", error=str(exc))
            finally:
                self.queue.task_done()

    def restore(self) -> None:
        if self._restored:
            return
        self._restored = True
        for record in self._load_saved_tasks():
            run = self._run_from_record(record)
            self.runs[run.run_id] = run
            if run.status in TERMINAL:
                continue
            if run.status == "running" and run.cancel_requested:
                self._complete(run, "cancelled", error="已取消")
                continue
            if run.status == "running":
                run.attempt += 1
                if run.attempt > self.settings.max_resume_attempts:
                    self._complete(run, "failed", error="多次中断")
                    continue
                run.resume = bool(run.input_committed and run.session_id)
                run.status = "queued"
                run.partial_text = ""
                run.events.clear()
                run.started_at = None
                self._persist(run)
            self.queue.put_nowait(run.run_id)
            log.info(
                "恢复 run=%s status=%s resume=%s attempt=%s",
                run.run_id,
                run.status,
                run.resume,
                run.attempt,
            )

    async def _execute(self, run_id: str) -> None:
        run = self.runs[run_id]
        if run.status in TERMINAL:
            return
        run.status = "running"
        if not run.started_at:
            run.started_at = now_iso()
        self.running_id = run.run_id
        self._persist(run)
        run.publish(
            {
                "event": "status",
                "data": {"runId": run.run_id, "status": "running"},
            }
        )
        self._remember_event(run)
        try:
            await self.worker.ensure_started()
            deadline = run.timeout_ms / 1000 + 30
            await asyncio.wait_for(self._consume(run), deadline)
        except TimeoutError:
            self._complete(run, "failed", error="worker 超时无响应")
            try:
                await self.worker.restart()
            except Exception:
                log.exception("worker 重启失败")
        finally:
            if self.running_id == run.run_id:
                self.running_id = None

    async def _consume(self, run: RunState) -> None:
        payload: dict[str, Any] = {
            "type": "session-run" if run.session_turn else "run",
            "requestId": run.run_id,
            "workspace": run.workspace,
            "prompt": run.prompt,
            "timeoutMs": run.timeout_ms,
            "sessionsDir": run.sessions_dir,
        }
        if run.session_id:
            payload["sessionId"] = run.session_id
        if run.resume:
            payload["resume"] = True

        async def on_started() -> None:
            run.accepts_cancel = True
            if run.cancel_requested:
                await self.worker.cancel(run.run_id)

        async for msg in self.worker.run(run.run_id, payload, on_started):
            kind = msg.get("type")
            if kind == "session":
                session_id = msg.get("sessionId")
                if isinstance(session_id, str) and session_id:
                    run.session_id = session_id
                    self._persist(run)
                continue
            if kind == "event":
                event = msg.get("event")
                if isinstance(event, dict):
                    self._on_agent_event(run, event)
                continue
            if kind == "approval":
                self._on_approval(run, msg)
                continue
            if kind == "warning":
                message = msg.get("message")
                if isinstance(message, str) and message:
                    run.publish({"event": "warning", "data": {"message": message}})
                    run.collector.note_warning(message)
                continue
            if kind == "result":
                report = msg.get("report") if isinstance(msg.get("report"), dict) else {}
                self._finish_from_report(run, int(msg.get("exitCode", 1)), report)
                return
            if kind == "error":
                message = msg.get("message")
                self._complete(
                    run,
                    "failed",
                    error=message if isinstance(message, str) and message else "worker 错误",
                )
                return

    def _on_agent_event(self, run: RunState, event: dict[str, Any]) -> None:
        if not run.input_committed:
            run.input_committed = True
            self._persist(run)
        event_type = event.get("type")
        if event_type == "text_delta" and isinstance(event.get("text"), str):
            run.collector.observe(event)
            run.append_text(event["text"])
            run.publish({"event": "text", "data": {"delta": event["text"]}})
            self._maybe_flush_partial(run)
        elif event_type == "tool_execution_start":
            self._commit_step(run, run.collector.observe(event))
            run.publish(
                {
                    "event": "tool",
                    "data": {
                        "id": event.get("id"),
                        "name": event.get("name"),
                        "phase": "start",
                    },
                }
            )
        elif event_type == "tool_execution_end":
            self._commit_step(run, run.collector.observe(event))
            run.publish(
                {
                    "event": "tool",
                    "data": {
                        "id": event.get("id"),
                        "name": event.get("name"),
                        "phase": "end",
                        "ok": event.get("ok"),
                        "summary": event.get("resultSummary"),
                    },
                }
            )
        elif event_type == "thinking_end":
            self._commit_step(run, run.collector.observe(event))
        run.publish({"event": "agent", "data": event})

    def _on_approval(self, run: RunState, msg: dict[str, Any]) -> None:
        approval_id = msg.get("approvalId")
        status = msg.get("status")
        if not isinstance(approval_id, str) or not approval_id:
            return
        if status not in {"pending", "allowed", "denied"}:
            return
        tool = msg.get("tool") if isinstance(msg.get("tool"), str) else ""
        subject = msg.get("subject") if isinstance(msg.get("subject"), str) else ""
        summary = msg.get("argsSummary") if isinstance(msg.get("argsSummary"), str) else ""
        data: dict[str, Any] = {
            "approvalId": approval_id,
            "runId": run.run_id,
            "status": status,
            "tool": tool,
            "subject": subject,
            "argsSummary": summary,
        }
        if status == "pending":
            data["choices"] = ["deny", "once", "session", "permanent"]
            run.pending_approval_id = approval_id
            run.pending_tool = tool
            run.pending_subject = subject
            run.pending_summary = summary
            run.approval_answered = False
        else:
            choice = msg.get("choice")
            if choice in {"deny", "once", "session", "permanent"}:
                data["choice"] = choice
            if run.pending_approval_id == approval_id:
                run.pending_approval_id = None
        run.publish({"event": "approval", "data": data})
        run.collector.note_approval(data)

    async def answer_approval(self, run_id: str, approval_id: str, choice: str) -> RunState:
        run = self.get(run_id)
        if not run.session_turn or run.status in TERMINAL:
            raise HTTPException(status_code=409, detail="这一轮不能提交选择")
        if run.approval_answered or run.pending_approval_id != approval_id:
            raise HTTPException(status_code=409, detail="询问已结束或不匹配")
        self._require_worker()
        run.approval_answered = True
        try:
            await self.worker.approve(run.run_id, approval_id, choice)
        except RuntimeError as exc:
            run.approval_answered = False
            raise HTTPException(status_code=503, detail="执行器不可用") from exc
        return run

    def _finish_from_report(
        self,
        run: RunState,
        exit_code: int,
        report: dict[str, Any],
    ) -> None:
        error = report.get("error")
        error_text = error if isinstance(error, str) and error else None
        stop = report.get("stopReason")
        if error_text == "agent_timeout":
            status: RunStatus = "failed"
        elif stop == "cancelled" or (run.cancel_requested and exit_code != 0):
            status = "cancelled"
        elif exit_code == 0:
            status = "completed"
        else:
            status = "failed"
        self._complete(run, status, error=error_text, report=report)

    def steps(self, run_id: str) -> list[dict[str, Any]]:
        self.get(run_id)
        self._require_store()
        assert self.store is not None
        return self.store.load_steps(run_id)

    def _require_store(self) -> None:
        if self.store is None:
            raise HTTPException(status_code=503, detail="任务库不可用")

    def _load_saved_tasks(self) -> list[dict[str, Any]]:
        if self.store is None:
            log.warning("任务库不可用")
            return []
        try:
            return self.store.load_tasks()
        except TaskStoreError as exc:
            log.warning("%s", exc)
            return []

    def _complete(
        self,
        run: RunState,
        status: RunStatus,
        error: str | None = None,
        report: dict[str, Any] | None = None,
    ) -> None:
        if run.status not in TERMINAL:
            self._commit_step(run, run.collector.flush())
        run.finish(status, error=error, report=report)
        self._remember(run)

    def _commit_step(self, run: RunState, step: dict[str, Any] | None) -> None:
        if not step:
            return
        if self.store is None:
            log.warning("任务库不可用，步骤未写入 run=%s", run.run_id)
            return
        try:
            self.store.append_step(run.run_id, step)
        except TaskStoreError as exc:
            log.warning("写入步骤失败 run=%s：%s", run.run_id, exc)

    def _require_worker(self) -> None:
        reason = self.worker.unavailable_reason()
        if reason:
            raise HTTPException(status_code=503, detail=reason)

    def _inflight_count(self) -> int:
        return sum(1 for run in self.runs.values() if run.status not in TERMINAL)

    def _fresh_idempotent_run(self, key: str) -> RunState | None:
        matches = [run for run in self.runs.values() if run.idempotency_key == key]
        if not matches:
            return None
        run = max(matches, key=lambda item: item.created_at)
        created = parse_iso(run.created_at)
        if created is None:
            return run
        if datetime.now(timezone.utc) - created > timedelta(seconds=IDEMPOTENCY_TTL_S):
            return None
        return run

    def _maybe_flush_partial(self, run: RunState) -> None:
        now = time.monotonic()
        if now - run.last_partial_flush < 1:
            return
        run.last_partial_flush = now
        self._persist(run)

    def _persist(self, run: RunState) -> None:
        if self.store is None:
            log.warning("任务库不可用，任务未写入 run=%s", run.run_id)
            return
        try:
            self.store.save_task(run.to_record())
        except (OSError, TaskStoreError) as exc:
            log.warning("写入任务失败 run=%s：%s", run.run_id, exc)

    def _remember_event(self, run: RunState) -> None:
        """细粒度事件只留在内存，供同一次进程里的订阅者回放。"""
        return

    def _remember(self, run: RunState) -> None:
        self._persist(run)

    def _run_from_record(self, record: dict[str, Any]) -> RunState:
        workspace = str(record.get("workspace") or "")
        sessions_dir = record.get("sessionsDir")
        if not isinstance(sessions_dir, str) or not sessions_dir:
            sessions_dir = str(Path(workspace) / ".mewcode" / "api-sessions")
        status = record.get("status")
        if status not in {"queued", "running", "completed", "failed", "cancelled"}:
            status = "failed"
        timeout = record.get("timeoutMs")
        run = RunState(
            run_id=str(record["runId"]),
            workspace=workspace,
            prompt=str(record.get("prompt") or ""),
            timeout_ms=timeout if isinstance(timeout, int) and timeout > 0 else DEFAULT_TIMEOUT_MS,
            sessions_dir=sessions_dir,
            created_at=str(record.get("createdAt") or now_iso()),
            session_id=record.get("sessionId") if isinstance(record.get("sessionId"), str) else None,
            status=status,
            partial_text=str(record.get("partialText") or ""),
            error=record.get("error") if isinstance(record.get("error"), str) else None,
            report=record.get("report") if isinstance(record.get("report"), dict) else None,
            cancel_requested=bool(record.get("cancelRequested")),
            started_at=record.get("startedAt") if isinstance(record.get("startedAt"), str) else None,
            ended_at=record.get("endedAt") if isinstance(record.get("endedAt"), str) else None,
            input_committed=bool(record.get("inputCommitted")),
            attempt=record.get("attempt") if isinstance(record.get("attempt"), int) else 0,
            idempotency_key=(
                record.get("idempotencyKey")
                if isinstance(record.get("idempotencyKey"), str)
                else None
            ),
            session_turn=record.get("sessionTurn") is True,
        )
        run.resume = bool(record.get("resume"))
        return run
