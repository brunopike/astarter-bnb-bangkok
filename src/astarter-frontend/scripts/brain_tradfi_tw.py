"""Read TWSE closing-price fields from dated, government-licensed public reports."""
import argparse
import csv
from datetime import date, datetime, timezone, timedelta
import hashlib
import io
import json
from math import isfinite
from pathlib import Path
import re
import tempfile
import threading
import time

import requests

from brain_tradfi import save

START = '2016-01-01'
VALUATION_START = '2017-04-13'
EDITION = 'twse-open-closes-v1'
BASE = 'https://www.twse.com.tw/'
LATEST = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
REPORTS = {
    'daily': ('11549', 'exchangeReport/STOCK_DAY_ALL', 'STOCK_DAY_ALL'),
    'rank': ('11673', 'exchangeReport/MI_INDEX20', 'MI_INDEX20'),
    'foreign': ('11759', 'exchangeReport/STOCK_FIRST', 'STOCK_FIRST'),
    'valuation': ('11764', 'rwd/zh/afterTrading/BWIBBU_d', 'BWIBBU_d_ALL'),
}
ISSUERS = {
    '2330': ('tsmc', '台积电', 'TSMC'),
    '2317': ('honhai', '鸿海', 'Hon Hai'),
    '1590': ('airtac', '亚德客-KY', 'AirTAC-KY'),
    '4958': ('zhending', '臻鼎-KY', 'Zhen Ding-KY'),
}
TITLES = {
    'daily': '個股日成交資訊', 'rank': '每日成交量前二十名證券',
    'foreign': '每日第一上市外國股票成交量值', 'valuation': '個股日本益比、殖利率及股價淨值比（依日期查詢）',
}
KY = {'1590', '4958'}
LOCAL = threading.local()
GATE = threading.Lock()
next_request = 0.0


def parse_report(day, kind, payload, disposition):
    code = day.replace('-', '')
    prefix = REPORTS[kind][2]
    if not re.search(r'filename="?'+re.escape(prefix+'_'+code+'.csv')+r'"?(?:;|$)', disposition, re.I):
        raise ValueError('TWSE report filename does not match requested date: '+day)
    reader = csv.reader(io.StringIO(payload.decode('utf-8-sig')))
    fields = next(reader, [])
    if kind == 'foreign':
        keys = ('第一上市外國股票收盤行情證券代號', '價格(單元：新台幣元)收盤價')
    else:
        keys = ('證券代號', '收盤價')
    if not set(keys).issubset(fields) or (kind != 'foreign' and '日期' not in fields):
        raise ValueError(f'Unexpected {kind} report schema on {day}')
    symbol, close = [fields.index(k) for k in keys]
    day_column = fields.index('日期') if '日期' in fields else None
    result = {}
    total = 0
    for row in reader:
        if not row or not any(row):
            continue
        if len(row) != len(fields) or (day_column is not None and row[day_column] != code):
            raise ValueError(f'Mismatched {kind} row on {day}')
        total += 1
        ticker = row[symbol]
        if ticker not in ISSUERS:
            continue
        if ticker in result:
            raise ValueError(f'Duplicate {ticker} in {kind} on {day}')
        text = row[close].replace(',', '').strip()
        value = None if text in {'', '--', '-', '---'} else float(text)
        if value is not None and (not isfinite(value) or value <= 0):
            raise ValueError(f'Invalid {ticker} closing price on {day}')
        result[ticker] = value
    if not total:
        raise ValueError(f'Empty {kind} report for trading day {day}')
    return result


def latest_snapshot():
    res = requests.get(LATEST, headers={'User-Agent':'Astarter public market archive/1.0'}, timeout=(8, 20))
    res.raise_for_status()
    return parse_latest(res.json())


def parse_latest(data):
    days = {r['Date'] for r in data}
    if len(days) != 1:
        raise ValueError('TWSE daily snapshot contains multiple dates or is empty')
    raw = days.pop()
    if not re.fullmatch(r'[0-9]{7}', raw):
        raise ValueError('TWSE daily snapshot has an invalid ROC date')
    day = date(1911 + int(raw[:3]), int(raw[3:5]), int(raw[5:])).isoformat()
    values = {}
    for row in data:
        ticker = row['Code'].strip()
        if ticker not in ISSUERS:
            continue
        if ticker in values:
            raise ValueError('Duplicate closing quote in daily snapshot: '+ticker)
        text = row['ClosingPrice'].replace(',', '').strip()
        if text in {'', '-', '--', '---'}:
            continue
        price = float(text)
        if not isfinite(price) or price <= 0:
            raise ValueError('Invalid daily closing quote: '+ticker)
        values[ticker] = [price, 'daily']
    if not values:
        raise ValueError('Daily snapshot has no tracked price')
    return day, values


