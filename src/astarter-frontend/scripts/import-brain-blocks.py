"""Build the static Ethereum and Bitcoin block index from public AWS Parquet.

Run with Python 3.11+, requests and pyarrow. The default snapshot covers July 1
through November 24, 2026, plus the Ethereum Merge and Bitcoin halving dates.
The manifest pins exact source objects and ETags for historical verification.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import io
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


def write_day(dest, chain, day, inputs):
    rows = extract(inputs, day)
    filename = f'{chain}-{day}.json'
    raw = (json.dumps(rows, separators=(',', ':'))+'\n').encode()
    (dest / filename).write_bytes(raw)
    return {'file': filename, 'start': str(day), 'end': str(day), 'count': len(rows),
            'firstHeight': rows[0][0], 'lastHeight': rows[-1][0],
            'sha256': sha256(raw).hexdigest(), 'sources': inputs}


def day_range(start, end):
    return {start+timedelta(days=i) for i in range((end-start).days+1)}


def build(args):
    args.output.mkdir(parents=True, exist_ok=True)
    data = []
    pinned = json.loads(args.replay.read_text()) if args.replay else None
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for chain in ('btc', 'eth'):
            jobs = {}
            if pinned:
                previous = next(item for item in pinned['datasets'] if item['asset'] == chain.upper())
                by_day = {date.fromisoformat(s['start']): s['sources'] for s in previous['shards']}
                expected = {s['file']:s['sha256'] for s in previous['shards']}
            else:
                days = day_range(args.start, args.end)
                by_day = objects(chain, days)
                milestone = MILESTONES[chain]
                if milestone not in days:
                    by_day.update(objects(chain, {milestone}))
            for day, inputs in by_day.items():
                prefix = f'{BUCKET}/v1.0/{chain}/blocks/date={day}/'
                for obj in inputs:
                    if not obj['url'].startswith(prefix) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.parquet', obj['url'][len(prefix):]):
                        raise ValueError('Invalid AWS block object location')
                    if not re.fullmatch(r'[0-9a-f]{32}(?:-[0-9]+)?', obj['etag']) or not 0 < obj['bytes'] < 512*1024*1024:
                        raise ValueError('Invalid object size or ETag')
                if not inputs:
                    raise ValueError(f'Missing AWS {chain} partition {day}')
                jobs[pool.submit(write_day, args.output, chain, day, inputs)] = day
            shards = []
            for task in as_completed(jobs):
                item = task.result()
                if pinned and expected[item['file']] != item['sha256']:
                    raise ValueError('Replay digest mismatch: ' + item['file'])
                shards.append(item)
                if len(shards) % 25 == 0:
                    print(chain, len(shards), '/', len(jobs), flush=True)
            shards.sort(key=lambda x:x['start'])
            count = sum(s['count'] for s in shards)
            ranges = []
            seen = set()
            for s in shards:
                heights = [row[0] for row in json.loads((args.output/s['file']).read_bytes())]
                if not seen.isdisjoint(heights):
                    raise ValueError('Duplicate chain-height across shards')
                seen.update(heights)
                begin = date.fromisoformat(s['start'])
                if ranges and begin == date.fromisoformat(ranges[-1]['end'])+timedelta(days=1):
                    ranges[-1]['end'] = s['end']
                    ranges[-1]['count'] += s['count']
                else:
                    ranges.append({'start': s['start'], 'end': s['end'], 'count': s['count']})
            data.append({'id': chain+'-blocks', 'asset': chain.upper(), 'source':'AWS Public Blockchain',
                         'sourceUrl':REGISTRY, 'fields':FIELDS, 'count':count, 'start':shards[0]['start'],
                         'end':shards[-1]['end'], 'ranges':ranges, 'shards':shards})
    total = sum(ds['count'] for ds in data)
    retrieved = pinned['accessedOn'] if pinned else datetime.now(timezone.utc).date().isoformat()
    manifest = {'schemaVersion': 1, 'count': total, 'accessedOn': retrieved,
                'sourceUrl': REGISTRY, 'licenseUrl': LICENSE,
                'datasets': data}
    resp = session().get(LICENSE, timeout=30)
    resp.raise_for_status()
    if b'Copyright Amazon.com' not in resp.content:
        raise ValueError('Unrecognized registry license notice')
    (args.output/'LICENSE.txt').write_bytes(resp.content)
    (args.output/'manifest.json').write_text(json.dumps(manifest, separators=(',', ':'))+'\n')
    print('Wrote', total, 'unique public block observations.',flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--start', type=date.fromisoformat, default=date(2026, 7, 1))
    parser.add_argument('--end', type=date.fromisoformat, default=date(2026, 11, 24))
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'brain-evidence'/'archive')
    parser.add_argument('--replay', type=Path, help='Read original object keys, ETags and output digests from a prior manifest')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    if args.start > args.end or not 1 <= args.workers <= 24:
        parser.error('Use an ordered UTC date range and 1 to 24 workers')
    build(args)
