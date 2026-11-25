"""L0 uses only owned local PG17 and a synthetic external-observation wire."""
# ruff: noqa: E402
import json
import os
import time
from dataclasses import replace
from uuid import uuid4

import pytest

if "PG2_TEST_SOCKET" not in os.environ:
    pytest.skip("Explicit owned synthetic cluster required", allow_module_level=True)

from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict

from stark_trading_os.control.postgres.public_access import PUBLIC_CATALOG_PIN, seed_public
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
from stark_trading_os.control.public_data_live import (
    PublicLiveTarget,
    _LivePool,
    create_live_public_app,
)
from stark_trading_os.control.public_data_policy import MIN_INTERVAL, ProviderPolicy
from tests.integration.control.test_public_pg import TOKEN
from tests.integration.control.test_public_pg import public_db as public_db
from tests.integration.control.test_public_provider_wiring import Wire, assets, response


def inputs(db, *, seed_mode="live_readonly", lifetime=600000):
    owner, writer, _ = db
    params = conninfo_to_dict(writer)
    expires = time.time_ns()//1000000 + lifetime
    seed_public(owner, mode=seed_mode,
                policies=tuple(ProviderPolicy(s, 30, n) for s, n in MIN_INTERVAL.items()),
                total_caps={s:30 for s in MIN_INTERVAL}, valid_until_ms=expires)
    target = PublicLiveTarget(params['host'], int(params['port']), params['dbname'],
                              'r22_reader', 'r22_collector', TargetProfile.LOCAL_PG17,
                              PUBLIC_CATALOG_PIN)
    cfg = dict(enabled=True, mode='live_readonly', host=target.host, port=target.port,
               dbname=target.dbname, reader=target.reader, collector=target.collector,
               profile=target.profile.value, catalog_pin=target.catalog_pin,
               reader_password='synthetic-reader', collector_password='synthetic-writer',
               refresh_token=TOKEN, scopes=['coingecko'], coingecko_api_key='synthetic-key',
               expires_at_ms=expires)
    wire = Wire({'COINGECKO_ASSETS': [response(assets())]})
    wire.purpose = 'EXTERNAL_OBSERVATION'  # Synthetic wire; no network implementation.
    return target, cfg, wire


def test_real_roles_shared_refresh_get_no_provider_and_no_fixture_relabel(public_db):
    owner, _, _ = public_db
    target, cfg, wire = inputs(public_db)
    app = create_live_public_app(json.dumps(cfg), target=target, service='collector',
                                 transport_factory=wire.factory)
    with TestClient(app) as c:
        r = c.post('/internal/public-data/refresh', headers={'Authorization':'Bearer '+TOKEN},
                   json={'request_id':str(uuid4()), 'scope':'coingecko'})
        assert r.status_code == 200 and r.json()['state'] == 'COMPLETED'
        for _ in range(2):
            result = c.get('/v1/data/assets')
            assert result.status_code == 200
            assert result.json()['mode'] == 'live_readonly'
            assert len(result.json()['items']) == 3
        assert len(wire.sent) == 1
        assert 'synthetic-key' not in result.text
        assert c.post('/internal/public-data/refresh').status_code == 403
        assert c.get('/v1/data/assets', headers={'Origin':'https://evil.test'}).status_code == 403
    assert wire.closed == wire.opened
    assert owner.execute('SELECT total_reserved FROM public_data.budgets '
                         "WHERE scope='coingecko'").fetchone()[0] == 1
    readonly = {k:v for k,v in cfg.items() if k not in
                {'collector_password', 'refresh_token', 'scopes', 'coingecko_api_key'}}
    with TestClient(create_live_public_app(json.dumps(readonly), target=target,
                                           transport_factory=wire.factory)) as c:
        assert c.get('/v1/data/assets').status_code == 200
        assert c.post('/internal/public-data/refresh').status_code == 403
    assert len(wire.sent) == 1


