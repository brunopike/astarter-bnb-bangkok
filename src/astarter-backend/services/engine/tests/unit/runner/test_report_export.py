from __future__ import annotations

from copy import deepcopy
from decimal import ROUND_DOWN, Context, Decimal, Inexact, Underflow, localcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pandas as pd
import pytest
from nautilus_trader.backtest import (
    BacktestDataConfig,
    BacktestEngineConfig,
    BacktestNode,
    BacktestRunConfig,
    BacktestVenueConfig,
)
from nautilus_trader.model import AccountType, BookType, Money, OmsType, Venue

import stark_trading_os.runner.report_export as report_export_module
from stark_trading_os.runner.compat_probe import _write_catalog, run_compat_probe
from stark_trading_os.runner.report_export import (
    ReportSchemaError,
    export_dataframe_report,
    export_metrics,
    export_portfolio_equity_series,
    validate_portfolio_equity_series,
)


def test_orders_export_uses_declared_index_schema_and_stable_order() -> None:
    frame = pd.DataFrame(
        [
            {"client_order_id": "order-b", **_order_columns("2")},
            {"client_order_id": "order-a", **_order_columns("1")},
        ]
    ).set_index("client_order_id")

    rows = export_dataframe_report("orders", frame)

    assert [row["client_order_id"] for row in rows] == ["order-a", "order-b"]
    assert rows[0]["quantity"] == "1"


def test_report_export_rejects_missing_declared_columns_and_unapproved_float() -> None:
    frame = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
        "client_order_id"
    )
    missing = frame.drop(columns="avg_px")

    with pytest.raises(ReportSchemaError, match="missing fields"):
        export_dataframe_report("orders", missing)

    frame.loc["order-a", "avg_px"] = 100.5
    with pytest.raises(ReportSchemaError, match="float"):
        export_dataframe_report("orders", frame)


@pytest.mark.parametrize("status", ["DENIED", "REJECTED"])
def test_unfilled_native_rejection_may_have_null_average_price(status: str) -> None:
    row = _order_columns("1")
    row["status"] = status
    row["filled_qty"] = Decimal("0")
    row["avg_px"] = None
    frame = pd.DataFrame([{"client_order_id": "order-a", **row}]).set_index("client_order_id")

    exported = export_dataframe_report("orders", frame)

    assert exported[0]["status"] == status
    assert exported[0]["filled_qty"] == "0"
    assert exported[0]["avg_px"] is None


@pytest.mark.parametrize(
    ("status", "filled_qty"),
    [("CANCELED", Decimal("0")), ("REJECTED", Decimal("0.001"))],
)
def test_null_average_price_is_rejected_outside_zero_fill_native_rejections(
    status: str,
    filled_qty: Decimal,
) -> None:
    row = _order_columns("1")
    row["status"] = status
    row["filled_qty"] = filled_qty
    row["avg_px"] = None
    frame = pd.DataFrame([{"client_order_id": "order-a", **row}]).set_index("client_order_id")

    with pytest.raises(ReportSchemaError, match="avg_px"):
        export_dataframe_report("orders", frame)


def test_pandas_nan_is_null_only_for_an_already_nullable_report_field() -> None:
    nullable = _order_columns("1")
    nullable["trigger_instrument_id"] = float("nan")
    frame = pd.DataFrame([{"client_order_id": "order-a", **nullable}]).set_index("client_order_id")

    exported = export_dataframe_report("orders", frame)

    assert exported[0]["trigger_instrument_id"] is None

    nonnullable = _order_columns("1")
    nonnullable["quantity"] = float("nan")
    frame = pd.DataFrame([{"client_order_id": "order-a", **nonnullable}]).set_index(
        "client_order_id"
    )
    with pytest.raises(ReportSchemaError, match="quantity"):
        export_dataframe_report("orders", frame)


def test_native_market_order_may_only_omit_non_applicable_price_and_post_only() -> None:
    market = _order_columns("1")
    market["type"] = "MARKET"
    market["price"] = float("nan")
    market["is_post_only"] = float("nan")
    frame = pd.DataFrame([{"client_order_id": "market-a", **market}]).set_index("client_order_id")

    exported = export_dataframe_report("orders", frame)

    assert exported[0]["type"] == "MARKET"
    assert exported[0]["price"] is None
    assert exported[0]["is_post_only"] is None

    for field in ("price", "is_post_only"):
        limit = _order_columns("1")
        limit[field] = float("nan")
        frame = pd.DataFrame([{"client_order_id": "limit-a", **limit}]).set_index("client_order_id")
        with pytest.raises(ReportSchemaError, match=field):
            export_dataframe_report("orders", frame)


@pytest.mark.parametrize("status", ["DENIED", "REJECTED"])
def test_zero_fill_native_rejection_may_omit_pre_execution_fields(status: str) -> None:
    row = _order_columns("1")
    row["status"] = status
    row["filled_qty"] = Decimal("0")
    row["avg_px"] = None
    row["commissions"] = None
    row["venue_order_id"] = None
    if status == "DENIED":
        row["account_id"] = None
    frame = pd.DataFrame([{"client_order_id": "order-a", **row}]).set_index("client_order_id")

    exported = export_dataframe_report("orders", frame)

    assert exported[0]["commissions"] is None
    assert exported[0]["venue_order_id"] is None
    assert exported[0]["account_id"] is (None if status == "DENIED" else row["account_id"])


