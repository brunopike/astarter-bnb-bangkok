import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {HUB_RESOURCES,HUB_SYMBOLS} from './market-hub-data.mjs';
import {PUBLIC_NEWS_SOURCE} from './public-news.mjs';
import {PUBLIC_SOCIAL_SOURCE} from './public-social.mjs';
const NOW=Date.UTC(2026,10,4,12),body={data:{total_market_cap:{usd:1000},total_volume:{usd:200},market_cap_percentage:{btc:55},market_cap_change_percentage_24h_usd:2,updated_at:NOW/1000}};
const response=(value,status=200,retry=null)=>({ok:status===200,status,headers:{get:key=>key==='Retry-After'?retry:null},text:async()=>JSON.stringify(value)});
const depth={lastUpdateId:123,bids:[['99.99','2'],['99.90','3']],asks:[['100.01','4'],['100.10','5']]};
async function call(handle,url='/api/market-hub?resource=global',method='GET'){
 const result={};result.handled=await handle({url,method},{writeHead(status,headers){result.status=status;result.headers=headers;},end(text){result.body=JSON.parse(text);}});return result;
}
test('a market snapshot keeps the provider that supplied its data through retries and cache hits',async t=>{
 const previous=process.env.COINMARKETCAP_API_KEY;
 process.env.COINMARKETCAP_API_KEY='test-only';
 t.after(()=>{if(previous===undefined)delete process.env.COINMARKETCAP_API_KEY;else process.env.COINMARKETCAP_API_KEY=previous;});
 const primary={status:{error_code:0},data:{btc_dominance:60,last_updated:new Date(NOW).toISOString(),quote:{USD:{total_market_cap:2000,total_volume_24h:100,total_market_cap_yesterday_percentage_change:1}}}};
 let at=NOW,available=true;
 const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{
  calls.push(new URL(url).hostname);
  if(url.startsWith('https://pro-api.coinmarketcap.com/'))return response(available?primary:{},200);
  assert.equal(options.headers['X-CMC_PRO_API_KEY'],undefined);
  return response(body);
 }});
 const direct=await call(handle);
 assert.equal(direct.body.source,'coinmarketcap');
 assert.equal(direct.body.body.data.total_market_cap.usd,2000);
 assert.deepEqual((await call(handle)).body,direct.body);
 at+=HUB_RESOURCES.global.interval;
 available=false;
 const fallback=await call(handle);
 assert.equal(fallback.body.source,'coingecko');
 assert.deepEqual(fallback.body.body,body);
 assert.deepEqual((await call(handle)).body,fallback.body);
 assert.deepEqual(calls,['pro-api.coinmarketcap.com','pro-api.coinmarketcap.com','api.coingecko.com']);
 at+=HUB_RESOURCES.global.interval;
 available=true;
 assert.equal((await call(handle)).body.source,'coinmarketcap');
});
const newsRSS=`<rss version="2.0"><channel><title>CoinDesk</title><item><title>Bitcoin and Ethereum</title><link>https://www.coindesk.com/markets/story</link><guid>story-1</guid><pubDate>${new Date(NOW-1000).toUTCString()}</pubDate><description>Not for republication</description></item></channel></rss>`;
test('fresh Ethereum transfer receipts can be shared across relay instances without resetting the clock',async()=>{
 let at=NOW,saved=null,calls=0;
 const cache={
  async get(key){assert.equal(key,'eth-transfers-v2');return saved;},
  async set(_key,value,options){assert.equal(options.ttl,60);saved=value;}
 };
 const make=()=>createMarketHubRelay({cache,now:()=>at,fetchImpl:async()=>{calls++;return response({items:[]});}});
 const path='/api/market-hub?resource=chain-insight&metric=eth-transfers';
 const first=await call(make(),path);
 assert.equal(first.status,200);
 at+=30_000;
 const shared=await call(make(),path);
 assert.deepEqual(shared.body,first.body);
 assert.equal(calls,1);
 at+=31_000;
 const expired=await call(make(),path);
 assert.equal(expired.body.receivedAt,at);
 assert.equal(calls,2);
});
test('when the explorer fails, safe blocks and successful transaction receipts bound the native transfer sample',async()=>{
 const head=1000,hex=n=>'0x'+n.toString(16),hash=n=>'0x'+n.toString(16).padStart(64,'0');
 const calls=[];
 const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async(url,init)=>{
  if(url.startsWith('https://eth.blockscout.com/'))return response({},502);
  assert.equal(url,'https://ethereum-rpc.publicnode.com');
  assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');
  const batch=JSON.parse(init.body);calls.push([batch[0].method,batch.length]);
  const transfers=[1,2].map(n=>({input:'0x',from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),value:hex(100n*10n**18n),hash:hash(n),blockHash:hash(head)}));
  return response(batch.map(({id,method,params})=>{
   const height=params[0]==='safe'?head:Number(params[0]),txHash=params[0];
   const result=method==='eth_getBlockByNumber'?{number:hex(height),hash:hash(height),parentHash:hash(height-1),timestamp:hex(NOW/1000-12*(head-height)),
    transactions:params[1]&&height===head?transfers:[]}:
    {transactionHash:txHash,blockHash:hash(head),status:txHash===hash(1)?'0x1':'0x0'};
   return {jsonrpc:'2.0',id,result};
  }).reverse());
 }});
 const result=await call(handle,'/api/market-hub?resource=chain-insight&metric=eth-transfers');
 assert.equal(result.status,200);assert.equal(result.body.body.source,'PublicNode');
 assert.deepEqual(result.body.body.sample,{fromBlock:983,throughBlock:1000,throughAt:NOW});
 assert.deepEqual(result.body.body.rows.map(row=>row.hash),[hash(1)]);
 assert.deepEqual(calls,[['eth_getBlockByNumber',1],['eth_getBlockByNumber',6],['eth_getBlockByNumber',6],['eth_getBlockByNumber',6],['eth_getTransactionReceipt',2]]);
});
test('social relay reads only three fixed public tags and shares the original interaction sampling clock across viewers',async()=>{
 const post={id:'1',uri:'https://mastodon.social/users/alice/statuses/1',url:'https://mastodon.social/@alice/1',created_at:new Date(NOW-1000).toISOString(),edited_at:null,visibility:'public',sensitive:false,spoiler_text:'',content:'<p>Bitcoin</p>',tags:[{name:'bitcoin'}],account:{acct:'alice',display_name:'Alice',url:'https://mastodon.social/@alice',bot:null},favourites_count:0,reblogs_count:0,replies_count:1,reblog:null};
 let at=NOW;const calls=[],handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{calls.push({url,options});return response([post]);}}),path='/api/market-hub?resource=social&selection_version=4&limit=20',first=await call(handle,path);
 assert.equal(first.status,200);assert.deepEqual(calls.map(c=>c.url),PUBLIC_SOCIAL_SOURCE.urls);assert.ok(calls.every(c=>c.options.credentials==='omit'));assert.equal(first.body.items.length,1);assert.equal(first.body.items[0].data.likes,0);
 at+=60000;const second=await call(handle,path.replace('=4','=5').replace('=20','=50'));assert.equal(second.status,200);assert.equal(second.body.selection_version,5);assert.equal(calls.length,3);assert.equal(second.body.requested_at_ms,at);assert.equal(second.body.items[0].data.observed_at_ms,NOW);assert.equal(second.body.items[0].valid_until_ms,first.body.items[0].valid_until_ms);
 for(const extra of ['&q=anything','&url=https://evil.test','&limit=20','&resource=social','&account=SIM-01'])assert.equal((await call(handle,path+extra)).status,400);assert.equal(calls.length,3);
 const denied=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>response({},403)}),failure=await call(denied,path);assert.equal(failure.status,502);assert.equal(failure.body.items,undefined);
 const empty=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>response([])}),success=await call(empty,path);assert.equal(success.status,200);assert.equal(success.body.coverage.scope,'SOCIAL_TAG_SAMPLES');assert.deepEqual(success.body.items,[]);
});
test('public news shares only its fixed publisher fetch, while projecting each selection and keeping source publication time',async()=>{
 let at=NOW;const calls=[],handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>newsRSS};}});
 const path='/api/market-hub?resource=news&selection_version=7&limit=20',first=await call(handle,path);
 assert.equal(first.status,200);assert.equal(calls[0].url,PUBLIC_NEWS_SOURCE.url);assert.equal(calls[0].options.headers.Accept,PUBLIC_NEWS_SOURCE.headers.Accept);
 assert.equal(first.body.selection_version,7);assert.equal(first.body.items[0].data.summary,'');assert.deepEqual(first.body.items[0].data.symbols,['BTC','ETH']);
 at+=60000;const second=await call(handle,path.replace('=7','=8').replace('=20','=50'));
 assert.equal(calls.length,1);assert.equal(second.body.selection_version,8);assert.equal(second.body.requested_at_ms,at);
 assert.equal(second.body.as_of_ms,first.body.as_of_ms);assert.equal(second.body.items[0].valid_until_ms,first.body.items[0].valid_until_ms);
 for(const extra of ['&url=https://evil.test','&resource=news','&limit=20','&account=SIM-01'])assert.equal((await call(handle,path+extra)).status,400);
 assert.equal((await call(handle,path.replace('limit=20','limit=51'))).status,400);assert.equal(calls.length,1);
});
test('an invalid or rate-limited news source never becomes an empty successful feed',async()=>{
 for(const text of ['<html>Access denied</html>',newsRSS.replace('www.coindesk.com','evil.test')]){
  const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>({ok:true,text:async()=>text})});
  const result=await call(handle,'/api/market-hub?resource=news');assert.equal(result.status,502);assert.equal(result.body.items,undefined);
 }
 let calls=0;const limited=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>{calls++;return response({},429,'120');}});
 const failed=await call(limited,'/api/market-hub?resource=news');assert.equal(failed.status,429);assert.equal(failed.headers['Retry-After'],'120');
 assert.equal((await call(limited,'/api/market-hub?resource=news')).status,429);assert.equal(calls,1);
});
test('spot depth binds its fixed market, observation window, coverage and cache without refreshing old time',async()=>{
 let at=NOW;const calls=[],handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);at+=100;return response(depth);}});
 const path='/api/market-hub?resource=spot-depth&symbol=BTC',first=await call(handle,path);
 assert.equal(first.status,200);assert.equal(calls[0],'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=100');
 assert.equal(first.body.body.requestStartedAt,NOW);assert.equal(first.body.receivedAt,NOW+100);assert.equal(first.body.body.validUntil,NOW+30000);
 assert.equal(first.body.body.bidCoverageComplete,false);assert.equal(first.body.body.bidLevels,2);
 at+=5000;assert.deepEqual((await call(handle,path)).body,first.body);assert.equal(calls.length,1);
 await call(handle,path.replace('BTC','ETH'));assert.equal(calls.length,2);
 for(const query of ['symbol=SPX','symbol=BTCUSDT','symbol=btc','symbol=BTC&symbol=ETH','symbol=BTC&url=https://evil.test'])assert.equal((await call(handle,'/api/market-hub?resource=spot-depth&'+query)).status,400);
 assert.equal(calls.length,2);
});

