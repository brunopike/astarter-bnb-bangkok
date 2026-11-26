"""Original Berkshire 13F period-end reported value per common share, on the filing date."""

import calendar
import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from brain_tradfi import get, save

CIK = "0001067983"
SUBMISSIONS = "https://data.sec.gov/submissions/"
ARCHIVES = "https://www.sec.gov/Archives/edgar/data/1067983/"
FIRST = "2016-03-31"
UNIT_CHANGE = "2023-01-03"
UNIT_SOURCE = "https://www.sec.gov/files/form_13f_readme.pdf"
EDITION = "berkshire-original-13f-v1"
# ticker, issuer name prefix, Chinese display name, English display name
SECURITIES = {
    "037833100": ("aapl", "APPLE", "苹果", "Apple"),
    "025816109": ("axp", "AMERICANEXPRESS", "美国运通", "American Express"),
    "191216100": ("ko", "COCACOLA", "可口可乐", "Coca-Cola"),
}
HEADERS = {"User-Agent": "Astarter financial research (https://dapp.ipfund.art)"}


def fetch(url):
    time.sleep(0.65)
    return get(url, headers=HEADERS).content


def quarterly_filings(until, load):
    index = json.loads(load(SUBMISSIONS + "CIK" + CIK + ".json"))
    if int(index["cik"]) != int(CIK) or "BERKSHIRE HATHAWAY" not in index["name"].upper():
        raise ValueError("Invalid SEC filer identity")
    pages = [index["filings"]["recent"]]
    for item in index["filings"]["files"]:
        if FIRST <= item["filingTo"] and item["filingFrom"] <= until.isoformat():
            name = item["name"]
            if not re.fullmatch(r"CIK0001067983-submissions-\d+\.json", name):
                raise ValueError("Unexpected historical submissions file")
            pages.append(json.loads(load(SUBMISSIONS + name)))
    periods = {}
    for page in pages:
        for form, period, filed, accession in zip(
            page["form"], page["reportDate"], page["filingDate"], page["accessionNumber"], strict=True
        ):
            if form != "13F-HR" or period < FIRST or filed > until.isoformat():
                continue
            if not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession) or period >= filed:
                raise ValueError("Invalid original 13F accession or period")
            item = (filed, accession)
            if period in periods and periods[period] != item:
                raise ValueError("Multiple original filings for one quarter")
            periods[period] = item
    expected = date.fromisoformat(FIRST)
    for period in sorted(periods):
        if period != expected.isoformat():
            raise ValueError("Missing Berkshire quarterly filing: " + expected.isoformat())
        year, month = expected.year, expected.month + 3
        if month > 12:
            year, month = year + 1, 3
        expected = date(year, month, calendar.monthrange(year, month)[1])
    if not periods:
        raise ValueError("No original Berkshire filings in the requested range")
    return [(period, *periods[period]) for period in sorted(periods)]


def whole(text):
    if not text or not re.fullmatch(r"[0-9]+", text):
        raise ValueError("Invalid unsigned integer in SEC filing")
    return int(text)


def text(root, name):
    return (root.findtext(".//{*}" + name) or "").strip()


