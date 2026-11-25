"""STA-26 bounded and idempotent finalization recovery contracts."""

from __future__ import annotations

import errno
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from test_finalization_crashes import _prepared_no_spawn
from test_finalization_order import MutableClock, _seed_no_spawn_finalizing

import stark_trading_os.audit.materializer as materializer_module
from stark_trading_os.audit.materializer import CanonicalMaterializer, MaterializationError
from stark_trading_os.control.recovery import ArtifactAccessDenied, FinalizationRecovery
from stark_trading_os.control.registry import (
    ControlStore,
    TerminalPreparation,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.domain.models import RunState


def test_mixed_recovery_keeps_pending_historical_evidence_and_publishes_legacy(tmp_path):
    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_legacy_mixed")
    try:
        store._connection.execute(
            "INSERT INTO runs(run_id,state,created_at_ns,contract_kind) "
            "VALUES('bt_aaa_historical','FINALIZING',10,'HISTORICAL_SMA_V2')"
        )
        store._connection.execute(
            "INSERT INTO runner_outcomes VALUES('bt_aaa_historical',?, ?, 10)",
            (b"pending-historical-opaque-bytes", "a" * 64),
        )
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()
        assert len(recovered) == 1
        assert recovered[0].run_id == preparation.run_id
        assert recovered[0].state is RunState.CANCELLED
        pending = store.run("bt_aaa_historical")
        assert pending.state is RunState.FINALIZING
        assert pending.state_version == 0 and pending.last_event_seq == 0
        assert (
            store._connection.execute(
                "SELECT outcome_bytes FROM runner_outcomes WHERE run_id='bt_aaa_historical'"
            ).fetchone()[0]
            == b"pending-historical-opaque-bytes"
        )
        assert not (runtime / "runs" / "bt_aaa_historical").exists()
    finally:
        store.close()


def test_recovery_publishes_one_exact_renamed_root_after_restart(tmp_path: Path) -> None:
    """Catches recovery that cannot finish a verified rename left by process exit."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recover_renamed")
    database_path = runtime / "control.sqlite"
    materialized = CanonicalMaterializer(
        store=store,
        runtime_root=runtime,
    ).build_verify_and_rename(preparation=preparation)
    assert store.terminal_finalization(run_id=preparation.run_id) is None
    store.close()

    reopened = ControlStore.open(database_path)
    try:
        recovered = FinalizationRecovery(store=reopened, runtime_root=runtime).recover()

        assert len(recovered) == 1
        publication = recovered[0]
        assert isinstance(publication, TerminalPublication)
        assert publication.run_id == preparation.run_id
        assert publication.state is RunState.CANCELLED
        assert publication.seal_digest == materialized.seal_digest
        assert reopened.terminal_finalization(run_id=preparation.run_id) == publication
        assert FinalizationRecovery(store=reopened, runtime_root=runtime).recover() == ()
        assert (
            reopened._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.cancelled'",
                (preparation.run_id,),
            ).fetchone()[0]
            == 1
        )
        assert (
            reopened._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 1
        )
    finally:
        reopened.close()


def test_recovery_publishes_a_verified_renamed_root_without_staging(tmp_path: Path) -> None:
    """Catches treating mutable staging as authority after the final root was renamed."""

    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id="bt_recover_without_staging",
    )
    materialized = CanonicalMaterializer(
        store=store,
        runtime_root=runtime,
    ).build_verify_and_rename(preparation=preparation)
    shutil.rmtree(runtime / "staging" / preparation.run_id)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], TerminalPublication)
        assert recovered[0].seal_digest == materialized.seal_digest
        assert store.terminal_finalization(run_id=preparation.run_id) == recovered[0]
    finally:
        store.close()


def test_recovery_creates_missing_preparation_and_rebuilds_around_partial_temp(
    tmp_path: Path,
) -> None:
    """Catches requiring a prior preparation or treating partial temp bytes as authority."""

    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    (runtime / "runs").mkdir(mode=0o700)
    store = ControlStore.open(runtime / "control.sqlite", clock=MutableClock())
    run_id = "bt_recover_no_preparation"
    _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
    run = store.run(run_id)
    outcome = store.runner_outcome(run_id)
    assert run.input_manifest_bytes is not None and outcome is not None
    staging_parent = runtime / "staging"
    staging_parent.mkdir(mode=0o700)
    staging = staging_parent / run_id
    staging.mkdir(mode=0o700)
    for name, payload in (
        ("input-manifest.json", run.input_manifest_bytes),
        ("runner-exit.json", outcome.outcome_bytes),
        ("stderr.txt", b""),
    ):
        path = staging / name
        path.write_bytes(payload)
        path.chmod(0o600)
    materializing = runtime / ".materializing"
    materializing.mkdir(mode=0o700)
    partial = materializing / ".tmp-partial"
    partial.mkdir(mode=0o700)
    marker = partial / "foreign"
    marker.write_bytes(b"not-authority")
    marker.chmod(0o600)
    try:
        assert store.terminal_preparation(run_id=run_id) is None

        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1 and isinstance(recovered[0], TerminalPublication)
        assert recovered[0].run_id == run_id
        assert marker.read_bytes() == b"not-authority"
        assert not (runtime / "runs" / run_id / "foreign").exists()
    finally:
        store.close()


def test_recovery_uses_run_id_order_and_ignores_partial_temp_authority(
    tmp_path: Path,
) -> None:
    """Catches nondeterministic scans or adoption of a half-written temp projection."""

    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    (runtime / "runs").mkdir(mode=0o700)
    store = ControlStore.open(runtime / "control.sqlite", clock=MutableClock())
    try:
        for index, run_id in enumerate(("bt_recover_z", "bt_recover_a")):
            if index == 1:
                shutil.copytree(
                    tmp_path / "trading-bt_recover_z",
                    tmp_path / "trading-bt_recover_a",
                )
            preparation = _seed_prepared_no_spawn(
                store,
                runtime=runtime,
                run_id=run_id,
                tmp_path=tmp_path,
            )
            CanonicalMaterializer(
                store=store,
                runtime_root=runtime,
            ).build_verify_and_rename(preparation=preparation)
        partial = runtime / ".materializing" / ".tmp-partial"
        partial.mkdir(mode=0o700)
        marker = partial / "not-authority"
        marker.write_bytes(b"partial")
        marker.chmod(0o600)

        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert tuple(item.run_id for item in recovered) == (
            "bt_recover_a",
            "bt_recover_z",
        )
        assert marker.read_bytes() == b"partial"
        assert all(isinstance(item, TerminalPublication) for item in recovered)
    finally:
        store.close()


def test_recovery_consumes_at_most_one_retry_attempt_per_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches one startup scan exhausting all three durable attempts at once."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recover_retry")

    def fail_snapshot(
        _materializer: CanonicalMaterializer,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        raise MaterializationError(
            "injected recoverable read failure",
            deterministic=False,
            stage="STAGING",
        )

    monkeypatch.setattr(CanonicalMaterializer, "read_staging_reports", fail_snapshot)
    recovery = FinalizationRecovery(store=store, runtime_root=runtime)
    try:
        assert recovery.recover() == ()
        first = store.terminal_preparation(run_id=preparation.run_id)
        assert first is not None and first.failure_attempt_count == 1

        assert recovery.recover() == ()
        second = store.terminal_preparation(run_id=preparation.run_id)
        assert second is not None and second.failure_attempt_count == 2

        third = recovery.recover()
        assert len(third) == 1
        assert isinstance(third[0], UnverifiedTerminalPublication)
        converted = store.terminal_preparation(run_id=preparation.run_id)
        assert converted is not None and converted.failure_attempt_count == 3
        assert recovery.recover() == ()
    finally:
        store.close()


def test_post_rename_publish_io_failure_is_not_retried_in_same_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches one recovery scan retrying publication after a renamed-root boundary."""

    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id="bt_recover_publish_eio",
    )
    original_publish = ControlStore._publish_verified_terminal
    publish_calls = 0

    def fail_first_publish(current_store: ControlStore, *, proof: object) -> object:
        nonlocal publish_calls
        publish_calls += 1
        if publish_calls == 1:
            raise OSError(errno.EIO, "injected post-rename publication failure")
        return original_publish(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", fail_first_publish)
    recovery = FinalizationRecovery(store=store, runtime_root=runtime)
    try:
        assert recovery.recover() == ()
        assert publish_calls == 1
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None and current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None

        recovered = recovery.recover()
        assert publish_calls == 2
        assert len(recovered) == 1 and isinstance(recovered[0], TerminalPublication)
        assert store.terminal_finalization(run_id=preparation.run_id) == recovered[0]
    finally:
        store.close()


def test_recovery_never_overwrites_or_adopts_an_unexpected_final_root(
    tmp_path: Path,
) -> None:
    """Catches treating a caller-created named directory as verified evidence."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recover_foreign")
    root = runtime / "runs" / preparation.run_id
    root.mkdir(mode=0o700)
    marker = root / "foreign"
    marker.write_bytes(b"do-not-adopt")
    marker.chmod(0o400)
    root.chmod(0o500)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()

        assert len(recovered) == 1
        assert isinstance(recovered[0], UnverifiedTerminalPublication)
        assert marker.read_bytes() == b"do-not-adopt"
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 0
        )
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 1
        )
    finally:
        store.close()


def test_renamed_root_io_failure_consumes_only_one_attempt_per_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a recovery failure falling through into a second ordinary attempt."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recover_root_eio")
    CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
        preparation=preparation
    )

    def fail_read(_descriptor: int, _size: int) -> bytes:
        raise OSError(errno.EIO, "injected renamed-root read failure")

    monkeypatch.setattr(materializer_module.os, "read", fail_read)
    try:
        assert FinalizationRecovery(store=store, runtime_root=runtime).recover() == ()
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 1
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_concurrent_recovery_connections_converge_to_one_publication(tmp_path: Path) -> None:
    """Catches duplicate terminal events or seals from two startup recovery scans."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recovery_race")
    database_path = runtime / "control.sqlite"
    CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
        preparation=preparation
    )
    store.close()

    def recover_once() -> tuple[object, ...]:
        connection = ControlStore.open(database_path)
        try:
            return FinalizationRecovery(store=connection, runtime_root=runtime).recover()
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = tuple(executor.map(lambda _unused: recover_once(), range(2)))
    verify = ControlStore.open(database_path)
    try:
        publications = (*first, *second)
        assert publications
        assert all(item == publications[0] for item in publications)
        assert verify.terminal_finalization(run_id=preparation.run_id) == publications[0]
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type = 'run.cancelled'",
                (preparation.run_id,),
            ).fetchone()[0]
            == 1
        )
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 1
        )
    finally:
        verify.close()


