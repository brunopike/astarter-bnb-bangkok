import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchJobClient,validateResearchJob,renderResearchJob} from './research-job-client.mjs';
import {validateResearchEvidence,createResearchAnalysisService} from './research-analysis-service.mjs';
import {pair} from './locale.mjs';

// Offline protocol doubles only. These tests make no model or production request.
const NOW=Date.UTC(2026,10,16,12),DAY=86400,ID='research-request-0001',OWNER='wallet:public-address:56:session-1';
const copy=value=>structuredClone(value);
const row=(symbol='BTC')=>({symbol,source:'Binance Spot',timezone:'UTC',unit:'USDT',feedState:'snapshot',state:'ready',paused:false,x:1.25,y:57.8,price:90500,change:1.5,closedAt:Math.floor(NOW/1000/DAY)*DAY,sampleAt:Math.floor(NOW/1000/DAY)*DAY-DAY,validUntil:Math.floor(NOW/1000/DAY)*DAY+DAY,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299});
function receipt({id=ID,symbols=['BTC'],state='complete',fresh=true}={}){
 const sources=validateResearchEvidence(symbols.map(symbol=>row(symbol)),symbols,NOW);
 const result={method:'ai',model:'openai/gpt-4.1-mini',responseId:'offline-provider-shape',usage:{inputTokens:100,outputTokens:40,totalTokens:140},billing:null,output:{outcome:'watch',headline:'Offline protocol fixture',summary:'Price is above EMA20; independent inputs remain unavailable.',claims:[{text:'RSI14 is 57.8.',evidenceIds:[sources[0].id]}]},sources,missingDimensions:['depth','macro','social','chain','risk'],createdAt:NOW,validUntil:Math.min(...sources.map(source=>source.validUntil*1000)),executionAuthority:'NONE',methodVersion:'closed-market-research-v1'};
 return {requestId:id,state,createdAt:NOW,fresh:state==='complete'&&fresh,...(state==='complete'?{result}:state==='unknown'?{error:'MODEL_TIMEOUT',queryOriginalRequest:true}:{})};
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function memory(){const entries=new Map();return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value))};}
function client(options={}){
 const storage=options.storage||memory(),calls=[];
 const instance=createResearchJobClient({storage,ownerRef:OWNER,symbols:['BTC'],now:()=>NOW,makeRequestId:()=>ID,fetchImpl:async(url,init)=>{calls.push({url,init});return response(receipt());},...options});
 return {instance,storage,calls};
}

test('only an explicit start posts the exact selection with same-origin cookies and no identity or source payload',async()=>{
 const {instance,calls,storage}=client();assert.equal(calls.length,0);assert.equal(instance.snapshot().status,'waiting');
 instance.select(['ETH','BTC']);assert.equal(calls.length,0);await instance.start();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/research/analyze');assert.equal(calls[0].init.method,'POST');
 assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.cache,'no-store');
 assert.deepEqual(JSON.parse(calls[0].init.body),{requestId:ID,symbols:['BTC','ETH']});
 assert.deepEqual(Object.keys(calls[0].init.headers).sort(),['Accept','Content-Type']);
 const saved=JSON.parse([...storage.entries.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['createdAt','ownerRef','requestId','symbols','version']);assert.equal(saved.ownerRef,OWNER);assert.equal(saved.result,undefined);
 assert.equal(instance.snapshot().status,'unknown','the one-symbol offline response cannot satisfy a two-symbol request');instance.destroy();
});

test('a complete service report preserves exact sources, citations, owner context and no trading authority',async()=>{
 const {instance}=client();await instance.start();const snapshot=instance.snapshot();
 assert.equal(snapshot.status,'complete');assert.equal(snapshot.ownerRef,OWNER);assert.equal(snapshot.requestId,ID);assert.equal(snapshot.mode,'live_readonly');assert.equal(snapshot.executionAuthority,'NONE');
 assert.deepEqual(snapshot.result.sources,receipt().result.sources);assert.deepEqual(snapshot.result.missingDimensions,['depth','macro','social','chain','risk']);
 snapshot.result.output.headline='changed outside';assert.equal(instance.snapshot().result.output.headline,'Offline protocol fixture');
 instance.destroy();
});

