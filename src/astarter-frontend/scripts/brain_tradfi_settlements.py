"""SEC settlement disclosures for identified US listed shares, as published."""
import argparse
from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
from zipfile import ZipFile

from brain_tradfi import get, save

SOURCE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data"
RIGHTS = "https://www.sec.gov/about/privacy-information#dissemination"
def source_file(period):
    collection = "frequently-requested-foia-document-fails-deliver-data" if period < "201706b" else "fails-deliver-data"
    return f"https://www.sec.gov/files/data/{collection}/cnsfails{period}.zip"

FIRST = date(2016, 1, 1)
USER_AGENT = {"User-Agent": "Astarter public financial research (https://dapp.ipfund.art)"}
# Match both the security identifier and the reported ticker. A reused ticker is a different instrument.
SECURITIES = {
    "AAPL": "037833100", "MSFT": "594918104", "NVDA": "67066G104", "AMZN": "023135106",
    "GOOGL": "02079K305", "GOOG": "02079K107", "META": "30303M102", "TSLA": "88160R101",
    "IBM": "459200101", "ORCL": "68389X105", "INTC": "458140100", "AMD": "007903107",
    "AVGO": "11135F101", "QCOM": "747525103", "TXN": "882508104", "CSCO": "17275R102",
    "AMAT": "038222105", "MU": "595112103", "CRM": "79466L302", "ADBE": "00724F101",
    "NFLX": "64110L106", "DIS": "254687106", "NKE": "654106103", "COST": "22160K105",
    "WMT": "931142103", "HD": "437076102", "MCD": "580135101", "SBUX": "855244109",
    "KO": "191216100", "PEP": "713448108", "PG": "742718109", "UNH": "91324P102",
    "JNJ": "478160104", "ABBV": "00287Y109", "MRK": "58933Y105", "PFE": "717081103",
    "LLY": "532457108", "JPM": "46625H100", "BAC": "060505104", "GS": "38141G104",
    "MS": "617446448", "BLK": "09290D101", "V": "92826C839", "MA": "57636Q104",
    "AXP": "025816109", "CAT": "149123101", "DE": "244199105", "BA": "097023105",
    "GE": "369604301", "RTX": "75513E101", "HON": "438516205", "UPS": "911312106",
    "UNP": "907818108", "XOM": "30233Q108", "CVX": "166764100", "COP": "20825C104",
    "SLB": "806857108", "NEM": "651639106", "FCX": "35671D857", "AA": "013872106",
    "NUE": "670346105", "F": "345370860", "GM": "37045V100", "T": "00206R102",
    "VZ": "92343V104", "DUK": "26441C204", "SO": "842587107", "NEE": "65339F101",
    "AMT": "03027X100", "C": "172967424", "AMGN": "031162100", "PANW": "697435105",
    "PLTR": "69608A108", "SPGI": "78409V104", "BKNG": "09857L108", "LOW": "548661107",
    "TGT": "87612E106", "CL": "194162103", "LMT": "539830109", "ADP": "053015103",
    "ABT": "002824100", "WFC": "949746101", "SCHW": "808513105", "TMO": "883556102",
    "ISRG": "46120E602", "APD": "009158106", "BMY": "110122108",
}
FILE_LINK = re.compile(r'href=["\'](/files/(?:[\w-]+/)+cnsfails(\d{6}[ab])(?:_\d+)?\.zip)["\']', re.I)
HEADER = 'SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE'


def official(url):
    return get(url, headers=USER_AGENT).content


def releases(index, until):
    indexed = {}
    for path, period in FILE_LINK.findall(index.decode('utf-8')):
        url = 'https://www.sec.gov' + path
        if indexed.setdefault(period, url) != url:
            raise ValueError('Conflicting SEC links for ' + period)
    required = []
    for year in range(FIRST.year, until.year + 1):
        for month in range(1, 13):
            for half, end in [('a', 14), ('b', monthrange(year, month)[1])]:
                if date(year, month, end) <= until:
                    required.append(f'{year:04}{month:02}{half}')
    published = [p for p in required if p in indexed]
    if not published or published != required[:len(published)]:
        raise ValueError('Gap in published SEC half-month series')
    latest = published[-1]
    y, m = int(latest[:4]), int(latest[4:6])
    last = date(y, m, 14 if latest[-1] == 'a' else monthrange(y, m)[1])
    if until - last > timedelta(days=40):
        raise ValueError('SEC disclosure index is out of date')
    return {p: indexed[p] for p in published}


