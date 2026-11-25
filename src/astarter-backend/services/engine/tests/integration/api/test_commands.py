from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import Any, cast

import pytest
from conftest import (
    ORIGIN,
    ApiHarness,
    _dependencies,
    draft_payload,
    publish,
    queued_run,
    ready_preflight,
    seed_staged_finalizing_run,
    seed_verified_cancelled_run,
)
from fastapi.testclient import TestClient

from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.audit.materializer import CanonicalMaterializer
from stark_trading_os.catalog.fixture_registry import FixtureInvalid
from stark_trading_os.control.app import create_app
from stark_trading_os.control.cancellation import (
    CancellationCoordinator,
    TerminationObservation,
)
from stark_trading_os.control.dependencies import (
    ApiCommandScheduler,
    ControlDependencies,
    build_default_dependencies,
    current_engine_identity,
)
from stark_trading_os.control.preflight import EngineIdentity, RunReservation
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    ProcessObservation,
    RunnerOutcomeRecord,
    RunnerProcessRecord,
    SupervisorExitV1,
    capture_process_identity,
    observe_process,
    process_identity_digest,
    supervisor_exit_bytes,
    supervisor_exit_from_bytes,
)
from stark_trading_os.control.recovery import ArtifactAccessDenied
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogPublication,
    ControlStore,
    EventCandidate,
    TerminalPublication,
)
from stark_trading_os.control.supervisor import (
    RunnerSupervisor,
    build_minimal_runner_environment,
    stage_input_manifest,
)
from stark_trading_os.control.transactions import (
    FinalizationFailure,
    IdempotencyCommand,
    PersistedCancelRequest,
)
from stark_trading_os.domain.models import BacktestDraftRequest, RunState
from stark_trading_os.runner.protocol import RunnerOutcomeV1, RunnerReportCandidateV1
from stark_trading_os.runner.report_export import export_metrics, normalize_report_row
from tests.sqlite_corruption import open_corruption_connection


def _assert_run_evidence_integrity_failure(response: Any, *, run_id: str) -> None:
    assert response.status_code == 409
    assert response.json() == {
        "code": "RUN_EVIDENCE_INTEGRITY_FAILED",
        "message": "The run evidence failed authoritative integrity verification.",
        "run_id": run_id,
        "retryable": False,
        "evidence_id": None,
        "details": None,
    }


def _assert_unavailable_performance(value: object, *, reason: str) -> None:
    assert value == {
        "completeness": "UNAVAILABLE",
        "unavailable_reason": reason,
        "series_schema": None,
        "source": None,
        "selection": None,
        "calculation": None,
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
        "account_id": None,
        "currency": None,
        "points": [],
        "provenance": None,
    }


def _api_metrics_bytes(*, include_performance_series: bool = True) -> bytes:
    metrics: dict[str, object] = {
        "summary": {
            "orders.total": "0",
            "orders.closed": "0",
            "orders.inflight": "0",
            "orders.emulated": "0",
            "orders.open": "0",
            "positions.total": "0",
            "positions.total_with_snapshots": "0",
            "positions.open": "0",
            "positions.closed": "0",
            "positions.snapshots": "0",
            "total_events": "1",
            "iterations": "1",
            "venues.total": "1",
            "account.SIM.id": "SIM-001",
            "account.SIM.type": "MARGIN",
            "account.SIM.event_count": "1",
            "account.SIM.base_currency": "None",
            "account.SIM.balance.USDT.total": "1000000 USDT",
            "account.SIM.balance.USDT.locked": "0 USDT",
            "account.SIM.balance.USDT.free": "1000000 USDT",
        },
        "stats_pnls": {"USDT": {"PnL (total)": "0", "PnL% (total)": "0"}},
        "stats_returns": {
            "Sortino Ratio (252 days)": "0",
            "Tail Ratio": "0",
            "Average Loss (Return)": "0",
            "Average (Return)": "0",
            "Sharpe Ratio (252 days)": "0",
            "Average Win (Return)": "0",
            "Returns Kurtosis": "0",
            "Profit Factor": "0",
            "Returns Volatility (252 days)": "0",
            "Risk Return Ratio": "0",
            "Returns Skewness": "0",
        },
        "stats_general": {},
    }
    if include_performance_series:
        metrics["performance_series"] = {
            "schema": "PortfolioEquitySeries.v1",
            "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
            "selection": "SOLE_TOTAL_EQUITY",
            "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
            "timestamp_unit": "UNIX_EPOCH_NS",
            "equity_unit": "ACCOUNT_CURRENCY",
            "drawdown_unit": "PERCENT",
            "account_id": "SIM-001",
            "currency": "USDT",
            "points": [
                {
                    "point_index": 0,
                    "ts_event_ns": "100",
                    "equity_amount": "1000000",
                    "drawdown_pct": "0",
                    "is_stale": False,
                    "stale_instruments": [],
                    "stale_currencies": [],
                    "unpriced_instruments": [],
                }
            ],
        }
    return canonical_json_bytes(export_metrics(metrics))


def _api_report_bytes() -> dict[str, bytes]:
    account = normalize_report_row(
        "account",
        {
            "ts_event_ns": "100",
            "total": "1000000",
            "locked": "0",
            "free": "1000000",
            "currency": "USDT",
            "account_id": "SIM-001",
            "account_type": "MARGIN",
            "margins": [
                {
                    "type": "MarginBalance",
                    "initial": "0",
                    "maintenance": "0",
                    "currency": "USDT",
                    "instrument_id": "ETH/USDT.SIM",
                }
            ],
            "reported": True,
            "info": {},
            "base_currency": "None",
        },
    )
    return {
        "reports/orders.json": canonical_json_bytes([]),
        "reports/fills.json": canonical_json_bytes([]),
        "reports/positions.json": canonical_json_bytes([]),
        "reports/account.json": canonical_json_bytes([account]),
        "reports/metrics.json": _api_metrics_bytes(),
    }


