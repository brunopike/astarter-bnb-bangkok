"""Eight native scenarios plus mutations of the internal report boundary."""

import json
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
from hashlib import sha256

import pytest

from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner.historical_report_component import build_historical_report_component_v2
from stark_trading_os.runner.report_export import ReportSchemaError, pd
from tests.integration.runner.historical_report_fixture import CASES, capture_case


@pytest.fixture(scope="module")
def native_cases(tmp_path_factory):
    return {name: capture_case(tmp_path_factory.mktemp(name), name) for name in CASES}


def clone(case):
    # pandas deep=True does not recursively copy object cells (native event lists).
    return {
        key: value
        if key == "loaded"
        else value.map(deepcopy)
        if isinstance(value, pd.DataFrame)
        else deepcopy(value)
        for key, value in case.items()
    }


@pytest.mark.parametrize("field", ["last_quantity", "last_price", "cash_delta", "commission"])
@pytest.mark.parametrize("invalid", ["1/2", "1/0", "1e3", "", " ", "NaN", "Infinity", "9" * 129])
def test_raw_fill_amounts_reject_non_plain_or_unbounded_decimals(native_cases, field, invalid):
    args = clone(native_cases["entry"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    fact = snapshot["native_fill_facts"][0]
    if field in {"cash_delta", "commission"}:
        fact[field]["USDT"] = invalid
    else:
        fact[field] = invalid
    raw = canonical_historical_bytes(snapshot)
    args["component_snapshot_bytes"] = raw
    with pytest.raises(
        ReportSchemaError, match="^native fill amount must be a bounded plain decimal$"
    ):
        build_historical_report_component_v2(**args)
    assert args["component_snapshot_bytes"] == raw


def test_raw_fill_plain_decimals_retain_native_trailing_zeros_and_signs(native_cases):
    args = clone(native_cases["entry"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    fact = snapshot["native_fill_facts"][0]
    for field in ("last_quantity", "last_price"):
        fact[field] = format(Decimal(fact[field]), ".8f")
    for field in ("cash_delta", "commission"):
        fact[field] = {k: format(Decimal(v), ".8f") for k, v in fact[field].items()}
    assert fact["cash_delta"]["USDT"].startswith("-")
    raw = canonical_historical_bytes(snapshot)
    args["component_snapshot_bytes"] = raw
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_PASSED"
    assert report["component_snapshot_sha256"] == sha256(raw).hexdigest()
    assert args["component_snapshot_bytes"] == raw


@pytest.mark.parametrize("name", CASES)
def test_native_tables_cash_and_input_are_bound_without_float_leakage(native_cases, name):
    args = native_cases[name]
    raw = build_historical_report_component_v2(**args)
    report = json.loads(raw)
    assert canonical_historical_bytes(report) == raw
    assert set(report) == {
        "schema_version",
        "scope",
        "status",
        "identity",
        "tables",
        "cash_series",
        "component_snapshot_sha256",
        "consistency_failures",
    }
    assert report["schema_version"] == 2
    assert report["scope"] == "IN_MEMORY_HISTORICAL_REPORT_COMPONENT"
    assert report["status"] == "INTERNAL_REPORT_CHECK_PASSED"
    assert report["consistency_failures"] == []
    assert (
        tuple(len(report["tables"][k]) for k in ("orders", "fills", "positions", "account"))
        == CASES[name][3]
    )
    loaded = args["loaded"]
    assert report["identity"] == dict(
        run_id=loaded.run_id,
        input_manifest_sha256=loaded.input_manifest_hash,
        configuration_content_sha256=loaded.manifest.configuration_content_sha256,
        catalog_revision=loaded.manifest.dataset.catalog_revision,
        cost_sha256=loaded.manifest.cost_sha256,
        runtime=loaded.runtime.model_dump(mode="json"),
        account_id=args["account_id"],
    )
    snapshot = json.loads(args["component_snapshot_bytes"])
    assert (
        report["component_snapshot_sha256"] == sha256(args["component_snapshot_bytes"]).hexdigest()
    )
    assert snapshot["checkpoints"][-1]["clock_ns"] > 2**53
    assert report["cash_series"]["points"][-1]["clock_ns"] == str(
        snapshot["checkpoints"][-1]["clock_ns"]
    )
    assert (
        report["cash_series"]["points"][-1]["balances"] == snapshot["checkpoints"][-1]["balances"]
    )

    def safe(value):
        assert not isinstance(value, float)
        if type(value) is int:
            assert abs(value) < 2**53
        elif isinstance(value, dict):
            for item in value.values():
                safe(item)
        elif isinstance(value, list):
            for item in value:
                safe(item)

    safe(report)
    report["cash_series"]["points"][-1]["balances"]["ETH"]["total"] = "999"
    assert build_historical_report_component_v2(**args) == raw


@pytest.mark.parametrize(
    "mutation",
    [
        "hash",
        "model",
        "runtime",
        "run_id",
        "catalog",
        "cost",
        "snapshot_input",
        "snapshot_noncanonical",
        "snapshot_extra",
    ],
)
def test_identity_or_raw_binding_violation_rejects(native_cases, mutation):
    args = clone(native_cases["entry"])
    loaded = args["loaded"]
    if mutation == "hash":
        args["loaded"] = replace(loaded, input_manifest_hash="f" * 64)
    elif mutation == "model":
        args["loaded"] = replace(
            loaded,
            manifest=loaded.manifest.model_copy(update={"configuration_content_sha256": "f" * 64}),
        )
    elif mutation == "runtime":
        args["loaded"] = replace(
            loaded, runtime=loaded.runtime.model_copy(update={"native_extension_sha256": "f" * 64})
        )
    elif mutation == "run_id":
        args["loaded"] = replace(loaded, run_id="bt_" + "c" * 32)
    elif mutation == "catalog":
        args["loaded"] = replace(
            loaded, catalog_manifest_bytes=loaded.catalog_manifest_bytes + b" "
        )
    elif mutation == "cost":
        args["loaded"] = replace(
            loaded, execution_profile=replace(loaded.execution_profile, cost_sha256="f" * 64)
        )
    elif mutation == "snapshot_noncanonical":
        args["component_snapshot_bytes"] += b" "
    else:
        snapshot = json.loads(args["component_snapshot_bytes"])
        if mutation == "snapshot_input":
            snapshot["input_manifest_sha256"] = "f" * 64
        else:
            snapshot["forged"] = True
        args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    with pytest.raises(ReportSchemaError):
        build_historical_report_component_v2(**args)


@pytest.mark.parametrize("kind", ["orders", "fills", "positions", "account"])
@pytest.mark.parametrize(
    "mutation",
    ["duplicate_column", "missing_column", "extra_column", "multiindex", "duplicate_row"],
)
def test_exact_shapes_and_semantic_duplicate_rows_reject(native_cases, kind, mutation):
    args = clone(native_cases["entry"])
    frame = args[kind]
    if mutation == "duplicate_column":
        frame = pd.concat([frame, frame.iloc[:, :1]], axis=1)
    elif mutation == "missing_column":
        frame = frame.iloc[:, 1:]
    elif mutation == "extra_column":
        frame["fabricated"] = "x"
    elif mutation == "multiindex":
        frame.index = pd.MultiIndex.from_arrays([frame.index, frame.index])
    else:
        frame = pd.concat([frame, frame.iloc[:1]])
    args[kind] = frame
    with pytest.raises(ReportSchemaError):
        build_historical_report_component_v2(**args)


@pytest.mark.parametrize(
    "mutation",
    [
        "float_amount",
        "unicode_time",
        "overflow_time",
        "nested_time",
        "nested_bigint",
        "discarded_fills",
        "currency",
        "blank_identity",
    ],
)
def test_unsupported_precision_or_currency_does_not_become_report_fact(native_cases, mutation):
    args = clone(native_cases["entry"])
    fills = args["fills"]
    if mutation == "float_amount":
        fills["last_qty"] = fills["last_qty"].astype(object)
        fills.iloc[0, fills.columns.get_loc("last_qty")] = 1.0
    elif mutation in {"unicode_time", "overflow_time"}:
        fills["ts_event"] = fills["ts_event"].astype(object)
        fills.iloc[0, fills.columns.get_loc("ts_event")] = (
            "１２３" if mutation == "unicode_time" else str(2**64)
        )
    elif mutation == "nested_time":
        args["positions"].iloc[0]["events"][0]["ts_event"] = "01"
    elif mutation == "nested_bigint":
        fills.at[fills.index[0], "info"] = {"unsafe": 2**53}
    elif mutation == "discarded_fills":
        args["positions"].iloc[0]["events"][0]["fills"] = ["must not disappear"]
    elif mutation == "currency":
        fills["currency"] = "BTC"
        fills["commission"] = "0.11 BTC"
    else:
        fills["trade_id"] = " "
    with pytest.raises(ReportSchemaError):
        build_historical_report_component_v2(**args)


@pytest.mark.parametrize(
    "mutation,code",
    [
        ("quantity", "ORDER_FILL_QUANTITY_MISMATCH"),
        ("commission", "ORDER_FILL_COMMISSION_MISMATCH"),
        ("side", "ORDER_FILL_IDENTITY_MISMATCH"),
        ("missing_order", "ORDER_FILL_IDENTITY_MISMATCH"),
        ("account", "REPORT_ACCOUNT_IDENTITY_MISMATCH"),
        ("position_order", "REPORT_POSITION_IDENTITY_MISMATCH"),
    ],
)
def test_economic_mismatch_preserves_facts_and_marks_failed(native_cases, mutation, code):
    args = clone(native_cases["entry"])
    if mutation == "quantity":
        args["fills"]["last_qty"] = "0.5"
    elif mutation == "commission":
        args["fills"]["commission"] = "0.12 USDT"
    elif mutation == "side":
        args["fills"]["order_side"] = "SELL"
    elif mutation == "missing_order":
        args["fills"].index = pd.Index(["unrelated-order"], name="client_order_id")
    elif mutation == "account":
        args["account"]["account_id"] = "OTHER-001"
    else:
        args["positions"]["opening_order_id"] = "unrelated-order"
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_FAILED"
    assert code in report["consistency_failures"]
    if mutation == "quantity":
        assert report["tables"]["fills"][0]["last_qty"] == "0.5"
    if mutation == "commission":
        assert report["tables"]["fills"][0]["commission"] == "0.12 USDT"
    assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "889.89"


def test_same_timestamp_account_permutations_preserve_all_native_facts(native_cases):
    args = clone(native_cases["large_entry_reverse"])
    original = build_historical_report_component_v2(**args)
    assert args["account"].index.duplicated().any()
    args["account"] = args["account"].iloc[::-1]
    assert build_historical_report_component_v2(**args) == original
    report = json.loads(original)
    assert len(report["tables"]["account"]) == 10
    assert (
        report["cash_series"]["points"][-1]["balances"]
        == json.loads(args["component_snapshot_bytes"])["checkpoints"][-1]["balances"]
    )


def test_failed_component_and_diagnostics_are_preserved(native_cases):
    args = clone(native_cases["entry"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    snapshot["status"] = "COMPONENT_CHECK_FAILED"
    snapshot["failure_codes"] = ["NATIVE_CASH_RECONCILIATION_FAILED"]
    snapshot["checkpoints"][-1]["balances"]["ETH"]["total"] = "0"
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_FAILED"
    assert report["cash_series"]["failure_codes"] == snapshot["failure_codes"]
    assert report["cash_series"]["points"][-1]["balances"]["ETH"]["total"] == "0"


@pytest.mark.parametrize("mutation", ["fill_price", "fill_absent", "position_event_absent"])
def test_snapshot_and_tables_from_different_native_facts_cannot_pass(native_cases, mutation):
    args = clone(native_cases["entry"])
    if mutation == "position_event_absent":
        args["positions"].iat[0, args["positions"].columns.get_loc("events")] = []
    else:
        snapshot = json.loads(args["component_snapshot_bytes"])
        if mutation == "fill_price":
            snapshot["native_fill_facts"][0]["last_price"] = "120"
        else:
            snapshot["native_fill_facts"] = []
        args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_FAILED"
    assert (
        "REPORT_POSITION_EVENT_MISMATCH"
        if mutation == "position_event_absent"
        else "NATIVE_FILL_FACT_MISMATCH"
    ) in report["consistency_failures"]


@pytest.mark.parametrize(
    "mutation",
    [
        "other_case",
        "missing_base",
        "missing_quote",
        "final_total",
        "final_free",
        "initial",
        "future_time",
    ],
)
def test_account_facts_must_witness_initial_and_final_cash(native_cases, mutation):
    args = clone(native_cases["entry"])
    frame = args["account"]
    if mutation == "other_case":
        frame = clone(native_cases["warmup"])["account"]
    elif mutation in {"missing_base", "missing_quote"}:
        frame = frame.loc[frame["currency"] != ("ETH" if mutation == "missing_base" else "USDT")]
    elif mutation == "future_time":
        frame.index = frame.index + pd.Timedelta(days=1)
    else:
        if mutation == "initial":
            offset = next(i for i, c in enumerate(frame["currency"]) if c == "USDT")
            for column in ("total", "free"):
                frame.iat[offset, frame.columns.get_loc(column)] = "990"
        else:
            offset = len(frame) - 1
            column = "total" if mutation == "final_total" else "free"
            frame.iat[offset, frame.columns.get_loc(column)] = "880"
    args["account"] = frame
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_FAILED"
    assert "REPORT_ACCOUNT_CASH_MISMATCH" in report["consistency_failures"]
    assert len(report["tables"]["account"]) == len(frame)
    assert report["cash_series"]["points"][-1]["balances"]["USDT"]["total"] == "889.89"


@pytest.mark.parametrize(
    "mutation",
    ["missing_denied", "unrelated_zero_fill", "missing_events", "foreign_event", "wrong_side"],
)
def test_zero_fill_orders_are_bound_to_submissions_and_native_events(native_cases, mutation):
    args = clone(native_cases["warmup" if mutation == "unrelated_zero_fill" else "denied"])
    if mutation == "missing_denied":
        args["orders"] = pd.DataFrame()
    elif mutation == "unrelated_zero_fill":
        args["orders"] = clone(native_cases["denied"])["orders"]
        # Isolate missing trace linkage; an unmodified other instrument already fails.
        args["orders"]["instrument_id"] = args["loaded"].manifest.dataset.instrument_id
    else:
        snapshot = json.loads(args["component_snapshot_bytes"])
        if mutation == "missing_events":
            snapshot["native_order_events"] = []
        elif mutation == "foreign_event":
            snapshot["native_order_events"][0]["client_order_id"] = "foreign-order"
        else:
            snapshot["decisions"][0]["side"] = "SELL"
        args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == "INTERNAL_REPORT_CHECK_FAILED"
    assert "REPORT_ORDER_TRACE_MISMATCH" in report["consistency_failures"]
    assert len(report["tables"]["orders"]) == len(args["orders"])


@pytest.mark.parametrize(
    "mutation",
    [
        "decision_extra",
        "decision_missing",
        "decision_bool_sequence",
        "decision_bad_quote",
        "event_extra",
        "event_time",
        "event_reason",
    ],
)
def test_consumed_native_order_trace_has_an_explicit_shape(native_cases, mutation):
    args = clone(native_cases["denied"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    decision = snapshot["decisions"][0]
    event = snapshot["native_order_events"][0]
    if mutation == "decision_extra":
        decision["unknown"] = True
    elif mutation == "decision_missing":
        decision.pop("sequence")
    elif mutation == "decision_bool_sequence":
        decision["sequence"] = True
    elif mutation == "decision_bad_quote":
        decision["required_quote_denominator"] = "0"
    elif mutation == "event_extra":
        event["unknown"] = True
    elif mutation == "event_time":
        event["ts_event"] = True
    else:
        event["reason"] = {}
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    with pytest.raises(ReportSchemaError):
        build_historical_report_component_v2(**args)


@pytest.mark.parametrize(
    "mutation", ["valid", "missing_table", "foreign_pending", "wrong_remaining"]
)
def test_pending_order_contract_retains_and_checks_order_identity(native_cases, mutation):
    # Explicit contract mutation: not a claim that this pending native path was observed.
    args = clone(native_cases["denied"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    oid = args["orders"].index[0]
    args["orders"]["status"] = "ACCEPTED"
    args["orders"]["account_id"] = args["account_id"]
    for event in snapshot["native_order_events"]:
        event["event_type"] = "OrderAccepted"
        event["reason"] = None
    snapshot["checkpoints"][-1]["pending_orders"] = [
        dict(id=oid, status="ACCEPTED", leaves_quantity="1")
    ]
    if mutation == "missing_table":
        args["orders"] = pd.DataFrame()
    elif mutation == "foreign_pending":
        snapshot["checkpoints"][-1]["pending_orders"][0]["id"] = "foreign-order"
    elif mutation == "wrong_remaining":
        snapshot["checkpoints"][-1]["pending_orders"][0]["leaves_quantity"] = "0.5"
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(build_historical_report_component_v2(**args))
    assert report["status"] == (
        "INTERNAL_REPORT_CHECK_PASSED" if mutation == "valid" else "INTERNAL_REPORT_CHECK_FAILED"
    )
    if mutation != "valid":
        assert "REPORT_ORDER_TRACE_MISMATCH" in report["consistency_failures"]
    assert (
        report["cash_series"]["points"][-1]["pending_orders"]
        == snapshot["checkpoints"][-1]["pending_orders"]
    )
