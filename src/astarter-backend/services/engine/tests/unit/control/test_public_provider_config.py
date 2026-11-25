"""R2.3 synthetic configuration; never read environment or real credentials."""

import asyncio
from contextlib import asynccontextmanager

import pytest

from stark_trading_os.control.public_data_models import PublicDataQuery
from stark_trading_os.control.public_data_providers import SharedPublicProviders
from stark_trading_os.integrations.public_data import PublicDataCredentials


def test_default_provider_configuration_is_disabled():
    config = SharedPublicProviders(mode="live_readonly")
    assert config.configured_scopes == ()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"enabled_scopes": ("unknown",)},
        {"enabled_scopes": ["coingecko"]},
        {"enabled_scopes": ("coingecko", "coingecko")},
        {"enable_external": 1},
        {"mode": "invalid"},
        {"mode": "offline_fixture", "enable_external": True},
    ],
)
def test_bad_configuration_fails_closed(kwargs):
    with pytest.raises(ValueError, match="PUBLIC_PROVIDER_CONFIGURATION"):
        SharedPublicProviders(**({"mode": "live_readonly"} | kwargs))


def test_cold_config_never_opens_resources(monkeypatch):
    import socket

    from psycopg_pool import ConnectionPool

    import stark_trading_os.control.public_data_providers as wiring
    from stark_trading_os.control.postgres.access import RepositoryAccessContract
    from stark_trading_os.control.postgres.pool import PgRepositoryPool
    from stark_trading_os.control.public_data_shared import create_shared_public_app

    def forbidden(*a, **kw):
        raise AssertionError("cold IO")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(ConnectionPool, "open", forbidden)
    monkeypatch.setattr(wiring, "PublicReadHttpTransport", forbidden)
    credentials = PublicDataCredentials(coingecko_api_key="synthetic-secret")
    config = SharedPublicProviders(
        mode="live_readonly",
        enabled_scopes=("coingecko",),
        credentials=credentials,
        enable_external=True,
    )
    assert config.configured_scopes == ("coingecko",)
    assert "synthetic-secret" not in repr(config)
    pools = [
        PgRepositoryPool(
            "host=/nonexistent dbname=synthetic user=fixture",
            writable=w,
            access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
        )
        for w in (False, True)
    ]
    app = create_shared_public_app(
        reader_pool=pools[0],
        collector_pool=pools[1],
        mode="live_readonly",
        providers=config,
        refresh_token="synthetic-token-" * 3,
    )
    assert app and all(p._pool.closed for p in pools)
    closed = SharedPublicProviders(
        mode="live_readonly", enabled_scopes=("coingecko",), credentials=credentials
    )
    assert closed.configured_scopes == ()
    with pytest.raises(ValueError, match="CONFIGURATION"):
        create_shared_public_app(
            reader_pool=pools[0],
            collector_pool=pools[1],
            mode="offline_fixture",
            providers=config,
            refresh_token="synthetic-token-" * 3,
        )


@pytest.mark.asyncio
async def test_mismatched_transport_mode_never_sends_and_closes():
    closed = []

    @asynccontextmanager
    async def factory(service):
        class Wrong:
            purpose = "EXTERNAL_OBSERVATION"

            async def send(self, request):
                raise AssertionError("wrong mode must never send")

        try:
            yield Wrong()
        finally:
            closed.append(service)

    config = SharedPublicProviders(
        mode="offline_fixture",
        enabled_scopes=("coingecko",),
        credentials=PublicDataCredentials(coingecko_api_key="synthetic"),
        transport_factory=factory,
    )
    with pytest.raises(ValueError, match="MODE_MISMATCH"):
        async with config.open() as fetch:
            await fetch(PublicDataQuery(resource="assets"))
    assert closed == ["COINGECKO_ASSETS"]


@pytest.mark.asyncio
async def test_cancelled_provider_operation_closes_owned_transport():
    entered, closed = asyncio.Event(), []

    @asynccontextmanager
    async def factory(service):
        class Blocking:
            purpose = "OFFLINE_FIXTURE"

            async def send(self, request):
                entered.set()
                await asyncio.Event().wait()

        try:
            yield Blocking()
        finally:
            closed.append(service)

    config = SharedPublicProviders(
        mode="offline_fixture",
        enabled_scopes=("blockbeats",),
        credentials=PublicDataCredentials(blockbeats_api_key="synthetic"),
        transport_factory=factory,
    )

    async def execute():
        async with config.open() as fetch:
            await fetch(PublicDataQuery(resource="news", limit=50))

    task = asyncio.create_task(execute())
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed == ["BLOCKBEATS_NEWS"]
