"""Append complete UTC Bitcoin, Ethereum and BNB Smart Chain block partitions.

Requires Python 3.11+, requests and pyarrow. The archive counts blocks, including
zero-transaction blocks. S3 LastModified measures publication, not chain time.
The bootstrap starts at 2016-01-01 for BTC/ETH and the first AWS BNB partition.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from itertools import pairwise
import gzip
import importlib.util
import json
from pathlib import Path
import os
import re
import tempfile
from xml.etree import ElementTree

spec = importlib.util.spec_from_file_location('brain_block_import', Path(__file__).with_name('import-brain-blocks.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
DAY = timedelta(days=1)
START = {'BTC': date(2016, 1, 1), 'ETH': date(2016, 1, 1), 'BNB': date(2020, 8, 29)}
RPC = {'ETH': ('https://ethereum-rpc.publicnode.com', 'https://ethereum.drpc.org'),
       'BNB': ('https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com')}
CHAIN_ID = {'ETH': 1, 'BNB': 56}
_readers = ThreadPoolExecutor(max_workers=16)


class IncompleteDay(ValueError):
    """The upstream daily export or its independent chain boundary is not complete."""


def list_days(asset, start, end):
    version = 'v1.1' if asset == 'BNB' else 'v1.0'
    prefix = f'{version}/{asset.lower()}/blocks/date='
    pattern = r'blocks\.parquet' if asset == 'BNB' else r'part-\d+-[\da-f-]+-c\d+\.snappy\.parquet'
    parts = {}
    query = {'list-type': 2, 'prefix': prefix, 'start-after': prefix + start.isoformat()}
    while True:
        response = archive.session().get(archive.BUCKET, params=query, timeout=40)
        response.raise_for_status()
        xml = ElementTree.fromstring(response.content)
        for item in xml.findall('{*}Contents'):
            key = item.findtext('{*}Key')
            day_string, _, name = key[len(prefix):].partition('/')
            day = date.fromisoformat(day_string)
            if day > end:
                return parts
            if day < start or not re.fullmatch(pattern, name):
                continue  # Intraday per-height exports are not settled daily partitions.
            size = int(item.findtext('{*}Size'))
            etag = item.findtext('{*}ETag').strip('"')
            modified = item.findtext('{*}LastModified')
            published = datetime.fromisoformat(modified.replace('Z', '+00:00'))
            if published.date() <= day or size <= 0 or not re.fullmatch(r'[0-9a-f]{32}(?:-\d+)?', etag):
                raise IncompleteDay(f'Unsettled AWS {asset} source for {day}')
            parts.setdefault(day, []).append({'url': f'{archive.BUCKET}/{key}', 'etag': etag,
                                              'bytes': size, 'lastModified': modified})
        cursor = xml.findtext('{*}NextContinuationToken')
        if not cursor:
            return parts
        query = {'list-type': 2, 'prefix': prefix, 'continuation-token': cursor}


def eth_header(asset, height):
    errors = []
    for url in RPC[asset]:
        try:
            commands = [{'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []},
                        {'jsonrpc': '2.0', 'id': 2, 'method': 'eth_getBlockByNumber', 'params': [hex(height), False]}]
            response = archive.session().post(url, json=commands, timeout=18)
            response.raise_for_status()
            replies = {a['id']: a['result'] for a in response.json()}
            block = replies[2]
            if int(replies[1], 16) != CHAIN_ID[asset] or int(block['number'], 16) != height:
                raise ValueError('Wrong chain or height')
            if not re.fullmatch(r'0x[0-9a-f]{64}', block['hash']):
                raise ValueError('Invalid block hash')
            return {'height': height, 'timestamp': int(block['timestamp'], 16),
                    'hash': block['hash'], 'source': url}
        except (ValueError, KeyError, TypeError, archive.requests.RequestException) as e:
            errors.append(str(e))
    raise IncompleteDay(f'{asset} canonical header {height} unavailable: {errors}')


def btc_window(ending):
    for base in ('https://mempool.space/api', 'https://mempool.emzy.de/api'):
        try:
            response = archive.session().get(f'{base}/v1/blocks/{ending}', timeout=18)
            response.raise_for_status()
            result = {}
            for b in response.json():
                if not re.fullmatch('[0-9a-f]{64}', b['id']):
                    raise ValueError('Bad Bitcoin hash')
                result[b['height']] = {'height': b['height'], 'timestamp': b['timestamp'],
                                       'medianTime': b['mediantime'], 'hash': b['id'], 'source': base}
            if ending not in result or set(result) != set(range(min(result), ending+1)):
                raise ValueError('Incomplete header window')
            return result
        except (ValueError, KeyError, TypeError, archive.requests.RequestException):
            continue
    raise IncompleteDay(f'Bitcoin canonical header window ending at {ending} unavailable')


def day_start(day):
    return (day - date(1970, 1, 1)).days * 86400


def verify_btc(day, rows, prior_height=None):
    """Verify real gaps, miners' non-monotone clocks, and the trailing time boundary."""
    start = day_start(day)
    end = start + 86400
    present = {h: ts for h, ts, _ in rows}
    first, last = rows[0][0], rows[-1][0]
    lower = max(0, min(first-11, prior_height+1 if prior_height is not None else first-11))
    if last-lower > len(rows)+4096:
        raise IncompleteDay('Implausible Bitcoin height gap')
    requested = [h for h in range(lower, last+1) if h not in present] + [first, last]
    seen = {}
    for h in sorted(set(requested), reverse=True):
        if h not in seen:
            seen.update(btc_window(h))
        ts = seen[h]['timestamp']
        if (h in present and present[h] != ts) or (h not in present and start <= ts < end):
            raise IncompleteDay(f'Missing or conflicting canonical Bitcoin block {h} for {day}')
    # Once MTP reaches the following midnight, future valid headers cannot be
    # timestamped inside this day. Check every intervening header, not just its tip.
    next_height = last+1
    for _ in range(40):
        group = btc_window(next_height+9)
        for h in range(next_height, next_height+10):
            if h not in group:
                raise IncompleteDay(f'Bitcoin successor {h} missing')
            current = group[h]
            if start <= current['timestamp'] < end:
                raise IncompleteDay(f'Bitcoin partition omits next block {h}')
            if current['medianTime'] >= end:
                return current
        next_height += 10
    raise IncompleteDay('Bitcoin day-end median time has not settled')


