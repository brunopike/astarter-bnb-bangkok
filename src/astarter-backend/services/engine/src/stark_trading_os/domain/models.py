from __future__ import annotations

import re
from collections.abc import Collection, Iterator, Mapping, Sequence
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    PlainValidator,
    StrictBool,
    StrictInt,
    StrictStr,
    WithJsonSchema,
    model_validator,
)

type Environment = Literal["BACKTEST"]
_CANONICAL_DECIMAL_PATTERN_TEXT = (
    r"^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|"
    r"-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$"
)

type NanosecondString = Annotated[
    StrictStr,
    Field(
        pattern=r"^(0|[1-9][0-9]*)$",
        description="Non-negative integer nanoseconds encoded as a base-10 string.",
    ),
]
type CanonicalDecimalString = Annotated[
    StrictStr,
    Field(
        pattern=_CANONICAL_DECIMAL_PATTERN_TEXT,
        description="Canonical non-exponent decimal string with no leading or trailing zeros.",
    ),
]
type NonNegativeIntegerString = Annotated[
    StrictStr,
    Field(pattern=r"^(0|[1-9][0-9]*)$"),
]
type Sha256Digest = Annotated[
    StrictStr,
    Field(pattern=r"^[0-9a-f]{64}$", description="Lowercase SHA-256 digest."),
]
type RegistryReference = Annotated[
    StrictStr,
    Field(
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*@[a-z0-9]+(?:-[a-z0-9]+)*$",
        description="Closed registry identifier and version; never a path, URL, or module name.",
    ),
]
_CANONICAL_DECIMAL_PATTERN = re.compile(_CANONICAL_DECIMAL_PATTERN_TEXT)
_JSON_VALUE_SCHEMA: dict[str, object] = {
    "$dynamicAnchor": "json-value",
    "anyOf": [
        {"type": "null"},
        {"type": "boolean"},
        {"type": "integer"},
        {"type": "string"},
        {"type": "array", "items": {"$dynamicRef": "#json-value"}},
        {"type": "object", "additionalProperties": {"$dynamicRef": "#json-value"}},
    ],
}
_JSON_OBJECT_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": _JSON_VALUE_SCHEMA,
}


class FrozenJsonObject(Mapping[str, object]):
    """A recursively immutable JSON object that Pydantic can serialize as a normal object."""

    __slots__ = ("_items",)
    _items: Mapping[str, object]

    def __init__(self, value: dict[str, object]) -> None:
        object.__setattr__(
            self,
            "_items",
            MappingProxyType({key: _freeze_json_value(item) for key, item in value.items()}),
        )

    def __setattr__(self, name: str, value: object) -> None:
        raise TypeError("Domain contract collections are immutable.")

    def __getitem__(self, key: str) -> object:
        return self._items[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)


class FrozenJsonArray(Collection[object]):
    """A recursively immutable JSON array that serializes as a standard JSON array."""

    __slots__ = ("_items",)
    _items: tuple[object, ...]

    def __init__(self, value: list[object]) -> None:
        object.__setattr__(self, "_items", tuple(_freeze_json_value(item) for item in value))

    def __setattr__(self, name: str, value: object) -> None:
        raise TypeError("Domain contract collections are immutable.")

    def __getitem__(self, index: int) -> object:
        return self._items[index]

    def __iter__(self) -> Iterator[object]:
        return iter(self._items)

    def __contains__(self, value: object) -> bool:
        return value in self._items

    def __len__(self) -> int:
        return len(self._items)


class FrozenDecimalMap(Mapping[str, str]):
    """An immutable mapping for canonical decimal values."""

    __slots__ = ("_items",)
    _items: Mapping[str, str]

    def __init__(self, value: dict[str, str]) -> None:
        object.__setattr__(self, "_items", MappingProxyType(dict(value)))

    def __setattr__(self, name: str, value: object) -> None:
        raise TypeError("Domain contract collections are immutable.")

    def __getitem__(self, key: str) -> str:
        return self._items[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)


def _freeze_json_value(value: object) -> object:
    if type(value) is FrozenJsonObject or type(value) is FrozenJsonArray:
        return value
    if value is None or isinstance(value, str | int | bool):
        return value
    if isinstance(value, float):
        raise ValueError("Binary floating-point values are not permitted in JSON slots.")
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings.")
        return FrozenJsonObject(value)
    if isinstance(value, list):
        return FrozenJsonArray(value)
    raise ValueError("JSON slots accept only JSON-compatible values.")


