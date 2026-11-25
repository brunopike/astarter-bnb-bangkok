"""Bound internal native report bytes; no Control, persistence or replay authority.

Account rows sharing a timestamp retain every distinct economic snapshot. Their
canonical order is not causal order; FINAL_POST_RUN supplies the final cash state.
"""

from __future__ import annotations

import re
from hashlib import sha256
from typing import Any

from stark_trading_os.audit.canonical_json import parse_json_object
from stark_trading_os.audit.historical_input import (
    input_manifest_bytes,
    parse_input_manifest_bytes,
    validate_input_bindings,
)
from stark_trading_os.catalog.historical_catalog import (
    _bar_value,
    canonical_historical_bytes,
)
from stark_trading_os.runner.historical_input_adapter import LoadedHistoricalRunnerInput
from stark_trading_os.runner.historical_report_export import (
    export_historical_market_orders_v2,
)
from stark_trading_os.runner.historical_report_semantics import (
    _COMPONENT_FIELDS,
    _strict_values,
    validate_historical_report_facts_v2,
)
from stark_trading_os.runner.report_export import (
    REPORT_SCHEMAS,
    ReportSchemaError,
    _is_exact_native_empty_frame,
    export_dataframe_report,
    pd,
)


def build_historical_report_component_v2(
    *,
    loaded: LoadedHistoricalRunnerInput,
    component_snapshot_bytes: bytes,
    account_id: str,
    orders: Any,
    fills: Any,
    positions: Any,
    account: Any,
) -> bytes:
    """Validate same-run facts and return an immutable, JavaScript-safe projection."""
    try:
        identity = _identity(loaded, account_id)
        if type(component_snapshot_bytes) is not bytes:
            raise ReportSchemaError("component snapshot must be canonical bytes")
        snapshot = parse_json_object(component_snapshot_bytes)
        if (
            set(snapshot) != _COMPONENT_FIELDS
            or canonical_historical_bytes(snapshot) != component_snapshot_bytes
        ):
            raise ReportSchemaError("component snapshot schema or canonical encoding differs")
        for name in ("decisions", "native_fill_facts", "native_order_events"):
            if type(snapshot[name]) is not list:
                raise ReportSchemaError(f"component {name} must be a list")
        dataset = loaded.manifest.dataset
        currencies = (dataset.base_currency, dataset.quote_currency)
        tables = {
            "orders": export_historical_market_orders_v2(orders),
            "fills": _table("fills", fills),
            "positions": _table("positions", positions),
            "account": _table("account", account),
        }
        cash_series, failures = validate_historical_report_facts_v2(
            snapshot=snapshot,
            tables=tables,
            expected_input_sha256=loaded.input_manifest_hash,
            expected_bar_times=tuple((b.ts_event, b.ts_init) for b in loaded.bars),
            currencies=currencies,
            instrument_id=dataset.instrument_id,
            account_id=account_id,
            starting_cash=loaded.manifest.configuration.configuration.execution_cost.starting_cash,
        )
        report: dict[str, object] = dict(
            schema_version=2,
            scope="IN_MEMORY_HISTORICAL_REPORT_COMPONENT",
            status="INTERNAL_REPORT_CHECK_FAILED" if failures else "INTERNAL_REPORT_CHECK_PASSED",
            identity=identity,
            tables=tables,
            cash_series=cash_series,
            component_snapshot_sha256=sha256(component_snapshot_bytes).hexdigest(),
            consistency_failures=sorted(failures),
        )
        _strict_values(report)
        return canonical_historical_bytes(report)
    except ReportSchemaError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as error:
        raise ReportSchemaError("historical report binding or native value is invalid") from error


def _identity(loaded: LoadedHistoricalRunnerInput, account_id: str) -> dict[str, object]:
    if not isinstance(loaded, LoadedHistoricalRunnerInput):
        raise ReportSchemaError("report requires loaded historical input")
    manifest = parse_input_manifest_bytes(
        loaded.manifest_bytes, expected_sha256=loaded.input_manifest_hash
    )
    validate_input_bindings(
        manifest,
        catalog_manifest_bytes=loaded.catalog_manifest_bytes,
        expected_runtime=loaded.runtime,
    )
    if (
        input_manifest_bytes(loaded.manifest) != loaded.manifest_bytes
        or canonical_historical_bytes(loaded.catalog_manifest) != loaded.catalog_manifest_bytes
        or type(loaded.run_id) is not str
        or re.fullmatch(r"bt_[0-9a-f]{32}", loaded.run_id) is None
        or loaded.staging_dir.name != loaded.run_id
        or not loaded.staging_dir.is_absolute()
        or type(account_id) is not str
        or not account_id.strip()
        or loaded.execution_profile.cost_sha256 != manifest.cost_sha256
        or str(loaded.instrument.id) != manifest.dataset.instrument_id
        or str(loaded.execution_profile.instrument.id) != manifest.dataset.instrument_id
        or str(loaded.instrument.base_currency) != manifest.dataset.base_currency
        or str(loaded.instrument.quote_currency) != manifest.dataset.quote_currency
        or len(loaded.bars) != manifest.dataset.record_count
        or any(str(b.bar_type) != manifest.dataset.bar_type for b in loaded.bars)
    ):
        raise ReportSchemaError("loaded report provenance differs from canonical input")
    bar_digest = sha256(
        canonical_historical_bytes(
            {"bars": [_bar_value(b).model_dump(mode="json", by_alias=True) for b in loaded.bars]}
        )
    ).hexdigest()
    if bar_digest != manifest.dataset.bar_values_sha256:
        raise ReportSchemaError("loaded report bars differ from input readback")
    return dict(
        run_id=loaded.run_id,
        input_manifest_sha256=loaded.input_manifest_hash,
        configuration_content_sha256=manifest.configuration_content_sha256,
        catalog_revision=manifest.dataset.catalog_revision,
        cost_sha256=manifest.cost_sha256,
        runtime=manifest.runtime.model_dump(mode="json"),
        account_id=account_id,
    )


def _table(kind: str, frame: Any) -> list[dict[str, object]]:
    if not isinstance(frame, pd.DataFrame):
        raise ReportSchemaError(f"{kind} must be a DataFrame")
    if kind != "account" and _is_exact_native_empty_frame(frame):
        return []
    if not frame.columns.is_unique or set(frame.columns) != set(REPORT_SCHEMAS[kind].fields):
        raise ReportSchemaError(f"{kind} must have exact unique native columns")
    if kind == "positions":
        # The v1 event helper accepts a 'fills' extra but discards it. This boundary
        # cannot drop an uncharacterized native fact while claiming a complete table.
        for events in frame["events"]:
            if type(events) is list and any(type(e) is dict and "fills" in e for e in events):
                raise ReportSchemaError("uncharacterized nested position fills")
    rows = export_dataframe_report(kind, frame)
    if kind == "fills":
        keys = [(r["client_order_id"], r["trade_id"]) for r in rows]
        if len(keys) != len(set(keys)):
            raise ReportSchemaError("duplicate native order/trade identity")
    if kind == "account" and not rows:
        raise ReportSchemaError("historical CASH report requires its native account rows")
    return rows