def _seed_verified_api_run(
    harness: ApiHarness,
    *,
    outcome_kind: str,
    legacy_metrics: bool = False,
    stop_phase: str | None = None,
    partial_attempts: int = 1,
    attach_natural_process: bool = True,
) -> tuple[str, str, str]:
    dependencies = _dependencies(harness)
    try:
        publication = dependencies.fixture_publisher.publish("local-qa-v1")
        request = draft_payload()
        request["catalog_revision"] = publication.catalog_revision
        preflight = dependencies.preflight.run(
            BacktestDraftRequest.model_validate(request),
            idempotency_key=f"preflight-{outcome_kind}",
        )
        reservation = dependencies.preflight.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key=f"create-{outcome_kind}",
        )
        run_id = reservation.run_id
        spawn_nonce = f"spawn-{outcome_kind}"
        dependencies.store.claim_runner_process(run_id=run_id, spawn_nonce=spawn_nonce)

        all_reports = _api_report_bytes()
        if outcome_kind == "completed":
            report_bytes = dict(all_reports)
            if legacy_metrics:
                report_bytes["reports/metrics.json"] = _api_metrics_bytes(
                    include_performance_series=False
                )
            result = "SUCCEEDED"
            failure = None
        elif outcome_kind == "finalizer":
            report_bytes = dict(all_reports)
            report_bytes["reports/metrics.json"] = _api_metrics_bytes(
                include_performance_series=False
            )
            result = "FAILED"
            failure = {
                "code": "REPORT_EXPORT_FAILED",
                "message": "native report export failed",
            }
        elif outcome_kind == "runner":
            report_bytes = {}
            result = "FAILED"
            failure = {
                "code": "REPORT_EXPORT_FAILED",
                "message": "native report export failed",
            }
        elif outcome_kind in {"supervisor", "protocol"}:
            report_bytes = {}
            result = "FAILED"
            failure = None
        else:
            raise AssertionError(f"unsupported API outcome fixture: {outcome_kind}")

        candidates = tuple(
            RunnerReportCandidateV1(
                name=cast(Any, relative_path.removeprefix("reports/").removesuffix(".json")),
                relative_path=relative_path,
                sha256=sha256(payload).hexdigest(),
                size_bytes=len(payload),
            )
            for relative_path, payload in report_bytes.items()
        )
        child = None
        if outcome_kind not in {"supervisor", "protocol"}:
            child = RunnerOutcomeV1.model_validate(
                {
                    "schema": "RunnerOutcome.v1",
                    "run_id": run_id,
                    "input_manifest_hash": reservation.input_manifest_hash,
                    "catalog_revision": publication.catalog_revision,
                    "engine_package_version": "2.0.0rc3",
                    "result": result,
                    "last_source_seq": 0,
                    "report_candidates": [
                        candidate.model_dump(mode="json", by_alias=True) for candidate in candidates
                    ],
                    "failure": failure,
                }
            )
        natural = outcome_kind in {"completed", "runner", "finalizer"}
        attached_supervisor_failure = outcome_kind == "protocol"
        process_identity_sha256 = None
        launched_at_ns = None
        if (natural and attach_natural_process) or attached_supervisor_failure:
            identity = ProcessIdentityV1(
                run_id=run_id,
                spawn_nonce=spawn_nonce,
                pid=701,
                ppid=1,
                pgid=701,
                sid=701,
                platform="darwin",
                start_token="darwin:1700000000:123456",
                configured_executable_path="/service/venv/bin/python",
                observed_executable_path="/service/venv/bin/python",
                executable_device=7,
                executable_inode=11,
            )
            attached = dependencies.store.attach_runner_process(identity=identity)
            assert attached.launched_at_ns is not None
            assert dependencies.store.run(run_id).state is RunState.RUNNING
            process_identity_sha256 = process_identity_digest(identity)
            launched_at_ns = attached.launched_at_ns
        outcome = SupervisorExitV1(
            run_id=run_id,
            spawn_nonce=spawn_nonce,
            process_identity_sha256=process_identity_sha256,
            launched_at_ns=launched_at_ns,
            ended_at_ns=100 if launched_at_ns is None else launched_at_ns + 1,
            duration_ns=0 if launched_at_ns is None else 1,
            exit_code=0 if outcome_kind == "completed" else (1 if natural else None),
            signal=None,
            final_cancel_phase="NONE",
            stdout_size_bytes=0,
            stderr_size_bytes=0,
            stderr_sha256=sha256(b"").hexdigest(),
            stderr_truncated=False,
            child_outcome=child,
            classification=(
                "NATURAL_SUCCESS"
                if outcome_kind == "completed"
                else ("NATURAL_FAILURE" if natural else "SUPERVISOR_FAILURE")
            ),
            failure_code=(
                None
                if outcome_kind == "completed"
                else (
                    "CHILD_REPORTED_FAILURE"
                    if natural
                    else ("PROTOCOL_FAILED" if attached_supervisor_failure else "LAUNCH_FAILED")
                )
            ),
            proposed_terminal_state="COMPLETED" if outcome_kind == "completed" else "FAILED",
        )
        record = dependencies.store.record_runner_outcome(outcome)
        if stop_phase == "PENDING":
            return run_id, record.outcome_hash, ""
        preparation = dependencies.store.prepare_terminal(run_id=run_id)
        if stop_phase == "STAGING":
            return run_id, record.outcome_hash, preparation.initial_event_digest
        if stop_phase == "PARTIAL":
            retry: object = preparation
            for expected_attempt in range(1, partial_attempts + 1):
                retry = dependencies.store.record_finalization_failure(
                    run_id=run_id,
                    failure=FinalizationFailure(deterministic=False, stage="FSYNC"),
                )
                assert getattr(retry, "failure_attempt_count", None) == expected_attempt
            return run_id, record.outcome_hash, preparation.initial_event_digest
        if stop_phase is not None:
            raise AssertionError(f"unsupported API stop phase: {stop_phase}")
        snapshot = dependencies.store.run(run_id)
        assert snapshot.input_manifest_bytes is not None
        staging_parent = harness.runtime_root / "staging"
        staging_parent.mkdir(mode=0o700, exist_ok=True)
        staging = staging_parent / run_id
        staging.mkdir(mode=0o700)
        for name, payload in (
            ("input-manifest.json", snapshot.input_manifest_bytes),
            ("runner-exit.json", preparation.outcome.outcome_bytes),
            ("stderr.txt", b""),
        ):
            path = staging / name
            path.write_bytes(payload)
            path.chmod(0o600)
        for relative_path, payload in report_bytes.items():
            path = staging / relative_path
            path.parent.mkdir(mode=0o700, exist_ok=True)
            path.write_bytes(payload)
            path.chmod(0o600)

        materializer = CanonicalMaterializer(
            store=dependencies.store,
            runtime_root=harness.runtime_root,
        )
        if legacy_metrics:
            finalization = materializer.materialize_and_publish(preparation=preparation)
        else:
            materializer.build_verify_and_rename(preparation=preparation)
            shutil.rmtree(staging)
            recovered = dependencies.recovery.recover()
            finalization = next(item for item in recovered if item.run_id == run_id)
        evidence_id = (
            finalization.fault.fault_hash
            if hasattr(finalization, "fault")
            else finalization.seal_digest
        )
        return run_id, record.outcome_hash, cast(str, evidence_id)
    finally:
        dependencies.store.close()


def _seed_queued_api_run(harness: ApiHarness) -> str:
    dependencies = _dependencies(harness)
    try:
        publication = dependencies.fixture_publisher.publish("local-qa-v1")
        request = draft_payload()
        request["catalog_revision"] = publication.catalog_revision
        preflight = dependencies.preflight.run(
            BacktestDraftRequest.model_validate(request),
            idempotency_key="preflight-real-corruption",
        )
        reservation = dependencies.preflight.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key="create-real-corruption",
        )
        return reservation.run_id
    finally:
        dependencies.store.close()


def _mutate_immutable_column(
    connection: sqlite3.Connection,
    *,
    trigger_name: str,
    statement: str,
    parameters: tuple[object, ...],
) -> None:
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        (trigger_name,),
    ).fetchone()
    assert row is not None and isinstance(row[0], str)
    trigger_sql = row[0]
    connection.execute(f'DROP TRIGGER "{trigger_name}"')
    try:
        connection.execute(statement, parameters)
    finally:
        connection.execute(trigger_sql)


