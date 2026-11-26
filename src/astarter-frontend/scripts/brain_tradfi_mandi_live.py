"""Maintain AGMARKNET's daily arrival-weighted prices, separate from variety and grade quotes."""

import argparse
import csv
import hashlib
import io
import json
import math
import subprocess
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from brain_tradfi_mandi import CROPS, LICENSE, store

API = "https://api.agmarknet.gov.in/v1/dashboard-data/"
FIRST = date(2026, 4, 21)
# Keys are official commodity names in the government report. Values are the official ID and archive slug.
PRODUCTS = {
    "Wheat": (1, "wheat"),
    "Maize": (4, "maize"),
    "Rice": (3, "rice"),
    "Paddy(Common)": (2, "paddy"),
    "Soyabean": (13, "soybean"),
    "Mustard": (12, "mustard"),
    "Cotton": (15, "cotton"),
    "Groundnut": (10, "groundnut"),
    "Sugar": (44, "sugar"),
    "Jute": (16, "jute"),
    "Coffee": (41, "coffee"),
    "Barley(Jau)": (29, "barley"),
    "Turmeric": (35, "turmeric"),
    "Black Gram(Urd Beans)(Whole)": (8, "black-gram"),
    "Bengal Gram(Gram)(Whole)": (6, "chickpea"),
    "Red gram/Arhar/Tur(whole)": (45, "pigeon-pea"),
    "Green Gram(Moong)(Whole)": (9, "mung-bean"),
    "Onion": (23, "onion"),
    "Potato": (24, "potato"),
    "Tomato": (65, "tomato"),
}
NAMES = {slug: zh for slug, zh in CROPS.values()}
DAY = timedelta(days=1)


def parse(raw, day):
    reader = csv.reader(io.StringIO(raw.decode("utf-8-sig")))
    if f"Data Monitoring Report ({day:%d-%m-%Y})" not in next(reader):
        raise ValueError("AGMARKNET export date differs: " + str(day))
    fields = next(reader)
    if fields != [
        "Commodity Group",
        "Commodity",
        "State/UT",
        "District",
        "Market",
        "Reporting Status",
        "Modal Price",
        "Price Unit",
        "Arrival",
        "Arrival Unit",
    ]:
        raise ValueError("AGMARKNET market export schema changed")
    observed, conflicts = {}, set()
    footer = False
    for row in reader:
        if row and row[0].startswith("Weighted Average Price"):
            footer = True
        if len(row) != len(fields) or row[5] != "Reported Markets":
            continue
        if row[1] not in PRODUCTS:
            raise ValueError("Unexpected reported commodity: " + row[1])
        if row[7] != "Rs./Quintal" or not all(
            v.strip() and v.strip() != "-" for v in row[2:5]
        ):
            continue
        try:
            price = float(row[6].replace(",", ""))
        except ValueError:
            continue
        if not math.isfinite(price) or price <= 0:
            continue
        key = (PRODUCTS[row[1]][1], tuple(v.strip() for v in row[2:5]))
        if key in observed and price != observed[key]:
            conflicts.add(key)
        observed[key] = int(price) if price.is_integer() else price
    if not footer:
        raise ValueError("Incomplete export or unrecognized price basis: " + str(day))
    for key in conflicts:
        del observed[key]
    return observed


def fetch(day):
    params = {
        "dashboard": "market_details_sp",
        "commodity": [i for i, _ in PRODUCTS.values()],
        "date": str(day),
        "page": 1,
        "limit": 500,
        "format": "json",
        "downloadreport": "true",
        "downloadformat": "csv",
    }
    return subprocess.check_output(
        [
            "curl",
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "90",
            "--retry",
            "2",
            "--retry-max-time",
            "120",
            "--user-agent",
            "Mozilla/5.0 (compatible; Astarter open market archive)",
            "-H",
            "Content-Type: application/json",
            "--data",
            json.dumps(params),
            API,
        ]
    )


