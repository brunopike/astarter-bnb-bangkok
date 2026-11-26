"""Build the static Ethereum and Bitcoin block index from public AWS Parquet.

Run with Python 3.11+, requests and pyarrow. By default, extend the existing
archive to all UTC days from 2022-09-15 through 2026-11-24. Every new gzip
shard holds [firstHeight, firstTime, [deltaHeight, deltaTime, transactions, ...]].
The initial deltas are zero. The manifest pins each object, ETag and shard digest.
Incremental imports retain existing days and the two reference event days.
For a source replay, use --replay manifest.json with an empty --output directory.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import io
import gzip
import os
import tempfile
import json
from pathlib import Path
import re
import threading
from urllib.parse import quote
from xml.etree import ElementTree

import pyarrow as pa
import pyarrow.parquet as parquet
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BUCKET = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com'
REGISTRY = 'https://registry.opendata.aws/aws-public-blockchain/'
LICENSE = 'https://raw.githubusercontent.com/aws-samples/digital-assets-examples/main/LICENSE'
COLUMNS = ['number', 'timestamp', 'transaction_count']
FIELDS = ['height', 'timestamp', 'transactions']
ENCODING = 'delta-triples+gzip'
MILESTONES = {'eth': date(2022, 9, 15), 'btc': date(2024, 4, 20)}
local = threading.local()


def session():
    if not hasattr(local, 'session'):
        http = requests.Session()
        retry = Retry(total=4, backoff_factor=.45, status_forcelist=[429, 500, 502, 503, 504])
        http.mount('https://', HTTPAdapter(max_retries=retry))
        local.session = http
    return local.session


def objects(chain, days):
    """List only the relevant suffix of the bucket, including split partitions."""
    prefix = f'v1.0/{chain}/blocks/date='
    start, end = min(days), max(days)
    params = {'list-type': 2, 'prefix': prefix, 'start-after': prefix + str(start)}
    results = {d: [] for d in days}
    while True:
        response = session().get(BUCKET, params=params, timeout=40)
        response.raise_for_status()
        xml = ElementTree.fromstring(response.content)
        for item in xml.findall('{*}Contents'):
            key = item.findtext('{*}Key')
            day = date.fromisoformat(key[len(prefix):len(prefix)+10])
            if day > end:
                return results
            if day in days and key.endswith('.parquet'):
                tag = item.findtext('{*}ETag').strip('"')
                results[day].append({'url': BUCKET + '/' + quote(key, safe='/='), 'etag': tag, 'bytes': int(item.findtext('{*}Size'))})
        cursor = xml.findtext('{*}NextContinuationToken')
        if not cursor:
            return results
        params = {'list-type': 2, 'prefix': prefix, 'continuation-token': cursor}


class ColumnReader(io.RawIOBase):
    """Seekable HTTPS source. Read the footer and required columns, pinning every request."""
    def __init__(self, obj):
        self.obj = obj
        self.pos = 0
        self.parts = []

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = (0, self.pos, self.obj['bytes'])[whence] + offset
        if self.pos < 0:
            raise ValueError('Negative Parquet offset')
        return self.pos

    def read(self, n=-1):
        size = self.obj['bytes']
        a = self.pos
        b = size if n < 0 else min(a+n, size)
        if b <= a:
            return b''
        for offset, chunk in self.parts:
            if offset <= a and b <= offset + len(chunk):
                self.pos = b
                return chunk[a-offset:b-offset]
        headers = {'Range': f'bytes={a}-{b-1}', 'If-Match': '"' + self.obj['etag'] + '"', 'Accept-Encoding': 'identity'}
        res = session().get(self.obj['url'], headers=headers, timeout=40)
        res.raise_for_status()
        if res.headers.get('ETag', '').strip('"') != self.obj['etag']:
            raise ValueError('Source object changed during import')
        if res.status_code == 200 and len(res.content) == size:
            offset = 0
        elif res.status_code == 206 and res.headers.get('Content-Range') == f'bytes {a}-{b-1}/{size}' and len(res.content) == b-a:
            offset = a
        else:
            raise ValueError('Unexpected Parquet byte range: ' + str(res.headers.get('Content-Range')))
        self.parts.append((offset, res.content))
        self.pos = b
        return res.content[a-offset:b-offset]


def extract(inputs, day):
    records = {}
    for obj in inputs:
        reader = ColumnReader(obj)
        data = parquet.ParquetFile(reader).read(columns=COLUMNS, use_threads=False)
        heights, times, counts = data.columns
        times = times.cast(pa.timestamp('s')).cast(pa.int64())
        for height, stamp, txs in zip(heights.to_pylist(), times.to_pylist(), counts.to_pylist(), strict=True):
            if not all(type(x) is int for x in (height, stamp, txs)) or min(height, txs) < 0:
                raise ValueError('Invalid block in ' + obj['url'])
            if date.fromordinal(date(1970, 1, 1).toordinal() + stamp//86400) != day:
                raise ValueError('UTC partition mismatch in ' + obj['url'])
            value = (stamp, txs)
            if height in records and records[height] != value:
                raise ValueError('Conflicting versions of block ' + str(height))
            records[height] = value
    if not records:
        raise ValueError('Empty source partition for ' + str(day))
    return [[height, *records[height]] for height in sorted(records)]


def packed(rows):
    first_height, first_time, _ = rows[0]
    height, timestamp = first_height, first_time
    values = []
    for next_height, next_time, transactions in rows:
        values.extend((next_height - height, next_time - timestamp, transactions))
        height, timestamp = next_height, next_time
    stream = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=stream, compresslevel=9, mtime=0) as output:
        output.write(json_bytes([first_height, first_time, values]))
    return stream.getvalue()


def json_bytes(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def atomic_write(path, content):
    handle = tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name+'.', suffix='.tmp', delete=False)
    try:
        with handle:
            os.fchmod(handle.fileno(), 0o644)
            handle.write(content)
        os.replace(handle.name, path)
    finally:
        Path(handle.name).unlink(missing_ok=True)


def validate_sources(chain, day, sources):
    prefix = f'{BUCKET}/v1.0/{chain}/blocks/date={day}/'
    if not sources:
        raise ValueError(f'Missing AWS {chain} partition {day}')
    for obj in sources:
        if not obj['url'].startswith(prefix) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.parquet', obj['url'][len(prefix):]):
            raise ValueError('Invalid AWS block object location')
        if not re.fullmatch(r'[0-9a-f]{32}(?:-[0-9]+)?', obj['etag']) or not 0 < obj['bytes'] < 512*1024*1024:
            raise ValueError('Invalid object size or ETag')


def date_rows(data, compact):
    if not compact:
        yield from data
        return
    height, timestamp, values = data
    if len(values) < 3 or len(values) % 3 or values[:2] != [0, 0]:
        raise ValueError('Invalid first block or delta triples')
    for i in range(0, len(values), 3):
        height += values[i]
        timestamp += values[i+1]
        yield height, timestamp, values[i+2]


def resolve_day(dest, checkpoints, chain, day, sources, previous=None):
    validate_sources(chain, day, sources)
    # The first release used plain JSON for its July–November window and event days.
    legacy = date(2026, 7, 1) <= day <= date(2026, 11, 24) or day == MILESTONES[chain]
    compact = previous.get('encoding') == ENCODING if previous else not legacy
    filename = f'{chain}-{day}.json' + ('.gz' if compact else '')
    target = dest / filename
    receipt = checkpoints / (filename+'.receipt') if checkpoints else None
    if previous and (previous['file'] != filename or previous.get('encoding') not in (None, ENCODING)):
        raise ValueError('Unexpected replay format for '+filename)
    saved = previous
    if saved is None and receipt and receipt.is_file():
        saved = json.loads(receipt.read_bytes())
    if saved and saved['sources'] == sources and saved['file'] == filename:
        candidates = [target, checkpoints/filename] if checkpoints else [target]
        for f in candidates:
            if not f.is_file():
                continue
            content = f.read_bytes()
            if sha256(content).hexdigest() == saved['sha256']:
                if f != target:
                    atomic_write(target, content)
                return saved
    rows = extract(sources, day)
    raw = packed(rows) if compact else json_bytes(rows)
    shard = {'file':filename,'start':str(day),'end':str(day),'count':len(rows),
             'firstHeight':rows[0][0],'lastHeight':rows[-1][0],'sha256':sha256(raw).hexdigest()}
    if compact:
        shard['encoding'] = ENCODING
    shard['sources'] = sources
    if previous and previous != shard:
        raise ValueError('Replay digest or metadata mismatch: '+filename)
    atomic_write(target, raw)
    if receipt:
        atomic_write(receipt, json_bytes(shard))
    return shard


def day_range(start, end):
    return {start + timedelta(days=i) for i in range((end-start).days+1)}


def verify_chain(dest, chain, shards):
    # Bitcoin miners' timestamps need not increase with height. A bitmap checks
    # exact height uniqueness, even for overlapping adjacent UTC partitions.
    chunks = {}
    ranges = []
    for s in shards:
        begin = date.fromisoformat(s['start'])
        utc_day = (begin-date(1970,1,1)).days
        raw = (dest/s['file']).read_bytes()
        if sha256(raw).hexdigest() != s['sha256']:
            raise ValueError('Local shard digest mismatch: '+s['file'])
        compact = s.get('encoding') == ENCODING
        payload = json.loads(gzip.decompress(raw) if compact else raw)
        count, prior = 0, -1
        for h, ts, tx in date_rows(payload, compact):
            if type(h) is not int or type(ts) is not int or type(tx) is not int or h <= prior or tx < 0 or ts//86400 != utc_day:
                raise ValueError('Invalid or misplaced block in '+s['file'])
            if not count and h != s['firstHeight']:
                raise ValueError('Invalid first height in '+s['file'])
            segment = h >> 16
            bitmap = chunks.get(segment)
            if bitmap is None:
                bitmap = chunks[segment] = bytearray(8192)
            index, bit = (h & 65535) >> 3, 1 << (h & 7)
            if bitmap[index] & bit:
                raise ValueError(f'Duplicate {chain} block height {h} across UTC days')
            bitmap[index] |= bit
            prior, count = h, count + 1
        if not count or count != s['count'] or prior != s['lastHeight'] or s['end'] != s['start']:
            raise ValueError('Invalid shard count or coverage: '+s['file'])
        if ranges and begin == date.fromisoformat(ranges[-1]['end'])+timedelta(days=1):
            ranges[-1]['end'] = s['end']
            ranges[-1]['count'] += count
        else:
            ranges.append({'start':s['start'],'end':s['end'],'count':count})
    # The first/last UTC day may omit out-of-order Bitcoin timestamps outside
    # the requested window. Every height between these two edge days must exist.
    offset = 0
    for span in ranges:
        days = 1 + (date.fromisoformat(span['end']) - date.fromisoformat(span['start'])).days
        group = shards[offset:offset+days]
        offset += days
        first, last = group[0], group[-1]
        low, high = min(s['firstHeight'] for s in group), max(s['lastHeight'] for s in group)
        if high - low + 1 == span['count']:
            continue
        if chain == 'eth':
            raise ValueError(f'Missing Ethereum height in {span["start"]} – {span["end"]}')
        for h in range(first['lastHeight'] + 1, last['firstHeight']):
            bitmap = chunks.get(h >> 16)
            if bitmap is None or not bitmap[(h & 65535) >> 3] & (1 << (h & 7)):
                raise ValueError(f'Missing interior Bitcoin block height {h}')
    return {'id':chain+'-blocks','asset':chain.upper(),'source':'AWS Public Blockchain','sourceUrl':REGISTRY,
            'fields':FIELDS,'count':sum(r['count'] for r in ranges),'start':shards[0]['start'],
            'end':shards[-1]['end'],'ranges':ranges,'shards':shards}


def source_plan(chain, pinned, previous, start, end):
    prior = next((ds for ds in (previous or {}).get('datasets', []) if ds['asset'] == chain.upper()), {})
    by_day = {date.fromisoformat(s['start']): s for s in prior.get('shards', [])}
    if pinned:
        return {d:(s['sources'],s) for d,s in by_day.items() if (not start or d >= start) and (not end or d <= end)}
    requested = day_range(start or date(2022,9,15), end or date(2026,11,24)) | {MILESTONES[chain]}
    plan = {d:(s['sources'],s) for d,s in by_day.items()}
    needed = requested-by_day.keys()
    if needed:
        plan.update({d:(inputs,None) for d,inputs in objects(chain,needed).items()})
    return plan


def build(args):
    dest = args.output
    dest.mkdir(parents=True, exist_ok=True)
    existing = dest/'manifest.json'
    previous = json.loads(args.replay.read_bytes()) if args.replay else json.loads(existing.read_bytes()) if existing.is_file() else None
    for catalog in [previous, json.loads(existing.read_bytes()) if existing.is_file() else None]:
        if catalog and any(d['asset'] not in ('BTC','ETH') for d in catalog['datasets']):
            raise ValueError('Use update-brain-chains.py for a multi-chain archive')
    checkpoints = args.checkpoints
    if checkpoints is None and not args.replay:
        directory_id = sha256(os.fsencode(dest.resolve())).hexdigest()[:16]
        checkpoints = Path(tempfile.gettempdir())/'astarter-block-checkpoints'/directory_id
    if checkpoints:
        checkpoints.mkdir(parents=True, exist_ok=True)
    plans = {chain:source_plan(chain, bool(args.replay), previous, args.start, args.end) for chain in ('btc','eth')}
    if not all(plans.values()):
        raise ValueError('No records for both chains in the selected archive/date range')
    if args.replay and existing.is_file():
        current = json.loads(existing.read_bytes())
        for ds in current['datasets']:
            planned = plans[ds['asset'].lower()]
            if any(date.fromisoformat(s['start']) not in planned for s in ds['shards']):
                raise ValueError('Use a separate output directory when replaying a smaller archive')
    grouped = {chain:[] for chain in plans}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(resolve_day, dest, checkpoints, chain, day, sources, known):chain
                for chain, plan in plans.items() for day,(sources,known) in sorted(plan.items())}
        for index, task in enumerate(as_completed(jobs), 1):
            grouped[jobs[task]].append(task.result())
            if index%100 == 0:
                print(f'{index}/{len(jobs)} UTC shards ready',flush=True)
    datasets = [verify_chain(dest, chain, sorted(parts,key=lambda s:s['start'])) for chain,parts in grouped.items()]
    total = sum(ds['count'] for ds in datasets)
    manifest = {'schemaVersion':1,'count':total,
                'accessedOn':previous['accessedOn'] if args.replay else datetime.now(timezone.utc).date().isoformat(),
                'sourceUrl':REGISTRY,'licenseUrl':LICENSE,'datasets':datasets}
    if args.replay and not args.start and not args.end and manifest != previous:
        raise ValueError('Replayed manifest differs from the original')
    if not (dest/'LICENSE.txt').is_file():
        response = session().get(LICENSE,timeout=30)
        response.raise_for_status()
        if b'Copyright Amazon.com' not in response.content:
            raise ValueError('Unrecognized registry license notice')
        atomic_write(dest/'LICENSE.txt',response.content)
    summary = {k:manifest[k] for k in ('schemaVersion','count','accessedOn')}
    summary['datasets'] = [{k:ds[k] for k in ('asset','count','start','end','ranges')} for ds in datasets]
    atomic_write(existing, json_bytes(manifest))
    atomic_write(dest/'summary.json', json_bytes(summary))
    print(f'Verified {total:,} unique public blocks in {sum(map(len,grouped.values())):,} UTC shards.',flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--start',type=date.fromisoformat,help='First UTC day, inclusive (default 2022-09-15)')
    parser.add_argument('--end',type=date.fromisoformat,help='Last UTC day, inclusive (default 2026-11-24)')
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'brain-evidence'/'archive')
    parser.add_argument('--replay',type=Path,help='Rebuild and verify the pinned original source list and daily encodings')
    parser.add_argument('--checkpoints',type=Path,help='Directory for daily receipts (default: temporary cache per output; source replay defaults to no cache)')
    parser.add_argument('--workers',type=int,default=12)
    args = parser.parse_args()
    start = args.start or (None if args.replay else date(2022,9,15))
    end = args.end or (None if args.replay else date(2026,11,24))
    if (start and end and start > end) or not 1 <= args.workers <= 32:
        parser.error('Use an ordered UTC date range and 1 to 32 workers')
    build(args)
