"""Merge dated, variety- and grade-specific AGMARKNET ranges from the public OGD mirror."""
import argparse
from collections import Counter, defaultdict
import csv
import io
import tarfile
import fcntl
from datetime import date, timedelta
import hashlib
import json
import math
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory

import requests

from brain_tradfi import mirror_revision
from brain_tradfi_mandi import CROPS, LICENSE, make_shard, store
from brain_tradfi_mandi_live import PRODUCTS

REPO='vivekg7/mandi'
RESOURCE='9ef84268-d588-465a-a308-a864a43d0070'
SOURCE='https://data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi'
CSV_REPO='kunal-rajput-317/mandi-data'
CSV_COMMIT='0960f76c6eac29442bcac5a8b27af82d8a9af4b4'
CSV_SOURCE={'mirror':'KrashiMitra','mirrorUrl':'https://krashimitra.in',
    'attribution':'Mandi price data via KrashiMitra, sourced from AGMARKNET / data.gov.in.',
    'sourceUrl':SOURCE,'resourceId':RESOURCE,'license':'CC BY 4.0','licenseUrl':'https://creativecommons.org/licenses/by/4.0/',
    'underlyingLicense':'Government Open Data License – India','underlyingLicenseUrl':LICENSE,
    'changes':'Selected commodities and complete variety/grade ranges; validated prices, deduplicated records and encoded monthly files.'}
NAMES={k:v[0] for k,v in CROPS.items()} | {k:v[1] for k,v in PRODUCTS.items()}


def download(revision=None):
    if not revision:
        revision=mirror_revision(REPO, 'data')
    if not re.fullmatch('[0-9a-f]{40}',revision):
        raise ValueError('Invalid immutable mirror commit')
    endpoint=f'https://codeload.github.com/{REPO}/tar.gz/{revision}'
    reply=requests.get(endpoint,timeout=(5,60))
    reply.raise_for_status()
    prefix='mandi-'+revision+'/'
    with tarfile.open(fileobj=io.BytesIO(reply.content),mode='r:gz') as archive:
        def fetch(path):
            member=archive.getmember(prefix+path)
            if not member.isfile() or member.size>25_000_000:
                raise ValueError('Unexpected state file')
            return json.load(archive.extractfile(member))
        index=fetch('index.json')
        if index.get('v')!=1 or index.get('source')!='data.gov.in resource '+RESOURCE:
            raise ValueError('Unexpected OGD dataset')
        states=index['states']
        if not states or len({s['slug'] for s in states})!=len(states):
            raise ValueError('Incomplete or duplicated state index')
        content=[]
        for state in states:
            slug=state['slug']
            if not re.fullmatch('[a-z-]+',slug):
                raise ValueError('Unexpected state identifier')
            doc=fetch('states/'+slug+'.json')
            if (doc.get('v')!=1 or doc.get('state')!=state['name'] or doc['generated']!=index['generated']
                    or len(doc['rows'])!=state['rows'] or not doc['rows']
                    or max(r[5] for r in doc['rows'])!=state['latest']):
                raise ValueError('Mismatched state snapshot: '+slug)
            content.append(doc)
        return revision,content


def csv_states(archive,revision):
    names=['date','state','district','market','commodity','variety','grade','min_price','max_price','modal_price']
    states=defaultdict(list)
    pattern=re.compile(r'mandi-data-'+re.escape(revision)+r'/data/(\d{4})/(\d{2})/(\d{4}-\d{2}-\d{2})\.csv')
    dates=set()
    for member in archive:
        match=pattern.fullmatch(member.name)
        if not match:continue
        yr,month,stamp=match.groups()
        if not member.isfile() or member.size>25_000_000 or stamp[:7]!=yr+'-'+month or stamp in dates:
            raise ValueError('Invalid dated market file')
        dates.add(stamp)
        if date.fromisoformat(stamp)<=date(2026,4,20):
            continue
        reader=csv.DictReader(io.TextIOWrapper(archive.extractfile(member),encoding='utf-8-sig',newline=''))
        if reader.fieldnames!=names:
            raise ValueError('Unexpected dated agricultural CSV header')
        for row in reader:
            if row['date']!=stamp:
                raise ValueError('CSV arrival date differs from its published day')
            if row['commodity'] not in NAMES:
                continue
            identity=[row[k] for k in ['district','market','commodity','variety','grade','date']]
            prices=[]
            for k in ['min_price','max_price','modal_price']:
                try:
                    x=float(row[k]); prices.append(int(x) if x.is_integer() else x)
                except (TypeError,ValueError):
                    prices.append(None)
            states[row['state']].append([*identity,*prices,None,None])
    return [{'state':state,'rows':rows} for state,rows in states.items()]


