"""STA-25 crash, retry, and concurrent-finalization contracts."""

from __future__ import annotations

import errno
import multiprocessing
import os
import sqlite3
import stat
from concurrent.futures import ThreadPoolExecutor
from multiprocessing.connection import Connection
from pathlib import Path
from typing import cast

import pytest
from test_finalization_order import MutableClock, _seed_no_spawn_finalizing

import stark_trading_os.audit.materializer as materializer_module
import stark_trading_os.control.registry as registry_module
import stark_trading_os.control.transactions as transactions_module
from stark_trading_os.audit.materializer import (
    CanonicalMaterializer,
    MaterializationError,
    RenamedRootRecoveryRequired,
    _RetainedFinalRootVerification,
    _VerifiedFinalRootReceipt,
)
from stark_trading_os.control.finalizer import FinalizationRetryPending, Finalizer
from stark_trading_os.control.registry import (
    ControlStore,
    FinalizationFailure,
    TerminalPreparation,
    TerminalPublication,
    TerminalPublicationConflict,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.transactions import _VerifiedPublicationWindow, _VerifiedRootProof
from stark_trading_os.domain.models import RunState


class _WindowBoundaryExit(BaseException):
    pass


class _WindowOpenFailure(RuntimeError):
    pass


class _InterruptAfterBeginConnection(sqlite3.Connection):
    """Connection seam that leaves a real writer transaction before exiting."""

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        cursor = super().execute(sql, parameters)
        if sql == "BEGIN IMMEDIATE":
            raise KeyboardInterrupt("injected post-BEGIN process exit")
        return cursor


def _probe_nonblocking_flock(lock_path: str, sender: Connection) -> None:
    descriptor = os.open(lock_path, os.O_RDONLY)
    try:
        try:
            materializer_module.fcntl.flock(
                descriptor,
                materializer_module.fcntl.LOCK_EX | materializer_module.fcntl.LOCK_NB,
            )
        except OSError as error:
            if error.errno not in {errno.EACCES, errno.EAGAIN}:
                raise
            sender.send(False)
        else:
            sender.send(True)
            materializer_module.fcntl.flock(descriptor, materializer_module.fcntl.LOCK_UN)
    finally:
        os.close(descriptor)
        sender.close()


def _external_flock_is_available(lock_path: Path) -> bool:
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_probe_nonblocking_flock, args=(str(lock_path), sender))
    process.start()
    sender.close()
    try:
        if not receiver.poll(5):
            process.terminate()
            process.join(timeout=5)
            raise RuntimeError("nonblocking flock probe did not return")
        acquired = receiver.recv()
        process.join(timeout=5)
        if process.exitcode != 0:
            raise RuntimeError("nonblocking flock probe did not exit cleanly")
        return acquired is True
    finally:
        receiver.close()
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)


def _close_recorded_lock_descriptors(descriptors: list[int], close: object) -> None:
    for descriptor in set(descriptors):
        try:
            close(descriptor)  # type: ignore[operator]
        except OSError:
            pass


def test_retry_pending_exposes_only_one_durable_attempt_and_closed_stage() -> None:
    """Catches retry signalling that leaks a path, message, or invalid attempt."""

    pending = FinalizationRetryPending(attempt=2, stage="FSYNC")

    assert pending.attempt == 2
    assert pending.stage == "FSYNC"
    assert str(pending) == "Finalization retry is pending."


def test_finalizer_rejects_a_non_store_before_any_finalization_attempt() -> None:
    """Catches accepting a caller-supplied store substitute at the authority boundary."""

    with pytest.raises(TypeError, match="exact ControlStore"):
        Finalizer(store=cast(ControlStore, object()), runtime_root=Path("/tmp/runtime"))


