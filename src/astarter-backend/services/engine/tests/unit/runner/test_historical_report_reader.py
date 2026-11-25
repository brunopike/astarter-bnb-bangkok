"""Saved bytes need independent identity and both committed artifact anchors."""

import json
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from decimal import Decimal
from hashlib import sha256

import pytest

import stark_trading_os.runner.historical_report_reader as reader
from stark_trading_os.catalog.historical_catalog import canonical_historical_bytes
from stark_trading_os.runner.historical_report_component import build_historical_report_component_v2
from stark_trading_os.runner.report_export import ReportSchemaError
from tests.integration.runner.historical_report_fixture import CASES, capture_case


@pytest.fixture(scope="module")
def bundles(tmp_path_factory):
    output = {}
    for name in CASES:
        case = capture_case(tmp_path_factory.mktemp(name), name)
        loaded = case["loaded"]
        expected = reader.HistoricalReportExpectationV2(
            run_id=loaded.run_id,
            input_manifest_bytes=loaded.manifest_bytes,
            input_manifest_sha256=loaded.input_manifest_hash,
            catalog_manifest_bytes=loaded.catalog_manifest_bytes,
            account_id="SIM-001",
        )
        output[name] = dict(
            report_bytes=build_historical_report_component_v2(**case),
            component_snapshot_bytes=case["component_snapshot_bytes"],
            expected=expected,
        )
        if name == "entry":
            snapshot = json.loads(case["component_snapshot_bytes"])
            snapshot["status"] = "COMPONENT_CHECK_FAILED"
            snapshot["failure_codes"] = ["NATIVE_CASH_RECONCILIATION_FAILED"]
            case = dict(case, component_snapshot_bytes=canonical_historical_bytes(snapshot))
            output["failed"] = dict(
                report_bytes=build_historical_report_component_v2(**case),
                component_snapshot_bytes=case["component_snapshot_bytes"],
                expected=expected,
            )
    return output


@pytest.mark.parametrize("name", [*CASES, "failed"])
def test_candidate_and_anchored_reverify_are_exact_immutable_results(bundles, name):
    args = bundles[name]
    result = reader.validate_historical_report_candidate_v2(**args)
    report = json.loads(args["report_bytes"])
    assert result.run_id == args["expected"].run_id
    assert result.input_manifest_sha256 == args["expected"].input_manifest_sha256
    assert result.report_sha256 == sha256(args["report_bytes"]).hexdigest()
    assert result.component_snapshot_sha256 == sha256(args["component_snapshot_bytes"]).hexdigest()
    assert result.status == report["status"]
    assert result.consistency_failures == tuple(report["consistency_failures"])
    assert result.table_counts == tuple(
        (k, len(report["tables"][k])) for k in ("orders", "fills", "positions", "account")
    )
    assert result == reader.reverify_historical_report_v2(
        **args,
        expected_report_sha256=result.report_sha256,
        expected_component_snapshot_sha256=result.component_snapshot_sha256,
    )
    with pytest.raises(FrozenInstanceError):
        result.status = "forged"
    with pytest.raises(FrozenInstanceError):
        args["expected"].run_id = "forged"


@pytest.mark.parametrize(
    "identity",
    [
        "run_id",
        "input_manifest_sha256",
        "configuration_content_sha256",
        "catalog_revision",
        "cost_sha256",
        "runtime",
        "account_id",
    ],
)
def test_candidate_self_hash_cannot_replace_trusted_identity(bundles, identity):
    args = dict(bundles["entry"])
    value = json.loads(args["report_bytes"])
    value["identity"][identity] = "private-forgery-marker"
    args["report_bytes"] = canonical_historical_bytes(value)
    with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize(
    "field",
    [
        "run_id",
        "input_manifest_sha256",
        "input_manifest_bytes",
        "catalog_manifest_bytes",
        "account_id",
    ],
)
def test_public_entries_revalidate_the_independent_expectation(bundles, field):
    args = dict(bundles["entry"])
    altered = {
        "run_id": "bt_" + "c" * 32,
        "input_manifest_sha256": "f" * 64,
        "input_manifest_bytes": bundles["warmup"]["expected"].input_manifest_bytes,
        "catalog_manifest_bytes": bundles["warmup"]["expected"].catalog_manifest_bytes,
        "account_id": "SIM-002",
    }
    args["expected"] = replace(args["expected"], **{field: altered[field]})
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)
    with pytest.raises(ReportSchemaError):
        reader.reverify_historical_report_v2(
            **args,
            expected_report_sha256=sha256(args["report_bytes"]).hexdigest(),
            expected_component_snapshot_sha256=sha256(args["component_snapshot_bytes"]).hexdigest(),
        )


