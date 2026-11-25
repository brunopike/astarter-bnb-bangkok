"""Local v2 HTTP integration uses real shared authority and native children."""

import asyncio
import sqlite3
import sys
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from conftest import ORIGIN, ApiHarness, SequentialHexIds, _dependencies

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.control.app import create_app
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.dependencies import (
    ApiCommandScheduler,
    build_default_dependencies,
    current_engine_identity,
)
from stark_trading_os.control.historical_configuration_service import HistoricalConfigurationService
from stark_trading_os.control.historical_control import HistoricalControl
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.domain.models import RunState
from tests.integration.runner.sma_component_fixture import prepare_sma_case

PREFIX = "/v2/historical"


class HistoricalHttpHarness:
    def __init__(self, root, config):
        self.root, self.config = root, config

    def dependencies(self, *, enabled):
        root = self.root
        dependencies = _dependencies(
            ApiHarness(root / "control.sqlite", root / "runtime", root / "runtime/runs")
        )
        if not enabled:
            return dependencies
        configurations = HistoricalConfigurationService(
            store=dependencies.store,
            runtime_root=root / "runtime",
            draft_id_factory=SequentialHexIds("sd"),
            configuration_id_factory=SequentialHexIds("cfg"),
        )
        cwd = root / "runtime/runner-cwd"
        cwd.mkdir(mode=0o700, exist_ok=True)
        historical = HistoricalControl(
            store=dependencies.store,
            configurations=configurations,
            runtime_root=root / "runtime",
            python_executable=Path(sys.executable).absolute(),
            runner_cwd=cwd,
        )
        cancellation = CancellationCoordinator(control=dependencies.store)
        engine = current_engine_identity()
        legacy = RunnerSupervisor(
            control=dependencies.store,
            runtime_root=root / "runtime",
            python_executable=Path(sys.executable).absolute(),
            runner_cwd=cwd,
            cancellation=cancellation,
        )
        scheduler = ApiCommandScheduler(
            store=dependencies.store,
            supervisor=legacy,
            cancellation=cancellation,
            recovery=dependencies.recovery,
            engine_identity=engine,
            historical=historical,
        )
        return replace(
            dependencies,
            cancellation=cancellation,
            scheduler=scheduler,
            engine_identity=engine,
            historical=historical,
        )

    @asynccontextmanager
    async def open(self, *, enabled=True, alter=None):
        dependencies = None

        def factory():
            nonlocal dependencies
            dependencies = self.dependencies(enabled=enabled)
            if alter is not None:
                dependencies = alter(dependencies)
            return dependencies

        app = create_app(testing=True, dependency_factory=factory, web_local_origin=ORIGIN)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://127.0.0.1:49540",
                headers={"Origin": ORIGIN},
            ) as client:
                yield client, dependencies


@pytest.fixture
def historical_http(tmp_path):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90])
    return HistoricalHttpHarness(tmp_path, config)