@pytest.mark.parametrize("crash", (KeyboardInterrupt, SystemExit))
def test_process_boundary_exits_consume_no_finalization_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    crash: type[BaseException],
) -> None:
    """Catches converting a process-boundary exit into a durable retry."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_boundary_exit")

    def exit_snapshot(
        _materializer: CanonicalMaterializer,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        raise crash()

    monkeypatch.setattr(CanonicalMaterializer, "read_staging_reports", exit_snapshot)
    try:
        with pytest.raises(crash):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_sqlite_record_failure_escapes_without_consuming_an_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches wrapping a failed SQLite fault write as a finalization retry."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_sqlite_escape")

    def fail_snapshot(
        _materializer: CanonicalMaterializer,
        *,
        preparation: TerminalPreparation,
    ) -> tuple[tuple[str, bytes], ...]:
        raise MaterializationError("injected staging failure", stage="STAGING")

    def fail_record(
        _store: ControlStore,
        *,
        run_id: str,
        failure: object,
    ) -> object:
        raise sqlite3.OperationalError("injected SQLite outage")

    monkeypatch.setattr(CanonicalMaterializer, "read_staging_reports", fail_snapshot)
    monkeypatch.setattr(ControlStore, "record_finalization_failure", fail_record)
    try:
        with pytest.raises(sqlite3.OperationalError, match="SQLite outage"):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_pre_rename_fsync_error_is_one_retryable_fsync_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches mapping a pre-rename durability OSError to MATERIALIZATION."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_fsync_stage")

    def fail_fsync(_descriptor: int) -> None:
        raise OSError("injected fsync failure")

    monkeypatch.setattr(materializer_module.os, "fsync", fail_fsync)
    try:
        with pytest.raises(FinalizationRetryPending) as failure:
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert failure.value.attempt == 1
        assert failure.value.stage == "FSYNC"
        assert store.run(preparation.run_id).state is RunState.FINALIZING
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_real_staging_read_eio_is_one_operational_staging_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches classifying an actual `os.read` EIO as deterministic evidence drift."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_read_eio")

    def fail_read(_descriptor: int, _size: int) -> bytes:
        raise OSError(errno.EIO, "injected read I/O failure")

    monkeypatch.setattr(materializer_module.os, "read", fail_read)
    try:
        with pytest.raises(FinalizationRetryPending) as pending:
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert pending.value.attempt == 1
        assert pending.value.stage == "STAGING"
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store.close()


def test_retained_publication_read_eio_requires_recovery_without_an_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches laundering post-rename retained evidence EIO into a terminal fault."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_retained_read_eio")
    original_publish = ControlStore._publish_verified_terminal

    def fail_after_receipt(current_store: ControlStore, *, proof: object) -> object:
        def fail_read(_descriptor: int, _size: int) -> bytes:
            raise OSError(errno.EIO, "injected retained read I/O failure")

        monkeypatch.setattr(materializer_module.os, "read", fail_read)
        return original_publish(current_store, proof=proof)  # type: ignore[arg-type]

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", fail_after_receipt)
    try:
        with pytest.raises(RenamedRootRecoveryRequired):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None and current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_real_read_eio_retries_and_converts_only_across_fresh_store_instances(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches per-call retries losing their durable count when a store is reopened."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_fresh_read_eio")
    database_path = runtime / "control.sqlite"
    store.close()

    def fail_read(_descriptor: int, _size: int) -> bytes:
        raise OSError(errno.EIO, "injected persistent read I/O failure")

    monkeypatch.setattr(materializer_module.os, "read", fail_read)

    def finalize_once() -> object:
        fresh = ControlStore.open(database_path)
        try:
            return Finalizer(store=fresh, runtime_root=runtime).finalize(preparation.run_id)
        finally:
            fresh.close()

    for expected_attempt in (1, 2):
        with pytest.raises(FinalizationRetryPending) as pending:
            finalize_once()
        assert pending.value.attempt == expected_attempt
        assert pending.value.stage == "STAGING"
    third = finalize_once()
    fourth = finalize_once()
    verify = ControlStore.open(database_path)
    try:
        assert isinstance(third, UnverifiedTerminalPublication)
        assert fourth == third == verify.terminal_finalization(run_id=preparation.run_id)
        prepared = verify.terminal_preparation(run_id=preparation.run_id)
        assert prepared is not None and prepared.failure_attempt_count == 3
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        verify.close()


def test_real_projection_write_eio_is_one_operational_materialization_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches an actual projection write EIO converting evidence deterministically."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_write_eio")

    def fail_write(_descriptor: int, _payload: bytes) -> int:
        raise OSError(errno.EIO, "injected write I/O failure")

    monkeypatch.setattr(materializer_module.os, "write", fail_write)
    try:
        with pytest.raises(FinalizationRetryPending) as pending:
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert pending.value.attempt == 1
        assert pending.value.stage == "MATERIALIZATION"
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_real_no_replace_rename_errno_is_one_operational_rename_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a renameatx_np errno branch becoming deterministic evidence failure."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_rename_errno")

    class RenameAtx:
        argtypes: object
        restype: object

        def __call__(self, *_args: object) -> int:
            materializer_module.ctypes.set_errno(errno.EIO)
            return -1

    class LibC:
        renameatx_np = RenameAtx()

    monkeypatch.setattr(materializer_module.ctypes, "CDLL", lambda *_args, **_kwargs: LibC())
    try:
        with pytest.raises(FinalizationRetryPending) as pending:
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert pending.value.attempt == 1
        assert pending.value.stage == "RENAME"
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_pre_rename_no_replace_oserror_is_one_retryable_rename_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches mapping a no-replace OSError to MATERIALIZATION or FSYNC."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_rename_stage")

    def fail_rename(*_args: object) -> None:
        raise OSError("injected rename failure")

    monkeypatch.setattr(materializer_module, "_darwin_rename_no_replace", fail_rename)
    try:
        with pytest.raises(FinalizationRetryPending) as failure:
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert failure.value.attempt == 1
        assert failure.value.stage == "RENAME"
        assert not (runtime / "runs" / preparation.run_id).exists()
    finally:
        store.close()


def test_lock_window_unverified_winner_prevents_stale_root_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a stale materializer renaming after a second store wins under flock."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_lock_window")
    database_path = runtime / "control.sqlite"
    original_flock = materializer_module.fcntl.flock
    committed = False

    def commit_winner_after_lock(descriptor: int, operation: int) -> None:
        nonlocal committed
        original_flock(descriptor, operation)
        if not committed and operation & materializer_module.fcntl.LOCK_EX:
            committed = True
            winner = ControlStore.open(database_path, clock=lambda: 201)
            try:
                result = winner.record_finalization_failure(
                    run_id=preparation.run_id,
                    failure=FinalizationFailure(
                        deterministic=True,
                        stage="REPORTS",
                    ),
                )
                assert isinstance(result, UnverifiedTerminalPublication)
            finally:
                winner.close()

    monkeypatch.setattr(materializer_module.fcntl, "flock", commit_winner_after_lock)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert committed is True
        assert isinstance(result, UnverifiedTerminalPublication)
        assert result == store.terminal_finalization(run_id=preparation.run_id)
        assert not (runtime / "runs" / preparation.run_id).exists()
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None and current.failure_attempt_count == 3
    finally:
        store.close()


def test_post_truth_read_unverified_winner_prevents_stale_root_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a winner committing after stale truth read but before rename."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_postread_window")
    database_path = runtime / "control.sqlite"
    original_flock = materializer_module.fcntl.flock
    original_preparation = ControlStore.terminal_preparation
    locked = False
    committed = False
    winner_result: UnverifiedTerminalPublication | None = None

    def note_lock(descriptor: int, operation: int) -> None:
        nonlocal locked
        original_flock(descriptor, operation)
        if operation & materializer_module.fcntl.LOCK_EX:
            locked = True

    def commit_winner_after_truth_read(
        current_store: ControlStore,
        *,
        run_id: str,
    ) -> TerminalPreparation | None:
        nonlocal committed, winner_result
        current = original_preparation(current_store, run_id=run_id)
        if current_store is store and locked and not committed:
            committed = True
            winner = ControlStore.open(database_path, clock=lambda: 301)
            try:
                result = winner.record_finalization_failure(
                    run_id=preparation.run_id,
                    failure=FinalizationFailure(
                        deterministic=True,
                        stage="REPORTS",
                    ),
                )
                assert isinstance(result, UnverifiedTerminalPublication)
                winner_result = result
            finally:
                winner.close()
        return current

    monkeypatch.setattr(materializer_module.fcntl, "flock", note_lock)
    monkeypatch.setattr(ControlStore, "terminal_preparation", commit_winner_after_truth_read)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert committed is True
        assert winner_result is not None
        assert isinstance(result, UnverifiedTerminalPublication)
        assert result == winner_result
        assert not (runtime / "runs" / preparation.run_id).exists()
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 3
        assert current.conversion_fault_hash == result.fault.fault_hash
        assert store.terminal_finalization(run_id=preparation.run_id) == result
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_sqlite_writer_window_blocks_a_real_writer_through_rename_and_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches releasing the final truth writer before the no-replace rename."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_writer_window")
    database_path = runtime / "control.sqlite"
    original_rename = materializer_module._darwin_rename_no_replace
    contender = sqlite3.connect(database_path)
    contender.execute("PRAGMA busy_timeout = 0")
    blocked = False

    def require_active_writer(*args: object) -> None:
        nonlocal blocked
        with pytest.raises(sqlite3.OperationalError, match="locked|busy"):
            contender.execute("BEGIN IMMEDIATE")
        blocked = True
        original_rename(*args)  # type: ignore[arg-type]

    monkeypatch.setattr(materializer_module, "_darwin_rename_no_replace", require_active_writer)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert blocked is True
        assert isinstance(result, TerminalPublication)
        assert store.terminal_finalization(run_id=preparation.run_id) == result
        assert (runtime / "runs" / preparation.run_id).exists()
        contender.execute("BEGIN IMMEDIATE")
        assert (
            contender.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 1
        )
        contender.rollback()
    finally:
        contender.close()
        store.close()


@pytest.mark.parametrize("cross_store", (False, True))
def test_forged_or_cross_store_window_cannot_end_active_writer(
    tmp_path: Path,
    cross_store: bool,
) -> None:
    """Catches an arbitrary window object rolling back a real store writer."""

    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id=f"bt_window_token_{int(cross_store)}",
    )
    other = ControlStore.open(runtime / "control.sqlite") if cross_store else store
    window = store._open_verified_publication_window(preparation=preparation)
    assert type(window) is _VerifiedPublicationWindow
    forged = object.__new__(_VerifiedPublicationWindow)
    forged._authority = store._publication_authority
    forged._nonce = object()
    forged._active = True
    candidate = window if cross_store else forged
    try:
        with pytest.raises(TerminalPublicationConflict):
            other._discard_verified_publication_window(candidate)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is window
    finally:
        store._discard_verified_publication_window(window)
        if other is not store:
            other.close()
        store.close()


def test_forged_owner_pointer_cannot_end_the_registered_writer(tmp_path: Path) -> None:
    """Catches trusting a mutable Store pointer over the issued window registry."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_forged_owner")
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")
    real_window = store._open_verified_publication_window(preparation=preparation)
    assert type(real_window) is _VerifiedPublicationWindow
    forged = object.__new__(_VerifiedPublicationWindow)
    forged._authority = store._publication_authority
    forged._nonce = object()
    forged._active = True
    store._verified_publication_window = forged
    try:
        with pytest.raises(TerminalPublicationConflict):
            store._discard_verified_publication_window(forged)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is forged
        assert real_window._active is True
        with pytest.raises(sqlite3.OperationalError, match="locked|busy"):
            contender.execute("BEGIN IMMEDIATE")

        store._discard_verified_publication_window(real_window)
        assert real_window._active is False
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        if real_window._active:
            store._verified_publication_window = real_window
            store._discard_verified_publication_window(real_window)
        contender.close()
        store.close()


