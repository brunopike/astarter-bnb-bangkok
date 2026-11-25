"""Shared report rules preserve native facts independently of live DataFrames."""

import json
from copy import deepcopy

import pytest

from stark_trading_os.runner.historical_report_component import build_historical_report_component_v2
from stark_trading_os.runner.historical_report_semantics import (
    normalize_historical_report_tables_v2,
    validate_historical_report_facts_v2,
)
from stark_trading_os.runner.report_export import ReportSchemaError
from tests.integration.runner.historical_report_fixture import CASES, capture_case


@pytest.fixture(scope="module")
def reports(tmp_path_factory):
    cases = {name: capture_case(tmp_path_factory.mktemp(name), name) for name in CASES}
    return {
        name: (case, json.loads(build_historical_report_component_v2(**case)))
        for name, case in cases.items()
    }


@pytest.mark.parametrize("name", CASES)
def test_shared_rules_match_builder_for_each_native_scenario(reports, name):
    args, report = reports[name]
    before = deepcopy(report["tables"])
    tables = normalize_historical_report_tables_v2(report["tables"])
    assert tables == before
    for rows in report["tables"].values():
        rows.reverse()
    assert normalize_historical_report_tables_v2(report["tables"]) == before
    report["tables"] = before
    loaded = args["loaded"]
    cash, failures = validate_historical_report_facts_v2(
        snapshot=json.loads(args["component_snapshot_bytes"]),
        tables=tables,
        expected_input_sha256=loaded.input_manifest_hash,
        expected_bar_times=tuple((b.ts_event, b.ts_init) for b in loaded.bars),
        currencies=("ETH", "USDT"),
        instrument_id=loaded.manifest.dataset.instrument_id,
        account_id="SIM-001",
        starting_cash=loaded.manifest.configuration.configuration.execution_cost.starting_cash,
    )
    assert cash == report["cash_series"]
    assert failures == tuple(report["consistency_failures"])
    assert tables == before


@pytest.mark.parametrize("kind", ["orders", "fills", "positions", "account"])
def test_shared_normalizer_rejects_duplicate_rows(reports, kind):
    tables = deepcopy(reports["entry"][1]["tables"])
    tables[kind].append(deepcopy(tables[kind][0]))
    with pytest.raises(ReportSchemaError):
        normalize_historical_report_tables_v2(tables)


@pytest.mark.parametrize(
    "mutation", ["extra", "missing", "nonlist", "nonrow", "no_account", "nested_fills"]
)
def test_shared_normalizer_rejects_unknown_or_dropped_facts(reports, mutation):
    tables = deepcopy(reports["entry"][1]["tables"])
    if mutation == "extra":
        tables["unknown"] = []
    elif mutation == "missing":
        del tables["account"]
    elif mutation == "nonlist":
        tables["orders"] = {}
    elif mutation == "nonrow":
        tables["orders"] = [1]
    elif mutation == "no_account":
        tables["account"] = []
    else:
        tables["positions"][0]["events"][0]["fills"] = ["must stay observable"]
    with pytest.raises(ReportSchemaError):
        normalize_historical_report_tables_v2(tables)