@pytest.mark.parametrize("field", ["commissions", "venue_order_id", "account_id"])
def test_pre_execution_nulls_remain_forbidden_outside_exact_native_state(field: str) -> None:
    row = _order_columns("1")
    row[field] = None
    frame = pd.DataFrame([{"client_order_id": "order-a", **row}]).set_index("client_order_id")
    with pytest.raises(ReportSchemaError, match=field):
        export_dataframe_report("orders", frame)

    rejected = _order_columns("1")
    rejected["status"] = "REJECTED"
    rejected["filled_qty"] = Decimal("0")
    rejected["avg_px"] = None
    rejected["account_id"] = None
    frame = pd.DataFrame([{"client_order_id": "order-b", **rejected}]).set_index("client_order_id")
    if field == "account_id":
        with pytest.raises(ReportSchemaError, match="account_id"):
            export_dataframe_report("orders", frame)


@pytest.mark.parametrize(
    ("kind", "field"),
    [
        ("orders", "position_id"),
        ("orders", "venue_order_id"),
        ("orders", "last_trade_id"),
        ("fills", "position_id"),
        ("fills", "venue_order_id"),
        ("fills", "trade_id"),
    ],
)
def test_filled_execution_requires_position_venue_and_trade_identity(
    kind: str,
    field: str,
) -> None:
    if kind == "orders":
        frame = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
            "client_order_id"
        )
    else:
        frame = pd.DataFrame(
            [{"client_order_id": "order-a", **_fill_columns("1", "trade-a")}]
        ).set_index("client_order_id")
    frame[field] = frame[field].astype(object)
    frame.loc["order-a", field] = None

    with pytest.raises(ReportSchemaError, match=field):
        export_dataframe_report(kind, frame)


def test_open_position_allows_only_the_three_inapplicable_closing_fields() -> None:
    row = _position_columns()
    frame = pd.DataFrame([{"position_id": "position-1", **row}]).set_index("position_id")

    exported = export_dataframe_report("positions", frame)

    assert exported[0]["side"] == "LONG"
    assert {field for field, value in exported[0].items() if value is None} == {
        "closing_order_id",
        "ts_closed",
        "avg_px_close",
    }


@pytest.mark.parametrize("field", ["closing_order_id", "ts_closed", "avg_px_close"])
def test_closed_position_requires_all_native_closing_evidence(field: str) -> None:
    row = _position_columns()
    row.update(
        {
            "closing_order_id": "order-2",
            "side": "FLAT",
            "quantity": "0",
            "ts_last": 3,
            "ts_closed": 3,
            "duration_ns": 1,
            "avg_px_close": "101",
            "realized_return": "0.01",
            "sell_qty": "1",
        }
    )
    row[field] = None
    frame = pd.DataFrame([{"position_id": "position-1", **row}]).set_index("position_id")

    with pytest.raises(ReportSchemaError, match=field):
        export_dataframe_report("positions", frame)


@pytest.mark.parametrize(
    ("kind", "field", "value"),
    [
        ("orders", "commissions", "oops"),
        ("fills", "info", "oops"),
        ("orders", "ts_init", "abc"),
    ],
)
def test_report_field_type_registry_precedes_generic_string_values(
    kind: str, field: str, value: object
) -> None:
    if kind == "orders":
        frame = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
            "client_order_id"
        )
    else:
        frame = pd.DataFrame(
            [{"client_order_id": "order-a", **_fill_columns("1", "trade-a")}]
        ).set_index("client_order_id")
    frame[field] = frame[field].astype(object)
    frame.loc["order-a", field] = value

    with pytest.raises(ReportSchemaError):
        export_dataframe_report(kind, frame)


@pytest.mark.parametrize(
    ("kind", "field", "value"),
    [
        ("orders", "side", 7),
        ("fills", "currency", 7),
        ("account", "account_type", 7),
        ("orders", "quantity", "bad"),
    ],
)
def test_report_scalars_are_closed_to_the_committed_path_types(
    kind: str, field: str, value: object
) -> None:
    if kind == "orders":
        frame = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
            "client_order_id"
        )
    elif kind == "fills":
        frame = pd.DataFrame(
            [{"client_order_id": "order-a", **_fill_columns("1", "trade-a")}]
        ).set_index("client_order_id")
    else:
        frame = pd.DataFrame([{"total": "1", **_account_columns("1")}], index=pd.Index([1]))
    frame[field] = frame[field].astype(object)
    frame.iloc[0, frame.columns.get_loc(field)] = value

    with pytest.raises(ReportSchemaError):
        export_dataframe_report(kind, frame)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("commissions", [{"amount": "1 USDT"}]),
        ("linked_order_ids", [7]),
        ("venue_order_ids", [{"id": "venue-1"}]),
    ],
)
def test_report_list_items_use_their_committed_scalar_shapes(field: str, value: object) -> None:
    if field in {"commissions", "linked_order_ids"}:
        frame = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
            "client_order_id"
        )
    else:
        frame = pd.DataFrame([{"position_id": "position-1", **_position_columns()}]).set_index(
            "position_id"
        )
    frame[field] = frame[field].astype(object)
    frame.iloc[0, frame.columns.get_loc(field)] = value

    with pytest.raises(ReportSchemaError):
        export_dataframe_report("orders" if field != "venue_order_ids" else "positions", frame)


