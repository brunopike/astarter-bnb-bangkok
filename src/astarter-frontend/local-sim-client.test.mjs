import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalSimClient,localSimStorage,localSimFixture,validLocalSimSnapshot} from './local-sim-client.mjs';

const data=(revision=0,epoch=1)=>({schema:'AstarterLocalSim.v1',mode:'ISOLATED_LOCAL_SIMULATION',fixtureId:'ui-fixture',revision,owner:{epoch,state:'RUNNING',protectionAvailable:true},recovery:{newRiskPaused:false,accountingKnown:true},capabilities:{nativeAccepted:false,realTrading:false,protectionScope:'LOCAL_PROCESS_ONLY'},trade:{cash:1000,totalFees:0,time:revision,orders:[],events:[],botBook:{runs:[]},accountSummary:{fixtureId:'ui-fixture',accountId:'SIM-01',environment:'DEMO',unit:'USDT',cash:1000,available:1000,reserved:0,equity:1000}}});
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
function setup(fetchImpl){const values=new Map([['hive.workspace.sim.v1','original-user-money']]),storage=localSimStorage({getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},'ui-fixture');return {values,storage,client:new LocalSimClient({fixtureId:'ui-fixture',storage,fetchImpl})};}

test('default browser fetch keeps its global receiver',async(t)=>{
 t.mock.method(globalThis,'fetch',async function(){assert.equal(this,globalThis);return reply({ok:true,snapshot:data()});});
 const client=new LocalSimClient({fixtureId:'ui-fixture'});
 assert.ok(await client.refresh());assert.equal(client.state,'LIVE');
});

