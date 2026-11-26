"""SEC MIDAS daily individual-security/exchange metrics. Install duckdb and pyarrow."""

from __future__ import annotations

import argparse
import calendar
import csv
import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from http.client import IncompleteRead
from zipfile import ZipFile

INDEX = "https://www.sec.gov/data-research/sec-markets-data/market-structure-data-security-exchange"
RIGHTS = "https://www.sec.gov/about/privacy-information"
UA = "Astarter public archive research (https://dapp.ipfund.art)"
CLASSES = {"Stock": "sec-midas-equities", "ETF": "sec-midas-etp"}
SOURCE_FIELDS = [
    "Date",
    "Security",
    "Ticker",
    "Exchange",
    "McapRank",
    "TurnRank",
    "VolatilityRank",
    "PriceRank",
    "Cancels",
    "Trades",
    "LitTrades",
    "OddLots",
    "Hidden",
    "TradesForHidden",
    "OrderVol('000)",
    "TradeVol('000)",
    "LitVol('000)",
    "OddLotVol('000)",
    "HiddenVol('000)",
    "TradeVolForHidden('000)",
]
FIELDS = [
    "date",
    "ticker",
    "exchange",
    "trades",
    "litTrades",
    "oddLots",
    "cancels",
    "tradeVolumeThousands",
]
KEY = "Date, Security, Ticker, Exchange"
METRICS = ("Trades", "LitTrades", "OddLots", "Cancels", "TradeVol('000)")
SERIES_INFO = {
    "Stock": (
        "U.S. equities · SEC exchange activity",
        "美国股票 · SEC 交易所活动",
        "stock",
    ),
    "ETF": (
        "U.S. exchange-traded products · SEC exchange activity",
        "美国交易所交易产品 · SEC 交易所活动",
        "etf",
    ),
}
COUNTERS = (
    "rawRows",
    "missingKeyRows",
    "identicalDuplicateRows",
    "conflictingRows",
    "conflictingKeys",
)