def test_replayed_owner_pointer_cannot_end_the_current_registered_writer(
    tmp_path: Path,
) -> None:
    """Catches a replayed pointer acquiring teardown authority over a newer writer."""

    store, _runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_replayed_owner")
    first = store._open_verified_publication_window(preparation=preparation)
    assert type(first) is _VerifiedPublicationWindow
    store._discard_verified_publication_window(first)
    current = store._open_verified_publication_window(preparation=preparation)
    assert type(current) is _VerifiedPublicationWindow
    store._verified_publication_window = first
    try:
        store._discard_verified_publication_window(first)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is first
        assert current._active is True
        store._discard_verified_publication_window(current)
        assert current._active is False
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
    finally:
        if current._active:
            store._verified_publication_window = current
            store._discard_verified_publication_window(current)
        store.close()


def test_cross_store_owner_pointer_cannot_end_the_registered_writer(tmp_path: Path) -> None:
    """Catches a foreign issued pointer acquiring another Store's teardown authority."""

    target_root = tmp_path / "target"
    other_root = tmp_path / "other"
    target_root.mkdir()
    other_root.mkdir()
    store, runtime, preparation = _prepared_no_spawn(target_root, run_id="bt_cross_owner_target")
    other, _other_runtime, other_preparation = _prepared_no_spawn(
        other_root, run_id="bt_cross_owner_source"
    )
    real_window = store._open_verified_publication_window(preparation=preparation)
    other_window = other._open_verified_publication_window(preparation=other_preparation)
    assert type(real_window) is _VerifiedPublicationWindow
    assert type(other_window) is _VerifiedPublicationWindow
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")
    store._verified_publication_window = other_window
    try:
        with pytest.raises(TerminalPublicationConflict):
            store._discard_verified_publication_window(other_window)

        assert store._connection.in_transaction is True
        assert real_window._active is True
        with pytest.raises(sqlite3.OperationalError, match="locked|busy"):
            contender.execute("BEGIN IMMEDIATE")
        store._discard_verified_publication_window(real_window)
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        if real_window._active:
            store._verified_publication_window = real_window
            store._discard_verified_publication_window(real_window)
        if other_window._active:
            other._verified_publication_window = other_window
            other._discard_verified_publication_window(other_window)
        contender.close()
        other.close()
        store.close()


