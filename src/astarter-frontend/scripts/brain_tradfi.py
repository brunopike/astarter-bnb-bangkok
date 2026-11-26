"""Build dated, attributed market series. An observation keeps the publisher's own frequency."""
import argparse
import calendar
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date, timedelta
import hashlib
import time
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile

import openpyxl
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from brain_tradfi_agencies import fetch_agency

START = date(2016, 1, 1)
TWSE = 'https://www.twse.com.tw/exchangeReport/FMTQIK'
WORLD_BANK = 'https://www.worldbank.org/en/research/commodity-markets'
ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/'
FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv'
SPECS = [
    ('taiex', 'index', '台湾加权指数', 'TAIEX', 'points', 'TAIEX'),
    ('gold', 'metals', '黄金', 'Gold', 'USD/troy oz', 'Gold'),
    ('silver', 'metals', '白银', 'Silver', 'USD/troy oz', 'Silver'),
    ('platinum', 'metals', '铂金', 'Platinum', 'USD/troy oz', 'Platinum'),
    ('copper', 'commodities', '铜', 'Copper', 'USD/t', 'Copper'),
    ('aluminum', 'commodities', '铝', 'Aluminum', 'USD/t', 'Aluminum'),
    ('maize', 'commodities', '玉米', 'Maize', 'USD/t', 'Maize'),
    ('eurusd', 'fx', '欧元 / 美元', 'EUR / USD', 'USD/EUR', 'USD'),
    ('eurjpy', 'fx', '欧元 / 日元', 'EUR / JPY', 'JPY/EUR', 'JPY'),
    ('eurgbp', 'fx', '欧元 / 英镑', 'EUR / GBP', 'GBP/EUR', 'GBP'),
    ('wti', 'oil', 'WTI 原油现货', 'WTI spot crude', 'USD/bbl', 'DCOILWTICO'),
    ('brent', 'oil', '布伦特原油现货', 'Brent spot crude', 'USD/bbl', 'DCOILBRENTEU'),
    ('ust2y', 'rates', '美国 2 年期国债收益率', 'U.S. 2-year Treasury yield', '%', 'DGS2'),
    ('ust10y', 'rates', '美国 10 年期国债收益率', 'U.S. 10-year Treasury yield', '%', 'DGS10'),
    ('usd-index', 'index', '美联储广义美元指数', 'Fed broad dollar index', 'Jan 2006 = 100', 'DTWEXBGS'),
]
MONTHLY = {'Gold','Silver','Platinum','Copper','Aluminum','Maize'}


def session():
    s = requests.Session()
    s.headers['User-Agent'] = 'Astarter public market archive/1.0'
    s.mount('https://', HTTPAdapter(max_retries=Retry(total=3, backoff_factor=.8, status_forcelist=[429, 500, 502, 503, 504])))
    return s


def mirror_revision(repository, branch):
    ref = f'refs/heads/{branch}'
    result = subprocess.check_output(
        ['git', 'ls-remote', '--exit-code', f'https://github.com/{repository}.git', ref],
        text=True, timeout=30,
    )
    match = re.fullmatch(r'([0-9a-f]{40})\t' + re.escape(ref), result.strip())
    if not match:
        raise ValueError('Invalid immutable mirror revision')
    return match.group(1)


def get(url, **kw):
    with session() as s:
        res = s.get(url, timeout=(10, 45), **kw)
        res.raise_for_status()
        return res


def json_bytes(obj):
    return (json.dumps(obj, separators=(',', ':'), ensure_ascii=False, allow_nan=False)+'\n').encode()


def save(path, obj):
    data = json_bytes(obj)
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:
        f.write(data)
    os.chmod(f.name,0o644)
    os.replace(f.name,path)


def number(value):
    n = float(str(value).replace(',', ''))
    if not math.isfinite(n):
        raise ValueError('Non-finite market observation')
    return n


def months(first, end):
    d = first.replace(day=1)
    while d <= end:
        yield d
        d = (d.replace(day=28)+timedelta(days=4)).replace(day=1)


def index_month(month):
    params={'response':'open_data','date':month.strftime('%Y%m%d')}
    for attempt in range(4):
        res=get(TWSE,params=params)
        reader=csv.DictReader(io.StringIO(res.content.decode('utf-8-sig')))
        if reader.fieldnames and '發行量加權股價指數' in reader.fieldnames:
            break
        if month==date.today().replace(day=1) and not res.content.strip():
            return []
        if attempt==3:
            raise ValueError('TWSE index schema unavailable for '+str(month))
        time.sleep(3*(attempt+1))
    rows=[]
    for r in reader:
        stamp=r['日期']
        if not re.fullmatch(r'\d{7}',stamp):
            raise ValueError('Invalid TWSE reporting date')
        observed=date(int(stamp[:3])+1911,int(stamp[3:5]),int(stamp[5:]))
        if observed.replace(day=1)!=month:
            raise ValueError('TWSE index date outside the requested month')
        rows.append([observed.isoformat(),number(r['發行量加權股價指數'])])
    return rows


