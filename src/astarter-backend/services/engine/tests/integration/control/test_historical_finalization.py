"""Original-byte anchors precede publication; restart never invents authority."""

import asyncio
import json
import os
import sqlite3
from hashlib import sha256

import pytest

from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.models import RunState
from tests.integration.control.test_historical_supervisor import (
    queued,
    supervisor,
)
from tests.integration.control.test_historical_supervisor import (
    setup as _native_setup,
)

setup = _native_setup


def finished(setup, tmp_path):
    store, _, reservation = queued(setup, tmp_path)
    result = asyncio.run(supervisor(store, tmp_path).run(reservation))
    assert result.outcome.outcome.classification == "NATURAL_SUCCESS"
    return store, reservation.run_id


def finalizer(store, tmp_path):
    from stark_trading_os.control.historical_finalizer import HistoricalFinalizer

    return HistoricalFinalizer(store=store, runtime_root=tmp_path / "runtime")


def test_independent_anchor_is_committed_before_any_final_directory(setup, tmp_path):
    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    preparation = service.prepare(run_id)
    assert preparation.anchor.validation == "COMPLETE_PASSED"
    assert preparation.anchor.terminal_state == "COMPLETED"
    assert store.run(run_id).state is RunState.FINALIZING
    assert not (tmp_path / "runtime/runs" / run_id).exists()
    assert store._connection.execute("SELECT COUNT(*) FROM seals").fetchone()[0] == 0
    assert (
        store._connection.execute("SELECT COUNT(*) FROM terminal_preparations").fetchone()[0] == 1
    )
    assert (
        store._connection.execute("SELECT COUNT(*) FROM historical_terminal_anchors").fetchone()[0]
        == 1
    )
    report = (tmp_path / "runtime/staging" / run_id / "reports/historical-report.json").read_bytes()
    anchor = next(
        a for a in preparation.anchor.artifacts if a.path == "reports/historical-report.json"
    )
    assert anchor.sha256 == sha256(report).hexdigest() and anchor.size_bytes == len(report)
    assert service.prepare(run_id) == preparation


def test_historical_publication_has_one_terminal_event_and_fresh_verified_artifact_read(
    setup, tmp_path
):
    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    result = service.finalize(run_id)
    assert result.state is RunState.COMPLETED
    assert store.run(run_id).state is RunState.COMPLETED
    report = service.read_artifact(run_id=run_id, relative_path="reports/historical-report.json")
    assert (
        report
        == (tmp_path / "runtime/staging" / run_id / "reports/historical-report.json").read_bytes()
    )
    assert len([e for e in store.events(run_id) if e.type == "run.completed"]) == 1
    assert service.finalize(run_id) == result
    assert store._connection.execute("SELECT COUNT(*) FROM seals").fetchone()[0] == 1


def test_recovery_without_anchor_retains_unverified_evidence(setup, tmp_path):
    store, run_id = finished(setup, tmp_path)
    before = tuple(store._connection.iterdump())
    assert finalizer(store, tmp_path).recover_one(run_id) is None
    assert tuple(store._connection.iterdump()) == before
    assert store.run(run_id).state is RunState.FINALIZING


def test_restart_keeps_original_anchor_and_rejects_changed_report(setup, tmp_path):
    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    preparation = service.prepare(run_id)
    path = tmp_path / "runtime/staging" / run_id / "reports/historical-report.json"
    path.write_bytes(path.read_bytes() + b" ")
    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=store._clock)
    try:
        recovered = finalizer(reopened, tmp_path)
        assert recovered.preparation(run_id) == preparation
        before = tuple(reopened._connection.iterdump())
        with pytest.raises(ValueError):
            recovered.recover_one(run_id)
        assert tuple(reopened._connection.iterdump()) == before
        assert reopened.run(run_id).state is RunState.FINALIZING
    finally:
        reopened.close()