test('crossed, incomplete, oversized and too slow depth responses fail closed',async()=>{
 for(const body of [{...depth,asks:[['99','1']]},{...depth,bids:[]},{...depth,bids:Array(101).fill(['99','1'])}]){
  const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>response(body)});
  assert.equal((await call(handle,'/api/market-hub?resource=spot-depth&symbol=BTC')).status,502);
 }
 let at=NOW;const slow=createMarketHubRelay({now:()=>at,fetchImpl:async()=>{at+=8001;return response(depth);}});
 assert.equal((await call(slow,'/api/market-hub?resource=spot-depth&symbol=BTC')).status,502);
});
test('relay deadlines release a wedged fetch or body and preserve per-market backoff',async()=>{
 for(const fetcher of [()=>new Promise(()=>{}),()=>({ok:true,text:()=>new Promise(()=>{})})]){
  let expire,calls=0,at=NOW;const handle=createMarketHubRelay({now:()=>at,setTimer:fn=>{expire=fn;return 1;},clearTimer:()=>{},fetchImpl:()=>{calls++;return fetcher();}});
  const first=call(handle,'/api/market-hub?resource=spot-depth&symbol=BTC');await new Promise(resolve=>setImmediate(resolve));expire();assert.equal((await first).status,502);
  assert.equal((await call(handle,'/api/market-hub?resource=spot-depth&symbol=BTC')).status,502);assert.equal(calls,1);
  at+=15000;const second=call(handle,'/api/market-hub?resource=spot-depth&symbol=BTC');await new Promise(resolve=>setImmediate(resolve));expire();assert.equal((await second).status,502);assert.equal(calls,2);
 }
});
test('relay only handles approved public GET resources, never arbitrary URLs or credentials',async()=>{
 const calls=[],handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return response(body);}});
 assert.equal((await call(handle,'/other')).handled,false);
 for(const url of ['/api/market-hub?resource=wallet','/api/market-hub?resource=https://evil.example','/api/market-hub?resource=global&resource=assets'])assert.equal((await call(handle,url)).status,400);
 assert.equal((await call(handle,undefined,'POST')).status,405);assert.equal(calls.length,0);
 const result=await call(handle);assert.equal(result.status,200);assert.equal(calls[0].url,HUB_RESOURCES.global.url);assert.equal(calls[0].options.credentials,'omit');assert.deepEqual(calls[0].options.headers,{Accept:'application/json'});assert.equal(result.body.schema,'public-market-relay-v1');
});
test('relay reuses a fresh response without rewriting source or fetch time and deduplicates concurrent reads',async()=>{
 let at=NOW,calls=0,finish;const handle=createMarketHubRelay({now:()=>at,fetchImpl:()=>{calls++;return new Promise(resolve=>{finish=()=>resolve(response(body));});}});
 const first=call(handle),second=call(handle);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);finish();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a.body,b.body);assert.equal(a.body.receivedAt,NOW);
 at+=30000;const cached=await call(handle);assert.equal(calls,1);assert.equal(cached.body.receivedAt,NOW);assert.equal(cached.body.body.data.updated_at,NOW/1000);
});
test('ticker relay exposes only the existing fixed twenty-asset request and cache, never caller-selected symbols or URLs',async()=>{
 let at=NOW;const calls=[],rows=HUB_SYMBOLS.map(symbol=>({symbol:symbol+'USDT',lastPrice:'101',openPrice:'100',quoteVolume:'200',closeTime:NOW-1000}));
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{calls.push({url,options});return response(rows);}}),path='/api/market-hub?resource=tickers';
 const first=await call(handle,path);assert.equal(first.status,200);assert.deepEqual(first.body,{schema:'public-market-relay-v1',resource:'tickers',receivedAt:NOW,body:rows});
 assert.equal(calls.length,1);assert.equal(calls[0].url,HUB_RESOURCES.tickers.url);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(calls[0].options.headers,{Accept:'application/json'});
 at+=HUB_RESOURCES.tickers.interval-1;assert.deepEqual((await call(handle,path)).body,first.body);assert.equal(calls.length,1);
 for(const suffix of ['&symbol=BTC','&symbols=BTCUSDT','&resource=global','&url=https://evil.test','&interval=1'])assert.equal((await call(handle,path+suffix)).status,400);
 assert.equal((await call(handle,path,'POST')).status,405);assert.equal(calls.length,1);
 at+=1;assert.equal((await call(handle,path)).status,200);assert.equal(calls.length,2);
});
test('ticker relay reuses the strict ticker normalizer and existing rate-limit backoff without a fake zero sample',async()=>{
 const ticker={symbol:'BTCUSDT',lastPrice:'101',openPrice:'100',quoteVolume:'200',closeTime:NOW};
 for(const rows of [[],[{...ticker,symbol:'UNKNOWNUSDT'}],[{...ticker,lastPrice:'NaN'}],[{...ticker,closeTime:NOW+30001}],Array(21).fill(ticker)]){
  const handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>response(rows)});assert.deepEqual((await call(handle,'/api/market-hub?resource=tickers')).body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});
 }
 let at=NOW,count=0;const handle=createMarketHubRelay({now:()=>at,fetchImpl:async()=>{count++;return count===1?response({},429,'120'):response([ticker]);}}),path='/api/market-hub?resource=tickers';
 const limited=await call(handle,path);assert.equal(limited.status,429);assert.equal(limited.headers['Retry-After'],'120');at+=119999;assert.equal((await call(handle,path)).status,429);assert.equal(count,1);
 at+=1;assert.equal((await call(handle,path)).status,200);assert.equal(count,2);
});
test('relay respects Retry-After and never promotes a failed or invalid response to success',async()=>{
 let at=NOW,calls=0,limited=true;const handle=createMarketHubRelay({now:()=>at,fetchImpl:async()=>{calls++;return limited?response({},429,'120'):response(body);}});
 const first=await call(handle);assert.equal(first.status,429);assert.equal(first.headers['Retry-After'],'120');at+=30000;assert.equal((await call(handle)).status,429);assert.equal(calls,1);
 at+=90000;limited=false;assert.equal((await call(handle)).status,200);assert.equal(calls,2);
 const invalid=createMarketHubRelay({now:()=>NOW,fetchImpl:async()=>response({})});assert.equal((await call(invalid)).status,502);
});
test('a synchronous transport failure can recover after its bounded retry interval',async()=>{
 let at=NOW,fail=true,calls=0;const handle=createMarketHubRelay({now:()=>at,fetchImpl:()=>{calls++;if(fail)throw new TypeError('offline');return Promise.resolve(response(body));}});
 assert.equal((await call(handle)).status,502);at+=15000;fail=false;assert.equal((await call(handle)).status,200);assert.equal(calls,2);
});


