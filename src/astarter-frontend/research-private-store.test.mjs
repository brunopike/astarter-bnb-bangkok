import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createResearchPrivateAdapters,researchCredentialDigest,reserveResearchMicrousd,RESEARCH_PRIVATE_CONTRACT,RESEARCH_AUDIENCE,RESEARCH_SESSION_COOKIE} from './research-private-store.mjs';
import {createResearchAnalysisService} from './research-analysis-service.mjs';

const NOW=Date.UTC(2026,10,16,12),TOKEN='offline_session_fixture_01234567890123456789',CLAIM='offline_claim_fixture_012345678901234567890';
const hash=s=>createHash('sha256').update(s).digest('hex');
const lease=()=>({leaseId:'reviewed-private-lease',targetId:'private-target-branch',database:'private_research',schema:'astarter_private_research',runtimeRole:'research_runtime',audience:RESEARCH_AUDIENCE,budgetId:'services-2026-11',model:'openai/gpt-4.1-mini',expiresAt:NOW+3600000});
const policy=()=>({id:'services-2026-11',from:Date.UTC(2026,10),until:Date.UTC(2026,11),tokenLimit:100000,requestLimit:4,model:'openai/gpt-4.1-mini',limitMicrousd:50000000,fixedServiceMicrousd:0,heldMicrousd:0,spentMicrousd:0,promptMicrousdPerMillion:400000,completionMicrousdPerMillion:1600000,blocked:false});
const session=()=>({subjectId:'real-issuer-fixture-user',tenantId:'real-issuer-fixture-tenant',audience:RESEARCH_AUDIENCE,notBefore:NOW-1000,expiresAt:NOW+7200000,revokedAt:null,permissions:['research:analyze']});
const req=(headers={authorization:'Bearer '+TOKEN})=>({headers});
const identity={subjectId:'real-issuer-fixture-user',scopeId:'real-issuer-fixture-tenant',requestId:'private-request-0001'};
const claimInput=()=>({...identity,fingerprint:hash('same-request'),createdAt:NOW,expiresAt:NOW+1800000,reservedTokens:13056,policy:{id:policy().id,from:policy().from,until:policy().until,tokenLimit:policy().tokenLimit,requestLimit:policy().requestLimit}});

// Protocol fixtures only. Atomicity, persistence and real issuer proof belong to the
// backend DAL integration suite; this double is never exported as a runtime store.
function fixture(){
 const expected=lease(),calls=[],records=new Map();let currentPolicy=policy(),currentSession=session(),actual={...expected,contract:RESEARCH_PRIVATE_CONTRACT,kind:'PRIVATE',now:NOW};
 const key=v=>v.subjectId+':'+v.scopeId+':'+v.requestId;
 const dal={contract:RESEARCH_PRIVATE_CONTRACT,
  async inspectLease(v){calls.push(['inspectLease',v]);return {...actual,policy:currentPolicy};},
  async resolveSession(v){calls.push(['resolveSession',v]);return v.tokenDigest===hash(TOKEN)?currentSession:null;},
  async get(v){calls.push(['get',v]);return records.get(key(v))||null;},
  async claim(v){calls.push(['claim',v]);const previous=records.get(key(v));if(previous)return {acquired:false,record:previous};const record={...v,state:'pending'};records.set(key(v),record);return {acquired:true,claimToken:CLAIM};},
  async finish(v){calls.push(['finish',v]);const record=records.get(key(v));if(!record||record.state!=='pending'||v.claimToken!==CLAIM)throw Error('CAS_CONFLICT');Object.assign(record,v);return record;}
 };
 const adapters=createResearchPrivateAdapters({dal,lease:expected,now:()=>NOW});
 return {dal,adapters,calls,records,setPolicy:p=>{currentPolicy=p;},setSession:s=>{currentSession=s;},setTarget:v=>{actual={...actual,...v};}};
}

