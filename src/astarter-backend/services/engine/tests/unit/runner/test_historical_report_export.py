"""Actual native table projection plus explicitly synthetic row-contract edge cases."""

from copy import deepcopy
from decimal import Decimal

import pytest

from stark_trading_os.runner.historical_report_export import (
    MARKET_ORDER_SCHEMA_V2,
    export_historical_market_orders_v2,
    normalize_historical_market_order_v2,
)
from stark_trading_os.runner.report_export import ReportSchemaError, export_dataframe_report, pd
from tests.integration.runner.sma_component_fixture import execute_sma_case, prepare_sma_case


@pytest.fixture(scope="module")
def native_frames(tmp_path_factory):
    frames = {}
    cases = [
        ("warmup", [100, 100, 110], {}, {}),
        ("entry", [100, 100, 100, 110], {}, {}),
        ("round_trip", [100, 100, 100, 110, 100, 90], {}, {}),
        ("denied", [100, 100, 100, 110], {}, {"native_order_cap": "100"}),
        ("rejected", [100, 100, 100, 110], {"volume": "0.000"}, {}),
        (
            "split",
            [100, 100, 100, 110],
            {"quantity": "250", "max_position": "500", "cash": "100000", "max_notional": "100000"},
            {},
        ),
    ]
    for name, closes, params, execution in cases:
        captured = {}

        def capture(strategy, engine):
            captured["orders"] = engine.generate_orders_report().copy(deep=True)
            captured["fills"] = engine.generate_fills_report().copy(deep=True)

        result = execute_sma_case(
            prepare_sma_case(tmp_path_factory.mktemp(name), closes, **params),
            after_run=capture,
            **execution,
        )
        assert result["status"] == "COMPONENT_CHECK_PASSED"
        frames[name] = captured
    return frames


def _raw_row(native_frames, case="entry"):
    return deepcopy(native_frames[case]["orders"].reset_index().iloc[0].to_dict())


def test_actual_warmup_frame_is_exact_native_empty(native_frames):
    assert export_historical_market_orders_v2(native_frames["warmup"]["orders"]) == []


@pytest.mark.parametrize("case", ["entry", "round_trip", "denied", "rejected", "split"])
def test_actual_native_market_rows_retain_only_observed_fields_and_exact_values(
    native_frames, case
):
    frame = native_frames[case]["orders"]
    before = deepcopy(frame.reset_index().to_dict(orient="records"))
    rows = export_historical_market_orders_v2(frame)
    assert len(MARKET_ORDER_SCHEMA_V2.fields) == 31
    assert set(frame.columns) == set(MARKET_ORDER_SCHEMA_V2.fields)
    assert len(rows) == len(frame)
    for row in rows:
        assert row["type"] == "MARKET"
        assert set(row) == {"client_order_id", *MARKET_ORDER_SCHEMA_V2.fields}
        assert not {
            "price",
            "expire_time_ns",
            "is_post_only",
            "display_qty",
            "trigger_instrument_id",
        } & set(row)
        assert type(row["ts_init"]) is str and type(row["ts_last"]) is str
        assert row["ts_init"].isascii() and row["ts_init"].isdigit()
        assert normalize_historical_market_order_v2(row) == row
    if case in {"denied", "rejected"}:
        assert rows[0]["status"] == case.upper()
        assert rows[0]["filled_qty"] == "0"
        for field in ("commissions", "venue_order_id", "position_id", "last_trade_id", "avg_px"):
            assert rows[0][field] is None
    else:
        assert all(row["status"] == "FILLED" for row in rows)
        source_commissions = native_frames[case]["fills"]["commission"].tolist()
        source_total = sum(Decimal(value.split()[0]) for value in source_commissions)
        output_total = sum(
            Decimal(value.split()[0]) for row in rows for value in row["commissions"]
        )
        assert source_total == output_total
    assert frame.reset_index().to_dict(orient="records") == before
    with pytest.raises(ReportSchemaError, match="missing fields"):
        export_dataframe_report("orders", frame)


@pytest.mark.parametrize(
    "mutation", ["missing", "extra", "duplicate_columns", "index", "duplicate_id", "false_empty"]
)
def test_invalid_dataframe_shape_does_not_silently_drop_information(native_frames, mutation):
    frame = native_frames["entry"]["orders"].copy(deep=True)
    if mutation == "missing":
        frame = frame.drop(columns=["quantity"])
    elif mutation == "extra":
        frame["price"] = None
    elif mutation == "duplicate_columns":
        frame = pd.concat([frame, frame[["quantity"]]], axis=1)
    elif mutation == "index":
        frame.index.name = "incorrect_id"
    elif mutation == "duplicate_id":
        frame = pd.concat([frame, frame])
    else:
        frame = pd.DataFrame(index=pd.Index([], name="client_order_id"))
    with pytest.raises(ReportSchemaError):
        export_historical_market_orders_v2(frame)


