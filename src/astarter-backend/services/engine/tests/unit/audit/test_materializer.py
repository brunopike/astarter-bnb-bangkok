from __future__ import annotations

import asyncio
import fcntl
import json
import os
import socket
import stat
import sys
import uuid
from dataclasses import replace
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest

import stark_trading_os.audit.materializer as materializer_module
from stark_trading_os.audit.canonical_json import canonical_json_bytes, parse_json_object
from stark_trading_os.audit.hash_chain import append_hash_chain
from stark_trading_os.audit.materializer import (
    CanonicalMaterializer,
    MaterializationError,
    MaterializedRun,
)
from stark_trading_os.audit.replay import ReplaySchemaError
from stark_trading_os.catalog.fixture_publisher import FixturePublisher, open_catalog_service
from stark_trading_os.catalog.fixture_registry import FixtureRegistry
from stark_trading_os.control.cancellation import CancellationCoordinator
from stark_trading_os.control.finalizer import FinalizationRetryPending, Finalizer
from stark_trading_os.control.preflight import (
    EngineIdentity,
    PreflightService,
    RegisteredDefinition,
    RunReservation,
)
from stark_trading_os.control.process_identity import ProcessObservation
from stark_trading_os.control.registry import (
    AuditIntent,
    ControlStore,
    EventCandidate,
    PersistedEvent,
    PreflightSnapshot,
    RunSnapshot,
    TerminalPreparation,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.supervisor import RunnerSupervisor
from stark_trading_os.control.transactions import TerminalPublicationConflict
from stark_trading_os.domain.models import (
    BacktestDraftRequest,
    CatalogManifestV1,
    InputManifestV1,
    RunState,
)
from stark_trading_os.runner.protocol import (
    RunnerCandidateV1,
    RunnerOutcomeV1,
    RunnerReportCandidateV1,
    encode_protocol_line,
)

REPOSITORY_ROOT = Path(__file__).parents[5]


class MutableClock:
    def __init__(self, value: int = 100) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


class FakeProcess:
    def __init__(self, *, stdout: bytes, returncode: int = 0) -> None:
        self.pid = 501
        self.stdout = asyncio.StreamReader(limit=65_537)
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader(limit=65_537)
        self.stderr.feed_eof()
        self.returncode: int | None = None
        self._final_returncode = returncode

    async def wait(self) -> int:
        self.returncode = self._final_returncode
        return self._final_returncode


@pytest.fixture(scope="module")
def task7_report_template(tmp_path_factory: pytest.TempPathFactory) -> dict[str, bytes]:
    """Produce one immutable real Task 7 report template for STA-25 cases."""

    store, runtime, _clock, reservation = _task7_template_reservation(
        tmp_path_factory.mktemp("task7-report-template"),
        run_id="bt_task7_template",
    )
    service_cwd = runtime / "service-cwd"
    service_cwd.mkdir(mode=0o700)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        run_timeout_seconds=30,
    )
    try:
        result = asyncio.run(supervisor.run(reservation))
        assert result.state is RunState.FINALIZING
        reports = runtime / "staging" / reservation.run_id / "reports"
        return {
            f"reports/{name}.json": (reports / f"{name}.json").read_bytes()
            for name in _REPORT_NAMES
        }
    finally:
        store.close()


def test_materializer_projects_one_real_no_spawn_preparation_without_publication(
    tmp_path: Path,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    try:
        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )

        assert isinstance(result, MaterializedRun)
        assert result.run_id == preparation.run_id
        assert result.terminal_state is RunState.CANCELLED
        assert result.terminal_event_seq == preparation.event.seq
        assert result.last_audit_seq == preparation.audit_intent.audit_seq
        final_root = runtime / "runs" / preparation.run_id
        assert final_root.is_dir()
        expected_events = b"".join(
            event.envelope_bytes + b"\n"
            for event in (*store.events(preparation.run_id), preparation.event)
        )
        expected_audit_entries = append_hash_chain(
            [
                parse_json_object(audit.intent_bytes)
                for audit in (
                    *store.audit_intents(preparation.run_id),
                    preparation.audit_intent,
                )
            ]
        )
        expected_audit = b"".join(
            canonical_json_bytes(entry) + b"\n" for entry in expected_audit_entries
        )
        assert (final_root / "events.ndjson").read_bytes() == expected_events
        assert (final_root / "audit.ndjson").read_bytes() == expected_audit
        assert result.audit_head_hash == expected_audit_entries[-1]["entry_hash"]
        assert (final_root / "run-record.json").read_bytes() == canonical_json_bytes(
            preparation.run_record.model_dump(mode="json", by_alias=True)
        )
        assert (final_root / "seal.json").read_bytes() == result.seal_bytes
        assert sha256(result.seal_bytes).hexdigest() == result.seal_digest
        assert stat.S_IMODE(final_root.stat().st_mode) == 0o500
        assert {path.name for path in final_root.iterdir()} == {
            "request.json",
            "preflight.json",
            "input-manifest.json",
            "run-record.json",
            "events.ndjson",
            "audit.ndjson",
            "runner-exit.json",
            "stderr.txt",
            "seal.json",
        }
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o400 for path in final_root.iterdir())
        assert store.run(preparation.run_id).state is RunState.FINALIZING
        assert store.events(preparation.run_id)[-1].type == "run.finalizing"
        assert not any(
            event.type == "report.generated" for event in store.events(preparation.run_id)
        )
    finally:
        store.close()


def test_staging_snapshot_returns_exact_declared_report_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a snapshot that omits or fabricates an authority-bound report."""

    store, runtime, preparation, report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=1,
        completed=False,
    )
    try:
        snapshot = CanonicalMaterializer(
            store=store,
            runtime_root=runtime,
        ).read_staging_reports(preparation=preparation)

        assert snapshot == (("orders", report_bytes["reports/orders.json"]),)
    finally:
        store.close()


def test_materializer_publishes_only_after_immutable_root_verification(tmp_path: Path) -> None:
    """Catches a final root that is returned without its bound terminal publication."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    try:
        publication = CanonicalMaterializer(
            store=store,
            runtime_root=runtime,
        ).materialize_and_publish(preparation=preparation)

        assert publication is not None
        assert store.terminal_finalization(run_id=preparation.run_id) == publication
    finally:
        store.close()