def test_old_fixture_budget_rejected_without_relabel_or_charge(public_db):
    owner, _, _ = public_db
    target, cfg, wire = inputs(public_db, seed_mode='offline_fixture')
    with pytest.raises(ValueError, match='PUBLIC_LIVE_POLICY_REJECTED'):
        with TestClient(create_live_public_app(json.dumps(cfg), target=target,
                        service='collector', transport_factory=wire.factory)):
            pytest.fail('fixture must not become live')
    assert not wire.sent
    assert owner.execute('SELECT sum(total_reserved) FROM public_data.budgets').fetchone()[0] == 0


@pytest.mark.parametrize('wrong', ['reader_as_writer', 'wrong_login', 'wrong_db', 'catalog'])
def test_native_identity_and_catalog_fail_closed(public_db, wrong):
    owner, writer, reader = public_db
    target, cfg, _ = inputs(public_db)
    if wrong == 'catalog':
        owner.execute('CREATE TABLE public.unexpected(id integer)')
    dsn = reader if wrong == 'reader_as_writer' else writer
    p = _LivePool(dsn, target=replace(target, dbname='wrong_db') if wrong=='wrong_db' else target,
                  user='wrong_login' if wrong=='wrong_login' else target.collector,
                  expires=cfg['expires_at_ms'], clock=lambda:time.time_ns()//1000000, writable=True)
    try:
        with pytest.raises((ValueError, RuntimeError)):
            p.open()
    finally:
        p.close()
    assert owner.execute('SELECT sum(total_reserved) FROM public_data.budgets').fetchone()[0] == 0


def test_expiry_after_checkout_rolls_back_without_refund(public_db):
    owner, writer, _ = public_db
    target, cfg, _ = inputs(public_db)
    clock = [time.time_ns()//1000000]
    p = _LivePool(writer, target=target, user=target.collector,
                  expires=cfg['expires_at_ms'], clock=lambda:clock[0], writable=True)
    try:
        p.open()
        with pytest.raises(ValueError, match='PUBLIC_LIVE_EXPIRED'):
            with p.transaction(write=True) as conn:
                conn.execute("UPDATE public_data.budgets SET total_reserved=1 "
                             "WHERE scope='coingecko'")
                clock[0] = cfg['expires_at_ms']
        assert owner.execute('SELECT sum(total_reserved) FROM public_data.budgets').fetchone()[0]==0
        with pytest.raises(ValueError, match='PUBLIC_LIVE_EXPIRED'):
            with p.transaction():
                pytest.fail('expired cannot enter')
    finally:
        p.close()


def test_expiry_during_send_keeps_charge_and_no_snapshot(public_db):
    from contextlib import asynccontextmanager
    owner, _, _ = public_db
    target, cfg, wire = inputs(public_db)
    clock = [time.time_ns()//1000000]

    @asynccontextmanager
    async def factory(source):
        async with wire.factory(source) as base:
            class Transport:
                purpose = 'EXTERNAL_OBSERVATION'
                async def send(self, request):
                    result = await base.send(request)
                    clock[0] = cfg['expires_at_ms']
                    return result
            yield Transport()

    app = create_live_public_app(json.dumps(cfg), target=target, service='collector',
                                 transport_factory=factory, clock_ms=lambda:clock[0])
    with TestClient(app) as c:
        r = c.post('/internal/public-data/refresh', headers={'Authorization':'Bearer '+TOKEN},
                   json={'request_id':str(uuid4()), 'scope':'coingecko'})
        assert r.status_code == 202 and r.json()['state'] == 'UNKNOWN'
        assert c.get('/v1/data/assets').status_code == 503
    assert len(wire.sent)==1
    assert owner.execute('SELECT count(*) FROM public_data.snapshots').fetchone()[0]==0
    assert owner.execute("SELECT total_reserved FROM public_data.budgets "
                         "WHERE scope='coingecko'").fetchone()[0]==1
