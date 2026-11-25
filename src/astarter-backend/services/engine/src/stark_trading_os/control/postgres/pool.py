"""Bounded native Psycopg pool; no automatic replay of writes."""
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from time import monotonic
from typing import Any, Self

import psycopg
from psycopg import Connection, generators, waiting
from psycopg.conninfo import conninfo_to_dict
from psycopg.pq import ExecStatus, PipelineStatus, TransactionStatus
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from stark_trading_os.control.astarter.strategy_repository import PersistenceConflict

from .access import RepositoryAccessContract, verify_access
from .pool_logging import protect
from .private_research_access import PrivateRole, verify_private_access
from .private_research_migration import PrivateTarget, private_profile_pins
from .synthetic_migration import TargetProfile


class CommitUnknown(RuntimeError):
    """COMMIT may have succeeded. Reconcile by request/hash; never assume not found = aborted."""


class PersistenceUnavailable(RuntimeError):
    """Sanitized native driver failure before acknowledged commit."""


def _private_transport(conninfo: str, kwargs: dict[str, Any] | None = None) -> None:
    params = conninfo_to_dict(conninfo)
    if (params.get('hostaddr') or params.get('service')
            or any((kwargs or {}).get(name) for name in ('hostaddr', 'service'))
            or any(os.environ.get(name) for name in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'))):
        raise ValueError('PRIVATE_POOL_CONFIGURATION')


class _PrivateConnection(Connection[dict[str, Any]]):
    @classmethod
    def connect(cls, conninfo: str = '', **kwargs: Any) -> Self:
        # Workers may connect later than pool construction; refuse libpq fallback there too.
        _private_transport(conninfo, kwargs)
        return super().connect(conninfo, **kwargs)


@dataclass(frozen=True)
class PoolSettings:
    min_size: int = 0
    max_size: int = 4
    acquire_timeout: float = 3.0
    connect_timeout: int = 5
    statement_timeout_ms: int = 5000
    lock_timeout_ms: int = 1000
    check_on_checkout: bool = False

    def __post_init__(self) -> None:
        if (type(self.min_size) is not int or type(self.max_size) is not int
                or type(self.connect_timeout) is not int
                or type(self.statement_timeout_ms) is not int
                or type(self.lock_timeout_ms) is not int
                or type(self.check_on_checkout) is not bool
                or type(self.acquire_timeout) not in {int, float}
                or not 0 <= self.min_size <= self.max_size <= 16 or self.max_size < 1
                or not 0 < self.acquire_timeout <= 30
                or not 1 <= self.connect_timeout <= 30
                or not 1 <= self.lock_timeout_ms <= self.statement_timeout_ms <= 30000):
            raise ValueError('PG2_POOL_BOUNDS')


class PgRepositoryPool:
    def __init__(self, conninfo: str, *, settings: PoolSettings = PoolSettings(),
                 writable: bool = True, profile: TargetProfile = TargetProfile.LOCAL_PG17,
                 access_contract: RepositoryAccessContract = (
                     RepositoryAccessContract.PG2_REFERENCE_V1),
                 private_target: PrivateTarget | None = None,
                 private_role: PrivateRole | None = None):
        if (type(writable) is not bool or type(profile) is not TargetProfile
                or type(access_contract) is not RepositoryAccessContract):
            raise ValueError('PG2_POOL_CONFIGURATION')
        if access_contract is RepositoryAccessContract.PRIVATE_RESEARCH_V1:
            if (type(private_target) is not PrivateTarget
                    or private_role not in {'runtime', 'issuer', 'cost'}
                    or private_target.profile is not profile):
                raise ValueError('PRIVATE_POOL_CONFIGURATION')
            private_profile_pins(profile, private_target.schema_version)
            _private_transport(conninfo)
            params = conninfo_to_dict(conninfo)
            if (params.get('host') != private_target.host
                    or params.get('hostaddr')
                    or params.get('port') != str(private_target.port)
                    or params.get('dbname') != private_target.database
                    or params.get('user') != getattr(private_target, private_role)
                    or (profile is TargetProfile.NEON_PG17_V1 and (
                        params.get('sslmode') != 'verify-full'
                        or params.get('channel_binding') != 'require'))):
                raise ValueError('PRIVATE_POOL_CONFIGURATION')
        elif private_target is not None or private_role is not None:
            raise ValueError('PRIVATE_POOL_CONFIGURATION')
        if access_contract is RepositoryAccessContract.Q08_RESEARCH_STUB_V1:
            from .research_access import research_profile_pin
            research_profile_pin(profile)
        if access_contract is RepositoryAccessContract.PUBLIC_DATA_V1:
            from .public_access import public_profile_pin
            public_profile_pin(profile)
            if profile is TargetProfile.NEON_PG17_V1:
                params = conninfo_to_dict(conninfo)
                if (params.get('sslmode') != 'verify-full'
                        or params.get('channel_binding') != 'require'):
                    raise ValueError('PUBLIC_TLS_CONFIGURATION')
        self.settings, self.writable, self.profile = settings, writable, profile
        self.access_contract = access_contract
        self.private_target, self.private_role = private_target, private_role
        private_class: dict[str, Any] = ({'connection_class': _PrivateConnection}
                                        if private_target is not None else {})
        self._pool: ConnectionPool[Connection[dict[str, Any]]] = ConnectionPool(
            conninfo, kwargs={'autocommit': True, 'row_factory': dict_row,
                             'connect_timeout': settings.connect_timeout,
                             'prepare_threshold': None},
            min_size=settings.min_size, max_size=settings.max_size,
            timeout=settings.acquire_timeout, max_waiting=16, open=False,
            reconnect_timeout=settings.connect_timeout, name='pg2-reference',
            **private_class,
        )
        protect(self._pool)

    def open(self) -> None:
        try:
            self._pool.open(wait=True, timeout=self.settings.acquire_timeout)
            # min_size=0 still requires a real handshake before returning application.
            with self.transaction():
                pass
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        self._pool.close(timeout=self.settings.connect_timeout)

    def _commit(self, connection: Connection[dict[str, Any]]) -> None:
        connection.execute('COMMIT')

    @staticmethod
    def _probe(connection: Connection[dict[str, Any]], deadline: float) -> None:
        pg = connection.pgconn
        if (not connection.autocommit or not pg.nonblocking
                or pg.transaction_status != TransactionStatus.IDLE
                or pg.pipeline_status != PipelineStatus.OFF):
            raise psycopg.OperationalError('PG2_CHECKOUT_STATE')
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise PoolTimeout('PG2_CHECKOUT_TIMEOUT')
        # Empty protocol query: no business SQL, transaction, or session-setting mutation.
        pg.send_query(b'')
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise PoolTimeout('PG2_CHECKOUT_TIMEOUT')
        results = waiting.wait(generators.execute(pg), pg.socket,
                               interval=min(0.05, remaining), timeout=remaining)
        if monotonic() >= deadline:
            raise PoolTimeout('PG2_CHECKOUT_TIMEOUT')
        if (len(results) != 1 or results[0].status != ExecStatus.EMPTY_QUERY
                or pg.transaction_status != TransactionStatus.IDLE):
            raise psycopg.OperationalError('PG2_CHECKOUT_RESPONSE')

    @contextmanager
    def _connection(self) -> Iterator[Connection[dict[str, Any]]]:
        if not self.settings.check_on_checkout:
            with self._pool.connection(timeout=self.settings.acquire_timeout) as connection:
                yield connection
            return
        deadline = monotonic() + self.settings.acquire_timeout
        # One resident connection and at most one replacement, never a reconnect storm.
        for _ in range(2):
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise PoolTimeout('PG2_CHECKOUT_TIMEOUT')
            connection = self._pool.getconn(timeout=remaining)
            try:
                self._probe(connection, deadline)
            except BaseException as error:
                # A cancelled/unfinished probe is discarded, never drained or recycled.
                connection.close()
                self._pool.putconn(connection)
                if isinstance(error, psycopg.Error):
                    continue
                raise
            break
        else:
            if monotonic() >= deadline:
                raise PoolTimeout('PG2_CHECKOUT_TIMEOUT')
            raise PersistenceUnavailable('PG2_CHECKOUT_FAILED') from None
        try:
            with connection:
                yield connection
        finally:
            self._pool.putconn(connection)

    @contextmanager
    def transaction(self, *, write: bool = False, scope_id: str = '') -> Iterator[
        Connection[dict[str, Any]]
    ]:
        if write and not self.writable:
            raise PermissionError('PG2_READ_ONLY')
        with self._connection() as connection:
            committing = False
            try:
                connection.execute(('BEGIN' if write else
                                    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                                   + '; SET LOCAL search_path=pg_catalog', prepare=False)
                connection.execute("SELECT set_config('statement_timeout',%s,true),"
                                   "set_config('lock_timeout',%s,true),"
                                   "set_config('idle_in_transaction_session_timeout',%s,true),"
                                   "set_config('pg1.writer_version','1',true),"
                                   "set_config('pg2.scope_id',%s,true)",
                                   (str(self.settings.statement_timeout_ms),
                                    str(self.settings.lock_timeout_ms),
                                    str(self.settings.statement_timeout_ms), scope_id))
                if self.access_contract is RepositoryAccessContract.PG2_REFERENCE_V1:
                    verify_access(connection, writable=self.writable, profile=self.profile)
                elif self.access_contract is RepositoryAccessContract.Q08_RESEARCH_STUB_V1:
                    from .research_access import verify_research_access
                    connection.execute("SELECT set_config('q08.writer_version','1',true)")
                    verify_research_access(connection, writable=self.writable,
                                           target_profile=self.profile)
                elif self.access_contract is RepositoryAccessContract.PUBLIC_DATA_V1:
                    from .public_access import verify_public_access
                    verify_public_access(connection, writable=self.writable, profile=self.profile)
                elif self.access_contract is RepositoryAccessContract.PRIVATE_RESEARCH_V1:
                    assert self.private_target is not None and self.private_role is not None
                    verify_private_access(connection, target=self.private_target,
                                          role=self.private_role)
                else:
                    raise ValueError('PG2_POOL_CONFIGURATION')
                if write:
                    lock = int.from_bytes(sha256(scope_id.encode()).digest()[:8], signed=True)
                    connection.execute('SELECT pg_advisory_xact_lock(%s)', (lock,))
                yield connection
                if write:
                    committing = True
                    self._commit(connection)
                else:
                    connection.execute('ROLLBACK')
            except BaseException as error:
                if committing:
                    connection.close()
                    if isinstance(error, (psycopg.IntegrityError,
                                          psycopg.errors.TransactionRollback)):
                        raise PersistenceUnavailable('PG2_COMMIT_REJECTED') from None
                    raise CommitUnknown('PG2_COMMIT_UNKNOWN_RECONCILE_NO_RETRY') from None
                try:
                    connection.rollback()
                except psycopg.Error:
                    connection.close()
                if isinstance(error, psycopg.IntegrityError):
                    raise PersistenceConflict('PG2_CONSTRAINT_CONFLICT') from None
                if isinstance(error, psycopg.Error):
                    raise PersistenceUnavailable('PG2_TRANSACTION_FAILED') from None
                raise
