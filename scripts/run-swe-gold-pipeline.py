#!/usr/bin/env python3
"""串行：crane 拉镜像 → docker load → gold 评测（跳过已通过）。

用法（仓库根目录）：
  set HTTPS_PROXY=http://127.0.0.1:7892
  python scripts/run-swe-gold-pipeline.py
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def ensure_image(root: Path, img: str) -> bool:
    tag = f"{img}:latest"

    def image_ok() -> bool:
        if subprocess.run(["docker", "image", "inspect", tag], capture_output=True).returncode != 0:
            return False
        # 探测层是否可解压（避免 load 成功但 create 500）
        probe = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "true", tag],
            capture_output=True,
            text=True,
        )
        if probe.returncode != 0:
            print(f"IMAGE_CORRUPT {img}，删除后重拉", file=sys.stderr)
            subprocess.run(["docker", "rmi", "-f", tag], capture_output=True)
            return False
        return True

    if image_ok():
        print(f"IMAGE_LOCAL {img}")
        return True

    crane = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "tools" / "crane.exe"
    if not crane.is_file():
        print(f"找不到 crane：{crane}", file=sys.stderr)
        return False

    outdir = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "images"
    cache = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "crane-cache"
    outdir.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    safe = img.replace("/", "_").replace(":", "_").replace("\\", "_")
    tar = outdir / f"{safe}.tar"

    print(f"CRANE_PULL {img}")
    # 大层经代理偶发卡死：带停滞检测，最多重试 3 次
    code = 1
    for attempt in range(1, 4):
        if tar.exists():
            tar.unlink(missing_ok=True)
        print(f"CRANE_ATTEMPT {attempt}/3", flush=True)
        proc = subprocess.Popen(
            [
                str(crane),
                "pull",
                "--platform",
                "linux/amd64",
                "--format",
                "legacy",
                "--cache_path",
                str(cache),
                img,
                str(tar),
            ],
            stdout=None,
            stderr=None,
        )

        def progress_bytes() -> int:
            total = tar.stat().st_size if tar.is_file() else 0
            if cache.is_dir():
                for p in cache.rglob("*"):
                    if p.is_file():
                        try:
                            total += p.stat().st_size
                        except OSError:
                            pass
            return total

        import time

        started = time.time()
        last_bytes = progress_bytes()
        last_grow = started
        stall_limit = 120  # 2 分钟无字节增长视为卡死
        hard_limit = 2400  # 单次最多 40 分钟
        code = 1
        while True:
            ret = proc.poll()
            if ret is not None:
                code = ret
                break
            now = time.time()
            if now - started > hard_limit:
                print(f"CRANE_TIMEOUT {img} attempt={attempt}", file=sys.stderr, flush=True)
                proc.kill()
                proc.wait(timeout=30)
                code = 124
                break
            cur = progress_bytes()
            if cur > last_bytes + 1024 * 100:  # 至少增长 100KB
                last_bytes = cur
                last_grow = now
                print(
                    f"CRANE_PROGRESS attempt={attempt} cache+tar={cur/1024/1024:.1f}MB "
                    f"elapsed={int(now-started)}s",
                    flush=True,
                )
            elif now - last_grow > stall_limit:
                print(
                    f"CRANE_STALL {img} attempt={attempt} no growth for {stall_limit}s "
                    f"(size={cur/1024/1024:.1f}MB)",
                    file=sys.stderr,
                    flush=True,
                )
                proc.kill()
                proc.wait(timeout=30)
                code = 125
                break
            time.sleep(15)

        if code == 0 and tar.is_file() and tar.stat().st_size > 0:
            break
        print(f"CRANE_RETRY {img} exit={code}", file=sys.stderr, flush=True)
    if code != 0 or not tar.is_file() or tar.stat().st_size == 0:
        print(f"CRANE_FAIL {img} exit={code}", file=sys.stderr, flush=True)
        return False

    load_ok = False
    for attempt in range(1, 4):
        print(f"DOCKER_LOAD attempt={attempt} {img}")
        if subprocess.run(["docker", "load", "-i", str(tar)]).returncode == 0:
            load_ok = True
            break
    if load_ok:
        tar.unlink(missing_ok=True)
    else:
        print(f"LOAD_FAIL {img}（保留 tar 以便重试）: {tar}", file=sys.stderr)
        return False

    if not image_ok():
        print(f"PROBE_FAIL {img}", file=sys.stderr)
        return False
    return True


def load_passed(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {
        line.strip().lstrip("\ufeff")
        for line in path.read_text(encoding="utf-8-sig").splitlines()
        if line.strip().lstrip("\ufeff") and not line.strip().lstrip("\ufeff").startswith("#")
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="串行 gold 过滤流水线")
    parser.add_argument("--start-from", type=str, default=None)
    parser.add_argument("--only", type=str, nargs="*", default=None)
    parser.add_argument("--skip-pull", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    manifest = root / "tests" / "eval" / "swe-multilang" / "selected-20.json"
    passed_path = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "gold-passed-ids.txt"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    items = data["items"]
    ids = [i["instance_id"] for i in items]
    img_by_id = {i["instance_id"]: i["docker_image"] for i in items}

    if args.only:
        ids = list(args.only)
    if args.start_from:
        if args.start_from not in ids:
            print(f"start-from 不在列表：{args.start_from}", file=sys.stderr)
            return 1
        ids = ids[ids.index(args.start_from) :]

    passed = load_passed(passed_path)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    print(f"proxy={proxy or '(未设置)'}")
    print(f"already_passed={len(passed)} remaining={len([i for i in ids if i not in passed])}")

    for n, iid in enumerate(ids, 1):
        if iid in passed:
            print(f"SKIP_PASSED {n}/{len(ids)} {iid}")
            continue

        print(f"\n=== {n}/{len(ids)} {iid} ===")
        if not args.skip_pull and not ensure_image(root, img_by_id[iid]):
            continue

        gold = subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "run-swe-gold-filter.py"),
                "--smoke",
                iid,
                "--overwrite",
                "1",
            ],
            cwd=str(root),
        )
        if gold.returncode != 0:
            print(f"GOLD_CMD_FAIL {iid} exit={gold.returncode}", file=sys.stderr)

        passed = load_passed(passed_path)
        print(f"PROGRESS passed={len(passed)}/20")

    print("PIPELINE_DONE")
    print("passed:", "\n".join(sorted(passed)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