def test_new_input_with_fresh_trusted_hash_still_cannot_claim_an_old_report(bundles):
    args = dict(bundles["entry"])
    raw = json.loads(args["expected"].input_manifest_bytes)
    raw["configuration_version"] += 1
    changed = canonical_historical_bytes(raw)
    args["expected"] = replace(
        args["expected"],
        input_manifest_bytes=changed,
        input_manifest_sha256=sha256(changed).hexdigest(),
    )
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


def test_original_catalog_runtime_must_agree_even_if_candidate_rewrites_all_hashes(bundles):
    args = dict(bundles["warmup"])
    raw = json.loads(args["expected"].input_manifest_bytes)
    raw["runtime"]["python_version"] = "3.12.99"
    changed = canonical_historical_bytes(raw)
    digest = sha256(changed).hexdigest()
    args["expected"] = replace(
        args["expected"], input_manifest_bytes=changed, input_manifest_sha256=digest
    )
    snapshot = json.loads(args["component_snapshot_bytes"])
    snapshot["input_manifest_sha256"] = digest
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(args["report_bytes"])
    report["identity"]["input_manifest_sha256"] = digest
    report["identity"]["runtime"] = raw["runtime"]
    report["cash_series"]["input_manifest_sha256"] = digest
    report["component_snapshot_sha256"] = sha256(args["component_snapshot_bytes"]).hexdigest()
    args["report_bytes"] = canonical_historical_bytes(report)
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


def test_frozen_carrier_is_not_treated_as_prevalidated_authority(bundles):
    args = dict(bundles["entry"])
    changed = replace(args["expected"])
    object.__setattr__(changed, "run_id", "private-invalid-run-marker")
    args["expected"] = changed
    with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize(
    "field,limit",
    [("input_manifest_bytes", 64 * 1024), ("catalog_manifest_bytes", 4 * 1024 * 1024)],
)
def test_expected_input_and_catalog_keep_their_existing_admission_limits(bundles, field, limit):
    args = dict(bundles["entry"])
    args["expected"] = replace(args["expected"], **{field: b" " * (limit + 1)})
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize(
    "mutation",
    [
        "extra",
        "missing",
        "identity_extra",
        "runtime_extra",
        "row_extra",
        "event_extra",
        "point_extra",
        "cash_extra",
        "bool_sequence",
        "unsafe_info",
        "duplicate_fill",
        "account_permutation",
        "status",
        "diagnostics",
        "cash",
        "component_digest",
    ],
)
def test_changed_report_structure_or_facts_cannot_be_promoted_by_own_digest(bundles, mutation):
    args = dict(bundles["entry"])
    value = json.loads(args["report_bytes"])
    if mutation == "extra":
        value["private-payload-marker"] = True
    elif mutation == "missing":
        del value["status"]
    elif mutation == "identity_extra":
        value["identity"]["private-payload-marker"] = True
    elif mutation == "runtime_extra":
        value["identity"]["runtime"]["private-payload-marker"] = True
    elif mutation == "row_extra":
        value["tables"]["fills"][0]["private-payload-marker"] = True
    elif mutation == "event_extra":
        value["tables"]["positions"][0]["events"][0]["private-payload-marker"] = True
    elif mutation == "point_extra":
        value["cash_series"]["points"][0]["private-payload-marker"] = True
    elif mutation == "cash_extra":
        value["cash_series"]["private-payload-marker"] = True
    elif mutation == "bool_sequence":
        value["cash_series"]["points"][0]["sequence"] = True
    elif mutation == "unsafe_info":
        value["tables"]["fills"][0]["info"] = {"private-payload-marker": 2**53}
    elif mutation == "duplicate_fill":
        value["tables"]["fills"].append(deepcopy(value["tables"]["fills"][0]))
    elif mutation == "account_permutation":
        value["tables"]["account"].reverse()
    elif mutation == "status":
        value["status"] = "INTERNAL_REPORT_CHECK_FAILED"
    elif mutation == "diagnostics":
        value["consistency_failures"] = ["COMPONENT_CHECK_FAILED"]
    elif mutation == "cash":
        value["cash_series"]["points"][-1]["balances"]["ETH"]["total"] = "999"
    else:
        value["component_snapshot_sha256"] = "f" * 64
    args["report_bytes"] = canonical_historical_bytes(value)
    with pytest.raises(ReportSchemaError) as error:
        reader.validate_historical_report_candidate_v2(**args)
    assert str(error.value) == "historical report evidence is invalid"


