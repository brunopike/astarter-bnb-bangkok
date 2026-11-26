"""Derive the small public market index from the same catalog that opens the records."""

import hashlib
import json
from collections import Counter
from datetime import date
from math import isfinite
import re


def source_receipts(root, series):
    names = {s["sourceIndex"] for s in series if s.get("sourceIndex")}
    if names - {"tw-stock-sources.json"}:
        raise ValueError("Unknown market source index")
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}


TAIWAN_CLOSE_IDS = {"2330": "tsmc", "2317": "honhai", "1590": "airtac", "4958": "zhending"}


def attach_market_provenance(root, catalog):
    """Verify linked full bars against both published series before assigning their category."""
    entries = catalog["series"]
    receipts = source_receipts(root, entries)
    by_id = {entry["id"]: entry for entry in entries}
    name = "tw-stock-sources.json"
    linked = {}
    if name in receipts:
        raw = (root / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != receipts[name]:
            raise ValueError("Taiwan receipt changed during indexing")
        proof = json.loads(raw)
        linked = proof.get("ohlcvByIssuer", {})
        if not isinstance(linked, dict) or set(linked) - TAIWAN_CLOSE_IDS.keys():
            raise ValueError("Unknown linked Taiwan issuer")

    def rows(meta):
        payload = (root / (meta["id"] + ".json")).read_bytes()
        doc = json.loads(payload)
        if (hashlib.sha256(payload).hexdigest() != meta["sha256"] or doc["id"] != meta["id"]
                or len(doc["rows"]) != meta["count"]):
            raise ValueError("Linked Taiwan series does not match its catalog")
        return doc["rows"]

    counts = {}
    for ticker, dates in linked.items():
        key = TAIWAN_CLOSE_IDS[ticker]
        close = by_id.get(key)
        if not close or close.get("ticker") != ticker or not isinstance(dates, dict):
            raise ValueError("Missing linked Taiwan close series")
        closes = dict(rows(close))
        full = by_id.get("tw-stock-twse-" + ticker)
        regular = {r[0] for r in rows(full)} if full else set()
        for day, prices in dates.items():
            date.fromisoformat(day)
            sources = proof["days"].get("twse-" + day, {})
            eligible = any(url.startswith("https://") and re.fullmatch(r"[a-f0-9]{64}", digest)
                           and ("STOCK_FIRST" not in url or ticker in ("1590", "4958"))
                           for url, digest in sources.items())
            if not eligible or day in regular or not isinstance(prices, list) or len(prices) != 5:
                raise ValueError("Invalid linked Taiwan date or source: " + ticker + " " + day)
            price, opening, high, low, volume = prices
            if (closes.get(day) != price or not all(type(n) in (int, float) and isfinite(n) and n > 0
                    for n in (price, opening, high, low)) or not low <= min(price, opening) <= max(price, opening) <= high
                    or type(volume) is not int or not 0 < volume < 2**53):
                raise ValueError("Invalid linked Taiwan price or volume: " + ticker + " " + day)
        counts[key] = len(dates)
    for entry in entries:
        entry.pop("linkedDailyBars", None)
        n = counts.get(entry["id"])
        if n:
            entry["linkedDailyBars"] = n
    catalog["supportingFiles"] = receipts
    return catalog


def summarize(catalog_bytes):
    series = json.loads(catalog_bytes)["series"]
    by_kind = Counter()
    ids = set()
    wholesale = Counter()
    groups = {}
    for item in series:
        key = item["id"]
        count = item["count"]
        if key in ids or type(count) is not int or count <= 0:
            raise ValueError("Duplicate market series or invalid count: " + key)
        ids.add(key)
        if item.get("statistic") in ("ohlcv", "ohlc") or (item.get("fields") or [])[
            :5
        ] == ["date", "close", "open", "high", "low"]:
            kind = "dailyBars"
        elif item.get("statistic") in ("wholesaleRange", "wholesaleModal"):
            kind = "wholesaleQuotes"
            wholesale[item["statistic"]] += count
        elif item.get("statistic") == "oracle":
            kind = "oracleReads"
        else:
            kind = "otherObservations"
        shared = item.get("linkedDailyBars", 0)
        linked_close = (item.get("statistic") == "close" and item.get("group") == "stock"
                        and TAIWAN_CLOSE_IDS.get(item.get("ticker")) == key)
        if type(shared) is not int or not 0 <= shared <= count or (shared and not linked_close):
            raise ValueError("Invalid linked daily-bar count: " + key)
        by_kind[kind] += count - shared
        by_kind["dailyBars"] += shared
        group = item["group"]
        if group == "commodity":
            group = "commodities"
        start, end = item["start"], item["end"]
        if date.fromisoformat(start) > date.fromisoformat(end):
            raise ValueError("Invalid date range: " + key)
        coverage = groups.setdefault(group, {"count": 0, "dailyBars": 0, "start": start, "end": end})
        coverage["count"] += count
        coverage["dailyBars"] += count if kind == "dailyBars" else shared
        coverage["start"] = min(coverage["start"], start)
        coverage["end"] = max(coverage["end"], end)
    return {
        "version": 1,
        "count": sum(by_kind.values()),
        "series": len(ids),
        "dailyBars": by_kind["dailyBars"],
        "wholesaleQuotes": by_kind["wholesaleQuotes"],
        "oracleReads": by_kind["oracleReads"],
        "otherObservations": by_kind["otherObservations"],
        "wholesaleRangeQuotes": wholesale["wholesaleRange"],
        "weightedMarketQuotes": wholesale["wholesaleModal"],
        "perGroup": groups,
        "catalogSha256": hashlib.sha256(catalog_bytes).hexdigest(),
    }