def download_csv(revision=CSV_COMMIT):
    if not re.fullmatch('[0-9a-f]{40}',revision):
        raise ValueError('Invalid fixed CSV mirror commit')
    reply=requests.get(f'https://codeload.github.com/{CSV_REPO}/tar.gz/{revision}',timeout=(5,90))
    reply.raise_for_status()
    with tarfile.open(fileobj=io.BytesIO(reply.content),mode='r:gz') as archive:
        return csv_states(archive,revision)


def observations(states,until):
    quotes=defaultdict(dict)
    conflicts=set()
    stats=Counter()
    skipped={'','-','--','n/a','na','null','unknown','unspecified'}
    for item in states:
        state=item['state']
        for row in item['rows']:
            if not isinstance(row,list) or len(row)!=11:
                raise ValueError('Unrecognized OGD mirror row')
            district,venue,crop,variety,grade,stamp,low,high,modal,_,_=row
            slug=NAMES.get(crop)
            if not slug:
                continue
            day=date.fromisoformat(stamp)
            if day>until:
                stats['afterCutoff']+=1
                continue
            parts=[state,district,venue,variety,grade]
            if not all(isinstance(p,str) and p.strip().casefold() not in skipped for p in parts):
                stats['incompleteIdentity']+=1
                continue
            loc=tuple(p.strip() for p in parts)
            lookup=(day.day,loc)
            bucket=(slug,stamp[:7])
            ident=(bucket,lookup)
            if ident in conflicts:
                continue
            if not all(type(p) in (int,float) and math.isfinite(p) and p>0 for p in [low,high,modal]) or not low<=modal<=high:
                conflicts.add(ident)
                quotes[bucket].pop(lookup,None)
                stats['invalidPrices']+=1
                continue
            prices=(modal,low,high)
            if lookup in quotes[bucket] and quotes[bucket][lookup]!=prices:
                conflicts.add(ident)
                del quotes[bucket][lookup]
                stats['conflictingSnapshotRows']+=1
            else:
                quotes[bucket][lookup]=prices
    return quotes,stats


def checked(path,sha):
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=sha:
        raise ValueError('Damaged AGMARKNET archive: '+path.name)
    return json.loads(data)


def commit(dest,stage):
    # Keep the staged files until their catalog has been replaced. A killed run can replay.
    for p in sorted(stage.glob('*.json'),key=lambda p:p.name=='catalog.json'):
        target=dest/p.name
        tmp=target.with_suffix('.recent-tmp')
        tmp.write_bytes(p.read_bytes())
        os.replace(tmp,target)
    for p in stage.iterdir():
        p.unlink()
    stage.rmdir()