def world_bank():
    page = get(WORLD_BANK).text
    link = re.search(r'https://thedocs\.worldbank\.org/[^"<> ]+/CMO-Historical-Data-Monthly\.xlsx',page)
    if not link:
        raise ValueError('World Bank historical monthly file missing')
    url = link.group()
    w = openpyxl.load_workbook(io.BytesIO(get(url).content), read_only=True, data_only=True)
    try:
        sheet = list(w['Monthly Prices'].values)
    finally:
        w.close()
    header = next(i for i,r in enumerate(sheet) if 'Crude oil, Brent' in r and 'Gold' in r)
    out = {}
    for code in MONTHLY:
        col = sheet[header].index(code)
        unit = '($/troy oz)' if code in {'Gold','Silver','Platinum'} else '($/mt)'
        if sheet[header+1][col] != unit:
            raise ValueError('World Bank unit changed for '+code)
        rows = []
        for r in sheet[header+2:]:
            if not re.fullmatch(r'\d{4}M\d{2}', str(r[0])) or not isinstance(r[col], (int,float)):
                continue
            y,m = map(int,r[0].split('M'))
            rows.append([date(y,m,calendar.monthrange(y,m)[1]).isoformat(),number(r[col])])
        out[code] = rows
    return url, out


def fetch_fx(code):
    key=f'D.{code}.EUR.SP00.A'
    url=ECB+key
    records=csv.DictReader(io.StringIO(get(url,params={'startPeriod':START.isoformat(),'format':'csvdata'}).text.lstrip('\ufeff')))
    rows=[]
    for r in records:
        if r['KEY']!='EXR.'+key or r['CURRENCY']!=code or r['CURRENCY_DENOM']!='EUR':
            raise ValueError('Wrong exchange-rate series')
        if r['OBS_VALUE']:
            rows.append([r['TIME_PERIOD'],number(r['OBS_VALUE'])])
    return url,rows


def fetch_fred(code):
    url='https://fred.stlouisfed.org/series/'+code
    with requests.get(FRED,params={'id':code,'cosd':START.isoformat()},timeout=(5,12)) as response:
        response.raise_for_status()
        rows=csv.DictReader(io.StringIO(response.text))
    if not rows.fieldnames or code not in rows.fieldnames:
        raise ValueError('Unexpected FRED series for '+code)
    return url,[[r['observation_date'],number(r[code])] for r in rows if r[code] not in ('','.','NA')]


def build(dest, until):
    catalog_path=dest/'catalog.json'
    previous=json.loads(catalog_path.read_bytes()) if catalog_path.exists() else {'series':[]}
    catalog={s['id']:s for s in previous['series']}
    errors=[]
    try:
        wb_url,wb=world_bank()
    except Exception as e:
        wb_url,wb=WORLD_BANK,{}
        errors.append('World Bank: '+str(e))
    for key,group,zh,en,unit,code in SPECS:
        try:
            path=dest/(key+'.json')
            if code=='TAIEX' and (catalog.get(key,{}).get('fields') or [])[:5]==['date','close','open','high','low']:
                # The daily OHLC importer owns this upgraded series, including revisions.
                continue
            old=dict(json.loads(path.read_bytes())['rows']) if path.exists() else {}
            if code=='TAIEX':
                # Refresh the latest stored month as well, so late corrections reach the archive.
                first=date.fromisoformat(max(old)).replace(day=1) if old else START
                if until.replace(day=1)>first and until.day<4:
                    first=min(first,(until.replace(day=1)-timedelta(days=1)).replace(day=1))
                with ThreadPoolExecutor(max_workers=2) as pool:
                    rows=[r for part in pool.map(index_month,months(first,until)) for r in part]
                source='Taiwan Stock Exchange';url='https://data.gov.tw/dataset/11672'
                statistic='close'
            elif code in MONTHLY:
                if code not in wb:
                    continue
                source='World Bank Pink Sheet';url,rows=wb_url,wb[code];statistic='monthlyMean'
            elif group=='fx':
                source='ECB';url,rows=fetch_fx(code);statistic='reference'
            else:
                source='Federal Reserve Board' if code in {'DTWEXBGS','DGS2','DGS10'} else 'U.S. EIA'
                try:
                    url,rows=fetch_agency(code)
                except Exception as agency_error:
                    print(f'{key}: {source} unavailable ({agency_error}); using FRED',flush=True)
                    url,rows=fetch_fred(code)
                    source+=' · FRED'
                statistic='yield' if group=='rates' else 'index' if code=='DTWEXBGS' else 'spot'
            filtered={d:v for d,v in rows if START<=date.fromisoformat(d)<=until}
            if not filtered and old and code=='TAIEX' and (until-date.fromisoformat(max(old))).days<=14:
                continue
            if not filtered or len(filtered)!=len([d for d,v in rows if START<=date.fromisoformat(d)<=until]):
                raise ValueError('Empty or duplicate observations: '+key)
            grace=70 if statistic=='monthlyMean' else 14
            if (until-date.fromisoformat(max(filtered))).days>grace:
                errors.append('Publisher data is overdue for '+key+' ('+max(filtered)+')')
            old.update(filtered)
            final=sorted(old.items())
            if not final[0][0].startswith('2016-') or len(final)<100:
                raise ValueError('Incomplete history: '+key)
            save(path,{'id':key,'rows':final})
            catalog[key]=dict(id=key,group=group,zh=zh,en=en,unit=unit,source=source,sourceUrl=url,statistic=statistic,
                              start=final[0][0],end=final[-1][0],count=len(final),sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            if code=='TAIEX':
                catalog[key].update(licenseUrl='https://data.gov.tw/license',license='Taiwan Open Government Data License 1.0')
        except Exception as e:
            errors.append(key+': '+str(e))
    if catalog:
        save(catalog_path,{'version':1,'series':[catalog[k] for k,*_ in SPECS if k in catalog]+[v for k,v in catalog.items() if k not in {s[0] for s in SPECS}]})
    if errors:
        raise RuntimeError('; '.join(errors))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dest',type=Path);parser.add_argument('--until',type=date.fromisoformat,default=date.today())
    args=parser.parse_args();build(args.dest,args.until)
