"""Archive regional pump-price medians from France's mandatory station price declarations."""
import argparse
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from contextlib import nullcontext
import csv
from datetime import date, datetime, timezone, timedelta
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
from statistics import median
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import requests

from brain_tradfi import save, session

SOURCE = 'https://www.prix-carburants.gouv.fr/rubrique/opendata/'
LICENSE = 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/'
ANNUAL = 'https://donnees.roulez-eco.fr/opendata/annee'
FIRST = date(2016, 1, 1)
FUELS = {
    'Gazole': ('diesel', '柴油'), 'SP95': ('95', 'SP95 汽油'), 'SP98': ('98', 'SP98 汽油'),
    'E10': ('e10', 'E10 汽油'), 'E85': ('e85', 'E85 乙醇汽油'), 'GPLc': ('lpg', '车用液化气'),
}
REGIONS = {
    'ara': ('Auvergne-Rhône-Alpes','奥弗涅-罗讷-阿尔卑斯','01 03 07 15 26 38 42 43 63 69 73 74'),
    'bfc': ('Bourgogne-Franche-Comté','勃艮第-弗朗什-孔泰','21 25 39 58 70 71 89 90'),
    'bre': ('Bretagne','布列塔尼','22 29 35 56'),
    'cvl': ('Centre-Val de Loire','中央-卢瓦尔河谷','18 28 36 37 41 45'),
    'cor': ('Corse','科西嘉','20'),
    'ges': ('Grand Est','大东部','08 10 51 52 54 55 57 67 68 88'),
    'hdf': ('Hauts-de-France','上法兰西','02 59 60 62 80'),
    'idf': ('Île-de-France','法兰西岛','75 77 78 91 92 93 94 95'),
    'nor': ('Normandie','诺曼底','14 27 50 61 76'),
    'naq': ('Nouvelle-Aquitaine','新阿基坦','16 17 19 23 24 33 40 47 64 79 86 87'),
    'occ': ('Occitanie','奥克西塔尼','09 11 12 30 31 32 34 46 48 65 66 81 82'),
    'pdl': ('Pays de la Loire','卢瓦尔河地区','44 49 53 72 85'),
    'pac': ("Provence-Alpes-Côte d'Azur",'普罗旺斯-阿尔卑斯-蓝色海岸','04 05 06 13 83 84'),
}
BY_PREFIX = {dep:key for key,(_,_,deps) in REGIONS.items() for dep in deps.split()}
METHOD = ('Median of reporting stations in the region. For each fuel and local date, each station contributes '
          'only its last newly reported price. Conflicting equally timed reports and missing days are omitted. '
          'Unweighted retail pump prices in EUR per litre, with a distinct reporting-station count.')


def archive_url(year):
    return ANNUAL if year == datetime.now(timezone.utc).year else f'{ANNUAL}/{year}'


def get_year(year, cache):
    target = Path(cache)/f'fr-fuel-{year}.zip' if cache else None
    if target and target.is_file():
        return target.read_bytes()
    with session() as http:
        response = http.get(archive_url(year), timeout=(10, 95))
        response.raise_for_status()
        content = response.content
    if target:
        target.parent.mkdir(exist_ok=True, parents=True)
        with ZipFile(BytesIO(content)) as z:
            if len(z.namelist()) != 1:
                raise ValueError('Unexpected annual XML archive')
        target.write_bytes(content)
    return content


