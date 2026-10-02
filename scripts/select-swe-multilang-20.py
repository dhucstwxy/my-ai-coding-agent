#!/usr/bin/env python3
"""从 SWE-bench-Live/MultiLang 按固定配额抽取 20 题。

需要：Python >= 3.10，pip install -r scripts/requirements-swe-select.txt
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

QUOTA: dict[str, int] = {
    "ts": 4,
    "js": 3,
    "java": 3,
    "go": 2,
    "rust": 2,
    "cpp": 2,
    "c": 2,
    "cs": 2,
}
SPLITS: list[str] = list(QUOTA.keys())
DEFAULT_SEED = 42
DATASET = "SWE-bench-Live/MultiLang"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_gold_ids(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    ids: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as err:
                raise SystemExit(f"gold jsonl 解析失败：{err}") from err
            iid = obj.get("instance_id")
            if not iid:
                raise SystemExit(f"gold jsonl 行缺少 instance_id：{line[:120]}")
            ids.add(str(iid))
        else:
            ids.add(line)
    return ids


def sample_split(
    rows: list[dict[str, Any]],
    *,
    split: str,
    need: int,
    rng: random.Random,
    gold: set[str] | None,
) -> list[dict[str, Any]]:
    candidates = rows
    if gold is not None:
        candidates = [r for r in rows if r["instance_id"] in gold]
    shuffled = list(candidates)
    rng.shuffle(shuffled)
    picked: list[dict[str, Any]] = []
    seen_repos: set[str] = set()
    for row in shuffled:
        repo = row["repo"]
        if repo in seen_repos:
            continue
        seen_repos.add(repo)
        picked.append(
            {
                "instance_id": row["instance_id"],
                "split": split,
                "repo": repo,
                "docker_image": row.get("docker_image"),
                "created_at": row.get("created_at"),
            }
        )
        if len(picked) >= need:
            break
    if len(picked) < need:
        raise SystemExit(
            f"split={split} 候选不足：需要 {need}，"
            f"去重后仅 {len(picked)}（过滤前 {len(candidates)}）"
        )
    return picked


def load_split_rows(split: str) -> list[dict[str, Any]]:
    try:
        from datasets import load_dataset
    except ImportError as err:
        raise SystemExit(
            "未安装 datasets。请先执行：pip install -r scripts/requirements-swe-select.txt"
        ) from err

    try:
        ds = load_dataset(DATASET, split=split)
    except Exception as err:  # noqa: BLE001 — 转为可读退出
        raise SystemExit(f"加载数据集失败（split={split}）：{err}") from err

    rows: list[dict[str, Any]] = []
    for item in ds:
        rows.append(
            {
                "instance_id": item["instance_id"],
                "repo": item["repo"],
                "docker_image": item.get("docker_image"),
                "created_at": item.get("created_at"),
            }
        )
    return rows


def write_outputs(out_dir: Path, payload: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "selected-20.json"
    ids_path = out_dir / "selected-20-ids.txt"
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    ids = [it["instance_id"] for it in payload["items"]]
    ids_path.write_text("\n".join(ids) + "\n", encoding="utf-8")
    print(f"已写入：{json_path}")
    print(f"已写入：{ids_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="从 SWE-bench-Live/MultiLang 抽取固定配额的 20 题"
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--gold",
        type=Path,
        default=None,
        help="可选：gold 通过 instance_id 列表（jsonl 或纯文本）",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="输出目录（默认 tests/eval/swe-multilang）",
    )
    args = parser.parse_args(argv)

    out_dir = args.out_dir or (repo_root() / "tests" / "eval" / "swe-multilang")
    gold: set[str] | None = None
    gold_source: str | None = None
    if args.gold is not None:
        gold_path = args.gold if args.gold.is_absolute() else repo_root() / args.gold
        if not gold_path.exists():
            raise SystemExit(f"找不到 gold 文件：{gold_path}")
        gold = load_gold_ids(gold_path)
        gold_source = str(gold_path)
        print(f"已加载 gold ids：{len(gold)}")

    rng = random.Random(args.seed)
    items: list[dict[str, Any]] = []
    for split in SPLITS:
        print(f"加载 split={split} …")
        rows = load_split_rows(split)
        picked = sample_split(
            rows,
            split=split,
            need=QUOTA[split],
            rng=rng,
            gold=gold,
        )
        items.extend(picked)
        print(f"  选中 {len(picked)} / 配额 {QUOTA[split]}")

    # 稳定排序：先按 SPLITS 顺序，再按 instance_id
    split_rank = {s: i for i, s in enumerate(SPLITS)}
    items.sort(key=lambda x: (split_rank[x["split"]], x["instance_id"]))

    if len(items) != 20:
        raise SystemExit(f"内部错误：期望 20 题，实际 {len(items)}")

    payload = {
        "version": 1,
        "dataset": DATASET,
        "seed": args.seed,
        "goldFiltered": gold is not None,
        "goldSource": gold_source,
        "quota": QUOTA,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(items),
        "items": items,
    }
    write_outputs(out_dir, payload)

    print("摘要：")
    for split in SPLITS:
        n = sum(1 for it in items if it["split"] == split)
        print(f"  {split}: {n}")
    print(f"goldFiltered={payload['goldFiltered']} seed={args.seed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
