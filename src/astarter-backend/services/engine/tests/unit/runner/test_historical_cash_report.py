"""Native finite snapshots and explicitly mutated projection-contract failures."""

from copy import deepcopy
from hashlib import sha256

import pytest

import stark_trading_os.runner.historical_sma as sma
from stark_trading_os.runner.historical_cash_report import normalize_historical_cash_series_v2
from stark_trading_os.runner.historical_sma_policy import SmaGuardDecision
from stark_trading_os.runner.report_export import ReportSchemaError
from tests.integration.runner.sma_component_fixture import execute_sma_case, prepare_sma_case


def _arguments(prepared):
    return {
        "expected_input_sha256": sha256(prepared[3]).hexdigest(),
        "expected_bar_times": tuple((bar.ts_event, bar.ts_init) for bar in prepared[1]),
        "currencies": ("ETH", "USDT"),
    }


@pytest.fixture(scope="module")
def native_snapshots(tmp_path_factory):
    result = {}
    for name, closes in (
        ("warmup", [100, 100, 110]),
        ("entry", [100, 100, 100, 110]),
        ("round_trip", [100, 100, 100, 110, 100, 90]),
    ):
        prepared = prepare_sma_case(tmp_path_factory.mktemp(name), closes)
        result[name] = (execute_sma_case(prepared), _arguments(prepared))
    return result


@pytest.mark.parametrize(
    "case,base,quote,pnl",
    [
        ("warmup", "0", "1000", {}),
        ("entry", "1", "889.89", {"USDT": "-0.11"}),
        ("round_trip", "0", "979.8", {"USDT": "-20.2"}),
    ],
)
def test_native_currency_vectors_and_final_bar_time_survive_projection(
    native_snapshots, case, base, quote, pnl
):
    source, args = native_snapshots[case]
    before = deepcopy(source)
    report = normalize_historical_cash_series_v2(source, **args)
    assert set(report) == {
        "schema_version",
        "scope",
        "input_manifest_sha256",
        "component_status",
        "failure_codes",
        "points",
    }
    assert report["schema_version"] == 2
    assert report["scope"] == "IN_MEMORY_NATIVE_CASH_SERIES"
    assert report["input_manifest_sha256"] == args["expected_input_sha256"]
    assert report["component_status"] == "COMPONENT_CHECK_PASSED"
    assert report["failure_codes"] == []
    points = report["points"]
    assert len(points) == len(args["expected_bar_times"]) + 1
    assert all(point["phase"] == "PRE_INTENT" for point in points[:-1])
    final = points[-1]
    assert final["phase"] == "FINAL_POST_RUN"
    assert final["sequence"] == len(args["expected_bar_times"])
    assert final["balances"]["ETH"]["total"] == base
    assert final["balances"]["USDT"]["total"] == quote
    assert final["total_equity"] == {"ETH": base, "USDT": quote}
    assert final["base_currency_equity"] is None and final["total_pnls"] == pnl
    for point in points:
        event, clock = args["expected_bar_times"][point["sequence"] - 1]
        assert point["clock_ns"] == str(clock) and point["bar_ts_event"] == str(event)
    if case == "entry":
        assert points[-2]["balances"]["ETH"]["total"] == "0"
        assert points[-1]["balances"]["ETH"]["total"] == "1"
    assert source == before


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_first",
        "missing_final",
        "duplicate",
        "reorder",
        "final_phase",
        "sequence_bool",
        "unknown_field",
        "missing_field",
        "wrong_time",
    ],
)
def test_checkpoint_structure_and_sequence_cannot_be_reinterpreted(native_snapshots, mutation):
    source, args = deepcopy(native_snapshots["entry"])
    points = source["checkpoints"]
    if mutation == "missing_first":
        points.pop(0)
    elif mutation == "missing_final":
        points.pop()
    elif mutation == "duplicate":
        points.insert(0, deepcopy(points[0]))
    elif mutation == "reorder":
        points[0], points[1] = points[1], points[0]
    elif mutation == "final_phase":
        points[-1]["phase"] = "PRE_INTENT"
    elif mutation == "sequence_bool":
        points[0]["sequence"] = True
    elif mutation == "unknown_field":
        points[0]["quote_equity"] = "1000"
    elif mutation == "missing_field":
        del points[0]["is_stale"]
    else:
        points[0]["bar_ts_event"] = points[1]["bar_ts_event"]
    with pytest.raises(ReportSchemaError):
        normalize_historical_cash_series_v2(source, **args)


