"""Owned local PG17 only: checked checkout retains the PUBLIC access contract."""
# ruff: noqa: E402, F811 -- opt-in before drivers; imported pytest fixture.
import asyncio
import os

import pytest

if 'PG2_TEST_SOCKET' not in os.environ:
    pytest.skip('Explicit owned synthetic cluster required', allow_module_level=True)

import psycopg
from psycopg.conninfo import conninfo_to_dict

from stark_trading_os.control.postgres.access import AccessRejected, RepositoryAccessContract
from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool, PoolSettings
from tests.integration.control.test_public_pg import public_db, seed  # noqa: F401


def checked_pool(dsn):
    # Run the same behavioural counterexample against the pre-feature baseline.
    options = ({'check_on_checkout': True}
               if 'check_on_checkout' in PoolSettings.__dataclass_fields__ else {})
    return PgRepositoryPool(
        dsn, writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
        settings=PoolSettings(max_size=1, acquire_timeout=1, **options),
    )


def test_dead_resident_replaced_before_checked_public_transaction(public_db):
    owner, _, reader = public_db
    seed(owner)
    p = checked_pool(reader)
    try:
        p.open()
        old = p._pool.getconn()
        pid = old.info.backend_pid
        p._pool.putconn(old)
        with psycopg.connect(reader, autocommit=True) as killer:
            assert killer.execute(
                'SELECT datname=current_database() AND usename=current_user '
                'FROM pg_stat_activity WHERE pid=%s', (pid,)).fetchone()[0]
            assert killer.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0]
        with p.transaction() as c:
            assert c.info.backend_pid != pid
            assert c.execute('SELECT current_user AS name').fetchone()['name'] == 'r22_reader'
        assert old.closed
        assert p._pool.get_stats()['pool_available'] == 1
        with pytest.raises(PermissionError, match='READ_ONLY'):
            with p.transaction(write=True):
                pytest.fail('Reader cannot write')
    finally:
        p.close()
    assert p._pool.closed


def test_checked_pool_still_rejects_owner_role(public_db):
    owner, _, reader = public_db
    seed(owner)
    from psycopg.conninfo import make_conninfo
    p = checked_pool(make_conninfo(reader, user='r22_owner'))
    assert conninfo_to_dict(reader)['user'] == 'r22_reader'
    with pytest.raises(AccessRejected):
        p.open()
    assert p._pool.closed


@pytest.mark.parametrize('cancel_before_commit', [True, False])
def test_checked_write_cancellation_or_lost_ack_never_replays(public_db, monkeypatch,
                                                            cancel_before_commit):
    owner, writer, _ = public_db
    seed(owner)
    p = PgRepositoryPool(
        writer, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
        settings=PoolSettings(max_size=1, check_on_checkout=True),
    )
    commits = []
    original = p._commit

    def lose_ack(connection):
        original(connection)
        commits.append(1)
        raise psycopg.OperationalError('synthetic lost acknowledgement')

    monkeypatch.setattr(p, '_commit', lose_ack)
    try:
        p.open()
        with pytest.raises(asyncio.CancelledError if cancel_before_commit else CommitUnknown):
            with p.transaction(write=True) as c:
                c.execute("UPDATE public_data.budgets SET reserved=reserved+1, "
                          "total_reserved=total_reserved+1 WHERE scope='binance'")
                if cancel_before_commit:
                    raise asyncio.CancelledError()
        expected = 0 if cancel_before_commit else 1
        assert len(commits) == expected
        with p.transaction() as c:
            assert c.execute("SELECT total_reserved AS n FROM public_data.budgets "
                             "WHERE scope='binance'").fetchone()['n'] == expected
        assert p._pool.get_stats()['pool_available'] == 1
    finally:
        p.close()