def fetch_report(day, kind):
    if not hasattr(LOCAL, 'http'):
        LOCAL.http = requests.Session()
        LOCAL.http.headers['User-Agent'] = 'Astarter public market archive/1.0'
    path = REPORTS[kind][1]
    global next_request
    with GATE:
        time.sleep(max(0, next_request - time.monotonic()))
        next_request = time.monotonic() + 8
    res = LOCAL.http.get(BASE+path, params={'response':'open_data', 'date':day.replace('-', '')}, timeout=(8, 25))
    if res.status_code in {428, 429}:
        raise OSError('TWSE paused automated downloads (HTTP '+str(res.status_code)+'); retry in a later refresh')
    res.raise_for_status()
    return parse_report(day, kind, res.content, res.headers.get('Content-Disposition', ''))


def read_day(day, fetch=fetch_report):
    values = {}
    reports = ['foreign', 'rank'] if day < VALUATION_START else ['valuation']
    for kind in reports:
        data = fetch(day, kind)
        for ticker, price in data.items():
            if price is None or (day < VALUATION_START and (kind == 'foreign') != (ticker in KY)):
                continue
            values[ticker] = [price, kind]
    if day >= VALUATION_START:
        missing = KY.difference(values)
        if missing:
            data = fetch(day, 'foreign')
            for ticker in missing:
                if data.get(ticker) is not None:
                    values[ticker] = [data[ticker], 'foreign']
    return values


def receipt(day, cache_dir, refresh=False):
    path = cache_dir / (day + '.json')
    if path.exists() and not refresh:
        return json.loads(path.read_bytes())
    data = read_day(day)
    save(path, data)
    return data


def sources(used):
    return [
        {'id': key, 'name': TITLES[key], 'datasetUrl': 'https://data.gov.tw/dataset/'+spec[0],
         'downloadUrl': LATEST if key == 'daily' else BASE+spec[1]+'?response=open_data&date={YYYYMMDD}'}
        for key, spec in REPORTS.items() if key in used
    ]


def calendar_dates(path, until):
    series = json.loads(path.read_bytes())
    if series.get('id') != 'taiex':
        raise ValueError('Expected the TAIEX trading calendar')
    dates = [row[0] for row in series['rows'] if START <= row[0] <= until.isoformat()]
    if not dates or dates != sorted(set(dates)):
        raise ValueError('Empty or unordered TAIEX trading calendar')
    for day in dates:
        date.fromisoformat(day)
    return dates


def load_old(dest, catalog, calendar):
    old = {ticker: {} for ticker in ISSUERS}
    checked = set(calendar)
    through = []
    for ticker, (key, _, _) in ISSUERS.items():
        meta = catalog.get(key, {})
        if meta.get('sourceEdition') != EDITION or not meta.get('verifiedThrough'):
            return {code: {} for code in ISSUERS}, set(), None
        content = (dest/(key+'.json')).read_bytes()
        if hashlib.sha256(content).hexdigest() != meta['sha256']:
            raise ValueError('Stored TWSE digest mismatch: '+key)
        ranges = iter(meta['sourcePeriods'])
        current = next(ranges)
        for day, price in json.loads(content)['rows']:
            if day > current[1]:
                current = next(ranges)
            if not current[0] <= day <= current[1] or current[2] not in REPORTS:
                raise ValueError('Stored TWSE source period mismatch: '+key)
            proof = meta.get('archivedSourceUrls', {}).get(day)
            old[ticker][day] = [price, current[2], proof] if proof else [price, current[2]]
        through.append(meta['verifiedThrough'])
        spans = meta.get('checkedTradingRanges', [[START, meta['verifiedThrough']]])
        checked.intersection_update(day for day in calendar if any(start <= day <= end for start, end in spans))
    return old, checked, min(through)


