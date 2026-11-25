from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
from hashlib import sha256

import pytest
from nautilus_trader.execution import FillModel, MakerTakerFeeModel, StaticLatencyModel
from nautilus_trader.model import (
    AccountType,
    BookType,
    Currency,
    CurrencyPair,
    InstrumentId,
    LiquiditySide,
    Money,
    OmsType,
    Price,
    Quantity,
    Symbol,
    Venue,
)
from pydantic import ValidationError

from stark_trading_os.runner.historical_cost import (
    HistoricalExecutionCostV1,
    NativeHistoricalExecutionProfile,
    UnsupportedHistoricalExecutionCost,
    build_historical_execution_profile,
    historical_cost_bytes,
)
from tests.unit.domain.test_cost_fill import _filled_order


def _supported_cost(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": "HistoricalExecutionCost.v1",
        "profile": "HISTORICAL_BAR_CLOSE_CASH_V1",
        "starting_cash": "1000",
        "maker_fee": "0.0002",
        "taker_fee": "0.001",
        "fee_source": "synthetic explicit assumption",
        "fill_model": "NATIVE_BASE_FILL",
        "latency": "ZERO",
        "execution_timing": "CLOSED_BAR_NATIVE",
        "random_seed_support": "UNSUPPORTED",
    }
    value.update(changes)
    return value


def _source_instrument(
    *,
    venue: str = "SIM",
    maker_fee: str = "0",
    taker_fee: str = "0",
) -> CurrencyPair:
    quote = Currency.from_str("USDT")
    return CurrencyPair(
        instrument_id=InstrumentId(Symbol("ETH/USDT"), Venue(venue)),
        raw_symbol=Symbol("ETH/USDT"),
        base_currency=Currency.from_str("ETH"),
        quote_currency=quote,
        price_precision=2,
        size_precision=3,
        price_increment=Price.from_str("0.01"),
        size_increment=Quantity.from_str("0.001"),
        ts_event=1_700_000_060_000_000_000,
        ts_init=1_700_000_060_000_000_000,
        multiplier=Quantity.from_str("1.000"),
        lot_size=Quantity.from_str("0.001"),
        max_quantity=Quantity.from_str("999.999"),
        min_quantity=Quantity.from_str("0.001"),
        max_notional=Money.from_str("99999 USDT"),
        min_notional=Money.from_str("1 USDT"),
        max_price=Price.from_str("9999.99"),
        min_price=Price.from_str("0.01"),
        margin_init=Decimal("0"),
        margin_maint=Decimal("0"),
        maker_fee=Decimal(maker_fee),
        taker_fee=Decimal(taker_fee),
        info={"provenance": "unit fixture", "nested": {"kept": True}},
    )


def _parsed_cost(**changes: object) -> HistoricalExecutionCostV1:
    return HistoricalExecutionCostV1.model_validate(_supported_cost(**changes))


