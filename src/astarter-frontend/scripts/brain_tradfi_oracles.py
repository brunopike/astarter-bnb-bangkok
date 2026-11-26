"""Read Chainlink proxy rounds at pinned historical blocks; keep read and update times distinct."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from threading import local, Lock
from time import monotonic
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import requests
from brain_tradfi import get, save

NETWORKS = {
    'ethereum': (1, 'https://etherscan.io', ['https://eth-mainnet.public.blastapi.io', 'https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://ethereum-rpc.publicnode.com']),
    'avax': (43114, 'https://build.avax.network/explorer/mainnet/c-chain', ['https://43114.rpc.thirdweb.com', 'https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.gateway.tenderly.co', 'https://avalanche-c-chain-rpc.publicnode.com']),
    'arbitrum': (42161, 'https://arbiscan.io', ['https://42161.rpc.thirdweb.com', 'https://arbitrum.gateway.tenderly.co', 'https://arbitrum-one.public.blastapi.io', 'https://arb1.arbitrum.io/rpc']),
}
# These proxies and answer precision are checked against the network feed directory.
FEEDS = {
    'ethereum': [
        ('gold','黄金','Gold','metals','USD/troy oz','0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6'),
        ('silver','白银','Silver','metals','USD/troy oz','0x379589227b15F1a12195D3f2d90bBc9F31f95235'),
        ('eurusd','欧元 / 美元','EUR / USD','fx','USD/EUR','0xb49f677943BC038e9857d61E7d053CaA2C1734C1'),
        ('tsla','特斯拉','Tesla','stock','USD/share','0xB204328559E17F84eE7A285036AA0d47124F85D5'),
        ('nvda','英伟达','NVIDIA','stock','USD/share','0x2c47b8CD75C818969b398911b70C633e280552d4'),
        ('spy','SPDR 标普 500 ETF','SPDR S&P 500 ETF','etf','USD/share','0x25efbA0d9b115D233cfA849F16BA743E8FFba2a1'),
        ('gbpusd','英镑 / 美元','GBP / USD','fx','USD/GBP','0x5c0Ab2d9b5a7ed9f470386e82BB36A3613cDd4b5'),
        ('jpyusd','日元 / 美元','JPY / USD','fx','USD/JPY','0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb3'),
        ('qqq','Invesco QQQ ETF','Invesco QQQ ETF','etf','USD/share','0xA1D955b4E582C784583df7071B8a3Fb6d4bcaC42')],
    'avax': [('copper','铜 · XCU','Copper · XCU','commodities','USD/XCU','0x32543Ad9dDAC8f883eE4d3c0a21a24E095A9E1B0')],
    'arbitrum': [
        ('wti','WTI 原油期货参考价','WTI futures reference','oil','USD/bbl','0x594b919AD828e693B935705c3F816221729E7AE8'),
        ('aapl','苹果','Apple','stock','USD/share','0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c'),
        ('meta','Meta Platforms','Meta Platforms','stock','USD/share','0xcd1bd86fDc33080DCF1b5715B6FCe04eC6F85845'),
        ('amzn','亚马逊','Amazon','stock','USD/share','0xd6a77691f071E98Df7217BED98f38ae6d2313EBA'),
        ('googl','Alphabet A 类','Alphabet Class A','stock','USD/share','0x1D1a83331e9D255EB1Aaf75026B60dFD00A252ba'),
        ('nvda-arbitrum','英伟达','NVIDIA','stock','USD/share','0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F'),
        ('tsla-arbitrum','特斯拉','Tesla','stock','USD/share','0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3'),
        ('spy-arbitrum','SPDR 标普 500 ETF','SPDR S&P 500 ETF','etf','USD/share','0x46306F3795342117721D8DEd50fbcF6DF2b3cc10'),
        ('msft','微软','Microsoft','stock','USD/share','0xDde33fb9F21739602806580bdd73BAd831DcA867'),
    ],
}
# Creation receipt 0x4a196a7b36f09c04b04f61d0be92f95c443ca5b173777ca7aaec3a33cbfee3be:
# Avalanche block 76,805,732 created the configured copper proxy on 2026-01-29.
FIRST_MONTH={'ethereum':date(2020,1,1),'arbitrum':date(2021,9,1),'avax':date(2026,1,1)}
UTC = timezone.utc
POLICY = 'daily-utc-close-v1'
_SOCKETS = local()
_COOLDOWN = {}
_COOLDOWN_LOCK = Lock()


def client():
    if not hasattr(_SOCKETS, 'session'):
        _SOCKETS.session = requests.Session()
        _SOCKETS.session.headers['User-Agent'] = 'Astarter public oracle history/1.0'
    return _SOCKETS.session


@lru_cache(maxsize=1)
def archived_eth_heights():
    path = Path(__file__).resolve().parents[1] / 'brain-evidence/archive/manifest.json'
    if not path.is_file():
        return {}
    datasets = json.loads(path.read_bytes())['datasets']
    eth = next((d for d in datasets if d['asset'] == 'ETH'), None)
    if not eth or eth.get('coverageMode', 'full') != 'full':
        return {}
    return {s['start']:s['lastHeight'] for s in eth['shards']
            if s['start'] == s['end'] and 'lastHeight' in s}



def rpc(url, calls):
    payload=[dict(jsonrpc='2.0',id=i,method=m,params=p) for i,(m,p) in enumerate(calls)]
    with _COOLDOWN_LOCK:
        if _COOLDOWN.get(url,0)>monotonic():
            raise ValueError('RPC is cooling down after its rate limit')
    response=client().post(url,json=payload,timeout=(5,16))
    body=response.json()
    responses=body if isinstance(body,list) else [body]
    throttled=response.status_code==429 or any(str(r.get('error',{}).get('code'))=='429'
        or 'rate limit exceeded' in str(r.get('error','')).lower() for r in responses)
    if throttled:
        retry=response.headers.get('Retry-After','')
        wait=int(retry) if retry.isdigit() else 5
        with _COOLDOWN_LOCK:
            _COOLDOWN[url]=monotonic()+max(1,wait)
        raise ValueError('RPC rate limit; retry after '+str(wait)+' seconds')
    response.raise_for_status()
    indexed={r['id']:r for r in responses}
    if len(indexed)!=len(payload):
        raise ValueError('Partial RPC response')
    return [indexed[i] for i in range(len(payload))]


def block_for(network,day):
    epoch=int(datetime.combine(day+timedelta(days=1),datetime.min.time(),UTC).timestamp())-1
    if network=='ethereum' and day.isoformat() in archived_eth_heights():
        return archived_eth_heights()[day.isoformat()],epoch
    r=client().get(f'https://coins.llama.fi/block/{network}/{epoch}',timeout=(4,15))
    r.raise_for_status()
    obj=r.json()
    height=obj['height']
    if type(height)!=int or height<0:
        raise ValueError('Invalid block locator')
    return height,epoch


def sample(network,day,precision):
    """Read a single archive block directly, without an aggregation contract."""
    height,cutoff=block_for(network,day)
    failures=[]
    feeds=FEEDS[network]
    for url in NETWORKS[network][2]:
        try:
            chain,header=rpc(url,[('eth_chainId',[]),('eth_getBlockByNumber',[hex(height),False])])
            if int(result(chain),16)!=NETWORKS[network][0]:
                raise ValueError('Wrong chain')
            at,hash_=checked_header(header,height)
            if not cutoff-86400<at<=cutoff:
                raise ValueError('Read block outside UTC day')
            answers=rpc(url,[('eth_call',[{'to':f[-1],'data':ORACLE_METHODS[0]},hex(height)]) for f in feeds])
            found={}
            for feed,answer in zip(feeds,answers):
                addr=feed[-1]
                if 'error' in answer and missing_at(url,height,addr,answer):
                    continue
                quote=result(answer)
                if quote=='0x':
                    continue
                scale=result(rpc(url,[('eth_call',[{'to':addr,'data':ORACLE_METHODS[1]},hex(height)])])[0])
                row=unpack_price(day.isoformat(),height,at,hash_,quote,scale,precision[addr.lower()])
                if row:
                    found[feed[0]]=row
            return found
        except (requests.RequestException,ValueError,KeyError,TypeError) as e:
            failures.append(str(e)[:150])
    raise RuntimeError(f'{network} {day}: {failures}')


def missing_at(endpoint,height,addr,answer):
    message=str(answer.get('error','')).lower()
    if 'execution reverted' not in message:
        return False
    if result(rpc(endpoint,[('eth_getCode',[addr,hex(height)])])[0])=='0x':
        return True
    # Error(string) containing the AggregatorV3Interface no-round diagnostic.
    return 'no data present' in message or '4e6f20646174612070726573656e74'.lower() in message


def result(response):
    if 'result' not in response or response['result'] is None:
        raise ValueError(str(response.get('error','Missing RPC result'))[:200])
    return response['result']


def checked_header(response, height):
    b=result(response)
    if int(b['number'],16)!=height or not re.fullmatch(r'0x[0-9a-f]{64}',b['hash']):
        raise ValueError('Invalid read block')
    return int(b['timestamp'],16),b['hash']


def last_block(url, height, cutoff, block, successor):
    at,block_hash=checked_header(block,height)
    following,_=checked_header(successor,height+1)
    if at<=cutoff<following:
        if cutoff-at>=86400:
            raise ValueError('Read block is outside the UTC day')
        return height,at,block_hash
    # The timestamp service is a hint; even a one-block error changes the UTC close.
    step=1
    while step<=131072:
        test=height-step if at>cutoff else height+1+step
        if test<0:
            raise ValueError('No UTC close before genesis')
        response=rpc(url,[('eth_getBlockByNumber',[hex(test),False])])[0]
        ts,_=checked_header(response,test)
        if (ts<=cutoff)==(at>cutoff):
            lo,hi=sorted([test,height if at>cutoff else height+1])
            break
        step*=2
    else:
        raise ValueError('Block locator is too far from UTC close')
    while lo+1<hi:
        middle=(lo+hi)//2
        ts,_=checked_header(rpc(url,[('eth_getBlockByNumber',[hex(middle),False])])[0],middle)
        if ts<=cutoff:
            lo=middle
        else:
            hi=middle
    ts,h=checked_header(rpc(url,[('eth_getBlockByNumber',[hex(lo),False])])[0],lo)
    if not cutoff-86400<ts<=cutoff:
        raise ValueError('No confirmed block in UTC day')
    return lo,ts,h


def unpack_price(day, height, at, hash_, answer, decimals, expected):
    if decimals=='0x' and answer=='0x':
        return None
    if not re.fullmatch(r'0x[0-9a-fA-F]{64}',decimals) or not re.fullmatch(r'0x[0-9a-fA-F]{320}',answer):
        raise ValueError('Malformed oracle response')
    precision=int(decimals,16)
    if precision!=expected:
        raise ValueError('Proxy precision differs from the feed directory')
    rid,price,started,updated,answered=[int(answer[i:i+64],16) for i in range(2,len(answer),64)]
    if not (rid & (2**64-1)) and price==started==updated==0:
        return None
    if not (0<rid<2**80 and 0<price<2**255 and 0<=started<=updated<=at and updated and answered>=rid):
        raise ValueError('Invalid oracle round')
    if at-updated>86400*10:
        return None
    return [day,price/10**precision,height,hash_,updated,str(rid)]


# Multicall is read-only here. Old blocks without the batch contract use direct proxy calls.
MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
MULTICALL2_ETH = '0x5ba1e12693dc8f9c48aad8770482f4739beed696'
MULTICALL1_ETH = '0xeefba1e63905ef1d7acba5a8513c70307c1ce441'
ORACLE_METHODS = ('0xfeaf968c', '0x313ce567')


def multicall_payload(feeds,legacy=False):
    # tryAggregate(false, (target, callData)[]); all payloads are four-byte selectors.
    word=lambda n:f'{n:064x}'
    items=[addr[2:].lower().rjust(64,'0')+word(64)+word(4)+func[2:].ljust(64,'0')
           for *_,addr in feeds for func in ORACLE_METHODS]
    offsets=''.join(word(len(items)*32+i*128) for i in range(len(items)))
    header='0x252dba42'+word(32) if legacy else '0xbce38bd7'+word(0)+word(64)
    return header+word(len(items))+offsets+''.join(items)


def multicall_values(raw,n):
    data=bytes.fromhex(raw.removeprefix('0x'))
    def integer(pos):
        if pos<0 or pos+32>len(data):
            raise ValueError('Truncated multicall word')
        return int.from_bytes(data[pos:pos+32],'big')
    if integer(0)!=32 or integer(32)!=n:
        raise ValueError('Invalid multicall array')
    out=[]
    for i in range(n):
        start=64+integer(64+32*i)
        valid,offset=integer(start),integer(start+32)
        if valid not in (0,1) or offset!=64:
            raise ValueError('Invalid multicall result')
        length=integer(start+64)
        if start+96+length>len(data):
            raise ValueError('Invalid multicall bytes')
        value='0x'+data[start+96:start+96+length].hex()
        out.append({'result':value} if valid else {'error':{'message':'execution reverted','data':value}})
    return out


def legacy_values(raw,height,n):
    data=bytes.fromhex(raw.removeprefix('0x'))
    def integer(pos):
        if pos+32>len(data):
            raise ValueError('Truncated legacy aggregate')
        return int.from_bytes(data[pos:pos+32],'big')
    if integer(0)!=height or integer(32)!=64 or integer(64)!=n:
        raise ValueError('Invalid legacy aggregate header')
    values=[]
    for i in range(n):
        start=96+integer(96+32*i)
        length=integer(start)
        if start+32+length>len(data):
            raise ValueError('Truncated legacy aggregate item')
        values.append({'result':'0x'+data[start+32:start+32+length].hex()})
    return values


def call_proxies(endpoint,network,feeds,blocks):
    output=[]
    days=list(blocks.values())
    payload=multicall_payload(feeds)
    def direct(h):
        calls=[('eth_call',[{'to':f[-1],'data':selector},hex(h)]) for f in feeds for selector in ORACLE_METHODS]
        return rpc(endpoint,calls)
    if network=='ethereum' and all(d<'2021-02-01' for d in blocks):
        encoded=multicall_payload(feeds,legacy=True)
        calls=[('eth_call',[{'to':MULTICALL1_ETH,'data':encoded},hex(h)]) for h,_,_ in days]
        for (h,_,_),response in zip(days,rpc(endpoint,calls)):
            if 'error' in response and 'execution reverted' in str(response['error']).lower():
                output.extend(direct(h))
            else:
                output.extend(legacy_values(result(response),h,len(feeds)*2))
        return output
    calls=[('eth_call',[{'to':MULTICALL3,'data':payload},hex(h)]) for h,_,_ in days]
    for (h,_,_),response in zip(days,rpc(endpoint,calls)):
        raw=result(response)
        if raw=='0x' and network=='ethereum':
            raw=result(rpc(endpoint,[('eth_call',[{'to':MULTICALL2_ETH,'data':payload},hex(h)])])[0])
        output.extend(direct(h) if raw=='0x' else multicall_values(raw,2*len(feeds)))
    return output


def sample_days(network, locators, feeds, precisions):
    dates=list(locators)
    calls=[('eth_chainId',[])]
    for height,_ in locators.values():
        calls.extend([('eth_getBlockByNumber',[hex(n),False]) for n in [height,height+1]])
    failures=[]
    for endpoint in NETWORKS[network][2]:
        try:
            headers=rpc(endpoint,calls)
            if int(result(headers[0]),16)!=NETWORKS[network][0]:
                raise ValueError('Unexpected chain ID')
            blocks={}
            for i,day in enumerate(dates):
                h,cut=locators[day]
                blocks[day]=last_block(endpoint,h,cut,*headers[1+2*i:3+2*i])
            active=feeds
            if network=='arbitrum' and len(dates)==1 and dates[0]<'2022-09-15':
                # Archive access differs across the Arbitrum Classic/Nitro transition.
                # Probe each proxy at the exact block and ask only deployed contracts.
                height=blocks[dates[0]][0]
                codes=rpc(endpoint,[('eth_getCode',[f[-1],hex(height)]) for f in feeds])
                active=[f for f,c in zip(feeds,codes) if result(c)!='0x']
                if not active:
                    return {dates[0]:{}}
            slots=[(day,h,at,hash_,f[0],f[-1]) for day,(h,at,hash_) in blocks.items() for f in active]
            values=call_proxies(endpoint,network,active,blocks)
            observations={day:{} for day in dates}
            for i,(day,h,at,hash_,name,addr) in enumerate(slots):
                a,d=values[2*i:2*i+2]
                if 'error' in a or 'error' in d:
                    if 'error' in a and missing_at(endpoint,h,addr,a):
                        continue
                    raise ValueError(str(a.get('error',d.get('error')))[:160])
                row=unpack_price(day,h,at,hash_,result(a),result(d),precisions[addr.lower()])
                if row:
                    observations[day][name]=row
            return observations
        except (requests.RequestException,ValueError,KeyError,TypeError,IndexError) as exc:
            failures.append(str(exc)[:150])
    raise RuntimeError(f'{network} {dates[0]} to {dates[-1]}: {failures}')


def ordered_dates(first,until,done):
    pending=[first+timedelta(days=i) for i in range((until-first).days+1)
             if (first+timedelta(days=i)).isoformat() not in done]
    # Recent dates first; older month ends establish dated coverage across the full history.
    pending.sort(key=lambda d:(0 if (until-d).days<32 else 1 if (d+timedelta(days=1)).month!=d.month else 2,-d.toordinal()))
    return pending


def checked_precision(network,feeds):
    directory={'ethereum':'feeds-mainnet.json','avax':'feeds-avalanche-mainnet.json','arbitrum':'feeds-ethereum-mainnet-arbitrum-1.json'}[network]
    listed={str(x.get('proxyAddress')).lower():x for x in get('https://reference-data-directory.vercel.app/'+directory).json()}
    values={}
    for feed in feeds:
        address=feed[-1].lower()
        value=listed[address]['decimals']
        if type(value)!=int or not 0<=value<=18:
            raise ValueError('Invalid directory precision for '+address)
        values[address]=value
    return values


def save_progress(dest, network, feeds, catalog, series, done, precision):
    for name,zh,en,group,unit,contract in feeds:
        key='oracle-'+name
        rows=sorted(series[name].values())
        if not rows:
            continue
        path=dest/(key+'.json')
        save(path,{'id':key,'rows':rows})
        catalog[key]=dict(id=key,related=name.removesuffix('-arbitrum'),group=group,zh=zh,en=en,unit=unit,statistic='oracle',
            source='Chainlink',sourceUrl=NETWORKS[network][1]+'/address/'+contract,network=network,contract=contract,
            start=rows[0][0],end=rows[-1][0],count=len(rows),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            sampling='dailyUtcClose',quoteMaximumAgeDays=10,decimals=precision[contract.lower()])
    # The coverage file is written last so interrupted publication can safely replay a batch.
    save(dest/'catalog.json',{'version':1,'series':list(catalog.values())})
    save(dest/('coverage-'+network+'.json'),{'method':POLICY,'feeds':sorted(f[-1].lower() for f in feeds),'dates':sorted(done)})


def update_network(dest,until,network,feeds,catalog_path,catalog,limit=64):
    if until>=datetime.now(UTC).date():
        raise ValueError('Choose a completed UTC day')
    precision=checked_precision(network,feeds)
    checkpoint=dest/('coverage-'+network+'.json')
    state=json.loads(checkpoint.read_bytes()) if checkpoint.is_file() else {}
    addresses=sorted(f[-1].lower() for f in feeds)
    done=set(state.get('dates',[])) if state.get('method')==POLICY and state.get('feeds')==addresses else set()
    series={}
    for name,*_ in feeds:
        path=dest/('oracle-'+name+'.json')
        series[name]={r[0]:r for r in json.loads(path.read_bytes())['rows']} if path.exists() else {}
    missing=ordered_dates(FIRST_MONTH[network],until,done)
    if limit:
        missing=missing[:limit]
    failures=[]
    def read(group):
        locators={d.isoformat():block_for(network,d) for d in group}
        return sample_days(network,locators,feeds,precision)
    # Groups stay small enough for the public RPC batch limits. No unbounded request fan-out.
    ordinary=[d for d in missing if network!='arbitrum' or d>=date(2022,9,15)]
    size=1 if network=='avax' else 4
    groups=[ordinary[i:i+size] for i in range(0,len(ordinary),size)]
    if network=='arbitrum':
        groups.extend([d] for d in missing if d<date(2022,9,15))
    with ThreadPoolExecutor(max_workers=2 if network=='avax' else 3) as pool:
        for i in range(0,len(groups),12):
            tasks={pool.submit(read,g):g for g in groups[i:i+12]}
            successes=0
            for f in as_completed(tasks):
                try:
                    observations=f.result()
                except Exception as e:
                    failures.append(str(e)[:320])
                    continue
                for day,records in observations.items():
                    for name,values in series.items():
                        if name in records:
                            values[day]=records[name]
                        else:
                            values.pop(day,None)
                    done.add(day)
                    successes+=1
            if successes:
                save_progress(dest,network,feeds,catalog,series,done,precision)
            if not successes and failures:
                break
    if until.isoformat() in done:
        for name,records in series.items():
            available=[stamp for stamp in records if stamp<=until.isoformat()]
            if available and date.fromisoformat(max(available))<until-timedelta(days=10):
                failures.append(f'{name}: latest qualifying UTC snapshot is {max(available)}')
    return failures


def build(dest,until,limit=64,only=None):
    catalog_path=dest/'catalog.json'
    catalog={s['id']:s for s in json.loads(catalog_path.read_bytes())['series']} if catalog_path.exists() else {}
    problems=[]
    for network,feeds in FEEDS.items():
        if only and network!=only:
            continue
        try:
            problems.extend(update_network(dest,until,network,feeds,catalog_path,catalog,limit))
        except Exception as exc:
            problems.append(f'{network}: {exc}')
    if problems:
        raise RuntimeError(str(len(problems))+' failed oracle reads: '+'; '.join(problems[:6]))


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dest',type=Path)
    parser.add_argument('until',type=date.fromisoformat)
    parser.add_argument('--network',choices=tuple(FEEDS))
    parser.add_argument('--full-history',action='store_true')
    args=parser.parse_args()
    build(args.dest,args.until,0 if args.full_history else 64,args.network)
