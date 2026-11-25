import {TradingDemo,DEFAULT_CONNECTIONS,MARKETS} from './trading-demo.mjs';
import {workbenchAccount} from './workbench-insights.mjs';
import {statementRecords,projectStatements,statementScope} from './statements-data.mjs';
import {ORDER_MARKETS,isPerp,positionValue,positionPnl,orderAuthorizationKey} from './order-markets.mjs';

// Isolated UI examples reuse the order ledger; never hydrate the user's trading desk.
const SLOTS=[
 ['btc-trend','BTC/USDT','cex-spot','long',1,350,'running','BTC 趋势跟随','BTC trend'],
 ['eth-range','ETH/USDT','cex-spot','long',1,280,'paused','ETH 分批买入','ETH accumulation'],
 ['sol-short','SOL/USDT','cex-perp','short',3,200,'running','SOL 合约跟随','SOL perpetual'],
 ['eth-long','ETH/USDT','cex-perp','long',2,220,'running','ETH 动量跟随','ETH momentum'],
 ['eth-swap','ETH/USDT','dex-spot','long',1,260,'paused','链上换币','On-chain swap'],
 ['btc-perp','BTC/USDT','dex-perp','long',2,240,'running','BTC 链上合约','BTC on-chain perpetual'],
 ['sol-order','SOL/USDT','cex-spot','long',1,180,'partial','SOL 分批建仓','SOL staged entry'],
 ['btc-unknown','BTC/USDT','cex-perp','short',2,160,'unknown','BTC 区间跟随','BTC range'],
 ['btc-swap','BTC/USDT','dex-spot','long',1,140,'confirming','链上定额买入','On-chain accumulation'],
 ['eth-order','ETH/USDT','dex-perp','short',2,190,'submitted','ETH 对冲观察','ETH hedge']
];
const advance=(demo,seconds)=>{for(let t=0;t<seconds;t+=.1)demo.tick(.1,{ready:true,market:demo.session.market,revision:1});};
const fail=error=>{if(error)throw new Error(error);};

export const hasActiveTrade=trade=>Boolean(trade?.pending||trade?.position||trade?.discovery?.armed||trade?.session&&trade.state!=='stopped');

