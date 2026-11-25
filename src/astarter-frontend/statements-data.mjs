import {sumAmounts,decimal} from './execution-records.mjs';
import {ORDER_MARKETS} from './order-markets.mjs';
import {spotTradeLedger} from './connection-options.mjs';

export const STATEMENT_OWNERS=['AI_SPECTRUM','STRATEGY_AGENT'];
export const STATEMENT_TABS=['fills','orders','openOrders','positions','funding'];
export const statementOpenOrder=row=>['submitted','open','partial','confirming','unknown'].includes(row.status);
const owner=value=>STATEMENT_OWNERS.includes(value)?value:null;
const key=(account,id)=>JSON.stringify([account,id]);
const amount=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?decimal(Number(value)):null;
const total=rows=>sumAmounts(rows.filter(value=>value!==null));
const latest=(rows,id)=>[...rows.reduce((map,row)=>{const k=id(row),old=map.get(k);if(!old||Number(row.revision||0)>Number(old.revision||0))map.set(k,row);return map;},new Map()).values()];
const wallClock=value=>Number.isFinite(value)&&value>=1e12&&Number.isFinite(new Date(value).getTime());
export const statementTimestamp=row=>wallClock(row?.recordedAt)?row.recordedAt:wallClock(row?.timestamp)?row.timestamp:null;
export function statementDay(timestamp,timeZone='UTC'){
 if(!wallClock(timestamp))return null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp);
 return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
}
export function statementMonth(month,offset=0){const [year,m]=month.split('-').map(Number);return new Date(Date.UTC(year,m-1+offset,1)).toISOString().slice(0,7);}
const validDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function statementZoneLabel(timeZone,at=Date.now()){
 const part=new Intl.DateTimeFormat('en',{timeZone,timeZoneName:'longOffset'}).formatToParts(at).find(p=>p.type==='timeZoneName')?.value||'GMT';
 return part.replace('GMT','UTC').replace(/([+-])0(\d)/,'$1$2').replace(/:00$/,'')+(part==='GMT'?'+0':'');
}
const agreement=values=>{const known=values.filter(v=>v!==undefined&&v!==null&&v!=='');return new Set(known).size===1?known[0]:null;};
function marketMeta(...sources){
 const expanded=sources.filter(Boolean).flatMap(row=>[row,row.executionRoute,ORDER_MARKETS[row.profileId],ORDER_MARKETS[row.executionRoute?.profileId]]).filter(Boolean);
 const venueId=agreement(expanded.map(r=>r.venueId));
 return {venueType:agreement(expanded.map(r=>r.venueType||({binance:'CEX',uniswap:'DEX',hyperliquid:'DEX'})[r.venueId])),marketType:agreement(expanded.map(r=>r.marketType==='PERP'?'PERPETUAL':r.marketType)),venueId,venue:agreement(expanded.map(r=>r.venue))||venueId,
  priceCurrency:agreement(expanded.map(r=>r.priceCurrency||r.quoteCurrency)),quantityAsset:agreement(expanded.map(r=>r.quantityAsset||r.quantityUnit)),notionalCurrency:agreement(expanded.map(r=>r.notionalCurrency)),chain:agreement(expanded.map(r=>r.chain||r.network)),intent:agreement(expanded.map(r=>r.intent)),direction:agreement(expanded.map(r=>r.direction)),leverage:agreement(expanded.map(r=>r.leverage)),marginMode:agreement(expanded.map(r=>r.marginMode))};
}
export function statementScope(search='',defaults={}){
 const p=new URLSearchParams(search),pick=(name,fallback='')=>p.get('st_'+name)??fallback;
 let zone=pick('zone',defaults.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();}catch{zone='UTC';}
 const from=pick('from',defaults.from||''),to=pick('to',defaults.to||''),day=pick('day',defaults.day||'');
 return {owner:owner(pick('owner',defaults.owner))||'AI_SPECTRUM',accountId:defaults.accountId||'',environment:defaults.environment||'',currency:pick('currency',defaults.currency??'USDT').slice(0,12),timeZone:zone,from:validDay(from)?from:'',to:validDay(to)?validDay(from)&&from>to?from:to:'',day:validDay(day)?day:'',runId:pick('run',defaults.runId||'').slice(0,128),symbol:pick('symbol',defaults.symbol||'').slice(0,40),venueType:['CEX','DEX'].includes(pick('venue',defaults.venueType))?pick('venue',defaults.venueType):'',marketType:['SPOT','PERPETUAL'].includes(pick('market',defaults.marketType))?pick('market',defaults.marketType):'',tab:STATEMENT_TABS.includes(pick('tab',defaults.tab))?pick('tab',defaults.tab):'fills',exceptions:pick('exceptions',defaults.exceptions?'1':'')==='1',query:pick('query',defaults.query||'').slice(0,128)};
}
export function statementSearch(scope,base='?page=logs'){
 const p=new URLSearchParams(base);p.set('page','logs');
 for(const [field,name] of [['owner','owner'],['currency','currency'],['timeZone','zone'],['from','from'],['to','to'],['day','day'],['runId','run'],['symbol','symbol'],['tab','tab'],['query','query'],['venueType','venue'],['marketType','market']]){if(scope[field])p.set('st_'+name,scope[field]);else p.delete('st_'+name);}
 if(scope.currency==='')p.set('st_currency','');
 if(scope.exceptions)p.set('st_exceptions','1');else p.delete('st_exceptions');
 return '?'+p;
}

