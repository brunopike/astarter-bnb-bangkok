"""Lifecycle faults use owned doubles; native identity/transactions are tested separately."""

import asyncio
import importlib
import importlib.util
import json
import socket
from dataclasses import asdict
from threading import Event
from unittest.mock import patch

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres.private_research_contracts import PrivateLease
from tests.unit.control.postgres.test_private_research_pool import target

MODULE = "stark_trading_os.control.private_research_service"
RUNTIME = "synthetic_runtime_" + "r" * 40
ISSUER = "synthetic_issuer_" + "i" * 40
PRIVATE = "/internal/private/v1/"


def env():
    t = target()
    lease = PrivateLease(
        leaseId="fixture-lease", targetId=t.target_id, database=t.database,
        schema="astarter_private", runtimeRole=t.runtime, audience="astarter-research",
        budgetId="fixture-budget", model="openai/gpt-4.1-mini", expiresAt=253402300799000,
    )
    return {
        "ASTARTER_PRIVATE_TARGET_JSON": json.dumps(asdict(t) | {"profile": t.profile.value}),
        "ASTARTER_PRIVATE_LEASE_JSON": lease.model_dump_json(by_alias=True),
        "ASTARTER_PRIVATE_RUNTIME_DATABASE_URL": make_conninfo(
            host=t.host, port=t.port, dbname=t.database, user=t.runtime,
        ),
        "ASTARTER_PRIVATE_ISSUER_DATABASE_URL": make_conninfo(
            host=t.host, port=t.port, dbname=t.database, user=t.issuer,
        ),
        "PRIVATE_RUNTIME_TOKEN": RUNTIME,
        "PRIVATE_ISSUER_TOKEN": ISSUER,
    }


def deny(*args, **kwargs):
    raise AssertionError("UNEXPECTED_EXTERNAL_IO")


def test_explicit_default_factory_is_present_and_inert():
    assert importlib.util.find_spec(MODULE) is not None, "PRIVATE lifecycle factory is missing"
    with patch.object(socket, "getaddrinfo", deny), patch.object(
        socket.socket, "connect", deny
    ), patch.object(psycopg, "connect", deny):
        service = importlib.import_module(MODULE)
        with patch.dict("os.environ", env(), clear=True):
            app = service.create_private_service()
        with TestClient(app) as client:
            response = client.post(PRIVATE + "auth/challenge/issue", json={})
        assert response.status_code == 503
        assert response.json()["code"] == "PRIVATE_UNCONFIGURED"


@pytest.fixture
def service():
    return importlib.import_module(MODULE)


def test_explicit_env_parse_and_factory_are_cold_and_secret_repr_is_redacted(service):
    with patch.object(socket, "getaddrinfo", deny), patch.object(
        socket.socket, "connect", deny
    ), patch.object(psycopg, "connect", deny), patch.object(service, "PgRepositoryPool", deny):
        config = service.PrivateServiceConfig.from_env(env())
        assert config is not None
        app = service.create_private_service(config)
        assert app is not None
        assert RUNTIME not in repr(config) and ISSUER not in repr(config)
        assert "private_runtime" not in repr(config)
        assert service.PrivateServiceConfig.from_env({}) is None
        assert service.create_private_service_from_env({}) is not None


@pytest.mark.parametrize("change", [
    {"PRIVATE_ISSUER_TOKEN": RUNTIME},
    {"PRIVATE_ISSUER_TOKEN": ""},
    {"PRIVATE_ISSUER_TOKEN": "synthetic invalid secret"},
    {"ASTARTER_PRIVATE_TARGET_JSON": '{"profile":"LOCAL_PG17","profile":"NEON_PG17_V1"}'},
    {"ASTARTER_PRIVATE_TARGET_JSON": '{"secret":"synthetic-private-dsn"}'},
    {"ASTARTER_PRIVATE_LEASE_JSON": '{"token":"synthetic-private-secret"}'},
    {"ASTARTER_PRIVATE_RUNTIME_DATABASE_URL": "x" * 8193},
])
def test_invalid_env_is_rejected_without_input_diagnostics(service, change):
    with patch.object(psycopg, "connect", deny):
        with pytest.raises(ValueError, match="^PRIVATE_SERVICE_CONFIGURATION$") as error:
            service.PrivateServiceConfig.from_env(env() | change)
    assert error.value.__suppress_context__


