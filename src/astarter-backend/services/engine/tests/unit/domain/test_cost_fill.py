from __future__ import annotations

import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

import pytest
from nautilus_trader.core import UUID4
from nautilus_trader.execution import (
    DefaultFillModel,
    MakerTakerFeeModel,
    StaticLatencyModel,
)
from nautilus_trader.model import (
    AccountId,
    BookType,
    ClientOrderId,
    Currency,
    CurrencyPair,
    InstrumentId,
    LimitOrder,
    LiquiditySide,
    OrderAccepted,
    OrderFilled,
    OrderSide,
    OrderSubmitted,
    Price,
    Quantity,
    StrategyId,
    Symbol,
    TimeInForce,
    TradeId,
    TraderId,
    Venue,
    VenueOrderId,
)
from pydantic import ValidationError

from stark_trading_os.domain.cost_fill import (
    UnsupportedCostFillModel,
    build_native_cost_fill_profile,
)
from stark_trading_os.domain.models import (
    CostFillModelV1,
    DraftCostFillModelV1,
)

_FIXTURE_INSTRUMENT = (
    Path(__file__).resolve().parents[5]
    / "data"
    / "fixtures"
    / "determinism-probe-v1"
    / "instrument.json"
)


def supported_cost_fill() -> dict[str, object]:
    return {
        "schema": "CostFillModel.v1",
        "fee": {
            "model": "MakerTakerFeeModel",
            "rate_source": "INSTRUMENT_MAKER_TAKER",
            "rate_unit": "NOTIONAL_DECIMAL_FRACTION",
            "charge_currency": "INSTRUMENT_QUOTE_CURRENCY",
            "minimum_fee": "0",
            "application": "PER_FILL",
            "decimal_precision": 8,
            "rounding_mode": "MIDPOINT_NEAREST_EVEN",
        },
        "spread": {"authority": "FIXTURE_BID_ASK"},
        "slippage": {
            "model": "DefaultFillModel",
            "prob_fill_on_limit": "1",
            "prob_slippage": "0",
            "random_seed_source": "INPUT_MANIFEST_REPLAY_SEED",
            "probabilistic_slippage": "DISABLED",
            "depth_price_impact": "DISABLED",
            "maximum_book_walk_ticks": "0",
        },
        "latency": {
            "model": "StaticLatencyModel",
            "decision_to_submit_ns": "0",
            "submit_to_venue_ns": "0",
            "base_latency_ns": "0",
            "insert_latency_ns": "0",
            "update_latency_ns": "0",
            "cancel_latency_ns": "0",
        },
        "liquidity": {
            "available_size_source": "RECORDED_QUOTE_TICK_BID_ASK_SIZE",
            "queue_assumption": "NOT_MODELED_AT_L1",
            "allocation_order": "SINGLE_ORDER_NO_ALLOCATION_COMPETITION",
            "partial_fill_schedule": "ON_RECORDED_QUOTE",
            "price_selection": "NATIVE_L1_BID_ASK_CROSS",
            "allow_partial_fills": True,
            "liquidity_consumption": True,
        },
        "cancel": {
            "acknowledgment_rule": "NATIVE",
            "remaining_quantity_disposition": "CANCEL_OPEN_REMAINDER",
            "time_in_force": "GTC",
        },
    }


@pytest.mark.parametrize(
    "section",
    ["fee", "spread", "slippage", "latency", "liquidity", "cancel"],
)
def test_draft_accepts_an_explicitly_missing_semantic_section_without_defaulting_it(
    section: str,
) -> None:
    value = supported_cost_fill()
    value[section] = None

    draft = DraftCostFillModelV1.model_validate(value)

    assert getattr(draft, section) is None
    with pytest.raises(ValidationError, match=section):
        CostFillModelV1.model_validate(value)


def test_complete_model_has_no_duplicate_seed_or_open_economic_map() -> None:
    model = CostFillModelV1.model_validate(supported_cost_fill())

    assert set(type(model).model_fields) == {
        "schema_",
        "fee",
        "spread",
        "slippage",
        "latency",
        "liquidity",
        "cancel",
    }
    assert "replay_seed" not in type(model).model_fields
    assert "economic_values" not in type(model).model_fields


@pytest.mark.parametrize(
    ("path", "bad_value"),
    [
        (("fee", "minimum_fee"), 0.0),
        (("slippage", "prob_fill_on_limit"), 1.0),
        (("slippage", "prob_slippage"), 0.0),
        (("latency", "base_latency_ns"), 0.0),
        (("liquidity", "allow_partial_fills"), 1),
        (("fee", "model"), "FixedFeeModel"),
        (("spread", "authority"), "SYNTHETIC"),
        (("latency", "insert_latency_ns"), "1"),
        (("liquidity", "available_size_source"), "NATIVE_SYNTHETIC_BOOK"),
        (("liquidity", "liquidity_consumption"), False),
        (("cancel", "time_in_force"), "IOC"),
    ],
)
def test_complete_model_rejects_float_wrong_type_and_unsupported_closed_values(
    path: tuple[str, str], bad_value: object
) -> None:
    value = deepcopy(supported_cost_fill())
    section = value[path[0]]
    assert isinstance(section, dict)
    section[path[1]] = bad_value

    with pytest.raises(ValidationError):
        CostFillModelV1.model_validate(value)


def test_complete_model_rejects_unknown_fields_in_every_layer() -> None:
    root = supported_cost_fill()
    root["surprise"] = True
    with pytest.raises(ValidationError, match="surprise"):
        CostFillModelV1.model_validate(root)

    nested = supported_cost_fill()
    fee = nested["fee"]
    assert isinstance(fee, dict)
    fee["surprise"] = True
    with pytest.raises(ValidationError, match="surprise"):
        CostFillModelV1.model_validate(nested)