test('validator accepts the exact service readback and rejects execution fields, source substitutions and unsupported conclusions',async()=>{
 const original=receipt(),context={requestId:ID,symbols:['BTC'],now:NOW};assert.deepEqual(await validateResearchJob(original,context),original);
 const mutations=[
  body=>body.requestId='another-request',body=>body.subjectId='caller-identity',body=>body.result.executionAuthority='TRADE',body=>body.result.method='fixture',body=>body.result.model='unknown',
  body=>body.error=null,body=>body.result.output.outcome='candidate',body=>body.result.output.order={side:'buy'},body=>body.result.output.claims[0].evidenceIds=['unprovided'],
  body=>body.result.missingDimensions.pop(),body=>body.result.sources[0].symbol='ETH',body=>body.result.sources[0].source='fixture',body=>body.result.sources[0].unit='USD',
  body=>body.result.sources[0].metrics.rsi14=101,body=>body.result.sources[0].metrics.close=90501,body=>body.result.sources[0].url='https://not-a-source.test',
  body=>body.result.sources[0].closedAt=NOW/1000+1,body=>body.result.validUntil++,body=>body.result.usage.totalTokens++,body=>body.result.billing={cost:0},body=>body.fresh='true'
 ];
 for(const mutate of mutations){const body=copy(original);mutate(body);await assert.rejects(()=>validateResearchJob(body,context),{message:'RESEARCH_RESPONSE_INVALID'});}
});

test('the client consumes service POST and GET readbacks from nullable private DAL records without a second schema',async()=>{
 let record=null,modelCalls=0;const bodies=[];
 const service=createResearchAnalysisService({now:()=>NOW,authorize:async()=>({subjectId:'offline-person',scopeId:'offline-private-scope',expiresAt:NOW+60000,permissions:['research:analyze']}),admission:async()=>({id:'offline-policy',from:NOW-1,until:NOW+60000,tokenLimit:30000,requestLimit:1}),store:{get:async()=>record,claim:async input=>{record={...input,state:'pending',error:null,queryOriginalRequest:false};return {acquired:true,claimToken:'offline-cas-token'};},finish:async patch=>Object.assign(record,patch)},loadEvidence:async symbols=>symbols.map(symbol=>row(symbol)),model:{configured:true,model:'openai/gpt-4.1-mini',generate:async({sources})=>{modelCalls++;const {method,model,responseId,usage,billing,output}=receipt().result;return {method,model,responseId,usage,billing,output:{...output,claims:[{text:'Offline adapter assertion.',evidenceIds:[sources[0].id]}]}};}}});
 const {instance}=client({fetchImpl:async(url,init)=>{const body=init.method==='POST'?await service.analyze({},JSON.parse(init.body)):await service.get({},url.split('/').at(-1));bodies.push(body);return response(body);}});
 await instance.start();assert.equal(record.error,null);assert.equal(instance.snapshot().status,'complete');await instance.query();assert.equal(modelCalls,1);assert.equal(instance.snapshot().status,'complete');assert.equal(bodies.length,2);assert.ok(bodies.every(body=>!Object.hasOwn(body,'error')));instance.destroy();
});

test('a network-unknown POST retains its ID and prohibits another POST; recovery is GET only',async()=>{
 const calls=[],storage=memory();let fail=true;
 const fetchImpl=async(url,init)=>{calls.push({url,init});if(fail)throw Error('private upstream detail');return response(receipt());};
 const {instance}=client({storage,fetchImpl});await instance.start();assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().canStart,false);assert.equal(instance.snapshot().canQuery,true);
 await assert.rejects(()=>instance.start(['ETH']),{message:'ORIGINAL_REQUEST_PENDING'});assert.equal(calls.length,1);assert.equal(instance.select(['ETH']),false);
 fail=false;await instance.query();assert.equal(calls[1].init.method,'GET');assert.equal(calls[1].url,'/api/research/requests/'+ID);assert.equal(calls[1].init.body,undefined);assert.equal(instance.snapshot().status,'complete');assert.doesNotMatch(JSON.stringify(instance.snapshot()),/private upstream detail/);
 instance.destroy();
 const restored=client({storage,fetchImpl}).instance;assert.equal(restored.snapshot().status,'unknown');assert.equal(calls.length,2);await restored.resume();assert.equal(calls[2].init.method,'GET');assert.equal(restored.snapshot().status,'complete');restored.destroy();
});

