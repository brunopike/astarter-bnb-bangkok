"""Explicit opt-in reference persistence, never the default Control composition root."""
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from stark_trading_os.control.astarter.strategy_repository import BackendScopeSource

from .pool import PgRepositoryPool, PoolSettings
from .strategy_repository import PostgresStrategyRepository
from .synthetic_migration import TargetProfile


@dataclass(frozen=True)
class PostgresApplication:
    pool: PgRepositoryPool
    repository: PostgresStrategyRepository


@contextmanager
def open_application(conninfo: str, source: BackendScopeSource, *,
                     settings: PoolSettings = PoolSettings(), writable: bool = True,
                     profile: TargetProfile = TargetProfile.LOCAL_PG17,
                     ) -> Iterator[PostgresApplication]:
    pool = PgRepositoryPool(conninfo, settings=settings, writable=writable, profile=profile)
    try:
        pool.open()
        yield PostgresApplication(pool, PostgresStrategyRepository(pool, source))
    finally:
        pool.close()
