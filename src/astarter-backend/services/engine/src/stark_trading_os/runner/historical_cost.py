"""Strict run-local historical cost profile for pinned native execution."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
from typing import Annotated, Literal

from nautilus_trader.execution import FillModel, MakerTakerFeeModel, StaticLatencyModel
from nautilus_trader.model import AccountType, BookType, CurrencyPair, Money, OmsType
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictStr,
    ValidationError,
    field_validator,
)

from stark_trading_os.catalog.historical_catalog import (
    HistoricalCatalogInvalid,
    canonical_historical_bytes,
)

_CANONICAL_DECIMAL_PATTERN = (
    r"^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|"
    r"-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$"
)
type _BoundedCanonicalDecimal = Annotated[
    StrictStr,
    Field(max_length=64, pattern=_CANONICAL_DECIMAL_PATTERN),
]


class UnsupportedHistoricalExecutionCost(ValueError):
    def __init__(self) -> None:
        super().__init__("UNSUPPORTED_HISTORICAL_EXECUTION_COST")


class HistoricalExecutionCostV1(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=False,
        serialize_by_alias=True,
        strict=True,
    )

    schema_: Literal["HistoricalExecutionCost.v1"] = Field(alias="schema")
    profile: Literal["HISTORICAL_BAR_CLOSE_CASH_V1"]
    starting_cash: _BoundedCanonicalDecimal
    maker_fee: _BoundedCanonicalDecimal
    taker_fee: _BoundedCanonicalDecimal
    fee_source: Annotated[StrictStr, Field(min_length=1, max_length=512)]
    fill_model: Literal["NATIVE_BASE_FILL"]
    latency: Literal["ZERO"]
    execution_timing: Literal["CLOSED_BAR_NATIVE"]
    random_seed_support: Literal["UNSUPPORTED"]

    @field_validator("starting_cash")
    @classmethod
    def _require_positive_starting_cash(cls, value: str) -> str:
        if Decimal(value) <= 0:
            raise ValueError("starting_cash must be positive")
        return value

    @field_validator("maker_fee", "taker_fee")
    @classmethod
    def _require_supported_fee_rate(cls, value: str) -> str:
        rate = Decimal(value)
        if rate < 0 or rate > 1:
            raise ValueError("fee rates must be between zero and one")
        return value

    @field_validator("fee_source")
    @classmethod
    def _require_nonblank_fee_source(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("fee_source must be nonblank")
        return value


@dataclass(frozen=True, slots=True)
class NativeHistoricalExecutionProfile:
    instrument: CurrencyPair
    starting_quote_balance: Money
    cost_bytes: bytes
    cost_sha256: str
    fee_model: MakerTakerFeeModel
    fill_model: FillModel
    latency_model: StaticLatencyModel
    book_type: BookType
    oms_type: OmsType
    account_type: AccountType
    routing: bool
    use_position_ids: bool
    use_random_ids: bool
    use_reduce_only: bool
    use_market_order_acks: bool
    bar_execution: bool
    bar_adaptive_high_low_ordering: bool
    trade_execution: bool
    liquidity_consumption: bool
    allow_cash_borrowing: bool


def historical_cost_bytes(cost: HistoricalExecutionCostV1) -> bytes:
    validated = _revalidate_cost(cost)
    try:
        return canonical_historical_bytes(validated)
    except HistoricalCatalogInvalid as error:
        raise UnsupportedHistoricalExecutionCost from error


def build_historical_execution_profile(
    instrument: CurrencyPair,
    cost: HistoricalExecutionCostV1,
) -> NativeHistoricalExecutionProfile:
    """Derive one run-local profile without authenticating or mutating its source catalog."""

    validated = _revalidate_cost(cost)
    if (
        type(instrument) is not CurrencyPair
        or str(instrument.id.venue) != "SIM"
        or Decimal(instrument.maker_fee) != Decimal("0")
        or Decimal(instrument.taker_fee) != Decimal("0")
    ):
        raise UnsupportedHistoricalExecutionCost

    try:
        source_values = instrument.to_dict()
        if type(source_values) is not dict:
            raise UnsupportedHistoricalExecutionCost
        execution_values = deepcopy(source_values)
        execution_values["maker_fee"] = validated.maker_fee
        execution_values["taker_fee"] = validated.taker_fee
        execution_instrument = CurrencyPair.from_dict(execution_values)
        result_values = execution_instrument.to_dict()
    except UnsupportedHistoricalExecutionCost:
        raise
    except Exception as error:
        raise UnsupportedHistoricalExecutionCost from error

    source_after = instrument.to_dict()
    source_nonfee = {
        key: value for key, value in source_values.items() if key not in {"maker_fee", "taker_fee"}
    }
    result_nonfee = {
        key: value for key, value in result_values.items() if key not in {"maker_fee", "taker_fee"}
    }
    if (
        execution_instrument is instrument
        or source_after != source_values
        or source_nonfee != result_nonfee
        or result_values.get("maker_fee") != validated.maker_fee
        or result_values.get("taker_fee") != validated.taker_fee
        or Decimal(execution_instrument.maker_fee) != Decimal(validated.maker_fee)
        or Decimal(execution_instrument.taker_fee) != Decimal(validated.taker_fee)
    ):
        raise UnsupportedHistoricalExecutionCost

    starting_value = Decimal(validated.starting_cash)
    try:
        starting_quote_balance = Money.from_decimal(
            starting_value,
            instrument.quote_currency,
        )
    except (OverflowError, RuntimeError, ValueError) as error:
        raise UnsupportedHistoricalExecutionCost from error
    if (
        not starting_quote_balance.is_positive()
        or starting_quote_balance.currency != instrument.quote_currency
        or starting_quote_balance.as_decimal() != starting_value
    ):
        raise UnsupportedHistoricalExecutionCost

    encoded = historical_cost_bytes(validated)
    return NativeHistoricalExecutionProfile(
        instrument=execution_instrument,
        starting_quote_balance=starting_quote_balance,
        cost_bytes=encoded,
        cost_sha256=sha256(encoded).hexdigest(),
        fee_model=MakerTakerFeeModel(),
        fill_model=FillModel(),
        latency_model=StaticLatencyModel(),
        book_type=BookType.L1_MBP,
        oms_type=OmsType.NETTING,
        account_type=AccountType.CASH,
        routing=False,
        use_position_ids=True,
        use_random_ids=False,
        use_reduce_only=False,
        use_market_order_acks=False,
        bar_execution=True,
        bar_adaptive_high_low_ordering=False,
        trade_execution=False,
        liquidity_consumption=True,
        allow_cash_borrowing=False,
    )


def _revalidate_cost(cost: HistoricalExecutionCostV1) -> HistoricalExecutionCostV1:
    if type(cost) is not HistoricalExecutionCostV1:
        raise UnsupportedHistoricalExecutionCost
    fields = type(cost).model_fields
    if set(cost.__dict__) != set(fields):
        raise UnsupportedHistoricalExecutionCost
    try:
        payload = {field.alias or name: getattr(cost, name) for name, field in fields.items()}
        validated = HistoricalExecutionCostV1.model_validate(payload)
    except (AttributeError, TypeError, ValidationError, ValueError) as error:
        raise UnsupportedHistoricalExecutionCost from error
    if validated != cost:
        raise UnsupportedHistoricalExecutionCost
    return validated
