import {HUB_RESOURCES,HUB_SYMBOLS,normalizeHubResource} from './market-hub-data.mjs';
import {CROSS_MARKETS,GOLD_SPOT,validateGoldSpot,validateCrossSnapshot} from './cross-market-data.mjs';
import {TOKEN_IDS} from './brand-icon-data.mjs';

export const MAX_ASSISTANT_QUOTES=5;
export function assistantQuoteInstrument(symbol){
 if(HUB_SYMBOLS.includes(symbol))return {source:'Binance Spot',unit:'USDT',market:symbol+'/USDT',resource:'tickers'};
 if(symbol==='XAU')return {source:GOLD_SPOT.source,unit:'USD/troy oz',market:'XAU/USD',resource:'gold-spot'};
 if(Object.hasOwn(CROSS_MARKETS,symbol))return {...CROSS_MARKETS[symbol],market:symbol,resource:'cross-candles'};
 const ids=Object.keys(TOKEN_IDS).filter(id=>TOKEN_IDS[id]===symbol);
 if(ids.length===1)return {source:'CoinGecko',unit:'USD',market:symbol+'/USD',id:ids[0],resource:'watch-assets'};
 return null;
}
export function cleanAssistantQuote(value){
 if(typeof value?.symbol!=='string')return null;
 const {symbol}=value,instrument=assistantQuoteInstrument(symbol);
 if(!instrument)return null;
 const identity={symbol,market:instrument.market,source:instrument.source,unit:instrument.unit,...(instrument.id?{instrumentId:instrument.id}:{})};
 if(Object.entries(identity).some(([key,wanted])=>value[key]!==wanted))return {symbol,state:'unavailable'};
 const validTime=Number.isSafeInteger(value.asOf)&&value.asOf>0&&value.asOf<8_640_000_000_000_000-28_800_000;
 if(value.state==='stale'&&validTime)return {...identity,state:'stale',asOf:value.asOf};
 if(value.state==='observed'&&validTime&&Number.isFinite(value.price)&&value.price>0)
  return {...identity,state:'observed',price:value.price,change:Number.isFinite(value.change)?value.change:null,asOf:value.asOf};
 return {symbol,state:'unavailable'};
}
// Prices come from the same public instruments as the market screens. Event/close
// times establish freshness. The relay's receipt time never dates a price.
export async function readAssistantQuotes(symbols,{fetchImpl=globalThis.fetch,now=Date.now,signal=AbortSignal.timeout(8000)}={}){
 const requests=new Map();
 async function envelope(resource,params,maxBytes){
  const url='/api/market-hub?'+new URLSearchParams({resource,...params});
  if(!requests.has(url))requests.set(url,(async()=>{
   signal.throwIfAborted();
   const response=await fetchImpl(url,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal});
   signal.throwIfAborted();
   if(!response.ok)throw Error('QUOTE_UNAVAILABLE');
   const text=await response.text();if(text.length>maxBytes+512)throw Error('QUOTE_INVALID');
   const result=JSON.parse(text);
   if(result?.schema!=='public-market-relay-v1'||result.resource!==resource||!Number.isSafeInteger(result.receivedAt)||result.receivedAt<=0||result.receivedAt>now()+30000)throw Error('QUOTE_INVALID');
   return result;
  })());
  return requests.get(url);
 }
 const targets=[...new Set(symbols)].slice(0,MAX_ASSISTANT_QUOTES),coinIds=targets.map(assistantQuoteInstrument).filter(i=>i?.resource==='watch-assets').map(i=>i.id);
 const unavailable=()=>targets.map(symbol=>({symbol,state:'unavailable'}));
 if(signal.aborted)return unavailable();
 let abort;
 const deadline=new Promise(resolve=>{abort=()=>resolve(unavailable());signal.addEventListener('abort',abort,{once:true});});
 const reads=Promise.all(targets.map(async symbol=>{
  const instrument=assistantQuoteInstrument(symbol);
  try{
   const {resource}=instrument;let row,validUntil;
   if(resource==='gold-spot'){
    const {body}=await envelope(resource,{},4096);
    if(!validateGoldSpot(body,now()))throw Error('QUOTE_INVALID');
    row=body;validUntil=row.asOf+GOLD_SPOT.stale;
   }else if(resource==='cross-candles'){
    const {body}=await envelope(resource,{symbol},600000);
    validateCrossSnapshot(body,{...instrument,symbol},now());
    const bar=body.bars.findLast(b=>b.closedAt===body.closedAt);
    row={price:bar.close,asOf:bar.closedAt*1000};validUntil=bar.validUntil*1000;
   }else{
    const ticker=resource==='tickers',key=ticker?'tickers':'assets',policy=HUB_RESOURCES[key];
    const {body,receivedAt}=await envelope(resource,ticker?{}:{ids:coinIds.join(',')},ticker?policy.maxBytes:2000000);
    const matches=normalizeHubResource(key,body,receivedAt).data.filter(q=>q.symbol===symbol&&(ticker?q.pair===symbol+'USDT':q.id===instrument.id));
    if(matches.length!==1)throw Error('QUOTE_IDENTITY');
    row=matches[0];validUntil=row.asOf+policy.stale;
   }
   if(row.asOf>now()+30000)throw Error('QUOTE_INVALID');
   return cleanAssistantQuote({...row,symbol,market:instrument.market,source:instrument.source,unit:instrument.unit,instrumentId:instrument.id,state:validUntil<now()?'stale':'observed'});
  }catch{return {symbol,state:'unavailable'};}
 }));
 try{return await Promise.race([reads,deadline]);}finally{signal.removeEventListener('abort',abort);}
}

