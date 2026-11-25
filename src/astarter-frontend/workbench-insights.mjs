import {ASSETS,portfolio} from './product-data.mjs';
import {isPerp,positionPnl} from './order-markets.mjs';
import {candleRequest} from './trading-chart-data.mjs';

export const INSIGHT_DIMENSIONS=['trend','depth','macro','social','chain','risk'];
const evidenceStates=new Set(['pending','collected','context','retain','conflict','missing','na']);
const finite=value=>Number.isFinite(value)?value:null;
const positive=value=>Number.isFinite(value)&&value>=0?value:null;

// This read-only projection uses the same account book as the portfolio and header.
export function workbenchAccount(trade){
 const accountId=trade?.accountSummary?.accountId||trade?.accountId||'SIM-01',environment=trade?.accountSummary?.environment||trade?.environment||'DEMO';
 const identity={accountId,environment,unit:'USD eq.',scope:accountId+':'+environment};
 const unknown={...identity,known:false,cash:null,held:null,equity:null,reserved:null,available:null,fees:null,pnl:null,realized:null,unrealized:null,spotUnmarked:false};
 if(!trade||positive(trade.cash)===null||trade.cashKnown===false||trade.unreadableTrade||trade.botSummary?.recoveryError)return unknown;
 const bot=trade.botSummary||{},positions=(trade.positions||[trade.position]).filter(Boolean);
 if(['cash','equity','inventoryValue','fees','unrealizedPnl'].some(key=>bot[key]!==undefined&&!Number.isFinite(bot[key]))||positions.some(p=>positive(p.qty)===null||positive(p.price)===null||isPerp(p)&&(positive(p.margin)===null||p.markPrice!==undefined&&!Number.isFinite(p.markPrice))))return unknown;
 const p=portfolio(trade),reservations=(trade.flow?.reservations||[]).filter(row=>row.state==='HELD'&&['USD','USDT','USDC'].includes(row.unit));
 if(reservations.some(row=>positive(Number(row.amount))===null)||![p.cash,p.held,p.equity,p.freeCash,p.reservedCash].every(Number.isFinite))return unknown;
 const reserved=Math.max(p.reservedCash,reservations.reduce((sum,row)=>sum+Number(row.amount),0));
 const spotUnmarked=positions.some(p=>!isPerp(p)&&p.qty>0),pnl=accountId==='SIM-01'&&environment==='DEMO'?p.pnl:null;
 // Legacy spot is carried at entry price; its missing mark-to-market cannot become zero floating P&L.
 const splitKnown=pnl!==null&&!spotUnmarked&&(!(bot.inventoryValue>0)||Number.isFinite(bot.unrealizedPnl));
 const unrealized=splitKnown?positions.reduce((sum,p)=>sum+(isPerp(p)?Math.max(-p.margin,positionPnl(p)):0),0)+(bot.unrealizedPnl||0):null;
 return {...identity,known:true,cash:p.cash,held:p.held,equity:p.equity,reserved,available:p.freeCash,fees:positive(p.fees),pnl,realized:splitKnown?pnl-unrealized:null,unrealized,spotUnmarked};
}

// Account figures stay account-wide; a selected asset never inherits another run's protection.
export function workbenchInsights({task,focus={},trade=null,risk=null}={}){
 const asset=ASSETS.find(row=>row[0]===task?.symbol),domain=task?.domain||asset?.[2];
 const evidence=INSIGHT_DIMENSIONS.map(key=>{
  const item=task?.evidence?.find(item=>item.key===key);
  return {key,status:evidenceStates.has(item?.status)?item.status:key==='chain'&&domain==='TradFi'?'na':'pending',text:item?.text||'',source:item?.source||'',sourceId:item?.sourceId||null};
 });
 const run=focus.linked&&focus.task?.symbol===task?.symbol&&trade?.session?.market?.split('/')[0]===task?.symbol?trade.session:null;
 const account=workbenchAccount(trade),{known,cash,held,reserved,available}=account,orders=run?(trade.orders||[]).filter(order=>order.runId===run.id):[];
 const macroConfig=asset&&domain!=='Crypto'?candleRequest({market:task.symbol,period:'1D',profileId:'public-market',venueId:task.symbol==='XAU'?'dukascopy':'yahoo'}):null;
 const allocations=known?[available,held,reserved]:[],allocationMax=Math.max(0,...allocations);
 return {
  symbol:task?.symbol||null,domain:domain||null,phase:task?.phase||'queued',outcome:task?.phase==='complete'?task.outcome:null,
  title:task?.title||'',thesis:task?.thesis||'',next:task?.next||'',evidence,
  // This is a public-market view, not evidence of an exchange account or execution connection.
  marketConfig:asset?.[2]==='Crypto'?{market:`${task.symbol}/USDT`,period:'1H',profileId:'cex-spot',venueId:'binance',trade:null}:macroConfig?{...macroConfig,trade:null}:null,
  capital:{...account,allocationMax,allocation:allocations.map((value,i)=>({key:['available','held','reserved'][i],value,level:allocationMax?value/allocationMax:0})),
   accountCap:positive(risk?.cap),dailyLossLimit:positive(risk?.dailyLoss),
   locked:Boolean(trade?.capitalProtection?.locked),runId:run?.id||null,runState:run?trade.state||'unknown':null,runMarket:run?.market||null,amount:positive(run?.amount),cap:positive(run?.cap),
   stopLoss:finite(run?.ticket?.stopLoss),takeProfit:finite(run?.ticket?.takeProfit),
   filledOrders:orders.filter(order=>order.filled>0).length,unknownOrders:orders.filter(order=>order.status==='unknown').length}
 };
}

// Only observed changes become events. Research elapsed time is never mapped onto UTC candles.
export class WorkbenchInsightHistory{
 constructor(){this.assets=new Map();}
 record(task,at,paused=false){
  if(!task?.symbol||!Number.isFinite(at))return [];
  const current=workbenchInsights({task});
  const snapshot={version:task.version,phase:task.phase,outcome:current.outcome,title:current.title,evidence:current.evidence};
  let previous=this.assets.get(task.symbol);
  if(!previous||at<previous.at){previous={at,snapshot,events:[]};this.assets.set(task.symbol,previous);return [];}
  if(paused){previous.at=at;previous.snapshot=snapshot;return previous.events;}
  const old=previous.snapshot,changes=[];
  if(old.version!==snapshot.version)changes.push({type:'research',from:old.version,to:snapshot.version,text:task.reason||''});
  for(const item of snapshot.evidence){
   const before=old.evidence.find(row=>row.key===item.key);
   if(before.status!==item.status||before.text!==item.text||before.sourceId!==item.sourceId||before.source!==item.source)changes.push({type:'evidence',key:item.key,from:before.status,to:item.status,text:item.text,source:item.source});
  }
  if(old.phase!==snapshot.phase)changes.push({type:'phase',from:old.phase,to:snapshot.phase,text:snapshot.phase==='complete'?snapshot.title:''});
  else if(old.outcome!==snapshot.outcome||old.title!==snapshot.title)changes.push({type:'conclusion',from:old.outcome,to:snapshot.outcome,text:snapshot.title});
  previous.events=[...changes.map((change,i)=>({...change,id:`${task.symbol}:${task.version}:${at}:${i}`,symbol:task.symbol,at,version:task.version})).reverse(),...previous.events].slice(0,24);
  previous.at=at;previous.snapshot=snapshot;return previous.events;
 }
}
