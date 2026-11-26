#!/usr/bin/env python3
"""Rebuild closed-window market memories from the existing spot candle archive.

brain-daily-update.py refreshes this automatically. Use --check for a read-only comparison.
"""
import argparse
import fcntl
import json
import os
import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from statistics import median
from urllib.parse import urlencode

DATA = Path(__file__).resolve().parents[1] / "brain-evidence"
DAY = 86400
BASELINE = 60
HORIZONS = (1, 7, 30)
COOLDOWN = 30


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def epoch(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def change(start, end):
    return (end / start - 1) * 100


def rounded(value):
    return float(round(value, 4))


def source_url(asset, first, last):
    end = last + DAY
    if asset["venue"] == "Binance Spot" and asset["market"] == asset["symbol"] + asset["quote"]:
        params = {"symbol": asset["market"], "interval": "1d", "startTime": first * 1000,
                  "endTime": end * 1000 - 1, "limit": (end - first) // DAY}
        return "https://data-api.binance.vision/api/v3/klines?" + urlencode(params)
    if asset["venue"] == "Coinbase Exchange" and asset["market"] == asset["symbol"] + "-" + asset["quote"]:
        params = {"granularity": DAY, "start": iso(first), "end": iso(end - 1)}
        return "https://api.exchange.coinbase.com/products/" + asset["market"] + "/candles?" + urlencode(params)
    raise ValueError("Unrecognized spot venue or pair: " + asset["market"])


def observation(bars, i):
    before = bars[i - BASELINE - 1:i]
    absolute_returns = sorted(abs(change(a[4], b[4])) for a, b in zip(before, before[1:]))
    # Nearest-rank 95th percentile of 60 previous absolute returns.
    rank = (BASELINE * 95 + 99) // 100
    threshold = max(Decimal(3), absolute_returns[rank - 1])
    _, opening, high, low, close, volume = bars[i]
    previous = before[-1][4]
    move = change(previous, close)
    ratio = volume / median(b[5] for b in before[1:])
    span = high - low
    span_pct = span / previous * 100
    close_location = (close - low) / span * 100 if span else None
    lower_wick = (min(opening, close) - low) / span * 100 if span else None
    kinds = []
    if abs(move) >= threshold:
        kinds.append("price-shock")
    if ratio >= 3 and abs(move) <= 1:
        kinds.append("volume-divergence")
    if span_pct >= 8 and close_location >= 75 and lower_wick >= 50:
        kinds.append("lower-wick")
    return kinds, {"priorClose": float(previous), "close": float(close),
                   "dayReturnPct": rounded(move), "thresholdPct": rounded(threshold),
                   "volumeMultiple": rounded(ratio), "rangePct": rounded(span_pct),
                   "closeLocationPct": rounded(close_location) if span else None,
                   "lowerWickPct": rounded(lower_wick) if span else None}


def follow_up(window):
    peak = start = window[0][4]
    worst = Decimal(0)
    horizons = []
    for days, bar in enumerate(window[1:], start=1):
        close = bar[4]
        peak = max(peak, close)
        worst = min(worst, change(peak, close))
        if days in HORIZONS:
            horizons.append({"days": days, "at": iso(bar[0] + DAY), "close": float(close),
                             "returnPct": rounded(change(start, close)), "maxDrawdownPct": rounded(worst)})
    return horizons


def asset_records(asset, initial_capture):
    bars = [[row[0], *map(Decimal, row[1:])] for row in asset["bars"]]
    previous = -DAY
    for bar in bars:
        ts, opening, high, low, closing, volume = bar
        if type(ts) is not int or ts % DAY or ts <= previous or not 0 < low <= min(opening, closing) <= max(opening, closing) <= high or volume <= 0:
            raise ValueError("Invalid UTC spot candle in " + asset["market"])
        previous = ts
    captures = asset.get("captures", [])
    last_selected = {}
    records = []
    for i in range(BASELINE + 1, len(bars) - HORIZONS[-1]):
        at = bars[i][0]
        first = bars[i - BASELINE - 1][0]
        if at - first != (BASELINE + 1) * DAY:
            continue
        kinds, metrics = observation(bars, i)
        for kind in kinds:
            if kind in last_selected and at - last_selected[kind] < COOLDOWN * DAY:
                continue
            # The event and its cooldown are selected before reading the following bars.
            last_selected[kind] = at
            window = bars[i:i + HORIZONS[-1] + 1]
            end = window[-1][0]
            if end - at != HORIZONS[-1] * DAY:
                continue
            captured = max([epoch(initial_capture)] + [epoch(c["retrievedAt"]) for c in captures
                           if c["start"] <= end and c["end"] >= first])
            if captured < end + DAY:
                raise ValueError("Incomplete candles at archive capture: " + asset["market"])
            day = iso(at)[:10]
            end_close, start_close = window[-1][4], window[0][4]
            outcome = "higher" if end_close > start_close else "lower" if end_close < start_close else "flat"
            records.append({"id": f"reaction/{asset['key']}/{day}/{kind}", "kind": kind,
                            "scopeKeys": [asset["key"]], "symbol": asset["symbol"], "market": asset["market"],
                            "venue": asset["venue"], "priceUnit": asset["quote"], "day": day,
                            "eventAt": iso(at + DAY), "reviewedAt": iso(end + DAY), "knownAt": iso(captured),
                            "sourceUrl": source_url(asset, first, end), **metrics,
                            "horizons": follow_up(window), "outcome": outcome})
    # Compare completed, older cases for the same market, pattern, and (for shocks) direction.
    # Prefer the most recent example of each outcome. Refilling the archive only appends later comparisons.
    groups = {}
    for r in records:
        direction = (r["dayReturnPct"] > 0) if r["kind"] == "price-shock" else None
        group = groups.setdefault((r["kind"], direction), [])
        examples = {}
        for older in reversed(group):
            if older["reviewedAt"] <= r["eventAt"]:
                examples.setdefault(older["outcome"], older["id"])
            if len(examples) == 3:
                break
        r["relations"] = [{"id": value, "kind": "parallel" if outcome == r["outcome"] else "contrast"}
                          for outcome, value in examples.items()]
        r["relatedIds"] = list(examples.values())
        group.append(r)
    return records


def render(archive, source_name):
    records = []
    for asset in archive["assets"]:
        records.extend(asset_records(asset, archive["retrievedAt"]))
    records.sort(key=lambda r: (r["eventAt"], r["id"]))
    header = {"schemaVersion": 1, "sourceArchive": source_name, "method": {
        "baselineDays": BASELINE, "horizonDays": list(HORIZONS), "cooldownDaysPerMarketAndKind": COOLDOWN,
        "patterns": {
            "price-shock": {"label": ["单日价格突变", "One-day price shock"],
                            "criterion": ["当日收盘涨跌幅的绝对值达到过去 60 天的第 95 百分位，且至少为 3%。",
                                          "The absolute close-to-close move reached the nearest-rank 95th percentile of the prior 60 days and was at least 3%."]},
            "volume-divergence": {"label": ["放量横盘", "Heavy volume, flat close"],
                                  "criterion": ["当日现货成交量达到过去 60 天中位数的 3 倍，收盘涨跌幅在 1% 以内。",
                                                "Spot volume reached three times the median of the prior 60 days while the absolute close-to-close move stayed within 1%."]},
            "lower-wick": {"label": ["长下影回收", "Long lower wick"],
                           "criterion": ["日内高低价差至少为昨收的 8%，下影线占振幅一半以上，收盘位于当日区间最高的四分之一。",
                                         "The daily range was at least 8% of the previous close. The lower wick covered at least half the range, and the close landed in its top quarter."]}},
        "sampling": ["同一市场、同一形态每 30 天最多选取首次符合条件的一天，只纳入已有完整 30 天后续日线的案例。",
                     "The first qualifying date per market and pattern starts a 30-day cooldown. The archive includes completed 30-day observations with consecutive UTC candles."],
        "followUp": ["第 1、7、30 天的涨跌均相对事件日收盘。最大回撤取同期逐日收盘价从高点到后续低点的最大跌幅。",
                     "Day 1, 7 and 30 changes are relative to the event close. Maximum drawdown uses the largest peak-to-later-trough decline across daily closes in each window."],
        "time": "eventAt and horizon.at are UTC close boundaries; knownAt is the latest retrieval of the source bars in the pinned archive.",
        "relatedIds": "Most recent older completed case per 30-day outcome for the same market and pattern, with matching direction for price shocks."}}
    return json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  "records": [\n' + ",\n".join(
        "    " + json.dumps(r, ensure_ascii=False, separators=(",", ":"), allow_nan=False) for r in records) + "\n  ]\n}\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DATA / "daily-markets.json")
    parser.add_argument("--output", type=Path, help="default: sibling of the selected source archive")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output = args.output or args.archive.with_name(
        "market-reactions.json" if args.archive.name == "daily-markets.json" else args.archive.stem + ".market-reactions.json")
    if output.resolve() == args.archive.resolve():
        parser.error("source and output must be different files")
    # Use the candle updater's directory lock: an older snapshot cannot overwrite a newer refresh.
    lock = os.open(args.archive.parent, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_SH if args.check else fcntl.LOCK_EX)
        archive = json.loads(args.archive.read_text(), parse_float=Decimal)
        content = render(archive, args.archive.name)
        current = output.read_text() if output.exists() else None
        if current != content:
            if args.check:
                parser.exit(1, "Market reactions differ from the current candle archive.\n")
            with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, encoding="utf-8", delete=False) as out:
                temp = Path(out.name)
                try:
                    out.write(content)
                    out.flush()
                    os.fsync(out.fileno())
                    temp.chmod(0o644)
                    os.replace(temp, output)
                finally:
                    temp.unlink(missing_ok=True)
    finally:
        os.close(lock)
    print(f"{len(json.loads(content)['records'])} closed-window market memories")


if __name__ == "__main__":
    main()
