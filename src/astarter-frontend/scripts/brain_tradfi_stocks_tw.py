"""Archive issuer-identified cash equity OHLCV from Taiwan's licensed open-data reports."""
import argparse
import base64
from collections import Counter, defaultdict
import csv
import fcntl
import os
from datetime import date, timedelta
from hashlib import sha1, sha256
import io
import json
from math import isfinite
from pathlib import Path
import re
import tarfile
import tempfile

import requests

from brain_tradfi import json_bytes, save

MIRROR = '88jiayu/tw-chip-open-data'
REVISION = 'f6a287051fb8190bc22a156b5ac5d3298988f89e'
LICENSE = 'https://data.gov.tw/license'
MASTERS = {
    'twse': 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    'tpex': 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
}
QUOTES = {
    'twse': 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data',
    'tpex': 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
}
DATASETS = {'twse':'https://data.gov.tw/dataset/11549','tpex':'https://data.gov.tw/dataset/11371'}
SOURCE = {'twse':'twse_openapi_stock_day_all','tpex':'tpex_openapi_quotes'}
LEGACY = {'2330':'tsmc','2317':'honhai','1590':'airtac','4958':'zhending'}
PREFIX = 'tw-stock-'
PROOF = 'tw-stock-sources.json'
FIELDS = ['open','high','low','close','volume_shares']


def download(url):
    result = requests.get(url, headers={'User-Agent':'Astarter public market archive/1.0'}, timeout=(8,35))
    result.raise_for_status()
    return result.content


def local_date(value):
    value = value.strip()
    if re.fullmatch(r'\d{7}',value):
        value = str(int(value[:3])+1911)+value[3:]
    return date.fromisoformat(value).isoformat()


def registry(raw, market):
    fields = ('公司代號','公司簡稱','英文簡稱','上市日期') if market=='twse' else (
        'SecuritiesCompanyCode','CompanyAbbreviation','Symbol','DateOfListing')
    result = {}
    for row in json.loads(raw):
        ticker,name,english,listed = [row[k].strip() for k in fields]
        if not re.fullmatch(r'[1-9]\d{3}', ticker):
            continue
        if ticker in result:
            raise ValueError('Duplicate issuer in '+market+': '+ticker)
        result[ticker] = (name,english,local_date(listed))
    if len(result)<500:
        raise ValueError('Incomplete Taiwan issuer registry: '+market)
    return result


def bar(values):
    if len(values)!=5:
        raise ValueError('Incomplete Taiwan OHLCV schema')
    numbers=[]
    for value in values:
        text=str(value).strip().replace(',','')
        if value is None or text in ('','-','--','---','----','N/A'):
            return None
        number=float(text)
        if not isfinite(number) or number<0:
            raise ValueError('Invalid stock OHLCV value')
        numbers.append(number)
    op,hi,lo,close,volume=numbers
    if not volume.is_integer() or volume>=2**53:
        raise ValueError('Invalid share count')
    if min(op,hi,lo,close,volume)==0:
        return None
    if not lo<=min(op,close)<=max(op,close)<=hi:
        raise ValueError('Stock price outside reported daily range')
    return [close,op,hi,lo,int(volume)]


def current_feed(raw, market):
    if market=='twse':
        records=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        attributes=('日期','證券代號','開盤價','最高價','最低價','收盤價','成交股數')
    else:
        records=json.loads(raw)
        attributes=('Date','SecuritiesCompanyCode','Open','High','Low','Close','TradingShares')
    if len(records)<500:
        raise ValueError('Incomplete Taiwan exchange snapshot: '+market)
    days, output=set(),{}
    for row in records:
        when,ticker,*values=[row[k] for k in attributes]
        ticker=ticker.strip()
        days.add(local_date(when))
        if ticker in output: raise ValueError('Duplicate stock quote: '+ticker)
        output[ticker]=values
    if len(days)!=1: raise ValueError('Mixed trading dates in '+market)
    return days.pop(),output


