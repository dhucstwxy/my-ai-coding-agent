"""JSON 行日志的格式。"""

from __future__ import annotations

import json
import logging
import sys
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from mewcode_api.jsonlog import JsonLineFormatter


class JsonLineTests(unittest.TestCase):
    def test_task_fields_are_one_json_line(self) -> None:
        record = logging.LogRecord(
            name="mewcode.runs",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="任务结束",
            args=(),
            exc_info=None,
        )
        record.event = "task.end"
        record.runId = "run-1"
        record.sessionId = "sess-1"
        record.status = "completed"
        record.durationMs = 12
        line = JsonLineFormatter().format(record)
        self.assertNotIn("\n", line)
        payload = json.loads(line)
        self.assertEqual(payload["message"], "任务结束")
        self.assertEqual(payload["event"], "task.end")
        self.assertEqual(payload["runId"], "run-1")
        self.assertEqual(payload["sessionId"], "sess-1")
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["durationMs"], 12)
        self.assertEqual(payload["level"], "info")

    def test_exception_stays_inside_one_line(self) -> None:
        try:
            raise RuntimeError("模型超时")
        except RuntimeError:
            exc_info = sys.exc_info()
        record = logging.LogRecord(
            name="mewcode.runs",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="任务失败",
            args=(),
            exc_info=exc_info,
        )
        line = JsonLineFormatter().format(record)
        self.assertNotIn("\n", line)
        payload = json.loads(line)
        self.assertIn("模型超时", payload["exception"])
        self.assertIn("RuntimeError", payload["exception"])