def test_verified_publication_requires_the_final_root_reverification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches publication moved before the post-rename root verification."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = CanonicalMaterializer._verify_projection_root

    def reject_final_root(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> None:
        if kwargs["root_name"] == preparation.run_id and kwargs["expected_root_mode"] == 0o500:
            raise MaterializationError("injected final root reverify failure")
        original(materializer, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(CanonicalMaterializer, "_verify_projection_root", reject_final_root)
    try:
        with pytest.raises(MaterializationError, match="final root reverify"):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_final_publication_rechecks_base_file_after_final_verifier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches proof issuance after a verified base file is rewritten under restored modes."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = CanonicalMaterializer._verify_final_publication_bindings
    changed = False

    def rewrite_after_final_verifier(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> None:
        nonlocal changed
        original(materializer, **kwargs)  # type: ignore[arg-type]
        if not changed:
            changed = True
            root = runtime / "runs" / preparation.run_id
            target = root / "request.json"
            root.chmod(0o700)
            target.chmod(0o600)
            payload = target.read_bytes()
            target.write_bytes(b"[" + payload[1:])
            target.chmod(0o400)
            root.chmod(0o500)

    monkeypatch.setattr(
        CanonicalMaterializer,
        "_verify_final_publication_bindings",
        rewrite_after_final_verifier,
    )
    try:
        with pytest.raises(MaterializationError):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_final_publication_rechecks_report_file_after_final_verifier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches proof issuance after a sealed report is rewritten under restored modes."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=1,
        completed=False,
    )
    original = CanonicalMaterializer._verify_final_publication_bindings
    changed = False

    def rewrite_after_final_verifier(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> None:
        nonlocal changed
        original(materializer, **kwargs)  # type: ignore[arg-type]
        if not changed:
            changed = True
            root = runtime / "runs" / preparation.run_id
            reports = root / "reports"
            target = reports / "orders.json"
            root.chmod(0o700)
            reports.chmod(0o700)
            target.chmod(0o600)
            payload = target.read_bytes()
            target.write_bytes(b"[" + payload[1:])
            target.chmod(0o400)
            reports.chmod(0o500)
            root.chmod(0o500)

    monkeypatch.setattr(
        CanonicalMaterializer,
        "_verify_final_publication_bindings",
        rewrite_after_final_verifier,
    )
    try:
        with pytest.raises(MaterializationError):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_locked_publication_proof_is_invalidated_before_flock_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a captured proof publishing after the materializer has released its flock."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore._publish_verified_terminal
    captured: list[object] = []

    def strand_proof(
        _store: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        captured.append(proof)
        raise RuntimeError("pause before verified SQLite publication")

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", strand_proof)
    try:
        with pytest.raises(RuntimeError, match="pause before"):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)
        assert len(captured) == 1
        with pytest.raises(TerminalPublicationConflict):
            original(store, proof=captured[0])  # type: ignore[arg-type]
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_consumed_locked_publication_proof_cannot_be_replayed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a successful verified proof being usable for a second transaction."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore._publish_verified_terminal
    captured: list[object] = []

    def capture_and_publish(
        current: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        captured.append(proof)
        return original(current, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", capture_and_publish)
    try:
        publication = CanonicalMaterializer(
            store=store,
            runtime_root=runtime,
        ).materialize_and_publish(preparation=preparation)

        assert publication is not None
        assert len(captured) == 1
        with pytest.raises(TerminalPublicationConflict):
            original(store, proof=captured[0])  # type: ignore[arg-type]
        assert store.terminal_finalization(run_id=preparation.run_id) == publication
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 1
        )
    finally:
        store.close()


@pytest.mark.parametrize(
    ("field", "replacement"),
    (
        ("run_id", "bt_mutated_proof_identity"),
        ("terminal_state", RunState.FAILED),
        ("terminal_event_seq", 999),
        ("last_audit_seq", 999),
        ("seal_digest", "0" * 64),
    ),
)
def test_locked_proof_rejects_a_mutated_logical_identity_before_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    replacement: object,
) -> None:
    """Catches any mutable logical proof field escaping its locked identity."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore._publish_verified_terminal
    changed = False

    def mutate_then_publish(
        current_store: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        nonlocal changed
        changed = True
        setattr(proof, field, replacement)
        return original(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", mutate_then_publish)
    try:
        with pytest.raises(MaterializationError, match="proof conflicts"):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)

        assert changed is True
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_locked_proof_rejects_a_mutated_issuance_nonce_before_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches replacing the private transport nonce after the authority issued a proof."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore._publish_verified_terminal

    def mutate_nonce_then_publish(
        current_store: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        proof._issuance_nonce = object()  # type: ignore[attr-defined]
        return original(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", mutate_nonce_then_publish)
    try:
        with pytest.raises(MaterializationError, match="proof conflicts"):
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).materialize_and_publish(preparation=preparation)

        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_finalizer_publishes_one_no_spawn_terminal_from_store_authority(tmp_path: Path) -> None:
    """Catches a finalizer that does not drive the verified handoff."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    try:
        publication = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert publication is not None
        assert publication.state is RunState.CANCELLED
        assert store.terminal_finalization(run_id=preparation.run_id) == publication
    finally:
        store.close()


def test_finalizer_converts_hash_matching_unknown_report_field_to_unverified(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches accepting a hash-matching report row outside the closed schema."""

    reports = dict(task7_report_template)
    raw_orders = json.loads(reports["reports/orders.json"])
    raw_orders[0]["unexpected"] = "field"
    reports["reports/orders.json"] = canonical_json_bytes(raw_orders)
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=reports,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert store.run(preparation.run_id).state is RunState.FAILED
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_classifies_a_report_candidate_hash_mismatch_as_reports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches mapping a declared report hash mismatch to STAGING or MATERIALIZATION."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=task7_report_template,
    )
    report_path = runtime / "staging" / preparation.run_id / "reports" / "orders.json"
    original = json.loads(report_path.read_bytes())
    original[0]["filled_qty"] = "0"
    report_path.write_bytes(canonical_json_bytes(original))
    report_path.chmod(0o600)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_publishes_real_task7_reports_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches rejecting a complete reconciled Task 7 evidence set."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=task7_report_template,
    )
    try:
        first = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        second = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(first, TerminalPublication)
        assert second == first
        assert first.state is RunState.COMPLETED
        assert not any(
            event.type == "report.generated" for event in store.events(preparation.run_id)
        )
    finally:
        store.close()


@pytest.mark.parametrize("report_count", range(6))
def test_finalizer_publishes_each_real_task7_natural_failure_prefix_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    report_count: int,
) -> None:
    """Catches rejecting a schema-valid natural-failure prefix before the strong gate."""

    reports = {
        f"reports/{name}.json": task7_report_template[f"reports/{name}.json"]
        for name in _REPORT_NAMES[:report_count]
    }
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=report_count,
        completed=False,
        source_report_bytes=reports,
    )
    try:
        first = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        second = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(first, TerminalPublication)
        assert first.state is RunState.FAILED
        assert second == first
        assert not any(
            event.type == "report.generated" for event in store.events(preparation.run_id)
        )
    finally:
        store.close()


@pytest.mark.parametrize("report_count", range(1, 6))
def test_finalizer_publishes_each_real_task7_supervisor_failure_prefix_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    report_count: int,
) -> None:
    """Catches treating a child-bearing supervisor failure as childless evidence."""

    reports = {
        f"reports/{name}.json": task7_report_template[f"reports/{name}.json"]
        for name in _REPORT_NAMES[:report_count]
    }
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=report_count,
        completed=False,
        supervisor_failure=True,
        source_report_bytes=reports,
    )
    try:
        assert preparation.outcome.outcome.classification == "SUPERVISOR_FAILURE"
        assert preparation.outcome.outcome.child_outcome is not None
        first = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        second = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(first, TerminalPublication)
        assert first.state is RunState.FAILED
        assert second == first
        assert not any(
            event.type == "report.generated" for event in store.events(preparation.run_id)
        )
    finally:
        store.close()


def test_finalizer_publishes_a_childless_supervisor_failure_without_reports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches requiring runner reports for a committed childless failure."""

    store, runtime, preparation = _real_supervisor_failure_preparation(tmp_path, monkeypatch)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, TerminalPublication)
        assert result.state is RunState.FAILED
        assert not (runtime / "runs" / preparation.run_id / "reports").exists()
    finally:
        store.close()


def test_finalizer_converts_a_real_success_missing_one_report_before_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches accepting a success outcome whose five-report evidence is incomplete."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=task7_report_template,
    )
    (runtime / "staging" / preparation.run_id / "reports" / "metrics.json").unlink()
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert store.run(preparation.run_id).state is RunState.FAILED
        assert [event.type for event in store.events(preparation.run_id)].count("run.failed") == 1
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize("mutation", ("fee", "order", "position", "account"))
def test_finalizer_converts_real_task7_economic_mutations_before_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    mutation: str,
) -> None:
    """Catches accepting refreshed-hash report economics that no longer reconcile."""

    reports = {name: json.loads(raw) for name, raw in task7_report_template.items()}
    if mutation == "fee":
        reports["reports/fills.json"][0]["commission"] = "2 USDT"
    elif mutation == "order":
        reports["reports/orders.json"][0]["filled_qty"] = "0"
    elif mutation == "position":
        reports["reports/positions.json"][0]["commissions"] = ["2 USDT"]
    elif mutation == "account":
        account = reports["reports/account.json"][-1]
        account["total"] = str(Decimal(account["total"]) + 1)
        account["free"] = str(Decimal(account["free"]) + 1)
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(mutation)
    source = {name: canonical_json_bytes(value) for name, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "RECONCILIATION"
        assert [event.type for event in store.events(preparation.run_id)].count("run.failed") == 1
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize("mutation", ("metrics", "margin", "account_type", "order_position"))
def test_finalizer_rejects_unbound_task7_cross_report_mutations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    mutation: str,
) -> None:
    """Catches the omitted metrics, margin, account-profile, and order-position gates."""

    reports = {name: json.loads(raw) for name, raw in task7_report_template.items()}
    if mutation == "metrics":
        reports["reports/metrics.json"]["summary"]["orders.inflight"] = "999"
    elif mutation == "margin":
        reports["reports/account.json"][-1]["margins"][0]["initial"] = "999999"
    elif mutation == "account_type":
        reports["reports/account.json"][-1]["account_type"] = "CASH"
    else:
        positions = reports["reports/positions.json"]
        assert len(positions) > 1
        reports["reports/orders.json"][0]["position_id"] = positions[-1]["position_id"]
    source = {name: canonical_json_bytes(value) for name, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == (
            "REPORTS" if mutation == "extra_account_group" else "RECONCILIATION"
        )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize("name", ("orders", "fills", "positions", "account"))
def test_finalizer_rejects_reordered_task7_rows_before_reconciliation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    name: str,
) -> None:
    """Catches accepting a report only because replay can sort its committed rows."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    rows = reports[f"reports/{name}.json"]
    assert len(rows) > 1
    rows[0], rows[1] = rows[1], rows[0]
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_rejects_duplicate_position_primary_key_before_reconciliation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches primary-key checks accidentally using the position sort key."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    positions = reports["reports/positions.json"]
    duplicate = dict(positions[-1])
    duplicate["position_id"] = positions[0]["position_id"]
    duplicate["ts_opened"] = str(int(duplicate["ts_opened"]) + 1)
    positions.append(duplicate)
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_rejects_duplicate_account_economic_row_before_reconciliation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches accepting repeated account evidence with the same economic tie."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    accounts = reports["reports/account.json"]
    accounts.insert(1, dict(accounts[0]))
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "REPORTS"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutation",
    ("foreign_fill_trade", "foreign_position_event_trade", "extra_account_group"),
)
def test_finalizer_rejects_task7_foreign_cross_report_bindings(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    mutation: str,
) -> None:
    """Catches cross-report identities that are valid schema but not committed evidence."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    if mutation == "foreign_fill_trade":
        reports["reports/fills.json"][0]["trade_id"] = "Z-foreign-trade"
    elif mutation == "foreign_position_event_trade":
        reports["reports/positions.json"][0]["events"][0]["trade_id"] = "Z-foreign-trade"
    elif mutation == "extra_account_group":
        reports["reports/metrics.json"]["summary"]["account.OTHER.id"] = "OTHER"
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(mutation)
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == (
            "REPORTS" if mutation == "extra_account_group" else "RECONCILIATION"
        )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutation",
    (
        "fill_side",
        "fill_type",
        "fill_venue_order",
        "filled_order_position_none",
        "order_last_trade",
        "margin_initial",
        "margin_maintenance",
    ),
)
def test_finalizer_rejects_task7_exact_order_fill_and_margin_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    mutation: str,
) -> None:
    """Catches plausible report values that disagree with exact order or catalog authority."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    fill = reports["reports/fills.json"][0]
    position = next(
        row
        for row in reports["reports/positions.json"]
        if row["position_id"] == fill["position_id"]
    )
    event = next(
        row
        for row in position["events"]
        if row["client_order_id"] == fill["client_order_id"] and row["trade_id"] == fill["trade_id"]
    )
    order = next(
        row
        for row in reports["reports/orders.json"]
        if row["client_order_id"] == fill["client_order_id"]
    )
    final_account = reports["reports/account.json"][-1]
    summary = reports["reports/metrics.json"]["summary"]
    if mutation == "fill_side":
        fill["order_side"] = "SELL"
        event["order_side"] = "SELL"
    elif mutation == "fill_type":
        fill["order_type"] = "MARKET"
        event["order_type"] = "MARKET"
    elif mutation == "fill_venue_order":
        fill["venue_order_id"] = "SIM-foreign"
        event["venue_order_id"] = "SIM-foreign"
    elif mutation == "filled_order_position_none":
        order["position_id"] = None
    elif mutation == "order_last_trade":
        order["last_trade_id"] = reports["reports/fills.json"][1]["trade_id"]
    elif mutation == "margin_initial":
        final_account["margins"][0]["initial"] = "1"
    elif mutation == "margin_maintenance":
        final_account["margins"][0]["maintenance"] = "49"
        final_account["locked"] = "49"
        final_account["free"] = "999950.962"
        summary["account.SIM.balance.USDT.locked"] = "49 USDT"
        summary["account.SIM.balance.USDT.free"] = "999950.962 USDT"
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(mutation)
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == (
            "REPORTS" if mutation == "filled_order_position_none" else "RECONCILIATION"
        )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutation",
    (
        "historical_account_balance",
        "historical_account_margin",
        "duplicate_position_event",
        "event_liquidity",
        "opening_order",
        "closing_order",
        "position_events_order",
    ),
)
def test_finalizer_rejects_task7_historical_account_and_position_binding_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
    mutation: str,
) -> None:
    """Catches plausible non-final balances and non-exact position fill bindings."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    accounts = reports["reports/account.json"]
    positions = reports["reports/positions.json"]
    orders = reports["reports/orders.json"]
    if mutation == "historical_account_balance":
        historical = accounts[-2]
        historical["free"] = str(Decimal(historical["free"]) + Decimal("1"))
    elif mutation == "historical_account_margin":
        historical = next(row for row in accounts[:-1] if row["margins"])
        historical["margins"][0]["initial"] = str(
            Decimal(historical["margins"][0]["initial"]) + Decimal("1")
        )
    elif mutation == "duplicate_position_event":
        position = next(row for row in positions if row["events"])
        event = dict(position["events"][0])
        position["events"].append(event)
        position["trade_ids"].append(event["trade_id"])
        position["venue_order_ids"].append(event["venue_order_id"])
    elif mutation == "event_liquidity":
        position = next(row for row in positions if row["events"])
        event = position["events"][0]
        event["liquidity_side"] = "TAKER" if event["liquidity_side"] != "TAKER" else "MAKER"
    elif mutation == "opening_order":
        position = next(row for row in positions if row["events"])
        event_order_ids = {event["client_order_id"] for event in position["events"]}
        position["opening_order_id"] = next(
            row["client_order_id"]
            for row in orders
            if row["client_order_id"] not in event_order_ids
        )
    elif mutation == "closing_order":
        position = next(row for row in positions if row["ts_closed"] is not None)
        event_order_ids = {event["client_order_id"] for event in position["events"]}
        position["closing_order_id"] = next(
            row["client_order_id"]
            for row in orders
            if row["client_order_id"] not in event_order_ids
        )
    elif mutation == "position_events_order":
        position = next(row for row in positions if len(row["events"]) > 1)
        position["events"].reverse()
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(mutation)
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "RECONCILIATION"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_derives_emulated_orders_from_status_not_stale_trigger_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches treating a closed order's retained trigger metadata as an emulated state."""

    reports = {path: json.loads(raw) for path, raw in task7_report_template.items()}
    reports["reports/orders.json"][0]["emulation_trigger"] = "DEFAULT"
    source = {path: canonical_json_bytes(value) for path, value in reports.items()}
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=source,
    )
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, TerminalPublication)
        assert result.state is RunState.COMPLETED
        assert store.terminal_finalization(run_id=preparation.run_id) == result
    finally:
        store.close()