def test_target_and_lease_mismatch_is_rejected_cold(service):
    values = env()
    lease = json.loads(values["ASTARTER_PRIVATE_LEASE_JSON"])
    values["ASTARTER_PRIVATE_LEASE_JSON"] = json.dumps(lease | {"runtimeRole": "other_role"})
    with pytest.raises(ValueError, match="^PRIVATE_SERVICE_CONFIGURATION$"):
        service.PrivateServiceConfig.from_env(values)


@pytest.fixture
def lifecycle(service, monkeypatch):
    events, pools = [], []
    fault = {"open": None, "close": None, "construct": None, "gate": None,
             "close_gate": None, "invoke_gate": None}

    class Pool:
        def __init__(self, dsn, **options):
            self.role = options["private_role"]
            if fault["construct"] == self.role:
                raise ValueError("synthetic-private-dsn-must-not-leak")
            assert options["profile"] is options["private_target"].profile
            assert options["access_contract"].value == "PRIVATE_RESEARCH_V1"
            assert options["writable"] is True
            assert options["settings"].max_size <= 4
            pools.append(self)
            events.append((self.role, "construct"))

        def open(self):
            events.append((self.role, "open"))
            if fault["gate"] and self.role == "issuer":
                entered, release = fault["gate"]
                entered.set()
                assert release.wait(3)
            if fault["open"] == self.role:
                raise RuntimeError("synthetic-private-dsn-must-not-leak")

        def close(self):
            events.append((self.role, "close"))
            if fault["close_gate"] and self.role == "issuer":
                entered, release = fault["close_gate"]
                entered.set()
                assert release.wait(3)
            if fault["close"] == self.role:
                raise RuntimeError("synthetic-private-secret-must-not-leak")

    class Backend:
        def __init__(self, pool, **options):
            self.role = pool.role

        def invoke(self, operation, payload, session_digest):
            if fault["invoke_gate"]:
                entered, release = fault["invoke_gate"]
                events.append((self.role, "invoke"))
                entered.set()
                assert release.wait(3)
                events.append((self.role, "invoke_done"))
            return {"role": self.role, "operation": operation, "digest": session_digest}

    monkeypatch.setattr(service, "PgRepositoryPool", Pool)
    monkeypatch.setattr(service, "PrivateIssuerRepository", Backend)
    monkeypatch.setattr(service, "PrivateRuntimeRepository", Backend)
    config = service.PrivateServiceConfig.from_env(env())
    return service.create_private_service(config), events, pools, fault


def request(client, *, issuer=False):
    return client.post(
        PRIVATE + ("auth/challenge/get" if issuer else "lease"), json={},
        headers={"Authorization": "Bearer " + (ISSUER if issuer else RUNTIME),
                 **({} if issuer else {"X-Astarter-Private-Session-Digest": "a" * 64})},
    )


def test_routes_are_closed_outside_lifespan_and_bind_separate_native_roles(lifecycle):
    app, events, pools, _ = lifecycle
    assert events == []
    with TestClient(app) as client:
        assert request(client).json()["result"]["role"] == "runtime"
        assert request(client, issuer=True).json()["result"]["role"] == "issuer"
        assert len(pools) == 2 and pools[0] is not pools[1]
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
    assert request(client).status_code == 503
    assert app.state.private_service_error is None


@pytest.mark.parametrize("stage", ["open", "construct"])
def test_startup_failure_closes_every_constructed_pool_and_preserves_first_error(lifecycle, stage):
    app, events, _, fault = lifecycle
    fault[stage] = "issuer"
    fault["close"] = "runtime"
    with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_STARTUP_FAILED$") as error:
        with TestClient(app):
            pytest.fail("failed startup cannot yield application")
    assert error.value.__suppress_context__
    assert ("runtime", "close") in events
    if stage == "open":
        assert ("issuer", "close") in events
    assert app.state.private_service_error == "PRIVATE_SERVICE_STARTUP_FAILED"


def test_shutdown_failure_still_closes_other_pool_and_blocks_unknown_cleanup_reentry(lifecycle):
    app, events, _, fault = lifecycle
    fault["close"] = "issuer"
    with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_SHUTDOWN_FAILED$"):
        with TestClient(app) as client:
            assert request(client).status_code == 200
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
    before = list(events)
    with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_UNAVAILABLE$"):
        with TestClient(app):
            pytest.fail("unconfirmed cleanup cannot be reused")
    assert events == before


