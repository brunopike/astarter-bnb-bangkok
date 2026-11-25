"""Explicit, expiring, reader-only PUBLIC synthetic preview. No provider assembly."""
import json
import os
import time
from collections.abc import Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from threading import Lock
from uuid import uuid4

from fastapi import Request
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg import Error as DriverError
from psycopg.conninfo import make_conninfo
from psycopg_pool import PoolClosed, PoolTimeout

from stark_trading_os.control.postgres.access import AccessRejected, RepositoryAccessContract
from stark_trading_os.control.postgres.pool import (
    PersistenceUnavailable,
    PgRepositoryPool,
    PoolSettings,
)
from stark_trading_os.control.postgres.synthetic_migration import TargetProfile
from stark_trading_os.control.public_data_shared import create_shared_public_app

HOST = "ep-divine-lake-azxddtms-pooler.c-3.ap-southeast-1.aws.neon.tech"
DATABASE = "astarter_public_f2_20261114"
READER = "r24_public_reader_20261114"
PATHS = frozenset("/v1/data/" + p for p in (
    "markets", "assets", "news", "explorer/capabilities",
))


def connection_error_category(error):
    # Only these fixed labels leave memory; driver inputs/messages never do.
    if not isinstance(error, DriverError):
        return 'OTHER'
    if error.sqlstate in {'28P01', '28000'}:
        return 'AUTHENTICATION'
    if error.sqlstate == '53300':
        return 'CAPACITY'
    message = str(error).lower()
    if 'quota' in message and ('exceeded' in message or 'exhausted' in message):
        return 'QUOTA_EXCEEDED'
    for category, fragments in (
        ('DNS', ('could not translate host name', 'name or service not known', 'name resolution')),
        ('TLS_CERTIFICATE', ('certificate verify failed', 'root certificate',
                             'certificate verification')),
        ('AUTHENTICATION', ('password authentication failed', 'authentication failed')),
        ('CAPACITY', ('too many connections', 'remaining connection slots')),
        ('CONNECT_TIMEOUT', ('timeout expired', 'connection timeout')),
        ('REFUSED', ('connection refused',)),
        ('CONNECTION_CLOSED', ('server closed the connection', 'ssl connection has been closed',
                              'ssl syscall')),
    ):
        if any(fragment in message for fragment in fragments):
            return category
    return 'UNKNOWN_DRIVER_ERROR'


def configuration(env: Mapping[str, str]) -> dict:
    try:
        if env.get("VERCEL_ENV") != "preview":
            raise ValueError
        cfg = json.loads(env.get("ASTARTER_PUBLIC_PREVIEW_CONFIG", "null"))
        if (not isinstance(cfg, dict)
                or set(cfg) != {"host", "dbname", "user", "password", "expires_at_ms"}
                or (cfg["host"], cfg["dbname"], cfg["user"]) != (HOST, DATABASE, READER)
                or not isinstance(cfg["password"], str) or len(cfg["password"]) < 12
                or type(cfg["expires_at_ms"]) is not int
                or not 0 < cfg["expires_at_ms"] <= 253402300799999):
            raise ValueError
        return cfg
    except (ValueError, TypeError, KeyError):
        raise ValueError("PUBLIC_PREVIEW_CONFIGURATION") from None


