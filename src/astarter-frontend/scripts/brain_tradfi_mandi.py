"""Archive real AGMARKNET wholesale reports, one quote per venue, grade, variety and day."""

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

SOURCE = (
    "https://www.data.gov.in/resource/variety-wise-daily-market-prices-data-commodity"
)
LICENSE = "https://www.data.gov.in/Godl"
SNAPSHOT = "https://www.kaggle.com/datasets/khandelwalmanas/daily-commodity-prices-india/versions/134"
SNAPSHOT_DIGESTS = {
    "2016-mandi.csv": "c531b53988127b141d98d92a19d19b30dc33bf7205a635ca1a217df7b9a35476",
    "2017-mandi.csv": "281228d04da793356825dd2fe610346391c8c3aa99d2bb0498801257ff9535e2",
    "2018-mandi.csv": "4cb606ef9923daf51ba5adf61032c3ca8c10ae05cf2a4526e678f06cec6a3eaa",
    "2019-mandi.csv": "c7c981efdeb85754abcda769591e46349f1b0a4d98463c2841664c5760f716e6",
    "2020-mandi.csv": "f748d89703c3eaff02985684f6df27891be406f8094207f85113d04b2f1e4018",
    "2021-mandi.csv": "32709b6652f18b4e86c0de1a8523a640c3b7fef8a0954c1d7a972a3a3f492c35",
    "2022-mandi.csv": "bca75203f780a71d0cf06cf8ea1b36c774ecc75a914c49dd00d5815f6c172126",
    "2023-mandi.csv": "7f5a6ee607afe9731de0412862bd6e6dfe30079eacba3928432e2580136b95e1",
    "2024-mandi.csv": "59794b7a4dad2fa5e3f1a116851b584368ca99ce44a9fe90b2638e8a5faf7a60",
    "2025-mandi.csv": "0070d5c0fd8f95a2268420eaa3f9b712f74bbb179e8c09025c4f32d4999bb45a",
    "2026-mandi.csv": "881de61a36fbcd00cc992f0f98abf67e980a0011daea255383a596305f875da5",
}
CROPS = {
    "Wheat": ("wheat", "小麦"),
    "Maize": ("maize", "玉米"),
    "Rice": ("rice", "大米"),
    "Paddy (Dhan)(Common)": ("paddy", "稻谷"),
    "Soyabean": ("soybean", "大豆"),
    "Mustard": ("mustard", "芥菜籽"),
    "Cotton": ("cotton", "棉花"),
    "Groundnut": ("groundnut", "花生"),
    "Sugar": ("sugar", "糖"),
    "Jute": ("jute", "黄麻"),
    "Coffee": ("coffee", "咖啡"),
    "Barley (Jau)": ("barley", "大麦"),
    "Turmeric": ("turmeric", "姜黄"),
    "Black Gram (Urd Beans)(Whole)": ("black-gram", "黑绿豆"),
    "Bengal Gram (Gram)(Whole)": ("chickpea", "鹰嘴豆"),
    "Arhar (Tur/Red Gram)(Whole)": ("pigeon-pea", "木豆"),
    "Green Gram (Moong)(Whole)": ("mung-bean", "绿豆"),
    "Onion": ("onion", "洋葱"),
    "Potato": ("potato", "马铃薯"),
    "Tomato": ("tomato", "番茄"),
}


def store(path, data):
    raw = (
        json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        + "\n"
    ).encode()
    if not path.exists() or path.read_bytes() != raw:
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(path)
    return hashlib.sha256(raw).hexdigest()


def make_shard(dest, key, month, quotes):
    venues = {}
    rows = []
    for day, location, modal, low, high in quotes:
        idx = venues.setdefault(location, len(venues))
        rows.append([day, idx, modal, low, high])
    digest = store(
        dest / f"{key}-{month}.json",
        {"id": key, "month": month, "locations": list(venues), "rows": rows},
    )
    return {
        "month": month,
        "count": len(rows),
        "start": f"{month}-{rows[0][0]:02}",
        "end": f"{month}-{rows[-1][0]:02}",
        "sha256": digest,
    }


def save_index(dest, name, shards):
    slug, zh = CROPS[name]
    key = "mandi-" + slug
    shards = sorted(shards, key=lambda r: r["month"])
    digest = store(dest / (key + ".json"), {"id": key, "shards": shards})
    return {
        "id": key,
        "group": "commodity",
        "zh": "印度现货 · " + zh,
        "en": "India wholesale · " + name,
        "unit": "INR / 100 kg",
        "source": "AGMARKNET · Directorate of Marketing & Inspection, India",
        "sourceUrl": SOURCE,
        "license": "Government Open Data License – India",
        "licenseUrl": LICENSE,
        "archiveUrl": SNAPSHOT,
        "statistic": "wholesaleRange",
        "start": shards[0]["start"],
        "end": shards[-1]["end"],
        "count": sum(s["count"] for s in shards),
        "sha256": digest,
        "shards": shards,
    }


