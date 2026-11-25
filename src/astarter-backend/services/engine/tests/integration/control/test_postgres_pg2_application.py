"""Native PG17 application LOGIN tests; synthetic fixtures only."""
# ruff: noqa: E402 -- explicit opt-in must precede optional driver imports.
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

if not any(key.startswith('PG2_TEST_') for key in os.environ):
    pytest.skip('PG2 owned cluster not configured', allow_module_level=True)

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg_pool import PoolClosed, PoolTimeout

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.database import open_control_database
from stark_trading_os.control.postgres.access import AccessRejected, install_access
from stark_trading_os.control.postgres.application import open_application
from stark_trading_os.control.postgres.pool import (
    CommitUnknown,
    PersistenceUnavailable,
    PoolSettings,
)
from stark_trading_os.control.postgres.strategy_repository import PostgresStrategyRepository
from stark_trading_os.control.postgres.synthetic_migration import new_target_statements, snapshot
from stark_trading_os.domain import strategy_contracts as c
from tests.unit.control.pg_schema8_fixture import derive_schema8_fixture
from tests.unit.control.test_astarter_strategy_repository import (
    SyntheticBackend,
    account,
    checkpoint,
    save,
)
from tests.unit.domain.test_strategy_contracts import IDS, approval, changed, plan


@pytest.fixture
def pg2(tmp_path):
    socket = os.environ.get('PG2_TEST_SOCKET')
    configured_root = os.environ.get('PG2_TEST_ROOT')
    if not socket or not configured_root:
        pytest.fail('PG2_OWNED_TARGET_REQUIRED')
    root = Path(configured_root)
    authorization = json.loads((root / 'root-socket-authorization.json').read_text())
    alias = Path(socket)
    if (not socket or not alias.is_absolute() or not alias.is_symlink()
            or socket != authorization['alias']
            or alias.lstat().st_ino != authorization['alias_inode']
            or alias.resolve() != Path(authorization['target'])
            or authorization['uid'] != os.getuid()
            or authorization['pgdata'] != str(root / 'pgdata')):
        pytest.fail('PG2_OWNED_TARGET_REQUIRED')
    db = 'pg2_' + uuid.uuid4().hex
    base = dict(host=socket, port=55439, connect_timeout=3)
    with psycopg.connect(**base, user='pg1_owner', dbname='postgres', autocommit=True) as admin:
        assert admin.execute('SHOW data_directory').fetchone()[0] == authorization['pgdata']
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
    account(conn, source)
    r.provision_account_scope(conn, source)
    second = SyntheticBackend(changed(source.assignment.binding,
                                     account_id='account-b', tenant_id='tenant-b'),
                              '22222222-2222-2222-2222-222222222222')
    account(conn, second)
    r.provision_account_scope(conn, second)
    conn.close()
    derive_schema8_fixture(current, path)
    dsn = make_conninfo(**base, user='pg2_app', dbname=db)
    owner = psycopg.connect(**base, user='pg2_owner', dbname=db, autocommit=True)
    with owner.transaction():
        for statement in new_target_statements(snapshot(path)):
            owner.execute(statement)
    yield owner, dsn, source
    owner.close()


def test_real_login_pool_and_roundtrip(pg2):
    owner, dsn, source = pg2
    with psycopg.connect(dsn) as native:
        assert native.execute('SELECT current_user').fetchone()[0] == 'pg2_app'
    install_access(owner)

    with open_application(dsn, source) as app:
        saved = save(app.repository)
        assert app.repository.read_plan(saved.bundle.plan.plan_id, now_ms=1000).record == saved


@pytest.fixture
def app(pg2):
    owner, dsn, source = pg2
    install_access(owner)
    install_access(owner)
    with open_application(dsn, source, settings=PoolSettings(max_size=2)) as value:
        yield value


@pytest.mark.parametrize('sid', IDS)
def test_catalog_bytes_and_non_authority(app, pg2, sid):
    record = save(app.repository, plan(sid))
    restored = app.repository.read_plan(record.bundle.plan.plan_id, now_ms=1000)
    assert restored.record == record and not restored.decision.execution_authorized
    raw = pg2[0].execute('SELECT content_bytes,content_sha256,ordinal FROM '
                        'pg1_control.astarter_plan_versions').fetchone()
    assert raw == (r._raw(record), r.reference_hash(record), 1)
    assert type(raw[0]) is bytes and type(raw[2]) is int