test('watchlist search uses fixed provider paths and rejects arbitrary IDs, duplicate fields and excess inputs',async()=>{
 const calls=[],handle=createMarketHubRelay({fetchImpl:async(url)=>{calls.push(url);return response({coins:[{id:'aave',symbol:'AAVE',name:'Aave'}]});}});
 const ok=await call(handle,'/api/market-hub?resource=search&query=AAVE');assert.equal(ok.status,200);assert.equal(ok.body.resource,'search');assert.equal(calls[0],'https://api.coingecko.com/api/v3/search?query=AAVE');
 for(const url of ['/api/market-hub?resource=search&query=', '/api/market-hub?resource=search&query=A&query=B','/api/market-hub?resource=watch-assets&ids=../../secret','/api/market-hub?resource=watch-assets&ids=https://evil.test','/api/market-hub?resource=watch-assets&ids='+Array(101).fill('bitcoin').join(',')])assert.equal((await call(handle,url)).status,400);
 assert.equal(calls.length,1);
});

test('public candles preserve venue OHLCV and isolate the cache by symbol and interval',async()=>{
 let at=NOW;const calls=[],bar=[NOW,'100','105','98','102','12.5',NOW+59999,'0',1,'0','0','0'];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return response([bar]);}});
 const url='/api/market-hub?resource=candles&symbol=BTCUSDT&interval=1m';
 const result=await call(handle,url);assert.equal(result.status,200);assert.deepEqual(result.body.body,[bar]);
 assert.equal(calls[0],'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=300');
 await call(handle,url);assert.equal(calls.length,1);
 await call(handle,url.replace('BTCUSDT','ETHUSDT'));assert.equal(calls.length,2);
 at+=5000;await call(handle,url);assert.equal(calls.length,3);
 for(const query of ['symbol=BTCUSDT&interval=1M','symbol=BTCUSDT&interval=1m&symbol=ETHUSDT','symbol=https://evil.test&interval=1m','symbol=ETHUSDC&interval=1m','symbol=BTCUSDT&interval=1m&key=secret'])assert.equal((await call(handle,'/api/market-hub?resource=candles&'+query)).status,400);
 const invalid=createMarketHubRelay({fetchImpl:async()=>response([[NOW,'100','99','98','102','12',NOW+59999]])});
 assert.equal((await call(invalid,url)).status,502);
});