test('isolated storage never reads or writes the original workspace; invalid mode does not fall back',()=>{
 const {values,storage}=setup();assert.equal(localSimFixture('?page=execution'),null);assert.equal(localSimFixture('?localSim=ui-fixture'),'ui-fixture');assert.throws(()=>localSimFixture('?localSim=../user'));
 assert.equal(storage.getItem('hive.workspace.sim.v1'),null);storage.setItem('hive.workspace.sim.v1','fixture-only');assert.equal(values.get('hive.workspace.sim.v1'),'original-user-money');assert.equal(storage.getItem('hive.workspace.sim.v1'),'fixture-only');
});
test('snapshot scope and capability checks reject foreign money; old responses cannot rewind the projection',()=>{
 const {client}=setup();assert.ok(client.install(data(8,2)));assert.equal(client.install(data(7,2)),false);assert.equal(client.install(data(99,1)),false);assert.equal(client.snapshot.revision,8);
 for(const patch of [{fixtureId:'other'},{capabilities:{realTrading:true}},{trade:{...data().trade,cash:NaN}},{trade:{...data().trade,accountSummary:{...data().trade.accountSummary,fixtureId:'other'}}}])assert.equal(Boolean(validLocalSimSnapshot({...data(),...patch},'ui-fixture')),false);
 assert.throws(()=>client.install({...data(),fixtureId:'other'}));assert.equal(client.snapshot.revision,8);
});
test('accounting completeness must be explicit boolean; false is a valid last-known snapshot',()=>{
 for(const accountingKnown of [undefined,'false',0,null])assert.equal(Boolean(validLocalSimSnapshot({...data(),recovery:{newRiskPaused:false,accountingKnown}},'ui-fixture')),false);
 for(const accountingKnown of [true,false])assert.ok(validLocalSimSnapshot({...data(),recovery:{newRiskPaused:false,accountingKnown}},'ui-fixture'));
});
test('double click shares one POST and applies no optimistic balance; response uses original request identity',async()=>{
 const calls=[];let release;
 const {client,storage}=setup(async(path,init)=>{calls.push([path,init]);return await new Promise(resolve=>{release=resolve;});});client.install(data());
 const first=client.command('create',{plan:{id:'D-1'}},'CREATE-1'),second=client.command('create',{plan:{id:'D-1'}},'CREATE-1');assert.equal(first,second);assert.equal(calls.length,1);assert.equal(client.snapshot.trade.cash,1000);assert.ok(storage.getItem('pending-command'));
 const sent=JSON.parse(calls[0][1].body);assert.deepEqual([sent.ownerEpoch,sent.expectedRevision,sent.requestId],[1,0,'CREATE-1']);
 release(reply({ok:true,receipt:{requestId:'CREATE-1',command:'create',ok:true,requestStatus:'COMMITTED',revision:1,result:{runId:'BOT-1'}},snapshot:data(1)}));assert.equal((await first).requestId,'CREATE-1');assert.equal(client.snapshot.revision,1);assert.equal(storage.getItem('pending-command'),null);
});
test('lost POST response queries the original key; unresolved work survives reload without another POST',async()=>{
 const calls=[];const {client,storage}=setup(async(path)=>{calls.push(path);if(path==='/api/local-sim/commands')throw Error('connection lost');return reply({ok:false,error:'NOT_FOUND'},404);});client.install(data());
 await assert.rejects(client.command('action',{runId:'BOT-1',kind:'cancel'},'CANCEL-1'),e=>e.unknown===true);assert.deepEqual(calls,['/api/local-sim/commands','/api/local-sim/requests/CANCEL-1']);assert.equal(client.snapshot.trade.cash,1000);assert.equal(client.pending.requestId,'CANCEL-1');
 const restored=new LocalSimClient({fixtureId:'ui-fixture',storage,fetchImpl:async(path,init)=>{assert.equal(init.method,undefined);assert.equal(path,'/api/local-sim/requests/CANCEL-1');return reply({ok:true,receipt:{requestId:'CANCEL-1',command:'action',ok:true,requestStatus:'COMMITTED',revision:2,result:{accepted:true}},snapshot:data(2)});}});
 await restored.command('action',{runId:'BOT-1',kind:'cancel'},'CANCEL-1');assert.equal(restored.pending,null);assert.equal(restored.snapshot.revision,2);
});
test('offline reads preserve the last snapshot and cannot create a browser-side fallback order',async()=>{
 let calls=0;const {client}=setup(async()=>{calls++;throw Error('offline');});client.install(data(4));await client.refresh();assert.equal(client.state,'OFFLINE');assert.equal(client.snapshot.revision,4);await assert.rejects(client.command('create',{plan:{}},'NEW'),/LOCAL_SERVICE_UNAVAILABLE/);assert.equal(calls,1);
});
test('unsaved intent prevents transmission and conflicting clicks cannot replace a pending request',async()=>{
 let calls=0;const client=new LocalSimClient({fixtureId:'ui-fixture',storage:{getItem(){return null;},setItem(){throw Error('quota');}},fetchImpl:async()=>{calls++;}});client.install(data());await assert.rejects(client.command('create',{plan:{}},'C1'),/LOCAL_STORAGE_UNAVAILABLE/);assert.equal(calls,0);
 const a=setup(async()=>reply({ok:false,error:'UNKNOWN',queryOriginalRequest:true},503));a.client.install(data());await assert.rejects(a.client.command('action',{runId:'B',kind:'cancel'},'C2'));await assert.rejects(a.client.command('action',{runId:'B',kind:'stop-close'},'C3'),/LOCAL_COMMAND_PENDING/);assert.equal(a.client.pending.requestId,'C2');
});
test('a malformed result remains unresolved until the same key yields a scoped receipt',async()=>{
 const calls=[];const {client}=setup(async(path)=>{calls.push(path);return path.endsWith('/commands')?reply({ok:true,receipt:{requestId:'C1'},snapshot:{...data(1),fixtureId:'foreign'}}):reply({ok:true,receipt:{requestId:'C1',command:'create',ok:true,requestStatus:'COMMITTED',revision:2,result:{runId:'BOT-1'}},snapshot:data(2)});});client.install(data());
 assert.equal((await client.command('create',{plan:{}},'C1')).result.runId,'BOT-1');assert.deepEqual(calls,['/api/local-sim/commands','/api/local-sim/requests/C1']);assert.equal(client.snapshot.revision,2);
});
test('reading a valid snapshot does not erase an unreadable pending-intent barrier',async()=>{
 let calls=0;const client=new LocalSimClient({fixtureId:'ui-fixture',storage:{getItem:()=>'{broken',setItem(){}},fetchImpl:async()=>{calls++;return reply({ok:true,snapshot:data()});}});await client.refresh();assert.equal(client.state,'LIVE');await assert.rejects(client.command('create',{plan:{}},'C1'),/LOCAL_SERVICE_UNAVAILABLE/);assert.equal(calls,1);
});
test('a successful read of a stopped owner is not active protection or permission to post',async()=>{
 let posts=0;const stopped={...data(),owner:{...data().owner,state:'STOPPED',protectionAvailable:false}};
 const {client}=setup(async(path,init)=>{if(init.method==='POST')posts++;return reply({ok:true,snapshot:stopped});});
 await client.refresh();assert.equal(client.state,'OFFLINE');assert.equal(client.snapshot.trade.cash,1000);
 await assert.rejects(client.command('create',{plan:{}},'STOPPED-CREATE'),/LOCAL_SERVICE_UNAVAILABLE/);assert.equal(posts,0);
});
test('invalid receipt status stays unresolved across POST, reload, and original-key recovery',async()=>{
 for(const patch of [{},{requestStatus:'INVALID_STATUS'},{requestStatus:'NOT_ACCEPTED'}])for(const status of [200,422]){
  const calls=[],receipt={requestId:'BAD-STATUS',command:'new-risk',ok:true,revision:1,result:{},...patch};
  const {client,storage}=setup(async(path)=>{calls.push(path);return reply({ok:true,receipt,snapshot:data(1)},path.endsWith('/commands')?status:200);});client.install(data());
  await assert.rejects(client.command('new-risk',{paused:false},'BAD-STATUS'),e=>e.unknown===true);
  assert.equal(client.pending.requestId,'BAD-STATUS');assert.ok(storage.getItem('pending-command'));
  const restored=new LocalSimClient({fixtureId:'ui-fixture',storage,fetchImpl:client.fetch});
  await assert.rejects(restored.recover(),e=>e.unknown===true);assert.equal(restored.pending.requestId,'BAD-STATUS');
  assert.deepEqual(calls,['/api/local-sim/commands','/api/local-sim/requests/BAD-STATUS','/api/local-sim/requests/BAD-STATUS']);
 }
});
test('valid committed failures and known nonacceptance resolve the original request',async()=>{
 for(const requestStatus of ['COMMITTED','NOT_ACCEPTED']){
  const receipt={requestId:'KNOWN-REJECTION',command:'new-risk',ok:false,revision:1,requestStatus,code:'RECONCILIATION_REQUIRED'};
  const {client,storage}=setup(async()=>reply({ok:false,receipt,snapshot:data(1)},422));client.install(data());
  assert.deepEqual(await client.command('new-risk',{paused:false},receipt.requestId),receipt);
  assert.equal(client.pending,null);assert.equal(storage.getItem('pending-command'),null);
 }
});