export class TradingPreview{
 constructor(now=Date.now()){this.reset(now);}
 reset(now=Date.now()){
  this.epoch=now-86400000;this.revision=0;
  this.slots=SLOTS.map(([id,market,profileId,direction,leverage,amount,state,zh,en],index)=>{
   const demo=new TradingDemo();demo.cash=1000;demo.seq=(index+1)*1000;demo.time=index*1800;
   const slot={id,market,profileId,direction,leverage,amount,state,name:{zh,en},demo};
   this.begin(slot);advance(demo,3.6);
   demo.position.markPrice=demo.position.price*(1+(index%2?-.009:.014));fail(demo.closePosition());advance(demo,3.6);
   if(index===0||index===1){
    demo.stop();this.begin(slot,index===0?'normal':'rejected');
    if(index===0){advance(demo,1.5);fail(demo.cancel());fail(demo.closePosition());advance(demo,3.6);}
   }
   demo.stop();demo.time=80000+index*20;
   this.begin(slot,state==='unknown'?'unknown':'normal');
   if(['running','paused'].includes(state)){
    advance(demo,3.6);demo.position.markPrice=demo.position.price*(1+[.018,-.011,-.024,.013,-.007,.016][index]);
    if(state==='paused')demo.pause();else demo.state='running';
   }else if(state==='partial'||state==='confirming')advance(demo,1.5);
   else if(state==='unknown')advance(demo,1.5);
   demo.nextSignal=Infinity;return slot;
  });
 }
 begin(slot,scenario='normal'){
  const {demo,market,profileId,direction,leverage,amount}=slot,price=MARKETS[market],short=direction==='short';
  const ticket={profileId,direction,leverage,market,amount,cap:1000,quotePrice:price,quotedAt:demo.time,maxGap:.5,revision:1,stopLoss:price*(short?1.04:.96),takeProfit:price*(short?.94:1.06),sourceId:'PREVIEW-'+slot.id+':'+demo.seq,slippage:.5,walletConnected:true,walletAuthorized:true,rpcReady:true,network:ORDER_MARKETS[profileId].chain};
  ticket.authorizationKey=orderAuthorizationKey(ticket);
  demo.orderScenario=scenario;
  fail(demo.quickOrder({market,strategy:'S03',mode:'auto',amount,cap:1000,protection:{id:'original'}},DEFAULT_CONNECTIONS,{ready:true,market,price,revision:1},ticket));
 }
 snapshot(){
  const positions=[],runs=[],orders=[],events=[],flow={plans:[],admissions:[],commands:[],operations:[],reservations:[],fills:[],protections:[],ledger:[],venueReceipts:[],sourceEvents:[],revision:this.revision};
  let cash=0,totalFees=0;
  for(const slot of this.slots){
   const d=slot.demo,profile=ORDER_MARKETS[slot.profileId],meta={previewId:slot.id,strategyLabel:slot.name,accountId:'DEMO-PREVIEW'};
   cash+=d.cash;totalFees+=d.totalFees;
   const protection=d.flow.protections.find(p=>p.instanceId===d.session.id);
   if(d.position)positions.push({...structuredClone(d.position),...meta,protection:structuredClone(protection)});
   runs.push({...meta,profileId:slot.profileId,market:d.session.market,displayMarket:d.orders.find(o=>o.runId===d.session.id)?.displayMarket||d.session.market,state:d.state,hasPosition:Boolean(d.position),pendingId:d.pending?.id,amount:slot.amount,cap:1000,...profile});
   orders.push(...d.orders.map(o=>({...structuredClone(o),...meta,recordedAt:this.epoch+o.at*1000})));
   events.push(...d.events.map(e=>({...structuredClone(e),...meta,recordedAt:this.epoch+e.at*1000})));
   for(const key of Object.keys(flow))if(Array.isArray(flow[key]))flow[key].push(...structuredClone(d.flow[key]||[]));
  }
  for(const rows of Object.values(flow))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'){if('accountId'in row)row.accountId='DEMO-PREVIEW';if(Number.isFinite(row.at))row.recordedAt=this.epoch+row.at*1000;}
  orders.sort((a,b)=>b.at-a.at);events.sort((a,b)=>b.at-a.at);
  const reserved=flow.reservations.filter(r=>r.state==='HELD'&&['USD','USDC','USDT'].includes(r.unit)).reduce((s,r)=>s+Number(r.amount),0);
  return {preview:true,accountId:'DEMO-PREVIEW',mode:'simulation-only',positions,runs,orders,events,flow,cash,totalFees,initialBalance:10000,available:cash-reserved,reserved,equity:cash+positions.reduce((s,p)=>s+positionValue(p),0),pnl:positions.reduce((s,p)=>s+(isPerp(p)?positionPnl(p):((p.markPrice??p.price)-p.price)*p.qty),0),revision:this.revision};
 }
 action(id,action){
  const slot=this.slots.find(s=>s.id===id);if(!slot)return '记录不存在。';const d=slot.demo;
  d.time=Math.max(d.time,86400,(Date.now()-this.epoch)/1000);
  let issue;
  if(action==='pause')issue=d.pause();
  else if(action==='resume')issue=d.resume({ready:true,market:slot.market,revision:1});
  else if(action==='stop')issue=d.stop();
  else if(action==='close'){issue=d.closePosition();if(!issue)advance(d,3.6);}
  else if(action==='cancel'){if(!d.pending)return '订单已经处理完成。';issue=d.cancel();}
  else if(action==='complete'){
   if(!d.pending)return '订单已经处理完成。';
   if(d.pending.status==='unknown')issue=d.deliverReceipt()||d.reconcile();
   if(!issue)advance(d,3.6);
  }else return '不支持此操作。';
  if(issue)return issue;
  d.nextSignal=Infinity;this.revision++;return null;
 }
}

const previewAccount = {accountId:'REVIEW-01',environment:'DEMO',unit:'USDT'};
const round = value => Number(value.toFixed(8));
const samples = [
 ['2026-11-01','ETH/USDT',.48,2088,2136.25],
 ['2026-11-02','BTC/USDT',.015,71920,72240],
 ['2026-11-03','SOL/USDT',8,150.1,148.32],
 ['2026-11-04','ETH/USDT',.6,2136.25,2168.4],
 ['2026-11-05','BTC/USDT',.018,72940,73460],
 ['2026-11-06','SOL/USDT',9,149.2,153.8],
 ['2026-11-07','ETH/USDT',.72,2176.8,2182.5],
 ['2026-11-08','BTC/USDT',.024,73460,72880],
 ['2026-11-09','ETH/USDT',.36,2182.5,2214.6]
];