def test_report_enums_and_fill_commission_currency_are_closed() -> None:
    orders = pd.DataFrame([{"client_order_id": "order-a", **_order_columns("1")}]).set_index(
        "client_order_id"
    )
    orders["side"] = orders["side"].astype(object)
    orders.loc["order-a", "side"] = "NOT_A_SIDE"
    with pytest.raises(ReportSchemaError, match="side"):
        export_dataframe_report("orders", orders)

    orders.loc["order-a", "side"] = "BUY"
    orders["emulation_trigger"] = orders["emulation_trigger"].astype(object)
    orders.loc["order-a", "emulation_trigger"] = "NOT_A_TRIGGER"
    with pytest.raises(ReportSchemaError, match="emulation_trigger"):
        export_dataframe_report("orders", orders)

    fills = pd.DataFrame(
        [{"client_order_id": "order-a", **_fill_columns("1", "trade-a")}]
    ).set_index("client_order_id")
    fills["commission"] = fills["commission"].astype(object)
    fills.loc["order-a", "commission"] = "1 USD"
    with pytest.raises(ReportSchemaError, match="commission currency"):
        export_dataframe_report("fills", fills)

    positions = pd.DataFrame([{"position_id": "position-1", **_position_columns()}]).set_index(
        "position_id"
    )
    event = _position_order_filled_event()
    event["order_side"] = "NOT_A_SIDE"
    positions["events"] = positions["events"].astype(object)
    positions.loc["position-1", "events"] = [event]
    with pytest.raises(ReportSchemaError, match="order_side"):
        export_dataframe_report("positions", positions)


def test_metrics_export_converts_only_declared_finite_float_metrics() -> None:
    source = _complete_metrics(0.25)
    source["stats_returns"] = {key: 1.5 for key in source["stats_returns"]}
    source["stats_general"] = {"Long Ratio": 0.5}
    metrics = export_metrics(source)

    assert metrics["stats_pnls"]["USD"]["Win Rate"] == "0.25"
    assert metrics["stats_returns"]["Sharpe Ratio (252 days)"] == "1.5"
    with pytest.raises(ReportSchemaError, match="unknown metric"):
        export_metrics(
            {
                "summary": _summary(),
                "stats_pnls": {"USD": {"Other": 1.0}},
                "stats_returns": {},
                "stats_general": {},
            }
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_metrics_reject_nan_and_infinity(value: float) -> None:
    source = _complete_metrics(value)
    with pytest.raises(ReportSchemaError, match="finite"):
        export_metrics(source)


def test_metrics_explicitly_accept_legacy_and_validate_current_series_idempotently() -> None:
    legacy = export_metrics(_complete_metrics(0.25))
    assert set(legacy) == {
        "summary",
        "stats_pnls",
        "stats_returns",
        "stats_general",
    }
    current = {**legacy, "performance_series": _performance_series()}

    normalized = export_metrics(current)

    assert normalized == current
    assert (
        validate_portfolio_equity_series(normalized["performance_series"])
        == (normalized["performance_series"])
    )


def test_performance_series_preserves_equal_timestamps_and_exact_running_peak_math() -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[1]["ts_event_ns"] = points[0]["ts_event_ns"]

    normalized = validate_portfolio_equity_series(series)

    assert [
        point["point_index"] for point in cast(list[dict[str, object]], normalized["points"])
    ] == [0, 1, 2]
    assert cast(list[dict[str, object]], normalized["points"])[1]["drawdown_pct"] == "-10"


def _decimal_context_state(context: Context) -> tuple[object, ...]:
    return (
        context.prec,
        context.rounding,
        context.Emin,
        context.Emax,
        context.capitals,
        context.clamp,
        dict(context.flags),
        dict(context.traps),
    )


def test_native_portfolio_series_ignores_hostile_ambient_decimal_context() -> None:
    account = SimpleNamespace(id="SIM-001")
    snapshots = [
        SimpleNamespace(
            account_id=account.id,
            is_stale=False,
            stale_instruments=[],
            stale_currencies=[],
            unpriced_instruments=[],
            total_equity=[Money.from_str(f"{amount} USDT")],
            ts_event=index + 10,
        )
        for index, amount in enumerate(("3", "2"))
    ]
    portfolio = SimpleNamespace(
        account=lambda _venue: account,
        snapshots=lambda _account_id: snapshots,
    )
    node = SimpleNamespace(get_engine_portfolio=lambda _run_config_id: portfolio)
    baseline = export_portfolio_equity_series(cast(Any, node), "config-1", Venue("SIM"))

    with localcontext() as ambient:
        ambient.prec = 2
        ambient.rounding = ROUND_DOWN
        ambient.Emin = 0
        ambient.Emax = 9
        ambient.capitals = 0
        ambient.clamp = 1
        ambient.flags[Underflow] = True
        ambient.traps[Inexact] = True
        ambient.traps[Underflow] = True
        ambient_state = _decimal_context_state(ambient)
        hostile = export_portfolio_equity_series(cast(Any, node), "config-1", Venue("SIM"))
        assert _decimal_context_state(ambient) == ambient_state

    assert hostile == baseline
    points = cast(list[dict[str, object]], hostile["points"])
    assert [point["drawdown_pct"] for point in points] == [
        "0",
        "-33.33333333333333333333333333333333",
    ]


def test_persisted_performance_series_ignores_hostile_ambient_decimal_context() -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[:] = [
        {**points[0], "equity_amount": "3", "drawdown_pct": "0"},
        {
            **points[1],
            "equity_amount": "2.99999999",
            "drawdown_pct": "-0.0000003333333333333333333333333333333333",
        },
    ]
    baseline = validate_portfolio_equity_series(series)

    with localcontext() as ambient:
        ambient.prec = 2
        ambient.rounding = ROUND_DOWN
        ambient.Emin = 0
        ambient.Emax = 9
        ambient.capitals = 0
        ambient.clamp = 1
        ambient.flags[Underflow] = True
        ambient.traps[Inexact] = True
        ambient.traps[Underflow] = True
        ambient_state = _decimal_context_state(ambient)
        hostile = validate_portfolio_equity_series(series)
        assert _decimal_context_state(ambient) == ambient_state

    assert hostile == baseline == series


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("equity_amount", "1e999999999"),
        ("equity_amount", "1e-999999999"),
        ("drawdown_pct", "0e999999999"),
        ("drawdown_pct", "0e-999999999"),
    ],
    ids=[
        "equity-positive-exponent",
        "equity-negative-exponent",
        "drawdown-positive-exponent",
        "drawdown-negative-exponent",
    ],
)
@pytest.mark.parametrize("entrypoint", ["validator", "metrics-export"])
def test_performance_series_rejects_exponent_syntax_before_decimal_expansion(
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str,
    entrypoint: str,
) -> None:
    real_formatter = report_export_module.canonical_decimal_string

    def expansion_guard(value: Decimal) -> str:
        exponent = value.as_tuple().exponent
        if isinstance(exponent, int) and abs(exponent) > 1_000:
            raise AssertionError("exponent input reached fixed-point formatting")
        return real_formatter(value)

    monkeypatch.setattr(report_export_module, "canonical_decimal_string", expansion_guard)
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[1][field] = value
    if field == "equity_amount":
        points[1]["drawdown_pct"] = "0"
    del points[2:]

    with pytest.raises(ReportSchemaError, match="canonical"):
        if entrypoint == "validator":
            validate_portfolio_equity_series(series)
        else:
            export_metrics({**_complete_metrics(0.25), "performance_series": series})