def test_recovery_rolls_back_sqlite_writer_before_releasing_publication_flock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches recovery exposing an active SQLite writer outside its filesystem lock."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recovery_cleanup")
    CanonicalMaterializer(store=store, runtime_root=runtime).build_verify_and_rename(
        preparation=preparation
    )
    root = runtime / "runs" / preparation.run_id
    record = root / "run-record.json"
    root.chmod(0o700)
    record.chmod(0o600)
    payload = record.read_bytes()
    record.write_bytes(b"X" + payload[1:])
    record.chmod(0o400)
    root.chmod(0o500)
    order: list[str] = []
    original_discard = ControlStore._discard_verified_publication_window
    original_flock = materializer_module.fcntl.flock

    def record_discard(current_store: ControlStore, window: object) -> None:
        order.append("writer")
        original_discard(current_store, window)  # type: ignore[arg-type]

    def record_flock(descriptor: int, operation: int) -> object:
        if operation == materializer_module.fcntl.LOCK_UN:
            order.append("flock")
        return original_flock(descriptor, operation)

    monkeypatch.setattr(ControlStore, "_discard_verified_publication_window", record_discard)
    monkeypatch.setattr(materializer_module.fcntl, "flock", record_flock)
    try:
        recovered = FinalizationRecovery(store=store, runtime_root=runtime).recover()
        assert len(recovered) == 1 and isinstance(recovered[0], UnverifiedTerminalPublication)
        assert order[:2] == ["writer", "flock"]
    finally:
        store.close()


