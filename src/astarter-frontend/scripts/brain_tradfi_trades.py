"""Monthly as-filed positive-price common-share Form 4 samples for AAPL and NVDA.

Select the latest eligible filing in each disclosure month. If multiple tranches
share the filing date, trading date and accession, use the largest reported share
lot, then the higher reported price. Original SEC acceptance times break filing-date ties. Prices and shares are as filed, unadjusted.
"""
import argparse
import calendar
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import io
import json
from pathlib import Path, PurePosixPath
import re
import time
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo
import xml.etree.ElementTree as ET
import zipfile

from brain_tradfi import get, save

INDEX = 'https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets'
CODES = 'https://www.sec.gov/edgar/searchedgar/ownershipformcodes.html'
AGENT = {'User-Agent':'Astarter financial research (https://dapp.ipfund.art)'}
SERIES = {'AAPL':(320193,'苹果','Apple'), 'NVDA':(1045810,'英伟达','NVIDIA')}
FIRST = date(2016,1,1)
EDITION = 'sec-form4-original-xml-v3'
FIELDS = ['filingDate','reportedPriceUSD','transactionDate','transactionCode','reportedShares',
          'priceBasis','accession','filingUrl','venue','footnoteIds','tradeKey','priceAsFiled','footnoteExcerpts','acceptedAtUtc']
MONTHS = ('JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC')
PRIVATE = re.compile(r'privat(?:ely negotiated|e (?:placement|sale|purchase|transfer|transaction|agreement))|'
                     r'(?:sale|purchase|transfer) (?:to|from|between) (?:an? affiliate|the issuer|the company|a related party)|'
                     r'(?:off.market|related.party) (?:sale|purchase|transfer|transaction)|broker.s error account|'
                     r'(?:purchased|acquired) (?:directly )?from (?:the company|the issuer|an affiliate)|'
                     r'(?:sold|transferred) (?:directly )?to (?:the company|the issuer|an affiliate)|'
                     r'employee stock purchase plan|privately arranged|repurchased by (?:the company|the issuer)',re.I)
OPEN = re.compile(r'\b(?:in|on|through) (?:the )?open[- ]market\b|\bopen[- ]market (?:sale|purchase|transaction)s?\b',re.I)
WEIGHTED = re.compile(r'weighted[- ]average',re.I)
FOOT_ID = re.compile(r'\bF\d+\b',re.I)


def get_bytes(url):
    time.sleep(.21)
    return get(url,headers=AGENT).content


def iso_date(value):
    if re.fullmatch(r'\d{2}-[A-Z]{3}-\d{4}',value):
        dd,mm,yy = value.split('-')
        return date(int(yy),MONTHS.index(mm)+1,int(dd)).isoformat()
    return date.fromisoformat(value).isoformat()


def positive(value):
    try:
        n = Decimal(value)
    except (InvalidOperation,TypeError):
        return None
    return n if n.is_finite() and n>0 else None


def accession_url(cik, accession):
    if not re.fullmatch(r'\d{10}-\d\d-\d{6}',accession):
        raise ValueError('Invalid EDGAR accession')
    return f'https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace("-","")}/'


def candidate(symbol, filed, accession, row, notes, url):
    title, code = row['title'].lower(), row['code']
    if ('common stock' not in title or re.search(r'preferred|option|restricted stock units?|convertible',title)
            or code not in ('P','S') or row['direction']!=('A' if code=='P' else 'D')
            or row['swap'].lower() not in ('false','0','')):
        return None
    price, shares = positive(row['price']), positive(row['shares'])
    if not price or not shares:
        return None
    ids = sorted(set(row['refs']),key=lambda ref:int(ref[1:]))
    if any(ref not in notes for ref in ids):
        raise ValueError(f'Unresolved EDGAR footnote: {accession}')
    texts = {ref:' '.join(notes[ref].split()) for ref in ids}
    joined = ' '.join(texts.values())
    if PRIVATE.search(joined):
        return None
    traded = iso_date(row['date'])
    if traded>filed:
        raise ValueError('Transaction postdates disclosure: '+accession)
    venue = 'explicitOpenMarket' if OPEN.search(joined) else 'notDisclosed'
    # Footnotes sometimes describe other prices or transactions. Classify a
    # weighted price only when the filer attaches that language to this price.
    basis = 'reportedWeightedAverage' if any(WEIGHTED.search(notes[ref]) for ref in row['priceRefs']) else 'reportedPrice'
    # Keep the original footnote references and short text cues. The linked filing
    # supplies every full note, including detailed per-price disclosure instructions.
    excerpts = []
    budget = 24
    for ref in sorted(ids, key=lambda k:k not in row['priceRefs']):
        if not budget:
            break
        words = texts[ref].split()
        take = min(len(words), budget, 12)
        if take:
            excerpts.append([ref, ' '.join(words[:take])+('…' if take<len(words) else '')])
            budget -= take
    return [filed,float(price),traded,code,float(shares),basis,accession,url,venue,
            ids,row['key'],str(row['price']),excerpts]


