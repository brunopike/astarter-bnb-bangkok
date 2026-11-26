// Public observations only. This module has no account, credit, wallet or execution imports.
export const HUB_ASSET_IDS={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',DOGE:'dogecoin',ADA:'cardano',AVAX:'avalanche-2',LINK:'chainlink',DOT:'polkadot',SUI:'sui',NEAR:'near',UNI:'uniswap',APT:'aptos',AAVE:'aave',LTC:'litecoin',BCH:'bitcoin-cash',TRX:'tron',TON:'the-open-network',SHIB:'shiba-inu'};
export const HUB_SYMBOLS=Object.keys(HUB_ASSET_IDS);
export const HUB_CATEGORIES=[['layer-1','Layer 1'],['decentralized-finance-defi','DeFi'],['real-world-assets-rwa','RWA'],['artificial-intelligence','AI'],['meme-token','Meme']];
export const HUB_RESOURCES={
 global:{url:'https://api.coingecko.com/api/v3/global',provider:'CoinGecko',source:'coingecko',interval:60000,stale:300000,maxBytes:30000},
 assets:{url:'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=24h,7d',provider:'CoinGecko',source:'coingecko',interval:60000,stale:300000,maxBytes:800000},
 tickers:{url:'https://data-api.binance.vision/api/v3/ticker/24hr?symbols='+encodeURIComponent(JSON.stringify(HUB_SYMBOLS.map(s=>s+'USDT'))),provider:'Binance Spot',interval:20000,stale:30000,maxBytes:60000},
 categories:{url:'https://api.coingecko.com/api/v3/coins/categories',provider:'CoinGecko',source:'coingecko',interval:300000,stale:900000,maxBytes:1000000},
 exchanges:{url:'https://api.coingecko.com/api/v3/exchanges?per_page=8&page=1',provider:'CoinGecko',interval:300000,stale:900000,maxBytes:50000},
 chains:{url:'https://api.llama.fi/v2/chains',provider:'DefiLlama',interval:300000,stale:900000,maxBytes:200000},
 stablecoins:{url:'https://stablecoins.llama.fi/stablecoincharts/all',provider:'DefiLlama',interval:600000,stale:129600000,maxBytes:2500000},
 tvl:{url:'https://api.llama.fi/v2/historicalChainTvl',provider:'DefiLlama',interval:600000,stale:129600000,maxBytes:400000},
 sentiment:{url:'https://api.alternative.me/fng/?limit=90&format=json',provider:'Alternative.me',source:'alternative.me',interval:600000,stale:129600000,maxBytes:30000}
};
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const number=v=>typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):v;
const valid=v=>{if(!v)throw new Error('INVALID_DATA');};
const label=(v,max=100)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const time=v=>typeof v==='number'?v:Date.parse(v);
export function hubSourceTime(value,key){
 const at=typeof value==='number'?value:typeof value==='string'&&value.trim()?Date.parse(value):NaN;
 if(!Number.isFinite(at)||!Number.isFinite(new Date(at).getTime()))return '—';
 if(['stablecoins','tvl','sentiment'].includes(key))return new Date(at).toISOString().slice(0,10);
 const displayed=new Date(at+8*3600000);return Number.isFinite(displayed.getTime())?displayed.toISOString().slice(0,19).replace('T',' ')+' UTC+8':'—';
}
function series(rows,value){
 valid(Array.isArray(rows)&&rows.length>0&&rows.length<=20000);
 const result=rows.map(row=>({at:Number(row.date)*1000,value:value(row)})).filter(row=>Number.isSafeInteger(row.at)&&row.at>0&&finite(row.value)&&row.value>=0).sort((a,b)=>a.at-b.at);
 valid(result.length>0&&result.every((row,i)=>!i||row.at>result[i-1].at));return result.slice(-366);
}
// A missing point must not turn a two-hour move into a one-hour move.
export const hourlySeries=values=>Array.isArray(values)&&values.every(v=>finite(v)&&v>0)?values.slice(-168):[];
function hubProvider(key,source){
 const policy=HUB_RESOURCES[key];
 if(source===null)return '—';
 if(policy?.source&&source==='coinmarketcap')return 'CoinMarketCap';
 valid(policy&&source===policy.source);
 return policy.provider;
}
export function normalizeHubResource(key,body,receivedAt=Date.now(),source=HUB_RESOURCES[key]?.source){
 let data,asOf=null;
 if(key==='global'){
  const d=body?.data;valid(d&&finite(d.total_market_cap?.usd)&&d.total_market_cap.usd>0&&finite(d.total_volume?.usd)&&finite(d.market_cap_percentage?.btc)&&finite(d.market_cap_change_percentage_24h_usd));
  data={cap:d.total_market_cap.usd,volume:d.total_volume.usd,btcShare:d.market_cap_percentage.btc,ethShare:finite(d.market_cap_percentage.eth)?d.market_cap_percentage.eth:null,change:d.market_cap_change_percentage_24h_usd,volumeChange:finite(d.volume_change_percentage_24h_usd)?d.volume_change_percentage_24h_usd:null,active:d.active_cryptocurrencies,venues:d.markets};asOf=Number(d.updated_at)*1000;
 }else if(key==='assets'){
  valid(Array.isArray(body)&&body.length>0&&body.length<=250);
  const provider=hubProvider(key,source);
  data=body.filter(a=>label(a.id)&&typeof a.symbol==='string'&&/^[a-z0-9._-]{1,20}$/i.test(a.symbol)&&label(a.name)&&finite(a.current_price)&&a.current_price>0&&finite(a.market_cap)&&a.market_cap>=0&&finite(time(a.last_updated))&&time(a.last_updated)<=receivedAt+300000).map(a=>({id:a.id,provider,symbol:a.symbol.toUpperCase(),name:a.name,price:a.current_price,cap:a.market_cap,volume:finite(a.total_volume)?a.total_volume:null,change:finite(a.price_change_percentage_24h)?a.price_change_percentage_24h:null,change7d:finite(a.price_change_percentage_7d_in_currency)?a.price_change_percentage_7d_in_currency:null,rank:a.market_cap_rank,high:a.high_24h,low:a.low_24h,image:a.image,asOf:time(a.last_updated),series:hourlySeries(a.sparkline_in_7d?.price)}));
  valid(data.length>0&&new Set(data.map(a=>a.id)).size===data.length);asOf=Math.min(...data.map(a=>a.asOf));
 }else if(key==='tickers'){
  valid(Array.isArray(body)&&body.length<=HUB_SYMBOLS.length);
  data=body.map(t=>normalizeHubTicker(t,receivedAt)).filter(Boolean);valid(data.length>0);asOf=Math.min(...data.map(t=>t.asOf));
 }else if(key==='categories'){
  valid(Array.isArray(body)&&body.length<=2000);
  data=body.filter(c=>HUB_CATEGORIES.some(([id])=>id===c.id)&&label(c.name)&&finite(c.market_cap)&&c.market_cap>0&&finite(c.market_cap_change_24h)&&finite(time(c.updated_at))).map(c=>({id:c.id,name:c.name,cap:c.market_cap,change:c.market_cap_change_24h,volume:finite(c.volume_24h)?c.volume_24h:null,asOf:time(c.updated_at)}));valid(data.length>0);asOf=Math.min(...data.map(c=>c.asOf));
 }else if(key==='exchanges'){
  valid(Array.isArray(body)&&body.length<=100);
  data=body.filter(e=>label(e.id)&&label(e.name)&&finite(e.trade_volume_24h_btc)&&e.trade_volume_24h_btc>=0).map(e=>({id:e.id,name:e.name,image:e.image,volume:e.trade_volume_24h_btc,rank:e.trust_score_rank})).sort((a,b)=>b.volume-a.volume);valid(data.length>0);
 }else if(key==='chains'){
  valid(Array.isArray(body)&&body.length<=2000);
  data=body.filter(c=>label(c.name)&&finite(c.tvl)&&c.tvl>0).map(c=>({name:c.name,tvl:c.tvl,symbol:label(c.tokenSymbol,20)?c.tokenSymbol:null})).sort((a,b)=>b.tvl-a.tvl);valid(data.length>0);
 }else if(key==='stablecoins'||key==='tvl'){
  data=series(body,row=>key==='tvl'?row.tvl:Object.values(row.totalCirculatingUSD||{}).reduce((sum,v)=>finite(v)&&v>=0?sum+v:sum,0));valid(key!=='stablecoins'||data.at(-1).value>0);asOf=data.at(-1).at;
 }else if(key==='sentiment'){
  valid(Array.isArray(body?.data)&&body.data.length>0&&body.data.length<=1000);
  data=body.data.map(row=>({at:Number(row.timestamp)*1000,value:number(row.value)})).filter(row=>Number.isSafeInteger(row.at)&&row.at>0&&Number.isInteger(row.value)&&row.value>=0&&row.value<=100).sort((a,b)=>a.at-b.at);valid(data.length>0);asOf=data.at(-1).at;
 }else throw new Error('UNKNOWN_RESOURCE');
 valid(asOf===null||Number.isFinite(asOf)&&asOf>0&&asOf<=receivedAt+300000);
 return {data,asOf,receivedAt,...(HUB_RESOURCES[key].source?{source,provider:hubProvider(key,source)}:{})};
}
export function normalizeHubTicker(raw,now=Date.now()){
 if(!raw||typeof raw.symbol!=='string'&&typeof raw.s!=='string')return null;
 const pair=raw.symbol||raw.s,symbol=pair.endsWith('USDT')?pair.slice(0,-4):null;
 if(!HUB_SYMBOLS.includes(symbol))return null;
 const price=number(raw.lastPrice??raw.c),open=number(raw.openPrice??raw.o),volume=number(raw.quoteVolume??raw.q),asOf=number(raw.closeTime??raw.E);
 if(!finite(price)||price<=0||!finite(open)||open<=0||!finite(volume)||volume<0||!Number.isSafeInteger(asOf)||asOf<=0||asOf>now+30000)return null;
 return {symbol,pair,price,open,volume,change:(price/open-1)*100,asOf,receivedAt:now,quote:'USDT',provider:'Binance Spot'};
}
export function hubSeriesChange(rows,days){
 if(!rows?.length)return null;const last=rows.at(-1),prior=[...rows].reverse().find(row=>row.at<=last.at-days*86400000);
 return prior&&prior.value>0?{delta:last.value-prior.value,percent:(last.value/prior.value-1)*100}:null;
}
export function hubQuality(snapshot,policy,now=Date.now(),error=null){
 if(!snapshot)return error?'unavailable':'loading';
 return error||now-(snapshot.asOf??snapshot.receivedAt)>policy.stale?'stale':'fresh';
}
export function hubRetryDelay(value,now=Date.now()){
 if(value==null||value==='')return 0;
 const delay=/^\d+(?:\.\d+)?$/.test(value)?Number(value)*1000:Date.parse(value)-now;
 return Number.isFinite(delay)?Math.min(86400000,Math.max(0,delay)):0;
}
export const HUB_REFRESH_SECONDS=Object.freeze([15,30,60,120,300]);
export function parseHubRefreshSeconds(value){const seconds=Number(value);if(!HUB_REFRESH_SECONDS.includes(seconds))throw new Error('INVALID_REFRESH_INTERVAL');return seconds;}
// The product footer and the market page consume the same public REST ticker feed.
const sharedTickerReaders=new WeakMap();
export function createMarketHubClient({fetchImpl=globalThis.fetch,WebSocketImpl=globalThis.WebSocket,storageImpl,now=Date.now,onChange=()=>{},onPrice=()=>{},refreshSeconds=60,resources=Object.keys(HUB_RESOURCES),shareTickersWhen=null}={}){
 const keys=[...new Set(resources)];valid(keys.length>0&&keys.every(key=>Object.hasOwn(HUB_RESOURCES,key)));
 const slots=new Map(),quotes=new Map(),events=[];
 let storage;try{storage=storageImpl===undefined?globalThis.localStorage:storageImpl;}catch{}
 const cacheKey=key=>'hive.public-markets.v1.'+key;
 let active=false,epoch=0,socket=null,socketEpoch=0,stream='idle',lastMessage=0,reconnectAt=0,connectAt=0,streamFailures=0,lastTick=-Infinity,manualAt=0,serial=0,inactiveAt=now(),refreshPromise=null;
 let interval=parseHubRefreshSeconds(refreshSeconds)*1000;
 const slot=key=>{
  if(!slots.has(key)){
   const policy=HUB_RESOURCES[key],s={snapshot:null,pending:false,error:null,detail:null,nextAt:0,retryAt:0,failures:0,controller:null,fromCache:false};
   try{const text=storage?.getItem(cacheKey(key));if(text&&text.length<=policy.maxBytes+300){const cached=JSON.parse(text);valid(cached.schema===1&&cached.url===policy.url&&finite(cached.receivedAt)&&cached.receivedAt<=now()+300000&&now()-cached.receivedAt<=Math.max(7200000,policy.stale*2));s.snapshot=normalizeHubResource(key,cached.body,cached.receivedAt,cached.source??null);s.fromCache=true;if(key==='tickers')s.snapshot.data.forEach(q=>acceptQuote(q,false));}}catch{}
   slots.set(key,s);
  }return slots.get(key);
 };
 function acceptQuote(quote,report){
  const old=quotes.get(quote.symbol);if(old&&old.asOf>quote.asOf)return false;
  quotes.set(quote.symbol,quote);
  if(report&&old&&old.price!==quote.price){events.unshift({id:++serial,symbol:quote.symbol,price:quote.price,previous:old.price,delta:(quote.price/old.price-1)*100,at:quote.asOf});events.splice(8);onPrice(quote,old);}
  return true;
 }
 async function load(key,manual=false){
  const s=slot(key),policy=HUB_RESOURCES[key],at=now();if(!active||s.pending||s.retryAt>at)return;
  const ownEpoch=epoch,controller=new AbortController();s.controller=controller;s.pending=true;s.detail=null;
  const timer=setTimeout(()=>controller.abort(),10000);onChange();
  try{
   const shared=!shareTickersWhen&&key==='tickers'&&sharedTickerReaders.get(fetchImpl);
   if(shared){
    const source=await shared(manual,interval);
    if(!source||!active||epoch!==ownEpoch||controller.signal.aborted)return;
    if(source.snapshot){s.snapshot=source.snapshot;s.snapshot.data.forEach(q=>acceptQuote(q,true));}
    s.fromCache=source.fromCache;s.error=source.error;s.detail=source.detail;s.retryAt=source.retryAt;
    s.nextAt=s.error?source.nextAt:now()+interval;
    return;
   }
   const options={credentials:'omit',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal};
   let response,relay=false;
   try{if(typeof window!=='undefined'&&['global','assets','tickers','categories','exchanges','sentiment'].includes(key)){relay=true;response=await fetchImpl('/api/market-hub?resource='+key,options);}else response=await fetchImpl(policy.url,options);}catch(error){
    if(relay||!['global','assets','categories','exchanges'].includes(key)||controller.signal.aborted||!active||epoch!==ownEpoch)throw error;
    relay=true;response=await fetchImpl('/api/market-hub?resource='+key,options);
   }
   if(!active||epoch!==ownEpoch)return;
   if(relay&&[502,503,504].includes(response.status)&&!hubRetryDelay(response.headers?.get?.('Retry-After'),now())){try{void response.body?.cancel().catch(()=>{});}catch{}response=await fetchImpl('/api/market-hub?resource='+key,options);if(!active||epoch!==ownEpoch)return;}
   const retry=hubRetryDelay(response.headers?.get?.('Retry-After'),now());if(!response.ok&&retry>0)s.retryAt=now()+retry;
   if(!response.ok){try{void response.body?.cancel().catch(()=>{});}catch{}s.detail='HTTP '+response.status;throw new Error(response.status===429?'RATE_LIMIT':response.status===402?'AUTH_REQUIRED':'FETCH_FAILED');}
   const text=await response.text();if(text.length>policy.maxBytes)throw new Error('INVALID_DATA');
   let body;try{body=JSON.parse(text);}catch{throw new Error('INVALID_DATA');}
   let receivedAt=now(),source=policy.source;if(relay){valid(body?.schema==='public-market-relay-v1'&&body.resource===key&&finite(body.receivedAt)&&body.receivedAt>0&&body.receivedAt<=now()+300000);receivedAt=body.receivedAt;source=body.source??policy.source;body=body.body;}
   const snapshot=normalizeHubResource(key,body,receivedAt,source);if(!active||epoch!==ownEpoch)return;
   s.snapshot=snapshot;s.fromCache=false;s.error=null;s.detail=null;s.failures=0;s.retryAt=0;s.nextAt=now()+interval;
   const cacheBody=key==='categories'?body.filter(c=>HUB_CATEGORIES.some(([id])=>id===c.id)):['stablecoins','tvl'].includes(key)?body.slice(-366):body;
   try{storage?.setItem(cacheKey(key),JSON.stringify({schema:1,url:policy.url,receivedAt:snapshot.receivedAt,source:snapshot.source,body:cacheBody}));}catch{}
   if(key==='tickers')snapshot.data.forEach(q=>acceptQuote(q,true));
  }catch(error){
   if(!active||epoch!==ownEpoch)return;
   s.detail=s.detail||String(error?.name||'Error')+': '+String(error?.message||'').slice(0,120);
   s.error=['RATE_LIMIT','AUTH_REQUIRED','INVALID_DATA'].includes(error?.message)?error.message:controller.signal.aborted?'TIMEOUT':'FETCH_FAILED';
   s.failures++;s.retryAt=Math.max(s.retryAt,now()+Math.min(300000,15000*2**Math.min(4,s.failures-1)));s.nextAt=s.retryAt;
  }finally{clearTimeout(timer);if(epoch===ownEpoch){s.pending=false;s.controller=null;onChange();}}
 }
 function closeStream(){socketEpoch++;const previous=socket;socket=null;previous?.close();stream='idle';}
 function connect(){
  if(!WebSocketImpl||socket||!active||now()<reconnectAt)return;
  const id=++socketEpoch;stream='connecting';connectAt=now();
  const failed=()=>{if(id!==socketEpoch)return;socketEpoch++;const previous=socket;socket=null;previous?.close();stream='polling';streamFailures++;reconnectAt=now()+Math.min(60000,5000*2**Math.min(4,streamFailures-1));onChange();};
  try{
   socket=new WebSocketImpl('wss://data-stream.binance.vision/stream?streams='+HUB_SYMBOLS.map(s=>s.toLowerCase()+'usdt@miniTicker').join('/'));
   socket.onopen=()=>{if(id===socketEpoch)stream='waiting';};
   socket.onerror=failed;socket.onclose=failed;
   socket.onmessage=event=>{
    if(!active||id!==socketEpoch||typeof event.data!=='string'||event.data.length>10000)return;
    try{const raw=JSON.parse(event.data),quote=normalizeHubTicker(raw.data||raw,now());if(!quote||now()-quote.asOf>30000)return;lastMessage=now();streamFailures=0;stream='live';acceptQuote(quote,true);}catch{}
   };
  }catch{failed();}
 }
 function setActive(value){
  if(active===value)return;active=value;epoch++;
  if(!active){inactiveAt=now();closeStream();for(const s of slots.values()){s.controller?.abort();s.controller=null;s.pending=false;}}
  else{lastTick=-Infinity;for(const s of slots.values())if(!s.snapshot)s.nextAt=0;tick();}
 }
 function tick(manual=false){
  if(!active||now()-lastTick<500)return;lastTick=now();
  for(const key of keys){
   const s=slot(key);if(s.nextAt>now()||s.retryAt>now()||s.pending)continue;
   if(key==='tickers'&&stream==='live'&&now()-lastMessage<10000&&s.snapshot){s.nextAt=now()+interval;continue;}
   s.task=load(key,manual);
  }
  if(socket&&((stream==='connecting'||stream==='waiting')&&now()-connectAt>12000||stream==='live'&&now()-lastMessage>20000)){closeStream();stream='polling';reconnectAt=now()+5000;slot('tickers').nextAt=0;onChange();}
  if(keys.includes('tickers'))connect();
 }
 async function sharedRead(manual,requestedInterval){
  if(!shareTickersWhen())return null;
  setActive(true);
  const s=slot('tickers');
  if(manual)await client.refresh();
  else{
   // A faster market-page setting can advance the next read without starting a second poller.
   if(s.snapshot&&!s.pending&&!s.error&&requestedInterval<interval&&now()>=s.nextAt-interval+requestedInterval){s.nextAt=0;lastTick=-Infinity;}
   tick();
  }
  await s.task;
  return shareTickersWhen()?s:null;
 }
 const client={
  setActive,tick,
  setRefreshSeconds(value){interval=parseHubRefreshSeconds(value)*1000;for(const s of slots.values())s.nextAt=now()+interval;return interval/1000;},
  get refreshSeconds(){return interval/1000;},
  refresh(){
   if(refreshPromise)return refreshPromise;
   if(!active)return Promise.resolve({status:'inactive'});
   if(now()<manualAt)return Promise.resolve({status:'cooldown',retryIn:Math.ceil((manualAt-now())/1000)});
   manualAt=now()+15000;const ownEpoch=epoch;
   for(const s of slots.values())s.nextAt=0;
   lastTick=-Infinity;tick(true);
   refreshPromise=Promise.all([...slots.values()].map(s=>s.task)).then(()=>{
    if(!active||epoch!==ownEpoch)return {status:'cancelled'};
    const failed=[...slots.values()].filter(s=>s.error);
    return {status:failed.length===slots.size?'failed':failed.length?'partial':'complete',failed:failed.length,total:slots.size,retryIn:failed.length?Math.max(0,Math.ceil((Math.min(...failed.map(s=>s.retryAt))-now())/1000)):0};
   }).finally(()=>{refreshPromise=null;});
   return refreshPromise;
  },
  read(key){const s=slot(key);return {...s,controller:undefined,task:undefined,quality:hubQuality(s.snapshot,HUB_RESOURCES[key],now(),s.error),retryIn:Math.max(0,Math.ceil((s.retryAt-now())/1000))};},
  quote(asset){const q=quotes.get(asset.symbol);return q&&HUB_ASSET_IDS[asset.symbol]===asset.id&&(active?now():inactiveAt)-q.asOf<=30000?q:{symbol:asset.symbol,price:asset.price,change:asset.change,volume:asset.volume,asOf:asset.asOf??asset.receivedAt,quote:'USD',provider:asset.address?'DEX Screener':asset.provider||HUB_RESOURCES.assets.provider};},
  get events(){return events.slice();},get stream(){return stream;},get lastMessage(){return lastMessage;},get active(){return active;},
  dispose(){setActive(false);if(sharedTickerReaders.get(fetchImpl)===sharedRead)sharedTickerReaders.delete(fetchImpl);}
 };
 if(shareTickersWhen)sharedTickerReaders.set(fetchImpl,sharedRead);
 return client;
}

