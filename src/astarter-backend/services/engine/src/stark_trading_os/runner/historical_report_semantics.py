"""Shared normalized historical report facts; no engine or run authority."""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from collections import defaultdict
from decimal import Decimal
from fractions import Fraction
from typing import Any, cast

from stark_trading_os.runner.historical_cash_reconciliation import (
    apply_native_fill_cash,
    initial_native_cash,
    native_position_matches_cash,
)
from stark_trading_os.runner.historical_cash_report import (
    _PENDING_STATUSES,
    _VECTOR_FIELDS,
    normalize_historical_cash_series_v2,
)
from stark_trading_os.runner.historical_report_export import (
    _canonical_timestamp,
    normalize_historical_market_order_v2,
)
from stark_trading_os.runner.report_export import (
    _DECIMAL_FIELDS,
    _MONEY_FIELDS,
    _MONEY_LIST_FIELDS,
    _TIMESTAMP_FIELDS,
    REPORT_SCHEMAS,
    ReportSchemaError,
    _row_fingerprint,
    _sort_value,
    _validate_unique_report_keys,
    normalize_report_row,
)

_COMPONENT_FIELDS = frozenset(
    {
        "scope",
        "status",
        "input_manifest_sha256",
        "failure_codes",
        "checkpoints",
        "decisions",
        "native_fill_facts",
        "native_order_events",
    }
)
_NONBLANK_FIELDS = frozenset(
    {
        "client_order_id",
        "trader_id",
        "strategy_id",
        "instrument_id",
        "account_id",
        "position_id",
        "trade_id",
        "event_id",
        "venue_order_id",
        "opening_order_id",
        "closing_order_id",
        "last_trade_id",
        "init_id",
        "currency",
    }
)


def normalize_historical_report_tables_v2(value: object) -> dict[str, list[dict[str, object]]]:
    """Normalize exact table facts, preserving every distinct account snapshot."""
    if type(value) is not dict or set(value) != {"orders", "fills", "positions", "account"}:
        raise ReportSchemaError("historical report requires exactly four native tables")
    tables: dict[str, list[dict[str, object]]] = {}
    for kind in ("orders", "fills", "positions", "account"):
        raw_rows = value[kind]
        if type(raw_rows) is not list or any(type(row) is not dict for row in raw_rows):
            raise ReportSchemaError("historical report tables require object rows")
        for row in raw_rows:
            _check_row_amounts(kind, row)
        if kind == "positions":
            for row in raw_rows:
                events = row.get("events")
                if type(events) is list and any(type(e) is dict and "fills" in e for e in events):
                    raise ReportSchemaError("uncharacterized nested position fills")
        rows = [
            normalize_historical_market_order_v2(row)
            if kind == "orders"
            else normalize_report_row(kind, row)
            for row in raw_rows
        ]
        _validate_unique_report_keys(kind, rows)
        if kind == "fills":
            keys = [(r["client_order_id"], r["trade_id"]) for r in rows]
            if len(keys) != len(set(keys)):
                raise ReportSchemaError("duplicate native order/trade identity")
        if kind == "account" and not rows:
            raise ReportSchemaError("historical CASH report requires its native account rows")
        tables[kind] = (
            sorted(rows, key=lambda row: cast(str, row["client_order_id"]))
            if kind == "orders"
            else sorted(
                rows,
                key=lambda row: (
                    tuple(_sort_value(row[key]) for key in REPORT_SCHEMAS[kind].sort_keys)
                    + ((_row_fingerprint(row),) if kind == "account" else ())
                ),
            )
        )
    _strict_values(tables)
    return tables


