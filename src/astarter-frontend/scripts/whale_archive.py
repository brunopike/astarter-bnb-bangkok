"""Build an attributed, locally auditable archive of Hyperliquid wallet activity.

Usage: uv run --with duckdb==2.0.1 --with requests scripts/whale_archive.py --root /path/to/archive
Only the compact summary is intended for the frontend.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import time

import requests

REPO = 'Hydromancer/hyperliquid-reservoir'
REVISION = '6b40203b4363771c26d4b1ecfda7dca92263e3d4'
SOURCE = 'https://huggingface.co/datasets/' + REPO
SUBDIR = 'fills_perp/hyperliquid'


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def get_sources(start, end):
    url = f'https://huggingface.co/api/datasets/{REPO}/tree/{REVISION}/{SUBDIR}'
    response = requests.get(url, params={'limit': 1000}, timeout=45)
    response.raise_for_status()
    available = {f['path'].split('_')[-1][:-8]: f for f in response.json() if f['path'].endswith('.parquet')}
    files = []
    day = start
    while day <= end:
        key = day.isoformat()
        f = available[key]
        files.append({'date': key, 'bytes': f['size'], 'sha256': f['lfs']['oid'],
                      'url': f"{SOURCE}/resolve/{REVISION}/{f['path']}"})
        day += timedelta(days=1)
    return files


def fetch_file(root, f):
    dest = root / 'raw' / (f['date'] + '.parquet')
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == f['bytes'] and sha256(dest) == f['sha256']:
        return
    partial = dest.with_suffix('.part')
    for attempt in range(5):
        try:
            with requests.get(f['url'], stream=True, timeout=(30, 120)) as resp:
                resp.raise_for_status()
                with partial.open('wb') as stream:
                    for chunk in resp.iter_content(chunk_size=2**21):
                        stream.write(chunk)
            if partial.stat().st_size != f['bytes'] or sha256(partial) != f['sha256']:
                raise ValueError('Downloaded bytes do not match the pinned LFS object: ' + f['date'])
            partial.replace(dest)
            print('Source verified', f['date'], f['bytes'], flush=True)
            return
        except (requests.RequestException, ValueError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--start', default='2026-11-07', type=date.fromisoformat)
    parser.add_argument('--end', default='2026-11-17', type=date.fromisoformat)
    parser.add_argument('--jobs', type=int, default=5)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--only-download', action='store_true')
    mode.add_argument('--only-analyze', action='store_true')
    parser.add_argument('--summary', type=Path, default=Path(__file__).resolve().parents[1] / 'data/research-archives/whale.json')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.start>args.end or args.jobs<1:
        parser.error('Use a positive worker count and a valid date range.')
    if not args.only_analyze:
        existing = root / 'sources.json'
        if existing.exists():
            recorded = json.loads(existing.read_text())
            dates = [f['date'] for f in recorded['files']]
            if recorded['revision']!=REVISION or dates[0]!=str(args.start) or dates[-1]!=str(args.end):
                parser.error('Choose another archive directory for a different window or revision.')
        sources = get_sources(args.start, args.end)
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            list(pool.map(lambda f: fetch_file(root, f), sources))
        write_json(root / 'sources.json', dict(repository=REPO, revision=REVISION, license='CC BY 4.0',
                   attribution='Hydromancer (https://hydromancer.xyz)', files=sources))
    if not args.only_download:
        from whale_archive_analysis import analyze
        analyze(root, args.summary)


if __name__ == '__main__':
    main()
