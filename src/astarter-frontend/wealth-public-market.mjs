import {createPublicClient,custom,toFunctionSelector} from 'viem';
import {mainnet} from 'viem/chains';
import {createWealthMarket,WEALTH_RPC,AAVE_POOL,RESEARCH_ASSETS} from './wealth-market.mjs';
import {WEALTH_MARKET_SCHEMA,WEALTH_MARKET_CAPABILITIES,wealthMarketAsset,wealthMarketFailure,validateWealthPublicMarket} from './wealth-market-data.mjs';

const MAX_BYTES=262144;
const RPC_URL=new URL(WEALTH_RPC).href;
const selector={reserve:toFunctionSelector('getReserveData(address)'),balance:toFunctionSelector('balanceOf(address)'),decimals:toFunctionSelector('decimals()')};
const fault=code=>Object.assign(Error(code),{code});
const quantity=value=>typeof value==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)&&value.length<=66;
const plain=value=>value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
const validHash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value)&&!/^0x0{64}$/i.test(value);

// One request-bound scope covers fetch AND streaming body reads. Abort alone is
// insufficient when an upstream ignores it; every awaited operation races here.
function deadline(timeoutMs){
 const controller=new AbortController();let reject,reader=null,closed=false;
 const stopped=new Promise((_,fail)=>reject=fail);stopped.catch(()=>{});
 const cancel=()=>{controller.abort();try{void reader?.cancel().catch(()=>{});}catch{}};
 const timer=setTimeout(()=>{closed=true;cancel();reject(fault('MARKET_TIMEOUT'));},timeoutMs);
 return {signal:controller.signal,reader(value){reader=value;},check(){if(closed)throw fault('MARKET_TIMEOUT');},wait(value){return Promise.race([value,stopped]);},close(){clearTimeout(timer);closed=true;cancel();}};
}
async function json(response,scope){
 if(response?.status===429)throw fault('MARKET_RATE_LIMITED');
 let sourceMatches=false;try{sourceMatches=Boolean(response)&&(!response.url||new URL(response.url).href===RPC_URL);}catch{}
 if(!response||response.redirected||!sourceMatches||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||''))throw fault('MARKET_INVALID');
 if(!response.ok)throw fault('MARKET_UNAVAILABLE');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES)||!response.body?.getReader)throw fault('MARKET_INVALID');
 const reader=response.body.getReader();scope.reader(reader);const decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0;
 try{for(;;){const chunk=await scope.wait(reader.read());scope.check();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw fault('MARKET_INVALID');bytes+=chunk.value.byteLength;if(bytes>MAX_BYTES)throw fault('MARKET_INVALID');parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());try{return JSON.parse(parts.join(''));}catch{throw fault('MARKET_INVALID');}}
 finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
function restrictedClient(assetId,fetchImpl,scope){
 const asset=RESEARCH_ASSETS[assetId];let id=0,block=null,timestamp=null;
 const client=createPublicClient({chain:mainnet,cacheTime:0,batch:{multicall:false},transport:custom({async request({method,params=[]}){
  scope.check();let call,kind;
  if(method==='eth_chainId'){if(params.length)throw fault('MARKET_INVALID');}
  else if(method==='eth_getBlockByNumber'){if(JSON.stringify(params)!=='["latest",false]')throw fault('MARKET_INVALID');}
  else if(method==='eth_call'){
   if(params.length!==2||!plain(params[0])||Object.keys(params[0]).some(key=>!['to','data'].includes(key))||!quantity(params[1])||params[1]!==block)throw fault('MARKET_INVALID');
   call=params[0];const to=call.to?.toLowerCase(),data=call.data?.toLowerCase();
   if(to===AAVE_POOL.toLowerCase()&&data===selector.reserve+'0'.repeat(24)+asset.address.slice(2).toLowerCase())kind='reserve';
   else if(to===asset.address.toLowerCase()&&data===selector.decimals)kind='decimals';
   else if(to===asset.address.toLowerCase()&&typeof data==='string'&&new RegExp('^'+selector.balance+'0{24}[0-9a-f]{40}$').test(data))kind='balance';
   else throw fault('MARKET_INVALID');
  }else throw fault('MARKET_INVALID');
  const requestId=++id,response=await scope.wait(fetchImpl(WEALTH_RPC,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),signal:scope.signal}));
  scope.check();const value=await json(response,scope);scope.check();
  if(!plain(value)||Object.keys(value).length!==3||value.jsonrpc!=='2.0'||value.id!==requestId||!Object.hasOwn(value,'result'))throw fault('MARKET_INVALID');
  const result=value.result;
  if(method==='eth_chainId'){if(result!=='0x1')throw fault('WRONG_CHAIN');}
  else if(method==='eth_getBlockByNumber'){
   if(!plain(result)||!validHash(result.hash)||!quantity(result.number)||BigInt(result.number)<=0n||!quantity(result.timestamp)||BigInt(result.timestamp)>253402300799n||!Array.isArray(result.transactions)||result.transactions.length>4096||result.transactions.some(tx=>!validHash(tx)))throw fault('MARKET_INVALID');
   block=result.number;timestamp=BigInt(result.timestamp);
  }else{
   if(typeof result!=='string'||!/^0x[0-9a-f]+$/i.test(result)||result.length!==(kind==='reserve'?962:66))throw fault('MARKET_INVALID');
   if(kind==='decimals'&&BigInt(result)!==BigInt(asset.decimals))throw fault('MARKET_INVALID');
   if(kind==='reserve'&&BigInt('0x'+result.slice(2+6*64,2+7*64))>timestamp)throw fault('MARKET_INVALID');
  }
  return result;
 }},{retryCount:0})});
 return client;
}