def validate_historical_report_facts_v2(
    *,
    snapshot: dict[str, Any],
    tables: dict[str, list[dict[str, object]]],
    expected_input_sha256: str,
    expected_bar_times: tuple[tuple[int, int], ...],
    currencies: tuple[str, str],
    instrument_id: str,
    account_id: str,
    starting_cash: str,
) -> tuple[dict[str, object], tuple[str, ...]]:
    """Check codec-normalized tables against the original native component facts."""
    if set(snapshot) != _COMPONENT_FIELDS:
        raise ReportSchemaError("component snapshot schema differs")
    for name in ("decisions", "native_fill_facts", "native_order_events"):
        if type(snapshot[name]) is not list:
            raise ReportSchemaError(f"component {name} must be a list")
    _check_snapshot_amounts(snapshot)
    cash_series = normalize_historical_cash_series_v2(
        snapshot,
        expected_input_sha256=expected_input_sha256,
        expected_bar_times=expected_bar_times,
        currencies=currencies,
    )
    _strict_values(tables)
    _currencies(tables, currencies)
    failures = _consistency(tables, instrument_id, account_id)
    points = cast(list[dict[str, object]], cash_series["points"])
    if not _account_cash_matches(tables["account"], points, currencies):
        failures.add("REPORT_ACCOUNT_CASH_MISMATCH")
    if not _order_trace_matches(snapshot, tables["orders"], points):
        failures.add("REPORT_ORDER_TRACE_MISMATCH")
    if not _snapshot_fills_match(snapshot["native_fill_facts"], tables["fills"], currencies):
        failures.add("NATIVE_FILL_FACT_MISMATCH")
    if not _position_endpoint_matches(tables["positions"], points[-1]):
        failures.add("REPORT_POSITION_CASH_MISMATCH")
    cash_matches = _cash_reconciles(
        points, snapshot["native_fill_facts"], currencies, starting_cash
    )
    if cash_series["component_status"] != "COMPONENT_CHECK_PASSED" or not cash_matches:
        failures.add("COMPONENT_CHECK_FAILED")
    return cash_series, tuple(sorted(failures))


def _cash_reconciles(
    points: list[dict[str, object]],
    facts: list[dict[str, Any]],
    currencies: tuple[str, str],
    starting_cash: str,
) -> bool:
    """Reconcile native deltas without treating same-time account sort order as causal."""
    expected = initial_native_cash(currencies, _bounded_plain_decimal(starting_cash))
    states = [dict(expected)]
    times: list[int] = []
    start, end = int(cast(str, points[0]["clock_ns"])), int(cast(str, points[-1]["clock_ns"]))
    for fact in facts:  # Raw callback order is retained; never sort it by UUID or table keys.
        timestamp = fact["ts_event"]
        if not start <= timestamp <= end or (times and timestamp < times[-1]):
            return False
        times.append(timestamp)
        apply_native_fill_cash(expected, fact["cash_delta"], fact["commission"])
        states.append(dict(expected))
    previous = 0
    for index, point in enumerate(points):
        balances = cast(dict[str, dict[str, str]], point["balances"])
        totals = {currency: Fraction(value["total"]) for currency, value in balances.items()}
        if not native_position_matches_cash(
            cast(list[dict[str, object]], point["positions"]), totals[currencies[0]]
        ):
            return False
        clock = int(cast(str, point["clock_ns"]))
        lower, upper = bisect_left(times, clock), bisect_right(times, clock)
        if index == 0:
            lower = upper = 0  # PRE_INTENT exists before any submission.
        elif index == len(points) - 1:
            lower = upper = len(facts)  # FINAL_POST_RUN includes every observed fill.
        # At a shared timestamp, allow an observed callback prefix; do not invent
        # an ordering from canonical account rows. Prefixes may never go backwards.
        match = next(
            (i for i in range(max(lower, previous), upper + 1) if states[i] == totals), None
        )
        if match is None:
            return False
        previous = match
    return True


def _position_endpoint_matches(rows: list[dict[str, object]], final: dict[str, object]) -> bool:
    open_positions = []
    for row in rows:
        quantity = Fraction(cast(str, row["quantity"]))
        events = cast(list[dict[str, object]], row["events"])
        bought = sum(
            (Fraction(cast(str, e["last_qty"])) for e in events if e["order_side"] == "BUY"),
            Fraction(0),
        )
        sold = sum(
            (Fraction(cast(str, e["last_qty"])) for e in events if e["order_side"] == "SELL"),
            Fraction(0),
        )
        if (
            quantity != bought - sold
            or bought != Fraction(cast(str, row["buy_qty"]))
            or sold != Fraction(cast(str, row["sell_qty"]))
            or row["side"] != ("LONG" if quantity > 0 else "FLAT")
        ):
            return False
        if quantity:
            open_positions.append((row["side"], quantity))
    final_positions = cast(list[dict[str, object]], final["positions"])
    return open_positions == [
        (p["side"], Fraction(cast(str, p["quantity"]))) for p in final_positions
    ]


def _bounded_plain_decimal(value: object) -> str:
    if (
        type(value) is not str
        or not 1 <= len(value) <= 128
        or re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", value) is None
    ):
        raise ReportSchemaError("native fill amount must be a bounded plain decimal")
    return value