def test_all_methods_reference_only_and_cas(app):
    repo = app.repository
    record = save(repo)
    p = record.bundle.plan
    a = approval(p)
    review = repo.save_approval(p.plan_id, a, request_key='review', now_ms=1000)
    assert repo.save_approval(p.plan_id, a, request_key='review', now_ms=1000) == review
    assert repo.read_plan(p.plan_id, approval_id=a.reference_id, now_ms=1000).approval == review
    assert repo.read_plan(p.plan_id, approval_id=a.reference_id,
                          now_ms=4000).decision.status == 'BLOCKED'
    ep = r.EpisodeReference(binding=p.binding, episode_id='ep', plan_id=p.plan_id,
                            revision=p.revision, plan_sha256=c.contract_hash(p))
    assert repo.save_episode(ep) == repo.save_episode(ep) == repo.read_episode('ep')
    cp = checkpoint(p, episode_id='ep', layer_index=0)
    layer = r.LayerReference(binding=p.binding, episode_id='ep', layer_index=0, mode='VIRTUAL',
                             action_id='action', trigger=cp.causal, disposition='UNKNOWN')
    assert repo.save_layer(layer) == repo.save_layer(layer) == repo.read_layer('ep', 0)
    assert repo.save_recovery(cp, now_ms=1000) == repo.save_recovery(cp, now_ms=1000)
    history = repo.read_recovery(p.plan_id, p.revision, now_ms=1000)
    assert history.reference_only and history.checkpoint == cp
    assert not history.plan.decision.execution_authorized
    next_cp = changed(cp, seq=2, previous_sha256=r.reference_hash(cp), request_key='cp2')
    assert repo.save_recovery(next_cp, now_ms=1000) == next_cp
    assert not repo.read_recovery(p.plan_id, p.revision, seq=1, now_ms=1000).checkpoint_current
    with pytest.raises(r.PersistenceConflict, match='CAS'):
        repo.save_recovery(changed(cp, request_key='wrong-seq'), now_ms=1000)
    with pytest.raises(r.PersistenceConflict, match='REQUEST_PAYLOAD'):
        save(repo, changed(p, risk_policy_revision='wrong'))
    with pytest.raises(r.PersistenceConflict, match='CAS'):
        save(repo, changed(p, revision='v2'), 'v2', 'wrong')
    new = changed(p, revision='v2', risk_policy_revision='risk-v2')
    save(repo, new, 'v2', p.revision)
    old = repo.read_plan(p.plan_id, revision=p.revision, now_ms=1000)
    assert not old.current and old.decision.reasons == ('PLAN_SUPERSEDED',)
    assert len(repo.list_plans(now_ms=1000)) == 2
    assert len(repo.list_plans(after=(p.plan_id, 1), now_ms=1000)) == 1
    with pytest.raises(ValueError):
        repo.list_plans(limit=True, now_ms=1000)


def test_alternating_scope_one_physical_connection(pg2):
    owner, dsn, source = pg2
    install_access(owner)
    with open_application(dsn, source, settings=PoolSettings(max_size=1)) as app:
        a = app.repository
        other = SyntheticBackend(changed(source.assignment.binding,
                                         tenant_id='tenant-b', account_id='account-b'),
                                  '22222222-2222-2222-2222-222222222222')
        b = PostgresStrategyRepository(app.pool, other)
        p = save(a).bundle.plan
        q = changed(p, binding=other.assignment.binding)
        save(b, q)
        pids = set()
        for repo, expected in [(a, p), (b, q), (a, p), (b, q)]:
            assert repo.read_plan(p.plan_id, now_ms=1000).record.bundle.plan == expected
            assert len(repo.list_plans(now_ms=1000)) == 1
            with app.pool.transaction(scope_id=repo._scope_id) as connection:
                result = connection.execute("SELECT pg_backend_pid() AS pid,"
                                            "current_setting('pg2.scope_id') AS scope").fetchone()
                pids.add(result['pid'])
                assert result['scope'] == repo._scope_id
        assert len(pids) == 1
        with app.pool._pool.connection() as connection:
            assert connection.execute("SELECT current_setting('pg2.scope_id') AS scope"
                                      ).fetchone()['scope'] == ''
        with pytest.raises(r.ScopeDenied):
            save(b, p, 'cross')
        wrong = SyntheticBackend(source.assignment.binding)
        wrong.assignment = changed(wrong.assignment, authority_ref='wrong-authority')
        with pytest.raises(r.ScopeDenied, match='PROVENANCE'):
            PostgresStrategyRepository(app.pool, wrong)


