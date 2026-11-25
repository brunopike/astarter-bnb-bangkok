import {orderMarket,orderTerms,marketTicketError,isPerp,positionValue,orderSideLabel,closeSettlement} from './order-markets.mjs';
import {newProtectionState,advanceProtection,protectionDecision} from './strategy-protection.mjs';
import {ExecutionRecords,decimal} from './execution-records.mjs';
// UI fixture only. Deliberately isolated from Nautilus, credentials and real orders.
export const MARKETS={'BTC/USDT':81218.87,'ETH/USDT':3246.52,'SOL/USDT':184.36};
export const DEFAULT_CONNECTIONS={exchange:true,data:true,ai:true,wallet:false,notifications:true,provider:'OpenRouter',budget:5};
const APPROVAL_SECONDS=30;
const SINGLE_SHOT_ADAPTER=Symbol('validated-single-shot'),singleShotEntries=new WeakSet();
// Catalog research labels do not register an executable adapter. Single-shot orders
// have their own validated market contract; S01/S02 run only in their paper Book.
const strategyAdapterAvailable=plan=>{
 if(singleShotEntries.has(plan))return true;
 if(plan?.singleShot)return false;
 if(plan?.strategy!=='S03'||plan.market!=='BTC/USDT'||plan.planVariant&&plan.planVariant!=='baseline')return false;
 const route=plan.executionRoute;
 return !route||route.profileId==='cex-spot'&&route.venueId==='binance'&&route.accountId==='SIM-01'&&!route.chainId&&plan.market==='BTC/USDT';
};
const approvalScope=s=>JSON.stringify([s.id,s.market,s.strategy,s.strategyVersion||s.version,s.amount,s.cap,s.price,s.researchRevision,s.riskVersion,s.protection]);
export function pendingStrategyApproval(trade){
 const s=trade?.session,signal=trade?.signal;
 if(!s||s.mode!=='review'||s.singleShot||trade.state!=='running'||trade.pending||!signal||signal.side!=='buy'||signal.intent==='close')return null;
 const request=signal.approval;
 if(!request||request.scope!==approvalScope(s)||!Number.isFinite(trade.time)||trade.time>request.expiresAt)return null;
 return {id:signal.id,market:s.market,strategy:s.strategy,amount:s.amount,cap:s.cap,price:s.price,expiresAt:request.expiresAt,remaining:Math.max(0,Math.ceil(request.expiresAt-trade.time))};
}
// Bounded one-shot tickets share the existing simulated order and fill ledger.
export function quickTicketError(ticket,context,now){
 if(!ticket||!Number.isFinite(ticket.quotePrice)||ticket.quotePrice<=0||!Number.isFinite(context?.price)||context.price<=0)return '报价尚未准备好，请重新打开下单面板。';
 if(!Number.isFinite(ticket.quotedAt)||now-ticket.quotedAt>45||ticket.quotedAt>now)return '报价已过期，请刷新报价后再确认。';
 if(!ticket.sourceId||ticket.revision!==context.revision||!context.ready||context.conflict||context.missing)return '这条信号已变化或仍有分歧，请等待新的评估。';
 if(!Number.isFinite(ticket.maxGap)||ticket.maxGap<=0||ticket.maxGap>2||Math.abs(context.price/ticket.quotePrice-1)*100>ticket.maxGap)return '价格变化超过允许范围，请刷新报价。';
 const short=orderMarket(ticket)?.marketType==='PERPETUAL'&&ticket.direction==='short';
 if(!Number.isFinite(ticket.stopLoss)||!Number.isFinite(ticket.takeProfit)||ticket.stopLoss<=0||ticket.takeProfit<=0||(short?!(ticket.takeProfit<context.price&&context.price<ticket.stopLoss):!(ticket.stopLoss<context.price&&context.price<ticket.takeProfit)))return '止盈止损价格与所选方向不匹配。';
 return null;
}
export class TradingDemo{
 constructor(){this.cash=10000;this.position=null;this.orders=[];this.events=[];this.seq=0;this.time=0;this.session=null;this.pending=null;this.signal=null;this.state='idle';this.nextSignal=0;this.readSeq=0;this.totalFees=0;this.signalHistory=[];this.orderScenario='normal';this.records=new ExecutionRecords();this.capitalProtection=null;}
 restore(data){if(!data||!Number.isFinite(data.cash)||data.cash<0||!Array.isArray(data.orders))return false;for(const k of ['cash','position','orders','events','seq','time','session','nextSignal','readSeq','totalFees','signalHistory','orderScenario','capitalProtection'])if(data[k]!==undefined)this[k]=structuredClone(data[k]);this.records=new ExecutionRecords(data.flow||data.records?.data);this.events=this.events.filter(e=>!e.text?.startsWith('已恢复模拟账本'));this.pending=data.pending?this.orders.find(o=>o.id===data.pending.id)||null:null;this.signal=null;this.state=this.pending?.status==='unknown'?'blocked':this.session?(data.state==='stopped'?'stopped':'paused'):'idle';if(this.session&&!['stopped','paused'].includes(data.state))this.event('已恢复模拟账本；自动执行保持暂停，需明确恢复。');return true;}
 get flow(){return this.records.data;}
 event(text,kind='info'){this.events.unshift({id:++this.seq,at:this.time,recordedAt:Date.now(),text,kind,runId:this.session?.id,strategy:this.session?.strategy,market:this.session?.market,profileId:this.session?.ticket?.profileId||'cex-spot'});this.events=this.events.slice(0,200);}
 get unread(){return this.events.filter(e=>e.id>this.readSeq&&!e.text?.startsWith('已恢复模拟账本')).length;}
 get availableCash(){return Math.max(0,this.cash-this.flow.reservations.filter(r=>r.state==='HELD'&&['USD','USDT','USDC'].includes(r.unit)).reduce((n,r)=>n+Number(r.amount),0));}
 get equity(){return this.cash+positionValue(this.position);}
 start(draft,connections,research,adapter){
  if(this.capitalProtection?.locked)return '账户资金保护已暂停新买入；切换策略不会解除。';
  if(this.session&&this.state!=='stopped')return '先停止当前运行，再应用新配置。';
  if(this.pending||this.position)return '先处理当前模拟持仓，再开启新运行。';
  if(!draft.executionRoute&&(!draft.singleShot||orderMarket(draft.ticket)?.venueType==='CEX')&&!connections.exchange||!connections.data||!connections.ai)return '交易所、行情或 AI 示例连接未就绪，请在底部配置。';
  const singleShot=adapter===SINGLE_SHOT_ADAPTER&&draft.singleShot===true&&orderMarket(draft.ticket);
  if(!Object.hasOwn(MARKETS,draft.market)||!(singleShot||strategyAdapterAvailable(draft))||!['signal','confirm','auto','review'].includes(draft.mode))return '所选市场、策略或执行模式不受支持。';
  if(!Number.isFinite(draft.amount)||draft.amount<10||draft.amount>1000||!Number.isFinite(draft.cap)||draft.cap<draft.amount||draft.cap>3000||draft.amount*1.001>this.availableCash)return '单笔需为 10–1,000 USDT，敞口上限需覆盖单笔且不超过 3,000 USDT，并保留手续费。';
  if(!research.ready||research.market!==draft.market||research.conflict||research.missing)return '研究未完成、标的不一致或仍有分歧，请先完成研究核验。';
  this.session={...draft,tradeOwner:['AI_SPECTRUM','STRATEGY_AGENT'].includes(draft.tradeOwner)?draft.tradeOwner:null,recordedAt:Date.now(),connections:{...connections},researchRevision:research.revision,price:research.price||MARKETS[draft.market],id:`SIM-${this.seq+1}`,count:0};if(singleShot)singleShotEntries.add(this.session);this.state='running';this.nextSignal=this.time+4;this.signal=null;this.event(`${draft.market} · ${draft.strategy} · ${draft.mode==='auto'?'自动执行':draft.mode==='review'?'入场前先批准':draft.mode==='confirm'?'逐笔确认':'只看信号'}已启动`);return null;
 }
 quickOrder(draft,connections,research,ticket,beforeSubmit=()=>{}){
  const issue=quickTicketError(ticket,research,this.time);if(issue)return issue;
  if(ticket.profileId){const issue=marketTicketError({...ticket,amount:draft.amount,cap:draft.cap},research.price,{cash:this.availableCash,market:draft.market});if(issue)return issue;}
  const key=`${ticket.sourceId}:${ticket.profileId||'cex-spot'}:${ticket.direction||'long'}`;
  if(this.orders.some(o=>(o.ticketKey||`${o.sourceId}:cex-spot:long`)===key&&o.intent!=='close'&&o.side===(ticket.direction==='short'?'sell':'buy')))return '这条信号已经提交过订单，请查看原订单。';
  const error=this.start({...draft,singleShot:true,ticket:{...ticket,ticketKey:key}},connections,research,SINGLE_SHOT_ADAPTER);if(error)return error;
  beforeSubmit(this.session);
  this.signal={id:`SIG-${++this.seq}`,side:ticket.direction==='short'?'sell':'buy',intent:'open',at:this.time,sourceId:ticket.sourceId};
  const result=this.submit();if(!result)this.event('单笔模拟订单已提交，成交后按已设条件管理。','order');return result;
 }
 triggerProtection(kind,price){
  const s=this.session;if(!s?.singleShot||!this.position||this.pending)return '尚无可保护的持仓，或有订单正在处理。';
  if(!['takeProfit','stopLoss'].includes(kind))return '不支持的保护条件。';
  if(!Number.isFinite(price)||price<=0)return '触发报价不可用。';
  const threshold=s.ticket[kind],short=this.position.direction==='short';if(kind==='takeProfit'?(short?price>threshold:price<threshold):(short?price<threshold:price>threshold))return '当前报价尚未触发保护条件。';
  const previous=this.state;s.ticket.exitAttempted=true;this.state='running';this.signal={id:`SIG-${++this.seq}`,side:this.position.direction==='short'?'buy':'sell',intent:'close',at:this.time,price,exitReason:kind};
  const error=this.submit();this.state=error?'blocked':previous==='stopped'?'stopped':'paused';if(error)this.signal=null;
  if(!error)this.event(`${kind==='takeProfit'?'止盈':'止损'}已触发，按已有持仓数量模拟退出；另一退出条件同时结束。`,'risk');return error;
 }
 tick(dt,context={ready:true}){
  this.time+=Math.min(Math.max(dt,0),.2);
  this.records.tick(this.time);
  if(this.position&&context.market===this.position.market&&Number.isFinite(context.price)&&context.price>0)this.position.markPrice=context.price;
  if(this.session?.protection?.id==='astarter'){
   this.capitalProtection||=newProtectionState(this.equity);
   const settled=!this.position&&!this.pending&&this.flow.fills.every(f=>f.feeState!=='PENDING');
   this.capitalProtection=advanceProtection(this.capitalProtection,{policy:this.session?.protection,equity:this.equity,settled,day:Math.floor(this.time/86400)});
   if(this.capitalProtection.locked&&this.state==='running'&&!this.pending){this.state='paused';this.signal=null;this.event('资金保护已暂停新买入；已有持仓保留退出操作。','risk');}
  }
  if(this.position&&this.flow.protections.some(p=>p.instanceId===this.session?.id&&['IMPAIRED','UNKNOWN'].includes(p.state))&&this.state==='running'){this.state='blocked';this.signal=null;this.event('持仓保护受损，停止新增；请核对覆盖并人工接管。','risk');}
  if(this.signal&&(this.signal.approval?this.time>this.signal.approval.expiresAt:this.time-this.signal.at>45)){this.event('信号已过有效期，未提交订单。','signal');this.signalHistory.unshift({...this.signal,market:this.session.market,runId:this.session.id,mode:this.session.mode,status:'expired'});this.signal=null;this.session.count++;this.nextSignal=this.time+12;}
  if(this.pending){const o=this.pending,age=this.time-o.at;if(o.scenario==='unknown'){if(age>=1.2&&o.status!=='unknown'){o.status='unknown';this.records.orderState(o,'UNKNOWN');this.state='blocked';this.event(o.id+' 回执未知，保留原操作和资金占用。','risk');}return;}if(o.venueId==='uniswap'&&age>=1&&o.status==='submitted'){o.status='confirming';this.records.changed();}if(age>=1.2&&o.filled===0&&o.venueId!=='uniswap')this.fill(o,.5);if(age>=2.5){if(o.venueId==='uniswap'&&o.scenario==='dex-revert'){o.status='rejected';this.records.orderState(o,'FAILED');this.records.reservation(o,true);this.pending=null;this.state='paused';this.event('模拟链上兑换失败；没有成交，已消耗网络费。','risk');return;}this.fill(o,1);o.status='filled';this.records.orderState(o,'SUCCEEDED');this.records.reservation(o,true);this.pending=null;this.event(`${o.id} 已模拟成交 · ${o.scenario==='late-fee'?'费用待核账':'手续费 '+o.fee.toFixed(4)+' '+(o.currency||'USDT')}`,'fill');}}
  if(this.session?.endIntent==='close'&&!this.pending){
   if(this.position&&!this.session.endExitAttempted){this.session.endExitAttempted=true;const issue=this.closePosition({manual:false});if(issue){this.state='blocked';this.event('退出未提交：'+issue,'risk');}return;}
   this.signal=null;this.state=this.position?'blocked':'stopped';return;
  }
  if(this.session?.endIntent==='keep'&&!this.pending){this.state='stopped';this.signal=null;}
  if(this.session?.manualIntervention&&!this.pending){this.state=this.position?'paused':'stopped';this.signal=null;if(!this.session.singleShot)return;}
  if(this.session?.singleShot&&!this.pending){
   if(this.position){const p=context.price;if(!this.session.ticket.exitAttempted&&Number.isFinite(p)&&context.market===this.session.market){const short=this.position.direction==='short';if(short?p<=this.session.ticket.takeProfit:p>=this.session.ticket.takeProfit)this.triggerProtection('takeProfit',p);else if(short?p>=this.session.ticket.stopLoss:p<=this.session.ticket.stopLoss)this.triggerProtection('stopLoss',p);}if(this.state==='running')this.state='paused';}
   else if(this.orders.some(o=>o.runId===this.session.id&&(o.intent==='close'||!o.intent&&o.side==='sell')&&o.status==='filled'))this.state='stopped';
   return;
  }
  if(this.state!=='running'||!this.session||this.pending)return;
  if(!strategyAdapterAvailable(this.session)){this.state='paused';this.signal=null;this.event('该策略版本尚无模拟执行适配，停止新增；原订单与持仓保留退出及对账。','risk');return;}
  if(this.session.awaitingResearch){if(!context.ready)return;this.session.awaitingResearch=false;this.session.researchRevision=context.revision;this.nextSignal=this.time+4;this.event('交易条件已满足，策略继续运行。');return;}
  if(!context.ready&&this.session.followResearch){this.signal=null;this.session.awaitingResearch=true;this.event('市场条件变化，策略等待新的交易条件。');return;}
  if(context.ready&&this.session.followResearch&&context.revision&&context.revision!==this.session.researchRevision){this.signal=null;this.session.researchRevision=context.revision;this.nextSignal=this.time+4;}
  if(!context.ready){this.signal=null;this.state='blocked';this.event('研究版本已变化，暂停新增风险；已有模拟持仓保留。','risk');return;}
  if(this.session.count>=3){this.state='paused';this.event('已完成本轮 3 个示例信号，暂停新增风险。');return;}
  if(this.signal&&(this.session.mode==='auto'||this.session.mode==='review'&&this.signal.side==='sell')&&this.time-this.signal.at>=2.2){this.submit();return;}
  if(!this.signal&&this.time>=this.nextSignal){this.signal={id:`SIG-${++this.seq}`,side:this.position?'sell':'buy',at:this.time};if(this.session.mode==='review'&&this.signal.side==='buy')this.signal.approval={scope:approvalScope(this.session),expiresAt:this.time+APPROVAL_SECONDS};this.event(`${this.signal.side==='buy'?'入场':'退出'}条件命中 · 预设信号示例`,'signal');if(this.session.mode==='signal'){this.signalHistory.unshift({...this.signal,market:this.session.market,runId:this.session.id,mode:'signal',strategy:this.session.strategy,status:'notified',revision:this.session.researchRevision});this.session.count++;this.signal=null;this.nextSignal=this.time+12;}}
 }
 approve(signalId){
  const request=pendingStrategyApproval(this);
  if(!request||request.id!==signalId)return '这份入场方案已变化或失效，请查看最新方案。';
  this.signal.approvedScope=this.signal.approval.scope;
  const error=this.submit();
  if(error&&this.signal)delete this.signal.approvedScope;
  if(!error)this.event('用户已批准本次入场，后续退出沿用原保护规则。','approval');
  return error;
 }
 submit(){
  if(this.state!=='running'||this.pending||!this.signal)return '当前没有可确认的信号。';
  const s=this.session,side=this.signal.side,price=this.signal.price??s.price;
  if((s.endIntent||s.manualIntervention)&&!(this.signal.intent==='close'||!this.signal.intent&&side==='sell'))return '运行已结束或由你接管，不再新增交易。';
  if(s.mode==='review'&&!s.singleShot&&side==='buy'&&this.signal.intent!=='close'&&(!pendingStrategyApproval(this)||this.signal.approvedScope!==approvalScope(s)))return '这次入场需要先批准当前方案。';
  const profile=s.singleShot?orderMarket(s.ticket):null,perp=isPerp(profile),closing=this.signal.intent==='close'||!this.signal.intent&&side==='sell',terms=s.singleShot?orderTerms({...s.ticket,amount:s.amount},price):null;
  if(!closing&&!strategyAdapterAvailable(s))return '该策略版本尚无模拟执行适配，不能新增交易。';
  if(closing&&profile?.gas&&this.availableCash+1e-9<profile.gas)return '可用模拟余额不足以支付退出网络费，未广播；持仓保留。';
  const constraintFailed=!closing&&(s.amount>s.cap||(terms?terms.notional>s.cap||s.amount+terms.fee+terms.gas>this.availableCash:s.amount*1.001>this.availableCash));
  let amount=s.amount;
  if(!closing&&s.protection?.id==='astarter'){
   this.capitalProtection||=newProtectionState(this.equity);
   this.capitalProtection=advanceProtection(this.capitalProtection,{policy:this.session?.protection,equity:this.equity});
   const decision=protectionDecision({policy:s.protection,state:this.capitalProtection,equity:this.equity,requested:s.amount,cap:s.cap,cash:this.cash,stopFraction:s.singleShot?Math.abs(price-s.ticket.stopLoss)/price*(terms?.leverage||1):.02});
   s.protectionDecision={...decision,fixtureStopFraction:s.singleShot?Math.abs(price-s.ticket.stopLoss)/price*(terms?.leverage||1):.02};
   if(!decision.amount){this.state='paused';this.signal=null;this.event('资金保护：暂停新买入，等待账户与额度检查。','risk');return '资金保护暂停了本次买入。';}
   amount=decision.amount;if(amount<s.amount)this.event(`资金保护将本次模拟金额从 ${s.amount} 调整为 ${amount.toFixed(2)} USDT。`,'risk');
  }
  const qty=closing?this.position?.qty:amount*(terms?.leverage||1)/price;
  if(!qty)return '无可退出的持仓。';
  if(!this.signal.id)this.signal.id=`SIG-${++this.seq}`;
  const {plan,admission}=this.records.prepare(this.signal,{...s,price},qty,constraintFailed?'risk-reject':this.orderScenario,this.time);
  if(admission.state!=='DISPATCHABLE'){this.state='blocked';this.event(admission.blockingReasons.join('；'),'risk');return admission.blockingReasons.join('；');}
  const signalId=this.signal.id||null;const order={scenario:this.orderScenario,signalId,strategy:s.strategy,strategyVersion:s.strategyVersion||1,id:`SIM-ORD-${++this.seq}`,market:s.market,side,price,qty,filled:0,fee:0,at:this.time,recordedAt:Date.now(),status:'submitted',runId:s.id};
  if(s.singleShot)Object.assign(order,{venueId:profile.venueId,venue:profile.venue,venueType:profile.venueType,marketType:profile.marketType,currency:profile.currency,profileId:profile.id,feeRate:profile.feeRate,intent:closing?'close':'open',direction:terms.direction,leverage:terms.leverage,marginMode:perp?'isolated':null,marginPerUnit:perp?(closing?this.position.margin/this.position.qty:price/terms.leverage):null,entryPrice:closing?this.position.price:price,reduceOnly:perp&&closing,chain:profile.chain||null,ticketKey:s.ticket.ticketKey,displayMarket:profile.id==='dex-spot'?(s.market.startsWith('ETH')?'WETH/USDC':'WBTC/USDC'):s.market.replace('USDT',profile.currency),sourceId:s.ticket.sourceId,sourceTitle:s.ticket.title,protection:{stopLoss:s.ticket.stopLoss,takeProfit:s.ticket.takeProfit},exitReason:this.signal.exitReason||null});
  this.records.submitted(order,plan,admission,this.time);this.orders.unshift(order);if(profile?.gas&&order.scenario!=='rejected'){const gas=this.records.cost({sourceId:`GAS-${order.id}`,orderId:order.id,amount:-profile.gas,type:'GAS',currency:'USD',at:this.time});this.cash+=gas;order.gas=profile.gas;}this.pending=order;this.signal=null;s.count++;this.nextSignal=this.time+12;if(order.scenario==='rejected'){order.status='rejected';this.records.orderState(order,'FAILED');this.records.reservation(order,true);this.pending=null;this.state='paused';this.event(order.id+' 被模拟场所拒绝，未生成成交回报。','risk');return null;}this.event(`${order.id} ${orderSideLabel(order)}已提交 · 本地模拟`,'order');return null;
 }
 fill(o,ratio){const receipt=this.records.recordFill(o,ratio,this.time);if(!receipt)return false;const {qty,notional,fill}=receipt;o.filled=ratio;
  if(isPerp(o)){
   const margin=qty*o.marginPerUnit;
   if(o.intent==='open'){this.cash-=margin;this.position={...o,market:o.market,qty:(this.position?.qty||0)+qty,margin:(this.position?.margin||0)+margin,price:o.price,markPrice:o.price};}
   else {const {pnl}=closeSettlement(o,qty);this.cash+=margin+pnl;this.position.margin=Math.max(0,this.position.margin-margin);this.position.qty=Math.max(0,this.position.qty-qty);if(this.position.qty<1e-12)this.position=null;}
  }else if(o.side==='buy'){this.cash-=notional;this.position={...o,market:o.market,qty:(this.position?.qty||0)+qty,price:o.price};}
  else{fill.realizedPnlGross=decimal(notional-qty*this.position.price);this.cash+=notional;this.position.qty=Math.max(0,this.position.qty-qty);if(this.position.qty<1e-12)this.position=null;}
  if(o.scenario!=='late-fee')this.applyFee(fill.id,isPerp(o)&&o.intent==='close'?closeSettlement(o,qty).fee:notional*(o.feeRate??.001));
  o.status=ratio===1?'filled':'partial';this.records.reservation(o,ratio===1);this.records.updateProtection(this.position,o,this.time);
  if(ratio<1)this.event(`${o.id} 部分成交 50% · 已成交部分计入持仓`,'fill');
  return true;
 }
 applyFee(fillId,fee,revision=1){const fill=this.flow.fills.find(f=>f.id===fillId);if(!fill)return false;const delta=this.records.cost({sourceId:`FEE-${fill.venueFillId}`,orderId:fill.orderId,fillId,amount:-fee,currency:fill.currency||'USDT',at:this.time,revision});if(delta===null)return false;this.cash+=delta;this.totalFees-=delta;const o=this.orders.find(o=>o.id===fill.orderId);if(o)o.fee-=delta;return true;}
 deliverReceipt(){if(!this.pending||this.pending.status!=='unknown')return '没有未知委托。';this.records.venueReceipt(this.pending,this.time);this.event('原委托模拟回执已送达，可查询原结果。','order');return null;}
 reconcile(){if(this.pending?.status!=='unknown')return '没有待对账的未知委托。';const o=this.pending,result=this.records.query(o.operationId,this.time);if(!result.receipt)return '原操作仍待核对；查询未生成新委托，资金占用保留。';o.scenario='normal';o.status='submitted';this.state='paused';o.at=this.time-1.2;this.records.orderState(o,'RUNNING');this.event(o.id+' 原模拟回执已确认，等待原委托的分步成交。','order');return null;}
 deliverProtection(){const p=this.flow.protections.find(p=>Number(p.targetQuantity)>0&&p.state!=='ACTIVE');if(!p)return '没有待核对的保护。';this.records.protectionReceipt(p.id,Number(p.targetQuantity),this.time,'ACTIVE',p.fenceRevision);this.event('模拟保护回执确认；新增风险仍需明确恢复。','risk');return null;}
 deliverFees(){const pending=this.flow.fills.filter(f=>f.feeState==='PENDING');for(const f of pending)this.applyFee(f.id,f.expectedFee??Number(f.notional)*(f.feeRate??.001));for(const o of this.orders)this.records.reservation(o,['filled','cancelled','partial-cancelled','rejected'].includes(o.status));if(pending.length)this.event('晚到模拟手续费已补录，同源事件不会重复扣费。','fill');return null;}
 replayFill(){const o=this.orders.find(o=>o.filled>0);if(!o)return '尚无成交可重放。';this.fill(o,o.filled);this.event('已重放原成交；同源事件去重，库存与账本不重复变化。');return null;}
 cancel(){if(this.pending?.venueId==='uniswap')return '兑换已广播，等待链上结果；不能当作普通委托撤单。';if(this.pending?.scenario==='unknown')return '回执未知，先模拟对账再撤销，不能直接当成零成交。';if(!this.pending)return null;this.pending.status=this.pending.filled?'partial-cancelled':'cancelled';this.records.orderState(this.pending,'SUCCEEDED');this.records.reservation(this.pending,true);this.event(`${this.pending.id} 剩余数量已模拟撤销`);this.pending=null;}
 pause(){if(!['running','blocked'].includes(this.state))return;const error=this.cancel();if(error){this.state='blocked';return error;}this.signal=null;this.state='paused';this.event('已暂停新增风险并撤销未成交部分；持仓保留。');}
 resume(context){if(this.session&&!strategyAdapterAvailable(this.session))return '该策略版本尚无模拟执行适配，原订单与持仓仅保留退出及对账。';if(this.session?.endIntent||this.session?.manualIntervention)return '运行已结束或由你接管，请在新方案中重新确认交易范围。';if(this.session?.protection?.id==='astarter'&&this.capitalProtection?.locked)return '资金保护已锁定新增买入；切换模式、刷新或跨日不会解除。';if(this.pending)return '先等待当前订单完成，再继续策略。';if(this.flow.protections.some(p=>Number(p.targetQuantity)>0&&p.state!=='ACTIVE'))return '持仓保护尚未确认有效，先检查保护。';if(!this.session||this.state!=='paused'&&!(this.state==='blocked'&&this.events[0]?.text?.startsWith('研究版本已变化')))return '当前策略不能继续，请先处理页面提示。';this.signal=null;this.state='running';this.session.followResearch=true;this.session.awaitingResearch=!context.ready;if(context.ready)this.session.researchRevision=context.revision;this.session.count=0;this.nextSignal=this.time+4;this.event(context.ready?'策略已继续，金额与资金保护保持不变。':'策略已继续，等待交易条件；满足后再下单。');return null;}
 stop(intent='keep',requestId=''){
  if(!['keep','close'].includes(intent)||typeof requestId!=='string'||requestId.length>256)return '请选择保留持仓或退出持仓。';
  if(intent==='close'&&this.position&&!this.session)return '运行身份缺失，不能提交退出。';
  const s=this.session,key=requestId||`end:${s?.id||'idle'}:${intent}`;if(s?.endRequestId===key)return null;
  if(s){s.endIntent=intent;s.endRequestId=key;s.endExitAttempted=false;}this.signal=null;
  const error=this.cancel();if(error){this.state='blocked';this.event('已停止新增交易；原订单结果仍需核对。','risk');return error;}
  this.state='stopped';
  if(intent==='close'&&this.position){s.endExitAttempted=true;const issue=this.closePosition({manual:false});if(issue){this.state='blocked';return issue;}this.event('运行正在结束，按剩余持仓退出；成交结果继续跟踪。','risk');}
  else this.event('运行已停止；保留已有持仓，可单独退出。','risk');
  return null;
 }
 closePosition({manual=true}={}){if(!this.position||this.pending)return '无可退出持仓，或仍有在途订单。';if(manual&&this.session)this.session.manualIntervention=true;const previous=this.state;this.state='running';this.signal={side:this.position.direction==='short'?'buy':'sell',intent:'close',price:this.position.markPrice||this.position.price};const error=this.submit();this.state=previous==='running'?'paused':previous;return error;}
 skip(signalId){if(!this.signal)return this.session?.mode==='review'?'这份入场方案已变化或失效，请查看最新方案。':undefined;if(this.session?.mode==='review'&&signalId!==this.signal.id)return '这份入场方案已变化或失效，请查看最新方案。';this.signalHistory.unshift({...this.signal,market:this.session.market,runId:this.session.id,mode:this.session.mode,status:'skipped'});this.signal=null;this.session.count++;this.nextSignal=this.time+12;this.event('本次信号已跳过。');return null;}
 markRead(){this.readSeq=this.seq;}
}
