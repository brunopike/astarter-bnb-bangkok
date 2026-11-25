"""Real Unix-only PG17, HTTP identity, isolation, and no financial authority."""
# ruff: noqa: E402 -- optional driver gated by explicit owned fixture.
import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

import pytest

if not os.environ.get('PG3_TEST_ROOT'):
    pytest.skip('PG3 owned fixture not configured', allow_module_level=True)

import httpx
import psycopg
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.app import create_app
from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.postgres.access import install_access
from stark_trading_os.control.postgres.caller import ReferenceRuntime
from stark_trading_os.control.postgres.identity import Grant, IdentityRegistry
from stark_trading_os.control.postgres.pool import PoolSettings
from stark_trading_os.control.postgres.synthetic_migration import new_target_statements, snapshot
from stark_trading_os.domain import strategy_contracts as c
from tests.unit.control.pg_schema8_fixture import derive_schema8_fixture
from tests.unit.control.test_astarter_strategy_repository import (
    SyntheticBackend,
    account,
    checkpoint,
)
from tests.unit.domain.test_strategy_contracts import approval, changed, plan

PREFIX = '/v1/strategy-references'
ORIGIN = {'Origin': 'http://127.0.0.1:3000'}
TOKENS = {name: 'fake-local-only-' + name + '-' + 'a' * 40
          for name in ('reader', 'writer', 'other')}


@pytest.fixture
def pg2(tmp_path):
    root = Path(os.environ['PG3_TEST_ROOT'])
    auth = json.loads((root / 'root-socket-authorization.json').read_text())
    alias = Path(auth['alias'])
    assert alias.is_symlink() and alias.lstat().st_ino == auth['alias_inode']
    assert alias.lstat().st_uid == auth['owner_uid'] == os.getuid()
    assert alias.resolve() == Path(auth['target']) == root / 'socket'
    assert alias.resolve().stat().st_mode & 0o777 == 0o700
    assert auth['new_pgdata'] == str(root / 'pgdata')
    base = dict(host=str(alias), port=55439, connect_timeout=3)
    db = 'pg3_' + uuid.uuid4().hex
    with psycopg.connect(**base, user='pg1_owner', dbname='postgres', autocommit=True) as admin:
        assert admin.execute('SHOW data_directory').fetchone()[0] == auth['new_pgdata']
        assert admin.execute('SHOW listen_addresses').fetchone()[0] == ''
        for role, login in [('pg2_owner', True), ('pg2_app', True), ('pg2_reader', True),
                            ('pg2_reference_read', False), ('pg2_reference_write', False)]:
            if not admin.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                admin.execute(psycopg.sql.SQL('CREATE ROLE {} {}').format(
                    psycopg.sql.Identifier(role), psycopg.sql.SQL('LOGIN' if login else 'NOLOGIN')))
        admin.execute(psycopg.sql.SQL(
            'CREATE DATABASE {} OWNER pg2_owner TEMPLATE template0').format(
                psycopg.sql.Identifier(db)))
        admin.execute('GRANT pg2_reference_write TO pg2_app')
        admin.execute('GRANT pg2_reference_read TO pg2_reader')
    source = SyntheticBackend()
    path = tmp_path / 'source.sqlite'
    current = tmp_path / 'source-current.sqlite'
    conn = open_control_database(current)
    other = SyntheticBackend(changed(source.assignment.binding,
        tenant_id='tenant-b', account_id='account-b'), '22222222-2222-2222-2222-222222222222')
    for value in (source, other):
        account(conn, value)
        r.provision_account_scope(conn, value)
    conn.close()
    derive_schema8_fixture(current, path)
    with psycopg.connect(**base, user='pg2_owner', dbname=db, autocommit=True) as owner:
        with owner.transaction():
            for statement in new_target_statements(snapshot(path)):
                owner.execute(statement)
        yield owner, make_conninfo(**base, user='pg2_app', dbname=db), source