def _raw_fill_amount(value: object) -> Fraction:
    amount = Decimal(_bounded_plain_decimal(value))
    if not amount.is_finite():
        raise ReportSchemaError("native fill amount must be a bounded plain decimal")
    return Fraction(amount)


def _check_money_amount(value: object) -> None:
    if type(value) is not str or len(parts := value.split(" ")) != 2:
        raise ReportSchemaError("native money requires amount and currency")
    _bounded_plain_decimal(parts[0])


def _check_row_amounts(kind: str, row: dict[str, object]) -> None:
    """Bound only numeric schema fields; arbitrary metadata strings stay opaque."""
    for field, value in row.items():
        if value is None:
            continue  # The existing row codec owns nullable-field eligibility.
        if field in _DECIMAL_FIELDS[kind]:
            _bounded_plain_decimal(value)
        elif field in _MONEY_FIELDS:
            _check_money_amount(value)
        elif field in _MONEY_LIST_FIELDS and type(value) is list:
            for item in value:
                _check_money_amount(item)
        elif kind == "positions" and field == "events" and type(value) is list:
            for event in value:
                if type(event) is dict:
                    _check_row_amounts("fills", event)
        elif kind == "account" and field == "margins" and value != []:
            raise ReportSchemaError("historical CASH report cannot contain margin facts")


def _check_snapshot_amounts(snapshot: dict[str, Any]) -> None:
    """Check fixed-format producer numbers before Decimal can expand an exponent."""
    points = snapshot.get("checkpoints")
    if type(points) is not list:
        return  # Shape failures are handled by the shared cash-series codec.
    for point in points:
        if type(point) is not dict:
            continue
        balances = point.get("balances")
        if type(balances) is dict:
            for balance in balances.values():
                if type(balance) is dict:
                    for value in balance.values():
                        _bounded_plain_decimal(value)
        for field in _VECTOR_FIELDS:
            vector = point.get(field)
            if type(vector) is dict:
                for value in vector.values():
                    _bounded_plain_decimal(value)
        for field, amount in (("positions", "quantity"), ("pending_orders", "leaves_quantity")):
            rows = point.get(field)
            if type(rows) is list:
                for row in rows:
                    if type(row) is dict and row.get(amount) is not None:
                        _bounded_plain_decimal(row[amount])


