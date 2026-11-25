import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {botParameters} from './bot-runtime.mjs';

const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-8,`${x} != ${y}`);
const plan=()=>({id:'OWNER-PLAN',version:1,riskVersion:1,strategy:'S02',planVariant:'S02-SIM',market:'BTC/USDT',environment:'DEMO',executionRoute:{accountId:'SIM-01',connectionId:'local-fixture',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S02',100000),simulationReference:{market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',period:'1H',closedPrice:100000,closedAt:1700000000000,asOf:1700000001000}});
async function fixture(t){
 const {createLocalSimOwner}=await import('./local-sim-owner.mjs');
 const dir=mkdtempSync(join(tmpdir(),'astarter-owner-')),databasePath=join(dir,'fixture.sqlite'),clock={now:0};
 const config={databasePath,fixtureId:'owner-fixture',connectionId:'local-fixture',clock:()=>clock.now};
 const owner=createLocalSimOwner({...config,create:true,seedCash:1000});owner.start();
 t.after(()=>{owner.close();rmSync(dir,{recursive:true,force:true});});return {owner,clock,config,createLocalSimOwner};
}
function dispatch(owner,requestId,command,payload){const s=owner.snapshot();return owner.dispatch({fixtureId:s.fixtureId,ownerEpoch:s.owner.epoch,expectedRevision:s.revision,requestId,command,payload});}
function prepare(owner){assert.ok(dispatch(owner,'ALLOW','new-risk',{enabled:true}).ok);assert.ok(dispatch(owner,'SEED-PRICE','prices',{prices:{'BTC/USDT':100000}}).ok);const out=dispatch(owner,'CREATE','create',{plan:plan()});assert.ok(out.ok,JSON.stringify(out));return out.receipt.result.runId;}
function advance(owner,clock,seconds,price){if(price)assert.ok(dispatch(owner,'PRICE-'+clock.now,'prices',{prices:{'BTC/USDT':price}}).ok);for(let i=0;i<seconds*10;i++){clock.now+=100;owner._cycle();}}

test('one durable original account/book, read-only snapshots, and no double create',async t=>{
 const {owner,clock}=await fixture(t);assert.equal(owner.snapshot().recovery.newRiskPaused,true);
 assert.equal(dispatch(owner,'BEFORE-ALLOW','create',{plan:plan()}).code,'NEW_RISK_PAUSED');
 const id=prepare(owner),before=owner.snapshot();assert.equal(before.trade.cash,500);near(before.trade.accountSummary.cash,1000);near(before.trade.accountSummary.available,500);
 const replay=dispatch(owner,'CREATE','create',{plan:plan()});assert.equal(replay.duplicate,true);assert.equal(replay.receipt.result.runId,id);assert.deepEqual(owner.snapshot(),before);
 assert.equal(dispatch(owner,'CREATE','create',{plan:{...plan(),cap:600}}).code,'REQUEST_CONFLICT');
 for(let i=0;i<20;i++)assert.deepEqual(owner.snapshot(),before);
 advance(owner,clock,3);const after=owner.snapshot();near(after.trade.accountSummary.cash,899.9);near(after.trade.botBook.runs[0].quantity,.001);near(after.trade.accountSummary.available,500);assert.ok(after.stateRevision>before.stateRevision);assert.equal(after.revision,before.revision);
});

test('CAS and namespace reject without changing cash; current owner is exclusive',async t=>{
 const {owner,config,createLocalSimOwner}=await fixture(t);const s=owner.snapshot();
 const input={fixtureId:s.fixtureId,ownerEpoch:s.owner.epoch,expectedRevision:s.revision,requestId:'COMMAND',command:'new-risk',payload:{enabled:true}};
 for(const patch of [{fixtureId:'OTHER'},{ownerEpoch:s.owner.epoch+1},{expectedRevision:99},{ownerEpoch:true},{extra:true}]){assert.equal(owner.dispatch({...input,...patch}).ok,false);assert.deepEqual(owner.snapshot(),s);}
 assert.throws(()=>createLocalSimOwner(config),/OWNER_CONFLICT/);assert.deepEqual(owner.snapshot(),s);
});

