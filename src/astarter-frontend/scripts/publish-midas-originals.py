"""Verify and mirror the SEC's original quarterly security-by-exchange ZIPs as immutable assets."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from zipfile import ZipFile

REPO = 'brunopike/astarter-bnb-bangkok'
TAG = 'tradfi-sec-midas'
INDEX = 'https://www.sec.gov/data-research/sec-markets-data/market-structure-data-security-exchange'
SERIES = ('sec-midas-equities', 'sec-midas-etp')
TITLE = 'SEC MIDAS · original quarterly security-by-exchange files'
NOTES = ('Original ZIPs published by the U.S. Securities and Exchange Commission for its '
         f'[Metrics by Individual Security and Exchange]({INDEX}) series. The quarterly files contain '
         'aggregated market-activity metrics. Equities and exchange-traded products share each original '
         'ZIP. Filenames include the quarter and the first 16 digits of the complete file SHA-256. '
         'A revised source file receives a new filename. See the frontend market catalog for full '
         'checksums, record definitions and data-quality notes.')
DOWNLOAD_LOCK = threading.Lock()
NEXT_REQUEST = 0.0


@dataclass(frozen=True)
class Original:
    quarter: str
    url: str
    size: int
    sha256: str

    @property
    def filename(self):
        return f'sec-midas-{self.quarter.lower()}-{self.sha256[:16]}.zip'


def secure_source(url):
    parts = urlsplit(url)
    return (parts.scheme == 'https' and parts.netloc == 'www.sec.gov' and not parts.query and
            not parts.fragment and parts.path.startswith('/files/') and parts.path.lower().endswith('.zip'))


def records(root, draft_only=False):
    indices = []
    catalog = root / 'catalog.json'
    reference = None
    if catalog.is_file() or not draft_only:
        series_metadata = json.loads(catalog.read_bytes())['series']
        reference = {entry['id']:entry for entry in series_metadata if entry['id'] in SERIES}
        if len(reference) != 2:raise ValueError('Missing SEC MIDAS series in the market catalog')
    for series in SERIES:
        raw = (root / (series + '.json')).read_bytes()
        if reference and hashlib.sha256(raw).hexdigest() != reference[series]['sha256']:
            raise ValueError(f'{series} index checksum differs from its market catalog')
        doc = json.loads(raw)
        if doc.get('id') != series:
            raise ValueError(f'Unexpected series ID in {series}')
        quarters = {}
        for row in doc['quarters']:
            item = Original(row['quarter'],row['url'],row['size'],row['sha256'])
            if not (re.fullmatch(r'20\d{2}Q[1-4]', item.quarter) and secure_source(item.url) and
                    re.fullmatch(r'[0-9a-f]{64}',item.sha256) and type(item.size) is int and
                    0 < item.size < 2**31 and type(row['count']) is int and row['count'] > 0):
                raise ValueError(f'Invalid source receipt for {series} {item.quarter}')
            if item.quarter in quarters:
                raise ValueError(f'Duplicate {series} {item.quarter}')
            quarters[item.quarter] = item
        if reference and sum(q['count'] for q in doc['quarters']) != reference[series]['count']:
            raise ValueError(f'{series} counts differ from its market catalog')
        indices.append(quarters)
    if not indices[0] or indices[0] != indices[1]:
        raise ValueError('Stock and ETP indexes must refer to exactly the same quarterly originals')
    ordered = sorted(indices[0]); first, last = ordered[0], ordered[-1]
    if not draft_only:
        expected = [f'{year}Q{quarter}' for year in range(2016,int(last[:4])+1) for quarter in range(1,5)
                    if f'{year}Q{quarter}' <= last]
        if first != '2016Q1' or last < '2026Q3' or ordered != expected:
            raise ValueError('Published history must include every quarter from 2016Q1, including the initial 43 quarters')
    return [indices[0][k] for k in ordered]


def gh(*args):
    env = {**os.environ,'GH_PROMPT_DISABLED':'1'}
    return subprocess.run(['gh',*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env).stdout


def release(may_create):
    args = ('release','view',TAG,'--repo',REPO,'--json','databaseId,isDraft,tagName')
    try:
        return json.loads(gh(*args))
    except subprocess.CalledProcessError as error:
        if not may_create or 'release not found' not in error.stderr.decode().lower():
            raise
    # An overlapping invocation can win the initial creation; verify by tag afterwards.
    try:
        gh('release','create',TAG,'--repo',REPO,'--target','main','--draft','--latest=false','--title',TITLE,'--notes',NOTES)
    except subprocess.CalledProcessError:
        return json.loads(gh(*args))
    return json.loads(gh(*args))


def assets(release_id):
    pages = json.loads(gh('api','--paginate','--slurp',f'repos/{REPO}/releases/{release_id}/assets?per_page=100'))
    return {a['name']:a for page in pages for a in page}


def matches(item, asset):
    if asset is None:
        return False
    if (asset['state'],asset['size'],asset.get('digest')) != ('uploaded',item.size,'sha256:'+item.sha256):
        raise ValueError(f'Existing asset has different contents or incomplete upload: {item.filename}')
    return True


def verify_file(path,item):
    if path.stat().st_size != item.size:
        raise ValueError(f'Unexpected size for {item.quarter}')
    with path.open('rb') as source:
        if hashlib.file_digest(source,'sha256').hexdigest() != item.sha256:
            raise ValueError(f'Unexpected SHA-256 for {item.quarter}')
    with ZipFile(path) as archive:
        if not any(i.filename.lower().endswith('.csv') and i.file_size>0 for i in archive.infolist()):
            raise ValueError(f'No CSV files in {item.quarter}')


def polite_request():
    global NEXT_REQUEST
    with DOWNLOAD_LOCK:
        time.sleep(max(0,NEXT_REQUEST-time.monotonic()))
        NEXT_REQUEST = time.monotonic()+0.5


def download(item,path):
    ua = os.environ.get('SEC_USER_AGENT') or 'Astarter public financial research (https://dapp.ipfund.art)'
    for attempt in range(3):
        polite_request()
        try:
            with urlopen(Request(item.url,headers={'User-Agent':ua}),timeout=90) as response:
                if not secure_source(response.geturl()):
                    raise ValueError('SEC source unexpectedly redirected outside its file archive')
                written = 0
                with path.open('wb') as dest:
                    while chunk := response.read(1024*1024):
                        written += len(chunk)
                        if written>item.size:raise ValueError('SEC file exceeds its indexed size')
                        dest.write(chunk)
            verify_file(path,item)
            return
        except HTTPError as error:
            if error.code not in (429,500,502,503,504) or attempt>=2:raise
            wait=error.headers.get('Retry-After','')
            if wait.isdigit() and int(wait)>120:raise
            time.sleep(int(wait) if wait.isdigit() else 2**(attempt+1))
        except (TimeoutError,URLError,ConnectionError) as error:
            if attempt>=2:raise
            time.sleep(2**(attempt+1))


def upload(item,cache,release_id):
    with tempfile.TemporaryDirectory() as tmp:
        target=Path(tmp)/item.filename
        # Accept a generic SEC cache file only if it matches the pinned revision.
        cached=None
        if cache:
            for name in (item.filename,item.quarter+'.zip'):
                candidate=cache/name
                if not candidate.is_file():continue
                try:verify_file(candidate,item)
                except ValueError:
                    if name==item.filename:raise
                    continue
                cached=candidate;break
        if cached:
            try:os.link(cached,target)
            except OSError:shutil.copyfile(cached,target)
        else:download(item,target)
        for attempt in range(3):
            try:
                gh('release','upload',TAG,str(target),'--repo',REPO)
                break
            except subprocess.CalledProcessError:
                # A completed concurrent upload is acceptable only if its digest and size agree.
                if matches(item,assets(release_id).get(item.filename)):break
                if attempt>=2:raise
                time.sleep(2**(attempt+1))
        print(f'{item.quarter} uploaded: {item.size:,} bytes',flush=True)


def publish(root,cache,draft_only,check_only,jobs):
    items=records(root,draft_only);info=release(not check_only)
    if info['tagName']!=TAG:raise ValueError('Incorrect target release')
    if draft_only and not info['isDraft']:raise ValueError('The initial staging release is already public')
    release_id=info['databaseId'];existing=assets(release_id)
    missing=[item for item in items if not matches(item,existing.get(item.filename))]
    if check_only and missing:raise ValueError(f'{len(missing)} expected files are missing')
    if missing:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            list(pool.map(lambda item:upload(item,cache,release_id),missing))
        existing=assets(release_id)
    if not all(matches(item,existing.get(item.filename)) for item in items):raise ValueError('Missing a verified original')
    if info['isDraft'] and not (draft_only or check_only):
        gh('release','edit',TAG,'--repo',REPO,'--draft=false','--latest=false')
        if release(False)['isDraft']:raise ValueError('Data release is still a draft')
    print(f'{len(items)} verified original ZIPs, {sum(i.size for i in items):,} bytes',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path('brain-evidence/tradfi'))
    parser.add_argument('--cache',type=Path,help='Optional directory with unmodified SEC ZIP downloads')
    parser.add_argument('--draft-only',action='store_true',help='Stage already verified quarters during the initial import')
    parser.add_argument('--check-only',action='store_true',help='Inspect the remote files without uploading or publishing')
    parser.add_argument('--jobs',type=int,choices=range(1,5),default=2)
    args=parser.parse_args()
    try:publish(args.root,args.cache,args.draft_only,args.check_only,args.jobs)
    except subprocess.CalledProcessError as error:
        sys.exit(error.stderr.decode().strip() or 'GitHub CLI request failed')