def test_uninitialized_window_and_no_active_publisher_leave_no_state_change(
    tmp_path: Path,
) -> None:
    """Catches raw private allocations bypassing the Store token registry."""

    store, _runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_window_uninit")
    window = store._open_verified_publication_window(preparation=preparation)
    assert type(window) is _VerifiedPublicationWindow
    forged = object.__new__(_VerifiedPublicationWindow)
    try:
        with pytest.raises(TerminalPublicationConflict):
            store._discard_verified_publication_window(forged)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is window
    finally:
        store._discard_verified_publication_window(window)

    try:
        with pytest.raises(TerminalPublicationConflict):
            store._publish_verified_terminal(proof=object.__new__(_VerifiedRootProof))

        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_active_writer_close_rolls_back_before_another_store_writes(tmp_path: Path) -> None:
    """Catches close leaving a held BEGIN IMMEDIATE transaction behind."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_window_close")
    window = store._open_verified_publication_window(preparation=preparation)
    assert type(window) is _VerifiedPublicationWindow
    store.close()

    other = ControlStore.open(runtime / "control.sqlite", clock=lambda: 401)
    try:
        result = other.record_finalization_failure(
            run_id=preparation.run_id,
            failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
        )

        assert isinstance(result, UnverifiedTerminalPublication)
        assert window._active is False
        assert other.terminal_finalization(run_id=preparation.run_id) == result
    finally:
        other.close()


def test_nested_or_replayed_window_cannot_affect_a_current_writer(tmp_path: Path) -> None:
    """Catches reusing an old token to end a later BEGIN IMMEDIATE window."""

    store, _runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_window_replay")
    first = store._open_verified_publication_window(preparation=preparation)
    assert type(first) is _VerifiedPublicationWindow
    try:
        with pytest.raises(TerminalPublicationConflict):
            store._open_verified_publication_window(preparation=preparation)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is first
    finally:
        store._discard_verified_publication_window(first)

    second = store._open_verified_publication_window(preparation=preparation)
    assert type(second) is _VerifiedPublicationWindow
    try:
        store._discard_verified_publication_window(first)

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is second
    finally:
        store._discard_verified_publication_window(second)
        store.close()


def test_active_window_rejects_an_ordinary_store_mutation(tmp_path: Path) -> None:
    """Catches a same-store write nesting inside a held publication transaction."""

    store, _runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_window_nested_write")
    window = store._open_verified_publication_window(preparation=preparation)
    assert type(window) is _VerifiedPublicationWindow
    try:
        with pytest.raises(RuntimeError, match="Nested control database transactions"):
            store.record_finalization_failure(
                run_id=preparation.run_id,
                failure=FinalizationFailure(deterministic=True, stage="REPORTS"),
            )

        assert store._connection.in_transaction is True
        assert store._verified_publication_window is window
        assert store.terminal_finalization(run_id=preparation.run_id) is None
    finally:
        store._discard_verified_publication_window(window)
        store.close()


@pytest.mark.parametrize("crash", (KeyboardInterrupt, SystemExit, _WindowBoundaryExit))
def test_window_baseexception_rolls_back_before_finalizer_exits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    crash: type[BaseException],
) -> None:
    """Catches a process-boundary exception stranding the Store writer window."""

    store, runtime, preparation = _prepared_no_spawn(
        tmp_path,
        run_id=f"bt_window_base_{crash.__name__}",
    )

    def exit_publisher(_store: ControlStore, *, proof: object) -> object:
        raise crash()

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", exit_publisher)
    try:
        with pytest.raises(crash):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert store._connection.in_transaction is False
        assert store._verified_publication_window is None
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()


def test_post_rename_sqlite_commit_denial_requires_recovery_without_attempt(
    tmp_path: Path,
) -> None:
    """Catches leaking a post-rename SQLite commit error as a normal database fault."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_commit_denied")

    def deny_commit(
        action: int,
        argument1: str | None,
        _argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action == sqlite3.SQLITE_TRANSACTION and argument1 == "COMMIT":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    store._connection.set_authorizer(deny_commit)
    try:
        with pytest.raises(RenamedRootRecoveryRequired, match="STA-26 recovery"):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )

        assert (runtime / "runs" / preparation.run_id).exists()
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None and current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 0
        )
        assert store._verified_publication_window is None
    finally:
        store._connection.set_authorizer(None)
        store.close()


def test_rollback_denial_preserves_primary_exit_and_poison_closes_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches failed rollback leaving the SQLite writer live after a process exit."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_rollback_denied")
    database_path = runtime / "control.sqlite"
    original_open = ControlStore._open_verified_publication_window
    original_flock = materializer_module.fcntl.flock
    captured: list[object] = []
    writer_released_at_unlock = False

    def capture_window(
        current_store: ControlStore,
        *,
        preparation: TerminalPreparation,
    ) -> object:
        current_store._connection.set_authorizer(deny_rollback)
        opened = original_open(current_store, preparation=preparation)
        if type(opened) is _VerifiedPublicationWindow:
            captured.append(opened)
        return opened

    def exit_publisher(_store: ControlStore, *, proof: object) -> object:
        raise KeyboardInterrupt()

    def deny_rollback(
        action: int,
        argument1: str | None,
        _argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action == sqlite3.SQLITE_TRANSACTION and argument1 == "ROLLBACK":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    def require_writer_released_before_unlock(descriptor: int, operation: int) -> None:
        nonlocal writer_released_at_unlock
        if operation == materializer_module.fcntl.LOCK_UN and not writer_released_at_unlock:
            contender.execute("BEGIN IMMEDIATE")
            contender.rollback()
            writer_released_at_unlock = True
        original_flock(descriptor, operation)

    monkeypatch.setattr(ControlStore, "_open_verified_publication_window", capture_window)
    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", exit_publisher)
    monkeypatch.setattr(
        materializer_module.fcntl,
        "flock",
        require_writer_released_before_unlock,
    )
    contender = sqlite3.connect(database_path)
    contender.execute("PRAGMA busy_timeout = 0")
    try:
        with pytest.raises(KeyboardInterrupt):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )

        assert len(captured) == 1
        assert captured[0]._active is False  # type: ignore[attr-defined]
        assert store._verified_publication_window is None
        assert writer_released_at_unlock is True
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            store._connection.execute("SELECT 1")
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        contender.close()
        try:
            store._connection.set_authorizer(None)
        except sqlite3.ProgrammingError:
            pass
        try:
            if store._connection.in_transaction:
                store._connection.rollback()
        except sqlite3.ProgrammingError:
            pass
        store.close()


def test_proof_discard_failure_preserves_primary_and_releases_both_locks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches proof cleanup masking a process exit before writer and flock release."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_proof_discard_eio")
    original_close = transactions_module.os.close
    original_flock = materializer_module.fcntl.flock
    source_lock_descriptors: list[int] = []
    captured_proofs: list[_VerifiedRootProof] = []
    captured_guard_descriptors: list[int] = []
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def note_source_lock(descriptor: int, operation: int) -> None:
        original_flock(descriptor, operation)
        if operation == materializer_module.fcntl.LOCK_EX:
            source_lock_descriptors.append(descriptor)

    def raise_primary(_store: ControlStore, *, proof: object) -> object:
        assert type(proof) is _VerifiedRootProof
        captured_proofs.append(proof)
        captured_guard_descriptors.append(proof._lock_guard_fd)
        raise KeyboardInterrupt("injected publisher process exit")

    def fail_only_proof_guard_close(descriptor: int) -> None:
        if captured_guard_descriptors and descriptor == captured_guard_descriptors[0]:
            raise OSError(errno.EIO, "injected proof guard close failure")
        original_close(descriptor)

    monkeypatch.setattr(materializer_module.fcntl, "flock", note_source_lock)
    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", raise_primary)
    monkeypatch.setattr(transactions_module.os, "close", fail_only_proof_guard_close)
    observed: BaseException | None = None
    try:
        try:
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        except BaseException as error:
            observed = error

        assert type(observed) is KeyboardInterrupt
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        assert _external_flock_is_available(runtime / ".run-publish.lock") is True
        assert captured_proofs[0]._lock_guard_fd == -1
        assert captured_proofs[0]._retained_final_root is None
    finally:
        monkeypatch.setattr(transactions_module.os, "close", original_close)
        _close_recorded_lock_descriptors(captured_guard_descriptors, original_close)
        if store._verified_publication_window is not None:
            store._discard_verified_publication_window(store._verified_publication_window)
        for proof in captured_proofs:
            proof._discard()
        if type(observed) is not KeyboardInterrupt:
            _close_recorded_lock_descriptors(source_lock_descriptors, original_close)
        contender.close()
        store.close()


