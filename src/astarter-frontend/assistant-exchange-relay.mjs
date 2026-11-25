import {createHmac,randomBytes} from 'node:crypto';
import {exchangeQuery,normalizeExchangeData,exchangeAnalysis,PRIVATE_EXCHANGE_OPERATIONS,OKX_SITES,EXCHANGE_ASSETS,EXCHANGE_PERIODS} from './assistant-exchange-data.mjs';
const TTL=30*60*1000,PREFIX='/api/assistant/exchanges/',COOKIE='astarter_exchange';
const failure=(code,status=502)=>Object.assign(Error(code),{status});
export function okxReadRequest({operation,asset='BTC',period='1H',site='global'},keys,at=Date.now()){
 const pair=asset+'-USDT',definition={market:['/api/v5/market/ticker',{instId:pair}],orderbook:['/api/v5/market/books',{instId:pair,sz:10}],candles:['/api/v5/market/candles',{instId:pair,bar:period,limit:60}],funding:['/api/v5/public/funding-rate',{instId:pair+'-SWAP'}],account:['/api/v5/account/balance',{}],positions:['/api/v5/account/positions',{}],fills:['/api/v5/trade/fills',{instType:'SPOT',instId:pair,limit:50}],config:['/api/v5/account/config',{}]}[operation==='analysis'?'candles':operation];
 if(!definition||!Object.hasOwn(OKX_SITES,site)||!EXCHANGE_ASSETS.includes(asset)||!EXCHANGE_PERIODS.includes(period))throw failure('INVALID_QUERY',400);
 const [path,params]=definition,target=new URL(path,OKX_SITES[site]),headers={Accept:'application/json'};target.search=new URLSearchParams(params).toString();
 if(keys){const timestamp=new Date(at).toISOString();Object.assign(headers,{'OK-ACCESS-KEY':keys.apiKey,'OK-ACCESS-PASSPHRASE':keys.passphrase,'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':createHmac('sha256',keys.secretKey).update(timestamp+'GET'+target.pathname+target.search).digest('base64')});}
 return {url:target,options:{method:'GET',headers,signal:AbortSignal.timeout(10000),redirect:'error'}};
}
export async function readExchangeJson(response,provider='binance'){
 const httpError=()=>{throw failure([401,403].includes(response.status)?'AUTH_OR_PERMISSION':response.status===429?'RATE_LIMITED':'UPSTREAM_UNAVAILABLE',response.status===429?429:[401,403].includes(response.status)?401:503);};
 if(!response.headers.get('content-type')?.includes('json')){if(!response.ok)httpError();throw failure('INVALID_RESPONSE');}
 const reader=response.body?.getReader();if(!reader)throw failure('INVALID_RESPONSE');let size=0,parts=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();throw failure('INVALID_RESPONSE');}parts.push(Buffer.from(value));}
 let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw failure('INVALID_RESPONSE');}
 if(provider==='okx'){
  if(!data||typeof data.code!=='string'||typeof data.msg!=='string'||!Array.isArray(data.data))throw failure('INVALID_RESPONSE');
  if(data.code==='0'){if(!response.ok)httpError();return data.data;}
  if(['50011','50061'].includes(data.code))throw failure('RATE_LIMITED',429);
  if(data.code==='51001')throw failure('INSTRUMENT_UNAVAILABLE',400);
  if(/^501(?:0[1-9]|1[0-4]|19|20|21)$/.test(data.code))throw failure('AUTH_OR_PERMISSION',401);
  throw failure('UPSTREAM_UNAVAILABLE',503);
 }
 if(data&&Object.hasOwn(data,'code')){
  if(!Number.isInteger(data.code)||typeof data.msg!=='string')throw failure('INVALID_RESPONSE');
  if([-2014,-2015,-1022].includes(data.code))throw failure('AUTH_OR_PERMISSION',401);
  if(data.code===-1121)throw failure('INSTRUMENT_UNAVAILABLE',400);
  if(data.code===-1003)throw failure('RATE_LIMITED',429);
  throw failure('UPSTREAM_UNAVAILABLE',503);
 }
 if(!response.ok)httpError();return data;
}
async function binanceRead(query,keys,fetchImpl){
 const {operation,asset='BTC',period='1H'}=query,symbol=asset+'USDT';
 const definition={market:['https://data-api.binance.vision','/api/v3/ticker/24hr',{symbol}],orderbook:['https://data-api.binance.vision','/api/v3/depth',{symbol,limit:10}],candles:['https://data-api.binance.vision','/api/v3/klines',{symbol,interval:period.toLowerCase(),limit:60}],funding:['https://fapi.binance.com','/fapi/v1/premiumIndex',{symbol}],account:['https://api.binance.com','/api/v3/account',{}],positions:['https://fapi.binance.com','/fapi/v3/positionRisk',{}],fills:['https://api.binance.com','/api/v3/myTrades',{symbol,limit:50}],config:['https://api.binance.com','/sapi/v1/account/apiRestrictions',{}]}[operation];
 if(!definition)throw failure('INVALID_QUERY',400);
 const [base,path,params]=definition,headers={Accept:'application/json'},target=new URL(path,base),signal=AbortSignal.timeout(10000);
 if(keys){
  const clock=await readExchangeJson(await fetchImpl('https://api.binance.com/api/v3/time',{method:'GET',signal,redirect:'error'}));
  if(!Number.isFinite(clock.serverTime))throw failure('INVALID_RESPONSE');
  Object.assign(params,{timestamp:clock.serverTime,recvWindow:5000});headers['X-MBX-APIKEY']=keys.apiKey;
 }
 target.search=new URLSearchParams(params).toString();
 if(keys)target.searchParams.set('signature',createHmac('sha256',keys.secretKey).update(target.search.slice(1)).digest('hex'));
 return readExchangeJson(await fetchImpl(target,{method:'GET',headers,signal,redirect:'error'}));
}
function credentials(body,provider){
 if(!body||typeof body!=='object'||Object.keys(body).some(k=>!['apiKey','secretKey','passphrase','site'].includes(k)))throw failure('INVALID_QUERY',400);
 for(const key of ['apiKey','secretKey',...(provider==='okx'?['passphrase']:[])])if(typeof body[key]!=='string'||body[key].length<8||body[key].length>256||/[\s\x00-\x1f]/.test(body[key]))throw failure('INVALID_CREDENTIALS',400);
 if(!Object.hasOwn(OKX_SITES,body.site||'global'))throw failure('INVALID_QUERY',400);
 return {apiKey:body.apiKey,secretKey:body.secretKey,...(provider==='okx'?{passphrase:body.passphrase}:{}),site:provider==='okx'?body.site||'global':'global'};
}
async function bodyJson(req){
 if(!req.headers['content-type']?.startsWith('application/json'))throw failure('INVALID_QUERY',400);
 let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)throw failure('INVALID_QUERY',400);}
 try{return JSON.parse(body);}catch{throw failure('INVALID_QUERY',400);}
}
export function createExchangeHandler({fetchImpl=globalThis.fetch,now=Date.now,schedule=setTimeout,okxReadImpl=async(query,keys)=>{const {url,options}=okxReadRequest(query,keys,now());return readExchangeJson(await fetchImpl(url,options),'okx');}}={}){
 const sessions=new Map(),active=new Map();
 const drop=(session,provider)=>{const conn=session.connections[provider];if(conn?.timer)clearTimeout(conn.timer);delete session.connections[provider];};
 const invoke=(query,keys)=>query.provider==='okx'?okxReadImpl({...query,site:keys?.site||query.site},keys):binanceRead(query,keys,fetchImpl);
 return async function handle(req,res,{port=4188}={}){
  if(!req.url?.startsWith(PREFIX))return false;
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));return true;};
  let slot='',acquired=false,authRead=null;
  try{
   const originAllowed=['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin);
   if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)||req.headers.origin&&!originAllowed||req.method!=='GET'&&!originAllowed||req.headers['x-astarter-exchange']!=='1'||req.headers['sec-fetch-site']==='cross-site')throw failure('INVALID_ORIGIN',403);
   const url=new URL(req.url,'http://127.0.0.1'),parts=url.pathname.slice(PREFIX.length).split('/'),[provider,operation]=parts;
   if(parts.length!==2||!['binance','okx'].includes(provider))throw failure('INVALID_QUERY',400);
   for(const [id,s] of sessions){for(const p of Object.keys(s.connections))if(s.connections[p].expiresAt<=now())drop(s,p);if(s.expiresAt<=now()){for(const p of Object.keys(s.connections))drop(s,p);sessions.delete(id);}}
   const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
   let session=sessions.get(cookie),token=cookie;
   const acquire=()=>{slot=(session?token:req.socket.remoteAddress)+':'+provider;if((active.get(slot)||0)>=2)throw failure('RATE_LIMITED',429);active.set(slot,(active.get(slot)||0)+1);acquired=true;};
   if(operation==='status'){
    if(req.method!=='GET'||url.search)throw failure('INVALID_QUERY',400);
    const conn=session?.connections[provider];return send(200,{provider,connected:!!conn,connectionId:conn?.id||null,expiresAt:conn?.expiresAt||null,site:conn?.keys.site||'global'});
   }
   if(operation==='connection'){
    if(url.search)throw failure('INVALID_QUERY',400);
    if(req.method==='DELETE'){if(session){drop(session,provider);session.pending[provider]=null;}return send(200,{provider,connected:false,connectionId:null});}
    if(req.method!=='POST')throw failure('METHOD_NOT_ALLOWED',405);
    acquire();
    const keys=credentials(await bodyJson(req),provider);
    if(!session){if(sessions.size>=64)throw failure('RATE_LIMITED',429);token=randomBytes(32).toString('hex');session={connections:{},pending:{},expiresAt:now()+TTL};sessions.set(token,session);}
    const attempt=Symbol();session.pending[provider]=attempt;drop(session,provider);
    try{
    const config=await invoke({provider,operation:'config',site:keys.site},keys);
    const readonly=provider==='okx'?Array.isArray(config)&&typeof config[0]?.perm==='string'&&config[0].perm.split(',').map(x=>x.trim()).every(x=>x==='read_only'):config?.enableReading===true&&Object.entries(config).every(([key,value])=>!/^(enable|permits)/.test(key)||typeof value==='boolean'&&(['enableReading','enableFixReadOnly'].includes(key)||value===false));
    if(!readonly)throw failure('READ_ONLY_KEY_REQUIRED',400);
    await invoke({provider,operation:'account',asset:'BTC',period:'1H',site:keys.site},keys).then(raw=>normalizeExchangeData(provider,'account',raw,'BTC',now()));
    if(session.pending[provider]!==attempt||!sessions.has(token)||res.destroyed)throw failure('CONNECTION_CHANGED',409);
    drop(session,provider);const id=randomBytes(16).toString('hex'),expiresAt=now()+TTL,conn={id,keys,expiresAt};session.connections[provider]=conn;session.expiresAt=expiresAt;session.pending[provider]=null;
    conn.timer=schedule(()=>{if(session.connections[provider]?.id===id)drop(session,provider);if(!Object.keys(session.connections).length&&!Object.values(session.pending).some(Boolean))sessions.delete(token);},TTL);conn.timer?.unref?.();
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=1800`);
    return send(200,{provider,connected:true,connectionId:id,expiresAt,site:keys.site});
    }finally{if(session.pending[provider]===attempt)session.pending[provider]=null;if(!Object.keys(session.connections).length&&!Object.values(session.pending).some(Boolean))sessions.delete(token);}
   }
   if(req.method!=='GET')throw failure('METHOD_NOT_ALLOWED',405);
   const query=exchangeQuery(provider,operation,url.searchParams),isPrivate=PRIVATE_EXCHANGE_OPERATIONS.includes(operation),connection=session?.connections[provider];
   if(isPrivate&&!connection)throw failure('AUTH_REQUIRED',401);
   const expected=req.headers['x-astarter-connection'];if(isPrivate&&expected&&expected!==connection.id)throw failure('CONNECTION_CHANGED',409);
   acquire();if(isPrivate)authRead={session,provider,id:connection.id};
   const keys=isPrivate?connection.keys:null,readOperation=operation==='analysis'?'candles':operation;
   const raw=await invoke({...query,operation:readOperation},keys),data=normalizeExchangeData(provider,readOperation,raw,query.asset,now());
   if(isPrivate&&(!sessions.has(token)||session.connections[provider]?.id!==connection.id||connection.expiresAt<=now()))throw failure('CONNECTION_CHANGED',409);
   return send(200,{provider,operation,asset:query.asset,period:query.period,site:keys?.site||query.site,private:isPrivate,connectionId:isPrivate?connection.id:null,...data,...(operation==='analysis'?{analysis:exchangeAnalysis(data.rows)}:{})});
  }catch(error){if(error.status===401&&authRead&&authRead.session.connections[authRead.provider]?.id===authRead.id)drop(authRead.session,authRead.provider);const code=['INVALID_QUERY','INVALID_RESPONSE','INSUFFICIENT_CANDLES'].includes(error.message)?error.message:error.status?error.message:error.name==='TimeoutError'?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE';return send(error.status||(['INVALID_QUERY','INSUFFICIENT_CANDLES'].includes(code)?400:503),{error:code});}
  finally{if(acquired){const left=(active.get(slot)||1)-1;if(left)active.set(slot,left);else active.delete(slot);}}
 };
}
export const handleAssistantExchange=createExchangeHandler();
