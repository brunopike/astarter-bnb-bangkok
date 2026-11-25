"""PG3 fake credentials only; default and denial must never borrow a database."""
import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.app import create_app
from stark_trading_os.control.postgres.identity import Grant, IdentityRegistry, IdentityRejected
from tests.unit.control.test_astarter_strategy_repository import SyntheticBackend

FAKE = 'fake-local-only-' + 'a' * 40


def grant(**changes):
    return Grant(**(dict(
        token_digest=hashlib.sha256(FAKE.encode()).hexdigest(), subject='synthetic-subject',
        scope=SyntheticBackend().assignment, role='reader', audience='pg3-local',
        not_before_ms=0, expires_at_ms=time.time_ns() // 1000000 + 60000,
    ) | changes))


def test_valid_fixed_scope_and_revocation():
    g = grant()
    registry = IdentityRegistry('pg3-local', (g,))
    principal = registry.authenticate(('Bearer ' + FAKE,))
    assert principal.scope == g.scope and principal.subject == g.subject
    registry.revoke(g.token_digest)
    with pytest.raises(IdentityRejected):
        registry.authenticate(('Bearer ' + FAKE,))


@pytest.mark.parametrize('headers', [(), ('',), ('Bearer forged',),
    ('Bearer ' + FAKE, 'Bearer ' + FAKE), ('bearer ' + FAKE,),
    ('Bearer ' + FAKE + ' ',), ('Bearer ' + 'x' * 257,)])
def test_bad_authorization(headers):
    with pytest.raises(IdentityRejected):
        IdentityRegistry('pg3-local', (grant(),)).authenticate(headers)


@pytest.mark.parametrize('changes', [dict(expires_at_ms=1), dict(audience='other'),
    dict(not_before_ms=9999999999999, expires_at_ms=99999999999999)])
def test_server_time_and_audience(changes):
    with pytest.raises(IdentityRejected):
        IdentityRegistry('pg3-local', (grant(**changes),)).authenticate(('Bearer ' + FAKE,))


def test_default_does_not_install_reference_routes():
    app = create_app(testing=True)
    with TestClient(app) as client:
        response = client.get('/v1/strategy-references/plans',
                              headers={'Origin': 'http://127.0.0.1:3000'})
        assert response.status_code == 404


def test_reference_only_requires_runtime():
    with pytest.raises(ValueError, match='REFERENCE_CONFIGURATION'):
        create_app(testing=True, strategy_reference_only=True)
