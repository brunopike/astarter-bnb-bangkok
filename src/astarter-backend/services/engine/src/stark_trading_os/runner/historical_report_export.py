"""Strict v2 MARKET order projection; not a complete or persisted run report."""

from __future__ import annotations

import re
from collections.abc import Mapping
from copy import deepcopy
from decimal import Decimal
from typing import Any, cast

from stark_trading_os.runner.report_export import (
    ReportSchema,
    ReportSchemaError,
    _is_exact_native_empty_frame,
    _is_report_null,
    _normalize_report_value,
    _records_with_explicit_index,
    _validate_unique_report_keys,
    pd,
)

MARKET_ORDER_SCHEMA_V2 = ReportSchema(
    index_name="client_order_id",
    fields=(
        "trader_id",
        "strategy_id",
        "instrument_id",
        "side",
        "type",
        "quantity",
        "status",
        "time_in_force",
        "is_reduce_only",
        "is_quote_quantity",
        "filled_qty",
        "init_id",
        "ts_init",
        "ts_last",
        "commissions",
        "venue_order_id",
        "emulation_trigger",
        "contingency_type",
        "order_list_id",
        "linked_order_ids",
        "parent_order_id",
        "exec_algorithm_id",
        "exec_algorithm_params",
        "exec_spawn_id",
        "tags",
        "account_id",
        "slippage",
        "position_id",
        "liquidity_side",
        "last_trade_id",
        "avg_px",
    ),
    sort_keys=("client_order_id",),
)
_OUTPUT_FIELDS = ("client_order_id", *MARKET_ORDER_SCHEMA_V2.fields)
_FILL_FACT_FIELDS = frozenset(
    {"commissions", "venue_order_id", "account_id", "position_id", "last_trade_id", "avg_px"}
)
_IDENTITY_FIELDS = frozenset(
    {
        "client_order_id",
        "trader_id",
        "strategy_id",
        "instrument_id",
        "init_id",
        "venue_order_id",
        "account_id",
        "position_id",
        "last_trade_id",
    }
)
_UINT64_MAX = 2**64 - 1
_CANONICAL_UINT64 = re.compile(r"(?:0|[1-9][0-9]{0,19})\Z")
_ZERO_FILL_STATUSES = frozenset(
    {
        "INITIALIZED",
        "DENIED",
        "EMULATED",
        "RELEASED",
        "SUBMITTED",
        "ACCEPTED",
        "REJECTED",
        "TRIGGERED",
    }
)


def export_historical_market_orders_v2(frame: Any) -> list[dict[str, object]]:
    """Project the observed rc3 MARKET-only table without padding LIMIT fields."""
    if not isinstance(frame, pd.DataFrame):
        raise ReportSchemaError("historical MARKET orders must be a DataFrame")
    if _is_exact_native_empty_frame(frame):
        return []
    if not frame.columns.is_unique:
        raise ReportSchemaError("historical MARKET orders have duplicate columns")
    if set(frame.columns) != set(MARKET_ORDER_SCHEMA_V2.fields):
        raise ReportSchemaError("historical MARKET orders must use the exact v2 columns")
    records = _records_with_explicit_index("orders", frame, MARKET_ORDER_SCHEMA_V2)
    rows = [normalize_historical_market_order_v2(row) for row in records]
    _validate_unique_report_keys("orders", rows)
    return sorted(rows, key=lambda row: cast(str, row["client_order_id"]))


def normalize_historical_market_order_v2(row: Mapping[str, object]) -> dict[str, object]:
    """Validate one v2 row and return an independent, JSON-safe normalization."""
    if not isinstance(row, Mapping) or set(row) != set(_OUTPUT_FIELDS):
        raise ReportSchemaError("historical MARKET order row must use the exact v2 schema")
    if row["type"] != "MARKET":
        raise ReportSchemaError("historical v2 order projection accepts only MARKET")

    quantity = Decimal(cast(str, _scalar("quantity", row["quantity"])))
    filled = Decimal(cast(str, _scalar("filled_qty", row["filled_qty"])))
    if quantity <= 0 or filled < 0 or filled > quantity:
        raise ReportSchemaError(
            "MARKET quantities require quantity > 0 and 0 <= filled <= quantity"
        )

    normalized: dict[str, object] = {}
    for field in _OUTPUT_FIELDS:
        value = row[field]
        if field in _FILL_FACT_FIELDS and _is_report_null(value):
            if filled > 0:
                raise ReportSchemaError(f"filled MARKET order is missing native {field}")
            normalized[field] = None
            continue
        value = _scalar(field, value)
        if field in {"ts_init", "ts_last"}:
            value = _canonical_timestamp(field, value)
        if field in _IDENTITY_FIELDS and (type(value) is not str or not value.strip()):
            raise ReportSchemaError(f"MARKET {field} must be a nonblank identity")
        normalized[field] = deepcopy(value)

    status = normalized["status"]
    if status == "FILLED" and filled != quantity:
        raise ReportSchemaError("FILLED MARKET order must have filled_qty equal to quantity")
    if status == "PARTIALLY_FILLED" and not 0 < filled < quantity:
        raise ReportSchemaError("PARTIALLY_FILLED MARKET order must have a strict partial quantity")
    if status in _ZERO_FILL_STATUSES and filled != 0:
        raise ReportSchemaError(f"{status} MARKET order must have zero filled_qty")
    if filled > 0 and not normalized["commissions"]:
        raise ReportSchemaError("filled MARKET order must retain native commission entries")
    if filled > 0 and Decimal(cast(str, normalized["avg_px"])) <= 0:
        raise ReportSchemaError("filled MARKET order must have a positive native avg_px")
    if int(cast(str, normalized["ts_last"])) < int(cast(str, normalized["ts_init"])):
        raise ReportSchemaError("MARKET ts_last must not precede ts_init")
    return normalized


def _scalar(field: str, value: object) -> object:
    return _normalize_report_value("orders", field, value, MARKET_ORDER_SCHEMA_V2.float_fields)


def _canonical_timestamp(field: str, value: object) -> str:
    if (
        type(value) is not str
        or _CANONICAL_UINT64.fullmatch(value) is None
        or int(value) > _UINT64_MAX
    ):
        raise ReportSchemaError(f"MARKET {field} must be a canonical ASCII unsigned64 timestamp")
    return value