export const EXCHANGE_ASSETS=['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','LTC','DOT','SUI'];
export const EXCHANGE_PERIODS=['15m','1H','4H','1D'];
export const EXCHANGE_OPERATIONS=['market','orderbook','candles','funding','analysis','account','positions','fills'];
export const PRIVATE_EXCHANGE_OPERATIONS=['account','positions','fills'];
export const EXCHANGE_CAPABILITIES={market:['行情','Market data'],orderbook:['盘口','Order book'],candles:['K 线','Candles'],funding:['资金费率','Funding rate'],analysis:['行情分析','Market analysis'],account:['账户资产','Balances'],positions:['合约持仓','Positions'],fills:['现货成交','Spot fills']};
export const OKX_SITES={global:'https://www.okx.com',eea:'https://eea.okx.com',us:'https://us.okx.com',tr:'https://tr.okx.com'};
export function exchangeQuery(provider,operation,params=new URLSearchParams()){
 const keys=[...params.keys()];
 if(!['binance','okx'].includes(provider)||!EXCHANGE_OPERATIONS.includes(operation)||keys.some(k=>!['asset','period','site'].includes(k))||new Set(keys).size!==keys.length)throw Error('INVALID_QUERY');
 const asset=params.get('asset')||'BTC',period=params.get('period')||'1H',site=params.get('site')||'global';
 if(!EXCHANGE_ASSETS.includes(asset)||!EXCHANGE_PERIODS.includes(period)||!Object.hasOwn(OKX_SITES,site))throw Error('INVALID_QUERY');
 return {provider,operation,asset,period,site};
}
const invalid=()=>{throw Error('INVALID_RESPONSE');};
const number=(v,optional=false)=>v==null||v===''?optional?null:invalid():['string','number'].includes(typeof v)&&String(v).trim()&&Number.isFinite(Number(v))?Number(v):invalid();
const text=v=>typeof v==='string'&&v.length<=100?v:invalid();
const array=v=>Array.isArray(v)&&v.length<=1000?v:invalid();
const stamp=(value,now)=>{const at=number(value);if(at<=0||at>now+60000)invalid();return at;};
export function normalizeExchangeData(provider,operation,raw,asset,now=Date.now()){
 const okx=provider==='okx',unit='USDT',market=asset+(okx?'-USDT':'USDT');let rows,asOf=now;
 if(operation==='market'){
  const d=okx?array(raw)[0]:raw;if(!d||(okx?d.instId:d.symbol)!==market)invalid();
  asOf=stamp(okx?d.ts:d.closeTime,now);const last=number(okx?d.last:d.lastPrice),open=number(okx?d.open24h:d.openPrice,true);
  if(last<=0)invalid();
  rows=[{market,last,changePct:okx?open>0?(last/open-1)*100:null:number(d.priceChangePercent,true),high:number(okx?d.high24h:d.highPrice,true),low:number(okx?d.low24h:d.lowPrice,true),volume:number(okx?d.vol24h:d.volume,true),quoteVolume:number(okx?d.volCcy24h:d.quoteVolume,true)}];
 }else if(operation==='orderbook'){
  const d=okx?array(raw)[0]:raw;if(!d)invalid();asOf=okx?stamp(d.ts,now):now;
  rows=['bids','asks'].flatMap(side=>array(d[side]).slice(0,10).map(r=>({side:side==='bids'?'buy':'sell',price:number(r[0]),quantity:number(r[1])})));if(rows.some(r=>r.price<=0||r.quantity<0))invalid();
 }else if(operation==='candles'){
  rows=array(raw).filter(r=>okx?r[8]==='1':number(r[6])<=now).map(r=>({time:stamp(r[0],now),open:number(r[1]),high:number(r[2]),low:number(r[3]),close:number(r[4]),volume:number(r[5])})).sort((a,b)=>a.time-b.time);
  if(rows.some((r,i)=>r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)||r.low<=0||r.volume<0||i&&r.time<=rows[i-1].time))invalid();
  asOf=rows.at(-1)?.time||now;
 }else if(operation==='funding'){
  const d=okx?array(raw)[0]:raw;if(!d||(okx?d.instId!==market+'-SWAP':d.symbol!==market))invalid();
  rows=[{market:okx?market+'-SWAP':market,ratePct:number(okx?d.fundingRate:d.lastFundingRate)*100,nextTime:number(okx?d.nextFundingTime:d.nextFundingTime,true),markPrice:okx?null:number(d.markPrice,true)}];
  asOf=okx?now:stamp(d.time,now);
 }else if(operation==='account'){
  const list=okx?array(array(raw)[0]?.details):array(raw?.balances);
  rows=list.map(d=>({asset:text(okx?d.ccy:d.asset),available:okx?number(d.availBal||d.availEq,true):number(d.free),held:number(okx?d.frozenBal:d.locked,okx),total:okx?number(d.eq,true):number(d.free)+number(d.locked)})).filter(d=>d.total!==0||d.held!==0);
 }else if(operation==='positions'){
  rows=array(raw).map(d=>({market:text(okx?d.instId:d.symbol),side:text(okx?d.posSide||'net':d.positionSide||'BOTH'),size:number(okx?d.pos:d.positionAmt),sizeUnit:okx?['SWAP','FUTURES','OPTION'].includes(d.instType)?'contracts':text(d.instId).split('-')[0]:text(d.symbol).replace(/(?:USDT|USDC|BUSD)$/,''),entry:number(okx?d.avgPx:d.entryPrice,true),mark:number(okx?d.markPx:d.markPrice,true),pnl:number(okx?d.upl:d.unRealizedProfit,true),unit:okx?text(d.ccy||'USDT'):text(d.marginAsset||d.symbol.match(/(?:USDT|USDC|BUSD)$/)?.[0]||'USDT')})).filter(d=>d.size!==0);
 }else if(operation==='fills'){
  rows=array(raw).slice(0,100).map(d=>{if(okx?d.instId!==market:d.symbol&&d.symbol!==market)invalid();return {id:String(okx?d.tradeId:d.id).slice(0,100),market,side:okx?text(d.side):d.isBuyer?'buy':'sell',price:number(okx?d.fillPx:d.price),quantity:number(okx?d.fillSz:d.qty),fee:number(okx?d.fee:d.commission,true),feeAsset:text(okx?d.feeCcy:d.commissionAsset),time:stamp(okx?d.ts:d.time,now)};});
 }else invalid();
 return {rows,asOf,unit,market};
}
export function exchangeAnalysis(rows){
 if(!Array.isArray(rows)||rows.length<21)throw Error('INSUFFICIENT_CANDLES');
 const last=rows.at(-1),mean=n=>rows.slice(-n).reduce((s,r)=>s+r.close,0)/n;
 const ranges=rows.slice(1).map((r,i)=>Math.max(r.high-r.low,Math.abs(r.high-rows[i].close),Math.abs(r.low-rows[i].close)));
 return {count:rows.length,last:last.close,ma5:mean(5),ma20:mean(20),atr14:ranges.slice(-14).reduce((a,b)=>a+b,0)/14,rangeHigh:Math.max(...rows.slice(-20).map(r=>r.high)),rangeLow:Math.min(...rows.slice(-20).map(r=>r.low)),start:rows[0].time,end:last.time};
}