test('missing explicit target or incomplete DAL stays closed without construction IO',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.adapters.configured,true);
 for(const options of [{},{dal:f.dal},{dal:f.dal,lease:{...lease(),schema:'public'}},{dal:f.dal,lease:{...lease(),model:'openai/gpt-4.1'}},{dal:f.dal,lease:{...lease(),expiresAt:NOW}},{dal:{...f.dal,claim:undefined},lease:lease()}]){
  const a=createResearchPrivateAdapters({...options,now:()=>NOW});assert.equal(a.configured,false);
  await assert.rejects(()=>a.authorize(req()),{message:'UNCONFIGURED'});
 }
 assert.equal(f.calls.length,0);
});
test('opaque bearer/cookie credentials are hashed and ambiguous, duplicate or preview credentials are rejected',()=>{
 assert.equal(researchCredentialDigest(req()),hash(TOKEN));
 assert.equal(researchCredentialDigest(req({cookie:'other=value; '+RESEARCH_SESSION_COOKIE+'='+TOKEN})),hash(TOKEN));
 for(const request of [req({}),req({authorization:'Bearer short'}),req({authorization:['Bearer '+TOKEN]}),req({authorization:'Bearer '+TOKEN,cookie:RESEARCH_SESSION_COOKIE+'='+TOKEN}),req({cookie:RESEARCH_SESSION_COOKIE+'='+TOKEN+'; '+RESEARCH_SESSION_COOKIE+'='+TOKEN}),req({cookie:'astarter_preview='+TOKEN}),req({cookie:'astarter_wallet='+TOKEN}),req({'x-user-id':identity.subjectId,'x-tenant-id':identity.scopeId}),{...req(),rawHeaders:['Authorization','Bearer '+TOKEN,'Authorization','Bearer '+TOKEN]},req({cookie:RESEARCH_SESSION_COOKIE+'='+TOKEN+'%20'})])assert.throws(()=>researchCredentialDigest(request),{message:'AUTH_REQUIRED'});
});
test('identity, tenant and audience are mapped by the verified session owner, never browser user IDs',async()=>{
 const f=fixture(),p=await f.adapters.authorize(req({authorization:'Bearer '+TOKEN,'x-user-id':'attacker','x-tenant-id':'public'}));
 assert.equal(p.subjectId,identity.subjectId);assert.equal(p.tenantId,identity.scopeId);assert.equal(p.scopeId,identity.scopeId);assert.equal(p.audience,RESEARCH_AUDIENCE);assert.equal(p.expiresAt,lease().expiresAt);assert.ok(Object.isFrozen(p));
 const args=f.calls.find(([k])=>k==='resolveSession')[1];assert.equal(args.tokenDigest,hash(TOKEN));assert.ok(!JSON.stringify(f.calls).includes(TOKEN));
 assert.deepEqual(await f.adapters.admission(p),claimInput().policy);
 await assert.rejects(()=>f.adapters.admission({...p}),{message:'AUTH_REQUIRED'});
});
test('expired, revoked, wrong-audience, wrong-tenant or unprivileged sessions are denied',async()=>{
 for(const patch of [{audience:'public-data'},{tenantId:''},{scopeId:'other-tenant'},{notBefore:NOW+1},{expiresAt:NOW},{revokedAt:NOW-1},{revokedAt:undefined},{permissions:[]},{subjectId:'bad\nidentity'}]){
  const f=fixture();f.setSession({...session(),...patch});await assert.rejects(()=>f.adapters.authorize(req()),{message:'AUTH_REQUIRED'});
  assert.equal(f.calls.filter(([k])=>['get','claim','finish'].includes(k)).length,0);
 }
});
test('database, runtime role, private target, server clock and lease drift fail before accessing records',async()=>{
 for(const patch of [{kind:'PUBLIC'},{targetId:'wrong-branch'},{database:'public_data'},{schema:'public'},{runtimeRole:'reader_role'},{leaseId:'old-lease'},{expiresAt:NOW},{now:NOW-10000},{contract:'OFFLINE_FIXTURE'}]){
  const f=fixture();f.setTarget(patch);await assert.rejects(()=>f.adapters.store.get(identity),{message:'PRIVATE_TARGET_MISMATCH'});assert.equal(f.calls.filter(([k])=>k==='get').length,0);
 }
});
test('monthly policy validates UTC period, total 50 dollar cap, costs, fixed model price and global blocked state',async()=>{
 for(const patch of [{limitMicrousd:50000001},{limitMicrousd:0},{fixedServiceMicrousd:50000001},{heldMicrousd:50000001},{spentMicrousd:50000001},{from:NOW},{until:NOW+1000},{blocked:true},{promptMicrousdPerMillion:400001},{completionMicrousdPerMillion:1600001},{model:'another-model'},{id:'wrong-budget'},{requestLimit:0},{tokenLimit:1}]){
  const f=fixture(),p=await f.adapters.authorize(req());f.setPolicy({...policy(),...patch});await assert.rejects(()=>f.adapters.admission(p),{message:'BUDGET_UNAVAILABLE'});
 }
});
test('fixed-price reservation uses integer ceiling, never floating token cost estimates',()=>{
 assert.equal(reserveResearchMicrousd(),20890);assert.equal(reserveResearchMicrousd(1),2);assert.equal(reserveResearchMicrousd(5),8);assert.equal(reserveResearchMicrousd(0),0);
 for(const value of [-1,1.1,NaN,Infinity,'13056',Number.MAX_SAFE_INTEGER])assert.throws(()=>reserveResearchMicrousd(value),{message:'BUDGET_UNAVAILABLE'});
});
test('claim sends private tenant predicates and exact USD/token reservation to the atomic owner',async()=>{
 const f=fixture(),value=await f.adapters.store.claim(claimInput());assert.deepEqual(value,{acquired:true,claimToken:CLAIM});
 const args=f.calls.find(([k])=>k==='claim')[1];assert.equal(args.tenantId,identity.scopeId);assert.equal(args.subjectId,identity.subjectId);assert.equal(args.reservedMicrousd,20890);assert.equal(args.reservedTokens,13056);assert.equal(args.leaseId,lease().leaseId);assert.equal(args.targetId,lease().targetId);
 assert.equal(args.policy.limitMicrousd,50000000);assert.equal(args.policy.fixedServiceMicrousd,0);
 assert.equal((await f.adapters.store.claim(claimInput())).record.state,'pending');
 const changed=fixture();await assert.rejects(()=>changed.adapters.store.claim({...claimInput(),policy:{...claimInput().policy,requestLimit:999999}}),{message:'BUDGET_UNAVAILABLE'});assert.equal(changed.calls.filter(([k])=>k==='claim').length,0);
});
test('budget rejection and duplicate/conflict outcomes are returned only by the atomic owner',async()=>{
 const f=fixture();f.dal.claim=async()=>({acquired:false,code:'BUDGET_EXCEEDED'});assert.deepEqual(await f.adapters.store.claim(claimInput()),{acquired:false,code:'BUDGET_EXCEEDED'});
 const duplicate=fixture();await duplicate.adapters.store.claim(claimInput());duplicate.setPolicy({...policy(),heldMicrousd:50000000});assert.equal((await duplicate.adapters.store.claim(claimInput())).record.state,'pending');
 const bad=fixture();bad.dal.claim=async()=>({acquired:true,claimToken:'short'});await assert.rejects(()=>bad.adapters.store.claim(claimInput()),{message:'PRIVATE_RECORD_INVALID'});
});
test('get rejects wrong-owner DAL results rather than exposing another tenant report',async()=>{
 const f=fixture();await f.adapters.store.claim(claimInput());const r=await f.adapters.store.get(identity);assert.equal(r.subjectId,identity.subjectId);
 f.dal.get=async()=>({...r,scopeId:'someone-else'});await assert.rejects(()=>f.adapters.store.get(identity),{message:'PRIVATE_RECORD_INVALID'});
});
test('unknown and completed-without-cost outcomes retain USD; known predispatch failures explicitly release zero',async()=>{
 for(const patch of [{state:'unknown',settledTokens:null,error:'MODEL_TIMEOUT',queryOriginalRequest:true},{state:'complete',settledTokens:140,result:{model:lease().model,responseId:'server-receipt',executionAuthority:'NONE',billing:null}},{state:'failed',settledTokens:0,error:'EVIDENCE_UNAVAILABLE'}]){
  const f=fixture();await f.adapters.store.claim(claimInput());await f.adapters.store.finish({...identity,claimToken:CLAIM,...patch});
  const args=f.calls.find(([k])=>k==='finish')[1];assert.equal(args.settledMicrousd,patch.state==='failed'?0:null);assert.equal(args.providerReceipt,null);
 }
});
test('known provider costs remain a separate cost-owner receipt, never an implicit runtime refund',async()=>{
 const f=fixture();await f.adapters.store.claim(claimInput());
 const billing={provider:'openrouter',responseId:'server-receipt',model:lease().model,costMicrousd:104,isByok:false};
 await f.adapters.store.finish({...identity,claimToken:CLAIM,state:'complete',settledTokens:140,result:{model:lease().model,responseId:'server-receipt',executionAuthority:'NONE',billing}});
 const args=f.calls.find(([k])=>k==='finish')[1];assert.deepEqual(args.providerReceipt,billing);assert.equal(args.settledMicrousd,null);
});
test('invalid CAS, premature unknown-release, BYOK/mismatched receipt and trading authority are rejected',async()=>{
 const complete={state:'complete',settledTokens:140,result:{model:lease().model,responseId:'server-receipt',executionAuthority:'NONE',billing:null}};
 for(const patch of [{state:'unknown',settledTokens:0,queryOriginalRequest:true},{state:'failed',settledTokens:null},{state:'pending',settledTokens:null},{...complete,claimToken:'short'},{...complete,result:{...complete.result,executionAuthority:'EXECUTE'}},{...complete,result:{...complete.result,billing:{provider:'openrouter',responseId:'another-receipt',model:lease().model,costMicrousd:1,isByok:false}}},{...complete,result:{...complete.result,billing:{provider:'openrouter',responseId:'server-receipt',model:lease().model,costMicrousd:1,isByok:true}}}]){
  const f=fixture();await f.adapters.store.claim(claimInput());await assert.rejects(()=>f.adapters.store.finish({...identity,claimToken:CLAIM,...patch}));assert.equal(f.calls.filter(([k])=>k==='finish').length,0);
 }
});
test('analysis service composes with private session/admission/store contracts and never grants execution',async()=>{
 const f=fixture();let calls=0;const day=86400,closedAt=Math.floor(NOW/1000/day)*day;
 const service=createResearchAnalysisService({...f.adapters,model:{configured:true,model:lease().model,async generate({sources}){calls++;return {method:'ai',model:lease().model,responseId:'offline-protocol-receipt',usage:{inputTokens:100,outputTokens:40,totalTokens:140},billing:null,output:{outcome:'watch',headline:'Watch the supplied technical evidence',summary:'Other dimensions are unverified.',claims:[{text:'Momentum remains below 70.',evidenceIds:[sources[0].id]}]}};}},loadEvidence:async()=>[{symbol:'BTC',source:'Binance Spot',timezone:'UTC',unit:'USDT',period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299,price:90500,change:1,x:1,y:55,closedAt,sampleAt:closedAt-day,validUntil:closedAt+day,state:'ready',feedState:'snapshot',paused:false}],now:()=>NOW});
 const q={requestId:identity.requestId,symbols:['BTC']},first=await service.analyze(req(),q);assert.equal(first.state,'complete');assert.equal(first.result.executionAuthority,'NONE');assert.equal(first.result.billing,null);assert.equal(first.subjectId,undefined);
 assert.deepEqual(await service.analyze(req(),q),first);assert.equal(calls,1);assert.equal(f.calls.find(([k])=>k==='finish')[1].settledMicrousd,null);
 await assert.rejects(()=>service.analyze(req({'x-user-id':identity.subjectId}),q),{message:'AUTH_REQUIRED'});assert.equal(calls,1);
});
