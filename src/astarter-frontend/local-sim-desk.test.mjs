import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalSimOwner} from './local-sim-owner.mjs';
import {LocalSimClient,localSimStorage} from './local-sim-client.mjs';
import {createLocalSimDesk} from './local-sim-desk.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {botParameters} from './bot-runtime.mjs';
import {startStrategyWatch,simulationBoundary} from './strategy-journeys.mjs';
import {scopeHeader} from './execution-views.mjs';
import {accessPanel} from './trading-access-view.mjs';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'astarter-local-desk-')),values=new Map([['hive.workspace.sim.v1','original-user-record']]),fixtureId='desk-fixture';
 const storage=localSimStorage({getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},fixtureId);
 let clock=0;const owner=createLocalSimOwner({databasePath:join(dir,'only-fixture.sqlite'),fixtureId,create:true,clock:()=>clock});owner.start();t.after(()=>{owner.close();rmSync(dir,{recursive:true,force:true});});
 const calls=[];let offline=false,lose=false;
 const client=new LocalSimClient({fixtureId,storage,fetchImpl:async(path,init)=>{calls.push(path);if(offline)throw Error('offline');let body;
  if(path.endsWith('/snapshot'))body={ok:true,snapshot:owner.snapshot()};
  else if(path.includes('/requests/'))body=owner.request(decodeURIComponent(path.split('/').at(-1)));
  else{body=owner.dispatch(JSON.parse(init.body));if(lose){lose=false;throw Error('lost response');}}
  return new Response(JSON.stringify(body),{status:body.ok?200:422});}});
 const w=new WorkspaceSim({storage}),desk=createLocalSimDesk({client,workspace:w});
 return {owner,client,w,desk,calls,values,advance:ms=>{clock+=ms;owner._cycle();},setOffline:v=>offline=v,lose:()=>{lose=true;}};
}
async function plan(f){
 await f.client.refresh();assert.equal(await f.desk.recoverAccess('local-resume'),null);
 await f.client.command('prices',{prices:{'BTC/USDT':100000}},'PRICE');
 const d=f.w.createDraft('S02');
 assert.equal(f.w.saveDraft(d.id,{...d,market:'BTC/USDT',amount:100,cap:500,executionRoute:{connectionId:'local-fixture',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''},planVariant:'S02-SIM',botParameters:botParameters('S02',100000)}),null);
 assert.ok(f.w.validateSetup().run);return d;
}
test('original approval uses one service Book; browser polling creates no fills or second cash owner',async t=>{
 const f=fixture(t),d=await plan(f),before=f.owner.snapshot();
 assert.equal(await startStrategyWatch(f.w,f.desk),null);assert.equal(d.botLaunch.status,'started');
 const after=f.owner.snapshot();assert.equal(after.trade.botBook.runs.length,1);assert.equal(after.trade.cash,before.trade.cash-500);
 for(let i=0;i<50;i++)f.desk.tick(.1);await f.client.reading;
 assert.equal(f.owner.snapshot().trade.botBook.runs.length,1);assert.equal(f.values.get('hive.workspace.sim.v1'),'original-user-record');assert.equal(f.w.s.credits,1000);
 assert.equal(await f.desk.botAction(d.botLaunch.runId,'stop-keep'),null);assert.equal(f.owner.snapshot().trade.cash,1000);
});
test('an unresolved exit explains the retained capital and original-order query',async t=>{
 const f=fixture(t),d=await plan(f);assert.equal(await startStrategyWatch(f.w,f.desk),null);
 const before=f.owner.snapshot().trade.accountSummary;
 f.client.command=async()=>({ok:false,code:'RECONCILIATION_REQUIRED'});
 const message=await f.desk.botAction(d.botLaunch.runId,'stop-close');
 assert.match(message,/资金继续保留|Capital stays reserved/);assert.match(message,/查询原订单|query the original order/);
 assert.doesNotMatch(message,/RECONCILIATION_REQUIRED/);assert.deepEqual(f.owner.snapshot().trade.accountSummary,before);
});
test('a committed end stays pending until its original orders reconcile, without reporting failure or completion',async t=>{
 const f=fixture(t),d=await plan(f);assert.equal(await startStrategyWatch(f.w,f.desk),null);
 f.advance(1000);await f.client.refresh();
 const id=d.botLaunch.runId,before=f.desk.snapshot();
 assert.ok(before.botBook.runs.find(run=>run.id===id).orders.some(order=>order.status==='submitted'));
 const result=await f.desk.botAction(id,'stop-keep',{requestId:'END-PENDING-1'});
 assert.equal(result?.pending,true);assert.match(result.message,/正在核对|being reconciled/);
 assert.doesNotMatch(result.message,/查询原订单|query the original order|已结束|has ended/);
 const waiting=f.desk.snapshot(),run=waiting.botBook.runs.find(run=>run.id===id);
 assert.equal(run.status,'stopping');assert.equal(run.endIntent,'keep');
 assert.equal(waiting.accountSummary.reserved,before.accountSummary.reserved);
 for(let i=0;i<3;i++)await f.client.refresh();
 assert.equal(f.owner.snapshot().trade.botBook.actions.filter(action=>action.requestId==='END-PENDING-1').length,1);
 f.advance(300);await f.client.refresh();
 const final=f.desk.snapshot();assert.equal(final.botBook.runs.find(run=>run.id===id).status,'stopped');
 assert.equal(final.accountSummary.reserved,0);assert.equal(final.cash,1000);
 assert.equal(await f.desk.botAction(id,'stop-keep',{requestId:'END-PENDING-1'}),null);
 assert.equal(f.owner.snapshot().trade.botBook.actions.filter(action=>action.requestId==='END-PENDING-1').length,1);
});
test('offline state preserves values and blocks new risk; it never falls back to browser simulation',async t=>{
 const f=fixture(t);await plan(f);const before=f.owner.snapshot();f.setOffline(true);await f.client.refresh();
 assert.equal(f.desk.access().code,'local-service-offline');assert.match(await startStrategyWatch(f.w,f.desk),/本机|local/i);
 assert.deepEqual(f.owner.snapshot(),before);assert.equal(f.desk.snapshot().cash,before.trade.cash);
});
test('explicitly incomplete accounting displays the last confirmed money but blocks new entries',async t=>{
 const f=fixture(t),d=await plan(f),snapshot=structuredClone(f.client.snapshot),calls=f.calls.length;
 snapshot.recovery.accountingKnown=false;f.client.install(snapshot);
 assert.equal(f.desk.access().ready,false);assert.equal(f.desk.access().code,'local-service-offline');
 assert.equal(f.desk.snapshot().cash,snapshot.trade.cash);assert.ok(f.desk.botCreateError(d));assert.equal(f.calls.length,calls);
});
test('lost reply recovers original accepted request without a duplicate allocation',async t=>{
 const f=fixture(t),d=await plan(f);f.lose();assert.equal(await startStrategyWatch(f.w,f.desk),null);
 assert.ok(f.calls.includes('/api/local-sim/requests/'+encodeURIComponent(d.botLaunch.requestId)));assert.equal(f.owner.snapshot().trade.botBook.runs.length,1);assert.equal(f.owner.snapshot().trade.cash,500);
});
test('isolated account controls expose only the bound demo and the actual recovery action',async t=>{
 const f=fixture(t);assert.equal(f.desk.readSnapshot(),null);await f.client.refresh();
 const html=scopeHeader(f.desk.syncStatus());assert.doesNotMatch(html,/value="SIM-02"|<option[^>]*>LIVE|<option[^>]*>PAPER/);assert.match(html,/data-access-action="local-resume"/);
 const panel=accessPanel(f.desk.access());assert.doesNotMatch(panel,/data-connection-open/);assert.match(panel,/本机|local/i);
});
test('a recorded rejection can be recovered as rejected without creating a run',async t=>{
 const f=fixture(t);await f.client.refresh();
 const receipt=await f.client.command('create',{plan:{}},'REJECTED-1');assert.equal(receipt.ok,false);
 assert.equal(receipt.code,'SCOPE_MISMATCH');assert.match(await f.desk.recoverBotLaunch('REJECTED-1'),/SCOPE_MISMATCH/);assert.equal(f.client.pending,null);assert.equal(f.owner.snapshot().trade.botBook.runs.length,0);assert.equal(f.owner.snapshot().trade.cash,1000);
});
test('a regular browser fixture is not mistaken for the service workspace',()=>{
 const status={state:'LIVE',source:'LOCAL_FIXTURE',scope:{permissionView:'LOCAL_FIXTURE',accountId:'SIM-01',environment:'DEMO'},access:{ready:true,code:'ready'}};
 assert.match(scopeHeader(status),/value="SIM-02"/);assert.match(scopeHeader(status),/>LIVE<\/option>/);
 const product=readFileSync(new URL('./product.js',import.meta.url),'utf8'),expression=product.match(/const isolated=([^;]+);/)[1];
 assert.equal(runInNewContext(expression,{desk:{syncStatus:()=>status}}),false);
 assert.equal(runInNewContext(expression,{desk:{syncStatus:()=>({...status,source:'LOCAL_SERVICE'})}}),true);
});
test('stale simulated quotes block new risk without disabling a stop request',async t=>{
 const f=fixture(t),d=await plan(f);assert.equal(await startStrategyWatch(f.w,f.desk),null);
 const quote=f.owner.snapshot().quotes['BTC/USDT'];
 await f.client.command('prices',{prices:{'BTC/USDT':100000},feedMode:'snapshot',clockRef:quote.clockRef,asOfMs:0,validUntilMs:1000},'STALE-PRICE');
 f.advance(2000);await f.client.refresh();assert.equal(f.desk.access().code,'local-price-wait');
 assert.equal(f.desk.parameterQuote({...d.executionRoute,market:d.market}),null);assert.equal(f.desk.access({operation:'control'}).ready,true);
 assert.equal(await f.desk.botAction(d.botLaunch.runId,'stop-keep'),null);assert.equal(f.owner.snapshot().trade.botBook.runs[0].quantity,0);
});
test('a persisted receipt conflict stays visible even when the confirmed ledger is known',async t=>{
 const f=fixture(t);await f.client.refresh();
 const snapshot=structuredClone(f.client.snapshot);Object.assign(snapshot.recovery,{phase:'RECEIPT_CONFLICT',accountingKnown:true,newRiskPaused:true,conflictOrderIds:['ORDER-1'],pendingOrderIds:['ORDER-1']});f.client.install(snapshot);
 assert.equal(f.desk.access().code,'local-receipt-conflict');
 assert.equal(f.desk.access({operation:'control'}).ready,true);
 const panel=accessPanel(f.desk.access());assert.match(panel,/成交记录待核对|Fill records need review/);assert.doesNotMatch(panel,/data-access-action="local-resume"/);
 assert.equal(f.desk.snapshot().localService.recovery.phase,'RECEIPT_CONFLICT');assert.equal(f.desk.snapshot().cash,snapshot.trade.cash);
});
test('creation and approval describe the actual owner lifetime without changing ordinary previews',()=>{
 assert.match(simulationBoundary('LOCAL_SERVICE').notice,/本机服务|local service/i);
 assert.match(simulationBoundary('LOCAL_SERVICE').scope,/仅限本机|local simulation service only/i);
 assert.doesNotMatch(simulationBoundary('LOCAL_SERVICE').notice,/关闭页面|Closing the page/);
 assert.match(simulationBoundary('LOCAL_FIXTURE').notice,/关闭页面|Closing the page/);
 assert.deepEqual(simulationBoundary(undefined),simulationBoundary('LOCAL_FIXTURE'));
});
