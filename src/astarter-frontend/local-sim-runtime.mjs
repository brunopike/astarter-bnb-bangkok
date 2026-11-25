import {createHash} from 'node:crypto';
import {BotBook} from './bot-runtime.mjs';
import {decimal} from './execution-records.mjs';

const clone=value=>structuredClone(value);
const plain=value=>typeof value==='object'&&value!==null&&Object.getPrototypeOf(value)===Object.prototype;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const open=order=>['submitted','partial','unknown'].includes(order.status);
const ended=run=>['stopped','failed'].includes(run.status);
const unresolved=row=>row.state!=='RECONCILED';
const failure=code=>({code,error:code});
const canonical=value=>JSON.stringify(value,(_,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
function units(value){
 if(typeof value!=='string'||value.length>64||! /^(?:\d+(?:\.\d{1,12})?|\.\d{1,12})$/.test(value))throw Error('RECEIPT_INVALID');
 const [whole,fraction='']=value.split('.');return BigInt(whole||'0')*10n**12n+BigInt(fraction.padEnd(12,'0'));
}
const kinds=['partial','filled','cancel-unknown','cancel-ack','cancel-final'];

// Only the local fixture's control protocol changes; the original Book owns all money and fills.
export class ResidentBotBook extends BotBook{
 constructor({fixtureId,state,marketReady,...options}={}){
  if(!id(fixtureId))throw Error('FIXTURE_SCOPE_INVALID');
  super(options);
  this.fixtureId=fixtureId;
  if(marketReady!==undefined&&typeof marketReady!=='function')throw Error('MARKET_GATE_INVALID');
  this.marketReady=marketReady;
  this.control={version:1,fixtureId,cancelRequests:[],receipts:[],receiptDrivenOrderIds:[],finals:[],receiptConflicts:[]};
  if(state!==undefined){
   if(!plain(state))throw Error('LOCAL_BOOK_INVALID');
   const saved=state.residentControl;
   if(saved!==undefined&&(!keys(saved,['version','fixtureId','cancelRequests','receipts','receiptDrivenOrderIds','finals','receiptConflicts'])||saved.version!==1||saved.fixtureId!==fixtureId||!['cancelRequests','receipts','receiptDrivenOrderIds','finals'].every(k=>Array.isArray(saved[k])&&saved[k].length<=10000)||saved.receiptConflicts!==undefined&&(!Array.isArray(saved.receiptConflicts)||saved.receiptConflicts.length>10000)))throw Error('LOCAL_CONTROL_INVALID');
   if(!super.restore(state))throw Error('LOCAL_BOOK_INVALID');
   if(saved!==undefined){this.control={...clone(saved),receiptConflicts:clone(saved.receiptConflicts??[])};this._validateControl();}
  }
 }
 snapshot(){return {...super.snapshot(),residentControl:clone(this.control)};}
 _validateControl(){
  const orders=this.s.runs.flatMap(run=>run.orders),seen=new Set();
  for(const row of this.control.cancelRequests){
   const order=orders.find(o=>o.id===row.orderId);
   if(!plain(row)||!order||order.runId!==row.runId||!id(row.id)||!id(row.requestId)||seen.has(row.orderId)||!['PENDING','UNKNOWN','ACKNOWLEDGED','RECONCILED'].includes(row.state)||!['normal','unknown'].includes(row.scenario)||!Number.isFinite(row.at)||row.at<0||row.at>this.s.time||row.state==='RECONCILED'&&open(order))throw Error('LOCAL_CONTROL_INVALID');
   seen.add(row.orderId);
  }
  seen.clear();
  for(const row of [...this.control.receipts,...this.control.receiptConflicts]){
   const order=orders.find(o=>o.id===row.orderId);
   if(!plain(row)||!order||row.runId!==order.runId||!id(row.eventId)||seen.has(row.eventId)||! /^[a-f0-9]{64}$/.test(row.hash)||!kinds.includes(row.kind)||!Number.isSafeInteger(row.sequence)||row.sequence<0||!['HTTP_FIXTURE','SERVICE_FIXTURE'].includes(row.source)||units(row.cumulativeQuantity)>units(decimal(order.qty))||units(row.cumulativeFee)!==units(decimal(Number(row.cumulativeQuantity)*order.price*order.feeRate)))throw Error('LOCAL_CONTROL_INVALID');
   seen.add(row.eventId);
  }
  for(const row of this.control.receiptConflicts){
   const order=orders.find(o=>o.id===row.orderId);
   if(open(order)||units(row.cumulativeQuantity)<=units(decimal(order.qty*order.filled)))throw Error('LOCAL_CONTROL_INVALID');
  }
  if(new Set(this.control.receiptDrivenOrderIds).size!==this.control.receiptDrivenOrderIds.length||this.control.receiptDrivenOrderIds.some(key=>!orders.some(o=>o.id===key)))throw Error('LOCAL_CONTROL_INVALID');
  seen.clear();
  for(const row of this.control.finals){
   const order=orders.find(o=>o.id===row.orderId);
   if(!order||seen.has(row.orderId)||open(order)||units(row.quantity)!==units(decimal(order.qty*order.filled)))throw Error('LOCAL_CONTROL_INVALID');
   seen.add(row.orderId);
  }
 }
 resumeProtection(){
  for(const run of this.s.runs)if(!ended(run)){
   run.status=run.endIntent?'stopping':'paused';
   this._event(run,'recovery-verified','原订单与资金核对后继续保护，新增买入仍暂停。');
  }
  this._changed();return this.snapshot();
 }
 action(runId,kind,options={}){
  if(kind==='reconcile')return failure('FIXTURE_RECEIPT_REQUIRED');
  if(kind!=='cancel')return super.action(runId,kind,options);
  const run=this._run(runId);
  if(!run)return failure('RUN_NOT_FOUND');
  if(!keys(options,['requestId','orderId','expectedAccountId','expectedConnectionId','cancelScenario'])||!id(options.requestId)||!id(options.orderId)||options.cancelScenario!==undefined&&!['normal','unknown'].includes(options.cancelScenario))return failure('PLAN_INVALID');
  const route=run.plan.executionRoute;
  if(options.expectedAccountId!==undefined&&options.expectedAccountId!==route.accountId||options.expectedConnectionId!==undefined&&options.expectedConnectionId!==route.connectionId)return failure('SCOPE_MISMATCH');
  const payload=canonical({...options,runId,kind}),prior=this.s.actions.find(row=>row.requestId===options.requestId);
  if(prior)return prior.payload===payload?{duplicate:true,run:clone(run)}:failure('REQUEST_CONFLICT');
  if(this.s.requests.some(row=>row.requestId===options.requestId))return failure('REQUEST_CONFLICT');
  const order=run.orders.find(row=>row.id===options.orderId);
  if(!order)return failure('ORDER_NOT_FOUND');
  this.currentCancelOptions=options;
  try{if(open(order))this._cancel(order);}finally{this.currentCancelOptions=null;}
  if(!ended(run)&&!run.endIntent)run.status='paused';
  this.s.actions.push({requestId:options.requestId,payload,runId,kind,at:this.s.time});
  this._sync(run);this._changed();return {run:clone(run)};
 }
 _cancel(order){
  if(!open(order))return;
  const existing=this.control.cancelRequests.find(row=>row.orderId===order.id);
  if(existing)return;
  const run=this._run(order.runId),options=this.currentCancelOptions;
  this.control.cancelRequests.push({id:this._id('BOT-CANCEL'),runId:run.id,orderId:order.id,requestId:options?.requestId||'AUTO-CANCEL-'+order.id,state:'PENDING',scenario:options?.cancelScenario||(order.status==='unknown'?'unknown':'normal'),at:this.s.time});
  this.records.orderState(order,'CANCEL_PENDING');
  this._event(run,'cancel-pending','撤单请求已记录，余量资金等待原单回执核对。');
 }
 _process(run,order){
  const cancel=this.control.cancelRequests.find(row=>row.orderId===order.id&&unresolved(row));
  if(cancel){
   if(cancel.scenario==='normal'){
    const age=this.s.time-cancel.at;
    const kind=age>=.2-1e-9?'cancel-final':age>=.1-1e-9&&cancel.state==='PENDING'?'cancel-ack':null;
    const sequence=1+Math.max(0,...this.control.receipts.filter(row=>row.orderId===order.id).map(row=>row.sequence));
    if(kind)this.receiveReceipt({runId:run.id,orderId:order.id,eventId:`SERVICE-${cancel.id}-${kind}`,kind,cumulativeQuantity:decimal(order.qty*order.filled),cumulativeFee:decimal(order.fee),sequence},{source:'SERVICE_FIXTURE'});
   }
   return;
  }
  if(this.control.receiptDrivenOrderIds.includes(order.id))return;
  super._process(run,order);
 }
 _marketReady(run){try{return this.marketReady===undefined||this.marketReady(run.plan.market)===true;}catch{return false;}}
 _inventoryDisputed(run){return this.control.receiptConflicts.some(row=>row.runId===run.id&&run.orders.find(order=>order.id===row.orderId)?.side==='sell');}
 _advance(run){
  const ready=this._marketReady(run);
  if(!ready||this._inventoryDisputed(run)){
   if(!ready){run.priceQuality='stale';run.priceSource='STALE_LOCAL_FIXTURE';}
   for(const order of run.orders.filter(open))if(this.control.cancelRequests.some(row=>row.orderId===order.id&&unresolved(row)))this._process(run,order);
   return;
  }
  run.priceQuality='fresh';super._advance(run);
 }
 receiveReceipt(value,{source='HTTP_FIXTURE'}={}){
  let receipt,quantity;
  try{
   if(!keys(value,['runId','orderId','eventId','kind','cumulativeQuantity','cumulativeFee','sequence'])||!['runId','orderId','eventId'].every(k=>id(value[k]))||!kinds.includes(value.kind)||!Number.isSafeInteger(value.sequence)||value.sequence<0||!['HTTP_FIXTURE','SERVICE_FIXTURE'].includes(source))return failure('RECEIPT_INVALID');
   quantity=units(value.cumulativeQuantity);units(value.cumulativeFee);
   receipt={...value,cumulativeQuantity:decimal(Number(value.cumulativeQuantity)),cumulativeFee:decimal(Number(value.cumulativeFee))};
   if(units(receipt.cumulativeQuantity)!==quantity)return failure('RECEIPT_INVALID');
  }catch{return failure('RECEIPT_INVALID');}
  const run=this._run(receipt.runId),order=run?.orders.find(row=>row.id===receipt.orderId);
  if(!order)return failure('RECEIPT_SCOPE_MISMATCH');
  if(quantity>units(decimal(order.qty))||units(receipt.cumulativeFee)!==units(decimal(Number(receipt.cumulativeQuantity)*order.price*order.feeRate))||receipt.kind==='filled'&&quantity!==units(decimal(order.qty)))return failure('RECEIPT_INVALID');
  const receiptHash=hash(receipt),conflict=this.control.receiptConflicts.find(row=>row.eventId===receipt.eventId);
  if(conflict)return failure('RECEIPT_CONFLICT');
  const prior=this.control.receipts.find(row=>row.eventId===receipt.eventId);
  if(prior)return prior.hash===receiptHash?{duplicate:true,run:clone(run)}:failure('RECEIPT_CONFLICT');
  const cancel=this.control.cancelRequests.find(row=>row.orderId===order.id);
  if(receipt.kind.startsWith('cancel-')&&!cancel)return failure('CANCEL_REQUEST_REQUIRED');
  const oldQuantity=units(decimal(order.qty*order.filled)),final=this.control.finals.find(row=>row.orderId===order.id);
  if((final||['filled','rejected','cancelled','partial-cancelled'].includes(order.status))&&quantity>oldQuantity){
   this.control.receiptConflicts.push({...receipt,hash:receiptHash,source});this._event(run,'receipt-conflict','最终累计与新回执矛盾，保留确认账本并暂停新增，等待人工核对。');this._changed();return failure('RECEIPT_CONFLICT');
  }
  if(quantity>oldQuantity&&order.side==='sell'&&this._inventoryDisputed(run))return failure('RECONCILIATION_REQUIRED');
  if(quantity>oldQuantity){
   const recordFill=this.records.recordFill,key=hash({fixtureId:this.fixtureId,orderId:order.id,eventId:receipt.eventId});
   this.records.recordFill=(row,ratio,at)=>recordFill.call(this.records,row,ratio,at,key);
   try{super._fill(run,order,Number(receipt.cumulativeQuantity)/order.qty);}finally{this.records.recordFill=recordFill;}
   if(units(decimal(order.qty*order.filled))!==quantity)throw Error('LOCAL_FILL_NOT_APPLIED');
  }
  if(!this.control.receiptDrivenOrderIds.includes(order.id))this.control.receiptDrivenOrderIds.push(order.id);
  const latestSequence=Math.max(-1,...this.control.receipts.filter(row=>row.orderId===order.id).map(row=>row.sequence));
  const stale=quantity<oldQuantity||Boolean(final)||receipt.sequence<=latestSequence;
  // A late event may prove more fills without being allowed to roll control state back.
  if(!stale||!final&&quantity===units(decimal(order.qty))){
   if(receipt.kind==='cancel-unknown'){cancel.state='UNKNOWN';cancel.scenario='unknown';this.records.orderState(order,'CANCEL_UNKNOWN');}
   if(receipt.kind==='cancel-ack'){cancel.state='ACKNOWLEDGED';this.records.orderState(order,'CANCEL_ACK_RECONCILING');}
   if(receipt.kind==='cancel-final'||quantity===units(decimal(order.qty))){
    super._terminal(order,quantity===units(decimal(order.qty))?'filled':quantity>0n?'partial-cancelled':'cancelled');
    if(cancel)cancel.state='RECONCILED';
    this.control.finals.push({orderId:order.id,quantity:decimal(order.qty*order.filled)});
   }
  }
  this.control.receipts.push({...receipt,hash:receiptHash,source});
  this.flow.venueReceipts.push({id:`ACK-LOCAL-${receiptHash}x`,operationId:order.operationId,source:'CONTROLLED_LOCAL_FIXTURE_ONLY',eventId:receipt.eventId,state:receipt.kind,cumulativeQuantity:receipt.cumulativeQuantity,cumulativeFee:receipt.cumulativeFee,at:this.s.time});
  if(!ended(run))run.status=run.endIntent?'stopping':'paused';
  if(run.endIntent)this._finishEnd(run);
  this._sync(run);this._changed();return {run:clone(run),ignoredStale:stale};
 }
 _finishEnd(run){
  const closing=run.orders.find(order=>open(order)&&order.intent==='close');
  for(const order of run.orders.filter(order=>open(order)&&order!==closing))this._cancel(order);
  if(run.endIntent==='keep'&&closing)this._cancel(closing);
  if(this._inventoryDisputed(run)){run.status='stopping';return 'RECONCILIATION_REQUIRED';}
  const pending=this.control.cancelRequests.filter(row=>row.runId===run.id&&unresolved(row));
  if(run.endIntent==='keep'){
   if(pending.length){run.status='stopping';return 'RECONCILIATION_REQUIRED';}
   return super._finishEnd(run);
  }
  if(closing||pending.some(row=>run.orders.find(order=>order.id===row.orderId).side==='sell')){run.status='stopping';return 'RECONCILIATION_REQUIRED';}
  const quantity=this._quantity(run);
  if(quantity>1e-12){
   if(!this._marketReady(run)){run.status='stopping';return 'MARKET_NOT_READY';}
   run.status='stopping';this._submit(run,'sell',run.markPrice,quantity,{lotIds:run.lots.filter(lot=>lot.qty>1e-12).map(lot=>lot.id),intent:'close'});return;
  }
  if(pending.length){run.status='stopping';return 'RECONCILIATION_REQUIRED';}
  return super._finishEnd(run);
 }
 _release(run){
  if(this.control.cancelRequests.some(row=>row.runId===run.id&&unresolved(row))||this.control.receiptConflicts.some(row=>row.runId===run.id)||run.orders.some(order=>order.status==='unknown'))return 'RECONCILIATION_REQUIRED';
  return super._release(run);
 }
}