def ratio(raw_value, multiplier, shares):
    if raw_value <= 0 or shares <= 0:
        raise ValueError("Missing positive reported value or number of shares")
    value = Decimal(raw_value * multiplier) / Decimal(shares)
    return float(value.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def original_table(period, filed, accession, raw):
    identity = re.search(rb"<SEC-DOCUMENT>([^.\r\n]+)\.txt", raw)
    acceptance = re.search(rb"FILED AS OF DATE:\s*(\d{8})", raw)
    if (
        not identity
        or identity[1].decode() != accession
        or not acceptance
        or acceptance[1].decode() != filed.replace("-", "")
    ):
        raise ValueError("SEC document identity or filing date differs from submissions index")
    parts = {}
    for document in re.findall(rb"<DOCUMENT>(.*?)</DOCUMENT>", raw, re.DOTALL):
        kind = re.search(rb"<TYPE>([^\r\n]+)", document)
        if not kind or kind[1].strip() not in (b"13F-HR", b"INFORMATION TABLE"):
            continue
        name = re.search(rb"<FILENAME>([^\r\n]+)", document)
        xml = re.search(rb"<XML>\s*(.*?)\s*</XML>", document, re.DOTALL)
        if kind[1] in parts or not name or not xml:
            raise ValueError("Missing or duplicate 13F attachment")
        filename = name[1].strip().decode()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.xml", filename, re.IGNORECASE):
            raise ValueError("Invalid SEC attachment filename")
        parts[kind[1]] = filename, ET.fromstring(xml[1])
    if set(parts) != {b"13F-HR", b"INFORMATION TABLE"}:
        raise ValueError("Incomplete original SEC 13F filing")
    cover = parts[b"13F-HR"][1]
    filename, table = parts[b"INFORMATION TABLE"]
    if (
        whole(text(cover, "cik")) != int(CIK)
        or datetime.strptime(text(cover, "reportCalendarOrQuarter"), "%m-%d-%Y").date().isoformat()
        != period
    ):
        raise ValueError("Original filing manager or report period differs")
    rows = table.findall(".//{*}infoTable")
    if len(rows) != whole(text(cover, "tableEntryTotal")) or sum(
        whole(text(r, "value")) for r in rows
    ) != whole(text(cover, "tableValueTotal")):
        raise ValueError("Information table does not reconcile to its cover page")
    sums = {}
    for item in rows:
        cusip = text(item, "cusip")
        if cusip not in SECURITIES or text(item, "putCall"):
            continue
        issuer = re.sub(r"[^A-Z]", "", text(item, "nameOfIssuer").upper())
        if (
            not issuer.startswith(SECURITIES[cusip][1])
            or text(item, "sshPrnamtType") != "SH"
            or text(item, "titleOfClass").upper() not in {"COM", "COMMON", "COMMON STOCK"}
        ):
            raise ValueError("Unexpected issuer or share class for " + cusip)
        value, shares = sums.get(cusip, (0, 0))
        sums[cusip] = value + whole(text(item, "value")), shares + whole(text(item, "sshPrnamt"))
    multiple = 1000 if filed < UNIT_CHANGE else 1
    source = ARCHIVES + accession.replace("-", "") + "/" + filename
    return {
        cusip: [
            filed,
            ratio(value, multiple, shares),
            period,
            value,
            multiple,
            shares,
            accession,
            source,
        ]
        for cusip, (value, shares) in sums.items()
    }


def build(dest: Path, until: date, load=fetch):
    dest = Path(dest)
    catalog_path = dest / "catalog.json"
    catalog = (
        json.loads(catalog_path.read_bytes())
        if catalog_path.is_file()
        else {"version": 1, "series": []}
    )
    metadata = {d["id"]: d for d in catalog["series"]}
    existing = {}
    not_disclosed = {}
    for cusip, (ticker, _, _, _) in SECURITIES.items():
        key = ticker + "-13f-value"
        entry = metadata.get(key, {})
        path = dest / (key + ".json")
        not_disclosed[cusip] = (
            dict(entry.get("notDisclosed", {})) if entry.get("edition") == EDITION else {}
        )
        if entry.get("edition") == EDITION:
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                raise ValueError("Changed previous 13F series " + key)
            existing[cusip] = {r[6]: r for r in json.loads(raw)["rows"]}
        else:
            existing[cusip] = {}
    periods = quarterly_filings(until, load)
    for period, filed, accession in periods:
        if all(
            (
                accession in history
                and history[accession][0] == filed
                and history[accession][2] == period
            )
            or not_disclosed[cusip].get(accession) == [period, filed]
            for cusip, history in existing.items()
        ):
            continue
        url = ARCHIVES + accession.replace("-", "") + "/" + accession + ".txt"
        table = original_table(period, filed, accession, load(url))
        for cusip, history in existing.items():
            if cusip in table:
                history[accession] = table[cusip]
                not_disclosed[cusip].pop(accession, None)
            else:
                # Only a reconciled, complete original filing can establish this absence.
                not_disclosed[cusip][accession] = [period, filed]
    for cusip, (ticker, _, zh, en) in SECURITIES.items():
        key = ticker + "-13f-value"
        rows = sorted(existing[cusip].values())
        if not rows:
            continue
        path = dest / (key + ".json")
        save(path, {"id": key, "rows": rows})
        metadata[key] = {
            "id": key,
            "group": "stock",
            "statistic": "reportedValuePerShare",
            "edition": EDITION,
            "zh": zh + " · 期末申报估值/股",
            "en": en + " · reported quarter-end value per share",
            "unit": "USD/share",
            "frequency": "quarterly",
            "dateBasis": "filingDate",
            "source": "SEC EDGAR · Berkshire Hathaway 13F-HR",
            "sourceUrl": SUBMISSIONS + "CIK" + CIK + ".json",
            "unitSourceUrl": UNIT_SOURCE,
            "filerCik": CIK,
            "cusip": cusip,
            "symbol": ticker.upper(),
            "method": "Aggregate reported value times its filing-unit multiplier divided by reported common shares. Original filings, as reported and unadjusted for splits.",
            "fields": [
                "filingDate",
                "valuePerShareUSD",
                "quarterEnd",
                "reportedValueRaw",
                "valueMultiplierUSD",
                "shares",
                "accession",
                "informationTableURL",
            ],
            "start": rows[0][0],
            "end": rows[-1][0],
            "count": len(rows),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        if not_disclosed[cusip]:
            metadata[key]["notDisclosed"] = not_disclosed[cusip]
    save(catalog_path, {**catalog, "series": list(metadata.values())})