@pytest.mark.parametrize(
    ("currency", "equity_amount", "accepted"),
    [
        ("USDT", "0.00000001", True),
        ("USDT", "0.000000001", False),
        ("USDT", "1.000000001", False),
        ("USDT", "17014118346046", True),
        ("USDT", "17014118346046.00000001", False),
        ("USDT", "17014118346045.000000001", False),
        ("JPY", "1", True),
        ("JPY", "1.1", False),
        ("usdt", "1", False),
        ("NOT-A-CURRENCY", "1", False),
    ],
)
@pytest.mark.parametrize("entrypoint", ["validator", "metrics-export"])
def test_performance_equity_must_round_trip_through_declared_currency_money(
    currency: str,
    equity_amount: str,
    accepted: bool,
    entrypoint: str,
) -> None:
    series = _performance_series()
    series["currency"] = currency
    points = cast(list[dict[str, object]], series["points"])
    points[:] = [
        {
            **points[0],
            "equity_amount": equity_amount,
            "drawdown_pct": "0",
        }
    ]

    def invoke() -> object:
        if entrypoint == "validator":
            return validate_portfolio_equity_series(series)
        return export_metrics({**_complete_metrics(0.25), "performance_series": series})

    if accepted:
        assert invoke() is not None
    else:
        with pytest.raises(ReportSchemaError, match="native Money"):
            invoke()


@pytest.mark.parametrize(
    "timestamp",
    [str(2**64), "9" * 5_000],
    ids=["u64-plus-one", "interpreter-digit-limit"],
)
@pytest.mark.parametrize("entrypoint", ["validator", "metrics-export"])
def test_performance_timestamp_rejects_values_outside_native_u64_before_int(
    timestamp: str,
    entrypoint: str,
) -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[:] = [{**points[0], "ts_event_ns": timestamp}]

    with pytest.raises(ReportSchemaError, match="native timestamp domain"):
        if entrypoint == "validator":
            validate_portfolio_equity_series(series)
        else:
            export_metrics({**_complete_metrics(0.25), "performance_series": series})


def test_native_portfolio_series_rejects_timestamp_above_u64() -> None:
    account = SimpleNamespace(id="SIM-001")
    snapshot = SimpleNamespace(
        account_id=account.id,
        is_stale=False,
        stale_instruments=[],
        stale_currencies=[],
        unpriced_instruments=[],
        total_equity=[Money.from_str("100 USDT")],
        ts_event=2**64,
    )
    portfolio = SimpleNamespace(
        account=lambda _venue: account,
        snapshots=lambda _account_id: [snapshot],
    )
    node = SimpleNamespace(get_engine_portfolio=lambda _run_config_id: portfolio)

    with pytest.raises(ReportSchemaError, match="native timestamp domain"):
        export_portfolio_equity_series(cast(Any, node), "config-1", Venue("SIM"))


def test_native_portfolio_series_accepts_exact_u64_maximum() -> None:
    account = SimpleNamespace(id="SIM-001")
    snapshot = SimpleNamespace(
        account_id=account.id,
        is_stale=False,
        stale_instruments=[],
        stale_currencies=[],
        unpriced_instruments=[],
        total_equity=[Money.from_str("100 USDT")],
        ts_event=(2**64) - 1,
    )
    portfolio = SimpleNamespace(
        account=lambda _venue: account,
        snapshots=lambda _account_id: [snapshot],
    )
    node = SimpleNamespace(get_engine_portfolio=lambda _run_config_id: portfolio)

    exported = export_portfolio_equity_series(cast(Any, node), "config-1", Venue("SIM"))

    assert exported["points"][0]["ts_event_ns"] == str((2**64) - 1)


