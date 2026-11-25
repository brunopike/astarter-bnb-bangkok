"""Offline historical strategy contracts; no runtime registry or authority."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, ClassVar, Literal

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

from stark_trading_os.catalog.historical_catalog import CatalogWindowV2
from stark_trading_os.runner.historical_cost import HistoricalExecutionCostV1

type Digest = Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
type PositiveDecimal = Annotated[
    StrictStr,
    Field(
        max_length=64,
        pattern=r"^(?:[1-9][0-9]*(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9])$",
    ),
]
type PositiveNanoseconds = Annotated[StrictStr, Field(max_length=20, pattern=r"^[1-9][0-9]*$")]
type CurrencyCode = Annotated[StrictStr, Field(min_length=1, max_length=32)]


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
        strict=True,
    )


class SmaCrossParametersV1(_ClosedModel):
    fast_period: Annotated[StrictInt, Field(ge=2, le=499)]
    slow_period: Annotated[StrictInt, Field(ge=3, le=500)]
    order_quantity: PositiveDecimal

    @model_validator(mode="after")
    def ordered_periods(self) -> SmaCrossParametersV1:
        if self.fast_period >= self.slow_period:
            raise ValueError("fast period must be smaller than slow period")
        return self


class SmaLocalRiskV1(_ClosedModel):
    schema_: Literal["SmaLocalRisk.v1"] = Field(alias="schema")
    max_order_notional: PositiveDecimal
    max_position_quantity: PositiveDecimal


class SmaConfigurationInputV2(_ClosedModel):
    name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    strategy_ref: Literal["sma-cross-long-flat@v1"]
    purpose: Literal["ENGINEERING_BASELINE"]
    catalog_revision: Digest
    parameters: SmaCrossParametersV1
    risk: SmaLocalRiskV1
    execution_cost: HistoricalExecutionCostV1

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must be nonblank")
        return value

    @model_validator(mode="after")
    def quantity_within_position_limit(self) -> SmaConfigurationInputV2:
        if Decimal(self.parameters.order_quantity) > Decimal(self.risk.max_position_quantity):
            raise ValueError("order quantity exceeds the position limit")
        return self


class SmaConfigurationEnvelopeV2(_ClosedModel):
    kind: Literal["StrategyConfigurationInput.v2"]
    configuration: SmaConfigurationInputV2


class HistoricalDatasetBindingV2(_ClosedModel):
    selection: Literal["ENTIRE_PUBLISHED_CATALOG"]
    catalog_revision: Digest
    source_id: Digest
    raw_sha256: Digest
    metadata_sha256: Digest
    catalog_checksum: Digest
    inventory_hash: Digest
    bar_values_sha256: Digest
    instrument_id: Annotated[StrictStr, Field(pattern=r"^HIST[0-9A-F]{20}\.SIM$")]
    bar_type: Annotated[StrictStr, Field(min_length=1, max_length=256)]
    timeframe_ns: PositiveNanoseconds
    record_count: Annotated[StrictInt, Field(ge=1, lt=100_000)]
    window: CatalogWindowV2
    base_currency: CurrencyCode
    quote_currency: CurrencyCode
    purpose: Literal["SYNTHETIC_QA", "HISTORICAL_MARKET"]
    availability_source: Literal["ASSUMED_AT_CLOSE", "RECORDED_AT_CLOSE"]

    @model_validator(mode="after")
    def exact_contiguous_window(self) -> HistoricalDatasetBindingV2:
        values = self.window.model_dump()
        for value in (self.timeframe_ns, *values.values()):
            if len(value) > 20 or int(value) > (2**64) - 1:
                raise ValueError("time outside native domain")
        period = int(self.timeframe_ns)
        start = int(self.window.first_open_ns)
        expected = {
            "first_open_ns": str(start),
            "first_close_ns": str(start + period),
            "last_open_ns": str(start + (self.record_count - 1) * period),
            "last_close_ns": str(start + self.record_count * period),
            "first_available_ns": str(start + period),
            "last_available_ns": str(start + self.record_count * period),
        }
        if values != expected:
            raise ValueError("dataset window must describe all contiguous closed bars")
        if self.base_currency == self.quote_currency:
            raise ValueError("base and quote currencies must differ")
        return self


class HistoricalRuntimeV2(_ClosedModel):
    engine_package_version: Literal["2.0.0rc3"]
    engine_tag_commit: Literal["648970ce64a304d93da0a29320cb6e19b905fa39"]
    python_version: Annotated[StrictStr, Field(pattern=r"^3\.12\.[0-9]+$")]
    precision_mode: Literal["FIXED_PRECISION_16"]
    platform_system: Literal["Darwin"]
    platform_machine: Literal["arm64"]
    native_extension_sha256: Digest


class HistoricalExecutionV2(_ClosedModel):
    venue: Literal["SIM"]
    oms_type: Literal["NETTING"]
    account_type: Literal["CASH"]
    book_type: Literal["L1_MBP"]
    initial_state: Literal["ZERO_BASE_QUOTE_CASH_NO_POSITION"]
    bar_execution: StrictBool
    bar_adaptive_high_low_ordering: StrictBool
    trade_execution: StrictBool
    liquidity_consumption: StrictBool
    routing: StrictBool
    use_random_ids: StrictBool
    use_position_ids: StrictBool
    use_reduce_only: StrictBool
    use_market_order_acks: StrictBool
    allow_cash_borrowing: StrictBool

    _TRUE_FLAGS: ClassVar[frozenset[str]] = frozenset(
        {"bar_execution", "liquidity_consumption", "use_position_ids"}
    )

    @model_validator(mode="after")
    def approved_native_flags(self) -> HistoricalExecutionV2:
        for name, field in type(self).model_fields.items():
            if field.annotation is bool and getattr(self, name) is not (name in self._TRUE_FLAGS):
                raise ValueError("unsupported historical execution flag")
        return self


class InputManifestV2(_ClosedModel):
    schema_: Literal["InputManifest.v2"] = Field(alias="schema")
    environment: Literal["BACKTEST"]
    configuration_id: Annotated[StrictStr, Field(pattern=r"^cfg_[0-9a-f]{32}$")]
    configuration_version: Annotated[StrictInt, Field(ge=1, le=(2**53) - 1)]
    configuration: SmaConfigurationEnvelopeV2
    configuration_content_sha256: Digest
    dataset: HistoricalDatasetBindingV2
    cost_sha256: Digest
    runtime: HistoricalRuntimeV2
    execution: HistoricalExecutionV2

    @model_validator(mode="after")
    def same_catalog(self) -> InputManifestV2:
        if self.configuration.configuration.catalog_revision != self.dataset.catalog_revision:
            raise ValueError("configuration and dataset catalogs differ")
        return self
