#!/usr/bin/env python3
"""把 selected-20 的完整字段导出为本地 jsonl，供官方 evaluation --dataset 使用。

避免每次 gold 都重新拉整份 MultiLang。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ids-file",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--selected-json",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="默认 tests/eval/swe-multilang/selected-20-full.jsonl",
    )
    args = parser.parse_args()
    root = repo_root()
    ids_file = args.ids_file or (root / "tests/eval/swe-multilang/selected-20-ids.txt")
    selected_json = args.selected_json or (root / "tests/eval/swe-multilang/selected-20.json")
    out = args.out or (root / "tests/eval/swe-multilang/selected-20-full.jsonl")

    ids = [
        ln.strip()
        for ln in ids_file.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    meta = json.loads(selected_json.read_text(encoding="utf-8"))
    split_of = {it["instance_id"]: it["split"] for it in meta["items"]}

    try:
        from datasets import load_dataset
    except ImportError as err:
        raise SystemExit("需要 datasets：python -m pip install datasets") from err

    wanted = set(ids)
    found: dict[str, dict] = {}
    for split in sorted(set(split_of.values())):
        print(f"加载 split={split} …")
        ds = load_dataset("SWE-bench-Live/MultiLang", split=split)
        for row in ds:
            iid = row["instance_id"]
            if iid in wanted and iid not in found:
                found[iid] = dict(row)

    missing = [i for i in ids if i not in found]
    if missing:
        print("缺失 instance：", missing, file=sys.stderr)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for iid in ids:
            f.write(json.dumps(found[iid], ensure_ascii=False) + "\n")
    print(f"已写入 {len(ids)} 条：{out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
