"""用假 worker 验收 HTTP 层，不调用真实模型。"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from fastapi.testclient import TestClient

from mewcode_api.main import create_app

FAKE = Path(__file__).with_name("fake_worker.py")


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = self.tmp.name
        self.data_dir = str(Path(self.tmp.name) / "server-data")
        self._token = os.environ.pop("MEWCODE_SERVER_TOKEN", None)
        self._roots = os.environ.pop("MEWCODE_ALLOWED_ROOTS", None)
        self._data = os.environ.get("MEWCODE_SERVER_DATA")
        self._queued = os.environ.get("MEWCODE_MAX_QUEUED")
        os.environ["MEWCODE_SERVER_DATA"] = self.data_dir
        os.environ.pop("MEWCODE_MAX_QUEUED", None)
        self.addCleanup(self._restore_env)
        self.app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        self.client_cm = TestClient(self.app)
        self.client = self.client_cm.__enter__()
        self.addCleanup(self.client_cm.__exit__, None, None, None)

    def _restore_env(self) -> None:
        self._put("MEWCODE_SERVER_TOKEN", self._token)
        self._put("MEWCODE_ALLOWED_ROOTS", self._roots)
        self._put("MEWCODE_SERVER_DATA", self._data)
        self._put("MEWCODE_MAX_QUEUED", self._queued)

    @staticmethod
    def _put(key: str, value: str | None) -> None:
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def test_health_and_one_shot(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["worker"], "ready")

        created = self.client.post(
            "/v1/runs",
            json={"prompt": "只回复 pong", "workspace": self.workspace},
        )
        self.assertEqual(created.status_code, 202)
        run_id = created.json()["runId"]
        view = self._wait(run_id)
        self.assertEqual(view["status"], "completed")
        self.assertEqual(view["partialText"], "pong")
        self.assertEqual(view["report"]["finalMessage"], "pong")
        self.assertEqual(view["sessionId"], "sess-new")

        listed = self.client.get("/v1/runs")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()[0]["runId"], run_id)

    def test_sse_replays_done(self) -> None:
        created = self.client.post(
            "/v1/runs",
            json={"prompt": "hi", "workspace": self.workspace},
        )
        run_id = created.json()["runId"]
        self._wait(run_id)
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            self.assertEqual(resp.status_code, 200)
            body = "".join(resp.iter_text())
        self.assertIn("event: agent", body)
        self.assertIn("event: text", body)
        self.assertIn("event: done", body)
        self.assertIn("pong", body)

    def test_continue_session_and_reject_bad_id(self) -> None:
        bad = self.client.post(
            "/v1/runs",
            json={
                "prompt": "hi",
                "workspace": self.workspace,
                "sessionId": "../secret",
            },
        )
        self.assertEqual(bad.status_code, 400)

        created = self.client.post(
            "/v1/runs",
            json={
                "prompt": "继续",
                "workspace": self.workspace,
                "sessionId": "sess-new",
            },
        )
        self.assertEqual(created.status_code, 202)
        view = self._wait(created.json()["runId"])
        self.assertEqual(view["status"], "completed")
        self.assertEqual(view["sessionId"], "sess-new")

    def test_missing_workspace_and_unknown_run(self) -> None:
        missing = self.client.post(
            "/v1/runs",
            json={"prompt": "hi", "workspace": str(Path(self.workspace) / "nope")},
        )
        self.assertEqual(missing.status_code, 400)
        unknown = self.client.get("/v1/runs/does-not-exist")
        self.assertEqual(unknown.status_code, 404)

    def test_cancel_running(self) -> None:
        created = self.client.post(
            "/v1/runs",
            json={"prompt": "WAIT_CANCEL", "workspace": self.workspace},
        )
        run_id = created.json()["runId"]
        self._wait_status(run_id, "running")
        cancelled = self.client.post(f"/v1/runs/{run_id}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        view = self._wait(run_id)
        self.assertEqual(view["status"], "cancelled")

    def test_token_and_allowed_root(self) -> None:
        os.environ["MEWCODE_SERVER_TOKEN"] = "secret"
        denied = self.client.get("/v1/runs")
        self.assertEqual(denied.status_code, 401)
        allowed = self.client.get(
            "/v1/runs",
            headers={"Authorization": "Bearer secret"},
        )
        self.assertEqual(allowed.status_code, 200)
        open_health = self.client.get("/health")
        self.assertEqual(open_health.status_code, 200)

    def test_allowed_root(self) -> None:
        os.environ["MEWCODE_ALLOWED_ROOTS"] = self.workspace
        app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        outside = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        with TestClient(app) as client:
            blocked = client.post(
                "/v1/runs",
                json={"prompt": "hi", "workspace": outside},
            )
            self.assertEqual(blocked.status_code, 403)
            inside = client.post(
                "/v1/runs",
                json={"prompt": "hi", "workspace": self.workspace},
            )
            self.assertEqual(inside.status_code, 202)

    def test_wait_returns_final_message(self) -> None:
        empty = self.client.post(
            "/v1/runs/wait",
            json={"prompt": "   ", "workspace": self.workspace},
        )
        self.assertEqual(empty.status_code, 422)
        waited = self.client.post(
            "/v1/runs/wait",
            json={"prompt": "只回复 pong", "workspace": self.workspace},
        )
        self.assertEqual(waited.status_code, 200)
        body = waited.json()
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["report"]["finalMessage"], "pong")

    def test_chat_page_and_tool_events(self) -> None:
        page = self.client.get("/chat")
        self.assertEqual(page.status_code, 200)
        self.assertIn("MewCode", page.text)
        created = self.client.post(
            "/v1/runs",
            json={"prompt": "USE_TOOL", "workspace": self.workspace},
        )
        run_id = created.json()["runId"]
        self._wait(run_id)
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            body = "".join(resp.iter_text())
        self.assertIn("event: tool", body)
        self.assertIn("read_file", body)
        self.assertIn("event: text", body)

    def test_queue_limit(self) -> None:
        os.environ["MEWCODE_MAX_QUEUED"] = "1"
        os.environ["MEWCODE_SERVER_DATA"] = str(Path(self.tmp.name) / "queue-data")
        app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app) as client:
            first = client.post(
                "/v1/runs",
                json={"prompt": "WAIT_CANCEL", "workspace": self.workspace},
            )
            self.assertEqual(first.status_code, 202)
            second = client.post(
                "/v1/runs",
                json={"prompt": "另一个", "workspace": self.workspace},
            )
            self.assertEqual(second.status_code, 429)

    def test_idempotency_key(self) -> None:
        headers = {"Idempotency-Key": "job-1"}
        payload = {"prompt": "同一件事", "workspace": self.workspace}
        first = self.client.post("/v1/runs", json=payload, headers=headers)
        second = self.client.post("/v1/runs", json=payload, headers=headers)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()["runId"], second.json()["runId"])
        conflict = self.client.post(
            "/v1/runs",
            json={"prompt": "另一件事", "workspace": self.workspace},
            headers=headers,
        )
        self.assertEqual(conflict.status_code, 409)

    def test_history_survives_restart(self) -> None:
        data = str(Path(self.tmp.name) / "history-data")
        os.environ["MEWCODE_SERVER_DATA"] = data
        app1 = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app1) as client:
            waited = client.post(
                "/v1/runs/wait",
                json={"prompt": "记下这次", "workspace": self.workspace},
            )
            self.assertEqual(waited.status_code, 200)
            run_id = waited.json()["runId"]
        app2 = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app2) as client:
            view = client.get(f"/v1/runs/{run_id}")
            self.assertEqual(view.status_code, 200)
            self.assertEqual(view.json()["report"]["finalMessage"], "pong")
            with client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
                body = "".join(resp.iter_text())
            self.assertIn("event: text", body)
            self.assertIn("pong", body)

    def test_resume_and_cancelled_stay(self) -> None:
        data = Path(self.tmp.name) / "resume-data"
        runs = data / "runs"
        runs.mkdir(parents=True)
        run_id = "11111111-1111-1111-1111-111111111111"
        record = {
            "runId": run_id,
            "status": "running",
            "workspace": self.workspace,
            "prompt": "继续干活",
            "sessionId": "sess-keep",
            "timeoutMs": 60000,
            "sessionsDir": str(Path(self.workspace) / ".mewcode" / "api-sessions"),
            "partialText": "半截",
            "error": None,
            "report": None,
            "cancelRequested": False,
            "createdAt": "2026-01-01T00:00:00Z",
            "startedAt": "2026-01-01T00:00:01Z",
            "endedAt": None,
            "inputCommitted": True,
            "attempt": 0,
            "idempotencyKey": None,
        }
        (runs / f"{run_id}.json").write_text(
            json.dumps(record, ensure_ascii=False),
            encoding="utf-8",
        )
        os.environ["MEWCODE_SERVER_DATA"] = str(data)
        app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app) as client:
            view = self._wait_on(client, run_id)
            self.assertEqual(view["status"], "completed")
            self.assertEqual(view["sessionId"], "sess-keep")
            self.assertTrue(view["report"]["resumed"])

        cancelled_id = "22222222-2222-2222-2222-222222222222"
        cancelled = dict(record)
        cancelled["runId"] = cancelled_id
        cancelled["status"] = "cancelled"
        cancelled["cancelRequested"] = True
        cancelled["endedAt"] = "2026-01-01T00:01:00Z"
        cancel_dir = Path(self.tmp.name) / "cancel-data" / "runs"
        cancel_dir.mkdir(parents=True)
        (cancel_dir / f"{cancelled_id}.json").write_text(
            json.dumps(cancelled, ensure_ascii=False),
            encoding="utf-8",
        )
        os.environ["MEWCODE_SERVER_DATA"] = str(cancel_dir.parent)
        app2 = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app2) as client:
            view = client.get(f"/v1/runs/{cancelled_id}")
            self.assertEqual(view.status_code, 200)
            self.assertEqual(view.json()["status"], "cancelled")
            time.sleep(0.2)
            again = client.get(f"/v1/runs/{cancelled_id}")
            self.assertEqual(again.json()["status"], "cancelled")

    def test_worker_down_returns_503(self) -> None:
        os.environ["MEWCODE_SERVER_DATA"] = str(Path(self.tmp.name) / "down-data")
        app = create_app(worker_cmd=[sys.executable, "-c", "import sys; sys.exit(3)"])
        with TestClient(app) as client:
            health = client.get("/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["worker"], "down")
            denied = client.post(
                "/v1/runs",
                json={"prompt": "hi", "workspace": self.workspace},
            )
            self.assertEqual(denied.status_code, 503)

    def test_restart_budget(self) -> None:
        import asyncio

        from mewcode_api.worker_client import WorkerClient

        worker = WorkerClient([sys.executable, str(FAKE)], Path(self.workspace))
        worker.max_restarts = 1
        worker.restarts = 1
        with self.assertRaises(RuntimeError):
            asyncio.run(worker.restart())
        self.assertTrue(worker.gave_up)
        self.assertIn("用尽", worker.unavailable_reason() or "")

    def test_create_and_list_session(self) -> None:
        created = self._create_session()
        self.assertEqual(created["label"], "新对话")
        self.assertFalse(created["busy"])
        listed = self.client.get(
            "/v1/sessions",
            params={"workspace": self.workspace},
        )
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()[0]["sessionId"], created["sessionId"])
        self.assertEqual(listed.json()[0]["label"], "新对话")

    def test_session_order_and_workspace_isolation(self) -> None:
        first = self._create_session()
        second = self._create_session()
        root = Path(self.workspace) / ".mewcode" / "api-sessions"
        os.utime(root / f"{first['sessionId']}.jsonl", (1_700_000_000, 1_700_000_000))
        os.utime(root / f"{second['sessionId']}.jsonl", (1_800_000_000, 1_800_000_000))
        listed = self.client.get(
            "/v1/sessions",
            params={"workspace": self.workspace},
        ).json()
        self.assertEqual(listed[0]["sessionId"], second["sessionId"])
        other = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(other, ignore_errors=True))
        elsewhere = self.client.get("/v1/sessions", params={"workspace": other})
        self.assertEqual(elsewhere.status_code, 200)
        self.assertEqual(elsewhere.json(), [])
        missing = self.client.get(
            f"/v1/sessions/{first['sessionId']}",
            params={"workspace": other},
        )
        self.assertEqual(missing.status_code, 404)

    def test_session_messages_hide_tools_and_label(self) -> None:
        created = self._create_session()
        session_id = created["sessionId"]
        sent = self._send(session_id, "只回复 pong")
        self.assertEqual(sent.status_code, 202)
        self._wait(sent.json()["runId"])
        path = (
            Path(self.workspace)
            / ".mewcode"
            / "api-sessions"
            / f"{session_id}.jsonl"
        )
        path.write_text(
            path.read_text(encoding="utf-8")
            + json.dumps(
                {
                    "type": "message",
                    "id": "tool-1",
                    "role": "tool",
                    "content": "secret-tool",
                    "createdAt": "2026-01-01T00:00:02Z",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        opened = self.client.get(
            f"/v1/sessions/{session_id}",
            params={"workspace": self.workspace},
        )
        self.assertEqual(opened.status_code, 200)
        roles = [item["role"] for item in opened.json()["messages"]]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertEqual(opened.json()["messages"][0]["content"], "只回复 pong")
        self.assertEqual(opened.json()["messages"][1]["content"], "pong")
        self.assertNotIn("secret-tool", opened.text)
        long_text = "字" * 50
        path.write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "type": "session",
                            "id": session_id,
                            "title": "新会话",
                            "createdAt": created["createdAt"],
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "type": "message",
                            "id": "u-long",
                            "role": "user",
                            "content": long_text,
                            "createdAt": "2026-01-01T00:00:03Z",
                        },
                        ensure_ascii=False,
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        listed = self.client.get(
            "/v1/sessions",
            params={"workspace": self.workspace},
        ).json()
        matched = next(item for item in listed if item["sessionId"] == session_id)
        self.assertEqual(matched["label"], ("字" * 40) + "…")

    def test_session_events_and_late_subscribe(self) -> None:
        created = self._create_session()
        sent = self._send(created["sessionId"], "USE_TOOL")
        run_id = sent.json()["runId"]
        self._wait(run_id)
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            body = "".join(resp.iter_text())
        self.assertIn("event: tool", body)
        self.assertIn("event: text", body)
        self.assertIn("event: done", body)
        self.assertIn("pong", body)
        self.assertIn("read_file", body)

    def test_session_busy_then_other_session_queues(self) -> None:
        first = self._create_session()["sessionId"]
        second = self._create_session()["sessionId"]
        held = self._send(first, "WAIT_CANCEL")
        self.assertEqual(held.status_code, 202)
        busy = self._send(first, "另一句")
        self.assertEqual(busy.status_code, 409)
        self.assertIn("正忙", busy.text)
        queued = self._send(second, "只回复 pong")
        self.assertEqual(queued.status_code, 202)
        cancelled = self.client.post(f"/v1/runs/{held.json()['runId']}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        self._wait(held.json()["runId"])
        again = self._send(first, "只回复 pong")
        self.assertEqual(again.status_code, 202)
        self._wait(again.json()["runId"])

    def test_session_queue_full_matches_runs(self) -> None:
        os.environ["MEWCODE_MAX_QUEUED"] = "1"
        os.environ["MEWCODE_SERVER_DATA"] = str(Path(self.tmp.name) / "session-queue")
        app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app) as client:
            first = client.post(
                "/v1/sessions",
                json={"workspace": self.workspace},
            ).json()["sessionId"]
            second = client.post(
                "/v1/sessions",
                json={"workspace": self.workspace},
            ).json()["sessionId"]
            held = client.post(
                f"/v1/sessions/{first}/messages",
                json={"prompt": "WAIT_CANCEL", "workspace": self.workspace},
            )
            self.assertEqual(held.status_code, 202)
            blocked = client.post(
                f"/v1/sessions/{second}/messages",
                json={"prompt": "只回复 pong", "workspace": self.workspace},
            )
            run_blocked = client.post(
                "/v1/runs",
                json={"prompt": "另一个", "workspace": self.workspace},
            )
            self.assertEqual(blocked.status_code, 429)
            self.assertEqual(run_blocked.status_code, 429)
            self.assertIn("排队任务已满", blocked.text)

    def test_session_errors_and_token(self) -> None:
        missing = self.client.post(
            "/v1/sessions",
            json={"workspace": str(Path(self.workspace) / "nope")},
        )
        self.assertEqual(missing.status_code, 400)
        self.assertIn("工作区不存在", missing.text)
        created = self._create_session()
        blank = self._send(created["sessionId"], "   ")
        self.assertEqual(blank.status_code, 422)
        bad = self.client.get(
            "/v1/sessions/bad id",
            params={"workspace": self.workspace},
        )
        self.assertEqual(bad.status_code, 400)
        os.environ["MEWCODE_SERVER_TOKEN"] = "secret"
        denied = self.client.post(
            "/v1/sessions",
            json={"workspace": self.workspace},
        )
        self.assertEqual(denied.status_code, 401)
        denied_list = self.client.get(
            "/v1/sessions",
            params={"workspace": self.workspace},
        )
        self.assertEqual(denied_list.status_code, 401)
        opened = self.client.get(
            f"/v1/sessions/{created['sessionId']}",
            params={"workspace": self.workspace},
        )
        self.assertEqual(opened.status_code, 401)
        sent = self._send(created["sessionId"], "只回复 pong")
        self.assertEqual(sent.status_code, 401)
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        allowed = self.client.get(
            "/v1/sessions",
            params={"workspace": self.workspace},
            headers={"Authorization": "Bearer secret"},
        )
        self.assertEqual(allowed.status_code, 200)

    def test_default_workspace_and_worker_down_still_lists(self) -> None:
        os.environ["MEWCODE_WORKSPACE"] = self.workspace
        self.addCleanup(lambda: os.environ.pop("MEWCODE_WORKSPACE", None))
        created = self.client.post("/v1/sessions", json={})
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["workspace"], str(Path(self.workspace).resolve()))
        os.environ["MEWCODE_SERVER_DATA"] = str(Path(self.tmp.name) / "down-sessions")
        app = create_app(worker_cmd=[sys.executable, "-c", "import sys; sys.exit(3)"])
        with TestClient(app) as client:
            made = client.post("/v1/sessions", json={"workspace": self.workspace})
            self.assertEqual(made.status_code, 200)
            listed = client.get("/v1/sessions", params={"workspace": self.workspace})
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(listed.json()[0]["sessionId"], made.json()["sessionId"])
            denied = client.post(
                f"/v1/sessions/{made.json()['sessionId']}/messages",
                json={"prompt": "hi", "workspace": self.workspace},
            )
            self.assertEqual(denied.status_code, 503)

    def test_session_survives_restart_without_saved_id(self) -> None:
        created = self._create_session()
        sent = self._send(created["sessionId"], "记下这次")
        self._wait(sent.json()["runId"])
        app2 = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app2) as client:
            listed = client.get("/v1/sessions", params={"workspace": self.workspace})
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(listed.json()[0]["sessionId"], created["sessionId"])
            opened = client.get(
                f"/v1/sessions/{created['sessionId']}",
                params={"workspace": self.workspace},
            )
            self.assertEqual(opened.json()["messages"][0]["content"], "记下这次")
            again = client.post(
                f"/v1/sessions/{created['sessionId']}/messages",
                json={"prompt": "只回复 pong", "workspace": self.workspace},
            )
            self.assertEqual(again.status_code, 202)

    def test_resume_does_not_duplicate_user_message(self) -> None:
        session_id = "20260101-000000-abc123"
        sessions = Path(self.workspace) / ".mewcode" / "api-sessions"
        sessions.mkdir(parents=True)
        path = sessions / f"{session_id}.jsonl"
        path.write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "type": "session",
                            "id": session_id,
                            "title": "新会话",
                            "createdAt": "2026-01-01T00:00:00Z",
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {
                            "type": "message",
                            "id": "already",
                            "role": "user",
                            "content": "继续干活",
                            "createdAt": "2026-01-01T00:00:01Z",
                        },
                        ensure_ascii=False,
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        data = Path(self.tmp.name) / "session-resume"
        runs = data / "runs"
        runs.mkdir(parents=True)
        run_id = "33333333-3333-3333-3333-333333333333"
        record = {
            "runId": run_id,
            "status": "running",
            "workspace": self.workspace,
            "prompt": "继续干活",
            "sessionId": session_id,
            "timeoutMs": 60000,
            "sessionsDir": str(sessions),
            "partialText": "",
            "error": None,
            "report": None,
            "cancelRequested": False,
            "createdAt": "2026-01-01T00:00:00Z",
            "startedAt": "2026-01-01T00:00:01Z",
            "endedAt": None,
            "inputCommitted": True,
            "attempt": 0,
            "idempotencyKey": None,
        }
        (runs / f"{run_id}.json").write_text(
            json.dumps(record, ensure_ascii=False),
            encoding="utf-8",
        )
        os.environ["MEWCODE_SERVER_DATA"] = str(data)
        app = create_app(worker_cmd=[sys.executable, str(FAKE)])
        with TestClient(app) as client:
            view = self._wait_on(client, run_id)
            self.assertEqual(view["status"], "completed")
        users = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        user_hits = [
            item
            for item in users
            if item.get("role") == "user" and item.get("content") == "继续干活"
        ]
        self.assertEqual(len(user_hits), 1)
        self.assertFalse((Path(self.workspace) / ".mewcode" / "sessions").exists())

    def test_failed_turn_keeps_service_and_session(self) -> None:
        created = self._create_session()
        failed = self._send(created["sessionId"], "FAIL")
        view = self._wait(failed.json()["runId"])
        self.assertEqual(view["status"], "failed")
        self.assertIn("模型失败", view["error"] or "")
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        again = self._send(created["sessionId"], "只回复 pong")
        self.assertEqual(again.status_code, 202)
        self._wait(again.json()["runId"])

    def test_chat_page_uses_sessions(self) -> None:
        page = self.client.get("/chat")
        self.assertEqual(page.status_code, 200)
        self.assertIn("对话", page.text)
        self.assertIn("/v1/sessions", page.text)
        self.assertIn("这段对话正忙", page.text)
        self.assertNotIn("mewcode.sessionId", page.text)
        self.assertLess(page.text.index("status === 409"), page.text.index('addBlock("你"'))
        self.assertIn("/approval", page.text)
        for label in ("拒绝", "仅本次放行", "本会话放行", "永久放行"):
            self.assertIn(label, page.text)

    def test_session_approval_choices_and_conflicts(self) -> None:
        created = self._create_session()
        sent = self._send(created["sessionId"], "ASK")
        self.assertEqual(sent.status_code, 202)
        run_id = sent.json()["runId"]
        self._wait_status(run_id, "running")
        pending = None
        for _ in range(40):
            events = self.app.state.manager.get(run_id).events
            pending = next(
                (
                    item
                    for item in events
                    if item.get("event") == "approval"
                    and item.get("data", {}).get("status") == "pending"
                ),
                None,
            )
            if pending is not None:
                break
            time.sleep(0.05)
        self.assertIsNotNone(pending)
        self.assertEqual(
            pending["data"]["choices"],
            ["deny", "once", "session", "permanent"],
        )
        choice = self._choose(run_id, "once")
        self.assertEqual(choice.status_code, 200, choice.text)
        again = self.client.post(
            f"/v1/runs/{run_id}/approval",
            json={"approvalId": "ask-1", "choice": "once"},
        )
        self.assertEqual(again.status_code, 409)
        view = self._wait(run_id)
        self.assertEqual(view["status"], "completed")
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            body = "".join(resp.iter_text())
        self.assertIn("event: approval", body)
        for option in ("deny", "once", "session", "permanent"):
            self.assertIn(option, body)

        denied = self._send(created["sessionId"], "ASK")
        denied_id = denied.json()["runId"]
        refused = self._choose(denied_id, "deny")
        self.assertEqual(refused.status_code, 200, refused.text)
        refused_view = self._wait(denied_id)
        self.assertEqual(refused_view["status"], "failed")
        transcript = (
            Path(self.workspace)
            / ".mewcode"
            / "api-sessions"
            / f"{created['sessionId']}.jsonl"
        ).read_text(encoding="utf-8")
        self.assertNotIn("write_file", transcript)

    def test_cancel_approval_and_other_session_stays_queued(self) -> None:
        first = self._create_session()["sessionId"]
        second = self._create_session()["sessionId"]
        held = self._send(first, "ASK")
        run_id = held.json()["runId"]
        self._wait_status(run_id, "running")
        time.sleep(0.2)
        queued = self._send(second, "只回复 pong")
        self.assertEqual(queued.status_code, 202)
        busy = self._send(first, "另一句")
        self.assertEqual(busy.status_code, 409)
        cancelled = self.client.post(f"/v1/runs/{run_id}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        view = self._wait(run_id)
        self.assertEqual(view["status"], "cancelled")
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            body = "".join(resp.iter_text())
        self.assertIn('"status": "denied"', body)
        again = self._send(first, "只回复 pong")
        self.assertEqual(again.status_code, 202)
        self._wait(again.json()["runId"])
        self._wait(queued.json()["runId"])

    def test_one_shot_rejects_approval(self) -> None:
        created = self.client.post(
            "/v1/runs",
            json={"prompt": "ASK", "workspace": self.workspace},
        )
        run_id = created.json()["runId"]
        view = self._wait(run_id)
        self.assertEqual(view["status"], "completed")
        with self.client.stream("GET", f"/v1/runs/{run_id}/events") as resp:
            body = "".join(resp.iter_text())
        self.assertNotIn("event: approval", body)
        rejected = self.client.post(
            f"/v1/runs/{run_id}/approval",
            json={"approvalId": "ask-1", "choice": "once"},
        )
        self.assertEqual(rejected.status_code, 409)
        missing = self.client.post(
            "/v1/runs/missing-run/approval",
            json={"approvalId": "ask-1", "choice": "deny"},
        )
        self.assertEqual(missing.status_code, 404)
        bad_choice = self.client.post(
            f"/v1/runs/{run_id}/approval",
            json={"approvalId": "ask-1", "choice": "allow"},
        )
        self.assertEqual(bad_choice.status_code, 422)

        os.environ["MEWCODE_SERVER_TOKEN"] = "secret"
        denied = self.client.post(
            f"/v1/runs/{run_id}/approval",
            json={"approvalId": "ask-1", "choice": "deny"},
        )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(self.client.get("/health").status_code, 200)

    def _choose(self, run_id: str, choice: str):
        last = None
        for _ in range(50):
            last = self.client.post(
                f"/v1/runs/{run_id}/approval",
                json={"approvalId": "ask-1", "choice": choice},
            )
            if last.status_code != 409:
                return last
            time.sleep(0.05)
        return last

    def _create_session(self) -> dict:
        response = self.client.post(
            "/v1/sessions",
            json={"workspace": self.workspace},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _send(self, session_id: str, prompt: str):
        return self.client.post(
            f"/v1/sessions/{session_id}/messages",
            json={"prompt": prompt, "workspace": self.workspace},
        )

    def _wait_on(self, client: TestClient, run_id: str) -> dict:
        last = {}
        for _ in range(50):
            last = client.get(f"/v1/runs/{run_id}").json()
            if last["status"] in {"completed", "failed", "cancelled"}:
                return last
            time.sleep(0.05)
        self.fail(f"运行未结束：{json.dumps(last, ensure_ascii=False)}")

    def _wait(self, run_id: str) -> dict:
        last = {}
        for _ in range(50):
            last = self.client.get(f"/v1/runs/{run_id}").json()
            if last["status"] in {"completed", "failed", "cancelled"}:
                return last
            time.sleep(0.05)
        self.fail(f"运行未结束：{json.dumps(last, ensure_ascii=False)}")

    def _wait_status(self, run_id: str, status: str) -> dict:
        last = {}
        for _ in range(50):
            last = self.client.get(f"/v1/runs/{run_id}").json()
            if last["status"] == status:
                return last
            time.sleep(0.05)
        self.fail(f"未进入 {status}：{json.dumps(last, ensure_ascii=False)}")


if __name__ == "__main__":
    unittest.main()