def create_preview_app(env: Mapping[str, str] | None = None):
    cfg = configuration(os.environ if env is None else env)
    dsn = make_conninfo(host=HOST, port=5432, dbname=DATABASE, user=READER,
                       password=cfg["password"], passfile="/dev/null",
                       sslmode="verify-full", sslrootcert="system", channel_binding="require")
    pool = PgRepositoryPool(
        dsn, writable=False, profile=TargetProfile.NEON_PG17_V1,
        access_contract=RepositoryAccessContract.PUBLIC_DATA_V1,
        settings=PoolSettings(max_size=2, acquire_timeout=10, check_on_checkout=True),
    )
    instance = uuid4().hex
    started = time.monotonic()
    lock = Lock()
    diagnostic = {'connect_started': 0, 'connect_active': 0, 'connect_ok': 0,
                  'connect_error': 0, 'last_error': 'NONE', 'last_duration_ms': 0.0}

    class ObservedConnection(Connection):
        @classmethod
        def connect(cls, *args, **kwargs):
            began = time.monotonic()
            with lock:
                diagnostic['connect_started'] += 1
                diagnostic['connect_active'] += 1
            try:
                connection = super().connect(*args, **kwargs)
            except Exception as error:
                with lock:
                    diagnostic['connect_error'] += 1
                    diagnostic['last_error'] = connection_error_category(error)
                raise
            finally:
                with lock:
                    diagnostic['connect_active'] -= 1
                    diagnostic['last_duration_ms'] = round((time.monotonic()-began)*1000, 3)
            with lock:
                diagnostic['connect_ok'] += 1
            return connection

    # Preview-only observation, before open; native pool retries/ACL/TLS stay unchanged.
    pool._pool.connection_class = ObservedConnection
    app = create_shared_public_app(reader_pool=pool, mode="offline_fixture")
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        if time.time_ns() // 1_000_000 >= cfg["expires_at_ms"]:
            yield
        else:
            async with AsyncExitStack() as stack:
                try:
                    await stack.enter_async_context(original_lifespan(application))
                except (AccessRejected, PersistenceUnavailable, PoolClosed, PoolTimeout):
                    application.state.public_data_managed = True
                    application.state.preview_startup_failed = True
                yield

    app.router.lifespan_context = lifespan
    app.openapi_url = app.docs_url = app.redoc_url = None

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        start = time.perf_counter()
        if request.method != "GET" or request.url.path not in PATHS | {"/healthz"}:
            response = JSONResponse({"code": "NOT_FOUND"}, status_code=404)
        elif request.headers.getlist("origin"):
            response = JSONResponse({"code": "ORIGIN_DENIED"}, status_code=403)
        elif time.time_ns() // 1_000_000 >= cfg["expires_at_ms"]:
            response = JSONResponse({"code": "PUBLIC_PREVIEW_EXPIRED"}, status_code=503)
        elif (getattr(app.state, "preview_startup_failed", False)
              and request.url.path != '/healthz'):
            response = JSONResponse({"code": "DATA_SERVICE_UNAVAILABLE"}, status_code=503)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-App-Mode"] = "offline_fixture"
        response.headers["Server-Timing"] = f"app;dur={(time.perf_counter()-start)*1000:.2f}"
        response.headers['X-Preview-Instance'] = instance
        with lock:
            response.headers['X-Preview-Connect-Error'] = diagnostic['last_error']
        return response

    @app.get("/healthz")
    async def health():
        with lock:
            counters = dict(diagnostic)
        stats = {key: value for key, value in pool._pool.get_stats().items()
                 if key in {'pool_size', 'pool_available', 'requests_waiting',
                            'connections_num', 'connections_errors', 'requests_errors',
                            'requests_queued', 'returns_bad'} and type(value) is int}
        result = {"service": "astarter-public-backend", "mode": "offline_fixture",
                "shared_snapshot_only": True, "collection_enabled": False,
                "release": os.environ.get("VERCEL_GIT_COMMIT_SHA"),
                "region": os.environ.get("VERCEL_REGION"), "database_region": "aws-ap-southeast-1",
                "real_trading_connected": False, "model_calls": 0,
                "instance": instance, "uptime_seconds": round(time.monotonic()-started, 3),
                "connection_diagnostics": counters, "native_pool_stats": stats,
                "pool_closed": bool(pool._pool.closed),
                "startup_failed": bool(getattr(app.state, 'preview_startup_failed', False))}
        if result['startup_failed']:
            return JSONResponse({**result, 'code': 'DATA_SERVICE_UNAVAILABLE'}, status_code=503)
        return result

    return app
