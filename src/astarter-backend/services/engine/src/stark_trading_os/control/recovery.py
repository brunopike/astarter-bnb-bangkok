"""STA-26 bounded terminal recovery and verified artifact access."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from stark_trading_os.audit.materializer import (
    CanonicalMaterializer,
    FinalizationAlreadyResolved,
    MaterializationError,
    RenamedRootRecoveryRequired,
    _legacy_artifact_path,
)
from stark_trading_os.control.finalizer import FinalizationRetryPending, Finalizer
from stark_trading_os.control.historical_finalizer import HistoricalFinalizer
from stark_trading_os.control.historical_terminal import HistoricalTerminalPublication
from stark_trading_os.control.registry import (
    ControlStore,
    FinalizationFailure,
    TerminalFinalization,
    TerminalIntegrityError,
    TerminalPreparation,
    TerminalPublication,
    UnverifiedTerminalPublication,
)
from stark_trading_os.control.run_contract import RunContractKind, require_probe_contract


class ArtifactAccessDenied(RuntimeError):
    """The requested run does not currently grant verified artifact access."""


class ArtifactIntegrityError(RuntimeError):
    """Persisted terminal authority or its immutable run root failed verification."""

    def __init__(self, artifact: str) -> None:
        self.artifact = artifact
        super().__init__(f"{artifact}: integrity verification failed.")


class FinalizationRecovery:
    """Recover persisted finalization work without accepting caller authority."""

    def __init__(self, *, store: ControlStore, runtime_root: Path) -> None:
        if type(store) is not ControlStore:
            raise TypeError("FinalizationRecovery requires an exact ControlStore.")
        runtime = Path(runtime_root)
        if not runtime.is_absolute():
            raise ValueError("runtime_root must be absolute.")
        self._store = store
        self._runtime_root = runtime
        self.pending_historical_run_ids: tuple[str, ...] = ()

    def recover(self) -> tuple[TerminalFinalization | HistoricalTerminalPublication, ...]:
        """Return terminal identities completed during this invocation."""

        recovered: list[TerminalFinalization | HistoricalTerminalPublication] = []
        materializer = CanonicalMaterializer(
            store=self._store,
            runtime_root=self._runtime_root,
        )
        finalizer = Finalizer(store=self._store, runtime_root=self._runtime_root)
        for run_id in self._store.recoverable_terminal_run_ids():
            if self._store.run(run_id).contract_kind is not RunContractKind.PROBE_V1:
                continue
            result: TerminalFinalization | None = None
            preparation = self._store.terminal_preparation(run_id=run_id)
            if preparation is not None and preparation.disposition == "NORMAL":
                try:
                    result = materializer.recover_renamed_and_publish(
                        preparation=preparation,
                    )
                except FinalizationAlreadyResolved as resolved:
                    result = resolved.result
                except MaterializationError as error:
                    result = self._record_materialization_failure(
                        run_id=run_id,
                        error=error,
                    )
                    if result is None:
                        continue
            if result is None:
                try:
                    result = finalizer.finalize(run_id)
                except (FinalizationRetryPending, RenamedRootRecoveryRequired):
                    continue
            if result is not None:
                recovered.append(result)
        # Explicit contract dispatch. A historical failure retains its original
        # anchor/files and must not stop compatible recoveries or become v1 bytes.
        historical = HistoricalFinalizer(store=self._store, runtime_root=self._runtime_root)
        pending: list[str] = []
        rows = self._store._connection.execute(
            "SELECT run_id FROM runs WHERE state='FINALIZING' "
            "AND contract_kind='HISTORICAL_SMA_V2' ORDER BY run_id"
        ).fetchall()
        for row in rows:
            run_id = row["run_id"]
            try:
                publication = historical.recover_one(run_id)
            except (ValueError, OSError):
                pending.append(run_id)
                continue
            if publication is None:
                pending.append(run_id)
            else:
                recovered.append(publication)
        self.pending_historical_run_ids = tuple(pending)
        return tuple(recovered)

    def read_artifact(self, *, run_id: str, relative_path: str) -> bytes:
        """Return one artifact only after a fresh complete verification."""

        if type(run_id) is not str or not run_id:
            raise ValueError("run_id must be a non-empty string.")
        if type(relative_path) is not str or not relative_path:
            raise ValueError("relative_path must be a non-empty string.")
        require_probe_contract(self._store.run(run_id).contract_kind)
        try:
            publication = self._store.terminal_finalization(run_id=run_id)
        except (sqlite3.Error, TerminalIntegrityError) as error:
            raise ArtifactIntegrityError("control.sqlite:terminal") from error
        if type(publication) is not TerminalPublication:
            raise ArtifactAccessDenied("Run evidence is not verified for artifact access.")
        payload = self.read_artifacts(
            publication=publication,
            relative_paths=(_legacy_artifact_path(relative_path),),
        )[0]
        if payload is None:
            raise ArtifactAccessDenied("relative_path is not in the verified run inventory.")
        return payload

    def read_artifacts(
        self,
        *,
        publication: TerminalPublication,
        relative_paths: tuple[str, ...],
    ) -> tuple[bytes | None, ...]:
        """Return one verified artifact bundle for an exact captured publication."""

        if type(publication) is not TerminalPublication:
            raise TypeError("Artifact reads require an exact TerminalPublication.")
        require_probe_contract(self._store.run(publication.run_id).contract_kind)
        try:
            return CanonicalMaterializer(
                store=self._store,
                runtime_root=self._runtime_root,
            ).read_verified_artifacts(
                publication=publication,
                relative_paths=relative_paths,
            )
        except MaterializationError as error:
            raise ArtifactIntegrityError(error.artifact or "<root>") from error
        except (sqlite3.Error, TerminalIntegrityError) as error:
            raise ArtifactIntegrityError("control.sqlite:terminal") from error

    def _record_materialization_failure(
        self,
        *,
        run_id: str,
        error: MaterializationError,
    ) -> TerminalFinalization | None:
        result = self._store.record_finalization_failure(
            run_id=run_id,
            failure=FinalizationFailure(
                deterministic=error.deterministic,
                stage=error.stage,
            ),
        )
        if type(result) is UnverifiedTerminalPublication:
            return result
        if type(result) is not TerminalPreparation:
            raise RuntimeError("recovery failure storage returned an invalid result")
        return None
