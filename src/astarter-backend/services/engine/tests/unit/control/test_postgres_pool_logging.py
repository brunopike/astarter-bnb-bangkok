"""Real native workers, fake connections: no socket/DSN/exception formatting."""
# ruff: noqa: E402 -- optional driver gate.
import gc
import logging
import socket
import threading
import time
import weakref
from types import SimpleNamespace

import pytest

pytest.importorskip('psycopg_pool')
import psycopg
from psycopg.pq import TransactionStatus
from psycopg_pool import ConnectionPool, PoolTimeout
from psycopg_pool.pool import MaintenanceTask
from psycopg_pool.sched import Scheduler

from stark_trading_os.control.postgres import pool_logging
from stark_trading_os.control.postgres.pool import PgRepositoryPool, PoolSettings


class UnsafeError(psycopg.OperationalError):
    def __str__(self):
        raise AssertionError('RAW_EXCEPTION_FORMATTED')

    def __repr__(self):
        raise AssertionError('RAW_EXCEPTION_FORMATTED')


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)


def owned(**kwargs):
    return PgRepositoryPool('dbname=offline', settings=PoolSettings(
        max_size=1, acquire_timeout=.03, connect_timeout=1, **kwargs))


def test_native_background_connect_red_green_and_unrelated(monkeypatch, caplog):
    logger = logging.getLogger('psycopg.pool')
    caplog.set_level(logging.WARNING, logger='psycopg.pool')
    monkeypatch.setattr(psycopg.Connection, 'connect', lambda *a, **k: (_ for _ in ()).throw(
        psycopg.OperationalError('FAKE_REVIEW_DRIVER_CANARY')))
    # Actual unowned pool is the RED control, not a synthetic log record.
    other = ConnectionPool('dbname=offline', min_size=0, max_size=1, open=False)
    other.open()
    with pytest.raises(PoolTimeout):
        other.getconn(timeout=.03)
    other.close()
    assert 'FAKE_REVIEW_DRIVER_CANARY' in caplog.text
    caplog.clear()
    pools = [owned(), owned(min_size=1)]
    for pool in pools:
        with pytest.raises(PoolTimeout):
            pool.open()
        assert pool._pool.closed
    assert 'PG_POOL_DIAGNOSTIC' in caplog.text
    assert 'FAKE_REVIEW_DRIVER_CANARY' not in caplog.text
    logger.warning('UNRELATED_POOL_LOG')
    logging.getLogger('unrelated.app').warning('UNRELATED_APP_LOG')
    assert 'UNRELATED_POOL_LOG' in caplog.text and 'UNRELATED_APP_LOG' in caplog.text
    # Native unowned pool remains unsanitized while both registrations are live.
    other = ConnectionPool('dbname=offline', min_size=1, max_size=1, open=False)
    with pytest.raises(PoolTimeout):
        other.open(wait=True, timeout=.03)
    other.close()
    assert 'FAKE_REVIEW_DRIVER_CANARY' in caplog.text


@pytest.mark.parametrize('status', [TransactionStatus.INTRANS, TransactionStatus.ACTIVE,
                                   TransactionStatus.IDLE, TransactionStatus.UNKNOWN])
def test_native_reset_discard_close_never_formats(status, caplog):
    caplog.set_level(logging.DEBUG, logger='psycopg.pool')
    pool = owned()

    class Connection:
        pgconn = SimpleNamespace(transaction_status=status)
        _pool = None
        _created_at = _expire_at = float('inf')

        def __str__(self):
            raise AssertionError('RAW_CONNECTION_FORMATTED')

        def rollback(self):
            raise UnsafeError()

        def close(self):
            self.pgconn = SimpleNamespace(transaction_status=TransactionStatus.UNKNOWN)

    def reset(conn):
        raise UnsafeError()

    pool._pool.open()
    pool._pool.close()  # initialize native queue, no connect; late return remains covered
    pool._pool._reset = reset
    pool._pool._return_connection(Connection(), from_getconn=False)
    assert 'PG_POOL_DIAGNOSTIC' in caplog.text


def test_late_worker_after_close_and_weak_cleanup(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger='psycopg.pool')
    entered, release = threading.Event(), threading.Event()
    def connect(*a, **k):
        entered.set()
        assert release.wait(3)
        raise UnsafeError()
    monkeypatch.setattr(psycopg.Connection, 'connect', connect)
    pool = owned(min_size=1)
    pool._pool.open()
    assert entered.wait(2)
    workers = list(pool._pool._workers)
    pool._pool.close(timeout=.01)  # worker is deliberately late
    release.set()
    for worker in workers:
        worker.join(2)
        assert not worker.is_alive()
    assert 'PG_POOL_DIAGNOSTIC' in caplog.text
    ref = weakref.ref(pool._pool)
    key = id(pool._pool)
    del pool
    gc.collect()
    assert ref() is None and key not in pool_logging._owned