def test_performance_timestamp_accepts_exact_u64_maximum() -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[:] = [{**points[0], "ts_event_ns": str((2**64) - 1)}]

    assert validate_portfolio_equity_series(series)["points"] == points


@pytest.mark.parametrize("timestamp", ["１２", "١٢"])
def test_performance_timestamp_rejects_non_ascii_decimal_digits(timestamp: str) -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[:] = [{**points[0], "ts_event_ns": timestamp}]

    with pytest.raises(ReportSchemaError, match="ASCII"):
        validate_portfolio_equity_series(series)


@pytest.mark.parametrize(
    "equity_amount",
    ["1" + ("0" * 1_000_000), "-1" + ("0" * 1_000_000)],
    ids=["huge-positive", "huge-negative"],
)
@pytest.mark.parametrize("entrypoint", ["validator", "metrics-export"])
def test_performance_series_rejects_equity_outside_native_money_domain_as_schema_error(
    equity_amount: str,
    entrypoint: str,
) -> None:
    series = _performance_series()
    points = cast(list[dict[str, object]], series["points"])
    points[1]["equity_amount"] = equity_amount
    points[1]["drawdown_pct"] = "0"
    del points[2:]

    with pytest.raises(ReportSchemaError, match="native Money domain"):
        if entrypoint == "validator":
            validate_portfolio_equity_series(series)
        else:
            export_metrics({**_complete_metrics(0.25), "performance_series": series})


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("schema",), "PortfolioEquitySeries.v2"),
        (("points", 0, "point_index"), True),
        (("points", 1, "point_index"), 7),
        (("points", 0, "ts_event_ns"), "01"),
        (("points", 1, "ts_event_ns"), "9"),
        (("points", 0, "equity_amount"), "100.0"),
        (("points", 1, "drawdown_pct"), "-9"),
        (("points", 0, "is_stale"), True),
        (("points", 0, "stale_instruments"), ["ETH/USDT.SIM"]),
        (("points", 0, "stale_currencies"), ["USDT"]),
        (("points", 0, "unpriced_instruments"), ["ETH/USDT.SIM"]),
    ],
)
def test_performance_series_rejects_identity_order_numeric_or_quality_tamper(
    path: tuple[str | int, ...],
    value: object,
) -> None:
    series = deepcopy(_performance_series())
    target: Any = series
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value

    with pytest.raises(ReportSchemaError):
        validate_portfolio_equity_series(series)


@pytest.mark.parametrize(
    "snapshots",
    [
        [],
        [
            SimpleNamespace(
                account_id="OTHER-001",
                is_stale=False,
                stale_instruments=[],
                stale_currencies=[],
                unpriced_instruments=[],
                total_equity=[Money.from_str("100 USDT")],
                ts_event=1,
            )
        ],
        [
            SimpleNamespace(
                account_id="SIM-001",
                is_stale=True,
                stale_instruments=[],
                stale_currencies=[],
                unpriced_instruments=[],
                total_equity=[Money.from_str("100 USDT")],
                ts_event=1,
            )
        ],
        [
            SimpleNamespace(
                account_id="SIM-001",
                is_stale=False,
                stale_instruments=[],
                stale_currencies=[],
                unpriced_instruments=[],
                total_equity=[Money.from_str("100 USDT"), Money.from_str("1 USD")],
                ts_event=1,
            )
        ],
        [
            SimpleNamespace(
                account_id="SIM-001",
                is_stale=False,
                stale_instruments=[],
                stale_currencies=[],
                unpriced_instruments=[],
                total_equity=[object()],
                ts_event=1,
            )
        ],
    ],
)
def test_native_portfolio_series_rejects_missing_ambiguous_or_dirty_snapshots(
    snapshots: list[object],
) -> None:
    account = SimpleNamespace(id="SIM-001")
    portfolio = SimpleNamespace(
        account=lambda _venue: account,
        snapshots=lambda _account_id: snapshots,
    )
    node = SimpleNamespace(get_engine_portfolio=lambda _run_config_id: portfolio)

    with pytest.raises(ReportSchemaError):
        export_portfolio_equity_series(cast(Any, node), "config-1", Venue("SIM"))


def test_positions_allow_only_the_three_checked_in_finite_float_paths() -> None:
    frame = pd.DataFrame([{"position_id": "position-1", **_position_columns()}]).set_index(
        "position_id"
    )
    for field in ("avg_px_open", "avg_px_close", "realized_return"):
        candidate = frame.copy()
        if field == "avg_px_close":
            candidate.loc["position-1", "closing_order_id"] = "order-2"
            candidate.loc["position-1", "side"] = "FLAT"
            candidate.loc["position-1", "quantity"] = "0"
            candidate.loc["position-1", "ts_closed"] = 3
        candidate[field] = candidate[field].astype(object)
        candidate.loc["position-1", field] = 1.25
        assert export_dataframe_report("positions", candidate)[0][field] == "1.25"

    frame["quantity"] = frame["quantity"].astype(object)
    frame.loc["position-1", "quantity"] = 1.25
    with pytest.raises(ReportSchemaError):
        export_dataframe_report("positions", frame)


