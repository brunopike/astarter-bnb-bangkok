"""Read Chainlink proxy rounds at pinned historical blocks; keep read and update times distinct."""
import calendar
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import requests
from brain_tradfi import get, months, save

NETWORKS = {
    'ethereum': (1, 'https://etherscan.io', ['https://eth-mainnet.public.blastapi.io', 'https://rpc.mevblocker.io', 'https://ethereum-rpc.publicnode.com']),
    'avax': (43114, 'https://build.avax.network/explorer/mainnet/c-chain', ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com']),
    'arbitrum': (42161, 'https://arbiscan.io', ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum-one.public.blastapi.io']),
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
        ('qqq','Invesco QQQ ETF','Invesco QQQ ETF','etf','USD/share','0xA1D955b4E582C784583df7071B8a3Fb6d4bcaC42')],
    'avax': [('copper','铜 · XCU','Copper · XCU','commodities','USD/XCU','0x32543Ad9dDAC8f883eE4d3c0a21a24E095A9E1B0')],
    'arbitrum': [
        ('wti','WTI 原油期货参考价','WTI futures reference','oil','USD/bbl','0x594b919AD828e693B935705c3F816221729E7AE8'),
        ('aapl','苹果','Apple','stock','USD/share','0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c'),
        ('msft','微软','Microsoft','stock','USD/share','0xDde33fb9F21739602806580bdd73BAd831DcA867'),
    ],
}
# Creation receipt 0x4a196a7b36f09c04b04f61d0be92f95c443ca5b173777ca7aaec3a33cbfee3be:
# Avalanche block 76,805,732 created the configured copper proxy on 2026-01-29.
FIRST_MONTH={'ethereum':date(2020,1,1),'arbitrum':date(2021,9,1),'avax':date(2026,1,1)}
UTC = timezone.utc


def rpc(url, calls):
    payload=[dict(jsonrpc='2.0',id=i,method=m,params=p) for i,(m,p) in enumerate(calls)]
    result=requests.post(url,json=payload,timeout=(5,22))
    result.raise_for_status()
    indexed={r['id']:r for r in result.json()}
    if len(indexed)!=len(payload):
        raise ValueError('Partial RPC response')
    return [indexed[i] for i in range(len(payload))]


def block_for(network,day):
    epoch=int(datetime.combine(day+timedelta(days=1),datetime.min.time(),UTC).timestamp())-1
    obj=get(f'https://coins.llama.fi/block/{network}/{epoch}').json()
    height=obj['height']
    if type(height)!=int or height<0:
        raise ValueError('Invalid block locator')
    return height,epoch


def sample(network,day,precision):
    height,cutoff=block_for(network,day)
    errors=[]
    for url in NETWORKS[network][2]:
        try:
            headers=rpc(url,[('eth_chainId',[]),('eth_getBlockByNumber',[hex(height),False])])
            if int(headers[0]['result'],16)!=NETWORKS[network][0]:
                raise ValueError('Wrong chain')
            block=headers[1]['result']
            if int(block['timestamp'],16)>cutoff:
                height-=1
                block=rpc(url,[('eth_getBlockByNumber',[hex(height),False])])[0]['result']
            at=int(block['timestamp'],16)
            if int(block['number'],16)!=height or not cutoff-86400<at<=cutoff or not re.fullmatch('0x[0-9a-f]{64}',block['hash']):
                raise ValueError('Read block is outside the UTC date')
            calls=[('eth_call',[dict(to=f[-1],data='0xfeaf968c'),hex(height)]) for f in FEEDS[network]]
            answer={}
            for feed,response in zip(FEEDS[network],rpc(url,calls)):
                if 'error' in response:
                    if 'execution reverted' in str(response['error']).lower():
                        code=rpc(url,[('eth_getCode',[feed[-1],hex(height)])])[0]
                        if code.get('result')=='0x':
                            continue
                    raise ValueError(str(response['error'])[:160])
                raw=response['result']
                if raw=='0x':
                    continue
                if not re.fullmatch(r'0x[0-9a-fA-F]{320}',raw):
                    raise ValueError('Unexpected latestRoundData ABI')
                round_id,value,started,updated,answered=[int(raw[i:i+64],16) for i in range(2,len(raw),64)]
                if not (round_id & (2**64-1)) and value==started==updated==0:
                    continue
                if not (round_id and 0<value<2**255 and 0<updated<=at and answered>=round_id):
                    raise ValueError('Invalid oracle round')
                if at-updated<=86400*10:
                    answer[feed[0]]=[day.isoformat(),value/10**precision[feed[-1].lower()],height,block['hash'],updated,str(round_id)]
            return answer
        except (requests.RequestException,ValueError,KeyError,TypeError) as e:
            errors.append(str(e)[:150])
    raise RuntimeError(f'{network} {day}: '+str(errors))


def update_network(dest,until,network,feeds,catalog_path,catalog):
    problems=[]
    directory={'ethereum':'feeds-mainnet.json','avax':'feeds-avalanche-mainnet.json','arbitrum':'feeds-ethereum-mainnet-arbitrum-1.json'}[network]
    listed={str(x.get('proxyAddress')).lower():x for x in get('https://reference-data-directory.vercel.app/'+directory).json()}
    precision={f[-1].lower():int(listed[f[-1].lower()]['decimals']) for f in feeds}
    if any(p!=(18 if network=='avax' else 8) for p in precision.values()):
        raise ValueError('Unexpected feed precision')
    checkpoint=dest/('coverage-'+network+'.json')
    state=json.loads(checkpoint.read_bytes()) if checkpoint.exists() else {}
    addresses=sorted(f[-1].lower() for f in feeds)
    first=FIRST_MONTH[network]
    prior_dates={d for d in state.get('dates',[]) if date.fromisoformat(d)>=first}
    done=set(prior_dates) if state.get('feeds')==addresses else set()
    candidates={m.replace(day=calendar.monthrange(m.year,m.month)[1]) for m in months(first,until)}
    start_daily=min([date.fromisoformat(d) for d in prior_dates if date.fromisoformat(d).day!=calendar.monthrange(int(d[:4]),int(d[5:7]))[1]] or [until-timedelta(days=14)])
    candidates.update(start_daily+timedelta(days=i) for i in range((until-start_daily).days+1))
    missing=sorted(d for d in candidates if d<=until and d.isoformat() not in done)
    series={}
    for name,*_ in feeds:
        path=dest/('oracle-'+name+'.json')
        series[name]={r[0]:r for r in json.loads(path.read_bytes())['rows']} if path.exists() else {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks={pool.submit(sample,network,d,precision):d.isoformat() for d in missing}
        for task in as_completed(tasks):
            day=tasks[task]
            try:
                for key,row in task.result().items():
                    series[key][day]=row
                done.add(day)
            except Exception as e:
                problems.append(str(e)[:280])
    for name,zh,en,group,unit,contract in feeds:
        key='oracle-'+name
        rows=sorted(series[name].values())
        if not rows:
            problems.append('No verified rounds for '+key)
            continue
        if (until-date.fromisoformat(rows[-1][0])).days>10:
            problems.append('No recent oracle round for '+key)
        path=dest/(key+'.json')
        save(path,{'id':key,'rows':rows})
        catalog[key]=dict(id=key,related=name,group=group,zh=zh,en=en,unit=unit,statistic='oracle',source='Chainlink',
            sourceUrl=NETWORKS[network][1]+'/address/'+contract,network=network,contract=contract,start=rows[0][0],end=rows[-1][0],
            count=len(rows),sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    save(catalog_path,{'version':1,'series':list(catalog.values())})
    save(checkpoint,{'feeds':addresses,'dates':sorted(done)})
    return problems


def build(dest,until):
    catalog_path=dest/'catalog.json'
    catalog={s['id']:s for s in json.loads(catalog_path.read_bytes())['series']} if catalog_path.exists() else {}
    problems=[]
    for network,feeds in FEEDS.items():
        try:
            problems.extend(update_network(dest,until,network,feeds,catalog_path,catalog))
        except Exception as exc:
            problems.append(f'{network}: {exc}')
    if problems:
        raise RuntimeError(str(len(problems))+' failed oracle reads: '+'; '.join(problems[:6]))


if __name__=='__main__':
    import sys
    build(Path(sys.argv[1]),date.fromisoformat(sys.argv[2]))
