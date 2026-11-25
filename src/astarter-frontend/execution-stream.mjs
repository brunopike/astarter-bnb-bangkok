// Read-side ordering contract. The transport below is explicitly a local fixture.
const copy=v=>structuredClone(v);
export function executionRunIdentity(data,scope={}){
 const s=data?.session;if(!s?.id)return null;
 const order=data.orders?.find(o=>o.runId===s.id),ticket=s.ticket||{},plan=data.flow?.plans?.find(p=>p.instanceId===s.id);
 const accountId=s.accountId||ticket.accountId||data.accountId||order?.accountId||plan?.accountId||scope.accountId;
 const environment=s.environment||ticket.environment||data.environment||order?.environment||scope.environment;
 const profileId=ticket.profileId||s.profileId||order?.profileId||'cex-spot';
 const source=s.executionKind||s.sourceMode||(s.singleShot?'MANUAL':s.mandateRef?'AI_AUTO':s.strategy?'BOT':null);
 return {runId:s.id,accountId,environment,connectionId:s.connectionId||ticket.connectionId||null,profileId,venueId:s.venueId||ticket.venueId||order?.venueId||plan?.venueId||(profileId.startsWith('cex-')?'binance':null),marketType:s.marketType||order?.marketType||plan?.marketType||(profileId.endsWith('perp')?'PERPETUAL':'SPOT'),market:s.market,instrumentId:s.instrumentId||order?.instrumentId||plan?.instrumentId||null,source,strategyId:s.strategy||null,strategyVersion:s.strategyVersion||s.version||order?.strategyVersion||plan?.strategyVersion||null,planRef:s.planRef||null,mandateRef:s.mandateRef||null};
}
export function executionRunState(data){
 if(!data?.session)return {state:'idle',remaining:0,unknown:false};
 const pending=data.pending,remaining=Math.max(0,Number(data.position?.qty)||0),unknown=pending?.status==='unknown',closing=pending&&(pending.intent==='close'||!pending.intent&&pending.side==='sell');
 if(data.session.endIntent||data.state==='stopped'&&closing)return {state:unknown?'end-unknown':pending?closing?'ending':'end-pending':remaining?data.session.endIntent==='close'?'exit-incomplete':'ended-held':'ended',remaining,unknown};
 if(data.state==='stopped')return {state:remaining?'ended-held':'ended',remaining,unknown};
 if(closing)return {state:unknown?'exit-unknown':'exiting',remaining,unknown};
 return {state:data.state,remaining,unknown};
}
export function runActionError(expected,data,status){
 const actual=executionRunIdentity(data,status?.scope);
 if(!actual||!expected||['runId','accountId','environment'].some(key=>!expected[key]||expected[key]!==actual[key]))return 'RUN_CHANGED';
 if(['connectionId','instrumentId','profileId','strategyVersion'].some(key=>expected[key]!=null&&String(expected[key])!==String(actual[key])))return 'RUN_CHANGED';
 if(status?.scope&&(actual.accountId!==status.scope.accountId||actual.environment!==status.scope.environment))return 'ACCOUNT_CHANGED';
 return null;
}
export function scopeExecutionRecords(data,identity){
 const own=row=>row.accountId===identity.accountId,run=row=>(row.runId||row.instanceId)===identity.runId;
 const orders=(data.orders||[]).filter(row=>own(row)&&run(row)),orderIds=new Set(orders.map(row=>row.id)),f=data.flow||{};
 const plans=(f.plans||[]).filter(row=>own(row)&&run(row)),planIds=new Set(plans.map(row=>row.id));
 const fills=(f.fills||[]).filter(row=>own(row)&&orderIds.has(row.orderId)),fillIds=new Set(fills.map(row=>row.id));
 return {...data,orders,pending:data.pending&&orders.some(row=>row.id===data.pending.id)?data.pending:null,position:data.position&&own(data.position)&&run(data.position)?data.position:null,flow:{...f,plans,fills,signals:(f.signals||[]).filter(row=>own(row)&&run(row)),admissions:(f.admissions||[]).filter(row=>planIds.has(row.planId)),commands:(f.commands||[]).filter(row=>own(row)&&planIds.has(row.planId)),operations:(f.operations||[]).filter(row=>orderIds.has(row.orderId)),reservations:(f.reservations||[]).filter(row=>own(row)&&orderIds.has(row.orderId)),protections:(f.protections||[]).filter(row=>own(row)&&run(row)),ledger:(f.ledger||[]).filter(row=>own(row)&&(orderIds.has(row.orderId)||fillIds.has(row.fillId)))}};
}
export function executionRenderStamp(data,status,review=null){
 const access=status?.access,s=data?.session;
 return JSON.stringify([status?.state,status?.scope,executionRunIdentity(data,status?.scope),status?.generation,access?.code,access?.revision,access?.connectionId,access?.accountId,access?.profileId,access?.trade,access?.wallet,data?.seq,data?.flow?.revision,data?.state,data?.strategyIssue,s?.id,s?.strategyVersion,s?.riskVersion,s?.planRef,s?.mandateRef,s?.endIntent,s?.manualIntervention,s?.awaitingResearch,data?.discovery?.armed,data?.signal?.id,data?.signal?.approval?Math.ceil(data.signal.approval.expiresAt-data.time):null,review?.revision,Boolean(review)]);
}
export const scopeKey=s=>JSON.stringify([s.workspaceId,s.permissionView,s.accountId,s.environment,s.filter]);
export class StreamProjection{
 constructor(scope){this.generation=0;this.switchScope(scope);}
 switchScope(scope){this.scope=copy(scope);this.scopeHash=scopeKey(scope);this.generation++;this.entities={};this.seen=new Set();this.buffer=[];this.lastSequence=0;this.resumeCursor=null;this.listCursor=null;this.snapshotId=null;this.snapshotCursor=null;this.lastSyncedAt=null;this.state='RESNAPSHOTTING';this.reason='读取此范围的完整快照';this.ignored=0;return this.ticket();}
 ticket(){return {generation:this.generation,scopeHash:this.scopeHash};}
 matches(ticket){return ticket.generation===this.generation&&ticket.scopeHash===this.scopeHash;}
 receive(event,ticket=this.ticket()){
  if(!this.matches(ticket)||event.scopeHash!==this.scopeHash){this.ignored++;return false;}
  if(this.state==='DISCONNECTED'||this.state==='STALE')return false;
  if(['RESNAPSHOTTING','REPLAYING'].includes(this.state)){this.buffer.push(copy(event));return false;}
  return this.apply(event);
 }
 apply(event){
  if(this.seen.has(event.eventId)||event.sequence<=this.lastSequence)return false;
  if(event.sequence!==this.lastSequence+1){this.state='STALE';this.reason='订阅事件存在缺口，需要完整快照';this.buffer.push(copy(event));return false;}
  const key=event.entityKey,old=this.entities[key];
  if(!old||event.entity.revision>old.revision)this.entities[key]=copy(event.entity);
  this.seen.add(event.eventId);this.lastSequence=event.sequence;this.resumeCursor=event.cursor;this.lastSyncedAt=event.asOf;return true;
 }
 install(snapshot,ticket){
  if(!this.matches(ticket)||snapshot.scopeHash!==this.scopeHash){this.ignored++;return false;}
  this.entities=copy(snapshot.data);this.lastSequence=snapshot.sequence;this.resumeCursor=snapshot.cursor;this.snapshotCursor=snapshot.cursor;this.snapshotId=snapshot.snapshotId;this.lastSyncedAt=snapshot.asOf;this.seen=new Set(snapshot.eventIds||[]);this.state='REPLAYING';
  const buffered=this.buffer;this.buffer=[];for(const event of buffered.sort((a,b)=>a.sequence-b.sequence)){if(this.state==='STALE')break;this.apply(event);}
  if(this.state!=='STALE'){this.state='LIVE';this.reason='快照及交界事件已补齐';}return this.state==='LIVE';
 }
 fail(ticket,reason='完整快照读取失败，保留上次已确认数据'){if(!this.matches(ticket)){this.ignored++;return false;}this.state='STALE';this.reason=reason;return true;}
 get view(){return {generation:this.generation,scopeHash:this.scopeHash,state:this.state,resumeCursor:this.resumeCursor,listCursor:this.listCursor,snapshotId:this.snapshotId,snapshotCursor:this.snapshotCursor,lastSequence:this.lastSequence,lastSyncedAt:this.lastSyncedAt,reason:this.reason,ignored:this.ignored};}
}
export const DEFAULT_SCOPE={workspaceId:'HIVE-DEMO',permissionView:'LOCAL_FIXTURE',accountId:'SIM-01',environment:'DEMO',filter:'all'};
export class ExecutionFeed{
 constructor(){this.projection=new StreamProjection(DEFAULT_SCOPE);this.sequence=0;this.revision=0;this.history=[];this.latest=null;this.signature='';this.pending=null;this.floor=0;this.clock=0;}
 publish(trade){
  this.clock=trade.time;const signature=JSON.stringify([trade.accessRevision,trade.connections,trade.discovery,trade.signal?.approval?Math.ceil(trade.signal.approval.expiresAt-trade.time):null,trade.seq,trade.position?.markPrice?.toFixed(2),trade.state,trade.signal,trade.pending?.status,trade.flow?.revision,trade.orders.map(o=>[o.id,o.status,o.filled])]);
  if(signature===this.signature)return;this.signature=signature;this.latest=copy(trade);const sequence=++this.sequence;
  const event={eventId:`STREAM-${sequence}`,scopeHash:scopeKey(DEFAULT_SCOPE),sequence,cursor:`stream:${sequence}`,asOf:trade.time,entityKey:'trade',entity:{id:'trade',revision:++this.revision,value:copy(trade)}};
  this.history.push(event);
  if(this.projection.scopeHash!==event.scopeHash)return;
  if(!this.projection.snapshotId&&this.projection.state==='RESNAPSHOTTING'&&!this.pending){this.projection.install(this.snapshot(),this.projection.ticket());return;}
  this.projection.receive(event);
 }
 snapshot(){return {snapshotId:`SNAP-${this.sequence}`,scopeHash:scopeKey(DEFAULT_SCOPE),sequence:this.sequence,cursor:`stream:${this.sequence}`,asOf:this.clock,data:this.latest?{trade:{id:'trade',revision:this.revision,value:copy(this.latest)}}:{},eventIds:this.history.map(e=>e.eventId)};}
 switchScope(patch){this.pending=null;this.projection.switchScope({...this.projection.scope,...patch});if(this.projection.scopeHash===scopeKey(DEFAULT_SCOPE))this.beginRecovery(true);else this.projection.fail(this.projection.ticket(),'此账户或环境尚未接入，没有可回读的账本。');}
 disconnect(){this.projection.state='DISCONNECTED';this.projection.reason='前端订阅已断开，显示上次确认数据；模拟执行及保护继续。';}
 beginRecovery(forceSnapshot=false,fail=false){
  if(this.projection.scopeHash!==scopeKey(DEFAULT_SCOPE)){this.projection.fail(this.projection.ticket(),'当前范围没有连接器；不能用其它账户的快照替代。');return;}
  if(this.pending)return;
  const ticket=this.projection.ticket();
  if(!forceSnapshot&&!fail&&this.projection.lastSequence>=this.floor){this.projection.state='REPLAYING';this.projection.reason='从原订阅游标补齐';this.pending={kind:'replay',ticket,age:0};}
  else{this.projection.state='RESNAPSHOTTING';this.projection.reason='订阅游标失效，读取同范围完整快照';this.pending={kind:'snapshot',ticket,snapshot:this.snapshot(),fail,age:0};}
 }
 tick(dt){if(!this.pending)return;this.pending.age+=dt;if(this.pending.age<.8)return;const p=this.pending;this.pending=null;if(!this.projection.matches(p.ticket))return;if(p.fail){this.projection.fail(p.ticket);return;}if(p.kind==='snapshot'){this.projection.install(p.snapshot,p.ticket);}else{for(const e of this.history.filter(e=>e.sequence>this.projection.lastSequence))this.projection.apply(e);this.projection.buffer=[];if(this.projection.state==='REPLAYING'){this.projection.state='LIVE';this.projection.reason='原订阅游标之后的事件已补齐';}}}
 fault(kind){if(kind==='disconnect')this.disconnect();if(kind==='expired'){this.disconnect();this.floor=this.sequence+1;this.beginRecovery(true);}if(kind==='snapshot-fail'){this.disconnect();this.beginRecovery(true,true);}if(kind==='retry')this.beginRecovery(this.projection.state==='STALE'||this.projection.lastSequence<this.floor);}
 get data(){return this.projection.entities.trade?.value||null;}
 get status(){return {...this.projection.view,source:'LOCAL_FIXTURE',scope:copy(this.projection.scope)};}
}
