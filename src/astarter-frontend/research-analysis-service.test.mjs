import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createResearchAnalysisModel,createResearchAnalysisService,createResearchAnalysisHandler,validateResearchEvidence,validateResearchOutput,researchCostMicrousd,RESEARCH_MODEL_LIMITS} from './research-analysis-service.mjs';

const NOW=Date.UTC(2026,10,16,12),DAY=86400;
const row=(symbol='BTC',patch={})=>({symbol,source:'Binance Spot',timezone:'UTC',unit:'USDT',feedState:'snapshot',state:'ready',paused:false,x:1.25,y:57.8,price:90500,change:1.5,closedAt:Math.floor(NOW/1000/DAY)*DAY,sampleAt:Math.floor(NOW/1000/DAY)*DAY-DAY,validUntil:Math.floor(NOW/1000/DAY)*DAY+DAY,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299,...patch});
const principal=()=>({subjectId:'person-one',scopeId:'private-one',expiresAt:NOW+3600000,permissions:['research:analyze']});
const policy=()=>({id:'owner-policy',from:NOW-1000,until:NOW+3600000,tokenLimit:30000,requestLimit:2});
const output=sources=>({outcome:'watch',headline:'Positive deviation with moderate momentum',summary:'The supplied close is above EMA20. Other dimensions are unverified.',claims:[{text:'RSI is below its overbought threshold.',evidenceIds:[sources[0].id]}]});
const result=sources=>({method:'ai',model:'openai/gpt-4.1-mini',responseId:'real-provider-response-shape',usage:{inputTokens:100,outputTokens:40,totalTokens:140},billing:null,output:output(sources)});

// This is an offline protocol test double, not production persistence or quota evidence.
class Store {
 constructor(){this.records=new Map();this.used=0;this.requests=0;this.finishes=[];}
 key(v){return v.scopeId+':'+v.subjectId+':'+v.requestId;}
 get(v){return Promise.resolve(this.records.get(this.key(v))||null);}
 claim(v){
  const previous=this.records.get(this.key(v));if(previous)return Promise.resolve({acquired:false,record:previous});
  if(this.requests>=v.policy.requestLimit||this.used+v.reservedTokens>v.policy.tokenLimit)return Promise.resolve({acquired:false,code:'BUDGET_EXCEEDED'});
  this.used+=v.reservedTokens;this.requests++;
  const record={...v,state:'pending',claimToken:'internal-cas-token'};this.records.set(this.key(v),record);
  return Promise.resolve({acquired:true,claimToken:record.claimToken});
 }
 finish(v){
  const record=this.records.get(this.key(v));assert.equal(v.claimToken,record.claimToken);
  if(record.state!=='pending')throw Error('CAS_CONFLICT');
  if(v.settledTokens!==null)this.used-=record.reservedTokens-v.settledTokens;
  Object.assign(record,v);this.finishes.push(v);return Promise.resolve(record);
 }
}
function setup(options={}){
 const store=new Store();let calls=0,loads=0;
 const service=createResearchAnalysisService({model:{configured:true,model:'openai/gpt-4.1-mini',generate:async({sources})=>{calls++;return result(sources);}},authorize:async()=>principal(),admission:async()=>policy(),store,loadEvidence:async selected=>{loads++;return selected.map(s=>row(s));},now:()=>NOW,...options});
 return {service,store,calls:()=>calls,loads:()=>loads};
}
const query={requestId:'request-0001',symbols:['BTC']};

test('a model pause stays distinct while private admission errors remain sanitized before reservation',async()=>{
 for(const code of ['MODEL_UNAVAILABLE','PRIVATE_INTERNAL_DIAGNOSTIC']){
  const c=setup({admission:async()=>{throw Error(code);}});
  await assert.rejects(()=>c.service.analyze({},query),{message:code==='MODEL_UNAVAILABLE'?'MODEL_UNAVAILABLE':'BUDGET_UNAVAILABLE'});
  assert.equal(c.store.records.size,0);assert.equal(c.calls(),0);assert.equal(c.loads(),0);
 }
});

