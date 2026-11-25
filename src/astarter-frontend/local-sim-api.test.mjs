import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSimOwner} from './local-sim-owner.mjs';
import {botParameters} from './bot-runtime.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'astarter-api-')),owner=createLocalSimOwner({databasePath:join(dir,'fixture.sqlite'),fixtureId:'api-fixture',create:true,clock:()=>0});owner.start();
 t.after(()=>{owner.close();rmSync(dir,{recursive:true,force:true});});
 const {createLocalSimHandler}=await import('./local-sim-api.mjs');let handler;
 const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 handler=createLocalSimHandler({owner,origin});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const request=async(path,options={})=>{const res=await fetch(origin+'/api/local-sim'+path,{...options,headers:{Origin:origin,...options.headers}});return {status:res.status,body:await res.json()};};
 const envelope=(requestId,command,payload)=>{const s=owner.snapshot();return {fixtureId:s.fixtureId,ownerEpoch:s.owner.epoch,expectedRevision:s.revision,requestId,command,payload};};
 const post=body=>request('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {owner,origin,request,envelope,post};
}
const plan=()=>({id:'API-PLAN',version:1,riskVersion:1,strategy:'S02',planVariant:'S02-SIM',market:'BTC/USDT',environment:'DEMO',executionRoute:{accountId:'SIM-01',connectionId:'local-fixture',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S02',100000)});

test('GET snapshots and missing request lookup do not advance the owner or create work',async t=>{
 const {owner,request}=await fixture(t);const before=owner.snapshot();
 for(let i=0;i<5;i++){const out=await request('/snapshot');assert.equal(out.status,200);assert.deepEqual(out.body.snapshot,before);}
 const missing=await request('/requests/ABSENT');assert.equal(missing.status,404);assert.equal(missing.body.code,'REQUEST_NOT_FOUND');assert.deepEqual(owner.snapshot(),before);
});

test('HTTP create is acknowledged once and request lookup returns immutable receipt with current snapshot',async t=>{
 const {owner,request,envelope,post}=await fixture(t);
 assert.equal((await post(envelope('ALLOW','new-risk',{enabled:true}))).status,200);
 const command=envelope('CREATE','create',{plan:plan()}),first=await post(command);assert.equal(first.status,200);assert.equal(first.body.receipt.requestId,'CREATE');assert.ok(first.body.receipt.result.runId);
 const replay=await post(command);assert.equal(replay.status,200);assert.equal(replay.body.duplicate,true);assert.deepEqual(replay.body.receipt,first.body.receipt);assert.equal(owner.snapshot().trade.cash,500);assert.equal(owner.snapshot().trade.botBook.runs.length,1);
 const known=await request('/requests/CREATE');assert.equal(known.status,200);assert.deepEqual(known.body.receipt,first.body.receipt);
 assert.equal((await post({...command,payload:{plan:{...plan(),cap:600}}})).status,409);
});

test('wrong origin, host or fixture cannot read private snapshot or mutate the isolated owner',async t=>{
 const {owner,origin,request,envelope,post}=await fixture(t);const before=owner.snapshot();
 const badOrigin=await request('/snapshot',{headers:{Origin:'https://outside.invalid'}});assert.equal(badOrigin.status,403);assert.equal(badOrigin.body.snapshot,undefined);
 const cross=await request('/snapshot',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(cross.status,403);
 // fetch normalizes Host; use real HTTP bytes to exercise the rebinding guard.
 const host=await new Promise((resolve,reject)=>{const req=httpRequest(origin+'/api/local-sim/snapshot',{headers:{Host:'outside.invalid',Origin:origin}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(host,403);
 const scope=await post({...envelope('SCOPE','new-risk',{enabled:true}),fixtureId:'OTHER'});assert.equal(scope.status,403);assert.equal(scope.body.snapshot,undefined);assert.deepEqual(owner.snapshot(),before);
});

test('stale command revision and epoch return conflict without replacing the current account',async t=>{
 const {owner,envelope,post}=await fixture(t);const before=owner.snapshot();
 const badRevision=await post({...envelope('STALE','new-risk',{enabled:true}),expectedRevision:99});assert.equal(badRevision.status,409);assert.equal(badRevision.body.snapshot.revision,before.revision);
 const badEpoch=await post({...envelope('FENCE','new-risk',{enabled:true}),ownerEpoch:99});assert.equal(badEpoch.status,409);
 assert.equal((await post({...envelope('TYPE','new-risk',{enabled:true}),ownerEpoch:true})).status,400);assert.deepEqual(owner.snapshot(),before);
});

test('body size, JSON, method and closed command fields are bounded before execution',async t=>{
 const {owner,request,envelope,post}=await fixture(t);const before=owner.snapshot();
 assert.equal((await request('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(65537)})).status,413);
 assert.equal((await request('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
 assert.equal((await request('/commands',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await request('/snapshot',{method:'DELETE'})).status,405);
 assert.equal((await post({...envelope('EXTRA','new-risk',{enabled:true}),databasePath:'/not/an/input'})).status,400);assert.deepEqual(owner.snapshot(),before);
});

test('commit-unknown HTTP result preserves original request recovery and never reports healthy protection',async t=>{
 const {owner,request,envelope,post}=await fixture(t);const execute=owner._db.exec.bind(owner._db);let fail=true;
 owner._db.exec=sql=>{const result=execute(sql);if(sql==='COMMIT'&&fail){fail=false;throw Error('SYNTHETIC_COMMIT_UNKNOWN');}return result;};
 const out=await post(envelope('UNKNOWN','new-risk',{enabled:true}));assert.equal(out.status,503);assert.equal(out.body.queryOriginalRequest,true);assert.equal(out.body.snapshot.recovery.accountingKnown,false);assert.equal(out.body.snapshot.owner.protectionAvailable,false);
 const known=await request('/requests/UNKNOWN');assert.equal(known.status,200);assert.equal(known.body.receipt.requestId,'UNKNOWN');assert.equal(known.body.snapshot.owner.state,'FAILED');
});

test('deep invalid JSON is rejected without stopping protection or accepting a request',async t=>{
 const {owner,request,envelope,post}=await fixture(t),before=owner.snapshot(),input=envelope('DEEP','new-risk',{enabled:true});
 const head=JSON.stringify(input).slice(0,-2),body=head+',"extra":'+'['.repeat(8000)+'0'+']'.repeat(8000)+'}}';assert.ok(Buffer.byteLength(body)<65536);
 const out=await request('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(out.status,400);assert.equal(out.body.code,'COMMAND_INVALID');assert.deepEqual(owner.snapshot(),before);assert.equal(owner.request('DEEP').code,'REQUEST_NOT_FOUND');assert.equal(owner.snapshot().owner.state,'RUNNING');assert.ok((await post(envelope('AFTER-DEEP','new-risk',{enabled:true}))).body.ok);
});

test('unexpected dispatch exceptions stay inside the HTTP response boundary',async t=>{
 const {owner,envelope,post,request}=await fixture(t),original=owner.dispatch.bind(owner);owner.dispatch=()=>{throw Error('SYNTHETIC_BOUNDARY_EXCEPTION');};
 const out=await post(envelope('UNEXPECTED','new-risk',{enabled:true}));assert.equal(out.status,503);assert.equal(out.body.code,'OUTCOME_UNKNOWN_QUERY');assert.equal(out.body.queryOriginalRequest,true);owner.dispatch=original;assert.equal((await request('/snapshot')).status,200);
});
