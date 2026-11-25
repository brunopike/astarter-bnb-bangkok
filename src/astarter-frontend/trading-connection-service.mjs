import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import {chmod,mkdir,open,readFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {executionAuthorization,liveOrderAllowed} from './execution-authorization.mjs';
import {spotBotStrategy} from './spot-live-bots.mjs';

const STATUSES=new Set(['unchecked','connected','disconnected','denied','expired']);
const MARKETS=new Set(['spot','perp']);
const TEXT=/^[\w][\w:.-]{0,79}$/;
const BODY_LIMIT=8192;

function keyBytes(value){
 if(Buffer.isBuffer(value)&&value.length===32)return value;
 if(typeof value==='string'&&value.length>=16&&value.length<=200)return createHash('sha256').update(value).digest();
 throw Object.assign(Error('CONNECTION_KEY_REQUIRED'),{code:'CONNECTION_KEY_REQUIRED'});
}
function encryptSecret(secret,key){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
 return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
function isSecretBox(value){
 return Boolean(value&&value.v===1&&typeof value.iv==='string'&&typeof value.tag==='string'&&typeof value.data==='string'&&value.iv.length<=80&&value.tag.length<=80&&value.data.length<=1024);
}
function decryptSecret(box,key){
 if(!isSecretBox(box))throw Object.assign(Error('INVALID_SECRET'),{code:'INVALID_SECRET'});
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));
 decipher.setAuthTag(Buffer.from(box.tag,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(box.data,'base64')),decipher.final()]).toString('utf8');
}
function decimalAmount(value){
 const text=typeof value==='number'?String(value):value;
 if(typeof text!=='string'||!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(text))return null;
 const amount=Number(text);
 return Number.isFinite(amount)&&amount>=0&&amount<=1e15?amount:null;
}
function publicTradingConnection(record){
 const reason=['restricted-location','timeout','check-failed'].includes(record.reason)?record.reason:'';
 const available=record.status==='connected'?decimalAmount(record.available):null;
 const locked=available===null?null:decimalAmount(record.locked)??0;
 return {connectionId:record.connectionId,venue:record.venue,kind:record.kind,market:record.market,chain:record.chain,permission:record.permission,status:record.status,checkedAt:record.checkedAt,accountId:record.accountId,label:record.label,balanceChecked:record.balanceChecked===true,...(available===null?{}:{available,locked}),...(reason?{reason}:{})};
}
function credentialText(value){return typeof value==='string'&&value.length>=8&&value.length<=256&&!/[\s\u0000-\u001f]/.test(value);}
function labelText(value){
 return typeof value==='string'&&value.trim().length<=40&&!/[\u0000-\u001f\u007f<>]/.test(value)&&!/^(?:sk[-_]|rk[-_]|AIza|gh[pousr]_|Bearer\s)|^(?:0x)?[a-f\d]{64}$/i.test(value.trim())?value.trim():'';
}
async function readJson(response){
 const text=await response.text();
 if(text.length>1000000)throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});
 try{return JSON.parse(text);}catch{throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});}
}
async function binanceSignedGet(path,params,creds,fetchImpl){
 const clockResponse=await fetchImpl('https://api.binance.com/api/v3/time',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(clockResponse.status===451)throw Object.assign(Error('RESTRICTED_LOCATION'),{code:'RESTRICTED_LOCATION'});
 const clock=await readJson(clockResponse);
 if(!Number.isFinite(clock.serverTime))throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});
 const query=new URLSearchParams({...params,timestamp:String(clock.serverTime),recvWindow:'5000'});
 query.set('signature',createHmac('sha256',creds.secret).update(query.toString()).digest('hex'));
 const response=await fetchImpl('https://api.binance.com'+path+'?'+query,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json','X-MBX-APIKEY':creds.key}});
 const data=await readJson(response);
 if(data&&Object.hasOwn(data,'code')&&data.code!==0)throw Object.assign(Error('AUTH_OR_PERMISSION'),{code:'AUTH_OR_PERMISSION'});
 if(!response.ok)throw Object.assign(Error('UPSTREAM_UNAVAILABLE'),{code:'UPSTREAM_UNAVAILABLE'});
 return data;
}
async function binanceSigned(method,pathname,params,creds,fetchImpl){
 const clockResponse=await fetchImpl('https://api.binance.com/api/v3/time',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
 if(clockResponse.status===451)throw Object.assign(Error('RESTRICTED_LOCATION'),{code:'RESTRICTED_LOCATION'});
 const clock=await readJson(clockResponse);
 if(!Number.isFinite(clock.serverTime))throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});
 const query=new URLSearchParams();
 for(const [key,value] of Object.entries(params))query.set(key,String(value));
 query.set('timestamp',String(clock.serverTime));
 query.set('recvWindow','5000');
 query.set('signature',createHmac('sha256',creds.secret).update(query.toString()).digest('hex'));
 const response=await fetchImpl('https://api.binance.com'+pathname+'?'+query,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','X-MBX-APIKEY':creds.key}});
 const data=await readJson(response);
 if(data&&typeof data.code==='number'&&data.code!==0)throw Object.assign(Error('EXCHANGE_REJECTED'),{code:'EXCHANGE_REJECTED',exchangeCode:data.code});
 if(!response.ok)throw Object.assign(Error('UPSTREAM_UNAVAILABLE'),{code:'UPSTREAM_UNAVAILABLE'});
 return data;
}
const GRID_SCALE=100000000n;
function gridScaled(value){
 const text=typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?value.toFixed(8).replace(/\.?0+$/,''):'';
 if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))return null;
 const [whole,frac='']=text.split('.');
 return BigInt(whole)*GRID_SCALE+BigInt((frac+'00000000').slice(0,8));
}
function gridText(value){
 const raw=value<0n?-value:value,whole=raw/GRID_SCALE,frac=(raw%GRID_SCALE).toString().padStart(8,'0').replace(/0+$/,'');
 return `${whole.toString()}${frac?`.${frac}`:''}`;
}
function gridMoney(value){
 if(typeof value==='number'&&Number.isFinite(value))return gridScaled(value)===null?null:gridText(gridScaled(value));
 return typeof value==='string'&&gridScaled(value)!==null?value.trim():null;
}
export function planS01LimitBuys({lower,upper,count,spacing,amount,cap,bid,tick,step,minNotional}){
 const lo=gridScaled(lower),hi=gridScaled(upper),spend=gridScaled(amount),budget=gridScaled(cap),bidN=gridScaled(bid),tickN=gridScaled(tick),stepN=gridScaled(step),minN=gridScaled(minNotional);
 if([lo,hi,spend,budget,bidN,tickN,stepN,minN].some(value=>value===null)||!Number.isInteger(count)||count<2||count>8||!['arithmetic','geometric'].includes(spacing))return {error:'invalid-grid'};
 const demoCap=25n*GRID_SCALE;
 if(lo<=0n||hi<=lo||bidN<=0n||tickN<=0n||stepN<=0n||minN<=0n||spend<minN||budget<spend||spend>demoCap||budget>demoCap)return {error:spend<minN?'below-minimum':spend>demoCap||budget>demoCap?'demo-limit':'invalid-grid'};
 const orders=[];
 let total=0n;
 for(let index=0;index<=count;index++){
  const ratio=index/count;
  const raw=index===0?lo:index===count?hi:spacing==='geometric'?gridScaled(Number(lo)/Number(GRID_SCALE)*(Number(hi)/Number(lo))**ratio):lo+(hi-lo)*BigInt(index)/BigInt(count);
  const price=raw/tickN*tickN;
  if(price<=0n||price+tickN>bidN)continue;
  const qty=((spend*GRID_SCALE+price-1n)/price+stepN-1n)/stepN*stepN;
  const notional=price*qty/GRID_SCALE;
  if(qty<=0n||notional<minN||notional>spend+price*stepN/GRID_SCALE||total+notional>budget)continue;
  const id=createHash('sha256').update(`s01|${gridText(lo)}|${gridText(hi)}|${count}|${spacing}|${gridText(spend)}|${gridText(price)}`).digest('hex').slice(0,16);
  orders.push({price:gridText(price),quantity:gridText(qty),notional:gridText(notional),clientOrderId:`as01${id}`});
  total+=notional;
 }
 return orders.length?{orders,total:gridText(total)}:{error:'no-buy-level'};
}
async function placeS01Grid(creds,body,fetchImpl){
 const keys=Object.keys(body);
 if(keys.some(key=>!['lower','upper','count','spacing','amount','cap'].includes(key)))return {error:'invalid-grid'};
 const spend=gridScaled(body.amount),budget=gridScaled(body.cap),demoCap=25n*GRID_SCALE;
 if(spend===null||budget===null)return {error:'invalid-grid'};
 if(spend>demoCap||budget>demoCap)return {error:'demo-limit'};
 const inspected=await inspectBinanceAccount({key:creds.key,secret:creds.secret,market:'spot',fetchImpl});
 if(inspected.status!=='connected'||inspected.permission!=='trade')return {error:'trade-disabled'};
 const info=await readJson(await fetchImpl('https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 const symbol=info.symbols?.find(row=>row.symbol==='BTCUSDT');
 const tick=symbol?.filters?.find(row=>row.filterType==='PRICE_FILTER')?.tickSize;
 const step=symbol?.filters?.find(row=>row.filterType==='LOT_SIZE')?.stepSize;
 const minNotional=symbol?.filters?.find(row=>row.filterType==='NOTIONAL')?.minNotional;
 const book=await readJson(await fetchImpl('https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)}));
 if(symbol?.status!=='TRADING'||!tick||!step||!minNotional||!book?.bidPrice)return {error:'invalid-grid'};
 const planned=planS01LimitBuys({...body,bid:book.bidPrice,tick,step,minNotional});
 if(planned.error)return planned;
 const account=await binanceSigned('GET','/api/v3/account',{},creds,fetchImpl);
 const free=gridScaled(account.balances?.find(row=>row.asset==='USDT')?.free??'0');
 if(free===null||free<gridScaled(planned.total))return {error:'balance'};
 const placed=[];
 for(const order of planned.orders){
  let existing=null;
  try{existing=await binanceSigned('GET','/api/v3/order',{symbol:'BTCUSDT',origClientOrderId:order.clientOrderId},creds,fetchImpl);}
  catch(error){if(error.exchangeCode!==-2013)return {error:'exchange-rejected',orders:placed};}
  const response=existing||await binanceSigned('POST','/api/v3/order',{symbol:'BTCUSDT',side:'BUY',type:'LIMIT_MAKER',price:order.price,quantity:order.quantity,newClientOrderId:order.clientOrderId,newOrderRespType:'RESULT'},creds,fetchImpl).catch(()=>({failed:true}));
  if(response?.failed)return {error:'exchange-rejected',orders:placed};
  placed.push({orderId:response.orderId,price:response.price||order.price,origQty:response.origQty||order.quantity,status:response.status||'NEW'});
 }
 return {ok:true,symbol:'BTCUSDT',side:'BUY',type:'LIMIT_MAKER',orders:placed,withdraw:false};
}
async function cancelSpotOrder(creds,body,fetchImpl){
 const keys=Object.keys(body||{});
 const orderId=keys.length===1&&keys[0]==='orderId'&&/^\d{1,20}$/.test(String(body.orderId))?String(body.orderId):'';
 if(!orderId)return {error:'invalid-order'};
 const inspected=await inspectBinanceAccount({key:creds.key,secret:creds.secret,market:'spot',fetchImpl});
 if(inspected.status!=='connected'||inspected.permission!=='trade')return {error:'trade-disabled'};
 let existing=null;
 try{existing=await binanceSigned('GET','/api/v3/order',{symbol:'BTCUSDT',orderId},creds,fetchImpl);}
 catch(error){return {error:error.exchangeCode===-2011||error.exchangeCode===-2013?'not-found':'exchange-rejected'};}
 const strategy=spotBotStrategy(existing?.clientOrderId);
 if(existing?.symbol!=='BTCUSDT'||existing.side!=='BUY'&&existing.side!=='SELL'||strategy!=='S01'&&strategy!=='S02')return {error:'not-strategy'};
 if(['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(existing.status))return {ok:true,orderId,status:'CANCELED',strategy,withdraw:false};
 if(existing.status==='FILLED')return {error:'filled'};
 if(existing.status!=='NEW'&&existing.status!=='PARTIALLY_FILLED'&&existing.status!=='PENDING_CANCEL')return {error:'invalid-order'};
 let response=null;
 try{response=await binanceSigned('DELETE','/api/v3/order',{symbol:'BTCUSDT',orderId},creds,fetchImpl);}
 catch(error){return error.exchangeCode===-2011?{ok:true,orderId,status:'CANCELED',strategy,withdraw:false}:{error:'exchange-rejected'};}
 if(response?.status!=='CANCELED'&&response?.status!=='EXPIRED'&&response?.status!=='EXPIRED_IN_MATCH')return {error:response?.status==='FILLED'?'filled':'exchange-rejected'};
 return {ok:true,orderId,status:'CANCELED',strategy,withdraw:false};
}
function timeoutCode(error){return error?.name==='TimeoutError'||error?.name==='AbortError'||error?.code==='ABORT_ERR';}
function withdrawEnabled(restrictions){
 return restrictions.enableWithdrawals===true||restrictions.permitsUniversalTransfer===true||restrictions.enableInternalTransfer===true;
}
export async function inspectBinanceAccount({key,secret,market,fetchImpl}){
 const creds={key,secret};
 const [account,restrictions]=await Promise.all([
  binanceSignedGet('/api/v3/account',{},creds,fetchImpl),
  binanceSignedGet('/sapi/v1/account/apiRestrictions',{},creds,fetchImpl)
 ]);
 if(!account||!Array.isArray(account.balances)||!restrictions||typeof restrictions.enableReading!=='boolean')throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});
 const usdt=account.balances.find(row=>row&&row.asset==='USDT');
 const available=usdt?decimalAmount(usdt.free):null,locked=usdt?decimalAmount(usdt.locked??'0'):null;
 const balanceChecked=available!==null;
 const amounts=balanceChecked&&locked!==null?{available,locked}:{};
 if(withdrawEnabled(restrictions))return {status:'denied',permission:null,balanceChecked};
 const trade=market==='perp'?restrictions.enableFutures===true:restrictions.enableSpotAndMarginTrading===true||account.canTrade===true;
 if(trade)return {status:'connected',permission:'trade',balanceChecked,...amounts};
 if(restrictions.enableReading===true)return {status:'connected',permission:'read',balanceChecked,...amounts};
 return {status:'disconnected',permission:null,balanceChecked};
}
export function createTradingConnectionStore({encryptionKey,now=()=>Date.now(),fetchImpl,persistPath=null}={}){
 const key=keyBytes(encryptionKey),owners=new Map(),preferred=new Map();
 const bucket=ownerId=>{if(!owners.has(ownerId))owners.set(ownerId,new Map());return owners.get(ownerId);};
 const preference=ownerId=>{if(!preferred.has(ownerId))preferred.set(ownerId,{});return preferred.get(ownerId);};
 function list(ownerId){return [...(owners.get(ownerId)?.values()||[])].map(publicTradingConnection);}
 function readOne(ownerId,connectionId){const record=owners.get(ownerId)?.get(connectionId);return record?publicTradingConnection(record):null;}
 function preferredRecord(ownerId,profileId){
  const id=preference(ownerId)[profileId];if(!id)return null;
  const record=owners.get(ownerId)?.get(id);if(!record||record.status==='expired')return null;
  return (record.kind==='CEX'?'cex-'+record.market:record.chain)===profileId?publicTradingConnection(record):null;
 }
 function hasUiCredentials(ownerId,connectionId){
  const record=owners.get(ownerId)?.get(connectionId);
  return Boolean(record&&record.source==='ui'&&isSecretBox(record.apiKey)&&isSecretBox(record.secret));
 }
 function unlockedCredentials(ownerId,connectionId){
  const record=owners.get(ownerId)?.get(connectionId);
  if(!record||!isSecretBox(record.apiKey)||!isSecretBox(record.secret))return null;
  try{const apiKey=decryptSecret(record.apiKey,key),secret=decryptSecret(record.secret,key);return credentialText(apiKey)&&credentialText(secret)?{key:apiKey,secret,market:record.market,label:record.label,source:record.source||'ui'}:null;}catch{return null;}
 }
 function snapshot(){
  const payload={version:1,owners:{}};
  for(const [ownerId,records]of owners){
   payload.owners[ownerId]={preferred:{...preference(ownerId)},records:[...records.values()].map(record=>({connectionId:record.connectionId,venue:record.venue,kind:record.kind,market:record.market,chain:record.chain,permission:record.permission,status:record.status,checkedAt:record.checkedAt,accountId:record.accountId,label:record.label,balanceChecked:record.balanceChecked===true,available:decimalAmount(record.available),locked:decimalAmount(record.locked),reason:record.reason||'',source:record.source||'ui',apiKey:record.apiKey,secret:record.secret}))};
  }
  return payload;
 }
 async function persist(){
  if(!persistPath)return;
  const dir=path.dirname(persistPath),tmp=persistPath+'.tmp';
  await mkdir(dir,{recursive:true,mode:0o700});
  try{await chmod(dir,0o700);}catch{}
  const handle=await open(tmp,'w',0o600);
  try{await handle.writeFile(JSON.stringify(snapshot()),'utf8');await handle.sync();}finally{await handle.close();}
  try{await chmod(tmp,0o600);}catch{}
  await rename(tmp,persistPath);
  try{await chmod(persistPath,0o600);}catch{}
 }
 function hydrate(payload){
  if(!payload||payload.version!==1||!payload.owners||typeof payload.owners!=='object')return;
  for(const [ownerId,entry]of Object.entries(payload.owners)){
   if(!TEXT.test(ownerId)||!entry||typeof entry!=='object')continue;
   const records=Array.isArray(entry.records)?entry.records:[];
   for(const item of records){
    if(!item||item.venue!=='binance'||!MARKETS.has(item.market)||item.kind!=='CEX'||!TEXT.test(item.connectionId)||!isSecretBox(item.apiKey)||!isSecretBox(item.secret))continue;
    try{if(!credentialText(decryptSecret(item.apiKey,key))||!credentialText(decryptSecret(item.secret,key)))continue;}catch{continue;}
    const status=STATUSES.has(item.status)?item.status:'unchecked';
    const permission=item.permission==='read'||item.permission==='trade'?item.permission:null;
    const reason=['restricted-location','timeout','check-failed'].includes(item.reason)?item.reason:'';
    const checkedAt=Number.isSafeInteger(item.checkedAt)&&item.checkedAt>=0?item.checkedAt:null;
    const label=labelText(item.label)||'Binance';
    bucket(ownerId).set(item.connectionId,{connectionId:item.connectionId,venue:'binance',kind:'CEX',market:item.market,chain:'',permission,status,checkedAt,accountId:item.market==='spot'?'BINANCE-SPOT':'BINANCE-PERP',label,balanceChecked:item.balanceChecked===true,available:decimalAmount(item.available),locked:decimalAmount(item.locked),reason,source:item.source==='env'?'env':'ui',apiKey:item.apiKey,secret:item.secret});
   }
   if(entry.preferred&&typeof entry.preferred==='object'){
    for(const [profileId,connectionId]of Object.entries(entry.preferred)){
     if(typeof profileId==='string'&&TEXT.test(connectionId)&&bucket(ownerId).has(connectionId))preference(ownerId)[profileId]=connectionId;
    }
   }
  }
 }
 async function load(){
  if(!persistPath)return;
  let raw;
  try{raw=await readFile(persistPath,'utf8');}catch(error){if(error?.code!=='ENOENT')return;return;}
  if(typeof raw!=='string'||raw.length>1000000)return;
  try{hydrate(JSON.parse(raw));}catch{}
 }
 async function saveAndCheck(input){
  if(!input||typeof input.ownerId!=='string'||!TEXT.test(input.ownerId))return {error:'invalid-connection'};
  if(input.venue!=='binance')return {error:'unsupported-venue'};
  if(!MARKETS.has(input.market)||!credentialText(input.key)||!credentialText(input.secret))return {error:'invalid-connection'};
  const connectionId='binance-'+input.market,records=bucket(input.ownerId);
  const label=labelText(input.label)||'Binance';
  const previous=records.get(connectionId);
  const record={connectionId,venue:'binance',kind:'CEX',market:input.market,chain:'',permission:previous?.permission??null,status:previous?.status==='connected'?'connected':'unchecked',checkedAt:previous?.status==='connected'?previous.checkedAt:null,accountId:input.market==='spot'?'BINANCE-SPOT':'BINANCE-PERP',label,balanceChecked:previous?.status==='connected'&&previous.balanceChecked===true,available:previous?.status==='connected'?decimalAmount(previous.available):null,locked:previous?.status==='connected'?decimalAmount(previous.locked)??0:null,reason:'',source:input.source==='env'?'env':'ui',apiKey:encryptSecret(input.key,key),secret:encryptSecret(input.secret,key)};
  records.set(connectionId,record);preference(input.ownerId)[input.market==='spot'?'cex-spot':'cex-perp']=connectionId;
  try{
   const result=await inspectBinanceAccount({key:input.key,secret:input.secret,market:input.market,fetchImpl});
   record.status=STATUSES.has(result.status)?result.status:'disconnected';
   record.permission=result.permission==='read'||result.permission==='trade'?result.permission:null;
   record.balanceChecked=result.balanceChecked===true;
   record.available=record.status==='connected'?decimalAmount(result.available):null;
   record.locked=record.available===null?null:decimalAmount(result.locked)??0;
   record.reason='';
  }catch(error){
   record.status='disconnected';record.permission=null;record.balanceChecked=false;record.available=null;record.locked=null;record.reason=error?.code==='RESTRICTED_LOCATION'?'restricted-location':timeoutCode(error)?'timeout':'check-failed';
  }
  record.checkedAt=now();
  await persist();
  return publicTradingConnection(record);
 }
 async function mark(ownerId,connectionId,status){
  const record=owners.get(ownerId)?.get(connectionId);if(!record||!STATUSES.has(status))return null;
  record.status=status;record.checkedAt=now();await persist();return publicTradingConnection(record);
 }
 function protectedSecrets(ownerId){return [...(owners.get(ownerId)?.values()||[])].flatMap(record=>[record.apiKey,record.secret].filter(Boolean));}
 async function noteSpotBalance(ownerId,available,locked){
  const record=owners.get(ownerId)?.get('binance-spot');
  const nextAvailable=decimalAmount(available),nextLocked=decimalAmount(locked);
  if(!record||record.status!=='connected'||nextAvailable===null||nextLocked===null)return false;
  if(record.available===nextAvailable&&record.locked===nextLocked&&record.balanceChecked===true)return false;
  record.available=nextAvailable;record.locked=nextLocked;record.balanceChecked=true;record.checkedAt=now();
  await persist();
  return true;
 }
 return {list,readOne,preferred:preferredRecord,saveAndCheck,mark,noteSpotBalance,protectedSecrets,hasUiCredentials,unlockedCredentials,load,persist};
}
async function readRequestJson(req){
 if(req.body!==undefined){
  if(typeof req.body==='object'&&req.body&&!Buffer.isBuffer(req.body)&&typeof req.body!=='string')return {ok:true,value:req.body};
  const raw=typeof req.body==='string'||Buffer.isBuffer(req.body)?String(req.body):null;
  if(raw===null)return {ok:false};
  if(Buffer.byteLength(raw)>BODY_LIMIT)return {ok:false};
  if(!raw.trim())return {ok:true,value:{}};
  try{return {ok:true,value:JSON.parse(raw)};}catch{return {ok:false};}
 }
 if(!req[Symbol.asyncIterator])return {ok:true,value:{}};
 const chunks=[];let size=0;
 for await(const chunk of req){
  const buf=Buffer.from(chunk);size+=buf.byteLength;if(size>BODY_LIMIT)return {ok:false};
  chunks.push(buf);
 }
 if(!size)return {ok:true,value:{}};
 try{return {ok:true,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))};}catch{return {ok:false};}
}
function tradingOperators(env){
 return String(env.ASTARTER_TRADING_OPERATORS||'').split(',').map(item=>item.trim().toLowerCase()).filter(item=>/^0x[0-9a-f]{40}$/.test(item));
}
function signedOperator(session,env,at){
 if(!session||session.chain!==56||typeof session.address!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(session.address))return false;
 if(!Number.isFinite(session.expires)||session.expires<=at)return false;
 const operators=tradingOperators(env);
 return !operators.length||operators.includes(session.address.toLowerCase());
}
function operatorWrite(session,env,at){
 return tradingOperators(env).length>0&&signedOperator(session,env,at);
}
export function createTradingConnectionService({env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),encryptionKey=env.ASTARTER_CONNECTION_KEY||randomBytes(32).toString('hex'),persistPath=null,sessionOf=()=>null}={}){
 const store=createTradingConnectionStore({encryptionKey,now,fetchImpl,persistPath}),ownerId='server';
 const apiKey=typeof env.BINANCE_API_KEY==='string'?env.BINANCE_API_KEY.trim():'';
 const secret=typeof env.BINANCE_API_SECRET==='string'?env.BINANCE_API_SECRET.trim():'';
 const configured=credentialText(apiKey)&&credentialText(secret);
 const ready=store.load();
 let pending=null;
 function checkFrom(input){
  const task=store.saveAndCheck(input).finally(()=>{if(pending===task)pending=null;});
  pending=task;return task;
 }
 function check(){
  if(store.hasUiCredentials(ownerId,'binance-spot')){
   const creds=store.unlockedCredentials(ownerId,'binance-spot');
   if(!creds)return Promise.resolve(null);
   if(!pending)return checkFrom({ownerId,venue:'binance',market:creds.market||'spot',key:creds.key,secret:creds.secret,label:creds.label,source:'ui'});
   return pending;
  }
  if(!configured)return Promise.resolve(null);
  if(!pending)return checkFrom({ownerId,venue:'binance',market:'spot',key:apiKey,secret,source:'env'});
  return pending;
 }
 async function current(){
  await ready;
  const rows=store.list(ownerId);
  const ui=store.hasUiCredentials(ownerId,'binance-spot');
  if(!ui&&!configured)return rows;
  const spot=rows.find(record=>record.connectionId==='binance-spot');
  if(!spot||spot.status==='unchecked'||!Number.isSafeInteger(spot.checkedAt)){await check();return store.list(ownerId);}
  if(now()-spot.checkedAt>60000)void check();
  return store.list(ownerId);
 }
 async function readSpotBook(){
  let creds=null;
  if(store.hasUiCredentials(ownerId,'binance-spot'))creds=store.unlockedCredentials(ownerId,'binance-spot');
  else if(configured)creds={key:apiKey,secret};
  if(!creds)return null;
  const [account,open]=await Promise.all([
   binanceSignedGet('/api/v3/account',{},creds,fetchImpl),
   binanceSignedGet('/api/v3/openOrders',{symbol:'BTCUSDT'},creds,fetchImpl)
  ]);
  let archived=[],fills=[],btcPrice=null,bnbPrice=null;
  try{archived=await binanceSignedGet('/api/v3/allOrders',{symbol:'BTCUSDT',limit:'50'},creds,fetchImpl);}catch{archived=[];}
  try{fills=await binanceSignedGet('/api/v3/myTrades',{symbol:'BTCUSDT',limit:'50'},creds,fetchImpl);}catch{fills=[];}
  try{const quote=await readJson(await fetchImpl('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}}));btcPrice=decimalAmount(typeof quote?.price==='string'?quote.price:'');}catch{btcPrice=null;}
  try{const quote=await readJson(await fetchImpl('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}}));bnbPrice=decimalAmount(typeof quote?.price==='string'?quote.price:'');}catch{bnbPrice=null;}
  let equityUsd=null;
  try{
   const wallets=await binanceSignedGet('/sapi/v1/asset/wallet/balance',{},creds,fetchImpl);
   if(Array.isArray(wallets)&&btcPrice){
    let btcTotal=0,seen=false;
    for(const row of wallets){const part=decimalAmount(row?.balance);if(part===null)continue;btcTotal+=part;seen=true;}
    if(seen)equityUsd=btcTotal*btcPrice;
   }
  }catch{equityUsd=null;}
  const rowFor=asset=>account.balances?.find(row=>row.asset===asset);
  const listed=row=>{if(!row||row.side!=='BUY'&&row.side!=='SELL')return null;return {orderId:row.orderId,side:row.side,type:row.type,price:row.price,origQty:row.origQty,executedQty:row.executedQty,cummulativeQuoteQty:row.cummulativeQuoteQty,status:row.status,time:row.time,strategy:spotBotStrategy(row.clientOrderId)};};
  const orders=(Array.isArray(open)?open:[]).slice(0,8).map(listed).filter(Boolean);
  const history=(Array.isArray(archived)?archived:[]).map(listed).filter(row=>row&&row.status!=='NEW'&&row.status!=='PARTIALLY_FILLED').sort((a,b)=>Number(b.time||0)-Number(a.time||0)).slice(0,20);
  const traded=row=>{
   if(!row||row.isBuyer!==true&&row.isBuyer!==false)return null;
   if(!['USDT','BTC','BNB'].includes(row.commissionAsset))return null;
   if(decimalAmount(row.price)===null||decimalAmount(row.qty)===null||decimalAmount(row.quoteQty)===null||decimalAmount(row.commission??'0')===null)return null;
   const id=String(row.id??''),orderId=String(row.orderId??'');
   if(!/^\d{1,20}$/.test(id)||!/^\d{1,20}$/.test(orderId))return null;
   const time=Number(row.time);
   return {id,orderId,price:String(row.price),qty:String(row.qty),quoteQty:String(row.quoteQty),commission:String(row.commission??'0'),commissionAsset:row.commissionAsset,isBuyer:row.isBuyer,...(Number.isSafeInteger(time)&&time>0?{time}:{})};
  };
  const trades=(Array.isArray(fills)?fills:[]).map(traded).filter(Boolean).sort((a,b)=>Number(a.time||0)-Number(b.time||0)).slice(-50);
  return {symbol:'BTCUSDT',usdt:decimalAmount(rowFor('USDT')?.free??'0'),usdtLocked:decimalAmount(rowFor('USDT')?.locked??'0'),btc:decimalAmount(rowFor('BTC')?.free??'0'),...(btcPrice?{btcPrice}:{}),...(bnbPrice?{bnbPrice}:{}),...(equityUsd!==null?{equityUsd}:{}),orders,history,trades};
 }
 return {configured,store,check,ready,async handle(req,res){
  let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{return false;}
  if(url.pathname!=='/api/trading-connections'&&url.pathname!=='/api/trading-connections/s01-grid'&&url.pathname!=='/api/trading-connections/cancel-order')return false;
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));return true;};
  if(!['GET','POST'].includes(req.method)||url.search)return send(req.method==='GET'||req.method==='POST'?400:405,{error:'invalid-connection',executionAuthority:'NONE'});
  let session=null;
  try{session=await sessionOf(req);}catch{session=null;}
  if(!signedOperator(session,env,now()))return send(401,{error:'sign-in-required',executionAuthority:'NONE'});
  if(req.method==='POST'&&!operatorWrite(session,env,now()))return send(403,{error:'operator-required',executionAuthority:'NONE'});
  try{
   await ready;
   if(url.pathname==='/api/trading-connections/s01-grid'){
    if(req.method!=='POST'||url.search)return send(req.method==='POST'?400:405,{error:'invalid-grid'});
    const parsed=await readRequestJson(req);
    if(!parsed.ok||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value))return send(400,{error:'invalid-grid'});
    let creds=null;
    if(store.hasUiCredentials(ownerId,'binance-spot'))creds=store.unlockedCredentials(ownerId,'binance-spot');
    else if(configured)creds={key:apiKey,secret};
    if(!creds)return send(403,{error:'trade-disabled'});
    const placed=await placeS01Grid(creds,parsed.value,fetchImpl);
    if(placed.error)return send(placed.orders?.length?502:400,{error:placed.error,orders:placed.orders||[]});
    return send(200,placed);
   }
   if(url.pathname==='/api/trading-connections/cancel-order'){
    if(req.method!=='POST')return send(405,{error:'invalid-order'});
    const parsed=await readRequestJson(req);
    if(!parsed.ok||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value))return send(400,{error:'invalid-order'});
    let creds=null;
    if(store.hasUiCredentials(ownerId,'binance-spot'))creds=store.unlockedCredentials(ownerId,'binance-spot');
    else if(configured)creds={key:apiKey,secret};
    if(!creds)return send(403,{error:'trade-disabled'});
    const canceled=await cancelSpotOrder(creds,parsed.value,fetchImpl);
    if(canceled.error)return send(canceled.error==='exchange-rejected'?502:400,{error:canceled.error});
    return send(200,canceled);
   }
   if(req.method==='POST'){
    const parsed=await readRequestJson(req);
    if(!parsed.ok)return send(400,{error:'invalid-connection',executionAuthority:'NONE'});
    const body=parsed.value&&typeof parsed.value==='object'&&!Array.isArray(parsed.value)?parsed.value:{};
    if(body.symbol||body.side||body.quantity||body.notional||body.order||executionAuthorization.ordersEnabled||liveOrderAllowed(body))return send(403,{error:'orders-disabled',executionAuthority:'NONE'});
    const postedKey=typeof body.apiKey==='string'?body.apiKey:typeof body.key==='string'?body.key:'';
    const postedSecret=typeof body.apiSecret==='string'?body.apiSecret:typeof body.secret==='string'?body.secret:'';
    if(postedKey||postedSecret||body.venue||body.market||body.label){
     const saved=await store.saveAndCheck({ownerId,venue:body.venue,market:body.market||'spot',key:postedKey,secret:postedSecret,label:body.label,source:'ui'});
     if(saved.error)return send(400,{error:saved.error,executionAuthority:'NONE'});
     return send(200,{connections:store.list(ownerId),executionAuthority:'NONE'});
    }
   }
   let connections=await current();
   let spotBook=null;
   try{spotBook=await readSpotBook();}catch{spotBook=null;}
   if(spotBook&&Number.isFinite(spotBook.usdt)){
    await store.noteSpotBalance(ownerId,spotBook.usdt,spotBook.usdtLocked??0);
    connections=store.list(ownerId);
   }
   return send(200,{connections,executionAuthority:'NONE',...(spotBook?{spotBook}:{})});
  }catch{return send(503,{error:'check-failed',executionAuthority:'NONE'});}
 }};
}
