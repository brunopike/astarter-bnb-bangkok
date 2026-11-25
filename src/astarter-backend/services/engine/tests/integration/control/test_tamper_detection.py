"""STA-26 read-time integrity and post-publication tamper contracts."""

from __future__ import annotations

import os
import shutil
from decimal import (
    ROUND_DOWN,
    Clamped,
    Context,
    Decimal,
    DefaultContext,
    DivisionByZero,
    Inexact,
    InvalidOperation,
    Overflow,
    Rounded,
    Subnormal,
    Underflow,
    getcontext,
    setcontext,
)
from hashlib import sha256
from pathlib import Path

import pytest
from test_finalization_crashes import _prepared_no_spawn
from test_finalization_order import MutableClock, _seed_queued

import stark_trading_os.runner.report_export as report_export_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.audit.materializer import CanonicalMaterializer, MaterializationError
from stark_trading_os.control.finalizer import Finalizer
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    SupervisorExitV1,
    process_identity_digest,
)
from stark_trading_os.control.recovery import (
    ArtifactAccessDenied,
    ArtifactIntegrityError,
    FinalizationRecovery,
)
from stark_trading_os.control.registry import (
    ControlStore,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.runner.protocol import RunnerOutcomeV1, RunnerReportCandidateV1
from stark_trading_os.runner.report_export import export_metrics, normalize_report_row

_ROOT_PATHS = (
    "request.json",
    "preflight.json",
    "input-manifest.json",
    "run-record.json",
    "events.ndjson",
    "audit.ndjson",
    "runner-exit.json",
    "stderr.txt",
    "reports/orders.json",
    "reports/fills.json",
    "reports/positions.json",
    "reports/account.json",
    "reports/metrics.json",
    "seal.json",
)


def _decimal_context_state(context: Context) -> tuple[object, ...]:
    return (
        context.prec,
        context.rounding,
        context.Emin,
        context.Emax,
        context.capitals,
        context.clamp,
        tuple(sorted((signal.__name__, enabled) for signal, enabled in context.flags.items())),
        tuple(sorted((signal.__name__, enabled) for signal, enabled in context.traps.items())),
    )


def _copy_decimal_context(source: Context, target: Context) -> None:
    target.prec = source.prec
    target.rounding = source.rounding
    target.Emin = source.Emin
    target.Emax = source.Emax
    target.capitals = source.capitals
    target.clamp = source.clamp
    for signal, enabled in source.flags.items():
        target.flags[signal] = enabled
    for signal, enabled in source.traps.items():
        target.traps[signal] = enabled


def test_new_finalization_rejects_legacy_metrics_before_seal_publication(
    tmp_path: Path,
) -> None:
    reports = _valid_empty_report_bytes()
    metrics = parse_json_object(reports["reports/metrics.json"])
    del metrics["performance_series"]
    reports["reports/metrics.json"] = canonical_json_bytes(metrics)
    store, runtime, run_id = _build_five_report_root(tmp_path, report_bytes=reports)
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "REPORTS"
        assert store.terminal_finalization(run_id=run_id) == recovered[0]
    finally:
        store.close()


@pytest.mark.parametrize(
    "equity_amount",
    ["1" + ("0" * 1_000_000), "-1" + ("0" * 1_000_000)],
    ids=["huge-positive", "huge-negative"],
)
def test_finalization_closes_equity_outside_native_money_domain_as_report_fault(
    tmp_path: Path,
    equity_amount: str,
) -> None:
    reports = _valid_empty_report_bytes()
    metrics = parse_json_object(reports["reports/metrics.json"])
    series = metrics["performance_series"]
    assert isinstance(series, dict)
    points = series["points"]
    assert isinstance(points, list)
    first = points[0]
    assert isinstance(first, dict)
    points.append(
        {
            **first,
            "point_index": 1,
            "ts_event_ns": "101",
            "equity_amount": equity_amount,
            "drawdown_pct": "0",
        }
    )
    reports["reports/metrics.json"] = canonical_json_bytes(metrics)
    store, runtime, run_id = _build_five_report_root(tmp_path, report_bytes=reports)
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "REPORTS"
        assert store.terminal_finalization(run_id=run_id) == recovered[0]
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("equity_amount", "1e999999999"),
        ("equity_amount", "1e-999999999"),
        ("drawdown_pct", "0e999999999"),
        ("drawdown_pct", "0e-999999999"),
        ("equity_amount", "1.000000001"),
        ("ts_event_ns", str(2**64)),
        ("ts_event_ns", "9" * 5_000),
    ],
)
def test_finalization_closes_performance_native_domain_as_report_fault(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str,
) -> None:
    real_formatter = report_export_module.canonical_decimal_string

    def expansion_guard(candidate: Decimal) -> str:
        exponent = candidate.as_tuple().exponent
        if isinstance(exponent, int) and abs(exponent) > 1_000:
            raise AssertionError("exponent input reached fixed-point formatting")
        return real_formatter(candidate)

    monkeypatch.setattr(report_export_module, "canonical_decimal_string", expansion_guard)
    reports = _valid_empty_report_bytes()
    metrics = parse_json_object(reports["reports/metrics.json"])
    series = metrics["performance_series"]
    assert isinstance(series, dict)
    points = series["points"]
    assert isinstance(points, list)
    first = points[0]
    assert isinstance(first, dict)
    first[field] = value
    if field == "equity_amount":
        first["drawdown_pct"] = "0"
    del points[1:]
    reports["reports/metrics.json"] = canonical_json_bytes(metrics)
    store, runtime, run_id = _build_five_report_root(tmp_path, report_bytes=reports)
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "REPORTS"
        assert store.terminal_finalization(run_id=run_id) == recovered[0]
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_recovery_ignores_hostile_ambient_decimal_context_for_valid_reports(
    tmp_path: Path,
) -> None:
    reports = _valid_empty_report_bytes()
    metrics = parse_json_object(reports["reports/metrics.json"])
    series = metrics["performance_series"]
    assert isinstance(series, dict)
    points = series["points"]
    assert isinstance(points, list)
    first = points[0]
    assert isinstance(first, dict)
    points[:] = [
        {**first, "equity_amount": "3", "drawdown_pct": "0"},
        {
            **first,
            "point_index": 1,
            "ts_event_ns": "101",
            "equity_amount": "2.99999999",
            "drawdown_pct": "-0.0000003333333333333333333333333333333333",
        },
    ]
    reports["reports/metrics.json"] = canonical_json_bytes(metrics)
    baseline_path = tmp_path / "baseline"
    hostile_path = tmp_path / "hostile"
    baseline_path.mkdir()
    hostile_path.mkdir()
    baseline_store, baseline_runtime, baseline_run_id = _build_five_report_root(
        baseline_path,
        report_bytes=reports,
    )
    hostile_store, hostile_runtime, hostile_run_id = _build_five_report_root(
        hostile_path,
        report_bytes=reports,
    )
    shutil.rmtree(baseline_runtime / "staging" / baseline_run_id)
    shutil.rmtree(hostile_runtime / "staging" / hostile_run_id)
    caller_context = getcontext().copy()
    default_context = DefaultContext.copy()
    try:
        baseline_recovered = FinalizationRecovery(
            store=baseline_store,
            runtime_root=baseline_runtime,
        ).recover()
        assert len(baseline_recovered) == 1
        baseline = baseline_recovered[0]
        assert isinstance(baseline, TerminalPublication)

        hostile_context = Context(
            prec=2,
            rounding=ROUND_DOWN,
            Emin=0,
            Emax=9,
            capitals=0,
            clamp=1,
            flags=[Clamped, Subnormal, Underflow],
            traps=[
                InvalidOperation,
                DivisionByZero,
                Overflow,
                Inexact,
                Rounded,
                Clamped,
                Subnormal,
                Underflow,
            ],
        )
        _copy_decimal_context(hostile_context, DefaultContext)
        setcontext(hostile_context.copy())
        hostile_before = _decimal_context_state(getcontext())
        hostile_recovered = FinalizationRecovery(
            store=hostile_store,
            runtime_root=hostile_runtime,
        ).recover()
        assert _decimal_context_state(getcontext()) == hostile_before

        assert len(hostile_recovered) == 1
        hostile = hostile_recovered[0]
        assert isinstance(hostile, TerminalPublication)
        assert hostile.seal_digest == baseline.seal_digest
        baseline_seal = parse_json_object(
            (baseline_runtime / "runs" / baseline_run_id / "seal.json").read_bytes()
        )
        hostile_seal = parse_json_object(
            (hostile_runtime / "runs" / hostile_run_id / "seal.json").read_bytes()
        )
        assert hostile_seal["audit_head_hash"] == baseline_seal["audit_head_hash"]
        assert hostile_store.terminal_finalization(run_id=hostile_run_id) == hostile
    finally:
        setcontext(caller_context)
        _copy_decimal_context(default_context, DefaultContext)
        baseline_store.close()
        hostile_store.close()


