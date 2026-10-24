"""服务进程配置。"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# 与 src/run/types.ts 的 DEFAULT_RUN_TIMEOUT_MS 一致
DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
MAX_TIMEOUT_MS = 30 * 60 * 1000
PARTIAL_TEXT_LIMIT = 200_000
EVENT_BUFFER_LIMIT = 20_000
DEFAULT_MAX_QUEUED = 20
DEFAULT_MAX_RESUME_ATTEMPTS = 2
DEFAULT_MAX_WORKER_RESTARTS = 5
IDEMPOTENCY_TTL_S = 24 * 60 * 60


def repo_root() -> Path:
    # server/mewcode_api/settings.py -> 仓库根
    return Path(__file__).resolve().parents[2]


def resolve_worker_cmd(
    root: Path,
    override: list[str] | None = None,
) -> list[str]:
    if override:
        return list(override)
    raw = os.environ.get("MEWCODE_WORKER_CMD", "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "MEWCODE_WORKER_CMD 必须是 JSON 字符串数组，例如 "
                '\'["node","--import","tsx","src/index.ts","serve-worker"]\''
            ) from exc
        if (
            not isinstance(parsed, list)
            or not parsed
            or not all(isinstance(item, str) and item for item in parsed)
        ):
            raise RuntimeError("MEWCODE_WORKER_CMD 必须是非空 JSON 字符串数组")
        return parsed
    return [
        "node",
        "--import",
        "tsx",
        str(root / "src" / "index.ts"),
        "serve-worker",
    ]


def data_dir_from_env() -> Path:
    raw = os.environ.get("MEWCODE_SERVER_DATA", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".mewcode" / "server").resolve()


def positive_int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} 必须是正整数") from exc
    if value < 1:
        raise RuntimeError(f"{name} 必须是正整数")
    return value


def allowed_roots_from_env() -> list[Path]:
    raw = os.environ.get("MEWCODE_ALLOWED_ROOTS", "").strip()
    if not raw:
        return []
    roots: list[Path] = []
    for part in raw.split(os.pathsep):
        text = part.strip()
        if not text:
            continue
        roots.append(Path(text).expanduser().resolve())
    return roots


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    worker_cmd: list[str]
    allowed_roots: list[Path]
    data_dir: Path
    max_queued: int = DEFAULT_MAX_QUEUED
    max_resume_attempts: int = DEFAULT_MAX_RESUME_ATTEMPTS
    max_worker_restarts: int = DEFAULT_MAX_WORKER_RESTARTS
    ready_timeout_s: float = 30.0

    @classmethod
    def load(cls, worker_cmd: list[str] | None = None) -> Settings:
        root = repo_root()
        return cls(
            repo_root=root,
            worker_cmd=resolve_worker_cmd(root, worker_cmd),
            allowed_roots=allowed_roots_from_env(),
            data_dir=data_dir_from_env(),
            max_queued=positive_int_from_env("MEWCODE_MAX_QUEUED", DEFAULT_MAX_QUEUED),
            max_resume_attempts=positive_int_from_env(
                "MEWCODE_MAX_RESUME",
                DEFAULT_MAX_RESUME_ATTEMPTS,
            ),
            max_worker_restarts=positive_int_from_env(
                "MEWCODE_MAX_WORKER_RESTARTS",
                DEFAULT_MAX_WORKER_RESTARTS,
            ),
        )
