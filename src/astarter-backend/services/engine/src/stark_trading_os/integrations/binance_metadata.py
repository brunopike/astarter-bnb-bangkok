"""Single-symbol offline metadata adapter; no exchange or account authorization."""

from __future__ import annotations

import time
from collections.abc import Callable
from hashlib import sha256
from typing import Any, Literal
from uuid import uuid4

from stark_trading_os.integrations.decimal_normalization import DecimalValue
from stark_trading_os.integrations.instrument_metadata import (
    TTL_NS,
    InstrumentFactsV1,
    InstrumentQuery,
    LotRules,
    MetadataInvalid,
    MetadataReceiptV1,
    MetadataResult,
    NotionalRules,
    PrecisionFact,
    PriceRules,
    RuleObservation,
    checked,
    digest,
    ns,
)
from stark_trading_os.integrations.transport import (
    Failure,
    HttpRequest,
    HttpTransport,
    http_failure,
    parse_object,
    send_once,
)

# A versioned finite parser table. Unknown fields remain observable but block adaptation.
_RULES = {
    "PRICE_FILTER": {"minPrice", "maxPrice", "tickSize"},
    "LOT_SIZE": {"minQty", "maxQty", "stepSize"},
    "MIN_NOTIONAL": {"minNotional", "applyToMarket", "avgPriceMins"},
    "NOTIONAL": {
        "minNotional",
        "maxNotional",
        "applyMinToMarket",
        "applyMaxToMarket",
        "avgPriceMins",
    },
    "PERCENT_PRICE": {"multiplierUp", "multiplierDown", "avgPriceMins"},
    "PERCENT_PRICE_BY_SIDE": {
        "bidMultiplierUp",
        "bidMultiplierDown",
        "askMultiplierUp",
        "askMultiplierDown",
        "avgPriceMins",
    },
    "MAX_NUM_ORDERS": {"maxNumOrders"},
    "MAX_POSITION": {"maxPosition"},
    "MARKET_LOT_SIZE": {"minQty", "maxQty", "stepSize"},
    "ICEBERG_PARTS": {"limit"},
    "TRAILING_DELTA": {
        "minTrailingAboveDelta",
        "maxTrailingAboveDelta",
        "minTrailingBelowDelta",
        "maxTrailingBelowDelta",
    },
    "MAX_NUM_ALGO_ORDERS": {"maxNumAlgoOrders"},
    "MAX_NUM_ICEBERG_ORDERS": {"maxNumIcebergOrders"},
    "MAX_NUM_ORDER_AMENDS": {"maxNumOrderAmends"},
    "MAX_NUM_ORDER_LISTS": {"maxNumOrderLists"},
    "EXCHANGE_MAX_NUM_ORDERS": {"maxNumOrders"},
    "EXCHANGE_MAX_NUM_ALGO_ORDERS": {"maxNumAlgoOrders"},
    "EXCHANGE_MAX_NUM_ICEBERG_ORDERS": {"maxNumIcebergOrders"},
    "EXCHANGE_MAX_NUM_ORDER_LISTS": {"maxNumOrderLists"},
}
_STATIC = {"PRICE_FILTER", "LOT_SIZE", "MIN_NOTIONAL", "NOTIONAL"}
_DYNAMIC = {
    "PERCENT_PRICE",
    "PERCENT_PRICE_BY_SIDE",
    "MAX_NUM_ORDERS",
    "MAX_POSITION",
    "EXCHANGE_MAX_NUM_ORDERS",
}
_BOOL_FIELDS = {"applyToMarket", "applyMinToMarket", "applyMaxToMarket"}
_INT_FIELDS = {
    "avgPriceMins",
    "maxNumOrders",
    "limit",
    "maxNumAlgoOrders",
    "maxNumIcebergOrders",
    "maxNumOrderAmends",
    "maxNumOrderLists",
    "minTrailingAboveDelta",
    "maxTrailingAboveDelta",
    "minTrailingBelowDelta",
    "maxTrailingBelowDelta",
}
_PRECISIONS = {
    "baseAssetPrecision",
    "quoteAssetPrecision",
    "quotePrecision",
    "baseCommissionPrecision",
    "quoteCommissionPrecision",
}
_TOP_FIELDS = {"timezone", "serverTime", "rateLimits", "exchangeFilters", "symbols"}
_SYMBOL_FIELDS = {
    "symbol",
    "status",
    "baseAsset",
    "quoteAsset",
    "isSpotTradingAllowed",
    "orderTypes",
    "permissionSets",
    "filters",
} | _PRECISIONS