def test_fills_and_account_schemas_sort_by_their_static_primary_keys() -> None:
    fills = pd.DataFrame(
        [
            {"client_order_id": "order-b", **_fill_columns("20", "trade-b")},
            {"client_order_id": "order-a", **_fill_columns("10", "trade-a")},
        ]
    ).set_index("client_order_id")
    account = pd.DataFrame(
        [
            {"total": "10", **_account_columns("10")},
            {"total": "2", **_account_columns("2")},
        ],
        index=pd.Index([10, 2], name="timestamp"),
    )

    assert [row["trade_id"] for row in export_dataframe_report("fills", fills)] == [
        "trade-a",
        "trade-b",
    ]
    assert [row["ts_event_ns"] for row in export_dataframe_report("account", account)] == [
        "2",
        "10",
    ]


def test_real_rc3_no_order_reports_use_only_the_exact_zero_by_zero_signature(
    tmp_path: Path,
) -> None:
    node, run_config = _no_order_node(tmp_path)
    try:
        for kind, report in (
            ("orders", node.generate_orders_report(run_config.id)),
            ("fills", node.generate_fills_report(run_config.id)),
            ("positions", node.generate_positions_report(run_config.id)),
        ):
            assert report.shape == (0, 0)
            assert isinstance(report.index, pd.RangeIndex)
            assert report.index.name is None
            assert export_dataframe_report(kind, report) == []
    finally:
        node.dispose()


def test_no_order_rc3_account_is_populated_and_synthetic_empty_account_is_rejected(
    tmp_path: Path,
) -> None:
    node, run_config = _no_order_node(tmp_path)
    try:
        account = node.generate_account_report(run_config.id, venue=Venue("SIM"))
        assert account.shape[0] > 0
        assert export_dataframe_report("account", account)
    finally:
        node.dispose()

    with pytest.raises(ReportSchemaError, match="missing fields"):
        export_dataframe_report("account", pd.DataFrame())


def test_report_decimal_strings_and_duplicate_primary_keys_are_closed() -> None:
    orders = pd.DataFrame(
        [
            {"client_order_id": "order-a", **_order_columns("6.000")},
            {"client_order_id": "order-a", **_order_columns("6.000")},
        ]
    ).set_index("client_order_id")
    with pytest.raises(ReportSchemaError, match="duplicate"):
        export_dataframe_report("orders", orders)

    single = orders.iloc[:1]
    assert export_dataframe_report("orders", single)[0]["quantity"] == "6"


def test_metrics_summary_requires_the_static_rc3_summary_schema() -> None:
    with pytest.raises(ReportSchemaError, match="summary"):
        export_metrics(
            {
                "summary": {"Total Orders": "1"},
                "stats_pnls": {},
                "stats_returns": {},
                "stats_general": {},
            }
        )


def test_metrics_summary_accepts_closed_non_sim_venue_currency_groups() -> None:
    metrics = _complete_metrics(0.25)
    summary = _summary()
    for key in list(summary):
        if key.startswith("account.SIM"):
            summary[key.replace("account.SIM", "account.BINANCE").replace("USDT", "USD")] = (
                summary.pop(key).replace("USDT", "USD")
            )
    metrics["summary"] = summary

    exported = export_metrics(metrics)["summary"]
    assert isinstance(exported, dict)
    assert exported["account.BINANCE.balance.USD.total"] == "1000000 USD"


@pytest.mark.parametrize("key", ["account.BINANCE.surprise", "account.BINANCE.balance.USD.free"])
def test_metrics_summary_rejects_unknown_or_incomplete_dynamic_groups(key: str) -> None:
    metrics = _complete_metrics(0.25)
    summary = _summary()
    summary[key.replace("BINANCE", "SIM").replace("USD", "USDT")] = "bad"
    if key.endswith("free"):
        del summary["account.SIM.balance.USDT.locked"]
    metrics["summary"] = summary

    with pytest.raises(ReportSchemaError, match="summary"):
        export_metrics(metrics)


def test_metrics_summary_rejects_a_complete_account_without_a_matching_balance() -> None:
    metrics = _complete_metrics(0.25)
    summary = _summary()
    summary.update(
        {
            "account.EXTRA.id": "EXTRA-001",
            "account.EXTRA.type": "MARGIN",
            "account.EXTRA.event_count": "0",
            "account.EXTRA.base_currency": "USDC",
        }
    )
    metrics["summary"] = summary

    with pytest.raises(ReportSchemaError, match="summary"):
        export_metrics(metrics)


def test_metrics_summary_canonicalizes_money_balance_and_requires_complete_balance_group() -> None:
    metrics = _complete_metrics(0.25)

    exported = export_metrics(metrics)["summary"]
    assert isinstance(exported, dict)
    assert exported["account.SIM.balance.USDT.total"] == "1000000 USDT"
    assert exported["account.SIM.balance.USDT.locked"] == "0 USDT"

    incomplete = _complete_metrics(0.25)
    for key in list(incomplete["summary"]):
        if ".balance.USDT." in key:
            del incomplete["summary"][key]
    with pytest.raises(ReportSchemaError, match="summary"):
        export_metrics(incomplete)


