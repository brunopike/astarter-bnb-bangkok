"""Derive the small public market index from the same catalog that opens the records."""

import hashlib
import json
from collections import Counter
from datetime import date


def source_receipts(root, series):
    names = {s["sourceIndex"] for s in series if s.get("sourceIndex")}
    if names - {"tw-stock-sources.json"}:
        raise ValueError("Unknown market source index")
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}


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
        by_kind[kind] += count
        group = item["group"]
        if group == "commodity":
            group = "commodities"
        start, end = item["start"], item["end"]
        if date.fromisoformat(start) > date.fromisoformat(end):
            raise ValueError("Invalid date range: " + key)
        coverage = groups.setdefault(group, {"count": 0, "dailyBars": 0, "start": start, "end": end})
        coverage["count"] += count
        if kind == "dailyBars":
            coverage["dailyBars"] += count
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
