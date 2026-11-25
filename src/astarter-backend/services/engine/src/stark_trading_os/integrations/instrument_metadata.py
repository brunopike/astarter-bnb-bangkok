"""Bounded simulation observations. Hashes and labels are not source authority."""

from __future__ import annotations

import json
from hashlib import sha256
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    model_validator,
)

from stark_trading_os.integrations.contracts import Identifier, Status
from stark_trading_os.integrations.decimal_normalization import DecimalValue

TTL_NS = 300_000_000_000
MAX_NS = 2**64 - 1
Nanoseconds = Annotated[StrictInt, Field(ge=0, le=MAX_NS)]
Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
Asset = Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{1,24}$")]


class MetadataInvalid(ValueError):
    def __init__(self) -> None:
        super().__init__("METADATA_INPUT_INVALID")


def ns(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_NS:
        raise MetadataInvalid
    return value


def digest(value: object) -> str:
    return sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
        ).encode()
    ).hexdigest()


class Frozen(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, revalidate_instances="always"
    )


def checked[T: BaseModel](kind: type[T], value: T) -> T:
    if (
        type(value) is not kind
        or set(value.__dict__) != set(kind.model_fields)
        or value.__pydantic_extra__
    ):
        raise MetadataInvalid
    return kind.model_validate(dict(value.__dict__))


class InstrumentQuery(Frozen):
    provider: Literal["binance-spot"] = "binance-spot"
    venue: Identifier
    market: Literal["SPOT", "PERP"]
    symbol: Annotated[StrictStr, Field(pattern=r"^[A-Z0-9]{2,32}$")]
    expected_base: Asset
    expected_quote: Asset

    @model_validator(mode="after")
    def distinct(self) -> Self:
        if self.expected_base == self.expected_quote:
            raise MetadataInvalid
        return self


class PriceRules(Frozen):
    minimum: DecimalValue
    maximum: DecimalValue
    tick: DecimalValue

    @model_validator(mode="after")
    def bounds(self) -> Self:
        if self.maximum.exact() and self.minimum.exact() > self.maximum.exact():
            raise MetadataInvalid
        return self


class LotRules(Frozen):
    minimum: DecimalValue
    maximum: DecimalValue
    step: DecimalValue

    @model_validator(mode="after")
    def bounds(self) -> Self:
        if self.minimum.exact() > self.maximum.exact():
            raise MetadataInvalid
        return self


class NotionalRules(Frozen):
    kind: Literal["MIN_NOTIONAL", "NOTIONAL"]
    minimum: DecimalValue
    maximum: DecimalValue | None = None
    apply_min_to_market: StrictBool
    apply_max_to_market: StrictBool = False
    average_minutes: Annotated[StrictInt, Field(ge=0, le=2**31 - 1)]

    @model_validator(mode="after")
    def bounds(self) -> Self:
        if (self.kind == "NOTIONAL") != (self.maximum is not None):
            raise MetadataInvalid
        if self.maximum is not None and self.minimum.exact() > self.maximum.exact():
            raise MetadataInvalid
        return self


class RuleObservation(Frozen):
    kind: Identifier
    level: Literal["SYMBOL", "EXCHANGE"]
    category: Literal["STATIC", "DYNAMIC", "NOT_APPLICABLE", "UNKNOWN"]
    raw_sha256: Digest


class PrecisionFact(Frozen):
    name: Literal[
        "baseAssetPrecision",
        "quoteAssetPrecision",
        "quotePrecision",
        "baseCommissionPrecision",
        "quoteCommissionPrecision",
    ]
    value: Annotated[StrictInt, Field(ge=0, le=128)]