def _freeze_json_object(value: object) -> FrozenJsonObject:
    if type(value) is FrozenJsonObject:
        return value
    if not isinstance(value, dict):
        raise ValueError("JSON slots must be objects.")
    return FrozenJsonObject(value)


def _freeze_decimal_map(value: object) -> FrozenDecimalMap:
    if type(value) is FrozenDecimalMap:
        return value
    if not isinstance(value, dict):
        raise ValueError("Economic values must be an object.")
    decimal_values: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise ValueError("Economic-value keys must be strings.")
        if not isinstance(item, str) or _CANONICAL_DECIMAL_PATTERN.fullmatch(item) is None:
            raise ValueError("Economic values must be canonical decimal strings.")
        decimal_values[key] = item
    return FrozenDecimalMap(decimal_values)


def _to_standard_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _to_standard_json(item) for key, item in value.items()}
    if isinstance(value, FrozenJsonArray) or (
        isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray)
    ):
        return [_to_standard_json(item) for item in value]
    return value


type JsonObject = Annotated[
    FrozenJsonObject,
    PlainValidator(_freeze_json_object),
    PlainSerializer(_to_standard_json, return_type=dict[str, object]),
    WithJsonSchema(_JSON_OBJECT_SCHEMA),
]
type DecimalValues = Annotated[
    FrozenDecimalMap,
    PlainValidator(_freeze_decimal_map),
    PlainSerializer(_to_standard_json, return_type=dict[str, str]),
    WithJsonSchema(
        {
            "type": "object",
            "additionalProperties": {
                "type": "string",
                "pattern": _CANONICAL_DECIMAL_PATTERN_TEXT,
            },
        }
    ),
]


class DomainModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=False, serialize_by_alias=True
    )


class RunState(StrEnum):
    DRAFT = "DRAFT"
    PREFLIGHT_BLOCKED = "PREFLIGHT_BLOCKED"
    PREFLIGHT_READY = "PREFLIGHT_READY"
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    CANCEL_REQUESTED = "CANCEL_REQUESTED"
    CANCEL_PENDING = "CANCEL_PENDING"
    FINALIZING = "FINALIZING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_STATES = frozenset({RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED})


class TimeWindowV1(DomainModel):
    start_ns: NanosecondString
    end_ns: NanosecondString


class GapV1(DomainModel):
    start_ns: NanosecondString
    end_ns: NanosecondString
    instrument_id: StrictStr

    @model_validator(mode="after")
    def require_nonempty_interval(self) -> GapV1:
        if (len(self.start_ns), self.start_ns) >= (len(self.end_ns), self.end_ns):
            raise ValueError("Gap intervals must be non-empty half-open ranges.")
        return self


class DuplicateV1(DomainModel):
    ts_event_ns: NanosecondString
    source_seq: Annotated[StrictInt, Field(ge=0)]
    record_hash: Sha256Digest


class InformationSetPolicyV1(DomainModel):
    schema_: Literal["InformationSetPolicy.v1"] = Field(alias="schema")
    availability_field: Literal["ts_available_ns"]
    nautilus_timestamp_field: Literal["ts_init"]
    visibility_rule: Literal["AVAILABLE_AT_OR_BEFORE_DECISION"]
    tie_breakers: tuple[Literal["ts_available_ns"], Literal["source_seq"], Literal["record_hash"]]
    bar_rule: Literal["CLOSED_AND_AVAILABLE"]
    source_revision_rule: Literal["SINGLE_IMMUTABLE_REVISION"]


class EvaluationProtocolV1(DomainModel):
    schema_: Literal["EvaluationProtocol.v1"] = Field(alias="schema")
    mode: Literal["fixture_only", "explicit"]
    train: TimeWindowV1 | None
    tune: TimeWindowV1 | None
    out_of_sample: TimeWindowV1 | None
    purge_ns: NanosecondString
    embargo_ns: NanosecondString

    @model_validator(mode="after")
    def require_mode_shape(self) -> EvaluationProtocolV1:
        windows = (self.train, self.tune, self.out_of_sample)
        if self.mode == "fixture_only":
            if any(window is not None for window in windows):
                raise ValueError("fixture_only evaluation cannot declare windows.")
            if self.purge_ns != "0" or self.embargo_ns != "0":
                raise ValueError("fixture_only evaluation requires zero purge and embargo.")
        elif any(window is None for window in windows):
            raise ValueError("explicit evaluation requires train, tune, and out_of_sample.")
        return self


