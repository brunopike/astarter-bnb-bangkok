"""Historical contract adapter over the existing owned-process supervisor core."""

from __future__ import annotations

import asyncio
from pathlib import Path

from stark_trading_os.audit.historical_input import parse_input_manifest_bytes
from stark_trading_os.control.historical_preflight import _record, _snapshot
from stark_trading_os.control.historical_process import (
    HistoricalRunnerOutcomeRecord,
    SupervisorExitV2,
    historical_exit_bytes,
    historical_exit_from_bytes,
    historical_identity,
)
from stark_trading_os.control.preflight import RunReservation
from stark_trading_os.control.process_identity import SupervisorExitV1
from stark_trading_os.control.run_contract import RunContractKind
from stark_trading_os.control.supervisor import (
    SupervisorError,
    _OwnedRunnerSupervisor,
    _ProtocolRead,
    _ProtocolReadError,
    _read_bounded_protocol,
    _stage_input_manifest_bytes,
)
from stark_trading_os.domain.historical_input import InputManifestV2
from stark_trading_os.domain.models import InputManifestV1
from stark_trading_os.runner.historical_protocol import (
    HistoricalRunnerIdentityV2,
    HistoricalRunnerSequenceValidator,
    RunnerOutcomeV2,
    parse_historical_protocol_line,
)
from stark_trading_os.runner.protocol import ProtocolError


class HistoricalRunnerSupervisor(_OwnedRunnerSupervisor):
    """Internal contract adapter; no historical execution route is exposed by HTTP."""

    _contract_kind = RunContractKind.HISTORICAL_SMA_V2

    def _parse_reserved_manifest(
        self, reservation: RunReservation, catalog_revision: str
    ) -> InputManifestV2:
        manifest = parse_input_manifest_bytes(
            reservation.input_manifest_bytes, expected_sha256=reservation.input_manifest_hash
        )
        connection = self._control._connection
        with _snapshot(connection):
            row = connection.execute(
                "SELECT preflight_id FROM historical_preflights WHERE run_id=?",
                (reservation.run_id,),
            ).fetchone()
            if row is None:
                raise SupervisorError("RESERVATION_INVALID")
            record = _record(connection, row["preflight_id"])
            if (
                record is None
                or record.consumed_at_ns is None
                or record.input_manifest_bytes != reservation.input_manifest_bytes
                or manifest.dataset.catalog_revision != catalog_revision
            ):
                raise SupervisorError("RESERVATION_INVALID")
        return manifest

    def _stage_input(self, reservation: RunReservation) -> Path:
        return _stage_input_manifest_bytes(runtime_root=self._runtime_root, reservation=reservation)

    def _runner_arguments(
        self, reservation: RunReservation, staging: Path, input_path: Path
    ) -> tuple[str, ...]:
        return (
            "-m",
            "stark_trading_os.runner.historical_main",
            "--run-id",
            reservation.run_id,
            "--staging-dir",
            str(staging),
            "--input-manifest",
            str(input_path),
            "--expected-input-sha256",
            reservation.input_manifest_hash,
        )

    def _environment_seed(self, manifest: InputManifestV1 | InputManifestV2) -> int:
        assert isinstance(manifest, InputManifestV2)
        # Historical cost contract has no stochastic fill model or strategy seed.
        # This only pins Python's hash ordering in the sanitized process environment.
        return 0

    def _identity(self, run_id: str) -> HistoricalRunnerIdentityV2:
        reservation = self._reservation_for_run(run_id)
        return historical_identity(
            run_id, reservation.input_manifest_bytes, reservation.input_manifest_hash
        )

    def _make_exit(self, **values: object) -> SupervisorExitV2:
        run_id = values.get("run_id")
        if type(run_id) is not str:
            raise SupervisorError("RESERVATION_INVALID")
        expected = self._identity(run_id)
        values.setdefault("identity", expected)
        outcome = SupervisorExitV2.model_validate(values)
        if outcome.identity != expected:
            raise SupervisorError("RESERVATION_INVALID")
        return outcome

    def _exit_bytes(self, outcome: SupervisorExitV1 | SupervisorExitV2) -> bytes:
        assert isinstance(outcome, SupervisorExitV2)
        return historical_exit_bytes(outcome)

    def _exit_from_bytes(self, raw: bytes) -> SupervisorExitV2:
        return historical_exit_from_bytes(raw)

    def _stored_outcome(self, run_id: str) -> HistoricalRunnerOutcomeRecord | None:
        return self._control.historical_runner_outcome(run_id)

    def _store_outcome(
        self, outcome: SupervisorExitV1 | SupervisorExitV2
    ) -> HistoricalRunnerOutcomeRecord:
        assert isinstance(outcome, SupervisorExitV2)
        return self._control.record_historical_runner_outcome(outcome)

    async def _read_protocol(
        self,
        stream: asyncio.StreamReader,
        *,
        reservation: RunReservation,
        manifest: InputManifestV1 | InputManifestV2,
        catalog_revision: str,
        failure: asyncio.Event,
    ) -> _ProtocolRead:
        assert isinstance(manifest, InputManifestV2)
        validator = HistoricalRunnerSequenceValidator(expected=self._identity(reservation.run_id))
        outcome: RunnerOutcomeV2 | None = None

        def accept_line(line: bytes) -> None:
            nonlocal outcome
            message = parse_historical_protocol_line(line)
            validator.accept(message)
            if isinstance(message, RunnerOutcomeV2):
                outcome = message

        total = await _read_bounded_protocol(stream, accept_line=accept_line, failure=failure)
        if outcome is None:
            raise _ProtocolReadError(
                "Historical child has no complete outcome.", raw_size_bytes=total
            )
        try:
            # Validate stream closure here; shared owner checks the actual OS exit code
            # before classifying or persisting a natural result.
            validator.finish(0 if outcome.result == "SUCCEEDED" else 1)
        except ProtocolError:
            raise _ProtocolReadError(
                "Historical child protocol is invalid.", raw_size_bytes=total
            ) from None
        return _ProtocolRead(outcome=outcome, raw_size_bytes=total)
