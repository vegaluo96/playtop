"""MiCall 后端入口。

  PYTHONPATH=src python3 -m micall.cli run-server     启动信令服务器（对接前端）
  PYTHONPATH=src python3 -m micall.cli spike          尺度一延迟 spike（钦定第一步）
  PYTHONPATH=src python3 -m micall.cli selfcheck      加载配置 + 报告各节点配置状态（铁律2）
  PYTHONPATH=src python3 -m micall.cli initdb         打印/执行 schema.sql
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import NODE_KEYS, Config, load_config


def _selfcheck(config: Config) -> int:
    print("=== MiCall 后端 selfcheck ===")
    s = config.server
    print(f"信令服务器：ws://{s.get('ws_host')}:{s.get('ws_port')}{s.get('path')}")
    print("接口配置节点（铁律2：endpoint/key 全配置化）：")
    all_ok = True
    for key in NODE_KEYS:
        node = config.node(key)
        state = "✓ 已配置" if node.configured else "· 未配置 → 回退 stub"
        if not node.configured:
            all_ok = False
        print(f"  {key:10s} [{node.provider or '—':18s}] {state}")
    print(f"全局默认：{config.global_defaults}")
    print(f"数据库 DSN：{'已配置' if config.database.get('dsn') else '未配置（骨架用内存仓储）'}")
    print("\n" + ("全部节点已配置，可接真实链路。" if all_ok
                  else "部分节点未配置：骨架以 stub 运行；注入 endpoint/key 后即切真实（逻辑不动）。"))
    return 0


def _initdb(config: Config) -> int:
    schema = Path(__file__).resolve().parent / "memory" / "schema.sql"
    dsn = config.database.get("dsn")
    if not dsn:
        print(f"未配置数据库 DSN。手动建表：psql <DSN> -f {schema}")
        print("（或设置 MICALL_DATABASE_DSN 后重跑本命令以自动执行。）")
        return 0
    try:
        import asyncpg  # noqa: F401
    except ImportError:
        print(f"需 asyncpg 才能自动执行。手动：psql {dsn} -f {schema}")
        return 1
    import asyncio

    async def run() -> None:
        import asyncpg

        conn = await asyncpg.connect(dsn)
        try:
            await conn.execute(schema.read_text(encoding="utf-8"))
        finally:
            await conn.close()

    asyncio.run(run())
    print("schema 已应用。")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="micall")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run-server", help="启动 WebSocket 信令服务器")
    sp = sub.add_parser("spike", help="尺度一延迟 spike（实测 LLM TTFT）")
    sp.add_argument("--node", default="llm_fast")
    sp.add_argument("--prompt-tokens", type=int, default=2000)
    sp.add_argument("--rounds", type=int, default=5)
    sp.add_argument("--model", default=None, help="临时覆盖模型名（横向对比不同模型）")
    sub.add_parser("selfcheck", help="报告配置 + 节点状态")
    sub.add_parser("initdb", help="应用/打印 schema.sql")
    args = ap.parse_args(argv)

    config = load_config()
    if args.cmd == "run-server":
        import asyncio
        import logging

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
        from .server import serve_forever

        try:
            asyncio.run(serve_forever(config))
        except KeyboardInterrupt:
            print("\n[micall] 已停止。")
        return 0
    if args.cmd == "spike":
        from .spike import run_spike

        run_spike(config, args.node, args.prompt_tokens, args.rounds, model=args.model)
        return 0
    if args.cmd == "selfcheck":
        return _selfcheck(config)
    if args.cmd == "initdb":
        return _initdb(config)
    return 1


if __name__ == "__main__":
    sys.exit(main())
