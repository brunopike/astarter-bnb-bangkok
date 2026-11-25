"""R2.2 default construction must never become an implicit collector."""

import pytest

from stark_trading_os.control.postgres.access import RepositoryAccessContract


def test_public_access_is_a_separate_contract():
    assert RepositoryAccessContract.PUBLIC_DATA_V1.value == "PUBLIC_DATA_V1"


def test_cold_construction_and_cloud_requires_explicit_tls(monkeypatch):
    import socket
    import sqlite3
    import threading

    import pytest
    from psycopg_pool import ConnectionPool

    from stark_trading_os.control.postgres.pool import PgRepositoryPool
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
    from stark_trading_os.control.public_data_shared import create_shared_public_app

    def forbidden(*args, **kwargs):
        raise AssertionError("cold default must not perform IO")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    monkeypatch.setattr(threading.Thread, "start", forbidden)
    monkeypatch.setattr(ConnectionPool, "open", forbidden)
    p = PgRepositoryPool(
        "host=/nonexistent dbname=fixture user=fixture password=fixture",
        writable=False,
        access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
    )
    app = create_shared_public_app(reader_pool=p, mode="offline_fixture")
    assert app and p._pool.closed
    with pytest.raises(ValueError, match="PUBLIC_TLS_CONFIGURATION"):
        PgRepositoryPool(
            "host=/nonexistent",
            profile=TargetProfile.NEON_PG17_V1,
            access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
        )
    cloud = PgRepositoryPool(
        "host=fixture.invalid sslmode=verify-full channel_binding=require",
        profile=TargetProfile.NEON_PG17_V1,
        access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
    )
    assert cloud._pool.closed


@pytest.mark.asyncio
async def test_repeated_shutdown_cancel_waits_for_owned_work():
    import asyncio
    import threading

    import pytest

    from stark_trading_os.control.public_data_shared import _OwnedCalls

    calls = _OwnedCalls()
    entered, release = threading.Event(), threading.Event()

    def job():
        entered.set()
        return release.wait(3)

    task = asyncio.create_task(calls.run(job))
    assert await asyncio.to_thread(entered.wait, 1)
    closing = asyncio.create_task(calls.close())
    await asyncio.sleep(0)
    closing.cancel()
    await asyncio.sleep(0)
    closing.cancel()
    await asyncio.sleep(0)
    assert not closing.done() and len(calls.pending) == 1
    release.set()
    assert await task
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert not calls.pending


@pytest.mark.parametrize('value', ['NEON_PG17_V1', None, True, 1])
def test_public_unknown_profile_rejected_before_connection(value):
    from stark_trading_os.control.postgres.access import AccessRejected
    from stark_trading_os.control.postgres.public_access import public_profile_pin
    with pytest.raises(AccessRejected, match='PROFILE_UNVERIFIED'):
        public_profile_pin(value)


@pytest.mark.parametrize('params', ['sslmode=require channel_binding=require',
    'sslmode=verify-full channel_binding=prefer', 'sslmode=disable', ''])
def test_public_neon_requires_hostname_and_channel_binding(params):
    from stark_trading_os.control.postgres.pool import PgRepositoryPool
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
    with pytest.raises(ValueError, match='PUBLIC_TLS_CONFIGURATION'):
        PgRepositoryPool('host=fixture.invalid '+params,
            profile=TargetProfile.NEON_PG17_V1,
            access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
