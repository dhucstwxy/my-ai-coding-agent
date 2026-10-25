"""FastAPI 入口：把无头 Coding Agent 暴露成可调用的 HTTP 服务。"""

from __future__ import annotations

import asyncio
import contextvars
import hmac
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from mewcode_api.models import (
    ConversationDetail,
    ConversationSummary,
    CreateConversationBody,
    CreateRunBody,
    CreateRunResponse,
    RunView,
    SendMessageBody,
    SendMessageResponse,
)
from mewcode_api.run_manager import TERMINAL, RunManager, RunState, resolve_workspace
from mewcode_api.session_catalog import SessionCatalog
from mewcode_api.settings import Settings
from mewcode_api.worker_client import WorkerClient

log = logging.getLogger("mewcode.api")
current_run_id: contextvars.ContextVar[str] = contextvars.ContextVar("run_id", default="")
CHAT_HTML = Path(__file__).resolve().parent / "static" / "chat.html"


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("MEWCODE_SERVER_TOKEN", "").strip()
    if not expected:
        return
    supplied = authorization or ""
    if not hmac.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="未授权")


def get_manager(request: Request) -> RunManager:
    return request.app.state.manager


def create_app(worker_cmd: list[str] | None = None) -> FastAPI:
    settings = Settings.load(worker_cmd)
    worker = WorkerClient(
        settings.worker_cmd,
        settings.repo_root,
        ready_timeout_s=settings.ready_timeout_s,
    )
    worker.max_restarts = settings.max_worker_restarts
    manager = RunManager(worker, settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await worker.start()
        except Exception as exc:
            log.warning("worker 初次启动失败，服务以降级方式继续：%s", exc)
        manager.restore()
        loop_task = asyncio.create_task(manager.loop())
        retry_task = asyncio.create_task(worker.supervise())
        try:
            yield
        finally:
            manager.stop()
            worker.stop_supervise()
            if manager.running_id:
                with suppress(Exception):
                    await worker.cancel(manager.running_id)
            await worker.close()
            retry_task.cancel()
            loop_task.cancel()
            with suppress(asyncio.CancelledError):
                await retry_task
            with suppress(asyncio.CancelledError):
                await loop_task

    app = FastAPI(
        title="MewCode Agent API",
        version="1.0.0",
        summary="把本地 Coding Agent 暴露成 HTTP 服务",
        description=(
            "提交 prompt 后再查询结果，或用 SSE 看文本增量和工具事件。"
            "权限模式与无头 run 相同，工具自动放行。默认同一时刻只执行一个任务。"
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.manager = manager
    app.state.worker = worker

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        token = current_run_id.set("")
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            run_id = current_run_id.get() or run_id_from_path(request.url.path)
            log.info(
                "%s %s -> %s %.0fms bytes=%s run=%s",
                request.method,
                request.url.path,
                status,
                elapsed_ms,
                request.headers.get("content-length", "-"),
                run_id or "-",
            )
            current_run_id.reset(token)

    @app.get("/health")
    async def health() -> dict:
        return {
            "status": "ok" if worker.healthy else "degraded",
            "worker": "ready" if worker.healthy else "down",
            "queued": manager.queue.qsize(),
            "runningRunId": manager.running_id,
        }

    @app.get("/")
    async def root() -> dict:
        return {
            "service": "mewcode-agent",
            "health": "/health",
            "chat": "/chat",
            "docs": "/docs",
        }

    @app.get("/chat")
    async def chat_page() -> FileResponse:
        return FileResponse(CHAT_HTML)

    @app.post(
        "/v1/sessions",
        response_model=ConversationSummary,
        dependencies=[Depends(require_token)],
    )
    async def create_session(
        body: CreateConversationBody,
        request: Request,
    ) -> ConversationSummary:
        workspace = resolve_workspace(
            body.workspace,
            get_manager(request).settings.allowed_roots,
        )
        return SessionCatalog().create(workspace)

    @app.get(
        "/v1/sessions",
        response_model=list[ConversationSummary],
        dependencies=[Depends(require_token)],
    )
    async def list_sessions(
        request: Request,
        workspace: str | None = Query(default=None),
    ) -> list[ConversationSummary]:
        manager = get_manager(request)
        root = resolve_workspace(workspace, manager.settings.allowed_roots)
        return SessionCatalog().list(root, manager.busy_session_ids())

    @app.get(
        "/v1/sessions/{session_id}",
        response_model=ConversationDetail,
        dependencies=[Depends(require_token)],
    )
    async def get_session(
        session_id: str,
        request: Request,
        workspace: str | None = Query(default=None),
    ) -> ConversationDetail:
        manager = get_manager(request)
        root = resolve_workspace(workspace, manager.settings.allowed_roots)
        detail = SessionCatalog().get(root, session_id)
        if detail.sessionId in manager.busy_session_ids():
            detail.busy = True
        return detail

    @app.post(
        "/v1/sessions/{session_id}/messages",
        status_code=202,
        response_model=SendMessageResponse,
        dependencies=[Depends(require_token)],
    )
    async def send_message(
        session_id: str,
        body: SendMessageBody,
        request: Request,
    ) -> SendMessageResponse:
        manager = get_manager(request)
        root = resolve_workspace(body.workspace, manager.settings.allowed_roots)
        detail = SessionCatalog().get(root, session_id)
        run, position = manager.submit_for_session(root, detail.sessionId, body.prompt)
        current_run_id.set(run.run_id)
        return SendMessageResponse(
            sessionId=detail.sessionId,
            runId=run.run_id,
            status=run.status,
            workspace=str(root),
            position=position,
        )

    @app.post(
        "/v1/runs/wait",
        response_model=RunView,
        dependencies=[Depends(require_token)],
    )
    async def wait_run(
        body: CreateRunBody,
        request: Request,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> RunView:
        run = await _submit_and_track(request, body, idempotency_key)
        finished = await get_manager(request).wait_for(run)
        return RunView.model_validate(finished.to_dict())

    @app.post(
        "/v1/runs",
        status_code=202,
        response_model=CreateRunResponse,
        dependencies=[Depends(require_token)],
    )
    async def create_run(
        body: CreateRunBody,
        request: Request,
        idempotency_key: Annotated[str | None, Header()] = None,
    ) -> CreateRunResponse:
        run, position = _submit(request, body, idempotency_key)
        return CreateRunResponse(
            runId=run.run_id,
            sessionId=run.session_id,
            status=run.status,
            workspace=run.workspace,
            position=position,
        )

    @app.get(
        "/v1/runs",
        response_model=list[RunView],
        dependencies=[Depends(require_token)],
    )
    async def list_runs(
        request: Request,
        limit: int = Query(default=20, ge=1, le=100),
    ) -> list[RunView]:
        return [
            RunView.model_validate(item.to_dict())
            for item in get_manager(request).list_runs(limit)
        ]

    @app.get(
        "/v1/runs/{run_id}",
        response_model=RunView,
        dependencies=[Depends(require_token)],
    )
    async def get_run(run_id: str, request: Request) -> RunView:
        current_run_id.set(run_id)
        return RunView.model_validate(get_manager(request).get(run_id).to_dict())

    @app.post(
        "/v1/runs/{run_id}/cancel",
        response_model=RunView,
        dependencies=[Depends(require_token)],
    )
    async def cancel_run(run_id: str, request: Request) -> RunView:
        current_run_id.set(run_id)
        run = await get_manager(request).cancel(run_id)
        return RunView.model_validate(run.to_dict())

    @app.get(
        "/v1/runs/{run_id}/events",
        dependencies=[Depends(require_token)],
    )
    async def run_events(run_id: str, request: Request) -> StreamingResponse:
        current_run_id.set(run_id)
        run = get_manager(request).get(run_id)
        return StreamingResponse(
            stream_events(run),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return app


def _submit(
    request: Request,
    body: CreateRunBody,
    idempotency_key: str | None,
) -> tuple[RunState, int]:
    run, position = get_manager(request).submit(
        prompt=body.prompt,
        workspace=body.workspace,
        session_id=body.sessionId,
        timeout_ms=body.timeoutMs,
        idempotency_key=idempotency_key,
    )
    current_run_id.set(run.run_id)
    return run, position


async def _submit_and_track(
    request: Request,
    body: CreateRunBody,
    idempotency_key: str | None,
) -> RunState:
    run, _position = _submit(request, body, idempotency_key)
    return run


def run_id_from_path(path: str) -> str:
    parts = [part for part in path.split("/") if part]
    if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "runs" and parts[2] != "wait":
        return parts[2]
    return ""


async def stream_events(run: RunState) -> AsyncIterator[bytes]:
    queue: asyncio.Queue[dict] = asyncio.Queue()
    snapshot = list(run.events)
    if run.status not in TERMINAL:
        run.subscribers.append(queue)
    try:
        for item in snapshot:
            yield encode_sse(item)
            if item.get("event") == "done":
                return
        if run.status in TERMINAL:
            yield encode_sse({"event": "done", "data": run.done_payload()})
            return
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=15)
            except TimeoutError:
                yield b": ping\n\n"
                if run.status in TERMINAL:
                    yield encode_sse({"event": "done", "data": run.done_payload()})
                    return
                continue
            yield encode_sse(item)
            if item.get("event") == "done" or (
                run.status in TERMINAL and queue.empty()
            ):
                if item.get("event") != "done":
                    yield encode_sse({"event": "done", "data": run.done_payload()})
                return
    finally:
        if queue in run.subscribers:
            run.subscribers.remove(queue)


def encode_sse(item: dict) -> bytes:
    event = str(item.get("event") or "message")
    data = json.dumps(item.get("data"), ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


app = create_app()


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    host = os.environ.get("MEWCODE_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("MEWCODE_SERVER_PORT", "8787"))
    token = os.environ.get("MEWCODE_SERVER_TOKEN", "").strip()
    if host in {"0.0.0.0", "::"} and not token:
        log.warning(
            "服务监听所有网卡，且未设置 MEWCODE_SERVER_TOKEN。工具调用会自动放行。"
        )
    uvicorn.run(app, host=host, port=port)