test('same-store reopen retains original run, cash, requests and resumes only protection',async t=>{
 const {owner,clock,config,createLocalSimOwner}=await fixture(t);const id=prepare(owner);advance(owner,clock,3);const old=owner.snapshot();owner.close();
 const restarted=createLocalSimOwner(config);t.after(()=>restarted.close());restarted.start();const recovered=restarted.snapshot();
 assert.ok(recovered.owner.epoch>old.owner.epoch);assert.equal(recovered.recovery.newRiskPaused,true);assert.equal(recovered.trade.botBook.runs[0].id,id);near(recovered.trade.cash,500);near(recovered.trade.botBook.runs[0].quantity,.001);
 const original=restarted.request('CREATE');assert.equal(original.receipt.result.runId,id);assert.equal(original.snapshot.trade.botBook.runs.length,1);
 advance(restarted,clock,4,90000);const protectedState=restarted.snapshot();assert.equal(protectedState.trade.botBook.runs[0].status,'stopped');near(protectedState.trade.cash,989.81);assert.equal(protectedState.trade.botBook.runs[0].orders.filter(o=>o.side==='buy').length,1);
});

test('recovery cannot create a missing DB and explicit create cannot replace an old DB',async t=>{
 const {owner,config,createLocalSimOwner}=await fixture(t);assert.throws(()=>createLocalSimOwner({...config,create:true}),/STORE_EXISTS/);
 const missing=join(config.databasePath,'..','missing.sqlite');assert.throws(()=>createLocalSimOwner({...config,databasePath:missing}),/STORE_UNAVAILABLE/);assert.equal(existsSync(missing),false);
 assert.equal(owner.snapshot().trade.cash,1000);
});

test('commit-unknown preserves one persisted result and queries original request after recovery',async t=>{
 const {owner,config,createLocalSimOwner}=await fixture(t);assert.ok(dispatch(owner,'ALLOW','new-risk',{enabled:true}).ok);
 const originalExec=owner._db.exec.bind(owner._db);let injected=false;
 owner._db.exec=sql=>{const out=originalExec(sql);if(sql==='COMMIT'&&!injected){injected=true;throw Error('SYNTHETIC_AFTER_COMMIT');}return out;};
 const out=dispatch(owner,'CREATE','create',{plan:plan()});assert.equal(out.ok,false);assert.equal(out.queryOriginalRequest,true);assert.equal(owner.snapshot().owner.protectionAvailable,false);owner.close();assert.equal(owner.snapshot().recovery.accountingKnown,false);
 const restarted=createLocalSimOwner(config);t.after(()=>restarted.close());restarted.start();const known=restarted.request('CREATE');assert.equal(known.ok,true);assert.equal(known.snapshot.trade.botBook.runs.length,1);near(known.snapshot.trade.cash,500);
 const again=dispatch(restarted,'CREATE','create',{plan:plan()});assert.equal(again.duplicate,true);near(again.snapshot.trade.cash,500);
});

test('before-commit failure rolls back the real DB and does not fabricate a request result',async t=>{
 const {owner,config,createLocalSimOwner}=await fixture(t);assert.ok(dispatch(owner,'ALLOW','new-risk',{enabled:true}).ok);
 const originalExec=owner._db.exec.bind(owner._db);owner._db.exec=sql=>{if(sql==='COMMIT')throw Error('SYNTHETIC_BEFORE_COMMIT');return originalExec(sql);};
 assert.equal(dispatch(owner,'CREATE','create',{plan:plan()}).queryOriginalRequest,true);owner._db.exec=originalExec;owner.close();
 const restarted=createLocalSimOwner(config);t.after(()=>restarted.close());restarted.start();assert.equal(restarted.request('CREATE').code,'REQUEST_NOT_FOUND');near(restarted.snapshot().trade.cash,1000);assert.equal(restarted.snapshot().trade.botBook.runs.length,0);
});