test('pending, ambiguous, auth and unavailable receipts remain separate and never retry automatically',async()=>{
 for(const [body,http,status] of [[receipt({state:'pending'}),202,'processing'],[receipt({state:'unknown'}),202,'unknown'],[{ok:false,error:'AUTH_REQUIRED',executionAuthority:'NONE'},401,'auth-required'],[{ok:false,error:'UNCONFIGURED',executionAuthority:'NONE'},503,'service-unavailable']]){
  let calls=0;const {instance}=client({fetchImpl:async()=>{calls++;return response(body,http);}});await instance.start();assert.equal(instance.snapshot().status,status);assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().canStart,false);assert.equal(calls,1);instance.destroy();
 }
});

test('a failed or ambiguous record requires its original-request flag before permitting another research',async()=>{
 for(const body of [{requestId:ID,state:'failed',fresh:false,createdAt:NOW,error:'MODEL_TIMEOUT'},receipt({state:'unknown'})]){
  delete body.queryOriginalRequest;const {instance}=client({fetchImpl:async()=>response(body,202)});await instance.start();assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().canStart,false);instance.destroy();
 }
 const {instance,calls}=client();await instance.start();await assert.rejects(()=>instance.start(),{message:'RESEARCH_REQUEST_ID_INVALID'});assert.equal(calls.length,1);instance.destroy();
});

test('source rejection can start a later explicit request, while a wrong-owner 404 never borrows a result',async()=>{
 let count=0;const {instance}=client({makeRequestId:()=>ID+'-'+(++count),fetchImpl:async(url,init)=>response(init.method==='POST'?{requestId:JSON.parse(init.body).requestId,state:'failed',createdAt:NOW,fresh:false,error:'EVIDENCE_UNAVAILABLE',queryOriginalRequest:false}:{ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},init.method==='POST'?503:404)});
 await instance.start();assert.equal(instance.snapshot().status,'service-unavailable');assert.equal(instance.snapshot().canStart,true);await instance.start();assert.equal(count,2);
 await instance.query();assert.equal(instance.snapshot().result,null);assert.equal(instance.snapshot().error,'REQUEST_NOT_FOUND');assert.equal(instance.snapshot().canStart,false);assert.equal(instance.snapshot().canRetryOriginal,true);await assert.rejects(()=>instance.start(),{message:'ORIGINAL_REQUEST_PENDING'});instance.destroy();
});

test('a pre-claim delayed POST and explicit retry after GET404 use one ID and one atomic claim',{timeout:1000},async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release,entered,ids=0,modelCalls=0;const beforeClaim=new Promise(resolve=>release=resolve),firstFetch=new Promise(resolve=>entered=resolve),calls=[],claims=new Map();
 const {instance}=client({timeoutMs:5,makeRequestId:()=>ID+'-'+(++ids),fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method,body:init.body});
  if(init.method==='GET')return response({ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},404);
  const body=JSON.parse(init.body);entered();await beforeClaim;
  if(!claims.has(body.requestId)){modelCalls++;claims.set(body.requestId,receipt({id:body.requestId,symbols:body.symbols}));}
  return response(claims.get(body.requestId));
 }});
 try{
  const first=instance.start();await firstFetch;assert.equal(instance.snapshot().status,'processing');assert.equal(claims.size,0);assert.equal(modelCalls,0);
  t.mock.timers.tick(5);await first;assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().canRetryOriginal,false);
  await instance.query();assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().canStart,false);assert.equal(instance.snapshot().canRetryOriginal,true);assert.equal(instance.select(['ETH']),false);
  assert.equal(await instance.start(['ETH']).then(()=>false,error=>error.message),'ORIGINAL_REQUEST_PENDING');
  const retried=instance.retryOriginal();release();await retried;await new Promise(resolve=>setImmediate(resolve));
  const posts=calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);assert.deepEqual(JSON.parse(posts[0].body),{requestId:ID+'-1',symbols:['BTC']});assert.equal(ids,1);assert.equal(claims.size,1);assert.equal(modelCalls,1);assert.equal(instance.snapshot().status,'complete');
 }finally{release();instance.destroy();}
});

