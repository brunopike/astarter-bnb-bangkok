"""Exact multi-currency projection of a complete finite component checkpoint series."""

from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import cast

from stark_trading_os.audit.canonical_json import CanonicalJSONError, canonical_decimal_string
from stark_trading_os.runner.historical_report_export import _canonical_timestamp
from stark_trading_os.runner.report_export import ReportSchemaError

_POINT_FIELDS = frozenset(
    {
        "phase",
        "sequence",
        "clock_ns",
        "bar_ts_event",
        "balances",
        "positions",
        "pending_orders",
        "realized_pnls",
        "unrealized_pnls",
        "total_pnls",
        "mark_values",
        "total_equity",
        "base_currency_equity",
        "is_stale",
        "stale_instruments",
        "stale_currencies",
        "unpriced_instruments",
    }
)
_VECTOR_FIELDS = ("realized_pnls", "unrealized_pnls", "total_pnls", "mark_values", "total_equity")
_STALE_FIELDS = ("stale_instruments", "stale_currencies", "unpriced_instruments")
_PENDING_STATUSES = frozenset(
    {
        "INITIALIZED",
        "EMULATED",
        "RELEASED",
        "SUBMITTED",
        "ACCEPTED",
        "TRIGGERED",
        "PENDING_UPDATE",
        "PENDING_CANCEL",
        "PARTIALLY_FILLED",
        "AWAITING_NATIVE_CACHE",
    }
)


def normalize_historical_cash_series_v2(
    component_snapshot: Mapping[str, object],
    *,
    expected_input_sha256: str,
    expected_bar_times: tuple[tuple[int, int], ...],
    currencies: tuple[str, str],
) -> dict[str, object]:
    """Validate consumed headers/points; unused component event tables remain separate."""
    if (
        type(expected_input_sha256) is not str
        or re.fullmatch(r"[0-9a-f]{64}", expected_input_sha256) is None
        or not isinstance(component_snapshot, Mapping)
        or component_snapshot.get("scope") != "IN_MEMORY_COMPONENT_CHECK"
        or component_snapshot.get("input_manifest_sha256") != expected_input_sha256
    ):
        raise ReportSchemaError("cash series input identity is invalid")
    if type(currencies) is not tuple or len(currencies) != 2:
        raise ReportSchemaError("cash series requires base and quote currencies")
    declared = {_text(value) for value in currencies}
    if len(declared) != 2:
        raise ReportSchemaError("cash series currencies must be distinct")
    timeline = _timeline(expected_bar_times)
    status = _text(component_snapshot.get("status"))
    failures = _strings(component_snapshot.get("failure_codes"))
    if status not in {"COMPONENT_CHECK_PASSED", "COMPONENT_CHECK_FAILED"} or (
        (status == "COMPONENT_CHECK_PASSED") != (not failures)
    ):
        raise ReportSchemaError("cash series status and failure codes disagree")
    raw_points = component_snapshot.get("checkpoints")
    if type(raw_points) is not list or len(raw_points) != len(timeline) + 1:
        raise ReportSchemaError("cash series requires every PRE_INTENT and one final checkpoint")
    points: list[dict[str, object]] = []
    for index, raw in enumerate(raw_points):
        row = _object(raw, _POINT_FIELDS)
        final = index == len(timeline)
        sequence = len(timeline) if final else index + 1
        phase = "FINAL_POST_RUN" if final else "PRE_INTENT"
        if type(row["sequence"]) is not int or row["sequence"] != sequence or row["phase"] != phase:
            raise ReportSchemaError("cash series phase or sequence is invalid")
        event, clock = timeline[sequence - 1]
        if _time(row["bar_ts_event"]) != event or _time(row["clock_ns"]) != clock:
            raise ReportSchemaError("cash series timestamps disagree with the loaded bars")
        balances = _object(row["balances"], declared)
        normalized_balances = {
            currency: {
                field: _number(value)
                for field, value in _object(balance, {"total", "free", "locked"}).items()
            }
            for currency, balance in balances.items()
        }
        if type(row["is_stale"]) is not bool or row["base_currency_equity"] is not None:
            raise ReportSchemaError("cash series requires native multi-currency snapshot flags")
        point: dict[str, object] = {
            "phase": phase,
            "sequence": sequence,
            "clock_ns": clock,
            "bar_ts_event": event,
            "balances": normalized_balances,
            "positions": _positions(row["positions"]),
            "pending_orders": _pending(row["pending_orders"]),
            "base_currency_equity": None,
            "is_stale": row["is_stale"],
        }
        for field in _VECTOR_FIELDS:
            vector = _object(row[field])
            if not set(vector).issubset(declared) or (
                field == "total_equity" and set(vector) != declared
            ):
                raise ReportSchemaError("cash series has missing or unexpected monetary currencies")
            point[field] = {currency: _number(value) for currency, value in vector.items()}
        for field in _STALE_FIELDS:
            point[field] = _strings(row[field])
        if status == "COMPONENT_CHECK_PASSED" and (
            point["is_stale"] or any(point[field] for field in _STALE_FIELDS)
        ):
            raise ReportSchemaError("passed cash series cannot contain stale or unpriced facts")
        points.append(point)
    return {
        "schema_version": 2,
        "scope": "IN_MEMORY_NATIVE_CASH_SERIES",
        "input_manifest_sha256": expected_input_sha256,
        "component_status": status,
        "failure_codes": failures,
        "points": points,
    }


