"""Atomic control-registry mutations built on one SQLite writer transaction."""

from __future__ import annotations

import fcntl
import os
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
from types import MappingProxyType
from typing import Literal, Protocol, cast

from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_json_bytes,
    parse_json_object,
)
from stark_trading_os.catalog.historical_catalog import (
    CatalogManifestV2,
    CatalogValidatedAuditV2,
    HistoricalCatalogInvalid,
    catalog_schema_from_bytes,
    parse_historical_manifest_bytes,
    parse_historical_model_bytes,
)
from stark_trading_os.catalog.historical_identity import validate_historical_catalog_identity
from stark_trading_os.control.admission import require_historical_capacity
from stark_trading_os.control.database import _immediate_transaction, _verify_write_connection
from stark_trading_os.control.historical_process import (
    HistoricalRunnerOutcomeRecord,
    SupervisorExitV2,
    historical_exit_bytes,
)
from stark_trading_os.control.preflight_contract import (
    PREFLIGHT_CHECK_CODES,
    PREFLIGHT_CHECK_EXPLANATIONS,
    PREFLIGHT_PASSING_CHECK_CODES,
    PREFLIGHT_READY_CHECKLIST,
    sanitize_preflight_evidence_value,
    validate_preflight_evidence,
    validate_unix_epoch_ns,
)
from stark_trading_os.control.process_identity import (
    CancelPhase,
    ProcessIdentityV1,
    RunnerOutcomeRecord,
    RunnerProcessRecord,
    SupervisorExitV1,
    process_identity_bytes,
    process_identity_digest,
    process_identity_from_bytes,
    supervisor_exit_bytes,
    supervisor_exit_from_bytes,
)
from stark_trading_os.control.run_contract import (
    RunContractKind,
    RunContractMismatch,
    parse_run_contract,
    require_probe_contract,
)
from stark_trading_os.control.strategy_configurations import (
    StrategyConfigurationBinding,
    StrategyConfigurationIntegrityError,
    persist_preflight_configuration_binding,
    validate_preflight_configuration_binding,
)
from stark_trading_os.domain.errors import StateConflict
from stark_trading_os.domain.models import (
    TERMINAL_STATES,
    BacktestDraftRequest,
    CatalogManifestV1,
    CatalogValidatedAuditV1,
    CostFillModelV1,
    DeterminismProbeConfigV1,
    EventEnvelopeV1,
    InputManifestV1,
    ProbeRiskPolicyV1,
    RunRecordV1,
    RunState,
)
from stark_trading_os.domain.state_machine import transition

type EventSource = Literal["control-api", "runner"]
type IdempotencyOperation = Literal["preflight", "create", "cancel"]
type CatalogPublicationStatus = Literal["PREPARED", "PUBLISHED", "INTEGRITY_FAILED"]
type _CatalogManifest = CatalogManifestV1 | CatalogManifestV2
type _CatalogValidatedAudit = CatalogValidatedAuditV1 | CatalogValidatedAuditV2
type PreflightStatus = Literal["PREFLIGHT_BLOCKED", "PREFLIGHT_READY"]
type TerminalPreparationDisposition = Literal["NORMAL", "FAULT_CONVERTED"]
type FinalizationStage = Literal[
    "STAGING",
    "REPORTS",
    "RECONCILIATION",
    "MATERIALIZATION",
    "FSYNC",
    "RENAME",
    "SEAL",
    "PUBLICATION",
]
type FinalizationFailureCategory = Literal[
    "DETERMINISTIC_EVIDENCE_FAILURE",
    "OPERATIONAL_RETRY_EXHAUSTED",
]

CONTROL_EVENT_TYPES = frozenset(
    {
        "preflight.passed",
        "preflight.blocked",
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancel_pending",
        "run.finalizing",
        "report.generated",
        "run.completed",
        "run.failed",
        "run.cancelled",
    }
)
RUNNER_EVENT_TYPES = frozenset(
    {
        "run.progress",
        "order.submitted",
        "order.accepted",
        "order.rejected",
        "order.partially_filled",
        "order.filled",
        "order.cancel_pending",
        "order.cancelled",
        "position.opened",
        "position.changed",
        "position.closed",
        "risk.rejected",
    }
)
TERMINAL_EVENT_TYPES = frozenset({"run.completed", "run.failed", "run.cancelled"})
LIFECYCLE_TARGETS: Mapping[str, RunState] = MappingProxyType(
    {
        "preflight.passed": RunState.PREFLIGHT_READY,
        "preflight.blocked": RunState.PREFLIGHT_BLOCKED,
        "run.queued": RunState.QUEUED,
        "run.started": RunState.RUNNING,
        "run.cancel_requested": RunState.CANCEL_REQUESTED,
        "run.cancel_pending": RunState.CANCEL_PENDING,
        "run.finalizing": RunState.FINALIZING,
    }
)
_RUNNER_APPEND_STATES = frozenset(
    {RunState.RUNNING, RunState.CANCEL_REQUESTED, RunState.CANCEL_PENDING}
)
_POST_QUEUE_STATES = frozenset(
    {
        RunState.QUEUED,
        RunState.RUNNING,
        RunState.CANCEL_REQUESTED,
        RunState.CANCEL_PENDING,
        RunState.FINALIZING,
        RunState.COMPLETED,
        RunState.FAILED,
        RunState.CANCELLED,
    }
)
_HEX_DIGEST_LENGTH = 64
_FINALIZATION_STAGES = frozenset(
    {
        "STAGING",
        "REPORTS",
        "RECONCILIATION",
        "MATERIALIZATION",
        "FSYNC",
        "RENAME",
        "SEAL",
        "PUBLICATION",
    }
)
_FINALIZATION_FAILURE_CATEGORIES = frozenset(
    {"DETERMINISTIC_EVIDENCE_FAILURE", "OPERATIONAL_RETRY_EXHAUSTED"}
)
PINNED_ENGINE_PACKAGE_VERSION = "2.0.0rc3"
PINNED_ENGINE_TAG_COMMIT = "648970ce64a304d93da0a29320cb6e19b905fa39"
PINNED_ENGINE_PYTHON_VERSION = "3.12.4"
PINNED_ENGINE_PRECISION_MODE = "FIXED_PRECISION_16"
PINNED_ENGINE_FIXED_PRECISION = 16
_PREFLIGHT_MISSING_COST_CODES = (
    "COST_FEE_MISSING",
    "COST_SPREAD_MISSING",
    "COST_SLIPPAGE_MISSING",
    "COST_LATENCY_MISSING",
    "FILL_LIQUIDITY_MISSING",
    "FILL_CANCEL_MISSING",
)


class Clock(Protocol):
    def __call__(self) -> int: ...


class EventIdFactory(Protocol):
    def __call__(self, run_id: str, seq: int) -> str: ...


class ControlStoreError(RuntimeError):
    """Base class for stable control-registry failures."""


class RunNotFound(ControlStoreError):
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        super().__init__(f"Run is not registered: {run_id}")


class VersionConflict(ControlStoreError):
    def __init__(self, *, run_id: str, expected: int, actual: int) -> None:
        self.run_id = run_id
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"STATE_CONFLICT: run {run_id} expected version {expected}, actual version {actual}"
        )


class EventRejected(ControlStoreError):
    """Raised before commit when a candidate violates ownership or lifecycle rules."""


class IdempotencyConflict(ControlStoreError):
    def __init__(self) -> None:
        super().__init__("IDEMPOTENCY_CONFLICT")


class CatalogConflict(ControlStoreError):
    def __init__(self) -> None:
        super().__init__("CATALOG_CONFLICT")


class CatalogRecoveryBlocked(ControlStoreError):
    def __init__(self) -> None:
        super().__init__("CATALOG_RECOVERY_BLOCKED")


class CatalogIntegrityFailed(ControlStoreError):
    def __init__(self) -> None:
        super().__init__("CATALOG_INTEGRITY_FAILED")


class CatalogStorageFailed(ControlStoreError):
    def __init__(self) -> None:
        super().__init__("CATALOG_STORAGE_FAILED")


class TerminalEligibilityError(ControlStoreError):
    """Raised when locked SQLite truth is not eligible for terminal preparation."""


class TerminalIntegrityError(ControlStoreError):
    """Raised when a persisted terminal identity fails exact read-back validation."""


class TerminalPublicationConflict(ControlStoreError):
    """Raised when immutable terminal publication differs from the supplied proof."""


@dataclass(frozen=True)
class PreflightSnapshot:
    preflight_id: str
    run_id: str
    status: PreflightStatus
    request_bytes: bytes
    request_hash: str
    result_bytes: bytes
    input_manifest_bytes: bytes | None
    input_manifest_hash: str | None
    catalog_revision: str | None
    catalog_inventory_hash: str | None
    engine_package_version: str | None
    engine_tag_commit: str | None
    risk_policy_hash: str | None
    expires_at_ns: int
    consumed_at_ns: int | None


@dataclass(frozen=True)
class PreflightReadyEvidence:
    catalog_publication_bytes: bytes
    strategy_id: str
    strategy_version: str
    strategy_bytes: bytes
    strategy_hash: str
    risk_policy_id: str
    risk_policy_version: str
    risk_policy_bytes: bytes
    risk_policy_hash: str
    engine_python_version: str
    engine_precision_mode: str


@dataclass(frozen=True)
class _ValidatedPreflightResult:
    preflight_id: str
    run_id: str
    state: PreflightStatus
    canonical_request_hash: str
    input_manifest_hash: str | None
    catalog_revision: str | None
    expires_at_ns: int
    checks: tuple[_ValidatedPreflightCheck, ...]


@dataclass(frozen=True)
class _ValidatedPreflightCheck:
    code: str
    passed: bool
    checked_at_ns: int
    explanation: str
    evidence: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class EventCandidate:
    source: EventSource
    type: str
    source_seq: int | None
    ts_event_ns: str
    payload: dict[str, object]

    @classmethod
    def control(
        cls,
        *,
        type: str,
        ts_event_ns: str,
        payload: dict[str, object],
    ) -> EventCandidate:
        return cls(
            source="control-api",
            type=type,
            source_seq=None,
            ts_event_ns=ts_event_ns,
            payload=dict(payload),
        )

    @classmethod
    def runner(
        cls,
        *,
        type: str,
        source_seq: int,
        ts_event_ns: str,
        payload: dict[str, object],
    ) -> EventCandidate:
        return cls(
            source="runner",
            type=type,
            source_seq=source_seq,
            ts_event_ns=ts_event_ns,
            payload=dict(payload),
        )


@dataclass(frozen=True)
class RunSnapshot:
    run_id: str
    state: RunState
    state_version: int
    last_event_seq: int
    last_audit_seq: int
    input_manifest_bytes: bytes | None
    input_manifest_hash: str | None
    catalog_revision: str | None
    catalog_inventory_hash: str | None
    created_at_ns: int
    evidence_status: str
    contract_kind: RunContractKind = RunContractKind.PROBE_V1


@dataclass(frozen=True)
class PersistedEvent:
    event_id: str
    run_id: str
    seq: int
    source_seq: int
    source: EventSource
    type: str
    ts_event_ns: str
    ts_ingest_ns: str
    visible: bool
    envelope_bytes: bytes


@dataclass(frozen=True)
class AuditIntent:
    run_id: str
    audit_seq: int
    event_seq: int
    event_digest: str
    intent_bytes: bytes
    created_at_ns: int


class _PublicationAuthority:
    """Per-store opaque registry for materializer-issued one-use capabilities."""

    __slots__ = ("_issued", "_windows")

    def __init__(self, _factory: object) -> None:
        if _factory is not _PUBLICATION_AUTHORITY_FACTORY:
            raise TypeError("Publication authority is owned by ControlStore.")
        self._issued: dict[int, _IssuedProof] = {}
        self._windows: dict[int, _IssuedWindow] = {}

    def _register(self, proof: _VerifiedRootProof) -> None:
        nonce = object()
        proof._issuance_nonce = nonce
        self._issued[id(proof)] = _IssuedProof(
            nonce=nonce,
            identity=_frozen_proof_identity(proof),
        )

    def _consume(self, proof: _VerifiedRootProof) -> _FrozenProofIdentity:
        issued = cast(_IssuedProof | None, self._issued.pop(id(proof), None))
        if issued is None:
            raise TerminalPublicationConflict(
                "Verified root capability was not issued by this store."
            )
        if (
            getattr(proof, "_issuance_nonce", None) is not issued.nonce
            or _frozen_proof_identity(proof) != issued.identity
        ):
            raise TerminalPublicationConflict("Verified root capability identity changed.")
        return issued.identity

    def _discard(self, proof: _VerifiedRootProof) -> None:
        self._issued.pop(id(proof), None)

    def _register_window(
        self,
        window: object,
        *,
        nonce: object,
        preparation: TerminalPreparation,
    ) -> None:
        self._windows[id(window)] = _IssuedWindow(
            owner=window,
            nonce=nonce,
            identity=_frozen_preparation_identity(preparation),
        )

    def _owns_window(self, window: object) -> bool:
        issued = self._windows.get(id(window))
        return (
            type(window) is _VerifiedPublicationWindow
            and issued is not None
            and issued.owner is window
        )

    def _require_window(
        self,
        window: object,
        *,
        proof_identity: _FrozenProofIdentity | None = None,
    ) -> _FrozenPreparationIdentity:
        sentinel = object()
        issued = self._windows.get(id(window))
        if (
            type(window) is not _VerifiedPublicationWindow
            or issued is None
            or issued.owner is not window
            or getattr(window, "_nonce", sentinel) is not issued.nonce
            or getattr(window, "_authority", sentinel) is not self
            or getattr(window, "_active", sentinel) is not True
        ):
            raise TerminalPublicationConflict(
                "Verified publication writer capability was not issued by this store."
            )
        if proof_identity is not None and not _window_matches_proof(
            issued.identity,
            proof_identity,
        ):
            raise TerminalPublicationConflict(
                "Verified root identity does not match the publication writer window."
            )
        return issued.identity

    def _discard_window(self, window: object) -> None:
        issued = self._windows.get(id(window))
        if issued is not None and issued.owner is window:
            self._windows.pop(id(window), None)


_PUBLICATION_AUTHORITY_FACTORY = object()


def _new_publication_authority() -> _PublicationAuthority:
    return _PublicationAuthority(_PUBLICATION_AUTHORITY_FACTORY)


class _VerifiedPublicationWindow:
    """Opaque one-use Store authority for an already-held SQLite writer."""

    _authority: _PublicationAuthority
    _nonce: object
    _active: bool
    __slots__ = ("_authority", "_nonce", "_active")

    def __init__(self, **_values: object) -> None:
        raise TypeError("Verified publication windows are opened only by ControlStore.")


class _VerifiedRootProof:
    """Opaque, one-use identity issued only while the root publication lock is held."""

    run_id: str
    terminal_state: RunState
    terminal_event_seq: int
    last_audit_seq: int
    seal_digest: str
    _authority: _PublicationAuthority
    _lock_guard_fd: int
    _retained_final_root: object | None
    _consumed: bool
    _issuance_nonce: object
    __slots__ = (
        "run_id",
        "terminal_state",
        "terminal_event_seq",
        "last_audit_seq",
        "seal_digest",
        "_authority",
        "_lock_guard_fd",
        "_retained_final_root",
        "_consumed",
        "_issuance_nonce",
    )

    def __init__(self, **_values: object) -> None:
        raise TypeError("Verified root proofs are issued only from a locked materializer.")

    @classmethod
    def _issue_from_locked_root(
        cls,
        *,
        run_id: str,
        terminal_state: RunState,
        terminal_event_seq: int,
        last_audit_seq: int,
        seal_digest: str,
        root_receipt: object,
        authority: _PublicationAuthority,
    ) -> _VerifiedRootProof:
        """Capture a duplicate of the held flock as the opaque one-use guard."""

        if type(authority) is not _PublicationAuthority:
            raise TypeError("Verified root proof authority is not store-bound.")
        # Delayed import avoids the materializer -> registry -> transactions
        # initialization cycle while making a verified root receipt, rather than
        # arbitrary five fields or a caller lock, the sole issuance authority.
        from stark_trading_os.audit.materializer import _VerifiedFinalRootReceipt

        if type(root_receipt) is not _VerifiedFinalRootReceipt:
            raise TypeError("Verified root proof requires an exact final-root receipt.")
        proof = object.__new__(cls)
        proof.run_id = run_id
        proof.terminal_state = terminal_state
        proof.terminal_event_seq = terminal_event_seq
        proof.last_audit_seq = last_audit_seq
        proof.seal_digest = seal_digest
        proof._authority = authority
        proof._lock_guard_fd, proof._retained_final_root = root_receipt._consume_locked_guard(
            authority=authority
        )
        proof._consumed = False
        authority._register(proof)
        return proof

    def _consume_locked_guard(
        self,
        *,
        authority: _PublicationAuthority,
    ) -> _FrozenProofIdentity:
        if getattr(self, "_consumed", None) is not False:
            raise TerminalPublicationConflict("Verified root capability was already consumed.")
        if getattr(self, "_authority", None) is not authority:
            raise TerminalPublicationConflict("Verified root capability belongs to another store.")
        identity: _FrozenProofIdentity = authority._consume(self)
        from stark_trading_os.audit.materializer import (
            MaterializationError,
            _reverify_retained_final_root,
        )

        try:
            fcntl.flock(self._lock_guard_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise MaterializationError(
                "verified publication lock guard could not be reacquired",
                deterministic=False,
                stage="PUBLICATION",
            ) from error
        try:
            _reverify_retained_final_root(
                self._retained_final_root,
                lock_guard_fd=self._lock_guard_fd,
            )
        except MaterializationError:
            raise
        except Exception as error:
            raise TerminalPublicationConflict(
                "Verified root capability no longer binds the retained final root."
            ) from error
        self._consumed = True
        return identity

    def _discard(self) -> None:
        authority = getattr(self, "_authority", None)
        if type(authority) is _PublicationAuthority:
            authority._discard(self)
        cleanup_error: BaseException | None = None
        lock_guard_fd = getattr(self, "_lock_guard_fd", -1)
        self._lock_guard_fd = -1
        if type(lock_guard_fd) is int and lock_guard_fd >= 0:
            try:
                os.close(lock_guard_fd)
            except BaseException as error:
                cleanup_error = error
        retained_final_root = getattr(self, "_retained_final_root", None)
        self._retained_final_root = None
        if retained_final_root is not None:
            from stark_trading_os.audit.materializer import _RetainedFinalRootVerification

            if type(retained_final_root) is _RetainedFinalRootVerification:
                try:
                    retained_final_root._discard()
                except BaseException as error:
                    if cleanup_error is None:
                        cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error


@dataclass(frozen=True)
class TerminalPreparation:
    run_id: str
    outcome: RunnerOutcomeRecord
    run_record: RunRecordV1 | None
    terminal_state: RunState
    terminal_state_version: int
    event: PersistedEvent
    audit_intent: AuditIntent
    disposition: TerminalPreparationDisposition
    initial_event_digest: str
    failure_attempt_count: int
    last_failure_at_ns: int | None
    last_failure_stage: str | None
    conversion_fault_hash: str | None
    prepared_at_ns: int
    converted_at_ns: int | None


@dataclass(frozen=True)
class _FrozenProofIdentity:
    run_id: str
    terminal_state: RunState
    terminal_event_seq: int
    last_audit_seq: int
    seal_digest: str


@dataclass(frozen=True)
class _IssuedProof:
    nonce: object
    identity: _FrozenProofIdentity


@dataclass(frozen=True)
class _FrozenPreparationIdentity:
    run_id: str
    terminal_state: RunState
    terminal_event_seq: int
    last_audit_seq: int
    fingerprint: tuple[object, ...]


@dataclass(frozen=True)
class _IssuedWindow:
    owner: object
    nonce: object
    identity: _FrozenPreparationIdentity


def _frozen_proof_identity(proof: _VerifiedRootProof) -> _FrozenProofIdentity:
    return _FrozenProofIdentity(
        run_id=proof.run_id,
        terminal_state=proof.terminal_state,
        terminal_event_seq=proof.terminal_event_seq,
        last_audit_seq=proof.last_audit_seq,
        seal_digest=proof.seal_digest,
    )


def _frozen_preparation_identity(
    preparation: TerminalPreparation,
) -> _FrozenPreparationIdentity:
    if type(preparation.run_record) is not RunRecordV1:
        raise TypeError("Terminal preparation requires an exact run record.")
    return _FrozenPreparationIdentity(
        run_id=preparation.run_id,
        terminal_state=preparation.terminal_state,
        terminal_event_seq=preparation.event.seq,
        last_audit_seq=preparation.audit_intent.audit_seq,
        fingerprint=(
            preparation.run_id,
            canonical_json_bytes(preparation.outcome.model_dump(mode="json", by_alias=True)),
            canonical_json_bytes(preparation.run_record.model_dump(mode="json", by_alias=True)),
            preparation.terminal_state,
            preparation.terminal_state_version,
            preparation.event,
            preparation.audit_intent,
            preparation.disposition,
            preparation.initial_event_digest,
            preparation.failure_attempt_count,
            preparation.last_failure_at_ns,
            preparation.last_failure_stage,
            preparation.conversion_fault_hash,
            preparation.prepared_at_ns,
            preparation.converted_at_ns,
        ),
    )


def _same_terminal_preparation(
    left: TerminalPreparation,
    right: TerminalPreparation,
) -> bool:
    try:
        return _frozen_preparation_identity(left) == _frozen_preparation_identity(right)
    except TypeError:
        return False


def _window_matches_proof(
    window: _FrozenPreparationIdentity,
    proof: _FrozenProofIdentity,
) -> bool:
    return (
        window.run_id == proof.run_id
        and window.terminal_state is proof.terminal_state
        and window.terminal_event_seq == proof.terminal_event_seq
        and window.last_audit_seq == proof.last_audit_seq
    )


@dataclass(frozen=True)
class TerminalPublication:
    run_id: str
    state: RunState
    state_version: int
    event: PersistedEvent
    audit_intent: AuditIntent
    seal_digest: str
    published_at_ns: int
    materialized_event_seq: int
    materialized_audit_seq: int


@dataclass(frozen=True)
class FinalizationFailure:
    deterministic: bool
    stage: FinalizationStage


@dataclass(frozen=True)
class FinalizationFaultRecord:
    run_id: str
    fault_bytes: bytes
    fault_hash: str
    recorded_at_ns: int
    category: FinalizationFailureCategory
    stage: FinalizationStage


@dataclass(frozen=True)
class UnverifiedTerminalPublication:
    run_id: str
    state: RunState
    state_version: int
    event: PersistedEvent
    audit_intent: AuditIntent
    fault: FinalizationFaultRecord


type TerminalFinalization = TerminalPublication | UnverifiedTerminalPublication


@dataclass(frozen=True)
class OutboxRecord:
    run_id: str
    seq: int
    audit_seq: int
    materialized: bool
    materialized_at_ns: int | None


@dataclass(frozen=True)
class CatalogPublication:
    catalog_revision: str
    fixture_id: str
    status: CatalogPublicationStatus
    inventory_hash: str
    publication_bytes: bytes
    staging_identity: str
    prepared_at_ns: int
    published_at_ns: int | None
    audit_intent_bytes: bytes | None


@dataclass(frozen=True)
class RunEvidenceSnapshot:
    """Validated run authority captured inside one SQLite read snapshot."""

    run: RunSnapshot
    last_visible_seq: int
    events: tuple[PersistedEvent, ...]
    catalog_publication: CatalogPublication | None
    runner_outcome: RunnerOutcomeRecord | None
    terminal_preparation: TerminalPreparation | None
    terminal_finalization: TerminalFinalization | None


@dataclass(frozen=True)
class PersistedTransition:
    run_id: str
    state: RunState
    state_version: int
    event: PersistedEvent
    audit_seq: int


@dataclass(frozen=True)
class IdempotentResponse:
    status_code: int
    body: bytes
    run_id: str | None = None

    def __post_init__(self) -> None:
        if type(self.status_code) is not int or not 100 <= self.status_code <= 599:
            raise ValueError("Idempotent response status must be an integer from 100 through 599.")
        if type(self.body) is not bytes:
            raise ValueError("Idempotent response body must be exact canonical bytes.")
        _require_exact_canonical_object(self.body, label="response body")
        if self.run_id is not None:
            _require_nonempty_string(self.run_id, label="response run_id")


@dataclass(frozen=True)
class PersistedCancelRequest:
    response: IdempotentResponse
    state: RunState
    state_version: int
    last_visible_seq: int
    created_by_caller: bool
    clean_no_claim: bool
    signal_required: bool


@dataclass(frozen=True, init=False)
class IdempotencyCommand:
    operation: IdempotencyOperation
    key: str
    canonical_request_bytes: bytes
    run_id: str | None
    configuration_id: str | None
    configuration_content_sha256: str | None

    def __init__(
        self,
        *args: object,
        **kwargs: object,
    ) -> None:
        raise TypeError("Use a server-owned IdempotencyCommand factory.")

    @classmethod
    def _new(
        cls,
        *,
        operation: IdempotencyOperation,
        key: str,
        canonical_request_bytes: bytes,
        run_id: str | None,
        configuration_id: str | None = None,
        configuration_content_sha256: str | None = None,
    ) -> IdempotencyCommand:
        _require_nonempty_string(key, label="idempotency key")
        if type(canonical_request_bytes) is not bytes:
            raise ValueError("Idempotency request must be exact canonical bytes.")
        _require_exact_canonical_object(canonical_request_bytes, label="request body")
        if operation == "cancel":
            if run_id is None:
                raise ValueError("Cancel idempotency requires a server-resolved run_id.")
            _require_nonempty_string(run_id, label="cancel run_id")
        elif run_id is not None:
            raise ValueError("Only cancel idempotency accepts a server-resolved run_id.")
        if (configuration_id is None) != (configuration_content_sha256 is None):
            raise ValueError("Configuration idempotency identity must be complete.")
        if configuration_id is not None:
            if operation != "preflight":
                raise ValueError("Only preflight idempotency accepts configuration identity.")
            _require_configuration_id(configuration_id)
            assert configuration_content_sha256 is not None
            _require_digest(
                configuration_content_sha256,
                label="configuration content hash",
            )
        command = object.__new__(IdempotencyCommand)
        object.__setattr__(command, "operation", operation)
        object.__setattr__(command, "key", key)
        object.__setattr__(command, "canonical_request_bytes", canonical_request_bytes)
        object.__setattr__(command, "run_id", run_id)
        object.__setattr__(command, "configuration_id", configuration_id)
        object.__setattr__(
            command,
            "configuration_content_sha256",
            configuration_content_sha256,
        )
        return command

    @classmethod
    def preflight(
        cls,
        *,
        key: str,
        canonical_request_bytes: bytes,
        configuration_id: str | None = None,
        configuration_content_sha256: str | None = None,
    ) -> IdempotencyCommand:
        return IdempotencyCommand._new(
            operation="preflight",
            key=key,
            canonical_request_bytes=canonical_request_bytes,
            run_id=None,
            configuration_id=configuration_id,
            configuration_content_sha256=configuration_content_sha256,
        )

    @classmethod
    def create(cls, *, key: str, canonical_request_bytes: bytes) -> IdempotencyCommand:
        return IdempotencyCommand._new(
            operation="create",
            key=key,
            canonical_request_bytes=canonical_request_bytes,
            run_id=None,
        )

    @classmethod
    def cancel(
        cls,
        *,
        run_id: str,
        key: str,
        canonical_request_bytes: bytes,
    ) -> IdempotencyCommand:
        return IdempotencyCommand._new(
            operation="cancel",
            key=key,
            canonical_request_bytes=canonical_request_bytes,
            run_id=run_id,
        )

    @property
    def scope(self) -> str:
        if self.operation == "preflight":
            return "backtest.preflight"
        if self.operation == "create":
            return "backtest.create"
        assert self.run_id is not None
        return f"backtest.cancel/{self.run_id}"

    @property
    def request_hash(self) -> str:
        return sha256(self.logical_request_bytes).hexdigest()

    @property
    def logical_request_bytes(self) -> bytes:
        return _logical_request_bytes(
            operation=self.operation,
            canonical_request_bytes=self.canonical_request_bytes,
            run_id=self.run_id,
            configuration_id=self.configuration_id,
            configuration_content_sha256=self.configuration_content_sha256,
        )


@dataclass(frozen=True)
class _ValidatedCommand:
    operation: IdempotencyOperation
    scope: str
    key: str
    logical_request_bytes: bytes
    request_hash: str
    bare_request_bytes: bytes
    bare_request_hash: str
    target_run_id: str | None
    configuration_id: str | None
    configuration_content_sha256: str | None


class ControlTransaction(Protocol):
    """Non-constructible handler surface with no raw SQLite connection."""

    def reserve_run(
        self,
        *,
        run_id: str,
        input_manifest_bytes: bytes | None = None,
        input_manifest_hash: str | None = None,
        catalog_revision: str | None = None,
        catalog_inventory_hash: str | None = None,
    ) -> RunSnapshot: ...

    def commit_transition(
        self,
        *,
        run_id: str,
        expected_version: int,
        target: RunState,
        candidate: EventCandidate,
    ) -> PersistedTransition: ...

    def append_event(
        self,
        *,
        run_id: str,
        expected_version: int,
        candidate: EventCandidate,
    ) -> PersistedTransition: ...

    def persist_preflight(
        self,
        *,
        preflight_id: str,
        run_id: str,
        status: PreflightStatus,
        request_bytes: bytes,
        request_hash: str,
        result_bytes: bytes,
        input_manifest_bytes: bytes | None,
        input_manifest_hash: str | None,
        catalog_revision: str | None,
        catalog_inventory_hash: str | None,
        engine_package_version: str | None,
        engine_tag_commit: str | None,
        risk_policy_hash: str | None,
        expires_at_ns: int,
        ready_evidence: PreflightReadyEvidence | None,
        configuration_id: str | None = None,
        configuration_content_sha256: str | None = None,
    ) -> PreflightSnapshot: ...

    def consume_preflight(
        self,
        *,
        preflight_id: str,
        expected_request_hash: str,
        expected_manifest_bytes: bytes,
        expected_manifest_hash: str,
        expected_catalog_revision: str,
        expected_catalog_inventory_hash: str,
        expected_catalog_publication_bytes: bytes,
        expected_engine_package_version: str,
        expected_engine_tag_commit: str,
        expected_python_version: str,
        expected_precision_mode: str,
        expected_risk_policy_hash: str,
        consumed_at_ns: int,
    ) -> PreflightSnapshot: ...


class _ReserveRunCapability(Protocol):
    def __call__(
        self,
        *,
        run_id: str,
        input_manifest_bytes: bytes | None,
        input_manifest_hash: str | None,
        catalog_revision: str | None,
        catalog_inventory_hash: str | None,
    ) -> RunSnapshot: ...


class _TransitionCapability(Protocol):
    def __call__(
        self,
        *,
        run_id: str,
        expected_version: int,
        target: RunState,
        candidate: EventCandidate,
    ) -> PersistedTransition: ...


class _AppendCapability(Protocol):
    def __call__(
        self,
        *,
        run_id: str,
        expected_version: int,
        candidate: EventCandidate,
    ) -> PersistedTransition: ...


class _PersistPreflightCapability(Protocol):
    def __call__(self, candidate: _PersistPreflightCandidate) -> PreflightSnapshot: ...


class _ConsumePreflightCapability(Protocol):
    def __call__(self, candidate: _ConsumePreflightCandidate) -> PreflightSnapshot: ...


@dataclass(frozen=True)
class _PersistPreflightCandidate:
    preflight_id: str
    run_id: str
    status: PreflightStatus
    request_bytes: bytes
    request_hash: str
    result_bytes: bytes
    input_manifest_bytes: bytes | None
    input_manifest_hash: str | None
    catalog_revision: str | None
    catalog_inventory_hash: str | None
    engine_package_version: str | None
    engine_tag_commit: str | None
    risk_policy_hash: str | None
    expires_at_ns: int
    ready_evidence: PreflightReadyEvidence | None
    configuration_id: str | None
    configuration_content_sha256: str | None


@dataclass(frozen=True)
class _ConsumePreflightCandidate:
    preflight_id: str
    expected_request_hash: str
    expected_manifest_bytes: bytes
    expected_manifest_hash: str
    expected_catalog_revision: str
    expected_catalog_inventory_hash: str
    expected_catalog_publication_bytes: bytes
    expected_engine_package_version: str
    expected_engine_tag_commit: str
    expected_python_version: str
    expected_precision_mode: str
    expected_risk_policy_hash: str
    consumed_at_ns: int


@dataclass
class _CommandScope:
    operation: IdempotencyOperation
    reserve: _ReserveRunCapability
    transition: _TransitionCapability
    append: _AppendCapability
    persist_preflight: _PersistPreflightCapability
    consume_preflight: _ConsumePreflightCapability
    in_transaction: Callable[[], bool]
    logical_request_bytes: bytes
    request_hash: str
    bare_request_bytes: bytes
    bare_request_hash: str
    target_run_id: str | None
    configuration_id: str | None
    configuration_content_sha256: str | None
    bound_run_id: str | None
    poisoned: bool = False
    run_reserved: bool = False
    preflight_status: PreflightStatus | None = None
    preflight_result_bytes: bytes | None = None
    preflight_persisted: bool = False
    preflight_transitioned: bool = False
    preflight_consumed: bool = False
    queued_transitioned: bool = False


class _CommandTransaction:
    """Lifecycle-limited command capability with no direct SQLite connection field."""

    __slots__ = ()

    def reserve_run(
        self,
        *,
        run_id: str,
        input_manifest_bytes: bytes | None = None,
        input_manifest_hash: str | None = None,
        catalog_revision: str | None = None,
        catalog_inventory_hash: str | None = None,
    ) -> RunSnapshot:
        def operation(scope: _CommandScope) -> RunSnapshot:
            if scope.operation != "preflight":
                raise EventRejected("Only backtest.preflight can reserve a run.")
            if scope.run_reserved:
                raise EventRejected("A preflight command can reserve exactly one new run.")
            _bind_command_run(scope, run_id)
            result = scope.reserve(
                run_id=run_id,
                input_manifest_bytes=input_manifest_bytes,
                input_manifest_hash=input_manifest_hash,
                catalog_revision=catalog_revision,
                catalog_inventory_hash=catalog_inventory_hash,
            )
            scope.run_reserved = True
            return result

        return _invoke_command_capability(self, operation)

    def commit_transition(
        self,
        *,
        run_id: str,
        expected_version: int,
        target: RunState,
        candidate: EventCandidate,
    ) -> PersistedTransition:
        def operation(scope: _CommandScope) -> PersistedTransition:
            _bind_command_run(scope, run_id)
            if scope.operation == "preflight":
                if not scope.preflight_persisted or scope.preflight_transitioned:
                    raise EventRejected("Preflight transition requires one persisted preflight.")
                assert scope.preflight_status is not None
                expected_target = RunState(scope.preflight_status)
                if target is not expected_target:
                    raise EventRejected("Preflight transition must match its persisted status.")
            elif scope.operation == "create":
                if not scope.preflight_consumed or scope.queued_transitioned:
                    raise EventRejected("Run queueing requires one consumed preflight.")
                if target is not RunState.QUEUED:
                    raise EventRejected("Backtest create can only transition its run to QUEUED.")
            result = scope.transition(
                run_id=run_id,
                expected_version=expected_version,
                target=target,
                candidate=candidate,
            )
            if scope.operation == "preflight":
                scope.preflight_transitioned = True
            elif scope.operation == "create":
                scope.queued_transitioned = True
            return result

        return _invoke_command_capability(self, operation)

    def append_event(
        self,
        *,
        run_id: str,
        expected_version: int,
        candidate: EventCandidate,
    ) -> PersistedTransition:
        def operation(scope: _CommandScope) -> PersistedTransition:
            if scope.operation in {"preflight", "create"}:
                raise EventRejected("Preflight and create commands cannot append unrelated events.")
            _bind_command_run(scope, run_id)
            return scope.append(
                run_id=run_id,
                expected_version=expected_version,
                candidate=candidate,
            )

        return _invoke_command_capability(self, operation)

    def persist_preflight(
        self,
        *,
        preflight_id: str,
        run_id: str,
        status: PreflightStatus,
        request_bytes: bytes,
        request_hash: str,
        result_bytes: bytes,
        input_manifest_bytes: bytes | None,
        input_manifest_hash: str | None,
        catalog_revision: str | None,
        catalog_inventory_hash: str | None,
        engine_package_version: str | None,
        engine_tag_commit: str | None,
        risk_policy_hash: str | None,
        expires_at_ns: int,
        ready_evidence: PreflightReadyEvidence | None,
        configuration_id: str | None = None,
        configuration_content_sha256: str | None = None,
    ) -> PreflightSnapshot:
        def operation(scope: _CommandScope) -> PreflightSnapshot:
            if scope.operation != "preflight":
                raise EventRejected("Preflight persistence requires backtest.preflight authority.")
            if not scope.run_reserved:
                raise EventRejected("Preflight persistence requires its newly reserved run.")
            if scope.preflight_persisted:
                raise EventRejected("A preflight command can persist exactly one preflight.")
            if request_bytes != scope.bare_request_bytes or request_hash != scope.bare_request_hash:
                raise EventRejected("Preflight request identity must equal its command request.")
            if (
                configuration_id != scope.configuration_id
                or configuration_content_sha256 != scope.configuration_content_sha256
            ):
                raise EventRejected(
                    "Preflight configuration identity must equal its command identity."
                )
            _bind_command_run(scope, run_id)
            result = scope.persist_preflight(
                _PersistPreflightCandidate(
                    preflight_id=preflight_id,
                    run_id=run_id,
                    status=status,
                    request_bytes=request_bytes,
                    request_hash=request_hash,
                    result_bytes=result_bytes,
                    input_manifest_bytes=input_manifest_bytes,
                    input_manifest_hash=input_manifest_hash,
                    catalog_revision=catalog_revision,
                    catalog_inventory_hash=catalog_inventory_hash,
                    engine_package_version=engine_package_version,
                    engine_tag_commit=engine_tag_commit,
                    risk_policy_hash=risk_policy_hash,
                    expires_at_ns=expires_at_ns,
                    ready_evidence=ready_evidence,
                    configuration_id=configuration_id,
                    configuration_content_sha256=configuration_content_sha256,
                )
            )
            scope.preflight_status = status
            scope.preflight_result_bytes = result_bytes
            scope.preflight_persisted = True
            return result

        return _invoke_command_capability(self, operation)

    def consume_preflight(
        self,
        *,
        preflight_id: str,
        expected_request_hash: str,
        expected_manifest_bytes: bytes,
        expected_manifest_hash: str,
        expected_catalog_revision: str,
        expected_catalog_inventory_hash: str,
        expected_catalog_publication_bytes: bytes,
        expected_engine_package_version: str,
        expected_engine_tag_commit: str,
        expected_python_version: str,
        expected_precision_mode: str,
        expected_risk_policy_hash: str,
        consumed_at_ns: int,
    ) -> PreflightSnapshot:
        def operation(scope: _CommandScope) -> PreflightSnapshot:
            if scope.operation != "create":
                raise EventRejected("Preflight consumption requires backtest.create authority.")
            if scope.preflight_consumed:
                raise EventRejected("A create command can consume exactly one preflight.")
            create_request = _parse_exact_schema_less_object(
                scope.bare_request_bytes,
                label="create command request",
            )
            if create_request != {
                "canonical_request_hash": expected_request_hash,
                "preflight_id": preflight_id,
            }:
                raise EventRejected(
                    "Create command request must exactly match its preflight consume arguments."
                )
            result = scope.consume_preflight(
                _ConsumePreflightCandidate(
                    preflight_id=preflight_id,
                    expected_request_hash=expected_request_hash,
                    expected_manifest_bytes=expected_manifest_bytes,
                    expected_manifest_hash=expected_manifest_hash,
                    expected_catalog_revision=expected_catalog_revision,
                    expected_catalog_inventory_hash=expected_catalog_inventory_hash,
                    expected_catalog_publication_bytes=expected_catalog_publication_bytes,
                    expected_engine_package_version=expected_engine_package_version,
                    expected_engine_tag_commit=expected_engine_tag_commit,
                    expected_python_version=expected_python_version,
                    expected_precision_mode=expected_precision_mode,
                    expected_risk_policy_hash=expected_risk_policy_hash,
                    consumed_at_ns=consumed_at_ns,
                )
            )
            _bind_command_run(scope, result.run_id)
            scope.preflight_consumed = True
            return result

        return _invoke_command_capability(self, operation)


_COMMAND_SCOPES: dict[_CommandTransaction, _CommandScope] = {}


def _bind_command_run(scope: _CommandScope, run_id: str) -> None:
    _require_nonempty_string(run_id, label="run_id")
    if scope.target_run_id is not None and run_id != scope.target_run_id:
        raise EventRejected(f"Command capability is bound to cancel target {scope.target_run_id}.")
    if scope.bound_run_id is None:
        scope.bound_run_id = run_id
    elif run_id != scope.bound_run_id:
        raise EventRejected(f"Command capability is bound to run {scope.bound_run_id}.")


def _require_command_completion(scope: _CommandScope) -> None:
    if scope.operation == "preflight" and not (
        scope.run_reserved and scope.preflight_persisted and scope.preflight_transitioned
    ):
        raise EventRejected(
            "A preflight command must persist one preflight and transition its run."
        )
    if scope.operation == "create" and not (scope.preflight_consumed and scope.queued_transitioned):
        raise EventRejected("A create command must consume one preflight and queue its run.")


def _invoke_command_capability[ResultT](
    transaction: _CommandTransaction,
    operation: Callable[[_CommandScope], ResultT],
) -> ResultT:
    scope = _COMMAND_SCOPES.get(transaction)
    if scope is None:
        raise ControlStoreError("Command transaction capability is inactive.")
    if not scope.in_transaction():
        scope.poisoned = True
        raise ControlStoreError("Command transaction has no active SQLite transaction.")
    if scope.poisoned:
        raise ControlStoreError("Idempotency command transaction is poisoned.")
    try:
        return operation(scope)
    except BaseException:
        scope.poisoned = True
        raise


def _reserve_run_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    run_id: str,
    input_manifest_bytes: bytes | None,
    input_manifest_hash: str | None,
    catalog_revision: str | None,
    catalog_inventory_hash: str | None,
) -> RunSnapshot:
    with _immediate_transaction(connection):
        return _reserve_run(
            connection,
            clock=clock,
            run_id=run_id,
            input_manifest_bytes=input_manifest_bytes,
            input_manifest_hash=input_manifest_hash,
            catalog_revision=catalog_revision,
            catalog_inventory_hash=catalog_inventory_hash,
        )


def _commit_transition_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    run_id: str,
    expected_version: int,
    target: RunState,
    candidate: EventCandidate,
) -> PersistedTransition:
    _prevalidate_transition(target=target, candidate=candidate)
    with _immediate_transaction(connection):
        return _mutate_event(
            connection,
            clock=clock,
            event_id_factory=event_id_factory,
            run_id=run_id,
            expected_version=expected_version,
            target=target,
            candidate=candidate,
        )


def _append_event_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    run_id: str,
    expected_version: int,
    candidate: EventCandidate,
) -> PersistedTransition:
    _prevalidate_append(candidate)
    with _immediate_transaction(connection):
        return _mutate_event(
            connection,
            clock=clock,
            event_id_factory=event_id_factory,
            run_id=run_id,
            expected_version=expected_version,
            target=None,
            candidate=candidate,
        )


def _execute_idempotent_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    command: IdempotencyCommand,
    handler: Callable[[ControlTransaction], IdempotentResponse],
) -> IdempotentResponse:
    validated = _validate_idempotency_command(command)
    with _immediate_transaction(connection):
        stored_response = _read_idempotent_response(connection, validated)
        if stored_response is not None:
            return stored_response

        def reserve_capability(
            *,
            run_id: str,
            input_manifest_bytes: bytes | None,
            input_manifest_hash: str | None,
            catalog_revision: str | None,
            catalog_inventory_hash: str | None,
        ) -> RunSnapshot:
            return _reserve_run(
                connection,
                clock=clock,
                run_id=run_id,
                input_manifest_bytes=input_manifest_bytes,
                input_manifest_hash=input_manifest_hash,
                catalog_revision=catalog_revision,
                catalog_inventory_hash=catalog_inventory_hash,
            )

        def transition_capability(
            *,
            run_id: str,
            expected_version: int,
            target: RunState,
            candidate: EventCandidate,
        ) -> PersistedTransition:
            return _mutate_event(
                connection,
                clock=clock,
                event_id_factory=event_id_factory,
                run_id=run_id,
                expected_version=expected_version,
                target=target,
                candidate=candidate,
            )

        def append_capability(
            *,
            run_id: str,
            expected_version: int,
            candidate: EventCandidate,
        ) -> PersistedTransition:
            return _mutate_event(
                connection,
                clock=clock,
                event_id_factory=event_id_factory,
                run_id=run_id,
                expected_version=expected_version,
                target=None,
                candidate=candidate,
            )

        def persist_preflight_capability(
            candidate: _PersistPreflightCandidate,
        ) -> PreflightSnapshot:
            return _persist_preflight(connection, candidate, clock=clock)

        def consume_preflight_capability(
            candidate: _ConsumePreflightCandidate,
        ) -> PreflightSnapshot:
            return _consume_preflight(connection, candidate)

        transaction = _CommandTransaction()
        scope = _CommandScope(
            operation=validated.operation,
            reserve=reserve_capability,
            transition=transition_capability,
            append=append_capability,
            persist_preflight=persist_preflight_capability,
            consume_preflight=consume_preflight_capability,
            in_transaction=lambda: connection.in_transaction,
            logical_request_bytes=validated.logical_request_bytes,
            request_hash=validated.request_hash,
            bare_request_bytes=validated.bare_request_bytes,
            bare_request_hash=validated.bare_request_hash,
            target_run_id=validated.target_run_id,
            configuration_id=validated.configuration_id,
            configuration_content_sha256=validated.configuration_content_sha256,
            bound_run_id=validated.target_run_id,
        )
        if transaction in _COMMAND_SCOPES:
            raise RuntimeError("Command transaction identity collision.")
        _COMMAND_SCOPES[transaction] = scope
        try:
            response = handler(transaction)
            if scope.poisoned:
                raise ControlStoreError("Idempotency command transaction is poisoned.")
            response = _validate_idempotent_response(
                response,
                command=validated,
                bound_run_id=scope.bound_run_id,
            )
            _require_command_completion(scope)
            if validated.operation == "preflight" and scope.preflight_result_bytes != response.body:
                raise EventRejected(
                    "Persisted preflight result must equal the exact successful response body."
                )
            if validated.operation == "preflight":
                assert scope.bound_run_id is not None
                row = connection.execute(
                    "SELECT preflight_id FROM preflights WHERE run_id = ?",
                    (scope.bound_run_id,),
                ).fetchone()
                if row is None:
                    raise EventRejected("Completed preflight command has no persisted preflight.")
                read_preflight(
                    connection,
                    _row_str(row, "preflight_id"),
                    _allow_pending_idempotency=True,
                )
            if validated.operation == "create":
                _validate_idempotent_linkage(
                    connection,
                    command=validated,
                    response=response,
                )
        finally:
            _COMMAND_SCOPES.pop(transaction, None)
        created_at_ns = _clock_ns(clock)
        connection.execute(
            """
            INSERT INTO idempotency_records (
                idempotency_scope,
                idempotency_key,
                request_hash,
                request_body,
                response_status,
                response_body,
                target_run_id,
                run_id,
                created_at_ns
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                validated.scope,
                validated.key,
                validated.request_hash,
                validated.logical_request_bytes,
                response.status_code,
                response.body,
                validated.target_run_id,
                response.run_id,
                created_at_ns,
            ),
        )
        return response


def read_idempotent_response(
    connection: sqlite3.Connection, command: IdempotencyCommand
) -> IdempotentResponse | None:
    return _read_idempotent_response(connection, _validate_idempotency_command(command))


def _read_idempotent_response(
    connection: sqlite3.Connection, command: _ValidatedCommand
) -> IdempotentResponse | None:
    stored = connection.execute(
        """
        SELECT request_hash, request_body, response_status, response_body,
               target_run_id, run_id
        FROM idempotency_records
        WHERE idempotency_scope = ? AND idempotency_key = ?
        """,
        (command.scope, command.key),
    ).fetchone()
    if stored is None:
        return None
    if (
        _row_str(stored, "request_hash") != command.request_hash
        or _row_bytes(stored, "request_body") != command.logical_request_bytes
        or _row_optional_str(stored, "target_run_id") != command.target_run_id
    ):
        raise IdempotencyConflict
    response = IdempotentResponse(
        status_code=_row_int(stored, "response_status"),
        body=_row_bytes(stored, "response_body"),
        run_id=_row_optional_str(stored, "run_id"),
    )
    validated = _validate_idempotent_response(
        response,
        command=command,
        bound_run_id=response.run_id,
    )
    _validate_idempotent_linkage(connection, command=command, response=validated)
    return validated


def read_preflight(
    connection: sqlite3.Connection,
    preflight_id: str,
    *,
    _allow_pending_idempotency: bool = False,
    _allow_pending_queue: bool = False,
) -> PreflightSnapshot | None:
    _require_nonempty_string(preflight_id, label="preflight_id")
    row = connection.execute(
        """
        SELECT preflight_id, run_id, status, request_bytes, request_hash,
               result_bytes, input_manifest_bytes, input_manifest_hash,
               catalog_revision, catalog_inventory_hash, engine_package_version,
               engine_tag_commit, risk_policy_hash, expires_at_ns, consumed_at_ns
        FROM preflights
        WHERE preflight_id = ?
        """,
        (preflight_id,),
    ).fetchone()
    if row is None:
        return None
    snapshot = _preflight_from_row(row)
    _validate_preflight_linkage(
        connection,
        snapshot,
        require_idempotency=not _allow_pending_idempotency,
        allow_pending_queue=_allow_pending_queue,
    )
    return snapshot


def _persist_preflight(
    connection: sqlite3.Connection,
    candidate: _PersistPreflightCandidate,
    *,
    clock: Clock,
) -> PreflightSnapshot:
    preflight_id = candidate.preflight_id
    run_id = candidate.run_id
    _require_probe_run(connection, run_id)
    status = candidate.status
    request_bytes = candidate.request_bytes
    request_hash = candidate.request_hash
    result_bytes = candidate.result_bytes
    input_manifest_bytes = candidate.input_manifest_bytes
    input_manifest_hash = candidate.input_manifest_hash
    catalog_revision = candidate.catalog_revision
    catalog_inventory_hash = candidate.catalog_inventory_hash
    engine_package_version = candidate.engine_package_version
    engine_tag_commit = candidate.engine_tag_commit
    risk_policy_hash = candidate.risk_policy_hash
    expires_at_ns = candidate.expires_at_ns
    ready_evidence = candidate.ready_evidence
    configuration_id = candidate.configuration_id
    configuration_content_sha256 = candidate.configuration_content_sha256
    _require_nonempty_string(preflight_id, label="preflight_id")
    _require_nonempty_string(run_id, label="run_id")
    if status not in {"PREFLIGHT_BLOCKED", "PREFLIGHT_READY"}:
        raise ValueError("Preflight status is invalid.")
    if type(request_bytes) is not bytes or type(result_bytes) is not bytes:
        raise ValueError("Preflight request and result must be exact bytes.")
    _require_exact_canonical_object(request_bytes, label="preflight request")
    _require_exact_canonical_object(result_bytes, label="preflight result")
    if type(request_hash) is not str:
        raise ValueError("Preflight request hash must be text.")
    _require_digest(request_hash, label="preflight request hash")
    if sha256(request_bytes).hexdigest() != request_hash:
        raise ValueError("Preflight request hash does not match exact bytes.")
    if type(expires_at_ns) is not int or expires_at_ns < 0:
        raise ValueError("Preflight expiry must be a non-negative integer.")
    identity = (
        input_manifest_bytes,
        input_manifest_hash,
        catalog_revision,
        catalog_inventory_hash,
        engine_package_version,
        engine_tag_commit,
        risk_policy_hash,
    )
    ready = status == "PREFLIGHT_READY"
    if ready != all(value is not None for value in identity):
        raise ValueError("READY requires a complete identity and BLOCKED requires NULL identity.")
    if ready != (ready_evidence is not None):
        raise ValueError("READY requires exact internal evidence and BLOCKED forbids it.")
    if (configuration_id is None) != (configuration_content_sha256 is None):
        raise ValueError("Preflight configuration identity must be complete.")
    run = read_run(connection, run_id)
    if run.state is not RunState.DRAFT:
        raise EventRejected("Preflight persistence requires the reserved DRAFT run.")
    if ready:
        if (
            type(input_manifest_bytes) is not bytes
            or type(input_manifest_hash) is not str
            or type(catalog_revision) is not str
            or type(catalog_inventory_hash) is not str
            or type(engine_package_version) is not str
            or type(engine_tag_commit) is not str
            or type(risk_policy_hash) is not str
        ):
            raise ValueError("READY preflight identity types are invalid.")
        _require_exact_canonical_object(input_manifest_bytes, label="input manifest")
        manifest_kind = _parse_exact_schema_less_object(
            input_manifest_bytes, label="input manifest"
        ).get("schema")
        if manifest_kind is not None and manifest_kind != "InputManifest.v1":
            raise RunContractMismatch("run contract requires a legacy input manifest")
        _require_digest(input_manifest_hash, label="input manifest hash")
        _require_digest(catalog_revision, label="catalog revision")
        _require_digest(catalog_inventory_hash, label="catalog inventory hash")
        _require_digest(risk_policy_hash, label="risk policy hash")
        if sha256(input_manifest_bytes).hexdigest() != input_manifest_hash:
            raise ValueError("Input manifest hash does not match exact bytes.")
        if (
            run.input_manifest_bytes != input_manifest_bytes
            or run.input_manifest_hash != input_manifest_hash
            or run.catalog_revision != catalog_revision
            or run.catalog_inventory_hash != catalog_inventory_hash
        ):
            raise EventRejected("READY preflight identity must equal its reserved run.")
        publication = _read_catalog_publication(connection, catalog_revision)
        if (
            publication is None
            or publication.status != "PUBLISHED"
            or publication.inventory_hash != catalog_inventory_hash
        ):
            raise EventRejected("READY preflight requires an exact PUBLISHED catalog.")
        assert ready_evidence is not None
        _validate_ready_preflight_evidence(
            candidate=candidate,
            publication=publication,
        )
    elif any(value is not None for value in identity) or any(
        value is not None
        for value in (
            run.input_manifest_bytes,
            run.input_manifest_hash,
            run.catalog_revision,
            run.catalog_inventory_hash,
        )
    ):
        raise EventRejected("BLOCKED preflight and its run must not carry manifest identity.")
    connection.execute(
        """
        INSERT INTO preflights (
            preflight_id, run_id, status, request_bytes, request_hash, result_bytes,
            input_manifest_bytes, input_manifest_hash, catalog_revision,
            catalog_inventory_hash, engine_package_version, engine_tag_commit,
            risk_policy_hash, expires_at_ns, consumed_at_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            preflight_id,
            run_id,
            status,
            request_bytes,
            request_hash,
            result_bytes,
            input_manifest_bytes,
            input_manifest_hash,
            catalog_revision,
            catalog_inventory_hash,
            engine_package_version,
            engine_tag_commit,
            risk_policy_hash,
            expires_at_ns,
        ),
    )
    if configuration_id is not None:
        assert configuration_content_sha256 is not None
        persist_preflight_configuration_binding(
            connection,
            preflight_id=preflight_id,
            run_id=run_id,
            binding=StrategyConfigurationBinding(
                configuration_id=configuration_id,
                content_sha256=configuration_content_sha256,
            ),
            request_bytes=request_bytes,
            input_manifest_bytes=input_manifest_bytes,
            created_at_ns=_clock_ns(clock),
        )
    result = read_preflight(
        connection,
        preflight_id,
        _allow_pending_idempotency=True,
    )
    assert result is not None
    return result


def _consume_preflight(
    connection: sqlite3.Connection,
    candidate: _ConsumePreflightCandidate,
) -> PreflightSnapshot:
    preflight_id = candidate.preflight_id
    expected_request_hash = candidate.expected_request_hash
    expected_manifest_bytes = candidate.expected_manifest_bytes
    expected_manifest_hash = candidate.expected_manifest_hash
    expected_catalog_revision = candidate.expected_catalog_revision
    expected_catalog_inventory_hash = candidate.expected_catalog_inventory_hash
    expected_catalog_publication_bytes = candidate.expected_catalog_publication_bytes
    expected_engine_package_version = candidate.expected_engine_package_version
    expected_engine_tag_commit = candidate.expected_engine_tag_commit
    expected_python_version = candidate.expected_python_version
    expected_precision_mode = candidate.expected_precision_mode
    expected_risk_policy_hash = candidate.expected_risk_policy_hash
    consumed_at_ns = candidate.consumed_at_ns
    stored = read_preflight(connection, preflight_id)
    if stored is None or stored.status != "PREFLIGHT_READY":
        raise EventRejected("PREFLIGHT_STALE")
    if (
        type(expected_manifest_bytes) is not bytes
        or type(expected_catalog_publication_bytes) is not bytes
    ):
        raise EventRejected("PREFLIGHT_STALE")
    expected_strings = (
        expected_request_hash,
        expected_manifest_hash,
        expected_catalog_revision,
        expected_catalog_inventory_hash,
        expected_engine_package_version,
        expected_engine_tag_commit,
        expected_python_version,
        expected_precision_mode,
        expected_risk_policy_hash,
    )
    if any(type(value) is not str for value in expected_strings):
        raise EventRejected("PREFLIGHT_STALE")
    if type(consumed_at_ns) is not int or consumed_at_ns < 0:
        raise EventRejected("PREFLIGHT_STALE")
    publication = _read_catalog_publication(connection, str(expected_catalog_revision))
    run = read_run(connection, stored.run_id)
    if (
        stored.consumed_at_ns is not None
        or consumed_at_ns >= stored.expires_at_ns
        or stored.request_hash != expected_request_hash
        or stored.input_manifest_bytes != expected_manifest_bytes
        or stored.input_manifest_hash != expected_manifest_hash
        or stored.catalog_revision != expected_catalog_revision
        or stored.catalog_inventory_hash != expected_catalog_inventory_hash
        or stored.engine_package_version != expected_engine_package_version
        or stored.engine_tag_commit != expected_engine_tag_commit
        or stored.risk_policy_hash != expected_risk_policy_hash
        or publication is None
        or publication.status != "PUBLISHED"
        or publication.inventory_hash != expected_catalog_inventory_hash
        or publication.publication_bytes != expected_catalog_publication_bytes
        or run.state is not RunState.PREFLIGHT_READY
        or run.input_manifest_bytes != expected_manifest_bytes
        or run.input_manifest_hash != expected_manifest_hash
        or run.catalog_revision != expected_catalog_revision
        or run.catalog_inventory_hash != expected_catalog_inventory_hash
    ):
        raise EventRejected("PREFLIGHT_STALE")
    try:
        _validate_consumed_manifest_evidence(
            manifest_bytes=expected_manifest_bytes,
            publication=publication,
            publication_bytes=expected_catalog_publication_bytes,
            engine_package_version=expected_engine_package_version,
            engine_tag_commit=expected_engine_tag_commit,
            python_version=expected_python_version,
            precision_mode=expected_precision_mode,
            risk_policy_hash=expected_risk_policy_hash,
        )
    except (ControlStoreError, ValidationError, ValueError, CatalogConflict) as error:
        raise EventRejected("PREFLIGHT_STALE") from error
    updated = connection.execute(
        """
        UPDATE preflights
        SET consumed_at_ns = ?
        WHERE preflight_id = ? AND consumed_at_ns IS NULL
        """,
        (consumed_at_ns, preflight_id),
    )
    if updated.rowcount != 1:
        raise EventRejected("PREFLIGHT_STALE")
    result = read_preflight(
        connection,
        preflight_id,
        _allow_pending_queue=True,
    )
    assert result is not None
    return result


def _validate_ready_preflight_evidence(
    *,
    candidate: _PersistPreflightCandidate,
    publication: CatalogPublication,
) -> None:
    evidence = candidate.ready_evidence
    if type(evidence) is not PreflightReadyEvidence:
        raise EventRejected("READY preflight evidence must be exact server-owned evidence.")
    assert candidate.input_manifest_bytes is not None
    assert candidate.input_manifest_hash is not None
    assert candidate.catalog_revision is not None
    assert candidate.catalog_inventory_hash is not None
    assert candidate.engine_package_version is not None
    assert candidate.engine_tag_commit is not None
    assert candidate.risk_policy_hash is not None

    for label, value in (
        ("strategy id", evidence.strategy_id),
        ("strategy version", evidence.strategy_version),
        ("risk policy id", evidence.risk_policy_id),
        ("risk policy version", evidence.risk_policy_version),
        ("engine Python version", evidence.engine_python_version),
        ("engine precision mode", evidence.engine_precision_mode),
    ):
        _require_nonempty_string(value, label=label)
    for label, value in (
        ("strategy hash", evidence.strategy_hash),
        ("risk policy hash", evidence.risk_policy_hash),
    ):
        _require_digest(value, label=label)
    if type(evidence.catalog_publication_bytes) is not bytes:
        raise EventRejected("Catalog publication evidence must be exact bytes.")

    strategy_object = _parse_exact_schema_less_object(
        evidence.strategy_bytes,
        label="strategy definition",
    )
    risk_object = _parse_exact_schema_less_object(
        evidence.risk_policy_bytes,
        label="risk policy definition",
    )
    if (
        sha256(evidence.strategy_bytes).hexdigest() != evidence.strategy_hash
        or sha256(evidence.risk_policy_bytes).hexdigest() != evidence.risk_policy_hash
        or evidence.risk_policy_hash != candidate.risk_policy_hash
    ):
        raise EventRejected("READY definition hashes do not match their exact bytes.")

    try:
        draft = BacktestDraftRequest.model_validate(
            _parse_exact_schema_less_object(
                candidate.request_bytes,
                label="preflight draft request",
            )
        )
        manifest = InputManifestV1.model_validate(
            _parse_exact_declared_object(
                candidate.input_manifest_bytes,
                label="input manifest",
            )
        )
        complete_cost_fill = CostFillModelV1.model_validate(
            draft.cost_fill_model.model_dump(mode="json", by_alias=True)
        )
        DeterminismProbeConfigV1.model_validate(strategy_object)
        ProbeRiskPolicyV1.model_validate(risk_object)
    except (ValidationError, ValueError) as error:
        raise EventRejected("READY preflight evidence is invalid.") from error

    if publication.publication_bytes != evidence.catalog_publication_bytes:
        raise EventRejected("READY catalog publication bytes changed.")
    try:
        catalog = _validate_catalog_publication_identity(
            catalog_revision=publication.catalog_revision,
            fixture_id=publication.fixture_id,
            inventory_hash=publication.inventory_hash,
            publication_bytes=evidence.catalog_publication_bytes,
            staging_identity=publication.staging_identity,
        )
    except (ValueError, CatalogConflict) as error:
        raise EventRejected("READY catalog publication evidence is invalid.") from error
    if not isinstance(catalog, CatalogManifestV1):
        raise EventRejected("READY catalog publication schema is unsupported.")

    fingerprint = catalog.inventory.native_fingerprint
    instrument = catalog.inventory.instrument
    if (
        candidate.engine_package_version != PINNED_ENGINE_PACKAGE_VERSION
        or candidate.engine_tag_commit != PINNED_ENGINE_TAG_COMMIT
        or evidence.engine_python_version != PINNED_ENGINE_PYTHON_VERSION
        or evidence.engine_precision_mode != PINNED_ENGINE_PRECISION_MODE
        or fingerprint.installed_nautilus_version != candidate.engine_package_version
        or fingerprint.python_version != evidence.engine_python_version
        or instrument.price_precision > PINNED_ENGINE_FIXED_PRECISION
        or instrument.size_precision > PINNED_ENGINE_FIXED_PRECISION
    ):
        raise EventRejected("READY engine identity is not bound to the catalog and native pin.")

    manifest_object = manifest.model_dump(mode="json", by_alias=True)
    expected_instruments = [
        {
            "instrument_id": catalog.inventory.instrument.instrument_id,
            "price_increment": catalog.inventory.instrument.price_increment,
            "quantity_increment": catalog.inventory.instrument.size_increment,
        }
    ]
    draft_venue_account = draft.venue_account_model
    if draft_venue_account is None:
        raise EventRejected("READY manifest account evidence is missing.")
    if (
        evidence.strategy_id != "determinism-probe"
        or evidence.strategy_version != "v1"
        or evidence.risk_policy_id != "probe-risk"
        or evidence.risk_policy_version != "v1"
        or draft.strategy_ref != f"{evidence.strategy_id}@{evidence.strategy_version}"
        or draft.risk_policy_ref != f"{evidence.risk_policy_id}@{evidence.risk_policy_version}"
        or draft.catalog_revision != candidate.catalog_revision
        or manifest.environment != draft.environment
        or manifest.strategy_id != evidence.strategy_id
        or manifest.strategy_version != evidence.strategy_version
        or manifest_object["canonical_config"] != strategy_object
        or manifest.config_hash != evidence.strategy_hash
        or manifest.engine_package_version != candidate.engine_package_version
        or manifest.engine_tag_commit != candidate.engine_tag_commit
        or manifest.python_version != evidence.engine_python_version
        or manifest.precision_mode != evidence.engine_precision_mode
        or manifest.fixture_id != catalog.fixture_id
        or manifest.catalog_revision != publication.catalog_revision
        or manifest.catalog_revision != candidate.catalog_revision
        or manifest.source_checksum != catalog.source_checksum
        or manifest.catalog_checksum != catalog.catalog_checksum
        or catalog.inventory_hash != publication.inventory_hash
        or publication.inventory_hash != candidate.catalog_inventory_hash
        or manifest_object["instruments"] != expected_instruments
        or tuple(manifest.data_types) != tuple(catalog.inventory.readback.data_types)
        or manifest.window != draft.window
        or manifest.timezone != catalog.inventory.timezone
        or manifest.gaps != catalog.inventory.gaps
        or manifest.duplicates != catalog.inventory.duplicates
        or manifest.ordering_result != catalog.inventory.ordering_result
        or manifest.information_set_policy != draft.information_set_policy
        or manifest.information_set_policy != catalog.inventory.information_set_policy
        or manifest.evaluation_protocol != draft.evaluation_protocol
        or manifest.evaluation_protocol != catalog.inventory.evaluation_protocol
        or manifest.venue_account_model.model_dump(mode="json", by_alias=True)
        != draft_venue_account.model_dump(mode="json", by_alias=True)
        or manifest.cost_fill_model != complete_cost_fill
        or manifest.risk_policy_id != evidence.risk_policy_id
        or manifest.risk_policy_version != evidence.risk_policy_version
        or manifest_object["canonical_risk_policy"] != risk_object
        or manifest.risk_policy_hash != evidence.risk_policy_hash
        or manifest.replay_seed != draft.replay_seed
    ):
        raise EventRejected("READY manifest does not bind all exact server evidence.")
    if (
        draft_venue_account.venue_id != catalog.inventory.instrument.venue
        or draft_venue_account.currency != catalog.inventory.instrument.quote_currency
        or _numeric_string_less(
            draft.window.start_ns,
            catalog.inventory.readback.first_ts_init,
        )
        or _numeric_string_less(
            _increment_numeric_string(catalog.inventory.readback.last_ts_init),
            draft.window.end_ns,
        )
    ):
        raise EventRejected("READY manifest window or account is outside catalog evidence.")


def _numeric_string_less(left: str, right: str) -> bool:
    return (len(left), left) < (len(right), right)


def _increment_numeric_string(value: str) -> str:
    digits = list(value)
    carry = 1
    for index in range(len(digits) - 1, -1, -1):
        next_digit = ord(digits[index]) - ord("0") + carry
        digits[index] = chr(ord("0") + (next_digit % 10))
        carry = next_digit // 10
        if carry == 0:
            break
    if carry:
        digits.insert(0, "1")
    return "".join(digits)


def _validate_consumed_manifest_evidence(
    *,
    manifest_bytes: bytes,
    publication: CatalogPublication | None,
    publication_bytes: bytes,
    engine_package_version: str,
    engine_tag_commit: str,
    python_version: str,
    precision_mode: str,
    risk_policy_hash: str,
) -> None:
    manifest, catalog = _validated_historical_manifest_evidence(
        manifest_bytes=manifest_bytes,
        publication=publication,
        publication_bytes=publication_bytes,
        engine_package_version=engine_package_version,
        engine_tag_commit=engine_tag_commit,
        python_version=python_version,
        precision_mode=precision_mode,
        risk_policy_hash=risk_policy_hash,
        require_published=True,
    )
    manifest_object = manifest.model_dump(mode="json", by_alias=True)
    DeterminismProbeConfigV1.model_validate(manifest_object["canonical_config"])
    ProbeRiskPolicyV1.model_validate(manifest_object["canonical_risk_policy"])
    instrument = catalog.inventory.instrument
    if (
        manifest.strategy_id != "determinism-probe"
        or manifest.strategy_version != "v1"
        or manifest.risk_policy_id != "probe-risk"
        or manifest.risk_policy_version != "v1"
        or engine_package_version != PINNED_ENGINE_PACKAGE_VERSION
        or engine_tag_commit != PINNED_ENGINE_TAG_COMMIT
        or python_version != PINNED_ENGINE_PYTHON_VERSION
        or precision_mode != PINNED_ENGINE_PRECISION_MODE
        or instrument.price_precision > PINNED_ENGINE_FIXED_PRECISION
        or instrument.size_precision > PINNED_ENGINE_FIXED_PRECISION
    ):
        raise EventRejected("PREFLIGHT_STALE")


def _validated_historical_manifest_evidence(
    *,
    manifest_bytes: bytes,
    publication: CatalogPublication | None,
    publication_bytes: bytes,
    engine_package_version: str,
    engine_tag_commit: str,
    python_version: str,
    precision_mode: str,
    risk_policy_hash: str,
    require_published: bool,
) -> tuple[InputManifestV1, CatalogManifestV1]:
    if (
        publication is None
        or (require_published and publication.status != "PUBLISHED")
        or (not require_published and publication.status not in {"PUBLISHED", "INTEGRITY_FAILED"})
        or publication.publication_bytes != publication_bytes
    ):
        raise EventRejected("PREFLIGHT_STALE")
    manifest = InputManifestV1.model_validate(
        _parse_exact_declared_object(manifest_bytes, label="input manifest")
    )
    catalog = _validate_catalog_publication_identity(
        catalog_revision=publication.catalog_revision,
        fixture_id=publication.fixture_id,
        inventory_hash=publication.inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=publication.staging_identity,
    )
    if not isinstance(catalog, CatalogManifestV1):
        raise EventRejected("PREFLIGHT_STALE")
    manifest_object = manifest.model_dump(mode="json", by_alias=True)
    config_bytes = canonical_json_bytes(manifest_object["canonical_config"])
    risk_bytes = canonical_json_bytes(manifest_object["canonical_risk_policy"])
    expected_instruments = [
        {
            "instrument_id": catalog.inventory.instrument.instrument_id,
            "price_increment": catalog.inventory.instrument.price_increment,
            "quantity_increment": catalog.inventory.instrument.size_increment,
        }
    ]
    fingerprint = catalog.inventory.native_fingerprint
    if (
        fingerprint.installed_nautilus_version != engine_package_version
        or fingerprint.python_version != python_version
        or manifest.engine_package_version != engine_package_version
        or manifest.engine_tag_commit != engine_tag_commit
        or manifest.python_version != python_version
        or manifest.precision_mode != precision_mode
        or manifest.risk_policy_hash != risk_policy_hash
        or manifest.config_hash != sha256(config_bytes).hexdigest()
        or manifest.risk_policy_hash != sha256(risk_bytes).hexdigest()
        or manifest.fixture_id != catalog.fixture_id
        or manifest.catalog_revision != publication.catalog_revision
        or manifest.source_checksum != catalog.source_checksum
        or manifest.catalog_checksum != catalog.catalog_checksum
        or manifest_object["instruments"] != expected_instruments
        or tuple(manifest.data_types) != tuple(catalog.inventory.readback.data_types)
        or manifest.timezone != catalog.inventory.timezone
        or manifest.gaps != catalog.inventory.gaps
        or manifest.duplicates != catalog.inventory.duplicates
        or manifest.ordering_result != catalog.inventory.ordering_result
        or manifest.information_set_policy != catalog.inventory.information_set_policy
        or manifest.evaluation_protocol != catalog.inventory.evaluation_protocol
        or manifest.venue_account_model.venue_id != catalog.inventory.instrument.venue
        or manifest.venue_account_model.currency != catalog.inventory.instrument.quote_currency
    ):
        raise EventRejected("PREFLIGHT_STALE")
    return manifest, catalog


def _prepare_catalog_publication_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    catalog_revision: str,
    fixture_id: str,
    inventory_hash: str,
    publication_bytes: bytes,
    staging_identity: str,
) -> CatalogPublication:
    _validate_catalog_publication_identity(
        catalog_revision=catalog_revision,
        fixture_id=fixture_id,
        inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=staging_identity,
    )
    with _immediate_transaction(connection):
        existing = _read_catalog_publication(connection, catalog_revision)
        if existing is not None:
            _require_catalog_identity(
                existing,
                fixture_id=fixture_id,
                inventory_hash=inventory_hash,
                publication_bytes=publication_bytes,
                staging_identity=staging_identity,
            )
            return existing
        prepared_at_ns = _clock_ns(clock)
        try:
            connection.execute(
                """
                INSERT INTO catalog_publications (
                    catalog_revision, fixture_id, status, inventory_hash,
                    publication_bytes, staging_identity, prepared_at_ns, published_at_ns
                ) VALUES (?, ?, 'PREPARED', ?, ?, ?, ?, NULL)
                """,
                (
                    catalog_revision,
                    fixture_id,
                    inventory_hash,
                    publication_bytes,
                    staging_identity,
                    prepared_at_ns,
                ),
            )
        except sqlite3.IntegrityError as error:
            raise CatalogConflict from error
        result = _read_catalog_publication(connection, catalog_revision)
        assert result is not None
        return result


def _publish_catalog_publication_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    catalog_revision: str,
    fixture_id: str,
    inventory_hash: str,
    publication_bytes: bytes,
    staging_identity: str,
    audit_intent_bytes: bytes,
) -> CatalogPublication:
    manifest = _validate_catalog_publication_identity(
        catalog_revision=catalog_revision,
        fixture_id=fixture_id,
        inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=staging_identity,
    )
    audit = _parse_exact_catalog_audit(audit_intent_bytes, manifest=manifest)
    if isinstance(manifest, CatalogManifestV1):
        if not isinstance(audit, CatalogValidatedAuditV1) or (
            audit.catalog_revision != catalog_revision
            or audit.fixture_id != fixture_id
            or audit.inventory_hash != inventory_hash
            or audit.source_checksum != manifest.source_checksum
            or audit.catalog_checksum != manifest.catalog_checksum
        ):
            raise CatalogConflict
    elif not isinstance(audit, CatalogValidatedAuditV2) or (
        audit.catalog_revision != catalog_revision
        or audit.source_id != fixture_id
        or audit.inventory_hash != inventory_hash
        or audit.raw_sha256 != manifest.raw_sha256
        or audit.metadata_sha256 != manifest.metadata_sha256
        or audit.catalog_checksum != manifest.catalog_checksum
    ):
        raise CatalogConflict
    with _immediate_transaction(connection):
        existing = _read_catalog_publication(connection, catalog_revision)
        if existing is None:
            raise CatalogConflict
        _require_catalog_identity(
            existing,
            fixture_id=fixture_id,
            inventory_hash=inventory_hash,
            publication_bytes=publication_bytes,
            staging_identity=staging_identity,
        )
        if existing.status == "INTEGRITY_FAILED":
            raise CatalogIntegrityFailed
        if existing.status == "PUBLISHED":
            if existing.audit_intent_bytes != audit_intent_bytes:
                raise CatalogConflict
            return existing
        if existing.audit_intent_bytes is not None:
            raise CatalogConflict
        published_at_ns = _clock_ns(clock)
        updated = connection.execute(
            """
            UPDATE catalog_publications
            SET status = 'PUBLISHED', published_at_ns = ?
            WHERE catalog_revision = ? AND status = 'PREPARED' AND published_at_ns IS NULL
            """,
            (published_at_ns, catalog_revision),
        )
        if updated.rowcount != 1:
            raise CatalogConflict
        connection.execute(
            """
            INSERT INTO catalog_audit_intents (catalog_revision, intent_bytes, created_at_ns)
            VALUES (?, ?, ?)
            """,
            (catalog_revision, audit_intent_bytes, published_at_ns),
        )
        result = _read_catalog_publication(connection, catalog_revision)
        assert result is not None
        return result


def _mark_catalog_integrity_failed_transaction(
    connection: sqlite3.Connection,
    *,
    catalog_revision: str,
    fixture_id: str,
    inventory_hash: str,
    publication_bytes: bytes,
    staging_identity: str,
) -> CatalogPublication:
    _validate_catalog_publication_identity(
        catalog_revision=catalog_revision,
        fixture_id=fixture_id,
        inventory_hash=inventory_hash,
        publication_bytes=publication_bytes,
        staging_identity=staging_identity,
    )
    with _immediate_transaction(connection):
        existing = _read_catalog_publication(connection, catalog_revision)
        if existing is None:
            raise CatalogConflict
        _require_catalog_identity(
            existing,
            fixture_id=fixture_id,
            inventory_hash=inventory_hash,
            publication_bytes=publication_bytes,
            staging_identity=staging_identity,
        )
        if existing.status == "PREPARED" or existing.audit_intent_bytes is None:
            raise CatalogIntegrityFailed
        if existing.status == "INTEGRITY_FAILED":
            return existing
        updated = connection.execute(
            """
            UPDATE catalog_publications
            SET status = 'INTEGRITY_FAILED'
            WHERE catalog_revision = ? AND status = 'PUBLISHED'
            """,
            (catalog_revision,),
        )
        if updated.rowcount != 1:
            raise CatalogConflict
        result = _read_catalog_publication(connection, catalog_revision)
        assert result is not None
        return result


def read_catalog_publication(
    connection: sqlite3.Connection, catalog_revision: str
) -> CatalogPublication | None:
    _require_digest(catalog_revision, label="catalog revision")
    return _read_catalog_publication(connection, catalog_revision)


def read_recoverable_catalog_publications(
    connection: sqlite3.Connection,
) -> tuple[CatalogPublication, ...]:
    rows = connection.execute(
        """
        SELECT
            publication.catalog_revision,
            publication.fixture_id,
            publication.status,
            publication.inventory_hash,
            publication.publication_bytes,
            publication.staging_identity,
            publication.prepared_at_ns,
            publication.published_at_ns,
            audit.intent_bytes AS audit_intent_bytes
        FROM catalog_publications AS publication
        LEFT JOIN catalog_audit_intents AS audit
          ON audit.catalog_revision = publication.catalog_revision
        WHERE publication.status IN ('PREPARED', 'PUBLISHED')
        ORDER BY publication.catalog_revision
        """
    ).fetchall()
    return tuple(_catalog_publication_from_row(row) for row in rows)


def read_run(connection: sqlite3.Connection, run_id: str) -> RunSnapshot:
    _require_nonempty_string(run_id, label="run_id")
    row = connection.execute(
        """
        SELECT
            run_id,
            state,
            state_version,
            last_event_seq,
            last_audit_seq,
            input_manifest_bytes,
            input_manifest_hash,
            catalog_revision,
            catalog_inventory_hash,
            created_at_ns,
            evidence_status,
            contract_kind
        FROM runs
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is None:
        raise RunNotFound(run_id)
    return _snapshot_from_row(row)


def read_run_evidence_snapshot(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> RunEvidenceSnapshot:
    """Read all RunResponse authorities from one coherent SQLite snapshot."""

    _require_nonempty_string(run_id, label="run evidence run_id")
    _verify_write_connection(connection)
    owns_snapshot = not connection.in_transaction
    if owns_snapshot:
        connection.execute("BEGIN")
    try:
        run = read_run(connection, run_id)
        events = _read_events(connection, run_id, visible_only=True)
        last_visible_seq = events[-1].seq if events else 0
        if last_visible_seq != run.last_event_seq:
            raise TerminalIntegrityError("Run visible cursor differs from persisted run authority.")

        identity = (
            run.input_manifest_bytes,
            run.input_manifest_hash,
            run.catalog_revision,
            run.catalog_inventory_hash,
        )
        if any(value is not None for value in identity) and any(
            value is None for value in identity
        ):
            raise TerminalIntegrityError("Run input and catalog identity is partial.")
        catalog_publication: CatalogPublication | None = None
        if run.input_manifest_bytes is not None:
            assert run.input_manifest_hash is not None
            assert run.catalog_revision is not None
            assert run.catalog_inventory_hash is not None
            try:
                manifest_value = parse_json_object(run.input_manifest_bytes)
                manifest = InputManifestV1.model_validate(manifest_value)
                if (
                    canonical_json_bytes(manifest.model_dump(mode="json", by_alias=True))
                    != run.input_manifest_bytes
                    or sha256(run.input_manifest_bytes).hexdigest() != run.input_manifest_hash
                    or manifest.catalog_revision != run.catalog_revision
                ):
                    raise ValueError("Run manifest identity differs from SQLite authority.")
            except (CanonicalJSONError, ValidationError, ValueError) as error:
                raise TerminalIntegrityError("Persisted run manifest is invalid.") from error
            catalog_publication = read_catalog_publication(connection, run.catalog_revision)
            if (
                catalog_publication is None
                or catalog_publication.status != "PUBLISHED"
                or catalog_publication.inventory_hash != run.catalog_inventory_hash
            ):
                raise TerminalIntegrityError(
                    "Run catalog publication is missing or differs from its bound identity."
                )

        try:
            runner_outcome = read_runner_outcome(connection, run_id)
            process: RunnerProcessRecord | None = None
            if runner_outcome is not None:
                process_row = _read_runner_process_row(connection, run_id)
                process = (
                    None
                    if process_row is None
                    else _runner_process_from_row(process_row, created_by_caller=False)
                )
                if (
                    process is not None
                    and process.identity is not None
                    and (
                        process_identity_digest(process.identity)
                        != runner_outcome.outcome.process_identity_sha256
                        or process.launched_at_ns != runner_outcome.outcome.launched_at_ns
                    )
                ):
                    raise TerminalIntegrityError(
                        "Runner outcome does not bind canonical attached process authority."
                    )
            if runner_outcome is not None and runner_outcome.outcome.classification in {
                "NATURAL_SUCCESS",
                "NATURAL_FAILURE",
            }:
                if (
                    process is None
                    or process.identity is None
                    or process.launched_at_ns is None
                    or runner_outcome.outcome.process_identity_sha256 is None
                    or runner_outcome.outcome.launched_at_ns is None
                ):
                    raise TerminalIntegrityError(
                        "Natural runner outcome has no attached process authority."
                    )
        except TerminalIntegrityError:
            raise
        except RuntimeError as error:
            raise TerminalIntegrityError("Persisted runner authority is invalid.") from error
        terminal_preparation = read_terminal_preparation(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        terminal_finalization = read_terminal_finalization(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if terminal_preparation is not None and runner_outcome is None:
            raise TerminalIntegrityError("Terminal preparation has no runner outcome authority.")
        snapshot = RunEvidenceSnapshot(
            run=run,
            last_visible_seq=last_visible_seq,
            events=events,
            catalog_publication=catalog_publication,
            runner_outcome=runner_outcome,
            terminal_preparation=terminal_preparation,
            terminal_finalization=terminal_finalization,
        )
    except BaseException:
        if owns_snapshot and connection.in_transaction:
            connection.rollback()
        raise
    if owns_snapshot:
        connection.rollback()
    return snapshot


def _read_events(
    connection: sqlite3.Connection,
    run_id: str,
    *,
    visible_only: bool,
) -> tuple[PersistedEvent, ...]:
    read_run(connection, run_id)
    predicate = "AND visible = 1" if visible_only else ""
    rows = connection.execute(
        f"""
        SELECT
            event_id,
            run_id,
            seq,
            source_seq,
            source,
            type,
            ts_event_ns,
            ts_ingest_ns,
            visible,
            envelope_bytes
        FROM events
        WHERE run_id = ? {predicate}
        ORDER BY seq
        """,
        (run_id,),
    ).fetchall()
    return tuple(_event_from_row(row) for row in rows)


def read_audit_intents(connection: sqlite3.Connection, run_id: str) -> tuple[AuditIntent, ...]:
    read_run(connection, run_id)
    rows = connection.execute(
        """
        SELECT run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        FROM audit_intents
        WHERE run_id = ?
        ORDER BY audit_seq
        """,
        (run_id,),
    ).fetchall()
    return tuple(_audit_from_row(row) for row in rows)


def read_pending_outbox(connection: sqlite3.Connection, run_id: str) -> tuple[OutboxRecord, ...]:
    read_run(connection, run_id)
    rows = connection.execute(
        """
        SELECT run_id, seq, audit_seq, materialized, materialized_at_ns
        FROM outbox
        WHERE run_id = ? AND materialized = 0
        ORDER BY seq
        """,
        (run_id,),
    ).fetchall()
    return tuple(_outbox_from_row(row) for row in rows)


def _reserve_run(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    run_id: str,
    input_manifest_bytes: bytes | None,
    input_manifest_hash: str | None,
    catalog_revision: str | None,
    catalog_inventory_hash: str | None,
) -> RunSnapshot:
    _require_nonempty_string(run_id, label="run_id")
    identity = (
        input_manifest_bytes,
        input_manifest_hash,
        catalog_revision,
        catalog_inventory_hash,
    )
    if any(value is not None for value in identity):
        if any(value is None for value in identity):
            raise ValueError(
                "Manifest bytes, digest, and catalog identity must be stored together."
            )
        assert input_manifest_bytes is not None
        assert input_manifest_hash is not None
        assert catalog_revision is not None
        assert catalog_inventory_hash is not None
        _require_exact_canonical_object(input_manifest_bytes, label="input manifest")
        manifest_kind = _parse_exact_schema_less_object(
            input_manifest_bytes, label="input manifest"
        ).get("schema")
        if manifest_kind is not None and manifest_kind != "InputManifest.v1":
            raise RunContractMismatch("run contract requires a legacy input manifest")
        _require_digest(input_manifest_hash, label="input manifest hash")
        if sha256(input_manifest_bytes).hexdigest() != input_manifest_hash:
            raise ValueError("Input manifest hash does not match the exact canonical bytes.")
        _require_nonempty_string(catalog_revision, label="catalog revision")
        _require_digest(catalog_inventory_hash, label="catalog inventory hash")
        publication = connection.execute(
            """
            SELECT status
            FROM catalog_publications
            WHERE catalog_revision = ? AND inventory_hash = ?
            """,
            (catalog_revision, catalog_inventory_hash),
        ).fetchone()
        if publication is None or _row_str(publication, "status") != "PUBLISHED":
            raise ValueError("Run reservation requires an exact published catalog identity.")
    created_at_ns = _clock_ns(clock)
    connection.execute(
        """
        INSERT INTO runs (
            run_id,
            state,
            created_at_ns,
            input_manifest_bytes,
            input_manifest_hash,
            catalog_revision,
            catalog_inventory_hash
        ) VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            created_at_ns,
            input_manifest_bytes,
            input_manifest_hash,
            catalog_revision,
            catalog_inventory_hash,
        ),
    )
    return read_run(connection, run_id)


def _mutate_event(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    run_id: str,
    expected_version: int,
    target: RunState | None,
    candidate: EventCandidate,
) -> PersistedTransition:
    _require_nonempty_string(run_id, label="run_id")
    if type(expected_version) is not int or expected_version < 0:
        raise ValueError("expected_version must be a non-negative integer.")
    if target is None:
        _prevalidate_append(candidate)
    else:
        _prevalidate_transition(target=target, candidate=candidate)

    row = connection.execute(
        """
        SELECT
            state,
            state_version,
            last_event_seq,
            last_audit_seq,
            control_source_seq,
            runner_source_seq,
            prepared_terminal_state,
            prepared_terminal_state_version,
            prepared_terminal_event_seq,
            EXISTS (
                SELECT 1
                FROM events
                WHERE events.run_id = runs.run_id
                  AND events.type IN ('run.completed', 'run.failed', 'run.cancelled')
            ) AS terminal_event_exists
        FROM runs
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is None:
        raise RunNotFound(run_id)
    current = RunState(_row_str(row, "state"))
    actual_version = _row_int(row, "state_version")
    if actual_version != expected_version:
        raise VersionConflict(run_id=run_id, expected=expected_version, actual=actual_version)
    if current in TERMINAL_STATES:
        raise EventRejected(f"Terminal run state {current} cannot accept events.")
    if (
        _row_optional_str(row, "prepared_terminal_state") is not None
        or _row_optional_int(row, "prepared_terminal_state_version") is not None
        or _row_optional_int(row, "prepared_terminal_event_seq") is not None
        or _row_int(row, "terminal_event_exists") != 0
    ):
        raise EventRejected("Prepared or existing terminal boundary freezes generic mutations.")

    if target is None:
        _require_append_state(current=current, candidate=candidate)
        next_state = current
        next_version = actual_version
    else:
        try:
            next_state = transition(current, target)
        except StateConflict as error:
            raise EventRejected(str(error)) from error
        next_version = actual_version + 1

    if target is RunState.QUEUED:
        require_historical_capacity(connection, run_id)

    seq = _row_int(row, "last_event_seq") + 1
    audit_seq = _row_int(row, "last_audit_seq") + 1
    control_source_seq = _row_int(row, "control_source_seq")
    runner_source_seq = _row_optional_int(row, "runner_source_seq")
    if candidate.source == "control-api":
        source_seq = control_source_seq + 1
        next_control_source_seq = source_seq
        next_runner_source_seq = runner_source_seq
    else:
        assert candidate.source_seq is not None
        source_seq = candidate.source_seq
        if runner_source_seq is not None and source_seq <= runner_source_seq:
            raise EventRejected(
                "Runner source_seq must be strictly greater than the persisted cursor."
            )
        next_control_source_seq = control_source_seq
        next_runner_source_seq = source_seq

    updated = connection.execute(
        """
        UPDATE runs
        SET
            state = ?,
            state_version = ?,
            last_event_seq = ?,
            last_audit_seq = ?,
            control_source_seq = ?,
            runner_source_seq = ?
        WHERE run_id = ? AND state_version = ?
        """,
        (
            next_state.value,
            next_version,
            seq,
            audit_seq,
            next_control_source_seq,
            next_runner_source_seq,
            run_id,
            expected_version,
        ),
    )
    if updated.rowcount != 1:
        latest = read_run(connection, run_id)
        raise VersionConflict(
            run_id=run_id,
            expected=expected_version,
            actual=latest.state_version,
        )

    event_id = event_id_factory(run_id, seq)
    _require_nonempty_string(event_id, label="event_id")
    ts_ingest_ns = str(_clock_ns(clock))
    try:
        envelope = EventEnvelopeV1.model_validate(
            {
                "event_id": event_id,
                "run_id": run_id,
                "seq": seq,
                "source_seq": source_seq,
                "ts_event_ns": candidate.ts_event_ns,
                "ts_ingest_ns": ts_ingest_ns,
                "type": candidate.type,
                "source": candidate.source,
                "writer": "control-api",
                "schema_version": 1,
                "payload": candidate.payload,
            }
        )
    except ValidationError as error:
        raise EventRejected(f"Invalid EventEnvelopeV1: {error}") from error
    envelope_bytes = canonical_json_bytes(envelope.model_dump(mode="json", by_alias=True))
    event_digest = sha256(envelope_bytes).hexdigest()
    intent_bytes = canonical_json_bytes(
        {
            "seq": audit_seq,
            "run_id": run_id,
            "event_seq": seq,
            "event_digest": event_digest,
        }
    )

    connection.execute(
        """
        INSERT INTO events (
            event_id,
            run_id,
            seq,
            source_seq,
            source,
            type,
            writer,
            schema_version,
            ts_event_ns,
            ts_ingest_ns,
            visible,
            envelope_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, 'control-api', 1, ?, ?, 1, ?)
        """,
        (
            event_id,
            run_id,
            seq,
            source_seq,
            candidate.source,
            candidate.type,
            candidate.ts_event_ns,
            ts_ingest_ns,
            envelope_bytes,
        ),
    )
    connection.execute(
        """
        INSERT INTO audit_intents (
            run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (run_id, audit_seq, seq, event_digest, intent_bytes, int(ts_ingest_ns)),
    )
    connection.execute(
        "INSERT INTO outbox (run_id, seq, audit_seq) VALUES (?, ?, ?)",
        (run_id, seq, audit_seq),
    )
    event = PersistedEvent(
        event_id=event_id,
        run_id=run_id,
        seq=seq,
        source_seq=source_seq,
        source=candidate.source,
        type=candidate.type,
        ts_event_ns=candidate.ts_event_ns,
        ts_ingest_ns=ts_ingest_ns,
        visible=True,
        envelope_bytes=envelope_bytes,
    )
    return PersistedTransition(
        run_id=run_id,
        state=next_state,
        state_version=next_version,
        event=event,
        audit_seq=audit_seq,
    )


def _prevalidate_transition(*, target: RunState, candidate: EventCandidate) -> None:
    if type(target) is not RunState:
        raise EventRejected("Transition target must be a RunState value.")
    if target in TERMINAL_STATES:
        raise EventRejected("Generic control operations cannot publish terminal transitions.")
    _validate_candidate(candidate)
    if candidate.source != "control-api":
        raise EventRejected("Runner candidates cannot change run state.")
    mapped_target = LIFECYCLE_TARGETS.get(candidate.type)
    if mapped_target is None or mapped_target is not target:
        raise EventRejected(
            f"Lifecycle event {candidate.type!r} does not map to target {target.value}."
        )


def _prevalidate_append(candidate: EventCandidate) -> None:
    _validate_candidate(candidate)
    if candidate.type in TERMINAL_EVENT_TYPES:
        raise EventRejected("Generic control operations cannot publish terminal events.")
    if candidate.type in LIFECYCLE_TARGETS:
        raise EventRejected(
            "Lifecycle events must use commit_transition and cannot self-transition."
        )
    if candidate.source == "control-api" and candidate.type != "report.generated":
        raise EventRejected(f"Control event {candidate.type!r} is not append-only.")
    if candidate.source == "runner" and candidate.type not in RUNNER_EVENT_TYPES:
        raise EventRejected(f"Runner event {candidate.type!r} is not registered.")


def _validate_candidate(candidate: EventCandidate) -> None:
    if type(candidate) is not EventCandidate:
        raise EventRejected("Event candidate must be an exact EventCandidate.")
    if candidate.source == "control-api":
        if candidate.type not in CONTROL_EVENT_TYPES:
            raise EventRejected(f"Control event {candidate.type!r} is not registered.")
        if candidate.source_seq is not None:
            raise EventRejected("Control source_seq is allocated by the store.")
    elif candidate.source == "runner":
        if candidate.type not in RUNNER_EVENT_TYPES:
            raise EventRejected(f"Runner event {candidate.type!r} is not registered.")
        if type(candidate.source_seq) is not int or candidate.source_seq < 0:
            raise EventRejected("Runner source_seq must be a non-negative integer.")
    else:
        raise EventRejected(f"Unknown event source: {candidate.source!r}.")
    if type(candidate.ts_event_ns) is not str:
        raise EventRejected("ts_event_ns must be a canonical nanosecond string.")
    if type(candidate.payload) is not dict:
        raise EventRejected("Event payload must be an exact JSON object.")


def _require_append_state(*, current: RunState, candidate: EventCandidate) -> None:
    if candidate.source == "runner" and current not in _RUNNER_APPEND_STATES:
        raise EventRejected(f"Runner event {candidate.type!r} is not allowed in state {current}.")
    if candidate.type == "report.generated" and current is not RunState.FINALIZING:
        raise EventRejected("report.generated is allowed only in FINALIZING.")


def _validate_idempotency_command(command: IdempotencyCommand) -> _ValidatedCommand:
    if type(command) is not IdempotencyCommand:
        raise TypeError("Idempotency command must be an exact IdempotencyCommand.")
    operation_value = command.operation
    key = command.key
    canonical_request_bytes = command.canonical_request_bytes
    run_id = command.run_id
    try:
        configuration_id = command.configuration_id
        configuration_content_sha256 = command.configuration_content_sha256
    except AttributeError as error:
        raise ValueError("Idempotency command configuration identity is invalid.") from error
    if type(operation_value) is not str or operation_value not in {
        "preflight",
        "create",
        "cancel",
    }:
        raise ValueError("Idempotency command operation is invalid.")
    operation = cast(IdempotencyOperation, operation_value)
    _require_nonempty_string(key, label="idempotency command key")
    if type(canonical_request_bytes) is not bytes:
        raise ValueError("Idempotency command request body must be exact canonical bytes.")
    _require_exact_canonical_object(
        canonical_request_bytes,
        label="idempotency command request body",
    )
    if operation == "cancel":
        if run_id is None:
            raise ValueError("Idempotency command cancel run_id is required.")
        _require_nonempty_string(run_id, label="idempotency command cancel run_id")
        target_run_id = run_id
        scope = f"backtest.cancel/{target_run_id}"
    else:
        if run_id is not None:
            raise ValueError("Idempotency command run_id is allowed only for cancel.")
        target_run_id = None
        scope = f"backtest.{operation}"
    if (configuration_id is None) != (configuration_content_sha256 is None):
        raise ValueError("Idempotency command configuration identity is incomplete.")
    if configuration_id is not None:
        if operation != "preflight":
            raise ValueError("Idempotency command configuration identity requires preflight.")
        _require_configuration_id(configuration_id)
        assert configuration_content_sha256 is not None
        _require_digest(
            configuration_content_sha256,
            label="idempotency command configuration content hash",
        )
    logical_request_bytes = _logical_request_bytes(
        operation=operation,
        canonical_request_bytes=canonical_request_bytes,
        run_id=target_run_id,
        configuration_id=configuration_id,
        configuration_content_sha256=configuration_content_sha256,
    )
    return _ValidatedCommand(
        operation=operation,
        scope=scope,
        key=key,
        logical_request_bytes=logical_request_bytes,
        request_hash=sha256(logical_request_bytes).hexdigest(),
        bare_request_bytes=canonical_request_bytes,
        bare_request_hash=sha256(canonical_request_bytes).hexdigest(),
        target_run_id=target_run_id,
        configuration_id=configuration_id,
        configuration_content_sha256=configuration_content_sha256,
    )


def _validate_idempotent_response(
    response: IdempotentResponse,
    *,
    command: _ValidatedCommand,
    bound_run_id: str | None,
) -> IdempotentResponse:
    if type(response) is not IdempotentResponse:
        raise TypeError("Idempotency handler must return IdempotentResponse.")
    validated = IdempotentResponse(
        status_code=response.status_code,
        body=response.body,
        run_id=response.run_id,
    )
    expected_status = {"preflight": 200, "create": 202}.get(command.operation)
    if expected_status is not None and validated.status_code != expected_status:
        raise ControlStoreError(
            f"Persisted {command.operation} response status must be exactly {expected_status}."
        )
    response_object = _parse_exact_schema_less_object(
        validated.body,
        label="response body",
    )
    if command.operation == "create":
        _validated_create_response_object(response_object)
    if "run_id" in response_object:
        response_body_run_id = response_object["run_id"]
        if type(response_body_run_id) is not str or not response_body_run_id:
            raise ControlStoreError("Idempotent response body run_id must be a non-empty string.")
        if response_body_run_id != validated.run_id:
            raise ControlStoreError(
                "Idempotent response body run_id does not match response metadata."
            )
    if command.target_run_id is not None:
        if validated.run_id is not None and validated.run_id != command.target_run_id:
            raise ControlStoreError("Idempotent response run_id does not match the cancel target.")
        if 200 <= validated.status_code <= 299 and validated.run_id != command.target_run_id:
            raise ControlStoreError("Successful response must name the cancel target.")
        return validated
    if validated.run_id is not None and validated.run_id != bound_run_id:
        raise ControlStoreError("Idempotent response does not match the command bound run.")
    if (
        bound_run_id is not None
        and 200 <= validated.status_code <= 299
        and validated.run_id != bound_run_id
    ):
        raise ControlStoreError("Successful response must name the command bound run.")
    return validated


def _logical_request_bytes(
    *,
    operation: IdempotencyOperation,
    canonical_request_bytes: bytes,
    run_id: str | None,
    configuration_id: str | None = None,
    configuration_content_sha256: str | None = None,
) -> bytes:
    request = _parse_exact_schema_less_object(
        canonical_request_bytes,
        label="request body",
    )
    logical_command: dict[str, object] = {
        "command": f"backtest.{operation}",
        "request": request,
    }
    if run_id is not None:
        logical_command["run_id"] = run_id
    if configuration_id is not None:
        logical_command["configuration_id"] = configuration_id
        logical_command["configuration_content_sha256"] = configuration_content_sha256
    return canonical_json_bytes(logical_command)


def _require_exact_canonical_object(value: bytes, *, label: str) -> None:
    _parse_exact_schema_less_object(value, label=label)


def _parse_exact_schema_less_object(value: bytes, *, label: str) -> dict[str, object]:
    wrapped_bytes = b'{"value":' + value + b"}"
    try:
        parsed_wrapper = parse_json_object(wrapped_bytes)
        parsed = parsed_wrapper["value"]
        if type(parsed) is not dict:
            raise CanonicalJSONError("value must be a JSON object")
        canonical_wrapper = canonical_json_bytes(parsed_wrapper)
    except (CanonicalJSONError, KeyError) as error:
        raise ValueError(f"{label} must be exact canonical JSON: {error}") from error
    if canonical_wrapper != wrapped_bytes:
        raise ValueError(f"{label} must be exact canonical JSON bytes.")
    return cast(dict[str, object], parsed)


def _validate_catalog_publication_identity(
    *,
    catalog_revision: str,
    fixture_id: str,
    inventory_hash: str,
    publication_bytes: bytes,
    staging_identity: str,
) -> _CatalogManifest:
    _require_digest(catalog_revision, label="catalog revision")
    _require_digest(inventory_hash, label="catalog inventory hash")
    _require_nonempty_string(fixture_id, label="fixture_id")
    _require_nonempty_string(staging_identity, label="staging identity")
    if staging_identity != f"prepared-{catalog_revision}":
        raise ValueError("Catalog staging identity must be derived from the revision.")
    if type(publication_bytes) is not bytes:
        raise ValueError("Catalog publication must be exact canonical bytes.")
    if sha256(publication_bytes).hexdigest() != catalog_revision:
        raise ValueError("Catalog revision does not match publication bytes.")
    try:
        schema = catalog_schema_from_bytes(publication_bytes)
    except HistoricalCatalogInvalid as error:
        raise ValueError("Catalog publication must be exact canonical JSON bytes.") from error
    if schema == "CatalogManifest.v1":
        parsed = _parse_exact_declared_object(
            publication_bytes,
            label="catalog publication",
        )
        try:
            manifest = CatalogManifestV1.model_validate(parsed)
        except ValidationError as error:
            raise ValueError(
                f"Catalog publication must be CatalogManifest.v1: {error}"
            ) from error
        if (
            manifest.fixture_id != fixture_id
            or manifest.inventory_hash != inventory_hash
            or manifest.inventory.fixture_id != fixture_id
            or manifest.inventory.source_checksum != manifest.source_checksum
            or manifest.inventory.catalog_checksum != manifest.catalog_checksum
        ):
            raise CatalogConflict
        inventory_bytes = canonical_json_bytes(
            manifest.inventory.model_dump(mode="json", by_alias=True)
        )
        if sha256(inventory_bytes).hexdigest() != inventory_hash:
            raise CatalogConflict
        return manifest
    if schema != "CatalogManifest.v2":
        raise ValueError("Catalog publication schema is unsupported.")
    try:
        historical = parse_historical_manifest_bytes(publication_bytes)
    except HistoricalCatalogInvalid as error:
        raise ValueError("Catalog publication must be CatalogManifest.v2.") from error
    _validate_historical_catalog_identity(
        historical,
        source_id=fixture_id,
        inventory_hash=inventory_hash,
    )
    return historical


def _validate_historical_catalog_identity(
    manifest: CatalogManifestV2,
    *,
    source_id: str,
    inventory_hash: str,
) -> None:
    try:
        validate_historical_catalog_identity(
            manifest, source_id=source_id, inventory_hash=inventory_hash
        )
    except HistoricalCatalogInvalid as error:
        raise CatalogConflict from error


def _parse_exact_declared_object(value: bytes, *, label: str) -> dict[str, object]:
    if type(value) is not bytes:
        raise ValueError(f"{label} must be exact canonical JSON bytes.")
    try:
        parsed = parse_json_object(value)
        canonical = canonical_json_bytes(parsed)
    except CanonicalJSONError as error:
        raise ValueError(f"{label} must be exact canonical JSON: {error}") from error
    if canonical != value:
        raise ValueError(f"{label} must be exact canonical JSON bytes.")
    return cast(dict[str, object], parsed)


def _parse_exact_catalog_audit(
    value: bytes,
    *,
    manifest: _CatalogManifest,
) -> _CatalogValidatedAudit:
    if type(value) is not bytes:
        raise ValueError("Catalog audit intent must be exact canonical bytes.")
    if isinstance(manifest, CatalogManifestV1):
        parsed = _parse_exact_declared_object(value, label="catalog audit intent")
        try:
            return CatalogValidatedAuditV1.model_validate(parsed)
        except ValidationError as error:
            raise ValueError(
                f"Catalog audit intent must be CatalogValidatedAudit.v1: {error}"
            ) from error
    try:
        audit = parse_historical_model_bytes(value, CatalogValidatedAuditV2)
    except HistoricalCatalogInvalid as error:
        raise ValueError(
            "Catalog audit intent must be CatalogValidatedAudit.v2."
        ) from error
    return audit


def _require_catalog_identity(
    publication: CatalogPublication,
    *,
    fixture_id: str,
    inventory_hash: str,
    publication_bytes: bytes,
    staging_identity: str,
) -> None:
    if (
        publication.fixture_id != fixture_id
        or publication.inventory_hash != inventory_hash
        or publication.publication_bytes != publication_bytes
        or publication.staging_identity != staging_identity
    ):
        raise CatalogConflict


def _read_catalog_publication(
    connection: sqlite3.Connection, catalog_revision: str
) -> CatalogPublication | None:
    row = connection.execute(
        """
        SELECT
            publication.catalog_revision,
            publication.fixture_id,
            publication.status,
            publication.inventory_hash,
            publication.publication_bytes,
            publication.staging_identity,
            publication.prepared_at_ns,
            publication.published_at_ns,
            audit.intent_bytes AS audit_intent_bytes
        FROM catalog_publications AS publication
        LEFT JOIN catalog_audit_intents AS audit
          ON audit.catalog_revision = publication.catalog_revision
        WHERE publication.catalog_revision = ?
        """,
        (catalog_revision,),
    ).fetchone()
    return None if row is None else _catalog_publication_from_row(row)


def _catalog_publication_from_row(row: sqlite3.Row) -> CatalogPublication:
    raw_status = _row_str(row, "status")
    if raw_status not in {"PREPARED", "PUBLISHED", "INTEGRITY_FAILED"}:
        raise ControlStoreError("Catalog publication status is invalid.")
    status = cast(CatalogPublicationStatus, raw_status)
    audit_intent_bytes = _row_optional_bytes(row, "audit_intent_bytes")
    published_at_ns = _row_optional_int(row, "published_at_ns")
    if status == "PREPARED":
        if published_at_ns is not None or audit_intent_bytes is not None:
            raise ControlStoreError("Prepared catalog publication evidence is inconsistent.")
    elif published_at_ns is None or audit_intent_bytes is None:
        raise ControlStoreError("Published catalog publication evidence is incomplete.")
    publication = CatalogPublication(
        catalog_revision=_row_str(row, "catalog_revision"),
        fixture_id=_row_str(row, "fixture_id"),
        status=status,
        inventory_hash=_row_str(row, "inventory_hash"),
        publication_bytes=_row_bytes(row, "publication_bytes"),
        staging_identity=_row_str(row, "staging_identity"),
        prepared_at_ns=_row_int(row, "prepared_at_ns"),
        published_at_ns=published_at_ns,
        audit_intent_bytes=audit_intent_bytes,
    )
    try:
        manifest = _validate_catalog_publication_identity(
            catalog_revision=publication.catalog_revision,
            fixture_id=publication.fixture_id,
            inventory_hash=publication.inventory_hash,
            publication_bytes=publication.publication_bytes,
            staging_identity=publication.staging_identity,
        )
        if publication.status != "PREPARED":
            assert publication.audit_intent_bytes is not None
            audit = _parse_exact_catalog_audit(
                publication.audit_intent_bytes,
                manifest=manifest,
            )
            if isinstance(manifest, CatalogManifestV1):
                if not isinstance(audit, CatalogValidatedAuditV1) or (
                    audit.fixture_id != publication.fixture_id
                    or audit.catalog_revision != publication.catalog_revision
                    or audit.inventory_hash != publication.inventory_hash
                    or audit.source_checksum != manifest.source_checksum
                    or audit.catalog_checksum != manifest.catalog_checksum
                ):
                    raise ValueError(
                        "Catalog audit identity differs from its publication."
                    )
            elif not isinstance(audit, CatalogValidatedAuditV2) or (
                audit.source_id != publication.fixture_id
                or audit.catalog_revision != publication.catalog_revision
                or audit.inventory_hash != publication.inventory_hash
                or audit.raw_sha256 != manifest.raw_sha256
                or audit.metadata_sha256 != manifest.metadata_sha256
                or audit.catalog_checksum != manifest.catalog_checksum
            ):
                raise ValueError(
                        "Catalog audit identity differs from its publication."
                    )
    except (ValueError, CatalogConflict) as error:
        raise ControlStoreError("Persisted catalog publication evidence is invalid.") from error
    return publication


def _require_digest(value: str, *, label: str) -> None:
    if (
        type(value) is not str
        or len(value) != _HEX_DIGEST_LENGTH
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest.")


def _require_configuration_id(value: str) -> None:
    if (
        type(value) is not str
        or len(value) != 36
        or not value.startswith("cfg_")
        or any(character not in "0123456789abcdef" for character in value[4:])
    ):
        raise ValueError("Configuration ID must be a server-generated identifier.")


def _require_nonempty_string(value: str, *, label: str) -> None:
    if type(value) is not str or not value:
        raise ValueError(f"{label} must be a non-empty string.")


def _clock_ns(clock: Clock) -> int:
    value = clock()
    if type(value) is not int or value < 0:
        raise ValueError("Injected clock must return a non-negative integer nanosecond value.")
    return value


def _require_probe_run(connection: sqlite3.Connection, run_id: str) -> None:
    row = connection.execute(
        "SELECT contract_kind FROM runs WHERE run_id = ?", (run_id,)
    ).fetchone()
    if row is not None:
        require_probe_contract(parse_run_contract(_row_str(row, "contract_kind")))


def _snapshot_from_row(row: sqlite3.Row) -> RunSnapshot:
    return RunSnapshot(
        run_id=_row_str(row, "run_id"),
        state=RunState(_row_str(row, "state")),
        state_version=_row_int(row, "state_version"),
        last_event_seq=_row_int(row, "last_event_seq"),
        last_audit_seq=_row_int(row, "last_audit_seq"),
        input_manifest_bytes=_row_optional_bytes(row, "input_manifest_bytes"),
        input_manifest_hash=_row_optional_str(row, "input_manifest_hash"),
        catalog_revision=_row_optional_str(row, "catalog_revision"),
        catalog_inventory_hash=_row_optional_str(row, "catalog_inventory_hash"),
        created_at_ns=_row_int(row, "created_at_ns"),
        evidence_status=_row_str(row, "evidence_status"),
        contract_kind=parse_run_contract(_row_str(row, "contract_kind")),
    )


def _preflight_from_row(row: sqlite3.Row) -> PreflightSnapshot:
    raw_status = _row_str(row, "status")
    if raw_status not in {"PREFLIGHT_BLOCKED", "PREFLIGHT_READY"}:
        raise ControlStoreError("Persisted preflight status is invalid.")
    snapshot = PreflightSnapshot(
        preflight_id=_row_str(row, "preflight_id"),
        run_id=_row_str(row, "run_id"),
        status=cast(PreflightStatus, raw_status),
        request_bytes=_row_bytes(row, "request_bytes"),
        request_hash=_row_str(row, "request_hash"),
        result_bytes=_row_bytes(row, "result_bytes"),
        input_manifest_bytes=_row_optional_bytes(row, "input_manifest_bytes"),
        input_manifest_hash=_row_optional_str(row, "input_manifest_hash"),
        catalog_revision=_row_optional_str(row, "catalog_revision"),
        catalog_inventory_hash=_row_optional_str(row, "catalog_inventory_hash"),
        engine_package_version=_row_optional_str(row, "engine_package_version"),
        engine_tag_commit=_row_optional_str(row, "engine_tag_commit"),
        risk_policy_hash=_row_optional_str(row, "risk_policy_hash"),
        expires_at_ns=_row_int(row, "expires_at_ns"),
        consumed_at_ns=_row_optional_int(row, "consumed_at_ns"),
    )
    try:
        _require_exact_canonical_object(snapshot.request_bytes, label="preflight request")
        _require_exact_canonical_object(snapshot.result_bytes, label="preflight result")
        _require_digest(snapshot.request_hash, label="preflight request hash")
        if sha256(snapshot.request_bytes).hexdigest() != snapshot.request_hash:
            raise ValueError("Persisted preflight request hash is inconsistent.")
        if snapshot.expires_at_ns < 0 or (
            snapshot.consumed_at_ns is not None
            and (snapshot.consumed_at_ns < 0 or snapshot.consumed_at_ns >= snapshot.expires_at_ns)
        ):
            raise ValueError("Persisted preflight timestamps are inconsistent.")
        identity = (
            snapshot.input_manifest_bytes,
            snapshot.input_manifest_hash,
            snapshot.catalog_revision,
            snapshot.catalog_inventory_hash,
            snapshot.engine_package_version,
            snapshot.engine_tag_commit,
            snapshot.risk_policy_hash,
        )
        ready = snapshot.status == "PREFLIGHT_READY"
        if ready != all(value is not None for value in identity):
            raise ValueError("Persisted preflight identity is incomplete.")
        if not ready and any(value is not None for value in identity):
            raise ValueError("Persisted blocked preflight carries runnable identity.")
        if ready:
            assert snapshot.input_manifest_bytes is not None
            assert snapshot.input_manifest_hash is not None
            assert snapshot.catalog_revision is not None
            assert snapshot.catalog_inventory_hash is not None
            assert snapshot.engine_package_version is not None
            assert snapshot.engine_tag_commit is not None
            assert snapshot.risk_policy_hash is not None
            _require_digest(snapshot.input_manifest_hash, label="input manifest hash")
            _require_digest(snapshot.catalog_revision, label="catalog revision")
            _require_digest(
                snapshot.catalog_inventory_hash,
                label="catalog inventory hash",
            )
            _require_digest(snapshot.risk_policy_hash, label="risk policy hash")
            if sha256(snapshot.input_manifest_bytes).hexdigest() != snapshot.input_manifest_hash:
                raise ValueError("Persisted input manifest hash is inconsistent.")
            manifest = InputManifestV1.model_validate(
                _parse_exact_declared_object(
                    snapshot.input_manifest_bytes,
                    label="input manifest",
                )
            )
            if (
                manifest.catalog_revision != snapshot.catalog_revision
                or manifest.engine_package_version != snapshot.engine_package_version
                or manifest.engine_tag_commit != snapshot.engine_tag_commit
                or manifest.risk_policy_hash != snapshot.risk_policy_hash
            ):
                raise ValueError("Persisted preflight outer and manifest identity differ.")
    except (ValidationError, ValueError) as error:
        raise ControlStoreError("Persisted preflight row is invalid.") from error
    return snapshot


def _validate_preflight_linkage(
    connection: sqlite3.Connection,
    snapshot: PreflightSnapshot,
    *,
    require_idempotency: bool = True,
    allow_pending_queue: bool = False,
) -> None:
    try:
        run = read_run(connection, snapshot.run_id)
        require_probe_contract(run.contract_kind)
        result = _parse_exact_schema_less_object(
            snapshot.result_bytes,
            label="preflight result",
        )
        validated_result = _validate_preflight_result_identity(
            connection=connection,
            snapshot=snapshot,
            result=result,
        )
        binding = validate_preflight_configuration_binding(
            connection,
            preflight_id=snapshot.preflight_id,
            run_id=snapshot.run_id,
            request_bytes=snapshot.request_bytes,
            input_manifest_bytes=snapshot.input_manifest_bytes,
        )
        if require_idempotency:
            _validate_preflight_idempotency_linkage(
                connection,
                snapshot=snapshot,
                binding=binding,
            )
        pending_draft = (
            not require_idempotency
            and connection.in_transaction
            and run.state is RunState.DRAFT
            and run.state_version == 0
            and run.last_event_seq == 0
            and run.last_audit_seq == 0
        )
        if snapshot.status == "PREFLIGHT_BLOCKED":
            if any(
                value is not None
                for value in (
                    run.input_manifest_bytes,
                    run.input_manifest_hash,
                    run.catalog_revision,
                    run.catalog_inventory_hash,
                )
            ):
                raise ValueError("Blocked preflight run carries manifest identity.")
            if pending_draft:
                return
            _validate_preflight_lifecycle_history(
                connection,
                snapshot=snapshot,
                run=run,
                allow_pending_queue=allow_pending_queue,
                checked_at_ns=validated_result.checks[0].checked_at_ns,
            )
            return
        assert snapshot.input_manifest_bytes is not None
        assert snapshot.input_manifest_hash is not None
        assert snapshot.catalog_revision is not None
        assert snapshot.catalog_inventory_hash is not None
        assert snapshot.engine_package_version is not None
        assert snapshot.engine_tag_commit is not None
        assert snapshot.risk_policy_hash is not None
        if (
            run.input_manifest_bytes != snapshot.input_manifest_bytes
            or run.input_manifest_hash != snapshot.input_manifest_hash
            or run.catalog_revision != snapshot.catalog_revision
            or run.catalog_inventory_hash != snapshot.catalog_inventory_hash
        ):
            raise ValueError("Preflight and run manifest identity differ.")
        publication = _read_catalog_publication(connection, snapshot.catalog_revision)
        if (
            publication is None
            or publication.status not in {"PUBLISHED", "INTEGRITY_FAILED"}
            or publication.inventory_hash != snapshot.catalog_inventory_hash
        ):
            raise ValueError("Preflight catalog linkage is missing.")
        manifest = InputManifestV1.model_validate(
            _parse_exact_declared_object(
                snapshot.input_manifest_bytes,
                label="input manifest",
            )
        )
        _validated_historical_manifest_evidence(
            manifest_bytes=snapshot.input_manifest_bytes,
            publication=publication,
            publication_bytes=publication.publication_bytes,
            engine_package_version=snapshot.engine_package_version,
            engine_tag_commit=snapshot.engine_tag_commit,
            python_version=manifest.python_version,
            precision_mode=manifest.precision_mode,
            risk_policy_hash=snapshot.risk_policy_hash,
            require_published=False,
        )
        draft = BacktestDraftRequest.model_validate(
            _parse_exact_schema_less_object(
                snapshot.request_bytes,
                label="preflight request",
            )
        )
        manifest_object = manifest.model_dump(mode="json", by_alias=True)
        if (
            draft.catalog_revision != snapshot.catalog_revision
            or draft.window != manifest.window
            or draft.information_set_policy != manifest.information_set_policy
            or draft.evaluation_protocol != manifest.evaluation_protocol
            or draft.venue_account_model is None
            or draft.venue_account_model.model_dump(mode="json", by_alias=True)
            != manifest.venue_account_model.model_dump(mode="json", by_alias=True)
            or draft.replay_seed != manifest.replay_seed
            or draft.strategy_ref != f"{manifest.strategy_id}@{manifest.strategy_version}"
            or draft.risk_policy_ref != f"{manifest.risk_policy_id}@{manifest.risk_policy_version}"
            or manifest.config_hash
            != sha256(canonical_json_bytes(manifest_object["canonical_config"])).hexdigest()
            or manifest.risk_policy_hash
            != sha256(canonical_json_bytes(manifest_object["canonical_risk_policy"])).hexdigest()
        ):
            raise ValueError("Preflight request and manifest linkage differ.")
        if pending_draft:
            return
        _validate_preflight_lifecycle_history(
            connection,
            snapshot=snapshot,
            run=run,
            allow_pending_queue=allow_pending_queue,
            checked_at_ns=validated_result.checks[0].checked_at_ns,
        )
    except (
        ControlStoreError,
        StrategyConfigurationIntegrityError,
        ValidationError,
        ValueError,
        CatalogConflict,
    ) as error:
        if isinstance(error, ControlStoreError) and not isinstance(error, CatalogConflict):
            raise
        raise ControlStoreError("Persisted preflight linkage is invalid.") from error


def _validate_preflight_lifecycle_history(
    connection: sqlite3.Connection,
    *,
    snapshot: PreflightSnapshot,
    run: RunSnapshot,
    allow_pending_queue: bool,
    checked_at_ns: int,
) -> None:
    if snapshot.status == "PREFLIGHT_BLOCKED":
        exact_v1 = run.state is RunState.PREFLIGHT_BLOCKED
    elif snapshot.consumed_at_ns is None:
        exact_v1 = run.state is RunState.PREFLIGHT_READY
    elif allow_pending_queue:
        if not connection.in_transaction or run.state is not RunState.PREFLIGHT_READY:
            raise ValueError("Pending queue preflight run lifecycle is inconsistent.")
        exact_v1 = True
    else:
        exact_v1 = False
        if (
            run.state not in _POST_QUEUE_STATES
            or run.state_version < 2
            or run.last_event_seq < 2
            or run.last_audit_seq < 2
        ):
            raise ValueError("Consumed preflight run lifecycle is inconsistent.")
    if exact_v1 and (run.state_version != 1 or run.last_event_seq != 1 or run.last_audit_seq != 1):
        raise ValueError("Preflight run v1 cursors are inconsistent.")
    if not exact_v1 and snapshot.consumed_at_ns is None:
        raise ValueError("Unconsumed preflight run lifecycle is inconsistent.")

    event_row = connection.execute(
        """
        SELECT event_id, source_seq, source, type, writer, schema_version,
               ts_event_ns, ts_ingest_ns, visible, envelope_bytes
        FROM events
        WHERE run_id = ? AND seq = 1
        """,
        (snapshot.run_id,),
    ).fetchone()
    audit_row = connection.execute(
        """
        SELECT audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        FROM audit_intents
        WHERE run_id = ? AND audit_seq = 1
        """,
        (snapshot.run_id,),
    ).fetchone()
    outbox_row = connection.execute(
        """
        SELECT seq, audit_seq, materialized, materialized_at_ns
        FROM outbox
        WHERE run_id = ? AND seq = 1
        """,
        (snapshot.run_id,),
    ).fetchone()
    if event_row is None or audit_row is None or outbox_row is None:
        raise ValueError("Preflight seq1 history is incomplete.")
    envelope_bytes = _row_bytes(event_row, "envelope_bytes")
    envelope = EventEnvelopeV1.model_validate(
        _parse_exact_schema_less_object(
            envelope_bytes,
            label="preflight seq1 event envelope",
        )
    )
    expected_type = (
        "preflight.blocked" if snapshot.status == "PREFLIGHT_BLOCKED" else "preflight.passed"
    )
    payload = envelope.model_dump(mode="json")["payload"]
    expected_payload = {
        "canonical_request_hash": snapshot.request_hash,
        "preflight_id": snapshot.preflight_id,
    }
    event_digest = sha256(envelope_bytes).hexdigest()
    expected_intent = canonical_json_bytes(
        {
            "event_digest": event_digest,
            "event_seq": 1,
            "run_id": snapshot.run_id,
            "seq": 1,
        }
    )
    materialized = _row_int(outbox_row, "materialized")
    materialized_at_ns = _row_optional_int(outbox_row, "materialized_at_ns")
    if (
        _row_str(event_row, "event_id") != envelope.event_id
        or _row_int(event_row, "source_seq") != 1
        or _row_str(event_row, "source") != "control-api"
        or _row_str(event_row, "type") != expected_type
        or _row_str(event_row, "writer") != "control-api"
        or _row_int(event_row, "schema_version") != 1
        or _row_str(event_row, "ts_event_ns") != envelope.ts_event_ns
        or _row_str(event_row, "ts_ingest_ns") != envelope.ts_ingest_ns
        or _row_int(event_row, "visible") != 1
        or envelope.run_id != snapshot.run_id
        or envelope.seq != 1
        or envelope.source_seq != 1
        or envelope.source != "control-api"
        or envelope.type != expected_type
        or envelope.writer != "control-api"
        or envelope.schema_version != 1
        or envelope.ts_event_ns != str(checked_at_ns)
        or payload != expected_payload
        or _row_int(audit_row, "audit_seq") != 1
        or _row_int(audit_row, "event_seq") != 1
        or _row_str(audit_row, "event_digest") != event_digest
        or _row_bytes(audit_row, "intent_bytes") != expected_intent
        or str(_row_int(audit_row, "created_at_ns")) != envelope.ts_ingest_ns
        or _row_int(outbox_row, "seq") != 1
        or _row_int(outbox_row, "audit_seq") != 1
        or materialized not in {0, 1}
        or (materialized == 0) != (materialized_at_ns is None)
    ):
        raise ValueError("Preflight seq1 history is invalid.")


def _validate_preflight_idempotency_linkage(
    connection: sqlite3.Connection,
    *,
    snapshot: PreflightSnapshot,
    binding: StrategyConfigurationBinding | None,
) -> None:
    rows = connection.execute(
        """
        SELECT request_hash, request_body, response_status, response_body,
               target_run_id, run_id
        FROM idempotency_records
        WHERE idempotency_scope = 'backtest.preflight' AND run_id = ?
        """,
        (snapshot.run_id,),
    ).fetchall()
    logical_request_bytes = _logical_request_bytes(
        operation="preflight",
        canonical_request_bytes=snapshot.request_bytes,
        run_id=None,
        configuration_id=(binding.configuration_id if binding is not None else None),
        configuration_content_sha256=(binding.content_sha256 if binding is not None else None),
    )
    if len(rows) != 1:
        raise ControlStoreError("Persisted preflight idempotency linkage is missing or ambiguous.")
    row = rows[0]
    response_status = _row_int(row, "response_status")
    if (
        _row_str(row, "request_hash") != sha256(logical_request_bytes).hexdigest()
        or _row_bytes(row, "request_body") != logical_request_bytes
        or response_status != 200
        or _row_bytes(row, "response_body") != snapshot.result_bytes
        or _row_optional_str(row, "target_run_id") is not None
        or _row_optional_str(row, "run_id") != snapshot.run_id
    ):
        raise ControlStoreError("Persisted preflight idempotency linkage is invalid.")


def _validate_preflight_result_identity(
    *,
    connection: sqlite3.Connection,
    snapshot: PreflightSnapshot,
    result: dict[str, object],
) -> _ValidatedPreflightResult:
    validated = _validated_preflight_result_object(result)
    try:
        draft = BacktestDraftRequest.model_validate(
            _parse_exact_schema_less_object(
                snapshot.request_bytes,
                label="preflight request",
            )
        )
    except ValidationError as error:
        raise ValueError("Persisted preflight request is invalid.") from error
    catalog: CatalogManifestV1 | None = None
    if any(check.code == "CATALOG_PUBLISHED" for check in validated.checks):
        publication = _read_catalog_publication(connection, draft.catalog_revision)
        if publication is None or publication.status not in {
            "PUBLISHED",
            "INTEGRITY_FAILED",
        }:
            raise ValueError("Published preflight check has no historical catalog evidence.")
        catalog = CatalogManifestV1.model_validate(
            _parse_exact_declared_object(
                publication.publication_bytes,
                label="catalog publication",
            )
        )
    evidence_context = _preflight_evidence_context(draft=draft, catalog=catalog)
    for check in validated.checks:
        _validate_preflight_check_evidence_authority(
            check,
            context=evidence_context,
        )
    if (
        validated.preflight_id != snapshot.preflight_id
        or validated.run_id != snapshot.run_id
        or validated.state != snapshot.status
        or validated.canonical_request_hash != snapshot.request_hash
        or validated.input_manifest_hash != snapshot.input_manifest_hash
        or validated.catalog_revision != snapshot.catalog_revision
        or validated.expires_at_ns != snapshot.expires_at_ns
    ):
        raise ValueError("Preflight result identity differs from its row.")
    return validated


def _schema_less_object_sha256(value: dict[str, object]) -> str:
    wrapped = canonical_json_bytes({"value": value})
    prefix = b'{"value":'
    if not wrapped.startswith(prefix) or not wrapped.endswith(b"}"):
        raise ValueError("Canonical evidence wrapper is invalid.")
    return sha256(wrapped[len(prefix) : -1]).hexdigest()


def _preflight_evidence_context(
    *,
    draft: BacktestDraftRequest,
    catalog: CatalogManifestV1 | None,
) -> Mapping[str, str]:
    account = draft.venue_account_model
    costs = draft.cost_fill_model
    values = {
        "account_model_sha256": (
            "NONE"
            if account is None
            else _schema_less_object_sha256(account.model_dump(mode="json", by_alias=True))
        ),
        "catalog_revision": draft.catalog_revision,
        "requested_revision": draft.catalog_revision,
        "cost_fill_sha256": _schema_less_object_sha256(
            draft.cost_fill_model.model_dump(mode="json", by_alias=True)
        ),
        "requested_policy_sha256": sha256(
            canonical_json_bytes(
                draft.information_set_policy.model_dump(mode="json", by_alias=True)
            )
        ).hexdigest(),
        "requested_protocol_sha256": sha256(
            canonical_json_bytes(draft.evaluation_protocol.model_dump(mode="json", by_alias=True))
        ).hexdigest(),
        "requested_start_ns": draft.window.start_ns,
        "requested_end_ns": draft.window.end_ns,
        "replay_seed": str(draft.replay_seed),
        "risk_policy_ref": draft.risk_policy_ref or "NONE",
        "strategy_ref": draft.strategy_ref,
        "account_present": "TRUE" if account is not None else "FALSE",
    }
    if account is not None:
        values["starting_balance"] = account.starting_balance
        values["starting_balance_non_positive"] = (
            "TRUE" if Decimal(account.starting_balance) <= 0 else "FALSE"
        )
    for section in ("fee", "spread", "slippage", "latency", "liquidity", "cancel"):
        values[f"{section}_present"] = "TRUE" if getattr(costs, section) is not None else "FALSE"
    if costs.fee is not None:
        values["fee_model"] = costs.fee.model
    if costs.slippage is not None:
        values["slippage_model"] = costs.slippage.model
    if costs.latency is not None:
        values["latency_model"] = costs.latency.model
    if costs.liquidity is not None:
        values["liquidity_source"] = costs.liquidity.available_size_source
    if costs.cancel is not None:
        values["cancel_rule"] = costs.cancel.acknowledgment_rule
    if catalog is not None:
        inventory = catalog.inventory
        expected_venue = inventory.instrument.venue
        expected_currency = inventory.instrument.quote_currency
        values.update(
            inventory_hash=catalog.inventory_hash,
            currency_authority_sha256=sha256(
                canonical_json_bytes({"currency": expected_currency, "venue": expected_venue})
            ).hexdigest(),
            venue_match=(
                "TRUE" if account is not None and account.venue_id == expected_venue else "FALSE"
            ),
            currency_match=(
                "TRUE" if account is not None and account.currency == expected_currency else "FALSE"
            ),
            catalog_policy_sha256=sha256(
                canonical_json_bytes(
                    inventory.information_set_policy.model_dump(mode="json", by_alias=True)
                )
            ).hexdigest(),
            catalog_protocol_sha256=sha256(
                canonical_json_bytes(
                    inventory.evaluation_protocol.model_dump(mode="json", by_alias=True)
                )
            ).hexdigest(),
            catalog_start_ns=inventory.readback.first_ts_init,
            catalog_end_ns=_increment_numeric_string(inventory.readback.last_ts_init),
            price_precision=str(inventory.instrument.price_precision),
            size_precision=str(inventory.instrument.size_precision),
            catalog_engine_version=sanitize_preflight_evidence_value(
                inventory.native_fingerprint.installed_nautilus_version
            ),
            catalog_python_version=sanitize_preflight_evidence_value(
                inventory.native_fingerprint.python_version
            ),
        )
    return MappingProxyType(values)


def _validate_preflight_check_evidence_authority(
    check: _ValidatedPreflightCheck,
    *,
    context: Mapping[str, str],
) -> None:
    facts = dict(check.evidence)
    for name, expected in context.items():
        if name in facts and facts[name] != expected:
            raise ValueError("Preflight check evidence differs from persisted authority.")
    required_section = facts.get("required_section")
    if required_section is not None and context[f"{required_section}_present"] != "FALSE":
        raise ValueError("Preflight missing-section evidence differs from persisted request.")
    if facts.get("account_model_status") == "MISSING" and context["account_present"] != "FALSE":
        raise ValueError("Preflight missing-account evidence differs from persisted request.")
    if (
        facts.get("starting_balance_status") == "NON_POSITIVE"
        and context.get("starting_balance_non_positive") != "TRUE"
    ):
        raise ValueError("Preflight balance evidence differs from persisted request.")


def _validated_preflight_checks(value: object) -> tuple[_ValidatedPreflightCheck, ...]:
    if type(value) is not list or not value:
        raise ValueError("Preflight result checks are invalid.")
    validated: list[_ValidatedPreflightCheck] = []
    seen: set[str] = set()
    for item in value:
        if (
            type(item) is not dict
            or set(item) != {"checked_at_ns", "code", "evidence", "explanation", "passed"}
            or type(item["code"]) is not str
            or item["code"] not in PREFLIGHT_CHECK_CODES
            or item["code"] in seen
            or type(item["passed"]) is not bool
            or type(item["explanation"]) is not str
            or not item["explanation"]
            or item["explanation"] != PREFLIGHT_CHECK_EXPLANATIONS[item["code"]]
        ):
            raise ValueError("Preflight result checks are invalid.")
        code = item["code"]
        passed = item["passed"]
        if passed != (code in PREFLIGHT_PASSING_CHECK_CODES):
            raise ValueError("Preflight result check outcome is invalid.")
        checked_at_ns = validate_unix_epoch_ns(
            item["checked_at_ns"],
            label="Preflight result checked_at_ns",
        )
        raw_evidence = item["evidence"]
        if type(raw_evidence) is not list or not raw_evidence:
            raise ValueError("Preflight result check evidence is invalid.")
        evidence: list[tuple[str, str]] = []
        for fact in raw_evidence:
            if (
                type(fact) is not dict
                or set(fact) != {"name", "value"}
                or type(fact["name"]) is not str
                or type(fact["value"]) is not str
            ):
                raise ValueError("Preflight result check evidence is invalid.")
            evidence.append((fact["name"], fact["value"]))
        try:
            validated_evidence = validate_preflight_evidence(code, evidence)
        except ValueError as error:
            raise ValueError("Preflight result check evidence is invalid.") from error
        seen.add(code)
        validated.append(
            _ValidatedPreflightCheck(
                code=code,
                passed=passed,
                checked_at_ns=checked_at_ns,
                explanation=item["explanation"],
                evidence=validated_evidence,
            )
        )
    if len({check.checked_at_ns for check in validated}) != 1:
        raise ValueError("Preflight result checks must share one checked_at_ns.")
    return tuple(validated)


def _validated_preflight_result_object(value: object) -> _ValidatedPreflightResult:
    expected_fields = {
        "canonical_request_hash",
        "catalog_revision",
        "checks",
        "expires_at_ns",
        "input_manifest_hash",
        "preflight_id",
        "run_id",
        "state",
        "state_version",
    }
    if type(value) is not dict or set(value) != expected_fields:
        raise ValueError("Preflight result fields are invalid.")
    preflight_id = value["preflight_id"]
    run_id = value["run_id"]
    raw_state = value["state"]
    canonical_request_hash = value["canonical_request_hash"]
    state_version = value["state_version"]
    expires_at_ns = value["expires_at_ns"]
    if type(preflight_id) is not str or not preflight_id:
        raise ValueError("Preflight result preflight_id is invalid.")
    if type(run_id) is not str or not run_id:
        raise ValueError("Preflight result run_id is invalid.")
    if type(raw_state) is not str or raw_state not in {
        "PREFLIGHT_BLOCKED",
        "PREFLIGHT_READY",
    }:
        raise ValueError("Preflight result state is invalid.")
    if type(state_version) is not int or state_version != 1:
        raise ValueError("Preflight result state_version is invalid.")
    if type(expires_at_ns) is not int or expires_at_ns < 0:
        raise ValueError("Preflight result expires_at_ns is invalid.")
    if type(canonical_request_hash) is not str:
        raise ValueError("Preflight result canonical_request_hash is invalid.")
    _require_digest(canonical_request_hash, label="preflight result canonical request hash")
    state = cast(PreflightStatus, raw_state)
    input_manifest_hash = value["input_manifest_hash"]
    catalog_revision = value["catalog_revision"]
    if state == "PREFLIGHT_READY":
        if type(input_manifest_hash) is not str or type(catalog_revision) is not str:
            raise ValueError("READY preflight result identity is invalid.")
        _require_digest(input_manifest_hash, label="preflight result input manifest hash")
        _require_digest(catalog_revision, label="preflight result catalog revision")
    elif input_manifest_hash is not None or catalog_revision is not None:
        raise ValueError("BLOCKED preflight result identity must be null.")
    checks = _validated_preflight_checks(value["checks"])
    codes = tuple(check.code for check in checks)
    if state == "PREFLIGHT_READY":
        if codes != PREFLIGHT_READY_CHECKLIST:
            raise ValueError("READY preflight checklist is invalid.")
    else:
        _validate_blocked_preflight_checklist(checks)
    return _ValidatedPreflightResult(
        preflight_id=preflight_id,
        run_id=run_id,
        state=state,
        canonical_request_hash=canonical_request_hash,
        input_manifest_hash=cast(str | None, input_manifest_hash),
        catalog_revision=cast(str | None, catalog_revision),
        expires_at_ns=expires_at_ns,
        checks=checks,
    )


def _validate_blocked_preflight_checklist(
    checks: tuple[_ValidatedPreflightCheck, ...],
) -> None:
    codes = tuple(check.code for check in checks)
    index = 0
    categories = (
        {"ENGINE_VERSION_VALID", "ENGINE_VERSION_MISMATCH"},
        {"ENGINE_TAG_VALID", "ENGINE_TAG_MISMATCH"},
        {"PYTHON_VERSION_VALID", "PYTHON_VERSION_MISMATCH"},
        {"PRECISION_MODE_VALID", "PRECISION_MODE_MISMATCH"},
        {
            "STRATEGY_VALID",
            "STRATEGY_UNKNOWN",
            "STRATEGY_HASH_MISMATCH",
            "STRATEGY_UNSUPPORTED",
        },
        {
            "CATALOG_PUBLISHED",
            "CATALOG_UNKNOWN",
            "CATALOG_NOT_PUBLISHED",
            "CATALOG_INTEGRITY_FAILED",
            "CATALOG_UNREADABLE",
        },
    )
    for category in categories:
        if index >= len(codes) or codes[index] not in category:
            raise ValueError("BLOCKED preflight checklist category is invalid.")
        index += 1
    catalog_code = codes[5]
    if index >= len(codes):
        raise ValueError("BLOCKED preflight cost checklist is missing.")
    if codes[index] in _PREFLIGHT_MISSING_COST_CODES:
        missing: list[str] = []
        while index < len(codes) and codes[index] in _PREFLIGHT_MISSING_COST_CODES:
            missing.append(codes[index])
            index += 1
        if tuple(missing) != tuple(
            code for code in _PREFLIGHT_MISSING_COST_CODES if code in missing
        ):
            raise ValueError("BLOCKED preflight missing-cost order is invalid.")
    elif codes[index] in {"COST_FILL_SUPPORTED", "UNSUPPORTED_COST_FILL_MODEL"}:
        index += 1
    else:
        raise ValueError("BLOCKED preflight cost checklist is invalid.")
    trailing_categories: tuple[set[str], ...] = (
        {
            "RISK_POLICY_VALID",
            "RISK_POLICY_MISSING",
            "RISK_POLICY_UNKNOWN",
            "RISK_POLICY_HASH_MISMATCH",
            "RISK_POLICY_UNSUPPORTED",
        },
        {
            "BALANCE_VALID",
            "BALANCE_MODEL_MISSING",
            "BALANCE_INVALID",
            "VENUE_ACCOUNT_UNSUPPORTED",
        },
        {"CURRENCY_MATCH", "CURRENCY_MISMATCH"},
        {"RUN_ROOT_VALID", "RUN_ROOT_INVALID"},
    )
    if catalog_code == "CATALOG_PUBLISHED":
        trailing_categories += (
            {"INFORMATION_SET_MATCH", "INFORMATION_SET_MISMATCH"},
            {"EVALUATION_PROTOCOL_MATCH", "EVALUATION_PROTOCOL_MISMATCH"},
            {"WINDOW_VALID", "WINDOW_OUT_OF_RANGE"},
            {"PRECISION_VALID", "PRECISION_MISMATCH"},
        )
    for category in trailing_categories:
        if index >= len(codes) or codes[index] not in category:
            raise ValueError("BLOCKED preflight checklist category is invalid.")
        index += 1
    if index != len(codes) or all(check.passed for check in checks):
        raise ValueError("BLOCKED preflight checklist is invalid.")


def _validated_create_response_object(value: object) -> tuple[str, str]:
    expected_fields = {
        "input_manifest_hash",
        "last_visible_seq",
        "run_id",
        "state",
        "state_version",
    }
    if type(value) is not dict or set(value) != expected_fields:
        raise ControlStoreError("Create response fields are invalid.")
    run_id = value["run_id"]
    input_manifest_hash = value["input_manifest_hash"]
    if type(run_id) is not str or not run_id:
        raise ControlStoreError("Create response run_id is invalid.")
    if type(input_manifest_hash) is not str:
        raise ControlStoreError("Create response input_manifest_hash is invalid.")
    try:
        _require_digest(input_manifest_hash, label="create response input_manifest_hash")
    except ValueError as error:
        raise ControlStoreError("Create response input_manifest_hash is invalid.") from error
    if (
        value["state"] != RunState.QUEUED.value
        or type(value["state"]) is not str
        or type(value["state_version"]) is not int
        or value["state_version"] != 2
        or type(value["last_visible_seq"]) is not int
        or value["last_visible_seq"] != 2
    ):
        raise ControlStoreError("Create response state is invalid.")
    return run_id, input_manifest_hash


def _validate_idempotent_linkage(
    connection: sqlite3.Connection,
    *,
    command: _ValidatedCommand,
    response: IdempotentResponse,
) -> None:
    if command.operation == "cancel":
        return
    if response.run_id is None:
        raise ControlStoreError("Persisted command response is missing its bound run.")
    if command.operation == "preflight":
        row = connection.execute(
            "SELECT preflight_id FROM preflights WHERE run_id = ?",
            (response.run_id,),
        ).fetchone()
        if row is None:
            raise ControlStoreError("Persisted preflight command has no preflight row.")
        preflight = read_preflight(connection, _row_str(row, "preflight_id"))
        if (
            preflight is None
            or preflight.request_bytes != command.bare_request_bytes
            or preflight.request_hash != command.bare_request_hash
            or preflight.result_bytes != response.body
        ):
            raise ControlStoreError("Persisted preflight command linkage is invalid.")
        return
    request = _parse_exact_schema_less_object(
        command.bare_request_bytes,
        label="create command request",
    )
    if set(request) != {"canonical_request_hash", "preflight_id"}:
        raise ControlStoreError("Persisted create command request is invalid.")
    preflight_id = request["preflight_id"]
    request_hash = request["canonical_request_hash"]
    if type(preflight_id) is not str or type(request_hash) is not str:
        raise ControlStoreError("Persisted create command request is invalid.")
    preflight = read_preflight(connection, preflight_id)
    response_value = _parse_exact_schema_less_object(
        response.body,
        label="create response body",
    )
    response_run_id, response_manifest_hash = _validated_create_response_object(response_value)
    run = read_run(connection, response_run_id)
    queued_row = connection.execute(
        """
        SELECT event_id, source_seq, source, type, writer, schema_version,
               visible, envelope_bytes
        FROM events
        WHERE run_id = ? AND seq = 2
        """,
        (response_run_id,),
    ).fetchone()
    try:
        if queued_row is None:
            raise ValueError("Queued event is missing.")
        queued_envelope = EventEnvelopeV1.model_validate(
            _parse_exact_schema_less_object(
                _row_bytes(queued_row, "envelope_bytes"),
                label="queued event envelope",
            )
        )
    except (ValidationError, ValueError) as error:
        raise ControlStoreError("Persisted create queued event is invalid.") from error
    queued_payload = queued_envelope.model_dump(mode="json")["payload"]
    post_queue_states = {
        RunState.QUEUED,
        RunState.RUNNING,
        RunState.CANCEL_REQUESTED,
        RunState.CANCEL_PENDING,
        RunState.FINALIZING,
        RunState.COMPLETED,
        RunState.FAILED,
        RunState.CANCELLED,
    }
    if (
        preflight is None
        or preflight.run_id != response.run_id
        or preflight.status != "PREFLIGHT_READY"
        or preflight.request_hash != request_hash
        or preflight.consumed_at_ns is None
        or preflight.input_manifest_hash != response_manifest_hash
        or run.run_id != response.run_id
        or run.state not in post_queue_states
        or run.state_version < 2
        or run.last_event_seq < 2
        or run.input_manifest_hash != response_manifest_hash
        or _row_str(queued_row, "event_id") != queued_envelope.event_id
        or _row_int(queued_row, "source_seq") != 2
        or _row_str(queued_row, "source") != "control-api"
        or _row_str(queued_row, "type") != "run.queued"
        or _row_str(queued_row, "writer") != "control-api"
        or _row_int(queued_row, "schema_version") != 1
        or _row_int(queued_row, "visible") != 1
        or queued_envelope.run_id != response.run_id
        or queued_envelope.seq != 2
        or queued_envelope.source_seq != 2
        or queued_envelope.source != "control-api"
        or queued_envelope.writer != "control-api"
        or queued_envelope.type != "run.queued"
        or queued_envelope.schema_version != 1
        or queued_payload != {"preflight_id": preflight_id}
    ):
        raise ControlStoreError("Persisted create command response linkage is invalid.")


def _event_from_row(row: sqlite3.Row) -> PersistedEvent:
    source = _row_str(row, "source")
    if source not in {"control-api", "runner"}:
        raise RuntimeError(f"Persisted event has unknown source: {source!r}.")
    return PersistedEvent(
        event_id=_row_str(row, "event_id"),
        run_id=_row_str(row, "run_id"),
        seq=_row_int(row, "seq"),
        source_seq=_row_int(row, "source_seq"),
        source=cast(EventSource, source),
        type=_row_str(row, "type"),
        ts_event_ns=_row_str(row, "ts_event_ns"),
        ts_ingest_ns=_row_str(row, "ts_ingest_ns"),
        visible=bool(_row_int(row, "visible")),
        envelope_bytes=_row_bytes(row, "envelope_bytes"),
    )


def _audit_from_row(row: sqlite3.Row) -> AuditIntent:
    return AuditIntent(
        run_id=_row_str(row, "run_id"),
        audit_seq=_row_int(row, "audit_seq"),
        event_seq=_row_int(row, "event_seq"),
        event_digest=_row_str(row, "event_digest"),
        intent_bytes=_row_bytes(row, "intent_bytes"),
        created_at_ns=_row_int(row, "created_at_ns"),
    )


def _outbox_from_row(row: sqlite3.Row) -> OutboxRecord:
    return OutboxRecord(
        run_id=_row_str(row, "run_id"),
        seq=_row_int(row, "seq"),
        audit_seq=_row_int(row, "audit_seq"),
        materialized=bool(_row_int(row, "materialized")),
        materialized_at_ns=_row_optional_int(row, "materialized_at_ns"),
    )


def _claim_runner_process_transaction(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    spawn_nonce: str,
) -> RunnerProcessRecord:
    _require_nonempty_string(run_id, label="runner claim run_id")
    _require_nonempty_string(spawn_nonce, label="runner claim spawn_nonce")
    with _immediate_transaction(connection):
        existing = _read_runner_process_row(connection, run_id)
        if existing is not None:
            return _runner_process_from_row(existing, created_by_caller=False)
        run = read_run(connection, run_id)
        if run.state is not RunState.QUEUED:
            raise EventRejected("Runner claim requires a QUEUED run.")
        connection.execute(
            "INSERT INTO runner_processes (run_id, spawn_nonce) VALUES (?, ?)",
            (run_id, spawn_nonce),
        )
        created = _read_runner_process_row(connection, run_id)
        assert created is not None
        return _runner_process_from_row(created, created_by_caller=True)


def _attach_runner_process_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    identity: ProcessIdentityV1,
) -> RunnerProcessRecord:
    if type(identity) is not ProcessIdentityV1:
        raise TypeError("Runner attachment requires an exact ProcessIdentityV1.")
    identity_bytes = process_identity_bytes(identity)
    with _immediate_transaction(connection):
        row = _read_runner_process_row(connection, identity.run_id)
        if row is None or _row_str(row, "spawn_nonce") != identity.spawn_nonce:
            raise EventRejected("Runner identity does not match its persisted spawn claim.")
        existing_pid = _row_optional_int(row, "pid")
        if existing_pid is not None:
            existing = _runner_process_from_row(row, created_by_caller=False)
            if existing.identity != identity:
                raise EventRejected("Runner claim is already bound to another process identity.")
            return existing
        launched_at_ns = _clock_ns(clock)
        updated = connection.execute(
            """
            UPDATE runner_processes
            SET pid = ?, process_identity_bytes = ?, launched_at_ns = ?
            WHERE run_id = ? AND spawn_nonce = ? AND pid IS NULL
            """,
            (
                identity.pid,
                identity_bytes,
                launched_at_ns,
                identity.run_id,
                identity.spawn_nonce,
            ),
        )
        if updated.rowcount != 1:
            raise EventRejected("Runner identity attachment lost its claim race.")
        run = read_run(connection, identity.run_id)
        if run.state is RunState.QUEUED:
            connection.execute(
                "UPDATE runs SET started_at_ns = ? WHERE run_id = ?",
                (launched_at_ns, identity.run_id),
            )
            _mutate_event(
                connection,
                clock=clock,
                event_id_factory=event_id_factory,
                run_id=identity.run_id,
                expected_version=run.state_version,
                target=RunState.RUNNING,
                candidate=EventCandidate.control(
                    type="run.started",
                    ts_event_ns=str(launched_at_ns),
                    payload={
                        "pid": identity.pid,
                        "process_identity_sha256": process_identity_digest(identity),
                        "spawn_nonce": identity.spawn_nonce,
                    },
                ),
            )
        elif run.state is not RunState.CANCEL_REQUESTED:
            raise EventRejected("Runner identity cannot attach in the current run state.")
        attached = _read_runner_process_row(connection, identity.run_id)
        assert attached is not None
        return _runner_process_from_row(attached, created_by_caller=False)


def _request_runner_cancel_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    command: IdempotencyCommand,
    reason: str,
) -> PersistedCancelRequest:
    validated = _validate_idempotency_command(command)
    if validated.operation != "cancel" or validated.target_run_id is None:
        raise ValueError("Runner cancellation requires a server-owned cancel command.")
    if type(reason) is not str or not reason or len(reason) > 256:
        raise ValueError("Cancellation reason must contain 1 through 256 characters.")
    request = _parse_exact_schema_less_object(
        validated.bare_request_bytes,
        label="cancel command request",
    )
    if request != {"reason": reason}:
        raise EventRejected("Cancel reason does not match exact command bytes.")
    with _immediate_transaction(connection):
        replay = _read_idempotent_response(connection, validated)
        if replay is not None:
            state, version, last_seq = _cancel_response_identity(replay)
            return PersistedCancelRequest(
                response=replay,
                state=state,
                state_version=version,
                last_visible_seq=last_seq,
                created_by_caller=False,
                clean_no_claim=False,
                signal_required=False,
            )
        run = read_run(connection, validated.target_run_id)
        if run.state not in {
            RunState.QUEUED,
            RunState.RUNNING,
            RunState.CANCEL_REQUESTED,
            RunState.CANCEL_PENDING,
            RunState.FINALIZING,
            *TERMINAL_STATES,
        }:
            raise EventRejected("Cancel is unsupported before a run is queued.")
        process_row = _read_runner_process_row(connection, run.run_id)
        clean_no_claim = False
        signal_required = False
        if run.state in {RunState.QUEUED, RunState.RUNNING}:
            prior_state = run.state
            transition_result = _mutate_event(
                connection,
                clock=clock,
                event_id_factory=event_id_factory,
                run_id=run.run_id,
                expected_version=run.state_version,
                target=RunState.CANCEL_REQUESTED,
                candidate=EventCandidate.control(
                    type="run.cancel_requested",
                    ts_event_ns=str(_clock_ns(clock)),
                    payload={"reason": reason},
                ),
            )
            run = read_run(connection, run.run_id)
            assert run.state is transition_result.state
            if process_row is None:
                clean_no_claim = prior_state is RunState.QUEUED
            else:
                if _row_str(process_row, "cancel_phase") != "NONE":
                    raise EventRejected("Fresh cancellation found an invalid process phase.")
                connection.execute(
                    """
                    UPDATE runner_processes
                    SET cancel_phase = 'REQUESTED'
                    WHERE run_id = ? AND cancel_phase = 'NONE'
                    """,
                    (run.run_id,),
                )
                signal_required = _row_optional_int(process_row, "pid") is not None
        response_body = canonical_json_bytes(
            {
                "last_visible_seq": run.last_event_seq,
                "run_id": run.run_id,
                "state": run.state.value,
                "state_version": run.state_version,
            }
        )
        status_code = 200 if run.state in TERMINAL_STATES else 202
        response = _validate_idempotent_response(
            IdempotentResponse(
                status_code=status_code,
                body=response_body,
                run_id=run.run_id,
            ),
            command=validated,
            bound_run_id=run.run_id,
        )
        created_at_ns = _clock_ns(clock)
        connection.execute(
            """
            INSERT INTO idempotency_records (
                idempotency_scope,
                idempotency_key,
                request_hash,
                request_body,
                response_status,
                response_body,
                target_run_id,
                run_id,
                created_at_ns
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                validated.scope,
                validated.key,
                validated.request_hash,
                validated.logical_request_bytes,
                response.status_code,
                response.body,
                validated.target_run_id,
                response.run_id,
                created_at_ns,
            ),
        )
        return PersistedCancelRequest(
            response=response,
            state=run.state,
            state_version=run.state_version,
            last_visible_seq=run.last_event_seq,
            created_by_caller=True,
            clean_no_claim=clean_no_claim,
            signal_required=signal_required,
        )


def _mark_runner_term_sent_transaction(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    spawn_nonce: str,
    recovery: bool = False,
) -> bool:
    return _advance_runner_signal_phase_transaction(
        connection,
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        target="TERM_SENT",
        recovery=recovery,
    )


def _mark_runner_kill_sent_transaction(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    spawn_nonce: str,
    recovery: bool = False,
) -> bool:
    return _advance_runner_signal_phase_transaction(
        connection,
        run_id=run_id,
        spawn_nonce=spawn_nonce,
        target="KILL_SENT",
        recovery=recovery,
    )


def _advance_runner_signal_phase_transaction(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    spawn_nonce: str,
    target: Literal["TERM_SENT", "KILL_SENT"],
    recovery: bool,
) -> bool:
    _require_nonempty_string(run_id, label="signal run_id")
    _require_nonempty_string(spawn_nonce, label="signal spawn_nonce")
    with _immediate_transaction(connection):
        run = read_run(connection, run_id)
        if recovery:
            if run.state not in {
                RunState.RUNNING,
                RunState.CANCEL_REQUESTED,
                RunState.CANCEL_PENDING,
            }:
                return False
        elif run.state is not RunState.CANCEL_REQUESTED:
            return False
        row = _read_runner_process_row(connection, run_id)
        if row is None or _row_str(row, "spawn_nonce") != spawn_nonce:
            raise EventRejected("Signal phase does not match the runner claim.")
        current = _row_str(row, "cancel_phase")
        if target == "TERM_SENT":
            if current == "TERM_SENT":
                return False
            if recovery:
                updated = connection.execute(
                    """
                    UPDATE runner_processes
                    SET cancel_phase = 'TERM_SENT'
                    WHERE run_id = ? AND spawn_nonce = ?
                      AND cancel_phase IN ('NONE', 'REQUESTED')
                    """,
                    (run_id, spawn_nonce),
                )
            else:
                updated = connection.execute(
                    """
                    UPDATE runner_processes
                    SET cancel_phase = 'TERM_SENT'
                    WHERE run_id = ? AND spawn_nonce = ?
                      AND cancel_phase = 'REQUESTED'
                    """,
                    (run_id, spawn_nonce),
                )
        else:
            if current == "KILL_SENT":
                return False
            updated = connection.execute(
                """
                UPDATE runner_processes
                SET cancel_phase = 'KILL_SENT'
                WHERE run_id = ? AND spawn_nonce = ?
                  AND cancel_phase = 'TERM_SENT'
                """,
                (run_id, spawn_nonce),
            )
        return updated.rowcount == 1


def _record_runner_outcome_transaction(
    connection: sqlite3.Connection, *, clock: Clock,
    event_id_factory: EventIdFactory, outcome: SupervisorExitV1,
) -> RunnerOutcomeRecord:
    if type(outcome) is not SupervisorExitV1:
        raise TypeError("Runner outcome requires an exact SupervisorExitV1.")
    result = _record_observed_runner_outcome_transaction(
        connection, clock=clock, event_id_factory=event_id_factory, outcome=outcome,
    )
    assert isinstance(result, RunnerOutcomeRecord)
    return result


def _record_historical_runner_outcome_transaction(
    connection: sqlite3.Connection, *, clock: Clock,
    event_id_factory: EventIdFactory, outcome: SupervisorExitV2,
) -> HistoricalRunnerOutcomeRecord:
    if type(outcome) is not SupervisorExitV2:
        raise TypeError("Runner outcome requires an exact SupervisorExitV2.")
    result = _record_observed_runner_outcome_transaction(
        connection, clock=clock, event_id_factory=event_id_factory, outcome=outcome,
    )
    assert isinstance(result, HistoricalRunnerOutcomeRecord)
    return result


def _record_observed_runner_outcome_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    outcome: SupervisorExitV1 | SupervisorExitV2,
) -> RunnerOutcomeRecord | HistoricalRunnerOutcomeRecord:
    if type(outcome) is SupervisorExitV1:
        payload = supervisor_exit_bytes(outcome)
    elif type(outcome) is SupervisorExitV2:
        payload = historical_exit_bytes(outcome)
    else:
        raise TypeError("Runner outcome requires an exact observer contract.")
    digest = sha256(payload).hexdigest()
    with _immediate_transaction(connection):
        from stark_trading_os.control.historical_outcomes import (
            _historical_outcome_from_row,
            _require_historical_run,
            _validate_historical_transaction_truth,
        )
        if isinstance(outcome, SupervisorExitV1):
            _require_probe_run(connection, outcome.run_id)
        else:
            _require_historical_run(connection, outcome.run_id)
        existing_row = connection.execute(
            """
            SELECT run_id, outcome_bytes, outcome_hash, recorded_at_ns
            FROM runner_outcomes
            WHERE run_id = ?
            """,
            (outcome.run_id,),
        ).fetchone()
        if existing_row is not None:
            existing = (
                _runner_outcome_from_row(connection, existing_row)
                if isinstance(outcome, SupervisorExitV1)
                else _historical_outcome_from_row(connection, existing_row)
            )
            if existing.outcome_bytes != payload or existing.outcome_hash != digest:
                raise EventRejected("A different runner outcome is already recorded.")
            return existing
        run = read_run(connection, outcome.run_id)
        if run.state not in {
            RunState.QUEUED,
            RunState.RUNNING,
            RunState.CANCEL_REQUESTED,
            RunState.CANCEL_PENDING,
        }:
            raise EventRejected("Runner outcome cannot enter FINALIZING from this state.")
        process_row = _read_runner_process_row(connection, outcome.run_id)
        _validate_outcome_process_binding(outcome, process_row)
        if isinstance(outcome, SupervisorExitV1):
            _validate_outcome_transaction_truth(
                connection, outcome=outcome, run=run, process_row=process_row,
            )
        else:
            _validate_historical_transaction_truth(connection, outcome, process_row)
        recorded_at_ns = _clock_ns(clock)
        connection.execute(
            """
            INSERT INTO runner_outcomes (
                run_id, outcome_bytes, outcome_hash, recorded_at_ns
            ) VALUES (?, ?, ?, ?)
            """,
            (outcome.run_id, payload, digest, recorded_at_ns),
        )
        _mutate_event(
            connection,
            clock=clock,
            event_id_factory=event_id_factory,
            run_id=outcome.run_id,
            expected_version=run.state_version,
            target=RunState.FINALIZING,
            candidate=EventCandidate.control(
                type="run.finalizing",
                ts_event_ns=str(recorded_at_ns),
                payload={
                    "classification": outcome.classification,
                    "outcome_hash": digest,
                    "proposed_terminal_state": outcome.proposed_terminal_state,
                },
            ),
        )
        stored_row = connection.execute(
            """
            SELECT run_id, outcome_bytes, outcome_hash, recorded_at_ns
            FROM runner_outcomes
            WHERE run_id = ?
            """,
            (outcome.run_id,),
        ).fetchone()
        assert stored_row is not None
        return (
            _runner_outcome_from_row(connection, stored_row)
            if isinstance(outcome, SupervisorExitV1)
            else _historical_outcome_from_row(connection, stored_row)
        )


def _insert_terminal_boundary(
    connection: sqlite3.Connection, *, run_id: str, outcome_hash: str,
    terminal_state: RunState, state_version: int, envelope: EventEnvelopeV1,
    audit_seq: int, prepared_at_ns: int,
) -> None:
    """Persist the common prepared boundary inside an existing writer transaction."""
    if not connection.in_transaction:
        raise RuntimeError("Terminal preparation requires a writer transaction.")
    run_row = connection.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run_row is None:
        raise TerminalIntegrityError("Terminal run disappeared.")
    event_id, event_seq, source_seq = envelope.event_id, envelope.seq, envelope.source_seq
    event_type, timestamp = envelope.type, envelope.ts_ingest_ns
    envelope_bytes = canonical_json_bytes(envelope.model_dump(mode="json", by_alias=True))
    event_digest = sha256(envelope_bytes).hexdigest()
    intent_bytes = canonical_json_bytes({
        "seq": audit_seq, "run_id": run_id, "event_seq": event_seq, "event_digest": event_digest,
    })
    intent_digest = sha256(intent_bytes).hexdigest()
    connection.execute(
        """
        INSERT INTO terminal_preparations (
            run_id,
            runner_outcome_hash,
            terminal_state,
            terminal_state_version,
            event_id,
            event_seq,
            event_source_seq,
            event_source,
            event_type,
            event_writer,
            event_schema_version,
            event_ts_event_ns,
            event_ts_ingest_ns,
            event_visible,
            event_envelope_bytes,
            event_digest,
            initial_event_digest,
            audit_seq,
            audit_event_digest,
            audit_intent_bytes,
            audit_intent_digest,
            audit_created_at_ns,
            prepared_at_ns,
            disposition,
            failure_attempt_count,
            last_failure_at_ns,
            last_failure_stage,
            conversion_fault_hash,
            converted_at_ns
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, 'control-api', ?, 'control-api', 1,
            ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NORMAL', 0,
            NULL, NULL, NULL, NULL
        )
        """,
        (
            run_id,
            outcome_hash,
            terminal_state.value,
            state_version,
            event_id,
            event_seq,
            source_seq,
            event_type,
            timestamp,
            timestamp,
            envelope_bytes,
            event_digest,
            event_digest,
            audit_seq,
            event_digest,
            intent_bytes,
            intent_digest,
            prepared_at_ns,
            prepared_at_ns,
        ),
    )
    updated = connection.execute(
        """
        UPDATE runs
        SET prepared_terminal_state = ?,
            prepared_terminal_state_version = ?,
            prepared_terminal_event_seq = ?,
            evidence_status = 'STAGING'
        WHERE run_id = ?
          AND state = 'FINALIZING'
          AND state_version = ?
          AND last_event_seq = ?
          AND last_audit_seq = ?
          AND control_source_seq = ?
          AND prepared_terminal_state IS NULL
          AND prepared_terminal_state_version IS NULL
          AND prepared_terminal_event_seq IS NULL
        """,
        (
            terminal_state.value,
            state_version,
            event_seq,
            run_id,
            _row_int(run_row, "state_version"),
            _row_int(run_row, "last_event_seq"),
            _row_int(run_row, "last_audit_seq"),
            _row_int(run_row, "control_source_seq"),
        ),
    )
    if updated.rowcount != 1:
        raise TerminalIntegrityError("Terminal preparation lost its locked run identity.")


def _prepare_terminal_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    run_id: str,
) -> TerminalPreparation:
    _require_nonempty_string(run_id, label="terminal run_id")
    with _immediate_transaction(connection):
        _require_probe_run(connection, run_id)
        existing = _read_terminal_preparation_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if existing is not None:
            if _terminal_event_or_seal_count(connection, run_id) != 0:
                publication = _read_terminal_finalization_unchecked(
                    connection,
                    run_id=run_id,
                    event_id_factory=event_id_factory,
                )
                if publication is None:
                    raise TerminalIntegrityError(
                        "Existing terminal publication identity is incomplete."
                    )
            return existing
        run_row = _terminal_run_row(connection, run_id)
        if _row_str(run_row, "state") != "FINALIZING":
            raise TerminalEligibilityError("Terminal preparation requires FINALIZING state.")
        if (
            _row_optional_str(run_row, "prepared_terminal_state") is not None
            or _row_optional_int(run_row, "prepared_terminal_state_version") is not None
            or _row_optional_int(run_row, "prepared_terminal_event_seq") is not None
            or _terminal_public_identity_count(connection, run_id) != 0
        ):
            raise TerminalIntegrityError("Existing terminal identity is partial or conflicting.")
        outcome = _validated_terminal_outcome(connection, run_id=run_id, run_row=run_row)
        terminal_state = _outcome_terminal_state(outcome)
        state_version = _row_int(run_row, "state_version") + 1
        event_seq = _row_int(run_row, "last_event_seq") + 1
        audit_seq = _row_int(run_row, "last_audit_seq") + 1
        source_seq = _row_int(run_row, "control_source_seq") + 1
        event_id = event_id_factory(run_id, event_seq)
        _require_nonempty_string(event_id, label="terminal event_id")
        prepared_at_ns = _terminal_clock_ns(clock)
        timestamp = str(prepared_at_ns)
        event_type = _terminal_event_type(terminal_state)
        payload = _terminal_payload(
            outcome=outcome,
            terminal_state=terminal_state,
            disposition="NORMAL",
            fault_hash=None,
        )
        try:
            envelope = EventEnvelopeV1.model_validate(
                {
                    "event_id": event_id,
                    "run_id": run_id,
                    "seq": event_seq,
                    "source_seq": source_seq,
                    "ts_event_ns": timestamp,
                    "ts_ingest_ns": timestamp,
                    "type": event_type,
                    "source": "control-api",
                    "writer": "control-api",
                    "schema_version": 1,
                    "payload": payload,
                }
            )
        except ValidationError as error:
            raise TerminalIntegrityError(f"Invalid prepared EventEnvelopeV1: {error}") from error
        _insert_terminal_boundary(
            connection, run_id=run_id, outcome_hash=outcome.outcome_hash,
            terminal_state=terminal_state, state_version=state_version, envelope=envelope,
            audit_seq=audit_seq, prepared_at_ns=prepared_at_ns,
        )
        prepared = _read_terminal_preparation_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if prepared is None:
            raise TerminalIntegrityError("Terminal preparation disappeared before commit.")
        return prepared


def read_terminal_preparation(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> TerminalPreparation | None:
    _require_nonempty_string(run_id, label="terminal run_id")
    _verify_write_connection(connection)
    _require_probe_run(connection, run_id)
    owns_snapshot = not connection.in_transaction
    if owns_snapshot:
        connection.execute("BEGIN")
    try:
        preparation = _read_terminal_preparation_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if preparation is not None and _terminal_event_or_seal_count(connection, run_id) != 0:
            publication = _read_terminal_finalization_unchecked(
                connection,
                run_id=run_id,
                event_id_factory=event_id_factory,
            )
            if publication is None:
                raise TerminalIntegrityError("Terminal publication identity is incomplete.")
    except BaseException:
        if owns_snapshot and connection.in_transaction:
            connection.rollback()
        raise
    if owns_snapshot:
        connection.rollback()
    return preparation


def read_terminal_finalization(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> TerminalFinalization | None:
    _require_nonempty_string(run_id, label="terminal run_id")
    _verify_write_connection(connection)
    _require_probe_run(connection, run_id)
    owns_snapshot = not connection.in_transaction
    if owns_snapshot:
        connection.execute("BEGIN")
    try:
        finalization = _read_terminal_finalization_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
    except BaseException:
        if owns_snapshot and connection.in_transaction:
            connection.rollback()
        raise
    if owns_snapshot:
        connection.rollback()
    return finalization


def _record_finalization_failure_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    run_id: str,
    failure: FinalizationFailure,
) -> TerminalPreparation | UnverifiedTerminalPublication:
    _require_nonempty_string(run_id, label="terminal run_id")
    if type(failure) is not FinalizationFailure:
        raise TypeError("Finalization failure must be an exact FinalizationFailure.")
    if type(failure.deterministic) is not bool or failure.stage not in _FINALIZATION_STAGES:
        raise ValueError("Finalization failure fields are invalid.")
    with _immediate_transaction(connection):
        existing = _read_terminal_finalization_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if existing is not None:
            if isinstance(existing, UnverifiedTerminalPublication):
                return existing
            raise TerminalPublicationConflict("Verified terminal is already published.")
        preparation = _read_terminal_preparation_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if preparation is None or preparation.disposition != "NORMAL":
            raise TerminalEligibilityError("Finalization failure requires a normal preparation.")
        if _terminal_public_identity_count(connection, run_id) != 0:
            raise TerminalIntegrityError("Finalization failure found a partial public identity.")
        previous_failure_at_ns = (
            preparation.prepared_at_ns
            if preparation.last_failure_at_ns is None
            else preparation.last_failure_at_ns
        )
        observed_at_ns = max(_terminal_clock_ns(clock), previous_failure_at_ns + 1)
        if observed_at_ns > 9_223_372_036_854_775_807:
            raise ValueError("Finalization observation exceeds SQLite INTEGER range.")
        if not failure.deterministic and preparation.failure_attempt_count < 2:
            updated = connection.execute(
                """
                UPDATE terminal_preparations
                SET failure_attempt_count = failure_attempt_count + 1,
                    last_failure_at_ns = ?,
                    last_failure_stage = ?
                WHERE run_id = ?
                  AND disposition = 'NORMAL'
                  AND failure_attempt_count = ?
                """,
                (
                    observed_at_ns,
                    failure.stage,
                    run_id,
                    preparation.failure_attempt_count,
                ),
            )
            if updated.rowcount != 1:
                raise TerminalPublicationConflict("Finalization attempt identity changed.")
            connection.execute(
                "UPDATE runs SET evidence_status = 'PARTIAL' WHERE run_id = ?",
                (run_id,),
            )
            retry = _read_terminal_preparation_unchecked(
                connection,
                run_id=run_id,
                event_id_factory=event_id_factory,
            )
            if retry is None:
                raise TerminalIntegrityError("Finalization attempt disappeared before commit.")
            return retry

        category: FinalizationFailureCategory = (
            "DETERMINISTIC_EVIDENCE_FAILURE"
            if failure.deterministic
            else "OPERATIONAL_RETRY_EXHAUSTED"
        )
        fault_bytes = canonical_json_bytes(
            {
                "schema": "FinalizationFault.v1",
                "run_id": run_id,
                "outcome_hash": preparation.outcome.outcome_hash,
                "initial_event_digest": preparation.initial_event_digest,
                "category": category,
                "stage": failure.stage,
                "attempt_count": 3,
                "observed_at_ns": observed_at_ns,
            }
        )
        fault_hash = sha256(fault_bytes).hexdigest()
        envelope = EventEnvelopeV1.model_validate(
            {
                "event_id": preparation.event.event_id,
                "run_id": run_id,
                "seq": preparation.event.seq,
                "source_seq": preparation.event.source_seq,
                "ts_event_ns": preparation.event.ts_event_ns,
                "ts_ingest_ns": preparation.event.ts_ingest_ns,
                "type": "run.failed",
                "source": "control-api",
                "writer": "control-api",
                "schema_version": 1,
                "payload": _terminal_payload(
                    outcome=preparation.outcome,
                    terminal_state=RunState.FAILED,
                    disposition="FAULT_CONVERTED",
                    fault_hash=fault_hash,
                ),
            }
        )
        envelope_bytes = canonical_json_bytes(envelope.model_dump(mode="json", by_alias=True))
        event_digest = sha256(envelope_bytes).hexdigest()
        audit_bytes = canonical_json_bytes(
            {
                "seq": preparation.audit_intent.audit_seq,
                "run_id": run_id,
                "event_seq": preparation.event.seq,
                "event_digest": event_digest,
            }
        )
        run_updated = connection.execute(
            """
            UPDATE runs
            SET last_event_seq = ?, last_audit_seq = ?, control_source_seq = ?,
                evidence_status = 'UNVERIFIED'
            WHERE run_id = ? AND state = 'FINALIZING' AND state_version = ?
              AND last_event_seq = ? AND last_audit_seq = ? AND control_source_seq = ?
            """,
            (
                preparation.event.seq,
                preparation.audit_intent.audit_seq,
                preparation.event.source_seq,
                run_id,
                preparation.terminal_state_version - 1,
                preparation.event.seq - 1,
                preparation.audit_intent.audit_seq - 1,
                preparation.event.source_seq - 1,
            ),
        )
        if run_updated.rowcount != 1:
            raise TerminalPublicationConflict("Finalization conversion cursors changed.")
        converted = connection.execute(
            """
            UPDATE terminal_preparations
            SET terminal_state = 'FAILED', event_type = 'run.failed',
                event_envelope_bytes = ?, event_digest = ?, audit_event_digest = ?,
                audit_intent_bytes = ?, audit_intent_digest = ?,
                disposition = 'FAULT_CONVERTED', failure_attempt_count = 3,
                last_failure_at_ns = ?, last_failure_stage = ?,
                conversion_fault_hash = ?, converted_at_ns = ?
            WHERE run_id = ? AND disposition = 'NORMAL'
              AND failure_attempt_count = ?
            """,
            (
                envelope_bytes,
                event_digest,
                event_digest,
                audit_bytes,
                sha256(audit_bytes).hexdigest(),
                observed_at_ns,
                failure.stage,
                fault_hash,
                observed_at_ns,
                run_id,
                preparation.failure_attempt_count,
            ),
        )
        if converted.rowcount != 1:
            raise TerminalPublicationConflict("Finalization preparation conversion changed.")
        prepared = connection.execute(
            """
            UPDATE runs SET prepared_terminal_state = 'FAILED'
            WHERE run_id = ? AND prepared_terminal_state = ?
            """,
            (run_id, preparation.terminal_state.value),
        )
        if prepared.rowcount != 1:
            raise TerminalPublicationConflict("Finalization prepared target changed.")
        connection.execute(
            "INSERT INTO finalization_faults "
            "(run_id, fault_bytes, fault_hash, recorded_at_ns) VALUES (?, ?, ?, ?)",
            (run_id, fault_bytes, fault_hash, observed_at_ns),
        )
        connection.execute(
            """
            INSERT INTO events (
                event_id, run_id, seq, source_seq, source, type, writer,
                schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
            ) VALUES (?, ?, ?, ?, 'control-api', 'run.failed', 'control-api',
                      1, ?, ?, 0, ?)
            """,
            (
                preparation.event.event_id,
                run_id,
                preparation.event.seq,
                preparation.event.source_seq,
                preparation.event.ts_event_ns,
                preparation.event.ts_ingest_ns,
                envelope_bytes,
            ),
        )
        connection.execute(
            "INSERT INTO audit_intents "
            "(run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                run_id,
                preparation.audit_intent.audit_seq,
                preparation.event.seq,
                event_digest,
                audit_bytes,
                preparation.audit_intent.created_at_ns,
            ),
        )
        connection.execute(
            "INSERT INTO outbox "
            "(run_id, seq, audit_seq, materialized, materialized_at_ns) "
            "VALUES (?, ?, ?, 0, NULL)",
            (run_id, preparation.event.seq, preparation.audit_intent.audit_seq),
        )
        visible = connection.execute(
            "UPDATE events SET visible = 1 WHERE run_id = ? AND seq = ? AND visible = 0",
            (run_id, preparation.event.seq),
        )
        if visible.rowcount != 1:
            raise TerminalPublicationConflict("Converted terminal event visibility changed.")
        completed = connection.execute(
            """
            UPDATE runs
            SET state = 'FAILED', state_version = ?, completed_at_ns = ?, duration_ns = ?
            WHERE run_id = ? AND state = 'FINALIZING' AND state_version = ?
            """,
            (
                preparation.terminal_state_version,
                preparation.outcome.outcome.ended_at_ns,
                preparation.outcome.outcome.duration_ns,
                run_id,
                preparation.terminal_state_version - 1,
            ),
        )
        if completed.rowcount != 1:
            raise TerminalPublicationConflict("Converted terminal run identity changed.")
        publication = _read_unverified_terminal_publication_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if publication is None:
            raise TerminalIntegrityError("Unverified finalization disappeared before commit.")
        return publication


def _publish_terminal_rows(
    connection: sqlite3.Connection, *, event: PersistedEvent, audit: AuditIntent,
    terminal_state: RunState, state_version: int, ended_at_ns: int, duration_ns: int,
    seal_digest: str, published_at_ns: int,
) -> None:
    """Shared terminal state/event/audit/seal transition, after contract-specific proof."""
    if not connection.in_transaction:
        raise RuntimeError("Terminal publication requires a writer transaction.")
    run_id = event.run_id
    updated = connection.execute(
        """
        UPDATE runs
        SET last_event_seq = ?,
            last_audit_seq = ?,
            control_source_seq = ?
        WHERE run_id = ?
          AND state = 'FINALIZING'
          AND state_version = ?
          AND last_event_seq = ?
          AND last_audit_seq = ?
          AND control_source_seq = ?
        """,
        (
            event.seq,
            audit.audit_seq,
            event.source_seq,
            run_id,
            state_version - 1,
            event.seq - 1,
            audit.audit_seq - 1,
            event.source_seq - 1,
        ),
    )
    if updated.rowcount != 1:
        raise TerminalPublicationConflict("Terminal publication cursors changed.")
    connection.execute(
        """
        INSERT INTO events (
            event_id, run_id, seq, source_seq, source, type, writer,
            schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, 'control-api', 1, ?, ?, 0, ?)
        """,
        (
            event.event_id,
            run_id,
            event.seq,
            event.source_seq,
            event.source,
            event.type,
            event.ts_event_ns,
            event.ts_ingest_ns,
            event.envelope_bytes,
        ),
    )
    connection.execute(
        """
        INSERT INTO audit_intents (
            run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            audit.audit_seq,
            audit.event_seq,
            audit.event_digest,
            audit.intent_bytes,
            audit.created_at_ns,
        ),
    )
    connection.execute(
        """
        INSERT INTO outbox (
            run_id, seq, audit_seq, materialized, materialized_at_ns
        ) VALUES (?, ?, ?, 1, ?)
        """,
        (run_id, event.seq, audit.audit_seq, published_at_ns),
    )
    connection.execute(
        """
        UPDATE outbox
        SET materialized = 1, materialized_at_ns = ?
        WHERE run_id = ? AND seq <= ?
        """,
        (published_at_ns, run_id, event.seq),
    )
    prefix = connection.execute(
        """
        SELECT COUNT(*) AS row_count,
               MIN(seq) AS minimum_seq,
               MAX(seq) AS maximum_seq,
               SUM(CASE WHEN materialized = 1
                             AND materialized_at_ns = ? THEN 0 ELSE 1 END) AS invalid_rows
        FROM outbox
        WHERE run_id = ? AND seq <= ?
        """,
        (published_at_ns, run_id, event.seq),
    ).fetchone()
    if (
        prefix is None
        or _row_int(prefix, "row_count") != event.seq
        or _row_optional_int(prefix, "minimum_seq") != 1
        or _row_optional_int(prefix, "maximum_seq") != event.seq
        or _row_int(prefix, "invalid_rows") != 0
    ):
        raise TerminalIntegrityError("Terminal publication outbox prefix is not contiguous.")
    connection.execute(
        """
        INSERT INTO seals (
            run_id, seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            run_id,
            seal_digest,
            event.seq,
            audit.audit_seq,
            published_at_ns,
        ),
    )
    connection.execute(
        "UPDATE events SET visible = 1 WHERE run_id = ? AND seq = ? AND visible = 0",
        (run_id, event.seq),
    )
    completed = connection.execute(
        """
        UPDATE runs
        SET state = ?,
            state_version = ?,
            completed_at_ns = ?,
            duration_ns = ?,
            evidence_status = 'VERIFIED',
            materialized_event_seq = ?,
            materialized_audit_seq = ?
        WHERE run_id = ?
          AND state = 'FINALIZING'
          AND state_version = ?
        """,
        (
            terminal_state.value,
            state_version,
            ended_at_ns,
            duration_ns,
            event.seq,
            audit.audit_seq,
            run_id,
            state_version - 1,
        ),
    )
    if completed.rowcount != 1:
        raise TerminalPublicationConflict("Terminal run transition lost its identity.")


def _publish_verified_terminal_transaction(
    connection: sqlite3.Connection,
    *,
    clock: Clock,
    event_id_factory: EventIdFactory,
    proof: _VerifiedRootProof,
    authority: _PublicationAuthority,
    window: _VerifiedPublicationWindow,
) -> TerminalPublication:
    if type(proof) is not _VerifiedRootProof:
        raise TypeError("Verified publication requires an exact private root proof.")
    identity = proof._consume_locked_guard(authority=authority)
    _require_nonempty_string(identity.run_id, label="terminal run_id")
    if (
        type(identity.terminal_state) is not RunState
        or identity.terminal_state not in TERMINAL_STATES
    ):
        raise ValueError("Verified root proof state must be terminal.")
    if type(identity.terminal_event_seq) is not int or identity.terminal_event_seq < 1:
        raise ValueError("Verified root proof event sequence must be positive.")
    if type(identity.last_audit_seq) is not int or identity.last_audit_seq < 1:
        raise ValueError("Verified root proof audit sequence must be positive.")
    _require_digest(identity.seal_digest, label="verified seal digest")
    run_id = identity.run_id
    window_identity = authority._require_window(window, proof_identity=identity)
    if not connection.in_transaction:
        raise RuntimeError("Verified publication window lost its SQLite writer transaction.")
    if connection.in_transaction:
        existing_publication = _read_terminal_publication_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if existing_publication is not None:
            if (
                existing_publication.state is not identity.terminal_state
                or existing_publication.event.seq != identity.terminal_event_seq
                or existing_publication.audit_intent.audit_seq != identity.last_audit_seq
                or existing_publication.seal_digest != identity.seal_digest
            ):
                raise TerminalPublicationConflict(
                    "Published terminal identity differs from the supplied proof."
                )
            return existing_publication
        preparation = _read_terminal_preparation_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if preparation is None:
            raise TerminalEligibilityError("Verified publication requires a preparation.")
        run_row = _terminal_run_row(connection, run_id)
        if (
            _frozen_preparation_identity(preparation) != window_identity
            or preparation.disposition != "NORMAL"
            or _row_str(run_row, "state") != "FINALIZING"
            or _row_str(run_row, "evidence_status") not in {"STAGING", "PARTIAL"}
            or _terminal_public_identity_count(connection, run_id) != 0
            or preparation.terminal_state is not identity.terminal_state
            or preparation.event.seq != identity.terminal_event_seq
            or preparation.audit_intent.audit_seq != identity.last_audit_seq
        ):
            raise TerminalPublicationConflict(
                "Verified publication found a conflicting terminal identity."
            )
        published_at_ns = _terminal_clock_ns(clock)
        _publish_terminal_rows(
            connection, event=preparation.event, audit=preparation.audit_intent,
            terminal_state=preparation.terminal_state,
            state_version=preparation.terminal_state_version,
            ended_at_ns=preparation.outcome.outcome.ended_at_ns,
            duration_ns=preparation.outcome.outcome.duration_ns,
            seal_digest=identity.seal_digest, published_at_ns=published_at_ns,
        )
        publication = _read_terminal_publication_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
        if publication is None:
            raise TerminalIntegrityError("Terminal publication disappeared before commit.")
        if publication.seal_digest != identity.seal_digest:
            raise TerminalPublicationConflict("Terminal publication seal changed before commit.")
        return publication


def _planned_terminal_run_record(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    run_row: sqlite3.Row,
    preparation_row: sqlite3.Row,
    outcome: RunnerOutcomeRecord,
    terminal_state: RunState,
) -> RunRecordV1:
    preflight_rows = connection.execute(
        """
        SELECT preflight_id
        FROM preflights
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchall()
    if len(preflight_rows) != 1:
        raise ValueError("Terminal run record requires one exact preflight identity.")
    preflight_id = _row_str(preflight_rows[0], "preflight_id")
    preflight = read_preflight(connection, preflight_id)
    if preflight is None or preflight.run_id != run_id:
        raise ValueError("Terminal run record preflight identity disappeared.")
    preflight_request_hash = preflight.request_hash
    preflight_manifest = preflight.input_manifest_bytes
    preflight_manifest_hash = preflight.input_manifest_hash
    run_manifest = _row_optional_bytes(run_row, "input_manifest_bytes")
    run_manifest_hash = _row_optional_str(run_row, "input_manifest_hash")
    if (
        preflight.status != "PREFLIGHT_READY"
        or preflight.consumed_at_ns is None
        or preflight_manifest is None
        or preflight_manifest_hash is None
        or run_manifest != preflight_manifest
        or run_manifest_hash != preflight_manifest_hash
    ):
        raise ValueError("Terminal run record preflight identity is invalid.")

    create_rows = connection.execute(
        """
        SELECT idempotency_key, request_hash, request_body, response_status,
               response_body, target_run_id, run_id
        FROM idempotency_records
        WHERE idempotency_scope = 'backtest.create'
          AND run_id = ?
          AND response_status BETWEEN 200 AND 299
        """,
        (run_id,),
    ).fetchall()
    if len(create_rows) != 1:
        raise ValueError("Terminal run record requires one successful create identity.")
    create = create_rows[0]
    logical_request_bytes = _row_bytes(create, "request_body")
    logical_request = _parse_exact_schema_less_object(
        logical_request_bytes,
        label="terminal create request",
    )
    if set(logical_request) != {"command", "request"}:
        raise ValueError("Terminal create request fields are invalid.")
    bare_request = logical_request["request"]
    if logical_request["command"] != "backtest.create" or type(bare_request) is not dict:
        raise ValueError("Terminal create command identity is invalid.")
    if set(bare_request) != {"canonical_request_hash", "preflight_id"}:
        raise ValueError("Terminal create request linkage is invalid.")
    if bare_request != {
        "canonical_request_hash": preflight_request_hash,
        "preflight_id": preflight_id,
    }:
        raise ValueError("Terminal create request does not bind its preflight.")
    response_body = _row_bytes(create, "response_body")
    response_run_id, response_manifest_hash = _validated_create_response_object(
        _parse_exact_schema_less_object(response_body, label="terminal create response")
    )
    if (
        _row_str(create, "request_hash") != sha256(logical_request_bytes).hexdigest()
        or _row_int(create, "response_status") != 202
        or _row_optional_str(create, "target_run_id") is not None
        or _row_optional_str(create, "run_id") != run_id
        or response_run_id != run_id
        or response_manifest_hash != preflight_manifest_hash
    ):
        raise ValueError("Terminal create response identity is invalid.")
    queued_row = connection.execute(
        """
        SELECT event_id, run_id, seq, source_seq, source, type, writer,
               schema_version, ts_event_ns, ts_ingest_ns, visible, envelope_bytes
        FROM events
        WHERE run_id = ? AND seq = 2
        """,
        (run_id,),
    ).fetchone()
    if queued_row is None:
        raise ValueError("Terminal create identity has no queued event.")
    queued_event = _event_from_row(queued_row)
    queued_envelope = EventEnvelopeV1.model_validate(
        _parse_exact_schema_less_object(
            queued_event.envelope_bytes,
            label="terminal create queued event",
        )
    )
    if (
        queued_event.visible is not True
        or queued_event.source != "control-api"
        or queued_event.type != "run.queued"
        or queued_envelope.event_id != queued_event.event_id
        or queued_envelope.run_id != run_id
        or queued_envelope.seq != 2
        or queued_envelope.source_seq != 2
        or queued_envelope.source != "control-api"
        or queued_envelope.writer != "control-api"
        or queued_envelope.type != "run.queued"
        or queued_envelope.schema_version != 1
        or queued_envelope.ts_event_ns != queued_event.ts_event_ns
        or queued_envelope.ts_ingest_ns != queued_event.ts_ingest_ns
        or queued_envelope.model_dump(mode="json")["payload"] != {"preflight_id": preflight_id}
    ):
        raise ValueError("Terminal create queued event identity is invalid.")
    queued_digest = sha256(queued_event.envelope_bytes).hexdigest()
    queued_audit_row = connection.execute(
        """
        SELECT run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        FROM audit_intents
        WHERE run_id = ? AND audit_seq = 2
        """,
        (run_id,),
    ).fetchone()
    queued_outbox_row = connection.execute(
        """
        SELECT run_id, seq, audit_seq, materialized, materialized_at_ns
        FROM outbox
        WHERE run_id = ? AND seq = 2
        """,
        (run_id,),
    ).fetchone()
    if queued_audit_row is None or queued_outbox_row is None:
        raise ValueError("Terminal create audit/outbox identity is incomplete.")
    queued_audit = _audit_from_row(queued_audit_row)
    queued_outbox = _outbox_from_row(queued_outbox_row)
    expected_queued_intent = canonical_json_bytes(
        {
            "seq": 2,
            "run_id": run_id,
            "event_seq": 2,
            "event_digest": queued_digest,
        }
    )
    if (
        queued_audit.audit_seq != 2
        or queued_audit.event_seq != 2
        or queued_audit.event_digest != queued_digest
        or queued_audit.intent_bytes != expected_queued_intent
        or queued_audit.created_at_ns != int(queued_event.ts_ingest_ns)
        or queued_outbox.seq != 2
        or queued_outbox.audit_seq != 2
        or (not queued_outbox.materialized) != (queued_outbox.materialized_at_ns is None)
    ):
        raise ValueError("Terminal create audit/outbox identity is invalid.")

    process_row = _read_runner_process_row(connection, run_id)
    process = (
        None
        if process_row is None
        else _runner_process_from_row(process_row, created_by_caller=False)
    )
    started_at_ns = _row_optional_int(run_row, "started_at_ns")
    if started_at_ns != outcome.outcome.launched_at_ns:
        raise ValueError("Terminal run start time does not bind the runner outcome.")
    runner_identity = (
        None
        if process is None or process.identity is None
        else process.identity.model_dump(mode="json")
    )
    return RunRecordV1.model_validate(
        {
            "schema": "RunRecord.v1",
            "run_id": run_id,
            "preflight_id": preflight_id,
            "idempotency_scope": "backtest.create",
            "idempotency_key": _row_str(create, "idempotency_key"),
            "state": terminal_state,
            "state_version": _row_int(preparation_row, "terminal_state_version"),
            "prepared_terminal_state": terminal_state,
            "prepared_terminal_state_version": _row_int(preparation_row, "terminal_state_version"),
            "created_at_ns": str(_row_int(run_row, "created_at_ns")),
            "started_at_ns": None if started_at_ns is None else str(started_at_ns),
            "completed_at_ns": str(outcome.outcome.ended_at_ns),
            "duration_ns": str(outcome.outcome.duration_ns),
            "runner_identity": runner_identity,
            "runner_exit": outcome.outcome.model_dump(mode="json"),
            "materialized_event_seq": _row_int(preparation_row, "event_seq"),
            "materialized_audit_seq": _row_int(preparation_row, "audit_seq"),
            "evidence_status": "VERIFIED",
        }
    )


def _read_finalization_fault_unchecked(
    connection: sqlite3.Connection,
    *,
    run_id: str,
) -> FinalizationFaultRecord | None:
    row = connection.execute(
        "SELECT run_id, fault_bytes, fault_hash, recorded_at_ns "
        "FROM finalization_faults WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    if row is None:
        return None
    fault_bytes = _row_bytes(row, "fault_bytes")
    fault_hash = _row_str(row, "fault_hash")
    recorded_at_ns = _row_int(row, "recorded_at_ns")
    value = _parse_exact_schema_less_object(
        fault_bytes,
        label="finalization fault",
    )
    if set(value) != {
        "schema",
        "run_id",
        "outcome_hash",
        "initial_event_digest",
        "category",
        "stage",
        "attempt_count",
        "observed_at_ns",
    }:
        raise ValueError("Finalization fault fields are invalid.")
    category = value["category"]
    stage = value["stage"]
    observed_at_ns = value["observed_at_ns"]
    if (
        value["schema"] != "FinalizationFault.v1"
        or value["run_id"] != run_id
        or type(value["outcome_hash"]) is not str
        or type(value["initial_event_digest"]) is not str
        or category not in _FINALIZATION_FAILURE_CATEGORIES
        or stage not in _FINALIZATION_STAGES
        or value["attempt_count"] != 3
        or type(observed_at_ns) is not int
        or observed_at_ns != recorded_at_ns
        or sha256(fault_bytes).hexdigest() != fault_hash
    ):
        raise ValueError("Finalization fault identity is invalid.")
    _require_digest(value["outcome_hash"], label="fault outcome hash")
    _require_digest(
        value["initial_event_digest"],
        label="fault initial event digest",
    )
    return FinalizationFaultRecord(
        run_id=run_id,
        fault_bytes=fault_bytes,
        fault_hash=fault_hash,
        recorded_at_ns=recorded_at_ns,
        category=cast(FinalizationFailureCategory, category),
        stage=cast(FinalizationStage, stage),
    )


def _read_terminal_preparation_unchecked(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> TerminalPreparation | None:
    run_row = _terminal_run_row(connection, run_id)
    row = connection.execute(
        "SELECT * FROM terminal_preparations WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    if row is None:
        if (
            _row_optional_str(run_row, "prepared_terminal_state") is not None
            or _row_optional_int(run_row, "prepared_terminal_state_version") is not None
            or _row_optional_int(run_row, "prepared_terminal_event_seq") is not None
            or _terminal_public_identity_count(connection, run_id) != 0
        ):
            raise TerminalIntegrityError("Terminal identity exists without its preparation.")
        return None
    try:
        outcome = _validated_terminal_outcome(connection, run_id=run_id, run_row=run_row)
        raw_disposition = _row_str(row, "disposition")
        if raw_disposition not in {"NORMAL", "FAULT_CONVERTED"}:
            raise ValueError("Unknown terminal preparation disposition.")
        disposition = cast(TerminalPreparationDisposition, raw_disposition)
        terminal_state = RunState(_row_str(row, "terminal_state"))
        if terminal_state not in TERMINAL_STATES:
            raise ValueError("Preparation target is not terminal.")
        event_seq = _row_int(row, "event_seq")
        event_id = _row_str(row, "event_id")
        if event_id != event_id_factory(run_id, event_seq):
            raise ValueError("Prepared terminal event ID is not store-derived.")
        envelope_bytes = _row_bytes(row, "event_envelope_bytes")
        envelope_value = _parse_exact_schema_less_object(
            envelope_bytes,
            label="prepared terminal event envelope",
        )
        envelope = EventEnvelopeV1.model_validate(envelope_value)
        fault_hash = _row_optional_str(row, "conversion_fault_hash")
        fault = _read_finalization_fault_unchecked(connection, run_id=run_id)
        fault_value = (
            None
            if fault is None
            else _parse_exact_schema_less_object(
                fault.fault_bytes,
                label="finalization fault",
            )
        )
        expected_payload = _terminal_payload(
            outcome=outcome,
            terminal_state=terminal_state,
            disposition=disposition,
            fault_hash=fault_hash,
        )
        envelope_payload = envelope.model_dump(mode="json")["payload"]
        event_digest = _row_str(row, "event_digest")
        if (
            envelope.event_id != event_id
            or envelope.run_id != run_id
            or envelope.seq != event_seq
            or envelope.source_seq != _row_int(row, "event_source_seq")
            or envelope.source != _row_str(row, "event_source")
            or envelope.type != _row_str(row, "event_type")
            or envelope.writer != _row_str(row, "event_writer")
            or envelope.schema_version != _row_int(row, "event_schema_version")
            or envelope.ts_event_ns != _row_str(row, "event_ts_event_ns")
            or envelope.ts_ingest_ns != _row_str(row, "event_ts_ingest_ns")
            or _row_int(row, "event_visible") != 0
            or envelope_payload != expected_payload
            or sha256(envelope_bytes).hexdigest() != event_digest
        ):
            raise ValueError("Prepared terminal event identity is invalid.")
        audit_seq = _row_int(row, "audit_seq")
        intent_bytes = _row_bytes(row, "audit_intent_bytes")
        expected_intent = {
            "seq": audit_seq,
            "run_id": run_id,
            "event_seq": event_seq,
            "event_digest": event_digest,
        }
        if (
            _parse_exact_schema_less_object(
                intent_bytes,
                label="prepared terminal audit intent",
            )
            != expected_intent
            or _row_str(row, "audit_event_digest") != event_digest
            or sha256(intent_bytes).hexdigest() != _row_str(row, "audit_intent_digest")
            or _row_int(row, "audit_created_at_ns") != int(_row_str(row, "event_ts_ingest_ns"))
            or _row_int(row, "prepared_at_ns") != _row_int(row, "audit_created_at_ns")
            or _row_str(row, "runner_outcome_hash") != outcome.outcome_hash
            or (disposition == "NORMAL" and terminal_state is not _outcome_terminal_state(outcome))
        ):
            raise ValueError("Prepared terminal audit or outcome identity is invalid.")
        if (
            _row_optional_str(run_row, "prepared_terminal_state") != terminal_state.value
            or _row_optional_int(run_row, "prepared_terminal_state_version")
            != _row_int(row, "terminal_state_version")
            or _row_optional_int(run_row, "prepared_terminal_event_seq") != event_seq
        ):
            raise ValueError("Run prepared identity differs from its preparation.")
        _validate_terminal_run_phase(
            connection,
            run_id=run_id,
            run_row=run_row,
            preparation_row=row,
            terminal_state=terminal_state,
            disposition=disposition,
        )
        preparation = TerminalPreparation(
            run_id=run_id,
            outcome=outcome,
            run_record=(
                _planned_terminal_run_record(
                    connection,
                    run_id=run_id,
                    run_row=run_row,
                    preparation_row=row,
                    outcome=outcome,
                    terminal_state=terminal_state,
                )
                if disposition == "NORMAL"
                else None
            ),
            terminal_state=terminal_state,
            terminal_state_version=_row_int(row, "terminal_state_version"),
            event=PersistedEvent(
                event_id=event_id,
                run_id=run_id,
                seq=event_seq,
                source_seq=_row_int(row, "event_source_seq"),
                source="control-api",
                type=_row_str(row, "event_type"),
                ts_event_ns=_row_str(row, "event_ts_event_ns"),
                ts_ingest_ns=_row_str(row, "event_ts_ingest_ns"),
                visible=False,
                envelope_bytes=envelope_bytes,
            ),
            audit_intent=AuditIntent(
                run_id=run_id,
                audit_seq=audit_seq,
                event_seq=event_seq,
                event_digest=event_digest,
                intent_bytes=intent_bytes,
                created_at_ns=_row_int(row, "audit_created_at_ns"),
            ),
            disposition=disposition,
            initial_event_digest=_row_str(row, "initial_event_digest"),
            failure_attempt_count=_row_int(row, "failure_attempt_count"),
            last_failure_at_ns=_row_optional_int(row, "last_failure_at_ns"),
            last_failure_stage=_row_optional_str(row, "last_failure_stage"),
            conversion_fault_hash=fault_hash,
            prepared_at_ns=_row_int(row, "prepared_at_ns"),
            converted_at_ns=_row_optional_int(row, "converted_at_ns"),
        )
        if disposition == "NORMAL" and (
            preparation.failure_attempt_count not in {0, 1, 2}
            or (
                preparation.failure_attempt_count == 0
                and (
                    preparation.last_failure_at_ns is not None
                    or preparation.last_failure_stage is not None
                )
            )
            or (
                preparation.failure_attempt_count in {1, 2}
                and (
                    preparation.last_failure_at_ns is None
                    or preparation.last_failure_stage is None
                    or preparation.last_failure_stage not in _FINALIZATION_STAGES
                    or preparation.last_failure_at_ns <= preparation.prepared_at_ns
                )
            )
            or preparation.initial_event_digest != event_digest
            or preparation.conversion_fault_hash is not None
            or preparation.converted_at_ns is not None
            or fault is not None
        ):
            raise ValueError("Normal preparation identity is invalid.")
        if disposition == "FAULT_CONVERTED" and (
            fault is None
            or terminal_state is not RunState.FAILED
            or preparation.failure_attempt_count != 3
            or preparation.last_failure_stage != fault.stage
            or preparation.conversion_fault_hash != fault.fault_hash
            or preparation.last_failure_at_ns != fault.recorded_at_ns
            or preparation.converted_at_ns != fault.recorded_at_ns
            or fault_value is None
            or fault_value["outcome_hash"] != preparation.outcome.outcome_hash
            or fault_value["initial_event_digest"] != preparation.initial_event_digest
        ):
            raise ValueError("Converted preparation does not bind its exact fault.")
        return preparation
    except (ValidationError, ValueError, RuntimeError, EventRejected) as error:
        raise TerminalIntegrityError("Persisted terminal preparation is invalid.") from error


def _read_terminal_finalization_unchecked(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> TerminalFinalization | None:
    counts = connection.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM events
             WHERE run_id = ?
               AND type IN ('run.completed', 'run.failed', 'run.cancelled')) AS events,
            (SELECT COUNT(*) FROM seals WHERE run_id = ?) AS seals,
            (SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?) AS faults
        """,
        (run_id, run_id, run_id),
    ).fetchone()
    if counts is None:
        raise TerminalIntegrityError("Terminal finalization counts are missing.")
    event_count = _row_int(counts, "events")
    seal_count = _row_int(counts, "seals")
    fault_count = _row_int(counts, "faults")
    if (event_count, seal_count, fault_count) == (0, 0, 0):
        return None
    if (event_count, seal_count, fault_count) == (1, 1, 0):
        return _read_terminal_publication_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
    if (event_count, seal_count, fault_count) == (1, 0, 1):
        return _read_unverified_terminal_publication_unchecked(
            connection,
            run_id=run_id,
            event_id_factory=event_id_factory,
        )
    raise TerminalIntegrityError("Terminal finalization identity is partial or conflicting.")


def _read_unverified_terminal_publication_unchecked(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> UnverifiedTerminalPublication | None:
    preparation = _read_terminal_preparation_unchecked(
        connection,
        run_id=run_id,
        event_id_factory=event_id_factory,
    )
    if preparation is None or preparation.disposition != "FAULT_CONVERTED":
        raise TerminalIntegrityError("Unverified publication lacks a converted preparation.")
    fault = _read_finalization_fault_unchecked(connection, run_id=run_id)
    event_row = connection.execute(
        """
        SELECT event_id, run_id, seq, source_seq, source, type,
               ts_event_ns, ts_ingest_ns, visible, envelope_bytes
        FROM events WHERE run_id = ? AND seq = ?
        """,
        (run_id, preparation.event.seq),
    ).fetchone()
    audit_row = connection.execute(
        """
        SELECT run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        FROM audit_intents WHERE run_id = ? AND audit_seq = ?
        """,
        (run_id, preparation.audit_intent.audit_seq),
    ).fetchone()
    outbox_row = connection.execute(
        """
        SELECT run_id, seq, audit_seq, materialized, materialized_at_ns
        FROM outbox WHERE run_id = ? AND seq = ?
        """,
        (run_id, preparation.event.seq),
    ).fetchone()
    if fault is None or event_row is None or audit_row is None or outbox_row is None:
        raise TerminalIntegrityError("Unverified terminal publication is partial.")
    event = _event_from_row(event_row)
    audit = _audit_from_row(audit_row)
    outbox = _outbox_from_row(outbox_row)
    run_row = _terminal_run_row(connection, run_id)
    fault_value = _parse_exact_schema_less_object(
        fault.fault_bytes,
        label="finalization fault",
    )
    if (
        event
        != PersistedEvent(
            event_id=preparation.event.event_id,
            run_id=run_id,
            seq=preparation.event.seq,
            source_seq=preparation.event.source_seq,
            source=preparation.event.source,
            type=preparation.event.type,
            ts_event_ns=preparation.event.ts_event_ns,
            ts_ingest_ns=preparation.event.ts_ingest_ns,
            visible=True,
            envelope_bytes=preparation.event.envelope_bytes,
        )
        or audit != preparation.audit_intent
        or outbox.run_id != run_id
        or outbox.seq != preparation.event.seq
        or outbox.audit_seq != preparation.audit_intent.audit_seq
        or outbox.materialized
        or outbox.materialized_at_ns is not None
        or preparation.conversion_fault_hash != fault.fault_hash
        or fault_value["outcome_hash"] != preparation.outcome.outcome_hash
        or fault_value["initial_event_digest"] != preparation.initial_event_digest
        or _row_str(run_row, "state") != "FAILED"
        or _row_int(run_row, "state_version") != preparation.terminal_state_version
        or _row_int(run_row, "last_event_seq") != preparation.event.seq
        or _row_int(run_row, "last_audit_seq") != preparation.audit_intent.audit_seq
        or _row_int(run_row, "control_source_seq") != preparation.event.source_seq
        or _row_int(run_row, "materialized_event_seq") >= preparation.event.seq
        or _row_int(run_row, "materialized_audit_seq") >= preparation.audit_intent.audit_seq
        or _row_str(run_row, "evidence_status") != "UNVERIFIED"
        or _row_optional_int(run_row, "completed_at_ns") != preparation.outcome.outcome.ended_at_ns
        or _row_optional_int(run_row, "duration_ns") != preparation.outcome.outcome.duration_ns
    ):
        raise TerminalIntegrityError("Unverified terminal publication identity is invalid.")
    return UnverifiedTerminalPublication(
        run_id=run_id,
        state=RunState.FAILED,
        state_version=preparation.terminal_state_version,
        event=event,
        audit_intent=audit,
        fault=fault,
    )


def _read_terminal_publication_unchecked(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    event_id_factory: EventIdFactory,
) -> TerminalPublication | None:
    terminal_count = connection.execute(
        """
        SELECT COUNT(*)
        FROM events
        WHERE run_id = ?
          AND type IN ('run.completed', 'run.failed', 'run.cancelled')
        """,
        (run_id,),
    ).fetchone()
    if terminal_count is None or type(terminal_count[0]) is not int:
        raise TerminalIntegrityError("Terminal event count is malformed.")
    if terminal_count[0] == 0:
        seal_or_fault = connection.execute(
            """
            SELECT EXISTS (SELECT 1 FROM seals WHERE run_id = ?)
                OR EXISTS (SELECT 1 FROM finalization_faults WHERE run_id = ?)
            """,
            (run_id, run_id),
        ).fetchone()
        if seal_or_fault is None or type(seal_or_fault[0]) is not int:
            raise TerminalIntegrityError("Terminal publication identity is malformed.")
        if seal_or_fault[0] != 0:
            raise TerminalIntegrityError("Seal or fault exists without a terminal event.")
        return None
    if terminal_count[0] != 1:
        raise TerminalIntegrityError("A run has more than one terminal event.")
    preparation = _read_terminal_preparation_unchecked(
        connection,
        run_id=run_id,
        event_id_factory=event_id_factory,
    )
    if preparation is None or preparation.disposition != "NORMAL":
        raise TerminalIntegrityError("Verified publication lacks a normal preparation.")
    event_row = connection.execute(
        """
        SELECT event_id, run_id, seq, source_seq, source, type,
               ts_event_ns, ts_ingest_ns, visible, envelope_bytes
        FROM events
        WHERE run_id = ? AND seq = ?
        """,
        (run_id, preparation.event.seq),
    ).fetchone()
    audit_row = connection.execute(
        """
        SELECT run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
        FROM audit_intents
        WHERE run_id = ? AND audit_seq = ?
        """,
        (run_id, preparation.audit_intent.audit_seq),
    ).fetchone()
    seal_row = connection.execute(
        """
        SELECT seal_digest, terminal_event_seq, last_audit_seq, published_at_ns
        FROM seals WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    run_row = _terminal_run_row(connection, run_id)
    if event_row is None or audit_row is None or seal_row is None:
        raise TerminalIntegrityError("Verified terminal publication is partial.")
    event = _event_from_row(event_row)
    audit = _audit_from_row(audit_row)
    published_at_ns = _row_int(seal_row, "published_at_ns")
    seal_digest = _row_str(seal_row, "seal_digest")
    try:
        _require_digest(seal_digest, label="persisted seal digest")
    except ValueError as error:
        raise TerminalIntegrityError("Verified terminal seal digest is invalid.") from error
    outbox = connection.execute(
        """
        SELECT COUNT(*) AS row_count,
               SUM(CASE WHEN materialized = 1
                             AND materialized_at_ns = ? THEN 0 ELSE 1 END) AS invalid_rows
        FROM outbox
        WHERE run_id = ? AND seq <= ?
        """,
        (published_at_ns, run_id, preparation.event.seq),
    ).fetchone()
    if (
        event
        != PersistedEvent(
            event_id=preparation.event.event_id,
            run_id=run_id,
            seq=preparation.event.seq,
            source_seq=preparation.event.source_seq,
            source=preparation.event.source,
            type=preparation.event.type,
            ts_event_ns=preparation.event.ts_event_ns,
            ts_ingest_ns=preparation.event.ts_ingest_ns,
            visible=True,
            envelope_bytes=preparation.event.envelope_bytes,
        )
        or audit != preparation.audit_intent
        or _row_int(seal_row, "terminal_event_seq") != preparation.event.seq
        or _row_int(seal_row, "last_audit_seq") != preparation.audit_intent.audit_seq
        or outbox is None
        or _row_int(outbox, "row_count") != preparation.event.seq
        or _row_int(outbox, "invalid_rows") != 0
        or _row_str(run_row, "state") != preparation.terminal_state.value
        or _row_int(run_row, "state_version") != preparation.terminal_state_version
        or _row_int(run_row, "last_event_seq") != preparation.event.seq
        or _row_int(run_row, "last_audit_seq") != preparation.audit_intent.audit_seq
        or _row_int(run_row, "control_source_seq") != preparation.event.source_seq
        or _row_int(run_row, "materialized_event_seq") != preparation.event.seq
        or _row_int(run_row, "materialized_audit_seq") != preparation.audit_intent.audit_seq
        or _row_str(run_row, "evidence_status") != "VERIFIED"
        or _row_optional_int(run_row, "completed_at_ns") != preparation.outcome.outcome.ended_at_ns
        or _row_optional_int(run_row, "duration_ns") != preparation.outcome.outcome.duration_ns
        or connection.execute(
            "SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?", (run_id,)
        ).fetchone()[0]
        != 0
    ):
        raise TerminalIntegrityError("Verified terminal publication identity is invalid.")
    return TerminalPublication(
        run_id=run_id,
        state=preparation.terminal_state,
        state_version=preparation.terminal_state_version,
        event=event,
        audit_intent=audit,
        seal_digest=seal_digest,
        published_at_ns=published_at_ns,
        materialized_event_seq=preparation.event.seq,
        materialized_audit_seq=preparation.audit_intent.audit_seq,
    )


def _terminal_run_row(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
    _require_probe_run(connection, run_id)
    row = connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise RunNotFound(run_id)
    if not isinstance(row, sqlite3.Row):
        raise TerminalIntegrityError("Terminal run query must return sqlite3.Row values.")
    return row


def _validate_terminal_run_phase(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    run_row: sqlite3.Row,
    preparation_row: sqlite3.Row,
    terminal_state: RunState,
    disposition: TerminalPreparationDisposition,
) -> None:
    terminal_version = _row_int(preparation_row, "terminal_state_version")
    event_seq = _row_int(preparation_row, "event_seq")
    audit_seq = _row_int(preparation_row, "audit_seq")
    source_seq = _row_int(preparation_row, "event_source_seq")
    public_identity_count = _terminal_public_identity_count(connection, run_id)
    if disposition == "NORMAL" and public_identity_count == 0:
        if (
            _row_str(run_row, "state") != "FINALIZING"
            or _row_int(run_row, "state_version") != terminal_version - 1
            or _row_int(run_row, "last_event_seq") != event_seq - 1
            or _row_int(run_row, "last_audit_seq") != audit_seq - 1
            or _row_int(run_row, "control_source_seq") != source_seq - 1
            or _row_str(run_row, "evidence_status") not in {"STAGING", "PARTIAL"}
        ):
            raise ValueError("Prepared terminal run is not in its predecessor phase.")
        _validate_materialized_run_boundary(
            connection,
            run_id=run_id,
            run_row=run_row,
            last_event_seq=event_seq - 1,
        )
        return
    if disposition == "NORMAL" and public_identity_count == 2:
        if (
            _row_str(run_row, "state") != terminal_state.value
            or _row_int(run_row, "state_version") != terminal_version
            or _row_int(run_row, "last_event_seq") != event_seq
            or _row_int(run_row, "last_audit_seq") != audit_seq
            or _row_int(run_row, "control_source_seq") != source_seq
            or _row_int(run_row, "materialized_event_seq") != event_seq
            or _row_int(run_row, "materialized_audit_seq") != audit_seq
            or _row_str(run_row, "evidence_status") != "VERIFIED"
        ):
            raise ValueError("Published terminal run differs from its prepared identity.")
        return
    if disposition == "FAULT_CONVERTED" and public_identity_count == 1:
        if (
            _row_str(run_row, "state") != "FINALIZING"
            or _row_int(run_row, "state_version") != terminal_version - 1
            or _row_int(run_row, "last_event_seq") != event_seq - 1
            or _row_int(run_row, "last_audit_seq") != audit_seq - 1
            or _row_int(run_row, "control_source_seq") != source_seq - 1
            or _row_str(run_row, "evidence_status") != "UNVERIFIED"
        ):
            raise ValueError("Converted preparation is not in its predecessor phase.")
        _validate_materialized_run_boundary(
            connection,
            run_id=run_id,
            run_row=run_row,
            last_event_seq=event_seq - 1,
        )
        return
    if disposition == "FAULT_CONVERTED" and public_identity_count == 2:
        if (
            _row_str(run_row, "state") != "FAILED"
            or terminal_state is not RunState.FAILED
            or _row_int(run_row, "state_version") != terminal_version
            or _row_int(run_row, "last_event_seq") != event_seq
            or _row_int(run_row, "last_audit_seq") != audit_seq
            or _row_int(run_row, "control_source_seq") != source_seq
            or _row_str(run_row, "evidence_status") != "UNVERIFIED"
        ):
            raise ValueError("Unverified terminal run differs from its preparation.")
        _validate_unverified_materialized_boundary(
            connection,
            run_id=run_id,
            run_row=run_row,
            terminal_event_seq=event_seq,
            terminal_audit_seq=audit_seq,
        )
        return
    raise ValueError("Terminal preparation has a partial public identity.")


def _validate_materialized_run_boundary(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    run_row: sqlite3.Row,
    last_event_seq: int,
) -> None:
    summary = connection.execute(
        """
        SELECT COUNT(*) AS row_count,
               COALESCE(SUM(materialized), 0) AS materialized_count,
               COALESCE(MAX(CASE WHEN materialized = 1 THEN seq ELSE 0 END), 0)
                   AS materialized_event_seq,
               COALESCE(MAX(CASE WHEN materialized = 1 THEN audit_seq ELSE 0 END), 0)
                   AS materialized_audit_seq
        FROM outbox
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if summary is None:
        raise ValueError("Prepared terminal outbox boundary is missing.")
    materialized_event_seq = _row_int(run_row, "materialized_event_seq")
    materialized_audit_seq = _row_int(run_row, "materialized_audit_seq")
    if (
        _row_int(summary, "row_count") != last_event_seq
        or _row_int(summary, "materialized_count") != materialized_event_seq
        or _row_int(summary, "materialized_event_seq") != materialized_event_seq
        or _row_int(summary, "materialized_audit_seq") != materialized_audit_seq
        or materialized_event_seq != materialized_audit_seq
    ):
        raise ValueError("Prepared terminal materialized boundary is invalid.")


def _validate_unverified_materialized_boundary(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    run_row: sqlite3.Row,
    terminal_event_seq: int,
    terminal_audit_seq: int,
) -> None:
    materialized_event_seq = _row_int(run_row, "materialized_event_seq")
    materialized_audit_seq = _row_int(run_row, "materialized_audit_seq")
    expected_event_seq = terminal_event_seq - 1
    expected_audit_seq = terminal_audit_seq - 1
    prefix = connection.execute(
        """
        SELECT COUNT(*) AS row_count,
               MIN(seq) AS minimum_seq,
               MAX(seq) AS maximum_seq,
               MIN(audit_seq) AS minimum_audit_seq,
               MAX(audit_seq) AS maximum_audit_seq,
               COALESCE(SUM(
                   CASE WHEN audit_seq = seq
                              AND (
                                  (seq <= ? AND materialized = 1
                                   AND materialized_at_ns IS NOT NULL)
                                  OR (seq > ? AND materialized = 0
                                      AND materialized_at_ns IS NULL)
                              )
                        THEN 0 ELSE 1 END
               ), 0) AS invalid_rows
        FROM outbox
        WHERE run_id = ? AND seq < ?
        """,
        (materialized_event_seq, materialized_event_seq, run_id, terminal_event_seq),
    ).fetchone()
    expected_minimum = None if expected_event_seq == 0 else 1
    if (
        materialized_event_seq != materialized_audit_seq
        or materialized_event_seq < 0
        or materialized_event_seq > expected_event_seq
        or materialized_audit_seq < 0
        or materialized_audit_seq > expected_audit_seq
        or prefix is None
        or _row_int(prefix, "row_count") != expected_event_seq
        or _row_optional_int(prefix, "minimum_seq") != expected_minimum
        or _row_optional_int(prefix, "maximum_seq")
        != (None if expected_event_seq == 0 else expected_event_seq)
        or _row_optional_int(prefix, "minimum_audit_seq") != expected_minimum
        or _row_optional_int(prefix, "maximum_audit_seq")
        != (None if expected_audit_seq == 0 else expected_audit_seq)
        or _row_int(prefix, "invalid_rows") != 0
    ):
        raise ValueError("Unverified terminal materialized boundary is invalid.")


def _terminal_public_identity_count(connection: sqlite3.Connection, run_id: str) -> int:
    row = connection.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM events
             WHERE run_id = ?
               AND type IN ('run.completed', 'run.failed', 'run.cancelled'))
          + (SELECT COUNT(*) FROM seals WHERE run_id = ?)
          + (SELECT COUNT(*) FROM finalization_faults WHERE run_id = ?)
        """,
        (run_id, run_id, run_id),
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise TerminalIntegrityError("Terminal identity count is malformed.")
    return int(row[0])


def _terminal_event_or_seal_count(connection: sqlite3.Connection, run_id: str) -> int:
    row = connection.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM events
             WHERE run_id = ?
               AND type IN ('run.completed', 'run.failed', 'run.cancelled'))
          + (SELECT COUNT(*) FROM seals WHERE run_id = ?)
        """,
        (run_id, run_id),
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise TerminalIntegrityError("Terminal publication count is malformed.")
    return int(row[0])


def _validated_terminal_outcome(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    run_row: sqlite3.Row,
) -> RunnerOutcomeRecord:
    outcome_row = connection.execute(
        """
        SELECT run_id, outcome_bytes, outcome_hash, recorded_at_ns
        FROM runner_outcomes WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if outcome_row is None:
        raise TerminalEligibilityError("Terminal preparation requires a runner outcome.")
    try:
        outcome = _runner_outcome_from_row(connection, outcome_row)
        expected_state = _outcome_terminal_state(outcome)
        if outcome.outcome.proposed_terminal_state != expected_state.value:
            raise ValueError("Outcome target does not match its classification.")
        finalizing_rows = connection.execute(
            """
            SELECT event_id, run_id, seq, source_seq, source, type,
                   ts_event_ns, ts_ingest_ns, visible, envelope_bytes
            FROM events
            WHERE run_id = ? AND type = 'run.finalizing'
            """,
            (run_id,),
        ).fetchall()
        if len(finalizing_rows) != 1:
            raise ValueError("Outcome requires exactly one run.finalizing lifecycle event.")
        event = _event_from_row(finalizing_rows[0])
        envelope_value = _parse_exact_schema_less_object(
            event.envelope_bytes,
            label="run.finalizing event envelope",
        )
        envelope = EventEnvelopeV1.model_validate(envelope_value)
        if (
            event.visible is not True
            or event.source != "control-api"
            or event.type != "run.finalizing"
            or envelope.event_id != event.event_id
            or envelope.run_id != run_id
            or envelope.seq != event.seq
            or envelope.source_seq != event.source_seq
            or envelope.type != event.type
            or envelope.source != event.source
            or envelope.ts_event_ns != event.ts_event_ns
            or envelope.ts_ingest_ns != event.ts_ingest_ns
            or envelope.model_dump(mode="json")["payload"]
            != {
                "classification": outcome.outcome.classification,
                "outcome_hash": outcome.outcome_hash,
                "proposed_terminal_state": outcome.outcome.proposed_terminal_state,
            }
        ):
            raise ValueError("run.finalizing event does not bind the persisted outcome.")
        audit_row = connection.execute(
            """
            SELECT run_id, audit_seq, event_seq, event_digest, intent_bytes, created_at_ns
            FROM audit_intents
            WHERE run_id = ? AND event_seq = ?
            """,
            (run_id, event.seq),
        ).fetchone()
        outbox_row = connection.execute(
            "SELECT run_id FROM outbox WHERE run_id = ? AND seq = ?",
            (run_id, event.seq),
        ).fetchone()
        if audit_row is None or outbox_row is None:
            raise ValueError("run.finalizing audit/outbox evidence is incomplete.")
        audit = _audit_from_row(audit_row)
        expected_intent = canonical_json_bytes(
            {
                "seq": audit.audit_seq,
                "run_id": run_id,
                "event_seq": event.seq,
                "event_digest": sha256(event.envelope_bytes).hexdigest(),
            }
        )
        if (
            audit.event_digest != sha256(event.envelope_bytes).hexdigest()
            or audit.intent_bytes != expected_intent
            or audit.created_at_ns != int(event.ts_ingest_ns)
        ):
            raise ValueError("run.finalizing audit does not bind the event.")
        preparation_boundary = connection.execute(
            """
            SELECT event_seq, event_source_seq, audit_seq
            FROM terminal_preparations WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if preparation_boundary is None:
            expected_event_seq = _row_int(run_row, "last_event_seq")
            expected_source_seq = _row_int(run_row, "control_source_seq")
            expected_audit_seq = _row_int(run_row, "last_audit_seq")
        else:
            expected_event_seq = _row_int(preparation_boundary, "event_seq") - 1
            expected_source_seq = _row_int(preparation_boundary, "event_source_seq") - 1
            expected_audit_seq = _row_int(preparation_boundary, "audit_seq") - 1
        counts = connection.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM events WHERE run_id = ?) AS event_count,
                (SELECT COUNT(*) FROM audit_intents WHERE run_id = ?) AS audit_count,
                (SELECT COUNT(*) FROM outbox WHERE run_id = ?) AS outbox_count
            """,
            (run_id, run_id, run_id),
        ).fetchone()
        if (
            counts is None
            or _row_int(counts, "event_count") != _row_int(run_row, "last_event_seq")
            or _row_int(counts, "audit_count") != _row_int(run_row, "last_audit_seq")
            or _row_int(counts, "outbox_count") != _row_int(run_row, "last_event_seq")
            or event.seq != expected_event_seq
            or event.source_seq != expected_source_seq
            or audit.audit_seq != expected_audit_seq
        ):
            raise ValueError("Persisted lifecycle cursors are not contiguous.")
        return outcome
    except (ValidationError, ValueError, RuntimeError, EventRejected) as error:
        raise TerminalIntegrityError("Persisted runner outcome authority is invalid.") from error


def _outcome_terminal_state(outcome: RunnerOutcomeRecord) -> RunState:
    mapping = {
        "NATURAL_SUCCESS": RunState.COMPLETED,
        "NATURAL_FAILURE": RunState.FAILED,
        "NO_SPAWN_CANCELLED": RunState.CANCELLED,
        "SUPERVISOR_FAILURE": RunState.FAILED,
    }
    return mapping[outcome.outcome.classification]


def _terminal_event_type(state: RunState) -> str:
    mapping = {
        RunState.COMPLETED: "run.completed",
        RunState.FAILED: "run.failed",
        RunState.CANCELLED: "run.cancelled",
    }
    try:
        return mapping[state]
    except KeyError as error:
        raise TerminalIntegrityError("Terminal preparation target is not terminal.") from error


def _terminal_payload(
    *,
    outcome: RunnerOutcomeRecord,
    terminal_state: RunState,
    disposition: TerminalPreparationDisposition,
    fault_hash: str | None,
) -> dict[str, object]:
    return {
        "classification": outcome.outcome.classification,
        "outcome_hash": outcome.outcome_hash,
        "outcome_terminal_state": outcome.outcome.proposed_terminal_state,
        "terminal_state": terminal_state.value,
        "evidence_status": "VERIFIED" if disposition == "NORMAL" else "UNVERIFIED",
        "finalization_fault_hash": fault_hash,
    }


def _terminal_clock_ns(clock: Clock) -> int:
    value = _clock_ns(clock)
    if value > 9_223_372_036_854_775_807:
        raise ValueError("Injected terminal clock exceeds SQLite INTEGER range.")
    return value


def read_runner_process(
    connection: sqlite3.Connection,
    run_id: str,
) -> RunnerProcessRecord | None:
    _require_nonempty_string(run_id, label="runner process run_id")
    row = _read_runner_process_row(connection, run_id)
    if row is None:
        return None
    return _runner_process_from_row(row, created_by_caller=False)


def read_runner_outcome(
    connection: sqlite3.Connection,
    run_id: str,
) -> RunnerOutcomeRecord | None:
    _require_nonempty_string(run_id, label="runner outcome run_id")
    _require_probe_run(connection, run_id)
    row = connection.execute(
        """
        SELECT run_id, outcome_bytes, outcome_hash, recorded_at_ns
        FROM runner_outcomes
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is None:
        return None
    return _runner_outcome_from_row(connection, row)


def read_recoverable_runner_processes(
    connection: sqlite3.Connection,
) -> tuple[RunnerProcessRecord, ...]:
    rows = connection.execute(
        """
        SELECT rp.run_id, rp.spawn_nonce, rp.pid, rp.process_identity_bytes,
               rp.launched_at_ns, rp.cancel_phase
        FROM runner_processes AS rp
        JOIN runs ON runs.run_id = rp.run_id
        LEFT JOIN runner_outcomes AS outcomes ON outcomes.run_id = rp.run_id
        WHERE runs.state IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
          AND outcomes.run_id IS NULL
        ORDER BY rp.run_id
        """
    ).fetchall()
    return tuple(_runner_process_from_row(row, created_by_caller=False) for row in rows)


def read_recoverable_active_runs(
    connection: sqlite3.Connection,
) -> tuple[RunSnapshot, ...]:
    """Return active control authority in deterministic recovery order."""

    rows = connection.execute(
        """
        SELECT
            run_id,
            state,
            state_version,
            last_event_seq,
            last_audit_seq,
            input_manifest_bytes,
            input_manifest_hash,
            catalog_revision,
            catalog_inventory_hash,
            created_at_ns,
            evidence_status,
            contract_kind
        FROM runs
        WHERE state IN (
            'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'CANCEL_PENDING', 'FINALIZING'
        )
        ORDER BY run_id
        """
    ).fetchall()
    active = tuple(_snapshot_from_row(row) for row in rows)
    allowed = {
        RunState.QUEUED,
        RunState.RUNNING,
        RunState.CANCEL_REQUESTED,
        RunState.CANCEL_PENDING,
        RunState.FINALIZING,
    }
    if any(snapshot.state not in allowed for snapshot in active):
        raise ControlStoreError("Recoverable active run query returned an invalid state.")
    return active


def read_recoverable_clean_cancellations(
    connection: sqlite3.Connection,
) -> tuple[str, ...]:
    rows = connection.execute(
        """
        SELECT runs.run_id
        FROM runs
        LEFT JOIN runner_processes AS processes ON processes.run_id = runs.run_id
        LEFT JOIN runner_outcomes AS outcomes ON outcomes.run_id = runs.run_id
        WHERE runs.state = 'CANCEL_REQUESTED'
          AND processes.run_id IS NULL
          AND outcomes.run_id IS NULL
        ORDER BY runs.run_id
        """
    ).fetchall()
    return tuple(_row_str(row, "run_id") for row in rows)


def read_recoverable_terminal_run_ids(
    connection: sqlite3.Connection,
) -> tuple[str, ...]:
    """Return exact FINALIZING outcomes in deterministic recovery order."""

    rows = connection.execute(
        """
        SELECT runs.run_id
        FROM runs
        JOIN runner_outcomes AS outcomes ON outcomes.run_id = runs.run_id
        WHERE runs.state = 'FINALIZING' AND runs.contract_kind = 'PROBE_V1'
        ORDER BY runs.run_id
        """
    ).fetchall()
    run_ids = tuple(_row_str(row, "run_id") for row in rows)
    for run_id in run_ids:
        if read_runner_outcome(connection, run_id) is None:
            raise TerminalIntegrityError("Recoverable terminal outcome disappeared.")
    return run_ids


def _read_runner_process_row(
    connection: sqlite3.Connection,
    run_id: str,
) -> sqlite3.Row | None:
    row = connection.execute(
        """
        SELECT run_id, spawn_nonce, pid, process_identity_bytes,
               launched_at_ns, cancel_phase
        FROM runner_processes
        WHERE run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is not None and not isinstance(row, sqlite3.Row):
        raise RuntimeError("Runner process query must return sqlite3.Row values.")
    return row


def _runner_process_from_row(
    row: sqlite3.Row,
    *,
    created_by_caller: bool,
) -> RunnerProcessRecord:
    identity_bytes = _row_optional_bytes(row, "process_identity_bytes")
    identity = None if identity_bytes is None else process_identity_from_bytes(identity_bytes)
    return RunnerProcessRecord(
        run_id=_row_str(row, "run_id"),
        spawn_nonce=_row_str(row, "spawn_nonce"),
        pid=_row_optional_int(row, "pid"),
        identity=identity,
        launched_at_ns=_row_optional_int(row, "launched_at_ns"),
        cancel_phase=_row_cancel_phase(row, "cancel_phase"),
        created_by_caller=created_by_caller,
    )


def _runner_outcome_from_row(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
) -> RunnerOutcomeRecord:
    run_id = _row_str(row, "run_id")
    payload = _row_bytes(row, "outcome_bytes")
    outcome = supervisor_exit_from_bytes(payload)
    digest = _row_str(row, "outcome_hash")
    if outcome.run_id != run_id or sha256(payload).hexdigest() != digest:
        raise ValueError("Stored runner outcome row identity is invalid.")
    process_row = _read_runner_process_row(connection, run_id)
    _validate_outcome_process_binding(outcome, process_row)
    return RunnerOutcomeRecord(
        run_id=run_id,
        outcome=outcome,
        outcome_bytes=payload,
        outcome_hash=digest,
        recorded_at_ns=_row_int(row, "recorded_at_ns"),
    )


def _validate_outcome_process_binding(
    outcome: SupervisorExitV1 | SupervisorExitV2,
    process_row: sqlite3.Row | None,
) -> None:
    if process_row is None:
        if outcome.classification != "NO_SPAWN_CANCELLED":
            raise EventRejected("Only a proved no-claim cancel may omit process evidence.")
        return
    if outcome.spawn_nonce != _row_str(process_row, "spawn_nonce"):
        raise EventRejected("Runner outcome spawn nonce does not match its claim.")
    identity_bytes = _row_optional_bytes(process_row, "process_identity_bytes")
    expected_digest = None if identity_bytes is None else sha256(identity_bytes).hexdigest()
    if outcome.process_identity_sha256 != expected_digest:
        raise EventRejected("Runner outcome does not bind persisted process identity.")
    if outcome.launched_at_ns != _row_optional_int(process_row, "launched_at_ns"):
        raise EventRejected("Runner outcome does not bind persisted launch time.")
    if outcome.final_cancel_phase != _row_cancel_phase(process_row, "cancel_phase"):
        raise EventRejected("Runner outcome does not bind persisted cancellation phase.")


def _validate_outcome_transaction_truth(
    connection: sqlite3.Connection,
    *,
    outcome: SupervisorExitV1,
    run: RunSnapshot,
    process_row: sqlite3.Row | None,
) -> None:
    if process_row is None:
        if run.state is not RunState.CANCEL_REQUESTED:
            raise EventRejected("No-spawn cancellation requires current cancel truth.")
    elif _row_cancel_phase(process_row, "cancel_phase") in {
        "TERM_SENT",
        "KILL_SENT",
    } and outcome.classification in {"NATURAL_SUCCESS", "NATURAL_FAILURE"}:
        raise EventRejected("A signaled runner cannot persist a natural outcome.")
    child = outcome.child_outcome
    if child is None:
        return
    if (
        child.run_id != run.run_id
        or child.input_manifest_hash != run.input_manifest_hash
        or child.catalog_revision != run.catalog_revision
    ):
        raise EventRejected("Child outcome does not bind persisted run inputs.")
    cursor_row = connection.execute(
        "SELECT runner_source_seq FROM runs WHERE run_id = ?",
        (run.run_id,),
    ).fetchone()
    assert cursor_row is not None
    cursor = _row_optional_int(cursor_row, "runner_source_seq")
    evidence = connection.execute(
        """
        SELECT COUNT(*) AS event_count,
               MIN(source_seq) AS minimum_source_seq,
               MAX(source_seq) AS maximum_source_seq
        FROM events
        WHERE run_id = ? AND source = 'runner'
        """,
        (run.run_id,),
    ).fetchone()
    assert evidence is not None
    event_count = _row_int(evidence, "event_count")
    minimum = _row_optional_int(evidence, "minimum_source_seq")
    maximum = _row_optional_int(evidence, "maximum_source_seq")
    last_source_seq = child.last_source_seq
    if last_source_seq == 0:
        valid_evidence = cursor is None and event_count == 0 and minimum is None and maximum is None
    else:
        valid_evidence = (
            cursor == last_source_seq
            and event_count == last_source_seq
            and minimum == 1
            and maximum == last_source_seq
        )
    if not valid_evidence:
        raise EventRejected("Child outcome does not bind contiguous runner event evidence.")


def _cancel_response_identity(
    response: IdempotentResponse,
) -> tuple[RunState, int, int]:
    value = _parse_exact_schema_less_object(response.body, label="cancel response")
    state_value = value.get("state")
    if type(state_value) is not str:
        raise ValueError("Stored cancel response state is invalid.")
    try:
        state = RunState(state_value)
    except ValueError as error:
        raise ValueError("Stored cancel response state is invalid.") from error
    version = value.get("state_version")
    last_seq = value.get("last_visible_seq")
    if type(version) is not int or version < 0 or type(last_seq) is not int or last_seq < 0:
        raise ValueError("Stored cancel response cursors are invalid.")
    return state, version, last_seq


def _row_str(row: sqlite3.Row, key: str) -> str:
    value = row[key]
    if type(value) is not str:
        raise RuntimeError(f"SQLite column {key} must be text.")
    return value


def _row_cancel_phase(row: sqlite3.Row, key: str) -> CancelPhase:
    value = _row_str(row, key)
    if value not in {"NONE", "REQUESTED", "TERM_SENT", "KILL_SENT"}:
        raise RuntimeError(f"SQLite column {key} has an invalid cancellation phase.")
    return cast(CancelPhase, value)


def _row_optional_str(row: sqlite3.Row, key: str) -> str | None:
    value = row[key]
    if value is None:
        return None
    if type(value) is not str:
        raise RuntimeError(f"SQLite column {key} must be text or NULL.")
    return value


def _row_int(row: sqlite3.Row, key: str) -> int:
    value = row[key]
    if type(value) is not int:
        raise RuntimeError(f"SQLite column {key} must be an integer.")
    return value


def _row_optional_int(row: sqlite3.Row, key: str) -> int | None:
    value = row[key]
    if value is None:
        return None
    if type(value) is not int:
        raise RuntimeError(f"SQLite column {key} must be an integer or NULL.")
    return value


def _row_bytes(row: sqlite3.Row, key: str) -> bytes:
    value = row[key]
    if type(value) is not bytes:
        raise RuntimeError(f"SQLite column {key} must be a BLOB.")
    return value


def _row_optional_bytes(row: sqlite3.Row, key: str) -> bytes | None:
    value = row[key]
    if value is None:
        return None
    if type(value) is not bytes:
        raise RuntimeError(f"SQLite column {key} must be a BLOB or NULL.")
    return value
