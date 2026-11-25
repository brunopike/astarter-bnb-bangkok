"""Static ReplayNormalization.v1 projections and digest."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from typing import cast

from stark_trading_os.audit.canonical_json import (
    CanonicalJSONError,
    canonical_decimal_string,
    canonical_json_bytes,
)
from stark_trading_os.runner.report_export import (
    REPORT_SCHEMAS,
    ReportSchemaError,
    export_metrics,
    normalize_report_row,
)

_SCHEMA = "ReplayNormalization.v1"
_REPORT_KINDS = frozenset({"orders", "fills", "positions", "account", "metrics"})
_EVENT_ENVELOPE_FIELDS = frozenset(
    {
        "run_id",
        "event_id",
        "seq",
        "source_seq",
        "ts_event_ns",
        "ts_ingest_ns",
        "type",
        "source",
        "writer",
        "schema_version",
        "payload",
        "process_id",
        "file_path",
        "duration_ns",
        "wall_clock_ns",
    }
)
_EVENT_REQUIRED_FIELDS = frozenset(
    {
        "event_id",
        "run_id",
        "seq",
        "source_seq",
        "ts_event_ns",
        "ts_ingest_ns",
        "type",
        "source",
        "writer",
        "schema_version",
        "payload",
    }
)
_PAYLOAD_OPERATIONAL_FIELDS = frozenset(
    {
        "run_id",
        "event_id",
        "causation_id",
        "correlation_id",
        "process_id",
        "file_path",
        "ts_ingest_ns",
        "wall_clock_ns",
        "duration_ns",
    }
)
_EVENT_PAYLOAD_FIELDS = {
    "order.submitted": frozenset(
        {"client_order_id", "instrument_id", "side", "type", "quantity", "price", "status"}
    ),
    "order.accepted": frozenset({"client_order_id", "instrument_id", "venue_order_id", "status"}),
    "order.rejected": frozenset({"client_order_id", "instrument_id", "reason", "status"}),
    "order.partially_filled": frozenset(
        {
            "client_order_id",
            "instrument_id",
            "last_qty",
            "last_px",
            "filled_qty",
            "trade_id",
            "commission",
            "currency",
            "liquidity_side",
        }
    ),
    "order.filled": frozenset(
        {
            "client_order_id",
            "instrument_id",
            "last_qty",
            "last_px",
            "filled_qty",
            "trade_id",
            "commission",
            "currency",
            "liquidity_side",
        }
    ),
    "order.cancel_pending": frozenset({"client_order_id", "instrument_id", "status"}),
    "order.cancelled": frozenset({"client_order_id", "instrument_id", "status"}),
    "position.opened": frozenset(
        {"position_id", "instrument_id", "side", "quantity", "price", "client_order_id"}
    ),
    "position.changed": frozenset(
        {"position_id", "instrument_id", "side", "quantity", "price", "client_order_id", "trade_id"}
    ),
    "position.closed": frozenset(
        {
            "position_id",
            "instrument_id",
            "side",
            "quantity",
            "price",
            "client_order_id",
            "trade_id",
            "realized_pnl",
        }
    ),
    "risk.rejected": frozenset({"rule_id", "reason", "client_order_id", "instrument_id"}),
}
_EVENT_REQUIRED_PAYLOAD_FIELDS = {
    "order.submitted": frozenset(
        {"client_order_id", "instrument_id", "side", "type", "quantity"}
    ),
    "order.accepted": frozenset({"client_order_id", "instrument_id", "venue_order_id"}),
    "order.rejected": frozenset({"client_order_id", "instrument_id", "reason"}),
    "order.partially_filled": frozenset(
        {
            "client_order_id",
            "instrument_id",
            "last_qty",
            "last_px",
            "filled_qty",
            "trade_id",
            "commission",
            "currency",
            "liquidity_side",
        }
    ),
    "order.filled": frozenset(
        {
            "client_order_id",
            "instrument_id",
            "last_qty",
            "last_px",
            "filled_qty",
            "trade_id",
            "commission",
            "currency",
            "liquidity_side",
        }
    ),
    "order.cancel_pending": frozenset({"client_order_id", "instrument_id"}),
    "order.cancelled": frozenset({"client_order_id", "instrument_id"}),
    "position.opened": frozenset(
        {"position_id", "instrument_id", "side", "quantity", "price", "client_order_id"}
    ),
    "position.changed": frozenset(
        {"position_id", "instrument_id", "side", "quantity", "price", "client_order_id"}
    ),
    "position.closed": frozenset(
        {
            "position_id",
            "instrument_id",
            "side",
            "quantity",
            "price",
            "client_order_id",
            "realized_pnl",
        }
    ),
    "risk.rejected": frozenset({"rule_id", "reason", "client_order_id", "instrument_id"}),
}
_ECONOMIC_DECIMAL_FIELDS = frozenset({"quantity", "price", "last_qty", "last_px", "filled_qty"})
_ECONOMIC_STRING_FIELDS = frozenset(
    {
        "client_order_id",
        "instrument_id",
        "side",
        "type",
        "status",
        "venue_order_id",
        "reason",
        "trade_id",
        "currency",
        "liquidity_side",
        "position_id",
        "rule_id",
    }
)
_EVENT_VALUE_DOMAINS: dict[str, dict[str, frozenset[str]]] = {
    "order.submitted": {
        "side": frozenset({"BUY", "SELL"}),
        "type": frozenset({"LIMIT", "MARKET"}),
        "status": frozenset({"SUBMITTED"}),
    },
    "order.accepted": {"status": frozenset({"ACCEPTED"})},
    "order.rejected": {"status": frozenset({"REJECTED"})},
    "order.partially_filled": {"liquidity_side": frozenset({"MAKER", "TAKER"})},
    "order.filled": {"liquidity_side": frozenset({"MAKER", "TAKER"})},
    "order.cancel_pending": {"status": frozenset({"PENDING_CANCEL"})},
    "order.cancelled": {"status": frozenset({"CANCELED"})},
    "position.opened": {"side": frozenset({"LONG", "SHORT"})},
    "position.changed": {"side": frozenset({"LONG", "SHORT"})},
    "position.closed": {"side": frozenset({"FLAT"})},
    "risk.rejected": {
        "rule_id": frozenset({"NAUTILUS_MAX_NOTIONAL_PER_ORDER"}),
    },
}
_OPERATIONAL_RUNNER_TYPES = frozenset({"run.progress"})
_PROGRESS_FIELDS = frozenset({"progress", "decision_ts_ns", "quote_identity"})
_QUOTE_IDENTITY_FIELDS = frozenset(
    {
        "instrument_id",
        "ts_event_ns",
        "ts_available_ns",
        "source_seq",
        "source_revision",
        "record_hash",
    }
)
_CONTROL_LIFECYCLE_TYPES = frozenset(
    {
        "catalog.validated",
        "preflight.passed",
        "preflight.blocked",
        "run.queued",
        "run.started",
        "run.cancel_requested",
        "run.cancel_pending",
        "run.finalizing",
        "report.generated",
        "run.completed",
        "run.failed",
        "run.cancelled",
    }
)
_REPORT_OPERATIONAL_FIELDS = {
    "orders": frozenset({"init_id"}),
    "fills": frozenset({"event_id", "causation_id"}),
    "positions": frozenset(),
    "account": frozenset(),
}
_POSITION_EVENT_FIELDS = frozenset(
    {
        "type",
        "trader_id",
        "strategy_id",
        "instrument_id",
        "client_order_id",
        "venue_order_id",
        "account_id",
        "trade_id",
        "order_side",
        "order_type",
        "last_qty",
        "last_px",
        "currency",
        "liquidity_side",
        "ts_event",
        "ts_init",
        "reconciliation",
        "info",
        "position_id",
        "commission",
    }
)
_POSITION_EVENT_EXCLUDED_FIELDS = frozenset(
    {"event_id", "run_id", "causation_id", "ts_ingest_ns", "fills"}
)


class ReplaySchemaError(ValueError):
    """Raised when evidence cannot be normalized under ReplayNormalization.v1."""


def replay_digest_v1(run: Mapping[str, object]) -> str:
    """Hash static event and report projections for one input manifest."""

    _require_exact_keys(run, {"input_manifest_hash", "events", "reports"}, "run")
    manifest_hash = run["input_manifest_hash"]
    if (
        type(manifest_hash) is not str
        or len(manifest_hash) != 64
        or any(char not in "0123456789abcdef" for char in manifest_hash)
    ):
        raise ReplaySchemaError(
            "input_manifest_hash must be a lowercase SHA-256 hexadecimal string"
        )
    events = run["events"]
    reports = run["reports"]
    if not isinstance(events, Sequence) or isinstance(events, str | bytes | bytearray):
        raise ReplaySchemaError("events must be a list")
    if not isinstance(reports, Mapping):
        raise ReplaySchemaError("reports must be an object")
    event_projection = project_events(events)
    report_projections = project_reports(reports)
    digest_object = {
        "schema": _SCHEMA,
        "input_manifest_hash": manifest_hash,
        "event_projection_hash": _digest(event_projection),
        "report_projection_hashes": {
            name: _digest(projection) for name, projection in report_projections.items()
        },
    }
    return _digest(digest_object)


def project_events(events: Sequence[object]) -> list[dict[str, object]]:
    """Validate all runner sequence numbers and project only economic events."""

    previous_source_seq = -1
    seen_source_seqs: set[int] = set()
    active_instrument_id: str | None = None
    active_currency: str | None = None
    economic: list[dict[str, object]] = []
    for event in events:
        if not isinstance(event, Mapping):
            raise ReplaySchemaError("event must be an object")
        _require_exact_keys(event, _EVENT_REQUIRED_FIELDS, "event")
        _validate_event_envelope(event)
        event_type = event["type"]
        if type(event_type) is not str:
            raise ReplaySchemaError("event type must be a string")
        source = event["source"]
        if source == "control-api":
            if event_type not in _CONTROL_LIFECYCLE_TYPES:
                raise ReplaySchemaError(f"unknown control lifecycle event type: {event_type}")
            _validate_json_value(event["payload"], "control lifecycle payload")
            continue
        if source != "runner":
            raise ReplaySchemaError("replay events must be runner or control-api produced")
        source_seq = event["source_seq"]
        if type(source_seq) is not int or source_seq < 0:
            raise ReplaySchemaError("source_seq must be a non-negative integer")
        if source_seq in seen_source_seqs:
            raise ReplaySchemaError(f"duplicate source_seq: {source_seq}")
        if source_seq <= previous_source_seq:
            raise ReplaySchemaError(f"source_seq regression: {source_seq}")
        seen_source_seqs.add(source_seq)
        previous_source_seq = source_seq
        if event_type in _OPERATIONAL_RUNNER_TYPES:
            progress_instrument_id = _validate_progress_payload(event["payload"])
            active_instrument_id = _bind_evidence_value(
                "instrument",
                active_instrument_id,
                progress_instrument_id,
            )
            continue
        if event_type not in _EVENT_PAYLOAD_FIELDS:
            raise ReplaySchemaError(f"unknown event type: {event_type}")
        timestamp = event["ts_event_ns"]
        if type(timestamp) is not str or not timestamp.isdecimal():
            raise ReplaySchemaError("ts_event_ns must be a non-negative decimal string")
        payload = event["payload"]
        if not isinstance(payload, Mapping):
            raise ReplaySchemaError("event payload must be an object")
        normalized_payload = _project_payload(event_type, payload)
        active_instrument_id = _bind_evidence_value(
            "instrument",
            active_instrument_id,
            cast(str, normalized_payload["instrument_id"]),
        )
        if "currency" in normalized_payload:
            active_currency = _bind_evidence_value(
                "currency",
                active_currency,
                cast(str, normalized_payload["currency"]),
            )
        if "realized_pnl" in normalized_payload:
            active_currency = _bind_evidence_value(
                "currency",
                active_currency,
                cast(str, normalized_payload["realized_pnl"]).rsplit(" ", maxsplit=1)[1],
            )
        economic.append(
            {
                "source_seq": source_seq,
                "ts_event_ns": timestamp,
                "type": event_type,
                "normalized_payload": normalized_payload,
            }
        )
    economic.sort(
        key=lambda row: (
            int(cast(str, row["ts_event_ns"])),
            cast(int, row["source_seq"]),
        )
    )
    return [
        {
            "replay_index": index,
            "ts_event_ns": row["ts_event_ns"],
            "type": row["type"],
            "normalized_payload": row["normalized_payload"],
        }
        for index, row in enumerate(economic)
    ]


def _validate_progress_payload(value: object) -> str:
    if not isinstance(value, Mapping):
        raise ReplaySchemaError("progress payload must be an object")
    _require_exact_keys(value, _PROGRESS_FIELDS, "progress payload")
    if value["progress"] != "decision":
        raise ReplaySchemaError("progress must be decision")
    decision_ts_ns = value["decision_ts_ns"]
    if not _is_nanosecond_string(decision_ts_ns):
        raise ReplaySchemaError("progress decision_ts_ns must be a nanosecond string")
    identity = value["quote_identity"]
    if not isinstance(identity, Mapping):
        raise ReplaySchemaError("progress quote_identity must be an object")
    _require_exact_keys(identity, _QUOTE_IDENTITY_FIELDS, "progress quote_identity")
    for field in ("instrument_id", "source_revision"):
        if type(identity[field]) is not str or not identity[field]:
            raise ReplaySchemaError(f"progress quote_identity {field} must be a string")
    for field in ("ts_event_ns", "ts_available_ns"):
        if not _is_nanosecond_string(identity[field]):
            raise ReplaySchemaError(
                f"progress quote_identity {field} must be a nanosecond string"
            )
    quote_source_seq = identity["source_seq"]
    if type(quote_source_seq) is not int or quote_source_seq < 1:
        raise ReplaySchemaError("progress quote_identity source_seq must start at one")
    record_hash = identity["record_hash"]
    if (
        type(record_hash) is not str
        or len(record_hash) != 64
        or any(character not in "0123456789abcdef" for character in record_hash)
    ):
        raise ReplaySchemaError("progress quote_identity record_hash must be SHA-256")
    available = identity["ts_available_ns"]
    if (len(available), available) > (len(decision_ts_ns), decision_ts_ns):
        raise ReplaySchemaError("progress quote is not available at decision time")
    return cast(str, identity["instrument_id"])


def _is_nanosecond_string(value: object) -> bool:
    return (
        type(value) is str
        and value.isdecimal()
        and (value == "0" or not value.startswith("0"))
    )


def project_reports(reports: Mapping[str, object]) -> dict[str, object]:
    """Project the five report kinds with their checked-in fields and keys."""

    _require_exact_keys(reports, _REPORT_KINDS, "reports")
    projections: dict[str, object] = {}
    for kind in ("orders", "fills", "positions", "account"):
        rows = reports[kind]
        if not isinstance(rows, Sequence) or isinstance(rows, str | bytes | bytearray):
            raise ReplaySchemaError(f"{kind} report must be a list")
        projections[kind] = _project_report_rows(kind, rows)
    metrics = reports["metrics"]
    if not isinstance(metrics, Mapping):
        raise ReplaySchemaError("metrics report must be an object")
    try:
        projections["metrics"] = export_metrics(metrics)
    except ReportSchemaError as error:
        raise ReplaySchemaError(str(error)) from error
    return projections


def _project_report_rows(kind: str, rows: Sequence[object]) -> list[dict[str, object]]:
    schema = REPORT_SCHEMAS[kind]
    primary_key = "ts_event_ns" if kind == "account" else schema.index_name
    if primary_key is None:
        raise ReplaySchemaError(f"{kind} report has no primary key")
    fields = {primary_key, *schema.fields}
    normalized_rows: list[dict[str, object]] = []
    seen_keys: set[tuple[str, ...]] = set()
    account_ties: set[tuple[str, ...]] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            raise ReplaySchemaError(f"{kind} row must be an object")
        _require_exact_keys(row, fields, f"{kind} report row")
        for field in fields:
            if field not in row:
                raise ReplaySchemaError(f"{kind} report missing field {field}")
        try:
            normalized_row = normalize_report_row(kind, row)
        except ReportSchemaError as error:
            raise ReplaySchemaError(str(error)) from error
        projected = {
            field: value
            for field, value in normalized_row.items()
            if field not in _REPORT_OPERATIONAL_FIELDS[kind]
        }
        if kind == "positions":
            projected["events"] = _project_position_events(projected["events"])
        _validate_json_value(projected, f"{kind} report")
        key = tuple(str(projected[field]) for field in _report_key_fields(kind))
        if kind == "account":
            tie = (*key, canonical_json_bytes(projected).hex())
            if tie in account_ties:
                raise ReplaySchemaError(f"account report has duplicate economic row {key}")
            account_ties.add(tie)
        elif key in seen_keys:
            raise ReplaySchemaError(f"{kind} report has duplicate primary key {key}")
        seen_keys.add(key)
        normalized_rows.append(projected)
    try:
        return sorted(
            normalized_rows,
            key=lambda row: (
                tuple(_sort_value(row[key]) for key in schema.sort_keys)
                + ((canonical_json_bytes(row).hex(),) if kind == "account" else ())
            ),
        )
    except KeyError as error:
        raise ReplaySchemaError(f"{kind} report missing sort key {error.args[0]}") from error


def _project_payload(event_type: str, payload: Mapping[str, object]) -> dict[str, object]:
    unknown = set(payload).difference(
        _EVENT_PAYLOAD_FIELDS[event_type] | _PAYLOAD_OPERATIONAL_FIELDS
    )
    if unknown:
        raise ReplaySchemaError(f"unknown field in {event_type} payload: {sorted(unknown)[0]}")
    missing = _EVENT_REQUIRED_PAYLOAD_FIELDS[event_type].difference(payload)
    if missing:
        raise ReplaySchemaError(f"missing payload field in {event_type}: {sorted(missing)[0]}")
    if event_type == "order.submitted":
        order_type = payload.get("type")
        if order_type == "LIMIT" and "price" not in payload:
            raise ReplaySchemaError("order.submitted LIMIT requires price")
        if order_type == "MARKET" and "price" in payload:
            raise ReplaySchemaError("order.submitted MARKET must omit price")
    normalized = {
        key: value for key, value in payload.items() if key not in _PAYLOAD_OPERATIONAL_FIELDS
    }
    for field in _ECONOMIC_DECIMAL_FIELDS.intersection(normalized):
        value = normalized[field]
        if type(value) is not str:
            raise ReplaySchemaError(f"{event_type} {field} must be decimal string")
        try:
            normalized[field] = canonical_decimal_string(Decimal(value))
        except (CanonicalJSONError, InvalidOperation, ValueError) as error:
            raise ReplaySchemaError(f"{event_type} {field} must be decimal string") from error
    for field in _ECONOMIC_STRING_FIELDS.intersection(normalized):
        if type(normalized[field]) is not str:
            raise ReplaySchemaError(f"{event_type} {field} must be a string")
    for field, allowed in _EVENT_VALUE_DOMAINS[event_type].items():
        if field in normalized and normalized[field] not in allowed:
            raise ReplaySchemaError(f"{event_type} {field} is outside the closed domain")
    if "currency" in normalized and not re.fullmatch(
        r"[A-Z][A-Z0-9]{1,15}", cast(str, normalized["currency"])
    ):
        raise ReplaySchemaError(f"{event_type} currency is outside the closed domain")
    if "commission" in normalized:
        normalized["commission"] = _normalize_payload_money(
            event_type, normalized["commission"], normalized.get("currency")
        )
    if "realized_pnl" in normalized:
        normalized["realized_pnl"] = _normalize_payload_money(
            event_type, normalized["realized_pnl"], None
        )
    _validate_json_value(normalized, f"{event_type} payload")
    return normalized


def _normalize_payload_money(event_type: str, value: object, currency: object) -> str:
    if type(value) is not str:
        raise ReplaySchemaError(f"{event_type} Money value must be a string")
    parts = value.split(" ")
    if len(parts) != 2 or not parts[1] or (currency is not None and parts[1] != currency):
        raise ReplaySchemaError(f"{event_type} Money value has invalid currency")
    if not re.fullmatch(r"[A-Z][A-Z0-9]{1,15}", parts[1]):
        raise ReplaySchemaError(f"{event_type} Money value has invalid currency")
    try:
        normalized_amount = canonical_decimal_string(Decimal(parts[0]))
    except (CanonicalJSONError, InvalidOperation, ValueError) as error:
        raise ReplaySchemaError(f"{event_type} Money value must be canonical decimal") from error
    normalized = f"{normalized_amount} {parts[1]}"
    if normalized != value:
        raise ReplaySchemaError(f"{event_type} Money value must already be canonical")
    return normalized


def _bind_evidence_value(kind: str, active: str | None, observed: str) -> str:
    if active is not None and active != observed:
        raise ReplaySchemaError(f"runner evidence {kind} drift")
    return observed


def _project_position_events(value: object) -> list[dict[str, object]]:
    if type(value) is not list:
        raise ReplaySchemaError("positions.events must be a list")
    projected: list[dict[str, object]] = []
    for event in value:
        if not isinstance(event, Mapping):
            raise ReplaySchemaError("positions.events entries must be objects")
        unknown = set(event).difference(_POSITION_EVENT_FIELDS | _POSITION_EVENT_EXCLUDED_FIELDS)
        if unknown:
            raise ReplaySchemaError(f"unknown field in positions.events: {sorted(unknown)[0]}")
        missing = _POSITION_EVENT_FIELDS.difference(event)
        if missing:
            raise ReplaySchemaError(f"positions.events missing field {sorted(missing)[0]}")
        if event["type"] != "OrderFilled":
            raise ReplaySchemaError("positions.events type must be OrderFilled")
        normalized = {key: item for key, item in event.items() if key in _POSITION_EVENT_FIELDS}
        for field in ("ts_event", "ts_init"):
            value = normalized[field]
            if type(value) is int and value >= 0:
                normalized[field] = str(value)
            elif type(value) is str and value.isdecimal():
                normalized[field] = value
            else:
                raise ReplaySchemaError(
                    f"positions.events {field} must be non-negative integer or decimal string"
                )
        for field in ("last_qty", "last_px"):
            value = normalized[field]
            if type(value) is not str:
                raise ReplaySchemaError(f"positions.events {field} must be decimal string")
            try:
                normalized[field] = canonical_decimal_string(Decimal(value))
            except (CanonicalJSONError, ValueError) as error:
                raise ReplaySchemaError(
                    f"positions.events {field} must be decimal string"
                ) from error
        _validate_json_value(normalized, "positions.events")
        projected.append(normalized)
    return projected


def _validate_json_value(value: object, location: str) -> None:
    try:
        # This is an arbitrary nested payload, not a declared production root.
        canonical_json_bytes({"value": value})
    except CanonicalJSONError as error:
        raise ReplaySchemaError(f"{location}: {error}") from error


def _require_exact_keys(
    value: Mapping[str, object],
    expected: set[str] | frozenset[str],
    location: str,
    *,
    allow_subset: bool = False,
) -> None:
    unknown = set(value).difference(expected)
    if unknown:
        raise ReplaySchemaError(f"unknown field in {location}: {sorted(unknown)[0]}")
    if not allow_subset:
        missing = set(expected).difference(value)
        if missing:
            raise ReplaySchemaError(f"{location} missing field {sorted(missing)[0]}")


def _validate_event_envelope(event: Mapping[str, object]) -> None:
    for field in ("event_id", "run_id", "ts_event_ns", "ts_ingest_ns", "type", "source", "writer"):
        value = event[field]
        if type(value) is not str:
            raise ReplaySchemaError(f"event {field} must be a string")
    for field in ("ts_event_ns", "ts_ingest_ns"):
        if not str(event[field]).isdecimal():
            raise ReplaySchemaError(f"event {field} must be a non-negative decimal string")
    for field in ("seq", "source_seq", "schema_version"):
        value = event[field]
        if type(value) is not int or value < 0:
            raise ReplaySchemaError(f"event {field} must be a non-negative integer")
    if event["writer"] != "control-api":
        raise ReplaySchemaError("event writer must be control-api")
    if event["schema_version"] != 1:
        raise ReplaySchemaError("event schema_version must be 1")
    if not isinstance(event["payload"], Mapping):
        raise ReplaySchemaError("event payload must be an object")


def _report_key_fields(kind: str) -> tuple[str, ...]:
    if kind == "orders":
        return ("client_order_id",)
    if kind == "fills":
        return ("ts_event", "client_order_id", "trade_id")
    if kind == "positions":
        return ("position_id",)
    return ("ts_event_ns", "account_id", "currency")


def _digest(value: object) -> str:
    try:
        return sha256(canonical_json_bytes(value)).hexdigest()
    except CanonicalJSONError as error:
        raise ReplaySchemaError(str(error)) from error


def _sort_value(value: object) -> tuple[int, object]:
    if type(value) is str and value.isdecimal():
        return (0, int(value))
    if type(value) is int:
        return (0, value)
    if value is None:
        return (1, "")
    return (2, str(value))