def _timeline(value: object) -> tuple[tuple[str, str], ...]:
    if type(value) is not tuple or not value:
        raise ReportSchemaError("cash series requires a nonempty loaded bar timeline")
    result: list[tuple[str, str]] = []
    for pair in value:
        if type(pair) is not tuple or len(pair) != 2 or any(type(item) is not int for item in pair):
            raise ReportSchemaError("loaded bar times must be strict integer pairs")
        event, clock = _time(pair[0]), _time(pair[1])
        if int(clock) < int(event) or (
            result and (int(event) <= int(result[-1][0]) or int(clock) < int(result[-1][1]))
        ):
            raise ReportSchemaError("loaded bar timeline is not causal and ordered")
        result.append((event, clock))
    return tuple(result)


def _time(value: object) -> str:
    return _canonical_timestamp("checkpoint", str(value) if type(value) is int else value)


def _object(value: object, fields: set[str] | frozenset[str] | None = None) -> dict[str, object]:
    if type(value) is not dict or not all(type(key) is str for key in value):
        raise ReportSchemaError("cash series record must be an object with string keys")
    if fields is not None and set(value) != fields:
        raise ReportSchemaError("cash series record must use the exact declared fields")
    return cast(dict[str, object], value)


def _text(value: object) -> str:
    if type(value) is not str or not value.strip():
        raise ReportSchemaError("cash series identities must be nonblank strings")
    return value


def _strings(value: object) -> list[str]:
    if type(value) is not list:
        raise ReportSchemaError("cash series string collection must be a list")
    result = [_text(item) for item in value]
    if len(set(result)) != len(result):
        raise ReportSchemaError("cash series string collection contains duplicates")
    return result


def _number(value: object) -> str:
    if type(value) is not str and not isinstance(value, Decimal):
        raise ReportSchemaError("cash series amounts must be decimal strings or Decimal")
    try:
        return canonical_decimal_string(Decimal(value))
    except (InvalidOperation, ValueError, CanonicalJSONError) as error:
        raise ReportSchemaError("cash series amounts must be finite decimals") from error


def _positions(value: object) -> list[dict[str, object]]:
    if type(value) is not list:
        raise ReportSchemaError("cash series positions must be a list")
    result: list[dict[str, object]] = []
    for item in value:
        row = _object(item, {"quantity", "side"})
        quantity, side = _number(row["quantity"]), _text(row["side"])
        if Decimal(quantity) < 0 or side not in {"LONG", "SHORT"}:
            raise ReportSchemaError("cash series position shape is invalid")
        result.append({"quantity": quantity, "side": side})
    return result


def _pending(value: object) -> list[dict[str, object]]:
    if type(value) is not list:
        raise ReportSchemaError("cash series pending orders must be a list")
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in value:
        row = _object(item, {"id", "status", "leaves_quantity"})
        identity, status = _text(row["id"]), _text(row["status"])
        if identity in seen or status not in _PENDING_STATUSES:
            raise ReportSchemaError("cash series pending identity or status is invalid")
        seen.add(identity)
        quantity = row["leaves_quantity"]
        if status == "AWAITING_NATIVE_CACHE":
            if quantity is not None:
                raise ReportSchemaError("unobserved native cache quantity must stay None")
        else:
            quantity = _number(quantity)
            if Decimal(quantity) < 0:
                raise ReportSchemaError("pending leaves quantity cannot be negative")
        result.append({"id": identity, "status": status, "leaves_quantity": quantity})
    return result
