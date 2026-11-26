#!/usr/bin/env python3
"""Atomically publish each verified chain update into the static Brain archive.

Run with Python 3.11+, requests, pyarrow, lz4 and msgpack. For a prepared build,
pass --prepared-dir containing evm/, sol/ and hyper/ with {ASSET}.dataset.json.
A failed chain retains its previous dataset and the overall command exits nonzero.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
import fcntl
import gzip
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

import brain_daily_evm as evm

DEFAULT_ROOT = Path(__file__).resolve().parents[1]/'brain-evidence'/'archive'
DIRECTORY = {'BTC':'evm', 'ETH':'evm', 'BNB':'evm', 'SOL':'sol', 'HYPE':'hyper'}
DAY = timedelta(days=1)


def read_json(path):
    return json.loads(path.read_bytes())


def integer(n):
    return type(n) is int


def lines_info(ds, asset):
    if ds.get('asset') != asset or not ds.get('shards'):
        raise ValueError(f'Missing or incorrect {asset} dataset')
    ranges = []
    previous = None
    previous_height = None
    for sh in ds['shards']:
        day = date.fromisoformat(sh['start'])
        if (day.isoformat() != sh['start'] or sh['end'] != sh['start'] or
                (previous is not None and day <= previous)):
            raise ValueError(f'Invalid or duplicate {asset} UTC date: {day}')
        gzip_shard = sh.get('encoding') == evm.archive.ENCODING
        expected = f"{asset.lower()}-{day}.json" + ('.gz' if gzip_shard else '')
        if (sh['file'] != expected or sh.get('encoding') not in (None, evm.archive.ENCODING) or
                not re.fullmatch('[0-9a-f]{64}', sh['sha256']) or not sh.get('sources')):
            raise ValueError('Invalid filename, hash, encoding or provenance for '+expected)
        if (not all(integer(sh[k]) for k in ('count','firstHeight','lastHeight')) or sh['count'] < 1
                or sh['firstHeight'] < 0 or sh['lastHeight']-sh['firstHeight']+1 < sh['count']):
            raise ValueError('Invalid coverage for '+expected)
        if previous_height is not None and asset != 'BTC':
            if sh['firstHeight'] <= previous_height:
                raise ValueError('Overlapping heights for '+expected)
            if asset in ('ETH', 'BNB') and day == previous+DAY and sh['firstHeight'] != previous_height+1:
                raise ValueError('Unaccounted complete-chain height before '+expected)
        if previous and day == previous+DAY:
            ranges[-1].update(end=str(day), count=ranges[-1]['count']+sh['count'])
        else:
            ranges.append({'start':str(day),'end':str(day),'count':sh['count']})
        previous, previous_height = day, sh['lastHeight']
    if (ds.get('ranges') != ranges or ds.get('start') != ranges[0]['start']
            or ds.get('end') != ranges[-1]['end'] or ds.get('count') != sum(r['count'] for r in ranges)):
        raise ValueError('Dataset totals or ranges do not reconcile for '+asset)
    return {s['start']:s for s in ds['shards']}


def validate_rows(raw, sh):
    packed = sh.get('encoding') == evm.archive.ENCODING
    data = json.loads(gzip.decompress(raw) if packed else raw)
    expected_day = (date.fromisoformat(sh['start'])-date(1970,1,1)).days
    start = None
    previous = -1
    count = 0
    for h, ts, txs in evm.archive.date_rows(data, packed):
        if (type(h) is not int or type(ts) is not int or type(txs) is not int
                or h <= previous or ts//86400 != expected_day or txs < 0):
            raise ValueError('Invalid block row in '+sh['file'])
        if start is None:
            start = h
        previous = h
        count += 1
    if (start,previous,count) != (sh['firstHeight'],sh['lastHeight'],sh['count']):
        raise ValueError('Block heights or count differ in '+sh['file'])


def regular_file(path):
    return path.is_file() and not path.is_symlink()


def verified_files(ds, prior, root, incoming, until):
    asset = ds['asset']
    by_day = lines_info(ds, asset)
    if date.fromisoformat(ds['end']) > until and (not prior or ds['end'] > prior['end']):
        raise ValueError(f'{asset} includes an open or unrequested UTC date')
    known = lines_info(prior, asset) if prior else {}
    for d, sh in known.items():
        if by_day.get(d) != sh:
            raise ValueError('Previously published block metadata changed: '+sh['file'])
    to_copy = []
    for d, sh in by_day.items():
        final = root/sh['file']
        if final.is_symlink():
            raise ValueError('Refusing a symlinked archive object: '+sh['file'])
        candidate = incoming/sh['file']
        if final.exists():
            source = final
        elif regular_file(candidate):
            source = candidate
        elif root != DEFAULT_ROOT and regular_file(DEFAULT_ROOT/sh['file']):
            source = DEFAULT_ROOT/sh['file']
        else:
            raise ValueError('Missing shard: '+sh['file'])
        if not regular_file(source):
            raise ValueError('Expected a regular file: '+sh['file'])
        raw = source.read_bytes()
        if sha256(raw).hexdigest() != sh['sha256']:
            raise ValueError('SHA-256 mismatch: '+sh['file'])
        if d not in known:
            validate_rows(raw, sh)
        if source != final:
            to_copy.append((source, final, sh['sha256']))
    return to_copy


def live_dataset(asset, prior, root, stage, until):
    if prior:
        prior_days = lines_info(prior, asset)
        if date.fromisoformat(prior['end']) >= until and len(prior['ranges']) == 1:
            return prior
        for sh in prior_days.values():
            src = root/sh['file']
            if not regular_file(src):
                raise ValueError('Previous shard unavailable: '+sh['file'])
            try:
                os.link(src,stage/sh['file'])
            except OSError:
                shutil.copyfile(src, stage/sh['file'])
    if asset in ('BTC', 'ETH', 'BNB'):
        fn = evm.update_chain
    elif asset == 'SOL':
        from brain_daily_sol import update_chain as fn
    else:
        from brain_daily_hyper import update_chain as fn
    return fn(asset, prior, stage, until)


def install_files(copies):
    created = []
    try:
        for src, dst, digest in copies:
            raw = src.read_bytes()
            if sha256(raw).hexdigest() != digest:
                raise ValueError('Source changed during import: '+src.name)
            was_present = dst.exists()
            evm.write_once(dst, raw)
            if not was_present:
                created.append((dst,digest))
    except Exception:
        for dst, digest in created:
            if regular_file(dst) and sha256(dst.read_bytes()).hexdigest() == digest:
                dst.unlink()
        raise


def archive_summary(manifest):
    return {'schemaVersion':manifest['schemaVersion'], 'count':manifest['count'],
            'accessedOn':manifest['accessedOn'],
            'datasets':[{k:v for k,v in ds.items() if k != 'shards'} for ds in manifest['datasets']]}


def publish(root, prepared, until, assets):
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest_path, summary_path = root/'manifest.json', root/'summary.json'
    old = read_json(manifest_path) if manifest_path.exists() else None
    if old and old.get('schemaVersion') != 1:
        raise ValueError('Unexpected archive version')
    indexed = {d['asset']:d for d in (old or {}).get('datasets',[])}
    if old and len(indexed) != len(old['datasets']):
        raise ValueError('Duplicate assets in previous archive')
    failures = []
    with tempfile.TemporaryDirectory(prefix='brain-chain-stage-') as tmp:
        stage_dir = Path(tmp)
        for asset in assets:
            try:
                prior = indexed.get(asset)
                if prepared:
                    incoming = prepared/DIRECTORY[asset]
                    meta = incoming/(asset+'.dataset.json')
                    if incoming.is_symlink() or not regular_file(meta):
                        raise ValueError('Missing prepared dataset: '+str(meta))
                    ds = read_json(meta)
                    if ds.get('asset') != asset:
                        raise ValueError('Prepared asset mismatch')
                else:
                    incoming = stage_dir/asset.lower()
                    incoming.mkdir()
                    ds = live_dataset(asset, prior, root, incoming, until)
                if asset in ('BTC','ETH','BNB'):
                    ds = {**ds,'coverageMode':'full','heightKind':'height'}
                copies = verified_files(ds, prior, root, incoming, until)
                install_files(copies)
                indexed[asset] = ds
                print(f"{asset}: {ds['count']:,} block records through {ds['end']}", flush=True)
                if date.fromisoformat(ds['end']) < until:
                    failures.append(f"{asset}: latest verified upstream day is {ds['end']}; requested {until}")
            except Exception as exc:
                failures.append(f'{asset}: {exc}')
    if indexed:
        manifest = dict(old or {'schemaVersion':1,'sourceUrl':evm.archive.REGISTRY,'licenseUrl':evm.archive.LICENSE})
        ordered = [indexed[a] for a in [*DIRECTORY, *(a for a in indexed if a not in DIRECTORY)] if a in indexed]
        changed = not old or ordered != old['datasets']
        if any(ds['asset'] in ('SOL','HYPE') for ds in ordered):
            # Registry and example-code license were global in the two-chain
            # legacy manifest. The expanded archive attributes providers per asset.
            manifest.pop('sourceUrl', None)
            manifest.pop('licenseUrl', None)
        manifest.update(datasets=ordered, count=sum(d['count'] for d in ordered))
        if changed:
            manifest['accessedOn'] = datetime.now(timezone.utc).date().isoformat()
        if changed or manifest != old:
            evm.archive.atomic_write(manifest_path, evm.archive.json_bytes(manifest))
        summary = evm.archive.json_bytes(archive_summary(manifest))
        if not summary_path.exists() or summary_path.read_bytes() != summary:
            evm.archive.atomic_write(summary_path, summary)
    for error in failures:
        print(error, file=sys.stderr, flush=True)
    return int(bool(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT, help='Archive directory with manifest and shards')
    parser.add_argument('--prepared-dir', type=Path, help='Prepared chain exports, one directory per adapter')
    parser.add_argument('--until', type=date.fromisoformat, default=datetime.now(timezone.utc).date()-DAY)
    parser.add_argument('--assets', nargs='+', choices=DIRECTORY, default=list(DIRECTORY))
    opts = parser.parse_args()
    if opts.until >= datetime.now(timezone.utc).date():
        parser.error('Only completed UTC days can be published')
    key = sha256(os.fsencode(opts.root.resolve())).hexdigest()[:16]
    with (Path(tempfile.gettempdir())/('brain-chains-'+key+'.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return publish(opts.root, opts.prepared_dir, opts.until, list(dict.fromkeys(opts.assets)))


if __name__ == '__main__':
    sys.exit(main())
