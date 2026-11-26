"""Build unadjusted nearest-traded-month TAIFEX futures bars from exchange reports."""
import argparse
import csv
from datetime import date, datetime, timedelta, timezone
from io import BytesIO, StringIO
import json
from math import isfinite
from pathlib import Path
import re
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from brain_tradfi import save, session
from hashlib import sha256

ROOT = 'https://www.taifex.com.tw/enl/eng3/'
SOURCE = ROOT+'futDailyMarketView'
LICENSE = 'https://data.gov.tw/license'
DATASET = 'https://data.gov.tw/dataset/11319'
SPECS = 'https://www.taifex.com.tw/enl/eng4/contractName'
FIRST = date(2016, 1, 1)
TAIPEI = ZoneInfo('Asia/Taipei')
FUTURES = {
    'TX': ('index', '臺指', 'TAIEX', 'points'),
    'TE': ('index', '台湾电子类股', 'Taiwan Electronics Sector', 'points'),
    'TF': ('index', '台湾金融类股', 'Taiwan Finance Sector', 'points'),
    'XIF': ('index', '台湾非金电', 'Taiwan Non-Finance Non-Electronics', 'points'),
    'GTF': ('index', '台北交易所股票指数', 'Taipei Exchange Stock Index', 'points'),
    'M1F': ('index', '台湾中型100', 'Taiwan Mid-Cap 100', 'points'),
    'SPF': ('index', '标普500', 'S&P 500', 'points'),
    'UDF': ('index', '道琼斯工业平均指数', 'DJIA', 'points'),
    'UNF': ('index', '纳斯达克100', 'Nasdaq-100', 'points'),
    'SXF': ('index', '费城半导体指数', 'PHLX Semiconductor Sector', 'points'),
    'F1F': ('index', '富时100', 'FTSE 100', 'points'),
    'TJF': ('index', '东证股价指数', 'TOPIX', 'points'),
    'GDF': ('metals', '美元黄金', 'USD gold', 'USD/troy oz'),
    'TGF': ('metals', '新台币黄金', 'TWD gold', 'TWD/3.75 g'),
    'BRF': ('oil', '布伦特原油', 'Brent crude', 'TWD/bbl'),
    'RHF': ('fx', '美元／离岸人民币（香港）', 'USD/CNH (Hong Kong)', 'CNH/USD'),
    'RTF': ('fx', '美元／离岸人民币（台湾）', 'USD/CNT (Taiwan)', 'CNT/USD'),
    'XEF': ('fx', '欧元／美元', 'EUR/USD', 'USD/EUR'),
    'XJF': ('fx', '美元／日元', 'USD/JPY', 'JPY/USD'),
    'XAF': ('fx', '澳元／美元', 'AUD/USD', 'USD/AUD'),
    'XBF': ('fx', '英镑／美元', 'GBP/USD', 'USD/GBP'),
}
FIELDS = ['date', 'close', 'open', 'high', 'low', 'volume', 'contractMonth', 'afterHoursVolume', 'regularVolume']
METHOD = ('Nearest listed monthly expiry with actual trade volume that day; excludes weeks and calendar spreads. '
          'Unadjusted trade prices. Prior evening first, regular session second, under the exchange-assigned trade date. '
          'Volume is contracts; contract multipliers can change.')


def latest_completed_day(now=None):
    moment = now if now is not None else datetime.now(timezone.utc)
    return moment.astimezone(TAIPEI).date() - timedelta(days=1)


def read_report(payload, first, last):
    reader = csv.reader(StringIO(payload.decode('latin1')))
    names = [c.lower().strip() for c in next(reader)]
    if names[:10] != ['date','contract','contract month(week)','open','high','low','last','change','%','volume']:
        raise ValueError('Unexpected TAIFEX daily report header')
    session_col = names.index('trading session') if 'trading session' in names else None
    records = {}
    for row in reader:
        if not row or len(row) == 1 and not row[0].strip(' \t\x1a'):
            continue
        code, month = row[1].strip(), row[2].strip()
        if code not in FUTURES or not re.fullmatch(r'\d{4}(?:0[1-9]|1[0-2])', month):
            continue
        observed = date(*map(int, row[0].split('/')))
        if not first <= observed <= last:
            continue
        if row[9].strip() in ('-', '', '0'):
            continue
        volume = int(row[9])
        if volume <= 0:
            raise ValueError('Invalid TAIFEX traded volume')
        sess = row[session_col].strip().replace('After Hours','After-Hours') if session_col is not None else ''
        if sess == '':
            if observed >= date(2017,5,15):raise ValueError('Missing post-launch session name')
            sess = 'Regular'
        if sess not in ('After-Hours', 'Regular'):
            raise ValueError('Unknown TAIFEX session: '+sess)
        if any(v.strip() in ('-','') for v in row[3:7]):
            # Some traded sessions omit one or more OHLC fields.
            op=high=low=cl=None
        else:
            op,high,low,cl=map(float,row[3:7])
            if not all(map(isfinite,(op,high,low,cl))) or not low<=min(op,cl)<=max(op,cl)<=high:
                op=high=low=cl=None
        day = observed.isoformat()
        sessions = records.setdefault((code,day),{}).setdefault(month,{})
        if sess in sessions:
            raise ValueError('Duplicate exchange session '+str((code,day,month,sess)))
        sessions[sess] = (op,high,low,cl,volume)
    result = {}
    for (code,day), months in records.items():
        for month, sessions in sorted(months.items()):
            trades = [sessions[s] for s in ('After-Hours','Regular') if s in sessions]
            if any(x[0] is None for x in trades):
                # No way to establish full-day OHLC for a volume-only session.
                break
            volume = sum(x[4] for x in trades)
            after = sessions['After-Hours'][4] if 'After-Hours' in sessions else 0
            result.setdefault(code,{})[day] = [day,trades[-1][3],trades[0][0],max(x[1] for x in trades),
                                               min(x[2] for x in trades),volume,month,after,volume-after]
            break
    return result