def _list(value: object, maximum: int) -> list[Any]:
    if type(value) is not list or len(value) > maximum:
        raise MetadataInvalid
    return value


def _rule(raw: object, level: Literal["SYMBOL", "EXCHANGE"]) -> RuleObservation:
    if type(raw) is not dict or type(raw.get("filterType")) is not str:
        raise MetadataInvalid
    kind = raw["filterType"]
    fields = _RULES.get(kind)
    category: Literal["STATIC", "DYNAMIC", "NOT_APPLICABLE", "UNKNOWN"] = "UNKNOWN"
    if (
        fields is not None
        and set(raw) == fields | {"filterType"}
        and kind.startswith("EXCHANGE_") == (level == "EXCHANGE")
    ):
        for key in fields:
            value = raw[key]
            if key in _BOOL_FIELDS:
                if type(value) is not bool:
                    raise MetadataInvalid
            elif key in _INT_FIELDS:
                if type(value) is not int or not 0 <= value <= 2**31 - 1:
                    raise MetadataInvalid
            else:
                DecimalValue.from_raw(value)
        category = (
            "STATIC" if kind in _STATIC else ("DYNAMIC" if kind in _DYNAMIC else "NOT_APPLICABLE")
        )
    elif fields is not None and not fields.issubset(raw):
        raise MetadataInvalid
    return RuleObservation(kind=kind, level=level, category=category, raw_sha256=digest(raw))


def _facts(data: dict[str, Any], query: InstrumentQuery) -> InstrumentFactsV1:
    symbols = _list(data.get("symbols"), 1)
    if len(symbols) != 1 or type(symbols[0]) is not dict:
        raise MetadataInvalid
    symbol = symbols[0]
    if (
        symbol.get("symbol") != query.symbol
        or symbol.get("baseAsset") != query.expected_base
        or symbol.get("quoteAsset") != query.expected_quote
    ):
        raise MetadataInvalid
    filters = _list(symbol.get("filters"), 64)
    exchange_filters = _list(data.get("exchangeFilters"), 64)
    rules = tuple(_rule(f, "SYMBOL") for f in filters) + tuple(
        _rule(f, "EXCHANGE") for f in exchange_filters
    )
    static = {
        f["filterType"]: f for f, r in zip(filters, rules, strict=False) if r.category == "STATIC"
    }
    price = lot = None
    if "PRICE_FILTER" in static:
        f = static["PRICE_FILTER"]
        price = PriceRules(
            minimum=DecimalValue.from_raw(f["minPrice"]),
            maximum=DecimalValue.from_raw(f["maxPrice"]),
            tick=DecimalValue.from_raw(f["tickSize"]),
        )
    if "LOT_SIZE" in static:
        f = static["LOT_SIZE"]
        lot = LotRules(
            minimum=DecimalValue.from_raw(f["minQty"]),
            maximum=DecimalValue.from_raw(f["maxQty"]),
            step=DecimalValue.from_raw(f["stepSize"]),
        )
    notionals = []
    for kind in ("MIN_NOTIONAL", "NOTIONAL"):
        if kind not in static:
            continue
        f = static[kind]
        notionals.append(
            NotionalRules(
                kind=kind,
                minimum=DecimalValue.from_raw(f["minNotional"]),
                maximum=DecimalValue.from_raw(f["maxNotional"]) if kind == "NOTIONAL" else None,
                apply_min_to_market=f[
                    "applyToMarket" if kind == "MIN_NOTIONAL" else "applyMinToMarket"
                ],
                apply_max_to_market=f["applyMaxToMarket"] if kind == "NOTIONAL" else False,
                average_minutes=f["avgPriceMins"],
            )
        )
    if notionals:
        maximums = [f.maximum.exact() for f in notionals if f.maximum is not None]
        if maximums and max(f.minimum.exact() for f in notionals) > min(maximums):
            raise MetadataInvalid
    permissions = tuple(
        tuple(_list(group, 32)) for group in _list(symbol.get("permissionSets"), 32)
    )
    unknown = {
        "top": {k: v for k, v in data.items() if k not in _TOP_FIELDS},
        "symbol": {k: v for k, v in symbol.items() if k not in _SYMBOL_FIELDS},
    }
    return InstrumentFactsV1(
        query=query,
        trading_status=symbol["status"],
        spot_allowed=symbol["isSpotTradingAllowed"],
        order_types=tuple(_list(symbol["orderTypes"], 32)),
        permission_sets=permissions,
        precisions=tuple(
            PrecisionFact.model_validate({"name": key, "value": symbol[key]})
            for key in sorted(_PRECISIONS)
            if key in symbol
        ),
        price=price,
        lot=lot,
        notionals=tuple(notionals),
        rules=rules,
        unknown_fields_sha256=digest(unknown) if any(unknown.values()) else None,
    )