def test_health_and_capabilities_are_backtest_only(client: TestClient) -> None:
    dependencies = cast(Any, client.app).state.control_dependencies
    control_clock = getattr(dependencies, "clock", None)
    assert control_clock is not None
    assert getattr(dependencies.preflight, "_clock", None) is control_clock
    assert getattr(dependencies.store, "_clock", None) is control_clock
    calls_before_health = getattr(control_clock, "calls", None)
    assert isinstance(calls_before_health, int)

    health = client.get("/v1/system/health")
    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "observed_at_ns": "1700000000000000000",
        "control_version": "0.1.0",
        "schema_version": 9,
        "engine_version": "2.0.0rc3",
        "engine_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
        "engine_commit_provenance": "LOCKED_RELEASE_PIN",
        "python_version": "3.12.4",
        "precision_mode": "FIXED_PRECISION_16",
        "input_manifest_engine_version": "2.0.0rc3",
        "input_manifest_engine_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
    }
    assert control_clock.calls == calls_before_health + 1

    calls_before_capabilities = control_clock.calls
    capabilities = client.get("/v1/system/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["execution_modes"] == ["BACKTEST"]
    assert capabilities.json()["live_available"] is False
    assert capabilities.json()["engine_version"] == "2.0.0rc3"
    assert capabilities.json()["engine_commit"] == ("648970ce64a304d93da0a29320cb6e19b905fa39")
    assert capabilities.json().get("observed_at_ns") == "1700000000000000001"
    assert control_clock.calls == calls_before_capabilities + 1


def test_current_engine_identity_uses_installed_runtime_precision() -> None:
    assert current_engine_identity() == EngineIdentity(
        package_version="2.0.0rc3",
        tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
        python_version="3.12.4",
        precision_mode="FIXED_PRECISION_16",
    )


def test_default_runtime_uses_var_trading_without_touching_repository(
    tmp_path: Path,
) -> None:
    (tmp_path / "services" / "engine").mkdir(parents=True)
    assert (tmp_path / "services" / "engine").stat().st_mode & 0o777 == 0o755
    dependencies = build_default_dependencies(tmp_path)
    try:
        expected = tmp_path / "var" / "trading"
        assert (expected / "control.sqlite").is_file()
        assert (expected / "runner-cwd").stat().st_mode & 0o777 == 0o700
        assert not (expected / "runner-cwd" / "control.sqlite").exists()
        scheduler = cast(Any, dependencies.scheduler)
        assert scheduler._supervisor._runner_cwd == expected / "runner-cwd"
        assert (tmp_path / "services" / "engine").stat().st_mode & 0o777 == 0o755
        assert not (tmp_path / "var" / "control.sqlite").exists()
    finally:
        dependencies.store.close()


def test_default_runner_keeps_venv_launcher_for_minimal_isolated_import(
    tmp_path: Path,
) -> None:
    (tmp_path / "services" / "engine").mkdir(parents=True)
    dependencies = build_default_dependencies(tmp_path)
    try:
        launcher = Path(sys.executable).absolute()
        runner_cwd = tmp_path / "var" / "trading" / "runner-cwd"
        command = (
            "import importlib.metadata,json,sys;"
            "import stark_trading_os.runner.main;"
            "print(json.dumps({'executable':sys.executable,'prefix':sys.prefix,"
            "'nautilus':importlib.metadata.version('nautilus_trader')}))"
        )
        completed = subprocess.run(
            [str(launcher), "-s", "-P", "-c", command],
            cwd=runner_cwd,
            env=build_minimal_runner_environment(0),
            check=False,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        provenance = cast(dict[str, str], json.loads(completed.stdout))
        assert Path(provenance["executable"]) == Path(sys.executable).absolute()
        assert Path(provenance["prefix"]) == Path(sys.prefix).absolute()
        assert provenance["nautilus"] == "2.0.0rc3"
        assert set(path.name for path in tmp_path.iterdir()) == {"services", "var"}
        assert tuple(runner_cwd.iterdir()) == ()
    finally:
        dependencies.store.close()


def test_default_dependency_graph_closes_store_when_construction_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[ControlStore] = []
    actual_open = ControlStore.open

    def capture_open(database_path: str | Path, *, clock: Any = None) -> ControlStore:
        store = actual_open(database_path, clock=clock)
        captured.append(store)
        return store

    class FailingSupervisor:
        def __init__(self, **_values: object) -> None:
            raise RuntimeError("injected graph construction failure")

    from stark_trading_os.control import dependencies as dependencies_module

    monkeypatch.setattr(ControlStore, "open", capture_open)
    monkeypatch.setattr(dependencies_module, "RunnerSupervisor", FailingSupervisor)
    with pytest.raises(RuntimeError, match="injected graph construction failure"):
        build_default_dependencies(tmp_path)

    assert len(captured) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
        captured[0].recoverable_active_runs()


def test_health_and_preflight_block_an_engine_version_mismatch(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    def mismatch_dependencies() -> ControlDependencies:
        dependencies = _dependencies(api_harness)
        return replace(
            dependencies,
            engine_identity=EngineIdentity(
                package_version="2.0.0rc2",
                tag_commit="0" * 40,
                python_version="3.12.4",
                precision_mode="FIXED_PRECISION_16",
            ),
        )

    app = create_app(
        dependency_factory=mismatch_dependencies,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as mismatch_client:
        response = mismatch_client.get("/v1/system/health")
        assert response.status_code == 503
        assert response.json()["code"] == "ENGINE_UNAVAILABLE"
        assert response.json()["details"]["check"] == "ENGINE_VERSION_MISMATCH"
        blocked = mismatch_client.post(
            "/v1/backtests/preflight",
            headers={"Idempotency-Key": "engine-mismatch"},
            json=draft,
        )
        assert blocked.status_code == 503
        assert blocked.json()["code"] == "ENGINE_VERSION_MISMATCH"


def test_publish_and_page_immutable_catalog(client: TestClient) -> None:
    publication = publish(client)
    replay = client.post("/v1/catalogs/fixtures/local-qa-v1/publish")
    assert replay.status_code == 200
    assert replay.json() == publication

    page = client.get(
        f"/v1/catalogs/{publication['catalog_revision']}/instruments",
        params={"cursor": "0", "limit": 1},
    )
    assert page.status_code == 200
    assert page.json()["catalog_revision"] == publication["catalog_revision"]
    assert [item["instrument_id"] for item in page.json()["items"]] == ["ETH/USDT.SIM"]
    assert page.json()["next_cursor"] is None

    unknown = client.get(f"/v1/catalogs/{'b' * 64}/instruments")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "CATALOG_UNKNOWN"
    for params in ({"limit": 0}, {"limit": 501}, {"cursor": "bad"}, {"cursor": "2"}):
        invalid = client.get(
            f"/v1/catalogs/{publication['catalog_revision']}/instruments",
            params=params,
        )
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "CURSOR_INVALID"


def test_preflight_create_get_and_cancel_commit_before_schedule(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    preflight = ready_preflight(client, draft)
    assert preflight["state"] == "PREFLIGHT_READY"
    assert preflight["checks"]
    assert all(
        isinstance(check, dict)
        and set(check) == {"checked_at_ns", "code", "evidence", "explanation", "passed"}
        and isinstance(check["checked_at_ns"], str)
        and bool(check["explanation"])
        and bool(check["evidence"])
        for check in preflight["checks"]
    )

    created = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-1"},
        json={
            "preflight_id": preflight["preflight_id"],
            "canonical_request_hash": preflight["canonical_request_hash"],
        },
    )
    assert created.status_code == 202
    assert created.json()["state"] == "QUEUED"
    assert api_harness.scheduler is not None
    assert [item.run_id for item in api_harness.scheduler.reservations] == [
        created.json()["run_id"]
    ]

    fetched = client.get(f"/v1/backtests/{created.json()['run_id']}")
    assert fetched.status_code == 200
    assert fetched.json()["state"] == "QUEUED"
    assert fetched.json()["engine_version"] == "2.0.0rc3"
    assert fetched.json()["control_version"] == "0.1.0"
    assert fetched.json()["schema_version"] == 9
    assert fetched.json()["engine_commit_provenance"] == "LOCKED_RELEASE_PIN"
    assert fetched.json()["python_version"] == "3.12.4"
    assert fetched.json()["precision_mode"] == "FIXED_PRECISION_16"
    assert fetched.json()["input_manifest_engine_version"] == "2.0.0rc3"
    assert fetched.json()["input_manifest_engine_commit"] == (
        "648970ce64a304d93da0a29320cb6e19b905fa39"
    )
    assert fetched.json()["input_manifest_python_version"] == "3.12.4"
    assert fetched.json()["input_manifest_precision_mode"] == "FIXED_PRECISION_16"

    cancelled = client.post(
        f"/v1/backtests/{created.json()['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-1"},
        json={"reason": "operator request"},
    )
    assert cancelled.status_code == 202
    assert cancelled.json()["state"] == "CANCEL_REQUESTED"
    assert api_harness.scheduler.cancellations[-1].clean_no_claim is True


def test_get_run_exposes_authoritative_input_and_unavailable_performance_evidence(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    """Catches a RunResponse that omits server-projected evidence authority."""

    run = queued_run(client, draft)

    response = client.get(f"/v1/backtests/{run['run_id']}")

    assert response.status_code == 200
    assert response.json()["evidence"] == {
        "input": {
            "completeness": "COMPLETE",
            "unavailable_reason": None,
            "fixture_id": "local-qa-v1",
            "fixture_label": "LOCAL QA FIXTURE",
            "strategy_id": "determinism-probe",
            "strategy_version": "v1",
            "instrument_ids": ["ETH/USDT.SIM"],
            "window_start_ns": "1700000000000000000",
            "window_end_ns": "1700000000000000002",
            "timezone": "UTC",
            "provenance": {
                "authority": "CONTROL_SQLITE_INPUT_MANIFEST_AND_CATALOG",
                "artifact_name": None,
                "evidence_id": response.json()["input_manifest_hash"],
                "seal_digest": None,
            },
        },
        "performance": {
            "completeness": "UNAVAILABLE",
            "unavailable_reason": "RUN_NOT_VERIFIED",
            "series_schema": None,
            "source": None,
            "selection": None,
            "calculation": None,
            "timestamp_unit": "UNIX_EPOCH_NS",
            "equity_unit": "ACCOUNT_CURRENCY",
            "drawdown_unit": "PERCENT",
            "account_id": None,
            "currency": None,
            "points": [],
            "provenance": None,
        },
        "process_exit": None,
        "failure": None,
    }


@pytest.mark.parametrize("illegal_evidence_status", ["VERIFIED", "UNVERIFIED"])
@pytest.mark.parametrize(
    "preterminal_state",
    ["PREFLIGHT_READY", "QUEUED", "CANCEL_REQUESTED"],
)
def test_get_run_rejects_terminal_evidence_status_for_every_preterminal_phase(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
    preterminal_state: str,
    illegal_evidence_status: str,
) -> None:
    if preterminal_state == "PREFLIGHT_READY":
        run_id = cast(str, ready_preflight(client, draft)["run_id"])
    else:
        run_id = cast(str, queued_run(client, draft)["run_id"])
        if preterminal_state == "CANCEL_REQUESTED":
            cancelled = client.post(
                f"/v1/backtests/{run_id}/cancel",
                headers={"Idempotency-Key": "cancel-illegal-evidence-phase"},
                json={"reason": "phase-matrix test"},
            )
            assert cancelled.status_code == 202
            assert cancelled.json()["state"] == "CANCEL_REQUESTED"

    with open_corruption_connection(api_harness.database) as connection:
        connection.execute(
            "UPDATE runs SET evidence_status = ? WHERE run_id = ?",
            (illegal_evidence_status, run_id),
        )

    response = client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(response, run_id=run_id)


@pytest.mark.parametrize(
    ("phase", "partial_attempts", "illegal_sibling"),
    [
        ("PENDING", 0, "STAGING"),
        ("PENDING", 0, "PARTIAL"),
        ("STAGING", 0, "PENDING"),
        ("STAGING", 0, "PARTIAL"),
        ("PARTIAL", 1, "PENDING"),
        ("PARTIAL", 2, "STAGING"),
    ],
)
def test_get_run_freezes_lawful_finalizing_phase_and_rejects_sibling(
    api_harness: ApiHarness,
    phase: str,
    partial_attempts: int,
    illegal_sibling: str,
) -> None:
    run_id, outcome_hash, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind="completed",
        stop_phase=phase,
        partial_attempts=partial_attempts,
    )
    verifier = _dependencies(api_harness)
    try:
        assert verifier.store.terminal_finalization(run_id=run_id) is None
    finally:
        verifier.store.close()
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        lawful = terminal_client.get(f"/v1/backtests/{run_id}")
        assert lawful.status_code == 200
        body = lawful.json()
        assert body["state"] == "FINALIZING"
        assert body["evidence_status"] == phase
        assert body["evidence"]["process_exit"]["provenance"]["evidence_id"] == outcome_hash
        assert body["evidence"]["failure"] is None
        _assert_unavailable_performance(
            body["evidence"]["performance"],
            reason="RUN_NOT_VERIFIED",
        )

        with open_corruption_connection(api_harness.database) as connection:
            connection.execute(
                "UPDATE runs SET evidence_status = ? WHERE run_id = ?",
                (illegal_sibling, run_id),
            )
        invalid = terminal_client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(invalid, run_id=run_id)


def test_get_run_rejects_claim_only_natural_outcome_as_integrity_failure(
    api_harness: ApiHarness,
) -> None:
    run_id, _, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind="completed",
        stop_phase="PENDING",
        attach_natural_process=False,
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(response, run_id=run_id)


@pytest.mark.parametrize(
    "outcome_kind",
    ["completed", "protocol"],
    ids=["natural-success", "supervisor-protocol-failure"],
)
@pytest.mark.parametrize(
    "corruption_kind",
    ["schema-invalid", "noncanonical-encoding"],
)
def test_get_run_rejects_rehashed_bound_process_identity_corruption(
    api_harness: ApiHarness,
    outcome_kind: str,
    corruption_kind: str,
) -> None:
    run_id, _, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind=outcome_kind,
        stop_phase="PENDING",
    )
    with open_corruption_connection(api_harness.database) as connection:
        row = connection.execute(
            "SELECT outcomes.outcome_bytes, processes.process_identity_bytes "
            "FROM runner_outcomes AS outcomes "
            "JOIN runner_processes AS processes USING (run_id) "
            "WHERE outcomes.run_id = ?",
            (run_id,),
        ).fetchone()
        assert row is not None and row[1] is not None
        identity_bytes = b"{}" if corruption_kind == "schema-invalid" else b" " + bytes(row[1])
        identity_digest = sha256(identity_bytes).hexdigest()
        original = supervisor_exit_from_bytes(bytes(row[0]))
        mutated = SupervisorExitV1.model_validate(
            {
                **original.model_dump(mode="json", by_alias=True),
                "process_identity_sha256": identity_digest,
            }
        )
        outcome_bytes = supervisor_exit_bytes(mutated)
        connection.execute(
            "UPDATE runner_processes SET process_identity_bytes = ? WHERE run_id = ?",
            (identity_bytes, run_id),
        )
        connection.execute(
            "UPDATE runner_outcomes SET outcome_bytes = ?, outcome_hash = ? WHERE run_id = ?",
            (outcome_bytes, sha256(outcome_bytes).hexdigest(), run_id),
        )

    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(response, run_id=run_id)


def test_get_run_rejects_schema_admitted_invalid_runner_cancel_phase(
    api_harness: ApiHarness,
) -> None:
    run_id, _, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind="protocol",
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(
        app,
        headers={"Origin": ORIGIN},
        raise_server_exceptions=False,
    ) as terminal_client:
        lawful = terminal_client.get(f"/v1/backtests/{run_id}")
        assert lawful.status_code == 200

        with open_corruption_connection(api_harness.database) as connection:
            connection.execute(
                "UPDATE runner_processes SET cancel_phase = 'ACKNOWLEDGED' WHERE run_id = ?",
                (run_id,),
            )

        response = terminal_client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(response, run_id=run_id)


def test_get_run_does_not_translate_unrelated_runtime_error(
    api_harness: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id, _, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind="protocol",
    )

    def fail_snapshot(*args: object, **kwargs: object) -> object:
        raise RuntimeError("unrelated programming fault")

    monkeypatch.setattr(ControlStore, "run_evidence_snapshot", fail_snapshot)
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(
        app,
        headers={"Origin": ORIGIN},
        raise_server_exceptions=False,
    ) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    assert response.status_code == 500
    assert response.text == "Internal Server Error"


@pytest.mark.parametrize(
    ("outcome_kind", "failure_code"),
    [("protocol", "PROTOCOL_FAILED"), ("supervisor", "LAUNCH_FAILED")],
    ids=["attached-protocol-failure", "unbound-launch-failure"],
)
def test_get_run_accepts_lawful_bound_and_unbound_supervisor_failures(
    api_harness: ApiHarness,
    outcome_kind: str,
    failure_code: str,
) -> None:
    run_id, outcome_hash, _ = _seed_verified_api_run(
        api_harness,
        outcome_kind=outcome_kind,
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    assert response.status_code == 200
    assert response.json()["state"] == "FAILED"
    evidence = response.json()["evidence"]
    assert evidence["process_exit"]["classification"] == "SUPERVISOR_FAILURE"
    assert evidence["process_exit"]["supervisor_failure_code"] == failure_code
    assert evidence["process_exit"]["provenance"] == {
        "authority": "CONTROL_SQLITE_RUNNER_OUTCOME",
        "artifact_name": None,
        "evidence_id": outcome_hash,
        "seal_digest": None,
    }
    assert evidence["failure"] == {
        "source": "SUPERVISOR",
        "code": failure_code,
        "provenance": evidence["process_exit"]["provenance"],
    }


def test_get_run_preserves_cancelled_verified_missing_metrics_as_lawful_prefix(
    api_harness: ApiHarness,
) -> None:
    seed_verified_cancelled_run(api_harness, run_id="verified-metrics-prefix")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        cancelled_run_id = next(
            path.name for path in (api_harness.runtime_root / "runs").iterdir() if path.is_dir()
        )
        lawful_cancelled = terminal_client.get(f"/v1/backtests/{cancelled_run_id}")
        assert lawful_cancelled.status_code == 200
        assert lawful_cancelled.json()["state"] == "CANCELLED"
        assert lawful_cancelled.json()["evidence"]["performance"] == {
            "completeness": "UNAVAILABLE",
            "unavailable_reason": "METRICS_ARTIFACT_NOT_SEALED",
            "series_schema": None,
            "source": None,
            "selection": None,
            "calculation": None,
            "timestamp_unit": "UNIX_EPOCH_NS",
            "equity_unit": "ACCOUNT_CURRENCY",
            "drawdown_unit": "PERCENT",
            "account_id": None,
            "currency": None,
            "points": [],
            "provenance": None,
        }


def test_get_run_rejects_denied_metrics_for_coherent_completed_verified(
    api_harness: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completed_run_id, _, seal_digest = _seed_verified_api_run(
        api_harness,
        outcome_kind="completed",
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        dependencies = cast(Any, terminal_client.app).state.control_dependencies
        fresh = terminal_client.get(f"/v1/backtests/{completed_run_id}")
        assert fresh.status_code == 200
        assert fresh.json()["state"] == "COMPLETED"
        assert fresh.json()["evidence"]["performance"] == {
            "completeness": "COMPLETE",
            "unavailable_reason": None,
            "series_schema": "PortfolioEquitySeries.v1",
            "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
            "selection": "SOLE_TOTAL_EQUITY",
            "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
            "timestamp_unit": "UNIX_EPOCH_NS",
            "equity_unit": "ACCOUNT_CURRENCY",
            "drawdown_unit": "PERCENT",
            "account_id": "SIM-001",
            "currency": "USDT",
            "points": [
                {
                    "point_index": 0,
                    "ts_event_ns": "100",
                    "equity_amount": "1000000",
                    "drawdown_pct": "0",
                    "is_stale": False,
                    "stale_instruments": [],
                    "stale_currencies": [],
                    "unpriced_instruments": [],
                }
            ],
            "provenance": {
                "authority": "SEALED_METRICS_ARTIFACT",
                "artifact_name": "metrics_report",
                "evidence_id": sha256(_api_metrics_bytes()).hexdigest(),
                "seal_digest": seal_digest,
            },
        }

        def deny_completed_metrics(*, run_id: str, relative_path: str) -> bytes:
            assert run_id == completed_run_id
            assert relative_path == "reports/metrics.json"
            raise ArtifactAccessDenied("injected completed metrics denial")

        monkeypatch.setattr(dependencies.recovery, "read_artifact", deny_completed_metrics)
        completed = terminal_client.get(f"/v1/backtests/{completed_run_id}")

        _assert_run_evidence_integrity_failure(completed, run_id=completed_run_id)


def test_get_run_projects_legacy_sealed_metrics_as_explicitly_unavailable(
    api_harness: ApiHarness,
) -> None:
    legacy_metrics = _api_metrics_bytes(include_performance_series=False)
    run_id, _, seal_digest = _seed_verified_api_run(
        api_harness,
        outcome_kind="completed",
        legacy_metrics=True,
    )
    root = api_harness.runtime_root / "runs" / run_id
    seal = parse_json_object((root / "seal.json").read_bytes())
    files = seal["files"]
    assert isinstance(files, list)
    metrics_entries = [
        item
        for item in files
        if isinstance(item, dict) and item.get("relative_path") == "reports/metrics.json"
    ]
    assert metrics_entries == [
        {
            "relative_path": "reports/metrics.json",
            "sha256": sha256(legacy_metrics).hexdigest(),
            "size_bytes": len(legacy_metrics),
        }
    ]
    assert sha256((root / "seal.json").read_bytes()).hexdigest() == seal_digest

    verifier = _dependencies(api_harness)
    try:
        outcome = verifier.store.runner_outcome(run_id)
        assert outcome is not None
        child_outcome = outcome.outcome.child_outcome
        assert child_outcome is not None
        metrics_candidates = [
            candidate
            for candidate in child_outcome.report_candidates
            if candidate.relative_path == "reports/metrics.json"
        ]
        assert len(metrics_candidates) == 1
        assert metrics_candidates[0].sha256 == metrics_entries[0]["sha256"]
        assert metrics_candidates[0].size_bytes == metrics_entries[0]["size_bytes"]
        publication = verifier.store.terminal_finalization(run_id=run_id)
        assert type(publication) is TerminalPublication
        assert publication.seal_digest == seal_digest
        persisted_seal = verifier.store._connection.execute(
            "SELECT seal_digest FROM seals WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert persisted_seal is not None
        assert persisted_seal["seal_digest"] == seal_digest
        assert (
            verifier.recovery.read_artifact(
                run_id=run_id,
                relative_path="reports/metrics.json",
            )
            == legacy_metrics
        )
    finally:
        verifier.store.close()

    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

        assert response.status_code == 200
        assert response.json()["state"] == "COMPLETED"
        _assert_unavailable_performance(
            response.json()["evidence"]["performance"],
            reason="LEGACY_METRICS_SERIES_ABSENT",
        )


@pytest.mark.parametrize(
    ("outcome_kind", "classification", "failure_source", "failure_code"),
    [
        ("runner", "NATURAL_FAILURE", "RUNNER", "REPORT_EXPORT_FAILED"),
        ("supervisor", "SUPERVISOR_FAILURE", "SUPERVISOR", "LAUNCH_FAILED"),
        ("finalizer", "NATURAL_FAILURE", "FINALIZER", None),
    ],
)
def test_get_run_preserves_failure_precedence_and_authoritative_provenance(
    api_harness: ApiHarness,
    outcome_kind: str,
    classification: str,
    failure_source: str,
    failure_code: str | None,
) -> None:
    run_id, outcome_hash, terminal_authority_id = _seed_verified_api_run(
        api_harness,
        outcome_kind=outcome_kind,
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    assert response.status_code == 200
    evidence = response.json()["evidence"]
    process_exit = evidence["process_exit"]
    assert process_exit["classification"] == classification
    assert process_exit["provenance"] == {
        "authority": "CONTROL_SQLITE_RUNNER_OUTCOME",
        "artifact_name": None,
        "evidence_id": outcome_hash,
        "seal_digest": None,
    }
    failure = evidence["failure"]
    assert failure["source"] == failure_source
    if failure_code is not None:
        assert failure["code"] == failure_code
        assert failure["provenance"] == process_exit["provenance"]
    else:
        assert failure["category"] == "DETERMINISTIC_EVIDENCE_FAILURE"
        assert failure["stage"] == "REPORTS"
        assert failure["attempt_count"] == 3
        assert failure["outcome_hash"] == outcome_hash
        assert failure["provenance"] == {
            "authority": "CONTROL_SQLITE_FINALIZATION_FAULT",
            "artifact_name": None,
            "evidence_id": terminal_authority_id,
            "seal_digest": None,
        }


@pytest.mark.parametrize(
    "corruption_source",
    [
        "manifest_source_checksum",
        "manifest_catalog_checksum",
        "runner_outcome",
        "terminal_preparation",
        "finalization_fault",
        "sealed_metrics",
        "sealed_root",
    ],
)
def test_get_run_detects_real_authority_corruption_as_one_safe_integrity_response(
    api_harness: ApiHarness,
    corruption_source: str,
) -> None:
    if corruption_source.startswith("manifest_"):
        run_id = _seed_queued_api_run(api_harness)
        field = corruption_source.removeprefix("manifest_")
        with open_corruption_connection(api_harness.database) as connection:
            row = connection.execute(
                "SELECT input_manifest_bytes FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            assert row is not None
            manifest = parse_json_object(bytes(row[0]))
            manifest[field] = "0" * 64
            manifest_bytes = canonical_json_bytes(manifest)
            connection.execute(
                "UPDATE runs SET input_manifest_bytes = ?, input_manifest_hash = ? "
                "WHERE run_id = ?",
                (manifest_bytes, sha256(manifest_bytes).hexdigest(), run_id),
            )
    else:
        outcome_kind = "finalizer" if corruption_source == "finalization_fault" else "completed"
        run_id, _, _ = _seed_verified_api_run(api_harness, outcome_kind=outcome_kind)
        if corruption_source == "runner_outcome":
            with open_corruption_connection(api_harness.database) as connection:
                row = connection.execute(
                    "SELECT outcome_bytes FROM runner_outcomes WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                assert row is not None
                connection.execute(
                    "UPDATE runner_outcomes SET outcome_bytes = ? WHERE run_id = ?",
                    (bytes(row[0]) + b" ", run_id),
                )
        elif corruption_source == "terminal_preparation":
            with open_corruption_connection(api_harness.database) as connection:
                row = connection.execute(
                    "SELECT event_envelope_bytes FROM terminal_preparations WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                assert row is not None
                _mutate_immutable_column(
                    connection,
                    trigger_name="trg_terminal_preparations_validate_update",
                    statement=(
                        "UPDATE terminal_preparations SET event_envelope_bytes = ? WHERE run_id = ?"
                    ),
                    parameters=(bytes(row[0]) + b" ", run_id),
                )
        elif corruption_source == "finalization_fault":
            with open_corruption_connection(api_harness.database) as connection:
                row = connection.execute(
                    "SELECT fault_bytes FROM finalization_faults WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                assert row is not None
                _mutate_immutable_column(
                    connection,
                    trigger_name="trg_finalization_faults_immutable_update",
                    statement="UPDATE finalization_faults SET fault_bytes = ? WHERE run_id = ?",
                    parameters=(bytes(row[0]) + b" ", run_id),
                )
        else:
            relative_path = (
                "reports/metrics.json" if corruption_source == "sealed_metrics" else "seal.json"
            )
            path = api_harness.runtime_root / "runs" / run_id / relative_path
            value = parse_json_object(path.read_bytes())
            if corruption_source == "sealed_metrics":
                summary = value["summary"]
                assert isinstance(summary, dict)
                summary["iterations"] = "2"
            else:
                value["audit_head_hash"] = "0" * 64
            path.chmod(0o600)
            try:
                path.write_bytes(canonical_json_bytes(value))
            finally:
                path.chmod(0o400)

    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        response = terminal_client.get(f"/v1/backtests/{run_id}")

    _assert_run_evidence_integrity_failure(response, run_id=run_id)


def test_command_errors_are_stable(client: TestClient, draft: dict[str, object]) -> None:
    missing_key = client.post("/v1/backtests/preflight", json=draft)
    assert missing_key.status_code == 422
    assert missing_key.json()["code"] == "REQUEST_INVALID"

    first = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "conflict"},
        json=draft,
    )
    assert first.status_code == 200
    assert first.json()["state"] == "PREFLIGHT_BLOCKED"
    changed = dict(draft)
    changed["replay_seed"] = 8
    conflict = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "conflict"},
        json=changed,
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"

    stale = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "stale"},
        json={"preflight_id": "missing", "canonical_request_hash": "a" * 64},
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "PREFLIGHT_STALE"

    unknown = client.get("/v1/backtests/missing")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "RUN_UNKNOWN"

    run = queued_run(client, draft)
    invalid_state = client.post(
        f"/v1/backtests/{run['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-invalid"},
        json={"reason": ""},
    )
    assert invalid_state.status_code == 422
    assert invalid_state.json()["code"] == "REQUEST_INVALID"


def test_fixture_and_state_conflict_errors_are_stable(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    unknown = client.post("/v1/catalogs/fixtures/not-registered/publish")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "FIXTURE_UNKNOWN"

    dependencies = cast(Any, client.app).state.control_dependencies
    for error, status, code in (
        (FixtureInvalid("SOURCE_CHECKSUM_MISMATCH"), 422, "FIXTURE_INVALID"),
        (CatalogConflict(), 409, "CATALOG_CONFLICT"),
    ):

        class FailingPublisher:
            def publish(self, fixture_id: str) -> CatalogPublication:
                assert fixture_id == "local-qa-v1"
                raise error

        cast(Any, client.app).state.control_dependencies = replace(
            dependencies,
            fixture_publisher=cast(Any, FailingPublisher()),
        )
        response = client.post("/v1/catalogs/fixtures/local-qa-v1/publish")
        assert response.status_code == status
        assert response.json()["code"] == code
    cast(Any, client.app).state.control_dependencies = dependencies

    preflight = ready_preflight(client, draft)
    conflict = client.post(
        f"/v1/backtests/{preflight['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-preflight-ready"},
        json={"reason": "not created"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "STATE_CONFLICT"


def test_create_and_cancel_idempotency_replays_exactly_and_conflicts(
    client: TestClient,
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    preflight = ready_preflight(client, draft)
    create_body = {
        "preflight_id": preflight["preflight_id"],
        "canonical_request_hash": preflight["canonical_request_hash"],
    }
    first = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-replay"},
        json=create_body,
    )
    replay = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-replay"},
        json=create_body,
    )
    assert replay.status_code == first.status_code == 202
    assert replay.content == first.content
    assert api_harness.scheduler is not None
    assert len(api_harness.scheduler.reservations) == 1
    assert api_harness.scheduler.reconciliations == [first.json()["run_id"]]
    conflict = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "create-replay"},
        json={**create_body, "canonical_request_hash": "b" * 64},
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"

    cancel_body = {"reason": "operator request"}
    cancel_first = client.post(
        f"/v1/backtests/{first.json()['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-replay"},
        json=cancel_body,
    )
    cancel_replay = client.post(
        f"/v1/backtests/{first.json()['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-replay"},
        json=cancel_body,
    )
    assert cancel_replay.status_code == cancel_first.status_code == 202
    assert cancel_replay.content == cancel_first.content
    assert len(api_harness.scheduler.cancellations) == 1
    assert api_harness.scheduler.reconciliations == [
        first.json()["run_id"],
        first.json()["run_id"],
    ]
    cancel_conflict = client.post(
        f"/v1/backtests/{first.json()['run_id']}/cancel",
        headers={"Idempotency-Key": "cancel-replay"},
        json={"reason": "different"},
    )
    assert cancel_conflict.status_code == 409
    assert cancel_conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_cancel_terminal_run_returns_idempotent_200(api_harness: ApiHarness) -> None:
    seed_verified_cancelled_run(api_harness, run_id="terminal-cancel")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as terminal_client:
        run_id = next(
            path.name for path in (api_harness.runtime_root / "runs").iterdir() if path.is_dir()
        )
        response = terminal_client.post(
            f"/v1/backtests/{run_id}/cancel",
            headers={"Idempotency-Key": "terminal-cancel"},
            json={"reason": "already complete"},
        )
        replay = terminal_client.post(
            f"/v1/backtests/{run_id}/cancel",
            headers={"Idempotency-Key": "terminal-cancel"},
            json={"reason": "already complete"},
        )
        assert response.status_code == replay.status_code == 200
        assert response.content == replay.content
        assert response.json()["state"] == "CANCELLED"
        assert api_harness.scheduler is not None
        assert api_harness.scheduler.cancellations == []


def test_preflight_http_replay_preserves_enriched_response_bytes(
    client: TestClient,
    draft: dict[str, object],
) -> None:
    publication = publish(client)
    request = dict(draft)
    request["catalog_revision"] = publication["catalog_revision"]

    first = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "preflight-enriched-replay"},
        json=request,
    )
    replay = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "preflight-enriched-replay"},
        json=request,
    )

    assert replay.status_code == first.status_code == 200
    assert replay.content == first.content
    checks = first.json().get("checks")
    assert isinstance(checks, list) and checks
    assert all(
        isinstance(check, dict)
        and set(check) == {"checked_at_ns", "code", "evidence", "explanation", "passed"}
        for check in checks
    )