// Limited public background observations. None is asset flow or execution evidence.
export const RESEARCH_BACKGROUND_RESOURCES=Object.freeze(['sentiment','chains','stablecoins']);
const backgroundSchema='research-background-v1',backgroundSkew=1000;
const backgroundError=code=>Object.assign(Error(code),{code});
const exactBackground=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
export function validateResearchBackground(value,resource,at=Date.now()){
 if(!RESEARCH_BACKGROUND_RESOURCES.includes(resource)||!Number.isSafeInteger(at)||at<0||!exactBackground(value,['schema','resource','provider','asOf','receivedAt','validUntil','data'])||value.schema!==backgroundSchema||value.resource!==resource||(value.provider!==HUB_RESOURCES[resource].provider&&!(resource==='sentiment'&&value.provider==='CoinMarketCap')))throw backgroundError('BACKGROUND_INVALID');
 const policy=HUB_RESOURCES[resource],daily=resource!=='chains';
 if(!Number.isSafeInteger(value.receivedAt)||value.receivedAt<0||value.receivedAt>at+backgroundSkew||(daily?(!Number.isSafeInteger(value.asOf)||value.asOf<0||value.asOf%86400000!==0||value.asOf>value.receivedAt+backgroundSkew):value.asOf!==null))throw backgroundError('BACKGROUND_INVALID');
 if(value.validUntil!==(daily?value.asOf:value.receivedAt)+policy.stale)throw backgroundError('BACKGROUND_INVALID');
 if(resource==='sentiment'){
  if(!exactBackground(value.data,['value'])||!Number.isInteger(value.data.value)||value.data.value<0||value.data.value>100)throw backgroundError('BACKGROUND_INVALID');
 }else if(resource==='stablecoins'){
  if(!exactBackground(value.data,['totalUsd'])||!finite(value.data.totalUsd)||value.data.totalUsd<=0)throw backgroundError('BACKGROUND_INVALID');
 }else if(!Array.isArray(value.data)||!value.data.length||value.data.length>2||new Set(value.data.map(row=>row?.name)).size!==value.data.length||value.data.some(row=>!exactBackground(row,['name','tvl'])||!['Ethereum','Solana'].includes(row.name)||!finite(row.tvl)||row.tvl<=0))throw backgroundError('BACKGROUND_INVALID');
 if(value.validUntil<=at)throw backgroundError('BACKGROUND_STALE');
 return structuredClone(value);
}
export function normalizeResearchBackground(envelope,resource,at=Date.now()){
 const fields=['schema','resource','receivedAt','body'];
 if(resource==='sentiment'&&envelope&&Object.hasOwn(envelope,'source'))fields.push('source');
 if(!RESEARCH_BACKGROUND_RESOURCES.includes(resource)||!exactBackground(envelope,fields)||envelope.schema!=='public-market-relay-v1'||envelope.resource!==resource)throw backgroundError('BACKGROUND_INVALID');
 let observed;try{observed=normalizeHubResource(resource,envelope.body,envelope.receivedAt,envelope.source);}catch{throw backgroundError('BACKGROUND_INVALID');}
 const last=observed.data.at(-1),data=resource==='sentiment'?{value:last.value}:resource==='stablecoins'?{totalUsd:last.value}:observed.data.filter(row=>['Ethereum','Solana'].includes(row.name)).map(({name,tvl})=>({name,tvl})).sort((a,b)=>a.name.localeCompare(b.name));
 if(resource==='sentiment'&&observed.data.some((row,i)=>i&&row.at<=observed.data[i-1].at))throw backgroundError('BACKGROUND_INVALID');
 if(resource==='chains'&&new Set(data.map(row=>row.name)).size!==data.length)throw backgroundError('BACKGROUND_INVALID');
 return validateResearchBackground({schema:backgroundSchema,resource,provider:observed.provider??HUB_RESOURCES[resource].provider,asOf:observed.asOf,receivedAt:observed.receivedAt,validUntil:(observed.asOf??observed.receivedAt)+HUB_RESOURCES[resource].stale,data},resource,at);
}

