import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {exchangeQuery,normalizeExchangeData,exchangeAnalysis} from './assistant-exchange-data.mjs';
import {createExchangeHandler,okxReadRequest,readExchangeJson} from './assistant-exchange-relay.mjs';
import {createAssistantExchangeTools,exchangeResultHTML} from './assistant-exchange-tools.mjs';

test('exchange requests accept only fixed read operations, supported pairs and candle intervals',()=>{
 assert.deepEqual(exchangeQuery('okx','candles',new URLSearchParams('asset=ETH&period=4H')),{provider:'okx',operation:'candles',asset:'ETH',period:'4H',site:'global'});
 for(const [p,o,q] of [['other','market',''],['okx','withdraw',''],['binance','market','url=https://evil.invalid'],['okx','candles','asset=BTC;shutdown'],['okx','candles','period=2s'],['okx','market','asset=BTC&asset=ETH']])assert.throws(()=>exchangeQuery(p,o,new URLSearchParams(q)),/INVALID_QUERY/);
 for(const operation of ['market','orderbook','candles','funding','account','positions','fills','analysis']){
  const {url,options}=okxReadRequest(exchangeQuery('okx',operation,new URLSearchParams()));
  assert.equal(options.method,'GET');assert.equal(url.origin,'https://www.okx.com');assert.ok(options.signal);
  assert.ok(!/place|cancel|amend|transfer|withdraw|purchase|redeem/.test(url.pathname));
 }
});
test('both exchanges normalize actual timestamps, units and missing fields without changing venue identity',()=>{
 const b=normalizeExchangeData('binance','market',{symbol:'BTCUSDT',lastPrice:'100',openPrice:'80',highPrice:'110',lowPrice:'75',volume:'10',quoteVolume:'900',priceChangePercent:'25',closeTime:1000},'BTC',2000);
 const o=normalizeExchangeData('okx','market',[{instId:'BTC-USDT',last:'100',open24h:'80',high24h:'110',low24h:'75',vol24h:'10',volCcy24h:'900',ts:'1000'}],'BTC',2000);
 assert.equal(b.asOf,1000);assert.equal(o.asOf,1000);assert.equal(b.rows[0].changePct,25);assert.equal(o.rows[0].changePct,25);assert.equal(o.unit,'USDT');
 assert.throws(()=>normalizeExchangeData('okx','market',[{instId:'ETH-USDT',last:'1',ts:'1000'}],'BTC',2000),/INVALID_RESPONSE/);
 assert.throws(()=>normalizeExchangeData('binance','market',{symbol:'BTCUSDT',lastPrice:'broken',closeTime:1000},'BTC',2000),/INVALID_RESPONSE/);
});
test('only closed candles enter analysis, preserving chronological order and real OHLC',()=>{
 const rows=[[1000,'10','13','9','12','3',1999],[2000,'12','14','11','13','4',2999],[3000,'13','15','12','14','5',3999]];
 const b=normalizeExchangeData('binance','candles',rows,'BTC',3500);
 assert.equal(b.rows.length,2);assert.equal(b.rows[1].close,13);
 const o=normalizeExchangeData('okx','candles',[['3000','13','15','12','14','5','0','0','0'],['2000','12','14','11','13','4','0','0','1'],['1000','10','13','9','12','3','0','0','1']],'BTC',3500);
 assert.deepEqual(o.rows,b.rows);
 const analysis=exchangeAnalysis(Array.from({length:30},(_,i)=>({time:1000+i,open:10+i,high:13+i,low:9+i,close:12+i,volume:2})));
 assert.equal(analysis.atr14,4);assert.equal(analysis.ma20,31.5);assert.equal(analysis.last,41);assert.equal(analysis.count,30);
 assert.throws(()=>exchangeAnalysis(b.rows),/INSUFFICIENT_CANDLES/);
});
test('personal responses are allowlisted and distinguish an empty account from an invalid response',()=>{
 const result=normalizeExchangeData('binance','account',{apiKey:'do-not-return',balances:[{asset:'BTC',free:'1',locked:'.1'},{asset:'ETH',free:'0',locked:'0'}]},'BTC',1000);
 assert.deepEqual(result.rows,[{asset:'BTC',available:1,held:.1,total:1.1}]);
 assert.ok(!JSON.stringify(result).includes('do-not-return'));
 assert.deepEqual(normalizeExchangeData('okx','account',[{details:[]}],'BTC',1000).rows,[]);
 assert.throws(()=>normalizeExchangeData('okx','account',[{}],'BTC',1000),/INVALID_RESPONSE/);
});
test('upstream booleans cannot become prices and invalid book levels cannot be shown as market data',()=>{
 assert.throws(()=>normalizeExchangeData('binance','market',{symbol:'BTCUSDT',lastPrice:true,closeTime:1000},'BTC',2000),/INVALID_RESPONSE/);
 assert.throws(()=>normalizeExchangeData('binance','orderbook',{bids:[['-1','2']],asks:[['2','3']]},'BTC',2000),/INVALID_RESPONSE/);
});