def test_worker_exception_boundary_and_two_pool_lifetime(caplog):
    caplog.set_level(logging.WARNING, logger='psycopg.pool')
    pools = [owned(), owned()]
    class BadClose(MaintenanceTask):
        def _run(self, pool):
            raise UnsafeError()
    for pool in pools:
        pool._pool.open()
        pool._pool.run_task(BadClose(pool._pool))
    limit = time.monotonic() + 2
    while len(caplog.records) < 2 and time.monotonic() < limit:
        time.sleep(.01)
    for pool in pools:
        pool.close()
    assert len([r for r in caplog.records if r.message == 'PG_POOL_DIAGNOSTIC']) >= 2
    del pool
    refs = [weakref.ref(p._pool) for p in pools]
    pools.clear()
    gc.collect()
    assert all(r() is None for r in refs)


def test_review_actual_scheduler_tick_run_task_red_green(monkeypatch, caplog):
    """Exact review call path, not a synthetic LogRecord or direct filter call."""
    caplog.set_level(logging.WARNING, logger='psycopg_pool.sched')
    pool = owned()
    arrived = threading.Event()

    class ProbeTask(MaintenanceTask):
        def _run(self, pool):
            pass

    def fail(task):
        if not isinstance(task, ProbeTask):
            return ConnectionPool.run_task(pool._pool, task)
        raise UnsafeError('FAKE_SCHEDULER_DRIVER_CANARY')

    try:
        pool._pool.open()
        monkeypatch.setattr(pool._pool, 'run_task', fail)
        pool._pool.schedule_task(ProbeTask(pool._pool), 0)
        pool._pool._sched.enter(0, arrived.set)
        assert arrived.wait(2)
    finally:
        pool.close()
    records = [r for r in caplog.records if r.name == 'psycopg_pool.sched']
    assert records and all(r.getMessage() == 'PG_POOL_DIAGNOSTIC' for r in records)
    assert all(not r.args and r.exc_info is None and r.stack_info is None for r in records)


@pytest.mark.parametrize('late_close', [False, True])
def test_shared_scheduler_task_identity_not_name_or_logger(monkeypatch, caplog, late_close):
    caplog.set_level(logging.WARNING, logger='psycopg_pool.sched')
    pool = owned()
    other = ConnectionPool('dbname=offline', min_size=0, max_size=1,
                           name=pool._pool.name, open=False)
    scheduler = Scheduler()
    entered, release = threading.Event(), threading.Event()

    class ProbeTask(MaintenanceTask):
        def _run(self, pool):
            pass

    def fail_owned(task):
        if not isinstance(task, ProbeTask):
            return ConnectionPool.run_task(pool._pool, task)
        entered.set()
        assert release.wait(3)
        raise UnsafeError()

    def fail_unowned(task):
        if not isinstance(task, ProbeTask):
            return ConnectionPool.run_task(other, task)
        raise RuntimeError('UNOWNED_SAME_NAME_CANARY')

    class UnrelatedAction:
        def __getattr__(self, name):
            raise AssertionError('UNKNOWN_ACTION_ATTR_READ')

        def __call__(self):
            raise RuntimeError('UNRELATED_ACTION_CANARY')

    pool._pool.open()
    other.open()
    monkeypatch.setattr(pool._pool, 'run_task', fail_owned)
    monkeypatch.setattr(other, 'run_task', fail_unowned)
    scheduler.enter(0, ProbeTask(pool._pool).tick)
    scheduler.enter(0, ProbeTask(other).tick)
    scheduler.enter(0, UnrelatedAction())
    scheduler.enter(0, None)
    worker = threading.Thread(target=scheduler.run)
    try:
        worker.start()
        assert entered.wait(2)
        if late_close:
            pool.close()
        release.set()
        worker.join(3)
        assert not worker.is_alive()
        logging.getLogger('psycopg_pool.sched').warning('UNRELATED_LOGGER_CANARY')
        assert 'PG_POOL_DIAGNOSTIC' in caplog.text
        assert 'UNOWNED_SAME_NAME_CANARY' in caplog.text
        assert 'UNRELATED_ACTION_CANARY' in caplog.text
        assert 'UNRELATED_LOGGER_CANARY' in caplog.text
    finally:
        release.set()
        worker.join(3)
        pool.close()
        other.close()


def test_scheduler_concurrent_weak_release(caplog):
    caplog.set_level(logging.WARNING, logger='psycopg_pool.sched')
    failures = []
    refs = []

    def exercise():
        try:
            pool = owned()
            scheduler = Scheduler()

            class ProbeTask(MaintenanceTask):
                def _run(self, pool):
                    pass

            native = weakref.ref(pool._pool)
            def fail(task):
                if not isinstance(task, ProbeTask):
                    return ConnectionPool.run_task(native(), task)
                raise UnsafeError()

            pool._pool.open()
            pool._pool.run_task = fail
            scheduler.enter(0, ProbeTask(pool._pool).tick)
            scheduler.enter(0, None)
            scheduler.run()
            pool.close()
            refs.append(weakref.ref(pool._pool))
            del pool
        except BaseException as error:
            failures.append(type(error).__name__)

    workers = [threading.Thread(target=exercise) for _ in range(4)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(3)
        assert not worker.is_alive()
    # Concurrent gc.collect() may return while another thread's collection is
    # still running. Assert release after all real workers and collectors drain.
    gc.collect()
    assert all(ref() is None for ref in refs)
    assert failures == []
    assert len([r for r in caplog.records if r.name == 'psycopg_pool.sched'
                and r.getMessage() == 'PG_POOL_DIAGNOSTIC']) == 4