const spotDecimal=value=>/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(String(value??''))?Number(value):null;
function binanceSpotStatementOrders(book,accountId,environment){
 if(environment!=='LIVE'||book?.symbol!=='BTCUSDT'||!Array.isArray(book.orders)||!Array.isArray(book.history))return [];
 const statusOf={NEW:'open',PARTIALLY_FILLED:'partial',FILLED:'filled',CANCELED:'cancelled',PENDING_CANCEL:'confirming',REJECTED:'rejected',EXPIRED:'cancelled',EXPIRED_IN_MATCH:'cancelled'};
 const rows=new Map();
 for(const raw of [...book.history,...book.orders]){
  const id=String(raw?.orderId??''),status=statusOf[raw?.status],qty=spotDecimal(raw?.origQty),executed=spotDecimal(raw?.executedQty),side=raw?.side==='BUY'?'buy':raw?.side==='SELL'?'sell':'';
  const time=Number(raw?.time);
  if(!/^[1-9]\d{5,19}$/.test(id)||!status||!side||qty===null||executed===null||executed>qty||!Number.isSafeInteger(time)||time<1e12)continue;
  if(rows.has(id)&&!(statementOpenOrder(rows.get(id))&&!statementOpenOrder({status})))continue;
  const price=spotDecimal(raw?.price),market=raw?.type==='MARKET'||price===0||price===null,orderType=market?'MARKET':'LIMIT';
  const strategy=typeof raw?.strategy==='string'&&/^[A-Z][A-Z0-9-]{1,15}$/.test(raw.strategy)?raw.strategy:'';
  const order={id,accountId,environment,kind:'order',key:'binance:'+id,owner:'STRATEGY_AGENT',status,side,market:'BTC/USDT',displayMarket:'BTC/USDT',currency:'USDT',venueType:'CEX',marketType:'SPOT',venueId:'binance',venue:'Binance',priceCurrency:'USDT',quantityAsset:'BTC',notionalCurrency:'USDT',qty,price:market?null:price,orderType,timestamp:time,recordedAt:time,agentName:strategy,strategy,runId:'',fills:[],events:[]};
  if(executed>0){
   const quote=spotDecimal(raw?.cummulativeQuoteQty??raw?.cumulativeQuoteQty);
   const fillPrice=quote>0?quote/executed:market?null:price;
   const notional=fillPrice===null?null:decimal(fillPrice*executed);
   order.fills.push({id:'F-'+id,accountId,environment,kind:'fill',key:'binance:fill:'+id,order,owner:'STRATEGY_AGENT',side,market:'BTC/USDT',currency:'USDT',venueType:'CEX',marketType:'SPOT',venueId:'binance',priceCurrency:'USDT',quantityAsset:'BTC',notionalCurrency:'USDT',quantity:decimal(executed),price:fillPrice===null?null:decimal(fillPrice),notional,realizedGross:null,closing:side==='sell',pendingFee:false,feeState:'CONFIRMED',timestamp:time,recordedAt:time,runId:'',events:[]});
  }
  rows.set(id,order);
 }
 const feeFor=new Map();
 for(const trade of Array.isArray(book.trades)?book.trades:[]){
  const orderId=String(trade?.orderId||''),commission=Number(trade?.commission);
  if(!rows.has(orderId)||!(commission>=0))continue;
  const price=Number(trade.price),bnb=Number(book.bnbPrice);
  const usdt=trade.commissionAsset==='USDT'?commission:trade.commissionAsset==='BTC'&&price>0?commission*price:trade.commissionAsset==='BNB'&&bnb>0?commission*bnb:null;
  if(usdt===null){feeFor.set(orderId,null);continue;}
  if(feeFor.get(orderId)!==null)feeFor.set(orderId,(feeFor.get(orderId)||0)+usdt);
 }
 let held=0,cost=0;
 const ledger=spotTradeLedger(book);
 for(const order of [...rows.values()].sort((a,b)=>a.timestamp-b.timestamp)){
  const fill=order.fills[0];if(!fill||fill.notional===null)continue;
  const fee=feeFor.has(order.id)?feeFor.get(order.id):0;
  if(fee>0){
   const event={kind:'event',key:fill.key+':fee',type:'FEE',amount:decimal(-fee),currency:'USDT',timestamp:fill.timestamp,owner:fill.owner,runId:'',market:fill.market,order,fill,excludeFromNet:Boolean(ledger)};
   fill.events.push(event);order.events.push(event);
  }else if(fee===null)fill.pendingFee=true;
  const qty=Number(fill.quantity);
  if(fill.side==='buy'){held+=qty;cost+=Number(fill.notional);}
  else{
   const net=ledger?.closes.get(order.id);
   const sold=Math.min(qty,held),average=held>0?cost/held:0;
   fill.realizedGross=net!==undefined?decimal(net):held>0?decimal(Number(fill.notional)-average*sold):null;
   if(fill.realizedGross!==null){
    const event={kind:'event',key:fill.key+':pnl',type:'REALIZED_PNL',amount:fill.realizedGross,currency:'USDT',timestamp:fill.timestamp,owner:fill.owner,runId:'',market:fill.market,order,fill};
    fill.events.push(event);order.events.push(event);
   }
   cost=Math.max(0,cost-average*sold);held=Math.max(0,held-sold);
  }
 }
 return [...rows.values()];
}
// A projection of receipts only: the business surface opening it cannot change ownership.
export function statementRecords(data,accessScope={}){
 const orders=[],fills=[],events=[],runs=[],positions=[];
 const accountId=accessScope.accountId||data?.accountSummary?.accountId||'',environment=accessScope.environment||data?.accountSummary?.environment||'';
 if(!data||!accountId||!environment)return {orders,fills,events,runs,positions,accountId,environment};
 const sources=[{name:'spectrum',flow:data.flow,orders:data.orders||[],runs:data.session?[data.session]:[]},{name:'agents',flow:data.botBook?.flow,orders:(data.botBook?.runs||[]).flatMap(run=>run.orders||[]),runs:data.botBook?.runs||[]}];
 for(const source of sources){
  const flow=source.flow||{},plans=new Map((flow.plans||[]).map(plan=>[key(plan.accountId,plan.id),plan]));
  const runMap=new Map(source.runs.map(run=>[run.id,run]));
  const ownOrders=new Map();
  for(const raw of latest(source.orders,row=>key(row.accountId,row.id))){
   const plan=plans.get(key(raw.accountId,raw.planId)),run=runMap.get(raw.runId),route=run?.plan?.executionRoute;
   if(raw.accountId!==accountId||(raw.environment||plan?.environment||run?.environment)!==environment)continue;
   const declared=[owner(raw.tradeOwner),owner(plan?.tradeOwner),owner(run?.tradeOwner)].filter(Boolean);
   const nativeAgent=source.name==='agents'&&run&&route?.accountId===accountId;
   const tradeOwner=new Set(declared).size>1?null:declared[0]||(nativeAgent?'STRATEGY_AGENT':null);
   const row={...raw,...marketMeta(raw,plan,run?.plan),kind:'order',key:source.name+':'+raw.id,owner:tradeOwner,environment,runId:raw.runId||plan?.instanceId||'',plan,run,market:raw.displayMarket||raw.market||plan?.market||'',currency:raw.currency||plan?.currency||'USDT',timestamp:statementTimestamp(raw),agentName:run?.plan?.name||run?.plan?.title||run?.plan?.strategy||raw.strategy||'',fills:[],events:[]};
   if(row.marketType==='SPOT'){row.priceCurrency||=row.currency;row.quantityAsset||=row.market.split('/')[0];row.notionalCurrency||=row.currency;}
   ownOrders.set(key(accountId,raw.id),row);orders.push(row);
  }
  for(const raw of latest(flow.fills||[],row=>key(row.accountId,row.venueFillId||row.id))){
   const order=ownOrders.get(key(raw.accountId,raw.orderId));if(!order||raw.environment&&raw.environment!==environment)continue;
   const ownerConflict=Boolean(owner(raw.tradeOwner)&&order.owner&&owner(raw.tradeOwner)!==order.owner);
   const row={...raw,...marketMeta(raw,order),side:raw.side||order.side,ownerConflict,kind:'fill',key:source.name+':'+raw.id,order,owner:ownerConflict?null:order.owner,runId:order.runId,market:order.market,currency:raw.currency||order.currency,timestamp:statementTimestamp(raw),quantity:amount(raw.quantity),price:amount(raw.price),notional:amount(raw.notional),realizedGross:amount(raw.realizedPnlGross),realizedNet:amount(raw.realizedPnlNet),events:[]};
   fills.push(row);order.fills.push(row);
  }
  const fillMap=new Map(fills.filter(row=>row.key.startsWith(source.name+':')).map(row=>[key(row.accountId,row.id),row]));
  for(const raw of latest(flow.ledger||[],row=>key(row.accountId,row.economicEventId||row.id))){
   if(!['REALIZED_PNL','FEE','GAS','FUNDING'].includes(raw.type))continue;
   const fill=fillMap.get(key(raw.accountId,raw.fillId)),order=ownOrders.get(key(raw.accountId,raw.orderId))||fill?.order;
   if(amount(raw.amount)===null||raw.accountId!==accountId||raw.environment&&raw.environment!==environment)continue;
   // Funding can settle against a position without an order; it still needs explicit account ownership.
   if(!order&&(raw.type!=='FUNDING'||raw.environment!==environment))continue;
   const declared=[owner(raw.tradeOwner),order?.owner].filter(Boolean);
   const row={...raw,...marketMeta(raw,order),kind:'event',key:source.name+':'+raw.id,order,fill,owner:fill?.ownerConflict||new Set(declared).size>1?null:declared[0]||null,runId:order?.runId||raw.runId||'',market:order?.market||raw.market||'',currency:raw.currency||order?.currency,amount:amount(raw.amount),timestamp:statementTimestamp(raw)};
   events.push(row);order?.events.push(row);fill?.events.push(row);
  }
  for(const fill of fillMap.values()){
   const pnl=fill.events.filter(e=>e.type==='REALIZED_PNL');
   if(pnl.length)fill.realizedGross=total(pnl.map(e=>e.amount));
   else if(fill.realizedGross!==null){
    const row={...marketMeta(fill),kind:'event',key:fill.key+':pnl',type:'REALIZED_PNL',amount:fill.realizedGross,currency:fill.currency,timestamp:fill.timestamp,owner:fill.owner,runId:fill.runId,market:fill.market,order:fill.order,fill};
    events.push(row);fill.events.push(row);fill.order.events.push(row);
   }
   fill.closing=fill.intent==='close'||fill.marketType==='SPOT'&&fill.side==='sell';
   fill.pendingFee=fill.feeState!=='CONFIRMED';
  }
  for(const run of source.runs){const route=run.plan?.executionRoute;if((run.accountId||route?.accountId||data.accountSummary?.accountId)!==accountId||(run.environment||environment)!==environment)continue;runs.push({id:run.id,name:run.plan?.name||run.plan?.strategy||run.strategy||run.id,market:run.plan?.market||run.market||'',owner:owner(run.tradeOwner)||(source.name==='agents'?'STRATEGY_AGENT':null)});}
 }
 // Current positions come from the current account snapshot, never reconstructed from past fills.
 const current=[...(Array.isArray(data.positions)?data.positions:data.position?[data.position]:[]),...(data.botBook?.runs||[]).filter(run=>Number(run.quantity)>0).map(run=>({...run,accountId:run.plan?.executionRoute?.accountId,runId:run.id,market:run.plan?.market,qty:run.quantity,entryPrice:amount(run.costBasis)!==null?Number(run.costBasis)/run.quantity:null,unrealizedPnl:run.unrealizedPnl,notional:run.inventoryValue,plan:run.plan,tradeOwner:run.tradeOwner}))];
 for(const raw of latest(current.filter(r=>r.positionId||r.id),r=>key(r.accountId,r.positionId||r.id))){
  const linked=orders.find(o=>o.accountId===raw.accountId&&o.id===raw.id),plan=raw.plan||linked?.run?.plan||linked?.plan;
  if(raw.accountId!==accountId||(raw.environment||linked?.environment)!==environment||!(Number(raw.qty??raw.quantity)>0))continue;
  const declared=[owner(raw.tradeOwner),linked?.owner].filter(Boolean),qty=amount(raw.qty??raw.quantity),entry=amount(raw.entryPrice??raw.price),mark=amount(raw.markPrice);
  const meta=marketMeta(raw,plan),pnl=amount(raw.unrealizedPnl),notional=amount(raw.notional);
  positions.push({...raw,...meta,kind:'position',key:'position:'+key(accountId,raw.positionId||raw.id),owner:new Set(declared).size>1?null:declared[0]||null,market:raw.displayMarket||raw.market||'',currency:raw.currency||plan?.currency||ORDER_MARKETS[plan?.executionRoute?.profileId]?.currency||'',runId:raw.runId||'',quantityAsset:raw.quantityAsset||raw.quantityUnit||(meta.marketType==='SPOT'?(raw.displayMarket||raw.market||'').split('/')[0]:''),notionalCurrency:raw.notionalCurrency||(meta.marketType==='SPOT'?raw.currency||plan?.currency||'':''),quantity:qty,entryPrice:entry,markPrice:mark,
   notional:notional??(meta.marketType==='SPOT'&&mark!==null?decimal(Number(qty)*Number(mark)):null),unrealizedPnl:pnl??(entry!==null&&mark!==null&&meta.marketType==='SPOT'?decimal((Number(mark)-Number(entry))*Number(qty)):null),timestamp:statementTimestamp(raw),environment});
 }
 if(environment==='LIVE'){
  const seen=new Set(orders.map(row=>String(row.id)));
  for(const order of binanceSpotStatementOrders(data.connections?.spotBook,accountId,environment)){
   if(seen.has(order.id))continue;
   seen.add(order.id);orders.push(order);fills.push(...order.fills);events.push(...order.events);
  }
 }
 for(const order of orders){
  const sum=field=>order.fills.length?order.fills.every(fill=>fill[field]!==null)?total(order.fills.map(fill=>fill[field])):null:Number(order.filled)===0?'0':null;
  order.filledQuantity=sum('quantity');order.filledNotional=sum('notional');
  order.averageFillPrice=Number(order.filledQuantity)>0&&order.filledNotional!==null?Number(order.filledNotional)/Number(order.filledQuantity):null;
  const closing=order.fills.filter(fill=>fill.closing);order.realizedGross=closing.length&&closing.every(fill=>fill.realizedGross!==null)?total(closing.map(fill=>fill.realizedGross)):null;
 }
 const sort=(a,b)=>(b.timestamp??-1)-(a.timestamp??-1)||a.key.localeCompare(b.key);
 return {orders:orders.sort(sort),fills:fills.sort(sort),events:events.sort(sort),positions:positions.sort(sort),positionsAvailable:Array.isArray(data.positions)||Object.hasOwn(data,'position')||Array.isArray(data.botBook?.runs),runs,accountId,environment};
}