def _checked_query(value: InstrumentQuery) -> InstrumentQuery:
    try:
        return checked(InstrumentQuery, value)
    except (ValueError, TypeError, AttributeError, RecursionError):
        raise MetadataInvalid from None


def parse_metadata(
    body: bytes,
    *,
    query: InstrumentQuery,
    received_at_ns: int,
    available_at_ns: int,
    receipt_id: str,
    source_policy_id: str,
    source_policy_revision: str,
) -> MetadataResult:
    query = _checked_query(query)
    if query.venue != "BINANCE" or query.market != "SPOT":
        return MetadataResult(query=query, status="UNSUPPORTED")
    try:
        data = parse_object(body)
        facts = _facts(data, query)
        receipt = MetadataReceiptV1(
            receipt_id=receipt_id,
            raw_sha256=sha256(body).hexdigest(),
            facts_revision=facts.revision(),
            source_policy_id=source_policy_id,
            source_policy_revision=source_policy_revision,
            received_at_ns=ns(received_at_ns),
            available_at_ns=ns(available_at_ns),
            expires_at_ns=ns(received_at_ns) + TTL_NS,
            source_server_time_ms=data.get("serverTime"),
        )
        return MetadataResult(
            query=query,
            facts=facts,
            receipt=receipt,
            evaluated_at_ns=available_at_ns,
            status="OK" if receipt.usable_at(available_at_ns) else "STALE",
        )
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return MetadataResult(query=query, status="INVALID_RESPONSE", reason="INVALID_METADATA")


class BinanceMetadataProvider:
    def __init__(
        self,
        transport: HttpTransport | None = None,
        *,
        clock_ns: Callable[[], int] = time.time_ns,
        source_policy_id: str = "offline-unregistered",
        source_policy_revision: str = "unregistered",
    ) -> None:
        self._transport = transport
        self._clock = clock_ns
        self._policy = source_policy_id
        self._policy_revision = source_policy_revision

    async def fetch(self, query: InstrumentQuery) -> MetadataResult:
        query = _checked_query(query)
        if query.venue != "BINANCE" or query.market != "SPOT":
            return MetadataResult(query=query, status="UNSUPPORTED")
        if self._transport is None:
            return MetadataResult(query=query, status="UNCONFIGURED")
        if self._transport.purpose != "OFFLINE_FIXTURE":
            return MetadataResult(query=query, status="UNSUPPORTED", reason="EXTERNAL_DISABLED")
        response = await send_once(
            self._transport,
            HttpRequest(
                "GET", f"https://api.binance.com/api/v3/exchangeInfo?symbol={query.symbol}"
            ),
            timeout_seconds=3.0,
        )
        if isinstance(response, Failure):
            return MetadataResult(
                query=query,
                status=response.status,
                retry_after_seconds=response.retry_after_seconds,
            )
        try:
            received = ns(self._clock())
            if response.status != 200:
                failure = http_failure(response.status, response.headers, received // 1_000_000)
                return MetadataResult(
                    query=query,
                    status=failure.status,
                    retry_after_seconds=failure.retry_after_seconds,
                )
            # Parse before recording availability: a delayed parser must not gain a fresh TTL.
            data = parse_object(response.body)
            facts = _facts(data, query)
            available = ns(self._clock())
            receipt = MetadataReceiptV1(
                receipt_id=str(uuid4()),
                raw_sha256=sha256(response.body).hexdigest(),
                facts_revision=facts.revision(),
                source_policy_id=self._policy,
                source_policy_revision=self._policy_revision,
                received_at_ns=received,
                available_at_ns=available,
                expires_at_ns=received + TTL_NS,
                source_server_time_ms=data.get("serverTime"),
            )
            return MetadataResult(
                query=query,
                facts=facts,
                receipt=receipt,
                evaluated_at_ns=available,
                status="OK" if receipt.usable_at(available) else "STALE",
            )
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
            return MetadataResult(query=query, status="INVALID_RESPONSE", reason="INVALID_METADATA")