@pytest.mark.parametrize(
    ("field", "value"),
    [("account_id", "OTHER-001"), ("currency", "USD")],
)
def test_finalization_binds_performance_account_and_currency_before_seal(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    reports = _valid_empty_report_bytes()
    metrics = parse_json_object(reports["reports/metrics.json"])
    series = metrics["performance_series"]
    assert isinstance(series, dict)
    series[field] = value
    reports["reports/metrics.json"] = canonical_json_bytes(metrics)
    store, runtime, run_id = _build_five_report_root(tmp_path, report_bytes=reports)
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "RECONCILIATION"
    finally:
        store.close()


def test_recovery_rejects_self_consistent_root_that_failed_the_report_gate(
    tmp_path: Path,
) -> None:
    """Catches recovery treating a valid seal as a substitute for report validation."""

    invalid_reports = {
        f"reports/{name}.json": canonical_json_bytes({} if name == "metrics" else [])
        for name in ("orders", "fills", "positions", "account", "metrics")
    }
    store, runtime, run_id = _build_five_report_root(
        tmp_path,
        report_bytes=invalid_reports,
    )
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "REPORTS"
        assert store.terminal_finalization(run_id=run_id) == recovered[0]
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_direct_renamed_root_adoption_cannot_skip_the_report_gate(tmp_path: Path) -> None:
    """Catches exposing a publication API whose caller can omit semantic validation."""

    invalid_reports = {
        f"reports/{name}.json": canonical_json_bytes({} if name == "metrics" else [])
        for name in ("orders", "fills", "positions", "account", "metrics")
    }
    store, runtime, run_id = _build_five_report_root(
        tmp_path,
        report_bytes=invalid_reports,
    )
    shutil.rmtree(runtime / "staging" / run_id)
    preparation = store.terminal_preparation(run_id=run_id)
    assert preparation is not None
    try:
        with pytest.raises(MaterializationError) as failure:
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).recover_renamed_and_publish(preparation=preparation)

        assert failure.value.stage == "REPORTS"
        assert store.terminal_finalization(run_id=run_id) is None
    finally:
        store.close()


