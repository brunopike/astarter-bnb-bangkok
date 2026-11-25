import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeAbiParameters,parseAbiParameters,toFunctionSelector} from 'viem';
import {createWealthPublicMarket,createWealthPublicMarketHandler} from './wealth-public-market.mjs';
import {validateWealthPublicMarket,WEALTH_MARKET_ASSETS} from './wealth-market-data.mjs';
import {AAVE_POOL,WEALTH_RPC,RESEARCH_ASSETS} from './wealth-market.mjs';

const NOW=Date.UTC(2026,10,17,12),HASH='0x'+'a'.repeat(64),ATOKEN='0x'+'1'.repeat(40);
const quantity=value=>'0x'+BigInt(value).toString(16),uint=value=>encodeAbiParameters([{type:'uint256'}],[BigInt(value)]);
const reserve=({rate=4n*10n**25n,updated=BigInt(NOW/1000),token=ATOKEN}={})=>encodeAbiParameters(parseAbiParameters('(uint256),uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128'),[[1n<<56n],1n,rate,1n,0n,0n,updated,0,token,ATOKEN,ATOKEN,ATOKEN,0n,0n,0n]);
const selectors={reserve:toFunctionSelector('getReserveData(address)'),balance:toFunctionSelector('balanceOf(address)'),decimals:toFunctionSelector('decimals()')};
function rpcFixture(options={}){
 const calls=[];let at=NOW;
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,init,body});assert.equal(url,WEALTH_RPC);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(new Headers(init.headers).has('authorization'),false);
  if(options.fetch)return options.fetch(url,init,body,calls.length);
  let result;
  if(body.method==='eth_chainId')result=options.chain||'0x1';
  else if(body.method==='eth_getBlockByNumber')result={number:'0x1234',hash:HASH,timestamp:quantity(options.blockTime??NOW/1000),transactions:[],...options.block};
  else if(body.method==='eth_call'){
   const [call,block]=body.params;assert.equal(block,'0x1234');
   if(call.data.startsWith(selectors.reserve)){assert.equal(call.to.toLowerCase(),AAVE_POOL.toLowerCase());result=reserve(options.reserve);}
   else if(call.data===selectors.decimals)result=uint(options.decimals??6);
   else if(call.data.startsWith(selectors.balance))result=uint(options.liquidity??123456789000n);
   else assert.fail('Only the three fixed read selectors are allowed');
  }else assert.fail('Unexpected RPC method '+body.method);
  const response=new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'Content-Type':'application/json'}});
  // Native fetch normalizes an HTTPS root to a trailing slash. Empty mock URLs
  // previously hid a production source-rejection regression.
  Object.defineProperty(response,'url',{value:options.responseURL??new URL(WEALTH_RPC).href});
  if(options.redirected)Object.defineProperty(response,'redirected',{value:true});
  return response;
 };
 const service=createWealthPublicMarket({fetchImpl,now:()=>at,timeoutMs:options.timeoutMs??150});
 return {service,calls,advance:ms=>at+=ms};
}
async function invoke(handler,{url='/api/wealth/market?asset=usdc',method='GET',headers={}}={}){
 let status,body,responseHeaders;await handler({url,method,headers},{writeHead(code,h){status=code;responseHeaders=h;},end(value){body=JSON.parse(value);}});return {status,body,headers:responseHeaders};
}

test('construction is inert; fixed Aave observation exposes only a read-only reference and exact asset units',async()=>{
 const f=rpcFixture();assert.equal(f.calls.length,0);const value=await f.service.read('usdc');assert.equal(value.status,'observed');assert.equal(value.readOnly,true);
 for(const key of ['realFundingEnabled','testFundingEnabled','modelEnabled','trackingEnabled'])assert.equal(value[key],false);
 assert.equal(value.observation.aprPercent,'4');assert.equal(value.observation.availableLiquidityUnits,'123456789000');assert.equal(value.observation.blockHash,HASH);assert.equal(value.assetId,'usdc');assert.deepEqual(validateWealthPublicMarket(value,'usdc',NOW),value);
 assert.equal(f.calls.every(call=>['eth_chainId','eth_getBlockByNumber','eth_call'].includes(call.body.method)),true);
 assert.equal(JSON.stringify(value).includes('walletBalance'),false);assert.equal(JSON.stringify(value).includes('nav'),false);
 for(const [id,asset] of Object.entries(WEALTH_MARKET_ASSETS))assert.equal(asset.decimals,RESEARCH_ASSETS[id].decimals);
});

test('all four fixed assets keep their original decimals and pinned block reads',async()=>{
 for(const [assetId,{decimals}] of Object.entries(RESEARCH_ASSETS)){
  const f=rpcFixture({decimals});const result=await f.service.read(assetId);assert.equal(result.status,'observed',assetId);assert.equal(result.assetId,assetId);assert.equal(result.observation.assetId,assetId);
  assert.equal(f.calls.filter(call=>call.body.method==='eth_call').length,3);
 }
});

test('canonical native Fetch root URL is accepted while other hosts, paths and redirects remain rejected',async()=>{
 const valid=rpcFixture({responseURL:'https://ethereum-rpc.publicnode.com/'});assert.equal((await valid.service.read('usdc')).status,'observed');
 for(const options of [{responseURL:'https://other.example/'},{responseURL:'https://ethereum-rpc.publicnode.com.evil.example/'},{responseURL:'https://ethereum-rpc.publicnode.com/other'},{responseURL:'https://ethereum-rpc.publicnode.com/?asset=usdc'},{responseURL:'https://ethereum-rpc.publicnode.com/',redirected:true}]){
  const f=rpcFixture(options),value=await f.service.read('usdc');assert.equal(value.status,'unavailable');assert.equal(value.error,'MARKET_INVALID');assert.equal(value.observation,null);assert.equal(f.calls.length,1);
 }
});