def test_contract_is_strict_frozen_alias_only_and_canonical() -> None:
    cost = _parsed_cost()

    assert cost.model_dump(mode="json", by_alias=True) == _supported_cost()
    assert cost.schema_ == "HistoricalExecutionCost.v1"
    with pytest.raises(ValidationError):
        HistoricalExecutionCostV1.model_validate(
            {**_supported_cost(), "schema_": "HistoricalExecutionCost.v1"}
        )
    with pytest.raises(ValidationError):
        cost.starting_cash = "2000"  # type: ignore[misc]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("profile", "NEXT_OPEN_CASH_V1"),
        ("fill_model", "ZERO_SLIPPAGE"),
        ("latency", "ONE_NANOSECOND"),
        ("execution_timing", "NEXT_BAR_OPEN"),
        ("random_seed_support", "FIXED_7"),
    ],
)
def test_contract_rejects_every_unsupported_fixed_profile_value(
    field: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        HistoricalExecutionCostV1.model_validate(_supported_cost(**{field: value}))


@pytest.mark.parametrize("field", ["seed", "slippage", "engine_kwargs", "path"])
def test_contract_rejects_arbitrary_runtime_knobs(field: str) -> None:
    with pytest.raises(ValidationError, match=field):
        HistoricalExecutionCostV1.model_validate(_supported_cost(**{field: "not supported"}))


@pytest.mark.parametrize(
    "value",
    [
        1,
        0.001,
        "+1",
        "01",
        "1.0",
        "0.0",
        "-0",
        "-0.0",
        "1e-3",
        ".1",
        "1.",
        "1" * 65,
    ],
)
@pytest.mark.parametrize("field", ["starting_cash", "maker_fee", "taker_fee"])
def test_contract_rejects_noncanonical_or_unbounded_decimal_values(
    field: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        HistoricalExecutionCostV1.model_validate(_supported_cost(**{field: value}))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("starting_cash", "0"),
        ("starting_cash", "-0.1"),
        ("maker_fee", "-0.0001"),
        ("maker_fee", "1.0001"),
        ("taker_fee", "-0.0001"),
        ("taker_fee", "1.0001"),
    ],
)
def test_contract_rejects_impossible_cash_and_fee_ranges(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        HistoricalExecutionCostV1.model_validate(_supported_cost(**{field: value}))


@pytest.mark.parametrize("fee_source", ["", " \t\n ", "x" * 513])
def test_contract_rejects_blank_or_unbounded_fee_provenance(fee_source: str) -> None:
    with pytest.raises(ValidationError):
        HistoricalExecutionCostV1.model_validate(_supported_cost(fee_source=fee_source))


def test_cost_bytes_are_canonical_and_bind_rates_and_provenance() -> None:
    base = _parsed_cost()
    changed_maker_rate = _parsed_cost(maker_fee="0.0003")
    changed_taker_rate = _parsed_cost(taker_fee="0.002")
    changed_source = _parsed_cost(fee_source="different explicit assumption")

    encoded = historical_cost_bytes(base)

    assert encoded == (
        b'{"execution_timing":"CLOSED_BAR_NATIVE","fee_source":"synthetic explicit '
        b'assumption","fill_model":"NATIVE_BASE_FILL","latency":"ZERO",'
        b'"maker_fee":"0.0002","profile":"HISTORICAL_BAR_CLOSE_CASH_V1",'
        b'"random_seed_support":"UNSUPPORTED","schema":"HistoricalExecutionCost.v1",'
        b'"starting_cash":"1000","taker_fee":"0.001"}'
    )
    assert (
        sha256(encoded).hexdigest() != sha256(historical_cost_bytes(changed_maker_rate)).hexdigest()
    )
    assert (
        sha256(encoded).hexdigest() != sha256(historical_cost_bytes(changed_taker_rate)).hexdigest()
    )
    assert sha256(encoded).hexdigest() != sha256(historical_cost_bytes(changed_source)).hexdigest()


@pytest.mark.parametrize("exported", [historical_cost_bytes, build_historical_execution_profile])
@pytest.mark.parametrize(
    "forged",
    [
        _parsed_cost().model_copy(update={"taker_fee": "-0.001"}),
        HistoricalExecutionCostV1.model_construct(
            **{
                **_parsed_cost().__dict__,
                "maker_fee": "1.001",
            }
        ),
    ],
)
def test_exported_functions_revalidate_forged_frozen_models(
    exported: object,
    forged: HistoricalExecutionCostV1,
) -> None:

    with pytest.raises(
        UnsupportedHistoricalExecutionCost,
        match=r"^UNSUPPORTED_HISTORICAL_EXECUTION_COST$",
    ) as captured:
        if exported is historical_cost_bytes:
            historical_cost_bytes(forged)
        else:
            build_historical_execution_profile(_source_instrument(), forged)

    assert "-0.001" not in str(captured.value)
    assert "1.001" not in str(captured.value)


def test_profile_maps_fees_without_mutating_any_source_instrument_field() -> None:
    source = _source_instrument()
    before = deepcopy(source.to_dict())
    cost = _parsed_cost()

    profile = build_historical_execution_profile(source, cost)

    assert isinstance(profile, NativeHistoricalExecutionProfile)
    assert profile.instrument is not source
    assert profile.instrument.maker_fee == Decimal("0.0002")
    assert profile.instrument.taker_fee == Decimal("0.001")
    assert source.maker_fee == Decimal("0")
    assert source.taker_fee == Decimal("0")
    assert source.to_dict() == before
    expected_execution = {**before, "maker_fee": "0.0002", "taker_fee": "0.001"}
    assert profile.instrument.to_dict() == expected_execution


def test_profile_carries_only_the_pinned_native_cash_bar_configuration() -> None:
    profile = build_historical_execution_profile(_source_instrument(), _parsed_cost())

    assert profile.starting_quote_balance.as_decimal() == Decimal("1000")
    assert profile.starting_quote_balance.currency == Currency.from_str("USDT")
    assert profile.cost_bytes == historical_cost_bytes(_parsed_cost())
    assert profile.cost_sha256 == sha256(profile.cost_bytes).hexdigest()
    assert type(profile.fee_model) is MakerTakerFeeModel
    assert type(profile.fill_model) is FillModel
    assert type(profile.latency_model) is StaticLatencyModel
    assert profile.book_type is BookType.L1_MBP
    assert profile.oms_type is OmsType.NETTING
    assert profile.account_type is AccountType.CASH
    assert profile.routing is False
    assert profile.use_position_ids is True
    assert profile.use_random_ids is False
    assert profile.use_reduce_only is False
    assert profile.use_market_order_acks is False
    assert profile.bar_execution is True
    assert profile.bar_adaptive_high_low_ordering is False
    assert profile.trade_execution is False
    assert profile.liquidity_consumption is True
    assert profile.allow_cash_borrowing is False
    assert "UnixNanos(0)" in repr(profile.latency_model)


@pytest.mark.parametrize(
    ("starting_cash", "expected"),
    [("0.00000001", Decimal("0.00000001")), ("17014118346046", Decimal("17014118346046"))],
)
def test_profile_accepts_cash_exactly_representable_by_quote_money(
    starting_cash: str,
    expected: Decimal,
) -> None:
    profile = build_historical_execution_profile(
        _source_instrument(),
        _parsed_cost(starting_cash=starting_cash),
    )

    assert profile.starting_quote_balance.as_decimal() == expected


@pytest.mark.parametrize("starting_cash", ["0.000000001", "17014118346047"])
def test_profile_rejects_cash_that_native_money_would_round_or_overflow(
    starting_cash: str,
) -> None:
    with pytest.raises(
        UnsupportedHistoricalExecutionCost,
        match=r"^UNSUPPORTED_HISTORICAL_EXECUTION_COST$",
    ):
        build_historical_execution_profile(
            _source_instrument(),
            _parsed_cost(starting_cash=starting_cash),
        )


@pytest.mark.parametrize(
    "source",
    [
        _source_instrument(venue="TEST"),
        _source_instrument(maker_fee="0.0001"),
        _source_instrument(taker_fee="0.001"),
    ],
)
def test_profile_rejects_non_sim_or_nonzero_fee_source_instruments(
    source: CurrencyPair,
) -> None:
    with pytest.raises(
        UnsupportedHistoricalExecutionCost,
        match=r"^UNSUPPORTED_HISTORICAL_EXECUTION_COST$",
    ):
        build_historical_execution_profile(source, _parsed_cost())


@pytest.mark.parametrize(
    ("liquidity_side", "expected"),
    [(LiquiditySide.MAKER, "0.04000000 USDT"), (LiquiditySide.TAKER, "0.20000000 USDT")],
)
def test_profile_native_fee_model_selects_configured_maker_and_taker_rates(
    liquidity_side: LiquiditySide,
    expected: str,
) -> None:
    profile = build_historical_execution_profile(_source_instrument(), _parsed_cost())
    order = _filled_order(profile.instrument, liquidity_side=liquidity_side)

    commission = profile.fee_model.get_commission(
        order,
        Quantity.from_str("2.000"),
        Price.from_str("100.00"),
        profile.instrument,
    )

    assert str(commission) == expected
    assert commission.currency == Currency.from_str("USDT")
