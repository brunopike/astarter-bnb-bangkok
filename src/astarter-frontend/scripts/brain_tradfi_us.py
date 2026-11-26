"""Quarterly diluted EPS as originally filed by US issuers, indexed by filing date."""
from collections import defaultdict
from datetime import date
from math import isfinite
import re

START = date(2016, 1, 1)
SEC = 'https://data.sec.gov/'
ISSUERS = {
    'nvda': ('0001045810', '英伟达 · 季度摊薄每股收益', 'NVIDIA · quarterly diluted EPS'),
    'tsla': ('0001318605', '特斯拉 · 季度摊薄每股收益', 'Tesla · quarterly diluted EPS'),
}
DILUTED = 'EarningsPerShareDiluted'
COMBINED = 'EarningsPerShareBasicAndDiluted'
ACCESSION = re.compile(r'[0-9]{10}-[0-9]{2}-[0-9]{6}')


def fetch_json(url):
    from brain_tradfi import get
    return get(url, headers={'User-Agent': 'Astarter financial research (https://dapp.ipfund.art)'}).json()


def original_reports(cik, until, fetch):
    submissions = fetch(f'{SEC}submissions/CIK{cik}.json')
    if str(submissions['cik']).zfill(10) != cik:
        raise ValueError('Unexpected SEC submissions issuer')
    tables = [submissions['filings']['recent']]
    for item in submissions['filings']['files']:
        if item['filingTo'] < START.isoformat() or item['filingFrom'] > until.isoformat():
            continue
        if not re.fullmatch(r'CIK' + cik + r'-submissions-[0-9]+\.json', item['name']):
            raise ValueError('Unexpected SEC historical submissions filename')
        tables.append(fetch(SEC + 'submissions/' + item['name']))

    reports = {}
    for table in tables:
        columns = [table[key] for key in ('accessionNumber', 'form', 'reportDate', 'filingDate')]
        for accession, form, period, filed in zip(*columns, strict=True):
            if form not in {'10-Q', '10-K'} or not (START.isoformat() <= filed <= until.isoformat()):
                continue
            if not ACCESSION.fullmatch(accession) or date.fromisoformat(filed) < date.fromisoformat(period):
                raise ValueError('Invalid SEC filing reference')
            if period < START.isoformat():
                continue
            report = (form, period, filed)
            if accession in reports and reports[accession] != report:
                raise ValueError('Conflicting SEC filing reference')
            reports[accession] = report
    return reports


def quarterly_rows(facts, reports):
    """Keep a quarter only when its original filing explicitly reports it."""
    gaap = facts['facts']['us-gaap']
    if not isinstance(gaap, dict):
        raise ValueError('Missing SEC US GAAP facts')
    values = defaultdict(lambda: defaultdict(set))
    for concept in (DILUTED, COMBINED):
        for fact in gaap.get(concept, {}).get('units', {}).get('USD/shares', []):
            accession = fact['accn']
            report = reports.get(accession)
            if not report or report != (fact['form'], fact['end'], fact['filed']) or 'start' not in fact:
                continue
            # Includes a 14-week quarter in 52/53-week fiscal calendars.
            duration = (date.fromisoformat(fact['end']) - date.fromisoformat(fact['start'])).days + 1
            if not 77 <= duration <= 99:
                continue
            value = fact['val']
            if type(value) not in (float, int) or not isfinite(value):
                raise ValueError('Invalid SEC diluted EPS')
            values[accession][concept].add(value)

    rows, combined, seen_periods, seen_filed = [], [], set(), set()
    for accession, specific in sorted(values.items(), key=lambda item: (reports[item[0]][2], item[0])):
        _, period, filed = reports[accession]
        if period in seen_periods:
            continue
        concept = DILUTED if specific[DILUTED] else COMBINED
        if len(specific[concept]) != 1 or (specific[DILUTED] and specific[COMBINED] and specific[DILUTED] != specific[COMBINED]):
            raise ValueError('Conflicting consolidated EPS in '+accession)
        if filed in seen_filed:
            raise ValueError('Distinct reporting periods filed on the same day')
        rows.append([filed, next(iter(specific[concept])), period, accession])
        if concept == COMBINED:
            combined.append(accession)
        seen_periods.add(period)
        seen_filed.add(filed)
    return rows, combined


def issuer_series(until: date, fetch_json=fetch_json):
    """Return ({id: (rows, metadata)}, {id: error}); preserve older data on source failure."""
    available, errors = {}, {}
    for ticker, (cik, zh, en) in ISSUERS.items():
        key = ticker + '-eps'
        try:
            reports = original_reports(cik, until, fetch_json)
            url = f'{SEC}api/xbrl/companyfacts/CIK{cik}.json'
            facts = fetch_json(url)
            if str(facts['cik']).zfill(10) != cik:
                raise ValueError('Unexpected SEC facts issuer')
            rows, combined = quarterly_rows(facts, reports)
            if not rows:
                raise ValueError('No verified quarterly filings')
            observed = {row[2] for row in rows}
            missing = sorted({period for form, period, _ in reports.values() if form == '10-Q'} - observed)
            if missing:
                raise ValueError('Quarterly EPS missing for filed report: ' + ', '.join(missing))
            available[key] = rows, {
                'id': key, 'group': 'stock', 'statistic': 'dilutedEps', 'related': 'oracle-' + ticker,
                'cik': cik, 'zh': zh, 'en': en, 'unit': 'USD/share',
                'source': 'SEC EDGAR', 'sourceUrl': url, 'concept': 'us-gaap:'+DILUTED,
                'combinedConcept': 'us-gaap:'+COMBINED, 'combinedAccessions': combined,
            }
        except (ValueError, TypeError, KeyError, OSError) as exc:
            errors[key] = str(exc)
    return available, errors
