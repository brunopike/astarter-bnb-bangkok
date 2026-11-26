#!/usr/bin/env python3
"""Append completed UTC spot candles to the existing Brain market archive.

Run once with python3 scripts/brain-daily-update.py, or add --dry-run to preview.
After a write, refresh the sibling market reaction archive from committed daily bars.
"""
import argparse
import concurrent.futures
import fcntl
import json
import os
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ARCHIVE = Path(__file__).resolve().parent.parent / "brain-evidence" / "daily-markets.json"
DAY = 86400
UTC = timezone.utc


def iso(epoch):
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_archive(path):
    data = json.loads(path.read_text(), parse_float=Decimal)
    keys = [a["key"] for a in data["assets"]]
    if not keys or len(keys) != len(set(keys)):
        raise ValueError("Missing or duplicate market mappings")
    return data


def venue_of(asset):
    sym, pair, quote = (asset[k] for k in ("symbol", "market", "quote"))
    url = urlsplit(asset["sourceUrl"])
    if url.scheme == "https" and asset["venue"] == "Binance Spot" and quote == "USDT" and pair == sym + quote:
        if (url.hostname, url.path, parse_qs(url.query).get("symbol")) == (
                "data-api.binance.vision", "/api/v3/klines", [pair]):
            return "binance"
    if url.scheme == "https" and asset["venue"] == "Coinbase Exchange" and quote == "USD" and pair == sym + "-" + quote:
        if (url.hostname, url.path) == ("api.exchange.coinbase.com", "/products/" + pair + "/candles"):
            return "coinbase"
    raise ValueError(f"Unverified venue, pair or quote for {asset['key']}")


def day_ranges(days):
    """Yield half-open intervals of consecutive UTC days, from sorted unique opens."""
    first = previous = None
    for day in days:
        if previous is not None and day != previous + DAY:
            yield first, previous + DAY
            first = day
        elif first is None:
            first = day
        previous = day
    if first is not None:
        yield first, previous + DAY


def validate_bar(bar):
    if len(bar) != 6 or type(bar[0]) is not int or bar[0] % DAY:
        raise ValueError("Invalid UTC candle timestamp or field count")
    opening, high, low, close, volume = map(Decimal, bar[1:])
    if (not all(n.is_finite() for n in (opening, high, low, close, volume))
            or not 0 < low <= min(opening, close) <= max(opening, close) <= high or volume < 0):
        raise ValueError("Invalid OHLCV for " + iso(bar[0]))
    return [bar[0], opening, high, low, close, volume]


def get(url):
    body = subprocess.check_output(["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "15",
                                    "--retry", "2", "--retry-max-time", "30", "--user-agent", "Astarter-daily/1.0", url])
    result = json.loads(body, parse_float=Decimal)
    if not isinstance(result, list):
        raise ValueError("Unexpected venue response")
    return result