def test_metrics_reject_noncanonical_fixed_counts_and_decimal_strings() -> None:
    metrics = _complete_metrics(0.25)
    metrics["summary"]["orders.total"] = "not-a-count"
    with pytest.raises(ReportSchemaError, match="summary"):
        export_metrics(metrics)

    metrics = _complete_metrics(0.25)
    metrics["stats_returns"]["Sharpe Ratio (252 days)"] = "1.0"
    exported = export_metrics(metrics)
    assert exported["stats_returns"]["Sharpe Ratio (252 days)"] == "1"


def test_account_equal_primary_keys_use_economic_tie_breaker_and_reject_exact_duplicate() -> None:
    rows = [
        {"total": "2.00000000", **_account_columns("20")},
        {"total": "1.00000000", **_account_columns("20")},
    ]
    account = pd.DataFrame(rows, index=pd.Index([20, 20], name="timestamp"))
    reversed_account = account.iloc[::-1]

    assert export_dataframe_report("account", account) == export_dataframe_report(
        "account", reversed_account
    )
    with pytest.raises(ReportSchemaError, match="duplicate"):
        export_dataframe_report("account", pd.concat([account.iloc[:1], account.iloc[:1]]))


def test_account_uses_rc3_decimal_paths_without_parsing_money_strings() -> None:
    account = pd.DataFrame(
        [
            {
                **_account_columns("20"),
                "total": "1000000.00000000",
                "locked": "30.00000000",
                "free": "999970.00000000",
                "margins": [
                    {
                        "type": "MarginBalance",
                        "initial": "60.00000000",
                        "maintenance": "30.00000000",
                        "currency": "USDT",
                        "instrument_id": "ETH/USDT.SIM",
                    }
                ],
            }
        ],
        index=pd.Index([20], name="timestamp"),
    )

    row = export_dataframe_report("account", account)[0]

    assert row["total"] == "1000000"
    assert row["locked"] == "30"
    assert row["free"] == "999970"
    margins = row["margins"]
    assert isinstance(margins, list)
    assert margins == [
        {
            "type": "MarginBalance",
            "initial": "60",
            "maintenance": "30",
            "currency": "USDT",
            "instrument_id": "ETH/USDT.SIM",
        }
    ]


def test_real_rc3_probe_positions_export_with_full_nested_order_filled_events(
    tmp_path: Path,
) -> None:
    result = run_compat_probe(tmp_path)

    rows = export_dataframe_report("positions", result.positions)

    assert len(rows) == 1
    events = rows[0]["events"]
    assert isinstance(events, list)
    assert events[0]["last_qty"] == "5"


def test_real_rc3_probe_orders_preserve_nullable_lists_and_canonicalize_nested_events(
    tmp_path: Path,
) -> None:
    result = run_compat_probe(tmp_path)

    orders = export_dataframe_report("orders", result.orders)
    positions = export_dataframe_report("positions", result.positions)

    assert orders[0]["linked_order_ids"] is None
    assert orders[0]["tags"] is None
    events = positions[0]["events"]
    assert isinstance(events, list)
    assert events[0]["last_qty"] == "5"
    assert events[0]["last_px"] == "100"
    assert events[0]["ts_event"] == "1700000000000000000"


def _order_columns(quantity: str) -> dict[str, object]:
    return {
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "side": "BUY",
        "type": "LIMIT",
        "quantity": Decimal(quantity),
        "price": Decimal("100"),
        "status": "FILLED",
        "time_in_force": "GTC",
        "expire_time_ns": None,
        "is_post_only": False,
        "is_reduce_only": False,
        "is_quote_quantity": False,
        "filled_qty": Decimal(quantity),
        "init_id": "init-1",
        "ts_init": 1,
        "ts_last": 2,
        "commissions": [],
        "venue_order_id": "venue-1",
        "display_qty": None,
        "emulation_trigger": "NO_TRIGGER",
        "trigger_instrument_id": None,
        "contingency_type": "NO_CONTINGENCY",
        "order_list_id": None,
        "linked_order_ids": [],
        "parent_order_id": None,
        "exec_algorithm_id": None,
        "exec_algorithm_params": None,
        "exec_spawn_id": None,
        "tags": [],
        "account_id": "SIM-001",
        "slippage": None,
        "position_id": "position-1",
        "liquidity_side": "TAKER",
        "last_trade_id": "trade-1",
        "avg_px": Decimal("100"),
    }


def _summary() -> dict[str, str]:
    return {
        "orders.total": "1",
        "orders.closed": "1",
        "orders.inflight": "0",
        "orders.emulated": "0",
        "orders.open": "0",
        "positions.total": "1",
        "positions.total_with_snapshots": "1",
        "positions.open": "1",
        "positions.closed": "0",
        "positions.snapshots": "0",
        "total_events": "1",
        "iterations": "2",
        "venues.total": "1",
        "account.SIM.id": "SIM-001",
        "account.SIM.type": "MARGIN",
        "account.SIM.event_count": "1",
        "account.SIM.base_currency": "None",
        "account.SIM.balance.USDT.total": "1000000.00000000 USDT",
        "account.SIM.balance.USDT.locked": "0.00000000 USDT",
        "account.SIM.balance.USDT.free": "1000000.00000000 USDT",
    }


