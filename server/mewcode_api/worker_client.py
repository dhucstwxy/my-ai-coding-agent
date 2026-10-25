"""拉起并读写 serve-worker 的 JSONL 协议。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

log = logging.getLogger("mewcode.worker")


class WorkerClient:
    def __init__(self, cmd: list[str], cwd: Path, ready_timeout_s: float = 30.0):
        self.cmd = cmd
        self.cwd = cwd
        self.ready_timeout_s = ready_timeout_s
        self.proc: asyncio.subprocess.Process | None = None
        self.ready = asyncio.Event()
        self._dead = asyncio.Event()
        self._generation = 0
        self._pending: dict[str, asyncio.Queue[dict]] = {}
        self._write_lock = asyncio.Lock()
        self._life_lock = asyncio.Lock()
        self._stderr_tail: deque[str] = deque(maxlen=30)
        self._reader: asyncio.Task[None] | None = None
        self._err_task: asyncio.Task[None] | None = None
        self.ever_ready = False
        self.last_error: str | None = None
        self.gave_up = False
        self.restarts = 0
        self.max_restarts = 5
        self._supervise_stop = asyncio.Event()

    @property
    def healthy(self) -> bool:
        return (
            self.proc is not None
            and self.proc.returncode is None
            and self.ready.is_set()
        )

    async def start(self) -> None:
        async with self._life_lock:
            if self.gave_up:
                raise RuntimeError("worker 重启次数已用尽")
            if self.healthy:
                return
            try:
                await self._spawn()
            except Exception as exc:
                self.last_error = str(exc)
                raise
            self.ever_ready = True
            self.last_error = None

    async def supervise(self) -> None:
        """初次启动失败后，隔几秒再试。进程曾经就绪过就不再从这里拉起。"""
        while not self._supervise_stop.is_set():
            try:
                await asyncio.wait_for(self._supervise_stop.wait(), timeout=5)
                return
            except TimeoutError:
                pass
            if (
                self._supervise_stop.is_set()
                or self.gave_up
                or self.healthy
                or self.ever_ready
            ):
                continue
            try:
                await self.start()
            except Exception:
                log.warning("worker 仍未就绪", exc_info=True)

    def stop_supervise(self) -> None:
        self._supervise_stop.set()

    def unavailable_reason(self) -> str | None:
        if self.healthy:
            return None
        if self.gave_up:
            return "worker 重启次数已用尽"
        if self.last_error and not self.ever_ready:
            return "worker 未能启动"
        return None

    async def ensure_started(self) -> None:
        if self.healthy:
            return
        await self.start()

    async def close(self) -> None:
        async with self._life_lock:
            proc = self.proc
            if proc is None or proc.returncode is not None:
                self._fail_pending("worker 已关闭")
                return
            try:
                await self._send({"type": "shutdown"})
            except Exception:
                log.debug("发送 shutdown 失败", exc_info=True)
            try:
                await asyncio.wait_for(proc.wait(), 15)
            except TimeoutError:
                proc.kill()
                await proc.wait()
            self.ready.clear()
            self._fail_pending("worker 已关闭")

    async def restart(self) -> None:
        if self.restarts >= self.max_restarts:
            self.gave_up = True
            raise RuntimeError("worker 重启次数已用尽")
        self.restarts += 1
        await self.close()
        await self.start()

    async def cancel(self, request_id: str) -> None:
        await self._send({"type": "cancel", "requestId": request_id})

    async def approve(self, request_id: str, approval_id: str, choice: str) -> None:
        """写一行审批选择。不新开一轮，也不打断正在读的输出。"""
        await self._send(
            {
                "type": "approval",
                "requestId": request_id,
                "approvalId": approval_id,
                "choice": choice,
            }
        )

    async def run(
        self,
        request_id: str,
        payload: dict,
        on_started: Callable[[], Awaitable[None]] | None = None,
    ) -> AsyncIterator[dict]:
        if request_id in self._pending:
            raise RuntimeError("重复的 requestId")
        queue: asyncio.Queue[dict] = asyncio.Queue()
        self._pending[request_id] = queue
        try:
            await self._send(payload)
            if on_started is not None:
                await on_started()
            while True:
                msg = await queue.get()
                yield msg
                if msg.get("type") in ("result", "error"):
                    return
        finally:
            self._pending.pop(request_id, None)

    async def _spawn(self) -> None:
        self._generation += 1
        generation = self._generation
        self.ready = asyncio.Event()
        self._dead = asyncio.Event()
        self._stderr_tail.clear()
        log.info("启动 worker：%s", " ".join(self.cmd))
        self.proc = await asyncio.create_subprocess_exec(
            *self.cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.cwd),
            env=os.environ.copy(),
        )
        self._reader = asyncio.create_task(self._read_stdout(generation))
        self._err_task = asyncio.create_task(self._drain_stderr(generation))

        ready_task = asyncio.create_task(self.ready.wait())
        dead_task = asyncio.create_task(self._dead.wait())
        done, pending = await asyncio.wait(
            {ready_task, dead_task},
            timeout=self.ready_timeout_s,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if self.ready.is_set():
            return
        proc = self.proc
        if proc is not None and proc.returncode is None:
            proc.kill()
            await proc.wait()
        tail = "\n".join(self._stderr_tail).strip()
        code = None if proc is None else proc.returncode
        hint = f"最近输出：{tail}" if tail else "无 stderr 输出"
        waited = "超时" if not done else "进程退出"
        raise RuntimeError(f"worker 未能启动（{waited}，exit={code}）。{hint}")

    async def _send(self, msg: dict) -> None:
        async with self._write_lock:
            proc = self.proc
            if proc is None or proc.stdin is None or proc.returncode is not None:
                raise RuntimeError("worker 未启动")
            data = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
            proc.stdin.write(data)
            await proc.stdin.drain()

    async def _read_stdout(self, generation: int) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                if generation != self._generation:
                    return
                text = raw.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    log.warning("忽略无法解析的 worker 输出：%s", text[:200])
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "ready":
                    self.ready.set()
                    continue
                request_id = msg.get("requestId")
                if isinstance(request_id, str):
                    queue = self._pending.get(request_id)
                    if queue is not None:
                        queue.put_nowait(msg)
                    else:
                        log.info("收到无订阅者的消息：%s", msg.get("type"))
                elif msg.get("type") == "error":
                    log.error("worker：%s", msg.get("message"))
        finally:
            if generation == self._generation:
                self._dead.set()
                self.ready.clear()
                self._fail_pending("worker 进程已退出")

    async def _drain_stderr(self, generation: int) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                return
            if generation != self._generation:
                return
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            self._stderr_tail.append(line)
            log.info("worker: %s", line)

    def _fail_pending(self, message: str) -> None:
        for request_id, queue in list(self._pending.items()):
            queue.put_nowait(
                {"type": "error", "requestId": request_id, "message": message}
            )
