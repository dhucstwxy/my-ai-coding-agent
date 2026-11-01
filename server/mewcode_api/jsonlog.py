"""把服务日志写成一行一个 JSON，输出到标准输出。"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

# 这些字段从 LogRecord 的 extra 抄进 JSON。任务事件必须带齐前五个。
TASK_KEYS = ("event", "runId", "sessionId", "status", "durationMs")
HTTP_KEYS = ("method", "path", "httpStatus")


class JsonLineFormatter(logging.Formatter):
    """一条日志一行 JSON。异常栈放进字段，避免把一行拆成多行。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in (*TASK_KEYS, *HTTP_KEYS):
            if key in record.__dict__:
                payload[key] = record.__dict__[key]
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    """根日志和 uvicorn 都走同一份 JSON 行。uvicorn 默认配置不再覆盖。"""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLineFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