def test_same_app_is_single_owner_and_restart_requires_fresh_factory(lifecycle, service):
    app, events, pools, _ = lifecycle

    async def scenario():
        async with app.router.lifespan_context(app):
            with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_UNAVAILABLE$"):
                async with app.router.lifespan_context(app):
                    pytest.fail("nested lifespan cannot take ownership")
            assert events.count(("runtime", "close")) == 0
        with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_UNAVAILABLE$"):
            async with app.router.lifespan_context(app):
                pytest.fail("old queued RPC cannot be admitted into a new generation")
        fresh = service.create_private_service(service.PrivateServiceConfig.from_env(env()))
        async with fresh.router.lifespan_context(fresh):
            assert len(pools) == 4 and len({id(p) for p in pools}) == 4

    asyncio.run(scenario())
    assert events.count(("runtime", "close")) == events.count(("issuer", "close")) == 2


def test_shutdown_drains_real_rpc_invoke_before_closing_pools(lifecycle):
    app, events, _, fault = lifecycle
    entered, release = Event(), Event()
    fault["invoke_gate"] = entered, release

    async def scenario():
        lifetime = app.router.lifespan_context(app)
        await lifetime.__aenter__()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://testserver") as client:
            task = asyncio.create_task(client.post(
                PRIVATE + "research/claim", json={},
                headers={"Authorization": "Bearer " + RUNTIME,
                         "X-Astarter-Private-Session-Digest": "a" * 64},
            ))
            assert await asyncio.to_thread(entered.wait, 2)
            closing = asyncio.create_task(lifetime.__aexit__(None, None, None))
            returned_early = False
            try:
                try:
                    await asyncio.wait_for(asyncio.shield(closing), .1)
                    returned_early = True
                except TimeoutError:
                    pass
            finally:
                release.set()
            assert (await task).status_code == 200
            await closing
        assert not returned_early, "lifespan returned while a native invoke was still owned"
        assert events.index(("runtime", "invoke_done")) < events.index(("runtime", "close"))

    asyncio.run(scenario())


def test_unavailable_executor_cleanup_preserves_first_error_and_closes_pools(lifecycle):
    app, events, _, _ = lifecycle

    async def scenario():
        with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_FAILED$"):
            async with app.router.lifespan_context(app):
                await asyncio.get_running_loop().shutdown_default_executor()
                raise ValueError("synthetic-private-secret-must-not-leak")

    asyncio.run(scenario())
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
    assert app.state.private_service_error == "PRIVATE_SERVICE_LIFESPAN_FAILED"


def test_unavailable_executor_shutdown_error_is_fixed_and_closes_pools(lifecycle):
    app, events, _, _ = lifecycle

    async def scenario():
        with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_SHUTDOWN_FAILED$") as error:
            async with app.router.lifespan_context(app):
                await asyncio.get_running_loop().shutdown_default_executor()
        assert error.value.__suppress_context__

    asyncio.run(scenario())
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]


def test_startup_cancellation_drains_native_open_before_closing_both(lifecycle):
    app, events, _, fault = lifecycle
    entered, release = Event(), Event()
    fault["gate"] = entered, release

    async def scenario():
        async def run():
            async with app.router.lifespan_context(app):
                pytest.fail("cancelled startup cannot become ready")

        task = asyncio.create_task(run())
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert not any(action == "close" for _, action in events)
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
    assert app.state.private_service_error == "PRIVATE_SERVICE_CANCELLED"


def test_cleanup_failure_cannot_mask_sanitized_lifespan_body_failure(lifecycle):
    app, events, _, fault = lifecycle
    fault["close"] = "issuer"

    async def scenario():
        with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_FAILED$"):
            async with app.router.lifespan_context(app):
                raise ValueError("synthetic-private-secret-must-not-leak")

    asyncio.run(scenario())
    assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
    assert app.state.private_service_error == "PRIVATE_SERVICE_LIFESPAN_FAILED"


def test_cancelled_cleanup_drains_both_pools_and_never_reenters_an_unknown_cleanup(lifecycle):
    app, events, pools, fault = lifecycle
    entered, release = Event(), Event()
    fault["close_gate"] = entered, release
    fault["close"] = "issuer"

    async def scenario():
        async def run():
            async with app.router.lifespan_context(app):
                pass

        task = asyncio.create_task(run())
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert events[-2:] == [("issuer", "close"), ("runtime", "close")]
        assert len(pools) == 2
        with pytest.raises(RuntimeError, match="^PRIVATE_SERVICE_LIFESPAN_UNAVAILABLE$"):
            async with app.router.lifespan_context(app):
                pytest.fail("cancelled cleanup result must not be treated as clean")
        assert len(pools) == 2

    asyncio.run(scenario())