def merge_locked(dest,until,revision,states,require_recent,supplement):
    dest=Path(dest)
    pending=dest/'.mandi-recent-pending'
    if pending.is_dir():
        commit(dest,pending)
    catalog=json.loads((dest/'catalog.json').read_bytes())
    index={c['id']:c for c in catalog['series']}
    quotes,stats=observations(states,until)
    visible=[(month,records) for (slug,month),records in quotes.items() if 'mandi-'+slug in index and records]
    stats['matches']=sum(len(records) for _,records in visible)
    if not stats['matches']:
        raise ValueError('No usable target commodity range with a real variety and grade')
    newest=max(date.fromisoformat(f'{month}-{d:02}') for month,records in visible for d,_ in records)
    if require_recent and newest<until-timedelta(days=7):
        raise ValueError(f'OGD target commodity observations are stale: latest arrival {newest}, cutoff {until}')
    with TemporaryDirectory(dir=dest,prefix='.mandi-recent-') as tmp:
        stage=Path(tmp)
        for name,(slug,_) in CROPS.items():
            key='mandi-'+slug
            if key not in index:
                continue
            meta=index[key]
            archive=checked(dest/(key+'.json'),meta['sha256'])
            if archive['id']!=key or archive['shards']!=meta['shards']:
                raise ValueError('Mismatched archive index: '+key)
            parts={s['month']:s for s in meta['shards']}
            changed=False
            for crop,month in sorted(quotes):
                if crop!=slug:continue
                reported=quotes[crop,month]
                if not reported:continue
                existing={}
                prev=parts.get(month)
                if prev:
                    data=checked(dest/f'{key}-{month}.json',prev['sha256'])
                    if data['id']!=key or data['month']!=month or len(data['rows'])!=prev['count']:
                        raise ValueError('Mismatched monthly quote file')
                    for d,loc,p,lo,hi in data['rows']:
                        existing[d,tuple(data['locations'][loc])]=(p,lo,hi)
                incoming={k:v for k,v in reported.items() if k not in existing}
                stats['unchanged']+=sum(existing.get(k)==v for k,v in reported.items())
                stats['disputedExistingPricePreserved']+=sum(k in existing and existing[k]!=v for k,v in reported.items())
                if not incoming:continue
                existing.update(incoming)
                rows=((d,location,*prices) for (d,location),prices in sorted(existing.items()))
                new=make_shard(stage,key,month,list(rows))
                key_refs='supplementSnapshots' if supplement else 'ogdSnapshots'
                for ref_list in ('supplementSnapshots','ogdSnapshots'):
                    if prev and ref_list in prev:new[ref_list]=list(prev[ref_list])
                revisions=new.setdefault(key_refs,[])
                if revision not in revisions:revisions.append(revision)
                parts[month]=new
                stats['added']+=len(incoming)
                changed=True
            if changed:
                ordered=[parts[m] for m in sorted(parts)]
                sha=store(stage/(key+'.json'),{'id':key,'shards':ordered})
                source={'provider':'Directorate of Marketing & Inspection, India','resourceId':RESOURCE,
                    'sourceUrl':SOURCE,'license':'Government Open Data License – India','licenseUrl':LICENSE,
                    'mirror':'vivekg7/mandi','mirrorUrl':'https://github.com/'+REPO+'/tree/data',
                    'snapshotUrl':f'https://github.com/{REPO}/tree/{revision}',
                    'snapshotAt':states[0].get('generated','')}
                prev_source=meta.get('recentSource',{})
                if prev_source and prev_source.get('snapshotUrl')!=source['snapshotUrl'] and (
                        'snapshotAt' not in prev_source or prev_source['snapshotAt']>source['snapshotAt']):
                    source=prev_source
                if supplement:
                    sources={s['snapshotUrl']:s for s in meta.get('supplementalSources',[])}
                    sources[supplement['snapshotUrl']]=supplement
                    meta['supplementalSources']=list(sources.values())
                else:
                    meta['recentSource']=source
                meta.update(shards=ordered,count=sum(x['count'] for x in ordered),start=ordered[0]['start'],
                    end=ordered[-1]['end'],sha256=sha)
        if stats['added']:
            store(stage/'catalog.json',catalog)
            stage.rename(pending)
            commit(dest,pending)
    return dict(stats,latestObservation=newest.isoformat())


def merge(dest,until,revision,states,require_recent=False,supplement=None):
    handle=os.open(dest,os.O_RDONLY)
    try:
        fcntl.flock(handle,fcntl.LOCK_EX)
        return merge_locked(dest,until,revision,states,require_recent,supplement)
    finally:
        os.close(handle)


def build(dest,until,revision=None):
    rev,states=download(revision)
    return merge(dest,until,rev,states,require_recent=revision is None)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--until',type=date.fromisoformat,required=True)
    parser.add_argument('--revision')
    parser.add_argument('--csv-archive',action='store_true',help='Import the July 2026 KrashiMitra archive at its immutable commit')
    args=parser.parse_args()
    if args.csv_archive:
        rev=args.revision or CSV_COMMIT
        source=dict(CSV_SOURCE,snapshotUrl=f'https://github.com/{CSV_REPO}/tree/{rev}')
        print(json.dumps(merge(args.root,args.until,rev,download_csv(rev),supplement=source)))
    else:
        print(json.dumps(build(args.root,args.until,args.revision)))