def digest(path):
    with Path(path).open("rb") as src:
        return hashlib.file_digest(src, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    raw = (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        + "\n"
    ).encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        tmp.write(raw)
        name = tmp.name
    os.replace(name, path)
    return hashlib.sha256(raw).hexdigest()


def valid_url(url):
    loc = urlsplit(url)
    return (
        loc.scheme == "https"
        and loc.netloc == "www.sec.gov"
        and loc.path.lower().endswith(".zip")
    )


def official_quarters(markup, until):
    out = {}
    for href, year, q in re.findall(
        r'<a\b[^>]*\bhref="([^"]+\.zip)"[^>]*>\s*(\d{4})\s+Q([1-4])\s*</a>',
        markup,
        re.I,
    ):
        end_month = int(q) * 3
        end = dt.date(
            int(year), end_month, calendar.monthrange(int(year), end_month)[1]
        )
        if int(year) < 2016 or end > until:
            continue
        quarter = f"{year}Q{q}"
        url = urljoin(INDEX, href)
        if not valid_url(url) or (quarter in out and out[quarter] != url):
            raise ValueError(f"Ambiguous SEC download for {quarter}")
        out[quarter] = url
    if not out:
        raise ValueError("SEC quarterly download index is empty")
    return dict(sorted(out.items()))


def iso_day(n):
    return dt.datetime.strptime(str(int(n)), "%Y%m%d").date().isoformat()


def scan_month(z, name, expected_month, db):
    import pyarrow as pa
    import pyarrow.csv as pc

    with z.open(name) as src:
        header = next(csv.reader([src.readline().decode("utf-8-sig").strip()]))
    if len(header) != len(SOURCE_FIELDS) or set(header) != set(SOURCE_FIELDS):
        raise ValueError(f"{name}: unsupported SEC column schema {header}")
    types = {
        field: pa.string()
        if field in ("Security", "Ticker", "Exchange")
        else pa.float64()
        for field in header
    }
    with z.open(name) as src:
        table = pc.read_csv(
            src,
            read_options=pc.ReadOptions(use_threads=False, block_size=4 * 1024 * 1024),
            convert_options=pc.ConvertOptions(
                column_types=types, strings_can_be_null=False
            ),
        )
    db.register("records", table)
    month = {}
    try:
        dates = db.sql("SELECT DISTINCT Date FROM records").fetchall()
        if not dates or any(
            value is None
            or not value.is_integer()
            or not iso_day(value).startswith(expected_month)
            for (value,) in dates
        ):
            raise ValueError(f"{name}: unexpected trading date")
        null_key = "trim(Ticker) = '' OR trim(Exchange) = ''"
        tally = db.sql(
            f"SELECT Security, count(*), count(*) FILTER (WHERE {null_key}) FROM records GROUP BY Security"
        ).fetchall()
        if set(item[0] for item in tally) - CLASSES.keys():
            raise ValueError(f"{name}: unexpected security class {tally}")
        db.execute(
            f"CREATE TEMP VIEW keyed AS SELECT * FROM records WHERE NOT ({null_key})"
        )
        db.execute(
            f"CREATE TEMP TABLE repeated AS SELECT {KEY}, count(*) n FROM keyed GROUP BY {KEY} HAVING count(*) > 1"
        )
        # Only compare all twenty published fields for the small subset with a repeated identity.
        db.execute(
            f"CREATE TEMP TABLE variants AS SELECT DISTINCT keyed.* FROM keyed JOIN repeated USING ({KEY})"
        )
        db.execute(
            f"CREATE TEMP TABLE repeated_audit AS SELECT repeated.*, v.variants FROM repeated JOIN (SELECT {KEY}, count(*) variants FROM variants GROUP BY {KEY}) v USING ({KEY})"
        )
        for security, raw, missing in tally:
            exact, conflict_rows, conflict_keys = db.execute(
                "SELECT coalesce(sum(n-1) FILTER (WHERE variants=1),0), coalesce(sum(n) FILTER (WHERE variants>1),0), count(*) FILTER (WHERE variants>1) FROM repeated_audit WHERE Security=?",
                [security],
            ).fetchone()
            item = dict(
                zip(COUNTERS, (raw, missing, exact, conflict_rows, conflict_keys))
            )
            item["count"] = raw - missing - exact - conflict_rows
            month[security] = item
        db.execute(
            f"CREATE TEMP VIEW accepted AS SELECT keyed.* FROM keyed ANTI JOIN repeated USING ({KEY}) UNION ALL SELECT v.* FROM variants v JOIN repeated_audit r USING ({KEY}) WHERE r.variants=1"
        )
        for security, count, first, last in db.sql(
            "SELECT Security,count(*),min(Date),max(Date) FROM accepted GROUP BY Security"
        ).fetchall():
            if count != month[security]["count"]:
                raise ValueError(f"{name}: deduplication audit mismatch")
            month[security].update(start=iso_day(first), end=iso_day(last), tickers={})
        select_metrics = ",".join(f'"{metric}"' for metric in METRICS)
        # Source date dominates and unavailable trade count sorts after published zero.
        for security, day, ticker, venue, *values in db.sql(
            f"SELECT Security,Date,Ticker,Exchange,{select_metrics} FROM accepted QUALIFY row_number() OVER (PARTITION BY Security,Ticker ORDER BY Date DESC, Trades DESC NULLS LAST, Exchange ASC) = 1"
        ).fetchall():
            if any(value is not None and not math.isfinite(value) for value in values):
                raise ValueError(f"{name}: non-finite observation")
            nums = [int(v) if v is not None and v.is_integer() else v for v in values]
            month[security]["tickers"][ticker] = [iso_day(day), ticker, venue, *nums]
        return month
    finally:
        for typ, obj in [
            ("VIEW", "accepted"),
            ("TABLE", "repeated_audit"),
            ("TABLE", "variants"),
            ("TABLE", "repeated"),
            ("VIEW", "keyed"),
        ]:
            db.execute(f"DROP {typ} IF EXISTS {obj}")
        db.unregister("records")


def scan_quarter(quarter, zip_path):
    import duckdb

    match = re.fullmatch(r"(20\d\d)Q([1-4])", quarter)
    if not match:
        raise ValueError(f"Invalid quarter: {quarter}")
    year, q = map(int, match.groups())
    expected = {
        f"{calendar.month_abbr[m].lower()}{year % 100:02}.csv": f"{year}-{m:02}"
        for m in range(3 * q - 2, 3 * q + 1)
    }
    result = {
        kind: {"count": 0, **dict.fromkeys(COUNTERS, 0), "tickers": {}, "monthly": []}
        for kind in CLASSES
    }
    with ZipFile(zip_path) as z, duckdb.connect() as db:
        db.execute("SET threads=2")
        db.execute("SET memory_limit='2500MB'")
        names = [n.filename for n in z.infolist() if not n.is_dir()]
        if len(names) != len(set(names)) or {
            n.lower() for n in names if n.lower().endswith(".csv")
        } != set(expected):
            raise ValueError(
                f"{quarter}: expected exactly its three monthly CSV members, received {names}"
            )
        for name in names:
            if not name.lower().endswith(".csv"):
                if name.lower() != "readme.txt":
                    raise ValueError(f"Unknown ZIP member {name}")
                z.read(name)  # Complete read verifies ZIP CRC for documentation, too.
        for name in sorted(
            (n for n in names if n.lower().endswith(".csv")),
            key=lambda n: expected[n.lower()],
        ):
            month = expected[name.lower()]
            stats = scan_month(z, name, month, db)
            for kind, values in stats.items():
                tickers = values.pop("tickers", {})
                if not tickers:
                    raise ValueError(f"{quarter} {month} {kind}: no usable tickers")
                bucket = result[kind]
                bucket["tickers"].update(tickers)
                bucket["monthly"].append({"month": month, **values})
                for field in ("count", *COUNTERS):
                    bucket[field] += values[field]
                bucket.setdefault("start", values["start"])
                bucket["end"] = values["end"]
    return result


def emit_quarter(results, key, source, dest):
    parts = {}
    for kind, dataset in CLASSES.items():
        detail = results[kind].copy()
        tickers = detail.pop("tickers")
        rows = [tickers[t] for t in sorted(tickers)]
        sample_symbols = (
            ("AAPL", "MSFT", "NVDA", "IBM", "BRK.B")
            if kind == "Stock"
            else ("SPY", "QQQ", "IWM", "GLD", "VTI")
        )
        sample = [tickers[t] for t in sample_symbols if t in tickers] or rows[:3]
        if not sample:
            raise ValueError(f"{key} {kind}: empty index")
        file = f"{dataset}-{key.lower()}.json"
        sha = write_json(dest / file, {"id": dataset, "quarter": key, "rows": rows})
        parts[kind] = {
            **{k: source[k] for k in ("url", "sha256", "etag", "lastModified", "size")},
            "quarter": key,
            **detail,
            "sample": sample,
            "tickerFile": file,
            "tickerSha256": sha,
            "tickerCount": len(rows),
        }
    return parts


def get_response(url, method="GET", headers=None):
    req = Request(
        url,
        method=method,
        headers={
            "User-Agent": os.getenv("SEC_USER_AGENT") or UA,
            "Accept-Encoding": "identity",
            **(headers or {}),
        },
    )
    try:
        return urlopen(req, timeout=90)
    except HTTPError as exc:
        if exc.code == 304:
            return exc
        raise


def network_retry(operation, *args):
    for attempt in range(3):
        try:
            return operation(*args)
        except HTTPError as exc:
            if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
            raw_delay = exc.headers.get("Retry-After", "")
            if raw_delay and (not raw_delay.isdigit() or int(raw_delay) > 90):
                raise
            delay = int(raw_delay) if raw_delay else 2 ** (attempt + 1)
        except (URLError, TimeoutError, ConnectionError, IncompleteRead) as exc:
            if attempt == 2:
                raise
            delay = 2 ** (attempt + 1)
        time.sleep(delay)


def get_text(url):
    with get_response(url) as r:
        return r.read().decode("utf-8")


def source_updated(url, old):
    if not old or url != old.get("url"):
        return True
    cond = {}
    if old.get("etag"):
        cond["If-None-Match"] = old["etag"]
    if old.get("lastModified"):
        cond["If-Modified-Since"] = old["lastModified"]
    if not cond:
        return True
    try:
        with get_response(url, "HEAD", cond) as r:
            if r.status == 304:
                return False
            tag, modified, size = (
                r.headers.get(name)
                for name in ("ETag", "Last-Modified", "Content-Length")
            )
            if tag and old.get("etag"):
                return tag != old["etag"] or bool(size and int(size) != old["size"])
            return not (
                modified
                and modified == old.get("lastModified")
                and size
                and int(size) == old["size"]
            )
    except HTTPError as exc:
        if exc.code in (405, 501):
            return True
        raise


def download_zip(url, key, path):
    sha = hashlib.sha256()
    with get_response(url) as response, path.open("wb") as target:
        while block := response.read(1024 * 1024):
            target.write(block)
            sha.update(block)
        size = target.tell()
        length = response.headers.get("Content-Length")
        if size < 1 or (length and size != int(length)):
            raise ConnectionError(f"{key}: interrupted SEC download")
        return {
            "quarter": key,
            "url": url,
            "sha256": sha.hexdigest(),
            "size": size,
            "etag": response.headers.get("ETag"),
            "lastModified": response.headers.get("Last-Modified"),
        }


def publish(dest, staged, parts, catalog):
    by_id = {entry["id"]: entry for entry in catalog["series"]}
    for kind, ident in CLASSES.items():
        records = [parts[q][kind] for q in sorted(parts)]
        ticker_indexes = []
        for q in records:
            file = q["tickerFile"]
            if file != f"{ident}-{q['quarter'].lower()}.json":
                raise ValueError(f"Invalid lookup path for {ident}")
            path = (staged / file) if (staged / file).is_file() else dest / file
            if digest(path) != q["tickerSha256"]:
                raise ValueError(f"{file}: lookup checksum mismatch")
            ticker_indexes.append(
                {"file": file, "sha256": q["tickerSha256"], "count": q["tickerCount"]}
            )
        file = f"{ident}.json"
        sha = write_json(staged / file, {"id": ident, "quarters": records})
        en, zh, group = SERIES_INFO[kind]
        by_id[ident] = {
            "id": ident,
            "group": group,
            "en": en,
            "zh": zh,
            "unit": "messages; volume in thousands of shares",
            "statistic": "exchangeActivity",
            "frequency": "daily",
            "fields": FIELDS,
            "source": "U.S. Securities and Exchange Commission · MIDAS",
            "sourceUrl": INDEX,
            "license": "SEC Website Dissemination · U.S. SEC public information",
            "licenseUrl": RIGHTS,
            "coverage": "Daily security/venue observations on SEC-published dates. SEC updates the underlying files quarterly. Unique on trading date, source security class, ticker and exchange. Blank identity fields and all conflicting identities are excluded. Identical rows are counted once. Each quarter lookup provides one observed row per ticker, from its last reported date and the venue with the highest reported trade-message count; the full daily original is linked.",
            "sourceSecurity": kind,
            "start": min(q["start"] for q in records),
            "end": max(q["end"] for q in records),
            "count": sum(q["count"] for q in records),
            "sha256": sha,
            "quarterIndexes": ticker_indexes,
        }
    for ident in CLASSES.values():
        for file in staged.glob(f"{ident}-*.json"):
            os.replace(file, dest / file.name)
    for ident in CLASSES.values():
        os.replace(staged / f"{ident}.json", dest / f"{ident}.json")
    write_json(dest / "catalog.json", {**catalog, "series": list(by_id.values())})


def build(
    dest,
    until,
    *,
    load=get_text,
    changed=source_updated,
    download=download_zip,
    scan=scan_quarter,
):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    catalog_path = dest / "catalog.json"
    catalog = (
        json.loads(catalog_path.read_bytes())
        if catalog_path.exists()
        else {"version": 1, "series": []}
    )
    old = {}
    metadata = {s["id"]: s for s in catalog["series"]}
    for kind, ident in CLASSES.items():
        if ident in metadata:
            path = dest / f"{ident}.json"
            if digest(path) != metadata[ident].get("sha256"):
                raise ValueError(f"{ident}: parent checksum mismatch")
            for q in json.loads(path.read_bytes())["quarters"]:
                old.setdefault(q["quarter"], {})[kind] = q
    quarters = official_quarters(network_retry(load, INDEX), until)
    latest = max(quarters)
    for y in range(2016, int(latest[:4]) + 1):
        for idx in range(1, 5):
            k = f"{y}Q{idx}"
            if k <= latest and k not in quarters:
                raise ValueError(f"{k} is missing from the SEC listing")
    cutoff = f"{until.year}Q{(until.month - 1) // 3 + 1}"
    if any(key not in quarters for key in old if key < cutoff):
        raise ValueError(
            "Previously archived quarter disappeared from official listing"
        )
    parts = dict(old)
    with tempfile.TemporaryDirectory(prefix=".midas-", dir=dest) as tmp:
        stage = Path(tmp)
        for key, url in quarters.items():
            existing = old.get(key, {})
            first = existing.get("Stock") if set(existing) == set(CLASSES) else None
            if first and (
                any(existing[k]["sha256"] != first["sha256"] for k in CLASSES)
                or any(
                    not (path := dest / f"{CLASSES[k]}-{key.lower()}.json").is_file()
                    or digest(path) != existing[k]["tickerSha256"]
                    for k in CLASSES
                )
            ):
                first = None
            if not network_retry(changed, url, first):
                continue
            zip_path = stage / "source.zip"
            try:
                source = network_retry(download, url, key, zip_path)
                if first and source["sha256"] == first["sha256"]:
                    parts[key] = {k: {**v, **source} for k, v in existing.items()}
                else:
                    parts[key] = emit_quarter(scan(key, zip_path), key, source, stage)
            finally:
                zip_path.unlink(missing_ok=True)
        publish(dest, stage, parts, catalog)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dest", type=Path)
    parser.add_argument(
        "--until",
        type=dt.date.fromisoformat,
        default=dt.datetime.now(dt.timezone.utc).date(),
    )
    args = parser.parse_args()
    build(args.dest, args.until)