@pytest.mark.parametrize(
    "mutation",
    [
        "unknown",
        "input",
        "missing_final",
        "extra_final",
        "final_time",
        "missing_events",
        "missing_decision",
        "amount",
        "native_failure",
    ],
)
def test_original_snapshot_is_rechecked_even_when_candidate_updates_its_hash(bundles, mutation):
    args = dict(
        bundles["zero_volume"]
        if mutation in {"missing_events", "missing_decision"}
        else bundles["entry"]
    )
    snapshot = json.loads(args["component_snapshot_bytes"])
    if mutation == "unknown":
        snapshot["checkpoints"][0]["private-payload-marker"] = True
    elif mutation == "input":
        snapshot["input_manifest_sha256"] = "f" * 64
    elif mutation == "missing_final":
        snapshot["checkpoints"].pop()
    elif mutation == "extra_final":
        snapshot["checkpoints"].append(deepcopy(snapshot["checkpoints"][-1]))
    elif mutation == "final_time":
        snapshot["checkpoints"][-1]["clock_ns"] += 1
    elif mutation == "missing_events":
        snapshot["native_order_events"] = []
    elif mutation == "missing_decision":
        snapshot["decisions"] = []
    elif mutation == "amount":
        snapshot["native_fill_facts"][0]["last_quantity"] = "1/0"
    else:
        snapshot["status"] = "COMPONENT_CHECK_FAILED"
        snapshot["failure_codes"] = ["NATIVE_CASH_RECONCILIATION_FAILED"]
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report = json.loads(args["report_bytes"])
    report["component_snapshot_sha256"] = sha256(args["component_snapshot_bytes"]).hexdigest()
    args["report_bytes"] = canonical_historical_bytes(report)
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


def test_complete_failed_evidence_must_keep_failed_status_and_diagnostics(bundles):
    args = dict(bundles["failed"])
    assert (
        reader.validate_historical_report_candidate_v2(**args).status
        == "INTERNAL_REPORT_CHECK_FAILED"
    )
    report = json.loads(args["report_bytes"])
    report["status"] = "INTERNAL_REPORT_CHECK_PASSED"
    report["consistency_failures"] = []
    args["report_bytes"] = canonical_historical_bytes(report)
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize("field", ["report_bytes", "component_snapshot_bytes"])
@pytest.mark.parametrize(
    "mutation", ["empty", "str", "bytearray", "utf8", "duplicate", "noncanonical", "not_object"]
)
def test_byte_boundary_is_strict_and_does_not_echo_payload(bundles, field, mutation):
    args = dict(bundles["entry"])
    raw = args[field]
    args[field] = {
        "empty": b"",
        "str": raw.decode(),
        "bytearray": bytearray(raw),
        "utf8": b"\xffprivate-payload-marker",
        "duplicate": b'{"private-payload-marker":1,"private-payload-marker":2}',
        "noncanonical": raw + b"\n",
        "not_object": b"[]",
    }[mutation]
    with pytest.raises(ReportSchemaError) as error:
        reader.validate_historical_report_candidate_v2(**args)
    assert str(error.value) == "historical report evidence is invalid"