function statementExampleSeed(){
 const data={orders:[],flow:{plans:[],fills:[],ledger:[]},botBook:{runs:[],flow:{fills:[],ledger:[]}},accountSummary:{...previewAccount}};
 for(const owner of ['STRATEGY_AGENT','AI_SPECTRUM']){
  const orders=owner==='STRATEGY_AGENT'?null:data.orders,flow=owner==='STRATEGY_AGENT'?data.botBook.flow:data.flow;
  const runMap=new Map();
  for(const [index,[day,market,baseQty,buy,sell]] of samples.entries()){
   const asset=market.split('/')[0],strategy=asset==='SOL'?'S02':'S01',runId=`PREVIEW-${owner}-${asset}`,qty=round(baseQty*(owner==='STRATEGY_AGENT'?1:.65));
   if(!runMap.has(runId)){
    const run={id:runId,tradeOwner:owner,environment:'DEMO',status:'stopped',quantity:0,realizedPnl:0,fees:0,initialAllocation:3000,orders:[],plan:{strategy,name:`${asset} ${strategy==='S02'?'分批买入':'区间网格'}`,version:'1.0',market,executionRoute:{accountId:previewAccount.accountId,environment:'DEMO',profileId:'cex-spot',venueId:'binance'},botParameters:strategy==='S02'?{takeProfitPct:2,stopLossPct:3,deviationPct:1.5}:{lower:round(buy*.97),upper:round(sell*1.03),count:10}},researchSnapshot:{summary:strategy==='S02'?'分批建立仓位，按已设退出条件完成卖出。':'在设定价格区间内，按网格触发价分批完成买卖。'}};
    runMap.set(runId,run);if(owner==='STRATEGY_AGENT')data.botBook.runs.push(run);else data.flow.plans.push({...run.plan,id:'P-'+runId,accountId:previewAccount.accountId,environment:'DEMO',tradeOwner:owner,researchSnapshot:run.researchSnapshot});
   }
   const run=runMap.get(runId);
   for(const side of ['buy','sell']){
    const id=`PREVIEW-${owner}-${index}-${side}`,price=side==='buy'?buy:sell,notional=round(qty*price),fee=round(notional*.001),recordedAt=Date.parse(`${day}T${side==='buy'?'09:18':'14:36'}:00+08:00`),partial=index===8&&side==='buy';
    const order={id,runId,planId:'P-'+runId,accountId:previewAccount.accountId,environment:'DEMO',tradeOwner:owner,strategy,market,currency:'USDT',marketType:'SPOT',side,price,qty:partial?round(qty/.6):qty,filled:partial?.6:1,status:partial?'partial-cancelled':'filled',recordedAt};
    const fill={id:'F-'+id,venueFillId:'R-'+id,orderId:id,accountId:previewAccount.accountId,side,marketType:'SPOT',quantity:String(qty),price:String(price),notional:String(notional),currency:'USDT',feeState:'CONFIRMED',recordedAt};
    if(side==='sell')fill.realizedPnlGross=String(round((sell-buy)*qty));
    (orders||run.orders).push(order);flow.fills.push(fill);flow.ledger.push({id:'L-'+id,economicEventId:'E-'+id,accountId:previewAccount.accountId,orderId:id,fillId:fill.id,type:'FEE',amount:String(-fee),currency:'USDT',recordedAt,revision:1});
    run.fees=round(run.fees+fee);run.realizedPnl=round(run.realizedPnl+(side==='sell'?Number(fill.realizedPnlGross):0)-fee);
   }
  }
 }
 return data;
}