test('close stops the owner timer and never advertises protection while stopped',async t=>{
 const {owner,clock}=await fixture(t);prepare(owner);advance(owner,clock,3);owner.close();const stopped=owner.snapshot();clock.now+=5000;owner._cycle();assert.deepEqual(owner.snapshot(),stopped);assert.equal(stopped.owner.state,'STOPPED');assert.equal(stopped.owner.protectionAvailable,false);assert.equal(dispatch(owner,'NEW','create',{plan:plan()}).ok,false);
});

test('stale snapshot quote never manufactures fills; another asset update cannot refresh it and fresh data resumes protection only',async t=>{
 const {owner,clock}=await fixture(t);prepare(owner);advance(owner,clock,3);
 const stale={prices:{'BTC/USDT':90000},feedMode:'snapshot',clockRef:{kind:'SIM',ref:'owner-fixture',unit:'ms'},asOfMs:0,validUntilMs:1000};
 assert.ok(dispatch(owner,'STALE','prices',stale).ok);
 const before=owner.snapshot();advance(owner,clock,3);const waiting=owner.snapshot();
 assert.ok(waiting.stateRevision>before.stateRevision);assert.ok(waiting.owner.tickCount>before.owner.tickCount);
 assert.equal(waiting.quotes['BTC/USDT'].state,'stale');assert.equal(waiting.quotes['BTC/USDT'].asOfMs,0);
 near(waiting.trade.botBook.runs[0].quantity,.001);assert.equal(waiting.trade.botBook.runs[0].orders.filter(o=>o.side==='sell').length,0);assert.equal(waiting.recovery.newRiskPaused,true);
 assert.ok(dispatch(owner,'OTHER-QUOTE','prices',{prices:{'ETH/USDT':3000},feedMode:'snapshot',clockRef:stale.clockRef,asOfMs:6000,validUntilMs:20000}).ok);advance(owner,clock,1);
 assert.equal(owner.snapshot().quotes['BTC/USDT'].asOfMs,0);assert.equal(owner.snapshot().quotes['BTC/USDT'].state,'stale');
 assert.ok(dispatch(owner,'FRESH','prices',{...stale,asOfMs:7000,validUntilMs:15000}).ok);advance(owner,clock,4);
 assert.equal(owner.snapshot().trade.botBook.runs[0].status,'stopped');near(owner.snapshot().trade.cash,989.81);assert.equal(owner.snapshot().recovery.newRiskPaused,true);
});

test('same-store restart retains original snapshot times and never turns expired data into fresh data',async t=>{
 const {owner,clock,config,createLocalSimOwner}=await fixture(t);prepare(owner);advance(owner,clock,3);
 assert.ok(dispatch(owner,'STALE','prices',{prices:{'BTC/USDT':90000},feedMode:'snapshot',clockRef:{kind:'SIM',ref:'owner-fixture',unit:'ms'},asOfMs:0,validUntilMs:1000}).ok);owner.close();
 const resumed=createLocalSimOwner(config);t.after(()=>resumed.close());resumed.start();advance(resumed,clock,1);
 assert.equal(resumed.snapshot().quotes['BTC/USDT'].asOfMs,0);assert.equal(resumed.snapshot().quotes['BTC/USDT'].state,'stale');near(resumed.snapshot().trade.botBook.runs[0].quantity,.001);
 assert.equal(dispatch(resumed,'NO-AUTO-RISK','new-risk',{enabled:true}).code,'MARKET_NOT_READY');
});

