"""Archive directly published daily reference rates, metal accounts, wholesale estimates and TAIEX OHLC."""

import argparse
import csv
import hashlib
import io
import json
import re
import time
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import requests
from brain_tradfi import START, months, number, save
from brain_tradfi_bank_gold import quotes as bank_gold_quotes

ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip"
ECB_PAGE = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"
ECB_LICENSE = "https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html"
NBU = "https://bank.gov.ua/NBU_Exchange/exchange_site"
NBU_PAGE = "https://bank.gov.ua/en/open-data/api-dev"
NBU_LICENSE = "https://bank.gov.ua/en/open-data"
USDA = "https://mpr.datamart.ams.usda.gov/services/v1.1/reports/"
USDA_LICENSE = "https://mpr.datamart.ams.usda.gov/menu.htm"
TWSE = "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST"
TAIEX_PAGE = "https://data.gov.tw/dataset/11755"
FX = [
    "CZK",
    "DKK",
    "HUF",
    "PLN",
    "RON",
    "SEK",
    "CHF",
    "ISK",
    "NOK",
    "TRY",
    "AUD",
    "BRL",
    "CAD",
    "CNY",
    "HKD",
    "IDR",
    "ILS",
    "INR",
    "KRW",
    "MXN",
    "MYR",
    "NZD",
    "PHP",
    "SGD",
    "THB",
    "ZAR",
]
METALS = {
    "XAU": (959, "gold", "黄金"),
    "XAG": (961, "silver", "白银"),
    "XPT": (962, "platinum", "铂金"),
    "XPD": (964, "palladium", "钯金"),
}
BEEF = {
    "choice_600_900_current": ("beef-choice", "Choice beef carcass", "特选级牛胴体"),
    "select_600_900_current": ("beef-select", "Select beef carcass", "精选级牛胴体"),
}
PORK = {
    key: (key.replace("_", "-"), en, zh)
    for key, en, zh in [
        ("pork_carcass", "Pork carcass", "猪胴体"),
        ("pork_loin", "Pork loin", "猪里脊"),
        ("pork_butt", "Pork shoulder butt", "猪上肩肉"),
        ("pork_picnic", "Pork picnic shoulder", "猪下肩肉"),
        ("pork_rib", "Pork rib", "猪肋排"),
        ("pork_ham", "Pork ham", "猪后腿"),
        ("pork_belly", "Pork belly", "猪腹肉"),
    ]
}
REPORTS = [
    ("2453", "Current Cutout Values", "LM_XB403", BEEF),
    ("2498", "Cutout and Primal Values", "LM_PK602", PORK),
]


def load(url, params=None):
    if url == TWSE:
        time.sleep(3.15)
    with requests.get(url, params=params, timeout=(8, 30)) as response:
        response.raise_for_status()
        return response.content


def metadata(
    key,
    group,
    zh,
    en,
    unit,
    statistic,
    source,
    source_url,
    license_name,
    license_url,
    coverage,
):
    return {
        "id": key,
        "group": group,
        "zh": zh,
        "en": en,
        "unit": unit,
        "statistic": statistic,
        "frequency": "daily",
        "source": source,
        "sourceUrl": source_url,
        "license": license_name,
        "licenseUrl": license_url,
        "fields": ["date", "value"],
        "coverage": coverage,
    }


def ecb_quotes(until, load):
    with (
        ZipFile(io.BytesIO(load(ECB))) as archive,
        archive.open("eurofxref-hist.csv") as source,
    ):
        reader = csv.DictReader(io.TextIOWrapper(source, encoding="utf-8-sig"))
        if not {"Date", *FX}.issubset(reader.fieldnames or []):
            raise ValueError("Missing ECB euro reference series")
        quotes = {code: [] for code in FX}
        for row in reader:
            day = date.fromisoformat(row["Date"])
            if START <= day <= until:
                for code in FX:
                    if row[code] not in ("", "N/A"):
                        rate = number(row[code])
                        if rate <= 0:
                            raise ValueError(
                                "Nonpositive ECB reference rate for " + code
                            )
                        quotes[code].append([day.isoformat(), rate])
    for code, rows in quotes.items():
        if rows:
            yield (
                metadata(
                    "eur" + code.lower(),
                    "fx",
                    "欧元 / " + code,
                    "EUR / " + code,
                    code + "/EUR",
                    "reference",
                    "ECB statistics",
                    ECB_PAGE,
                    "ESCB free reuse with attribution",
                    ECB_LICENSE,
                    "Publisher reference dates only. Historical gaps and unavailable rates are left empty.",
                ),
                sorted(rows),
            )


