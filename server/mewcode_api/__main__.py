"""python server/mewcode_api/__main__.py 或在 server 目录下 python -m mewcode_api。"""

from __future__ import annotations

import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from mewcode_api.main import main

if __name__ == "__main__":
    main()
