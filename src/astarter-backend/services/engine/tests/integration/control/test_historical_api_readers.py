"""Historical HTTP projections preserve stored authority and original evidence."""

import asyncio
import json

import pytest

from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.run_contract import RunContractMismatch
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationIntegrityError,
    StrategyConfigurationUnknown,
    StrategyDraftUnknown,
)
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_configuration_service import service_for
from tests.integration.control.test_historical_configurations import NOW
from tests.integration.control.test_historical_control import case as _case
from tests.integration.control.test_historical_control import control_for
from tests.integration.control.test_historical_control_commands import ready_command
from tests.integration.control.test_strategy_configuration_races import _configuration
from tests.integration.runner.sma_component_fixture import prepare_sma_case

case = _case


def readers():
    from stark_trading_os.control import historical_api_adapters

    return historical_api_adapters


def test_configuration_pages_are_bounded_id_sorted_and_do_not_expose_legacy(case, tmp_path):
    store, service, version = case
    for digit in ("6", "2", "4"):
        extra = service_for(
            store,
            tmp_path / "runtime",
            draft_id="sd_" + digit * 32,
            version_id="cfg_" + digit * 32,
        )
        draft = extra.create_draft(version.configuration)
        extra.publish_draft(draft_id=draft.draft_id, expected_revision=1)
    store.create_strategy_draft(
        draft_id="sd_" + "0" * 32, configuration=_configuration(name="Legacy")
    )
    before = tuple(store._connection.iterdump())
    trace = []
    store._connection.set_trace_callback(trace.append)
    try:
        page, cursor = service.configuration_page(after_id=None, limit=2)
        assert [x.configuration_id for x in page] == ["cfg_" + n * 32 for n in ("1", "2")]
        assert cursor == page[-1].configuration_id
        tail, end = service.configuration_page(after_id=cursor, limit=2)
        assert [x.configuration_id for x in tail] == ["cfg_" + n * 32 for n in ("4", "6")]
        assert end is None
        empty, end = service.configuration_page(after_id=tail[-1].configuration_id, limit=2)
        assert empty == () and end is None
        drafts, cursor = service.draft_page(after_id=None, limit=2)
        assert [x.draft_id for x in drafts] == ["sd_" + n * 32 for n in ("1", "2")]
        assert cursor == drafts[-1].draft_id
        assert any("ORDER BY configuration_id" in sql and "LIMIT 3" in sql for sql in trace)
        assert any("ORDER BY draft_id" in sql and "LIMIT 3" in sql for sql in trace)
    finally:
        store._connection.set_trace_callback(None)
    assert tuple(store._connection.iterdump()) == before


@pytest.mark.parametrize("limit", [0, 101, True, 2.0, "2"])
def test_page_limits_are_strict_and_do_not_write(case, limit):
    store, service, _ = case
    before = tuple(store._connection.iterdump())
    for method in (service.configuration_page, service.draft_page):
        with pytest.raises(ValueError):
            method(after_id=None, limit=limit)
    assert tuple(store._connection.iterdump()) == before


def test_page_cursor_and_selected_row_keep_existing_integrity_checks(case):
    store, service, _ = case
    with pytest.raises(StrategyConfigurationUnknown):
        service.configuration_page(after_id="cfg_" + "a" * 32, limit=1)
    with pytest.raises(StrategyDraftUnknown):
        service.draft_page(after_id="sd_" + "a" * 32, limit=1)
    store._connection.execute("DROP TRIGGER trg_historical_strategy_versions_reject_update")
    store._connection.execute("UPDATE strategy_configuration_versions SET version=2")
    before = tuple(store._connection.iterdump())
    with pytest.raises(StrategyConfigurationIntegrityError):
        service.configuration_page(after_id=None, limit=1)
    assert tuple(store._connection.iterdump()) == before


def test_preflight_time_observation_never_renews_receipt_or_promises_eligibility(
    case, tmp_path, monkeypatch
):
    store, control, ready, command = ready_command(case, tmp_path)
    api = readers()
    before = tuple(store._connection.iterdump())
    status = api.historical_preflight_status(control, ready.preflight_id)
    assert status.receipt == ready and status.time_status == "IN_WINDOW"
    assert status.consumed_at_ns is None and status.current_eligibility == "NOT_RECHECKED"
    monkeypatch.setattr(store, "_clock", lambda: int(ready.expires_at_ns))
    expired = api.historical_preflight_status(control, ready.preflight_id)
    assert expired.time_status == "EXPIRED" and expired.receipt == ready
    assert tuple(store._connection.iterdump()) == before
    monkeypatch.setattr(store, "_clock", lambda: NOW)
    control.reserve(**command)
    monkeypatch.setattr(store, "_clock", lambda: int(ready.expires_at_ns))
    consumed = api.historical_preflight_status(control, ready.preflight_id)
    assert consumed.consumed_at_ns == str(NOW) and consumed.time_status == "EXPIRED"
    assert consumed.current_eligibility == "NOT_RECHECKED"