export function projectStatements(records,scope){
 const allCurrencies=scope.currency==='';
 const day=row=>statementDay(row.timestamp,scope.timeZone);
 const matchesFilters=row=>(!scope.venueType||row.venueType===scope.venueType)&&(!scope.marketType||row.marketType===scope.marketType)&&(!scope.runId||row.runId===scope.runId)&&(!scope.symbol||row.market===scope.symbol)&&(!scope.query||[row.id,row.order?.id,row.runId,row.market].some(v=>String(v||'').toLowerCase().includes(scope.query.toLowerCase())));
 const matches=row=>(scope.exceptions?!row.owner:row.owner===scope.owner)&&matchesFilters(row);
 const same=row=>matches(row)&&(allCurrencies||row.currency===scope.currency);
 const inRange=row=>{const d=day(row);return !scope.from&&!scope.to||d&&(!scope.from||d>=scope.from)&&(!scope.to||d<=scope.to);};
 const allFills=records.fills.filter(same),allEvents=records.events.filter(same),allOrders=records.orders.filter(same);
 const fills=allFills.filter(inRange),events=allEvents.filter(inRange),orders=allOrders.filter(row=>inRange(row)||row.fills.some(inRange)||row.events.some(inRange));
 const foreignEvents=records.events.filter(row=>matches(row)&&row.currency!==scope.currency&&row.order?.currency===scope.currency&&inRange(row));
 // Unclassified receipts can make coverage incomplete without changing any attributed amount.
 const unknownActivity=[...records.fills,...records.events].filter(row=>!row.owner&&matchesFilters(row)&&(allCurrencies||row.currency===scope.currency||row.order?.currency===scope.currency)&&(row.timestamp===null||inRange(row)));
 const settled=row=>row.excludeFromNet!==true;
 const daily=new Map(),getDay=d=>{if(!daily.has(d))daily.set(d,{day:d,amounts:[],fills:0,pending:0,missingPnl:0,foreignCosts:0});return daily.get(d);};
 for(const row of fills){const d=day(row);if(d){const bucket=getDay(d);bucket.fills++;if(row.pendingFee)bucket.pending++;if(row.closing&&row.realizedGross===null)bucket.missingPnl++;}}
 for(const row of events){const d=day(row);if(d&&settled(row))getDay(d).amounts.push(row.amount);}
 for(const row of foreignEvents){const d=day(row);if(d)getDay(d).foreignCosts++;}
 if(!scope.exceptions)for(const row of unknownActivity){const d=day(row);if(d)getDay(d).classificationPending=true;}
 const days=[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(row=>({...row,net:allCurrencies?null:total(row.amounts)}));
 const filtered=row=>!scope.day||day(row)===scope.day;
 const shownFills=fills.filter(filtered),shownEvents=events.filter(filtered),shownOrders=orders.filter(row=>filtered(row)||row.fills.some(filtered)||row.events.some(filtered));
 const missingPnl=shownFills.filter(row=>row.closing&&row.realizedGross===null).length,pending=shownFills.filter(row=>row.pendingFee).length;
 const points=[];let cumulative='0';
 if(!allCurrencies)for(const e of shownEvents.filter(row=>row.timestamp!==null&&settled(row)).sort((a,b)=>a.timestamp-b.timestamp)){cumulative=total([cumulative,e.amount]);const prior=points.at(-1);if(prior?.at===e.timestamp)prior.value=Number(cumulative);else points.push({at:e.timestamp,value:Number(cumulative)});}
 const unknownCount=records.orders.filter(row=>!row.owner).length;
 const unknownShown=unknownActivity.filter(row=>row.timestamp===null||filtered(row));
 const scopedUnknownCount=new Set(unknownShown.map(row=>row.order?.key||row.key)).size;
 const unclassifiedUndated=new Set(unknownShown.filter(row=>row.timestamp===null).map(row=>row.order?.key||row.key)).size;
 const classificationPending=!scope.exceptions&&scopedUnknownCount>0;
 const undatedEvents=shownEvents.filter(row=>row.timestamp===null).length;
 const foreignCosts=foreignEvents.filter(filtered).length;
 const undated=allFills.filter(row=>row.timestamp===null).length;
 const currencyModels=allCurrencies?[...new Set([...allOrders,...allFills,...allEvents,...(records.positions||[]).filter(matches)].map(row=>row.currency).filter(Boolean))].map(currency=>({currency,model:projectStatements(records,{...scope,currency})})):[];
 const single=currencyModels.length===1?currencyModels[0].model:null;
 const settledEvents=shownEvents.filter(settled);
 return {positions:(records.positions||[]).filter(same),positionsAvailable:records.positionsAvailable,openOrders:allOrders.filter(statementOpenOrder),historyOrders:shownOrders.filter(row=>!statementOpenOrder(row)),funding:shownEvents,fills:shownFills,orders:shownOrders,events:shownEvents,days:allCurrencies?single?.days||[]:days,points:allCurrencies?single?.points||[]:points,net:allCurrencies?single?.net??(currencyModels.length?null:'0'):missingPnl||pending||foreignCosts?null:total(settledEvents.map(row=>row.amount)),confirmedNet:allCurrencies?single?.confirmedNet??(currencyModels.length?null:'0'):total(settledEvents.map(row=>row.amount)),fees:allCurrencies?single?.fees??(currencyModels.length?null:'0'):total(shownEvents.filter(row=>['FEE','GAS'].includes(row.type)).map(row=>decimal(-Number(row.amount)))),pending,missingPnl,undated,undatedEvents,foreignCosts:allCurrencies?currencyModels.reduce((n,row)=>n+row.model.foreignCosts,0):foreignCosts,unknownCount,classificationPending,scopedUnknownCount,unclassifiedUndated,allFills,allOrders,...(allCurrencies?{currencyModels}:{})};
}

export function statementCurveRange(model,scope){
 const days=model.days.filter(row=>!scope.day||row.day===scope.day);
 return {from:scope.day||scope.from||days[0]?.day||'',to:scope.day||scope.to||days.at(-1)?.day||'',days};
}
export function statementCurveDay(model,scope,day){
 const range=statementCurveRange(model,scope);if(!validDay(day)||day<range.from||day>range.to)return null;
 const bucket=range.days.find(row=>row.day===day),before=range.days.filter(row=>row.day<=day);
 const incomplete=row=>row.classificationPending||row.pending||row.missingPnl||row.foreignCosts;
 return {day,net:bucket&&incomplete(bucket)?null:bucket?.net||'0',cumulative:before.some(incomplete)?null:total(before.map(row=>row.net)),fills:bucket?.fills||0};
}