def test_finalizer_converts_a_replay_normalization_failure_before_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    task7_report_template: dict[str, bytes],
) -> None:
    """Catches allowing a replay normalization failure to reach materialization."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
        source_report_bytes=task7_report_template,
    )

    def fail_replay(_value: object) -> str:
        raise ReplaySchemaError("injected replay normalization failure")

    monkeypatch.setattr("stark_trading_os.control.finalizer.replay_digest_v1", fail_replay)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "RECONCILIATION"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_finalizer_records_one_operational_attempt_per_call_before_conversion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a retry loop that consumes more than one durable attempt per call."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)

    def fail_snapshot(
        _materializer: CanonicalMaterializer,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        raise MaterializationError(
            "injected bounded staging I/O failure",
            deterministic=False,
            stage="STAGING",
        )

    monkeypatch.setattr(CanonicalMaterializer, "read_staging_reports", fail_snapshot)
    finalizer = Finalizer(store=store, runtime_root=runtime)
    try:
        with pytest.raises(FinalizationRetryPending) as first:
            finalizer.finalize(preparation.run_id)
        assert first.value.attempt == 1
        assert store.run(preparation.run_id).state is RunState.FINALIZING
        with pytest.raises(FinalizationRetryPending) as second:
            finalizer.finalize(preparation.run_id)
        assert second.value.attempt == 2
        converted = finalizer.finalize(preparation.run_id)
        assert isinstance(converted, UnverifiedTerminalPublication)
        assert converted.fault.category == "OPERATIONAL_RETRY_EXHAUSTED"
        assert converted.fault.stage == "STAGING"
        assert finalizer.finalize(preparation.run_id) == converted
    finally:
        store.close()


@pytest.mark.parametrize("crash", (KeyboardInterrupt, SystemExit))
def test_finalizer_never_records_process_boundary_crashes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    crash: type[BaseException],
) -> None:
    """Catches treating process-boundary exits as retryable evidence failures."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)

    def crash_snapshot(
        _materializer: CanonicalMaterializer,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        raise crash()

    monkeypatch.setattr(CanonicalMaterializer, "read_staging_reports", crash_snapshot)
    try:
        with pytest.raises(crash):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_finalizer_classifies_non_report_staging_inventory_as_staging(
    tmp_path: Path,
) -> None:
    """Catches mapping a closed staging-root mismatch to MATERIALIZATION."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    (runtime / "staging" / preparation.run_id / "stderr.txt").unlink()
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "STAGING"
    finally:
        store.close()


def test_materializer_rejects_audit_timestamp_not_bound_to_its_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore.audit_intents

    def drifted_audits(control: ControlStore, run_id: str) -> tuple[AuditIntent, ...]:
        audits = original(control, run_id)
        return (replace(audits[0], created_at_ns=audits[0].created_at_ns + 1), *audits[1:])

    monkeypatch.setattr(ControlStore, "audit_intents", drifted_audits)
    try:
        with pytest.raises(MaterializationError, match="audit intent"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


def test_materializer_rejects_a_committed_terminal_event_before_the_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_events = ControlStore.events
    original_audits = ControlStore.audit_intents
    committed = original_events(store, preparation.run_id)
    event_value = parse_json_object(committed[0].envelope_bytes)
    event_value["type"] = "run.completed"
    terminal_bytes = canonical_json_bytes(event_value)
    terminal_digest = sha256(terminal_bytes).hexdigest()
    terminal_event = replace(
        committed[0],
        type="run.completed",
        envelope_bytes=terminal_bytes,
    )

    def terminal_events(control: ControlStore, run_id: str) -> tuple[PersistedEvent, ...]:
        events = original_events(control, run_id)
        return (terminal_event, *events[1:])

    def rebound_audits(control: ControlStore, run_id: str) -> tuple[AuditIntent, ...]:
        audits = original_audits(control, run_id)
        first = replace(
            audits[0],
            event_digest=terminal_digest,
            intent_bytes=canonical_json_bytes(
                {
                    "seq": audits[0].audit_seq,
                    "run_id": audits[0].run_id,
                    "event_seq": audits[0].event_seq,
                    "event_digest": terminal_digest,
                }
            ),
        )
        return (first, *audits[1:])

    monkeypatch.setattr(ControlStore, "events", terminal_events)
    monkeypatch.setattr(ControlStore, "audit_intents", rebound_audits)
    try:
        with pytest.raises(MaterializationError, match="terminal event"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


def test_materializer_accepts_a_normal_partial_retry_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore.run

    def partial_run(control: ControlStore, run_id: str) -> RunSnapshot:
        return replace(original(control, run_id), evidence_status="PARTIAL")

    monkeypatch.setattr(ControlStore, "run", partial_run)
    try:
        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )
        assert result.run_id == preparation.run_id
    finally:
        store.close()


def test_materializer_rejects_a_preflight_lookup_identity_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original = ControlStore.preflight

    def drifted_preflight(
        control: ControlStore,
        preflight_id: str,
    ) -> PreflightSnapshot | None:
        snapshot = original(control, preflight_id)
        assert snapshot is not None
        return replace(snapshot, preflight_id="pf_drifted")

    monkeypatch.setattr(ControlStore, "preflight", drifted_preflight)
    try:
        with pytest.raises(MaterializationError, match="SQLite authority"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("authority", ("events", "audits"))
def test_materializer_rejects_a_global_committed_sequence_gap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    authority: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    if authority == "events":
        original_events = ControlStore.events

        def gapped_events(control: ControlStore, run_id: str) -> tuple[PersistedEvent, ...]:
            return original_events(control, run_id)[1:]

        monkeypatch.setattr(ControlStore, "events", gapped_events)
    else:
        original_audits = ControlStore.audit_intents

        def gapped_audits(control: ControlStore, run_id: str) -> tuple[AuditIntent, ...]:
            return original_audits(control, run_id)[1:]

        monkeypatch.setattr(ControlStore, "audit_intents", gapped_audits)
    try:
        with pytest.raises(MaterializationError, match="boundary is not contiguous"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("authority", ("events", "audits"))
def test_materializer_rejects_a_duplicate_committed_sequence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    authority: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    if authority == "events":
        original_events = ControlStore.events

        def duplicate_events(
            control: ControlStore,
            run_id: str,
        ) -> tuple[PersistedEvent, ...]:
            events = list(original_events(control, run_id))
            events[1] = events[0]
            return tuple(events)

        monkeypatch.setattr(ControlStore, "events", duplicate_events)
    else:
        original_audits = ControlStore.audit_intents

        def duplicate_audits(
            control: ControlStore,
            run_id: str,
        ) -> tuple[AuditIntent, ...]:
            audits = list(original_audits(control, run_id))
            audits[1] = audits[0]
            return tuple(audits)

        monkeypatch.setattr(ControlStore, "audit_intents", duplicate_audits)
    try:
        with pytest.raises(MaterializationError):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("authority", ("event", "audit"))
def test_materializer_rejects_a_wrong_run_link(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    authority: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    if authority == "event":
        original_events = ControlStore.events

        def wrong_run_events(
            control: ControlStore,
            run_id: str,
        ) -> tuple[PersistedEvent, ...]:
            events = list(original_events(control, run_id))
            value = parse_json_object(events[0].envelope_bytes)
            value["run_id"] = "bt_other"
            events[0] = replace(
                events[0],
                run_id="bt_other",
                envelope_bytes=canonical_json_bytes(value),
            )
            return tuple(events)

        monkeypatch.setattr(ControlStore, "events", wrong_run_events)
    else:
        original_audits = ControlStore.audit_intents

        def wrong_run_audits(
            control: ControlStore,
            run_id: str,
        ) -> tuple[AuditIntent, ...]:
            audits = list(original_audits(control, run_id))
            audits[0] = replace(
                audits[0],
                run_id="bt_other",
                intent_bytes=canonical_json_bytes(
                    {
                        "seq": audits[0].audit_seq,
                        "run_id": "bt_other",
                        "event_seq": audits[0].event_seq,
                        "event_digest": audits[0].event_digest,
                    }
                ),
            )
            return tuple(audits)

        monkeypatch.setattr(ControlStore, "audit_intents", wrong_run_audits)
    try:
        with pytest.raises(MaterializationError):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


def test_materializer_rejects_a_control_source_sequence_gap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_events = ControlStore.events

    def gapped_events(control: ControlStore, run_id: str) -> tuple[PersistedEvent, ...]:
        events = list(original_events(control, run_id))
        value = parse_json_object(events[0].envelope_bytes)
        value["source_seq"] = 2
        events[0] = replace(
            events[0],
            source_seq=2,
            envelope_bytes=canonical_json_bytes(value),
        )
        return tuple(events)

    monkeypatch.setattr(ControlStore, "events", gapped_events)
    try:
        with pytest.raises(MaterializationError, match="control source sequence"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


def test_materializer_rejects_noncanonical_committed_event_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_events = ControlStore.events

    def noncanonical_events(
        control: ControlStore,
        run_id: str,
    ) -> tuple[PersistedEvent, ...]:
        events = list(original_events(control, run_id))
        events[0] = replace(events[0], envelope_bytes=events[0].envelope_bytes + b" ")
        return tuple(events)

    monkeypatch.setattr(ControlStore, "events", noncanonical_events)
    try:
        with pytest.raises(MaterializationError, match="stored event"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("attack", ("event-digest", "chain-link"))
def test_materializer_rejects_wrong_audit_digest_or_chain_link(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    if attack == "event-digest":
        original_audits = ControlStore.audit_intents

        def wrong_digest_audits(
            control: ControlStore,
            run_id: str,
        ) -> tuple[AuditIntent, ...]:
            audits = list(original_audits(control, run_id))
            wrong_digest = "f" * 64
            audits[0] = replace(
                audits[0],
                event_digest=wrong_digest,
                intent_bytes=canonical_json_bytes(
                    {
                        "seq": audits[0].audit_seq,
                        "run_id": audits[0].run_id,
                        "event_seq": audits[0].event_seq,
                        "event_digest": wrong_digest,
                    }
                ),
            )
            return tuple(audits)

        monkeypatch.setattr(ControlStore, "audit_intents", wrong_digest_audits)
    else:
        original_chain = materializer_module.append_hash_chain

        def wrong_chain_link(
            entries: list[dict[str, object]],
        ) -> list[dict[str, object]]:
            chained = original_chain(entries)
            chained[1]["prev_hash"] = "f" * 64
            return chained

        monkeypatch.setattr(materializer_module, "append_hash_chain", wrong_chain_link)
    try:
        with pytest.raises(MaterializationError, match="audit"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("drift", ("converted", "during-build"))
def test_materializer_rejects_converted_or_drifted_terminal_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    drift: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    if drift == "converted":
        changed = replace(preparation, disposition="FAULT_CONVERTED")
        monkeypatch.setattr(
            ControlStore,
            "terminal_preparation",
            lambda _control, *, run_id: changed,
        )
        supplied = changed
        expected_error = "only a NORMAL"
    else:
        reads = 0

        def drift_after_authoritative_read(
            _control: ControlStore,
            *,
            run_id: str,
        ) -> TerminalPreparation:
            nonlocal reads
            reads += 1
            if reads == 1:
                return preparation
            return replace(preparation, failure_attempt_count=1)

        monkeypatch.setattr(
            ControlStore,
            "terminal_preparation",
            drift_after_authoritative_read,
        )
        supplied = preparation
        expected_error = "drifted during materialization"
    try:
        with pytest.raises(MaterializationError, match=expected_error):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=supplied
            )
    finally:
        store.close()


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("run_id", "bt_other"),
        ("input_manifest_hash", "b" * 64),
        ("catalog_revision", "b" * 64),
    ),
)
def test_materializer_rejects_child_outcome_identity_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str,
) -> None:
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=1,
        completed=False,
    )
    child = preparation.outcome.outcome.child_outcome
    assert child is not None
    changed_child = child.model_copy(update={field: value})
    changed_exit = preparation.outcome.outcome.model_copy(update={"child_outcome": changed_child})
    changed_outcome = preparation.outcome.model_copy(update={"outcome": changed_exit})
    changed = replace(preparation, outcome=changed_outcome)
    monkeypatch.setattr(
        ControlStore,
        "terminal_preparation",
        lambda _control, *, run_id: changed,
    )
    try:
        with pytest.raises(MaterializationError, match="SQLite authority"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=changed
            )
    finally:
        store.close()


def test_materializer_rejects_a_prepared_terminal_type_that_differs_from_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    event_value = parse_json_object(preparation.event.envelope_bytes)
    event_value["type"] = "run.failed"
    event_bytes = canonical_json_bytes(event_value)
    event_digest = sha256(event_bytes).hexdigest()
    event = replace(
        preparation.event,
        type="run.failed",
        envelope_bytes=event_bytes,
    )
    audit = replace(
        preparation.audit_intent,
        event_digest=event_digest,
        intent_bytes=canonical_json_bytes(
            {
                "seq": preparation.audit_intent.audit_seq,
                "run_id": preparation.run_id,
                "event_seq": event.seq,
                "event_digest": event_digest,
            }
        ),
    )
    changed = replace(
        preparation,
        event=event,
        audit_intent=audit,
        initial_event_digest=event_digest,
    )
    monkeypatch.setattr(
        ControlStore,
        "terminal_preparation",
        lambda _control, *, run_id: changed,
    )
    try:
        with pytest.raises(MaterializationError, match="terminal event type"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=changed
            )
    finally:
        store.close()


def test_materializer_rejects_a_planned_run_record_that_drifted_from_authority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    changed_record = preparation.run_record.model_copy(update={"evidence_status": "STAGING"})
    changed = replace(preparation, run_record=changed_record)
    monkeypatch.setattr(
        ControlStore,
        "terminal_preparation",
        lambda _control, *, run_id: changed,
    )
    try:
        with pytest.raises(MaterializationError, match="planned RunRecord"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=changed
            )
    finally:
        store.close()


def test_materializer_accepts_a_frozen_nonempty_runner_prefix_without_child_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_supervisor_failure_preparation(
        tmp_path,
        monkeypatch,
    )
    try:
        assert preparation.outcome.outcome.classification == "SUPERVISOR_FAILURE"
        assert preparation.outcome.outcome.child_outcome is None
        runner_events = [
            event for event in store.events(preparation.run_id) if event.source == "runner"
        ]
        assert [event.source_seq for event in runner_events] == [1]

        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )
        assert result.terminal_state is RunState.FAILED
    finally:
        store.close()


def test_materializer_rejects_a_runner_gap_without_child_outcome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_supervisor_failure_preparation(
        tmp_path,
        monkeypatch,
    )
    original_events = ControlStore.events

    def gapped_events(control: ControlStore, run_id: str) -> tuple[PersistedEvent, ...]:
        events = list(original_events(control, run_id))
        index = next(i for i, event in enumerate(events) if event.source == "runner")
        value = parse_json_object(events[index].envelope_bytes)
        value["source_seq"] = 2
        events[index] = replace(
            events[index],
            source_seq=2,
            envelope_bytes=canonical_json_bytes(value),
        )
        return tuple(events)

    monkeypatch.setattr(ControlStore, "events", gapped_events)
    try:
        with pytest.raises(MaterializationError, match="runner source sequence"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("report_count", range(6))
def test_materializer_accepts_every_failed_fixed_report_prefix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    report_count: int,
) -> None:
    store, runtime, preparation, report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=report_count,
        completed=False,
    )
    try:
        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )

        assert result.terminal_state is RunState.FAILED
        final_root = runtime / "runs" / preparation.run_id
        seal = parse_json_object(result.seal_bytes)
        sealed_paths = tuple(item["relative_path"] for item in seal["files"])
        expected_reports = tuple(f"reports/{name}.json" for name in _REPORT_NAMES[:report_count])
        assert tuple(path for path in sealed_paths if path.startswith("reports/")) == tuple(
            sorted(expected_reports)
        )
        if report_count:
            reports = final_root / "reports"
            assert stat.S_IMODE(reports.stat().st_mode) == 0o500
            assert {path.name for path in reports.iterdir()} == {
                Path(path).name for path in expected_reports
            }
            for relative_path in expected_reports:
                report = final_root / relative_path
                assert report.read_bytes() == report_bytes[relative_path]
                assert stat.S_IMODE(report.stat().st_mode) == 0o400
        else:
            assert not (final_root / "reports").exists()
    finally:
        store.close()


def test_materializer_accepts_a_completed_run_with_exactly_five_reports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation, report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=5,
        completed=True,
    )
    try:
        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )

        assert result.terminal_state is RunState.COMPLETED
        final_root = runtime / "runs" / preparation.run_id
        assert {
            str(path.relative_to(final_root)) for path in (final_root / "reports").iterdir()
        } == set(report_bytes)
    finally:
        store.close()


@pytest.mark.parametrize(
    "attack",
    ("missing", "same-size-hash", "extra", "symlink", "hardlink", "fifo"),
)
def test_materializer_rejects_report_prefix_staging_attacks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=3,
        completed=False,
    )
    reports = runtime / "staging" / preparation.run_id / "reports"
    report = reports / "fills.json"
    try:
        if attack == "missing":
            report.unlink()
        elif attack == "same-size-hash":
            raw = report.read_bytes()
            report.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
            report.chmod(0o600)
        elif attack == "extra":
            extra = reports / "unexpected.json"
            extra.write_bytes(b"{}")
            extra.chmod(0o600)
        elif attack == "symlink":
            external = tmp_path / "external-report.json"
            external.write_bytes(report.read_bytes())
            external.chmod(0o600)
            report.unlink()
            report.symlink_to(external)
        elif attack == "hardlink":
            external = tmp_path / "linked-report.json"
            external.write_bytes(report.read_bytes())
            external.chmod(0o600)
            report.unlink()
            report.hardlink_to(external)
        elif attack == "fifo":
            report.unlink()
            os.mkfifo(report, mode=0o600)
        else:  # pragma: no cover - the closed parameter list owns this branch.
            raise AssertionError(attack)

        with pytest.raises(MaterializationError):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_materializer_uses_the_effective_service_uid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    monkeypatch.setattr(os, "getuid", lambda: os.geteuid() + 1)
    try:
        result = CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
            preparation=preparation
        )
        assert result.run_id == preparation.run_id
    finally:
        store.close()


def test_materializer_rejects_a_symlinked_runtime_root_ancestor(tmp_path: Path) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path / "real")
    alias = tmp_path / "runtime-alias"
    alias.symlink_to(runtime.parent, target_is_directory=True)
    try:
        with pytest.raises(MaterializationError, match="runtime_root ancestry"):
            CanonicalMaterializer(
                store=store,
                runtime_root=alias / runtime.name,
            ).build_verify_and_rename(preparation=preparation)
    finally:
        store.close()


def test_configured_directory_open_closes_the_child_if_parent_close_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    original_open = os.open
    original_close = os.close
    opened: list[int] = []
    closed: list[int] = []
    failed_parent: int | None = None

    def tracking_open(*args: object, **kwargs: object) -> int:
        descriptor = original_open(*args, **kwargs)
        opened.append(descriptor)
        return descriptor

    def fail_first_parent_close(descriptor: int) -> None:
        nonlocal failed_parent
        if failed_parent is None and len(opened) >= 2 and descriptor == opened[-2]:
            failed_parent = descriptor
            raise OSError("injected parent close failure")
        closed.append(descriptor)
        original_close(descriptor)

    monkeypatch.setattr(os, "open", tracking_open)
    monkeypatch.setattr(os, "close", fail_first_parent_close)
    try:
        with pytest.raises(MaterializationError, match="descriptor-safe"):
            materializer_module._open_configured_directory(
                runtime,
                expected_mode=0o700,
                expected_uid=os.geteuid(),
            )
        assert failed_parent is not None
        assert opened[-1] in closed
    finally:
        if failed_parent is not None:
            original_close(failed_parent)


def test_missing_or_replaced_evidence_paths_are_deterministic_not_operational(
    tmp_path: Path,
) -> None:
    """Catches laundering an observed missing pathname into an I/O retry."""

    parent_fd = os.open(tmp_path, materializer_module._DIRECTORY_FLAGS)
    retained_fd = -1
    evidence = tmp_path / "retained.json"
    evidence.write_bytes(b"sealed")
    try:
        with pytest.raises(MaterializationError, match="regular file") as missing:
            materializer_module._read_regular_file(
                parent_fd,
                "vanished.json",
                expected_uid=os.geteuid(),
                expected_mode=0o600,
                expected_size=0,
                expected_hash=sha256(b"").hexdigest(),
                expected_bytes=b"",
            )
        assert missing.value.deterministic is True

        retained_fd = os.open("retained.json", materializer_module._READ_FLAGS, dir_fd=parent_fd)
        os.unlink("retained.json", dir_fd=parent_fd)
        with pytest.raises(MaterializationError, match="retained evidence") as replaced:
            materializer_module._require_fd_name_identity(
                retained_fd,
                parent_fd,
                "retained.json",
                label="retained evidence",
            )
        assert replaced.value.deterministic is True
    finally:
        if retained_fd >= 0:
            os.close(retained_fd)
        os.close(parent_fd)


def test_materializer_binds_the_lock_pathname_to_the_flocked_inode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_flock = fcntl.flock
    exchanged = False

    def exchange_lock(descriptor: int, operation: int) -> None:
        nonlocal exchanged
        original_flock(descriptor, operation)
        if operation == fcntl.LOCK_EX and not exchanged:
            exchanged = True
            lock_path = runtime / ".run-publish.lock"
            lock_path.rename(runtime / ".run-publish.lock-held")
            lock_path.write_bytes(b"")
            lock_path.chmod(0o600)

    monkeypatch.setattr(fcntl, "flock", exchange_lock)
    try:
        with pytest.raises(MaterializationError, match="lock pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize("attack", ("fifo", "symlink", "hardlink", "wrong-mode"))
def test_materializer_rejects_unsafe_existing_publish_locks_without_blocking(
    tmp_path: Path,
    attack: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    lock_path = runtime / ".run-publish.lock"
    try:
        if attack == "fifo":
            os.mkfifo(lock_path, mode=0o600)
        elif attack == "symlink":
            external = tmp_path / "external-lock"
            external.write_bytes(b"")
            external.chmod(0o600)
            lock_path.symlink_to(external)
        elif attack == "hardlink":
            lock_path.write_bytes(b"")
            lock_path.chmod(0o600)
            (tmp_path / "second-lock-name").hardlink_to(lock_path)
        elif attack == "wrong-mode":
            lock_path.write_bytes(b"")
            lock_path.chmod(0o640)
        else:  # pragma: no cover - the closed parameter list owns this branch.
            raise AssertionError(attack)

        with pytest.raises(MaterializationError, match="lock pathname|metadata"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize(
    "exchange_point",
    ("before-rename", "after-rename", "after-final-reverify"),
)
def test_materializer_binds_the_retained_runtime_fd_to_the_configured_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    exchange_point: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    held_runtime = runtime.with_name("runtime-held")
    exchanged = False

    def exchange_runtime() -> None:
        nonlocal exchanged
        if exchanged:
            return
        exchanged = True
        runtime.rename(held_runtime)
        runtime.mkdir(mode=0o700)

    if exchange_point == "before-rename":
        original_flock = fcntl.flock

        def exchange_before_rename(descriptor: int, operation: int) -> None:
            original_flock(descriptor, operation)
            if operation == fcntl.LOCK_EX:
                exchange_runtime()

        monkeypatch.setattr(fcntl, "flock", exchange_before_rename)
    elif exchange_point == "after-rename":
        original_rename = materializer_module._darwin_rename_no_replace

        def exchange_after_rename(
            source_parent_fd: int,
            source_name: str,
            destination_parent_fd: int,
            destination_name: str,
        ) -> None:
            original_rename(
                source_parent_fd,
                source_name,
                destination_parent_fd,
                destination_name,
            )
            exchange_runtime()

        monkeypatch.setattr(
            materializer_module,
            "_darwin_rename_no_replace",
            exchange_after_rename,
        )
    elif exchange_point == "after-final-reverify":
        original_verify = CanonicalMaterializer._verify_projection_root
        verify_calls = 0

        def exchange_after_final_reverify(
            materializer: CanonicalMaterializer,
            **kwargs: object,
        ) -> None:
            nonlocal verify_calls
            verify_calls += 1
            original_verify(materializer, **kwargs)
            if verify_calls == 3:
                exchange_runtime()

        monkeypatch.setattr(
            CanonicalMaterializer,
            "_verify_projection_root",
            exchange_after_final_reverify,
        )
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(exchange_point)

    try:
        with pytest.raises(MaterializationError, match="runtime_root pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert exchanged is True
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


@pytest.mark.parametrize("parent_name", (".materializing", "runs"))
def test_materializer_binds_retained_parent_fds_to_configured_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    parent_name: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_flock = fcntl.flock
    exchanged = False

    def exchange_parent(descriptor: int, operation: int) -> None:
        nonlocal exchanged
        original_flock(descriptor, operation)
        if operation == fcntl.LOCK_EX and not exchanged:
            exchanged = True
            original_path = runtime / parent_name
            original_path.rename(runtime / f"{parent_name}-held")
            original_path.mkdir(mode=0o700)

    monkeypatch.setattr(fcntl, "flock", exchange_parent)
    try:
        with pytest.raises(MaterializationError, match="parent pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert not (runtime / "runs" / preparation.run_id).exists()
        assert not (runtime / "runs-held" / preparation.run_id).exists()
    finally:
        store.close()


def test_materializer_binds_the_source_name_to_the_retained_root_fd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_flock = fcntl.flock
    exchanged = False

    def exchange_source(descriptor: int, operation: int) -> None:
        nonlocal exchanged
        original_flock(descriptor, operation)
        if operation == fcntl.LOCK_EX and not exchanged:
            exchanged = True
            materializing = runtime / ".materializing"
            temp_root = next(materializing.iterdir())
            temp_root.rename(materializing / f"{temp_root.name}-held")
            temp_root.mkdir(mode=0o700)

    monkeypatch.setattr(fcntl, "flock", exchange_source)
    try:
        with pytest.raises(MaterializationError, match="source root pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_materializer_binds_the_destination_name_to_the_retained_root_fd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_rename = materializer_module._darwin_rename_no_replace

    def exchange_destination(
        source_parent_fd: int,
        source_name: str,
        destination_parent_fd: int,
        destination_name: str,
    ) -> None:
        original_rename(
            source_parent_fd,
            source_name,
            destination_parent_fd,
            destination_name,
        )
        os.rename(
            destination_name,
            f"{destination_name}-held",
            src_dir_fd=destination_parent_fd,
            dst_dir_fd=destination_parent_fd,
        )
        os.mkdir(destination_name, mode=0o700, dir_fd=destination_parent_fd)

    monkeypatch.setattr(materializer_module, "_darwin_rename_no_replace", exchange_destination)
    try:
        with pytest.raises(MaterializationError, match="destination root pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


def test_materializer_rebinds_the_destination_after_final_reverify(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_verify = CanonicalMaterializer._verify_projection_root
    verify_calls = 0
    exchanged = False

    def exchange_after_final_reverify(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> None:
        nonlocal exchanged, verify_calls
        verify_calls += 1
        original_verify(materializer, **kwargs)
        if verify_calls == 3:
            exchanged = True
            final_root = runtime / "runs" / preparation.run_id
            final_root.rename(final_root.with_name(f"{preparation.run_id}-verified-held"))
            final_root.mkdir(mode=0o500)

    monkeypatch.setattr(
        CanonicalMaterializer,
        "_verify_projection_root",
        exchange_after_final_reverify,
    )
    try:
        with pytest.raises(MaterializationError, match="destination root pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert exchanged is True
        assert list((runtime / "runs" / preparation.run_id).iterdir()) == []
    finally:
        store.close()


def test_materializer_rebinds_the_lock_after_final_reverify(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_verify = CanonicalMaterializer._verify_projection_root
    verify_calls = 0
    exchanged = False

    def exchange_lock_after_final_reverify(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> None:
        nonlocal exchanged, verify_calls
        verify_calls += 1
        original_verify(materializer, **kwargs)
        if verify_calls == 3:
            exchanged = True
            lock_path = runtime / ".run-publish.lock"
            lock_path.rename(runtime / ".run-publish.lock-verified-held")
            lock_path.write_bytes(b"")
            lock_path.chmod(0o600)

    monkeypatch.setattr(
        CanonicalMaterializer,
        "_verify_projection_root",
        exchange_lock_after_final_reverify,
    )
    try:
        with pytest.raises(MaterializationError, match="lock pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert exchanged is True
    finally:
        store.close()


@pytest.mark.parametrize("replacement", ("root", "lock"))
def test_publish_rebinds_root_and_lock_after_receipt_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    replacement: str,
) -> None:
    """Catches a receipt handoff that publishes after its path binding changed."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_verify = CanonicalMaterializer._verify_projection_root
    changed = False

    def replace_after_receipt(
        materializer: CanonicalMaterializer,
        **kwargs: object,
    ) -> object:
        nonlocal changed
        receipt = original_verify(materializer, **kwargs)  # type: ignore[arg-type]
        if kwargs.get("publication_lock_fd") is not None:
            changed = True
            if replacement == "root":
                final_root = runtime / "runs" / preparation.run_id
                final_root.rename(final_root.with_name(f"{preparation.run_id}-receipt-held"))
                final_root.mkdir(mode=0o500)
            else:
                lock_path = runtime / ".run-publish.lock"
                lock_path.rename(runtime / ".run-publish.lock-receipt-held")
                lock_path.write_bytes(b"")
                lock_path.chmod(0o600)
        return receipt

    monkeypatch.setattr(
        CanonicalMaterializer,
        "_verify_projection_root",
        replace_after_receipt,
    )
    try:
        with pytest.raises(MaterializationError, match="destination root pathname|lock pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        assert changed is True
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


@pytest.mark.parametrize("target_name", ("request.json", "reports/orders.json"))
def test_publish_rechecks_retained_files_inside_the_real_publisher(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    target_name: str,
) -> None:
    """Catches a post-receipt file rewrite before the one-use proof is consumed."""

    store, runtime, preparation, _report_bytes = _real_report_preparation(
        tmp_path,
        monkeypatch,
        report_count=1 if target_name.startswith("reports/") else 0,
        completed=False,
    )
    original_publish = ControlStore._publish_verified_terminal
    changed = False

    def rewrite_before_consumption(
        current_store: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        nonlocal changed
        changed = True
        root = runtime / "runs" / preparation.run_id
        target = root / target_name
        parent = target.parent
        root.chmod(0o700)
        if parent != root:
            parent.chmod(0o700)
        target.chmod(0o600)
        payload = target.read_bytes()
        target.write_bytes(b"[" + payload[1:])
        target.chmod(0o400)
        if parent != root:
            parent.chmod(0o500)
        root.chmod(0o500)
        return original_publish(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", rewrite_before_consumption)
    try:
        with pytest.raises(MaterializationError):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        assert changed is True
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_publish_rebinds_configured_runtime_after_receipt_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches publication from a retained but no-longer-configured runtime root."""

    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_publish = ControlStore._publish_verified_terminal
    held_runtime = runtime.with_name("runtime-receipt-held")
    changed = False

    def replace_runtime_before_consumption(
        current_store: ControlStore,
        *,
        proof: object,
    ) -> TerminalPublication:
        nonlocal changed
        changed = True
        runtime.rename(held_runtime)
        runtime.mkdir(mode=0o700)
        return original_publish(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(
        ControlStore,
        "_publish_verified_terminal",
        replace_runtime_before_consumption,
    )
    try:
        with pytest.raises(MaterializationError, match="runtime_root pathname"):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        assert changed is True
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_materializer_is_byte_identical_for_identical_isolated_authority(
    tmp_path: Path,
) -> None:
    projections: list[dict[str, bytes]] = []
    digests: list[str] = []
    for name in ("first", "second"):
        store, runtime, preparation = _real_no_spawn_preparation(tmp_path / name)
        try:
            result = CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).build_verify_and_rename(preparation=preparation)
            root = runtime / "runs" / preparation.run_id
            projections.append(
                {
                    str(path.relative_to(root)): path.read_bytes()
                    for path in root.rglob("*")
                    if path.is_file()
                }
            )
            digests.append(result.seal_digest)
        finally:
            store.close()

    assert projections[0] == projections[1]
    assert digests[0] == digests[1]


def test_verified_artifact_batch_reads_one_root_in_caller_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        root = runtime / "runs" / preparation.run_id
        opened: list[str] = []
        original_open = CanonicalMaterializer._open_locked_final_root

        def count_open(current: CanonicalMaterializer, run_id: str) -> object:
            opened.append(run_id)
            return original_open(current, run_id)

        monkeypatch.setattr(CanonicalMaterializer, "_open_locked_final_root", count_open)

        observed = materializer.read_verified_artifacts(
            publication=publication,
            relative_paths=("events.ndjson", "missing.json", "run-record.json"),
        )

        assert observed == (
            (root / "events.ndjson").read_bytes(),
            None,
            (root / "run-record.json").read_bytes(),
        )
        assert opened == [preparation.run_id]
    finally:
        store.close()


def test_verified_artifact_batch_rejects_malformed_or_duplicate_paths(
    tmp_path: Path,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)

        with pytest.raises(TypeError):
            materializer.read_verified_artifacts(  # type: ignore[arg-type]
                publication=publication,
                relative_paths=["run-record.json"],
            )
        for invalid in (
            (),
            ("",),
            ("/run-record.json",),
            ("./run-record.json",),
            ("reports//metrics.json",),
            ("reports/../metrics.json",),
            ("reports\\metrics.json",),
            ("reports/metrics.json\0",),
            ("run-record.json", "run-record.json"),
        ):
            with pytest.raises(ValueError):
                materializer.read_verified_artifacts(
                    publication=publication,
                    relative_paths=invalid,
                )
    finally:
        store.close()


def test_verified_artifact_batch_detects_authority_and_root_drift(tmp_path: Path) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        changed_publication = replace(
            publication,
            published_at_ns=publication.published_at_ns + 1,
        )
        with pytest.raises(MaterializationError, match="authority changed"):
            materializer.read_verified_artifacts(
                publication=changed_publication,
                relative_paths=("run-record.json",),
            )

        root = runtime / "runs" / preparation.run_id
        record = root / "run-record.json"
        root.chmod(0o700)
        record.chmod(0o600)
        payload = record.read_bytes()
        record.write_bytes(b"X" + payload[1:])
        record.chmod(0o400)
        root.chmod(0o500)
        with pytest.raises(MaterializationError):
            materializer.read_verified_artifacts(
                publication=publication,
                relative_paths=("run-record.json",),
            )
    finally:
        store.close()


def test_single_verified_artifact_reader_delegates_to_batch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        observed: list[tuple[TerminalPublication, tuple[str, ...]]] = []

        def read_batch(
            *,
            publication: TerminalPublication,
            relative_paths: tuple[str, ...],
        ) -> tuple[bytes | None, ...]:
            observed.append((publication, relative_paths))
            return (b"delegated",)

        monkeypatch.setattr(materializer, "read_verified_artifacts", read_batch)

        assert (
            materializer.read_verified_artifact(
                publication=publication,
                relative_path="run-record.json",
            )
            == b"delegated"
        )
        assert observed == [(publication, ("run-record.json",))]
    finally:
        store.close()


def test_single_verified_artifact_reader_only_maps_malformed_legacy_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        assert (
            materializer.read_verified_artifact(
                publication=publication,
                relative_path="../run-record.json",
            )
            is None
        )

        injected = ValueError("batch root validation failed")
        observed: list[tuple[TerminalPublication, tuple[str, ...]]] = []

        def fail_batch(
            *,
            publication: TerminalPublication,
            relative_paths: tuple[str, ...],
        ) -> tuple[bytes | None, ...]:
            observed.append((publication, relative_paths))
            raise injected

        monkeypatch.setattr(materializer, "read_verified_artifacts", fail_batch)

        with pytest.raises(ValueError) as raised:
            materializer.read_verified_artifact(
                publication=publication,
                relative_path="run-record.json",
            )

        assert raised.value is injected
        assert observed == [(publication, ("run-record.json",))]
    finally:
        store.close()


def test_materializer_never_replaces_or_adopts_an_existing_final_target(
    tmp_path: Path,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    target = runtime / "runs" / preparation.run_id
    target.mkdir(mode=0o700)
    marker = target / "operator-owned.txt"
    marker.write_bytes(b"unchanged")
    marker.chmod(0o600)
    target_identity = target.stat()
    marker_identity = marker.stat()
    try:
        with pytest.raises(MaterializationError, match="already exists"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert target.stat().st_ino == target_identity.st_ino
        assert marker.stat().st_ino == marker_identity.st_ino
        assert marker.read_bytes() == b"unchanged"
        assert stat.S_IMODE(target.stat().st_mode) == 0o700
        assert stat.S_IMODE(marker.stat().st_mode) == 0o600
        assert store.run(preparation.run_id).state is RunState.FINALIZING
    finally:
        store.close()


@pytest.mark.parametrize(
    "failure_point",
    (
        "before-file-fsync",
        "after-file-fsync",
        "before-directory-fsync",
        "after-directory-fsync",
        "before-rename",
        "after-rename",
        "after-renamed-root-fsync",
    ),
)
def test_materializer_failure_injection_never_returns_or_publishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_point: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    original_fsync = os.fsync
    original_write_file = materializer_module._write_projection_file
    original_write_projection = CanonicalMaterializer._write_projection
    original_rename = materializer_module._darwin_rename_no_replace
    original_verify_root = CanonicalMaterializer._verify_projection_root
    injected = False

    if failure_point in {"before-file-fsync", "before-directory-fsync"}:

        def fail_selected_fsync(descriptor: int) -> None:
            nonlocal injected
            metadata = os.fstat(descriptor)
            selected = (
                stat.S_ISREG(metadata.st_mode)
                if failure_point == "before-file-fsync"
                else stat.S_ISDIR(metadata.st_mode)
            )
            if selected and not injected:
                injected = True
                raise OSError("injected fsync failure")
            original_fsync(descriptor)

        monkeypatch.setattr(os, "fsync", fail_selected_fsync)
    elif failure_point == "after-file-fsync":

        def fail_after_file(
            parent_fd: int,
            name: str,
            payload: bytes,
            *,
            expected_uid: int,
        ) -> None:
            nonlocal injected
            original_write_file(
                parent_fd,
                name,
                payload,
                expected_uid=expected_uid,
            )
            if not injected:
                injected = True
                raise MaterializationError("injected after file fsync")

        monkeypatch.setattr(materializer_module, "_write_projection_file", fail_after_file)
    elif failure_point == "after-directory-fsync":

        def fail_after_directory(
            materializer: CanonicalMaterializer,
            *,
            temp_fd: int,
            expected: dict[str, bytes],
        ) -> None:
            nonlocal injected
            original_write_projection(materializer, temp_fd=temp_fd, expected=expected)
            injected = True
            raise MaterializationError("injected after directory fsync")

        monkeypatch.setattr(CanonicalMaterializer, "_write_projection", fail_after_directory)
    elif failure_point in {"before-rename", "after-rename"}:

        def fail_at_rename(
            source_parent_fd: int,
            source_name: str,
            destination_parent_fd: int,
            destination_name: str,
        ) -> None:
            nonlocal injected
            if failure_point == "before-rename":
                injected = True
                raise MaterializationError("injected before rename")
            original_rename(
                source_parent_fd,
                source_name,
                destination_parent_fd,
                destination_name,
            )
            injected = True
            raise MaterializationError("injected after rename")

        monkeypatch.setattr(materializer_module, "_darwin_rename_no_replace", fail_at_rename)
    elif failure_point == "after-renamed-root-fsync":
        verify_calls = 0

        def fail_final_reverify(
            materializer: CanonicalMaterializer,
            **kwargs: object,
        ) -> None:
            nonlocal injected, verify_calls
            verify_calls += 1
            if verify_calls == 3:
                injected = True
                raise MaterializationError("injected after renamed root fsync")
            original_verify_root(materializer, **kwargs)

        monkeypatch.setattr(
            CanonicalMaterializer,
            "_verify_projection_root",
            fail_final_reverify,
        )
    else:  # pragma: no cover - the closed parameter list owns this branch.
        raise AssertionError(failure_point)

    try:
        with pytest.raises(
            MaterializationError,
            match="injected|filesystem operation|written durably|durability check",
        ) as failure:
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert injected is True
        if failure_point in {"before-file-fsync", "before-directory-fsync"}:
            assert failure.value.deterministic is False
            assert failure.value.stage == "FSYNC"
        assert store.run(preparation.run_id).state is RunState.FINALIZING
        assert store.terminal_preparation(run_id=preparation.run_id) == preparation
        assert not any(
            event.type in {"run.completed", "run.failed", "run.cancelled"}
            for event in store.events(preparation.run_id)
        )
        final_root = runtime / "runs" / preparation.run_id
        if failure_point in {"after-rename", "after-renamed-root-fsync"}:
            assert final_root.is_dir()
            assert stat.S_IMODE(final_root.stat().st_mode) in {0o700, 0o500}
        else:
            assert not final_root.exists()
    finally:
        store.close()


@pytest.mark.parametrize(
    "attack",
    (
        "missing",
        "same-size-hash",
        "different-size",
        "extra",
        "alternate-separator",
        "symlink",
        "hardlink",
        "fifo",
        "socket",
        "wrong-file-mode",
        "wrong-directory-mode",
        "unexpected-reports-directory",
    ),
)
def test_materializer_rejects_closed_staging_inventory_attacks(
    tmp_path: Path,
    attack: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    staging = runtime / "staging" / preparation.run_id
    manifest = staging / "input-manifest.json"
    socket_handle: socket.socket | None = None
    try:
        if attack == "missing":
            manifest.unlink()
        elif attack == "same-size-hash":
            raw = manifest.read_bytes()
            manifest.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
            manifest.chmod(0o600)
        elif attack == "different-size":
            manifest.write_bytes(manifest.read_bytes() + b"x")
            manifest.chmod(0o600)
        elif attack == "extra":
            extra = staging / "unlisted.json"
            extra.write_bytes(b"{}")
            extra.chmod(0o600)
        elif attack == "alternate-separator":
            alternate = staging / "input-manifest.json\\"
            alternate.write_bytes(manifest.read_bytes())
            alternate.chmod(0o600)
        elif attack == "symlink":
            external = tmp_path / "external-manifest.json"
            external.write_bytes(manifest.read_bytes())
            external.chmod(0o600)
            manifest.unlink()
            manifest.symlink_to(external)
        elif attack == "hardlink":
            external = tmp_path / "linked-manifest.json"
            external.write_bytes(manifest.read_bytes())
            external.chmod(0o600)
            manifest.unlink()
            manifest.hardlink_to(external)
        elif attack == "fifo":
            manifest.unlink()
            os.mkfifo(manifest, mode=0o600)
        elif attack == "socket":
            manifest.unlink()
            socket_handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            short_socket = Path("/tmp") / f"sta24-{uuid.uuid4().hex}.sock"
            socket_handle.bind(str(short_socket))
            short_socket.replace(manifest)
        elif attack == "wrong-file-mode":
            manifest.chmod(0o640)
        elif attack == "wrong-directory-mode":
            staging.chmod(0o750)
        elif attack == "unexpected-reports-directory":
            (staging / "reports").mkdir(mode=0o700)
        else:  # pragma: no cover - the closed parameter list owns this branch.
            raise AssertionError(attack)

        with pytest.raises(MaterializationError):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert store.run(preparation.run_id).state is RunState.FINALIZING
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        if socket_handle is not None:
            socket_handle.close()
        store.close()


@pytest.mark.parametrize("attack", ("wrong-owner", "device"))
def test_materializer_rejects_falsified_staging_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    manifest = runtime / "staging" / preparation.run_id / "input-manifest.json"
    target = manifest.stat()
    original_fstat = os.fstat

    def falsified_fstat(descriptor: int) -> os.stat_result | SimpleNamespace:
        observed = original_fstat(descriptor)
        if observed.st_dev != target.st_dev or observed.st_ino != target.st_ino:
            return observed
        return SimpleNamespace(
            st_dev=observed.st_dev,
            st_ino=observed.st_ino,
            st_mode=(stat.S_IFCHR | 0o600 if attack == "device" else observed.st_mode),
            st_uid=(observed.st_uid + 1 if attack == "wrong-owner" else observed.st_uid),
            st_nlink=observed.st_nlink,
            st_size=observed.st_size,
            st_mtime_ns=observed.st_mtime_ns,
            st_ctime_ns=observed.st_ctime_ns,
        )

    monkeypatch.setattr(os, "fstat", falsified_fstat)
    try:
        with pytest.raises(MaterializationError, match="metadata"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
    finally:
        store.close()


@pytest.mark.parametrize("attack", ("short-read", "post-open-replacement"))
def test_materializer_rejects_staging_read_races(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    attack: str,
) -> None:
    store, runtime, preparation = _real_no_spawn_preparation(tmp_path)
    manifest = runtime / "staging" / preparation.run_id / "input-manifest.json"
    target = manifest.stat()
    original_read = os.read
    attacked = False

    def attack_read(descriptor: int, count: int) -> bytes:
        nonlocal attacked
        observed = os.fstat(descriptor)
        if not attacked and observed.st_dev == target.st_dev and observed.st_ino == target.st_ino:
            attacked = True
            if attack == "short-read":
                return b""
            held = manifest.with_name("input-manifest-held.json")
            manifest.rename(held)
            manifest.write_bytes(held.read_bytes())
            manifest.chmod(0o600)
        return original_read(descriptor, count)

    monkeypatch.setattr(os, "read", attack_read)
    try:
        with pytest.raises(MaterializationError, match="content or identity"):
            CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
                preparation=preparation
            )
        assert attacked is True
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def _task7_template_reservation(
    tmp_path: Path,
    *,
    run_id: str,
) -> tuple[ControlStore, Path, MutableClock, RunReservation]:
    runtime = tmp_path / "runtime"
    clock = MutableClock()
    publisher, store = open_catalog_service(
        fixture_root=REPOSITORY_ROOT / "data" / "fixtures",
        runtime_root=runtime,
        clock=clock,
    )
    publication = publisher.publish("determinism-probe-v1")
    catalog = CatalogManifestV1.model_validate_json(publication.publication_bytes)
    strategy = {
        "entry_limit_price": "100",
        "entry_quantity": "15",
        "metric_round_trip_quantity": "1",
        "metric_round_trips": 5,
        "risk_probe_quantity": "20",
        "venue_rejection_quantity": "1",
    }
    risk = {"max_notional": "1600"}
    instrument = catalog.inventory.instrument
    draft = _draft(publication.catalog_revision).model_dump(mode="json", by_alias=True)
    manifest = InputManifestV1.model_validate(
        {
            "schema": "InputManifest.v1",
            "environment": "BACKTEST",
            "strategy_id": "determinism-probe",
            "strategy_version": "v1",
            "canonical_config": strategy,
            "config_hash": sha256(canonical_json_bytes(strategy)).hexdigest(),
            "engine_package_version": "2.0.0rc3",
            "engine_tag_commit": "648970ce64a304d93da0a29320cb6e19b905fa39",
            "python_version": "3.12.4",
            "precision_mode": "FIXED_PRECISION_16",
            "fixture_id": catalog.fixture_id,
            "catalog_revision": publication.catalog_revision,
            "source_checksum": catalog.source_checksum,
            "catalog_checksum": catalog.catalog_checksum,
            "instruments": [
                {
                    "instrument_id": instrument.instrument_id,
                    "price_increment": instrument.price_increment,
                    "quantity_increment": instrument.size_increment,
                }
            ],
            "data_types": list(catalog.inventory.readback.data_types),
            "window": {
                "start_ns": catalog.inventory.readback.first_ts_init,
                "end_ns": catalog.inventory.readback.last_ts_init,
            },
            "timezone": catalog.inventory.timezone,
            "gaps": catalog.inventory.gaps,
            "duplicates": catalog.inventory.duplicates,
            "ordering_result": catalog.inventory.ordering_result,
            "information_set_policy": catalog.inventory.information_set_policy,
            "evaluation_protocol": catalog.inventory.evaluation_protocol,
            "venue_account_model": draft["venue_account_model"],
            "cost_fill_model": draft["cost_fill_model"],
            "risk_policy_id": "probe-risk",
            "risk_policy_version": "v1",
            "canonical_risk_policy": risk,
            "risk_policy_hash": sha256(canonical_json_bytes(risk)).hexdigest(),
            "replay_seed": 7,
        }
    )
    manifest_bytes = canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
    manifest_hash = sha256(manifest_bytes).hexdigest()
    store.reserve_run(
        run_id=run_id,
        input_manifest_bytes=manifest_bytes,
        input_manifest_hash=manifest_hash,
        catalog_revision=publication.catalog_revision,
        catalog_inventory_hash=publication.inventory_hash,
    )
    store.commit_transition(
        run_id=run_id,
        expected_version=0,
        target=RunState.PREFLIGHT_READY,
        candidate=EventCandidate.control(type="preflight.passed", ts_event_ns="10", payload={}),
    )
    store.commit_transition(
        run_id=run_id,
        expected_version=1,
        target=RunState.QUEUED,
        candidate=EventCandidate.control(type="run.queued", ts_event_ns="11", payload={}),
    )
    (runtime / "runs").mkdir(mode=0o700)
    return (
        store,
        runtime,
        clock,
        RunReservation(
            run_id=run_id,
            state=RunState.QUEUED,
            state_version=2,
            last_visible_seq=2,
            input_manifest_bytes=manifest_bytes,
            input_manifest_hash=manifest_hash,
        ),
    )


def _real_queued_reservation(
    tmp_path: Path,
    *,
    run_id: str,
    fixture_id: str = "local-qa-v1",
) -> tuple[ControlStore, Path, MutableClock, RunReservation]:
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700, parents=True)
    clock = MutableClock()
    store = ControlStore.open(runtime / "control.sqlite", clock=clock)
    publisher = FixturePublisher(
        registry=FixtureRegistry(REPOSITORY_ROOT / "data" / "fixtures"),
        control=store,
        runtime_root=runtime,
    )
    publication = publisher.publish(fixture_id)
    strategy = _definition(
        "determinism-probe",
        "v1",
        {
            "entry_limit_price": "100",
            "entry_quantity": "15",
            "metric_round_trip_quantity": "1",
            "metric_round_trips": 5,
            "risk_probe_quantity": "20",
            "venue_rejection_quantity": "1",
        },
    )
    risk = _definition("probe-risk", "v1", {"max_notional": "1600"})
    run_root = runtime / "runs"
    run_root.mkdir(mode=0o700)
    service = PreflightService(
        control=store,
        catalog=publisher,
        engine=EngineIdentity(
            package_version="2.0.0rc3",
            tag_commit="648970ce64a304d93da0a29320cb6e19b905fa39",
            python_version="3.12.4",
            precision_mode="FIXED_PRECISION_16",
        ),
        strategy_resolver=lambda ref: strategy if ref == "determinism-probe@v1" else None,
        risk_resolver=lambda ref: risk if ref == "probe-risk@v1" else None,
        clock=clock,
        run_id_factory=lambda: run_id,
        preflight_id_factory=lambda: f"pf_{run_id}",
        token_ttl_ns=100,
        run_root=run_root,
    )
    previous_clock_value = clock.value
    clock.value = 1_700_000_000_000_000_000
    try:
        preflight = service.run(
            _draft(publication.catalog_revision),
            idempotency_key=f"preflight-{run_id}",
        )
        reservation = service.consume_ready(
            preflight.preflight_id,
            preflight.canonical_request_hash,
            idempotency_key=f"create-{run_id}",
        )
    finally:
        clock.value = previous_clock_value
    return store, runtime, clock, reservation


def _real_no_spawn_preparation(
    tmp_path: Path,
    *,
    run_id: str = "bt_materialized_cancel",
) -> tuple[ControlStore, Path, TerminalPreparation]:
    store, runtime, clock, _reservation = _real_queued_reservation(
        tmp_path,
        run_id=run_id,
    )
    coordinator = CancellationCoordinator(control=store)
    decision = coordinator.request(
        run_id=run_id,
        idempotency_key=f"cancel-{run_id}",
        reason="operator",
    )
    service_cwd = runtime / "service-cwd"
    service_cwd.mkdir(mode=0o700)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        clock=clock,
        cancellation=coordinator,
        run_timeout_seconds=5,
    )
    result = supervisor.finalize_clean_cancel(decision)
    assert result is not None and result.state is RunState.FINALIZING
    clock.value = 200
    return store, runtime, store.prepare_terminal(run_id=run_id)


def _real_supervisor_failure_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    run_id: str = "bt_supervisor_prefix",
) -> tuple[ControlStore, Path, TerminalPreparation]:
    store, runtime, clock, reservation = _real_queued_reservation(
        tmp_path,
        run_id=run_id,
    )
    service_cwd = runtime / "service-cwd"
    service_cwd.mkdir(mode=0o700)

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        return FakeProcess(stdout=_runner_candidate_line(reservation))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        clock=clock,
        spawn_nonce_factory=lambda: f"spawn-{run_id}",
        identity_observer=_fake_process_observation,
        cancellation=CancellationCoordinator(
            control=store,
            identity_observer=_fake_process_observation,
            group_is_live=lambda _identity: False,
        ),
        run_timeout_seconds=5,
    )
    result = asyncio.run(supervisor.run(reservation))
    assert result.state is RunState.FINALIZING
    assert result.outcome is not None
    assert result.outcome.outcome.classification == "SUPERVISOR_FAILURE"
    assert result.outcome.outcome.child_outcome is None
    clock.value = 200
    return store, runtime, store.prepare_terminal(run_id=run_id)


_REPORT_NAMES = ("orders", "fills", "positions", "account", "metrics")


def _real_report_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    report_count: int,
    completed: bool,
    supervisor_failure: bool = False,
    source_report_bytes: dict[str, bytes] | None = None,
) -> tuple[ControlStore, Path, TerminalPreparation, dict[str, bytes]]:
    run_id = f"bt_reports_{'completed' if completed else 'failed'}_{report_count}"
    store, runtime, clock, reservation = _real_queued_reservation(
        tmp_path,
        run_id=run_id,
        fixture_id="determinism-probe-v1",
    )
    service_cwd = runtime / "service-cwd"
    service_cwd.mkdir(mode=0o700)
    manifest = InputManifestV1.model_validate_json(reservation.input_manifest_bytes)
    report_bytes = {
        f"reports/{name}.json": (
            canonical_json_bytes({"name": name, "rows": [report_count]})
            if source_report_bytes is None
            else source_report_bytes[f"reports/{name}.json"]
        )
        for name in _REPORT_NAMES[:report_count]
    }
    candidates = tuple(
        RunnerReportCandidateV1(
            name=name,
            relative_path=f"reports/{name}.json",
            sha256=sha256(report_bytes[f"reports/{name}.json"]).hexdigest(),
            size_bytes=len(report_bytes[f"reports/{name}.json"]),
        )
        for name in _REPORT_NAMES[:report_count]
    )
    outcome = RunnerOutcomeV1.model_validate(
        {
            "schema": "RunnerOutcome.v1",
            "run_id": run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": manifest.catalog_revision,
            "engine_package_version": "2.0.0rc3",
            "result": "SUCCEEDED" if completed else "FAILED",
            "last_source_seq": 1,
            "report_candidates": [
                candidate.model_dump(mode="json", by_alias=True) for candidate in candidates
            ],
            "failure": (
                None
                if completed
                else {
                    "code": "RUNNER_EXECUTION_FAILED",
                    "message": "expected failure",
                }
            ),
        }
    )

    async def launch(*_args: object, **_kwargs: object) -> FakeProcess:
        reports = runtime / "staging" / run_id / "reports"
        if report_bytes:
            reports.mkdir(mode=0o700)
            for relative_path, payload in report_bytes.items():
                path = runtime / "staging" / run_id / relative_path
                path.write_bytes(payload)
                path.chmod(0o600)
        return FakeProcess(
            stdout=_runner_candidate_line(reservation) + encode_protocol_line(outcome),
            returncode=0 if completed else 2 if supervisor_failure else 1,
        )

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    supervisor = RunnerSupervisor(
        control=store,
        runtime_root=runtime,
        python_executable=Path(sys.executable),
        runner_cwd=service_cwd,
        clock=clock,
        spawn_nonce_factory=lambda: f"spawn-{run_id}",
        identity_observer=_fake_process_observation,
        cancellation=CancellationCoordinator(
            control=store,
            identity_observer=_fake_process_observation,
            group_is_live=lambda _identity: False,
        ),
        run_timeout_seconds=5,
    )
    result = asyncio.run(supervisor.run(reservation))
    assert result.state is RunState.FINALIZING
    assert result.outcome is not None
    assert result.outcome.outcome.child_outcome == outcome
    assert result.outcome.outcome.classification == (
        "NATURAL_SUCCESS"
        if completed
        else "SUPERVISOR_FAILURE"
        if supervisor_failure
        else "NATURAL_FAILURE"
    )
    clock.value = 200
    return store, runtime, store.prepare_terminal(run_id=run_id), report_bytes


def _runner_candidate_line(reservation: RunReservation) -> bytes:
    manifest = InputManifestV1.model_validate_json(reservation.input_manifest_bytes)
    candidate = RunnerCandidateV1.model_validate(
        {
            "schema": "RunnerCandidate.v1",
            "run_id": reservation.run_id,
            "input_manifest_hash": reservation.input_manifest_hash,
            "catalog_revision": manifest.catalog_revision,
            "source_seq": 1,
            "ts_event_ns": manifest.window.start_ns,
            "type": "run.progress",
            "payload": {
                "progress": "decision",
                "decision_ts_ns": manifest.window.start_ns,
                "quote_identity": {
                    "instrument_id": manifest.instruments[0].instrument_id,
                    "ts_event_ns": manifest.window.start_ns,
                    "ts_available_ns": manifest.window.start_ns,
                    "source_seq": 1,
                    "source_revision": manifest.fixture_id,
                    "record_hash": "a" * 64,
                },
            },
        }
    )
    return encode_protocol_line(candidate)


def _fake_process_observation(pid: int, _path: Path) -> ProcessObservation:
    executable = Path(sys.executable).resolve()
    metadata = executable.stat()
    return ProcessObservation(
        platform="darwin",
        pid=pid,
        ppid=os.getpid(),
        pgid=pid,
        sid=pid,
        start_token="darwin:1700000000:123456",
        executable_path=str(executable),
        executable_device=metadata.st_dev,
        executable_inode=metadata.st_ino,
    )


def _definition(identifier: str, version: str, value: dict[str, object]) -> RegisteredDefinition:
    raw = canonical_json_bytes(value)
    return RegisteredDefinition(
        identifier=identifier,
        version=version,
        canonical_bytes=raw,
        sha256=sha256(raw).hexdigest(),
    )


def _draft(catalog_revision: str) -> BacktestDraftRequest:
    return BacktestDraftRequest.model_validate(
        {
            "environment": "BACKTEST",
            "strategy_ref": "determinism-probe@v1",
            "catalog_revision": catalog_revision,
            "window": {
                "start_ns": "1700000000000000000",
                "end_ns": "1700000000000000002",
            },
            "information_set_policy": {
                "schema": "InformationSetPolicy.v1",
                "availability_field": "ts_available_ns",
                "nautilus_timestamp_field": "ts_init",
                "visibility_rule": "AVAILABLE_AT_OR_BEFORE_DECISION",
                "tie_breakers": ["ts_available_ns", "source_seq", "record_hash"],
                "bar_rule": "CLOSED_AND_AVAILABLE",
                "source_revision_rule": "SINGLE_IMMUTABLE_REVISION",
            },
            "evaluation_protocol": {
                "schema": "EvaluationProtocol.v1",
                "mode": "fixture_only",
                "train": None,
                "tune": None,
                "out_of_sample": None,
                "purge_ns": "0",
                "embargo_ns": "0",
            },
            "venue_account_model": {
                "venue_id": "SIM",
                "oms_type": "HEDGING",
                "account_type": "MARGIN",
                "book_type": "L1_MBP",
                "routing": False,
                "use_random_ids": False,
                "use_position_ids": True,
                "allow_cash_borrowing": False,
                "starting_balance": "1000000",
                "currency": "USDT",
            },
            "cost_fill_model": _cost_fill_model(),
            "risk_policy_ref": "probe-risk@v1",
            "replay_seed": 7,
        }
    )


def _cost_fill_model() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }
