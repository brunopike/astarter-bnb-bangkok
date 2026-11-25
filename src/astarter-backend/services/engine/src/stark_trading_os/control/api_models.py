"""Narrow HTTP DTOs for the local backtest control surface."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    model_validator,
)

from stark_trading_os.control.preflight_contract import validate_unix_epoch_ns
from stark_trading_os.control.process_identity import (
    CancelPhase,
    SupervisorClassification,
    SupervisorFailureCode,
)
from stark_trading_os.control.transactions import FinalizationFailureCategory, FinalizationStage
from stark_trading_os.domain.models import (
    CanonicalDecimalString,
    CatalogInstrumentV1,
    NanosecondString,
    RunState,
    Sha256Digest,
)

type EvidenceStatus = Literal["PENDING", "STAGING", "PARTIAL", "VERIFIED", "UNVERIFIED"]
type ArtifactPublicationStatus = Literal["STAGING", "PARTIAL", "VERIFIED"]
type EvidenceAuthority = Literal[
    "CONTROL_SQLITE_INPUT_MANIFEST_AND_CATALOG",
    "CONTROL_SQLITE_RUNNER_OUTCOME",
    "CONTROL_SQLITE_FINALIZATION_FAULT",
    "SEALED_METRICS_ARTIFACT",
]
type EvidenceCompleteness = Literal["COMPLETE", "UNAVAILABLE"]
type InputEvidenceUnavailableReason = Literal["INPUT_MANIFEST_NOT_COMMITTED"]
type PerformanceEvidenceUnavailableReason = Literal[
    "RUN_NOT_VERIFIED",
    "METRICS_ARTIFACT_NOT_SEALED",
    "LEGACY_METRICS_SERIES_ABSENT",
]


def _validate_unix_epoch_ns_string(value: str) -> str:
    validate_unix_epoch_ns(int(value), label="HTTP observation timestamp")
    return value


type UnixEpochNanosecondString = Annotated[
    StrictStr,
    Field(pattern=r"^[1-9][0-9]{18}$"),
    AfterValidator(_validate_unix_epoch_ns_string),
]


class ApiError(RuntimeError):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        run_id: str | None = None,
        retryable: bool = False,
        details: dict[str, object] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.run_id = run_id
        self.retryable = retryable
        self.details = details
        super().__init__(code)


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class HealthResponse(ApiModel):
    status: Literal["ok"]
    observed_at_ns: UnixEpochNanosecondString
    control_version: StrictStr
    schema_version: StrictInt
    engine_version: StrictStr
    engine_commit: StrictStr
    engine_commit_provenance: Literal["LOCKED_RELEASE_PIN"]
    python_version: StrictStr
    precision_mode: StrictStr
    input_manifest_engine_version: StrictStr
    input_manifest_engine_commit: StrictStr


class CapabilitiesResponse(ApiModel):
    execution_modes: tuple[Literal["BACKTEST"]]
    live_available: Literal[False]
    observed_at_ns: UnixEpochNanosecondString
    control_version: StrictStr
    schema_version: StrictInt
    engine_version: StrictStr
    engine_commit: StrictStr
    engine_commit_provenance: Literal["LOCKED_RELEASE_PIN"]
    python_version: StrictStr
    precision_mode: StrictStr
    input_manifest_engine_version: StrictStr
    input_manifest_engine_commit: StrictStr


class CatalogRevisionResponse(ApiModel):
    catalog_revision: StrictStr
    fixture_id: StrictStr
    status: Literal["PUBLISHED"]
    inventory_hash: StrictStr


class InstrumentPage(ApiModel):
    catalog_revision: StrictStr
    items: tuple[CatalogInstrumentV1, ...]
    next_cursor: StrictStr | None


class PreflightEvidenceFactResponse(ApiModel):
    name: StrictStr = Field(min_length=1)
    value: StrictStr = Field(min_length=1)


class PreflightCheckResponse(ApiModel):
    code: StrictStr
    passed: StrictBool
    checked_at_ns: UnixEpochNanosecondString
    explanation: StrictStr = Field(min_length=1)
    evidence: tuple[PreflightEvidenceFactResponse, ...] = Field(min_length=1)


class PreflightApiResponse(ApiModel):
    preflight_id: StrictStr
    run_id: StrictStr
    state: Literal["PREFLIGHT_BLOCKED", "PREFLIGHT_READY"]
    state_version: StrictInt
    canonical_request_hash: StrictStr
    input_manifest_hash: StrictStr | None
    catalog_revision: StrictStr | None
    expires_at: StrictStr
    checks: tuple[PreflightCheckResponse, ...]


class CreateBacktestRequest(ApiModel):
    preflight_id: StrictStr = Field(min_length=1)
    canonical_request_hash: StrictStr = Field(pattern=r"^[0-9a-f]{64}$")


class CancelRequest(ApiModel):
    reason: StrictStr = Field(min_length=1, max_length=256)


class RunCommandResponse(ApiModel):
    run_id: StrictStr
    state: RunState
    state_version: StrictInt
    last_visible_seq: StrictInt


class EvidenceProvenanceResponse(ApiModel):
    authority: EvidenceAuthority
    artifact_name: Literal["metrics_report"] | None
    evidence_id: Sha256Digest
    seal_digest: Sha256Digest | None

    @model_validator(mode="after")
    def require_authority_shape(self) -> Self:
        sealed = self.authority == "SEALED_METRICS_ARTIFACT"
        if sealed != (self.artifact_name == "metrics_report" and self.seal_digest is not None):
            raise ValueError("Evidence provenance fields do not match their authority.")
        if not sealed and (self.artifact_name is not None or self.seal_digest is not None):
            raise ValueError("SQLite evidence cannot claim artifact provenance.")
        return self


class RunInputEvidenceResponse(ApiModel):
    completeness: EvidenceCompleteness
    unavailable_reason: InputEvidenceUnavailableReason | None
    fixture_id: StrictStr | None
    fixture_label: Literal["LOCAL QA FIXTURE"] | None
    strategy_id: StrictStr | None
    strategy_version: StrictStr | None
    instrument_ids: tuple[StrictStr, ...]
    window_start_ns: NanosecondString | None
    window_end_ns: NanosecondString | None
    timezone: StrictStr | None
    provenance: EvidenceProvenanceResponse | None

    @model_validator(mode="after")
    def require_availability_shape(self) -> Self:
        optional_values = (
            self.fixture_id,
            self.fixture_label,
            self.strategy_id,
            self.strategy_version,
            self.window_start_ns,
            self.window_end_ns,
            self.timezone,
            self.provenance,
        )
        if self.completeness == "COMPLETE":
            if (
                self.unavailable_reason is not None
                or any(value is None for value in optional_values)
                or not self.instrument_ids
            ):
                raise ValueError("Complete input evidence is missing authority.")
        elif (
            self.unavailable_reason is None
            or any(value is not None for value in optional_values)
            or self.instrument_ids
        ):
            raise ValueError("Unavailable input evidence contains authoritative fields.")
        return self


class PerformancePointResponse(ApiModel):
    point_index: Annotated[StrictInt, Field(ge=0)]
    ts_event_ns: NanosecondString
    equity_amount: CanonicalDecimalString
    drawdown_pct: CanonicalDecimalString
    is_stale: Literal[False]
    stale_instruments: tuple[StrictStr, ...]
    stale_currencies: tuple[StrictStr, ...]
    unpriced_instruments: tuple[StrictStr, ...]

    @model_validator(mode="after")
    def require_clean_quality(self) -> Self:
        if self.stale_instruments or self.stale_currencies or self.unpriced_instruments:
            raise ValueError("Complete performance points must have clean native quality.")
        return self


class RunPerformanceEvidenceResponse(ApiModel):
    completeness: EvidenceCompleteness
    unavailable_reason: PerformanceEvidenceUnavailableReason | None
    series_schema: Literal["PortfolioEquitySeries.v1"] | None
    source: Literal["NAUTILUS_PORTFOLIO_SNAPSHOTS"] | None
    selection: Literal["SOLE_TOTAL_EQUITY"] | None
    calculation: Literal["RUNNING_PEAK_DRAWDOWN_PERCENT_V1"] | None
    timestamp_unit: Literal["UNIX_EPOCH_NS"]
    equity_unit: Literal["ACCOUNT_CURRENCY"]
    drawdown_unit: Literal["PERCENT"]
    account_id: StrictStr | None
    currency: StrictStr | None
    points: tuple[PerformancePointResponse, ...]
    provenance: EvidenceProvenanceResponse | None

    @model_validator(mode="after")
    def require_availability_shape(self) -> Self:
        optional_values = (
            self.series_schema,
            self.source,
            self.selection,
            self.calculation,
            self.account_id,
            self.currency,
            self.provenance,
        )
        if self.completeness == "COMPLETE":
            if (
                self.unavailable_reason is not None
                or any(value is None for value in optional_values)
                or not self.points
            ):
                raise ValueError("Complete performance evidence is missing authority.")
        elif (
            self.unavailable_reason is None
            or any(value is not None for value in optional_values)
            or self.points
        ):
            raise ValueError("Unavailable performance evidence contains authoritative fields.")
        return self


class ProcessExitEvidenceResponse(ApiModel):
    classification: SupervisorClassification
    supervisor_failure_code: SupervisorFailureCode | None
    exit_code: StrictInt | None
    signal: StrictInt | None
    ended_at_ns: NanosecondString
    duration_ns: NanosecondString
    final_cancel_phase: CancelPhase
    stderr_sha256: Sha256Digest
    stderr_truncated: StrictBool
    provenance: EvidenceProvenanceResponse


class RunnerFailureEvidence(ApiModel):
    source: Literal["RUNNER"]
    code: Literal["RUNNER_EXECUTION_FAILED", "REPORT_EXPORT_FAILED", "PROTOCOL_FAILED"]
    message: StrictStr
    provenance: EvidenceProvenanceResponse


class SupervisorFailureEvidence(ApiModel):
    source: Literal["SUPERVISOR"]
    code: SupervisorFailureCode
    provenance: EvidenceProvenanceResponse


class FinalizationFailureEvidence(ApiModel):
    source: Literal["FINALIZER"]
    category: FinalizationFailureCategory
    stage: FinalizationStage
    attempt_count: Literal[3]
    observed_at_ns: NanosecondString
    outcome_hash: Sha256Digest
    initial_event_digest: Sha256Digest
    provenance: EvidenceProvenanceResponse


type RunFailureEvidence = Annotated[
    RunnerFailureEvidence | SupervisorFailureEvidence | FinalizationFailureEvidence,
    Field(discriminator="source"),
]


class RunEvidenceResponse(ApiModel):
    input: RunInputEvidenceResponse
    performance: RunPerformanceEvidenceResponse
    process_exit: ProcessExitEvidenceResponse | None
    failure: RunFailureEvidence | None


class RunResponse(RunCommandResponse):
    evidence_status: EvidenceStatus
    created_at_ns: StrictStr
    input_manifest_hash: StrictStr | None
    catalog_revision: StrictStr | None
    control_version: StrictStr
    schema_version: StrictInt
    engine_version: StrictStr
    engine_commit: StrictStr
    engine_commit_provenance: Literal["LOCKED_RELEASE_PIN"]
    python_version: StrictStr
    precision_mode: StrictStr
    input_manifest_engine_version: StrictStr | None
    input_manifest_engine_commit: StrictStr | None
    input_manifest_python_version: StrictStr | None
    input_manifest_precision_mode: StrictStr | None
    evidence: RunEvidenceResponse


class EventResponse(ApiModel):
    event_id: StrictStr
    run_id: StrictStr
    seq: StrictInt
    source_seq: StrictInt
    source: Literal["control-api", "runner"]
    type: StrictStr
    ts_event_ns: StrictStr
    ts_ingest_ns: StrictStr
    schema_version: StrictInt
    payload: dict[str, object]


class EventPage(ApiModel):
    run_id: StrictStr
    items: tuple[EventResponse, ...]
    next_after_seq: StrictInt


class PublicArtifactName(StrEnum):
    REQUEST = "request"
    PREFLIGHT = "preflight"
    INPUT_MANIFEST = "input_manifest"
    RUN_RECORD = "run_record"
    EVENTS = "events"
    AUDIT = "audit"
    RUNNER_EXIT = "runner_exit"
    STDERR = "stderr"
    ORDERS_REPORT = "orders_report"
    FILLS_REPORT = "fills_report"
    POSITIONS_REPORT = "positions_report"
    ACCOUNT_REPORT = "account_report"
    METRICS_REPORT = "metrics_report"
    SEAL = "seal"


class ArtifactEntry(ApiModel):
    name: PublicArtifactName
    downloadable: bool


class ArtifactIndex(ApiModel):
    run_id: StrictStr
    evidence_status: EvidenceStatus
    publication_status: ArtifactPublicationStatus | None
    items: tuple[ArtifactEntry, ...]
