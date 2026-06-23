import logging

from .repository import InMemoryRepository, MemoryRepository

log = logging.getLogger("micall.memory")


def make_repository(config) -> MemoryRepository:
    """配了 database.dsn → Postgres 持久化（PgRepository），否则内存（重启即丢）。
    Pg 初始化失败（缺 psycopg/连不上）也不拖垮服务，回退内存并告警。"""
    dsn = ((getattr(config, "database", None) or {}).get("dsn") or "").strip()
    if dsn:
        try:
            from .pg_repository import PgRepository
            repo = PgRepository(dsn)
            log.info("仓储：Postgres 持久化已启用")
            return repo
        except Exception as e:
            log.warning("Postgres 仓储初始化失败，回退内存（重启即丢）：%r", e)
    return InMemoryRepository()


__all__ = ["InMemoryRepository", "MemoryRepository", "make_repository"]
