import logging
import os

from .repository import InMemoryRepository, MemoryRepository

log = logging.getLogger("micall.memory")


def make_repository(config) -> MemoryRepository:
    """配了 database.dsn → Postgres 持久化（PgRepository），否则内存（重启即丢）。
    Pg 初始化失败（缺 psycopg/连不上）默认回退内存并【醒目告警】——否则整库记忆悄悄变进程内、重启全丢
    而运营无感。生产可设 MICALL_REQUIRE_DB=1：配了 DSN 却连不上时直接 fail-fast（拒绝降级跑），
    避免「以为在持久化、其实没有」。"""
    dsn = ((getattr(config, "database", None) or {}).get("dsn") or "").strip()
    if dsn:
        try:
            from .pg_repository import PgRepository
            repo = PgRepository(dsn)
            log.info("仓储：Postgres 持久化已启用")
            return repo
        except Exception as e:
            if os.environ.get("MICALL_REQUIRE_DB", "").strip().lower() in ("1", "true", "yes"):
                log.error("Postgres 仓储初始化失败且 MICALL_REQUIRE_DB 已设 → 拒绝降级，启动中止：%r", e)
                raise
            log.error("⚠ Postgres 仓储初始化失败，已回退【内存】仓储：记忆不持久化、重启即丢！"
                      "请尽快排查 DSN/网络/psycopg。错误：%r", e)
    return InMemoryRepository()


__all__ = ["InMemoryRepository", "MemoryRepository", "make_repository"]