def mirror_day(data, market, day, revision):
    doc=json.loads(data)
    keys={'rows':doc['rows'],'source':doc['source'],'license':doc['license']}
    checksum=sha256(json.dumps(keys,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if market=='tpex' and day=='2026-07-27' and doc.get('revision')==1:
        # The mirror's first dated receipt hashes rows alone.
        checksum=sha256(json.dumps(doc['rows'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if (doc['schema']!=1 or doc['trade_date']!=day or doc['kind']!='price_'+market
        or doc['license']!='open' or doc['source']!=SOURCE[market] or doc['fields']!=FIELDS
        or checksum!=doc.get('checksum') or len(doc['rows'])<500):
        raise ValueError('Invalid licensed snapshot: '+market+' '+day)

    url=f'https://github.com/{MIRROR}/blob/{revision}/data/official/price_{market}/{day}.json'
    return market,day,doc['rows'],url,sha256(data).hexdigest()


def mirror_days(path, revision):
    if not re.fullmatch(r'[0-9a-f]{40}',revision): raise ValueError('Use an immutable Git revision')
    n=0
    with tarfile.open(path,'r:gz') as archive:
        for entry in archive:
            m=re.fullmatch(r'tw-chip-open-data-'+revision+r'/data/official/price_(twse|tpex)/(\d{4}-\d\d-\d\d)\.json',entry.name)
            if not entry.isfile() or not m: continue
            market,day=m.groups()
            data=archive.extractfile(entry).read()
            n+=1
            yield mirror_day(data,market,day,revision)
    if not n: raise ValueError('No price snapshots found for the pinned revision')


def archived_twse(path):
    index=json.loads((path/'wayback-index.json').read_bytes())
    for stamp,url,digest,_ in index:
        receipt=path/(digest+'.blob')
        if '/STOCK_DAY_ALL' not in url or not receipt.is_file(): continue
        if not re.fullmatch(r'https?://(?:openapi|www)\.twse\.com\.tw(?::80)?/(?:v1/)?exchangeReport/STOCK_DAY_ALL\??(?:response=open_data)?',url,re.I): continue
        data=receipt.read_bytes()
        if base64.b32encode(sha1(data).digest()).decode()!=digest: raise ValueError('Archive CDX digest mismatch')
        if data.lstrip().startswith(b'{'):
            report=json.loads(data)
            if report.get('stat')!='OK': continue
            day=local_date(report['date']); keys=report['fields'];rows={}
            for row in report['data']:
                r=dict(zip(keys,row,strict=True))
                rows[r['證券代號'].strip()]=[r[k] for k in ('開盤價','最高價','最低價','收盤價','成交股數')]
        elif data.lstrip(b'\xef\xbb\xbf').startswith('日期'.encode()):
            day,rows=current_feed(data,'twse')
        else:
            continue
        if len(rows)<500: raise ValueError('Incomplete CDX stock report')
        yield 'twse',day,rows,'https://web.archive.org/web/'+stamp+'id_/'+url,sha256(data).hexdigest()


def first_listed_reports(path):
    prefix='第一上市外國股票收盤行情'
    for receipt in sorted(path.glob('*.json')):
        day=receipt.stem
        doc=json.loads(receipt.read_bytes())
        compact=day.replace('-','')
        url='https://www.twse.com.tw/exchangeReport/STOCK_FIRST?response=open_data&date='+compact
        raw=receipt.with_suffix('.csv').read_bytes()
        if doc['url']!=url or sha256(raw).hexdigest()!=doc['sha256'] or 'STOCK_FIRST_'+compact+'.csv' not in doc['disposition']:
            raise ValueError('Dated STOCK_FIRST receipt mismatch: '+day)
        rows={}
        for r in csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))):
            ticker=r[prefix+'證券代號'].strip()
            if ticker in rows: raise ValueError('Duplicate STOCK_FIRST security: '+ticker)
            rows[ticker]=[r['價格(單元：新台幣元)'+k] for k in ['開盤價','最高價','最低價','收盤價']]+[r[prefix+'成交股數']]
        if not rows: raise ValueError('Empty STOCK_FIRST report: '+day)
        yield 'twse',day,rows,url,doc['sha256']


def recover_batch(dest):
    pending=dest/'.tw-stock-pending'
    if pending.is_dir():
        for path in sorted(pending.glob('*.json'),key=lambda f:f.name=='catalog.json'):
            path.replace(dest/path.name)
        pending.rmdir()


def compile_market(dest, until, issuers, snapshots, existing=None, keep=True):
    dest.mkdir(parents=True,exist_ok=True)
    recover_batch(dest)
    catfile=dest/'catalog.json'
    old=json.loads(catfile.read_bytes()) if catfile.exists() else {'version':1,'series':[]}
    related={}
    for ticker,k in LEGACY.items():
        f=(existing or dest)/(k+'.json')
        if not f.is_file():
            raise ValueError('Missing linked TWSE closing-price series: '+str(f))
        linked=json.loads(f.read_bytes())
        if linked.get('id')!=k: raise ValueError('Wrong linked close series')
        related[ticker]={r[0]:r[1] for r in linked['rows']}
    series=defaultdict(dict); known={}; receipts={}
    source_file=dest/PROOF
    if keep and source_file.is_file(): receipts=json.loads(source_file.read_bytes())['days']
    other=[]
    for m in old['series']:
        if not m['id'].startswith(PREFIX):
            other.append(m)
            continue
        if not keep: continue
        key=(m['exchange'].lower(),m['symbol']);known[key]=m
        data=(dest/(m['id']+'.json')).read_bytes()
        if sha256(data).hexdigest()!=m['sha256']: raise ValueError('Stored stock SHA-256 mismatch')
        series[key]={r[0]:r[1:] for r in json.loads(data)['rows']}
    touched=Counter()
    for market,day,rows,url,digest in snapshots:
        date.fromisoformat(day)
        if day>until.isoformat(): continue
        valid_rows=0
        for ticker,values in rows.items():
            issuer=issuers[market].get(ticker)
            if issuer is None or day<issuer[2]: continue
            value=bar(values)
            if value is None: continue
            storage=series[market,ticker]
            if day in storage and storage[day]!=value:
                raise ValueError('Conflicting observed OHLCV: '+market+' '+ticker+' '+day)
            storage[day]=value
            valid_rows+=1
        if not valid_rows:
            raise ValueError('No eligible issuer prices in '+market+' on '+day)
        touched[market]+=valid_rows
        receipts.setdefault(market+'-'+day,{})[url]=digest
    if not touched and not known: raise ValueError('No eligible issuer prices returned')
    omitted=0;meta=[]
    # Prepare the entire batch before replacing any public files.
    with tempfile.TemporaryDirectory(dir=dest) as temp:
        stage=Path(temp)/'ready'
        stage.mkdir()
        for (market,ticker),by_date in sorted(series.items()):
            if market=='twse' and ticker in related:
                for day in set(by_date)&related[ticker].keys():
                    if by_date[day][0]!=related[ticker][day]: raise ValueError('Published Taiwan close conflict at '+day)
                    del by_date[day];omitted+=1
            if not by_date: continue
            rows=[[day,*v] for day,v in sorted(by_date.items())]
            key=PREFIX+market+'-'+ticker
            base=known.get((market,ticker),{})
            issuer=issuers[market].get(ticker)
            if not issuer and not base: raise ValueError('Missing issuer')
            name=issuer[0] if issuer else base['issuerName']
            english=issuer[1] if issuer else base['issuerEnglishName']
            payload=json_bytes({'id':key,'rows':rows})
            digest=sha256(payload).hexdigest()
            if base.get('sha256')!=digest: (stage/(key+'.json')).write_bytes(payload)
            item=dict(id=key,symbol=ticker,exchange=market.upper(),group='stock',statistic='ohlcv',
                      en=f'{english or ticker} · {market.upper()}',zh=f'{name} · '+('台湾上市' if market=='twse' else '台湾上柜'),
                      issuerName=name,issuerEnglishName=english,listedOn=issuer[2] if issuer else base['listedOn'],
                      unit='TWD/share',frequency='daily',priceBasis='unadjusted',volumeUnit='shares',
                      coverage='observedLicensedTradingDates',issuerUniverse='issuerRegistryAtCollection',
                      source='Taiwan Stock Exchange' if market=='twse' else 'Taipei Exchange',
                      sourceUrl=DATASETS[market],license='Open Government Data License, version 1.0',
                      licenseUrl=LICENSE,sourceIndex=PROOF,start=rows[0][0],end=rows[-1][0],count=len(rows),sha256=digest)
            if market=='twse' and ticker in LEGACY: item['related']=[LEGACY[ticker]]
            meta.append(item)
        save(stage/PROOF,{'version':1,'days':receipts,'registryUrls':MASTERS,
                   'historicalKyDataset':'https://data.gov.tw/dataset/11759','licenseUrl':LICENSE})
        save(stage/'catalog.json',{**old,'series':other+meta})
        stage.rename(dest/'.tw-stock-pending')
        recover_batch(dest)
    return {'issuers':len(meta),'rows':sum(x['count'] for x in meta),'existingCloseDatesOmitted':omitted,
            'coverage':{m:sorted(k.split('-',1)[1] for k in receipts if k.startswith(m+'-')) for m in MASTERS}}


def build(dest, until, existing=None, inputs=None, vintage=None, dated=None, mirror=None, revision=REVISION):
    """Update directly from official snapshots; historical sources can be added on bootstrap."""
    def read(name,url): return (inputs/name).read_bytes() if inputs else download(url)
    issuers={m:registry(read(m+'_master.json',url),m) for m,url in MASTERS.items()}
    existing=Path(existing) if existing else None
    gaps=defaultdict(list)
    dest=Path(dest)
    dest.mkdir(parents=True,exist_ok=True)
    def snapshots():
        if mirror: yield from mirror_days(mirror,revision)
        if vintage: yield from archived_twse(vintage)
        if dated: yield from first_listed_reports(dated)
        proof=dest/PROOF
        previous=json.loads(proof.read_bytes())['days'] if proof.is_file() else {}
        calendar=(existing or dest)/'taiex.json'
        schedule=[]
        if not inputs and calendar.is_file():
            schedule=[r[0] for r in json.loads(calendar.read_bytes())['rows']
                      if (until-timedelta(days=9)).isoformat()<=r[0]<=until.isoformat()]
        head=None
        for market,url in QUOTES.items():
            raw=read(market+('_latest.csv' if market=='twse' else '_latest.json'),url)
            day,rows=current_feed(raw,market)
            if date.fromisoformat(day)<until-timedelta(days=10): raise ValueError('Stale official '+market+' snapshot: '+day)
            yield market,day,rows,url,sha256(raw).hexdigest()
            for missed in schedule:
                clipped=market+'-'+missed
                if missed==day or any('STOCK_FIRST' not in src for src in previous.get(clipped,{})): continue
                if head is None:
                    head=json.loads(download('https://api.github.com/repos/'+MIRROR+'/commits/main'))['sha']
                    if not re.fullmatch(r'[0-9a-f]{40}',head): raise ValueError('Invalid mirror commit')
                location=f'https://raw.githubusercontent.com/{MIRROR}/{head}/data/official/price_{market}/{missed}.json'
                try:
                    data=download(location)
                except requests.HTTPError as exc:
                    if exc.response.status_code!=404: raise
                    gaps[market].append(missed)
                    # A mirror may have missed that session, or may publish after the exchange.
                    continue
                yield mirror_day(data,market,missed,head)
    fd=os.open(str(dest),os.O_RDONLY)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX)
        result=compile_market(dest,until,issuers,snapshots(),existing)
        result['recentSessionsWithoutSnapshot']=dict(gaps)
        return result
    finally:
        os.close(fd)


if __name__=='__main__':
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--root',type=Path,required=True)
    cli.add_argument('--until',type=date.fromisoformat,required=True)
    for option in ('existing','inputs','vintage','dated','mirror'): cli.add_argument('--'+option,type=Path)
    cli.add_argument('--revision',default=REVISION)
    cfg=cli.parse_args()
    print(json.dumps(build(cfg.root,cfg.until,cfg.existing,cfg.inputs,cfg.vintage,cfg.dated,cfg.mirror,cfg.revision)))