@pytest.mark.parametrize("point", ["before_rename", "after_rename", "database_publication"])
def test_crash_boundaries_recover_original_anchor_exactly_once(setup, tmp_path, monkeypatch, point):
    from stark_trading_os.control import historical_artifacts as artifacts

    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    preparation = service.prepare(run_id)
    original = artifacts._darwin_rename_no_replace

    def crash(*args):
        if point == "after_rename":
            original(*args)
        raise RuntimeError("simulated process crash at rename")

    if point == "database_publication":
        store._connection.execute(
            "CREATE TRIGGER crash_publish BEFORE INSERT ON seals "
            "BEGIN SELECT RAISE(ABORT,'simulated publication crash'); END"
        )
        error_type = sqlite3.IntegrityError
    else:
        monkeypatch.setattr(artifacts, "_darwin_rename_no_replace", crash)
        error_type = RuntimeError
    with pytest.raises(error_type):
        service.finalize(run_id)
    assert store.run(run_id).state is RunState.FINALIZING
    assert store._connection.execute("SELECT COUNT(*) FROM seals").fetchone()[0] == 0
    assert service.preparation(run_id) == preparation
    assert (tmp_path / "runtime/runs" / run_id).exists() is (point != "before_rename")
    monkeypatch.setattr(artifacts, "_darwin_rename_no_replace", original)
    if point == "database_publication":
        store._connection.execute("DROP TRIGGER crash_publish")
    reopened = ControlStore.open(tmp_path / "control.sqlite", clock=store._clock)
    try:
        recovered = finalizer(reopened, tmp_path)
        publication = recovered.recover_one(run_id)
        assert publication.state is RunState.COMPLETED
        assert recovered.preparation(run_id) == preparation
        assert recovered.recover_one(run_id) == publication
        assert len([e for e in reopened.events(run_id) if e.type == "run.completed"]) == 1
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "mutation", ["bytes", "file_mode", "hardlink", "symlink", "extra", "root_mode"]
)
def test_fresh_read_rejects_altered_immutable_root(setup, tmp_path, mutation):
    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    service.finalize(run_id)
    root = tmp_path / "runtime/runs" / run_id
    path = root / "reports/historical-report.json"
    raw = path.read_bytes()
    if mutation == "bytes":
        path.chmod(0o600)
        path.write_bytes(raw + b" ")
        path.chmod(0o400)
    elif mutation == "file_mode":
        path.chmod(0o600)
    elif mutation in {"hardlink", "symlink"}:
        path.parent.chmod(0o700)
        outside = tmp_path / "outside-report"
        outside.write_bytes(raw)
        outside.chmod(0o400)
        path.unlink()
        if mutation == "hardlink":
            os.link(outside, path)
        else:
            path.symlink_to(outside)
        path.parent.chmod(0o500)
    elif mutation == "extra":
        root.chmod(0o700)
        (root / "extra").write_bytes(b"unexpected")
        root.chmod(0o500)
    else:
        root.chmod(0o700)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError):
        service.read_artifact(run_id=run_id, relative_path="run.json")
    assert tuple(store._connection.iterdump()) == before


def test_root_mode_changed_during_retained_read_cannot_publish(setup, tmp_path, monkeypatch):
    from stark_trading_os.control import historical_artifacts as artifacts

    store, run_id = finished(setup, tmp_path)
    service = finalizer(store, tmp_path)
    service.prepare(run_id)
    original = artifacts._read
    root = tmp_path / "runtime/runs" / run_id

    def changed(*args, **kwargs):
        raw = original(*args, **kwargs)
        if root.exists():
            root.chmod(0o700)
        return raw

    monkeypatch.setattr(artifacts, "_read", changed)
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError):
        service.finalize(run_id)
    assert tuple(store._connection.iterdump()) == before


def test_clean_no_spawn_cancel_can_publish_without_fabricated_report(setup, tmp_path):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    decision = CancellationCoordinator(control=store).request(
        run_id=reservation.run_id, idempotency_key="cancel", reason="operator"
    )
    owner.finalize_clean_cancel(decision)
    service = finalizer(store, tmp_path)
    publication = service.finalize(reservation.run_id)
    assert publication.state is RunState.CANCELLED and publication.validation == "NO_REPORT"
    assert not (tmp_path / "runtime/runs" / reservation.run_id / "reports").exists()
    assert store.runner_process(reservation.run_id) is None