def test_recovery_reads_one_bundle_from_the_exact_snapshot_publication(tmp_path: Path) -> None:
    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_recovery_bundle")
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        snapshot = store.run_evidence_snapshot(preparation.run_id)
        assert snapshot.terminal_finalization == publication
        assert isinstance(snapshot.terminal_finalization, TerminalPublication)
        root = runtime / "runs" / preparation.run_id

        observed = FinalizationRecovery(store=store, runtime_root=runtime).read_artifacts(
            publication=snapshot.terminal_finalization,
            relative_paths=("run-record.json", "absent.json", "events.ndjson"),
        )

        assert observed == (
            (root / "run-record.json").read_bytes(),
            None,
            (root / "events.ndjson").read_bytes(),
        )
    finally:
        store.close()


def test_recovery_bundle_does_not_lookup_a_new_publication_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id="bt_recovery_exact_publication",
    )
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        observed: list[tuple[TerminalPublication, tuple[str, ...]]] = []

        def read_batch(
            _materializer: CanonicalMaterializer,
            *,
            publication: TerminalPublication,
            relative_paths: tuple[str, ...],
        ) -> tuple[bytes | None, ...]:
            observed.append((publication, relative_paths))
            return (b"snapshot", None)

        def reject_lookup(_store: ControlStore, *, run_id: str) -> object:
            raise AssertionError(f"unexpected preliminary publication lookup: {run_id}")

        monkeypatch.setattr(CanonicalMaterializer, "read_verified_artifacts", read_batch)
        monkeypatch.setattr(ControlStore, "terminal_finalization", reject_lookup)

        result = FinalizationRecovery(store=store, runtime_root=runtime).read_artifacts(
            publication=publication,
            relative_paths=("run-record.json", "absent.json"),
        )

        assert result == (b"snapshot", None)
        assert observed == [
            (publication, ("run-record.json", "absent.json")),
        ]
    finally:
        store.close()


