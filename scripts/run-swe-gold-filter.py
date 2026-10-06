#!/usr/bin/env python3
"""对 selected-20 跑官方 gold patch，过滤本机可 resolve 的实例并可选重抽。

用法（在本仓库根目录）：
  python scripts/run-swe-gold-filter.py

依赖：
  - 已 clone 的 SWE-bench-Live（默认 ../SWE-bench-Live）
  - Docker
  - pip install -e ../SWE-bench-Live
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Gold-filter selected-20 MultiLang instances")
    parser.add_argument(
        "--swe-live-dir",
        type=Path,
        default=None,
        help="SWE-bench-Live 仓库路径（默认仓库同级 ../SWE-bench-Live）",
    )
    parser.add_argument(
        "--ids-file",
        type=Path,
        default=None,
        help="instance_id 列表（默认 tests/eval/swe-multilang/selected-20-ids.txt）",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="官方 evaluation 输出目录（默认 tests/eval/swe-multilang/logs/gold）",
    )
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--overwrite", type=int, default=1)
    parser.add_argument(
        "--smoke",
        type=str,
        default=None,
        help="只跑指定一个 instance_id（冒烟）",
    )
    parser.add_argument(
        "--reselect",
        action="store_true",
        help="gold 完成后用成功列表重跑选题脚本（可能因配额不足失败）",
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default=None,
        help="数据集名或本地 jsonl；默认优先 selected-20-full.jsonl，否则 SWE-bench-Live/MultiLang",
    )
    args = parser.parse_args()

    root = repo_root()
    swe_dir = args.swe_live_dir or (root.parent / "SWE-bench-Live")
    ids_file = args.ids_file or (root / "tests" / "eval" / "swe-multilang" / "selected-20-ids.txt")
    output_dir = args.output_dir or (
        root / "tests" / "eval" / "swe-multilang" / "logs" / "gold"
    )
    local_full = root / "tests" / "eval" / "swe-multilang" / "selected-20-full.jsonl"
    dataset = args.dataset
    if dataset is None:
        dataset = str(local_full.resolve()) if local_full.is_file() else "SWE-bench-Live/MultiLang"
    else:
        ds_path = Path(dataset)
        if not ds_path.is_absolute():
            ds_path = (root / ds_path).resolve()
        if ds_path.is_file():
            dataset = str(ds_path)
        # else keep HF dataset name as-is

    if not swe_dir.is_dir():
        print(f"找不到 SWE-bench-Live：{swe_dir}", file=sys.stderr)
        print("请先：git clone https://github.com/microsoft/SWE-bench-Live.git", file=sys.stderr)
        return 1
    if not ids_file.is_file():
        print(f"找不到 ids 文件：{ids_file}", file=sys.stderr)
        return 1

    ids = [
        line.strip()
        for line in ids_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if args.smoke:
        ids = [args.smoke]

    if not ids:
        print("没有可评测的 instance_id", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "evaluation.evaluation",
        "--dataset",
        dataset,
        "--platform",
        "linux",
        "--patch_dir",
        "gold",
        "--output_dir",
        str(output_dir.resolve()),
        "--workers",
        str(args.workers),
        "--overwrite",
        str(args.overwrite),
        "--instance_ids",
        *ids,
    ]
    print("运行：", " ".join(cmd))
    print(f"cwd={swe_dir}")
    print(f"instances={len(ids)}")
    proc = subprocess.run(cmd, cwd=str(swe_dir))
    if proc.returncode != 0:
        return proc.returncode

    gold_jsonl = output_dir / "gold_patch_evaluated_instances.jsonl"
    results_json = output_dir / "results.json"
    results: dict = {}
    if results_json.is_file():
        results = json.loads(results_json.read_text(encoding="utf-8"))
        print("=== Gold 结果摘要 ===")
        print("success:", results.get("success"), results.get("success_ids"))
        print("failure:", results.get("failure"), results.get("failure_ids"))
        print("error:", results.get("error"), results.get("error_ids"))

    # 另写一份仅含成功 id 的文本，方便 --gold（与历史通过列表合并，避免 --smoke 覆盖）
    success_ids_path = output_dir / "gold-passed-ids.txt"
    prev: list[str] = []
    if success_ids_path.is_file():
        prev = [
            line.strip().lstrip("\ufeff")
            for line in success_ids_path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip().lstrip("\ufeff") and not line.strip().lstrip("\ufeff").startswith("#")
        ]
    passed: list[str] = []
    if gold_jsonl.is_file():
        for line in gold_jsonl.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            obj = json.loads(line)
            passed.append(obj["instance_id"])
    elif results:
        passed = list(results.get("success_ids") or [])

    # 本轮 failure 从通过列表剔除；success 并入
    failure_ids = set(results.get("failure_ids") or [])
    failure_ids |= set(results.get("error_ids") or [])
    merged: list[str] = []
    for i in prev:
        if i not in failure_ids and i not in merged:
            merged.append(i)
    for i in passed:
        if i not in failure_ids and i not in merged:
            merged.append(i)
    success_ids_path.write_text("\n".join(merged) + ("\n" if merged else ""), encoding="utf-8")
    print(f"已写入通过列表：{success_ids_path} ({len(merged)} 题；本轮成功 {len(passed)})")

    if args.reselect and success_ids_path.is_file():
        reselect = [
            sys.executable,
            str(root / "scripts" / "select-swe-multilang-20.py"),
            "--gold",
            str(success_ids_path),
            "--out-dir",
            str(root / "tests" / "eval" / "swe-multilang"),
        ]
        print("重抽选题：", " ".join(reselect))
        return subprocess.run(reselect, cwd=str(root)).returncode

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