def price(x):
    return int(x) if x.is_integer() else x


def bootstrap(files, dest, until):
    import duckdb

    dest.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as temp:
        db = duckdb.connect(str(Path(temp) / "quotes.db"))
        db.execute("SET threads=4")
        db.execute("SET memory_limit='3GB'")
        db.execute(
            """CREATE TABLE quotes AS SELECT trim(commodity) AS crop, try_cast(Arrival_Date AS DATE) AS day,
            trim(state) AS state,trim(district) AS district,trim(market) AS venue,trim(variety) AS variety,trim(grade) AS grade,
            try_cast(Min_Price AS DOUBLE) AS lo,try_cast(Max_Price AS DOUBLE) AS hi,try_cast(Modal_Price AS DOUBLE) AS modal
            FROM read_csv(?,header=true,all_varchar=true,strict_mode=false) WHERE trim(Commodity) IN (SELECT unnest(?))""",
            [list(map(str, files)), list(CROPS)],
        )
        scope = "day BETWEEN DATE '2016-01-01' AND ?"
        ok = """coalesce(state<>'' and district<>'' and venue<>'' and variety<>'' and grade<>''
              and isfinite(lo) and isfinite(hi) and isfinite(modal) and lo>0 and modal between lo and hi,false)"""
        # Keep disputed reports out even when just one conflicting source row is invalid.
        unique = f"""SELECT day,state,district,venue,variety,grade,min(modal) AS p,min(lo) AS l,min(hi) AS h,
            count(*) AS n, bool_and({ok}) AS usable, min(lo)=max(lo) and min(hi)=max(hi) and min(modal)=max(modal) AS agreed
            FROM quotes WHERE crop=? and {scope} GROUP BY ALL"""
        result = []
        audit = {}
        for name, (slug, _) in CROPS.items():
            key = "mandi-" + slug
            db.execute("CREATE OR REPLACE TEMP TABLE crop AS " + unique, [name, until])
            stats = db.execute("""SELECT sum(n),count(*) filter(where not usable),count(*) filter(where usable and not agreed),
                 coalesce(sum(n-1) filter(where usable and agreed),0),count(*) filter(where usable and agreed) FROM crop""").fetchone()
            cursor = db.execute("""SELECT strftime(day,'%Y-%m'),dayofmonth(day),state,district,venue,variety,grade,p,l,h
                    FROM crop WHERE usable and agreed ORDER BY day,state,district,venue,variety,grade""")
            month = None
            quotes = []
            shards = []
            while batch := cursor.fetchmany(12000):
                for m, d, s, ds, v, kind, g, p, l, h in batch:
                    if m != month:
                        if quotes:
                            shards.append(make_shard(dest, key, month, quotes))
                        month, quotes = m, []
                    quotes.append(
                        (d, (s, ds, v, kind, g), price(p), price(l), price(h))
                    )
            if quotes:
                shards.append(make_shard(dest, key, month, quotes))
            if not shards:
                raise ValueError("Missing commodity: " + name)
            item = save_index(dest, name, shards)
            assert item["count"] == stats[-1]
            result.append(item)
            audit[key] = dict(
                zip(
                    (
                        "sourceRows",
                        "invalidKeys",
                        "conflictingKeys",
                        "duplicatesRemoved",
                        "observations",
                    ),
                    stats,
                )
            )
            print(key, item["count"], item["end"], flush=True)
        store(dest / "catalog.json", {"version": 1, "series": result})
        db.close()
        return audit


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--csv-dir",
        type=Path,
        required=True,
        help="Extracted original AGMARKNET snapshot v134 YYYY-mandi.csv files",
    )
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--until", type=date.fromisoformat, required=True)
    p.add_argument("--audit", type=Path, required=True)
    args = p.parse_args()
    files = [
        args.csv_dir / f"{y}-mandi.csv"
        for y in range(2016, min(args.until.year, 2026) + 1)
    ]
    if (args.root / "catalog.json").exists():
        p.error(
            "Build the frozen snapshot in a fresh staging directory to preserve newer market reports"
        )
    checksums = {}
    for path in files:
        with path.open("rb") as f:
            checksums[path.name] = hashlib.file_digest(f, "sha256").hexdigest()
        if checksums[path.name] != SNAPSHOT_DIGESTS[path.name]:
            raise ValueError("Input differs from pinned v134: " + path.name)
    audit = bootstrap(files, args.root, args.until)
    store(args.audit, {"snapshot": SNAPSHOT, "files": checksums, "series": audit})