// Read-only product review data. This module never accesses account storage or execution APIs.
export const STATEMENT_EXAMPLE=Object.freeze({id:'spectrum-20261109',asOf:Date.parse('2026-11-09T20:00:00+08:00'),timeZone:'Asia/Shanghai'});
const amount=value=>Number(Number(value).toFixed(8));
export function statementExampleSnapshot(){
 const data={orders:[],flow:{plans:[],fills:[],ledger:[],reservations:[]},botBook:{runs:[],flow:{fills:[],ledger:[]}},accountSummary:{...previewAccount},positions:[],cash:10000,totalFees:0};
 for(const [index,{days,scale}]of [{days:-18,scale:.8},{days:-9,scale:1.25},{days:0,scale:1}].entries()){
  const batch=JSON.parse(JSON.stringify(statementExampleSeed()).replaceAll('PREVIEW-',`PNL-B${index}-`));
  const move=value=>{if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){if(key==='accountId')value[key]=previewAccount.accountId;else if(key==='recordedAt')value[key]=item+days*86400000;else move(item);}};move(batch);
  for(const order of [...batch.orders,...batch.botBook.runs.flatMap(run=>run.orders)])order.qty=amount(order.qty*scale);
  for(const flow of [batch.flow,batch.botBook.flow]){
   for(const fill of flow.fills){fill.quantity=String(amount(Number(fill.quantity)*scale));fill.notional=String(amount(Number(fill.price)*Number(fill.quantity)));if(fill.realizedPnlGross!==undefined)fill.realizedPnlGross=String(amount(Number(fill.realizedPnlGross)*scale));}
   for(const fee of flow.ledger)fee.amount=String(amount(Number(fee.amount)*scale));
  }
  for(const run of batch.botBook.runs){run.fees=amount(run.fees*scale);run.realizedPnl=amount(run.realizedPnl*scale);}
  data.orders.push(...batch.orders);data.flow.plans.push(...batch.flow.plans);data.flow.fills.push(...batch.flow.fills);data.flow.ledger.push(...batch.flow.ledger);
  data.botBook.runs.push(...batch.botBook.runs);data.botBook.flow.fills.push(...batch.botBook.flow.fills);data.botBook.flow.ledger.push(...batch.botBook.flow.ledger);
 }
 const scope=statementScope('',{...previewAccount,owner:'all',timeZone:'Asia/Shanghai'}),records=statementRecords(data,scope);
 const spectrum=projectStatements(records,{...scope,owner:'AI_SPECTRUM'}),agents=projectStatements(records,{...scope,owner:'STRATEGY_AGENT'});
 data.cash=amount(10000+Number(spectrum.net)+Number(agents.net));data.totalFees=Number(spectrum.fees);
 data.botSummary={cash:0,equity:0,inventoryValue:0,fees:Number(agents.fees),unrealizedPnl:0};data.accountSummary.available=data.cash;
 return data;
}

// Explicit examples remain separate from account receipts, including unresolved history.
export function statementExampleContext(trade,status,hostname=globalThis.location?.hostname){
 if(!['127.0.0.1','localhost','opsqa.localhost'].includes(hostname)||status?.state!=='LIVE'||status?.source!=='LOCAL_FIXTURE'||status.scope?.accountId!=='SIM-01'||status.scope?.environment!=='DEMO')return false;
 if(!workbenchAccount(trade).known||trade.pending)return false;
 if(!Array.isArray(trade.orders)||!Array.isArray(trade.flow?.fills)||!Array.isArray(trade.flow?.ledger))return false;
 return trade.accountSummary?.accountId==='SIM-01'&&trade.accountSummary?.environment==='DEMO';
}
export function statementExampleAllowed(trade,status,hostname=globalThis.location?.hostname){
 if(!statementExampleContext(trade,status,hostname))return false;
 const records=statementRecords(trade,status.scope);
 if(records.orders.some(row=>row.owner!=='STRATEGY_AGENT'||row.timestamp===null||row.status==='unknown')||records.fills.some(row=>row.owner!=='STRATEGY_AGENT'||row.timestamp===null||row.pendingFee)||records.events.some(row=>!row.owner||row.timestamp===null))return false;
 // Orphan receipts are unresolved data, not an empty ledger.
 return trade.flow.fills.every(raw=>records.fills.some(row=>row.id===raw.id))&&trade.flow.ledger.filter(raw=>['REALIZED_PNL','FEE','GAS','FUNDING'].includes(raw.type)).every(raw=>records.events.some(row=>row.id===raw.id));
}