class DraftVenueAccountModelV1(DomainModel):
    """Strict request carrier; native support is decided by preflight."""

    venue_id: StrictStr
    oms_type: StrictStr
    account_type: StrictStr
    book_type: StrictStr
    routing: StrictBool
    use_random_ids: StrictBool
    use_position_ids: StrictBool
    allow_cash_borrowing: StrictBool
    starting_balance: CanonicalDecimalString
    currency: StrictStr


class VenueAccountModelV1(DraftVenueAccountModelV1):
    """Exact native profile persisted in a READY input manifest."""

    venue_id: Literal["SIM"]
    oms_type: Literal["HEDGING"]
    account_type: Literal["MARGIN"]
    book_type: Literal["L1_MBP"]
    currency: Literal["USDT"]

    @model_validator(mode="after")
    def require_v01_native_profile(self) -> VenueAccountModelV1:
        if (
            self.routing is not False
            or self.use_random_ids is not False
            or self.use_position_ids is not True
            or self.allow_cash_borrowing is not False
            or self.starting_balance != "1000000"
        ):
            raise ValueError(
                "VenueAccountModel.v1 must match the pinned native simulation profile."
            )
        return self


class DeterminismProbeConfigV1(DomainModel):
    entry_limit_price: Literal["100"]
    entry_quantity: Literal["15"]
    metric_round_trip_quantity: Literal["1"]
    metric_round_trips: Literal[5]
    risk_probe_quantity: Literal["20"]
    venue_rejection_quantity: Literal["1"]


class ProbeRiskPolicyV1(DomainModel):
    max_notional: Literal["1600"]


class InstrumentInputV1(DomainModel):
    instrument_id: StrictStr
    price_increment: CanonicalDecimalString
    quantity_increment: CanonicalDecimalString


class DraftFeePolicyV1(DomainModel):
    model: StrictStr
    rate_source: StrictStr
    rate_unit: StrictStr
    charge_currency: StrictStr
    minimum_fee: CanonicalDecimalString
    application: StrictStr
    decimal_precision: Annotated[StrictInt, Field(ge=0)]
    rounding_mode: StrictStr

    @model_validator(mode="after")
    def require_non_negative_minimum_fee(self) -> DraftFeePolicyV1:
        if Decimal(self.minimum_fee) < 0:
            raise ValueError("minimum_fee cannot be negative.")
        return self


class DraftSpreadPolicyV1(DomainModel):
    authority: StrictStr


class DraftSlippagePolicyV1(DomainModel):
    model: StrictStr
    prob_fill_on_limit: CanonicalDecimalString
    prob_slippage: CanonicalDecimalString
    random_seed_source: StrictStr
    probabilistic_slippage: StrictStr
    depth_price_impact: StrictStr
    maximum_book_walk_ticks: NonNegativeIntegerString

    @model_validator(mode="after")
    def require_valid_probabilities_and_book_walk(self) -> DraftSlippagePolicyV1:
        for name, value in (
            ("prob_fill_on_limit", self.prob_fill_on_limit),
            ("prob_slippage", self.prob_slippage),
        ):
            probability = Decimal(value)
            if not 0 <= probability <= 1:
                raise ValueError(f"{name} must be between zero and one.")
        if Decimal(self.maximum_book_walk_ticks) < 0:
            raise ValueError("maximum_book_walk_ticks cannot be negative.")
        return self


class DraftLatencyPolicyV1(DomainModel):
    model: StrictStr
    decision_to_submit_ns: NanosecondString
    submit_to_venue_ns: NanosecondString
    base_latency_ns: NanosecondString
    insert_latency_ns: NanosecondString
    update_latency_ns: NanosecondString
    cancel_latency_ns: NanosecondString


class DraftLiquidityPolicyV1(DomainModel):
    available_size_source: StrictStr
    queue_assumption: StrictStr
    allocation_order: StrictStr
    partial_fill_schedule: StrictStr
    price_selection: StrictStr
    allow_partial_fills: StrictBool
    liquidity_consumption: StrictBool