def _strict_values(value: object) -> None:
    if value is None or type(value) in (str, bool):
        return
    if type(value) is int:
        if abs(value) >= 2**53:
            raise ReportSchemaError("untyped report integer exceeds JavaScript exact range")
        return
    if isinstance(value, list):
        for item in value:
            _strict_values(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if type(key) is not str:
                raise ReportSchemaError("report keys must be strings")
            if key in _TIMESTAMP_FIELDS and item is not None:
                _canonical_timestamp(key, item)
            if key in _NONBLANK_FIELDS and item is not None:
                if type(item) is not str or not item.strip():
                    raise ReportSchemaError(f"report {key} requires a nonblank identity")
            _strict_values(item)
        return
    raise ReportSchemaError("report contains a non-JSON-safe value")


def _money(value: object) -> tuple[Fraction, str]:
    if type(value) is not str or len(parts := value.split(" ")) != 2:
        raise ReportSchemaError("native money requires amount and currency")
    return Fraction(parts[0]), parts[1]


def _currencies(tables: dict[str, list[dict[str, object]]], currencies: tuple[str, str]) -> None:
    quote = currencies[1]
    for kind, rows in tables.items():
        for row in rows:
            if kind == "account":
                if (
                    row["currency"] not in currencies
                    or row["account_type"] != "CASH"
                    or row["base_currency"] != "None"
                    or row["margins"] != []
                ):
                    raise ReportSchemaError(
                        "account report differs from multi-currency CASH profile"
                    )
            if kind == "fills":
                if row["currency"] != quote or _money(row["commission"])[1] != quote:
                    raise ReportSchemaError("native fill currency differs from quote currency")
                if (
                    Fraction(cast(str, row["last_qty"])) <= 0
                    or Fraction(cast(str, row["last_px"])) <= 0
                ):
                    raise ReportSchemaError("native fills require positive quantity and price")
            for fact in cast(list[object], row.get("commissions") or []):
                if _money(fact)[1] != quote:
                    raise ReportSchemaError("native commission currency differs")
            if kind == "positions":
                if _money(row["realized_pnl"])[1] != quote:
                    raise ReportSchemaError("native PnL currency differs")
                for event in cast(list[dict[str, object]], row["events"]):
                    if event["currency"] != quote or _money(event["commission"])[1] != quote:
                        raise ReportSchemaError("position event currency differs")


def _fees(values: list[object]) -> dict[str, Fraction]:
    totals: dict[str, Fraction] = defaultdict(Fraction)
    for value in values:
        amount, currency = _money(value)
        totals[currency] += amount
    return dict(totals)


def _consistency(
    tables: dict[str, list[dict[str, object]]], instrument: str, account: str
) -> set[str]:
    failures: set[str] = set()
    orders = {cast(str, row["client_order_id"]): row for row in tables["orders"]}
    fills_by_order: dict[str, list[dict[str, object]]] = defaultdict(list)
    fills_by_key = {}
    for fill in tables["fills"]:
        fills_by_order[cast(str, fill["client_order_id"])].append(fill)
        fills_by_key[(fill["client_order_id"], fill["trade_id"])] = fill
    for kind, rows in tables.items():
        for row in rows:
            if row.get("account_id") not in ({None, account} if kind == "orders" else {account}):
                failures.add("REPORT_ACCOUNT_IDENTITY_MISMATCH")
            if kind != "account" and row["instrument_id"] != instrument:
                failures.add("REPORT_INSTRUMENT_IDENTITY_MISMATCH")
    for fill in tables["fills"]:
        order = orders.get(cast(str, fill["client_order_id"]))
        if order is None or any(
            fill[f] != order[o]
            for f, o in (
                ("instrument_id", "instrument_id"),
                ("account_id", "account_id"),
                ("order_side", "side"),
                ("order_type", "type"),
                ("trader_id", "trader_id"),
                ("strategy_id", "strategy_id"),
                ("position_id", "position_id"),
                ("venue_order_id", "venue_order_id"),
            )
        ):
            failures.add("ORDER_FILL_IDENTITY_MISMATCH")
    for oid, order in orders.items():
        fills = fills_by_order[oid]
        if sum((Fraction(cast(str, f["last_qty"])) for f in fills), Fraction(0)) != Fraction(
            cast(str, order["filled_qty"])
        ):
            failures.add("ORDER_FILL_QUANTITY_MISMATCH")
        if _fees([f["commission"] for f in fills]) != _fees(
            cast(list[object], order["commissions"] or [])
        ):
            failures.add("ORDER_FILL_COMMISSION_MISMATCH")
    positions = {r["position_id"]: r for r in tables["positions"]}
    seen_events: set[tuple[object, object]] = set()
    for fill in tables["fills"]:
        if fill["position_id"] not in positions:
            failures.add("REPORT_POSITION_IDENTITY_MISMATCH")
    for position in tables["positions"]:
        for field in ("opening_order_id", "closing_order_id"):
            ref = position[field]
            order = orders.get(cast(str, ref))
            if ref is not None and (
                order is None
                or any(
                    position[f] != order[f]
                    for f in (
                        "instrument_id",
                        "account_id",
                        "position_id",
                        "trader_id",
                        "strategy_id",
                    )
                )
            ):
                failures.add("REPORT_POSITION_IDENTITY_MISMATCH")
        for event in cast(list[dict[str, object]], position["events"]):
            key = (event["client_order_id"], event["trade_id"])
            match = fills_by_key.get(key)
            if (
                key in seen_events
                or match is None
                or event["position_id"] != position["position_id"]
                or any(event[f] != match[f] for f in match)
            ):
                failures.add("REPORT_POSITION_EVENT_MISMATCH")
            seen_events.add(key)
    if seen_events != set(fills_by_key):
        failures.add("REPORT_POSITION_EVENT_MISMATCH")
    return failures


def _account_cash_matches(
    rows: list[dict[str, object]],
    points: list[dict[str, object]],
    currencies: tuple[str, str],
) -> bool:
    """Require native endpoint witnesses without inventing same-timestamp causality."""
    start, end = int(cast(str, points[0]["clock_ns"])), int(cast(str, points[-1]["clock_ns"]))
    grouped: dict[str, dict[int, set[tuple[str, ...]]]] = {c: {} for c in currencies}

    def balances(row: dict[str, object]) -> tuple[str, ...]:
        return tuple(cast(str, row[field]) for field in ("total", "free", "locked"))

    for row in rows:
        timestamp = int(cast(str, row["ts_event_ns"]))
        if not start <= timestamp <= end:
            return False
        grouped[cast(str, row["currency"])].setdefault(timestamp, set()).add(balances(row))
    first = cast(dict[str, dict[str, object]], points[0]["balances"])
    final = cast(dict[str, dict[str, object]], points[-1]["balances"])
    for currency, snapshots in grouped.items():
        if not snapshots or min(snapshots) != start:
            return False
        if (
            balances(first[currency]) not in snapshots[start]
            or balances(final[currency]) not in snapshots[max(snapshots)]
        ):
            return False
    return True


def _trace_text(value: object) -> str:
    if type(value) is not str or not value.strip():
        raise ReportSchemaError("native order trace requires nonblank text")
    return value


def _order_trace_matches(
    snapshot: dict[str, Any],
    rows: list[dict[str, object]],
    points: list[dict[str, object]],
) -> bool:
    """Bind all submitted orders, including zero fills, to native trace identities."""
    orders = {cast(str, row["client_order_id"]): row for row in rows}
    submissions: set[str] = set()
    matched = True
    last_sequence = 0
    for decision in snapshot["decisions"]:
        base = {"sequence", "side", "code"}
        quote = {"required_quote_numerator", "required_quote_denominator"}
        if type(decision) is not dict or set(decision) not in (
            base,
            base | quote,
            base | quote | {"client_order_id"},
        ):
            raise ReportSchemaError("native decision has unknown shape")
        sequence = decision["sequence"]
        if (
            type(sequence) is not int
            or not last_sequence < sequence < len(points)
            or decision["side"] not in {"BUY", "SELL"}
        ):
            raise ReportSchemaError("native decision sequence or side is invalid")
        last_sequence = sequence
        code = _trace_text(decision["code"])
        if set(decision) == base and code not in {"WAIT_PENDING_ENTRY", "NO_CONFIRMED_POSITION"}:
            raise ReportSchemaError("guard decision is missing its exact quote requirement")
        for field in quote & set(decision):
            value = decision[field]
            if (
                type(value) is not str
                or re.fullmatch(r"0|[1-9][0-9]*", value) is None
                or (field.endswith("denominator") and value == "0")
            ):
                raise ReportSchemaError(
                    "required quote needs a nonnegative integer numerator and positive denominator"
                )
        if code == "SUBMITTED" and "client_order_id" not in decision:
            raise ReportSchemaError("submitted decision requires its native order identity")
        if "client_order_id" in decision:
            oid = _trace_text(decision["client_order_id"])
            if code not in {"SUBMITTED", "ALLOW"} or oid in submissions:
                raise ReportSchemaError("native submitted decision is invalid or duplicated")
            submissions.add(oid)
            expected = f"SMA-{snapshot['input_manifest_sha256'][:24]}-{sequence}-{decision['side']}"
            order = orders.get(oid)
            if (
                oid != expected
                or order is None
                or order["side"] != decision["side"]
                or order["ts_init"] != points[sequence - 1]["clock_ns"]
            ):
                matched = False
    event_ids: set[str] = set()
    order_events: dict[str, list[dict[str, Any]]] = defaultdict(list)
    start, end = int(cast(str, points[0]["clock_ns"])), int(cast(str, points[-1]["clock_ns"]))
    for event in snapshot["native_order_events"]:
        if type(event) is not dict or set(event) != {
            "event_type",
            "client_order_id",
            "ts_event",
            "reason",
        }:
            raise ReportSchemaError("native order event has unknown shape")
        _trace_text(event["event_type"])
        oid = _trace_text(event["client_order_id"])
        if type(event["ts_event"]) is not int or (
            event["reason"] is not None and type(event["reason"]) is not str
        ):
            raise ReportSchemaError("native order event timestamp or reason is invalid")
        timestamp = int(_canonical_timestamp("ts_event", str(event["ts_event"])))
        if not start <= timestamp <= end:
            matched = False
        event_ids.add(oid)
        order_events[oid].append(event)
    if set(orders) != submissions or set(orders) != event_ids:
        matched = False
    if not _native_order_states_match(orders, order_events, snapshot["native_fill_facts"]):
        matched = False
    for point in points:
        for pending in cast(list[dict[str, object]], point["pending_orders"]):
            if pending["id"] not in submissions:
                matched = False
    final_pending = {
        cast(str, p["id"]): p for p in cast(list[dict[str, object]], points[-1]["pending_orders"])
    }
    table_pending = {oid for oid, order in orders.items() if order["status"] in _PENDING_STATUSES}
    if set(final_pending) != table_pending:
        matched = False
    for oid, pending in final_pending.items():
        order = orders.get(oid)
        if (
            order is None
            or pending["status"] != order["status"]
            or pending["leaves_quantity"] is None
        ):
            matched = False
        elif Fraction(cast(str, pending["leaves_quantity"])) != Fraction(
            cast(str, order["quantity"])
        ) - Fraction(cast(str, order["filled_qty"])):
            matched = False
    return matched


def _native_order_states_match(
    orders: dict[str, dict[str, object]],
    events: dict[str, list[dict[str, Any]]],
    fill_facts: list[dict[str, Any]],
) -> bool:
    """Bind observed terminal/pending states and fill callbacks to the native table."""
    states = {
        "OrderInitialized": "INITIALIZED",
        "OrderEmulated": "EMULATED",
        "OrderReleased": "RELEASED",
        "OrderSubmitted": "SUBMITTED",
        "OrderAccepted": "ACCEPTED",
        "OrderTriggered": "TRIGGERED",
        "OrderPendingUpdate": "PENDING_UPDATE",
        "OrderPendingCancel": "PENDING_CANCEL",
        "OrderDenied": "DENIED",
        "OrderRejected": "REJECTED",
        "OrderCanceled": "CANCELED",
        "OrderExpired": "EXPIRED",
    }
    fills: dict[str, list[int]] = defaultdict(list)
    for fact in fill_facts:
        fills[fact["client_order_id"]].append(fact["ts_event"])
    for oid, order in orders.items():
        trace = events.get(oid, [])
        if not trace or any(a["ts_event"] > b["ts_event"] for a, b in zip(trace, trace[1:])):
            return False
        last = trace[-1]
        if order["ts_last"] != str(last["ts_event"]):
            return False
        expected = states.get(last["event_type"])
        if last["event_type"] == "OrderFilled":
            filled, quantity = (
                Fraction(cast(str, order["filled_qty"])),
                Fraction(cast(str, order["quantity"])),
            )
            if not 0 < filled <= quantity:
                return False
            expected = "FILLED" if filled == quantity else "PARTIALLY_FILLED"
        if order["status"] != expected:
            return False
        if [e["ts_event"] for e in trace if e["event_type"] == "OrderFilled"] != fills[oid]:
            return False
        terminal = {"OrderDenied", "OrderRejected", "OrderCanceled", "OrderExpired"}
        if any(e["event_type"] in terminal for e in trace[:-1]):
            return False
    return True


def _snapshot_fills_match(
    facts: object, fills: list[dict[str, object]], currencies: tuple[str, str]
) -> bool:
    """Join raw ordered callback facts to table facts without deriving cash or PnL."""
    if type(facts) is not list:
        raise ReportSchemaError("native fill facts must be a list")
    native: dict[tuple[str, str], tuple[Fraction, Fraction, str, dict[str, Fraction]]] = {}
    for fact in facts:
        if type(fact) is not dict or set(fact) != {
            "client_order_id",
            "trade_id",
            "last_quantity",
            "last_price",
            "cash_delta",
            "commission",
            "ts_event",
        }:
            raise ReportSchemaError("native fill fact has unknown shape")
        for name in ("client_order_id", "trade_id"):
            if type(fact[name]) is not str or not fact[name].strip():
                raise ReportSchemaError("native fill fact requires exact string fields")
        if type(fact["ts_event"]) is not int:
            raise ReportSchemaError("native fill fact timestamp must be an integer")
        timestamp = _canonical_timestamp("ts_event", str(fact["ts_event"]))
        for field, expected in (("cash_delta", set(currencies)), ("commission", {currencies[1]})):
            vector = fact[field]
            if (
                type(vector) is not dict
                or set(vector) != expected
                or any(type(v) is not str for v in vector.values())
            ):
                raise ReportSchemaError("native fill fact currency vector differs")
            for value in vector.values():
                _raw_fill_amount(value)
        key = (fact["client_order_id"], fact["trade_id"])
        if key in native:
            raise ReportSchemaError("duplicate native fill fact")
        native[key] = (
            _raw_fill_amount(fact["last_quantity"]),
            _raw_fill_amount(fact["last_price"]),
            timestamp,
            {k: _raw_fill_amount(v) for k, v in fact["commission"].items()},
        )
    projected = {
        (cast(str, fill["client_order_id"]), cast(str, fill["trade_id"])): (
            Fraction(cast(str, fill["last_qty"])),
            Fraction(cast(str, fill["last_px"])),
            cast(str, fill["ts_event"]),
            _fees([fill["commission"]]),
        )
        for fill in fills
    }
    return native == projected