def write_once(path, content):
    """No overwrite: a racing importer must have produced byte-identical data."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name+'.', suffix='.tmp') as tmp:
        os.fchmod(tmp.fileno(), 0o644)
        tmp.write(content)
        tmp.flush()
        try:
            os.link(tmp.name, path)
        except FileExistsError:
            if path.read_bytes() != content:
                raise ValueError('Existing immutable shard differs: ' + str(path))


def projected_ranges(metadata):
    # Historical BSC Parquet often puts time and transaction count at the end
    # of one group, followed by the next group's block numbers a few bytes later.
    intervals = []
    for i in range(metadata.num_row_groups):
        group = metadata.row_group(i)
        for j in range(group.num_columns):
            col = group.column(j)
            if col.path_in_schema in archive.COLUMNS:
                offset = col.dictionary_page_offset if col.has_dictionary_page else col.data_page_offset
                intervals.append((offset, offset+col.total_compressed_size))
    merged = []
    for start, end in sorted(intervals):
        if merged and start-merged[-1][1] <= 2048:
            merged[-1] = (merged[-1][0], max(merged[-1][1],end))
        else:
            merged.append((start,end))
    return merged


def extract_bnb(sources, day):
    if len(sources) != 1:
        raise IncompleteDay(f'Expected one consolidated BNB partition for {day}')
    source = sources[0]
    reader = archive.ColumnReader(source)
    parquet = archive.parquet.ParquetFile(reader)
    footer = tuple(reader.parts)
    def fetch(interval):
        start, end = interval
        for off, chunk in footer:
            if off <= start and end <= off+len(chunk):
                return start, chunk[start-off:end-off]
        separate = archive.ColumnReader(source)
        separate.seek(start)
        return start, separate.read(end-start)
    reader.parts.extend(_readers.map(fetch, projected_ranges(parquet.metadata)))
    table = parquet.read(columns=archive.COLUMNS, use_threads=False)
    heights, times, counts = table.columns
    times = times.cast(archive.pa.timestamp('s')).cast(archive.pa.int64())
    rows = sorted(zip(heights.to_pylist(),times.to_pylist(),counts.to_pylist(),strict=True))
    utc = day_start(day)
    if not rows or any(type(h) is not int or type(t) is not int or type(n) is not int
                       or h < 0 or n < 0 or not utc <= t < utc+86400 for h,t,n in rows):
        raise IncompleteDay(f'Invalid BNB records or partition time for {day}')
    return rows


def capture(asset, day, sources, dest, previous_height=None, prove_btc=True):
    rows = extract_bnb(sources, day) if asset == 'BNB' else archive.extract(sources, day)
    first, last = rows[0], rows[-1]
    proof = None
    if asset == 'BTC':
        if prove_btc:
            proof = verify_btc(day, rows, previous_height)
    elif any(b[0] != a[0]+1 or b[1] < a[1] for a,b in pairwise(rows)):
        raise IncompleteDay(f'{asset} height gap or reversed block time on {day}')
    data = archive.packed(rows)
    name = f'{asset.lower()}-{day}.json.gz'
    shard = {'file': name, 'start': str(day), 'end': str(day), 'count': len(rows),
             'firstHeight': first[0], 'lastHeight': last[0], 'sha256': sha256(data).hexdigest(),
             'encoding': archive.ENCODING, 'sources': sources}
    if proof:
        shard['dayEndHeader'] = proof
    write_once(dest/name, data)
    return shard


def check_evm_edges(asset, fresh, prior):
    """Adjacent UTC partitions corroborate all interior day boundaries."""
    low, high = fresh[0], fresh[-1]
    expected = prior['lastHeight']+1 if prior else low['firstHeight']
    for sh in fresh:
        if sh['firstHeight'] != expected or sh['lastHeight']-sh['firstHeight']+1 != sh['count']:
            raise IncompleteDay(f"{asset} discontinuity before {sh['start']}")
        expected = sh['lastHeight']+1
    if low['firstHeight'] > 0:
        before = eth_header(asset, low['firstHeight']-1)
        if before['timestamp'] >= day_start(date.fromisoformat(low['start'])):
            raise IncompleteDay(f'{asset} first UTC day is missing earlier blocks')
        low['dayStartPredecessor'] = before
    after = eth_header(asset, high['lastHeight']+1)
    if after['timestamp'] < day_start(date.fromisoformat(high['end'])+DAY):
        raise IncompleteDay(f'{asset} last UTC day is missing later blocks')
    high['dayEndSuccessor'] = after


def combine(asset, previous, fresh):
    shards = list((previous or {}).get('shards', [])) + fresh
    ranges = [dict(r) for r in (previous or {}).get('ranges', [])]
    for sh in fresh:
        if ranges and date.fromisoformat(ranges[-1]['end'])+DAY == date.fromisoformat(sh['start']):
            ranges[-1]['end'] = sh['end']
            ranges[-1]['count'] += sh['count']
        else:
            ranges.append({k: sh[k] for k in ('start', 'end', 'count')})
    return {**(previous or {}), 'id': asset.lower()+'-blocks', 'asset': asset,
            'source': 'AWS Public Blockchain', 'sourceUrl': archive.REGISTRY, 'fields': archive.FIELDS,
            'coverageMode':'full','heightKind':'height',
            'count': sum(s['count'] for s in shards), 'start': shards[0]['start'], 'end': shards[-1]['end'],
            'ranges': ranges, 'shards': shards}


def update_chain(asset, previous_dataset_or_None, dest: Path, until: date):
    """Append settled partitions through an inclusive UTC date; never replace a release."""
    previous = previous_dataset_or_None
    if asset not in START or (previous is not None and previous.get('asset') != asset):
        raise ValueError('Wrong chain for daily archive')
    until = min(until, datetime.now(timezone.utc).date()-DAY)
    start = date.fromisoformat(previous['end'])+DAY if previous else START[asset]
    if start > until:
        if previous is not None:
            return previous
        raise IncompleteDay(f'No completed {asset} days before {start}')
    dates = [start + i*DAY for i in range((until-start).days+1)]
    sources = list_days(asset, start, until)
    missing = next((d for d in dates if not sources.get(d)), None)
    if missing is not None:
        if missing == start or any(d > missing and src for d, src in sources.items()):
            raise IncompleteDay(f'{asset} consolidated AWS partition is unavailable for {missing}')
        # Backlog recovery can still publish every complete day before a trailing
        # export that the provider has not published. The returned end stays exact.
        dates = [d for d in dates if d < missing]
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    prior = previous['shards'][-1] if previous else None
    if asset == 'BTC' and len(dates) == 1:
        fresh = [capture(asset, start, sources[start], dest, prior['lastHeight'] if prior else None)]
    elif asset == 'BTC':
        # Verify the entire contiguous height range once. Its UTC edge days need
        # independent checks; interior days already reconcile against both neighbors.
        with ThreadPoolExecutor(max_workers=6) as pool:
            fresh = list(pool.map(lambda d: capture(asset, d, sources[d], dest, prove_btc=False), dates))
        archive.verify_chain(dest, 'btc', fresh)
        for idx, previous_height in ((0, prior['lastHeight'] if prior else None), (-1, fresh[-2]['lastHeight'])):
            sh = fresh[idx]
            payload = json.loads(gzip.decompress((dest/sh['file']).read_bytes()))
            rows = list(archive.date_rows(payload, True))
            sh['dayEndHeader'] = verify_btc(date.fromisoformat(sh['start']), rows, previous_height)
    else:
        with ThreadPoolExecutor(max_workers=4) as p:
            fresh = list(p.map(lambda d: capture(asset, d, sources[d], dest), dates))
        check_evm_edges(asset, fresh, prior)
    return combine(asset, previous, fresh)