def download(fields):
    with session() as http:
        response = http.post(ROOT+'futDataDown', data=fields, timeout=(12,90))
        response.raise_for_status()
        return response.content


def annual(year, cache):
    path = cache/(str(year)+'.zip') if cache else None
    data = path.read_bytes() if path and path.is_file() else download({'down_type':'2','his_year':year})
    with ZipFile(BytesIO(data)) as z:
        csv_data=z.read(str(year)+'_fut.csv')
    if path and not path.exists():path.write_bytes(data)
    return csv_data


def period(first,last,cache):
    path=cache/'futures-cache'/f'{first}_{last}.csv' if cache else None
    if path and path.is_file():
        data=path.read_bytes()
    elif (last.year-first.year)*12+last.month-first.month>1:
        mid=first+(last-first)//2
        early=period(first,mid,cache);late=period(mid+timedelta(days=1),last,cache)
        data=early.rstrip(b'\r\n')+b'\r\n'+late.split(b'\n',1)[1]
    else:
        fields={'down_type':'1','commodity_id':'all','commodity_id2':'',
                'queryStartDate':first.strftime('%Y/%m/%d'),'queryEndDate':last.strftime('%Y/%m/%d')}
        data=download(fields)
    if not data.lower().startswith(b'date,contract,'):
        raise ValueError('TAIFEX did not return a daily CSV for '+str((first,last)))
    if path and not path.exists():
        path.parent.mkdir(exist_ok=True,parents=True);path.write_bytes(data)
    return data


def merge(target, result):
    for code, days in result.items():
        target.setdefault(code,{}).update(days)


def build(dest,until,cache=None):
    dest=Path(dest);cache=Path(cache) if cache else None
    if until>latest_completed_day() or until<FIRST:raise ValueError('Use a completed date')
    if cache:cache.mkdir(parents=True,exist_ok=True)
    catalog_path=dest/'catalog.json'
    catalog=json.loads(catalog_path.read_bytes()) if catalog_path.is_file() else {'version':1,'series':[]}
    metadata={s['id']:s for s in catalog['series']}
    bars={code:{} for code in FUTURES}
    for code in FUTURES:
        key='taifex-'+code.lower()
        if key not in metadata:continue
        raw=(dest/(key+'.json')).read_bytes()
        if sha256(raw).hexdigest()!=metadata[key]['sha256']:raise ValueError('Existing TAIFEX archive failed checksum')
        bars[code]={r[0]:r for r in json.loads(raw)['rows']}
    if bars['TX']:
        previous=date.fromisoformat(max(bars['TX']))
        if until<previous:raise ValueError('Use a separate output for earlier data')
    first=max(FIRST,previous-timedelta(days=14)) if all(bars.values()) else FIRST
    while first<=until:
        year_end=date(first.year,12,31)
        if first.month==1 and first.day==1 and year_end<=until:
            end=year_end; report=annual(first.year,cache)
        else:
            end=min(first+timedelta(days=29),year_end,until)
            report=period(first,end,cache)
        observed=read_report(report,first,end)
        if (end-first).days>=21 and not observed.get('TX'):
            raise ValueError('No TAIEX observations in expected trading period: '+str((first,end)))
        merge(bars,observed)
        first=end+timedelta(days=1)
    for code, (group,zh,en,unit) in FUTURES.items():
        if not bars[code]:continue
        key='taifex-'+code.lower()
        rows=[r for _,r in sorted(bars[code].items())]
        path=dest/(key+'.json');save(path,{'id':key,'rows':rows})
        metadata[key]=dict(id=key,group=group,zh='台期所 · '+zh+'期货',en='TAIFEX · '+en+' futures',
            unit=unit,statistic='ohlcv',priceBasis='nearestTradedFuturesMonth',symbol=code,
            source='Taiwan Futures Exchange',sourceUrl=SOURCE,license='Open Government Data License, version 1.0',
            licenseUrl=LICENSE,datasetUrl=DATASET,contractSpecsUrl=SPECS,method=METHOD,
            frequency='daily',fields=FIELDS,volumeUnit='contracts',start=rows[0][0],end=rows[-1][0],
            count=len(rows),sha256=sha256(path.read_bytes()).hexdigest())
    save(catalog_path,{**catalog,'series':list(metadata.values())})


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True)
    p.add_argument('--until',type=date.fromisoformat,default=latest_completed_day())
    p.add_argument('--cache',type=Path);a=p.parse_args();build(a.root,a.until,a.cache)
