"""Closed v2 HTTP projections; metadata never promises fresh file verification."""

from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from stark_trading_os.control.historical_configuration_models import (
    HistoricalStrategyConfigurationVersionV2,
    HistoricalStrategyDraftV2,
)
from stark_trading_os.control.historical_preflight import HistoricalPreflightReceiptV2
from stark_trading_os.control.process_identity import CancelPhase, SupervisorClassification
from stark_trading_os.control.strategy_models import (
    PositiveRevision,
    StrategyConfigurationId,
    StrategyDraftId,
    UnixEpochNanosecondString,
)
from stark_trading_os.domain.historical_input import (
    Digest,
    HistoricalDatasetBindingV2,
    SmaConfigurationInputV2,
)
from stark_trading_os.domain.models import CanonicalDecimalString, NanosecondString, RunState

type HistoricalRunId = Annotated[StrictStr, Field(pattern=r"^bt_[0-9a-f]{32}$")]
type HistoricalPreflightId = Annotated[StrictStr, Field(pattern=r"^pfh_[0-9a-f]{32}$")]
type CatalogGridValue = Annotated[
    StrictStr, Field(max_length=31, pattern=r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,16})?$")
]
type ReportValidation = Literal[
    "COMPLETE_PASSED", "COMPLETE_FAILED", "DIAGNOSTIC_PREFIX", "NO_REPORT"
]


class _HistoricalApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class HistoricalCapabilitiesResponse(_HistoricalApiModel):
    enabled: StrictBool
    environment: Literal["BACKTEST"] = "BACKTEST"
    contract_kind: Literal["HISTORICAL_SMA_V2"] = "HISTORICAL_SMA_V2"
    live_available: Literal[False] = False


class HistoricalStrategyDefinition(_HistoricalApiModel):
    strategy_ref: Literal["sma-cross-long-flat@v1"] = "sma-cross-long-flat@v1"
    name: Literal["SMA 多头/空仓工程基准"] = "SMA 多头/空仓工程基准"
    purpose: Literal["ENGINEERING_BASELINE"] = "ENGINEERING_BASELINE"
    environment: Literal["BACKTEST"] = "BACKTEST"
    contract_kind: Literal["HISTORICAL_SMA_V2"] = "HISTORICAL_SMA_V2"
    data_selection: Literal["ENTIRE_PUBLISHED_CATALOG"] = "ENTIRE_PUBLISHED_CATALOG"
    availability: Literal["HTTP_WORKFLOW_IMPLEMENTED"] = "HTTP_WORKFLOW_IMPLEMENTED"
    admission: Literal["PREFLIGHT_REQUIRED"] = "PREFLIGHT_REQUIRED"
    live_available: Literal[False] = False


class HistoricalStrategyDefinitionList(_HistoricalApiModel):
    items: tuple[HistoricalStrategyDefinition, ...]


class HistoricalCatalogResponse(_HistoricalApiModel):
    dataset: HistoricalDatasetBindingV2
    source_label: Annotated[StrictStr, Field(min_length=1, max_length=200)]
    source_market: Annotated[StrictStr, Field(min_length=1, max_length=64)]
    source_symbol: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    price_precision: Annotated[StrictInt, Field(ge=0, le=16)]
    size_precision: Annotated[StrictInt, Field(ge=0, le=16)]
    price_increment: CatalogGridValue
    size_increment: CatalogGridValue
    minimum_quantity: CatalogGridValue
    published_at_ns: Annotated[StrictStr, Field(max_length=19, pattern=r"^(0|[1-9][0-9]*)$")]
    authority: Literal["CONTROL_SQLITE"] = "CONTROL_SQLITE"
    filesystem_verification: Literal["NOT_CHECKED"] = "NOT_CHECKED"
    current_eligibility: Literal["NOT_RECHECKED"] = "NOT_RECHECKED"

    @field_validator("price_increment", "size_increment", "minimum_quantity")
    @classmethod
    def positive_grid(cls, value: str) -> str:
        if Decimal(value) <= 0:
            raise ValueError("Catalog grid values must be positive.")
        return value


class HistoricalCatalogPage(_HistoricalApiModel):
    items: tuple[HistoricalCatalogResponse, ...]
    next_cursor: Digest | None


class HistoricalUpdateDraftRequest(SmaConfigurationInputV2):
    expected_revision: PositiveRevision


class HistoricalPreflightRequest(_HistoricalApiModel):
    configuration_id: StrategyConfigurationId