class DraftCancelPolicyV1(DomainModel):
    acknowledgment_rule: StrictStr
    remaining_quantity_disposition: StrictStr
    time_in_force: StrictStr


class DraftCostFillModelV1(DomainModel):
    """Structurally valid operator draft; omitted semantics are preflight failures."""

    schema_: Literal["CostFillModel.v1"] = Field(alias="schema")
    fee: DraftFeePolicyV1 | None = None
    spread: DraftSpreadPolicyV1 | None = None
    slippage: DraftSlippagePolicyV1 | None = None
    latency: DraftLatencyPolicyV1 | None = None
    liquidity: DraftLiquidityPolicyV1 | None = None
    cancel: DraftCancelPolicyV1 | None = None


class FeePolicyV1(DraftFeePolicyV1):
    model: Literal["MakerTakerFeeModel"]
    rate_source: Literal["INSTRUMENT_MAKER_TAKER"]
    rate_unit: Literal["NOTIONAL_DECIMAL_FRACTION"]
    charge_currency: Literal["INSTRUMENT_QUOTE_CURRENCY"]
    minimum_fee: Literal["0"]
    application: Literal["PER_FILL"]
    decimal_precision: Literal[8]
    rounding_mode: Literal["MIDPOINT_NEAREST_EVEN"]


class SpreadPolicyV1(DraftSpreadPolicyV1):
    authority: Literal["FIXTURE_BID_ASK"]


class SlippagePolicyV1(DraftSlippagePolicyV1):
    model: Literal["DefaultFillModel"]
    prob_fill_on_limit: Literal["1"]
    prob_slippage: Literal["0"]
    random_seed_source: Literal["INPUT_MANIFEST_REPLAY_SEED"]
    probabilistic_slippage: Literal["DISABLED"]
    depth_price_impact: Literal["DISABLED"]
    maximum_book_walk_ticks: Literal["0"]


class LatencyPolicyV1(DraftLatencyPolicyV1):
    model: Literal["StaticLatencyModel"]
    decision_to_submit_ns: Literal["0"]
    submit_to_venue_ns: Literal["0"]
    base_latency_ns: Literal["0"]
    insert_latency_ns: Literal["0"]
    update_latency_ns: Literal["0"]
    cancel_latency_ns: Literal["0"]


class LiquidityPolicyV1(DraftLiquidityPolicyV1):
    available_size_source: Literal["RECORDED_QUOTE_TICK_BID_ASK_SIZE"]
    queue_assumption: Literal["NOT_MODELED_AT_L1"]
    allocation_order: Literal["SINGLE_ORDER_NO_ALLOCATION_COMPETITION"]
    partial_fill_schedule: Literal["ON_RECORDED_QUOTE"]
    price_selection: Literal["NATIVE_L1_BID_ASK_CROSS"]
    allow_partial_fills: StrictBool
    liquidity_consumption: StrictBool

    @model_validator(mode="after")
    def require_recorded_l1_flags(self) -> LiquidityPolicyV1:
        if self.allow_partial_fills is not True or self.liquidity_consumption is not True:
            raise ValueError(
                "The recorded L1 profile requires partial fills with liquidity consumption."
            )
        return self


class CancelPolicyV1(DraftCancelPolicyV1):
    acknowledgment_rule: Literal["NATIVE"]
    remaining_quantity_disposition: Literal["CANCEL_OPEN_REMAINDER"]
    time_in_force: Literal["GTC"]


class CostFillModelV1(DomainModel):
    schema_: Literal["CostFillModel.v1"] = Field(alias="schema")
    fee: FeePolicyV1
    spread: SpreadPolicyV1
    slippage: SlippagePolicyV1
    latency: LatencyPolicyV1
    liquidity: LiquidityPolicyV1
    cancel: CancelPolicyV1


class BacktestDraftRequest(DomainModel):
    environment: Environment
    strategy_ref: RegistryReference
    catalog_revision: Sha256Digest
    window: TimeWindowV1
    information_set_policy: InformationSetPolicyV1
    evaluation_protocol: EvaluationProtocolV1
    venue_account_model: DraftVenueAccountModelV1 | None = None
    cost_fill_model: DraftCostFillModelV1
    risk_policy_ref: RegistryReference | None = None
    replay_seed: Annotated[StrictInt, Field(ge=0, le=(2**64) - 1)]

    @model_validator(mode="after")
    def require_nonempty_top_level_window(self) -> BacktestDraftRequest:
        if not _nanosecond_less(self.window.start_ns, self.window.end_ns):
            raise ValueError("Backtest top-level window must be a non-empty half-open range.")
        return self