def test_post_commit_proof_cleanup_error_releases_locks_without_recovery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches Store proof cleanup turning a committed terminal into STA-26 recovery."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_post_commit_cleanup")
    original_publish = ControlStore._publish_verified_terminal
    original_close = transactions_module.os.close
    captured_proofs: list[_VerifiedRootProof] = []
    captured_guard_descriptors: list[int] = []
    captured_retained: list[_RetainedFinalRootVerification] = []
    retained_descriptors: list[int] = []
    close_failed = False
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def capture_publish(current_store: ControlStore, *, proof: object) -> TerminalPublication:
        assert type(proof) is _VerifiedRootProof
        captured_proofs.append(proof)
        captured_guard_descriptors.append(proof._lock_guard_fd)
        retained = proof._retained_final_root
        assert type(retained) is _RetainedFinalRootVerification
        captured_retained.append(retained)
        retained_descriptors.extend(
            descriptor
            for descriptor in (
                *(item[1] for item in retained._files),
                retained._reports_fd,
                retained._root_fd,
                retained._runs_fd,
                retained._runtime_fd,
            )
            if descriptor >= 0
        )
        return original_publish(current_store, proof=proof)

    def fail_proof_guard_once(descriptor: int) -> None:
        nonlocal close_failed
        if (
            not close_failed
            and captured_guard_descriptors
            and descriptor == captured_guard_descriptors[0]
        ):
            close_failed = True
            raise OSError(errno.EIO, "injected committed proof cleanup failure")
        original_close(descriptor)

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", capture_publish)
    monkeypatch.setattr(transactions_module.os, "close", fail_proof_guard_once)
    try:
        observed: BaseException | None = None
        try:
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        except BaseException as error:
            observed = error

        assert type(observed) is OSError
        assert isinstance(observed, OSError) and observed.errno == errno.EIO
        assert isinstance(
            store.terminal_finalization(run_id=preparation.run_id),
            TerminalPublication,
        )
        assert (runtime / "runs" / preparation.run_id).is_dir()
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        assert _external_flock_is_available(runtime / ".run-publish.lock") is True
        assert len(captured_proofs) == 1
        assert captured_proofs[0]._lock_guard_fd == -1
        assert captured_proofs[0]._retained_final_root is None
        assert len(captured_retained) == 1
        assert captured_retained[0]._files == ()
        assert captured_retained[0]._reports_fd == -1
        assert captured_retained[0]._root_fd == -1
        assert captured_retained[0]._runs_fd == -1
        assert captured_retained[0]._runtime_fd == -1
        for descriptor in retained_descriptors:
            with pytest.raises(OSError) as closed:
                os.fstat(descriptor)
            assert closed.value.errno == errno.EBADF
    finally:
        monkeypatch.setattr(transactions_module.os, "close", original_close)
        _close_recorded_lock_descriptors(captured_guard_descriptors, original_close)
        contender.close()
        store.close()


def test_post_commit_retained_cleanup_error_preserves_terminal_and_reports_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a retained descriptor close error being reported as publication success."""

    store, runtime, preparation = _prepared_no_spawn(
        tmp_path, run_id="bt_post_commit_retained_cleanup"
    )
    original_publish = ControlStore._publish_verified_terminal
    original_close = materializer_module.os.close
    captured_proofs: list[_VerifiedRootProof] = []
    captured_retained: list[_RetainedFinalRootVerification] = []
    failed_descriptors: list[int] = []
    close_failed = False
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def capture_publish(current_store: ControlStore, *, proof: object) -> TerminalPublication:
        assert type(proof) is _VerifiedRootProof
        retained = proof._retained_final_root
        assert type(retained) is _RetainedFinalRootVerification
        assert retained._files
        captured_proofs.append(proof)
        captured_retained.append(retained)
        failed_descriptors.append(retained._files[0][1])
        return original_publish(current_store, proof=proof)

    def fail_retained_file_once(descriptor: int) -> None:
        nonlocal close_failed
        if not close_failed and failed_descriptors and descriptor == failed_descriptors[0]:
            close_failed = True
            raise OSError(errno.EIO, "injected retained cleanup failure")
        original_close(descriptor)

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", capture_publish)
    monkeypatch.setattr(materializer_module.os, "close", fail_retained_file_once)
    try:
        with pytest.raises(OSError) as observed:
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )

        assert observed.value.errno == errno.EIO
        assert isinstance(
            store.terminal_finalization(run_id=preparation.run_id),
            TerminalPublication,
        )
        assert (runtime / "runs" / preparation.run_id).is_dir()
        assert captured_proofs[0]._retained_final_root is None
        assert captured_retained[0]._files == ()
        assert captured_retained[0]._reports_fd == -1
        assert captured_retained[0]._root_fd == -1
        assert captured_retained[0]._runs_fd == -1
        assert captured_retained[0]._runtime_fd == -1
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        assert _external_flock_is_available(runtime / ".run-publish.lock") is True
    finally:
        monkeypatch.setattr(materializer_module.os, "close", original_close)
        _close_recorded_lock_descriptors(failed_descriptors, original_close)
        contender.close()
        store.close()


def test_receipt_discard_releases_retained_descriptors_after_guard_close_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches receipt guard cleanup preventing retained-root teardown."""

    guard_read, guard_write = os.pipe()
    runtime_fd, runtime_write = os.pipe()
    runs_fd, runs_write = os.pipe()
    root_fd, root_write = os.pipe()
    reports_fd, reports_write = os.pipe()
    file_fd, file_write = os.pipe()
    retained = object.__new__(_RetainedFinalRootVerification)
    retained._files = (("seal.json", file_fd, os.fstat(file_fd), b"{}"),)
    retained._reports_fd = reports_fd
    retained._root_fd = root_fd
    retained._runs_fd = runs_fd
    retained._runtime_fd = runtime_fd
    receipt = object.__new__(_VerifiedFinalRootReceipt)
    receipt._lock_guard_fd = guard_read
    receipt._retained = retained
    receipt._consumed = False
    original_close = materializer_module.os.close
    close_failed = False

    def fail_guard_once(descriptor: int) -> None:
        nonlocal close_failed
        if not close_failed and descriptor == guard_read:
            close_failed = True
            raise OSError(errno.EIO, "injected receipt guard close failure")
        original_close(descriptor)

    monkeypatch.setattr(materializer_module.os, "close", fail_guard_once)
    try:
        with pytest.raises(OSError) as observed:
            receipt._discard()

        assert observed.value.errno == errno.EIO
        assert receipt._lock_guard_fd == -1
        assert receipt._retained is None
        assert retained._files == ()
        assert retained._reports_fd == -1
        assert retained._root_fd == -1
        assert retained._runs_fd == -1
        assert retained._runtime_fd == -1
        for descriptor in (file_fd, reports_fd, root_fd, runs_fd, runtime_fd):
            with pytest.raises(OSError) as closed:
                os.fstat(descriptor)
            assert closed.value.errno == errno.EBADF
    finally:
        monkeypatch.setattr(materializer_module.os, "close", original_close)
        _close_recorded_lock_descriptors(
            [
                guard_read,
                guard_write,
                runtime_fd,
                runtime_write,
                runs_fd,
                runs_write,
                root_fd,
                root_write,
                reports_fd,
                reports_write,
                file_fd,
                file_write,
            ],
            original_close,
        )