// Shared per-workbench slots coalesce all assets; construction performs no I/O.
export function createResearchBackgroundClient({fetchImpl=globalThis.fetch,now=Date.now,onChange=()=>{},timeoutMs=8000}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw backgroundError('BACKGROUND_CONFIGURATION');
 const slots=new Map(RESEARCH_BACKGROUND_RESOURCES.map(resource=>[resource,{snapshot:null,error:false,pending:null,controller:null,nextAt:0}]));let active=false,disposed=false,epoch=0;
 const rows=()=>[...slots].map(([resource,s])=>{let state=!active?'paused':s.error?'error':'loading';if(active&&!s.error&&s.snapshot)try{validateResearchBackground(s.snapshot,resource,now());state='ready';}catch{state='stale';}return {resource,state,snapshot:s.snapshot?structuredClone(s.snapshot):null};});
 const emit=()=>{if(!disposed)onChange(rows());};
 async function load(resource){
  const s=slots.get(resource);if(disposed||!active||s.pending)return s?.pending;
  const ownEpoch=epoch,controller=new AbortController();s.controller=controller;s.error=false;
  let rejectStop,reader;const stopped=new Promise((_,reject)=>rejectStop=reject);stopped.catch(()=>{});
  controller.signal.addEventListener('abort',()=>rejectStop(backgroundError('BACKGROUND_ABORTED')),{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs),bounded=value=>Promise.race([value,stopped]);
  const work=(async()=>{
   try{
    const exchange=Promise.resolve().then(()=>{if(controller.signal.aborted||!active||epoch!==ownEpoch)throw backgroundError('BACKGROUND_ABORTED');return fetchImpl('/api/market-hub?resource='+resource,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});});
    void exchange.then(response=>{if(controller.signal.aborted)try{void response.body?.cancel().catch(()=>{});}catch{}},()=>{});
    const response=await bounded(exchange);if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')){try{void response.body?.cancel().catch(()=>{});}catch{}throw backgroundError('BACKGROUND_UNAVAILABLE');}
    const max=HUB_RESOURCES[resource].maxBytes+1024,length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max)||!response.body?.getReader)throw backgroundError('BACKGROUND_INVALID');
    reader=response.body.getReader();const parts=[],decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0;
    for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw backgroundError('BACKGROUND_INVALID');bytes+=chunk.value.byteLength;if(bytes>max)throw backgroundError('BACKGROUND_INVALID');parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());
    const snapshot=normalizeResearchBackground(JSON.parse(parts.join('')),resource,now());
    if(!active||disposed||epoch!==ownEpoch)return;
    const old=s.snapshot;if(!old||snapshot.receivedAt>=old.receivedAt&&(old.asOf===null||snapshot.asOf>=old.asOf))s.snapshot=snapshot;
    s.error=false;s.nextAt=now()+HUB_RESOURCES[resource].interval;
   }catch{if(active&&!disposed&&epoch===ownEpoch){s.error=true;s.nextAt=now()+30000;}}
   finally{clearTimeout(timer);try{void reader?.cancel().catch(()=>{});}catch{}controller.abort();if(epoch===ownEpoch&&s.pending===work){s.pending=null;s.controller=null;emit();}}
  })();s.pending=work;emit();return work;
 }
 function tick(){if(active&&!disposed)for(const [resource,s]of slots)if(!s.pending&&s.nextAt<=now())void load(resource);}
 return {rows,tick,setActive(value){value=Boolean(value)&&!disposed;if(active===value)return;active=value;epoch++;if(!active){for(const s of slots.values()){s.controller?.abort();s.controller=null;s.pending=null;}}emit();if(active)tick();},refresh(resource){const chosen=RESEARCH_BACKGROUND_RESOURCES.includes(resource)?[resource]:RESEARCH_BACKGROUND_RESOURCES;if(!active||disposed)return Promise.resolve();for(const key of chosen)slots.get(key).nextAt=0;return Promise.all(chosen.map(key=>load(key)));},dispose(){if(disposed)return;this.setActive(false);disposed=true;epoch++;}};
}
