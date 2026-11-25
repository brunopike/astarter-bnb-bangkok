import json
import subprocess
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from psycopg import OperationalError, errors

from cloud_preview import (
    DATABASE,
    HOST,
    READER,
    configuration,
    connection_error_category,
    create_preview_app,
)
from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import PersistenceUnavailable


def env(**overrides):
    value = dict(host=HOST, dbname=DATABASE, user=READER, password="synthetic-only-password",
                 expires_at_ms=time.time_ns() // 1_000_000 + 100000)
    value.update(overrides)
    return {"VERCEL_ENV": "preview", "ASTARTER_PUBLIC_PREVIEW_CONFIG": json.dumps(value)}


class PreviewTests(unittest.TestCase):
    def test_preview_cold_import_uses_only_synthetic_configuration(self):
        code = """
import socket, sqlite3, threading, asyncio
def fail(*a, **k): raise AssertionError('UNEXPECTED_IO')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = fail
sqlite3.connect = threading.Thread.start = asyncio.create_task = fail
from app import app
print('ZERO_IO')
"""
        result = subprocess.run([sys.executable, '-B', '-c', code], env=env(),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'ZERO_IO')

    def test_configuration_is_explicit_and_target_bound(self):
        self.assertEqual(configuration(env())["dbname"], DATABASE)
        invalid = [{}, {**env(), "VERCEL_ENV": "production"}, env(host="example.com"),
                   env(dbname="astarter_synthetic"), env(user="astarter_test_owner"),
                   env(expires_at_ms=True), env(extra="bad"), env(password="short")]
        with patch("cloud_preview.PgRepositoryPool") as constructor:
            for value in invalid:
                with self.subTest(value=list(value)):
                    with self.assertRaisesRegex(ValueError, "PUBLIC_PREVIEW_CONFIGURATION"):
                        create_preview_app(value)
            constructor.assert_not_called()

    def test_reader_only_and_no_external_or_internal_routes(self):
        p = MagicMock(writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
        with patch("cloud_preview.PgRepositoryPool", return_value=p) as constructor:
            app = create_preview_app(env())
            self.assertFalse(constructor.call_args.kwargs["writable"])
            self.assertIn("sslmode=verify-full", constructor.call_args.args[0])
            self.assertIn("sslrootcert=system", constructor.call_args.args[0])
            with TestClient(app) as client:
                r = client.get("/healthz")
                self.assertEqual(r.json()["mode"], "offline_fixture")
                self.assertFalse(r.json()["collection_enabled"])
                self.assertEqual(r.headers["cache-control"], "no-store")
                self.assertEqual(client.post("/internal/public-data/refresh").status_code, 404)
                self.assertEqual(client.get("/docs").status_code, 404)
                denied = client.get("/healthz", headers={"Origin": "https://evil.test"})
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(client.get("/v1/data/markets?asset_ids=unknown").status_code, 400)
            p.close.assert_called_once()

    def test_expired_preview_never_opens_database(self):
        p = MagicMock(writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
        with patch("cloud_preview.PgRepositoryPool", return_value=p):
            with TestClient(create_preview_app(env(expires_at_ms=1))) as client:
                self.assertEqual(client.get("/v1/data/markets").status_code, 503)
            p.open.assert_not_called()

    def test_startup_connection_failure_is_bounded_unavailable(self):
        p = MagicMock(writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
        p.open.side_effect = PersistenceUnavailable("sanitized")
        with patch("cloud_preview.PgRepositoryPool", return_value=p):
            with TestClient(create_preview_app(env())) as client:
                for path in ("/v1/data/markets", "/v1/data/assets", "/v1/data/news", "/healthz"):
                    r = client.get(path)
                    self.assertEqual(r.status_code, 503)
                    self.assertEqual(r.json()['code'], 'DATA_SERVICE_UNAVAILABLE')
                    if path == '/healthz':
                        self.assertTrue(r.json()['startup_failed'])
                    else:
                        self.assertEqual(r.json(), {"code": "DATA_SERVICE_UNAVAILABLE"})
                    self.assertEqual(r.headers["cache-control"], "no-store")
            p.open.assert_called_once()
            p.close.assert_called_once()

    def test_connection_diagnostics_delegate_once_and_never_emit_driver_message(self):
        p = MagicMock(writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
        p._pool.get_stats.return_value = {'pool_size': 2, 'connections_errors': 1,
                                         'secret-field': 'synthetic-secret'}
        p._pool.closed = False
        with patch('cloud_preview.PgRepositoryPool', return_value=p):
            app = create_preview_app(env())
            observed = p._pool.connection_class
            error = OperationalError('connection refused synthetic-secret')
            with patch('cloud_preview.Connection.connect', side_effect=error) as native:
                with self.assertRaises(OperationalError) as raised:
                    observed.connect('synthetic-dsn', connect_timeout=5)
                self.assertIs(raised.exception, error)
                native.assert_called_once_with('synthetic-dsn', connect_timeout=5)
            sentinel = object()
            with patch('cloud_preview.Connection.connect', return_value=sentinel) as native:
                self.assertIs(observed.connect('synthetic-dsn'), sentinel)
                native.assert_called_once_with('synthetic-dsn')
            with TestClient(app) as client:
                response = client.get('/healthz')
                body = response.json()
                self.assertEqual(body['instance'], response.headers['x-preview-instance'])
                self.assertEqual(body['connection_diagnostics']['connect_started'], 2)
                self.assertEqual(body['connection_diagnostics']['connect_active'], 0)
                self.assertEqual(body['connection_diagnostics']['connect_ok'], 1)
                self.assertEqual(body['connection_diagnostics']['connect_error'], 1)
                self.assertEqual(body['connection_diagnostics']['last_error'], 'REFUSED')
                self.assertEqual(body['native_pool_stats'],
                                 {'pool_size': 2, 'connections_errors': 1})
                self.assertNotIn('synthetic-secret', response.text)

    def test_connection_classification_keeps_unknowns_and_fixed_labels(self):
        cases = [(ValueError('synthetic-secret'), 'OTHER'),
                 (OperationalError('synthetic-secret'), 'UNKNOWN_DRIVER_ERROR'),
                 (errors.InvalidPassword('synthetic-secret'), 'AUTHENTICATION'),
                 (errors.TooManyConnections('synthetic-secret'), 'CAPACITY'),
                 (OperationalError('could not translate host name synthetic-secret'), 'DNS'),
                 (OperationalError('certificate verify failed synthetic-secret'),
                  'TLS_CERTIFICATE'),
                 (OperationalError('timeout expired synthetic-secret'), 'CONNECT_TIMEOUT')]
        for error, expected in cases:
            self.assertEqual(connection_error_category(error), expected)

    def test_quota_category_requires_explicit_exhaustion(self):
        for message in ('compute time quota has been exceeded synthetic-secret',
                        'active time quota exhausted synthetic-secret'):
            self.assertEqual(connection_error_category(OperationalError(message)), 'QUOTA_EXCEEDED')
        for message in ('quota reset tomorrow', 'connection limit exceeded'):
            self.assertEqual(connection_error_category(OperationalError(message)),
                             'UNKNOWN_DRIVER_ERROR')

    def test_preview_enables_bounded_checkout_through_public_settings(self):
        p = MagicMock(writable=False, access_contract=RepositoryAccessContract.PUBLIC_DATA_V1)
        with patch('cloud_preview.PgRepositoryPool', return_value=p) as constructor:
            create_preview_app(env())
        settings = constructor.call_args.kwargs['settings']
        self.assertTrue(settings.check_on_checkout)
        self.assertEqual(settings.acquire_timeout, 10)
        self.assertEqual(settings.max_size, 2)


if __name__ == "__main__":
    unittest.main()