async function harness(fn){
 let clock=1000,calls=[],permissions={enableReading:true,enableWithdrawals:false},readError=false;
 const upstream=async(url,options={})=>{
  calls.push({url:String(url),method:options.method||'GET',headers:options.headers});
  const p=new URL(url).pathname;
  if(p.endsWith('/apiRestrictions'))return Response.json(permissions);
  if(p.endsWith('/account'))return readError?Response.json({code:-2015,msg:'untrusted secret=never-expose'},{status:400}):Response.json({balances:[{asset:'BTC',free:'1',locked:'0'}]});
  if(p.endsWith('/time'))return Response.json({serverTime:clock});
  if(p.endsWith('/ticker/24hr'))return Response.json({symbol:'BTCUSDT',lastPrice:'100',openPrice:'80',highPrice:'110',lowPrice:'75',volume:'10',quoteVolume:'900',priceChangePercent:'25',closeTime:clock});
  return Response.json({code:-2015,msg:'untrusted upstream secret=never-expose'},{status:401});
 };
 const handler=createExchangeHandler({fetchImpl:upstream,now:()=>clock,okxReadImpl:async(query,keys)=>{
  calls.push({okx:query,hasKeys:!!keys});
  if(query.operation==='config')return [{perm:'read_only',uid:'private-id'}];
  if(query.operation==='account')return [{details:[{ccy:'BTC',availBal:'2',frozenBal:'0',eq:'2'}]}];
  return [{instId:'BTC-USDT',last:'100',open24h:'80',high24h:'110',low24h:'75',vol24h:'10',volCcy24h:'900',ts:String(clock)}];
 }});
 const server=http.createServer((req,res)=>handler(req,res,{port:server.address().port}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(path,options={})=>fetch(base+'/api/assistant/exchanges/'+path,{...options,headers:{Origin:base,'X-Astarter-Exchange':'1',...options.headers}});
 try{await fn({request,calls,setClock:v=>clock=v,setPermissions:v=>permissions=v,setReadError:v=>readError=v,base});}finally{await new Promise(r=>server.close(r));}
}
const keys={apiKey:'public-test-key-1234',secretKey:'public-test-secret-1234',passphrase:'public-test-passphrase',site:'global'};
test('connection verifies upstream first, isolates sessions, expires and disconnects without leaking credentials',()=>harness(async({request,calls,setClock})=>{
 const response=await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)});
 assert.equal(response.status,200,JSON.stringify({body:await response.clone().json(),paths:calls.map(c=>c.url?new URL(c.url).pathname:c.okx)}));const body=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
 assert.equal(body.connected,true);assert.ok(body.connectionId);assert.ok(!JSON.stringify(body).includes(keys.secretKey));
 assert.equal((await request('binance/account')).status,401);
 const account=await request('binance/account',{headers:{Cookie:cookie}});assert.equal(account.status,200);assert.equal((await account.json()).connectionId,body.connectionId);
 const cross=await request('okx/account',{headers:{Cookie:cookie}});assert.equal(cross.status,401);
 assert.ok(calls.every(c=>!c.url||c.method==='GET'));
 assert.ok(calls.find(c=>c.url?.includes('signature=')));
 setClock(1801001);assert.equal((await request('binance/account',{headers:{Cookie:cookie}})).status,401);
 const again=await request('okx/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)});const okxCookie=again.headers.get('set-cookie').split(';')[0];
 assert.equal(again.status,200);
 assert.equal((await request('okx/connection',{method:'DELETE',headers:{Cookie:okxCookie}})).status,200);
 assert.equal((await request('okx/account',{headers:{Cookie:okxCookie}})).status,401);
}));
test('connecting another exchange does not extend the first exchange credential lifetime',()=>harness(async({request,setClock})=>{
 const first=await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)}),cookie=first.headers.get('set-cookie').split(';')[0];
 setClock(10000);const next=await request('okx/connection',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(keys)});assert.equal(next.status,200);
 setClock(1801001);assert.equal((await request('binance/account',{headers:{Cookie:cookie}})).status,401);assert.equal((await request('okx/account',{headers:{Cookie:cookie}})).status,200);
}));
test('bridge rejects cross-origin, unexpected fields and write operations before contacting an exchange',()=>harness(async({request,calls})=>{
 assert.equal((await request('binance/market',{headers:{Origin:'https://evil.invalid'}})).status,403);
 assert.equal((await request('binance/market?url=https://evil.invalid')).status,400);
 assert.equal((await request('binance/place-order',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,405);
 assert.equal((await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...keys,url:'https://evil.invalid'})})).status,400);
 assert.equal(calls.length,0);
}));
test('read-only connection rejects all trading and transfer scopes; browser GET needs no forged Origin header',()=>harness(async({request,setPermissions,base})=>{
 const market=await fetch(base+'/api/assistant/exchanges/binance/market',{headers:{'X-Astarter-Exchange':'1'}});assert.equal(market.status,200);
 const missingOrigin=await fetch(base+'/api/assistant/exchanges/binance/connection',{method:'POST',headers:{'X-Astarter-Exchange':'1','Content-Type':'application/json'},body:JSON.stringify(keys)});assert.equal(missingOrigin.status,403);
 for(const flag of ['enableWithdrawals','enableSpotAndMarginTrading','enableFutures','enableInternalTransfer','permitsUniversalTransfer']){
  setPermissions({enableReading:true,[flag]:true});const response=await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)});
  assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'READ_ONLY_KEY_REQUIRED'});assert.equal(response.headers.get('set-cookie'),null);
 }
 setPermissions({enableReading:true,enableFixReadOnly:true,enableWithdrawals:false});assert.equal((await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)})).status,200);
}));
test('official authentication errors revoke only the matching connection and never echo upstream messages',()=>harness(async({request,setReadError})=>{
 const first=await request('binance/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(keys)}),cookie=first.headers.get('set-cookie').split(';')[0];setReadError(true);
 const query=await request('binance/account',{headers:{Cookie:cookie}});assert.equal(query.status,401);assert.deepEqual(await query.json(),{error:'AUTH_OR_PERMISSION'});
 const status=await request('binance/status',{headers:{Cookie:cookie}});assert.equal((await status.json()).connected,false);
}));
test('OKX HTTP signing uses fixed read endpoints and never puts credentials in URLs or messages',async()=>{
 const {url,options}=okxReadRequest({operation:'account',site:'global'},keys,1000);
 assert.equal(url.href,'https://www.okx.com/api/v5/account/balance');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
 assert.equal(options.headers['OK-ACCESS-KEY'],keys.apiKey);assert.equal(options.headers['OK-ACCESS-TIMESTAMP'],'1970-01-01T00:00:01.000Z');assert.ok(!url.href.includes(keys.secretKey));
 assert.equal(options.headers['OK-ACCESS-SIGN'],createHmac('sha256',keys.secretKey).update('1970-01-01T00:00:01.000ZGET/api/v5/account/balance').digest('base64'));
 await assert.rejects(readExchangeJson(Response.json({code:'50113',msg:keys.secretKey,data:[]}),'okx'),error=>error.message==='AUTH_OR_PERMISSION'&&!error.message.includes(keys.secretKey));
 await assert.rejects(readExchangeJson(Response.json({code:'0',data:[]}),'okx'),/INVALID_RESPONSE/);
 const source=await readFile(new URL('./assistant-exchange-relay.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/node:(?:child_process|fs|util)|execFile|runOkx|OKX_LOG_RETENTION|process\.env/);
});
test('a disconnected account cannot deliver an in-flight personal result',async()=>{
 let release,blocked=false;
 const handler=createExchangeHandler({okxReadImpl:async query=>{if(query.operation==='config')return[{perm:'read_only'}];if(blocked)await new Promise(r=>release=r);return[{details:[]}];}});
 const server=http.createServer((req,res)=>handler(req,res,{port:server.address().port}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:base,'X-Astarter-Exchange':'1','Content-Type':'application/json'};
 try{
  const response=await fetch(base+'/api/assistant/exchanges/okx/connection',{method:'POST',headers,body:JSON.stringify(keys)}),cookie=response.headers.get('set-cookie').split(';')[0];
  blocked=true;const pending=fetch(base+'/api/assistant/exchanges/okx/account',{headers:{...headers,Cookie:cookie}});
  while(!release)await new Promise(r=>setImmediate(r));
  await fetch(base+'/api/assistant/exchanges/okx/connection',{method:'DELETE',headers:{...headers,Cookie:cookie}});release();
  const stale=await pending;assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'CONNECTION_CHANGED'});
 }finally{release?.();await new Promise(r=>server.close(r));}
});

function toolFixture(){
 const nodes=new Map(),ops=['market','orderbook','candles','funding','analysis','account','positions','fills'].map(id=>({dataset:{exchangeOperation:id},setAttribute(){}}));
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:selector==='[data-exchange-asset]'?'BTC':'1H',innerHTML:'',textContent:'',events:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},focus(){this.focusCount=(this.focusCount||0)+1;},reset(){this.resetCount=(this.resetCount||0)+1;},replaceChildren(){this.innerHTML='';},addEventListener(type,fn){this.events[type]=fn;},querySelector:s=>node(s)});return nodes.get(selector);};
 const dialog={open:true,innerHTML:'',querySelector:node,querySelectorAll:s=>s==='[data-exchange-operation]'?ops:s.includes('asset')?[node('[data-exchange-asset]'),node('[data-exchange-period]')]:[],close(){this.open=false;}};
 return {dialog,node};
}
test('late query results cannot replace a new asset selection or a disconnected private result',async()=>{
 const {dialog,node}=toolFixture();let queries=[],connected=false;
 const tools=createAssistantExchangeTools({onBack(){},onSource(){throw Error('Unexpected attachment');},fetchImpl:async path=>{
  if(path.endsWith('/status'))return Response.json({provider:'binance',connected,connectionId:connected?'old':null});
  if(path.endsWith('/connection')){connected=false;return Response.json({provider:'binance',connected:false});}
  return new Promise(resolve=>queries.push({path,resolve}));
 }});
 const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
 tools.open(dialog,'binance','market');await flush();assert.equal(queries.length,1);assert.equal(node('[data-exchange-close]').focusCount,1);
 node('[data-exchange-asset]').value='ETH';node('[data-exchange-asset]').onchange();await flush();assert.equal(queries.length,2);
 const result=asset=>({provider:'binance',operation:'market',asset,period:'1H',market:asset+'USDT',asOf:1000,unit:'USDT',private:false,rows:[{last:100,changePct:1,high:110,low:90,volume:2,quoteVolume:200}]});
 queries[1].resolve(Response.json(result('ETH')));await flush();queries[0].resolve(Response.json(result('BTC')));await flush();assert.match(node('[data-exchange-output]').innerHTML,/ETHUSDT/);assert.doesNotMatch(node('[data-exchange-output]').innerHTML,/BTCUSDT/);
 connected=true;tools.open(dialog,'binance','account');await flush();const pending=queries.at(-1);assert.match(pending.path,/account/);
 await node('[data-exchange-disconnect]').onclick();pending.resolve(Response.json({...result('ETH'),operation:'account',asset:'BTC',private:true,connectionId:'old',rows:[{asset:'BTC',available:1,held:0,total:1}]}));await flush();assert.equal(node('[data-exchange-output]').innerHTML,'');tools.dispose();assert.ok(node('[data-exchange-connect]').resetCount);
});
test('result text escapes upstream content and private size carries its contract unit',()=>{
 assert.doesNotMatch(exchangeResultHTML({operation:'account',rows:[{asset:'<script>',available:1,held:0,total:1}]}),/<script>/);
 assert.match(exchangeResultHTML({operation:'positions',rows:[{market:'BTC-USDT-SWAP',side:'long',size:2,sizeUnit:'contracts',entry:100,mark:101,pnl:2,unit:'USDT'}]}),/2 (?:张|contracts)/);
});
test('small nonzero balances and fees never round to a displayed zero',()=>{
 const account=exchangeResultHTML({operation:'account',rows:[{asset:'ETH',available:1e-12,held:0,total:1e-12}]});assert.match(account,/1e-12/);
 const fills=exchangeResultHTML({operation:'fills',rows:[{time:1000,market:'ETHUSDT',side:'buy',price:3000,quantity:1,fee:-1e-12,feeAsset:'ETH'}]});assert.match(fills,/-1e-12 ETH/);
});
test('market volume display stays readable without changing prices or the source snapshot',()=>{
 const result={operation:'market',asset:'BTC',unit:'USDT',rows:[{last:75942.2412345678,changePct:1,high:76000,low:75000,volume:5025.998112345,quoteVolume:381195614.9357987}]},before=JSON.stringify(result),html=exchangeResultHTML(result);
 assert.match(html,/>75,942\.2412345678 USDT<\/dd>/);assert.match(html,/title="381195614\.9357987 USDT">381,195,614\.94 USDT<\/dd>/);assert.match(html,/title="5025\.998112345 BTC">5,025\.998112 BTC<\/dd>/);assert.equal(JSON.stringify(result),before);
 const tiny=exchangeResultHTML({...result,rows:[{...result.rows[0],volume:1e-9,quoteVolume:1e-5}]});assert.match(tiny,/>1e-9 BTC<\/dd>/);assert.match(tiny,/>1e-5 USDT<\/dd>/);
});
test('position direction uses trading labels for hedge sides and signed net positions',()=>{
 const row={market:'BTCUSDT',entry:100,mark:101,pnl:2,unit:'USDT',sizeUnit:'BTC'};
 const hedge=exchangeResultHTML({operation:'positions',rows:[{...row,side:'LONG',size:1}]});assert.match(hedge,/多头|Long/);assert.doesNotMatch(hedge,/>LONG</);
 const net=exchangeResultHTML({operation:'positions',rows:[{...row,side:'BOTH',size:-1}]});assert.match(net,/空头|Short/);assert.doesNotMatch(net,/>BOTH</);
});
test('an absent relay is a recoverable unavailable tool and never a connected account',async()=>{
 const {dialog,node}=toolFixture();const tools=createAssistantExchangeTools({onBack(){},onSource(){},fetchImpl:async()=>new Response('Not found',{status:404})});
 tools.open(dialog,'okx','account');for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
 assert.match(node('[data-exchange-status]').textContent,/暂不可用|unavailable/);assert.doesNotMatch(node('[data-exchange-status]').textContent,/账户已连接|Account connected/);
 assert.match(node('[data-exchange-output]').innerHTML,/data-exchange-retry/);tools.dispose();
});
test('credentials expire proactively per exchange, even without another request',async()=>{
 const timers=[];let calls=0;
 const handler=createExchangeHandler({schedule:(fn,delay)=>{assert.equal(delay,1800000);timers.push(fn);return {unref(){}};},okxReadImpl:async query=>{calls++;return query.operation==='config'?[{perm:'read_only'}]:[{details:[]}];}});
 const server=http.createServer((req,res)=>handler(req,res,{port:server.address().port}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:base,'X-Astarter-Exchange':'1','Content-Type':'application/json'};
 try{const response=await fetch(base+'/api/assistant/exchanges/okx/connection',{method:'POST',headers,body:JSON.stringify(keys)}),cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(timers.length,1);const before=calls;timers[0]();const query=await fetch(base+'/api/assistant/exchanges/okx/account',{headers:{...headers,Cookie:cookie}});assert.equal(query.status,401);assert.equal(calls,before);}
 finally{await new Promise(r=>server.close(r));}
});
test('an open tool clears personal output when its connection expires',async()=>{
 const {dialog,node}=toolFixture();let requested;
 const tools=createAssistantExchangeTools({onBack(){},onSource(){},fetchImpl:async path=>{
  if(path.endsWith('/status'))return Response.json({provider:'binance',connected:true,connectionId:'short-lived',expiresAt:Date.now()+50});
  requested=true;return Response.json({provider:'binance',operation:'account',asset:'BTC',period:'1H',market:'BTCUSDT',asOf:1000,private:true,connectionId:'short-lived',unit:'USDT',rows:[{asset:'BTC',available:1,held:0,total:1}]});
 }});
 tools.open(dialog,'binance','account');await new Promise(r=>setTimeout(r,100));assert.ok(requested);assert.match(node('[data-exchange-output]').innerHTML,/连接已过期|connection expired/);assert.doesNotMatch(node('[data-exchange-output]').innerHTML,/<table>/);tools.dispose();
});
test('attached public data keeps its exchange snapshot rather than linking to another venue current quote',async()=>{
 const {dialog,node}=toolFixture();let attached=null;
 const value={provider:'okx',operation:'market',asset:'BTC',period:'1H',market:'BTC-USDT',asOf:1000,unit:'USDT',private:false,rows:[{last:100,changePct:1,high:110,low:90,volume:2,quoteVolume:200}]};
 const tools=createAssistantExchangeTools({onBack(){},onSource:source=>{attached=source;return false;},fetchImpl:async path=>Response.json(path.endsWith('/status')?{provider:'okx',connected:false}:value)});
 tools.open(dialog,'okx','market');for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));node('[data-exchange-source]').events.click();assert.equal(attached.href,'');
 const snapshot=JSON.parse(attached.text.slice(attached.text.indexOf('\n')+1));assert.equal(snapshot.provider,'okx');assert.equal(snapshot.market,'BTC-USDT');assert.equal(snapshot.asOf,1000);assert.equal(snapshot.rows[0].last,100);tools.dispose();
});
test('account-wide balances do not appear under an unrelated selected pair heading',async()=>{
 const {dialog,node}=toolFixture();const tools=createAssistantExchangeTools({onBack(){},onSource(){},fetchImpl:async path=>Response.json(path.endsWith('/status')?{provider:'binance',connected:true,connectionId:'account-one'}:{provider:'binance',operation:'account',asset:'BTC',period:'1H',market:'BTCUSDT',asOf:1000,private:true,connectionId:'account-one',rows:[{asset:'ETH',available:1,held:0,total:1}]})});
 tools.open(dialog,'binance','account');for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));const heading=node('[data-exchange-output]').innerHTML.match(/<h3>(.*?)<\/h3>/)?.[1]||'';assert.match(heading,/账户资产|Balances/);assert.doesNotMatch(heading,/BTCUSDT/);tools.dispose();
});
test('connection verification obeys the same per-client concurrency limit as reads',async()=>{
 const releases=[];const handler=createExchangeHandler({okxReadImpl:async query=>query.operation==='config'?new Promise(r=>releases.push(()=>r([{perm:'read_only'}]))):[{details:[]}]});
 const server=http.createServer((req,res)=>handler(req,res,{port:server.address().port}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,connect=()=>fetch(base+'/api/assistant/exchanges/okx/connection',{method:'POST',headers:{Origin:base,'X-Astarter-Exchange':'1','Content-Type':'application/json'},body:JSON.stringify(keys)});
 let pending=[];
 try{pending=[connect(),connect()];for(let i=0;i<100&&releases.length<2;i++)await new Promise(r=>setImmediate(r));assert.equal(releases.length,2);const third=await connect();assert.equal(third.status,429);releases.forEach(r=>r());assert.deepEqual((await Promise.all(pending)).map(r=>r.status),[200,200]);}
 finally{releases.forEach(r=>r());await Promise.allSettled(pending);await new Promise(r=>server.close(r));}
});
test('an old account authentication failure cannot disconnect a newly connected account',async()=>{
 let release,block=false;const newer={...keys,apiKey:'second-public-test-key'};
 const handler=createExchangeHandler({okxReadImpl:async(query,credential)=>{if(query.operation==='config')return[{perm:'read_only'}];if(block&&credential.apiKey===keys.apiKey){await new Promise(r=>release=r);throw Object.assign(Error('AUTH_OR_PERMISSION'),{status:401});}return[{details:[]}];}});
 const server=http.createServer((req,res)=>handler(req,res,{port:server.address().port}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:base,'X-Astarter-Exchange':'1','Content-Type':'application/json'};let pending;
 try{const old=await fetch(base+'/api/assistant/exchanges/okx/connection',{method:'POST',headers,body:JSON.stringify(keys)}),cookie=old.headers.get('set-cookie').split(';')[0];block=true;pending=fetch(base+'/api/assistant/exchanges/okx/account',{headers:{...headers,Cookie:cookie}});for(let i=0;i<100&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);
  const next=await fetch(base+'/api/assistant/exchanges/okx/connection',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify(newer)}),connected=await next.json();assert.equal(next.status,200);release();assert.equal((await pending).status,401);
  const status=await fetch(base+'/api/assistant/exchanges/okx/status',{headers:{...headers,Cookie:cookie}});assert.equal((await status.json()).connectionId,connected.connectionId);
 }finally{release?.();if(pending)await Promise.allSettled([pending]);await new Promise(r=>server.close(r));}
});

test('both venues resume the selected private capability after read-only verification and retain keyboard focus',async()=>{
 const saved=globalThis.FormData;
 globalThis.FormData=class{*[Symbol.iterator](){yield* Object.entries(keys);}};
 const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
 try{for(const provider of ['binance','okx']){
  const {dialog,node}=toolFixture();let connected=false,reject=true,connections=0,reads=0,attachments=0;
  const tools=createAssistantExchangeTools({onSource(){attachments++;},fetchImpl:async(path,options)=>{
   if(path.endsWith('/status'))return Response.json({provider,connected,connectionId:connected?'verified':null,expiresAt:Date.now()+60000});
   if(path.endsWith('/connection')){connections++;assert.equal(options.method,'POST');if(reject)return Response.json({error:'READ_ONLY_KEY_REQUIRED'},{status:400});connected=true;return Response.json({provider,connected:true,connectionId:'verified',expiresAt:Date.now()+60000});}
   reads++;assert.match(path,/\/fills\?asset=ETH&period=4H/);return Response.json({provider,operation:'fills',asset:'ETH',period:'4H',market:'ETH-USDT',private:true,connectionId:'verified',asOf:1000,rows:[]});
  }});
  tools.open(dialog,provider,'fills',{asset:'ETH',period:'4H'});await flush();assert.match(dialog.innerHTML,new RegExp('data-exchange-title data-no-translate>'+ (provider==='okx'?'OKX':'Binance')+' · '));
  assert.equal(reads,0);assert.equal(node('[data-exchange-credentials]').open,true);assert.equal(node('[data-exchange-query-form]').hidden,true);assert.equal(node('[name=apiKey]').focusCount,1);assert.doesNotMatch(dialog.innerHTML,/data-exchange-operation=/);
  const form=node('[data-exchange-connect]');await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.equal(connected,false);assert.match(node('[data-exchange-connect-message]').textContent,/仅开启读取|read permission only/);assert.equal(node('[data-exchange-connect-message]').getAttribute('role'),'alert');assert.equal(node('[data-exchange-connect-message]').focusCount,1);assert.equal(reads,0);
  reject=false;const pending=form.onsubmit({preventDefault(){},currentTarget:form});await form.onsubmit({preventDefault(){},currentTarget:form});await pending;await flush();
  assert.equal(connections,2);assert.equal(reads,1);assert.equal(form.resetCount,2);assert.equal(node('[data-exchange-query-form]').hidden,false);assert.equal(node('[data-exchange-query]').focusCount,1);assert.equal(node('[data-exchange-query]').getAttribute('aria-disabled'),'false');assert.equal(node('[data-exchange-output]').getAttribute('aria-busy'),'false');assert.match(node('[data-exchange-output]').innerHTML,/本次已读取|Retrieved/);assert.doesNotMatch(node('[data-exchange-output]').innerHTML,/data-exchange-source/);assert.equal(attachments,0);tools.dispose();
 }}finally{globalThis.FormData=saved;}
});