def read_report(xml, year, last):
    from math import isfinite
    groups = defaultdict(list)
    station_ids = set()
    first = f'{year}-01-01'
    for _, station in ET.iterparse(xml, events=('end',)):
        if station.tag != 'pdv':
            continue
        code = station.get('cp', '').strip()
        region = BY_PREFIX.get(code[:2]) if len(code) == 5 else None
        if not region:
            station.clear()
            continue
        sid = station.attrib['id']
        if sid in station_ids:
            raise ValueError('Duplicate station in annual archive: '+sid)
        station_ids.add(sid)
        latest = {}
        for quote in station.iterfind('prix'):
            fuel = quote.get('nom')
            if fuel not in FUELS:
                if fuel:raise ValueError('Unknown French fuel product: '+fuel)
                continue
            stamp = quote.attrib['maj'].replace(' ', 'T')
            day = stamp[:10]
            if not first <= day <= last:
                continue
            value = quote.get('valeur')
            if not value:
                continue
            # The official files through 2021 use thousandths of a euro per litre.
            v = float(value) * (1 if year <= 2021 else 1000)
            if not isfinite(v) or v <= 0:
                continue
            if abs(v-round(v)) > 0.00001:
                raise ValueError('Unexpected precision in station price: '+value)
            milli = round(v)
            key = day,fuel
            old = latest.get(key)
            if old is None or stamp > old[0]:
                latest[key] = (stamp,milli)
            elif stamp == old[0] and old[1] != milli:
                latest[key] = (stamp,None)
        for (day,fuel),(_,milli) in latest.items():
            if milli is not None:
                groups[region,fuel,day].append(milli)
        station.clear()
    if not groups:
        raise ValueError('No dated French station reports in '+str(year))
    output = defaultdict(list)
    for (region,fuel,day), samples in sorted(groups.items()):
        output[region,fuel].append([day,median(samples)/1000,len(samples)])
    return dict(output)


def parse_year(args):
    year,until,cache = args
    with ZipFile(BytesIO(get_year(year,cache))) as z:
        names = z.namelist()
        if len(names) != 1 or not names[0].lower().endswith('.xml'):
            raise ValueError('Expected one annual fuel price XML file')
        with z.open(names[0]) as xml:
            return year,read_report(xml,year,until)


def build(dest,until,cache=None,workers=1):
    dest=Path(dest)
    dest.mkdir(parents=True,exist_ok=True)
    if until < FIRST or until >= datetime.now(timezone.utc).date():
        raise ValueError('Choose a complete reporting date')
    path=dest/'catalog.json'
    catalog=json.loads(path.read_bytes()) if path.exists() else {'version':1,'series':[]}
    items={s['id']:s for s in catalog['series']}
    prior=[date.fromisoformat(s['end']) for s in items.values() if s['id'].startswith('fr-fuel-')]
    if prior and max(prior)>until:
        raise ValueError('Use a separate archive for an earlier end date')
    first=max(FIRST.year,(max(prior)-timedelta(days=14)).year) if prior else FIRST.year
    inputs=[(year,str(until),cache) for year in range(first,until.year+1)]
    output=defaultdict(list)
    with ProcessPoolExecutor(max_workers=min(workers,len(inputs))) if workers>1 else nullcontext(None) as executor:
        results=executor.map(parse_year,inputs) if executor else map(parse_year,inputs)
        for year,annual in results:
            for k,v in annual.items():
                output[k].extend(v)
            print('French regional pump reports',year,sum(map(len,annual.values())),flush=True)
    if len(output)<len(REGIONS)*3:
        raise ValueError('Truncated regional fuel archive')
    for (region,fuel),rows in sorted(output.items()):
        suffix,zh_fuel=FUELS[fuel];en_region,zh_region,_=REGIONS[region]
        key=f'fr-fuel-{region}-{suffix}'
        file=dest/(key+'.json')
        if key in items:
            raw=file.read_bytes()
            if hashlib.sha256(raw).hexdigest()!=items[key]['sha256']:
                raise ValueError('Previous fuel archive failed checksum: '+key)
            previous=[r for r in json.loads(raw)['rows'] if r[0][:4]<str(first)]
            rows=previous+rows
        save(file,{'id':key,'rows':rows})
        items[key]=dict(id=key,group='commodities',zh=zh_region+' · '+zh_fuel,en=en_region+' · '+fuel,
                        unit='EUR/L',statistic='retailMedian',frequency='daily',fields=['date','value','reportingStations'],
                        source='French Ministry of Economy and Finance · Prix des carburants',sourceUrl=SOURCE,
                        license='Licence Ouverte / Open Licence 2.0',licenseUrl=LICENSE,method=METHOD,
                        start=rows[0][0],end=rows[-1][0],count=len(rows),sha256=hashlib.sha256(file.read_bytes()).hexdigest())
    save(path,{**catalog,'series':list(items.values())})