def store_series(dest, catalog, dates, checked, observations):
    spans = []
    previous_checked = False
    for day in dates:
        if day in checked:
            if previous_checked:
                spans[-1][1] = day
            else:
                spans.append([day, day])
        previous_checked = day in checked
    prepared = {}
    for ticker, (key, zh, en) in ISSUERS.items():
        rows, periods, proofs = [], [], {}
        for day, observation in sorted(observations[ticker].items()):
            price, kind = observation[:2]
            if kind not in REPORTS or type(price) not in (int, float) or not isfinite(price) or price <= 0:
                raise ValueError('Invalid cached TWSE observation: '+ticker+' '+day)
            if len(observation) == 3:
                proofs[day] = observation[2]
            rows.append([day, price])
            if periods and periods[-1][2] == kind:
                periods[-1][1] = day
            else:
                periods.append([day, day, kind])
        if not rows:
            raise ValueError('No verified observations for '+ticker)
        previous_sources = sources({s[2] for s in periods})
        source = previous_sources[-1]['datasetUrl']
        meta = dict(id=key, group='stock', zh=zh+' · '+ticker, en=en+' · '+ticker, unit='TWD',
                    source='Taiwan Stock Exchange', sourceUrl=source, statistic='close',
                    start=rows[0][0], end=rows[-1][0], count=len(rows), sourceEdition=EDITION,
                    licenseUrl='https://data.gov.tw/license', licenseVersion='Open Government Data License 1.0 (Taiwan)',
                    sourcePeriods=periods, reports=previous_sources,
                    attribution='Taiwan Stock Exchange / Securities and Futures Bureau, FSC (Taiwan)',
                    checkedTradingDays=len(checked), verifiedThrough=max(checked), ticker=ticker,
                    calendarTradingDays=len(dates), checkedTradingRanges=spans,
                    coverageMode='reported-close' if len(checked)==len(dates) else 'sampled-trading-days',
                    primaryListedForeign=ticker in KY)
        if proofs:
            meta['archivedSourceUrls'] = proofs
        if ticker not in KY:
            meta['earlyCoverage'] = {'through':'2017-04-12','method':'top20-volume'}
        prepared[key] = (rows, meta)
    for key, (rows, meta) in prepared.items():
        path = dest/(key+'.json')
        save(path, {'id':key, 'rows':rows})
        catalog[key] = {**meta, 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    save(dest/'catalog.json', {'version':1, 'series':list(catalog.values())})


def priority_dates(dates):
    month_ends = {day[:7]: day for day in dates}
    # A provisional history should cover every calendar year before filling gaps.
    year_ends = {day[:4]: day for day in dates}
    return list(dict.fromkeys([dates[-1], dates[0], *year_ends.values(), *month_ends.values(), *reversed(dates)]))


def build(dest, until, *, calendar_path=None, cache_dir=None, fetch_day=None, limit=32, cached_only=False):
    calendar_path = calendar_path or dest/'taiex.json'
    cache_dir = cache_dir or Path(tempfile.gettempdir())/EDITION
    dates = calendar_dates(calendar_path, until)
    dest.mkdir(exist_ok=True, parents=True)
    meta_path = dest/'catalog.json'
    entries = json.loads(meta_path.read_bytes())['series'] if meta_path.exists() else []
    catalog = {s['id']:s for s in entries}
    records, checked, previous = load_old(dest, catalog, dates)
    if previous and previous > dates[-1]:
        return []
    cache_dir.mkdir(exist_ok=True, parents=True)
    if not cached_only and fetch_day is None:
        try:
            snapshot_date, values = latest_snapshot()
        except requests.RequestException as exc:
            if exc.response is not None and exc.response.status_code in {428, 429}:
                raise
        else:
            if snapshot_date in dates and snapshot_date not in checked:
                save(cache_dir/(snapshot_date+'.json'), values)
    ordered = priority_dates(dates)
    ready = [day for day in ordered if day not in checked and (cache_dir/(day+'.json')).is_file()]
    ready_set = set(ready)
    missing = [day for day in ordered if day not in checked and day not in ready_set]
    needed = ready if cached_only else ready + missing[:limit]
    if previous and not cached_only and previous == dates[-1] and not needed:
        needed.append(previous)
    elif previous and not cached_only and previous < dates[-1]:
        needed.append(previous)
    if not needed:
        return []

    def pull(day):
        if fetch_day:
            return fetch_day(day)
        return receipt(day, cache_dir, refresh=bool(previous) and day == previous)

    updated = False
    for day in needed:
        try:
            data = pull(day)
        except (OSError, ValueError):
            if updated and all(records.values()):
                store_series(dest, catalog, dates, checked, records)
            raise
        # An omission in a ranked or thinner report cannot retract an earlier observed close.
        for ticker, observation in data.items():
            if ticker in ISSUERS:
                records[ticker][day] = observation
        updated = True
        checked.add(day)
    store_series(dest, catalog, dates, checked, records)
    return []


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--calendar', type=Path)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--cached-only', action='store_true')
    parser.add_argument('--until', type=date.fromisoformat, default=datetime.now(timezone.utc).date()-timedelta(days=1))
    args = parser.parse_args()
    build(args.root, args.until, calendar_path=args.calendar, cache_dir=args.cache,
          limit=None if args.full else 32, cached_only=args.cached_only)