test('existing background resources use only their fixed public providers and keep original receipt times on a shared cache hit',async()=>{
 const day=Math.floor(NOW/86400000)*86400000,values={sentiment:{data:[{timestamp:String(day/1000),value:'37'}]},chains:[{name:'Ethereum',tvl:1000},{name:'Solana',tvl:500}],stablecoins:[{date:day/1000,totalCirculatingUSD:{peggedUSD:120}}]};
 for(const resource of ['sentiment','chains','stablecoins']){
  let at=NOW,calls=0;const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{calls++;assert.equal(url,HUB_RESOURCES[resource].url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return response(values[resource]);}}),path='/api/market-hub?resource='+resource;
  const first=await call(handle,path);assert.equal(first.status,200);assert.equal(first.body.resource,resource);assert.equal(first.body.receivedAt,NOW);at+=1000;assert.deepEqual((await call(handle,path)).body,first.body);assert.equal(calls,1);
  for(const query of ['&url=https://evil.test','&resource=chains','&key=secret','&symbol=BTC'])assert.equal((await call(handle,path+query)).status,400);
  assert.equal((await call(handle,path,'POST')).status,405);assert.equal(calls,1);
 }
});

import {DERIVATIVE_SYMBOLS,DERIVATIVE_VIEWS,CHAIN_INSIGHT_MAX_AGE} from './public-market-extended.mjs';
import {CROSS_MARKETS} from './cross-market-data.mjs';
// Fixed public resources come from closed lists; search, watch-assets, candles and a trader address are chosen by the caller.
const fixedPaths=[
 ...Object.keys(HUB_RESOURCES).map(resource=>'resource='+resource),'resource=news','resource=social','resource=social-sample',
 ...['BTC','ETH','SOL'].map(symbol=>'resource=spot-depth&symbol='+symbol),...Object.keys(CROSS_MARKETS).map(symbol=>'resource=cross-candles&symbol='+symbol),
 ...DERIVATIVE_VIEWS.flatMap(view=>DERIVATIVE_SYMBOLS.map(symbol=>`resource=derivatives&view=${view}&symbol=${symbol}`)),
 ...[...Object.keys(CHAIN_INSIGHT_MAX_AGE),'lightning','channels'].map(metric=>'resource=chain-insight&metric='+metric),
 'resource=btc-disclosed-balance','resource=eth-active-balance','resource=eth-validator-exits','resource=eth-disclosed-balance',
 'resource=macro',...['cpi','unemployment','payrolls'].map(series=>'resource=macro-series&series='+series),'resource=eth-etf-holdings','resource=etf&asset=btc','resource=etf&asset=eth','resource=traders'
].map(query=>'/api/market-hub?'+query);
const callerPath=i=>'/api/market-hub?'+[`resource=search&query=q${i}`,`resource=watch-assets&ids=coin-${i}`,`resource=candles&symbol=C${i}USDT&interval=1m`,`resource=traders&address=0x${String(i).padStart(40,'0')}`][i%4];
const candlePath=i=>`/api/market-hub?resource=candles&symbol=C${i}USDT&interval=1m`,relayBar=[NOW,'100','105','98','102','12.5',NOW+59999,'0',1,'0','0','0'];
test('all fixed public resources, more than one hundred of them, keep their slots and back-off through more than one hundred caller-chosen keys, while caller keys stay bounded at one hundred',async()=>{
 const calls=[],handle=createMarketHubRelay({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return response({},503);}});
 for(const path of fixedPaths)assert.equal((await call(handle,path)).status,502,path);
 const fixedCalls=calls.length;for(const path of fixedPaths)await call(handle,path);assert.equal(calls.length,fixedCalls);
 for(let i=0;i<150;i++)assert.equal((await call(handle,callerPath(i))).status,502);
 const before=calls.length;
 for(const path of fixedPaths){const held=await call(handle,path);assert.equal(held.status,502,path);assert.equal(held.headers['Retry-After'],'15',path);assert.equal(calls.length,before,path);}
 await call(handle,callerPath(149));assert.equal(calls.length,before);
 await call(handle,callerPath(0));assert.equal(calls.length,before+1);await call(handle,callerPath(3));assert.ok(calls.length>before+1,String(calls.length-before));assert.ok(calls.slice(before+1).every(url=>url==='https://api.hyperliquid.xyz/info'));
});
test('a fixed resource keeps its provider Retry-After and its fresh snapshot through more than one hundred caller-chosen keys',async()=>{
 let at=NOW,limited=true;const gecko=[],handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{if(url!==HUB_RESOURCES.global.url)return response([relayBar]);gecko.push(at);return limited?response({},429,'120'):response(body);}});
 assert.equal((await call(handle)).status,429);
 for(let i=0;i<150;i++)await call(handle,candlePath(i));
 at+=60000;const held=await call(handle);assert.equal(held.status,429);assert.equal(held.headers['Retry-After'],'60');assert.equal(gecko.length,1);
 at+=60000;limited=false;const fresh=await call(handle);assert.equal(fresh.status,200);assert.equal(gecko.length,2);
 for(let i=150;i<300;i++)await call(handle,candlePath(i));
 at+=30000;const cached=await call(handle);assert.equal(cached.status,200);assert.equal(cached.body.receivedAt,fresh.body.receivedAt);assert.equal(gecko.length,2);
});
test('one hundred caller-chosen reads in flight, a trader address among them, answer BUSY to a new caller key but never to a fixed resource',async()=>{
 const waiting=[];let gecko=0;
 const handle=createMarketHubRelay({now:()=>NOW,setTimer:()=>1,clearTimer:()=>{},fetchImpl:url=>{if(url===HUB_RESOURCES.global.url){gecko++;return Promise.resolve(response(body));}return new Promise(resolve=>waiting.push(()=>resolve(response({coins:[]}))));}});
 const reads=[...Array.from({length:99},(_,i)=>call(handle,'/api/market-hub?resource=search&query=q'+i)),call(handle,'/api/market-hub?resource=traders&address=0x'+'a'.repeat(40))];
 await new Promise(resolve=>setImmediate(resolve));const inFlight=waiting.length;assert.ok(inFlight>=100,String(inFlight));
 const busy=await Promise.race([call(handle,'/api/market-hub?resource=search&query=late'),new Promise(resolve=>setImmediate(resolve,{status:'pending'}))]);assert.equal(busy.status,429);assert.deepEqual(busy.body,{error:'BUSY'});assert.equal(busy.headers['Retry-After'],'5');assert.equal(waiting.length,inFlight);
 const fixed=await call(handle);assert.equal(fixed.status,200);assert.equal(gecko,1);
 waiting.forEach(finish=>finish());const results=await Promise.all(reads);assert.ok(results.slice(0,99).every(result=>result.status===200));
});
test('gold spot, exchange reserves, exchange netflow and disclosed BTC flows are fixed resources: with one hundred caller-chosen reads in flight they still read their sources and never answer BUSY',async()=>{
 const waiting=[],urls=[];
 const handle=createMarketHubRelay({now:()=>NOW,setTimer:()=>1,clearTimer:()=>{},fetchImpl:url=>{urls.push(url);return new Promise(resolve=>waiting.push(()=>resolve(response({},503))));}});
 const reads=Array.from({length:100},(_,i)=>call(handle,'/api/market-hub?resource=search&query=q'+i));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting.length,100);
 const busy=await Promise.race([call(handle,'/api/market-hub?resource=search&query=late'),new Promise(resolve=>setImmediate(resolve,{status:'pending'}))]);assert.equal(busy.status,429);assert.deepEqual(busy.body,{error:'BUSY'});
 const fixed=[];
 for(const resource of ['gold-spot','exchange-reserves','exchange-netflow','btc-disclosed-flows']){
  const before=urls.length,read=call(handle,'/api/market-hub?resource='+resource);fixed.push(read);
  const state=await Promise.race([read,new Promise(resolve=>setImmediate(resolve,{status:'pending'}))]);
  assert.equal(state.status,'pending',resource);assert.ok(urls.length>before,resource);
 }
 waiting.forEach(finish=>finish());await Promise.all(reads);
 while(waiting.length>100){const next=waiting.splice(100);next.forEach(finish=>finish());await new Promise(resolve=>setImmediate(resolve));}
 for(const result of await Promise.all(fixed))assert.equal(result.status,502);
});
test('the disclosed BTC flows slot of an earlier day is dropped once the next day is read, so a fixed key that moves each day keeps one slot',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);throw Error('offline');}});
 const flows='/api/market-hub?resource=btc-disclosed-flows',other='/api/market-hub?resource=exchange-netflow';
 assert.equal((await call(handle,other)).status,502);
 assert.equal((await call(handle,flows)).status,502);const first=calls.length;assert.ok(first>=1);
 at+=1000;assert.equal((await call(handle,flows)).status,502);assert.equal(calls.length,first);
 at=NOW+86400000;await call(handle,flows);const second=calls.length;assert.ok(second>first);
 at=NOW+2000;await call(handle,flows);assert.ok(calls.length>second);
 const third=calls.length;assert.equal((await call(handle,other)).status,502);assert.equal(calls.length,third);
});
test('a required source Retry-After holds every relay key of that provider until it ends, also after its slot is evicted, and no other provider',async()=>{
 let at=NOW;const calls=[],ticker={symbol:'BTCUSDT',lastPrice:'101',openPrice:'100',quoteVolume:'200',closeTime:NOW};
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return url===HUB_RESOURCES.global.url?response({},429,'120'):url===HUB_RESOURCES.tickers.url?response([ticker]):url.includes('/klines?')?response([relayBar]):response({coins:[]});}});
 const gecko=()=>calls.filter(url=>url.startsWith('https://api.coingecko.com/'));
 const limited=await call(handle);assert.equal(limited.status,429);assert.equal(limited.headers['Retry-After'],'120');
 for(const path of ['resource=assets','resource=search&query=aave','resource=watch-assets&ids=bitcoin']){
  const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.deepEqual(held.body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});assert.equal(held.headers['Retry-After'],'120',path);
 }
 assert.equal(gecko().length,1);assert.equal((await call(handle,'/api/market-hub?resource=tickers')).status,200);assert.equal(calls.length,2);
 for(let i=0;i<150;i++)await call(handle,candlePath(i));
 at+=60000;
 for(const path of ['resource=categories','resource=search&query=aave']){const later=await call(handle,'/api/market-hub?'+path);assert.equal(later.status,429,path);assert.equal(later.headers['Retry-After'],'60',path);}
 at+=55000;const late=await call(handle,'/api/market-hub?resource=search&query=late');assert.equal(late.status,429);assert.equal(late.headers['Retry-After'],'5');assert.equal(gecko().length,1);
 at+=5000;for(const query of ['aave','late'])assert.equal((await call(handle,'/api/market-hub?resource=search&query='+query)).status,200);
 assert.deepEqual(gecko().slice(1),['https://api.coingecko.com/api/v3/search?query=aave','https://api.coingecko.com/api/v3/search?query=late']);
});
test('an OKX Retry-After on a required read holds every derivatives key, while one on an optional read holds none',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);
  if(url.includes('/public/open-interest?'))return response({},429,'60');
  if(url.includes('/open-interest-history?'))return response({code:'0',data:[[String(NOW-1000),'10','1','3210.34']]});
  if(url.includes('/funding-rate-history?'))return response({},429,'120');
  return response({code:'0',data:[]});
 }});
 const oi=await call(handle,'/api/market-hub?resource=derivatives&view=oi&symbol=BTC');assert.equal(oi.status,200);assert.equal(oi.body.body.current,null);assert.equal(calls.length,2);
 assert.equal((await call(handle,'/api/market-hub?resource=derivatives&view=ratio&symbol=ETH')).status,200);assert.equal(calls.length,3);
 const funding=await call(handle,'/api/market-hub?resource=derivatives&view=funding&symbol=BTC');assert.equal(funding.status,429);assert.equal(funding.headers['Retry-After'],'120');assert.equal(calls.length,4);
 for(const query of ['view=oi&symbol=SOL','view=liquidation&symbol=BTC','view=ratio&symbol=XRP']){
  const held=await call(handle,'/api/market-hub?resource=derivatives&'+query);assert.equal(held.status,429,query);assert.equal(held.headers['Retry-After'],'120',query);
 }
 assert.equal(calls.length,4);
 at+=120000;assert.equal((await call(handle,'/api/market-hub?resource=derivatives&view=ratio&symbol=XRP')).status,200);assert.equal(calls.length,5);
});
test('a held Ethereum explorer is skipped for the safe-block fallback, and a fresh shared transfer snapshot still answers first',async()=>{
 let at=NOW,saved={schema:'public-market-relay-v1',resource:'chain-insight',receivedAt:NOW,body:{metric:'eth-transfers',rows:[]}};
 const calls=[],head=1000,hex=n=>'0x'+n.toString(16),hash=n=>'0x'+n.toString(16).padStart(64,'0');
 const cache={async get(key){assert.equal(key,'eth-transfers-v2');return saved;},async set(_key,value){saved=value;}};
 const handle=createMarketHubRelay({cache,now:()=>at,fetchImpl:async(url,init)=>{
  calls.push(url);
  if(url.startsWith('https://eth.blockscout.com/api/v2/stats'))return response({},429,'120');
  if(url.startsWith('https://eth.blockscout.com/'))return response({items:[]});
  return response(JSON.parse(init.body).map(({id,params})=>{
   const height=params[0]==='safe'?head:Number(params[0]);
   return {jsonrpc:'2.0',id,result:{number:hex(height),hash:hash(height),parentHash:hash(height-1),timestamp:hex(Math.floor(at/1000)-12*(head-height)),transactions:[]}};
  }));
 }});
 const path='/api/market-hub?resource=chain-insight&metric=eth-transfers';
 const gas=await call(handle,'/api/market-hub?resource=chain-insight&metric=eth-gas');assert.equal(gas.status,429);assert.equal(gas.headers['Retry-After'],'120');assert.equal(calls.length,1);
 at+=1000;const shared=await call(handle,path);assert.equal(shared.status,200);assert.deepEqual(shared.body,saved);assert.equal(calls.length,1);
 at+=60000;const fallback=await call(handle,path);
 assert.equal(fallback.status,200);assert.equal(fallback.body.body.source,'PublicNode');assert.equal(fallback.body.body.sample.throughAt,at);
 assert.deepEqual(calls.slice(1),Array(4).fill('https://ethereum-rpc.publicnode.com'));assert.equal(saved.receivedAt,at);
 at+=60000;assert.equal((await call(handle,path)).status,200);assert.ok(calls[5].startsWith('https://eth.blockscout.com/api/v2/advanced-filters?'));
});
test('a shorter Retry-After from a read already in flight never shortens the hold of its provider',async()=>{
 let at=NOW;const waiting=new Map(),calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:url=>{calls.push(url);return calls.length<=2?new Promise(resolve=>waiting.set(url,resolve)):Promise.resolve(response([]));}});
 const first=call(handle),second=call(handle,'/api/market-hub?resource=assets');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
 waiting.get(HUB_RESOURCES.global.url)(response({},429,'120'));assert.equal((await first).headers['Retry-After'],'120');
 waiting.get(HUB_RESOURCES.assets.url)(response({},429,'30'));assert.equal((await second).headers['Retry-After'],'30');
 at+=60000;
 for(const path of ['resource=categories','resource=assets']){const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.equal(held.headers['Retry-After'],'60',path);}
 assert.equal(calls.length,2);
});
test('a provider answer other than 429 with a Retry-After holds that provider with 502 until it ends',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return url===HUB_RESOURCES.global.url?response({},503,'60'):response({coins:[]});}});
 const failed=await call(handle);assert.equal(failed.status,502);assert.equal(failed.headers['Retry-After'],'60');
 for(const path of ['resource=assets','resource=search&query=aave']){
  const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,502,path);assert.deepEqual(held.body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});assert.equal(held.headers['Retry-After'],'60',path);
 }
 assert.equal(calls.length,1);
 at+=60000;assert.equal((await call(handle,'/api/market-hub?resource=search&query=aave')).status,200);assert.equal(calls.length,2);
});