GAS_SOURCE = 'https://www.aemo.com.au/energy-systems/gas/short-term-trading-market-sttm/data-sttm/daily-sttm-reports'
GAS_RIGHTS = 'https://www.aemo.com.au/privacy-and-legal-notices/copyright-permissions'
WORKBOOK = 'https://www.aemo.com.au/-/media/files/gas/sttm/data/sttm-price-and-withdrawals.xlsx'
BASELINE = WORKBOOK+'?rev=29b5fa9ed5b94c96a98821bb127aacdd&sc_lang=en'
NEM = 'https://www.nemweb.com.au/Reports/CURRENT/STTM/'
EX_ANTE = 'int651_v1_ex_ante_market_price_rpt_1'
HUBS = {'SYD':('Sydney','悉尼'),'ADL':('Adelaide','阿德莱德'),'BRI':('Brisbane','布里斯班')}


def gas_price(value):
    from math import isfinite
    result=float(value)
    if not isfinite(result):
        raise ValueError('Invalid AEMO gas price')
    return result


def read_gas_book(payload,until):
    from openpyxl import load_workbook
    out={hub:{} for hub in HUBS}
    with BytesIO(payload) as fp:
        w=load_workbook(fp,read_only=True,data_only=True)
        for hub in HUBS:
            rows=iter(w[hub+' price and withdrawals'].values)
            if next(rows)[:2]!=('DateTime',hub+' exante_price'):
                raise ValueError('Unexpected AEMO market sheet: '+hub)
            for stamp,value,*_ in rows:
                if not isinstance(stamp,datetime) or not FIRST<=stamp.date()<=until:
                    continue
                if value in (None,'','[NULL]'):
                    continue
                day=stamp.date().isoformat()
                if day in out[hub]:
                    raise ValueError('Duplicate AEMO daily settlement: '+day)
                out[hub][day]=gas_price(value)
        w.close()
    return out


def merge_gas_report(history,payload,until):
    seen={}
    for row in csv.DictReader(StringIO(payload.decode('utf-8-sig'))):
        hub=row['hub_identifier']
        day=datetime.strptime(row['gas_date'],'%d %b %Y').date()
        if hub not in HUBS:continue
        if row['hub_name']!=HUBS[hub][0]:raise ValueError('AEMO gas hub mismatch: '+hub)
        if not FIRST<=day<=until:continue
        value=gas_price(row['ex_ante_market_price'])
        k=(hub,day.isoformat())
        if k in seen and seen[k]!=value:raise ValueError('Conflicting AEMO published gas prices')
        seen[k]=value
    for (hub,day),value in seen.items():history[hub][day]=value


def gas_file(url,name,cache):
    file=Path(cache)/name if cache else None
    if file and file.is_file():return file.read_bytes()
    with session() as http:
        resp=http.get(url,timeout=(8,35));resp.raise_for_status();raw=resp.content
    if file:file.write_bytes(raw)
    return raw


