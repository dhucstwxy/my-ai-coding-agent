#!/usr/bin/env python3
"""用 crane（走 HTTP_PROXY）拉取 selected-20 镜像，再 docker load。

Docker Desktop 经系统代理拉 Hub 大层时常卡住；crane + 本地代理更稳。

用法（仓库根目录）：
  set HTTPS_PROXY=http://127.0.0.1:7892
  python scripts/pull-swe-images-crane.py

依赖：
  - docker
  - crane（可用 --crane 指定路径；默认在 PATH 或 logs/gold/tools/crane.exe）
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def find_crane(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    which = shutil.which("crane")
    if which:
        return Path(which)
    bundled = (
        repo_root()
        / "tests"
        / "eval"
        / "swe-multilang"
        / "logs"
        / "gold"
        / "tools"
        / "crane.exe"
    )
    if bundled.is_file():
        return bundled
    raise FileNotFoundError(
        "找不到 crane。请安装 google/go-containerregistry 的 crane，"
        "或放到 tests/eval/swe-multilang/logs/gold/tools/crane.exe"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="crane 拉取 selected-20 Docker 镜像")
    parser.add_argument("--crane", type=Path, default=None)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="selected-20.json（默认 tests/eval/swe-multilang/selected-20.json）",
    )
    parser.add_argument("--platform", default="linux/amd64")
    parser.add_argument(
        "--keep-tar",
        action="store_true",
        help="docker load 后保留 tar（默认删除以省磁盘）",
    )
    args = parser.parse_args()

    root = repo_root()
    manifest = args.manifest or (
        root / "tests" / "eval" / "swe-multilang" / "selected-20.json"
    )
    if not manifest.is_file():
        print(f"找不到清单：{manifest}", file=sys.stderr)
        return 1

    crane = find_crane(args.crane)
    outdir = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "images"
    cache = root / "tests" / "eval" / "swe-multilang" / "logs" / "gold" / "crane-cache"
    outdir.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    data = json.loads(manifest.read_text(encoding="utf-8"))
    images = [item["docker_image"] for item in data["items"]]

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    print(f"crane={crane}")
    print(f"proxy={proxy or '(未设置，若 Hub 超时请 export HTTPS_PROXY=http://127.0.0.1:7892)'}")
    print(f"images={len(images)}")

    ok = fail = skip = 0
    for i, img in enumerate(images, 1):
        tag = f"{img}:latest"
        inspect = subprocess.run(
            ["docker", "image", "inspect", tag],
            capture_output=True,
            text=True,
        )
        if inspect.returncode == 0:
            print(f"SKIP {i}/{len(images)} {img}")
            skip += 1
            continue

        safe = img.replace("/", "_").replace(":", "_").replace("\\", "_")
        tar = outdir / f"{safe}.tar"
        print(f"CRANE_PULL {i}/{len(images)} {img}")
        pull = subprocess.run(
            [
                str(crane),
                "pull",
                "--platform",
                args.platform,
                "--format",
                "legacy",
                "--cache_path",
                str(cache),
                img,
                str(tar),
            ],
        )
        if pull.returncode != 0:
            print(f"CRANE_FAIL {img} exit={pull.returncode}", file=sys.stderr)
            fail += 1
            continue

        print(f"DOCKER_LOAD {img} sizeMB={tar.stat().st_size / (1024 * 1024):.1f}")
        load_ok = False
        for attempt in range(1, 4):
            load = subprocess.run(["docker", "load", "-i", str(tar)])
            if load.returncode == 0:
                load_ok = True
                break
            print(
                f"LOAD_RETRY {img} attempt={attempt} exit={load.returncode}",
                file=sys.stderr,
            )
        if not load_ok:
            print(f"LOAD_FAIL {img}", file=sys.stderr)
            fail += 1
            continue

        if not args.keep_tar:
            tar.unlink(missing_ok=True)
        print(f"OK {i}/{len(images)} {img}")
        ok += 1

    print(f"done ok={ok} skip={skip} fail={fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