def test_recovery_rejects_final_root_that_failed_economic_reconciliation(
    tmp_path: Path,
) -> None:
    """Catches recovery validating report schemas without rerunning economic checks."""

    store, runtime, run_id = _build_five_report_root(
        tmp_path,
        report_bytes=_valid_empty_report_bytes(orders_total="1"),
    )
    shutil.rmtree(runtime / "staging" / run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert recovered[0].fault.stage == "RECONCILIATION"
        assert store.terminal_finalization(run_id=run_id) == recovered[0]
    finally:
        store.close()


def test_verified_artifact_read_rechecks_the_complete_published_root(tmp_path: Path) -> None:
    """Catches granting access from SQLite VERIFIED state without reopening the root."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_artifact_read")
    try:
        publication = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert isinstance(publication, TerminalPublication)
        expected = (runtime / "runs" / preparation.run_id / "run-record.json").read_bytes()
        try:
            observed = FinalizationRecovery(
                store=store,
                runtime_root=runtime,
            ).read_artifact(
                run_id=preparation.run_id,
                relative_path="run-record.json",
            )
        except ArtifactAccessDenied:
            observed = None

        assert observed == expected
    finally:
        store.close()


@pytest.mark.parametrize("relative_path", _ROOT_PATHS)
def test_every_published_file_tamper_is_named_without_rewriting_terminal_history(
    tmp_path: Path,
    relative_path: str,
) -> None:
    """Catches partial verification or post-publication terminal-history downgrade."""

    store, runtime, run_id = _publish_five_report_root(tmp_path)
    root = runtime / "runs" / run_id
    try:
        _change_file(root, relative_path)
        frozen = _terminal_history(store, run_id)

        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=run_id,
                relative_path="run-record.json",
            )

        assert getattr(failure.value, "artifact", None) == relative_path
        assert _terminal_history(store, run_id) == frozen
    finally:
        store.close()


@pytest.mark.parametrize("relative_path", _ROOT_PATHS)
def test_every_published_file_deletion_is_named_without_history_rewrite(
    tmp_path: Path,
    relative_path: str,
) -> None:
    """Catches an incomplete root being accepted because only remaining files were checked."""

    store, runtime, run_id = _publish_five_report_root(tmp_path)
    root = runtime / "runs" / run_id
    try:
        _delete_file(root, relative_path)
        frozen = _terminal_history(store, run_id)

        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=run_id,
                relative_path="run-record.json",
            )

        assert getattr(failure.value, "artifact", None) == relative_path
        assert _terminal_history(store, run_id) == frozen
    finally:
        store.close()


@pytest.mark.parametrize(
    ("relative_path", "expected_artifact"),
    (("extra.bin", "extra.bin"), ("reports/extra.json", "reports/extra.json")),
)
def test_unsealed_extra_file_is_named_and_denied(
    tmp_path: Path,
    relative_path: str,
    expected_artifact: str,
) -> None:
    """Catches accepting a seal that covers only a subset of the named root."""

    store, runtime, run_id = _publish_five_report_root(tmp_path)
    root = runtime / "runs" / run_id
    path = root / relative_path
    path.parent.chmod(0o700)
    path.write_bytes(b"extra")
    path.chmod(0o400)
    path.parent.chmod(0o500)
    try:
        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=run_id,
                relative_path="run-record.json",
            )
        assert getattr(failure.value, "artifact", None) == expected_artifact
    finally:
        store.close()


@pytest.mark.parametrize("mutation", ("mode", "symlink", "hardlink", "fifo"))
def test_non_regular_or_mutable_file_metadata_is_denied(
    tmp_path: Path,
    mutation: str,
) -> None:
    """Catches content-only verification that ignores mode, type, or link count."""

    store, runtime, run_id = _publish_five_report_root(tmp_path)
    root = runtime / "runs" / run_id
    path = root / "run-record.json"
    root.chmod(0o700)
    original = path.read_bytes()
    if mutation == "mode":
        path.chmod(0o600)
    else:
        path.unlink()
        if mutation == "symlink":
            path.symlink_to(runtime / "control.sqlite")
        elif mutation == "hardlink":
            forged = runtime / "forged-run-record.json"
            forged.write_bytes(original)
            forged.chmod(0o400)
            os.link(forged, path)
        else:
            os.mkfifo(path, mode=0o400)
    root.chmod(0o500)
    try:
        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=run_id,
                relative_path="run-record.json",
            )
        assert getattr(failure.value, "artifact", None) == "run-record.json"
    finally:
        store.close()


@pytest.mark.parametrize(
    ("target", "expected_artifact"),
    (("root", "<root>"), ("reports", "reports")),
)
def test_mutable_directory_metadata_is_denied(
    tmp_path: Path,
    target: str,
    expected_artifact: str,
) -> None:
    """Catches treating writable final directories as immutable evidence."""

    store, runtime, run_id = _publish_five_report_root(tmp_path)
    root = runtime / "runs" / run_id
    path = root if target == "root" else root / "reports"
    path.chmod(0o700)
    try:
        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=run_id,
                relative_path="run-record.json",
            )
        assert getattr(failure.value, "artifact", None) == expected_artifact
    finally:
        store.close()


def test_renamed_only_and_unverified_runs_never_grant_artifact_access(tmp_path: Path) -> None:
    """Catches treating a directory name or explicit partial evidence as an access grant."""

    (tmp_path / "renamed").mkdir()
    renamed_store, renamed_runtime, preparation = _prepared_no_spawn(
        tmp_path / "renamed",
        run_id="bt_access_renamed_only",
    )
    CanonicalMaterializer(
        store=renamed_store,
        runtime_root=renamed_runtime,
    ).build_verify_and_rename(preparation=preparation)
    try:
        with pytest.raises(ArtifactAccessDenied):
            FinalizationRecovery(
                store=renamed_store,
                runtime_root=renamed_runtime,
            ).read_artifact(
                run_id=preparation.run_id,
                relative_path="run-record.json",
            )
    finally:
        renamed_store.close()

    (tmp_path / "failed").mkdir()
    failed_store, failed_runtime, failed_preparation = _prepared_no_spawn(
        tmp_path / "failed",
        run_id="bt_access_unverified",
    )
    staging = failed_runtime / "staging" / failed_preparation.run_id
    (staging / "unexpected").write_bytes(b"tamper")
    try:
        Finalizer(store=failed_store, runtime_root=failed_runtime).finalize(
            failed_preparation.run_id
        )
        with pytest.raises(ArtifactAccessDenied):
            FinalizationRecovery(
                store=failed_store,
                runtime_root=failed_runtime,
            ).read_artifact(
                run_id=failed_preparation.run_id,
                relative_path="run-record.json",
            )
    finally:
        failed_store.close()


def test_sqlite_external_seal_tamper_is_reported_without_history_rewrite(
    tmp_path: Path,
) -> None:
    """Catches trusting a modified external digest or rewriting the original terminal result."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_sqlite_seal_tamper")
    database_path = runtime / "control.sqlite"
    tampered: ControlStore | None = None
    try:
        publication = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert isinstance(publication, TerminalPublication)
        store.close()
        database_bytes = database_path.read_bytes()
        digest_bytes = publication.seal_digest.encode("ascii")
        assert database_bytes.count(digest_bytes) == 1
        database_path.write_bytes(database_bytes.replace(digest_bytes, b"0" * 64, 1))
        tampered = ControlStore.open(database_path)
        frozen = _terminal_history(tampered, preparation.run_id)

        with pytest.raises(ArtifactIntegrityError) as failure:
            FinalizationRecovery(store=tampered, runtime_root=runtime).read_artifact(
                run_id=preparation.run_id,
                relative_path="run-record.json",
            )

        assert getattr(failure.value, "artifact", None) == "control.sqlite:seals"
        assert _terminal_history(tampered, preparation.run_id) == frozen
    finally:
        if tampered is not None:
            tampered.close()
        store.close()