def build_gas(dest,until,cache=None):
    dest=Path(dest);dest.mkdir(exist_ok=True,parents=True)
    if until<FIRST or until>=datetime.now(timezone.utc).date():raise ValueError('Use a completed gas day')
    market=dest/'catalog.json'
    catalog=json.loads(market.read_bytes()) if market.exists() else {'version':1,'series':[]}
    index={x['id']:x for x in catalog['series']}
    records={}
    for hub in HUBS:
        key='au-gas-'+hub.lower()
        if key not in index:continue
        b=(dest/(key+'.json')).read_bytes()
        if hashlib.sha256(b).hexdigest()!=index[key]['sha256']:raise ValueError('Gas archive checksum mismatch: '+key)
        records[hub]=dict(json.loads(b)['rows'])
        if max(records[hub])>str(until):raise ValueError('Use a separate folder for earlier data')
    refresh=len(records)!=len(HUBS) or any(until-date.fromisoformat(max(days))>timedelta(days=28) for days in records.values())
    if refresh:
        try:
            book=read_gas_book(gas_file(WORKBOOK,'sttm-latest.xlsx',cache),until)
        except requests.RequestException:
            book=read_gas_book(gas_file(BASELINE,'sttm-historical.xlsx',cache),until)
        for hub in HUBS:
            book[hub].update(records.get(hub,{}))
        records=book
    merge_gas_report(records,gas_file(NEM+EX_ANTE+'.csv','sttm-current-'+str(until)+'.csv',cache),until)
    full_days={str(FIRST+timedelta(days=i)) for i in range((until-FIRST).days+1)}
    checked=set()
    while missing:=sorted(full_days-set.intersection(*(set(d) for d in records.values()))):
        last=date.fromisoformat(missing[-1])
        if until-last>timedelta(days=30) or last in checked:
            raise ValueError('AEMO archive requires the latest monthly workbook to fill '+str(last))
        checked.add(last)
        day=f'Day{last.day:02}.zip'
        b=gas_file(NEM+day,'sttm-'+str(last)+'.zip',cache)
        with ZipFile(BytesIO(b)) as z:
            names=[n for n in z.namelist() if n.startswith(EX_ANTE+'~') and n.endswith('.csv')]
            if len(names)!=1:raise ValueError('Unexpected AEMO daily archive')
            merge_gas_report(records,z.read(names[0]),until)
    for hub,days in records.items():
        key='au-gas-'+hub.lower();file=dest/(key+'.json');rows=sorted(days.items())
        save(file,{'id':key,'rows':rows})
        en,zh=HUBS[hub]
        index[key]=dict(id=key,group='commodities',zh=zh+' · 天然气日前出清价',en=en+' · day-ahead gas market price',
                        unit='AUD/GJ',statistic='dayAheadGas',frequency='daily',fields=['date','value'],
                        source='Australian Energy Market Operator · Short Term Trading Market',sourceUrl=GAS_SOURCE,
                        license='AEMO permission for use with accurate attribution',licenseUrl=GAS_RIGHTS,
                        method='Operator-published ex ante clearing price for the named hub and local gas day.',
                        start=rows[0][0],end=rows[-1][0],count=len(rows),sha256=hashlib.sha256(file.read_bytes()).hexdigest())
    save(market,{**catalog,'series':list(index.values())})


GOLD_SOURCE='https://www.tpex.org.tw/zh-tw/other/gold/historical/day.html'
GOLD_DATASET='https://data.gov.tw/en/datasets/32443'
GOLD_BASE='https://www.tpex.org.tw/storage/ch/gold/historical/daily/'
GOLD_NAMES={'AU9901':('臺銀金','Bank of Taiwan Gold'),'AU9902':('一銀金','First Bank Gold')}
GOLD_FIELDS=['date','last','high','low','weightedAverage','volumeMace','turnoverTWD','trades','reportedVolume']
GOLD_UNIT_CHANGE=date(2025,10,1)


def read_gold(payload,day):
    import re
    if not payload:return {}
    rows=list(csv.reader(StringIO(payload.decode('cp950'))))
    header=next((r for r in rows if r and r[0]=='HEADER'),[])
    stamp=next((r[1] for r in rows if r and r[0]=='DATADATE' and len(r)>1),'')
    match=re.fullmatch(r'日期:\s*(\d+)年\s*(\d+)月\s*(\d+)日',stamp)
    if not match or date(int(match[1])+1911,int(match[2]),int(match[3]))!=day:
        raise ValueError('Wrong exchange date in TPEx gold file: '+str(day))
    if (len(header)!=15 or header[1]!='黃金現貨代號' or header[5]!='日均價' or
        header[9:12]!=['最高','最低','最後'] or not header[12].startswith('成交量') or header[13:]!=['成交金額','筆數']):
        raise ValueError('Unexpected TPEx gold trading fields: '+str(header))
    if '台兩' in header[12] and day>=GOLD_UNIT_CHANGE or '台錢' in header[12] and day<GOLD_UNIT_CHANGE:
        raise ValueError('Unexpected TPEx unit for historical volume: '+str(day))
    result={}
    for row in rows:
        if len(row)!=15 or row[0]!='BODY' or row[1] not in GOLD_NAMES:continue
        code=row[1]
        values=[v.replace(',','').strip() for v in row]
        if values[14] in ('','0','---','-','--'):continue
        if not values[14].isdigit() or int(values[14])<=0:raise ValueError('Invalid trade count in TPEx gold report')
        trades=int(values[14])
        high,low,last=map(float,values[9:12]);vwap=float(values[5])
        vol=int(values[12]);turn=int(values[13]);mace=vol*(10 if day<GOLD_UNIT_CHANGE else 1)
        if code in result or not 0<low<=last<=high or not low-.11<=vwap<=high+.11 or vol<=0 or turn<=0:
            raise ValueError('Inconsistent gold range or volume: '+code+' '+str(day))
        result[code]=[day.isoformat(),last,high,low,vwap,mace,turn,trades,vol]
    return result