def test_catalog_replay_status_uses_exact_returned_revision(client: TestClient) -> None:
    publish(client)
    dependencies = cast(Any, client.app).state.control_dependencies
    returned = CatalogPublication(
        catalog_revision="b" * 64,
        fixture_id="local-qa-v1",
        status="PUBLISHED",
        inventory_hash="c" * 64,
        publication_bytes=b"{}",
        staging_identity="prepared-new",
        prepared_at_ns=1,
        published_at_ns=2,
        audit_intent_bytes=b"{}",
    )

    class NewRevisionPublisher:
        def publish(self, fixture_id: str) -> CatalogPublication:
            assert fixture_id == returned.fixture_id
            return returned

    cast(Any, client.app).state.control_dependencies = replace(
        dependencies,
        fixture_publisher=cast(Any, NewRevisionPublisher()),
    )
    response = client.post("/v1/catalogs/fixtures/local-qa-v1/publish")
    assert response.status_code == 201
    assert response.json()["catalog_revision"] == "b" * 64


def test_scheduler_shutdown_drains_owned_operation_before_store_close(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingSupervisor:
        cancelled = False
        store_usable = False

        async def run(self, _reservation: RunReservation) -> None:
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
            dependencies.store.recoverable_active_runs()
            self.store_usable = True

    supervisor = BlockingSupervisor()
    scheduler = ApiCommandScheduler(
        store=dependencies.store,
        supervisor=cast(Any, supervisor),
        cancellation=dependencies.cancellation,
        recovery=dependencies.recovery,
        engine_identity=dependencies.engine_identity,
    )
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="shutdown-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="shutdown-create",
    )

    async def exercise() -> None:
        scheduler.schedule_run(reservation)
        await started.wait()
        closing = asyncio.create_task(scheduler.close())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not closing.done()
        assert supervisor.cancelled is False
        release.set()
        await closing

    try:
        asyncio.run(exercise())
        assert supervisor.store_usable is True
    finally:
        dependencies.store.close()