test('definitive revision rejection is queryable and fences a delayed replay of the same logical request',async t=>{
 const {owner}=await fixture(t),s=owner.snapshot();
 const envelope={fixtureId:s.fixtureId,ownerEpoch:s.owner.epoch,expectedRevision:99,requestId:'REJECTED',command:'new-risk',payload:{enabled:true}};
 const rejected=owner.dispatch(envelope);assert.equal(rejected.code,'REVISION_CONFLICT');
 const known=owner.request('REJECTED');assert.equal(known.ok,true);assert.equal(known.receipt.requestStatus,'NOT_ACCEPTED');
 assert.ok(dispatch(owner,'OTHER','new-risk',{enabled:true}).ok);const current=owner.snapshot();
 const late=owner.dispatch({...envelope,expectedRevision:current.revision});assert.equal(late.code,'REVISION_CONFLICT');assert.equal(late.duplicate,true);assert.deepEqual(owner.snapshot(),current);
});

for(const kind of ['stop-close','close-position'])test('accepted current quote marks without advancing before immediate '+kind,async t=>{
 const {owner,clock}=await fixture(t),runId=prepare(owner);advance(owner,clock,3);
 if(kind==='close-position')assert.ok(dispatch(owner,'KEEP-INVENTORY','action',{runId,kind:'stop-keep'}).ok);
 const before=owner.snapshot();
 const priced=dispatch(owner,'NEW-MARK','prices',{prices:{'BTC/USDT':90000}});assert.ok(priced.ok);
 const marked=priced.snapshot;assert.equal(marked.owner.tickCount,before.owner.tickCount);assert.equal(marked.trade.botBook.runs[0].orders.length,before.trade.botBook.runs[0].orders.length);near(marked.trade.accountSummary.cash,before.trade.accountSummary.cash);
 const out=dispatch(owner,'IMMEDIATE-CLOSE','action',{runId,kind});assert.ok(out.ok);assert.equal(out.snapshot.trade.botBook.runs[0].orders.find(row=>row.intent==='close').price,90000);
 advance(owner,clock,4);near(owner.snapshot().trade.cash,989.81);
});

test('final cumulative contradiction persists a risk hold without changing confirmed money across restart',async t=>{
 const {owner,clock,config,createLocalSimOwner}=await fixture(t),runId=prepare(owner);advance(owner,clock,1.5);
 const orderId=owner.snapshot().trade.botBook.runs[0].orders[0].id;
 assert.ok(dispatch(owner,'CANCEL','action',{runId,kind:'cancel',orderId,cancelScenario:'unknown'}).ok);
 const receipt={runId,orderId,eventId:'FINAL',kind:'cancel-final',cumulativeQuantity:'.0005',cumulativeFee:'.05',sequence:10};assert.ok(dispatch(owner,'FINAL','fixture-receipt',receipt).ok);
 const before=owner.snapshot(),bad={...receipt,eventId:'CONTRADICTION',kind:'partial',cumulativeQuantity:'.0008',cumulativeFee:'.08',sequence:11};
 assert.equal(dispatch(owner,'CONTRADICTION','fixture-receipt',bad).code,'RECEIPT_CONFLICT');const held=owner.snapshot();
 near(held.trade.accountSummary.cash,before.trade.accountSummary.cash);near(held.trade.botBook.runs[0].quantity,before.trade.botBook.runs[0].quantity);near(held.trade.botBook.runs[0].fees,before.trade.botBook.runs[0].fees);
 assert.equal(held.recovery.phase,'RECEIPT_CONFLICT');assert.deepEqual(held.recovery.conflictOrderIds,[orderId]);assert.equal(held.recovery.newRiskPaused,true);assert.equal(held.recovery.accountingKnown,true);assert.equal(dispatch(owner,'FORBID-ENABLE','new-risk',{enabled:true}).code,'RECONCILIATION_REQUIRED');
 const conflictCount=held.trade.botBook.residentControl.receiptConflicts.length;assert.equal(dispatch(owner,'SAME-CONTRADICTION','fixture-receipt',bad).code,'RECEIPT_CONFLICT');assert.equal(owner.snapshot().trade.botBook.residentControl.receiptConflicts.length,conflictCount);
 owner.close();const reopened=createLocalSimOwner(config);t.after(()=>reopened.close());reopened.start();const restored=reopened.snapshot();assert.equal(restored.recovery.phase,'RECEIPT_CONFLICT');assert.deepEqual(restored.recovery.conflictOrderIds,[orderId]);assert.equal(dispatch(reopened,'STILL-FORBID','new-risk',{enabled:true}).code,'RECONCILIATION_REQUIRED');near(restored.trade.accountSummary.cash,before.trade.accountSummary.cash);
});

