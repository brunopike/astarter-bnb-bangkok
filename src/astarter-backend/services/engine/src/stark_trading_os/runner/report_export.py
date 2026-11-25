"""The only exporter from Nautilus report objects to committed report JSON."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import (
    ROUND_HALF_EVEN,
    Context,
    Decimal,
    DecimalException,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    localcontext,
)
from importlib import import_module
from numbers import Integral
from types import MappingProxyType
from typing import Any, cast

from nautilus_trader.backtest import BacktestNode, BacktestResult
from nautilus_trader.model import FIXED_PRECISION, Currency, Money, Venue

from stark_trading_os.audit.canonical_json import CanonicalJSONError, canonical_decimal_string

pd: Any = import_module("pandas")


class ReportSchemaError(ValueError):
    """Raised when a native report differs from its committed schema."""


@dataclass(frozen=True)
class ReportSchema:
    index_name: str | None
    fields: tuple[str, ...]
    sort_keys: tuple[str, ...]
    float_fields: frozenset[str] = frozenset()


_ORDER_FIELDS = (
    "trader_id",
    "strategy_id",
    "instrument_id",
    "side",
    "type",
    "quantity",
    "price",
    "status",
    "time_in_force",
    "expire_time_ns",
    "is_post_only",
    "is_reduce_only",
    "is_quote_quantity",
    "filled_qty",
    "init_id",
    "ts_init",
    "ts_last",
    "commissions",
    "venue_order_id",
    "display_qty",
    "emulation_trigger",
    "trigger_instrument_id",
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
)
_FILL_FIELDS = (
    "trader_id",
    "strategy_id",
    "instrument_id",
    "venue_order_id",
    "account_id",
    "trade_id",
    "order_side",
    "order_type",
    "last_qty",
    "last_px",
    "currency",
    "liquidity_side",
    "event_id",
    "ts_event",
    "ts_init",
    "reconciliation",
    "info",
    "position_id",
    "commission",
    "causation_id",
)
_POSITION_FIELDS = (
    "type",
    "events",
    "adjustments",
    "trader_id",
    "strategy_id",
    "instrument_id",
    "account_id",
    "opening_order_id",
    "closing_order_id",
    "entry",
    "side",
    "quantity",
    "peak_qty",
    "price_precision",
    "size_precision",
    "multiplier",
    "is_inverse",
    "ts_init",
    "ts_opened",
    "ts_last",
    "ts_closed",
    "duration_ns",
    "avg_px_open",
    "avg_px_close",
    "realized_return",
    "realized_pnl",
    "venue_order_ids",
    "trade_ids",
    "buy_qty",
    "sell_qty",
    "commissions",
    "is_snapshot",
)
_ACCOUNT_FIELDS = (
    "total",
    "locked",
    "free",
    "currency",
    "account_id",
    "account_type",
    "margins",
    "reported",
    "info",
    "base_currency",
)
REPORT_SCHEMAS = MappingProxyType(
    {
        "orders": ReportSchema("client_order_id", _ORDER_FIELDS, ("client_order_id",)),
        "fills": ReportSchema(
            "client_order_id", _FILL_FIELDS, ("ts_event", "client_order_id", "trade_id")
        ),
        "positions": ReportSchema(
            "position_id",
            _POSITION_FIELDS,
            ("ts_opened", "position_id"),
            frozenset({"avg_px_open", "avg_px_close", "realized_return"}),
        ),
        "account": ReportSchema(None, _ACCOUNT_FIELDS, ("ts_event_ns", "account_id", "currency")),
    }
)

_METRIC_FIELDS = MappingProxyType(
    {
        "stats_pnls": frozenset(
            {
                "Max Winner",
                "Win Rate",
                "PnL% (total)",
                "Min Winner",
                "PnL (total)",
                "Avg Winner",
                "Expectancy",
                "Avg Loser",
                "Min Loser",
                "Max Loser",
            }
        ),
        "stats_returns": frozenset(
            {
                "Sortino Ratio (252 days)",
                "Tail Ratio",
                "Average Loss (Return)",
                "Average (Return)",
                "Sharpe Ratio (252 days)",
                "Average Win (Return)",
                "Returns Kurtosis",
                "Profit Factor",
                "Returns Volatility (252 days)",
                "Risk Return Ratio",
                "Returns Skewness",
            }
        ),
        "stats_general": frozenset({"Long Ratio"}),
    }
)
_SUMMARY_FIXED_FIELDS = frozenset(
    {
        "orders.total",
        "orders.closed",
        "orders.inflight",
        "orders.emulated",
        "orders.open",
        "positions.total",
        "positions.total_with_snapshots",
        "positions.open",
        "positions.closed",
        "positions.snapshots",
        "total_events",
        "iterations",
        "venues.total",
    }
)
_SUMMARY_ACCOUNT_FIELDS = frozenset({"id", "type", "event_count", "base_currency"})
_SUMMARY_BALANCE_FIELDS = frozenset({"total", "locked", "free"})
_EMPTY_PNL_FIELDS = frozenset({"PnL (total)", "PnL% (total)"})
_FULL_PNL_FIELDS = _METRIC_FIELDS["stats_pnls"]
_RETURN_FIELDS = _METRIC_FIELDS["stats_returns"]
_LEGACY_METRICS_KEYS = frozenset({"summary", *tuple(_METRIC_FIELDS)})
_CURRENT_METRICS_KEYS = frozenset({*_LEGACY_METRICS_KEYS, "performance_series"})
_PERFORMANCE_SERIES_LITERALS = MappingProxyType(
    {
        "schema": "PortfolioEquitySeries.v1",
        "source": "NAUTILUS_PORTFOLIO_SNAPSHOTS",
        "selection": "SOLE_TOTAL_EQUITY",
        "calculation": "RUNNING_PEAK_DRAWDOWN_PERCENT_V1",
        "timestamp_unit": "UNIX_EPOCH_NS",
        "equity_unit": "ACCOUNT_CURRENCY",
        "drawdown_unit": "PERCENT",
    }
)
_PERFORMANCE_SERIES_KEYS = frozenset(
    {*_PERFORMANCE_SERIES_LITERALS, "account_id", "currency", "points"}
)
_PERFORMANCE_POINT_KEYS = frozenset(
    {
        "point_index",
        "ts_event_ns",
        "equity_amount",
        "drawdown_pct",
        "is_stale",
        "stale_instruments",
        "stale_currencies",
        "unpriced_instruments",
    }
)
# The locked high-precision Nautilus Money type uses 16 fractional digits and
# rejects absolute amounts above 17_014_118_346_046.
_NATIVE_MONEY_MAX_ABS = Decimal("17014118346046")
_NATIVE_MONEY_MAX_CANONICAL_CHARS = 1 + 14 + 1 + FIXED_PRECISION
_DERIVED_DRAWDOWN_MAX_CANONICAL_CHARS = 96
_DERIVED_DRAWDOWN_MAX_ABS_ADJUSTED_EXPONENT = 31
_CANONICAL_PERFORMANCE_DECIMAL = re.compile(
    r"(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|"
    r"-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))"
)
_NATIVE_TIMESTAMP_MAX = (2**64) - 1
_NATIVE_TIMESTAMP_MAX_TEXT = str(_NATIVE_TIMESTAMP_MAX)
_DECIMAL_FIELDS = {
    "orders": frozenset({"quantity", "price", "filled_qty", "display_qty", "slippage", "avg_px"}),
    "fills": frozenset({"last_qty", "last_px"}),
    "positions": frozenset(
        {
            "quantity",
            "peak_qty",
            "multiplier",
            "avg_px_open",
            "avg_px_close",
            "realized_return",
            "buy_qty",
            "sell_qty",
        }
    ),
    "account": frozenset({"total", "locked", "free"}),
}
_TIMESTAMP_FIELDS = frozenset(
    {
        "expire_time_ns",
        "ts_init",
        "ts_last",
        "ts_event",
        "ts_event_ns",
        "ts_opened",
        "ts_closed",
        "duration_ns",
    }
)


def _performance_decimal_context() -> Context:
    return Context(
        prec=34,
        rounding=ROUND_HALF_EVEN,
        Emin=-999999,
        Emax=999999,
        capitals=1,
        clamp=0,
        flags=[],
        traps=[InvalidOperation, DivisionByZero, Overflow],
    )


_BOOLEAN_FIELDS = frozenset(
    {
        "is_post_only",
        "is_reduce_only",
        "is_quote_quantity",
        "is_inverse",
        "is_snapshot",
        "reconciliation",
        "reported",
    }
)
_INTEGER_FIELDS = frozenset({"price_precision", "size_precision"})
_LIST_FIELDS = frozenset(
    {
        "commissions",
        "linked_order_ids",
        "tags",
        "venue_order_ids",
        "trade_ids",
        "events",
        "adjustments",
        "margins",
    }
)
_MONEY_LIST_FIELDS = frozenset({"commissions"})
_STRING_LIST_FIELDS = frozenset({"linked_order_ids", "tags", "venue_order_ids", "trade_ids"})
_EMPTY_LIST_FIELDS = frozenset({"adjustments"})
_OBJECT_FIELDS = frozenset({"exec_algorithm_params", "info"})
_NULLABLE_FIELDS_BY_KIND = {
    "orders": frozenset(
        {
            "expire_time_ns",
            "display_qty",
            "trigger_instrument_id",
            "order_list_id",
            "parent_order_id",
            "exec_algorithm_id",
            "exec_algorithm_params",
            "exec_spawn_id",
            "linked_order_ids",
            "tags",
            "slippage",
        }
    ),
    "fills": frozenset({"causation_id", "info"}),
    "positions": frozenset(),
    "account": frozenset({"base_currency"}),
}
_MONEY_FIELDS = frozenset({"commission", "realized_pnl"})
_ORDER_TYPES = frozenset(
    {
        "MARKET",
        "MARKET_TO_LIMIT",
        "LIMIT",
        "STOP_MARKET",
        "STOP_LIMIT",
        "MARKET_IF_TOUCHED",
        "LIMIT_IF_TOUCHED",
        "TRAILING_STOP_MARKET",
        "TRAILING_STOP_LIMIT",
    }
)
_ORDER_STATUSES = frozenset(
    {
        "INITIALIZED",
        "SUBMITTED",
        "ACCEPTED",
        "REJECTED",
        "DENIED",
        "EMULATED",
        "RELEASED",
        "PENDING_UPDATE",
        "PENDING_CANCEL",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCELED",
        "VOIDED",
        "EXPIRED",
        "TRIGGERED",
    }
)
_ENUM_VALUES: dict[tuple[str, str], frozenset[str]] = {
    ("orders", "side"): frozenset({"BUY", "SELL"}),
    ("orders", "type"): _ORDER_TYPES,
    ("orders", "status"): _ORDER_STATUSES,
    ("orders", "time_in_force"): frozenset(
        {"GTC", "IOC", "FOK", "GTD", "DAY", "AT_THE_OPEN", "AT_THE_CLOSE"}
    ),
    ("orders", "liquidity_side"): frozenset({"NO_LIQUIDITY_SIDE", "MAKER", "TAKER"}),
    ("orders", "emulation_trigger"): frozenset(
        {
            "NO_TRIGGER",
            "DEFAULT",
            "BID_ASK",
            "DOUBLE_BID_ASK",
            "DOUBLE_LAST",
            "INDEX_PRICE",
            "LAST_OR_BID_ASK",
            "LAST_PRICE",
            "MARK_PRICE",
            "MID_POINT",
        }
    ),
    ("orders", "contingency_type"): frozenset({"NO_CONTINGENCY", "OCO", "OTO", "OUO"}),
    ("fills", "order_side"): frozenset({"BUY", "SELL"}),
    ("fills", "order_type"): _ORDER_TYPES,
    ("fills", "liquidity_side"): frozenset({"NO_LIQUIDITY_SIDE", "MAKER", "TAKER"}),
    ("positions", "type"): frozenset({"Position"}),
    ("positions", "entry"): frozenset({"BUY", "SELL"}),
    ("positions", "side"): frozenset({"LONG", "SHORT", "FLAT"}),
    ("account", "account_type"): frozenset({"CASH", "MARGIN", "BETTING", "WALLET"}),
}
_STRING_FIELDS = {
    kind: frozenset(
        set(((schema.index_name,) if schema.index_name else ("ts_event_ns",)) + schema.fields)
        - _DECIMAL_FIELDS[kind]
        - _BOOLEAN_FIELDS
        - _INTEGER_FIELDS
        - _TIMESTAMP_FIELDS
        - _LIST_FIELDS
        - _OBJECT_FIELDS
        - _MONEY_FIELDS
    )
    for kind, schema in REPORT_SCHEMAS.items()
}
_PRIMARY_KEYS = {
    "orders": ("client_order_id",),
    "fills": ("ts_event", "client_order_id", "trade_id"),
    "positions": ("position_id",),
    "account": ("ts_event_ns", "account_id", "currency"),
}


def export_dataframe_report(kind: str, frame: pd.DataFrame) -> list[dict[str, object]]:
    """Export one rc3 DataFrame using its exact committed schema and sort keys."""

    if kind not in REPORT_SCHEMAS:
        raise ReportSchemaError(f"unknown report kind: {kind}")
    schema = REPORT_SCHEMAS[kind]
    if not isinstance(frame, pd.DataFrame):
        raise ReportSchemaError(f"{kind} report must be a DataFrame")
    if kind != "account" and _is_exact_native_empty_frame(frame):
        return []
    expected = set(schema.fields)
    actual = set(frame.columns)
    missing = expected.difference(actual)
    unknown = actual.difference(expected)
    if missing:
        raise ReportSchemaError(f"{kind} report missing fields: {', '.join(sorted(missing))}")
    if unknown:
        raise ReportSchemaError(f"{kind} report has unknown fields: {', '.join(sorted(unknown))}")
    records = _records_with_explicit_index(kind, frame, schema)
    normalized = [normalize_report_row(kind, row) for row in records]
    _validate_unique_report_keys(kind, normalized)
    try:
        return sorted(
            normalized,
            key=lambda row: (
                tuple(_sort_value(row[key]) for key in schema.sort_keys)
                + ((_row_fingerprint(row),) if kind == "account" else ())
            ),
        )
    except KeyError as error:
        raise ReportSchemaError(f"{kind} report missing sort key {error.args[0]}") from error


def export_portfolio_equity_series(
    node: BacktestNode,
    run_config_id: str,
    venue: Venue,
) -> dict[str, object]:
    """Project the sole native Portfolio equity stream without deriving substitutes."""

    portfolio = node.get_engine_portfolio(run_config_id)
    account = portfolio.account(venue)
    if account is None:
        raise ReportSchemaError("portfolio venue account is missing")
    account_id = str(account.id)
    if not account_id:
        raise ReportSchemaError("portfolio account id must be non-empty")
    snapshots = portfolio.snapshots(account.id)
    if not snapshots:
        raise ReportSchemaError("portfolio equity snapshots must be non-empty")

    currency: str | None = None
    previous_ts: int | None = None
    running_peak: Decimal | None = None
    points: list[dict[str, object]] = []
    with localcontext(_performance_decimal_context()):
        for point_index, snapshot in enumerate(snapshots):
            if snapshot.account_id != account.id:
                raise ReportSchemaError("portfolio snapshot account identity drifted")
            if snapshot.is_stale is not False:
                raise ReportSchemaError("portfolio snapshot must not be stale")
            for quality_field in (
                "stale_instruments",
                "stale_currencies",
                "unpriced_instruments",
            ):
                if getattr(snapshot, quality_field) != []:
                    raise ReportSchemaError(f"portfolio snapshot {quality_field} must be empty")

            total_equity = snapshot.total_equity
            if type(total_equity) is not list or len(total_equity) != 1:
                raise ReportSchemaError("portfolio snapshot must have sole total equity")
            money = total_equity[0]
            if type(money) is not Money:
                raise ReportSchemaError("portfolio total equity must be native Money")
            point_currency = money.currency.code
            if type(point_currency) is not str or not point_currency:
                raise ReportSchemaError("portfolio equity currency must be non-empty")
            if currency is None:
                currency = point_currency
            elif point_currency != currency:
                raise ReportSchemaError("portfolio equity currency drifted")

            ts_event_ns = snapshot.ts_event
            if (
                type(ts_event_ns) is not int
                or ts_event_ns < 0
                or ts_event_ns > _NATIVE_TIMESTAMP_MAX
            ):
                raise ReportSchemaError(
                    "portfolio snapshot timestamp is outside the native timestamp domain"
                )
            if previous_ts is not None and ts_event_ns < previous_ts:
                raise ReportSchemaError("portfolio snapshot timestamps must be nondecreasing")
            previous_ts = ts_event_ns

            equity = money.as_decimal()
            if type(equity) is not Decimal:
                raise ReportSchemaError("portfolio total equity must expose Decimal")
            try:
                equity_amount = canonical_decimal_string(equity)
            except (CanonicalJSONError, DecimalException) as error:
                raise ReportSchemaError("portfolio equity must be finite") from error
            try:
                if running_peak is None:
                    if equity <= 0:
                        raise ReportSchemaError("first portfolio equity must be positive")
                    running_peak = equity
                elif equity > running_peak:
                    running_peak = equity
                drawdown = (equity - running_peak) / running_peak * Decimal(100)
                drawdown_pct = canonical_decimal_string(drawdown)
            except (CanonicalJSONError, DecimalException) as error:
                raise ReportSchemaError("portfolio drawdown must be finite") from error
            points.append(
                {
                    "point_index": point_index,
                    "ts_event_ns": str(ts_event_ns),
                    "equity_amount": equity_amount,
                    "drawdown_pct": drawdown_pct,
                    "is_stale": False,
                    "stale_instruments": [],
                    "stale_currencies": [],
                    "unpriced_instruments": [],
                }
            )

    assert currency is not None
    return validate_portfolio_equity_series(
        {
            **_PERFORMANCE_SERIES_LITERALS,
            "account_id": account_id,
            "currency": currency,
            "points": points,
        }
    )


def validate_portfolio_equity_series(series: object) -> dict[str, object]:
    """Validate an exported or persisted PortfolioEquitySeries.v1 exactly."""

    if not isinstance(series, Mapping) or set(series) != _PERFORMANCE_SERIES_KEYS:
        raise ReportSchemaError("performance series must use the exact committed schema")
    for field, literal in _PERFORMANCE_SERIES_LITERALS.items():
        if series[field] != literal:
            raise ReportSchemaError(f"performance series {field} is invalid")
    account_id = series["account_id"]
    currency = series["currency"]
    if type(account_id) is not str or not account_id:
        raise ReportSchemaError("performance series account_id must be non-empty")
    if type(currency) is not str or not currency:
        raise ReportSchemaError("performance series currency must be non-empty")
    try:
        native_currency = Currency.from_str(currency, strict=True)
    except (TypeError, ValueError, RuntimeError) as error:
        raise ReportSchemaError(
            "performance series currency must be a canonical native Money currency"
        ) from error
    if native_currency.code != currency:
        raise ReportSchemaError(
            "performance series currency must be a canonical native Money currency"
        )
    raw_points = series["points"]
    if type(raw_points) is not list or not raw_points:
        raise ReportSchemaError("performance series points must be a non-empty list")

    points: list[dict[str, object]] = []
    previous_ts: int | None = None
    running_peak: Decimal | None = None
    with localcontext(_performance_decimal_context()):
        for expected_index, raw_point in enumerate(raw_points):
            if not isinstance(raw_point, Mapping) or set(raw_point) != _PERFORMANCE_POINT_KEYS:
                raise ReportSchemaError("performance point must use the exact committed schema")
            if (
                type(raw_point["point_index"]) is not int
                or raw_point["point_index"] != expected_index
            ):
                raise ReportSchemaError("performance point_index must be continuous from zero")
            ts_event_ns = _require_native_timestamp(raw_point["ts_event_ns"])
            if previous_ts is not None and ts_event_ns < previous_ts:
                raise ReportSchemaError("performance timestamps must be nondecreasing")
            previous_ts = ts_event_ns
            equity = _require_canonical_performance_decimal(
                raw_point["equity_amount"],
                field="equity_amount",
                currency=native_currency,
            )
            supplied_drawdown = _require_canonical_performance_decimal(
                raw_point["drawdown_pct"], field="drawdown_pct"
            )
            if running_peak is None:
                if equity <= 0:
                    raise ReportSchemaError("first performance equity must be positive")
                running_peak = equity
            elif equity > running_peak:
                running_peak = equity
            try:
                expected_drawdown = (equity - running_peak) / running_peak * Decimal(100)
                expected_drawdown_string = canonical_decimal_string(expected_drawdown)
            except (CanonicalJSONError, DecimalException) as error:
                raise ReportSchemaError(
                    "performance drawdown is outside its closed domain"
                ) from error
            if (
                supplied_drawdown != expected_drawdown
                or raw_point["drawdown_pct"] != expected_drawdown_string
            ):
                raise ReportSchemaError("performance drawdown does not match running peak")
            if raw_point["is_stale"] is not False:
                raise ReportSchemaError("performance point is_stale must be false")
            for quality_field in (
                "stale_instruments",
                "stale_currencies",
                "unpriced_instruments",
            ):
                if type(raw_point[quality_field]) is not list or raw_point[quality_field]:
                    raise ReportSchemaError(f"performance point {quality_field} must be empty")
            points.append(dict(raw_point))

    return {
        **_PERFORMANCE_SERIES_LITERALS,
        "account_id": account_id,
        "currency": currency,
        "points": points,
    }


def _require_native_timestamp(value: object) -> int:
    if (
        type(value) is not str
        or not value
        or not value.isascii()
        or not value.isdecimal()
        or (len(value) > 1 and value[0] == "0")
    ):
        raise ReportSchemaError("performance timestamp must use canonical ASCII digits")
    if (len(value), value) > (
        len(_NATIVE_TIMESTAMP_MAX_TEXT),
        _NATIVE_TIMESTAMP_MAX_TEXT,
    ):
        raise ReportSchemaError("performance timestamp is outside the native timestamp domain")
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ReportSchemaError(
            "performance timestamp is outside the native timestamp domain"
        ) from error


def _require_canonical_performance_decimal(
    value: object,
    *,
    field: str,
    currency: Currency | None = None,
) -> Decimal:
    if type(value) is not str:
        raise ReportSchemaError(f"performance {field} must be a decimal string")
    if field == "equity_amount":
        if len(value) > _NATIVE_MONEY_MAX_CANONICAL_CHARS:
            raise ReportSchemaError("performance equity_amount is outside the native Money domain")
    elif len(value) > _DERIVED_DRAWDOWN_MAX_CANONICAL_CHARS:
        raise ReportSchemaError(f"performance {field} is outside its closed decimal domain")
    if _CANONICAL_PERFORMANCE_DECIMAL.fullmatch(value) is None:
        raise ReportSchemaError(f"performance {field} must be canonical")
    try:
        parsed = Decimal(value)
        if not parsed.is_finite():
            raise InvalidOperation
        exponent = parsed.as_tuple().exponent
        if not isinstance(exponent, int):
            raise InvalidOperation
        adjusted = parsed.adjusted()
        if field == "equity_amount":
            if (
                currency is None
                or exponent < -FIXED_PRECISION
                or adjusted > _NATIVE_MONEY_MAX_ABS.adjusted()
                or abs(parsed) > _NATIVE_MONEY_MAX_ABS
            ):
                raise ReportSchemaError(
                    "performance equity_amount is outside the native Money domain"
                )
            try:
                native_amount = Money.from_decimal(parsed, currency).as_decimal()
            except (
                DecimalException,
                TypeError,
                ValueError,
                OverflowError,
                RuntimeError,
            ) as error:
                raise ReportSchemaError(
                    "performance equity_amount is outside the native Money domain"
                ) from error
            if (
                type(native_amount) is not Decimal
                or native_amount != parsed
                or canonical_decimal_string(native_amount) != value
            ):
                raise ReportSchemaError(
                    "performance equity_amount is outside the native Money domain"
                )
        elif parsed != 0 and abs(adjusted) > _DERIVED_DRAWDOWN_MAX_ABS_ADJUSTED_EXPONENT:
            raise ReportSchemaError(f"performance {field} is outside its closed decimal domain")
        normalized = canonical_decimal_string(parsed)
    except ReportSchemaError:
        raise
    except (
        CanonicalJSONError,
        DecimalException,
        TypeError,
        ValueError,
        OverflowError,
        RuntimeError,
    ) as error:
        raise ReportSchemaError(f"performance {field} must be finite") from error
    if normalized != value:
        raise ReportSchemaError(f"performance {field} must be canonical")
    return parsed


def export_metrics(metrics: Mapping[str, object]) -> dict[str, object]:
    """Export rc3 BacktestResult metric maps under the finite-float allowlist."""

    actual = set(metrics)
    if actual not in {_LEGACY_METRICS_KEYS, _CURRENT_METRICS_KEYS}:
        raise ReportSchemaError(
            "metrics keys must be the exact legacy or current committed schema; "
            f"got {sorted(actual)}"
        )
    summary = metrics["summary"]
    if not isinstance(summary, Mapping):
        raise ReportSchemaError("metrics summary must be dict[str, str]")
    normalized_summary = _normalize_result_summary(summary)
    if normalized_summary is None:
        raise ReportSchemaError("metrics summary must be dict[str, str]")
    output: dict[str, object] = {"summary": normalized_summary}
    for group, allowed in _METRIC_FIELDS.items():
        values = metrics[group]
        if not isinstance(values, Mapping):
            raise ReportSchemaError(f"{group} must be a mapping")
        if group == "stats_pnls":
            currencies: dict[str, object] = {}
            for currency, nested in values.items():
                if type(currency) is not str or not isinstance(nested, Mapping):
                    raise ReportSchemaError("stats_pnls must be nested by currency")
                currencies[currency] = _normalize_metric_map(group, nested, allowed)
            output[group] = currencies
        else:
            output[group] = _normalize_metric_map(group, values, allowed)
    if actual == _CURRENT_METRICS_KEYS:
        output["performance_series"] = validate_portfolio_equity_series(
            metrics["performance_series"]
        )
    return output


def export_backtest_reports(
    node: BacktestNode, run_config_id: str, venue: Venue, backtest_result: BacktestResult
) -> dict[str, object]:
    """Map the five fixed rc3 report sources to their committed JSON projections."""

    return {
        "orders": export_dataframe_report("orders", node.generate_orders_report(run_config_id)),
        "fills": export_dataframe_report("fills", node.generate_fills_report(run_config_id)),
        "positions": export_dataframe_report(
            "positions", node.generate_positions_report(run_config_id)
        ),
        "account": export_dataframe_report(
            "account", node.generate_account_report(run_config_id, venue=venue)
        ),
        "metrics": export_metrics(
            {
                "summary": backtest_result.summary,
                "stats_pnls": backtest_result.stats_pnls,
                "stats_returns": backtest_result.stats_returns,
                "stats_general": backtest_result.stats_general,
                "performance_series": export_portfolio_equity_series(
                    node,
                    run_config_id,
                    venue,
                ),
            }
        ),
    }


def _records_with_explicit_index(
    kind: str, frame: pd.DataFrame, schema: ReportSchema
) -> list[dict[str, object]]:
    if isinstance(frame.index, pd.MultiIndex):
        raise ReportSchemaError(f"{kind} report must have a single index")
    if schema.index_name is None:
        if frame.index.name not in {None, "timestamp"}:
            raise ReportSchemaError("account report index must be unnamed timestamp")
        records = frame.copy()
        records.insert(0, "ts_event_ns", records.index)
        return cast(list[dict[str, object]], records.to_dict(orient="records"))
    if frame.index.name != schema.index_name:
        raise ReportSchemaError(f"{kind} report index must be {schema.index_name}")
    records = frame.copy()
    records.insert(0, schema.index_name, records.index)
    return cast(list[dict[str, object]], records.to_dict(orient="records"))


def _output_fields(kind: str, schema: ReportSchema) -> tuple[str, ...]:
    if kind == "account":
        return ("ts_event_ns", *schema.fields)
    if schema.index_name is None:
        raise ReportSchemaError(f"{kind} report has no declared index")
    return (schema.index_name, *schema.fields)


def _normalize_metric_map(
    group: str, values: Mapping[object, object], allowed: frozenset[str]
) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for name, value in values.items():
        if type(name) is not str or name not in allowed:
            raise ReportSchemaError(f"unknown metric in {group}: {name}")
        normalized[name] = _normalize_metric_value(value)
    if group == "stats_pnls" and set(normalized) not in {_EMPTY_PNL_FIELDS, _FULL_PNL_FIELDS}:
        raise ReportSchemaError("stats_pnls must use a checked-in rc3 metric schema")
    if group == "stats_returns" and set(normalized) != _RETURN_FIELDS:
        raise ReportSchemaError("stats_returns must use the checked-in rc3 metric schema")
    if group == "stats_general" and set(normalized) not in {frozenset(), frozenset({"Long Ratio"})}:
        raise ReportSchemaError("stats_general must use a checked-in rc3 metric schema")
    return normalized


def _normalize_result_summary(summary: Mapping[object, object]) -> dict[str, str] | None:
    normalized: dict[str, str] = {}
    for key, value in summary.items():
        if type(key) is not str or type(value) is not str:
            return None
        normalized[key] = value
    keys = set(normalized)
    if not _SUMMARY_FIXED_FIELDS.issubset(keys):
        return None
    if any(not _is_canonical_nonnegative_integer(normalized[key]) for key in _SUMMARY_FIXED_FIELDS):
        return None
    account_fields: dict[str, set[str]] = {}
    balance_fields: dict[tuple[str, str], set[str]] = {}
    for key in keys.difference(_SUMMARY_FIXED_FIELDS):
        parts = key.split(".")
        if len(parts) == 3 and parts[0] == "account":
            venue, field = parts[1:]
            if venue and field in _SUMMARY_ACCOUNT_FIELDS:
                if field == "event_count" and not _is_canonical_nonnegative_integer(
                    normalized[key]
                ):
                    return None
                account_fields.setdefault(venue, set()).add(field)
                continue
        if len(parts) == 5 and parts[0] == "account" and parts[2] == "balance":
            venue, currency, field = parts[1], parts[3], parts[4]
            if venue and currency and field in _SUMMARY_BALANCE_FIELDS:
                money = _normalize_summary_money(normalized[key], currency)
                if money is None:
                    return None
                normalized[key] = money
                balance_fields.setdefault((venue, currency), set()).add(field)
                continue
        return None
    if not account_fields or any(
        fields != _SUMMARY_ACCOUNT_FIELDS for fields in account_fields.values()
    ):
        return None
    if not balance_fields or any(
        fields != _SUMMARY_BALANCE_FIELDS for fields in balance_fields.values()
    ):
        return None
    if any(venue not in account_fields for venue, _ in balance_fields):
        return None
    if any(
        not any(balance_venue == venue for balance_venue, _ in balance_fields)
        for venue in account_fields
    ):
        return None
    return normalized


def _is_canonical_nonnegative_integer(value: str) -> bool:
    return value.isdecimal() and str(int(value)) == value


def _normalize_summary_money(value: str, currency: str) -> str | None:
    parts = value.split(" ")
    if len(parts) != 2 or parts[1] != currency:
        return None
    try:
        amount = canonical_decimal_string(Decimal(parts[0]))
    except (CanonicalJSONError, InvalidOperation):
        return None
    return f"{amount} {currency}"


def _normalize_metric_value(value: object) -> str:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ReportSchemaError("metric float must be finite")
        return _decimal_from_float(value)
    if isinstance(value, Decimal):
        try:
            return canonical_decimal_string(value)
        except CanonicalJSONError as error:
            raise ReportSchemaError(str(error)) from error
    if type(value) is str:
        return _normalize_decimal_field("metric", value)
    if type(value) is int:
        return str(value)
    raise ReportSchemaError(
        "metric values must be string, integer, Decimal, or finite float; "
        f"got {type(value).__name__}"
    )


def _normalize_report_value(
    kind: str, field: str, value: object, float_fields: frozenset[str]
) -> object:
    if _is_report_null(value):
        if field not in _NULLABLE_FIELDS_BY_KIND[kind]:
            raise ReportSchemaError(f"null is not permitted at report field {field}")
        return None
    if isinstance(value, float):
        if field not in float_fields:
            raise ReportSchemaError(f"float is not permitted at report field {field}")
        if not math.isfinite(value):
            raise ReportSchemaError(f"float must be finite at report field {field}")
        return _decimal_from_float(value)
    if field in _DECIMAL_FIELDS[kind]:
        return _normalize_decimal_field(field, value)
    if field in _MONEY_FIELDS:
        return _normalize_money_field(field, value)
    if field in _BOOLEAN_FIELDS:
        if type(value) is not bool:
            raise ReportSchemaError(f"{field} must be a boolean")
        return value
    if field in _INTEGER_FIELDS:
        if type(value) is bool or not isinstance(value, Integral):
            raise ReportSchemaError(f"{field} must be an integer")
        return int(value)
    if field in _TIMESTAMP_FIELDS:
        if isinstance(value, pd.Timestamp):
            return str(_timestamp_ns(value))
        if type(value) is str and value.isdecimal():
            return value
        if type(value) is bool or not isinstance(value, Integral) or value < 0:
            raise ReportSchemaError(f"{field} must be a non-negative integer")
        return str(int(value))
    if field in _LIST_FIELDS:
        if type(value) is not list:
            raise ReportSchemaError(f"{field} must be a list")
        if kind == "positions" and field == "events":
            return [_normalize_position_event(item) for item in value]
        if kind == "account" and field == "margins":
            return [_normalize_account_margin(item) for item in value]
        if field in _MONEY_LIST_FIELDS:
            return [_normalize_money_field(field, item) for item in value]
        if field in _STRING_LIST_FIELDS:
            if not all(type(item) is str for item in value):
                raise ReportSchemaError(f"{field} items must be strings")
            return value
        if field in _EMPTY_LIST_FIELDS:
            if value:
                raise ReportSchemaError(f"{field} must be empty in the rc3 report schema")
            return []
        return [_normalize_nested_value(item) for item in value]
    if field in _OBJECT_FIELDS:
        if type(value) is not dict:
            raise ReportSchemaError(f"{field} must be an object")
        return _normalize_nested_value(value)
    if field in _STRING_FIELDS[kind]:
        if type(value) is not str:
            raise ReportSchemaError(f"{field} must be a string")
        allowed = _ENUM_VALUES.get((kind, field))
        if allowed is not None and value not in allowed:
            raise ReportSchemaError(f"{field} is not a declared rc3 enum value")
        return value
    raise ReportSchemaError(f"unclassified report field {field}")


def _normalize_decimal_field(field: str, value: object) -> str:
    if isinstance(value, Decimal):
        decimal_value = value
    elif type(value) is str:
        try:
            decimal_value = Decimal(value)
        except (InvalidOperation, ValueError) as error:
            raise ReportSchemaError(f"{field} must be a decimal string") from error
    else:
        raise ReportSchemaError(f"{field} must be a Decimal or decimal string")
    try:
        return canonical_decimal_string(decimal_value)
    except (CanonicalJSONError, InvalidOperation) as error:
        raise ReportSchemaError(str(error)) from error


def _normalize_money_field(field: str, value: object) -> str:
    if type(value) is not str:
        raise ReportSchemaError(f"{field} must be a Money string")
    parts = value.split(" ")
    if len(parts) != 2 or not parts[1]:
        raise ReportSchemaError(f"{field} must be '<decimal> <currency>'")
    return f"{_normalize_decimal_field(field, parts[0])} {parts[1]}"


def normalize_report_row(kind: str, row: Mapping[str, object]) -> dict[str, object]:
    """Idempotently validate one persisted/exported committed report row."""
    if kind not in REPORT_SCHEMAS:
        raise ReportSchemaError(f"unknown report kind: {kind}")
    schema = REPORT_SCHEMAS[kind]
    fields = (
        ("ts_event_ns", *schema.fields)
        if kind == "account"
        else (schema.index_name, *schema.fields)
    )
    expected = frozenset(field for field in fields if field is not None)
    if set(row) != expected:
        raise ReportSchemaError(f"{kind} report row must use the exact committed schema")
    normalized: dict[str, object] = {}
    for field in expected:
        value = row[field]
        if (
            kind == "orders"
            and field
            in {
                "commissions",
                "venue_order_id",
                "position_id",
                "last_trade_id",
            }
            and _is_report_null(value)
        ):
            if not _is_zero_fill_order_with_status(
                row,
                allowed_statuses=frozenset({"DENIED", "REJECTED"}),
            ):
                raise ReportSchemaError(
                    f"orders.{field} may be null only for zero-fill DENIED or REJECTED orders"
                )
            normalized[field] = None
            continue
        if (
            kind == "positions"
            and field in {"closing_order_id", "ts_closed", "avg_px_close"}
            and _is_report_null(value)
        ):
            if not _is_open_position(row):
                raise ReportSchemaError(
                    f"positions.{field} may be null only for an open native position"
                )
            normalized[field] = None
            continue
        if kind == "orders" and field == "account_id" and _is_report_null(value):
            if not _is_zero_fill_order_with_status(
                row,
                allowed_statuses=frozenset({"DENIED"}),
            ):
                raise ReportSchemaError(
                    "orders.account_id may be null only for zero-fill DENIED orders"
                )
            normalized[field] = None
            continue
        if kind == "orders" and field == "avg_px" and _is_report_null(value):
            status = row["status"]
            filled_qty = _normalize_decimal_field("filled_qty", row["filled_qty"])
            if status not in {"DENIED", "REJECTED"} or Decimal(filled_qty) != 0:
                raise ReportSchemaError(
                    "orders.avg_px may be null only for zero-fill DENIED or REJECTED orders"
                )
            normalized[field] = None
            continue
        if kind == "orders" and field in {"price", "is_post_only"} and _is_report_null(value):
            if row["type"] != "MARKET":
                raise ReportSchemaError(f"orders.{field} may be null only for MARKET orders")
            normalized[field] = None
            continue
        normalized[field] = _normalize_report_value(
            kind,
            field,
            value,
            schema.float_fields,
        )
    if kind == "fills":
        commission = cast(str, normalized["commission"])
        currency = cast(str, normalized["currency"])
        if commission.rsplit(" ", maxsplit=1)[1] != currency:
            raise ReportSchemaError("commission currency must match fills.currency")
    return normalized


def _is_zero_fill_order_with_status(
    row: Mapping[str, object], *, allowed_statuses: frozenset[str]
) -> bool:
    if row["status"] not in allowed_statuses:
        return False
    filled_qty = _normalize_decimal_field("filled_qty", row["filled_qty"])
    return Decimal(filled_qty) == 0


def _is_open_position(row: Mapping[str, object]) -> bool:
    if row["side"] not in {"LONG", "SHORT"}:
        return False
    quantity = _normalize_decimal_field("quantity", row["quantity"])
    return Decimal(quantity) > 0 and all(
        _is_report_null(row[field]) for field in ("closing_order_id", "ts_closed", "avg_px_close")
    )


def _is_report_null(value: object) -> bool:
    return (
        value is None
        or value is pd.NA
        or value is pd.NaT
        or (isinstance(value, float) and math.isnan(value))
    )


def _normalize_nested_value(value: object) -> object:
    if value is None or type(value) is bool or type(value) is int or type(value) is str:
        return value
    if type(value) is list:
        return [_normalize_nested_value(item) for item in value]
    if type(value) is dict:
        if not all(type(key) is str for key in value):
            raise ReportSchemaError("nested report object keys must be strings")
        return {key: _normalize_nested_value(item) for key, item in value.items()}
    raise ReportSchemaError(f"unsupported nested report value: {type(value).__name__}")


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
        "event_id",
        "ts_event",
        "ts_init",
        "reconciliation",
        "info",
        "position_id",
        "commission",
        "causation_id",
    }
)
_POSITION_EVENT_STRING_FIELDS = _POSITION_EVENT_FIELDS.difference(
    {
        "last_qty",
        "last_px",
        "ts_event",
        "ts_init",
        "reconciliation",
        "info",
        "commission",
        "causation_id",
    }
)


def _normalize_position_event(value: object) -> dict[str, object]:
    if type(value) is not dict or not set(value).issubset(_POSITION_EVENT_FIELDS | {"fills"}):
        raise ReportSchemaError("positions.events entries must use the rc3 OrderFilled schema")
    if _POSITION_EVENT_FIELDS.difference(value):
        raise ReportSchemaError("positions.events entries must use the rc3 OrderFilled schema")
    normalized: dict[str, object] = {}
    for field in _POSITION_EVENT_STRING_FIELDS:
        item = value[field]
        if type(item) is not str:
            raise ReportSchemaError(f"positions.events {field} must be a string")
        normalized[field] = item
    if normalized["type"] != "OrderFilled":
        raise ReportSchemaError("positions.events type must be OrderFilled")
    for field, allowed in {
        "order_side": frozenset({"BUY", "SELL"}),
        "order_type": _ORDER_TYPES,
        "liquidity_side": frozenset({"NO_LIQUIDITY_SIDE", "MAKER", "TAKER"}),
    }.items():
        if normalized[field] not in allowed:
            raise ReportSchemaError(f"positions.events {field} is not a declared rc3 enum value")
    for field in ("ts_event", "ts_init"):
        timestamp = value[field]
        if type(timestamp) is str and timestamp.isdecimal():
            normalized[field] = timestamp
            continue
        if type(timestamp) is bool or type(timestamp) is not int or timestamp < 0:
            raise ReportSchemaError(f"positions.events {field} must be a non-negative integer")
        normalized[field] = str(timestamp)
    for field in ("last_qty", "last_px"):
        normalized[field] = _normalize_decimal_field(field, value[field])
    if type(value["reconciliation"]) is not bool:
        raise ReportSchemaError("positions.events reconciliation must be a boolean")
    normalized["reconciliation"] = value["reconciliation"]
    if value["info"] is not None and type(value["info"]) is not dict:
        raise ReportSchemaError("positions.events info must be an object or null")
    normalized["info"] = _normalize_nested_value(value["info"])
    if value["causation_id"] is not None and type(value["causation_id"]) is not str:
        raise ReportSchemaError("positions.events causation_id must be a string or null")
    normalized["causation_id"] = value["causation_id"]
    commission = _normalize_money_field("positions.events commission", value["commission"])
    if commission.rsplit(" ", maxsplit=1)[1] != normalized["currency"]:
        raise ReportSchemaError("positions.events commission currency must match currency")
    normalized["commission"] = commission
    if "fills" in value:
        _normalize_nested_value(value["fills"])
    return normalized


_ACCOUNT_MARGIN_FIELDS = frozenset({"type", "initial", "maintenance", "currency", "instrument_id"})


def _normalize_account_margin(value: object) -> dict[str, object]:
    if type(value) is not dict or set(value) != _ACCOUNT_MARGIN_FIELDS:
        raise ReportSchemaError("account.margins entries must use the rc3 margin schema")
    initial = _normalize_decimal_field("account.margins.initial", value["initial"])
    maintenance = _normalize_decimal_field("account.margins.maintenance", value["maintenance"])
    margin_type = value["type"]
    currency = value["currency"]
    instrument_id = value["instrument_id"]
    if (
        margin_type != "MarginBalance"
        or type(currency) is not str
        or type(instrument_id) is not str
    ):
        raise ReportSchemaError("account.margins requires a typed rc3 MarginBalance")
    return {
        "type": margin_type,
        "initial": initial,
        "maintenance": maintenance,
        "currency": currency,
        "instrument_id": instrument_id,
    }


def _is_exact_native_empty_frame(frame: pd.DataFrame) -> bool:
    return (
        frame.shape == (0, 0)
        and isinstance(frame.index, pd.RangeIndex)
        and frame.index.name is None
        and frame.index.start == 0
        and frame.index.stop == 0
        and frame.index.step == 1
    )


def _validate_unique_report_keys(kind: str, rows: list[dict[str, object]]) -> None:
    seen: set[tuple[str, ...]] = set()
    account_rows: set[tuple[str, ...]] = set()
    for row in rows:
        key = tuple(str(row[field]) for field in _PRIMARY_KEYS[kind])
        if kind == "account":
            economic_row = (*key, _row_fingerprint(row))
            if economic_row in account_rows:
                raise ReportSchemaError(f"account report has duplicate economic row {key}")
            account_rows.add(economic_row)
            continue
        if key in seen:
            raise ReportSchemaError(f"{kind} report has duplicate primary key {key}")
        seen.add(key)


def _row_fingerprint(row: dict[str, object]) -> str:
    from stark_trading_os.audit.canonical_json import canonical_json_bytes

    return canonical_json_bytes(row).hex()


def _timestamp_ns(value: pd.Timestamp) -> int:
    if value.tzinfo is None:
        raise ReportSchemaError("timestamps must be UTC-aware")
    return int(value.tz_convert("UTC").value)


def _decimal_from_float(value: float) -> str:
    try:
        return canonical_decimal_string(Decimal(repr(float(value))))
    except CanonicalJSONError as error:
        raise ReportSchemaError(str(error)) from error


def _sort_value(value: object) -> tuple[int, object]:
    if type(value) is str and value.isdecimal():
        return (0, int(value))
    if type(value) is int:
        return (0, value)
    if value is None:
        return (1, "")
    return (2, str(value))