def test_scheduler_startup_recovers_unclaimed_queue_and_coalesces_owners(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="startup-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="startup-create",
    )
    dependencies.store.close()
    started = threading.Event()
    release = threading.Event()

    class RecordingSupervisor:
        calls: list[str] = []

        def __init__(self, store: ControlStore) -> None:
            self.store = store

        async def run(self, recovered: RunReservation) -> None:
            self.calls.append(recovered.run_id)
            started.set()
            while not release.is_set():
                await asyncio.sleep(0.001)
            decision = self.store.request_runner_cancel(
                command=IdempotencyCommand.cancel(
                    run_id=recovered.run_id,
                    key="startup-clean-cancel",
                    canonical_request_bytes=b'{"reason":"startup-test"}',
                ),
                reason="startup-test",
            )
            assert decision.clean_no_claim
            self.store.record_runner_outcome(
                SupervisorExitV1(
                    run_id=recovered.run_id,
                    spawn_nonce=None,
                    process_identity_sha256=None,
                    launched_at_ns=None,
                    ended_at_ns=100,
                    duration_ns=0,
                    exit_code=None,
                    signal=None,
                    final_cancel_phase="REQUESTED",
                    stdout_size_bytes=0,
                    stderr_size_bytes=0,
                    stderr_sha256=sha256(b"").hexdigest(),
                    stderr_truncated=False,
                    child_outcome=None,
                    classification="NO_SPAWN_CANCELLED",
                    failure_code=None,
                    proposed_terminal_state="CANCELLED",
                )
            )

        async def recover_one(self, _run_id: str) -> None:
            raise AssertionError("unclaimed QUEUED reservations must use run")

    class RecordingRecovery:
        calls = 0

        def recover(self) -> tuple[()]:
            self.calls += 1
            return ()

    recovery = RecordingRecovery()
    schedulers: list[ApiCommandScheduler] = []
    supervisors: list[RecordingSupervisor] = []

    def factory() -> ControlDependencies:
        active = _dependencies(api_harness)
        supervisor = RecordingSupervisor(active.store)
        supervisors.append(supervisor)
        scheduler = ApiCommandScheduler(
            store=active.store,
            supervisor=cast(Any, supervisor),
            cancellation=active.cancellation,
            recovery=cast(Any, recovery),
            engine_identity=active.engine_identity,
        )
        schedulers.append(scheduler)
        return replace(active, scheduler=scheduler)

    app = create_app(
        dependency_factory=factory,
        web_local_origin=ORIGIN,
        testing=True,
    )
    try:
        with TestClient(app, headers={"Origin": ORIGIN}) as recovery_client:
            assert started.wait(timeout=1)
            replay = recovery_client.post(
                "/v1/backtests",
                headers={"Idempotency-Key": "startup-create"},
                json={
                    "preflight_id": preflight.preflight_id,
                    "canonical_request_hash": preflight.canonical_request_hash,
                },
            )
            assert replay.status_code == 202
            assert replay.json()["run_id"] == reservation.run_id
            time.sleep(0.01)
            assert supervisors[0].calls == [reservation.run_id]
            release.set()
        assert recovery.calls == 3
        assert schedulers[0].unavailable_reason() == "BACKGROUND_RECOVERY_FAILED"
    finally:
        release.set()