class HistoricalStartRequest(_HistoricalApiModel):
    preflight_id: HistoricalPreflightId
    request_sha256: Digest


class HistoricalConfigurationPage(_HistoricalApiModel):
    items: tuple[HistoricalStrategyConfigurationVersionV2, ...]
    next_cursor: StrategyConfigurationId | None


class HistoricalDraftPage(_HistoricalApiModel):
    items: tuple[HistoricalStrategyDraftV2, ...]
    next_cursor: StrategyDraftId | None


class HistoricalPreflightStatus(_HistoricalApiModel):
    receipt: HistoricalPreflightReceiptV2
    consumed_at_ns: UnixEpochNanosecondString | None
    observed_at_ns: UnixEpochNanosecondString
    time_status: Literal["BEFORE_CHECK", "IN_WINDOW", "EXPIRED"]
    current_eligibility: Literal["NOT_RECHECKED"] = "NOT_RECHECKED"

    @model_validator(mode="after")
    def truthful_time(self) -> Self:
        checked, expires = int(self.receipt.checked_at_ns), int(self.receipt.expires_at_ns)
        now = int(self.observed_at_ns)
        expected = "BEFORE_CHECK" if now < checked else "IN_WINDOW" if now < expires else "EXPIRED"
        if checked >= expires or self.time_status != expected:
            raise ValueError("Historical receipt time observation is inconsistent.")
        if self.consumed_at_ns is not None and not checked <= int(self.consumed_at_ns) < expires:
            raise ValueError("Historical receipt consumption is outside its original window.")
        return self


class HistoricalStartResponse(_HistoricalApiModel):
    run_id: HistoricalRunId
    state: Literal["QUEUED"]
    state_version: Annotated[StrictInt, Field(ge=2, le=2)]
    last_visible_seq: Annotated[StrictInt, Field(ge=2, le=2)]
    input_manifest_hash: Digest


class HistoricalProcessStatus(_HistoricalApiModel):
    claim: Literal["UNCLAIMED", "CLAIMED_UNBOUND", "CLAIMED_BOUND"]
    cancel_phase: CancelPhase | None


class HistoricalOutcomeStatus(_HistoricalApiModel):
    classification: SupervisorClassification
    outcome_sha256: Digest


class HistoricalPublicationStatus(_HistoricalApiModel):
    state: Literal["NOT_PREPARED", "PREPARED", "PUBLISHED"]
    evidence_anchor_sha256: Digest | None
    seal_sha256: Digest | None
    report_validation: ReportValidation | None
    authority: Literal["CONTROL_SQLITE"] = "CONTROL_SQLITE"
    filesystem_verification: Literal["NOT_CHECKED"] = "NOT_CHECKED"

    @model_validator(mode="after")
    def truthful_shape(self) -> Self:
        if self.state == "NOT_PREPARED":
            valid = all(
                v is None
                for v in (self.evidence_anchor_sha256, self.seal_sha256, self.report_validation)
            )
        else:
            valid = self.evidence_anchor_sha256 is not None and self.report_validation is not None
            valid = valid and ((self.seal_sha256 is not None) == (self.state == "PUBLISHED"))
        if not valid:
            raise ValueError("Historical publication metadata is inconsistent.")
        return self


class HistoricalRunResponse(_HistoricalApiModel):
    run_id: HistoricalRunId
    environment: Literal["BACKTEST"] = "BACKTEST"
    contract_kind: Literal["HISTORICAL_SMA_V2"] = "HISTORICAL_SMA_V2"
    state: RunState
    state_version: PositiveRevision
    last_visible_seq: Annotated[StrictInt, Field(ge=1)]
    created_at_ns: UnixEpochNanosecondString
    observed_at_ns: UnixEpochNanosecondString
    preflight_id: HistoricalPreflightId
    configuration_id: StrategyConfigurationId
    configuration_version: PositiveRevision
    configuration_content_sha256: Digest
    input_manifest_hash: Digest
    catalog_revision: Digest
    catalog_publication_sha256: Digest
    cost_sha256: Digest
    process: HistoricalProcessStatus
    outcome: HistoricalOutcomeStatus | None
    publication: HistoricalPublicationStatus


class HistoricalArtifactName(StrEnum):
    INPUT_MANIFEST = "input_manifest"
    CATALOG_MANIFEST = "catalog_manifest"
    RUNNER_EXIT = "runner_exit"
    STDERR = "stderr"
    COMPONENT_SNAPSHOT = "component_snapshot"
    HISTORICAL_REPORT = "historical_report"
    EVIDENCE_ANCHOR = "evidence_anchor"
    EVENTS = "events"
    AUDIT = "audit"
    RUN = "run"
    SEAL = "seal"


