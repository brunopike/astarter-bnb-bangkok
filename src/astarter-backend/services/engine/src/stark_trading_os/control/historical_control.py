"""Simulation-only historical authority, shared by internal and opt-in HTTP callers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from stark_trading_os.control.historical_configuration_service import HistoricalConfigurationService
from stark_trading_os.control.historical_finalizer import HistoricalFinalizer
from stark_trading_os.control.historical_preflight import (
    HistoricalPreflightInvalid,
    HistoricalPreflightReceiptV2,
    HistoricalPreflightService,
)
from stark_trading_os.control.historical_supervisor import HistoricalRunnerSupervisor
from stark_trading_os.control.historical_terminal import HistoricalTerminalPublication
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.control.run_contract import RunContractKind, require_historical_contract
from stark_trading_os.control.supervisor import SupervisorError
from stark_trading_os.control.transactions import PersistedCancelRequest
from stark_trading_os.domain.models import RunState


@dataclass(frozen=True)
class HistoricalControlResult:
    run_id: str
    state: RunState
    publication: HistoricalTerminalPublication | None
    pending_reason: Literal["OWNED_PROCESS_PENDING", "EVIDENCE_NOT_ANCHORED"] | None


class HistoricalControl:
    """Composition only: no replacement lifecycle, process claim, or transaction authority."""

    def __init__(
        self,
        *,
        store: ControlStore,
        configurations: HistoricalConfigurationService,
        runtime_root: Path,
        python_executable: Path,
        runner_cwd: Path,
    ) -> None:
        if (
            type(store) is not ControlStore
            or type(configurations) is not HistoricalConfigurationService
            or configurations._store is not store
            or configurations._runtime_root != Path(runtime_root)
        ):
            raise ValueError("HISTORICAL_CONTROL_CONFIGURATION_INVALID")
        self._store = store
        self._preflights = HistoricalPreflightService(
            store=store, configurations=configurations, clock=store._clock
        )
        self._supervisor = HistoricalRunnerSupervisor(
            control=store,
            runtime_root=runtime_root,
            python_executable=python_executable,
            runner_cwd=runner_cwd,
            clock=store._clock,
        )
        self._finalizer = HistoricalFinalizer(store=store, runtime_root=runtime_root)

    def preflight(
        self, *, configuration_id: str, idempotency_key: str
    ) -> HistoricalPreflightReceiptV2:
        return self._preflights.preflight(
            configuration_id=configuration_id, idempotency_key=idempotency_key
        )

    async def execute(
        self, *, preflight_id: str, request_sha256: str, idempotency_key: str
    ) -> HistoricalControlResult:
        reservation = self.reserve(
            preflight_id=preflight_id,
            request_sha256=request_sha256,
            idempotency_key=idempotency_key,
        )
        return await self.run_reserved(reservation.run_id)

    def reserve(
        self, *, preflight_id: str, request_sha256: str, idempotency_key: str
    ) -> RunReservation:
        """Durably accept one command without starting a child or staging files."""
        return self._preflights._consume_ready_for_control(
            preflight_id, request_sha256, idempotency_key
        )

    async def run_reserved(self, run_id: str) -> HistoricalControlResult:
        """Execute only the original, validated, consumed server-side input."""
        record = self._preflights.record_for_run(run_id)
        reservation = self._preflights._reservation(record)
        current = self._store.run(run_id)
        require_historical_contract(current.contract_kind)
        if self._store.historical_runner_outcome(run_id) is None:
            if current.state is RunState.QUEUED and self._store.runner_process(run_id) is None:
                await self._supervisor.run(reservation)
            # A replay must not kill/recover someone else's currently owned child.
            if self._store.historical_runner_outcome(run_id) is None:
                return self._pending(run_id, "OWNED_PROCESS_PENDING")
        if self._finalizer.preparation(run_id) is None:
            # A committed outcome can precede runner-exit.pending promotion.
            # Recover only that existing observation before normal preparation.
            await self._supervisor.recover_one(run_id)
        publication = self._finalizer.finalize(run_id)
        return HistoricalControlResult(run_id, publication.state, publication, None)

    def finalize_clean_cancel(self, decision: PersistedCancelRequest) -> None:
        if type(decision) is not PersistedCancelRequest:
            raise TypeError("Clean cancellation requires an exact persisted decision.")
        if decision.response.run_id is None:
            raise HistoricalPreflightInvalid()
        self._preflights.record_for_run(decision.response.run_id)
        self._supervisor.finalize_clean_cancel(decision)

    async def recover_one(self, run_id: str) -> HistoricalControlResult:
        current = self._store.run(run_id)
        require_historical_contract(current.contract_kind)
        if current.state in {
            RunState.QUEUED,
            RunState.RUNNING,
            RunState.CANCEL_REQUESTED,
            RunState.CANCEL_PENDING,
        }:
            try:
                await self._supervisor.recover_one(run_id)
            except SupervisorError as error:
                if str(error) != "PROCESS_GROUP_UNRESOLVED":
                    raise
                return self._pending(run_id, "OWNED_PROCESS_PENDING")
        if self._store.historical_runner_outcome(run_id) is None:
            return self._pending(run_id, "OWNED_PROCESS_PENDING")
        if self._finalizer.preparation(run_id) is None:
            # Complete the supervisor's durable exit handoff without creating
            # an artifact anchor; only normal execute may prepare new evidence.
            await self._supervisor.recover_one(run_id)
        publication = self._finalizer.recover_one(run_id)
        if publication is None:
            return self._pending(run_id, "EVIDENCE_NOT_ANCHORED")
        return HistoricalControlResult(run_id, publication.state, publication, None)

    def read_artifact(self, *, run_id: str, relative_path: str) -> bytes:
        return self._finalizer.read_artifact(run_id=run_id, relative_path=relative_path)

    def _pending(
        self, run_id: str, reason: Literal["OWNED_PROCESS_PENDING", "EVIDENCE_NOT_ANCHORED"]
    ) -> HistoricalControlResult:
        run = self._store.run(run_id)
        if run.contract_kind is not RunContractKind.HISTORICAL_SMA_V2:
            raise ValueError("HISTORICAL_CONTROL_CONFIGURATION_INVALID")
        return HistoricalControlResult(run_id, run.state, None, reason)
