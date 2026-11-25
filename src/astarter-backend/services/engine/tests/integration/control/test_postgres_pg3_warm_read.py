"""Real local PG protocol waits, not remote latency or a cloud SLA."""
# ruff: noqa: E402 -- owned PG gate precedes optional imports.
import json
import os
import time
from collections import Counter
from pathlib import Path

import pytest

if not os.environ.get('PG3_TEST_ROOT'):
    pytest.skip('PG3 owned fixture not configured', allow_module_level=True)

from fastapi.testclient import TestClient
from psycopg import Connection, pq

from tests.integration.control.test_postgres_pg3_caller import (
    PREFIX,
    app_for,
    headers,
    payload,
    runtime,
)
from tests.integration.control.test_postgres_pg3_caller import pg2 as pg2


@pytest.mark.parametrize('role', ['reader', 'writer'])
def test_warm_read_has_bounded_waits_without_skipping_private_checks(pg2, monkeypatch, role):
    """Catch sequential catalog/privilege roundtrips on the actual HTTP path."""
    rt = runtime(pg2)
    observations = []
    with TestClient(app_for(rt)) as client:
        body = payload()
        assert client.post(PREFIX + '/plans', json=body, headers=headers()).status_code == 200
        plan_id = body['bundle']['plan']['plan_id']
        expected = None
        for _ in range(3):
            calls = []
            original = Connection.execute

            def observed(connection, query, *args, **kwargs):
                # Only fixed SQL categories/times survive this local instrumentation.
                text = query if isinstance(query, str) else query.as_string(connection)
                category = ('access' if 'pg_roles' in text or 'pg_class' in text
                            or 'pg_auth_members' in text or 'pg1_metadata' in text
                            or 'has_database_privilege' in text else
                            'transaction' if text.startswith(('BEGIN', 'SET ', 'ROLLBACK'))
                            or "set_config(" in text else 'scope_or_data')
                start = time.perf_counter()
                try:
                    return original(connection, query, *args, **kwargs)
                finally:
                    calls.append((category, (time.perf_counter() - start) * 1000))

            with monkeypatch.context() as patch:
                patch.setattr(Connection, 'execute', observed)
                started = time.perf_counter()
                response = client.get(PREFIX + '/plans/' + plan_id, headers=headers(role))
                elapsed_ms = (time.perf_counter() - started) * 1000
            assert response.status_code == 200
            result = response.json()
            assert result['reference_only'] and not result['execution_authorized']
            assert not result['result']['decision']['execution_authorized']
            if expected is None:
                expected = result
            assert result == expected
            categories = Counter(category for category, _ in calls)
            observations.append({'elapsed_ms': elapsed_ms, 'execute_calls': dict(categories),
                                 'execute_ms': sum(ms for _, ms in calls),
                                 'wait_boundaries': len(calls)})
    print(json.dumps({'synthetic_unix_only': True, 'observations': observations}))
    root = Path(os.environ['PG3_TEST_ROOT'])
    evidence = root / (role + '-' + os.environ.get('PG3_WARM_EVIDENCE_NAME', 'warm-protocol.json'))
    evidence.write_text(json.dumps(observations, indent=2) + '\n')
    assert all(0 < item['wait_boundaries'] <= 14 for item in observations), observations


def test_latest_read_uses_repeatable_snapshot_and_next_request_sees_new_revision(pg2, monkeypatch):
    from stark_trading_os.domain import strategy_contracts as c
    from tests.unit.domain.test_strategy_contracts import changed

    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        body = payload()
        assert client.post(PREFIX + '/plans', json=body, headers=headers()).status_code == 200
        original = c.preflight
        updated = False

        def publish_after_read(bundle, *, now_ms):
            nonlocal updated
            decision = original(bundle, now_ms=now_ms)
            if not updated:
                updated = True
                newer = changed(bundle, plan=changed(bundle.plan, revision='plan-v2'))
                writer = rt.admit((headers()['Authorization'],), write=True)
                writer.save_plan(newer, request_key='concurrent-v2',
                                 expected_revision='plan-v1')
            return decision

        with monkeypatch.context() as patch:
            patch.setattr(c, 'preflight', publish_after_read)
            first = client.get(PREFIX + '/plans/fixture-plan', headers=headers('reader'))
        assert first.status_code == 200
        assert updated and first.json()['result']['current']
        assert first.json()['result']['record']['bundle']['plan']['revision'] == 'plan-v1'
        second = client.get(PREFIX + '/plans/fixture-plan', headers=headers('reader'))
        assert second.status_code == 200 and second.json()['result']['current']
        assert second.json()['result']['record']['bundle']['plan']['revision'] == 'plan-v2'
        history = client.get(PREFIX + '/plans/fixture-plan', params={'revision': 'plan-v1'},
                             headers=headers('reader'))
        assert history.status_code == 200 and not history.json()['result']['current']
        assert history.json()['result']['decision']['reasons'] == ['PLAN_SUPERSEDED']


@pytest.mark.parametrize('role', ['reader', 'writer'])
def test_batched_check_sql_failure_rolls_back_before_business_and_reuses_pool(pg2, monkeypatch,
                                                                           role):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        pool = rt.reader if role == 'reader' else rt.writer
        with pool._pool.connection() as native:
            pid = native.info.backend_pid
        body = payload(key='guard-failure-no-write')
        original = Connection.execute

        def failed_check(connection, query, *args, **kwargs):
            if isinstance(query, str) and 'has_database_privilege' in query:
                query = query.replace("has_database_privilege(current_database(),'CREATE')",
                                      '(1 / 0 = 1)')
            return original(connection, query, *args, **kwargs)

        def request():
            if role == 'reader':
                return client.get(PREFIX + '/plans', headers=headers(role))
            return client.post(PREFIX + '/plans', json=body, headers=headers(role))

        with monkeypatch.context() as patch:
            patch.setattr(Connection, 'execute', failed_check)
            response = request()
        assert response.status_code == 503 and not response.json()['retryable']
        assert pg2[0].execute('SELECT count(*) FROM pg1_control.astarter_plan_versions'
                              ).fetchone()[0] == 0
        with pool._pool.connection() as connection:
            assert connection.info.backend_pid == pid
            assert connection.info.transaction_status == pq.TransactionStatus.IDLE
        assert request().status_code == 200


def test_warm_connection_revalidates_metadata_without_permission_cache(pg2):
    rt = runtime(pg2)
    with TestClient(app_for(rt)) as client:
        owner = pg2[0]
        assert client.get(PREFIX + '/plans', headers=headers('reader')).status_code == 200
        original = owner.execute('SELECT manifest_sha256 FROM pg1_control.pg1_metadata'
                                 ).fetchone()[0]
        owner.execute("UPDATE pg1_control.pg1_metadata SET manifest_sha256=repeat('0',64)")
        response = client.get(PREFIX + '/plans', headers=headers('reader'))
        assert response.status_code == 422 and response.json()['code'] == 'REFERENCE_INVALID'
        owner.execute('UPDATE pg1_control.pg1_metadata SET manifest_sha256=%s', (original,))
        assert client.get(PREFIX + '/plans', headers=headers('reader')).status_code == 200
        assert rt.reader._pool.get_stats()['connections_num'] == 1