class HistoricalArtifactEntry(_HistoricalApiModel):
    name: HistoricalArtifactName
    downloadable: StrictBool
    size_bytes: Annotated[StrictInt, Field(ge=0)] | None
    sha256: Digest | None

    @model_validator(mode="after")
    def truthful_availability(self) -> Self:
        if self.downloadable:
            valid = self.size_bytes is not None and self.sha256 is not None
        else:
            valid = self.size_bytes is None and self.sha256 is None
        if not valid:
            raise ValueError("Historical artifact availability is inconsistent.")
        return self


class HistoricalArtifactIndex(_HistoricalApiModel):
    run_id: HistoricalRunId
    state: RunState
    report_validation: ReportValidation
    evidence_anchor_sha256: Digest
    seal_sha256: Digest
    verification: Literal["FRESH_FULL_ROOT_AND_CONTROL_ANCHORS"] = (
        "FRESH_FULL_ROOT_AND_CONTROL_ANCHORS"
    )
    observed_at_ns: UnixEpochNanosecondString
    items: tuple[HistoricalArtifactEntry, ...]


class HistoricalBalanceSummary(_HistoricalApiModel):
    total: CanonicalDecimalString
    free: CanonicalDecimalString
    locked: CanonicalDecimalString


class HistoricalFinalCashSummary(_HistoricalApiModel):
    phase: Literal["FINAL_POST_RUN"]
    sequence: Annotated[StrictInt, Field(ge=1)]
    clock_ns: NanosecondString
    bar_ts_event: NanosecondString
    balances: dict[StrictStr, HistoricalBalanceSummary]
    realized_pnls: dict[StrictStr, CanonicalDecimalString]
    unrealized_pnls: dict[StrictStr, CanonicalDecimalString]
    total_pnls: dict[StrictStr, CanonicalDecimalString]
    mark_values: dict[StrictStr, CanonicalDecimalString]
    total_equity: dict[StrictStr, CanonicalDecimalString]
    base_currency_equity: None
    is_stale: StrictBool
    stale_instruments: tuple[StrictStr, ...]
    stale_currencies: tuple[StrictStr, ...]
    unpriced_instruments: tuple[StrictStr, ...]
    position_count: Annotated[StrictInt, Field(ge=0)]
    pending_order_count: Annotated[StrictInt, Field(ge=0)]


class HistoricalTableCounts(_HistoricalApiModel):
    orders: Annotated[StrictInt, Field(ge=0)]
    fills: Annotated[StrictInt, Field(ge=0)]
    positions: Annotated[StrictInt, Field(ge=0)]
    account: Annotated[StrictInt, Field(ge=0)]


class HistoricalReportSummary(_HistoricalApiModel):
    run_id: HistoricalRunId
    environment: Literal["BACKTEST"] = "BACKTEST"
    contract_kind: Literal["HISTORICAL_SMA_V2"] = "HISTORICAL_SMA_V2"
    report_status: Literal["INTERNAL_REPORT_CHECK_PASSED", "INTERNAL_REPORT_CHECK_FAILED"]
    report_validation: Literal["COMPLETE_PASSED", "COMPLETE_FAILED"]
    report_sha256: Digest
    component_snapshot_sha256: Digest
    evidence_anchor_sha256: Digest
    seal_sha256: Digest
    input_manifest_sha256: Digest
    configuration_content_sha256: Digest
    catalog_revision: Digest
    cost_sha256: Digest
    account_id: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    observed_at_ns: UnixEpochNanosecondString
    verification: Literal["FRESH_FULL_ROOT_AND_CONTROL_ANCHORS"] = (
        "FRESH_FULL_ROOT_AND_CONTROL_ANCHORS"
    )
    consistency_failures: tuple[StrictStr, ...]
    table_counts: HistoricalTableCounts
    final_cash: HistoricalFinalCashSummary

    @model_validator(mode="after")
    def truthful_report_status(self) -> Self:
        passed = self.report_validation == "COMPLETE_PASSED"
        if (self.report_status == "INTERNAL_REPORT_CHECK_PASSED") != passed or (
            (not self.consistency_failures) != passed
        ):
            raise ValueError("Historical report summary status is inconsistent.")
        return self