@pytest.mark.parametrize(
    "value", [True, 1.0, float("nan"), -1, 2**64, "01", "١", "", "18446744073709551616"]
)
def test_snapshot_times_are_exact_ascii_unsigned64(native_snapshots, value):
    source, args = deepcopy(native_snapshots["entry"])
    source["checkpoints"][0]["clock_ns"] = value
    with pytest.raises(ReportSchemaError):
        normalize_historical_cash_series_v2(source, **args)


@pytest.mark.parametrize(
    "mutation",
    [
        "float_amount",
        "nan_amount",
        "unknown_currency",
        "missing_currency",
        "blank_currency",
        "same_currency",
        "input_hash",
        "passed_failures",
        "failed_no_failures",
        "stale_passed",
        "nonboolean_stale",
        "base_equity",
    ],
)
def test_currency_status_and_identity_contracts_reject_ambiguous_facts(native_snapshots, mutation):
    source, args = deepcopy(native_snapshots["entry"])
    point = source["checkpoints"][0]
    if mutation == "float_amount":
        point["balances"]["ETH"]["total"] = 0.0
    elif mutation == "nan_amount":
        point["balances"]["ETH"]["total"] = "NaN"
    elif mutation == "unknown_currency":
        point["total_pnls"]["BTC"] = "1"
    elif mutation == "missing_currency":
        del point["balances"]["ETH"]
    elif mutation == "blank_currency":
        args["currencies"] = ("ETH", " ")
    elif mutation == "same_currency":
        args["currencies"] = ("ETH", "ETH")
    elif mutation == "input_hash":
        args["expected_input_sha256"] = "f" * 64
    elif mutation == "passed_failures":
        source["failure_codes"] = ["NATIVE_CASH_RECONCILIATION_FAILED"]
    elif mutation == "failed_no_failures":
        source["status"] = "COMPONENT_CHECK_FAILED"
    elif mutation == "stale_passed":
        point["is_stale"] = True
    elif mutation == "nonboolean_stale":
        point["is_stale"] = 0
    else:
        point["base_currency_equity"] = {"USDT": "1000"}
    with pytest.raises(ReportSchemaError):
        normalize_historical_cash_series_v2(source, **args)


def test_actual_native_cash_failure_is_preserved_as_diagnostic_facts(tmp_path, monkeypatch):
    prepared = prepare_sma_case(tmp_path, [100, 100, 100, 110], cash="110")
    monkeypatch.setattr(sma, "check_sma_intent", lambda **_: SmaGuardDecision("ALLOW"))
    source = execute_sma_case(prepared)
    report = normalize_historical_cash_series_v2(source, **_arguments(prepared))
    assert report["component_status"] == "COMPONENT_CHECK_FAILED"
    assert "NATIVE_CASH_RECONCILIATION_FAILED" in report["failure_codes"]
    final = report["points"][-1]
    assert final["balances"]["ETH"]["total"] == "0"
    assert final["positions"] == [{"quantity": "1", "side": "LONG"}]


def test_failed_stale_and_signed_vectors_are_retained_without_aliases(native_snapshots):
    # Deliberately mutated diagnostic contract, not an additional native observation.
    source, args = deepcopy(native_snapshots["entry"])
    source["status"] = "COMPONENT_CHECK_FAILED"
    source["failure_codes"] = ["NATIVE_SNAPSHOT_UNSUPPORTED"]
    point = source["checkpoints"][-1]
    point["is_stale"] = True
    point["stale_instruments"] = ["test.SIM"]
    point["balances"]["USDT"]["free"] = "-1"
    point["pending_orders"] = [
        {"id": "reserved", "status": "AWAITING_NATIVE_CACHE", "leaves_quantity": None}
    ]
    report = normalize_historical_cash_series_v2(source, **args)
    actual = report["points"][-1]
    assert actual["is_stale"] and actual["balances"]["USDT"]["free"] == "-1"
    source["checkpoints"][-1]["stale_instruments"].append("changed")
    source["checkpoints"][-1]["pending_orders"][0]["id"] = "changed"
    assert actual["stale_instruments"] == ["test.SIM"]
    assert actual["pending_orders"][0]["id"] == "reserved"
