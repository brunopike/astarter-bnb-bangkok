"""Archive a daily sample of native HyperCore explorer blocks from the anonymous AWS mirror.

Requires requests, lz4 and msgpack. Each UTC date contains the actual explorer
rows of one available 100-height source object, usually near noon. The height
estimate only selects an object; time, transaction count and height always come
from that object. Individual fills and replica command counts are different.
"""
import argparse
import bisect
import gzip
import io
import json
import os
import re
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from xml.etree import ElementTree

import lz4.frame
import msgpack
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ORIGIN = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com'
PREFIX = 'v1.1/hyperliquid/mainnet/explorer_blocks/'
REGISTRY = 'https://registry.opendata.aws/aws-public-blockchain/'
FIELDS = ['height', 'timestamp', 'transactions']
UTC = timezone.utc
DAY = timedelta(days=1)
EPOCH = date(1970, 1, 1)
LOCAL = threading.local()


def http():
    if not hasattr(LOCAL, 'session'):
        session = requests.Session()
        backoff = Retry(total=4, backoff_factor=.5, status_forcelist=[429, 500, 502, 503, 504])
        session.mount('https://', HTTPAdapter(max_retries=backoff))
        LOCAL.session = session
    return LOCAL.session


def encode(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        name = out.name
        try:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), 0o644)
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)


def pack(rows):
    height, stamp, _ = rows[0]
    deltas = []
    for h, t, n in rows:
        deltas.extend([h-height, t-stamp, n])
        height, stamp = h, t
    out = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0, compresslevel=9) as stream:
        stream.write(encode([rows[0][0], rows[0][1], deltas]))
    return out.getvalue()


def object_key(end):
    return f'{PREFIX}{(end-1)//100_000_000*100_000_000}/{(end-1)//100_000*100_000}/{end}.rmp.lz4'


def list_parts(prefix, folders):
    params = {'prefix': prefix, 'list-type': '2', 'delimiter': '/', 'max-keys': 1000}
    entries = []
    while True:
        resp = http().get(ORIGIN, params=params, timeout=30)
        resp.raise_for_status()
        xml = ElementTree.fromstring(resp.content)
        for entry in xml.findall('{*}CommonPrefixes' if folders else '{*}Contents'):
            key = entry.findtext('{*}Prefix' if folders else '{*}Key', '')
            suffix = key.removeprefix(prefix)
            valid = re.fullmatch(r'(\d+)/' if folders else r'(\d+)\.rmp\.lz4', suffix)
            if valid:
                entries.append(int(valid[1]))
        cursor = xml.findtext('{*}NextContinuationToken')
        if not cursor:
            return sorted(entries)
        params['continuation-token'] = cursor


def extent():
    roots = list_parts(PREFIX, True)
    if not roots:
        raise ValueError('Empty HyperCore AWS mirror')
    limits = []
    for edge in (min, max):
        root = PREFIX + str(edge(roots)) + '/'
        group = root + str(edge(list_parts(root, True))) + '/'
        limits.append(edge(list_parts(group, False)))
    return limits