test('real owner process ticks without a browser and a new PID restores the same ledger for protection only',{timeout:15000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'astarter-owner-process-')),databasePath=join(dir,'fixture.sqlite'),children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}rmSync(dir,{recursive:true,force:true});});
 const moduleUrl=new URL('./local-sim-owner.mjs',import.meta.url).href;
 async function launch(create){
  const code=`import {createLocalSimOwner} from ${JSON.stringify(moduleUrl)};const owner=createLocalSimOwner(${JSON.stringify({databasePath,fixtureId:'owner-process-fixture',create,seedCash:1000})});owner.start();process.on('message',({id,operation,input})=>{const result=operation==='dispatch'?owner.dispatch(input):operation==='request'?owner.request(input):owner.snapshot();process.send({id,result});});process.on('SIGTERM',()=>{owner.close();process.exit(0);});process.send({id:'READY',result:owner.snapshot()});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);
  const waiting=new Map();let errors='';child.stderr.on('data',data=>{errors=(errors+data.toString()).slice(-2000);});
  child.on('message',message=>{const pending=waiting.get(message.id);if(pending){waiting.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.result);}});
  child.on('exit',()=>{for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(Error('CHILD_EXIT '+errors));}waiting.clear();});
  function read(id,operation,input){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(Error('CHILD_TIMEOUT '+errors));},5000);waiting.set(id,{resolve,reject,timer});if(operation)child.send({id,operation,input});});}
  let sequence=0;const ready=await read('READY');
  return {child,ready,read:()=>read('READ-'+(++sequence),'snapshot'),request:key=>read('REQ-'+(++sequence),'request',key),command:async(requestId,command,payload)=>{const s=await read('READ-'+(++sequence),'snapshot');return read('CMD-'+(++sequence),'dispatch',{fixtureId:s.fixtureId,ownerEpoch:s.owner.epoch,expectedRevision:s.revision,requestId,command,payload});}};
 }
 async function until(worker,predicate){const end=Date.now()+5000;while(Date.now()<end){const state=await worker.read();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('resident timer did not reach the expected state');}
 const first=await launch(true);assert.notEqual(first.ready.owner.pid,process.pid);
 assert.ok((await first.command('ALLOW','new-risk',{enabled:true})).ok);assert.ok((await first.command('PRICE','prices',{prices:{'BTC/USDT':100000}})).ok);
 const created=await first.command('CREATE','create',{plan:plan()});assert.ok(created.ok);const runId=created.receipt.result.runId;
 const filled=await until(first,s=>s.trade.botBook.runs[0].quantity===.001);assert.ok(filled.owner.tickCount>0);near(filled.trade.cash,500);
 first.child.kill('SIGKILL');await new Promise(resolve=>first.child.once('exit',resolve));
 const second=await launch(false);assert.notEqual(second.ready.owner.pid,first.ready.owner.pid);assert.ok(second.ready.owner.epoch>first.ready.owner.epoch);assert.equal(second.ready.recovery.newRiskPaused,true);
 assert.equal(second.ready.trade.botBook.runs[0].id,runId);near(second.ready.trade.botBook.runs[0].quantity,.001);
 assert.equal((await second.request('CREATE')).receipt.result.runId,runId);assert.ok((await second.command('CREATE','create',{plan:plan()})).duplicate);
 assert.ok((await second.command('STOP-PRICE','prices',{prices:{'BTC/USDT':90000}})).ok);
 const protectedState=await until(second,s=>s.trade.botBook.runs[0].status==='stopped');near(protectedState.trade.cash,989.81);assert.equal(protectedState.trade.botBook.runs.length,1);assert.equal(protectedState.trade.botBook.runs[0].orders.filter(o=>o.side==='buy').length,1);
});