test('30-second cache reuses the original source and received timestamps and never refreshes an expired sample',async()=>{
 const f=rpcFixture();const first=await f.service.read('usdc'),count=f.calls.length;f.advance(1000);const cached=await f.service.read('usdc');assert.deepEqual(cached,first);assert.equal(f.calls.length,count);
 f.advance(181000);const expired=await f.service.read('usdc');assert.equal(expired.status,'unavailable');assert.equal(expired.observation,null);assert.equal(expired.error,'MARKET_STALE');assert.equal(first.observation.receivedAt,NOW);
});

test('wrong chains, stale or future blocks, malformed hashes, decimals and reserve times never become observations',async()=>{
 for(const options of [{chain:'0x38'},{blockTime:NOW/1000-181},{blockTime:NOW/1000+31},{block:{hash:'0x123'}},{block:{number:'0x00'}},{decimals:18},{reserve:{updated:BigInt(NOW/1000+1)}},{reserve:{token:'0x'+'0'.repeat(40)}}]){
  const f=rpcFixture(options),result=await f.service.read('usdc');assert.equal(result.status,'unavailable',JSON.stringify(options,(_,value)=>typeof value==='bigint'?String(value):value));assert.equal(result.observation,null);
 }
});

test('RPC failures, redirects, oversized bodies and invalid envelopes fail closed without arbitrary RPC retries',async()=>{
 for(const fetch of [
  async()=>new Response('{}',{status:429,headers:{'Content-Type':'application/json'}}),
  async()=>new Response('{}',{status:302,headers:{'Content-Type':'application/json',Location:'https://other.example'}}),
  async()=>new Response('x'.repeat(262145),{headers:{'Content-Type':'application/json'}}),
  async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:'0x1'}),{headers:{'Content-Type':'application/json'}}),
  async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x1',error:{message:'private diagnostic'}}),{headers:{'Content-Type':'application/json'}}),
 ]){const f=rpcFixture({fetch}),result=await f.service.read('usdc');assert.equal(result.status,'unavailable');assert.equal(result.observation,null);assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(result),/private diagnostic|other\.example/);}
});

test('hard deadline terminates ignored fetch and body hangs, aborts transport, and releases pending for a fresh attempt',async()=>{
 for(const bodyHang of [false,true]){
  let blocked=true;const f=rpcFixture({timeoutMs:15,fetch:async(_url,_init,body)=>{
   if(blocked)return bodyHang?new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}}):new Promise(()=>{});
   return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'0x1'}),{headers:{'Content-Type':'application/json'}});
  }});
  const started=Date.now(),one=await f.service.read('usdc');assert.ok(Date.now()-started<400);assert.equal(one.error,'MARKET_TIMEOUT');assert.equal(f.calls[0].init.signal.aborted,true);
  blocked=false;await f.service.read('usdc');assert.ok(f.calls.length>1,'a timed-out pending entry cannot lock the asset');
 }
});

test('public GET handler admits exactly one whitelisted asset and never dispatches funding or model actions',async()=>{
 let reads=0;const f=rpcFixture(),handler=createWealthPublicMarketHandler({now:()=>NOW,service:{read:asset=>{reads++;return f.service.read(asset);}}});
 for(const url of ['/api/wealth/market','/api/wealth/market?asset=btc','/api/wealth/market?asset=usdc&asset=usdt','/api/wealth/market?asset=usdc&url=https://other.example','/api/wealth/market?asset=usdc&chain=56'])assert.equal((await invoke(handler,{url})).status,400,url);
 assert.equal((await invoke(handler,{method:'POST'})).status,405);assert.equal(reads,0);const result=await invoke(handler);assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(reads,1);
});

test('public handler preserves rate-limit and failure states without returning fabricated zero balances or APR',async()=>{
 const f=rpcFixture({fetch:async()=>new Response('{}',{status:429,headers:{'Content-Type':'application/json'}})}),result=await invoke(createWealthPublicMarketHandler({service:f.service,now:()=>NOW}));assert.equal(result.status,429);assert.equal(result.body.error,'MARKET_RATE_LIMITED');assert.equal(result.body.observation,null);assert.equal(result.body.realFundingEnabled,false);
});

test('cold API import performs no I/O and normalizes only its known Vercel function path',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('No outbound calls allowed in this offline test');};
 try{
  const {default:api}=await import('./api/wealth-market.mjs');assert.equal(calls,0);
  for(const url of ['/api/wealth-market?asset=unknown','/api/wealth-market?asset=usdc&asset=usdt','/api/wealth-market/other?asset=usdc']){
   const req={url,method:'GET',headers:{}},res={writeHead(code){this.status=code;},end(value){this.body=JSON.parse(value);}};await api(req,res);assert.equal(res.status,400);assert.equal(req.url,url);
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=previous;}
 const sources=await Promise.all(['./wealth-public-market.mjs','./api/wealth-market.mjs'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
 for(const source of sources)assert.doesNotMatch(source,/wealth-(?:manager|model|vault)|node:(?:sqlite|child_process|fs)|process\.env/);
});
