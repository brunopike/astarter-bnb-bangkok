"""Public single-writer control registry over the constrained SQLite schema."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable
from pathlib import Path

from stark_trading_os.control import historical_configurations as historical_configs
from stark_trading_os.control.database import (
    _verify_write_connection,
    open_control_database,
    verify_control_connection,
)
from stark_trading_os.control.historical_configuration_models import (
    HistoricalStrategyConfigurationVersionV2,
    HistoricalStrategyDraftV2,
)
from stark_trading_os.control.historical_process import (
    HistoricalRunnerOutcomeRecord,
    SupervisorExitV2,
)
from stark_trading_os.control.process_identity import (
    ProcessIdentityV1,
    RunnerOutcomeRecord,
    RunnerProcessRecord,
    SupervisorExitV1,
)
from stark_trading_os.control.strategy_configurations import (
    create_strategy_draft,
    publish_strategy_draft,
    read_run_strategy_configuration,
    read_strategy_configuration,
    read_strategy_configuration_versions,
    read_strategy_draft,
    read_strategy_drafts,
    update_strategy_draft,
)
from stark_trading_os.control.strategy_models import (
    ConfigurationInput,
    StrategyConfigurationVersion,
    StrategyDraft,
)
from stark_trading_os.control.transactions import (
    AuditIntent,
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogPublication,
    CatalogRecoveryBlocked,
    CatalogStorageFailed,
    Clock,
    ControlStoreError,
    ControlTransaction,
    EventCandidate,
    EventIdFactory,
    EventRejected,
    FinalizationFailure,
    FinalizationFaultRecord,
    IdempotencyCommand,
    IdempotencyConflict,
    IdempotentResponse,
    OutboxRecord,
    PersistedCancelRequest,
    PersistedEvent,
    PersistedTransition,
    PreflightReadyEvidence,
    PreflightSnapshot,
    RunEvidenceSnapshot,
    RunNotFound,
    RunSnapshot,
    TerminalEligibilityError,
    TerminalFinalization,
    TerminalIntegrityError,
    TerminalPreparation,
    TerminalPublication,
    TerminalPublicationConflict,
    UnverifiedTerminalPublication,
    VersionConflict,
    _append_event_transaction,
    _attach_runner_process_transaction,
    _claim_runner_process_transaction,
    _commit_transition_transaction,
    _execute_idempotent_transaction,
    _mark_catalog_integrity_failed_transaction,
    _mark_runner_kill_sent_transaction,
    _mark_runner_term_sent_transaction,
    _new_publication_authority,
    _prepare_catalog_publication_transaction,
    _prepare_terminal_transaction,
    _publish_catalog_publication_transaction,
    _publish_verified_terminal_transaction,
    _read_events,
    _record_finalization_failure_transaction,
    _record_runner_outcome_transaction,
    _request_runner_cancel_transaction,
    _reserve_run_transaction,
    _same_terminal_preparation,
    _VerifiedPublicationWindow,
    _VerifiedRootProof,
    read_audit_intents,
    read_catalog_publication,
    read_idempotent_response,
    read_pending_outbox,
    read_preflight,
    read_recoverable_active_runs,
    read_recoverable_catalog_publications,
    read_recoverable_clean_cancellations,
    read_recoverable_runner_processes,
    read_recoverable_terminal_run_ids,
    read_run,
    read_run_evidence_snapshot,
    read_runner_outcome,
    read_runner_process,
    read_terminal_finalization,
    read_terminal_preparation,
)
from stark_trading_os.domain.historical_input import SmaConfigurationInputV2
from stark_trading_os.domain.models import RunState

__all__ = [
    "AuditIntent",
    "CatalogConflict",
    "CatalogIntegrityFailed",
    "CatalogPublication",
    "CatalogRecoveryBlocked",
    "CatalogStorageFailed",
    "Clock",
    "ControlStore",
    "ControlStoreError",
    "ControlTransaction",
    "EventCandidate",
    "EventIdFactory",
    "EventRejected",
    "FinalizationFailure",
    "FinalizationFaultRecord",
    "IdempotencyCommand",
    "IdempotencyConflict",
    "IdempotentResponse",
    "OutboxRecord",
    "PersistedEvent",
    "PersistedCancelRequest",
    "PersistedTransition",
    "PreflightReadyEvidence",
    "PreflightSnapshot",
    "ProcessIdentityV1",
    "RunNotFound",
    "RunEvidenceSnapshot",
    "RunSnapshot",
    "RunnerOutcomeRecord",
    "RunnerProcessRecord",
    "SupervisorExitV1",
    "TerminalEligibilityError",
    "TerminalIntegrityError",
    "TerminalFinalization",
    "TerminalPreparation",
    "TerminalPublication",
    "TerminalPublicationConflict",
    "UnverifiedTerminalPublication",
    "VersionConflict",
]


class ControlStore:
    """Own one independent connection; every public mutation uses `BEGIN IMMEDIATE`."""

    def __init__(
        self,
        connection: sqlite3.Connection,
        *,
        clock: Clock | None = None,
        event_id_factory: EventIdFactory | None = None,
    ) -> None:
        verify_control_connection(connection)
        self._connection = connection
        self._clock = clock if clock is not None else time.time_ns
        self._event_id_factory = (
            event_id_factory if event_id_factory is not None else _default_event_id
        )
        self._publication_authority = _new_publication_authority()
        self._verified_publication_window: _VerifiedPublicationWindow | None = None

    @classmethod
    def open(
        cls,
        path: str | Path,
        *,
        clock: Clock | None = None,
        event_id_factory: EventIdFactory | None = None,
    ) -> ControlStore:
        return cls(
            open_control_database(path),
            clock=clock,
            event_id_factory=event_id_factory,
        )

    def close(self) -> None:
        active = self._verified_publication_window
        try:
            if active is not None:
                self._discard_verified_publication_window(active)
        finally:
            self._connection.close()

    def create_historical_strategy_draft(
        self, *, draft_id: str, configuration: SmaConfigurationInputV2,
    ) -> HistoricalStrategyDraftV2:
        return historical_configs.create_historical_strategy_draft(
            self._connection, clock=self._clock, draft_id=draft_id, configuration=configuration
        )

    def historical_strategy_draft(self, draft_id: str) -> HistoricalStrategyDraftV2 | None:
        return historical_configs.read_historical_strategy_draft(self._connection, draft_id)

    def historical_strategy_drafts(self) -> tuple[HistoricalStrategyDraftV2, ...]:
        return historical_configs.read_historical_strategy_drafts(self._connection)

    def historical_strategy_draft_page(
        self, *, after_id: str | None, limit: int,
    ) -> tuple[tuple[HistoricalStrategyDraftV2, ...], str | None]:
        return historical_configs.read_historical_strategy_draft_page(
            self._connection, after_id=after_id, limit=limit
        )

    def historical_strategy_configuration_page(
        self, *, after_id: str | None, limit: int,
    ) -> tuple[tuple[HistoricalStrategyConfigurationVersionV2, ...], str | None]:
        return historical_configs.read_historical_strategy_configuration_page(
            self._connection, after_id=after_id, limit=limit
        )

    def update_historical_strategy_draft(
        self, *, draft_id: str, expected_revision: int, configuration: SmaConfigurationInputV2,
    ) -> HistoricalStrategyDraftV2:
        return historical_configs.update_historical_strategy_draft(
            self._connection, clock=self._clock, draft_id=draft_id,
            expected_revision=expected_revision, configuration=configuration,
        )

    def publish_historical_strategy_draft(
        self, *, draft_id: str, expected_revision: int, configuration_id: str,
    ) -> HistoricalStrategyConfigurationVersionV2:
        return historical_configs.publish_historical_strategy_draft(
            self._connection, clock=self._clock, draft_id=draft_id,
            expected_revision=expected_revision, configuration_id=configuration_id,
        )

    def historical_strategy_configuration(
        self, configuration_id: str,
    ) -> HistoricalStrategyConfigurationVersionV2 | None:
        return historical_configs.read_historical_strategy_configuration(
            self._connection, configuration_id
        )

    def historical_strategy_configuration_versions(
        self, draft_id: str,
    ) -> tuple[HistoricalStrategyConfigurationVersionV2, ...]:
        return historical_configs.read_historical_strategy_configuration_versions(
            self._connection, draft_id
        )

    def create_strategy_draft(
        self,
        *,
        draft_id: str,
        configuration: ConfigurationInput,
    ) -> StrategyDraft:
        return create_strategy_draft(
            self._connection,
            clock=self._clock,
            draft_id=draft_id,
            configuration=configuration,
        )

    def strategy_drafts(self) -> tuple[StrategyDraft, ...]:
        return read_strategy_drafts(self._connection)

    def strategy_draft(self, draft_id: str) -> StrategyDraft | None:
        return read_strategy_draft(self._connection, draft_id)

    def update_strategy_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration: ConfigurationInput,
    ) -> StrategyDraft:
        return update_strategy_draft(
            self._connection,
            clock=self._clock,
            draft_id=draft_id,
            expected_revision=expected_revision,
            configuration=configuration,
        )

    def publish_strategy_draft(
        self,
        *,
        draft_id: str,
        expected_revision: int,
        configuration_id: str,
    ) -> StrategyConfigurationVersion:
        return publish_strategy_draft(
            self._connection,
            clock=self._clock,
            draft_id=draft_id,
            expected_revision=expected_revision,
            configuration_id=configuration_id,
        )

    def strategy_configuration(
        self, configuration_id: str
    ) -> StrategyConfigurationVersion | None:
        return read_strategy_configuration(self._connection, configuration_id)

    def strategy_configuration_versions(
        self, draft_id: str
    ) -> tuple[StrategyConfigurationVersion, ...]:
        return read_strategy_configuration_versions(self._connection, draft_id)

    def run_strategy_configuration(
        self, run_id: str
    ) -> StrategyConfigurationVersion | None:
        return read_run_strategy_configuration(self._connection, run_id)

    def reserve_run(
        self,
        *,
        run_id: str,
        input_manifest_bytes: bytes | None = None,
        input_manifest_hash: str | None = None,
        catalog_revision: str | None = None,
        catalog_inventory_hash: str | None = None,
    ) -> RunSnapshot:
        return _reserve_run_transaction(
            self._connection,
            clock=self._clock,
            run_id=run_id,
            input_manifest_bytes=input_manifest_bytes,
            input_manifest_hash=input_manifest_hash,
            catalog_revision=catalog_revision,
            catalog_inventory_hash=catalog_inventory_hash,
        )

    def catalog_publication(self, catalog_revision: str) -> CatalogPublication | None:
        try:
            return read_catalog_publication(self._connection, catalog_revision)
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def recoverable_catalog_publications(self) -> tuple[CatalogPublication, ...]:
        try:
            return read_recoverable_catalog_publications(self._connection)
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def prepare_catalog_publication(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
    ) -> CatalogPublication:
        try:
            return _prepare_catalog_publication_transaction(
                self._connection,
                clock=self._clock,
                catalog_revision=catalog_revision,
                fixture_id=fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=staging_identity,
            )
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def publish_catalog_publication(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
        audit_intent_bytes: bytes,
    ) -> CatalogPublication:
        try:
            return _publish_catalog_publication_transaction(
                self._connection,
                clock=self._clock,
                catalog_revision=catalog_revision,
                fixture_id=fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=staging_identity,
                audit_intent_bytes=audit_intent_bytes,
            )
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def mark_catalog_integrity_failed(
        self,
        *,
        catalog_revision: str,
        fixture_id: str,
        inventory_hash: str,
        publication_bytes: bytes,
        staging_identity: str,
    ) -> CatalogPublication:
        try:
            return _mark_catalog_integrity_failed_transaction(
                self._connection,
                catalog_revision=catalog_revision,
                fixture_id=fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=staging_identity,
            )
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def commit_transition(
        self,
        *,
        run_id: str,
        expected_version: int,
        target: RunState,
        candidate: EventCandidate,
    ) -> PersistedTransition:
        return _commit_transition_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            run_id=run_id,
            expected_version=expected_version,
            target=target,
            candidate=candidate,
        )

    def append_event(
        self,
        *,
        run_id: str,
        expected_version: int,
        candidate: EventCandidate,
    ) -> PersistedTransition:
        return _append_event_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            run_id=run_id,
            expected_version=expected_version,
            candidate=candidate,
        )

    def execute_idempotent(
        self,
        *,
        command: IdempotencyCommand,
        handler: Callable[[ControlTransaction], IdempotentResponse],
    ) -> IdempotentResponse:
        return _execute_idempotent_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            command=command,
            handler=handler,
        )

    def idempotent_response(self, command: IdempotencyCommand) -> IdempotentResponse | None:
        """Return only an exact stored command response; never accepts SQL or filters."""
        try:
            _verify_write_connection(self._connection)
            return read_idempotent_response(self._connection, command)
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def preflight(self, preflight_id: str) -> PreflightSnapshot | None:
        try:
            _verify_write_connection(self._connection)
            return read_preflight(self._connection, preflight_id)
        except sqlite3.Error as error:
            raise CatalogStorageFailed from error

    def run(self, run_id: str) -> RunSnapshot:
        return read_run(self._connection, run_id)

    def run_evidence_snapshot(self, run_id: str) -> RunEvidenceSnapshot:
        return read_run_evidence_snapshot(
            self._connection,
            run_id=run_id,
            event_id_factory=self._event_id_factory,
        )

    def events(self, run_id: str) -> tuple[PersistedEvent, ...]:
        return _read_events(self._connection, run_id, visible_only=True)

    def audit_intents(self, run_id: str) -> tuple[AuditIntent, ...]:
        return read_audit_intents(self._connection, run_id)

    def pending_outbox(self, run_id: str) -> tuple[OutboxRecord, ...]:
        return read_pending_outbox(self._connection, run_id)

    def claim_runner_process(
        self,
        *,
        run_id: str,
        spawn_nonce: str,
    ) -> RunnerProcessRecord:
        return _claim_runner_process_transaction(
            self._connection,
            run_id=run_id,
            spawn_nonce=spawn_nonce,
        )

    def attach_runner_process(
        self,
        *,
        identity: ProcessIdentityV1,
    ) -> RunnerProcessRecord:
        return _attach_runner_process_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            identity=identity,
        )

    def request_runner_cancel(
        self,
        *,
        command: IdempotencyCommand,
        reason: str,
    ) -> PersistedCancelRequest:
        return _request_runner_cancel_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            command=command,
            reason=reason,
        )

    def mark_runner_term_sent(self, *, run_id: str, spawn_nonce: str) -> bool:
        return _mark_runner_term_sent_transaction(
            self._connection,
            run_id=run_id,
            spawn_nonce=spawn_nonce,
        )

    def mark_recovery_term_sent(self, *, run_id: str, spawn_nonce: str) -> bool:
        return _mark_runner_term_sent_transaction(
            self._connection,
            run_id=run_id,
            spawn_nonce=spawn_nonce,
            recovery=True,
        )

    def mark_runner_kill_sent(self, *, run_id: str, spawn_nonce: str) -> bool:
        return _mark_runner_kill_sent_transaction(
            self._connection,
            run_id=run_id,
            spawn_nonce=spawn_nonce,
        )

    def mark_recovery_kill_sent(self, *, run_id: str, spawn_nonce: str) -> bool:
        return _mark_runner_kill_sent_transaction(
            self._connection,
            run_id=run_id,
            spawn_nonce=spawn_nonce,
            recovery=True,
        )

    def record_runner_outcome(self, outcome: SupervisorExitV1) -> RunnerOutcomeRecord:
        return _record_runner_outcome_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            outcome=outcome,
        )

    def record_historical_runner_outcome(
        self, outcome: SupervisorExitV2
    ) -> HistoricalRunnerOutcomeRecord:
        from stark_trading_os.control.transactions import (
            _record_historical_runner_outcome_transaction,
        )
        return _record_historical_runner_outcome_transaction(
            self._connection, clock=self._clock, event_id_factory=self._event_id_factory,
            outcome=outcome,
        )

    def historical_runner_outcome(self, run_id: str) -> HistoricalRunnerOutcomeRecord | None:
        from stark_trading_os.control.historical_outcomes import read_historical_runner_outcome
        return read_historical_runner_outcome(self._connection, run_id)

    def runner_process(self, run_id: str) -> RunnerProcessRecord | None:
        return read_runner_process(self._connection, run_id)

    def runner_outcome(self, run_id: str) -> RunnerOutcomeRecord | None:
        return read_runner_outcome(self._connection, run_id)

    def prepare_terminal(self, *, run_id: str) -> TerminalPreparation:
        return _prepare_terminal_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            run_id=run_id,
        )

    def terminal_preparation(self, *, run_id: str) -> TerminalPreparation | None:
        return read_terminal_preparation(
            self._connection,
            run_id=run_id,
            event_id_factory=self._event_id_factory,
        )

    def terminal_finalization(self, *, run_id: str) -> TerminalFinalization | None:
        return read_terminal_finalization(
            self._connection,
            run_id=run_id,
            event_id_factory=self._event_id_factory,
        )

    def _open_verified_publication_window(
        self,
        *,
        preparation: TerminalPreparation,
    ) -> _VerifiedPublicationWindow | TerminalFinalization:
        """Hold the sole SQLite writer from authoritative truth through commit."""

        if type(preparation) is not TerminalPreparation:
            raise TypeError("Verified publication requires an exact terminal preparation.")
        if self._verified_publication_window is not None or self._connection.in_transaction:
            raise TerminalPublicationConflict(
                "Nested verified publication writer windows are not permitted."
            )
        _verify_write_connection(self._connection)
        window: _VerifiedPublicationWindow | None = None
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            existing = read_terminal_finalization(
                self._connection,
                run_id=preparation.run_id,
                event_id_factory=self._event_id_factory,
            )
            if existing is not None:
                self._connection.rollback()
                return existing
            current = read_terminal_preparation(
                self._connection,
                run_id=preparation.run_id,
                event_id_factory=self._event_id_factory,
            )
            if (
                current is None
                or not _same_terminal_preparation(current, preparation)
                or current.disposition != "NORMAL"
            ):
                existing = read_terminal_finalization(
                    self._connection,
                    run_id=preparation.run_id,
                    event_id_factory=self._event_id_factory,
                )
                if existing is not None:
                    self._connection.rollback()
                    return existing
                raise TerminalPublicationConflict(
                    "Terminal preparation changed inside the publication writer window."
                )
            window = object.__new__(_VerifiedPublicationWindow)
            window._authority = self._publication_authority
            window._nonce = object()
            window._active = True
            self._publication_authority._register_window(
                window,
                nonce=window._nonce,
                preparation=preparation,
            )
            self._verified_publication_window = window
            return window
        except BaseException:
            if window is not None and self._verified_publication_window is window:
                try:
                    self._discard_verified_publication_window(window)
                except BaseException:
                    pass
            else:
                if window is not None:
                    self._publication_authority._discard_window(window)
                    window._active = False
                if self._connection.in_transaction:
                    try:
                        self._connection.rollback()
                    except BaseException:
                        try:
                            self._connection.close()
                        except BaseException:
                            pass
            raise

    def _discard_verified_publication_window(self, window: _VerifiedPublicationWindow) -> None:
        if type(window) is not _VerifiedPublicationWindow:
            raise TerminalPublicationConflict("Verified publication writer capability is invalid.")
        if not self._publication_authority._owns_window(window):
            sentinel = object()
            if (
                getattr(window, "_authority", sentinel) is self._publication_authority
                and getattr(window, "_active", sentinel) is False
            ):
                return
            self._publication_authority._require_window(window)
            raise TerminalPublicationConflict(
                "Verified publication writer capability is not active."
            )
        # The authority registry, rather than this mutable Store pointer or the
        # token fields, identifies the real writer for fail-safe teardown.
        rollback_error: BaseException | None = None
        try:
            if self._connection.in_transaction:
                self._connection.rollback()
        except BaseException as error:
            rollback_error = error
        finally:
            self._publication_authority._discard_window(window)
            window._active = False
            self._verified_publication_window = None
        if rollback_error is not None:
            try:
                self._connection.close()
            except BaseException:
                pass
            raise rollback_error

    def record_finalization_failure(
        self,
        *,
        run_id: str,
        failure: FinalizationFailure,
    ) -> TerminalPreparation | UnverifiedTerminalPublication:
        return _record_finalization_failure_transaction(
            self._connection,
            clock=self._clock,
            event_id_factory=self._event_id_factory,
            run_id=run_id,
            failure=failure,
        )

    def _publish_verified_terminal(
        self,
        *,
        proof: _VerifiedRootProof,
    ) -> TerminalPublication:
        # The locked materializer scope owns proof descriptors through flock release.
        try:
            window = self._verified_publication_window
            if window is None or not window._active:
                raise TerminalPublicationConflict(
                    "Verified publication requires an active store-owned writer window."
                )
            self._publication_authority._require_window(window)
            if not self._connection.in_transaction:
                raise TerminalPublicationConflict(
                    "Verified publication writer window is not active."
                )
            publication = _publish_verified_terminal_transaction(
                self._connection,
                clock=self._clock,
                event_id_factory=self._event_id_factory,
                proof=proof,
                authority=self._publication_authority,
                window=window,
            )
            self._connection.commit()
            self._publication_authority._discard_window(window)
            window._active = False
            self._verified_publication_window = None
            return publication
        except BaseException:
            window = self._verified_publication_window
            if window is not None:
                try:
                    self._discard_verified_publication_window(window)
                except BaseException:
                    pass
            raise

    def recoverable_runner_processes(self) -> tuple[RunnerProcessRecord, ...]:
        return read_recoverable_runner_processes(self._connection)

    def recoverable_active_runs(self) -> tuple[RunSnapshot, ...]:
        return read_recoverable_active_runs(self._connection)

    def recoverable_clean_cancellations(self) -> tuple[str, ...]:
        return read_recoverable_clean_cancellations(self._connection)

    def recoverable_terminal_run_ids(self) -> tuple[str, ...]:
        return read_recoverable_terminal_run_ids(self._connection)


def _default_event_id(run_id: str, seq: int) -> str:
    return f"evt_{run_id}_{seq:06d}"