test('reloading a 404 intent preserves its ID and requires a fresh GET before an explicit original POST',async()=>{
 const storage=memory(),calls=[];let made=0,finish=false;
 const fetchImpl=async(url,init)=>{calls.push({url,method:init.method,body:init.body});if(init.method==='GET')return response({ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},404);if(!finish)throw Error('unconfirmed');return response(receipt());};
 const first=client({storage,makeRequestId:()=>{made++;return ID;},fetchImpl}).instance;await first.start();await first.query();assert.equal(first.snapshot().canRetryOriginal,true);first.destroy();
 const restored=client({storage,makeRequestId:()=>{throw Error('MUST_NOT_CREATE_NEW_ID');},fetchImpl}).instance;
 try{
  assert.equal(restored.snapshot().requestId,ID);assert.equal(restored.snapshot().canRetryOriginal,false);assert.equal(restored.snapshot().canStart,false);await assert.rejects(()=>restored.start(),{message:'ORIGINAL_REQUEST_PENDING'});await assert.rejects(()=>restored.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
  const before=calls.length;await restored.resume();assert.equal(calls[before].method,'GET');assert.equal(restored.snapshot().canRetryOriginal,true);finish=true;await restored.retryOriginal();
  assert.equal(made,1);assert.equal(calls.at(-1).method,'POST');assert.equal(calls.at(-1).body,calls[0].body);assert.equal(restored.snapshot().requestId,ID);assert.equal(restored.snapshot().status,'complete');
 }finally{restored.destroy();}
});

test('only a confirmed GET404 enables same-ID retry; all other unknown outcomes remain GET-only',async()=>{
 const notFound={ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'};
 for(const [body,status]of [[receipt({state:'pending'}),202],[receipt({state:'unknown'}),202],[{ok:false,error:'UNCONFIGURED',executionAuthority:'NONE'},503],[notFound,200],[notFound,503]]){
  let calls=0;const {instance}=client({fetchImpl:async(_url,init)=>{calls++;if(init.method==='POST')throw Error('unconfirmed');return response(body,status);}});
  try{await instance.start();await instance.query();assert.equal(instance.snapshot().canRetryOriginal,false);assert.equal(instance.snapshot().canStart,false);await assert.rejects(()=>instance.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});assert.equal(calls,2);}
  finally{instance.destroy();}
 }
 let calls=0;const {instance}=client({fetchImpl:async()=>{calls++;return response(notFound,404);}});try{await instance.start();assert.equal(instance.snapshot().canRetryOriginal,false);await assert.rejects(()=>instance.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});assert.equal(calls,1);}finally{instance.destroy();}
});

test('an owner switch before the retry dispatch cancels it, and an old in-flight retry cannot publish for a new owner',async()=>{
 for(const alreadyDispatched of [false,true]){
  let posts=0,release;const late=new Promise(resolve=>release=resolve),{instance}=client({fetchImpl:async(_url,init)=>{if(init.method==='GET')return response({ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},404);if(++posts===1)throw Error('unconfirmed');return late;}});
  try{
   await instance.start();await instance.query();assert.equal(instance.snapshot().canRetryOriginal,true);const pending=instance.retryOriginal();if(alreadyDispatched)await Promise.resolve();instance.setOwner('wallet:another:56:session-2');release(response(receipt()));await pending;
   assert.equal(posts,alreadyDispatched?2:1);assert.equal(instance.snapshot().ownerRef,'wallet:another:56:session-2');assert.equal(instance.snapshot().result,null);assert.equal(instance.snapshot().canRetryOriginal,false);await assert.rejects(()=>instance.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
   instance.setOwner(OWNER);assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().canRetryOriginal,false);
  }finally{release(response(receipt()));instance.destroy();}
 }
});