class InputManifestV1(DomainModel):
    schema_: Literal["InputManifest.v1"] = Field(alias="schema")
    environment: Environment
    strategy_id: StrictStr
    strategy_version: StrictStr
    canonical_config: JsonObject
    config_hash: Sha256Digest
    engine_package_version: StrictStr
    engine_tag_commit: StrictStr
    python_version: StrictStr
    precision_mode: StrictStr
    fixture_id: StrictStr
    catalog_revision: Sha256Digest
    source_checksum: Sha256Digest
    catalog_checksum: Sha256Digest
    instruments: tuple[InstrumentInputV1, ...] = Field(
        description="Stable semantic order: sorted lexicographically by instrument_id."
    )
    data_types: tuple[StrictStr, ...] = Field(
        description="Stable semantic order: sorted lexicographically by data-type identifier."
    )
    window: TimeWindowV1
    timezone: StrictStr
    gaps: tuple[GapV1, ...] = Field(
        description="Stable semantic order: sorted by start_ns, end_ns, then instrument_id."
    )
    duplicates: tuple[DuplicateV1, ...] = Field(
        description="Stable semantic order: sorted by ts_event_ns, source_seq, then record_hash."
    )
    ordering_result: Literal["PASS"]
    information_set_policy: InformationSetPolicyV1
    evaluation_protocol: EvaluationProtocolV1
    venue_account_model: VenueAccountModelV1
    cost_fill_model: CostFillModelV1
    risk_policy_id: StrictStr
    risk_policy_version: StrictStr
    canonical_risk_policy: JsonObject
    risk_policy_hash: Sha256Digest
    replay_seed: Annotated[StrictInt, Field(ge=0, le=(2**64) - 1)]

    @model_validator(mode="after")
    def require_nonempty_top_level_window(self) -> InputManifestV1:
        if not _nanosecond_less(self.window.start_ns, self.window.end_ns):
            raise ValueError("Manifest top-level window must be a non-empty half-open range.")
        return self


def _nanosecond_less(left: str, right: str) -> bool:
    return (len(left), left) < (len(right), right)


class CatalogFileV1(DomainModel):
    relative_path: StrictStr
    size_bytes: Annotated[StrictInt, Field(ge=0)]
    sha256: Sha256Digest


class CatalogFileSetV1(DomainModel):
    schema_: Literal["CatalogFileSet.v1"] = Field(alias="schema")
    catalog_files: tuple[CatalogFileV1, ...]


class CatalogInstrumentV1(DomainModel):
    instrument_id: StrictStr
    raw_symbol: StrictStr
    venue: StrictStr
    base_currency: StrictStr
    quote_currency: StrictStr
    price_precision: Annotated[StrictInt, Field(ge=0)]
    size_precision: Annotated[StrictInt, Field(ge=0)]
    price_increment: CanonicalDecimalString
    size_increment: CanonicalDecimalString
    minimum_quantity: CanonicalDecimalString
    margin_init: CanonicalDecimalString
    margin_maint: CanonicalDecimalString
    maker_fee: CanonicalDecimalString
    taker_fee: CanonicalDecimalString
    ts_event_ns: NanosecondString
    ts_available_ns: NanosecondString


class CatalogSourceRecordV1(DomainModel):
    instrument_id: StrictStr
    bid_price: StrictStr
    ask_price: StrictStr
    bid_size: StrictStr
    ask_size: StrictStr
    ts_event_ns: NanosecondString
    ts_available_ns: NanosecondString
    source_seq: Annotated[StrictInt, Field(ge=0)]
    source_revision: StrictStr
    record_hash: Sha256Digest


class CatalogReadbackV1(DomainModel):
    instrument: CatalogInstrumentV1
    quote_count: Annotated[StrictInt, Field(ge=0)]
    first_ts_init: NanosecondString
    last_ts_init: NanosecondString
    data_types: tuple[Literal["instruments"], Literal["quotes"]]