def read_release(raw, period):
    with ZipFile(BytesIO(raw)) as archive:
        files = [i for i in archive.infolist() if not i.is_dir()]
        if len(files) != 1 or files[0].file_size > 96_000_000:
            raise ValueError('Unexpected SEC archive contents: ' + period)
        lines = archive.read(files[0]).decode('latin1').splitlines()
    if not lines or lines[0].strip() != HEADER:
        raise ValueError('Unknown SEC disclosure format: ' + period)
    count = shares = 0
    declared = {}
    selected = {}
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        if line.startswith('Trailer '):
            label, value = line.rsplit(' ', 1)
            declared[label.strip()] = int(value)
            continue
        day, security, ticker, quantity, rest = line.split('|', 4)
        if not re.fullmatch(period[:6] + r'\d\d', day):
            raise ValueError('Settlement date outside source month: ' + period)
        n = int(quantity)
        count += 1
        shares += n
        ticker = 'META' if ticker == 'FB' else ticker
        if SECURITIES.get(ticker) != security:
            continue
        price = rest.rsplit('|', 1)[1].strip()
        if price in {'.', ''} or n <= 0:
            continue
        value = Decimal(price)
        if not value.is_finite() or value <= 0:
            continue
        when = date.fromisoformat(day).isoformat()
        key = ticker, when
        if key in selected:
            raise ValueError('Duplicate listed security and settlement date: ' + str(key))
        selected[key] = [when, float(value), n, period]
    if declared.get('Trailer record count') != count or declared.get('Trailer total quantity of shares') != shares:
        raise ValueError('SEC file totals do not reconcile: ' + period)
    return selected


def build(dest, until, cache=None):
    dest = Path(dest)
    dest.mkdir(exist_ok=True, parents=True)
    path = dest / 'catalog.json'
    items = {s['id']: s for s in json.loads(path.read_bytes())['series']} if path.exists() else {}
    urls = releases((cache / 'index.html').read_bytes() if cache else official(SOURCE), until)
    periods = list(urls)
    prior = {symbol: items.get('sec-settlement-' + symbol.lower()) for symbol in SECURITIES}
    latest = min((s.get('latestRelease', '') if s else '') for s in prior.values())
    if latest and latest > periods[-1]:
        raise ValueError('Archive is newer than the requested SEC reporting period')
    first = max(0, periods.index(latest) - 2) if latest in periods else 0
    fresh = set(periods[first:])
    data = {symbol: {} for symbol in SECURITIES}
    for symbol, item in prior.items():
        if item:
            previous = (dest / (item['id'] + '.json')).read_bytes()
            if sha256(previous).hexdigest() != item['sha256']:
                raise ValueError('Prior settlement file checksum mismatch')
            data[symbol] = {r[0]: r for r in json.loads(previous)['rows'] if r[3] not in fresh}
    for period in sorted(fresh):
        raw = (cache / (period + '.zip')).read_bytes() if cache else official(urls[period])
        for (symbol, day), row in read_release(raw, period).items():
            if day in data[symbol] and data[symbol][day] != row:
                raise ValueError('Conflicting SEC settlements: ' + symbol + ' ' + day)
            data[symbol][day] = row
    for symbol, report in data.items():
        if not report:
            continue
        key = 'sec-settlement-' + symbol.lower()
        rows = sorted(report.values())
        file = dest / (key + '.json')
        save(file, {'id': key, 'rows': rows})
        items[key] = {
            'id': key, 'group': 'stock', 'ticker': symbol, 'unit': 'USD/share',
            'statistic': 'settlementReference', 'frequency': 'daily', 'dateBasis': 'settlementDate',
            'en': symbol + ' · SEC settlement disclosure', 'zh': symbol + ' · SEC 交收披露',
            'fields': ['settlementDate', 'previousCloseUSD', 'undeliveredShares', 'release'],
            'source': 'SEC · NSCC Continuous Net Settlement', 'sourceUrl': SOURCE,
            'license': 'SEC website dissemination policy', 'licenseUrl': RIGHTS,
            'coverage': 'Reported settlement dates with a positive outstanding fail balance and a published prior closing price, as filed. Only the identified security is included. Published twice monthly.',
            'start': rows[0][0], 'end': rows[-1][0], 'count': len(rows), 'latestRelease': periods[-1],
            'releaseOverrides': {p: urls[p] for p in sorted({r[3] for r in rows}) if urls[p] != source_file(p)},
            'sha256': sha256(file.read_bytes()).hexdigest(),
        }
    save(path, {'version': 1, 'series': list(items.values())})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--until', type=date.fromisoformat, required=True)
    parser.add_argument('--cache', type=Path)
    args = parser.parse_args()
    build(args.root, args.until, args.cache)
