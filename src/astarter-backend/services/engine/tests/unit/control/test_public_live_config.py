"""L0 configuration is data; tests never connect or use real credentials."""
import json
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.postgres.public_access import PUBLIC_NEON_CATALOG_PIN
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
from stark_trading_os.control.public_data_live import PublicLiveTarget, create_live_public_app

TARGET = PublicLiveTarget("ep-synthetic-pooler.ap-southeast-1.aws.neon.tech", 5432,
                          "public_live_test", "live_reader", "live_collector",
                          TargetProfile.NEON_PG17_V1, PUBLIC_NEON_CATALOG_PIN)

def config(**changes):
    value = dict(enabled=True, mode="live_readonly", host=TARGET.host, port=TARGET.port,
                 dbname=TARGET.dbname, reader=TARGET.reader, collector=TARGET.collector,
                 profile=TARGET.profile.value, catalog_pin=TARGET.catalog_pin,
                 expires_at_ms=time.time_ns()//1000000+600000, reader_password="synthetic-reader")
    value.update(changes)
    return json.dumps(value)

def test_default_and_explicit_disabled_never_construct_pool():
    with patch("stark_trading_os.control.public_data_live._LivePool") as pool:
        for value in (None, json.dumps({"enabled": False})):
            with TestClient(create_live_public_app(value)) as client:
                assert client.get("/v1/data/markets").status_code == 503
        pool.assert_not_called()

@pytest.mark.parametrize("changes", [dict(host="evil.test"), dict(dbname="old_fixture"),
    dict(reader=TARGET.collector), dict(catalog_pin="0"*64), dict(mode="offline_fixture"),
    dict(expires_at_ms=True), dict(expires_at_ms=1), dict(profile="LOCAL_PG17"),
    dict(port=True), dict(unknown="synthetic-secret"), dict(enabled="true"),
    dict(collector_password="synthetic-writer"), dict(scopes=["binance"]),
    dict(coingecko_api_key="synthetic-key")])
def test_invalid_reader_config_before_pool(changes):
    with patch("stark_trading_os.control.public_data_live._LivePool") as pool:
        with pytest.raises(ValueError, match="^PUBLIC_LIVE_CONFIGURATION$"):
            create_live_public_app(config(**changes), target=TARGET)
        pool.assert_not_called()

def test_no_target_or_malformed_never_construct_pool():
    for value in (config(), "{", "[]", '{"enabled":true,"enabled":false}'):
        with pytest.raises(ValueError, match="PUBLIC_LIVE_CONFIGURATION"):
            create_live_public_app(value)

def test_reader_factory_has_no_collector_credentials():
    from stark_trading_os.control.postgres.access import RepositoryAccessContract
    with patch("stark_trading_os.control.public_data_live._LivePool") as cls:
        cls.return_value.writable = False
        cls.return_value.access_contract = RepositoryAccessContract.PUBLIC_DATA_V1
        app = create_live_public_app(config(), target=TARGET)
        assert len(cls.call_args_list) == 1
        assert cls.call_args.kwargs["writable"] is False
        assert "sslmode=verify-full" in cls.call_args.args[0]
        with TestClient(app) as client:
            assert client.post("/internal/public-data/refresh").status_code == 403
            assert client.get("/docs").status_code == 404
        assert "synthetic-reader" not in repr(app)


def test_cold_factory_and_import_do_not_start_io():
    import os
    import subprocess
    import sys
    code = """
import socket, sqlite3, threading, asyncio
def fail(*a, **k): raise AssertionError('UNEXPECTED_IO')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = fail
sqlite3.connect = threading.Thread.start = asyncio.create_task = fail
from stark_trading_os.control.public_data_live import create_live_public_app
create_live_public_app()
print('ZERO_IO')
"""
    result = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True,
                            text=True, timeout=30, env={'PYTHONPATH': os.environ['PYTHONPATH']})
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'ZERO_IO'


def test_expired_between_construction_and_start_never_opens():
    from stark_trading_os.control.postgres.access import RepositoryAccessContract
    now = time.time_ns()//1000000
    clock = [now]
    with patch("stark_trading_os.control.public_data_live._LivePool") as cls:
        cls.return_value.writable = False
        cls.return_value.access_contract = RepositoryAccessContract.PUBLIC_DATA_V1
        app = create_live_public_app(config(expires_at_ms=now+1000), target=TARGET,
                                     clock_ms=lambda: clock[0])
        clock[0] = now+1000
        with pytest.raises(ValueError, match='PUBLIC_LIVE_EXPIRED'):
            with TestClient(app):
                pytest.fail('cannot start expired configuration')
        cls.return_value.open.assert_not_called()