def nbu_metals(until, load):
    for code, (numeric_code, en, zh) in METALS.items():
        args = {
            "start": "20151201",
            "end": until.strftime("%Y%m%d"),
            "valcode": code.lower(),
            "sort": "exchangedate",
            "order": "asc",
            "json": "",
        }
        raw = json.loads(load(NBU, args))
        rows, previous_day, last_calc, last_price = [], None, None, None
        for item in raw:
            if (
                item["cc"] != code
                or item["r030"] != numeric_code
                or item["group"] != "3"
            ):
                raise ValueError("Unexpected NBU metal identity")
            day = datetime.strptime(item["exchangedate"], "%d.%m.%Y").date()
            if previous_day is not None and day <= previous_day:
                raise ValueError("Unordered NBU effective dates")
            previous_day = day
            calc = (item["calcdate"] or "").strip()
            calc = datetime.strptime(calc, "%d.%m.%Y").date() if calc else None
            units = item["units"]
            price = Decimal(str(item["rate_per_unit"]))
            if (
                units not in (1, 10)
                or price <= 0
                or price * units != Decimal(str(item["rate"]))
            ):
                raise ValueError("Inconsistent NBU price per troy ounce")
            if calc and (calc > day or (last_calc and calc < last_calc)):
                raise ValueError("Invalid NBU calculation date")
            if calc and calc == last_calc and price != last_price:
                raise ValueError("Conflicting NBU effective prices for one calculation")
            fresh = calc != last_calc if calc else price != last_price
            if fresh and START <= day <= until:
                rows.append([day.isoformat(), float(price)])
            last_calc, last_price = calc, price
        detail = metadata(
            "nbu-" + en + "-uah",
            "metals",
            "乌克兰央行" + zh + "记账价",
            "NBU " + en + " accounting price",
            "UAH/troy oz",
            "accountingPrice",
            "National Bank of Ukraine",
            NBU_PAGE,
            "NBU open data, attribution required",
            NBU_LICENSE,
            "First effective date per published calculation. Before calculation dates were provided, only effective-date price changes are retained. Official per-ounce value, including historical 10-ounce quotations.",
        )
        detail["methodologyUrl"] = (
            "https://bank.gov.ua/admin_uploads/article/Instr_API_KURS_VAL_data_Full_eng.pdf"
        )
        if rows:
            detail["observationUrl"] = (
                NBU
                + "?start=20160101&end="
                + rows[-1][0].replace("-", "")
                + "&valcode="
                + code.lower()
                + "&sort=exchangedate&order=asc&json"
            )
        yield detail, rows


def usda_reports(until, load, meta):
    for slug, section, symbol, columns in REPORTS:
        present = [
            meta.get("usda-" + key, {}).get("end") for key, _, _ in columns.values()
        ]
        year = (
            min(date.fromisoformat(day).year for day in present)
            if all(present)
            else START.year
        )
        observations = {field: {} for field in columns}
        for yr in range(year, until.year + 1):
            first, last = date(yr, 1, 1), min(until, date(yr, 12, 31))
            query = {"q": f"report_date={first:%m/%d/%Y}:{last:%m/%d/%Y}"}
            body = json.loads(load(USDA + slug + "/" + section, query))
            records, stats = body["results"], body["stats"]
            if (
                body["reportSection"] != section
                or stats["totalRows:"] != len(records)
                or stats["returnedRows:"] != len(records)
            ):
                raise ValueError("Wrong or truncated USDA report " + slug)
            for row in records:
                if row["slug_id"] != slug or symbol not in row["report_title"]:
                    raise ValueError("Unexpected USDA report identity")
                day = datetime.strptime(row["report_date"], "%m/%d/%Y").date()
                if not first <= day <= last:
                    raise ValueError("USDA report date outside requested range")
                for field in columns:
                    if row[field] in (None, "", "N/A"):
                        continue
                    value = number(row[field])
                    if value <= 0 or day in observations[field]:
                        raise ValueError("Invalid or duplicate USDA cutout")
                    observations[field][day] = value
        for field, (key, en, zh) in columns.items():
            details = metadata(
                "usda-" + key,
                "commodities",
                "美国农业部 · " + zh + "估值",
                en + " cutout · USDA",
                "USD/cwt",
                "wholesaleCutout",
                "USDA AMS Market News · " + symbol,
                "https://mymarketnews.ams.usda.gov/viewReport/" + slug,
                "USDA AMS permits republication of original values",
                USDA_LICENSE,
                "Afternoon negotiated sale report. USD per 100 pounds. Only dates with a published cutout or primal value are included.",
            )
            details.update(reportSection=section, sourceField=field)
            yield (
                details,
                [
                    [day.isoformat(), v]
                    for day, v in sorted(observations[field].items())
                ],
            )