async def configure(client, config):
    created = await client.post(
        PREFIX + "/configuration-drafts", json=config.model_dump(mode="json")
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    published = await client.post(
        PREFIX + f"/configuration-drafts/{draft['draft_id']}/publish",
        json={"expected_revision": draft["revision"]},
    )
    assert published.status_code == 200, published.text
    return draft, published.json()


async def ready(client, version, *, key="ready"):
    response = await client.post(
        PREFIX + "/preflights",
        json={"configuration_id": version["configuration_id"]},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 200, response.text
    return response


def command(receipt):
    return {"preflight_id": receipt["preflight_id"], "request_sha256": receipt["request_sha256"]}


async def drain(dependencies):
    await asyncio.gather(*tuple(dependencies.scheduler._tasks.values()))
    await asyncio.sleep(0)


def test_disabled_surface_has_capability_but_no_mutation(historical_http):
    async def exercise():
        async with historical_http.open(enabled=False) as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            caps = await client.get(PREFIX + "/capabilities")
            assert caps.status_code == 200 and caps.json() == {
                "enabled": False,
                "environment": "BACKTEST",
                "contract_kind": "HISTORICAL_SMA_V2",
                "live_available": False,
            }
            for method, path, body in [
                ("GET", "/configurations", None),
                ("POST", "/configuration-drafts", historical_http.config.model_dump(mode="json")),
                ("POST", "/preflights", {"configuration_id": "cfg_" + "1" * 32}),
                ("POST", "/runs", {"preflight_id": "pfh_" + "1" * 32, "request_sha256": "a" * 64}),
            ]:
                response = await client.request(
                    method, PREFIX + path, json=body, headers={"Idempotency-Key": "disabled"}
                )
                assert (
                    response.status_code == 503 and response.json()["code"] == "CAPABILITY_DISABLED"
                )
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert not dependencies.scheduler.reservations

    asyncio.run(exercise())


@pytest.mark.parametrize("setting", [None, "0", "1"])
def test_default_builder_requires_explicit_enablement(tmp_path, monkeypatch, setting):
    if setting is None:
        monkeypatch.delenv("HISTORICAL_API_ENABLED", raising=False)
    else:
        monkeypatch.setenv("HISTORICAL_API_ENABLED", setting)
    dependencies = build_default_dependencies(tmp_path)
    try:
        assert (dependencies.historical is not None) is (setting == "1")
        if setting == "1":
            assert dependencies.scheduler._historical is dependencies.historical
            assert dependencies.historical._store is dependencies.store
    finally:
        asyncio.run(dependencies.scheduler.close())
        dependencies.store.close()


@pytest.mark.parametrize("setting", ["", "true", "2"])
def test_invalid_enablement_is_rejected_before_creating_runtime(tmp_path, monkeypatch, setting):
    monkeypatch.setenv("HISTORICAL_API_ENABLED", setting)
    with pytest.raises(ValueError):
        create_app(testing=True)
    with pytest.raises(ValueError):
        build_default_dependencies(tmp_path)
    assert not (tmp_path / "var").exists()


def test_enabled_graph_cannot_use_an_unbound_scheduler(historical_http):
    def altered(dependencies):
        dependencies.scheduler._historical = None
        return dependencies

    async def exercise():
        with pytest.raises(ValueError):
            async with historical_http.open(alter=altered):
                pytest.fail("mismatched graph started")

    asyncio.run(exercise())


def test_http_draft_cas_publication_and_pages_keep_exact_saved_versions(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            draft, version = await configure(client, historical_http.config)
            updated_body = historical_http.config.model_dump(mode="json") | {
                "name": "Edited",
                "expected_revision": 1,
            }
            updated = await client.put(
                PREFIX + f"/configuration-drafts/{draft['draft_id']}", json=updated_body
            )
            assert updated.status_code == 200 and updated.json()["revision"] == 2
            before = tuple(dependencies.store._connection.iterdump())
            stale = await client.put(
                PREFIX + f"/configuration-drafts/{draft['draft_id']}", json=updated_body
            )
            assert (
                stale.status_code == 409
                and stale.json()["code"] == "CONFIGURATION_REVISION_CONFLICT"
            )
            original = await client.post(
                PREFIX + f"/configuration-drafts/{draft['draft_id']}/publish",
                json={"expected_revision": 1},
            )
            assert original.json() == version
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert (await client.get(PREFIX + "/configurations?limit=1")).json()["items"] == [
                version
            ]
            assert (
                await client.get(PREFIX + f"/configurations/{version['configuration_id']}")
            ).json() == version
            assert (await client.get(PREFIX + "/configuration-drafts")).json()["items"] == [
                updated.json()
            ]
            unused = await client.post(
                PREFIX + "/configuration-drafts",
                json=historical_http.config.model_dump(mode="json"),
                headers={"Idempotency-Key": "unused"},
            )
            assert unused.status_code == 422

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Idempotency-Key": ""},
        {"Idempotency-Key": "bad key"},
        {"Idempotency-Key": "x" * 129},
        [("Idempotency-Key", "a"), ("Idempotency-Key", "b")],
    ],
)
def test_invalid_headers_reject_before_preflight_write(historical_http, headers):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            _, version = await configure(client, historical_http.config)
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.post(
                PREFIX + "/preflights",
                json={"configuration_id": version["configuration_id"]},
                headers=headers,
            )
            assert response.status_code == 422
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert not dependencies.scheduler._tasks

    asyncio.run(exercise())


def test_http_native_round_trip_returns_stored_202_before_completion(historical_http, monkeypatch):
    original = asyncio.create_subprocess_exec
    entered, release = asyncio.Event(), asyncio.Event()
    launches = 0

    async def launch(*args, **kwargs):
        nonlocal launches
        launches += 1
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    async def exercise():
        async with historical_http.open() as (client, dependencies):
            try:
                _, version = await configure(client, historical_http.config)
                preflight = await ready(client, version)
                receipt = preflight.json()
                run_id = receipt["run_id"]
                assert preflight.content == canonical_historical_bytes(
                    dependencies.historical._preflights.record(receipt["preflight_id"]).receipt
                )
                assert (await ready(client, version)).content == preflight.content
                request = command(receipt)
                response = await client.post(
                    PREFIX + "/runs", json=request, headers={"Idempotency-Key": "run"}
                )
                assert response.status_code == 202, response.text
                await asyncio.wait_for(entered.wait(), timeout=3)
                assert dependencies.store.historical_runner_outcome(run_id) is None
                stored = dependencies.store._connection.execute(
                    "SELECT response_body FROM idempotency_records "
                    "WHERE idempotency_scope='historical.create' AND idempotency_key='run'"
                ).fetchone()[0]
                assert response.content == stored
                assert (
                    await client.post(
                        PREFIX + "/runs", json=request, headers={"Idempotency-Key": "run"}
                    )
                ).content == stored
                assert (await client.get(PREFIX + f"/runs/{run_id}/artifacts")).status_code == 409
                release.set()
                await drain(dependencies)
                current = (await client.get(PREFIX + f"/runs/{run_id}")).json()
                assert (
                    current["state"] == "COMPLETED"
                    and current["publication"]["filesystem_verification"] == "NOT_CHECKED"
                )
                index = (await client.get(PREFIX + f"/runs/{run_id}/artifacts")).json()
                assert index["report_validation"] == "COMPLETE_PASSED"
                raw = await client.get(PREFIX + f"/runs/{run_id}/artifacts/historical_report")
                assert raw.status_code == 200
                assert (
                    raw.json()["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "979.8"
                )
                assert raw.content == dependencies.historical.read_artifact(
                    run_id=run_id, relative_path="reports/historical-report.json"
                )
                events = (await client.get(PREFIX + f"/runs/{run_id}/events?limit=2")).json()
                assert len(events["items"]) == 2 and events["next_after_seq"] == 2
                assert (
                    await client.get(PREFIX + f"/runs/{run_id}/events?after_seq=999")
                ).status_code == 422
                assert (
                    await client.post(
                        PREFIX + "/runs", json=request, headers={"Idempotency-Key": "run"}
                    )
                ).content == stored
                await drain(dependencies)
                assert launches == 1
            finally:
                release.set()

    asyncio.run(exercise())


def test_cancel_receipts_are_not_rewritten_and_unconsumed_cancel_has_no_write(
    historical_http, monkeypatch
):
    original = HistoricalControl.run_reserved
    release = asyncio.Event()

    async def delayed(self, run_id):
        await release.wait()
        return await original(self, run_id)

    monkeypatch.setattr(HistoricalControl, "run_reserved", delayed)

    async def exercise():
        async with historical_http.open() as (client, dependencies):
            try:
                _, version = await configure(client, historical_http.config)
                receipt = (await ready(client, version)).json()
                run_id = receipt["run_id"]
                path = PREFIX + f"/runs/{run_id}/cancel"
                before = tuple(dependencies.store._connection.iterdump())
                rejected = await client.post(
                    path, json={"reason": "user"}, headers={"Idempotency-Key": "early"}
                )
                assert rejected.status_code == 409 and rejected.json()["code"] == "STATE_CONFLICT"
                assert tuple(dependencies.store._connection.iterdump()) == before
                assert (
                    await client.post(
                        PREFIX + "/runs", json=command(receipt), headers={"Idempotency-Key": "run"}
                    )
                ).status_code == 202
                accepted = await client.post(
                    path, json={"reason": "user"}, headers={"Idempotency-Key": "cancel"}
                )
                assert accepted.status_code == 202
                release.set()
                await drain(dependencies)
                assert dependencies.store.run(run_id).state is RunState.CANCELLED
                replay = await client.post(
                    path, json={"reason": "user"}, headers={"Idempotency-Key": "cancel"}
                )
                assert replay.status_code == 202 and replay.content == accepted.content
                terminal = await client.post(
                    path, json={"reason": "user"}, headers={"Idempotency-Key": "terminal"}
                )
                assert terminal.status_code == 200
                await drain(dependencies)
                assert dependencies.store.runner_process(run_id) is None
                assert (
                    await client.get(PREFIX + f"/runs/{run_id}/artifacts/historical_report")
                ).status_code == 404
                await dependencies.scheduler.close()
                before = tuple(dependencies.store._connection.iterdump())
                closed = await client.post(
                    path, json={"reason": "user"}, headers={"Idempotency-Key": "closed"}
                )
                assert closed.status_code == 503
                assert (await client.get(PREFIX + f"/runs/{run_id}")).status_code == 200
                assert tuple(dependencies.store._connection.iterdump()) == before
            finally:
                release.set()

    asyncio.run(exercise())


def test_cross_contract_and_conflicting_commands_do_not_mutate(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            _, version = await configure(client, historical_http.config)
            _, other = await configure(
                client, historical_http.config.model_copy(update={"name": "Other"})
            )
            receipt = (await ready(client, version)).json()
            run_id = receipt["run_id"]
            legacy = "bt_" + "e" * 32
            dependencies.store.reserve_run(run_id=legacy)
            before = tuple(dependencies.store._connection.iterdump())
            for path in [
                f"/runs/{legacy}",
                f"/runs/{legacy}/events",
                f"/runs/{legacy}/artifacts",
                f"/runs/{legacy}/artifacts/run",
            ]:
                response = await client.get(PREFIX + path)
                assert (
                    response.status_code == 409
                    and response.json()["code"] == "RUN_CONTRACT_UNSUPPORTED"
                )
            response = await client.post(
                PREFIX + f"/runs/{legacy}/cancel",
                json={"reason": "user"},
                headers={"Idempotency-Key": "cross"},
            )
            assert (
                response.status_code == 409
                and response.json()["code"] == "RUN_CONTRACT_UNSUPPORTED"
            )
            assert (
                await client.post(
                    f"/v1/backtests/{run_id}/cancel",
                    json={"reason": "user"},
                    headers={"Idempotency-Key": "cross-v1"},
                )
            ).status_code == 409
            conflict = await client.post(
                PREFIX + "/preflights",
                json={"configuration_id": other["configuration_id"]},
                headers={"Idempotency-Key": "ready"},
            )
            assert conflict.status_code == 409 and conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"
            invalid = await client.post(
                PREFIX + "/runs",
                json=command(receipt) | {"input_manifest": "/private/do-not-echo"},
                headers={"Idempotency-Key": "invalid"},
            )
            assert invalid.status_code == 422 and "/private/do-not-echo" not in invalid.text
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert not dependencies.scheduler._tasks

    asyncio.run(exercise())


def test_restart_resumes_queue_committed_before_task_registration(historical_http, monkeypatch):
    original = asyncio.create_subprocess_exec
    launches = 0

    async def launch(*args, **kwargs):
        nonlocal launches
        launches += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    async def exercise():
        async with historical_http.open() as (client, dependencies):
            _, version = await configure(client, historical_http.config)
            receipt = (await ready(client, version)).json()
            dependencies.historical.reserve(**command(receipt), idempotency_key="lost")
            assert not dependencies.scheduler._tasks
        async with historical_http.open() as (client, dependencies):
            await drain(dependencies)
            run_id = receipt["run_id"]
            assert (await client.get(PREFIX + f"/runs/{run_id}")).json()["state"] == "COMPLETED"
            replay = await client.post(
                PREFIX + "/runs", json=command(receipt), headers={"Idempotency-Key": "lost"}
            )
            assert replay.status_code == 202 and replay.json()["state"] == "QUEUED"
            await drain(dependencies)
            assert launches == 1

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "failure,code",
    [
        ("missing", "PREFLIGHT_UNKNOWN"),
        ("hash", "HISTORICAL_PREFLIGHT_STALE"),
        ("expired", "HISTORICAL_PREFLIGHT_STALE"),
        ("capacity", "HISTORICAL_CAPACITY_BUSY"),
        ("engine", "ENGINE_VERSION_MISMATCH"),
    ],
)
def test_admission_failures_are_content_free_and_never_dispatch(
    historical_http, monkeypatch, failure, code
):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            _, version = await configure(client, historical_http.config)
            receipt = (await ready(client, version)).json()
            body = command(receipt)
            if failure == "missing":
                body["preflight_id"] = "pfh_" + "e" * 32
            elif failure == "hash":
                body["request_sha256"] = "0" * 64
            elif failure == "expired":
                dependencies.historical._preflights._clock = lambda: int(receipt["expires_at_ns"])
            elif failure == "capacity":
                occupied = (await ready(client, version, key="occupant-ready")).json()
                dependencies.historical.reserve(**command(occupied), idempotency_key="occupant-run")
                assert dependencies.store.run(occupied["run_id"]).state is RunState.QUEUED
            else:
                from stark_trading_os.control.routes import historical

                monkeypatch.setattr(historical, "engine_identity_check", lambda _value: "mismatch")
            before = tuple(dependencies.store._connection.iterdump())
            response = await client.post(
                PREFIX + "/runs", json=body, headers={"Idempotency-Key": "rejected"}
            )
            assert response.status_code == (
                404 if failure == "missing" else 503 if failure == "engine" else 409
            ), response.text
            assert response.json()["code"] == code
            assert response.json()["details"] is None
            assert tuple(dependencies.store._connection.iterdump()) == before
            assert not dependencies.scheduler._tasks

    asyncio.run(exercise())


def test_temporary_configuration_storage_failure_is_not_invalid_user_input(historical_http):
    async def exercise():
        async with historical_http.open() as (client, dependencies):
            before = tuple(dependencies.store._connection.iterdump())
            other = sqlite3.connect(historical_http.root / "control.sqlite", isolation_level=None)
            try:
                other.execute("BEGIN IMMEDIATE")
                response = await client.post(
                    PREFIX + "/configuration-drafts",
                    json=historical_http.config.model_dump(mode="json"),
                )
                assert response.status_code == 503, response.text
                assert response.json()["code"] == "CONTROL_UNAVAILABLE"
                assert "database is locked" not in response.text
                assert tuple(dependencies.store._connection.iterdump()) == before
                assert not dependencies.scheduler._tasks
            finally:
                other.rollback()
                other.close()
            # The original write failed; a later explicit request can create one draft.
            response = await client.post(
                PREFIX + "/configuration-drafts",
                json=historical_http.config.model_dump(mode="json"),
            )
            assert response.status_code == 201
            drafts = (await client.get(PREFIX + "/configuration-drafts")).json()["items"]
            assert len(drafts) == 1 and drafts[0] == response.json()

    asyncio.run(exercise())