def test_retained_root_discard_attempts_all_closes_and_preserves_first_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches retained-root teardown silently dropping a descriptor close error."""

    first_file_fd, first_file_write = os.pipe()
    second_file_fd, second_file_write = os.pipe()
    reports_fd, reports_write = os.pipe()
    root_fd, root_write = os.pipe()
    runs_fd, runs_write = os.pipe()
    runtime_fd, runtime_write = os.pipe()
    retained = object.__new__(_RetainedFinalRootVerification)
    retained._files = (
        ("request.json", first_file_fd, os.fstat(first_file_fd), b"{}"),
        ("seal.json", second_file_fd, os.fstat(second_file_fd), b"{}"),
    )
    retained._reports_fd = reports_fd
    retained._root_fd = root_fd
    retained._runs_fd = runs_fd
    retained._runtime_fd = runtime_fd
    original_close = materializer_module.os.close
    attempted: list[int] = []
    close_failed = False

    def fail_first_file_once(descriptor: int) -> None:
        nonlocal close_failed
        attempted.append(descriptor)
        if not close_failed and descriptor == first_file_fd:
            close_failed = True
            raise OSError(errno.EIO, "injected retained file close failure")
        original_close(descriptor)

    monkeypatch.setattr(materializer_module.os, "close", fail_first_file_once)
    try:
        with pytest.raises(OSError) as observed:
            retained._discard()

        assert observed.value.errno == errno.EIO
        assert attempted == [
            first_file_fd,
            second_file_fd,
            reports_fd,
            root_fd,
            runs_fd,
            runtime_fd,
        ]
        assert retained._files == ()
        assert retained._reports_fd == -1
        assert retained._root_fd == -1
        assert retained._runs_fd == -1
        assert retained._runtime_fd == -1
        for descriptor in (second_file_fd, reports_fd, root_fd, runs_fd, runtime_fd):
            with pytest.raises(OSError) as closed:
                os.fstat(descriptor)
            assert closed.value.errno == errno.EBADF
    finally:
        monkeypatch.setattr(materializer_module.os, "close", original_close)
        _close_recorded_lock_descriptors(
            [
                first_file_fd,
                first_file_write,
                second_file_fd,
                second_file_write,
                reports_fd,
                reports_write,
                root_fd,
                root_write,
                runs_fd,
                runs_write,
                runtime_fd,
                runtime_write,
            ],
            original_close,
        )


def test_cleanup_only_rollback_denial_releases_flock_before_propagating(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches immediate cleanup re-raise before the process flock is released."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_cleanup_rollback")
    original_open = ControlStore._open_verified_publication_window
    original_flock = materializer_module.fcntl.flock
    source_lock_descriptors: list[int] = []
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def deny_rollback(
        action: int,
        argument1: str | None,
        _argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action == sqlite3.SQLITE_TRANSACTION and argument1 == "ROLLBACK":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    def open_then_deny_rollback(
        current_store: ControlStore,
        *,
        preparation: TerminalPreparation,
    ) -> object:
        opened = original_open(current_store, preparation=preparation)
        current_store._connection.set_authorizer(deny_rollback)
        return opened

    def return_without_commit(_store: ControlStore, *, proof: object) -> TerminalPublication:
        assert type(proof) is _VerifiedRootProof
        return TerminalPublication(
            run_id=preparation.run_id,
            state=preparation.terminal_state,
            state_version=preparation.terminal_state_version,
            event=preparation.event,
            audit_intent=preparation.audit_intent,
            seal_digest="0" * 64,
            published_at_ns=0,
            materialized_event_seq=preparation.event.seq,
            materialized_audit_seq=preparation.audit_intent.audit_seq,
        )

    def note_source_lock(descriptor: int, operation: int) -> None:
        original_flock(descriptor, operation)
        if operation == materializer_module.fcntl.LOCK_EX:
            source_lock_descriptors.append(descriptor)

    monkeypatch.setattr(ControlStore, "_open_verified_publication_window", open_then_deny_rollback)
    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", return_without_commit)
    monkeypatch.setattr(materializer_module.fcntl, "flock", note_source_lock)
    observed: BaseException | None = None
    flock_available: bool | None = None
    try:
        try:
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )
        except BaseException as error:
            observed = error

        assert isinstance(observed, sqlite3.DatabaseError)
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            store._connection.execute("SELECT 1")
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        flock_available = _external_flock_is_available(runtime / ".run-publish.lock")
        assert flock_available is True
    finally:
        contender.close()
        if flock_available is not True:
            _close_recorded_lock_descriptors(source_lock_descriptors, transactions_module.os.close)
        try:
            store._connection.set_authorizer(None)
        except sqlite3.ProgrammingError:
            pass
        store.close()


def test_corrupted_active_window_still_releases_writer_before_primary_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a damaged owner window preventing fail-safe writer cleanup."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_corrupt_window")
    original_open = ControlStore._open_verified_publication_window
    captured: list[tuple[_VerifiedPublicationWindow, object]] = []
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def open_then_corrupt(
        current_store: ControlStore,
        *,
        preparation: TerminalPreparation,
    ) -> object:
        opened = original_open(current_store, preparation=preparation)
        if type(opened) is _VerifiedPublicationWindow:
            original_nonce = opened._nonce
            opened._nonce = object()
            captured.append((opened, original_nonce))
        return opened

    def raise_primary(_store: ControlStore, *, proof: object) -> object:
        assert type(proof) is _VerifiedRootProof
        raise KeyboardInterrupt("injected publisher process exit")

    monkeypatch.setattr(ControlStore, "_open_verified_publication_window", open_then_corrupt)
    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", raise_primary)
    try:
        with pytest.raises(KeyboardInterrupt):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )

        assert len(captured) == 1
        assert captured[0][0]._active is False
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        assert _external_flock_is_available(runtime / ".run-publish.lock") is True
    finally:
        for window, nonce in captured:
            window._nonce = nonce
            if store._verified_publication_window is window:
                store._discard_verified_publication_window(window)
        contender.close()
        store.close()


def test_replaced_active_window_pointer_still_releases_real_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches a replaced owner pointer stranding the authenticated writer window."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_replaced_window")
    original_open = ControlStore._open_verified_publication_window
    captured: list[tuple[_VerifiedPublicationWindow, _VerifiedPublicationWindow]] = []
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")

    def open_then_replace(
        current_store: ControlStore,
        *,
        preparation: TerminalPreparation,
    ) -> object:
        opened = original_open(current_store, preparation=preparation)
        if type(opened) is _VerifiedPublicationWindow:
            forged = object.__new__(_VerifiedPublicationWindow)
            forged._authority = current_store._publication_authority
            forged._nonce = object()
            forged._active = True
            current_store._verified_publication_window = forged
            captured.append((opened, forged))
        return opened

    def raise_primary(_store: ControlStore, *, proof: object) -> object:
        assert type(proof) is _VerifiedRootProof
        raise KeyboardInterrupt("injected publisher process exit")

    monkeypatch.setattr(ControlStore, "_open_verified_publication_window", open_then_replace)
    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", raise_primary)
    try:
        with pytest.raises(KeyboardInterrupt):
            CanonicalMaterializer(store=store, runtime_root=runtime).materialize_and_publish(
                preparation=preparation
            )

        assert len(captured) == 1
        real_window, _forged = captured[0]
        assert real_window._active is False
        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
        assert _external_flock_is_available(runtime / ".run-publish.lock") is True
    finally:
        for real_window, forged in captured:
            if real_window._active:
                store._verified_publication_window = real_window
                store._discard_verified_publication_window(real_window)
            elif store._verified_publication_window is forged:
                store._verified_publication_window = None
            forged._active = False
        contender.close()
        store.close()


def test_post_begin_process_exit_rolls_back_the_unissued_writer_window(tmp_path: Path) -> None:
    """Catches a real BEGIN IMMEDIATE escaping before its rollback scope exists."""

    initial, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_post_begin_exit")
    database_path = runtime / "control.sqlite"
    initial.close()
    connection = sqlite3.connect(
        database_path,
        factory=_InterruptAfterBeginConnection,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA busy_timeout = 5000")
    store = ControlStore(connection)
    contender = sqlite3.connect(database_path)
    contender.execute("PRAGMA busy_timeout = 0")
    try:
        with pytest.raises(KeyboardInterrupt, match="post-BEGIN"):
            store._open_verified_publication_window(preparation=preparation)

        assert store._verified_publication_window is None
        assert store._connection.in_transaction is False
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        assert not (runtime / "runs" / preparation.run_id).exists()
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        contender.close()
        try:
            if store._connection.in_transaction:
                store._connection.rollback()
        finally:
            store.close()


def test_window_open_rollback_denial_preserves_read_error_and_releases_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches writer-window setup leaking a denied rollback after its truth read fails."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_open_rollback_denied")
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")
    original_read = registry_module.read_terminal_preparation

    def fail_authoritative_read(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        event_id_factory: object,
    ) -> TerminalPreparation | None:
        if connection is store._connection and connection.in_transaction:
            raise _WindowOpenFailure("injected writer-window truth read failure")
        return original_read(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,  # type: ignore[arg-type]
        )

    def deny_rollback(
        action: int,
        argument1: str | None,
        _argument2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action == sqlite3.SQLITE_TRANSACTION and argument1 == "ROLLBACK":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    monkeypatch.setattr(registry_module, "read_terminal_preparation", fail_authoritative_read)
    store._connection.set_authorizer(deny_rollback)
    try:
        with pytest.raises(_WindowOpenFailure, match="truth read failure"):
            store._open_verified_publication_window(preparation=preparation)

        assert store._verified_publication_window is None
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            store._connection.execute("SELECT 1")
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        contender.close()
        try:
            store._connection.set_authorizer(None)
        except sqlite3.ProgrammingError:
            pass
        try:
            if store._connection.in_transaction:
                store._connection.rollback()
        except sqlite3.ProgrammingError:
            pass
        store.close()


def test_authoritative_writer_read_is_transactional_and_blocks_other_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches doing the final preparation read outside the held SQLite writer."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_writer_read")
    contender = sqlite3.connect(runtime / "control.sqlite")
    contender.execute("PRAGMA busy_timeout = 0")
    original_read = registry_module.read_terminal_preparation
    observed = False

    def require_writer_read(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        event_id_factory: object,
    ) -> TerminalPreparation | None:
        nonlocal observed
        prepared = original_read(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,  # type: ignore[arg-type]
        )
        if connection is store._connection and connection.in_transaction and not observed:
            assert connection.in_transaction is True
            with pytest.raises(sqlite3.OperationalError, match="locked|busy"):
                contender.execute("BEGIN IMMEDIATE")
            observed = True
        return prepared

    monkeypatch.setattr(registry_module, "read_terminal_preparation", require_writer_read)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)

        assert observed is True
        assert isinstance(result, TerminalPublication)
        contender.execute("BEGIN IMMEDIATE")
        contender.rollback()
    finally:
        contender.close()
        store.close()


def test_first_post_rename_durability_error_requires_recovery_without_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches recording a retry after the no-replace rename has already succeeded."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_post_rename_fsync")
    original_rename = materializer_module._darwin_rename_no_replace
    original_fsync = materializer_module.os.fsync
    renamed = False

    def mark_rename(*args: object) -> None:
        nonlocal renamed
        original_rename(*args)  # type: ignore[arg-type]
        renamed = True

    def fail_only_after_rename(_descriptor: int) -> None:
        if renamed:
            raise OSError("injected post-rename fsync failure")
        original_fsync(_descriptor)

    monkeypatch.setattr(materializer_module, "_darwin_rename_no_replace", mark_rename)
    monkeypatch.setattr(materializer_module.os, "fsync", fail_only_after_rename)
    try:
        with pytest.raises(RenamedRootRecoveryRequired, match="STA-26 recovery"):
            Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        current = store.terminal_preparation(run_id=preparation.run_id)
        assert current is not None and current.failure_attempt_count == 0
        assert store.terminal_finalization(run_id=preparation.run_id) is None
        root = runtime / "runs" / preparation.run_id
        assert root.is_dir() and stat.S_IMODE(root.stat().st_mode) == 0o500
        assert (
            store._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
    finally:
        monkeypatch.setattr(materializer_module.os, "fsync", original_fsync)
        store.close()


def test_final_root_reverification_is_a_deterministic_seal_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches leaving a post-rename root mismatch at MATERIALIZATION."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_seal_stage")
    original_verify = CanonicalMaterializer._verify_projection_root

    def reject_final_root(materializer: CanonicalMaterializer, **kwargs: object) -> None:
        if kwargs["root_name"] == preparation.run_id:
            raise MaterializationError("injected final root mismatch")
        original_verify(materializer, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(CanonicalMaterializer, "_verify_projection_root", reject_final_root)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "SEAL"
    finally:
        store.close()


def test_private_proof_conflict_is_a_deterministic_publication_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches leaking a private proof/preparation conflict from Finalizer."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_publication_stage")

    def conflict_publication(*_args: object, **_kwargs: object) -> object:
        raise TerminalPublicationConflict("injected private proof conflict")

    monkeypatch.setattr(ControlStore, "_publish_verified_terminal", conflict_publication)
    try:
        result = Finalizer(store=store, runtime_root=runtime).finalize(preparation.run_id)
        assert isinstance(result, UnverifiedTerminalPublication)
        assert result.fault.stage == "PUBLICATION"
    finally:
        store.close()


def test_two_store_connections_converge_to_one_finalization_identity(tmp_path: Path) -> None:
    """Catches finalizers that duplicate the terminal event or sealed identity."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_finalizer_race")
    database_path = runtime / "control.sqlite"
    store.close()

    def finalize_once() -> object:
        connection = ControlStore.open(database_path)
        try:
            return Finalizer(store=connection, runtime_root=runtime).finalize(preparation.run_id)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = tuple(executor.map(lambda _unused: finalize_once(), range(2)))
    verify = ControlStore.open(database_path)
    try:
        assert first == second
        assert verify.terminal_finalization(run_id=preparation.run_id) == first
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


