import {orderMarket,isPerp,closeSettlement} from './order-markets.mjs';
// Provenance for TradingDemo fixtures only. Never an execution authority or a funds lock.
export const EXECUTION_SCENARIOS=[['normal','正常成交'],['risk-reject','风控拒绝'],['mandate-expired','授权过期'],['reservation-conflict','预占竞争'],['protection-invalid','保护方案缺失'],['unknown','提交超时'],['protection-delay','保护确认晚到'],['protection-impaired','保护受损'],['late-fee','手续费晚到'],['rejected','场所拒单'],['dex-revert','DEX 兑换失败（消耗 Gas）']];
export const decimal=n=>Number(n).toFixed(12).replace(/\.?0+$/,'')||'0';
const units=s=>{const [a,b='']=String(s).split('.');return BigInt(a.startsWith('-')?'-1':'1')*(BigInt(a.replace('-','')||'0')*10n**12n+BigInt(b.padEnd(12,'0').slice(0,12)));};
const fromUnits=v=>{const sign=v<0n?'-':'';v=v<0n?-v:v;return sign+`${v/10n**12n}.${String(v%10n**12n).padStart(12,'0')}`.replace(/\.?0+$/,'');};
export const sumAmounts=values=>fromUnits(values.reduce((n,v)=>n+units(v),0n));
const fresh=()=>({schema:1,revision:0,signals:[],plans:[],admissions:[],commands:[],operations:[],fills:[],ledger:[],reservations:[],protections:[],sourceEvents:[],venueReceipts:[]});
export class ExecutionRecords{
 constructor(saved){this.data=saved?.schema===1?{...fresh(),...structuredClone(saved)}:fresh();}
 changed(){this.data.revision++;}
 prepare(signal,session,quantity,scenario,at){
  const accountId=session.accountId||session.ticket?.accountId||'SIM-01',environment=session.environment||'DEMO';
  const id=`PLAN-${accountId==='SIM-01'?'':encodeURIComponent(accountId)+'-'}${signal.id}`,existing=this.data.plans.find(p=>p.id===id);if(existing){if(existing.instanceId!==session.id||existing.accountId!==accountId)throw Error('PLAN_SCOPE_CONFLICT');return {plan:existing,admission:this.data.admissions.find(a=>a.planId===id)};}
  this.data.signals.unshift({...structuredClone(signal),revision:1,state:"TRIGGERED",instanceId:session.id,market:session.market,accountId,environment});
  const plan={id,revision:1,tradeOwner:['AI_SPECTRUM','STRATEGY_AGENT'].includes(session.tradeOwner)?session.tradeOwner:null,recordedAt:Date.now(),signalId:signal.id,instanceId:session.id,accountId,venueId:'binance',environment,instrumentId:`binance:SPOT:${session.market}`,market:session.market,marketType:'SPOT',side:signal.side,quantity:decimal(quantity),price:decimal(session.price),strategyVersion:`${session.strategy}@${session.strategyVersion||1}`,riskVersion:session.riskVersion||1,mandateId:session.authorizationId||`SIM-MANDATE-${session.id}`,configurationHash:`fixture:${accountId}:${session.id}:${session.strategy}:${session.amount}:${session.cap}`,executionKind:session.executionKind||(session.singleShot?'MANUAL':session.mandateRef?'AI_AUTO':'BOT'),planRef:session.planRef||null,mandateRef:session.mandateRef||null,createdAt:at,protectionPrepared:scenario!=='protection-invalid'};
  if(session.singleShot){const p=orderMarket(session.ticket);Object.assign(plan,{venueId:p.venueId,venueType:p.venueType,marketType:p.marketType,currency:p.currency,chain:p.chain||null,instrumentId:`${p.venueId}:${p.marketType}:${(p.id==='dex-spot'?'W':'')+session.market.replace('USDT',p.currency)}`,direction:session.ticket.direction||'long',leverage:session.ticket.leverage||1,intent:signal.intent||'open',reduceOnly:signal.intent==='close'&&isPerp(p)});}
  if(session.singleShot)Object.assign(plan,{sourceId:session.ticket.sourceId,protection:{stopLoss:session.ticket.stopLoss,takeProfit:session.ticket.takeProfit},exitReason:signal.exitReason||null});
  const reasons={'risk-reject':['risk','账户风险限额拒绝本计划'],'mandate-expired':['mandate','新增风险授权已过期'],'reservation-conflict':['reservation','可用资金已被另一实例预占'],'protection-invalid':['protection','下单前保护方案未通过校验']};
  const fail=reasons[scenario],checks=['risk','mandate','configuration','reservation','protection'].map(key=>({key,result:fail?.[0]===key?'FAIL':'PASS',reason:fail?.[0]===key?fail[1]:'本地合同样例通过'}));
  const admission={id:`ADM-${id.slice(5)}`,planId:id,revision:1,source:'LOCAL_FIXTURE',state:fail?'BLOCKED':'DISPATCHABLE',configurationHash:plan.configurationHash,checks,blockingReasons:fail?[fail[1]]:[],evidenceId:`SIM-EVIDENCE-${id.slice(5)}`,reservationIds:[],checkedAt:at,expiresAt:at+45};
  this.data.plans.unshift(plan);this.data.admissions.unshift(admission);this.changed();return {plan,admission};
 }
 submitted(order,plan,admission,at){
  const commandId=`CMD-${order.id}`,operationId=`OP-${order.id}`,idempotencyKey=`demo:${plan.accountId}:${plan.signalId}:v1`,clientOrderId=`HIVE-${order.id}`;
  Object.assign(order,{planId:plan.id,admissionId:admission.id,commandId,operationId,idempotencyKey,clientOrderId,accountId:plan.accountId,instrumentId:plan.instrumentId,environment:plan.environment,executionKind:plan.executionKind,tradeOwner:plan.tradeOwner,recordedAt:order.recordedAt??Date.now(),planRef:plan.planRef,mandateRef:plan.mandateRef});
  this.data.commands.unshift({id:commandId,revision:1,planId:plan.id,signalId:plan.signalId,idempotencyKey,clientOrderId,accountId:plan.accountId,environment:plan.environment,state:'DISPATCHED',at});
  this.data.operations.unshift({id:operationId,commandId,revision:1,state:'RUNNING',orderId:order.id,lastCheckedAt:null});
  const reservation={id:`RES-${order.id}`,revision:1,orderId:order.id,planId:plan.id,accountId:plan.accountId,unit:isPerp(order)?(order.intent==='close'?'CONTRACT':order.currency):order.side==='buy'?(order.currency||'USDT'):(order.displayMarket||order.market).split('/')[0],amount:decimal(isPerp(order)?(order.intent==='close'?order.qty:order.qty*(order.marginPerUnit+order.price*order.feeRate)):order.side==='buy'?order.qty*order.price*(1+(order.feeRate??.001)):order.qty),state:'HELD',releaseEvidenceId:null};
  this.data.reservations.unshift(reservation);admission.reservationIds=[reservation.id];if(order.intent==='close'||!order.intent&&order.side==='sell'){const fee={...reservation,id:`RES-FEE-${order.id}`,unit:order.currency||'USDT',feeOnly:true,amount:decimal(isPerp(order)?closeSettlement(order,order.qty).fee:order.qty*order.price*(order.feeRate??.001))};this.data.reservations.unshift(fee);admission.reservationIds.push(fee.id);}this.changed();
 }
 orderState(order,state){const op=this.data.operations.find(p=>p.id===order.operationId);if(op){op.state=state;op.revision++;}this.changed();}
 recordFill(order,ratio,at,receiptKey){
  if(receiptKey!==undefined&&(typeof receiptKey!=='string'||!/^[a-f0-9]{64}$/.test(receiptKey)))throw Error('INVALID_RECEIPT_KEY');
  const id=`FILL-${order.id}-${receiptKey===undefined?Math.round(ratio*10000):'RECEIPT-'+receiptKey}`;if(this.data.fills.some(f=>f.id===id)||ratio<=order.filled||ratio>1)return null;
  const qty=order.qty*(ratio-order.filled),notional=qty*order.price;
  const fill={id,revision:1,tradeOwner:order.tradeOwner||null,recordedAt:Date.now(),venueFillId:`FIXTURE-${id}`,orderId:order.id,accountId:order.accountId||'SIM-01',instrumentId:order.instrumentId,quantity:decimal(qty),price:decimal(order.price),notional:decimal(notional),side:order.side,marketType:order.marketType||'SPOT',venueId:order.venueId||'binance',currency:order.currency||'USDT',feeRate:order.feeRate??.001,intent:order.intent,direction:order.direction,executedAt:at,feeState:'PENDING',feeAmount:'0'};
  fill.expectedFee=isPerp(order)&&order.intent==='close'?closeSettlement(order,qty).fee:notional*(order.feeRate??.001);this.data.fills.push(fill);this.data.sourceEvents.push(fill.venueFillId);
  const cashEntry=(type,amount)=>this.data.ledger.push({id:`LEDGER-${id}-${type}`,revision:1,economicEventId:fill.venueFillId+':'+type,fillId:id,orderId:order.id,accountId:fill.accountId,type,amount:decimal(amount),currency:order.currency||'USDT',at,recordedAt:fill.recordedAt,backfill:false});
  if(isPerp(order)){const margin=qty*order.marginPerUnit;if(order.intent==='open')cashEntry('MARGIN_LOCK',-margin);else{cashEntry('MARGIN_RELEASE',margin);cashEntry('REALIZED_PNL',closeSettlement(order,qty).pnl);}}else cashEntry('TRADE_CASH',(order.side==='buy'?-1:1)*notional);this.changed();return {fill,qty,notional};
 }
 cost({sourceId,orderId,fillId,accountId='SIM-01',amount,type='FEE',at,revision=1,marketType='SPOT',currency='USDT'}){
  if(type==='FUNDING'&&marketType!=='PERPETUAL')return null;
  const old=this.data.ledger.find(e=>e.economicEventId===sourceId);if(old&&old.revision>=revision)return null;
  const delta=Number(amount)-Number(old?.amount||0);
  const entry={id:old?.id||`LEDGER-${sourceId}`,economicEventId:sourceId,orderId,fillId,accountId,type,amount:decimal(amount),currency,at,recordedAt:old?.recordedAt??Date.now(),revision,backfill:at>(this.data.fills.find(f=>f.id===fillId)?.executedAt??at)||!!old};
  if(old)Object.assign(old,entry);else this.data.ledger.push(entry);
  const fill=this.data.fills.find(f=>f.id===fillId);if(fill){fill.feeState='CONFIRMED';fill.feeAmount=decimal(-Number(amount));fill.revision++;}
  this.changed();return delta;
 }
 updateProtection(position,order,at){
  const id=`PROT-${order.accountId&&order.accountId!=='SIM-01'?encodeURIComponent(order.accountId)+'-':''}${order.runId}`;let p=this.data.protections.find(p=>p.id===id&&p.accountId===(order.accountId||'SIM-01'));
  if(!p){p={id,revision:0,instanceId:order.runId,positionId:`POS-${order.runId}`,accountId:order.accountId||'SIM-01',ownerRef:`SIM-EXIT-${order.runId}`,fenceRevision:1,mode:'SIMULATED_SERVICE',confirmedQuantity:'0',targetQuantity:'0',pendingQuantity:'0',uncoveredQuantity:'0',lastVerifiedAt:null};this.data.protections.push(p);}
  if(order.protection)Object.assign(p,order.protection,{sourceId:order.sourceId});
  const target=position?.qty||0,confirmed=Math.min(target,Number(p.confirmedQuantity));
  Object.assign(p,{revision:p.revision+1,targetQuantity:decimal(target),confirmedQuantity:decimal(confirmed),pendingQuantity:decimal(Math.max(0,target-confirmed)),uncoveredQuantity:decimal(Math.max(0,target-confirmed)),state:target===0?'COMPLETED':target>confirmed?'PENDING':'ACTIVE',requestedAt:at,scenario:order.scenario});this.changed();
 }
 protectionReceipt(id,quantity,at,state='ACTIVE',fence){
  const p=this.data.protections.find(p=>p.id===id);if(!p||fence!==p.fenceRevision)return false;
  const confirmed=Math.max(0,Math.min(Number(p.targetQuantity),quantity));Object.assign(p,{revision:p.revision+1,confirmedQuantity:decimal(confirmed),pendingQuantity:'0',uncoveredQuantity:decimal(Math.max(0,Number(p.targetQuantity)-confirmed)),state:confirmed<Number(p.targetQuantity)&&state==='ACTIVE'?'IMPAIRED':state,lastVerifiedAt:at});this.changed();return true;
 }
 tick(at){for(const p of this.data.protections){if(p.state!=='PENDING'||at-p.requestedAt<.8)continue;if(p.scenario==='protection-delay'){if(at-p.requestedAt>4)this.protectionReceipt(p.id,Number(p.confirmedQuantity),at,'UNKNOWN',p.fenceRevision);continue;}if(p.scenario==='protection-impaired'){this.protectionReceipt(p.id,Number(p.confirmedQuantity),at,'IMPAIRED',p.fenceRevision);continue;}this.protectionReceipt(p.id,Number(p.targetQuantity),at,'ACTIVE',p.fenceRevision);}}
 reservation(order,terminal=false){
  const r=this.data.reservations.find(r=>r.orderId===order.id&&!r.feeOnly);if(!r)return;
  const pendingFee=(isPerp(order)?order.intent==='open':order.side==='buy')?this.data.fills.filter(f=>f.orderId===order.id&&f.feeState==='PENDING').reduce((n,f)=>n+Number(f.expectedFee??Number(f.notional)*(f.feeRate??.001)),0):0;
  const perUnit=isPerp(order)?(order.intent==='close'?1:order.marginPerUnit+order.price*order.feeRate):order.side==='buy'?order.price*(1+(order.feeRate??.001)):1;
  const amount=(terminal?0:order.qty*(1-order.filled)*perUnit)+pendingFee,released=terminal&&amount===0;
  Object.assign(r,{amount:decimal(amount),state:released?'RELEASED':'HELD',revision:r.revision+1,releaseEvidenceId:released?`SIM-TERMINAL-${order.id}-${order.status}`:null});const fee=this.data.reservations.find(r=>r.orderId===order.id&&r.feeOnly);if(fee){const due=this.data.fills.filter(f=>f.orderId===order.id&&f.feeState==='PENDING').reduce((n,f)=>n+Number(f.expectedFee??Number(f.notional)*(f.feeRate??.001)),0),remaining=terminal?0:isPerp(order)?closeSettlement(order,order.qty*(1-order.filled)).fee:order.qty*(1-order.filled)*order.price*(order.feeRate??.001);Object.assign(fee,{amount:decimal(due+remaining),state:due+remaining>0?'HELD':'RELEASED',revision:fee.revision+1,releaseEvidenceId:due+remaining===0?`SIM-FEE-SETTLED-${order.id}`:null});}this.changed();
 }
 query(operationId,at){const op=this.data.operations.find(p=>p.id===operationId);if(!op)return {state:'UNKNOWN',reason:'原操作尚未查到；保留占用'};op.lastCheckedAt=at;this.changed();return {...structuredClone(op),receipt:this.data.venueReceipts.find(r=>r.operationId===operationId)||null};}
 venueReceipt(order,at){if(this.data.venueReceipts.some(r=>r.operationId===order.operationId))return;this.data.venueReceipts.push({id:`ACK-${order.id}`,operationId:order.operationId,clientOrderId:order.clientOrderId,state:'ACCEPTED',at});this.changed();}
 get totals(){return {cashDelta:sumAmounts(this.data.ledger.map(e=>e.amount)),fees:sumAmounts(this.data.ledger.filter(e=>e.type==='FEE').map(e=>e.amount)),funding:sumAmounts(this.data.ledger.filter(e=>e.type==='FUNDING').map(e=>e.amount))};}
}
