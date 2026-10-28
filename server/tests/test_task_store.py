"""任务库和步骤收集的单元测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from mewcode_api.step_collector import StepCollector
from mewcode_api.task_store import TaskStore, TaskStoreError


class TaskStoreTests(unittest.TestCase):
    def test_round_trip_and_step_sequence(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = TaskStore(Path(tmp.name))
        self.addCleanup(store.close)
        record = {
            "runId": "run-1",
            "status": "queued",
            "workspace": tmp.name,
            "sessionId": None,
            "prompt": "你好",
            "partialText": "",
            "error": None,
            "report": None,
            "cancelRequested": False,
            "createdAt": "2026-01-01T00:00:00Z",
            "startedAt": None,
            "endedAt": None,
            "timeoutMs": 1000,
            "sessionsDir": str(Path(tmp.name) / "sessions"),
            "inputCommitted": False,
            "attempt": 0,
            "idempotencyKey": None,
            "sessionTurn": True,
            "resume": False,
        }
        store.save_task(record)
        record["status"] = "completed"
        record["partialText"] = "好"
        store.save_task(record)
        loaded = store.load_tasks()
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]["runId"], "run-1")
        self.assertEqual(loaded[0]["status"], "completed")
        self.assertEqual(loaded[0]["partialText"], "好")
        self.assertIs(loaded[0]["sessionTurn"], True)
        self.assertEqual(store.append_step("run-1", {"kind": "thinking", "text": "想"}), 1)
        self.assertEqual(store.append_step("run-1", {"kind": "text", "text": "好"}), 2)
        steps = store.load_steps("run-1")
        self.assertEqual([item["seq"] for item in steps], [1, 2])
        self.assertEqual(steps[0]["kind"], "thinking")
        self.assertFalse((Path(tmp.name) / "runs").exists())

    def test_open_failure_names_the_store(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blocked = Path(tmp.name) / "tasks.sqlite"
        blocked.write_text("这不是数据库", encoding="utf-8")
        with self.assertRaises(TaskStoreError) as caught:
            TaskStore(Path(tmp.name))
        self.assertIn("任务库不可用", str(caught.exception))


class StepCollectorTests(unittest.TestCase):
    def test_completed_units_keep_order(self) -> None:
        collector = StepCollector()
        self.assertEqual(
            collector.observe({"type": "thinking_end", "summary": "先看"}),
            {"kind": "thinking", "text": "先看"},
        )
        self.assertIsNone(collector.observe({"type": "text_delta", "text": "上"}))
        self.assertIsNone(collector.observe({"type": "text_delta", "text": "半"}))
        self.assertEqual(
            collector.observe(
                {"type": "tool_execution_start", "id": "t1", "name": "read_file"}
            ),
            {"kind": "text", "text": "上半"},
        )
        collector.note_approval(
            {
                "approvalId": "ask-1",
                "status": "allowed",
                "tool": "read_file",
                "subject": "a.txt",
                "argsSummary": "读取",
                "choice": "once",
            }
        )
        collector.note_warning("工具提示")
        tool = collector.observe(
            {
                "type": "tool_execution_end",
                "id": "t1",
                "name": "read_file",
                "subject": "a.txt",
                "ok": True,
                "resultSummary": "读完了",
            }
        )
        self.assertEqual(tool["kind"], "tool")
        self.assertEqual(tool["tool"], "read_file")
        self.assertEqual(tool["subject"], "a.txt")
        self.assertIs(tool["ok"], True)
        self.assertEqual(tool["summary"], "读完了")
        self.assertEqual(tool["warnings"], ["工具提示"])
        self.assertEqual(tool["approval"]["status"], "allowed")
        self.assertIsNone(collector.observe({"type": "text_delta", "text": "下半"}))
        self.assertEqual(collector.flush(), {"kind": "text", "text": "下半"})

    def test_unfinished_tool_and_loose_warning_are_not_steps(self) -> None:
        collector = StepCollector()
        collector.note_warning("启动提示")
        self.assertIsNone(collector.flush())
        collector.observe({"type": "tool_execution_start", "name": "read_file"})
        self.assertIsNone(collector.flush())
        ended = collector.observe(
            {"type": "tool_execution_end", "name": "read_file", "ok": True}
        )
        self.assertEqual(ended["subject"], "")
        plain = StepCollector()
        plain.observe({"type": "text_delta", "text": "只有正文"})
        self.assertEqual(plain.flush(), {"kind": "text", "text": "只有正文"})

    def test_summary_hides_secrets(self) -> None:
        collector = StepCollector()
        collector.observe({"type": "tool_execution_start", "name": "read_file"})
        step = collector.observe(
            {
                "type": "tool_execution_end",
                "name": "read_file",
                "ok": True,
                "resultSummary": "key=sk-live-secret-value",
            }
        )
        self.assertNotIn("sk-live-secret-value", step["summary"])
        self.assertIn("sk-***", step["summary"])

    def test_approval_before_the_tool_still_attaches(self) -> None:
        collector = StepCollector()
        collector.note_warning("启动提示")
        collector.note_approval(
            {
                "approvalId": "ask-1",
                "status": "allowed",
                "tool": "write_file",
                "subject": "a.txt",
                "argsSummary": "写入",
                "choice": "once",
            }
        )
        self.assertIsNone(
            collector.observe({"type": "tool_execution_start", "name": "write_file"})
        )
        step = collector.observe(
            {
                "type": "tool_execution_end",
                "name": "write_file",
                "subject": "a.txt",
                "ok": True,
                "resultSummary": "写好了",
            }
        )
        self.assertEqual(step["approval"]["choice"], "once")
        self.assertEqual(step["warnings"], [])