@pytest.mark.parametrize('extra', [dict(scopes=['blockbeats']), dict(scopes=['binance','binance']),
    dict(scopes=['coingecko']), dict(refresh_token='short'),
    dict(coingecko_api_key='invalid key')])
def test_collector_scopes_keys_and_token_rejected_before_pool(extra):
    values = dict(collector_password='synthetic-writer', refresh_token='x'*40, scopes=['binance'])
    values.update(extra)
    with patch('stark_trading_os.control.public_data_live._LivePool') as cls:
        with pytest.raises(ValueError, match='PUBLIC_LIVE_CONFIGURATION'):
            create_live_public_app(config(**values), target=TARGET, service='collector')
        cls.assert_not_called()


@pytest.mark.parametrize('host', ['/tmp/owned,192.0.2.123', '/tmp/owned,', '/tmp/a\x00b'])
def test_local_multi_host_is_rejected(host):
    from stark_trading_os.control.postgres.public_access import PUBLIC_CATALOG_PIN
    with pytest.raises(ValueError, match='PUBLIC_LIVE_CONFIGURATION'):
        PublicLiveTarget(host, 5432, 'synthetic', 'reader', 'collector',
                         TargetProfile.LOCAL_PG17, PUBLIC_CATALOG_PIN)


@pytest.mark.parametrize('key', ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS',
                                 'PGSSLCERT', 'PGPASSWORD'])
def test_libpq_environment_cannot_redirect_fixed_target(monkeypatch, key):
    monkeypatch.setenv(key, 'synthetic-only')
    with patch('stark_trading_os.control.public_data_live._LivePool') as cls:
        with pytest.raises(ValueError, match='PUBLIC_LIVE_ENVIRONMENT'):
            create_live_public_app(config(), target=TARGET)
        cls.assert_not_called()
    assert create_live_public_app()  # Disabled still does not inspect configuration.


@pytest.mark.asyncio
@pytest.mark.parametrize('expire', ['before_dns', 'after_dns', 'queued'])
async def test_expiry_inside_transport_preflight_never_enters_wire(expire):
    import asyncio

    import httpx

    from stark_trading_os.integrations.public_data.network import PublicReadHttpTransport
    from stark_trading_os.integrations.transport import HttpRequest, TransportRejected
    now, sent, resolutions = [1000], [], []
    def check():
        if now[0] >= 2000:
            raise ValueError('PUBLIC_LIVE_EXPIRED')
    async def resolve(host):
        resolutions.append(host)
        if expire == 'after_dns':
            now[0] = 2000
        return ('8.8.8.8',)
    async def wire(request):
        sent.append(request)
        return httpx.Response(200, content=b'{}')
    transport = PublicReadHttpTransport('BINANCE_SPOT',
        offline_transport=httpx.MockTransport(wire), resolver=resolve, before_io=check)
    if expire == 'before_dns':
        now[0] = 2000
    if expire == 'queued':
        for _ in range(3):
            await transport._slots.acquire()
    try:
        task = asyncio.create_task(transport.send(HttpRequest('GET',
            'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT&type=FULL')))
        if expire == 'queued':
            await asyncio.sleep(0)
            now[0] = 2000
            for _ in range(3):
                transport._slots.release()
        with pytest.raises(TransportRejected):
            await task
        assert sent == []
        assert len(resolutions) == (1 if expire == 'after_dns' else 0)
    finally:
        await transport.aclose()


def test_environment_change_after_construction_blocks_native_connection(monkeypatch):
    from stark_trading_os.control.public_data_live import _LivePool
    p = _LivePool('host='+TARGET.host+' user=synthetic password=synthetic '
                  'sslmode=verify-full channel_binding=require',
                  target=TARGET, user=TARGET.reader,
                  expires=time.time_ns()//1000000+100000, clock=lambda:0, writable=False)
    try:
        monkeypatch.setenv('PGHOSTADDR', '192.0.2.123')
        with patch('psycopg.Connection.connect') as connect:
            with pytest.raises(ValueError, match='PUBLIC_LIVE_ENVIRONMENT'):
                p._pool.connection_class.connect('')
            connect.assert_not_called()
    finally:
        p.close()