def rank(row):
    return (row[0],row[2],row[6],Decimal(str(row[4])),Decimal(str(row[1])),row[10])


def keep(output, symbol, row, filings=None):
    if row is None:
        return
    month = row[0][:7]
    if filings is not None:
        by_accession=filings[symbol].setdefault(month,{})
        prior=by_accession.get(row[6])
        if prior is None or rank(row)>rank(prior):
            by_accession[row[6]]=row
    old = output[symbol].get(month)
    if old is None or rank(row)>rank(old):
        output[symbol][month]=row


def tab_rows(z,name,selected=None):
    with z.open(name+'.tsv') as f:
        headers=f.readline().decode('utf-8-sig').rstrip('\r\n').split('\t')
        for line in f:
            if selected is not None and line.partition(b'\t')[0] not in selected:
                continue
            values=line.rstrip(b'\r\n').decode('utf-8').split('\t')
            if len(headers)!=len(values):
                raise ValueError('Unexpected SEC table column count: '+name)
            yield dict(zip(headers,values))


def scan_quarter(raw,until,output,filings=None):
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        subjects={}
        for item in tab_rows(z,'SUBMISSION'):
            symbol=item['ISSUERTRADINGSYMBOL'].upper()
            if symbol not in SERIES or item['DOCUMENT_TYPE']!='4' or int(item['ISSUERCIK'])!=SERIES[symbol][0]:
                continue
            filed=iso_date(item['FILING_DATE'])
            if FIRST.isoformat()<=filed<=until.isoformat():
                subjects[item['ACCESSION_NUMBER'].encode()]=(symbol,filed)
        notes={}
        for part in tab_rows(z,'FOOTNOTES',subjects):
            notes.setdefault(part['ACCESSION_NUMBER'],{})[part['FOOTNOTE_ID']]=part['FOOTNOTE_TXT']
        for t in tab_rows(z,'NONDERIV_TRANS',subjects):
            acc=t['ACCESSION_NUMBER'];symbol,filed=subjects[acc.encode()]
            if t['TRANS_FORM_TYPE']!='4' or t['TRANS_CODE'] not in ('P','S'):
                continue
            keys=('SECURITY_TITLE_FN','TRANS_DATE_FN','TRANS_SHARES_FN','TRANS_PRICEPERSHARE_FN',
                  'TRANS_ACQUIRED_DISP_CD_FN','EQUITY_SWAP_TRANS_CD_FN')
            refs=FOOT_ID.findall(' '.join(t[k] for k in keys))
            row=dict(title=t['SECURITY_TITLE'],code=t['TRANS_CODE'],direction=t['TRANS_ACQUIRED_DISP_CD'],
                     swap=t['EQUITY_SWAP_INVOLVED'],price=t['TRANS_PRICEPERSHARE'],shares=t['TRANS_SHARES'],
                     date=t['TRANS_DATE'],refs=refs,priceRefs=FOOT_ID.findall(t['TRANS_PRICEPERSHARE_FN']),
                     key=t['NONDERIV_TRANS_SK'])
            url=accession_url(SERIES[symbol][0],acc)+acc+'-index.htm'
            keep(output,symbol,candidate(symbol,filed,acc,row,notes.get(acc,{}),url),filings)