import {isEthDisclosedRpcSpec} from './public-eth-disclosed.mjs';
test('disclosed ETH balance reads keep their POST body under a provider hold, and their Retry-After holds the transfer fallback on the same RPC',async()=>{
 let at=NOW;const calls=[],hash='0x'+'d'.repeat(64),rpc='https://ethereum-rpc.publicnode.com';
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method,body:init.body});
  if(url.startsWith('https://eth.blockscout.com/'))return response({},503);
  assert.equal(url,rpc);assert.equal(init.credentials,'omit');
  if(at<NOW+120000)return response({},429,'120');
  const batch=JSON.parse(init.body);
  return response(Array.isArray(batch)?batch.map(({id})=>({jsonrpc:'2.0',id,result:'0x'+(id*1000).toString(16)})):{jsonrpc:'2.0',id:1,result:{hash,number:'0x10',timestamp:'0x'+((at-12000)/1000).toString(16)}});
 }});
 const path='/api/market-hub?resource=eth-disclosed-balance';
 const limited=await call(handle,path);assert.equal(limited.status,429);assert.equal(limited.headers['Retry-After'],'120');
 at+=1000;const transfers=await call(handle,'/api/market-hub?resource=chain-insight&metric=eth-transfers');
 assert.equal(transfers.status,429);assert.equal(transfers.headers['Retry-After'],'119');
 assert.deepEqual(calls.map(({url})=>new URL(url).host),['ethereum-rpc.publicnode.com','eth.blockscout.com']);
 at+=119000;const fresh=await call(handle,path);assert.equal(fresh.status,200);assert.equal(fresh.body.body.totalWei,'10000');assert.equal(fresh.body.body.sourceAsOf,at-12000);
 const posts=calls.filter(({url})=>url===rpc);assert.equal(posts.length,3);assert.ok(posts.every(spec=>spec.method==='POST'&&isEthDisclosedRpcSpec(spec)));
});
const page=text=>({ok:true,status:200,headers:{get:()=>null},text:async()=>text});
test('a BLS API Retry-After holds every macro series, while the release archives that macro reads after its calendar set no hold and are read again at the next refresh',async()=>{
 let at=Date.parse('2026-11-10T15:00:00Z');const calls=[];
 const fomc='<a id="1">2026 FOMC Meetings</a><div class="fomc-meeting__month col-xs-5"><strong>October</strong></div>\n<div class="fomc-meeting__date col-xs-4">27-28</div>';
 const cpiDates='<div id="release-dates-pager"><span>Tuesday November 10, 2026</span></td></tr><tr><td>7:30 am</td><td><a href="/release?rid=10">Consumer Price Index</a></td></tr>Releases 1 - 1 of 1</div>All times are US Central Time';
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{
  calls.push(url);const {host}=new URL(url);
  if(host==='api.bls.gov'||host==='www.bls.gov')return response({},429,'7200');
  if(url.includes('fomccalendars'))return page(fomc);
  if(url.includes('rid=10'))return page(cpiDates);
  return response({},503);
 }});
 const host=name=>calls.filter(url=>new URL(url).host===name).length;
 const cpi=await call(handle,'/api/market-hub?resource=macro-series&series=cpi');assert.equal(cpi.status,429);assert.equal(cpi.headers['Retry-After'],'7200');
 const jobs=await call(handle,'/api/market-hub?resource=macro-series&series=unemployment');assert.equal(jobs.status,429);assert.equal(jobs.headers['Retry-After'],'7200');assert.equal(host('api.bls.gov'),1);
 const macro=await call(handle,'/api/market-hub?resource=macro');assert.equal(macro.status,200);
 assert.deepEqual(macro.body.body.events.map(event=>[event.id,event.actual]),[['fed:2026-10-28',null],['fred:10:2026-11-10',null]]);
 assert.equal(host('www.bls.gov'),1);assert.equal(host('alfred.stlouisfed.org'),2);assert.equal(host('www.federalreserve.gov'),2);
 at+=3600000;const refreshed=await call(handle,'/api/market-hub?resource=macro');assert.equal(refreshed.status,200);assert.equal(refreshed.body.receivedAt,at);
 assert.equal(host('www.bls.gov'),2);
 const later=await call(handle,'/api/market-hub?resource=macro-series&series=payrolls');assert.equal(later.status,429);assert.equal(later.headers['Retry-After'],'3600');assert.equal(host('api.bls.gov'),1);
});
test('a mempool.space Retry-After on the disclosed BTC balance holds the mempool chain metrics, and the Lightning read calls no mempool.space URL until it ends',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return url.includes('/api/address/')?response({},429,'120'):response({},503);}});
 const disclosed=await call(handle,'/api/market-hub?resource=btc-disclosed-balance');assert.equal(disclosed.status,429);assert.equal(disclosed.headers['Retry-After'],'120');
 const first=calls.length;assert.ok(first>=1);
 const hashrate=await call(handle,'/api/market-hub?resource=chain-insight&metric=hashrate');assert.equal(hashrate.status,429);assert.equal(hashrate.headers['Retry-After'],'120');assert.equal(calls.length,first);
 // The Lightning read asks its primary observer first; its mempool.space fallback stays held.
 const lightning=await call(handle,'/api/market-hub?resource=chain-insight&metric=lightning');assert.equal(lightning.status,502);
 const stats=['/api/v1/lightning/statistics/1m','/api/v1/lightning/statistics/latest'],hostPath=url=>{const u=new URL(url);return u.host+u.pathname;};
 assert.deepEqual(calls.slice(first).map(hostPath).sort(),stats.map(path=>'mempool.emzy.de'+path));
 const second=calls.length;
 at+=120000;await call(handle,'/api/market-hub?resource=chain-insight&metric=channels');
 assert.deepEqual(calls.slice(second).map(hostPath).sort(),[...stats.map(path=>'mempool.emzy.de'+path),...stats.map(path=>'mempool.space'+path)]);
});
const holdTicker={symbol:'BTCUSDT',lastPrice:'101',openPrice:'100',quoteVolume:'200',closeTime:NOW},holdDepth='https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=100';
const holdAnswer=url=>url===HUB_RESOURCES.global.url?response(body):url===HUB_RESOURCES.tickers.url?response([holdTicker]):url===holdDepth?response(depth):url.includes('/klines?')?response([relayBar]):response({coins:[]});
test('a Retry-After on a caller-chosen key holds only the caller-chosen keys of that provider, while the fixed resources of that provider keep reading',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return at===NOW&&(url.includes('/search?query=aave')||url.includes('/klines?symbol=BTCUSDT&'))?response({},429,'86400'):holdAnswer(url);}});
 for(const path of ['resource=search&query=aave','resource=candles&symbol=BTCUSDT&interval=1m']){const limited=await call(handle,'/api/market-hub?'+path);assert.equal(limited.status,429,path);assert.equal(limited.headers['Retry-After'],'86400',path);}
 for(const path of ['resource=search&query=late','resource=watch-assets&ids=bitcoin','resource=candles&symbol=ETHUSDT&interval=1m']){const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.deepEqual(held.body,{error:'PUBLIC_SOURCE_UNAVAILABLE'});assert.equal(held.headers['Retry-After'],'86400',path);}
 assert.equal(calls.length,2);
 for(const path of ['resource=global','resource=tickers','resource=spot-depth&symbol=BTC'])assert.equal((await call(handle,'/api/market-hub?'+path)).status,200,path);
 assert.deepEqual(calls.slice(2),[HUB_RESOURCES.global.url,HUB_RESOURCES.tickers.url,holdDepth]);
 at+=3600000;
 for(const path of ['resource=global','resource=tickers','resource=spot-depth&symbol=BTC'])assert.equal((await call(handle,'/api/market-hub?'+path)).status,200,path);
 assert.equal(calls.length,8);
 for(const path of ['resource=search&query=late','resource=candles&symbol=ETHUSDT&interval=1m']){const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.equal(held.headers['Retry-After'],'82800',path);}
 assert.equal(calls.length,8);
 at+=82800000;for(const path of ['resource=search&query=late','resource=candles&symbol=ETHUSDT&interval=1m'])assert.equal((await call(handle,'/api/market-hub?'+path)).status,200,path);
 assert.deepEqual(calls.slice(8),['https://api.coingecko.com/api/v3/search?query=late','https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1m&limit=300']);
});
test('a Retry-After on a fixed resource still holds every key of that provider, and a caller-chosen key under both holds answers with the longer one',async()=>{
 let at=NOW;const calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async url=>{calls.push(url);return at!==NOW?holdAnswer(url):url.includes('/search?query=aave')||url===HUB_RESOURCES.tickers.url?response({},429,'60'):response({},429,'600');}});
 for(const [path,wait] of [['resource=search&query=aave','60'],['resource=global','600'],['resource=candles&symbol=BTCUSDT&interval=1m','600'],['resource=tickers','60']]){const limited=await call(handle,'/api/market-hub?'+path);assert.equal(limited.status,429,path);assert.equal(limited.headers['Retry-After'],wait,path);}
 assert.equal(calls.length,4);
 at+=30000;
 for(const [path,wait] of [['resource=assets','570'],['resource=categories','570'],['resource=search&query=late','570'],['resource=watch-assets&ids=bitcoin','570'],['resource=candles&symbol=ETHUSDT&interval=1m','570'],['resource=spot-depth&symbol=BTC','30']]){const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.equal(held.headers['Retry-After'],wait,path);}
 assert.equal(calls.length,4);
 at+=30000;
 for(const path of ['resource=tickers','resource=spot-depth&symbol=BTC'])assert.equal((await call(handle,'/api/market-hub?'+path)).status,200,path);
 assert.deepEqual(calls.slice(4),[HUB_RESOURCES.tickers.url,holdDepth]);
 for(const path of ['resource=search&query=late','resource=candles&symbol=ETHUSDT&interval=1m']){const held=await call(handle,'/api/market-hub?'+path);assert.equal(held.status,429,path);assert.equal(held.headers['Retry-After'],'540',path);}
 assert.equal(calls.length,6);
 at+=540000;for(const path of ['resource=global','resource=search&query=late','resource=candles&symbol=ETHUSDT&interval=1m'])assert.equal((await call(handle,'/api/market-hub?'+path)).status,200,path);
 assert.equal(calls.length,9);
});