// Separate review scenario; the original 27-day ledger and account remain untouched.
export const STATEMENT_MARKET_EXAMPLE=Object.freeze({id:'markets-20261110',asOf:STATEMENT_EXAMPLE.asOf});
export function statementMarketExampleSnapshot(){
 const data={orders:[],positions:[],flow:{plans:[],fills:[],ledger:[]},botBook:{runs:[],flow:{fills:[],ledger:[]}},accountSummary:{...previewAccount}};
 const cases=[['cex-spot','BTC/USDT',.02,72000,72800,'long'],['cex-perp','ETH/USDT',.8,2200,2240,'long'],['dex-spot','WETH/USDC',.4,2190,2225,'long'],['dex-perp','SOL/USDC',12,152,149,'short']];
 for(const [ownerIndex,tradeOwner]of ['AI_SPECTRUM','STRATEGY_AGENT'].entries())for(const [index,[profileId,market,qty,entry,exit,direction]]of cases.entries()){
  const profile=ORDER_MARKETS[profileId],perp=isPerp(profile),prefix=`REVIEW-${ownerIndex}-${profileId}`,runId=prefix+'-RUN',day=`2026-11-${String(6+index).padStart(2,'0')}`,base={accountId:previewAccount.accountId,environment:'DEMO',tradeOwner,runId,market,...profile,priceCurrency:profile.currency,notionalCurrency:profile.currency,quantityAsset:market.split('/')[0],leverage:perp?3:1,direction,marginMode:perp?'isolated':null,fundingRate:perp?.0001:null,orderType:profileId==='dex-spot'?'SWAP':'LIMIT',chainStatus:profile.venueType==='DEX'?'confirmed':null,slippage:profileId==='dex-spot'?.5:null};
  const run={id:runId,tradeOwner,environment:'DEMO',plan:{name:perp?'趋势跟随':'分批买入',market,executionRoute:{accountId:previewAccount.accountId,environment:'DEMO',profileId,venueId:profile.venueId}},orders:[]};
  if(tradeOwner==='STRATEGY_AGENT')data.botBook.runs.push(run);
  const orders=tradeOwner==='AI_SPECTRUM'?data.orders:run.orders,flow=tradeOwner==='AI_SPECTRUM'?data.flow:data.botBook.flow;
  for(const [i,price]of [entry,exit].entries()){
   const id=prefix+'-'+i,recordedAt=Date.parse(day+`T${i?'16:30':'09:15'}:00+08:00`),side=(direction==='short'?i===0:i===1)?'sell':'buy';
   const order={...base,id,recordedAt,side,intent:i?'close':'open',reduceOnly:perp&&i===1,price,qty,filled:1,status:'filled',inputAmount:profileId==='dex-spot'?(side==='buy'?amount(price*qty):qty):null,inputAsset:side==='buy'?profile.currency:market.split('/')[0],outputAmount:profileId==='dex-spot'?(side==='buy'?qty:amount(price*qty)):null,outputAsset:side==='buy'?market.split('/')[0]:profile.currency,minReceived:profileId==='dex-spot'?amount((side==='buy'?qty:price*qty)*.995):null,txHash:profile.venueType==='DEX'?'review-only-'+id:null};
   orders.push(order);
   const fill={...order,id:'F-'+id,orderId:id,venueFillId:'RECEIPT-'+id,recordedAt,side,intent:order.intent,price:String(price),quantity:String(qty),notional:String(amount(qty*price)),feeState:'CONFIRMED',liquidityRole:'TAKER'};
   if(i)fill.realizedPnlGross=String(amount((exit-entry)*qty*(direction==='short'?-1:1)));
   flow.fills.push(fill);flow.ledger.push({id:'FEE-'+id,economicEventId:'FEE-'+id,accountId:previewAccount.accountId,orderId:id,fillId:fill.id,type:'FEE',currency:profile.currency,amount:String(-amount(qty*price*profile.feeRate)),recordedAt});
   if(profileId==='dex-spot')flow.ledger.push({id:'GAS-'+id,economicEventId:'GAS-'+id,accountId:previewAccount.accountId,orderId:id,type:'GAS',currency:'ETH',amount:'-0.00008',recordedAt});
  }
  const recordedAt=Date.parse('2026-11-09T19:00:00+08:00');
  orders.push({...base,id:prefix+'-OPEN',recordedAt,side:direction==='short'?'sell':'buy',intent:'open',price:entry,qty,filled:0,status:profileId==='dex-spot'?'confirming':'open',chainStatus:profile.venueType==='DEX'?'pending':null,orderType:profileId==='dex-spot'?'SWAP':'LIMIT'});
  data.positions.push({...base,id:prefix+'-POS',recordedAt,qty,quantityAsset:market.split('/')[0],notional:amount(qty*exit),notionalCurrency:profile.currency,entryPrice:entry,markPrice:exit,margin:perp?amount(qty*entry/3):null,liquidationPrice:perp?amount(entry*(direction==='short'?1.32:.68)):null,unrealizedPnl:amount((exit-entry)*qty*(direction==='short'?-1:1))});
  if(perp)flow.ledger.push({...base,id:prefix+'-FUNDING',economicEventId:prefix+'-FUNDING',recordedAt,type:'FUNDING',amount:direction==='short'?'0.18':'-0.176',fundingRate:.0001});
 }
 return data;
}