class InstrumentFactsV1(Frozen):
    schema_version: Literal["InstrumentFacts.v1"] = "InstrumentFacts.v1"
    parser_revision: Literal["binance-metadata-v1"] = "binance-metadata-v1"
    query: InstrumentQuery
    trading_status: Identifier
    spot_allowed: StrictBool
    order_types: Annotated[tuple[Identifier, ...], Field(max_length=32)]
    permission_sets: Annotated[
        tuple[Annotated[tuple[Identifier, ...], Field(min_length=1, max_length=32)], ...],
        Field(max_length=32),
    ]
    precisions: Annotated[tuple[PrecisionFact, ...], Field(max_length=5)]
    price: PriceRules | None
    lot: LotRules | None
    notionals: Annotated[tuple[NotionalRules, ...], Field(max_length=2)]
    rules: Annotated[tuple[RuleObservation, ...], Field(max_length=128)]
    unknown_fields_sha256: Digest | None = None

    @model_validator(mode="after")
    def unique_rules(self) -> Self:
        keys = [(r.level, r.kind) for r in self.rules]
        if len(keys) != len(set(keys)) or len(set(self.order_types)) != len(self.order_types):
            raise MetadataInvalid
        if len({p.name for p in self.precisions}) != len(self.precisions):
            raise MetadataInvalid
        return self

    @property
    def unsupported(self) -> bool:
        return self.unknown_fields_sha256 is not None or any(
            r.category == "UNKNOWN" for r in self.rules
        )

    def revision(self) -> str:
        value = checked(type(self), self).model_dump(mode="json")

        def semantic(item: object) -> object:
            if isinstance(item, dict):
                if set(item) == {"raw", "canonical"}:
                    return item["canonical"]
                return {k: semantic(v) for k, v in item.items()}
            if isinstance(item, list):
                return [semantic(v) for v in item]
            return item

        value["rules"] = [
            {k: v for k, v in r.items() if k != "raw_sha256" or r["category"] != "STATIC"}
            for r in value["rules"]
        ]
        return digest(semantic(value))


class MetadataReceiptV1(Frozen):
    receipt_id: Identifier
    capability_id: Literal["binance.spot.instrument"] = "binance.spot.instrument"
    purpose: Literal["OFFLINE_FIXTURE"] = "OFFLINE_FIXTURE"
    timestamp_semantics: Literal["METADATA_OBSERVATION"] = "METADATA_OBSERVATION"
    parser_revision: Literal["binance-metadata-v1"] = "binance-metadata-v1"
    source_policy_id: Identifier
    source_policy_revision: Identifier
    raw_sha256: Digest
    facts_revision: Digest
    received_at_ns: Nanoseconds
    available_at_ns: Nanoseconds
    expires_at_ns: Nanoseconds
    source_server_time_ms: Annotated[StrictInt, Field(ge=0, le=MAX_NS // 1_000_000)] | None = None

    @model_validator(mode="after")
    def chronology(self) -> Self:
        if (
            self.received_at_ns > self.available_at_ns
            or self.expires_at_ns != self.received_at_ns + TTL_NS
        ):
            raise MetadataInvalid
        return self

    def usable_at(self, decision_time_ns: int) -> bool:
        r = checked(type(self), self)
        return r.available_at_ns <= ns(decision_time_ns) < r.expires_at_ns


class MetadataResult(Frozen):
    query: InstrumentQuery
    status: Status
    facts: InstrumentFactsV1 | None = None
    receipt: MetadataReceiptV1 | None = None
    evaluated_at_ns: Nanoseconds | None = None
    reason: Literal["INVALID_METADATA", "EXTERNAL_DISABLED"] | None = None
    retry_after_seconds: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.status in {"OK", "STALE"}:
            if self.facts is None or self.receipt is None or self.evaluated_at_ns is None:
                raise MetadataInvalid
            if (
                self.facts.query != self.query
                or self.receipt.facts_revision != self.facts.revision()
                or self.receipt.parser_revision != self.facts.parser_revision
                or self.evaluated_at_ns < self.receipt.available_at_ns
                or (self.status == "OK") != self.receipt.usable_at(self.evaluated_at_ns)
                or self.reason is not None
                or self.retry_after_seconds is not None
            ):
                raise MetadataInvalid
        elif any(v is not None for v in (self.facts, self.receipt, self.evaluated_at_ns)):
            raise MetadataInvalid
        return self