class CatalogMappingV1(DomainModel):
    schema_: Literal["CatalogMapping.v1"] = Field(alias="schema")
    event_timestamp: Literal["ts_event_ns -> QuoteTick.ts_event"]
    availability_timestamp: Literal["ts_available_ns -> QuoteTick.ts_init"]
    source_identity: Literal["source_seq/source_revision/record_hash -> catalog-manifest.json"]


class CatalogNativeFingerprintV1(DomainModel):
    schema_: Literal["CatalogNativeFingerprint.v1"] = Field(alias="schema")
    installed_nautilus_version: Literal["2.0.0rc3"]
    python_version: StrictStr
    platform_system: StrictStr
    platform_machine: StrictStr
    native_extension_sha256: Sha256Digest
    writer_class: Literal["nautilus_trader.persistence.ParquetDataCatalog"]
    writer_options: Literal[
        "batch_size=null;compression=null;max_row_group_size=null;storage_options=null"
    ]


class CatalogInventoryV1(DomainModel):
    schema_: Literal["CatalogInventory.v1"] = Field(alias="schema")
    fixture_id: StrictStr
    label: Literal["LOCAL QA FIXTURE"]
    source_revision: StrictStr
    timezone: Literal["UTC"]
    purpose: Literal["LOCAL_QA_ONLY"]
    source_checksum: Sha256Digest
    catalog_checksum: Sha256Digest
    catalog_files: tuple[CatalogFileV1, ...]
    instrument: CatalogInstrumentV1
    source_records: tuple[CatalogSourceRecordV1, ...]
    readback: CatalogReadbackV1
    mapping: CatalogMappingV1
    native_fingerprint: CatalogNativeFingerprintV1
    information_set_policy: InformationSetPolicyV1
    evaluation_protocol: EvaluationProtocolV1
    gaps: tuple[GapV1, ...]
    duplicates: tuple[DuplicateV1, ...]
    ordering_result: Literal["PASS"]


class CatalogManifestV1(DomainModel):
    schema_: Literal["CatalogManifest.v1"] = Field(alias="schema")
    fixture_id: StrictStr
    label: Literal["LOCAL QA FIXTURE"]
    source_checksum: Sha256Digest
    catalog_checksum: Sha256Digest
    inventory_hash: Sha256Digest
    inventory: CatalogInventoryV1


class CatalogValidatedAuditV1(DomainModel):
    schema_: Literal["CatalogValidatedAudit.v1"] = Field(alias="schema")
    action: Literal["catalog.validated"]
    fixture_id: StrictStr
    catalog_revision: Sha256Digest
    inventory_hash: Sha256Digest
    source_checksum: Sha256Digest
    catalog_checksum: Sha256Digest


class RunRecordV1(DomainModel):
    schema_: Literal["RunRecord.v1"] = Field(alias="schema")
    run_id: StrictStr
    preflight_id: StrictStr
    idempotency_scope: StrictStr
    idempotency_key: StrictStr
    state: RunState
    state_version: Annotated[StrictInt, Field(ge=0)]
    prepared_terminal_state: RunState | None = None
    prepared_terminal_state_version: Annotated[StrictInt, Field(ge=0)] | None = None
    created_at_ns: NanosecondString
    started_at_ns: NanosecondString | None = None
    completed_at_ns: NanosecondString | None = None
    duration_ns: NanosecondString | None = None
    runner_identity: JsonObject | None = None
    runner_exit: JsonObject | None = None
    materialized_event_seq: Annotated[StrictInt, Field(ge=0)] | None = None
    materialized_audit_seq: Annotated[StrictInt, Field(ge=0)] | None = None
    evidence_status: Literal["PENDING", "STAGING", "PARTIAL", "VERIFIED", "UNVERIFIED"] = "PENDING"


class EventEnvelopeV1(DomainModel):
    event_id: StrictStr
    run_id: StrictStr
    seq: Annotated[StrictInt, Field(ge=0)]
    source_seq: Annotated[StrictInt, Field(ge=0)]
    ts_event_ns: NanosecondString
    ts_ingest_ns: NanosecondString
    type: StrictStr
    source: Literal["control-api", "runner"]
    writer: Literal["control-api"]
    schema_version: Annotated[StrictInt, Field(ge=1)]
    payload: JsonObject


class ErrorResponse(DomainModel):
    code: StrictStr
    message: StrictStr
    run_id: StrictStr | None = None
    retryable: StrictBool
    evidence_id: StrictStr | None = None
    details: JsonObject | None = None