@pytest.mark.parametrize('bad', ['hash', 'future', 'foreign', 'version', 'causal', 'locks'])
def test_negative_boundaries(app, bad):
    repo = app.repository
    p = save(repo).bundle.plan
    cp = checkpoint(p)
    if bad == 'hash':
        value = changed(cp, plan_sha256='0' * 64)
    elif bad == 'future':
        value = changed(cp, observed_at_ms=1001)
    elif bad == 'foreign':
        value = changed(cp, binding=changed(cp.binding, tenant_id='foreign'))
    elif bad == 'version':
        identity = p.spec.identity.model_copy(update={'version': 'old-v0'})
        invalid = p.model_copy(update={'spec': p.spec.model_copy(update={'identity': identity})})
        with pytest.raises(ValueError):
            repo.save_plan(c.PreflightInput.model_construct(plan=invalid,
                           evidence=(), approval=None),
                           request_key='bad', expected_revision=p.revision, now_ms=1000)
        return
    elif bad == 'causal':
        with pytest.raises(ValueError):
            changed(cp, observed_at_ms=0)
        return
    else:
        repo.save_recovery(cp, now_ms=1000)
        value = changed(cp, seq=2, previous_sha256=r.reference_hash(cp),
                        request_key='clear', reason_locks=())
    with pytest.raises(ValueError):
        repo.save_recovery(value, now_ms=1000)
    assert repo.reconcile_request('recovery', 'clear', '0' * 64) == 'UNKNOWN'


@pytest.mark.parametrize('mode', ['request', 'cas', 'sequence'])
def test_two_actual_connections_race(app, mode):
    repo = app.repository
    barrier = Barrier(2)
    def physical(_):
        with app.pool.transaction() as connection:
            pid = connection.info.backend_pid
            barrier.wait(timeout=5)
            return pid
    with ThreadPoolExecutor(2) as executor:
        assert len(set(executor.map(physical, range(2)))) == 2
    p = save(repo).bundle.plan if mode != 'request' else None
    def run(index):
        barrier.wait(timeout=5)
        try:
            if mode == 'sequence':
                return repo.save_recovery(checkpoint(p, request_key='cp'+str(index)), now_ms=1000)
            if mode == 'cas':
                return save(repo, changed(p, revision='v'+str(index+2)),
                            'key'+str(index), p.revision)
            return save(repo)
        except r.PersistenceConflict:
            return 'CONFLICT'
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(run, range(2)))
    if mode == 'request':
        assert results[0] == results[1]
        assert len(repo.list_plans(now_ms=1000)) == 1
    else:
        assert results.count('CONFLICT') == 1


@pytest.mark.parametrize('statement', [
    'UPDATE pg1_control.astarter_accounts SET risk_epoch=0',
    'UPDATE pg1_control.astarter_accounts SET baseline_quote=\'0\'',
    'DELETE FROM pg1_control.astarter_orders',
    'INSERT INTO pg1_control.astarter_fills DEFAULT VALUES',
    'DELETE FROM pg1_control.astarter_settlements',
    'UPDATE pg1_control.astarter_strategy_scopes SET tenant_id=tenant_id',
    'UPDATE pg1_control.pg1_metadata SET writer_version=1',
    'CREATE TABLE pg1_control.forbidden(x int)',
    'SELECT baseline_quote FROM pg1_control.astarter_accounts',
])
def test_real_login_finance_and_ddl_denied(pg2, statement):
    owner, dsn, _ = pg2
    install_access(owner)
    with psycopg.connect(dsn, autocommit=True) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            connection.execute(statement)