// No env, identity, persistence, signer, chain process or model is created here.
// The frozen candidate supplies the Aave calculation; this adapter only bounds
// its public transport and validates the projected reference DTO.
export function createWealthPublicMarket({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fault('MARKET_CONFIGURATION');
 const cache=new Map(),pending=new Map();
 return {async read(assetId){
  if(!wealthMarketAsset(assetId))throw fault('SELECTION');
  const old=cache.get(assetId);if(old&&now()-old.observation.receivedAt<30000){try{return validateWealthPublicMarket(old,assetId,now());}catch{cache.delete(assetId);}}
  if(pending.has(assetId))return pending.get(assetId);
  const scope=deadline(timeoutMs);let sourceError=null;
  const sourceClient=restrictedClient(assetId,fetchImpl,scope),client={getChainId:(...args)=>sourceClient.getChainId(...args).catch(error=>{sourceError=error;throw error;}),getBlock:(...args)=>sourceClient.getBlock(...args).catch(error=>{sourceError=error;throw error;}),readContract:(...args)=>sourceClient.readContract(...args).catch(error=>{sourceError=error;throw error;})};
  const task=(async()=>{try{
   const observation=await scope.wait(createWealthMarket({client,now}).read(assetId));scope.check();
   if(observation.status!=='observed')throw sourceError||fault(observation.reason);
   const result=validateWealthPublicMarket({schema:WEALTH_MARKET_SCHEMA,mode:'cloud-readonly',...WEALTH_MARKET_CAPABILITIES,assetId,status:'observed',error:null,observation},assetId,now());cache.set(assetId,result);return result;
  }catch(error){let reason=error?.code||error?.message;for(let current=error,depth=0;current&&depth<6;current=current.cause,depth++)if(['MARKET_TIMEOUT','MARKET_RATE_LIMITED','MARKET_INVALID','WRONG_CHAIN'].includes(current.code))reason=current.code;return wealthMarketFailure(assetId,reason);}
  finally{scope.close();if(pending.get(assetId)===task)pending.delete(assetId);}})();
  pending.set(assetId,task);return task;
 }};
}
export function createWealthPublicMarketHandler({service,fetchImpl,now,timeoutMs}={}){
 const market=service||createWealthPublicMarket({fetchImpl,now,timeoutMs});
 return async(req,res)=>{
  const send=(status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(JSON.stringify(value));};
  if(req.method!=='GET')return send(405,{error:'METHOD_NOT_ALLOWED',...WEALTH_MARKET_CAPABILITIES},{Allow:'GET'});
  let asset;
  try{if(typeof req.url!=='string'||req.url.length>1024||!req.url.startsWith('/')||req.url.startsWith('//'))throw Error();const url=new URL(req.url,'https://astarter.imstark.site');asset=url.searchParams.get('asset');if(url.pathname!=='/api/wealth/market'||url.hash||[...url.searchParams].length!==1||!wealthMarketAsset(asset)||req.headers?.['transfer-encoding']!==undefined||req.headers?.['content-length']!==undefined&&req.headers['content-length']!=='0')throw Error();}
  catch{return send(400,{error:'INVALID_REQUEST',...WEALTH_MARKET_CAPABILITIES});}
  try{const result=validateWealthPublicMarket(await market.read(asset),asset,(now||Date.now)());return send(result.status==='observed'?200:result.error==='MARKET_RATE_LIMITED'?429:503,result,result.error==='MARKET_RATE_LIMITED'?{'Retry-After':'30'}:{});}
  catch{return send(503,wealthMarketFailure(asset));}
 };
}
