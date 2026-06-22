#!/usr/bin/env python3
"""MiCall 后端启动入口（systemd 专用）—— 自定位 src 加入 sys.path。

相对 PYTHONPATH=src 在 systemd 下不稳，会 `No module named 'micall'` 崩溃重启。
本脚本按**自身绝对位置**算出 backend/src 并加入 sys.path，无论 cwd / PYTHONPATH
如何都能 import 到 micall。等价于 `PYTHONPATH=src python3 -m micall.cli run-server`，
但零环境依赖，systemd 直接 `ExecStart=/usr/bin/python3 .../backend/run_server.py` 即可。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from micall.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["run-server"]))