def test_supported_profile_constructs_only_the_pinned_rc3_native_models() -> None:
    model = CostFillModelV1.model_validate(supported_cost_fill())

    native = build_native_cost_fill_profile(model, replay_seed=7)

    assert type(native.fee_model) is MakerTakerFeeModel
    assert type(native.fill_model) is DefaultFillModel
    assert type(native.latency_model) is StaticLatencyModel
    assert native.book_type is BookType.L1_MBP
    assert native.liquidity_consumption is True
    assert "prob_fill_on_limit: 1.0" in repr(native.fill_model)
    assert "prob_slippage: 0.0" in repr(native.fill_model)
    assert "random_seed: Some(7)" in repr(native.fill_model)
    assert "base_latency_nanos: UnixNanos(0)" in repr(native.latency_model)
    assert "insert_latency_nanos: UnixNanos(0)" in repr(native.latency_model)
    assert "update_latency_nanos: UnixNanos(0)" in repr(native.latency_model)
    assert "delete_latency_nanos: UnixNanos(0)" in repr(native.latency_model)
    assert model.fee.decimal_precision == Currency.from_str("USDT").precision == 8


def test_adapter_revalidates_exact_profile_instead_of_ignoring_a_mutation() -> None:
    model = CostFillModelV1.model_validate(supported_cost_fill())
    object.__setattr__(model.latency, "insert_latency_ns", "1")

    with pytest.raises(UnsupportedCostFillModel):
        build_native_cost_fill_profile(model, replay_seed=7)


@pytest.mark.parametrize(
    ("liquidity_side", "expected"),
    [(LiquiditySide.MAKER, "0.04000000 USDT"), (LiquiditySide.TAKER, "0.10000000 USDT")],
)
def test_pinned_rc3_native_maker_taker_characterization_uses_quote_currency_precision(
    liquidity_side: LiquiditySide, expected: str
) -> None:
    instrument = _fixture_instrument(maker_fee="0.0002", taker_fee="0.0005")
    order = _filled_order(instrument, liquidity_side=liquidity_side)
    native = build_native_cost_fill_profile(
        CostFillModelV1.model_validate(supported_cost_fill()), replay_seed=7
    )

    commission = native.fee_model.get_commission(
        order,
        Quantity.from_str("2.000"),
        Price.from_str("100.00"),
        instrument,
    )

    assert str(commission) == expected
    assert str(commission.currency) == "USDT"


def test_determinism_fixture_rates_charge_each_native_taker_fill() -> None:
    source = json.loads(_FIXTURE_INSTRUMENT.read_bytes())
    assert source["maker_fee"] == "0.0002"
    assert source["taker_fee"] == "0.001"
    instrument = _fixture_instrument(
        maker_fee=source["maker_fee"],
        taker_fee=source["taker_fee"],
    )
    order = _filled_order(instrument, liquidity_side=LiquiditySide.TAKER)
    native = build_native_cost_fill_profile(
        CostFillModelV1.model_validate(supported_cost_fill()), replay_seed=7
    )

    commission = native.fee_model.get_commission(
        order,
        Quantity.from_str("2.000"),
        Price.from_str("100.00"),
        instrument,
    )

    assert str(commission) == "0.20000000 USDT"


def _fixture_instrument(*, maker_fee: str, taker_fee: str) -> CurrencyPair:
    return CurrencyPair(
        instrument_id=InstrumentId(Symbol("ETH/USDT"), Venue("SIM")),
        raw_symbol=Symbol("ETH/USDT"),
        base_currency=Currency.from_str("ETH"),
        quote_currency=Currency.from_str("USDT"),
        price_precision=2,
        size_precision=3,
        price_increment=Price.from_str("0.01"),
        size_increment=Quantity.from_str("0.001"),
        ts_event=1,
        ts_init=1,
        min_quantity=Quantity.from_str("0.001"),
        min_notional=None,
        margin_init=Decimal("0.1"),
        margin_maint=Decimal("0.05"),
        maker_fee=Decimal(maker_fee),
        taker_fee=Decimal(taker_fee),
    )


def _filled_order(instrument: CurrencyPair, *, liquidity_side: LiquiditySide) -> LimitOrder:
    order = LimitOrder(
        trader_id=TraderId("TRADER-001"),
        strategy_id=StrategyId("PROBE-001"),
        instrument_id=instrument.id,
        client_order_id=ClientOrderId("ORDER-001"),
        order_side=OrderSide.BUY,
        quantity=Quantity.from_str("2.000"),
        price=Price.from_str("100.00"),
        time_in_force=TimeInForce.GTC,
        post_only=False,
        reduce_only=False,
        quote_quantity=False,
        init_id=UUID4(),
        ts_init=1,
    )
    account_id = AccountId("SIM-001")
    venue_order_id = VenueOrderId("VENUE-001")
    order.apply(
        OrderSubmitted(
            order.trader_id,
            order.strategy_id,
            order.instrument_id,
            order.client_order_id,
            account_id,
            UUID4(),
            2,
            2,
        )
    )
    order.apply(
        OrderAccepted(
            order.trader_id,
            order.strategy_id,
            order.instrument_id,
            order.client_order_id,
            venue_order_id,
            account_id,
            UUID4(),
            3,
            3,
            False,
        )
    )
    order.apply(
        OrderFilled(
            order.trader_id,
            order.strategy_id,
            order.instrument_id,
            order.client_order_id,
            venue_order_id,
            account_id,
            TradeId("TRADE-001"),
            order.side,
            order.order_type,
            Quantity.from_str("2.000"),
            Price.from_str("100.00"),
            instrument.quote_currency,
            liquidity_side,
            UUID4(),
            4,
            4,
            False,
        )
    )
    return order
