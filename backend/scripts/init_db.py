#!/usr/bin/env python3
"""一键建库：连上 Postgres，建 pgvector 扩展 + 所有表（幂等）。

用法：
  # 1) 装依赖（后端目录）
  pip3 install -r requirements.txt
  # 2) 给连接串（与后端 micall.env 同一个变量）
  export MICALL_DATABASE_DSN='postgresql://user:pass@host:5432/micall'
  #   或写进 backend/config/micall.env，再 set -a; . config/micall.env; set +a
  # 3) 建库
  PYTHONPATH=src python3 scripts/init_db.py

幂等：可反复跑（CREATE TABLE IF NOT EXISTS）。前提：库已存在、角色有建表/建扩展权限、
已装 pgvector 扩展包（apt install postgresql-1X-pgvector 或 RDS 控制台启用 vector）。
"""
import os
import sys
from pathlib import Path

DSN = (os.environ.get("MICALL_DATABASE_DSN") or os.environ.get("DATABASE_URL") or "").strip()
SCHEMA = Path(__file__).resolve().parents[1] / "src" / "micall" / "memory" / "schema.sql"


def main() -> int:
    if not DSN:
        print("✗ 未提供连接串。设 MICALL_DB_DSN='postgresql://user:pass@host:5432/micall'", file=sys.stderr)
        return 2
    try:
        import psycopg
    except ImportError:
        print("✗ 缺 psycopg：pip3 install 'psycopg[binary,pool]'", file=sys.stderr)
        return 2
    sql = SCHEMA.read_text(encoding="utf-8")
    try:
        with psycopg.connect(DSN, autocommit=True) as c:
            c.execute(sql)
            tables = c.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='public' ORDER BY table_name"
            ).fetchall()
    except Exception as e:
        print(f"✗ 建库失败：{e}", file=sys.stderr)
        print("  常见原因：pgvector 扩展未装（CREATE EXTENSION vector 失败）/ 无权限 / 连接串错。", file=sys.stderr)
        return 1
    print("✓ 建库完成。表：", ", ".join(t[0] for t in tables))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