def decode_source(raw, end):
    # The native explorer flattens a bundled entry into one transaction per action.
    # The on-disk UTC timestamps sometimes have nine fractional digits and no suffix.
    rows = []
    with lz4.frame.open(io.BytesIO(raw), mode='rb') as stream:
        reader = msgpack.Unpacker(stream, raw=False, strict_map_key=False)
        count = reader.read_array_header()
        if not 0 < count <= 100:
            raise ValueError(f'Invalid explorer pack size for {end}')
        for _ in range(count):
            header = txs = None
            for _ in range(reader.read_map_header()):
                field = reader.unpack()
                if field == 'header':
                    header = reader.unpack()
                elif field == 'txs':
                    txs = 0
                    for _ in range(reader.read_array_header()):
                        actions = None
                        for _ in range(reader.read_map_header()):
                            if reader.unpack() == 'actions':
                                actions = reader.read_array_header()
                                for _ in range(actions):
                                    reader.skip()
                            else:
                                reader.skip()
                        if actions is None:
                            raise ValueError(f'Missing native explorer actions in {end}')
                        txs += actions
                else:
                    reader.skip()
            if not isinstance(header, dict) or txs is None:
                raise ValueError(f'Missing explorer fields at {end}')
            h = header.get('height')
            instant = datetime.fromisoformat(header['block_time'].replace('Z', '+00:00'))
            if instant.tzinfo is None:
                instant = instant.replace(tzinfo=UTC)
            ts = int(instant.timestamp())
            if type(h) is not int or not end-100 < h <= end or (rows and (h <= rows[-1][0] or ts < rows[-1][1])):
                raise ValueError(f'Invalid HyperCore block order in {end}')
            rows.append((h, ts, txs))
        try:
            reader.unpack()
        except msgpack.OutOfData:
            pass
        else:
            raise ValueError('Trailing data in HyperCore explorer object')
    return rows


@lru_cache(maxsize=2400)
def load_object(end):
    url = ORIGIN + '/' + object_key(end)
    resp = http().get(url, timeout=(10, 75))
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    raw = resp.content
    etag = resp.headers.get('ETag', '').strip('"')
    if not re.fullmatch(r'[a-f0-9]{32}(?:-[0-9]+)?', etag) or len(raw) != int(resp.headers['Content-Length']):
        raise ValueError('Unpinned or truncated HyperCore explorer object')
    return decode_source(raw, end), {'url': url, 'etag': etag, 'bytes': len(raw)}


def nearest_object(end, low, high):
    end = min(high, max(low, end))
    candidate = load_object(end)
    if candidate:
        return end, candidate
    group = object_key(end).rsplit('/', 1)[0] + '/'
    present = [n for n in list_parts(group, False) if low <= n <= high]
    if present:
        nearby = min(present, key=lambda n: (abs(n-end), n))
        obj = load_object(nearby)
        if obj:
            return nearby, obj
    return None


def day_sample(day, anchors):
    start = (day - EPOCH).days * 86400
    target = start + 43200
    idx = bisect.bisect_left(anchors, (target, 0))
    lo = anchors[max(0, idx-1)]
    hi = anchors[min(len(anchors)-1, idx)]
    for _ in range(28):
        if lo[1] == hi[1]:
            end = lo[1]
        else:
            fraction = min(1, max(0, (target-lo[0])/max(1, hi[0]-lo[0])))
            end = lo[1] + int(round((hi[1]-lo[1])*fraction/100))*100
        found = nearest_object(end, lo[1], hi[1])
        if not found:
            raise ValueError(f'No HyperCore source object near {end} on {day}')
        end, (rows, source) = found
        within = [r for r in rows if start <= r[1] < start+86400]
        if within:
            return within, source
        if rows[-1][1] < start:
            lo = (rows[-1][1], end+100)
        else:
            hi = (rows[0][1], end-100)
        if lo[1] > hi[1]:
            break
    raise ValueError(f'No dated HyperCore block found on {day}')


def shard_for(day, anchors, dest, receipts):
    filename = f'hype-{day}.json.gz'
    receipt = receipts / (filename+'.receipt')
    path = dest / filename
    if receipt.exists() and path.exists():
        saved = json.loads(receipt.read_bytes())
        if saved['file'] == filename and sha256(path.read_bytes()).hexdigest() == saved['sha256']:
            return saved
    rows, source = day_sample(day, anchors)
    raw = pack(rows)
    shard = {'file':filename, 'start':str(day), 'end':str(day), 'count':len(rows),
             'firstHeight':rows[0][0], 'lastHeight':rows[-1][0], 'firstTime':rows[0][1],
             'lastTime':rows[-1][1], 'sha256':sha256(raw).hexdigest(),
             'encoding':'delta-triples+gzip', 'sources':[source]}
    atomic(path, raw)
    atomic(receipt, encode(shard))
    return shard