test('a retry that becomes unknown requires another GET404 and renders the exact original-request action',async()=>{
 const calls=[],{instance}=client({fetchImpl:async(_url,init)=>{calls.push(init.method);if(init.method==='GET')return response({ok:false,error:'REQUEST_NOT_FOUND',executionAuthority:'NONE'},404);throw Error('unconfirmed');}});
 try{
  await instance.start();assert.doesNotMatch(renderResearchJob(instance.snapshot()),/data-research-job-action="retry"/);await instance.query();
  const html=renderResearchJob(instance.snapshot());assert.match(html,/data-research-job-action="retry"/);assert.ok(html.includes(pair('重试原请求','Retry original request')));assert.match(html,/data-research-job-action="query"/);assert.doesNotMatch(html,/data-research-job-action="start"/);
  await instance.retryOriginal();assert.equal(instance.snapshot().canRetryOriginal,false);await assert.rejects(()=>instance.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});await instance.query();assert.equal(instance.snapshot().canRetryOriginal,true);assert.deepEqual(calls,['POST','GET','POST','GET']);
 }finally{instance.destroy();}
});

test('local or server expiry retains the report as expired rather than a fresh approval',async()=>{
 let now=NOW;const {instance}=client({now:()=>now});await instance.start();now=receipt().result.validUntil;assert.equal(instance.snapshot().status,'expired');assert.equal(instance.snapshot().executionAuthority,'NONE');assert.ok(instance.snapshot().result);instance.destroy();
 const stale=client({fetchImpl:async()=>response(receipt({fresh:false}))}).instance;await stale.start();assert.equal(stale.snapshot().status,'expired');stale.destroy();
});

test('leaving aborts ownership and late success cannot cross a page or account boundary',async()=>{
 let release,signal;const pending=new Promise(resolve=>{release=resolve;});const {instance}=client({fetchImpl:async(url,init)=>{signal=init.signal;await pending;return response(receipt());}});
 const original=instance.start();await Promise.resolve();instance.leave();assert.equal(signal.aborted,true);assert.equal(instance.snapshot().status,'cancel-view');release();await original;assert.equal(instance.snapshot().status,'cancel-view');assert.equal(instance.snapshot().result,null);
 instance.setOwner('wallet:another:56:session-2');assert.equal(instance.snapshot().requestId,null);assert.deepEqual(instance.snapshot().symbols,[]);await instance.resume();assert.equal(instance.snapshot().status,'waiting');instance.destroy();
});

test('account switches isolate saved request IDs and ignore an unresolved old account read',async()=>{
 const storage=memory();let release;const pending=new Promise(resolve=>{release=resolve;});
 const {instance}=client({storage,fetchImpl:async()=>{await pending;return response(receipt());}});const original=instance.start();await Promise.resolve();
 instance.setOwner('wallet:another:56:session-2');assert.equal(instance.snapshot().status,'waiting');assert.equal(instance.snapshot().requestId,null);release();await original;assert.equal(instance.snapshot().result,null);
 instance.setOwner(OWNER);assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().status,'unknown');instance.destroy();
});

test('simultaneous explicit starts share one dispatch and timeout leaves the original request unresolved',async()=>{
 let calls=0;const {instance}=client({timeoutMs:5,fetchImpl:async(url,init)=>{calls++;await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('offline abort')),{once:true}));}});
 await Promise.all([instance.start(),instance.start()]);assert.equal(calls,1);assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().error,'REQUEST_TIMEOUT');assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().canStart,false);instance.destroy();
});

test('an abort-ignoring fetch has a hard deadline, retains the original ID and ignores its late success',{timeout:1000},async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release,calls=[];const stalled=new Promise(resolve=>release=resolve);let first=true;
 const {instance}=client({timeoutMs:5,fetchImpl:async(url,init)=>{calls.push({url,init});if(first){first=false;return stalled;}return response(receipt());}});
 const pending=instance.start();await Promise.resolve();t.mock.timers.tick(4);await Promise.resolve();assert.equal(instance.snapshot().status,'processing');
 t.mock.timers.tick(1);const settled=await pending.then(()=>true),before=instance.snapshot();
 release(response(receipt()));await pending;await new Promise(resolve=>setImmediate(resolve));
 try{
  assert.equal(settled,true,'the deadline must settle even when fetch ignores AbortSignal');assert.equal(before.status,'unknown');assert.equal(before.error,'REQUEST_TIMEOUT');assert.equal(before.requestId,ID);assert.equal(before.canStart,false);assert.equal(before.canQuery,true);
  assert.deepEqual(instance.snapshot(),before,'late success cannot replace the timeout state');await assert.rejects(()=>instance.start(),{message:'ORIGINAL_REQUEST_PENDING'});assert.equal(calls.length,1);
  await instance.query();assert.equal(calls.length,2);assert.equal(calls[1].init.method,'GET');assert.equal(calls[1].url,'/api/research/requests/'+ID);assert.equal(instance.snapshot().status,'complete');
 }finally{instance.destroy();}
});

