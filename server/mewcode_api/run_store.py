"""运行记录落盘。任务 JSON 与事件 JSONL 分开，避免正文增量把状态文件撑爆。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("mewcode.store")


class RunStore:
    def __init__(self, data_dir: Path):
        self.root = data_dir / "runs"

    def load_records(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        records: list[dict[str, Any]] = []
        for path in self.root.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("忽略损坏的运行记录 %s：%s", path.name, exc)
                continue
            if isinstance(raw, dict) and isinstance(raw.get("runId"), str):
                records.append(raw)
        return records

    def load_events(self, run_id: str, limit: int) -> list[dict[str, Any]]:
        path = self._events_path(run_id)
        if not path.is_file():
            return []
        events: list[dict[str, Any]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            log.warning("无法读取事件 %s：%s", path.name, exc)
            return []
        for line in lines[-limit:]:
            text = line.strip()
            if not text:
                continue
            try:
                item = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                events.append(item)
        return events

    def save_record(self, record: dict[str, Any]) -> None:
        run_id = record.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._record_path(run_id)
        tmp = path.with_suffix(".json.tmp")
        payload = json.dumps(record, ensure_ascii=False, indent=2)
        tmp.write_text(payload + "\n", encoding="utf-8")
        tmp.replace(path)

    def append_event(self, run_id: str, item: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        line = json.dumps(item, ensure_ascii=False)
        with self._events_path(run_id).open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def clear_events(self, run_id: str) -> None:
        path = self._events_path(run_id)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("无法清空事件 %s：%s", path.name, exc)

    def _record_path(self, run_id: str) -> Path:
        return self.root / f"{run_id}.json"

    def _events_path(self, run_id: str) -> Path:
        return self.root / f"{run_id}.events.jsonl"