def dataset(shards):
    if not shards:
        raise ValueError('No HyperCore explorer samples')
    ordered = sorted(shards, key=lambda x: x['start'])
    ranges = []
    previous = None
    for shard in ordered:
        day = date.fromisoformat(shard['start'])
        if previous and (day <= previous or shard['firstHeight'] <= last):
            raise ValueError('Overlapping HyperCore archive dates or heights')
        if previous and day == previous+DAY:
            ranges[-1]['end'] = str(day)
            ranges[-1]['count'] += shard['count']
        else:
            ranges.append({'start':str(day), 'end':str(day), 'count':shard['count']})
        previous, last = day, shard['lastHeight']
    return {'id':'hype-blocks', 'asset':'HYPE', 'network':'HyperCore',
            'coverageMode':'sampled', 'sampling':'One native explorer pack per covered UTC day (up to 100 blocks)',
            'source':'Hyperliquid HyperCore explorer (AWS Open Data)', 'sourceUrl':REGISTRY,
            'fields':FIELDS, 'count':sum(s['count'] for s in ordered), 'start':ordered[0]['start'],
            'end':ordered[-1]['end'], 'ranges':ranges, 'shards':ordered}


def update_chain(asset, previous_dataset_or_None, dest: Path, until: date):
    if asset != 'HYPE' or until >= datetime.now(UTC).date():
        raise ValueError('Expected HYPE and a completed UTC date')
    previous = previous_dataset_or_None or {}
    if previous and (previous.get('asset'),previous.get('network'),previous.get('coverageMode')) != ('HYPE','HyperCore','sampled'):
        raise ValueError('Incompatible existing HyperCore archive')
    dest = Path(dest)
    existing = {date.fromisoformat(s['start']):s for s in previous.get('shards', [])}
    first, last = extent()
    seeds = {}
    for end in (first, last):
        obj = load_object(end)
        if not obj:
            raise ValueError('HyperCore archive changed during source discovery')
        seeds[end] = obj[0][0][1]
    begin = datetime.fromtimestamp(seeds[first], UTC).date()
    stop = min(until, datetime.fromtimestamp(load_object(last)[0][-1][1], UTC).date())
    needed = [begin + i*DAY for i in range((stop-begin).days+1) if begin+i*DAY not in existing]
    if not needed:
        return dataset(existing.values())
    receipts = dest.parent / ('.'+dest.name+'-hype-checkpoints')
    with ThreadPoolExecutor(max_workers=8) as workers:
        if len(needed)>28:
            def anchor(end):
                probe = nearest_object(end, first, last)
                return (probe[0], probe[1][0][0][1]) if probe else None
            for point in workers.map(anchor, range(25_000_000,last,25_000_000)):
                if point:
                    seeds[point[0]] = point[1]
        for s in existing.values():
            end = ((s['lastHeight']+99)//100)*100
            if s.get('firstTime') and first <= end <= last:
                seeds[end] = s['firstTime']
        anchors = sorted((stamp, h) for h, stamp in seeds.items())
        # Newest first, making recent evidence available even during a long bootstrap.
        jobs = {workers.submit(shard_for,d,anchors,dest,receipts):d for d in reversed(needed)}
        for job in as_completed(jobs):
            existing[jobs[job]] = job.result()
    return dataset(existing.values())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, required=True)
    parser.add_argument('--until', type=date.fromisoformat, default=datetime.now(UTC).date()-DAY)
    opts = parser.parse_args()
    result = opts.dest/'HYPE.dataset.json'
    prior = json.loads(result.read_bytes()) if result.exists() else None
    record = update_chain('HYPE',prior,opts.dest,opts.until)
    atomic(result, encode(record))
    print(f"{record['count']:,} native HyperCore blocks sampled across {len(record['shards']):,} UTC dates ({record['start']} to {record['end']})")