def read_day(day, cache):
    file = cache / (str(day) + ".csv") if cache else None
    if file and file.is_file():
        return parse(file.read_bytes(), day)
    raw = fetch(day)
    rows = parse(raw, day)
    if file:
        file.write_bytes(raw)
    time.sleep(1.6)
    return rows


def save_month(dest, catalog, month, quotes, revisited):
    for name, (_, slug) in PRODUCTS.items():
        key = "mandi-modal-" + slug
        meta = catalog.get(key, {})
        shards = {s["month"]: s for s in meta.get("shards", [])}
        chunk_path = dest / f"{key}-{month}.json"
        existing = {}
        if month in shards:
            raw = chunk_path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != shards[month]["sha256"]:
                raise ValueError("Damaged monthly file: " + key + " " + month)
            chunk = json.loads(raw)
            for day, loc, price in chunk["rows"]:
                if day not in revisited:
                    existing[day, tuple(chunk["locations"][loc])] = price
        existing.update(quotes.get(slug, {}))
        if existing:
            venues = {}
            rows = [
                [d, venues.setdefault(loc, len(venues)), p]
                for (d, loc), p in sorted(existing.items())
            ]
            digest = store(
                chunk_path,
                {"id": key, "month": month, "locations": list(venues), "rows": rows},
            )
            shards[month] = {
                "month": month,
                "count": len(rows),
                "start": f"{month}-{rows[0][0]:02}",
                "end": f"{month}-{rows[-1][0]:02}",
                "sha256": digest,
            }
        elif month in shards:
            del shards[month]
        if not shards:
            if key in catalog:
                raise ValueError("No verified observations remain for " + key)
            continue
        ordered = [shards[k] for k in sorted(shards)]
        digest = store(dest / (key + ".json"), {"id": key, "shards": ordered})
        catalog[key] = {
            "id": key,
            "group": "commodities",
            "zh": "印度市场加权价 · " + NAMES[slug],
            "en": "India market weighted price · " + name,
            "unit": "INR / 100 kg",
            "statistic": "wholesaleModal",
            "source": "AGMARKNET · Directorate of Marketing & Inspection, India",
            "sourceUrl": "https://agmarknet.gov.in/home",
            "datasetUrl": API,
            "license": "Government Open Data License – India",
            "licenseUrl": LICENSE,
            "frequency": "daily",
            "shards": ordered,
            "start": ordered[0]["start"],
            "end": ordered[-1]["end"],
            "sha256": digest,
            "count": sum(s["count"] for s in ordered),
        }


def build(dest, until, cache=None, first=None):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    path = dest / "catalog.json"
    catalog = (
        {s["id"]: s for s in json.loads(path.read_bytes())["series"]}
        if path.is_file()
        else {}
    )
    latest = max(
        (
            date.fromisoformat(s["end"])
            for s in catalog.values()
            if s["statistic"] == "wholesaleModal"
        ),
        default=FIRST,
    )
    if first is None:
        first = max(FIRST, latest - 9 * DAY)
    if first > until:
        raise ValueError("Invalid market reporting interval")
    day = first
    latest_seen = None
    while day <= until:
        month = day.strftime("%Y-%m")
        quotes = defaultdict(dict)
        revisited = set()
        while day <= until and day.strftime("%Y-%m") == month:
            obs = read_day(day, cache)
            if obs:
                latest_seen = day
            for (slug, loc), value in obs.items():
                quotes[slug][day.day, loc] = value
            revisited.add(day.day)
            day += DAY
        save_month(dest, catalog, month, quotes, revisited)
        store(path, {"version": 1, "series": list(catalog.values())})
        print("AGMARKNET", month, sum(len(v) for v in quotes.values()), flush=True)
    if latest_seen is None or until - latest_seen > 4 * DAY:
        raise ValueError(
            "AGMARKNET has no recent reported market prices through " + str(until)
        )


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--until", type=date.fromisoformat, required=True)
    p.add_argument("--first", type=date.fromisoformat)
    p.add_argument("--cache", type=Path)
    a = p.parse_args()
    build(a.root, a.until, a.cache, a.first)