def _complete_metrics(value: float) -> dict[str, object]:
    return {
        "summary": _summary(),
        "stats_pnls": {
            "USD": {
                "Max Winner": value,
                "Win Rate": value,
                "PnL% (total)": value,
                "Min Winner": value,
                "PnL (total)": value,
                "Avg Winner": value,
                "Expectancy": value,
                "Avg Loser": value,
                "Min Loser": value,
                "Max Loser": value,
            }
        },
        "stats_returns": {
            "Sortino Ratio (252 days)": value,
            "Tail Ratio": value,
            "Average Loss (Return)": value,
            "Average (Return)": value,
            "Sharpe Ratio (252 days)": value,
            "Average Win (Return)": value,
            "Returns Kurtosis": value,
            "Profit Factor": value,
            "Returns Volatility (252 days)": value,
            "Risk Return Ratio": value,
            "Returns Skewness": value,
        },
        "stats_general": {"Long Ratio": value},
    }


def _performance_series() -> dict[str, object]:
    return {
        "schema": "PortfolioEquitySeries.v1",
        "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
        "selection": "SOLE_TOTAL_EQUITY",
        "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
        "account_id": "SIM-001",
        "currency": "USDT",
        "points": [
            {
                "point_index": 0,
                "ts_event_ns": "10",
                "equity_amount": "100",
                "drawdown_pct": "0",
                "is_stale": False,
                "stale_instruments": [],
                "stale_currencies": [],
                "unpriced_instruments": [],
            },
            {
                "point_index": 1,
                "ts_event_ns": "11",
                "equity_amount": "90",
                "drawdown_pct": "-10",
                "is_stale": False,
                "stale_instruments": [],
                "stale_currencies": [],
                "unpriced_instruments": [],
            },
            {
                "point_index": 2,
                "ts_event_ns": "12",
                "equity_amount": "110",
                "drawdown_pct": "0",
                "is_stale": False,
                "stale_instruments": [],
                "stale_currencies": [],
                "unpriced_instruments": [],
            },
        ],
    }


def _fill_columns(ts_event: str, trade_id: str) -> dict[str, object]:
    return {
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "venue_order_id": "venue-1",
        "account_id": "SIM-001",
        "trade_id": trade_id,
        "order_side": "BUY",
        "order_type": "LIMIT",
        "last_qty": "1",
        "last_px": "100",
        "currency": "USDT",
        "liquidity_side": "TAKER",
        "event_id": "native-event",
        "ts_event": int(ts_event),
        "ts_init": int(ts_event),
        "reconciliation": False,
        "info": {},
        "position_id": "position-1",
        "commission": "0 USDT",
        "causation_id": "cause-1",
    }


def _account_columns(timestamp: str) -> dict[str, object]:
    return {
        "locked": "0",
        "free": "1",
        "currency": "USDT",
        "account_id": "SIM-001",
        "account_type": "MARGIN",
        "margins": [],
        "reported": True,
        "info": {},
        "base_currency": None,
    }


def _position_columns() -> dict[str, object]:
    return {
        "type": "Position",
        "events": [],
        "adjustments": [],
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETHUSDT.SIM",
        "account_id": "SIM-001",
        "opening_order_id": "order-1",
        "closing_order_id": None,
        "entry": "BUY",
        "side": "LONG",
        "quantity": "1",
        "peak_qty": "1",
        "price_precision": 2,
        "size_precision": 3,
        "multiplier": "1",
        "is_inverse": False,
        "ts_init": 1,
        "ts_opened": 2,
        "ts_last": 2,
        "ts_closed": None,
        "duration_ns": 0,
        "avg_px_open": "100",
        "avg_px_close": None,
        "realized_return": "0",
        "realized_pnl": "0 USDT",
        "venue_order_ids": ["venue-1"],
        "trade_ids": ["trade-1"],
        "buy_qty": "1",
        "sell_qty": "0",
        "commissions": [],
        "is_snapshot": False,
    }


def _position_order_filled_event() -> dict[str, object]:
    return {
        "type": "OrderFilled",
        "trader_id": "TRADER-001",
        "strategy_id": "probe",
        "instrument_id": "ETH/USDT.SIM",
        "client_order_id": "order-1",
        "venue_order_id": "venue-1",
        "account_id": "SIM-001",
        "trade_id": "trade-1",
        "order_side": "BUY",
        "order_type": "LIMIT",
        "last_qty": "5.000",
        "last_px": "100.00",
        "currency": "USDT",
        "liquidity_side": "TAKER",
        "event_id": "native-event",
        "ts_event": 1700000000000000000,
        "ts_init": 1700000000000000000,
        "reconciliation": False,
        "info": None,
        "position_id": "position-1",
        "commission": "0.00000000 USDT",
        "causation_id": None,
    }


def _no_order_node(tmp_path: Path) -> tuple[BacktestNode, BacktestRunConfig]:
    catalog_path, instrument = _write_catalog(tmp_path)
    run_config = BacktestRunConfig(
        venues=[
            BacktestVenueConfig(
                name="SIM",
                oms_type=OmsType.HEDGING,
                account_type=AccountType.MARGIN,
                book_type=BookType.L1_MBP,
                starting_balances=["1_000_000 USDT"],
            )
        ],
        data=[
            BacktestDataConfig(
                data_type="QuoteTick",
                catalog_path=str(catalog_path),
                instrument_id=instrument.id,
            )
        ],
        engine=BacktestEngineConfig(bypass_logging=True, run_analysis=True),
        dispose_on_completion=False,
        id="rc3-no-orders",
    )
    node = BacktestNode(configs=[run_config])
    node.build()
    node.run()
    return node, run_config
