"""Import the frozen public-domain WIKI Prices daily U.S. equity archive."""
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import date
from hashlib import file_digest, sha256
from math import isfinite
from pathlib import Path
import re
import tempfile
from zipfile import ZipFile

from brain_tradfi import json_bytes, save, session

SOURCE = 'https://data.nasdaq.com/databases/WIKIP'
MIRROR = 'https://api.kaggle.com/v1/datasets/download/marketneutral/quandl-wiki-prices-us-equites?datasetVersionNumber=1'
SOURCE_HASH = 'adfd226694c6f3ec2c56b585d973764180a39a3ec516601721e90096dc1de94f'
FIRST, LAST = '2016-01-01', '2018-03-27'
HEADER = b'ticker,date,open,high,low,close,volume,ex-dividend,split_ratio,adj_open,adj_high,adj_low,adj_close,adj_volume'
TICKER = re.compile(r'[A-Z][A-Z0-9]*(?:_[A-Z])?')
EXPECTED = (2903, 1478174, 53)


@contextmanager
def source_archive(path):
    with tempfile.TemporaryDirectory() as tmp:
        if path is None:
            path = Path(tmp) / 'wiki-prices-v1.zip'
            with session() as http, http.get(MIRROR, stream=True, timeout=(12, 120)) as res:
                res.raise_for_status()
                with path.open('wb') as dest:
                    for chunk in res.iter_content(1024 * 1024):
                        dest.write(chunk)
        with Path(path).open('rb') as archive:
            if file_digest(archive, 'sha256').hexdigest() != SOURCE_HASH:
                raise ValueError('The WIKI Prices snapshot no longer matches its pinned SHA-256')
            archive.seek(0)
            with ZipFile(archive) as bundle, bundle.open('WIKI_PRICES.csv') as raw:
                yield raw


def bar(day, data):
    op, high, low, close, volume = map(float, data)
    if not all(isfinite(x) for x in (op, high, low, close, volume)):
        raise ValueError('Non-finite WIKI market data')
    if not (0 < low <= min(op, close) and high >= max(op, close)):
        return None
    if not (volume.is_integer() and 0 <= volume <= 2**53 - 1):
        raise ValueError('Invalid official share volume')
    return [day, close, op, high, low, int(volume)]


def iter_symbols(raw, until, rejects):
    if next(raw).rstrip(b'\r\n') != HEADER:
        raise ValueError('Unexpected WIKI Prices schema')
    seen, ticker, previous_day, rows = set(), '', '', []
    start_bytes, end_bytes = FIRST.encode(), until.encode()
    for line in raw:
        symbol_bytes, day_bytes, rest = line.split(b',', 2)
        if not start_bytes <= day_bytes <= end_bytes:
            continue
        symbol = symbol_bytes.decode('ascii')
        day = day_bytes.decode('ascii')
        if symbol != ticker:
            if not TICKER.fullmatch(symbol) or symbol in seen:
                raise ValueError('Unexpected WIKI symbol grouping: ' + symbol)
            if rows:
                yield ticker, rows
            seen.add(symbol)
            ticker, previous_day, rows = symbol, '', []
        if day <= previous_day or date.fromisoformat(day).isoformat() != day:
            raise ValueError('Unexpected or duplicate WIKI date for ' + symbol)
        previous_day = day
        values = bar(day, rest.split(b',', 5)[:5])
        if values is None:
            rejects.append([symbol, day, 'priceOutsideDailyRange'])
        else:
            rows.append(values)
    if rows:
        yield ticker, rows


def build(dest, until, archive=None, audit_path=None):
    import json
    dest = Path(dest)
    final = min(until.isoformat(), LAST)
    if final < FIRST:
        raise ValueError('WIKI import begins in 2016')
    path = dest/'catalog.json'
    original = json.loads(path.read_bytes()) if path.is_file() else {'version': 1, 'series': []}
    other = [s for s in original['series'] if not s['id'].startswith('us-wiki-')]
    existing = [s for s in original['series'] if s['id'].startswith('us-wiki-')]
    if any(s['end'] > final for s in existing):
        raise ValueError('An earlier as-of must be imported into a separate directory')
    rejects, metadata = [], []
    with source_archive(archive) as raw, tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        for symbol, rows in iter_symbols(raw, final, rejects):
            key = 'us-wiki-' + symbol.lower().replace('_', '-')
            data = json_bytes({'id': key, 'rows': rows})
            (stage/(key+'.json')).write_bytes(data)
            metadata.append(dict(id=key, symbol=symbol, group='stock', statistic='ohlcv',
                en=symbol+' · WIKI', zh=symbol+' · WIKI', unit='USD/share', frequency='daily',
                source='Quandl community · WIKI Prices', sourceUrl=SOURCE, licenseUrl=SOURCE,
                license='Public domain', priceBasis='unadjusted', sourceStatus='discontinued',
                start=rows[0][0], end=rows[-1][0], count=len(rows), sha256=sha256(data).hexdigest()))
        size = sum(s['count'] for s in metadata)
        if final == LAST and (len(metadata), size, len(rejects)) != EXPECTED:
            raise ValueError('Verified snapshot coverage does not reconcile')
        if not metadata:
            raise ValueError('The WIKI archive returned no observations')
        if len(set(s['id'] for s in metadata)) != len(metadata):
            raise ValueError('Duplicate normalized instrument identifier')
        dest.mkdir(parents=True, exist_ok=True)
        for s in metadata:
            # Immutable frozen source: overlapping published files must be identical
            # on a replay, or a strict date-prefix extension for a later as-of.
            f = dest/(s['id']+'.json')
            frozen = (stage/f.name).read_bytes()
            if f.exists():
                current = f.read_bytes()
                if current == frozen:
                    continue
                a, b = json.loads(current), json.loads(frozen)
                if a['id'] != b['id'] or b['rows'][:len(a['rows'])] != a['rows']:
                    raise ValueError('Existing WIKI data conflicts with pinned source: ' + f.name)
            save(f, json.loads(frozen))
    save(path, {**original, 'series': other+metadata})
    if audit_path:
        save(Path(audit_path), {'sourceUrl': SOURCE, 'snapshotUrl': MIRROR, 'sourceSha256': SOURCE_HASH,
             'end': final, 'series':len(metadata), 'observations':size,
             'excludedRows':rejects, 'excludedByReason':dict(Counter(x[2] for x in rejects))})
    return len(metadata), size, len(rejects)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--audit', type=Path)
    parser.add_argument('--until', type=date.fromisoformat, default=date.fromisoformat(LAST))
    args = parser.parse_args()
    print(build(args.root, args.until, args.archive, args.audit))