def test_scheduler_startup_blocks_unclaimed_queue_when_engine_identity_mismatches(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="mismatch-startup-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="mismatch-startup-create",
    )
    dependencies.store.close()
    mismatch = EngineIdentity(
        package_version="2.0.0rc2",
        tag_commit="0" * 40,
        python_version="3.12.4",
        precision_mode="FIXED_PRECISION_16",
    )
    run_attempts: list[str] = []
    schedulers: list[ApiCommandScheduler] = []

    class RecordingSupervisor:
        async def run(self, queued: RunReservation) -> None:
            run_attempts.append(queued.run_id)

        async def recover_one(self, _run_id: str) -> None:
            raise AssertionError("a bare QUEUED reservation must not enter recovery")

    def factory() -> ControlDependencies:
        active = _dependencies(api_harness)
        scheduler = ApiCommandScheduler(
            store=active.store,
            supervisor=cast(Any, RecordingSupervisor()),
            cancellation=active.cancellation,
            recovery=active.recovery,
            engine_identity=mismatch,
        )
        schedulers.append(scheduler)
        return replace(active, scheduler=scheduler, engine_identity=mismatch)

    app = create_app(
        dependency_factory=factory,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as mismatch_client:
        for _ in range(50):
            if schedulers and schedulers[0].unavailable_reason() is not None:
                break
            time.sleep(0.01)
        assert schedulers[0].unavailable_reason() == "ENGINE_VERSION_MISMATCH"
        response = mismatch_client.get("/v1/system/health")
        assert response.status_code == 503
        assert response.json()["code"] == "CONTROL_UNAVAILABLE"
        assert response.json()["details"]["check"] == "ENGINE_VERSION_MISMATCH"
        snapshot = mismatch_client.get(f"/v1/backtests/{reservation.run_id}")
        assert snapshot.status_code == 200
        assert snapshot.json()["state"] == "QUEUED"
        observer = ControlStore.open(api_harness.database)
        try:
            assert observer.runner_process(reservation.run_id) is None
            assert observer.runner_outcome(reservation.run_id) is None
        finally:
            observer.close()
        assert run_attempts == []


def test_scheduler_retries_transient_finalization_to_verified_terminal(
    api_harness: ApiHarness,
) -> None:
    run_id = seed_staged_finalizing_run(api_harness, run_id="transient-recovery")
    dependencies = _dependencies(api_harness)

    class NoopSupervisor:
        async def run(self, _reservation: RunReservation) -> None:
            raise AssertionError("FINALIZING work must not spawn")

        async def recover_one(self, _run_id: str) -> None:
            raise AssertionError("FINALIZING work must use FinalizationRecovery")

    class TransientRecovery:
        calls = 0

        def recover(self) -> tuple[object, ...]:
            self.calls += 1
            if self.calls < 3:
                raise RuntimeError("injected transient finalization failure")
            return dependencies.recovery.recover()

    recovery = TransientRecovery()
    scheduler = ApiCommandScheduler(
        store=dependencies.store,
        supervisor=cast(Any, NoopSupervisor()),
        cancellation=dependencies.cancellation,
        recovery=cast(Any, recovery),
        engine_identity=dependencies.engine_identity,
    )

    async def exercise() -> None:
        await scheduler.start()
        await scheduler.close()

    try:
        asyncio.run(exercise())
        assert recovery.calls == 3
        assert dependencies.store.run(run_id).state is RunState.CANCELLED
        assert dependencies.store.run(run_id).evidence_status == "VERIFIED"
        assert scheduler.unavailable_reason() is None
    finally:
        dependencies.store.close()


def test_active_owner_does_not_coalesce_cancel_sidecar_or_repeat_replay(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="active-owner-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="active-owner-create",
    )
    owner_started = asyncio.Event()
    owner_release = asyncio.Event()
    sidecar_started = asyncio.Event()

    class BlockingClaimedSupervisor:
        async def run(self, active: RunReservation) -> None:
            staging = stage_input_manifest(
                runtime_root=api_harness.runtime_root,
                reservation=active,
            )
            claim = dependencies.store.claim_runner_process(
                run_id=active.run_id,
                spawn_nonce="spawn-active-owner",
            )
            identity = ProcessIdentityV1(
                run_id=active.run_id,
                spawn_nonce=claim.spawn_nonce,
                pid=501,
                ppid=1,
                pgid=501,
                sid=501,
                platform="darwin",
                start_token="darwin:1700000000:123456",
                configured_executable_path="/service/venv/bin/python",
                observed_executable_path="/service/venv/bin/python",
                executable_device=7,
                executable_inode=11,
            )
            attached = dependencies.store.attach_runner_process(identity=identity)
            assert attached.launched_at_ns is not None
            owner_started.set()
            await owner_release.wait()
            outcome = SupervisorExitV1(
                run_id=active.run_id,
                spawn_nonce=claim.spawn_nonce,
                process_identity_sha256=process_identity_digest(identity),
                launched_at_ns=attached.launched_at_ns,
                ended_at_ns=attached.launched_at_ns + 1,
                duration_ns=1,
                exit_code=None,
                signal=15,
                final_cancel_phase="REQUESTED",
                stdout_size_bytes=0,
                stderr_size_bytes=0,
                stderr_sha256=sha256(b"").hexdigest(),
                stderr_truncated=False,
                child_outcome=None,
                classification="SUPERVISOR_FAILURE",
                failure_code="FORCED_TERMINATION",
                proposed_terminal_state="FAILED",
            )
            stored = dependencies.store.record_runner_outcome(outcome)
            for name, payload in (
                ("runner-exit.json", stored.outcome_bytes),
                ("stderr.txt", b""),
            ):
                path = staging / name
                path.write_bytes(payload)
                path.chmod(0o600)

        async def recover_one(self, _run_id: str) -> None:
            return None

    class RecordingCancellation:
        calls: list[str] = []

        async def terminate(
            self,
            decision: PersistedCancelRequest,
        ) -> TerminationObservation:
            run_id = decision.response.run_id
            assert run_id is not None
            self.calls.append(run_id)
            sidecar_started.set()
            return TerminationObservation(
                identity_verified=True,
                term_delivery="DELIVERED",
                kill_delivery=None,
                group_dead=True,
            )

    cancellation = RecordingCancellation()
    scheduler = ApiCommandScheduler(
        store=dependencies.store,
        supervisor=cast(Any, BlockingClaimedSupervisor()),
        cancellation=cast(Any, cancellation),
        recovery=dependencies.recovery,
        engine_identity=dependencies.engine_identity,
    )

    async def exercise() -> None:
        scheduler.schedule_run(reservation)
        await owner_started.wait()
        command = IdempotencyCommand.cancel(
            run_id=reservation.run_id,
            key="active-owner-cancel",
            canonical_request_bytes=b'{"reason":"operator"}',
        )
        decision = dependencies.store.request_runner_cancel(
            command=command,
            reason="operator",
        )
        assert decision.signal_required
        scheduler.schedule_cancel(decision)
        await asyncio.wait_for(sidecar_started.wait(), timeout=0.1)
        replay = dependencies.store.request_runner_cancel(
            command=command,
            reason="operator",
        )
        assert replay.created_by_caller is False
        scheduler.schedule_cancel(replay)
        scheduler.reconcile_run(reservation.run_id)
        await asyncio.sleep(0)
        assert cancellation.calls == [reservation.run_id]
        owner_release.set()
        await scheduler.close()
        run = dependencies.store.run(reservation.run_id)
        assert run.state is RunState.FAILED
        assert run.evidence_status == "VERIFIED"
        assert scheduler.unavailable_reason() is None

    try:
        asyncio.run(exercise())
    finally:
        dependencies.store.close()


def test_identity_loss_after_attach_never_creates_a_second_owner_or_leaks_child(
    api_harness: ApiHarness,
    draft: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependencies = _dependencies(api_harness)
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="identity-loss-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="identity-loss-create",
    )
    real_create_subprocess_exec = asyncio.create_subprocess_exec
    children: list[asyncio.subprocess.Process] = []

    async def create_sleeper(*_args: object, **_kwargs: object) -> asyncio.subprocess.Process:
        child = await real_create_subprocess_exec(
            str(Path(sys.executable).absolute()),
            "-s",
            "-P",
            "-c",
            "import time; time.sleep(0.5)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
            cwd=str(api_harness.runtime_root),
            env=build_minimal_runner_environment(0),
        )
        children.append(child)
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_sleeper)
    identity_mismatch = False
    attached = asyncio.Event()

    def adversarial_observer(pid: int, configured_executable: Path) -> ProcessObservation:
        observed = observe_process(pid, configured_executable)
        if not identity_mismatch:
            return observed
        return replace(observed, executable_inode=observed.executable_inode + 1)

    original_attach = dependencies.store.attach_runner_process

    def attach_then_lose_identity(*, identity: ProcessIdentityV1) -> RunnerProcessRecord:
        nonlocal identity_mismatch
        result = original_attach(identity=identity)
        identity_mismatch = True
        attached.set()
        return result

    monkeypatch.setattr(dependencies.store, "attach_runner_process", attach_then_lose_identity)
    cancellation = CancellationCoordinator(
        control=dependencies.store,
        identity_observer=adversarial_observer,
        term_grace_seconds=0.01,
    )
    supervisor = RunnerSupervisor(
        control=dependencies.store,
        runtime_root=api_harness.runtime_root,
        python_executable=Path(sys.executable).absolute(),
        runner_cwd=api_harness.runtime_root,
        identity_observer=adversarial_observer,
        cancellation=cancellation,
        run_timeout_seconds=0.05,
    )
    scheduler = ApiCommandScheduler(
        store=dependencies.store,
        supervisor=supervisor,
        cancellation=cancellation,
        recovery=dependencies.recovery,
        engine_identity=dependencies.engine_identity,
    )
    original_record = dependencies.store.record_runner_outcome
    outcome_recorded_after_exit: list[bool] = []

    def record_after_owned_child_exit(outcome: SupervisorExitV1) -> RunnerOutcomeRecord:
        assert children
        outcome_recorded_after_exit.append(children[0].returncode is not None)
        return original_record(outcome)

    monkeypatch.setattr(
        dependencies.store,
        "record_runner_outcome",
        record_after_owned_child_exit,
    )

    async def exercise() -> None:
        scheduler.schedule_run(reservation)
        await asyncio.wait_for(attached.wait(), timeout=1)
        decision = dependencies.store.request_runner_cancel(
            command=IdempotencyCommand.cancel(
                run_id=reservation.run_id,
                key="identity-loss-cancel",
                canonical_request_bytes=b'{"reason":"operator"}',
            ),
            reason="operator",
        )
        assert decision.signal_required
        scheduler.schedule_cancel(decision)
        try:
            await asyncio.wait_for(scheduler.close(), timeout=1)
            assert outcome_recorded_after_exit == [True]
            child = children[0]
            assert child.returncode is not None
            with pytest.raises(ProcessLookupError):
                os.killpg(child.pid, 0)
            snapshot = dependencies.store.run(reservation.run_id)
            assert snapshot.state is RunState.FAILED
            assert snapshot.evidence_status == "VERIFIED"
            assert [event.type for event in dependencies.store.events(reservation.run_id)].count(
                "run.finalizing"
            ) == 1
            assert scheduler.unavailable_reason() == "BACKGROUND_RECOVERY_FAILED"
        finally:
            if children and children[0].returncode is None:
                try:
                    os.killpg(children[0].pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await children[0].wait()

    try:
        asyncio.run(exercise())
    finally:
        dependencies.store.close()


def test_startup_recovers_claimed_cancel_pending_to_one_verified_terminal(
    api_harness: ApiHarness,
    draft: dict[str, object],
) -> None:
    dependencies = _dependencies(api_harness)
    publication = dependencies.fixture_publisher.publish("local-qa-v1")
    request = dict(draft)
    request["catalog_revision"] = publication.catalog_revision
    preflight = dependencies.preflight.run(
        BacktestDraftRequest.model_validate(request),
        idempotency_key="pending-startup-preflight",
    )
    reservation = dependencies.preflight.consume_ready(
        preflight.preflight_id,
        preflight.canonical_request_hash,
        idempotency_key="pending-startup-create",
    )
    stage_input_manifest(
        runtime_root=api_harness.runtime_root,
        reservation=reservation,
    )
    signals: list[tuple[int, int]] = []

    def send_signal(pgid: int, signal_number: int) -> None:
        signals.append((pgid, signal_number))
        os.killpg(pgid, signal_number)

    async def exercise() -> None:
        child = await asyncio.create_subprocess_exec(
            str(Path(sys.executable).absolute()),
            "-s",
            "-P",
            "-c",
            "import time; time.sleep(60)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
            cwd=str(api_harness.runtime_root),
            env=build_minimal_runner_environment(0),
        )
        wait_task = asyncio.create_task(child.wait())
        try:
            claim = dependencies.store.claim_runner_process(
                run_id=reservation.run_id,
                spawn_nonce="spawn-pending-startup",
            )
            identity = capture_process_identity(
                run_id=reservation.run_id,
                spawn_nonce=claim.spawn_nonce,
                pid=child.pid,
                configured_executable=Path(sys.executable).absolute(),
            )
            dependencies.store.attach_runner_process(identity=identity)
            decision = dependencies.store.request_runner_cancel(
                command=IdempotencyCommand.cancel(
                    run_id=reservation.run_id,
                    key="pending-startup-cancel",
                    canonical_request_bytes=b'{"reason":"operator"}',
                ),
                reason="operator",
            )
            assert decision.signal_required
            pending = dependencies.store.commit_transition(
                run_id=reservation.run_id,
                expected_version=decision.state_version,
                target=RunState.CANCEL_PENDING,
                candidate=EventCandidate.control(
                    type="run.cancel_pending",
                    ts_event_ns=str(time.time_ns()),
                    payload={"reason": "operator"},
                ),
            )
            assert pending.state is RunState.CANCEL_PENDING
            cancellation = CancellationCoordinator(
                control=dependencies.store,
                signal_sender=send_signal,
                term_grace_seconds=0.01,
            )
            supervisor = RunnerSupervisor(
                control=dependencies.store,
                runtime_root=api_harness.runtime_root,
                python_executable=Path(sys.executable).absolute(),
                runner_cwd=api_harness.runtime_root,
                cancellation=cancellation,
                run_timeout_seconds=1,
            )
            scheduler = ApiCommandScheduler(
                store=dependencies.store,
                supervisor=supervisor,
                cancellation=cancellation,
                recovery=dependencies.recovery,
                engine_identity=dependencies.engine_identity,
            )
            await scheduler.start()
            await asyncio.wait_for(scheduler.close(), timeout=1)
            assert child.returncode is not None
            await wait_task
            with pytest.raises(ProcessLookupError):
                os.killpg(child.pid, 0)
            assert signals == [(child.pid, signal.SIGTERM)]
            outcome = dependencies.store.runner_outcome(reservation.run_id)
            assert outcome is not None
            assert outcome.outcome.failure_code == "FORCED_TERMINATION"
            snapshot = dependencies.store.run(reservation.run_id)
            assert snapshot.state is RunState.FAILED
            assert snapshot.evidence_status == "VERIFIED"
            assert [event.type for event in dependencies.store.events(reservation.run_id)].count(
                "run.finalizing"
            ) == 1
            assert scheduler.unavailable_reason() is None
        finally:
            if child.returncode is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await wait_task

    try:
        asyncio.run(exercise())
    finally:
        dependencies.store.close()


def test_background_failure_makes_health_stably_unavailable(
    api_harness: ApiHarness,
) -> None:
    seed_staged_finalizing_run(api_harness, run_id="background-failure")
    schedulers: list[ApiCommandScheduler] = []

    class NoopSupervisor:
        async def run(self, _reservation: RunReservation) -> None:
            raise AssertionError("FINALIZING work must not spawn")

        async def recover_one(self, _run_id: str) -> None:
            raise AssertionError("FINALIZING work must use FinalizationRecovery")

    class FailingRecovery:
        calls = 0

        def recover(self) -> tuple[()]:
            self.calls += 1
            raise RuntimeError("injected durable finalization failure")

    recovery = FailingRecovery()

    def factory() -> ControlDependencies:
        dependencies = _dependencies(api_harness)
        scheduler = ApiCommandScheduler(
            store=dependencies.store,
            supervisor=cast(Any, NoopSupervisor()),
            cancellation=dependencies.cancellation,
            recovery=cast(Any, recovery),
            engine_identity=dependencies.engine_identity,
        )
        schedulers.append(scheduler)
        return replace(dependencies, scheduler=scheduler)

    app = create_app(
        dependency_factory=factory,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as failure_client:
        response = failure_client.get("/v1/system/health")
        for _ in range(50):
            if response.status_code == 503:
                break
            time.sleep(0.01)
            response = failure_client.get("/v1/system/health")
        assert response.status_code == 503
        assert response.json()["code"] == "CONTROL_UNAVAILABLE"
        assert response.json()["details"]["check"] == "BACKGROUND_RECOVERY_FAILED"
        assert failure_client.get("/v1/system/health").content == response.content
    assert recovery.calls == 3
    assert len(schedulers) == 1


def test_historical_occupancy_rejects_legacy_create_without_consuming_preflight(
    client: TestClient, api_harness: ApiHarness, draft: dict[str, object],
) -> None:
    preflight = ready_preflight(client, draft)
    store = _dependencies(api_harness).store
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
        "VALUES('bt_historical_busy','CANCEL_PENDING',10,'HISTORICAL_SMA_V2')"
    )
    before = tuple(store._connection.iterdump())
    response = client.post(
        "/v1/backtests",
        headers={"Idempotency-Key": "busy-create"},
        json={
            "preflight_id": preflight["preflight_id"],
            "canonical_request_hash": preflight["canonical_request_hash"],
        },
    )
    assert response.status_code == 409
    assert response.json()["code"] == "HISTORICAL_CAPACITY_BUSY"
    assert response.json()["retryable"] is True
    assert tuple(store._connection.iterdump()) == before
    assert api_harness.scheduler is not None
    assert api_harness.scheduler.reservations == []
