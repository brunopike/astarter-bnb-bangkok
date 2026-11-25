"""Pure configuration and shared codec compatibility boundaries."""
# ruff: noqa: E402 -- optional extras are gated before importing their entrypoint.
import os
from importlib.resources import files

import pytest

if not any(key.startswith('PG2_TEST_') for key in os.environ):
    pytest.importorskip('psycopg')
    pytest.importorskip('psycopg_pool')

from stark_trading_os.control.postgres.pool import PoolSettings


@pytest.mark.parametrize('updates', [
    {'max_size': 0}, {'max_size': 17}, {'min_size': -1}, {'min_size': 2, 'max_size': 1},
    {'max_size': True}, {'connect_timeout': True}, {'acquire_timeout': float('nan')},
    {'acquire_timeout': float('inf')}, {'acquire_timeout': 0}, {'lock_timeout_ms': 0},
    {'statement_timeout_ms': 30001}, {'statement_timeout_ms': 100, 'lock_timeout_ms': 101},
])
def test_pool_bounds(updates):
    with pytest.raises(ValueError, match='PG2_POOL_BOUNDS'):
        PoolSettings(**updates)


def test_resources_and_lazy_public_exports():
    from stark_trading_os.control.postgres import PostgresStrategyRepository, open_application
    from stark_trading_os.control.postgres.strategy_repository import (
        PostgresStrategyRepository as P,
    )
    assert PostgresStrategyRepository is P and callable(open_application)
    resource = files('stark_trading_os.control.postgres')
    assert 'UPDATE(singleton)' in resource.joinpath('access_v1.sql').read_text()
    assert 'CREATE SCHEMA pg1_control' in resource.joinpath('schema_v1.sql').read_text()


@pytest.mark.parametrize('mode', ['member-set', 'admin'])
def test_role_reachability_rejection_without_granting_privileges(mode):
    """Pure guard test only: no prohibited privilege escalation fixture is executed."""
    from stark_trading_os.control.postgres.access import AccessRejected, verify_access
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile

    class Connection:
        def execute(self, query, **kwargs):
            members = [dict(rolname='pg2_reference_write', unsafe=False)]
            if mode == 'member-set':
                members.append(dict(rolname='broad-reachable-via-set', unsafe=False))
            self.results = [[dict(name='app', login='app', rolcanlogin=True, unsafe=False)],
                            members, [{'present': 1}], [], [], [], [], []]
            self.index = 0
            return self

        def fetchall(self):
            return self.results[self.index]

        def nextset(self):
            self.index += 1
            return self.index < len(self.results)

    with pytest.raises(AccessRejected, match='PG2_ROLE_MEMBERSHIP|PG2_ROLE_ADMIN'):
        verify_access(Connection(), writable=True, profile=TargetProfile.LOCAL_PG17)


@pytest.mark.parametrize('sets', [0, 7, 9])
def test_missing_or_extra_access_results_fail_closed(sets):
    from stark_trading_os.control.postgres.access import AccessRejected, verify_access
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile

    class Connection:
        index = 0

        def execute(self, query, **kwargs):
            return self

        def fetchall(self):
            return []

        def nextset(self):
            self.index += 1
            return self.index < sets

    with pytest.raises(AccessRejected, match='PG2_ACCESS_RESULTS'):
        verify_access(Connection(), writable=True, profile=TargetProfile.LOCAL_PG17)