def load_gold(day,cache):
    import time
    key=day.strftime('%Y%m%d');name=key+'.csv'
    file=Path(cache)/'tpex-gold'/name if cache else None
    if file and file.is_file():return read_gold(file.read_bytes(),day)
    url=f'{GOLD_BASE}{key[:4]}/{key[:6]}/EMdes410.{key}-C.csv'
    with session() as http:
        for i in range(3):
            r=http.get(url,timeout=(6,28))
            if r.status_code!=429:break
            time.sleep(min(60,int(r.headers.get('Retry-After','3'))*2**i))
        if r.status_code in (404,410) or (r.status_code==200 and b'<title>404 -' in r.content[:800]):raw=b''
        else:
            r.raise_for_status();raw=r.content
    observed=read_gold(raw,day)
    if file:
        file.parent.mkdir(exist_ok=True,parents=True)
        file.write_bytes(raw)
    return observed


def build_gold(dest,until,cache=None):
    from zoneinfo import ZoneInfo
    dest=Path(dest);dest.mkdir(exist_ok=True,parents=True)
    if until<FIRST or until>=datetime.now(ZoneInfo('Asia/Taipei')).date():raise ValueError('Use a completed Taipei day')
    path=dest/'catalog.json';catalog=json.loads(path.read_bytes()) if path.exists() else {'version':1,'series':[]}
    index={x['id']:x for x in catalog['series']};old={}
    for code in GOLD_NAMES:
        key='tpex-'+code.lower()
        if key not in index:continue
        raw=(dest/(key+'.json')).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=index[key]['sha256']:raise ValueError('Gold archive checksum mismatch')
        old[code]={r[0]:r for r in json.loads(raw)['rows']}
        if max(old[code])>str(until):raise ValueError('Use a separate output for an earlier date')
    start=FIRST
    if old.keys()==GOLD_NAMES.keys():
        start=max(FIRST,min(date.fromisoformat(max(bars)) for bars in old.values())-timedelta(days=10))
    for code in GOLD_NAMES:old.setdefault(code,{})
    day=start
    while day<=until:
        for code,row in load_gold(day,cache).items():old[code][row[0]]=row
        day+=timedelta(days=1)
    for code,(zh,en) in GOLD_NAMES.items():
        rows=sorted(old[code].values())
        if not rows or len(rows)<2:raise ValueError('Incomplete TPEx historical gold prices: '+code)
        if until-date.fromisoformat(rows[-1][0])>timedelta(days=16):
            raise ValueError('TPEx gold archive has no recent trades for '+code)
        key='tpex-'+code.lower();file=dest/(key+'.json')
        save(file,{'id':key,'rows':rows})
        index[key]=dict(id=key,group='metals',zh='櫃買中心 · '+zh,en='TPEx · '+en,symbol=code,unit='TWD/3.75 g',
                        statistic='goldSpotTrade',frequency='daily',fields=GOLD_FIELDS,volumeUnit='Taiwan mace (3.75 g)',
                        source='Taipei Exchange · spot gold daily trading report',sourceUrl=GOLD_SOURCE,
                        datasetUrl=GOLD_DATASET,license='Open Government Data License, version 1.0',licenseUrl='https://data.gov.tw/license',
                        method='Last, high, low and weighted average of executed spot trades. Prices are TWD per Taiwan mace. Reported volume was in Taiwan taels before 2025-10-01 (10 mace per tael), then in mace.',
                        start=rows[0][0],end=rows[-1][0],count=len(rows),sha256=hashlib.sha256(file.read_bytes()).hexdigest())
    save(path,{**catalog,'series':list(index.values())})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--until',type=date.fromisoformat,required=True);parser.add_argument('--cache',type=Path)
    parser.add_argument('--workers',type=int,default=1);parser.add_argument('--gas',action='store_true');parser.add_argument('--gold',action='store_true')
    args=parser.parse_args()
    if args.gold:build_gold(args.root,args.until,args.cache)
    elif args.gas:build_gas(args.root,args.until,args.cache)
    else:build(args.root,args.until,args.cache,args.workers)