def quarter_links(html,until):
    found={}
    for href in re.findall(r'href=["\x27]([^"\x27]+)["\x27]',html,re.I):
        url=urljoin(INDEX,href);u=urlsplit(url)
        match=re.search(r'/(20\d\d)q([1-4])_form345\.zip$',u.path,re.I)
        if not match or (u.scheme,u.hostname)!=('https','www.sec.gov'):
            continue
        yr,q=map(int,match.groups());start=date(yr,3*q-2,1)
        if FIRST<=start<=until:
            found[(yr,q)]=url
    if not found or min(found)!=(2016,1):
        raise ValueError('SEC quarterly download history is incomplete')
    last_y,last_q = max(found)
    expected = {(n//4,1+n%4) for n in range(2016*4,last_y*4+last_q)}
    if set(found)!=expected:
        raise ValueError('Missing SEC quarter in the published history')
    return sorted(found.items())


def xml_rows(raw,symbol,filed,acc,url,output,filings=None):
    document=ET.fromstring(raw)
    cik=SERIES[symbol][0]
    if (document.tag!='ownershipDocument' or document.findtext('documentType')!='4'
            or int(document.findtext('issuer/issuerCik','0'))!=cik
            or document.findtext('issuer/issuerTradingSymbol','').upper()!=symbol):
        raise ValueError('Unexpected Form 4 issuer or document: '+acc)
    notes={x.attrib['id']:''.join(x.itertext()) for x in document.findall('./footnotes/footnote')}
    for i,t in enumerate(document.findall('nonDerivativeTable/nonDerivativeTransaction')):
        val=lambda path:t.findtext(path,'')
        price_node='transactionAmounts/transactionPricePerShare'
        ref_paths=('securityTitle','transactionDate',price_node,'transactionAmounts/transactionShares',
                   'transactionAmounts/transactionAcquiredDisposedCode','transactionCoding')
        refs=[f.attrib['id'] for path in ref_paths for f in t.findall(path+'/footnoteId')]
        price_refs=[f.attrib['id'] for f in t.findall(price_node+'/footnoteId')]
        row=dict(title=val('securityTitle/value'),date=val('transactionDate/value'),
                 code=val('transactionCoding/transactionCode'),swap=val('transactionCoding/equitySwapInvolved'),
                 price=val(price_node+'/value'),shares=val('transactionAmounts/transactionShares/value'),
                 direction=val('transactionAmounts/transactionAcquiredDisposedCode/value'),refs=refs,
                 priceRefs=price_refs,key=f'xml-{i+1:06d}')
        keep(output,symbol,candidate(symbol,filed,acc,row,notes,url),filings)


def tail(symbol,after,until,output,load,filings=None):
    cik=SERIES[symbol][0];api='https://data.sec.gov/submissions/'
    doc=json.loads(load(api+f'CIK{cik:010d}.json'))
    if int(doc['cik'])!=cik or symbol not in doc['tickers']:
        raise ValueError('SEC submissions issuer changed for '+symbol)
    pages=[doc['filings']['recent']]
    for p in doc['filings'].get('files',[]):
        if p['filingTo']>=after and p['filingFrom']<=until.isoformat():
            if not re.fullmatch(r'CIK\d{10}-submissions-\d+\.json',p['name']):
                raise ValueError('Unexpected EDGAR pagination path')
            pages.append(json.loads(load(api+p['name'])))
    seen=set()
    for page in pages:
        for filed,acc,form,path in zip(*(page[k] for k in ('filingDate','accessionNumber','form','primaryDocument')),strict=True):
            if not after<=filed<=until.isoformat() or form!='4' or acc in seen:
                continue
            seen.add(acc);name=PurePosixPath(path).name
            if not re.fullmatch(r'[A-Za-z0-9_.-]+\.xml',name,re.I):
                raise ValueError('Unexpected ownership filing path: '+path)
            url=accession_url(cik,acc)+name
            xml_rows(load(url),symbol,filed,acc,url,output,filings)


def original_sample(symbol, hint, raw):
    filed,acc=hint[0],hint[6]
    header=raw.split(b'</SEC-HEADER>',1)[0]
    def field(pattern):
        m=re.search(pattern,header,re.I)
        if not m: raise ValueError('Missing SEC filing header: '+acc)
        return m[1].decode('ascii')
    if (field(rb'ACCESSION NUMBER:\s*([0-9-]+)')!=acc
            or field(rb'FILED AS OF DATE:\s*(\d{8})')!=filed.replace('-','')):
        raise ValueError('Original SEC accession or disclosure date mismatch: '+acc)
    eastern=ZoneInfo('America/New_York')
    accepted=datetime.strptime(field(rb'<ACCEPTANCE-DATETIME>(\d{14})'),'%Y%m%d%H%M%S').replace(tzinfo=eastern)
    for part in raw.split(b'<DOCUMENT>')[1:]:
        if not re.search(rb'<TYPE>4\s',part):
            continue
        doc=re.search(rb'<ownershipDocument[^>]*>[\s\S]+?</ownershipDocument>',part,re.I)
        name=re.search(rb'<FILENAME>([a-zA-Z0-9_.-]+\.xml)\s',part,re.I)
        if not doc or not name:
            continue
        url=accession_url(SERIES[symbol][0],acc)+name[1].decode('ascii')
        winners={symbol:{}}
        xml_rows(doc.group(),symbol,filed,acc,url,winners)
        result=winners[symbol].get(filed[:7])
        if result:
            return result+[accepted.astimezone(timezone.utc).isoformat().replace('+00:00','Z')]
        return None
    raise ValueError('Source filing lacks an original Form 4 XML document: '+acc)


def resolve(symbol, candidates, stored, load, cache):
    # The quarterly TSV can round the original XML price. It identifies
    # candidate filings; only original XML prices ever enter published rows.
    grouped={}
    for hint in candidates.values():
        grouped.setdefault(hint[0],[]).append(hint)
    for filed,hints in sorted(grouped.items(),reverse=True):
        verified=[]
        for hint in hints:
            acc=hint[6]
            if acc in stored:
                verified.append(stored[acc]);continue
            raw_url=accession_url(SERIES[symbol][0],acc)+acc+'.txt'
            path=Path(cache)/'originals'/(acc+'.txt') if cache else None
            raw=path.read_bytes() if path and path.is_file() else load(raw_url)
            result=original_sample(symbol,hint,raw)
            if path and not path.exists():
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
            if result:verified.append(result)
        if verified:
            return max(verified,key=lambda r:(r[13],rank(r)))
    return None


def build(dest,until,cache=None,load=get_bytes):
    dest=Path(dest);catalog_path=dest/'catalog.json'
    catalog=json.loads(catalog_path.read_bytes()) if catalog_path.is_file() else {'version':1,'series':[]}
    metadata={s['id']:s for s in catalog['series']}
    if until>=datetime.now(timezone.utc).date() or until<FIRST:
        raise ValueError('Expected a completed UTC date from 2016 onward')
    if any(metadata.get(symbol.lower()+'-insider-trade',{}).get('coverageThrough','')>until.isoformat() for symbol in SERIES):
        raise ValueError('Use a separate output directory for an earlier as-of date')
    quarters=quarter_links(load(INDEX).decode(),until)
    output={symbol:{} for symbol in SERIES}
    filings={symbol:{} for symbol in SERIES}
    originals={symbol:{} for symbol in SERIES}
    latest=[]
    for symbol in SERIES:
        key=symbol.lower()+'-insider-trade';prior=metadata.get(key)
        path=dest/(key+'.json')
        if prior and prior.get('edition')==EDITION and path.is_file() and sha256(path.read_bytes()).hexdigest()==prior['sha256']:
            latest.append(prior['bulkThrough'])
            closed_before=date.fromisoformat(prior['bulkThrough'])
            recheck_from=closed_before.replace(month=((closed_before.month-1)//3)*3+1,day=1)
            for row in json.loads(path.read_bytes())['rows']:
                if len(row)!=len(FIELDS) or not row[13].endswith('Z'):
                    raise ValueError('Incomplete stored original Form 4 provenance')
                originals[symbol][row[6]]=row
                if row[0]<recheck_from.isoformat() and row[0]<=until.isoformat():
                    keep(output,symbol,row,filings)
        else: latest.append('')
    resume=min(latest)
    if not resume:
        output={symbol:{} for symbol in SERIES}
    for (year,q),url in quarters:
        month=q*3;closed=date(year,month,calendar.monthrange(year,month)[1]).isoformat()
        if resume and closed<resume:
            continue
        path=Path(cache)/PurePosixPath(urlsplit(url).path).name if cache else None
        raw=path.read_bytes() if path and path.is_file() else load(url)
        scan_quarter(raw,until,output,filings)
        if path and not path.exists():
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
    for symbol in SERIES:
        tail(symbol,closed,until,output,load,filings)
    for symbol in SERIES:
        output[symbol]={}
        for hints in filings[symbol].values():
            keep(output,symbol,resolve(symbol,hints,originals[symbol],load,cache))
    for symbol,winners in output.items():
        if not winners or min(winners)[:4]!='2016':
            raise ValueError('Incomplete insider-price history: '+symbol)
    for symbol,(_,zh,en) in SERIES.items():
        rows=[r for _,r in sorted(output[symbol].items())]
        key=symbol.lower()+'-insider-trade';path=dest/(key+'.json')
        save(path,{'id':key,'rows':rows})
        metadata[key]=dict(id=key,group='stock',symbol=symbol,statistic='reportedInsiderTradePrice',
            zh=zh+' · 内部人披露成交价',en=en+' · reported insider trade price',unit='USD/share',
            source='SEC EDGAR · original Form 4, Table I',sourceUrl=INDEX,codeDefinitionsUrl=CODES,
            frequency='monthly-sample',dateBasis='filingDate',start=rows[0][0],end=rows[-1][0],count=len(rows),
            coverageThrough=until.isoformat(),bulkThrough=closed,fields=FIELDS,edition=EDITION,
            method='Original XML from the last SEC-accepted eligible filing per disclosure month; within a filing choose latest trading date and largest reported share lot. Common shares, positive-price P/S, original Form 4 only. Explicit private and related-party trades excluded. Venue is unknown unless identified. As-filed prices unadjusted for splits; no market close or inferred missing months.',
            sha256=sha256(path.read_bytes()).hexdigest())
    save(catalog_path,{**catalog,'series':list(metadata.values())})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dest',type=Path);parser.add_argument('--until',type=date.fromisoformat,default=datetime.now(timezone.utc).date()-timedelta(days=1))
    parser.add_argument('--cache',type=Path);opts=parser.parse_args();build(opts.dest,opts.until,opts.cache)