def runtime(pg2, **settings):
    owner, dsn, source = pg2
    install_access(owner)
    grants = []
    for name, token in TOKENS.items():
        scope = source.assignment
        if name == 'other':
            scope = SyntheticBackend(changed(scope.binding, tenant_id='tenant-b',
                account_id='account-b'), '22222222-2222-2222-2222-222222222222').assignment
        grants.append(Grant(hashlib.sha256(token.encode()).hexdigest(), name, scope,
            'reader' if name == 'reader' else 'writer', 'pg3', 0,
            time.time_ns() // 1000000 + 120000))
    return ReferenceRuntime(IdentityRegistry('pg3', tuple(grants)),
        reader_conninfo=make_conninfo(dsn, user='pg2_reader'), writer_conninfo=dsn,
        settings=PoolSettings(max_size=1, **settings))


def headers(name='writer'):
    return ORIGIN | {'Authorization': 'Bearer ' + TOKENS[name]}


def app_for(rt):
    return create_app(testing=False, web_local_origin=ORIGIN['Origin'],
        strategy_reference_runtime=rt, strategy_reference_only=True)


def payload(p=None, key='pg3-save'):
    return dict(bundle=c.PreflightInput(plan=p or plan()).model_dump(mode='json'),
                request_key=key, expected_revision=None)


def test_six_actions_real_http_and_reopen(pg2):
    rt = runtime(pg2)
    p = plan()
    # Private approval needs current server time; evidence remains synthetic/offline.
    now = time.time_ns() // 1000000
    p = changed(p, starts_at_ms=now - 1000, expires_at_ms=now + 120000)
    a = changed(approval(p), starts_at_ms=now - 1000, expires_at_ms=now + 60000)
    with TestClient(app_for(rt)) as client:
        assert client.app.state.control_dependencies is None
        assert client.get('/v1/system', headers=ORIGIN).status_code == 404
        saved = client.post(PREFIX + '/plans', json=payload(p), headers=headers())
        assert saved.status_code == 200, saved.text
        read = client.get(PREFIX + '/plans/' + p.plan_id, headers=headers('reader'))
        assert read.status_code == 200 and not read.json()['execution_authorized']
        review = client.post(PREFIX + '/plans/' + p.plan_id + '/approval-references',
            json=dict(approval=a.model_dump(mode='json'), request_key='pg3-review'),
            headers=headers())
        assert review.status_code == 200, review.text
        assert review.json()['result']['authority'] == 'OFFLINE_REFERENCE'
        cp = checkpoint(p)
        saved_cp = client.post(PREFIX + '/recovery', json=cp.model_dump(mode='json'),
                               headers=headers())
        assert saved_cp.status_code == 200, saved_cp.text
        restored = client.get(PREFIX + '/plans/' + p.plan_id + '/recovery',
            params={'revision': p.revision}, headers=headers('reader'))
        assert restored.status_code == 200 and restored.json()['result']['reference_only']
        assert restored.json()['result']['checkpoint']['state']['order'] == 'UNKNOWN'
        cleared = changed(cp, seq=2, previous_sha256=r.reference_hash(cp), request_key='clear',
                          state=changed(cp.state, order='NONE'))
        denied = client.post(PREFIX + '/recovery', json=cleared.model_dump(mode='json'),
                             headers=headers())
        assert denied.status_code == 409
        assert client.get(PREFIX + '/plans', headers=headers()).status_code == 200
    assert rt.reader._pool.closed and rt.writer._pool.closed
    with TestClient(app_for(runtime(pg2))) as reopened:
        assert reopened.get(PREFIX + '/plans/' + p.plan_id, headers=headers()).status_code == 200


@pytest.mark.parametrize('case', ['missing', 'duplicate', 'forged', 'expired', 'audience',
                                 'revoked', 'reader-write', 'scope-header'])
def test_denial_before_borrow(pg2, monkeypatch, case):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        def no_borrow(*args, **kwargs):
            pytest.fail('AUTH_DENIAL_BORROWED_DB')
        monkeypatch.setattr(rt.reader, 'transaction', no_borrow)
        monkeypatch.setattr(rt.writer, 'transaction', no_borrow)
        h = headers('reader')
        expected = 401
        if case == 'missing':
            h = ORIGIN
        elif case == 'duplicate':
            h = list(h.items()) + [('Authorization', h['Authorization'])]
        elif case == 'forged':
            h['Authorization'] = 'Bearer ' + 'x' * 40
        elif case in ('expired', 'audience'):
            g = rt.identities._grants[0]
            from dataclasses import replace
            rt.identities = IdentityRegistry('pg3', (replace(g, **(
                {'expires_at_ms': 1} if case == 'expired' else {'audience': 'wrong'})),))
        elif case == 'revoked':
            rt.identities.revoke(hashlib.sha256(TOKENS['reader'].encode()).hexdigest())
        else:
            expected = 403
            h |= {'X-Tenant': 'tenant-b', 'X-Role': 'writer'}
        response = client.post(PREFIX + '/plans', headers=h, json={'token': 'canary-secret'})
        assert response.status_code == expected
        assert 'canary' not in response.text and TOKENS['reader'] not in response.text


@pytest.mark.asyncio
async def test_same_pool_one_connection_concurrent_scopes(pg2):
    rt = runtime(pg2)
    app = app_for(rt)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url='http://local') as client:
            other = changed(plan(), binding=rt.identities._grants[2].scope.binding)
            results = await asyncio.gather(
                client.post(PREFIX + '/plans', json=payload(), headers=headers()),
                client.post(PREFIX + '/plans', json=payload(other), headers=headers('other')))
            assert [v.status_code for v in results] == [200, 200]
            results = await asyncio.gather(*[
                client.get(PREFIX + '/plans/fixture-plan', headers=headers(name))
                for name in ('writer', 'other') * 3])
            assert [v.json()['result']['record']['bundle']['plan']['binding']['tenant_id']
                    for v in results] == ['tenant-a', 'tenant-b'] * 3
            cross = changed(plan(), plan_id='private-a-only')
            assert (await client.post(PREFIX + '/plans', json=payload(cross, 'private'),
                                      headers=headers())).status_code == 200
            denied = await client.get(PREFIX + '/plans/private-a-only', headers=headers('other'))
            missing = await client.get(PREFIX + '/plans/missing-id', headers=headers('other'))
            assert denied.status_code == missing.status_code == 404
            assert denied.content == missing.content
            assert rt.writer._pool.get_stats()['connections_num'] == 1


@pytest.mark.parametrize('mutation', [
    'clock', 'scope', 'float', 'extra', 'duplicate', 'depth', 'size',
])
def test_strict_raw_input_and_no_canary_reflection(pg2, mutation):
    with TestClient(app_for(runtime(pg2))) as client:
        body = payload()
        if mutation == 'clock':
            body['now_ms'] = 1000
        elif mutation == 'scope':
            body['bundle']['plan']['binding']['tenant_id'] = 'canary-secret'
        elif mutation == 'float':
            body['bundle']['plan']['starts_at_ms'] = 900.0
        elif mutation == 'extra':
            body['bundle']['plan']['canary-secret'] = True
        raw = json.dumps(body)
        if mutation == 'duplicate':
            raw = '{"request_key":"canary-secret",' + raw[1:]
        elif mutation == 'depth':
            raw = '[' * 100 + '0' + ']' * 100
        elif mutation == 'size':
            raw = ' ' * 262145
        result = client.post(PREFIX + '/plans', content=raw, headers=headers())
        assert result.status_code in (404, 422)
        assert 'canary-secret' not in result.text


def test_unknown_commit_no_replay(pg2, monkeypatch):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        original = rt.writer._commit
        calls = []
        def lost_ack(connection):
            original(connection)
            calls.append(1)
            raise psycopg.OperationalError('canary-secret')
        monkeypatch.setattr(rt.writer, '_commit', lost_ack)
        response = client.post(PREFIX + '/plans', json=payload(), headers=headers())
        assert response.status_code == 503 and response.json()['code'] == 'COMMIT_UNKNOWN_NO_RETRY'
        assert calls == [1] and 'canary-secret' not in response.text
        read = client.get(PREFIX + '/plans', headers=headers('reader'))
        assert len(read.json()['result']) == 1 and calls == [1]


def test_partial_startup_closes_both(pg2, monkeypatch):
    rt = runtime(pg2)
    def fail():
        raise RuntimeError('synthetic-startup-failure')
    monkeypatch.setattr(rt.writer, 'open', fail)
    with pytest.raises(RuntimeError, match='synthetic-startup-failure'):
        with TestClient(app_for(rt)):
            pass
    assert rt.reader._pool.closed and rt.writer._pool.closed


@pytest.mark.asyncio
async def test_cancel_startup_closes_owned_pools(pg2, monkeypatch):
    from threading import Event
    rt = runtime(pg2)
    started, release = Event(), Event()
    original = rt.writer.open
    def slow():
        started.set()
        assert release.wait(5)
        original()
    monkeypatch.setattr(rt.writer, 'open', slow)
    async def run():
        async with rt.lifespan():
            pytest.fail('CANCELLED_STARTUP_ADMITTED')
    task = asyncio.create_task(run())
    assert await asyncio.to_thread(started.wait, 5)
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert rt.reader._pool.closed and rt.writer._pool.closed


@pytest.mark.parametrize('path', ['/plans', '/plans/fixture-plan/approval-references', '/recovery'])
def test_reader_all_write_actions_preborrow(pg2, monkeypatch, path):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        def forbidden(*args, **kwargs):
            pytest.fail('READER_BORROWED_DB')
        monkeypatch.setattr(rt.reader, 'transaction', forbidden)
        monkeypatch.setattr(rt.writer, 'transaction', forbidden)
        assert client.post(PREFIX + path, headers=headers('reader'), json={}).status_code == 403


def test_revocation_and_claims_are_not_cached_or_authoritative(pg2, monkeypatch):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        assert client.get(PREFIX + '/plans', headers=headers()).status_code == 200
        def forbidden(*args, **kwargs):
            pytest.fail('REVOKED_OR_FOREIGN_BORROWED_DB')
        monkeypatch.setattr(rt.writer, 'transaction', forbidden)
        body = payload(changed(plan(), binding=changed(plan().binding, tenant_id='foreign')))
        assert client.post(PREFIX + '/plans', headers=headers(), json=body).status_code == 404
        rt.identities.revoke(hashlib.sha256(TOKENS['writer'].encode()).hexdigest())
        assert client.get(PREFIX + '/plans', headers=headers()).status_code == 401


@pytest.mark.asyncio
async def test_pool_exhaustion_fixed_error_and_responsive_loop(pg2):
    rt = runtime(pg2, acquire_timeout=0.1)
    app = app_for(rt)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url='http://local') as client:
            with rt.reader._pool.connection():
                task = asyncio.create_task(client.get(PREFIX + '/plans', headers=headers('reader')))
                await asyncio.sleep(0.02)
                assert not task.done()
                response = await task
                assert response.status_code == 503
                assert response.json()['code'] == 'REFERENCE_UNAVAILABLE'
            response = await client.get(PREFIX + '/plans', headers=headers('reader'))
            assert response.status_code == 200


@pytest.mark.asyncio
async def test_request_cancel_joins_dal_before_shutdown(pg2, monkeypatch):
    from threading import Event

    from stark_trading_os.control.postgres.strategy_repository import PostgresStrategyRepository
    rt = runtime(pg2)
    app = app_for(rt)
    started, release, finished = Event(), Event(), Event()
    original = PostgresStrategyRepository.list_plans
    def slow(self, **kwargs):
        started.set()
        assert release.wait(5)
        try:
            return original(self, **kwargs)
        finally:
            finished.set()
    monkeypatch.setattr(PostgresStrategyRepository, 'list_plans', slow)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url='http://local') as client:
            task = asyncio.create_task(client.get(PREFIX + '/plans', headers=headers()))
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            await asyncio.sleep(0.01)
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert finished.is_set()
    assert rt.reader._pool.closed and rt.writer._pool.closed