def test_run_metadata_covers_preflight_queue_and_unanchored_without_writes(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    api = readers()
    status = api.historical_run_response(control, ready.run_id)
    assert status.state is RunState.PREFLIGHT_READY
    assert status.configuration_id == ready.configuration_id
    assert status.input_manifest_hash == ready.input_manifest_sha256
    assert status.process.claim == "UNCLAIMED"
    assert status.publication.state == "NOT_PREPARED"
    assert status.publication.filesystem_verification == "NOT_CHECKED"
    reservation = control.reserve(**command)
    queued = api.historical_run_response(control, ready.run_id)
    assert queued.state is RunState.QUEUED and queued.last_visible_seq == 2
    asyncio.run(control._supervisor.run(reservation))
    before = tuple(store._connection.iterdump())
    pending = api.historical_run_response(control, ready.run_id)
    assert pending.state is RunState.FINALIZING and pending.outcome is not None
    assert pending.publication.state == "NOT_PREPARED"
    with pytest.raises(ApiError) as error:
        api.historical_artifact_index(control, ready.run_id)
    assert error.value.code == "ARTIFACT_UNVERIFIED"
    assert tuple(store._connection.iterdump()) == before
    assert not (tmp_path / "runtime/runs" / ready.run_id).exists()


@pytest.mark.parametrize("phase", ["prepared", "published"])
def test_state_metadata_is_not_fresh_filesystem_verification(case, tmp_path, phase):
    store, control, ready, command = ready_command(case, tmp_path)
    asyncio.run(control._supervisor.run(control.reserve(**command)))
    control._finalizer.prepare(ready.run_id)
    api = readers()
    if phase == "published":
        control._finalizer.finalize(ready.run_id)
        path = tmp_path / "runtime/runs" / ready.run_id / "reports/historical-report.json"
        path.chmod(0o600)
        path.write_bytes(path.read_bytes() + b" ")
        path.chmod(0o400)
    before = tuple(store._connection.iterdump())
    status = api.historical_run_response(control, ready.run_id)
    assert status.publication.state == phase.upper()
    assert status.publication.filesystem_verification == "NOT_CHECKED"
    with pytest.raises(ApiError) as error:
        api.historical_artifact_index(control, ready.run_id)
    assert error.value.code == (
        "ARTIFACT_UNVERIFIED" if phase == "prepared" else "ARTIFACT_INTEGRITY_FAILED"
    )
    assert tuple(store._connection.iterdump()) == before


def test_native_success_artifact_index_and_raw_bytes_require_full_root(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    asyncio.run(control.execute(**command))
    api = readers()
    before = tuple(store._connection.iterdump())
    index = api.historical_artifact_index(control, ready.run_id)
    assert index.report_validation == "COMPLETE_PASSED"
    assert len(index.items) == 11 and all(x.downloadable for x in index.items)
    raw = api.historical_artifact_bytes(control, ready.run_id, "historical_report")
    report = json.loads(raw)
    assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "979.8"
    assert (
        raw
        == (
            tmp_path / "runtime/runs" / ready.run_id / "reports/historical-report.json"
        ).read_bytes()
    )
    assert tuple(store._connection.iterdump()) == before
    path = tmp_path / "runtime/runs" / ready.run_id / "stderr.txt"
    path.chmod(0o600)
    path.write_bytes(b"changed")
    path.chmod(0o400)
    with pytest.raises(ApiError) as error:
        api.historical_artifact_bytes(control, ready.run_id, "historical_report")
    assert error.value.code == "ARTIFACT_INTEGRITY_FAILED"
    assert tuple(store._connection.iterdump()) == before


def test_clean_cancel_index_does_not_invent_report_and_checks_db_anchor(case, tmp_path):
    store, control, ready, command = ready_command(case, tmp_path)
    control.reserve(**command)
    control.finalize_clean_cancel(
        CancellationCoordinator(control=store).request(
            run_id=ready.run_id, idempotency_key="cancel", reason="operator"
        )
    )
    control._finalizer.finalize(ready.run_id)
    api = readers()
    before = tuple(store._connection.iterdump())
    index = api.historical_artifact_index(control, ready.run_id)
    assert index.report_validation == "NO_REPORT"
    assert [x.name.value for x in index.items if not x.downloadable] == [
        "component_snapshot",
        "historical_report",
    ]
    with pytest.raises(ApiError) as error:
        api.historical_artifact_bytes(control, ready.run_id, "historical_report")
    assert error.value.status_code == 404 and error.value.code == "ARTIFACT_NOT_PRESENT"
    assert tuple(store._connection.iterdump()) == before
    # Test-owned corruption must bypass the immutable-row guard explicitly.
    store._connection.execute("DROP TRIGGER trg_seals_immutable_update")
    store._connection.execute("UPDATE seals SET seal_digest=?", ("0" * 64,))
    corrupted = tuple(store._connection.iterdump())
    with pytest.raises(ApiError) as error:
        api.historical_artifact_bytes(control, ready.run_id, "run")
    assert error.value.code == "ARTIFACT_INTEGRITY_FAILED"
    assert tuple(store._connection.iterdump()) == corrupted


@pytest.mark.parametrize("name", ["../seal.json", "seal.json", "/tmp/secret", "request"])
def test_closed_artifact_names_reject_paths_without_writes(case, tmp_path, name):
    store, control, ready, _ = ready_command(case, tmp_path)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError):
        readers().historical_artifact_bytes(control, ready.run_id, name)
    assert tuple(store._connection.iterdump()) == before


def test_v1_run_is_rejected_before_v2_parsing_or_filesystem_access(case, tmp_path):
    store, control, _, _ = ready_command(case, tmp_path)
    legacy_id = "bt_" + "a" * 32
    store.reserve_run(run_id=legacy_id)
    before = tuple(store._connection.iterdump())
    api = readers()
    for method, args in [
        (api.historical_run_response, ()),
        (api.historical_artifact_index, ()),
        (api.historical_artifact_bytes, ("run",)),
    ]:
        with pytest.raises(RunContractMismatch):
            method(control, legacy_id, *args)
    assert tuple(store._connection.iterdump()) == before


def test_real_diagnostic_prefix_preserves_only_declared_artifacts(case, tmp_path, monkeypatch):
    store, control, ready, command = ready_command(case, tmp_path)
    original = asyncio.create_subprocess_exec
    script = (
        "import sys\nimport stark_trading_os.runner.historical_main as child\n"
        "from stark_trading_os.runner.historical_report_files import "
        "HistoricalReportPersistenceError\n"
        "persist=child.persist_historical_report_files\n"
        "def fail(**kwargs):\n"
        "    bundle=persist(**kwargs)\n"
        "    raise HistoricalReportPersistenceError(bundle.artifacts[:1])\n"
        "child.persist_historical_report_files=fail\nsys.exit(child.main())\n"
    )

    async def launch(*args, **kwargs):
        return await original(*args[:5], "-c", script, *args[7:], **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    asyncio.run(control.execute(**command))
    api = readers()
    index = api.historical_artifact_index(control, ready.run_id)
    assert index.report_validation == "DIAGNOSTIC_PREFIX" and index.state is RunState.FAILED
    assert [x.name.value for x in index.items if not x.downloadable] == ["historical_report"]
    assert api.historical_artifact_bytes(control, ready.run_id, "component_snapshot")
    with pytest.raises(ApiError) as error:
        api.historical_artifact_bytes(control, ready.run_id, "historical_report")
    assert error.value.code == "ARTIFACT_NOT_PRESENT"


def test_complete_failed_native_report_is_downloadable_without_success_claim(tmp_path, monkeypatch):
    *_, config = prepare_sma_case(tmp_path, [100, 100, 100, 110], cash="110")
    store = ControlStore.open(tmp_path / "control.sqlite", clock=lambda: NOW)
    configs = service_for(store, tmp_path / "runtime")
    draft = configs.create_draft(config)
    version = configs.publish_draft(draft_id=draft.draft_id, expected_revision=1)
    original = asyncio.create_subprocess_exec
    # Test-only native discrepancy, not a production risk-policy bypass.
    script = (
        "import sys\nimport stark_trading_os.runner.historical_sma as sma\n"
        "from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision\n"
        "from stark_trading_os.runner.historical_main import main\n"
        "sma.check_sma_intent=lambda **kwargs:SmaGuardDecision('ALLOW')\n"
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
        asyncio.run(
            control.execute(
                preflight_id=ready.preflight_id,
                request_sha256=ready.request_sha256,
                idempotency_key="run",
            )
        )
        api = readers()
        index = api.historical_artifact_index(control, ready.run_id)
        assert index.state is RunState.FAILED and index.report_validation == "COMPLETE_FAILED"
        raw = api.historical_artifact_bytes(control, ready.run_id, "historical_report")
        report = json.loads(raw)
        assert "NATIVE_CASH_RECONCILIATION_FAILED" in report["cash_series"]["failure_codes"]
    finally:
        store.close()