def test_child_exit_after_final_reverify_leaves_a_non_public_recovery_root(tmp_path: Path) -> None:
    """Catches catching a post-rename process exit or publishing before reverify."""

    store, runtime, preparation = _prepared_no_spawn(tmp_path, run_id="bt_renamed_crash")
    database_path = runtime / "control.sqlite"
    store.close()
    process = multiprocessing.get_context("spawn").Process(
        target=_exit_before_publication,
        args=(database_path, runtime, preparation.run_id),
    )
    process.start()
    process.join(timeout=15)
    assert process.exitcode == 91

    verify = ControlStore.open(database_path)
    root = runtime / "runs" / preparation.run_id
    try:
        assert root.is_dir()
        assert stat.S_IMODE(root.stat().st_mode) == 0o500
        assert verify.terminal_finalization(run_id=preparation.run_id) is None
        assert verify.run(preparation.run_id).state is RunState.FINALIZING
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM events WHERE run_id = ? AND type IN "
                "('run.completed', 'run.failed', 'run.cancelled')",
                (preparation.run_id,),
            ).fetchone()[0]
            == 0
        )
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM seals WHERE run_id = ?", (preparation.run_id,)
            ).fetchone()[0]
            == 0
        )
        assert (
            verify._connection.execute(
                "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?",
                (preparation.run_id,),
            ).fetchone()[0]
            == 0
        )
        with pytest.raises(RenamedRootRecoveryRequired, match="STA-26 recovery"):
            Finalizer(store=verify, runtime_root=runtime).finalize(preparation.run_id)
        current = verify.terminal_preparation(run_id=preparation.run_id)
        assert current is not None
        assert current.failure_attempt_count == 0
    finally:
        verify.close()