@pytest.mark.parametrize("field", ["expected_report_sha256", "expected_component_snapshot_sha256"])
@pytest.mark.parametrize("value", [None, "", "f" * 64, "A" * 64, "f" * 63])
def test_reverification_requires_each_independent_lowercase_digest(bundles, field, value):
    args = dict(bundles["entry"])
    anchors = dict(
        expected_report_sha256=sha256(args["report_bytes"]).hexdigest(),
        expected_component_snapshot_sha256=sha256(args["component_snapshot_bytes"]).hexdigest(),
    )
    anchors[field] = value
    with pytest.raises(ReportSchemaError):
        reader.reverify_historical_report_v2(**args, **anchors)


def test_reverification_has_no_optional_digest_fallback(bundles):
    with pytest.raises(TypeError):
        reader.reverify_historical_report_v2(**bundles["entry"])


def test_exact_byte_admission_limit_is_inclusive(bundles, monkeypatch):
    args = bundles["entry"]
    size = max(len(args["report_bytes"]), len(args["component_snapshot_bytes"]))
    monkeypatch.setattr(reader, "MAX_REPORT_BYTES", size)
    reader.validate_historical_report_candidate_v2(**args)
    monkeypatch.setattr(reader, "MAX_REPORT_BYTES", size - 1)
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize("depth,decoded", [(64, True), (65, False)])
def test_depth_is_bounded_before_recursive_json_decoding(bundles, monkeypatch, depth, decoded):
    args = dict(bundles["entry"])
    args["report_bytes"] = b'{"x":' + b"[" * (depth - 1) + b"0" + b"]" * (depth - 1) + b"}"
    called = []
    real = reader.parse_json_object

    def parse(raw):
        if raw == args["report_bytes"]:
            called.append(True)
        return real(raw)

    monkeypatch.setattr(reader, "parse_json_object", parse)
    with pytest.raises(ReportSchemaError):
        reader.validate_historical_report_candidate_v2(**args)
    assert bool(called) is decoded


def test_historical_verification_uses_bound_original_runtime_not_current_machine(
    bundles, monkeypatch
):
    import stark_trading_os.runner.historical_input_adapter as runtime

    def unavailable(*args, **kwargs):
        raise AssertionError("historical reader must not observe current runtime")

    monkeypatch.setattr(runtime, "observe_historical_runtime", unavailable)
    reader.validate_historical_report_candidate_v2(**bundles["entry"])