def taiex_bars(until, load, previous):
    old = {r[0]: r for r in previous}
    complete = {day[:7] for day, r in old.items() if len(r) == 5} - {
        day[:7] for day, r in old.items() if len(r) != 5
    }
    last_archived = date.fromisoformat(max(old)).replace(day=1) if old else START
    for month in months(START, until):
        if month.strftime("%Y-%m") in complete and month < min(
            until.replace(day=1), last_archived
        ):
            continue
        response = load(
            TWSE, {"response": "open_data", "date": month.strftime("%Y%m%d")}
        )
        reader = csv.DictReader(io.StringIO(response.decode("utf-8-sig")))
        if reader.fieldnames != [
            "日期",
            "開盤指數",
            "最高指數",
            "最低指數",
            "收盤指數",
        ]:
            raise ValueError("Unexpected TAIEX OHLC header for " + str(month))
        days = set()
        for r in reader:
            roc = r["日期"]
            if not re.fullmatch(r"\d{7}", roc):
                raise ValueError("Invalid TAIEX trading date")
            day = date(int(roc[:3]) + 1911, int(roc[3:5]), int(roc[5:]))
            if day.replace(day=1) != month or day in days:
                raise ValueError("Unexpected or duplicate TAIEX trading day")
            days.add(day)
            op, hi, lo, cl = [number(r[name]) for name in reader.fieldnames[1:]]
            if not (0 < lo <= min(op, cl) <= max(op, cl) <= hi):
                raise ValueError("Inconsistent TAIEX OHLC")
            if day <= until:
                old[day.isoformat()] = [day.isoformat(), cl, op, hi, lo]
        if not days and month != until.replace(day=1):
            raise ValueError("Empty TAIEX report for " + str(month))
    details = metadata(
        "taiex",
        "index",
        "台湾加权指数",
        "TAIEX",
        "points",
        "index",
        "Taiwan Stock Exchange",
        TAIEX_PAGE,
        "Taiwan Open Government Data License 1.0",
        "https://data.gov.tw/license",
        "Exchange trading dates. OHLC index points as published by TWSE. Dates without an exchange observation are excluded.",
    )
    details["fields"] = ["date", "close", "open", "high", "low"]
    if any(len(row) != 5 for row in old.values()):
        raise ValueError("TAIEX OHLC upgrade incomplete for previously archived dates")
    # The catalog can already contain a later completed session in exchange time.
    yield details, sorted(row for day, row in old.items() if day <= until.isoformat())


def build(dest, until, load=load, sources=None):
    dest = Path(dest)
    path = dest / "catalog.json"
    catalog = (
        json.loads(path.read_bytes()) if path.exists() else {"version": 1, "series": []}
    )
    meta = {entry["id"]: entry for entry in catalog["series"]}
    source_names = sources if sources is not None else ["ecb", "nbu", "usda", "taiex", "bank-gold"]
    errors = []
    for provider in source_names:
        try:
            if provider == "ecb":
                outputs = ecb_quotes(until, load)
            elif provider == "nbu":
                outputs = nbu_metals(until, load)
            elif provider == "bank-gold":
                outputs = bank_gold_quotes(until, load)
            elif provider == "usda":
                outputs = usda_reports(until, load, meta)
            elif provider == "taiex":
                prior = dest / "taiex.json"
                outputs = taiex_bars(
                    until,
                    load,
                    json.loads(prior.read_bytes())["rows"] if prior.is_file() else [],
                )
            else:
                raise ValueError("Unknown daily provider " + provider)
            for entry, rows in outputs:
                key = entry["id"]
                target = dest / (key + ".json")
                old = json.loads(target.read_bytes())["rows"] if target.exists() else []
                history = {r[0]: r for r in old}
                previous = None
                for r in rows:
                    day = date.fromisoformat(r[0])
                    if not START <= day <= until or (previous and previous >= day):
                        raise ValueError("Invalid ordered report dates for " + key)
                    previous = day
                    history[r[0]] = r
                final = sorted(history.values())
                if not final:
                    raise ValueError("Empty observation series " + key)
                if provider == "nbu":
                    entry["observationUrl"] = re.sub(
                        r"(?<=&end=)\d{8}", final[-1][0].replace("-", ""), entry["observationUrl"]
                    )
                save(target, {"id": key, "rows": final})
                entry.update(
                    start=final[0][0],
                    end=final[-1][0],
                    count=len(final),
                    sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                )
                meta[key] = entry
        except (
            OSError,
            ValueError,
            ArithmeticError,
            KeyError,
            BadZipFile,
            csv.Error,
        ) as error:
            errors.append(provider + ": " + str(error))
    save(path, {**catalog, "series": list(meta.values())})
    if errors:
        raise RuntimeError("; ".join(errors))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dest", type=Path)
    parser.add_argument("--until", type=date.fromisoformat, required=True)
    args = parser.parse_args()
    build(args.dest, args.until)
