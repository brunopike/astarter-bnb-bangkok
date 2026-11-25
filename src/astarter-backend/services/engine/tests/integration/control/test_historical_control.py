"""Internal facade closes actual historical runs; public v2 routes remain absent."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_configuration_service import service_for
from tests.integration.control.test_historical_configurations import NOW
from tests.integration.runner.sma_component_fixture import prepare_sma_case


def control_for(store, configurations, tmp_path):
    from stark_trading_os.control.historical_control import HistoricalControl

    cwd = tmp_path / "runtime/service-cwd"
    cwd.mkdir(mode=0o700, exist_ok=True)
    return HistoricalControl(
        store=store,
        configurations=configurations,
        runtime_root=tmp_path / "runtime",
        python_executable=Path(sys.executable).absolute(),
        runner_cwd=cwd,
    )


@pytest.fixture
def case(tmp_path):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110, 100, 90])
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    configurations = service_for(store, tmp_path / "runtime")
    draft = configurations.create_draft(config)
    version = configurations.publish_draft(draft_id=draft.draft_id, expected_revision=1)
    try:
        yield store, configurations, version
    finally:
        store.close()


def test_complete_native_round_trip_has_fees_one_run_and_restart_read(case, tmp_path, monkeypatch):
    store, configurations, version = case
    control = control_for(store, configurations, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    result = asyncio.run(
        control.execute(
            preflight_id=ready.preflight_id,
            request_sha256=ready.request_sha256,
            idempotency_key="execute",
        )
    )
    assert result.state is RunState.COMPLETED and result.publication.validation == "COMPLETE_PASSED"
    report_raw = control.read_artifact(
        run_id=ready.run_id, relative_path="reports/historical-report.json"
    )
    report = json.loads(report_raw)
    assert len(report["tables"]["fills"]) == 2
    assert [r["commission"] for r in report["tables"]["fills"]] == ["0.11 USDT", "0.09 USDT"]
    assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "979.8"
    assert report["identity"]["input_manifest_sha256"] == ready.input_manifest_sha256
    assert store._connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1

    async def forbidden(*args, **kwargs):
        pytest.fail("completed retry spawned another child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    assert (
        asyncio.run(
            control.execute(
                preflight_id=ready.preflight_id,
                request_sha256=ready.request_sha256,
                idempotency_key="execute",
            )
        )
        == result
    )
    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    try:
        configs = service_for(reopened, tmp_path / "runtime")
        restarted = control_for(reopened, configs, tmp_path)
        assert asyncio.run(restarted.recover_one(ready.run_id)).publication == result.publication
        assert (
            restarted.read_artifact(
                run_id=ready.run_id, relative_path="reports/historical-report.json"
            )
            == report_raw
        )
        assert len([e for e in reopened.events(ready.run_id) if e.type == "run.completed"]) == 1
    finally:
        reopened.close()


def test_duplicate_inflight_execute_keeps_owned_process_and_capacity(case, tmp_path, monkeypatch):
    store, configurations, version = case
    control = control_for(store, configurations, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    control._preflights._consume_ready_for_control(
        ready.preflight_id, ready.request_sha256, "execute"
    )
    store.claim_runner_process(run_id=ready.run_id, spawn_nonce="existing-owner")
    before = tuple(store._connection.iterdump())

    async def forbidden(*args, **kwargs):
        pytest.fail("duplicate inflight request spawned or recovered a child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    monkeypatch.setattr(control._supervisor, "recover_one", forbidden)
    result = asyncio.run(
        control.execute(
            preflight_id=ready.preflight_id,
            request_sha256=ready.request_sha256,
            idempotency_key="execute",
        )
    )
    assert result.state is RunState.QUEUED and result.publication is None
    assert tuple(store._connection.iterdump()) == before


def test_recovery_never_prepares_unanchored_finalizing_result(case, tmp_path, monkeypatch):
    store, configurations, version = case
    control = control_for(store, configurations, tmp_path)
    ready = control.preflight(configuration_id=version.configuration_id, idempotency_key="ready")
    reservation = control._preflights._consume_ready_for_control(
        ready.preflight_id, ready.request_sha256, "execute"
    )
    asyncio.run(control._supervisor.run(reservation))
    before = tuple(store._connection.iterdump())
    result = asyncio.run(control.recover_one(ready.run_id))
    assert result.state is RunState.FINALIZING and result.publication is None
    assert result.pending_reason == "EVIDENCE_NOT_ANCHORED"
    assert tuple(store._connection.iterdump()) == before


def test_actual_native_failed_report_remains_failed_after_full_publication(tmp_path, monkeypatch):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110], cash="110")
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    configs = service_for(store, tmp_path / "runtime")
    draft = configs.create_draft(config)
    version = configs.publish_draft(draft_id=draft.draft_id, expected_revision=1)
    original = asyncio.create_subprocess_exec
    # Test-only bypass exposes the actual native cash discrepancy. Production
    # entry policy still rejects a quantity whose fee-inclusive cash is missing.
    script = (
        "import sys\n"
        "import stark_trading_os.runner.historical_sma as sma\n"
        "from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision\n"
        "from stark_trading_os.runner.historical_main import main\n"
        "sma.check_sma_intent = lambda **kwargs: SmaGuardDecision('ALLOW')\n"
        "sys.exit(main())\n"
    )

    async def launch(*args, **kwargs):
        return await original(*args[:5], "-c", script, *args[7:], **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    try:
        control = control_for(store, configs, tmp_path)
        ready = control.preflight(
            configuration_id=version.configuration_id, idempotency_key="ready"
        )
        result = asyncio.run(
            control.execute(
                preflight_id=ready.preflight_id,
                request_sha256=ready.request_sha256,
                idempotency_key="execute",
            )
        )
        assert (
            result.state is RunState.FAILED and result.publication.validation == "COMPLETE_FAILED"
        )
        raw = control.read_artifact(
            run_id=ready.run_id, relative_path="reports/historical-report.json"
        )
        report = json.loads(raw)
        assert "NATIVE_CASH_RECONCILIATION_FAILED" in report["cash_series"]["failure_codes"]
        assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "110"
        assert report["tables"]["fills"][0]["last_qty"] == "1"
    finally:
        store.close()