test('normalizes the supplied numerical evidence and binds provenance without inventing new dimensions',()=>{
 const [source]=validateResearchEvidence([row()],['BTC'],NOW);
 assert.deepEqual(source.metrics,{close:90500,changePercent:1.5,ema20DeviationAtr14:1.25,rsi14:57.8});
 assert.equal(source.source,'Binance Spot');assert.equal(source.closedAt,Date.UTC(2026,10,16)/1000);assert.match(source.id,/^market-[a-f0-9]{32}$/);
 assert.equal(validateResearchEvidence([row()],['BTC'],NOW)[0].id,source.id);
 assert.notEqual(validateResearchEvidence([row('BTC',{x:1.5})],['BTC'],NOW)[0].id,source.id);
});
test('rejects missing, duplicate, stale, non-finite, future and mismatched source evidence',()=>{
 for(const patch of [{source:'fixture'},{unit:'USD'},{timezone:'Asia/Shanghai'},{period:'1H'},{methodVersion:'unreviewed'},{x:NaN},{y:101},{price:0},{bars:20},{sampleAt:-1},{closedAt:NOW/1000+1},{validUntil:NOW/1000-1},{paused:true},{state:'stale'},{feedState:'error'}])assert.throws(()=>validateResearchEvidence([row('BTC',patch)],['BTC'],NOW));
 assert.throws(()=>validateResearchEvidence([],['BTC'],NOW));assert.throws(()=>validateResearchEvidence([row(),row()],['BTC','ETH'],NOW));
 assert.throws(()=>validateResearchEvidence([row('ETH')],['BTC'],NOW));
});
test('model conclusions require exact supplied citations and never accept order-authority fields',()=>{
 const sources=validateResearchEvidence([row()],['BTC'],NOW);
 assert.deepEqual(validateResearchOutput(output(sources),sources),output(sources));
 assert.throws(()=>validateResearchOutput({...output(sources),order:{side:'buy'}},sources));
 assert.throws(()=>validateResearchOutput({...output(sources),outcome:'buy'},sources));
 assert.throws(()=>validateResearchOutput({...output(sources),claims:[{text:'Made-up macro evidence',evidenceIds:['unprovided']}]},sources));
});
test('unconfigured or unauthorized service performs zero source/model calls',async()=>{
 const unconfigured=createResearchAnalysisService();assert.equal(unconfigured.configured,false);await assert.rejects(()=>unconfigured.analyze({},query),{message:'UNCONFIGURED'});
 for(const identity of [null,{...principal(),permissions:[]},{...principal(),expiresAt:NOW}]){
  const ctx=setup({authorize:async()=>identity});await assert.rejects(()=>ctx.service.analyze({},query),{message:'AUTH_REQUIRED'});assert.equal(ctx.calls(),0);assert.equal(ctx.loads(),0);
 }
});
test('identity infrastructure failures remain unavailable without declaring a user signed out',async()=>{
 const unavailable=setup({authorize:async()=>{throw Error('PRIVATE_RPC_UNAVAILABLE');}});
 await assert.rejects(()=>unavailable.service.analyze({},query),{message:'SERVICE_UNAVAILABLE',status:503});assert.equal(unavailable.calls(),0);
 const denied=setup({authorize:async()=>{throw Error('AUTH_REQUIRED');}});
 await assert.rejects(()=>denied.service.analyze({},query),{message:'AUTH_REQUIRED',status:401});assert.equal(denied.calls(),0);
});
test('known atomic quota and conflict rejections do not become unknown or dispatch a model',async()=>{
 for(const [code,status,expected]of [['BUDGET_EXCEEDED',429,'BUDGET_EXCEEDED'],['PRIVATE_CONFLICT',409,'REQUEST_CONFLICT']]){
  const store=new Store();store.claim=async()=>{throw Object.assign(Error(code),{outcomeUnknown:false});};
  const c=setup({store});await assert.rejects(()=>c.service.analyze({},query),{message:expected,status});assert.equal(c.calls(),0);assert.equal(c.loads(),0);
 }
 const store=new Store();store.claim=async()=>{throw Object.assign(Error('BUDGET_EXCEEDED'),{outcomeUnknown:true});};
 const c=setup({store});await assert.rejects(()=>c.service.analyze({},query),{message:'OUTCOME_UNKNOWN',status:503});assert.equal(c.calls(),0);
});
test('requires server policy and rejects client-provided evidence before loading or model calls',async()=>{
 for(const body of [{...query,sources:[row()]},{...query,symbols:['BTC','BTC']},{...query,symbols:['UNKNOWN']},{...query,requestId:'bad'}]){
  const c=setup();await assert.rejects(()=>c.service.analyze({},body),{message:'REQUEST_INVALID'});assert.equal(c.calls(),0);
 }
 for(const p of [null,{...policy(),tokenLimit:1},{...policy(),requestLimit:0},{...policy(),until:NOW}]){
  const c=setup({admission:async()=>p});await assert.rejects(()=>c.service.analyze({},query),{message:'BUDGET_EXCEEDED'});assert.equal(c.calls(),0);assert.equal(c.loads(),0);
 }
});
test('successful report stores model receipt, exact sources and missing dimensions but grants no execution',async()=>{
 const c=setup(),value=await c.service.analyze({},query);
 assert.equal(value.state,'complete');assert.equal(value.fresh,true);assert.equal(value.result.responseId,'real-provider-response-shape');assert.equal(value.result.executionAuthority,'NONE');
 assert.deepEqual(value.result.missingDimensions,['depth','macro','social','chain','risk']);assert.equal(value.result.sources[0].metrics.close,90500);assert.equal(c.store.used,140);
 assert.equal(value.claimToken,undefined);assert.equal(value.policy,undefined);assert.equal(value.subjectId,undefined);
 assert.equal(c.calls(),1);assert.deepEqual(await c.service.analyze({},query),value);assert.equal(c.calls(),1);
 assert.deepEqual(await c.service.get({},query.requestId),value);
});
test('same request with different selection conflicts and cross-scope reads reveal no result',async()=>{
 const c=setup();await c.service.analyze({},query);await assert.rejects(()=>c.service.analyze({},{...query,symbols:['ETH']}),{message:'REQUEST_CONFLICT'});assert.equal(c.calls(),1);
 const other=createResearchAnalysisService({model:{configured:true,model:'openai/gpt-4.1-mini',generate:async()=>{}},authorize:async()=>({...principal(),scopeId:'private-two'}),admission:async()=>policy(),store:c.store,loadEvidence:async()=>[],now:()=>NOW});
 await assert.rejects(()=>other.get({},query.requestId),{message:'REQUEST_NOT_FOUND'});
});
test('atomic claim prevents simultaneous duplicate model dispatch',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 const c=setup({loadEvidence:async()=>{await waiting;return [row()];}});
 const first=c.service.analyze({},query);await new Promise(resolve=>setImmediate(resolve));
 const duplicate=await c.service.analyze({},query);assert.equal(duplicate.state,'pending');release();await first;assert.equal(c.calls(),1);
});
test('budget exhausted by request count cannot be bypassed by fresh request IDs',async()=>{
 const c=setup();await c.service.analyze({},query);await c.service.analyze({},{...query,requestId:'request-0002'});
 await assert.rejects(()=>c.service.analyze({},{...query,requestId:'request-0003'}),{message:'BUDGET_EXCEEDED'});assert.equal(c.calls(),2);
});
test('source failures release tokens; unknown provider outcomes retain reservation and never automatically retry',async()=>{
 const missing=setup({loadEvidence:async()=>[]}),bad=await missing.service.analyze({},query);assert.equal(bad.state,'failed');assert.equal(bad.error,'EVIDENCE_INVALID');assert.equal(missing.calls(),0);assert.equal(missing.store.used,0);
 let dispatched=0;
 const timeout=setup({model:{configured:true,model:'openai/gpt-4.1-mini',async generate(){dispatched++;throw Object.assign(Error('MODEL_TIMEOUT'),{status:503});}}});
 const unknown=await timeout.service.analyze({},query);assert.equal(unknown.state,'unknown');assert.equal(unknown.error,'MODEL_TIMEOUT');assert.equal(unknown.queryOriginalRequest,true);assert.ok(timeout.store.used>800);
 assert.deepEqual(await timeout.service.analyze({},query),unknown);assert.equal(dispatched,1);
});
test('persistence failure after dispatch is unresolved and cannot be reported as delivered',async()=>{
 const c=setup();c.store.finish=async()=>{throw Error('private-db-detail');};await assert.rejects(()=>c.service.analyze({},query),{message:'OUTCOME_UNKNOWN'});assert.equal(c.calls(),1);
 assert.equal((await c.service.analyze({},query)).state,'pending');assert.equal(c.calls(),1);
});
test('usage bounds and store failures cannot fabricate successful research or expose credentials',async()=>{
 const storeFailure=setup();storeFailure.store.get=async()=>{throw Error('credential-in-driver-error');};await assert.rejects(()=>storeFailure.service.analyze({},query),{message:'SERVICE_UNAVAILABLE'});assert.equal(storeFailure.calls(),0);
 const claimFailure=setup();claimFailure.store.claim=async()=>{throw Error('credential-in-driver-error');};await assert.rejects(()=>claimFailure.service.analyze({},query),{message:'OUTCOME_UNKNOWN'});assert.equal(claimFailure.calls(),0);
 for(const usage of [{inputTokens:-1,outputTokens:1,totalTokens:0},{inputTokens:100,outputTokens:801,totalTokens:901},{inputTokens:100,outputTokens:40,totalTokens:10}]){
  const c=setup({model:{configured:true,model:'openai/gpt-4.1-mini',generate:async({sources})=>({...result(sources),usage})}}),response=await c.service.analyze({},query);
  assert.equal(response.state,'unknown');assert.equal(response.error,'MODEL_INVALID_RESPONSE');assert.ok(c.store.used>800);
 }
});
test('expiry of completed evidence is visible on replay without re-running the model',async()=>{
 let time=NOW;const c=setup({now:()=>time,authorize:async()=>({...principal(),expiresAt:NOW+DAY*2000})});await c.service.analyze({},query);time+=DAY*1000;
 const result=await c.service.analyze({},query);assert.equal(result.state,'complete');assert.equal(result.fresh,false);assert.equal(c.calls(),1);
});
test('fixed-endpoint adapter uses strict JSON schema, explicit model and hard token limits',async()=>{
 const sources=validateResearchEvidence([row()],['BTC'],NOW),key='offline-test-key-not-a-real-secret';let sent;
 const provider={id:'gen-provider-fixture',model:'openai/gpt-4.1-mini',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output(sources),null,2)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}};
 const model=createResearchAnalysisModel({apiKey:key,model:'openai/gpt-4.1-mini',fetchImpl:async(url,options)=>{sent={url,options};return new Response(JSON.stringify(provider),{headers:{'Content-Type':'application/json'}});}});
 const answer=await model.generate({sources});assert.equal(answer.responseId,'gen-provider-fixture');assert.equal(sent.url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(sent.options.redirect,'error');
 const body=JSON.parse(sent.options.body);assert.equal(body.max_completion_tokens,800);assert.equal(body.stream,false);assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.model,provider.model);assert.ok(!sent.options.body.includes(key));
 assert.deepEqual(body.provider,{only:['openai'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.4,completion:1.6}});
 assert.equal(answer.billing,null);assert.equal(RESEARCH_MODEL_LIMITS.reservedMicrousd,20890);
});
test('provider billing is bound to its receipt, uses decimal ceiling and holds unknown/BYOK costs',async()=>{
 const sources=validateResearchEvidence([row()],['BTC'],NOW);
 for(const [cost,is_byok,expected] of [[0.000104,false,104],[0.0000001,false,1],[0,false,0],[1.0000001,false,1000001],[0.000104,true,null],[0.000104,undefined,null],[undefined,false,null],[-1,false,null],['0.01',false,null]]){
  const provider={id:'receipt-bound-cost',model:'openai/gpt-4.1-mini',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output(sources))}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,cost,is_byok}};
  const m=createResearchAnalysisModel({apiKey:'not-a-real-secret-value',model:provider.model,fetchImpl:async()=>new Response(JSON.stringify(provider),{headers:{'Content-Type':'application/json'}})});
  const value=await m.generate({sources});assert.equal(value.billing?.costMicrousd??null,expected);
  if(expected!==null)assert.deepEqual(value.billing,{provider:'openrouter',responseId:provider.id,model:provider.model,costMicrousd:expected,isByok:false});
 }
 for(const v of [NaN,Infinity,-1,undefined,null,'0.01',Number.MAX_SAFE_INTEGER])assert.equal(researchCostMicrousd(v),null);
 assert.equal(researchCostMicrousd(5e-324),1);
 const c=setup({model:{configured:true,model:'openai/gpt-4.1-mini',generate:async({sources})=>({...result(sources),billing:{provider:'openrouter',responseId:'wrong-receipt',model:'openai/gpt-4.1-mini',costMicrousd:1,isByok:false}})}});
 assert.equal((await c.service.analyze({},query)).state,'unknown');assert.ok(c.store.used>800);
});
test('adapter fails closed on absent config, truncated/unsupported model/invalid citations and oversized output',async()=>{
 assert.equal(createResearchAnalysisModel().configured,false);assert.equal(createResearchAnalysisModel({apiKey:'not-a-real-secret-value',model:'unapproved/model'}).configured,false);
 const sources=validateResearchEvidence([row()],['BTC'],NOW);
 for(const provider of [
  {id:'id',model:'other',choices:[],usage:{}},
  {id:'id',model:'openai/gpt-4.1-mini',choices:[{finish_reason:'length',message:{content:'{}'}}],usage:{prompt_tokens:5,completion_tokens:1,total_tokens:6}},
  {id:'id',model:'openai/gpt-4.1-mini',choices:[{finish_reason:'stop',message:{content:JSON.stringify({...output(sources),claims:[{text:'False source',evidenceIds:['other']}]})}}],usage:{prompt_tokens:5,completion_tokens:1,total_tokens:6}}
 ]){
  const m=createResearchAnalysisModel({apiKey:'not-a-real-secret-value',model:'openai/gpt-4.1-mini',fetchImpl:async()=>new Response(JSON.stringify(provider),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(()=>m.generate({sources}),{message:'MODEL_INVALID_RESPONSE'});
 }
 const large=createResearchAnalysisModel({apiKey:'not-a-real-secret-value',model:'openai/gpt-4.1-mini',fetchImpl:async()=>new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}})});
 await assert.rejects(()=>large.generate({sources}),{message:'MODEL_INVALID_RESPONSE'});
});
test('adapter enforces its real AbortSignal deadline without retrying transport',async()=>{
 let calls=0;
 const model=createResearchAnalysisModel({apiKey:'not-a-real-secret-value',model:'openai/gpt-4.1-mini',timeoutMs:100,fetchImpl:async(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>{const later=setTimeout(()=>resolve(new Response('{}')),400);signal.addEventListener('abort',()=>{clearTimeout(later);reject(signal.reason);},{once:true});});}});
 await assert.rejects(()=>model.generate({sources:validateResearchEvidence([row()],['BTC'],NOW)}),{message:'MODEL_TIMEOUT'});assert.equal(calls,1);
});
function req(url,method='GET',body='',headers={}){return Object.assign(Readable.from(body?[body]:[]),{url,method,headers:{host:'astarter.example',...headers}});}
async function invoke(handler,request){let status,body;const response={writeHead(s){status=s;},end(v){body=JSON.parse(v);}};const handled=await handler(request,response);return {handled,status,body};}
test('HTTP handler rejects cross-origin/malformed input and exposes no raw failure detail',async()=>{
 const c=setup(),origin='https://astarter.example',handler=createResearchAnalysisHandler({service:c.service,origin});
 assert.equal((await invoke(handler,req('/other'))).handled,false);
 assert.equal((await invoke(handler,req('/api/research/analyze','POST','{}',{origin:'https://evil.example'}))).status,403);
 assert.equal((await invoke(handler,req('/api/research/analyze','POST','{}',{origin}))).status,415);
 assert.equal((await invoke(handler,req('/api/research/analyze','POST','x'.repeat(2049),{origin,'content-type':'application/json'}))).status,413);
 const result=await invoke(handler,req('/api/research/analyze','POST',JSON.stringify(query),{origin,'content-type':'application/json'}));assert.equal(result.status,200);assert.equal(result.body.state,'complete');
 const missing=createResearchAnalysisHandler({service:setup({loadEvidence:async()=>[]}).service,origin});
 const invalid=await invoke(missing,req('/api/research/analyze','POST',JSON.stringify(query),{origin,'content-type':'application/json'}));assert.equal(invalid.status,422);assert.equal(invalid.body.ok,false);
 const broken=createResearchAnalysisHandler({service:{analyze:async()=>{throw Error('database-secret-credential');}},origin});
 const failure=await invoke(broken,req('/api/research/analyze','POST',JSON.stringify(query),{origin,'content-type':'application/json'}));assert.equal(failure.status,503);assert.equal(failure.body.error,'SERVICE_UNAVAILABLE');assert.ok(!JSON.stringify(failure).includes('database-secret'));
});
test('native HTTP route reads bounded JSON, authenticates and reconciles the original request',async()=>{
 const c=setup({authorize:async req=>req.headers.authorization==='Bearer offline-http-test'?principal():null});
 let handler;
 const server=createServer((req,res)=>void handler(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 handler=createResearchAnalysisHandler({service:c.service,origin});
 try{
  const headers={origin,'content-type':'application/json',authorization:'Bearer offline-http-test'};
  const denied=await fetch(origin+'/api/research/analyze',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(query)});assert.equal(denied.status,401);assert.equal(c.calls(),0);
  const first=await fetch(origin+'/api/research/analyze',{method:'POST',headers,body:JSON.stringify(query)}),firstBody=await first.json();assert.equal(first.status,200);assert.equal(firstBody.result.executionAuthority,'NONE');assert.equal(firstBody.claimToken,undefined);
  const replay=await fetch(origin+'/api/research/analyze',{method:'POST',headers,body:JSON.stringify(query)});assert.equal((await replay.json()).result.responseId,firstBody.result.responseId);assert.equal(c.calls(),1);
  const record=await fetch(origin+'/api/research/requests/'+query.requestId,{headers});assert.equal(record.status,200);assert.equal((await record.json()).state,'complete');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('Vercel-parsed bodies retain bounds and host checks before the service runs',async()=>{
 const c=setup(),origin='https://astarter.example',handler=createResearchAnalysisHandler({service:c.service,origin});
 for(const body of [query,JSON.stringify(query)]){
  const request=req('/api/research/analyze','POST','',{origin,'content-type':'application/json'});request.body=body;
  assert.equal((await invoke(handler,request)).status,200);
 }
 assert.equal(c.calls(),1);
 const oversized=req('/api/research/analyze','POST','',{origin,'content-type':'application/json'});oversized.body={...query,extra:'x'.repeat(2048)};
 assert.equal((await invoke(handler,oversized)).status,413);
 for(const host of ['evil.example',undefined]){
  const request=req('/api/research/analyze','POST','',{origin,host,'content-type':'application/json'});request.body=query;
  assert.equal((await invoke(handler,request)).status,403);
 }
 assert.equal(c.calls(),1);
});
// The source owner's outage row: the requested identity, no numbers, state and feed 'error'.
const outage=(symbol='BTC',reason='SOURCE_UNAVAILABLE')=>({symbol,source:'Binance Spot',timezone:'UTC',unit:'USDT',period:'1D',methodVersion:'ema20-atr14-rsi14-v1',paused:false,state:'error',feedState:'error',reason});
test('a source outage reads EVIDENCE_UNAVAILABLE, stays apart from invalid evidence, and fails without a model call or held tokens',async()=>{
 for(const reason of ['SOURCE_UNAVAILABLE','SOURCE_TIMEOUT'])assert.throws(()=>validateResearchEvidence([outage('BTC',reason)],['BTC'],NOW),{message:'EVIDENCE_UNAVAILABLE',status:503});
 assert.throws(()=>validateResearchEvidence([row('BTC'),outage('ETH')],['BTC','ETH'],NOW),{message:'EVIDENCE_UNAVAILABLE',status:503});
 for(const patch of [{source:'fixture'},{unit:'USD'},{period:'1H'},{methodVersion:'unreviewed'}])assert.throws(()=>validateResearchEvidence([{...outage(),...patch}],['BTC'],NOW),{message:'EVIDENCE_INVALID',status:502});
 assert.throws(()=>validateResearchEvidence([outage('ETH')],['BTC'],NOW),{message:'EVIDENCE_INVALID',status:502});
 for(const rows of [[outage('BTC')],[row('BTC'),outage('ETH')]]){
  const symbols=rows.map(item=>item.symbol),c=setup({loadEvidence:async()=>rows}),value=await c.service.analyze({},{requestId:'request-outage-'+symbols.length,symbols});
  assert.equal(value.state,'failed');assert.equal(value.error,'EVIDENCE_UNAVAILABLE');assert.equal(value.queryOriginalRequest,false);assert.equal(value.result,undefined);assert.equal(c.calls(),0);assert.equal(c.store.used,0);
 }
 const origin='https://astarter.example',handler=createResearchAnalysisHandler({service:setup({loadEvidence:async()=>[outage()]}).service,origin});
 const answer=await invoke(handler,req('/api/research/analyze','POST',JSON.stringify(query),{origin,'content-type':'application/json'}));
 assert.equal(answer.status,503);assert.equal(answer.body.ok,false);assert.equal(answer.body.state,'failed');assert.equal(answer.body.error,'EVIDENCE_UNAVAILABLE');
});
test('a service without a configured model still reads its stored record, while a new analysis stays inert',async()=>{
 const c=setup(),done=await c.service.analyze({},query);let authorizations=0,reads=0;
 const store={get:async value=>{reads++;return c.store.get(value);},claim:()=>assert.fail('claim'),finish:()=>assert.fail('finish')};
 const keyless=createResearchAnalysisService({model:createResearchAnalysisModel({model:'openai/gpt-4.1-mini',fetchImpl:()=>assert.fail('model I/O')}),authorize:async()=>{authorizations++;return principal();},admission:async()=>assert.fail('admission'),store,loadEvidence:async()=>assert.fail('source I/O'),now:()=>NOW});
 assert.equal(keyless.configured,false);assert.deepEqual(await keyless.get({},query.requestId),done);
 await assert.rejects(()=>keyless.analyze({},{...query,requestId:'request-0009'}),{message:'UNCONFIGURED',status:503});
 assert.equal(authorizations,1);assert.equal(reads,1);assert.equal(c.calls(),1);assert.equal(c.store.records.size,1);
 await assert.rejects(()=>createResearchAnalysisService({authorize:async()=>principal()}).get({},query.requestId),{message:'UNCONFIGURED',status:503});
});