def test_two_native_rows_are_sorted_by_client_identity(native_frames):
    frame = native_frames["round_trip"]["orders"].iloc[::-1]
    rows = export_historical_market_orders_v2(frame)
    assert [row["client_order_id"] for row in rows] == sorted(frame.index.tolist())


@pytest.mark.parametrize(
    "field",
    ["commissions", "venue_order_id", "account_id", "position_id", "last_trade_id", "avg_px"],
)
def test_filled_order_cannot_lose_native_fill_facts(native_frames, field):
    row = _raw_row(native_frames)
    row[field] = None
    with pytest.raises(ReportSchemaError):
        normalize_historical_market_order_v2(row)


@pytest.mark.parametrize(
    "value",
    [
        True,
        1.5,
        -1,
        2**64,
        "01700000240000000000",
        "١٧٠٠٠٠٠٢٤٠٠٠٠٠٠٠٠٠٠",
        "",
        "18446744073709551616",
    ],
)
def test_order_timestamps_are_exact_canonical_unsigned64(native_frames, value):
    row = _raw_row(native_frames)
    row["ts_init"] = value
    with pytest.raises(ReportSchemaError):
        normalize_historical_market_order_v2(row)


def test_canonical_unsigned64_boundary_round_trips(native_frames):
    row = _raw_row(native_frames)
    row["ts_init"] = row["ts_last"] = str(2**64 - 1)
    normalized = normalize_historical_market_order_v2(row)
    assert normalized["ts_init"] == normalized["ts_last"] == str(2**64 - 1)


@pytest.mark.parametrize(
    "changes",
    [
        {"type": "LIMIT"},
        {"status": "MADE_UP"},
        {"quantity": "0"},
        {"quantity": "-1"},
        {"filled_qty": "-1"},
        {"filled_qty": "2"},
        {"filled_qty": "0"},
        {"status": "PARTIALLY_FILLED"},
        {"status": "DENIED"},
        {"status": "REJECTED"},
        {"quantity": 1.0},
        {"avg_px": "0"},
        {"client_order_id": " "},
        {"trader_id": ""},
        {"ts_last": "0"},
    ],
)
def test_market_projection_rejects_contradictory_or_inexact_rows(native_frames, changes):
    row = _raw_row(native_frames)
    row.update(changes)
    with pytest.raises(ReportSchemaError):
        normalize_historical_market_order_v2(row)


@pytest.mark.parametrize("status", ["ACCEPTED", "PENDING_CANCEL", "CANCELED"])
def test_zero_fill_pending_and_cancelled_contract_preserves_unknown_native_facts(
    native_frames, status
):
    # Contract-only mutation. This is NOT proof that this native strategy reaches the status.
    row = _raw_row(native_frames, "denied")
    row["status"] = status
    result = normalize_historical_market_order_v2(row)
    assert result["status"] == status
    assert result["filled_qty"] == "0"
    assert result["commissions"] is result["account_id"] is result["avg_px"] is None


@pytest.mark.parametrize(
    "status",
    ["PARTIALLY_FILLED", "CANCELED", "PENDING_CANCEL", "PENDING_UPDATE", "EXPIRED", "VOIDED"],
)
def test_partial_fill_contract_retains_native_fill_facts(native_frames, status):
    # Contract-only mutation; actual characterization saw split fills ending FILLED.
    row = _raw_row(native_frames)
    row.update(quantity="2", status=status)
    result = normalize_historical_market_order_v2(row)
    assert result["filled_qty"] == "1" and result["quantity"] == "2"
    assert result["avg_px"] == "110"
    assert result["commissions"] == ["0.11 USDT"]


def test_positive_filled_order_rejects_missing_commission_entries(native_frames):
    row = _raw_row(native_frames)
    row["commissions"] = []
    with pytest.raises(ReportSchemaError):
        normalize_historical_market_order_v2(row)


def test_zero_fee_is_preserved_as_explicit_money_fact(native_frames):
    # Contract-only zero-rate representation, not another native execution case.
    row = _raw_row(native_frames)
    row["commissions"] = ["0.00 USDT"]
    assert normalize_historical_market_order_v2(row)["commissions"] == ["0 USDT"]


@pytest.mark.parametrize(
    "status", ["INITIALIZED", "EMULATED", "RELEASED", "SUBMITTED", "ACCEPTED", "TRIGGERED"]
)
def test_unfilled_lifecycle_states_cannot_carry_positive_filled_quantity(native_frames, status):
    row = _raw_row(native_frames)
    row["status"] = status
    with pytest.raises(ReportSchemaError):
        normalize_historical_market_order_v2(row)


def test_projected_nested_values_do_not_alias_input_objects(native_frames):
    row = _raw_row(native_frames)
    row["tags"] = ["original"]
    row["exec_algorithm_params"] = {"nested": ["original"]}
    result = normalize_historical_market_order_v2(row)
    row["tags"].append("changed")
    row["exec_algorithm_params"]["nested"].append("changed")
    assert result["tags"] == ["original"]
    assert result["exec_algorithm_params"] == {"nested": ["original"]}