def fetch_page(asset, venue, start, end):
    pair = asset["market"]
    if venue == "binance":
        params = {"symbol": pair, "interval": "1d", "startTime": start * 1000, "endTime": end * 1000 - 1,
                  "limit": (end - start) // DAY}
        raw = get("https://data-api.binance.vision/api/v3/klines?" + urlencode(params))
    else:
        params = {"granularity": DAY, "start": iso(start), "end": iso(end - 1)}
        raw = get("https://api.exchange.coinbase.com/products/" + pair + "/candles?" + urlencode(params))
    valid = []
    previous = None
    for row in raw:
        if venue == "binance":
            opened, closed = row[0], row[6]
            if type(opened) is not int or type(closed) is not int or opened % (DAY * 1000):
                raise ValueError("Invalid Binance candle time")
            if not opened <= closed < opened + DAY * 1000:
                raise ValueError("Invalid Binance close time")
            if closed != opened + DAY * 1000 - 1:
                continue  # A final delisting candle can close mid-day.
            epoch = opened // 1000
            bar = [epoch, *row[1:6]]
        else:
            epoch, low, high, opening, close, volume = row
            bar = [epoch, opening, high, low, close, volume]
        if not start <= epoch < end:
            continue  # Coinbase can include preceding candles.
        if previous is not None and (epoch <= previous if venue == "binance" else epoch >= previous):
            raise ValueError("Duplicate or out-of-order venue candle")
        previous = epoch
        normalized = validate_bar(bar)
        if normalized[5] > 0:
            valid.append(normalized)
    return valid


def collect(asset, cutoff, bootstrap):
    venue = venue_of(asset)
    bars = asset["bars"]
    days = [r[0] for r in bars]
    if days != sorted(set(days)) or any(validate_bar(row)[5] <= 0 for row in bars):
        raise ValueError("Invalid existing daily series")
    start = asset.get("incrementalFrom", days[-1] + DAY if days else bootstrap)
    if type(start) is not int or start % DAY:
        raise ValueError("Invalid incremental start")
    present = set(days)
    missing = (d for d in range(start, cutoff, DAY) if d not in present)
    bars_new = []
    span = (1000 if venue == "binance" else 250) * DAY
    for first, end in day_ranges(missing):
        for page in range(first, end, span):
            bars_new.extend(fetch_page(asset, venue, page, min(page + span, end)))
    return start, sorted(bars_new, key=lambda r: r[0])


def merge(data, batches, captured):
    added = 0
    for asset in data["assets"]:
        if asset["key"] not in batches:
            continue
        mapping, start, rows = batches[asset["key"]]
        if mapping != (venue_of(asset), asset["market"]):
            raise ValueError("Market mapping changed during collection")
        present = {r[0] for r in asset["bars"]}
        rows = [r for r in rows if r[0] not in present]
        if not rows:
            continue
        asset["bars"] = sorted([*asset["bars"], *rows], key=lambda r: r[0])
        # Preserve gaps after the original archive so missing days are retried.
        asset["incrementalFrom"] = min(start, asset.get("incrementalFrom", start))
        captures = asset.setdefault("captures", [])
        for first, end in day_ranges(r[0] for r in rows):
            captures.append({"start": first, "end": end - DAY, "retrievedAt": captured})
        added += len(rows)
    if added:
        data["updatedAt"] = captured
    return added


def save(path, data):
    # Keep the eight-bars-per-line archive layout and exact historical decimal values.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as out:
        temp = Path(out.name)
        try:
            header = {k: v for k, v in data.items() if k != "assets"}
            out.write(json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  "assets": [\n')
            for i, asset in enumerate(data["assets"]):
                if i:
                    out.write(",\n")
                meta = {k: v for k, v in asset.items() if k != "bars"}
                out.write("    " + json.dumps(meta, ensure_ascii=False)[:-1] + ', "bars": [')
                for j, row in enumerate(asset["bars"]):
                    if j:
                        out.write(",")
                    if j % 8 == 0:
                        out.write("\n      ")
                    out.write("[" + ",".join(format(n, "f") if isinstance(n, Decimal) else str(n) for n in row) + "]")
                out.write("\n    ]}")
            out.write("\n  ]\n}\n")
            out.flush()
            os.fsync(out.fileno())
            os.chmod(temp, path.stat().st_mode & 0o777)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", "--output", type=Path, default=ARCHIVE, help="existing daily-markets.json")
    parser.add_argument("--until", type=date.fromisoformat, help="last completed UTC day to include")
    parser.add_argument("--dry-run", action="store_true", help="fetch and validate without writing")
    args = parser.parse_args()
    today = datetime.now(UTC).date()
    until = args.until or today - timedelta(days=1)
    if until >= today:
        parser.error("--until must be a completed UTC day")
    cutoff = int(datetime.combine(until + timedelta(days=1), datetime.min.time(), UTC).timestamp())
    data = read_archive(args.archive)
    pinned = datetime.fromisoformat(data["retrievedAt"].replace("Z", "+00:00")).timestamp()
    bootstrap = (int(pinned) // DAY - 1) * DAY
    batches = {}
    failed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(collect, a, cutoff, bootstrap): a for a in data["assets"]}
        for job in concurrent.futures.as_completed(jobs):
            asset = jobs[job]
            try:
                start, rows = job.result()
                if rows:
                    batches[asset["key"]] = ((venue_of(asset), asset["market"]), start, rows)
            except (ValueError, TypeError, IndexError, KeyError, ArithmeticError, OSError, subprocess.SubprocessError) as exc:
                failed += 1
                print(f"{asset['market']} retained, retry on next run: {exc}", file=sys.stderr)
    added = sum(len(rows) for _, _, rows in batches.values())
    if added and not args.dry_run:
        lock = os.open(args.archive.parent, os.O_RDONLY)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = read_archive(args.archive)
            added = merge(current, batches, iso(datetime.now(UTC).timestamp()))
            if added:
                save(args.archive, current)
        finally:
            os.close(lock)
    print(f"{'Preview' if args.dry_run else 'Update'} through {until}: {added} new candles, {failed} failed markets", flush=True)
    if not args.dry_run:
        # Also retry on a no-op run if a prior refresh failed after candles were saved.
        generator = Path(__file__).with_name("brain-market-reactions.py")
        result = subprocess.run([sys.executable, str(generator), "--archive", str(args.archive)])
        if result.returncode:
            print("Market memories could not be rebuilt; retry the same update.", file=sys.stderr)
            return 1
    return int(failed > 0)


if __name__ == "__main__":
    sys.exit(main())