def test_readonly_login_and_owner_refused(pg2):
    owner, dsn, source = pg2
    install_access(owner)
    params = conninfo_to_dict(dsn)
    with open_application(make_conninfo(**(params | {'user': 'pg2_reader'})),
                          source, writable=False) as app:
        assert app.repository.list_plans(now_ms=1000) == ()
        with pytest.raises(PermissionError):
            save(app.repository)
    with psycopg.connect(**(params | {'user': 'pg2_reader'}), autocommit=True) as native:
        for statement in (
            'INSERT INTO pg1_control.astarter_plan_versions DEFAULT VALUES',
            'UPDATE pg1_control.astarter_accounts SET baseline_quote=\'0\'',
            'CREATE TABLE pg1_control.reader_forbidden(x int)',
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                native.execute(statement)
    with pytest.raises(AccessRejected):
        with open_application(make_conninfo(**(params | {'user': 'pg2_owner'})), source):
            pass


def test_pool_exhaustion_exception_timeout_and_close(pg2):
    owner, dsn, source = pg2
    install_access(owner)
    with open_application(dsn, source, settings=PoolSettings(
            max_size=1, acquire_timeout=0.1, statement_timeout_ms=150, lock_timeout_ms=100)) as app:
        with app.pool._pool.connection():
            with pytest.raises(PoolTimeout):
                app.repository.list_plans(now_ms=1000)
        with pytest.raises(RuntimeError, match='synthetic'):
            with app.pool.transaction(write=True) as connection:
                raise RuntimeError('synthetic')
        with pytest.raises(PersistenceUnavailable):
            with app.pool.transaction() as connection:
                connection.execute('SELECT pg_sleep(1)')
        assert save(app.repository).ordinal == 1
    with pytest.raises(PoolClosed):
        app.repository.list_plans(now_ms=1000)


def test_commit_ack_injection_unknown_no_replay(app, monkeypatch):
    repo = app.repository
    original = app.pool._commit
    calls = []
    def lost_ack(connection):
        original(connection)
        calls.append(1)
        raise psycopg.OperationalError('controlled ACK loss after real COMMIT')
    monkeypatch.setattr(app.pool, '_commit', lost_ack)
    with pytest.raises(CommitUnknown):
        save(repo)
    assert calls == [1]
    stored = repo.list_plans(now_ms=1000)
    assert len(stored) == 1
    digest = r.reference_hash(stored[0].record)
    assert repo.reconcile_request('plan', 'save-1', digest) == 'CONFIRMED'
    assert repo.reconcile_request('plan', 'save-1', '0' * 64) == 'CONFLICT'
    assert repo.reconcile_request('plan', 'missing', digest) == 'UNKNOWN'
    assert calls == [1]


def test_real_backend_disconnect_recycles_connection(app, pg2):
    params = conninfo_to_dict(pg2[1]) | {'user': 'pg1_owner'}
    with pytest.raises(PersistenceUnavailable):
        with app.pool.transaction(write=True) as connection:
            pid = connection.info.backend_pid
            with psycopg.connect(**params, autocommit=True) as admin:
                assert admin.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0]
            connection.execute('SELECT 1')
    assert save(app.repository).ordinal == 1


@pytest.mark.parametrize('mutation', [
    "UPDATE pg1_control.pg1_metadata SET resource_sha256=repeat('0',64)",
    "UPDATE pg1_control.pg1_metadata SET manifest_sha256=repeat('0',64)",
    'CREATE TABLE pg1_control.drift(x bigint)',
    'GRANT SELECT ON pg1_control.astarter_accounts TO pg2_reference_write',
])
def test_handshake_metadata_catalog_privilege_drift(app, pg2, mutation):
    pg2[0].execute(mutation)
    with pytest.raises(AccessRejected):
        app.repository.list_plans(now_ms=1000)


def test_repeatable_read_snapshot_and_lock_timeout(app):
    repo = app.repository
    p = save(repo).bundle.plan
    with app.pool.transaction() as reader:
        before = reader.execute('SELECT count(*) AS n FROM '
                                'pg1_control.astarter_plan_versions').fetchone()['n']
        save(repo, changed(p, revision='next'), 'next', p.revision)
        assert reader.execute('SELECT count(*) AS n FROM '
                              'pg1_control.astarter_plan_versions').fetchone()['n'] == before
    with app.pool.transaction(write=True, scope_id=repo._scope_id):
        with pytest.raises(PersistenceUnavailable):
            save(repo, changed(p, revision='timeout'), 'timeout', 'next')
    assert repo.reconcile_request('plan', 'timeout', '0' * 64) == 'UNKNOWN'


@pytest.mark.parametrize('version', ['0', '2'])
def test_real_app_old_writer_protocol_denied(pg2, version):
    install_access(pg2[0])
    with psycopg.connect(pg2[1], autocommit=True) as native:
        with pytest.raises(psycopg.errors.RaiseException):
            with native.transaction():
                native.execute("SELECT set_config('pg1.writer_version',%s,true)", (version,))
                native.execute('INSERT INTO pg1_control.astarter_strategy_versions '
                               'SELECT * FROM pg1_control.astarter_strategy_versions WHERE false')


