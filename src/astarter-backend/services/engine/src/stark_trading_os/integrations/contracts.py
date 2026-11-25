"""Immutable research contracts, deliberately separate from execution authority."""

from __future__ import annotations

from typing import Annotated, Literal, Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

type Purpose = Literal["OFFLINE_FIXTURE", "EXTERNAL_OBSERVATION"]
type Status = Literal[
    "OK",
    "UNCONFIGURED",
    "UNSUPPORTED",
    "MISSING",
    "STALE",
    "INVALID_RESPONSE",
    "RATE_LIMITED",
    "TIMEOUT",
    "UNAVAILABLE",
    "UNAUTHORIZED",
    "BUDGET_EXCEEDED",
]
Identifier = Annotated[StrictStr, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")]
Timestamp = Annotated[StrictInt, Field(ge=0, le=253402300799999)]
DecimalText = Annotated[StrictStr, Field(pattern=r"^(0|[1-9][0-9]*)(\.[0-9]+)?$", max_length=128)]
SignedDecimalText = Annotated[
    StrictStr, Field(pattern=r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$", max_length=80)
]
TokenCount = Annotated[StrictInt, Field(ge=0, le=10**12)]
RoleId = Annotated[StrictStr, Field(pattern=r"^A(0[1-9]|1[0-8])$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, revalidate_instances="always")


class Instrument(Contract):
    venue: Identifier
    market_kind: Literal["SPOT", "PERP"]
    symbol: Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{2,32}$")]
    base_asset: Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{1,24}$")]
    quote_asset: Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{1,24}$")]

    @model_validator(mode="after")
    def identity(self) -> Self:
        if self.base_asset == self.quote_asset:
            raise ValueError("distinct asset units required")
        return self


class Provenance(Contract):
    provider_id: Identifier
    schema_version: Literal["SpotTicker.v1"] = "SpotTicker.v1"
    purpose: Purpose
    source_event_at_ms: Timestamp
    available_at_ms: Timestamp
    received_at_ms: Timestamp
    published_at_ms: Timestamp | None = None
    raw_sha256: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
    timestamp_semantics: Literal["STATISTICS_WINDOW_END"] = "STATISTICS_WINDOW_END"

    @model_validator(mode="after")
    def chronology(self) -> Self:
        if not self.source_event_at_ms <= self.received_at_ms <= self.available_at_ms:
            raise ValueError("invalid source/receipt/availability chronology")
        return self


class SpotTicker(Contract):
    instrument: Instrument
    last_price: DecimalText
    base_volume: DecimalText
    quote_volume: DecimalText
    window_open_at_ms: Timestamp
    window_close_at_ms: Timestamp
    price_change_pct: SignedDecimalText | None = None
    executable: Literal[False] = False


class DataResult(Contract):
    provider_id: Identifier = "binance-spot-ticker-v1"
    instrument: Instrument
    status: Status
    provenance: Provenance | None = None
    snapshot: SpotTicker | None = None
    retry_after_seconds: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def complete_snapshot(self) -> Self:
        if self.status in {"OK", "STALE"}:
            if self.snapshot is None or self.provenance is None:
                raise ValueError("successful data result requires snapshot and provenance")
            if (
                self.snapshot.instrument != self.instrument
                or self.provenance.provider_id != self.provider_id
                or self.snapshot.window_close_at_ms != self.provenance.source_event_at_ms
            ):
                raise ValueError("mixed snapshot identity or source time")
        elif self.snapshot is not None or self.provenance is not None:
            raise ValueError("failed data result cannot carry a usable snapshot")
        return self

    def freshness_at(
        self,
        now_ms: int,
        *,
        max_source_age_ms: int,
        max_receipt_age_ms: int,
    ) -> Status:
        """Evaluate both clocks again at consumption; never refresh source time on reuse."""
        if any(
            type(v) is not int or v < 0 for v in (now_ms, max_source_age_ms, max_receipt_age_ms)
        ):
            raise ValueError("nonnegative integer freshness policy required")
        if self.status not in {"OK", "STALE"} or self.provenance is None:
            return self.status
        p = self.provenance
        if now_ms < max(p.source_event_at_ms, p.received_at_ms, p.available_at_ms):
            return "INVALID_RESPONSE"
        if (
            now_ms - p.source_event_at_ms > max_source_age_ms
            or now_ms - p.received_at_ms > max_receipt_age_ms
        ):
            return "STALE"
        return "OK"


class Evidence(Contract):
    evidence_id: Identifier
    text: Annotated[StrictStr, Field(min_length=1, max_length=8000)] = Field(repr=False)
    available_at_ms: Timestamp
    valid_until_ms: Timestamp

    @model_validator(mode="after")
    def valid_range(self) -> Self:
        if self.valid_until_ms <= self.available_at_ms:
            raise ValueError("empty evidence validity interval")
        return self


class ResearchTask(Contract):
    task_id: Identifier
    role_id: RoleId
    profile_version: Identifier
    evidence: Annotated[tuple[Evidence, ...], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def unique_evidence(self) -> Self:
        ids = [e.evidence_id for e in self.evidence]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate evidence identity")
        return self


class ResearchOutput(Contract):
    stance: Literal["OBSERVE", "WAIT", "REVIEW"]
    summary: Annotated[StrictStr, Field(min_length=1, max_length=2000)] = Field(repr=False)
    evidence_ids: Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=8)]

    @model_validator(mode="after")
    def unique_references(self) -> Self:
        if len(self.evidence_ids) != len(set(self.evidence_ids)) or not self.summary.strip():
            raise ValueError("invalid research references or summary")
        return self


class Usage(Contract):
    status: Literal["MISSING", "REPORTED", "INVALID"] = "MISSING"
    input_tokens: TokenCount | None = None
    output_tokens: TokenCount | None = None
    total_tokens: TokenCount | None = None
    cached_input_tokens: TokenCount | None = None
    reasoning_tokens: TokenCount | None = None
    cost_credits: DecimalText | None = None

    @model_validator(mode="after")
    def consistent_totals(self) -> Self:
        if (
            self.input_tokens is not None
            and self.output_tokens is not None
            and self.total_tokens is not None
            and self.total_tokens != self.input_tokens + self.output_tokens
        ):
            raise ValueError("inconsistent token total")
        for subset, total in (
            (self.cached_input_tokens, self.input_tokens),
            (self.reasoning_tokens, self.output_tokens),
        ):
            if subset is not None and total is not None and subset > total:
                raise ValueError("invalid token subset")
        return self


class ModelResult(Contract):
    task_id: Identifier
    role_id: RoleId
    profile_version: Identifier
    requested_model: Identifier
    status: Status
    purpose: Purpose | None
    started_at_ms: Timestamp
    completed_at_ms: Timestamp
    output: ResearchOutput | None = None
    usage: Usage = Usage()
    response_id: Identifier | None = None
    returned_model: Identifier | None = None
    returned_provider: Identifier | None = None
    response_sha256: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")] | None = None
    retry_after_seconds: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    attempts: Annotated[StrictInt, Field(ge=0, le=1)] = 0

    @model_validator(mode="after")
    def consistent_outcome(self) -> Self:
        if self.completed_at_ms < self.started_at_ms:
            raise ValueError("completion precedes start")
        if self.status == "OK":
            if (
                self.output is None
                or self.attempts != 1
                or self.purpose is None
                or self.usage.status == "INVALID"
                or self.retry_after_seconds is not None
            ):
                raise ValueError("successful result requires one valid completed attempt")
        elif self.output is not None:
            raise ValueError("failed result cannot carry usable output")
        if self.attempts == 1:
            if self.purpose is None or self.status in {"UNCONFIGURED", "UNSUPPORTED"}:
                raise ValueError("attempt requires configured supported transport purpose")
        elif self.usage != Usage() or any(
            item is not None
            for item in (
                self.response_id,
                self.returned_model,
                self.returned_provider,
                self.response_sha256,
                self.retry_after_seconds,
            )
        ):
            raise ValueError("unattempted result cannot carry response or billing metadata")
        return self


class DataProvider(Protocol):
    async def fetch_snapshot(self, instrument: Instrument) -> DataResult: ...


class ModelPort(Protocol):
    async def generate_structured(self, task: ResearchTask) -> ModelResult: ...