@pytest.mark.parametrize(
    "location",
    ["order", "fill_fee", "position_fee", "position_event", "balance", "vector", "pending"],
)
def test_numeric_bombs_are_rejected_before_decimal_expansion(bundles, monkeypatch, location):
    import stark_trading_os.runner.historical_cash_report as cash
    import stark_trading_os.runner.report_export as exporter

    args = dict(bundles["entry"])
    report = json.loads(args["report_bytes"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    bomb = "1e1000000000"
    if location == "order":
        report["tables"]["orders"][0]["quantity"] = bomb
    elif location == "fill_fee":
        report["tables"]["fills"][0]["commission"] = bomb + " USDT"
    elif location == "position_fee":
        report["tables"]["positions"][0]["commissions"] = [bomb + " USDT"]
    elif location == "position_event":
        report["tables"]["positions"][0]["events"][0]["last_qty"] = bomb
    elif location == "balance":
        snapshot["checkpoints"][0]["balances"]["USDT"]["total"] = bomb
    elif location == "vector":
        snapshot["checkpoints"][0]["total_equity"]["USDT"] = bomb
    else:
        snapshot["checkpoints"][-1]["pending_orders"] = [
            dict(id="pending", status="ACCEPTED", leaves_quantity=bomb)
        ]
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report["component_snapshot_sha256"] = sha256(args["component_snapshot_bytes"]).hexdigest()
    args["report_bytes"] = canonical_historical_bytes(report)
    real = exporter.canonical_decimal_string

    def guarded(value):
        if value.adjusted() > 1024:
            raise AssertionError("would attempt unbounded decimal expansion")
        return real(value)

    monkeypatch.setattr(exporter, "canonical_decimal_string", guarded)
    monkeypatch.setattr(cash, "canonical_decimal_string", guarded)
    with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
        reader.validate_historical_report_candidate_v2(**args)


def test_pending_bytes_contract_is_retained_without_claiming_a_native_pending_run(bundles):
    args = dict(bundles["denied"])
    report = json.loads(args["report_bytes"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    order = report["tables"]["orders"][0]
    order.update(status="ACCEPTED", account_id="SIM-001")
    for event in snapshot["native_order_events"]:
        event.update(event_type="OrderAccepted", reason=None)
    pending = [dict(id=order["client_order_id"], status="ACCEPTED", leaves_quantity="1")]
    snapshot["checkpoints"][-1]["pending_orders"] = pending
    report["cash_series"]["points"][-1]["pending_orders"] = pending
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report["component_snapshot_sha256"] = sha256(args["component_snapshot_bytes"]).hexdigest()
    args["report_bytes"] = canonical_historical_bytes(report)
    assert (
        reader.validate_historical_report_candidate_v2(**args).status
        == "INTERNAL_REPORT_CHECK_PASSED"
    )


def test_numeric_looking_metadata_remains_opaque(bundles):
    args = dict(bundles["entry"])
    report = json.loads(args["report_bytes"])
    info = {"literal": "1e1000000000", "brackets": '["{\\}"]'}
    report["tables"]["fills"][0]["info"] = info
    report["tables"]["positions"][0]["events"][0]["info"] = info
    args["report_bytes"] = canonical_historical_bytes(report)
    assert (
        reader.validate_historical_report_candidate_v2(**args).status
        == "INTERNAL_REPORT_CHECK_PASSED"
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "final_position",
        "intermediate_position",
        "short_position",
        "duplicate_position",
        "position_table",
        "starting_cash",
        "fill_delta",
        "intermediate_cash",
    ],
)
def test_synchronized_cash_and_position_contradictions_cannot_pass(bundles, mutation):
    args = dict(bundles["entry"])
    report = json.loads(args["report_bytes"])
    snapshot = json.loads(args["component_snapshot_bytes"])
    points = snapshot["checkpoints"]
    if mutation == "final_position":
        points[-1]["positions"][0]["quantity"] = "9"
    elif mutation == "intermediate_position":
        points[1]["positions"] = [{"quantity": "9", "side": "LONG"}]
    elif mutation == "short_position":
        points[-1]["positions"][0]["side"] = "SHORT"
    elif mutation == "duplicate_position":
        points[-1]["positions"] = [{"quantity": "0.5", "side": "LONG"}] * 2
    elif mutation == "position_table":
        report["tables"]["positions"][0]["quantity"] = "9"
    elif mutation == "starting_cash":
        for point in points:
            for field in ("total", "free"):
                point["balances"]["USDT"][field] = str(
                    Decimal(point["balances"]["USDT"][field]) + 100
                )
        for row in report["tables"]["account"]:
            if row["currency"] == "USDT":
                for field in ("total", "free"):
                    row[field] = str(Decimal(row[field]) + 100)
    elif mutation == "fill_delta":
        snapshot["native_fill_facts"][0]["cash_delta"]["USDT"] = "-100"
    else:
        points[1]["balances"]["USDT"].update(total="999", free="999")
    for index, point in enumerate(points):
        for field in ("balances", "positions"):
            report["cash_series"]["points"][index][field] = deepcopy(point[field])
    args["component_snapshot_bytes"] = canonical_historical_bytes(snapshot)
    report["component_snapshot_sha256"] = sha256(args["component_snapshot_bytes"]).hexdigest()
    args["report_bytes"] = canonical_historical_bytes(report)
    with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
        reader.validate_historical_report_candidate_v2(**args)


@pytest.mark.parametrize(
    "name,status",
    [
        ("zero_volume", "DENIED"),
        ("zero_volume", "CANCELED"),
        ("zero_volume", "EXPIRED"),
        ("denied", "REJECTED"),
    ],
)
def test_native_terminal_event_cannot_be_relabelled(bundles, name, status):
    args = dict(bundles[name])
    report = json.loads(args["report_bytes"])
    report["tables"]["orders"][0]["status"] = status
    args["report_bytes"] = canonical_historical_bytes(report)
    with pytest.raises(ReportSchemaError, match="^historical report evidence is invalid$"):
        reader.validate_historical_report_candidate_v2(**args)