def test_candidate_hashes_cannot_substitute_for_independent_semantic_validation(
    setup, tmp_path, monkeypatch
):
    from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
    from stark_trading_os.runner.historical_protocol import RunnerOutcomeV2

    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    original = owner._record_natural_exit_artifact

    def forged_report(staging, outcome):
        # Fault injection: candidate/child digest agree, but report account is foreign.
        path = staging / "reports/historical-report.json"
        payload = json.loads(path.read_bytes())
        payload["identity"]["account_id"] = "FOREIGN-001"
        raw = canonical_historical_bytes(payload)
        path.write_bytes(raw)
        child = outcome.child_outcome.model_dump()
        child["artifacts"][1].update(sha256=sha256(raw).hexdigest(), size_bytes=len(raw))
        modified = outcome.model_copy(
            update={"child_outcome": RunnerOutcomeV2.model_validate(child)}
        )
        return original(staging, modified)

    monkeypatch.setattr(owner, "_record_natural_exit_artifact", forged_report)
    asyncio.run(owner.run(reservation))
    before = tuple(store._connection.iterdump())
    with pytest.raises(ValueError):
        finalizer(store, tmp_path).prepare(reservation.run_id)
    assert tuple(store._connection.iterdump()) == before
    assert (
        store._connection.execute("SELECT COUNT(*) FROM historical_terminal_anchors").fetchone()[0]
        == 0
    )


@pytest.mark.parametrize("prefix", [0, 1, 2])
def test_real_child_persistence_failure_retains_only_declared_diagnostic_prefix(
    setup, tmp_path, monkeypatch, prefix
):
    store, _, reservation = queued(setup, tmp_path)
    owner = supervisor(store, tmp_path)
    original = asyncio.create_subprocess_exec
    script = (
        "import sys\n"
        "import stark_trading_os.runner.historical_main as child\n"
        "from stark_trading_os.runner.historical_report_files import "
        "HistoricalReportPersistenceError\n"
        "persist = child.persist_historical_report_files\n"
        "def fail(**kwargs):\n"
        "    bundle = persist(**kwargs)\n"
        f"    raise HistoricalReportPersistenceError(bundle.artifacts[:{prefix}])\n"
        "child.persist_historical_report_files = fail\n"
        "sys.exit(child.main())\n"
    )

    async def launch(*args, **kwargs):
        return await original(*args[:5], "-c", script, *args[7:], **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    observed = asyncio.run(owner.run(reservation))
    assert observed.outcome.outcome.classification == "NATURAL_FAILURE"
    assert observed.outcome.outcome.child_outcome.failure_code == "PERSISTENCE_FAILED"
    result = finalizer(store, tmp_path).finalize(reservation.run_id)
    assert result.state is RunState.FAILED
    assert result.validation == ("NO_REPORT" if prefix == 0 else "DIAGNOSTIC_PREFIX")
    reports = tmp_path / "runtime/runs" / reservation.run_id / "reports"
    assert len(list(reports.iterdir())) == prefix if prefix else not reports.exists()
    assert len(list((tmp_path / "runtime/staging" / reservation.run_id / "reports").iterdir())) == 2


def test_shared_recovery_dispatches_anchored_historical_and_retains_unanchored(setup, tmp_path):
    from stark_trading_os.control.recovery import FinalizationRecovery

    store, run_id = finished(setup, tmp_path)
    finalizer(store, tmp_path).prepare(run_id)
    pending = "bt_" + "0" * 32
    store._connection.execute(
        "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
        "VALUES(?, 'FINALIZING',10,'HISTORICAL_SMA_V2')",
        (pending,),
    )
    recovery = FinalizationRecovery(store=store, runtime_root=tmp_path / "runtime")
    completed = recovery.recover()
    assert len(completed) == 1 and completed[0].run_id == run_id
    assert completed[0].state is RunState.COMPLETED
    assert recovery.pending_historical_run_ids == (pending,)
    assert store.run(pending).state is RunState.FINALIZING
    assert recovery.recover() == ()