def test_unknown_relative_path_is_denied_after_full_verification(tmp_path: Path) -> None:
    """Catches path traversal or access to bytes outside the sealed inventory."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_access_path")
    try:
        Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        with pytest.raises(ArtifactAccessDenied):
            FinalizationRecovery(store=store, runtime_root=runtime).read_artifact(
                run_id=preparation.run_id,
                relative_path="../control.sqlite",
            )
    finally:
        store.close()


def _publish_five_report_root(tmp_path: Path) -> tuple[ControlStore, Path, str]:
    store, runtime, run_id = _build_five_report_root(
        tmp_path,
        report_bytes=_valid_empty_report_bytes(),
    )
    recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()
    assert len(recovered) == 1 and isinstance(recovered[0], TerminalPublication)
    return store, runtime, run_id


def _build_five_report_root(
    tmp_path: Path,
    *,
    report_bytes: dict[str, bytes],
) -> tuple[ControlStore, Path, str]:
    run_id = "bt_tamper_five_reports"
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    (runtime / "runs").mkdir(mode=0o700)
    store = ControlStore.open(runtime / "control.sqlite", clock=MutableClock())
    input_manifest_hash, catalog_revision = _seed_queued(store, run_id, tmp_path=tmp_path)
    spawn_nonce = f"spawn-{run_id}"
    store.claim_runner_process(run_id=run_id, spawn_nonce=spawn_nonce)
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
    attached = store.attach_runner_process(identity=identity)
    assert attached.launched_at_ns is not None
    assert store.run(run_id).state.value == "RUNNING"
    candidates = tuple(
        RunnerReportCandidateV1(
            name=name,
            relative_path=f"reports/{name}.json",
            sha256=sha256(report_bytes[f"reports/{name}.json"]).hexdigest(),
            size_bytes=len(report_bytes[f"reports/{name}.json"]),
        )
        for name in ("orders", "fills", "positions", "account", "metrics")
    )
    child = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": run_id,
            "input_manifest_hash": input_manifest_hash,
            "catalog_revision": catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "SUCCEEDED",
            "last_source_seq": 0,
            "report_candidates": [
                candidate.model_dump(mode="json", by_alias=True) for candidate in candidates
            ],
            "failure": None,
        }
    )
    outcome = SupervisorExitV1(
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        process_identity_sha256=process_identity_digest(identity),
        launched_at_ns=attached.launched_at_ns,
        ended_at_ns=attached.launched_at_ns + 1,
        duration_ns=1,
        exit_code=0,
        signal=None,
        final_cancel_phase="NONE",
        stdout_size_bytes=0,
        stderr_size_bytes=0,
        stderr_sha256=sha256(b"").hexdigest(),
        stderr_truncated=False,
        child_outcome=child,
        classification="NATURAL_SUCCESS",
        failure_code=None,
        proposed_terminal_state="COMPLETED",
    )
    store.record_runner_outcome(outcome)
    preparation = store.prepare_terminal(run_id=run_id)
    run = store.run(run_id)
    assert run.input_manifest_bytes is not None
    staging_parent = runtime / "staging"
    staging_parent.mkdir(mode=0o700)
    staging = staging_parent / run_id
    staging.mkdir(mode=0o700)
    for name, payload in (
        ("input-manifest.json", run.input_manifest_bytes),
        ("runner-exit.json", preparation.outcome.outcome_bytes),
        ("stderr.txt", b""),
    ):
        path = staging / name
        path.write_bytes(payload)
        path.chmod(0o600)
    reports = staging / "reports"
    reports.mkdir(mode=0o700)
    for relative_path, payload in report_bytes.items():
        path = staging / relative_path
        path.write_bytes(payload)
        path.chmod(0o600)
    CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
        preparation=preparation
    )
    return store, runtime, run_id


def _valid_empty_report_bytes(*, orders_total: str = "0") -> dict[str, bytes]:
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
    metrics = export_metrics(
        {
            "summary": {
                "orders.total": orders_total,
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
            "performance_series": {
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
            },
        }
    )
    return {
        "reports/orders.json": canonical_json_bytes([]),
        "reports/fills.json": canonical_json_bytes([]),
        "reports/positions.json": canonical_json_bytes([]),
        "reports/account.json": canonical_json_bytes([account]),
        "reports/metrics.json": canonical_json_bytes(metrics),
    }


def _change_file(root: Path, relative_path: str) -> None:
    path = root / relative_path
    parent = path.parent
    parent.chmod(0o700)
    path.chmod(0o600)
    original = path.read_bytes()
    path.write_bytes((b"X" + original[1:]) if original else b"X")
    path.chmod(0o400)
    parent.chmod(0o500)


def _delete_file(root: Path, relative_path: str) -> None:
    path = root / relative_path
    parent = path.parent
    parent.chmod(0o700)
    path.unlink()
    parent.chmod(0o500)


def _terminal_history(store: ControlStore, run_id: str) -> tuple[object, ...]:
    run = store._connection.execute(
        "SELECT state, state_version, evidence_status FROM runs WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    events = tuple(
        store._connection.execute(
            "SELECT seq, type, visible, envelope_bytes FROM events WHERE run_id = ? ORDER BY seq",
            (run_id,),
        ).fetchall()
    )
    seals = tuple(
        store._connection.execute(
            "SELECT seal_digest, terminal_event_seq, last_audit_seq FROM seals WHERE run_id = ?",
            (run_id,),
        ).fetchall()
    )
    faults = store._connection.execute(
        "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?",
        (run_id,),
    ).fetchone()[0]
    return tuple(run), events, seals, faults