def _prepared_no_spawn(
    tmp_path: Path,
    *,
    run_id: str,
) -> tuple[ControlStore, Path, TerminalPreparation]:
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    (runtime / "runs").mkdir(mode=0o700)
    store = ControlStore.open(runtime / "control.sqlite", clock=MutableClock())
    _seed_no_spawn_finalizing(store, run_id, tmp_path=tmp_path)
    preparation = store.prepare_terminal(run_id=run_id)
    run = store.run(run_id)
    assert run.input_manifest_bytes is not None
    assert preparation.outcome.outcome.stderr_size_bytes == 0
    staging_parent = runtime / "staging"
    staging_parent.mkdir(mode=0o700)
    staging = staging_parent / run_id
    staging.mkdir(mode=0o700)
    _write_private(staging / "input-manifest.json", run.input_manifest_bytes)
    _write_private(staging / "runner-exit.json", preparation.outcome.outcome_bytes)
    _write_private(staging / "stderr.txt", b"")
    return store, runtime, preparation


def _write_private(path: Path, payload: bytes) -> None:
    path.write_bytes(payload)
    path.chmod(0o600)


def _exit_before_publication(database_path: Path, runtime: Path, run_id: str) -> None:
    store = ControlStore.open(database_path)

    def terminate_publication(*_args: object, **_kwargs: object) -> object:
        os._exit(91)

    ControlStore._publish_verified_terminal = terminate_publication
    Finalizer(store=store, runtime_root=runtime).finalize(run_id)