test('an abort-ignoring response body shares the deadline and late bytes never become a report',async()=>{
 let release,reads=0,cancelled=0;const stalled=new Promise(resolve=>release=resolve);
 const reader={read(){return ++reads===1?stalled:Promise.resolve({done:true});},cancel(){cancelled++;return new Promise(()=>{});},releaseLock(){}};
 const {instance}=client({timeoutMs:5,fetchImpl:async()=>({status:200,redirected:false,headers:new Headers({'Content-Type':'application/json'}),body:{getReader:()=>reader}})});
 const pending=instance.start(),settled=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),40))]),before=instance.snapshot();
 release({done:false,value:new TextEncoder().encode(JSON.stringify(receipt()))});await pending;await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(settled,true,'response headers do not end the request deadline');assert.equal(before.error,'REQUEST_TIMEOUT');assert.equal(before.status,'unknown');assert.equal(before.requestId,ID);assert.ok(cancelled>0);assert.deepEqual(instance.snapshot(),before);}
 finally{instance.destroy();}
});

test('fetch and body use one timeout budget, with no late body cancellation rejection leaking',async()=>{
 let release,reads=0;const stalled=new Promise(resolve=>release=resolve),unhandled=[],onUnhandled=reason=>unhandled.push(reason);process.on('unhandledRejection',onUnhandled);
 const reader={read(){return ++reads===1?stalled:Promise.resolve({done:true});},cancel(){return Promise.reject(Error('late cancellation detail'));},releaseLock(){}};
 const {instance}=client({timeoutMs:20,fetchImpl:async()=>{await new Promise(resolve=>setTimeout(resolve,12));return {status:200,redirected:false,headers:new Headers({'Content-Type':'application/json'}),body:{getReader:()=>reader}};}});
 try{
  const pending=instance.start(),settled=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),45))]);
  release({done:false,value:new TextEncoder().encode(JSON.stringify(receipt()))});await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,true);assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().error,'REQUEST_TIMEOUT');assert.equal(instance.snapshot().result,null);assert.deepEqual(unhandled,[]);
 }finally{instance.destroy();process.off('unhandledRejection',onUnhandled);}
});

test('late transport rejection after the hard deadline is handled without publishing another result or posting again',async()=>{
 let rejectLate,calls=0;const stalled=new Promise((_,reject)=>rejectLate=reject),unhandled=[],onUnhandled=reason=>unhandled.push(reason);process.on('unhandledRejection',onUnhandled);
 const {instance}=client({timeoutMs:5,fetchImpl:()=>{calls++;return stalled;}});
 try{
  const pending=instance.start(),settled=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),40))]),before=instance.snapshot();
  rejectLate(Error('late private transport detail'));await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,true);assert.equal(before.error,'REQUEST_TIMEOUT');assert.deepEqual(instance.snapshot(),before);assert.equal(calls,1);assert.deepEqual(unhandled,[]);
 }finally{instance.destroy();process.off('unhandledRejection',onUnhandled);}
});

test('storage failures and corrupt metadata fail closed without losing page drafts or posting',async()=>{
 const draft={amount:250,cap:1000},before=copy(draft);let calls=0;
 const {instance}=client({storage:{getItem:()=>null,setItem(){throw Error('private disk');}},fetchImpl:async()=>{calls++;throw Error();}});await instance.start();assert.equal(calls,0);assert.equal(instance.snapshot().status,'service-unavailable');assert.equal(instance.snapshot().error,'REQUEST_STORAGE_UNAVAILABLE');assert.deepEqual(draft,before);instance.destroy();
 const bad=client({storage:{getItem:()=>'{broken',setItem(){}},fetchImpl:async()=>{calls++;throw Error();}}).instance;assert.equal(bad.snapshot().canStart,false);await assert.rejects(()=>bad.start(),{message:'ORIGINAL_REQUEST_PENDING'});assert.equal(calls,0);bad.destroy();
});

