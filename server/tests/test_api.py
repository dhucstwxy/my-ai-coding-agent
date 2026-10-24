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