def test_single_recovery_reader_delegates_and_preserves_missing_denial(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id="bt_recovery_single_compatibility",
    )
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    recovery = FinalizationRecovery(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        observed: list[tuple[TerminalPublication, tuple[str, ...]]] = []
        payload: bytes | None = b"compatible"

        def read_batch(
            *,
            publication: TerminalPublication,
            relative_paths: tuple[str, ...],
        ) -> tuple[bytes | None, ...]:
            observed.append((publication, relative_paths))
            return (payload,)

        monkeypatch.setattr(recovery, "read_artifacts", read_batch)

        assert (
            recovery.read_artifact(
                run_id=preparation.run_id,
                relative_path="run-record.json",
            )
            == b"compatible"
        )
        payload = None
        with pytest.raises(
            ArtifactAccessDenied,
            match="relative_path is not in the verified run inventory",
        ):
            recovery.read_artifact(
                run_id=preparation.run_id,
                relative_path="absent.json",
            )
        assert observed == [
            (publication, ("run-record.json",)),
            (publication, ("absent.json",)),
        ]
    finally:
        store.close()


def test_single_recovery_reader_only_maps_malformed_legacy_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id="bt_recovery_single_error_compatibility",
    )
    materializer = CanonicalMaterializer(store=store, runtime_root=runtime)
    recovery = FinalizationRecovery(store=store, runtime_root=runtime)
    try:
        publication = materializer.materialize_and_publish(preparation=preparation)
        with pytest.raises(
            ArtifactAccessDenied,
            match="relative_path is not in the verified run inventory",
        ):
            recovery.read_artifact(
                run_id=preparation.run_id,
                relative_path="../run-record.json",
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

        monkeypatch.setattr(recovery, "read_artifacts", fail_batch)

        with pytest.raises(ValueError) as raised:
            recovery.read_artifact(
                run_id=preparation.run_id,
                relative_path="run-record.json",
            )

        assert raised.value is injected
        assert observed == [(publication, ("run-record.json",))]
    finally:
        store.close()


def _seed_prepared_no_spawn(
    store: ControlStore,
    *,
    runtime: Path,
    run_id: str,
    tmp_path: Path,
) -> TerminalPreparation:
    _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
    preparation = store.prepare_terminal(run_id=run_id)
    run = store.run(run_id)
    assert run.input_manifest_bytes is not None
    staging_parent = runtime / "staging"
    if not staging_parent.exists():
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
    return preparation