test('invalid JSON, oversize or substituted responses never become successful reports',async()=>{
 for(const send of [()=>new Response('<html>private error</html>',{status:503}),()=>new Response('{bad',{headers:{'Content-Type':'application/json'}}),()=>new Response(' '.repeat(66000),{headers:{'Content-Type':'application/json'}}),()=>response({...receipt(),requestId:'different-request'})]){
  const {instance}=client({fetchImpl:async()=>send()});await instance.start();assert.equal(instance.snapshot().status,'unknown');assert.equal(instance.snapshot().result,null);assert.equal(instance.snapshot().requestId,ID);assert.equal(instance.snapshot().canStart,false);instance.destroy();
 }
});

test('a missing verified-owner reference cannot start or recover a paid request',async()=>{
 let calls=0;const {instance}=client({ownerRef:null,fetchImpl:async()=>{calls++;throw Error();}});await instance.start();await instance.query();await instance.resume();assert.equal(calls,0);assert.equal(instance.snapshot().status,'auth-required');assert.equal(instance.snapshot().canStart,false);instance.destroy();
});

test('result cards escape model text, expose source provenance and offer query instead of repeat dispatch',async()=>{
 const value=receipt();value.result.output.headline='<img src=x onerror=bad()>';value.result.output.summary='<script>bad()</script>';
 const {instance}=client({fetchImpl:async()=>response(value)});await instance.start();const html=renderResearchJob(instance.snapshot());
 assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;script'));assert.doesNotMatch(html,/<img|<script|data-action="(?:buy|start-trade)"/);
 assert.match(html,/Binance Spot/);assert.match(html,/RSI14/);assert.match(html,/data-research-source="market-[a-f0-9]{32}"/);assert.ok(html.includes(pair('查看依据','View evidence')));assert.ok(html.includes(pair('流动性、宏观事件、舆情、链上与账户风险依据待补。','Liquidity, macro-event, sentiment, on-chain and account-risk evidence remains missing.')));
 const source=value.result.sources[0].id;assert.ok(html.includes(`href="#research-source-${ID}-${source}"`));assert.ok(html.includes(`id="research-source-${ID}-${source}"`));
 instance.leave();assert.equal(renderResearchJob(instance.snapshot()),'');instance.destroy();
 const pending=renderResearchJob({status:'unknown',symbols:['BTC'],canStart:false,canQuery:true,error:'REQUEST_TIMEOUT'});assert.match(pending,/data-research-job-action="query"/);assert.doesNotMatch(pending,/data-research-job-action="start"/);
});


test('research allowance errors identify the unavailable allowance without promising a user limit editor',()=>{
 const base={status:'service-unavailable',symbols:['BTC'],canStart:false,canQuery:true};
 const unavailable=renderResearchJob({...base,error:'BUDGET_UNAVAILABLE'}),exhausted=renderResearchJob({...base,error:'BUDGET_EXCEEDED'});
 assert.match(unavailable,/研究额度尚未开通|Research allowance is not enabled/);assert.match(exhausted,/研究额度已用尽|Research allowance is exhausted/);
 for(const markup of [unavailable,exhausted]){assert.match(markup,/data-research-job-action="query"/);assert.doesNotMatch(markup,/data-research-job-action="start"|调整预算|Review the budget/);}
});

test('a model pause retains the original request and offers a read rather than another start',()=>{
 const html=renderResearchJob({status:'service-unavailable',symbols:['BTC'],canStart:false,canQuery:true,error:'MODEL_UNAVAILABLE'});
 assert.match(html,/模型暂不可用|The model is unavailable/);assert.match(html,/data-research-job-action="query"/);assert.doesNotMatch(html,/data-research-job-action="start"/);
});