def test_approval_oldhash_cross_scope_and_layer_rollback(app):
    repo = app.repository
    p = save(repo).bundle.plan
    with pytest.raises(ValueError):
        repo.save_approval(p.plan_id, changed(approval(p), plan_sha256='0' * 64),
                           request_key='bad-hash', now_ms=1000)
    with pytest.raises(r.ScopeDenied):
        repo.save_approval(p.plan_id, changed(approval(p),
            binding=changed(p.binding, tenant_id='foreign')), request_key='cross', now_ms=1000)
    ep = r.EpisodeReference(binding=p.binding, episode_id='ep', plan_id=p.plan_id,
                            revision=p.revision, plan_sha256=c.contract_hash(p))
    repo.save_episode(ep)
    cp = checkpoint(p, episode_id='ep', layer_index=0)
    future = changed(cp.causal, received_at_ms=1100)
    repo.save_layer(r.LayerReference(binding=p.binding, episode_id='ep', layer_index=0,
                    mode='VIRTUAL', action_id='future', trigger=future, disposition='UNKNOWN'))
    with pytest.raises(r.StoredReferenceError, match='FUTURE'):
        repo.save_recovery(cp, now_ms=1500)
    with pytest.raises(LookupError):
        repo.read_recovery(p.plan_id, p.revision, now_ms=1500)


def test_owner_setup_wrong_metadata_no_grant(pg2):
    owner, _, _ = pg2
    owner.execute("UPDATE pg1_control.pg1_metadata SET resource_sha256=repeat('0',64)")
    with pytest.raises(AccessRejected):
        install_access(owner)
    assert not owner.execute("SELECT has_schema_privilege('pg2_app','pg1_control','USAGE')"
                             ).fetchone()[0]


def test_server_commit_deferred_fk_rejection(app, monkeypatch):
    """Real server 23503 at COMMIT, not ACK injection or guard-name impersonation."""
    original = app.pool._commit
    sqlstates = []
    connections = []

    def observe_commit(connection):
        try:
            original(connection)
        except psycopg.errors.ForeignKeyViolation as error:
            sqlstates.append(error.sqlstate)
            raise

    monkeypatch.setattr(app.pool, '_commit', observe_commit)
    with pytest.raises(PersistenceUnavailable, match='^PG2_COMMIT_REJECTED$'):
        with app.pool.transaction(write=True) as connection:
            connections.append(connection)
            connection.execute('CREATE TEMP TABLE pg2_fk_fixture_parent(id int PRIMARY KEY)')
            connection.execute('CREATE TEMP TABLE pg2_fk_fixture_child('
                               'id int REFERENCES pg2_fk_fixture_parent(id) '
                               'DEFERRABLE INITIALLY DEFERRED)')
            connection.execute('INSERT INTO pg2_fk_fixture_child VALUES (1)')
            assert connection.execute('SELECT count(*) AS n FROM pg2_fk_fixture_child'
                                      ).fetchone()['n'] == 1
    assert sqlstates == ['23503']
    assert connections[0].closed
    with app.pool.transaction() as connection:
        assert connection.execute("SELECT to_regclass('pg_temp.pg2_fk_fixture_child') AS t"
                                  ).fetchone()['t'] is None
    assert save(app.repository).ordinal == 1
    assert len(app.repository.list_plans(now_ms=1000)) == 1


@pytest.mark.parametrize('mode', ['request', 'shared-spec', 'recovery-request'])
def test_cross_plan_scope_serialization(app, pg2, mode):
    repo = app.repository
    first = plan()
    second = changed(first, plan_id='other-plan')
    if mode == 'recovery-request':
        save(repo, first, 'first')
        save(repo, second, 'second')
    barrier = Barrier(2)

    def run(index):
        p = [first, second][index]
        barrier.wait(timeout=5)
        try:
            if mode == 'recovery-request':
                return repo.save_recovery(checkpoint(p), now_ms=1000)
            return save(repo, p, 'shared' if mode == 'request' else 'key'+str(index))
        except r.PersistenceConflict:
            return 'CONFLICT'

    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(run, range(2)))
    assert results.count('CONFLICT') == (0 if mode == 'shared-spec' else 1)
    assert pg2[0].execute('SELECT count(*) FROM pg1_control.astarter_strategy_versions'
                          ).fetchone()[0] == 1
