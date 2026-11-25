import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {createResearchRuntime,RESEARCH_ORIGIN} from './research-runtime.mjs';
import {createPrivateApiRoute} from './private-api-route.mjs';
import {RESEARCH_MODEL_LIMITS} from './research-analysis-service.mjs';
import {createResearchJobClient,renderResearchJob} from './research-job-client.mjs';
import {createResearchJobCoordinator} from './research-job-coordinator.mjs';
import {pair} from './locale.mjs';

// Fixture fallback for research jobs: no model, network or database is reached. The page
// client, and in one test the page coordinator, drives the real route, runtime, private
// adapters and private RPC client. The private service, the price source and the provider
// are offline doubles. This proves no database locking, real identity or answer quality.
const NOW=Date.UTC(2026,10,16,12),DAY=86400000,BOUNDARY=Math.floor(NOW/DAY)*DAY;
const CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1',PRIVATE_ORIGIN='https://offline-private.example',HOST=new URL(RESEARCH_ORIGIN).host;
const RUNTIME_TOKEN='offline_runtime_credential_01234567890123456789',ISSUER_TOKEN='offline_distinct_issuer_credential_01234567890123456789',PROVIDER_KEY='offline_provider_key_never_sent_to_a_network';
const SESSION='offline_user_a_session_01234567890123456789',OWNER='wallet:56:0x'+'a'.repeat(40),ID='acceptance-request-0001',ANALYZE='/api/research/analyze';
const HEADLINE='Offline headline for the acceptance chain',SUMMARY='Offline summary with independent source groups missing.',CLAIM='Offline claim that the supplied RSI14 is 50.',FOREIGN='market-'+'0'.repeat(32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const wire=result=>json({contract:CONTRACT,result});
const rejected=(code,status)=>json({contract:CONTRACT,code},status);
const lease={leaseId:'lease-acceptance',targetId:'private-target-acceptance',database:'private_research',schema:'astarter_private_research',runtimeRole:'research_runtime',audience:'astarter-research',budgetId:'services-2026-11',model:RESEARCH_MODEL_LIMITS.model,expiresAt:NOW+3600000};
const policy={id:lease.budgetId,from:Date.UTC(2026,10),until:Date.UTC(2026,11),tokenLimit:1000000,requestLimit:100,model:lease.model,limitMicrousd:50000000,fixedServiceMicrousd:0,heldMicrousd:0,spentMicrousd:0,promptMicrousdPerMillion:RESEARCH_MODEL_LIMITS.promptMicrousdPerMillion,completionMicrousdPerMillion:RESEARCH_MODEL_LIMITS.completionMicrousdPerMillion,blocked:false};
const env=()=>({ASTARTER_PRIVATE_SERVICE_ORIGIN:PRIVATE_ORIGIN,ASTARTER_PRIVATE_RUNTIME_TOKEN:RUNTIME_TOKEN,ASTARTER_PRIVATE_ISSUER_TOKEN:ISSUER_TOKEN,ASTARTER_RESEARCH_LEASE_JSON:JSON.stringify(lease),ASTARTER_RESEARCH_MODEL:lease.model,ASTARTER_RESEARCH_MODEL_ENABLED:'1',OPENROUTER_API_KEY:PROVIDER_KEY});
const dailyBars=()=>Array.from({length:300},(_,i)=>[BOUNDARY-(300-i)*DAY,'100','101','99','100','100',BOUNDARY-(299-i)*DAY-1]);
const memory=()=>{const entries=new Map();return {entries,getItem:name=>entries.get(name)??null,setItem:(name,value)=>entries.set(name,String(value))};};
const actions=html=>[...html.matchAll(/data-research-job-action="([a-z]+)"/g)].map(match=>match[1]);
// Card copy in both languages, as the card draws it. The tests run with the Chinese locale.
const copy={
 complete:()=>pair('\u6280\u672f\u89c2\u5bdf\u5df2\u5b8c\u6210','Technical review complete'),
 unconfirmed:()=>pair('\u7ed3\u679c\u5f85\u786e\u8ba4','Result unconfirmed'),
 retained:()=>pair('\u4fdd\u7559\u539f\u7814\u7a76\u8bf7\u6c42\uff0c\u67e5\u8be2\u786e\u8ba4\u540e\u518d\u7ee7\u7eed\u3002','The original request is retained. Check its result before continuing.'),
 check:()=>pair('\u67e5\u8be2\u7ed3\u679c','Check result'),
 checkOriginal:()=>pair('\u539f\u7814\u7a76\u7ed3\u679c\u5f85\u786e\u8ba4\uff0c\u8bf7\u67e5\u8be2\u539f\u8bf7\u6c42\u3002','Check the original research request before continuing.'),
 notFound:()=>pair('\u5c1a\u672a\u67e5\u5230\u539f\u8bf7\u6c42\uff0c\u53ef\u6cbf\u7528\u539f\u7f16\u53f7\u91cd\u8bd5\u3002','Original request not found. Retry using the same ID.')
};

// The private double answers in the record shape of the private service (tenantId, subjectId, scopeId, requestId, fingerprint,
// state, createdAt, expiresAt, result, error, settledTokens, queryOriginalRequest), with null for an absent result or error, and a
// 43-character claim token. Options: a policy patch; more owners (as in the private service, the lease read fails for an owner
// without a policy); a claim stored while its answer is lost. It keeps no budget ledger: holds, releases and cost settlement are not modelled here.
function fixture(options={}){
 const calls=[],records=new Map(),tokens=new Map(),finishes=[],owners=new Map([[hash(SESSION),{subjectId:'person-a',tenantId:'tenant-a',policy:{...policy,...options.policyPatch}}],...(options.owners||[]).map(({session,...entry})=>[hash(session),entry])]);let providerCalls=0;
 const key=body=>body.subjectId+':'+body.tenantId+':'+body.requestId;
 const fetchImpl=async(url,request)=>{
  const target=new URL(url),body=request.body?JSON.parse(request.body):null;calls.push({url,body});
  if(target.origin===PRIVATE_ORIGIN){
   const owner=owners.get(request.headers['X-Astarter-Private-Session-Digest']);if(request.headers.Authorization!=='Bearer '+RUNTIME_TOKEN||!owner)return rejected('PRIVATE_AUTH_REQUIRED',401);
   const path=target.pathname.slice('/internal/private/v1/'.length);
   if(path==='lease')return owner.policy?wire({contract:CONTRACT,kind:'PRIVATE',...lease,now:NOW,policy:owner.policy}):rejected('PRIVATE_UNAVAILABLE',503);
   if(path==='session/resolve')return wire({subjectId:owner.subjectId,tenantId:owner.tenantId,scopeId:owner.tenantId,audience:lease.audience,notBefore:NOW-1000,expiresAt:NOW+3600000,revokedAt:null,permissions:['research:analyze']});
   if(body.subjectId!==owner.subjectId||body.tenantId!==owner.tenantId||body.scopeId!==owner.tenantId)return rejected('PRIVATE_FORBIDDEN',403);
   const record=records.get(key(body));
   if(path==='research/get')return wire(record||null);
   if(path==='research/claim'){
    if(record)return wire({acquired:false,record});
    records.set(key(body),{tenantId:body.tenantId,subjectId:body.subjectId,scopeId:body.scopeId,requestId:body.requestId,fingerprint:body.fingerprint,state:'pending',createdAt:NOW,expiresAt:body.expiresAt,result:null,error:null,settledTokens:null,queryOriginalRequest:false});
    tokens.set(key(body),'offline_claim_'+hash(key(body)).slice(0,29));
    return options.commitUnknown?rejected('PRIVATE_COMMIT_UNKNOWN',409):wire({acquired:true,claimToken:tokens.get(key(body))});
   }
   if(path==='research/finish'){
    finishes.push(body);
    if(!record||record.state!=='pending'||body.claimToken!==tokens.get(key(body)))return rejected('PRIVATE_CONFLICT',409);
    Object.assign(record,{state:body.state,result:body.result??null,error:body.error??null,settledTokens:body.settledTokens,queryOriginalRequest:body.state==='unknown'});
    return wire(record);
   }
   assert.fail('Unrecognized private RPC path');
  }
  if(url==='https://openrouter.ai/api/v1/key')return json({data:{is_management_key:false,limit:50,limit_remaining:49,usage_monthly:1,limit_reset:'monthly'}});
  if(target.hostname==='data-api.binance.vision')return options.sourceDown?new Response('offline',{status:503}):json(dailyBars());
  if(url==='https://openrouter.ai/api/v1/chat/completions'){
   providerCalls++;options.providerStarted?.();if(options.providerGate)await options.providerGate;
   if(options.providerDown)throw Error('offline provider failure');
   const {sources}=JSON.parse(body.messages[1].content);
   const output={outcome:'watch',headline:HEADLINE,summary:SUMMARY,claims:[{text:CLAIM,evidenceIds:[sources[0].symbol===options.foreign?FOREIGN:sources[0].id]}]};
   return json({id:'offline-provider-receipt-'+providerCalls,model:lease.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,cost:.000104,is_byok:false}});
  }
  assert.fail('Unexpected outbound route');
 };
 const runtime=createResearchRuntime({env:options.env||env(),fetchImpl,now:()=>NOW});
 return {route:createPrivateApiRoute('research',runtime.handle),calls,records,finishes,providerCalls:()=>providerCalls,count:path=>calls.filter(call=>call.url.endsWith(path)).length,paths:()=>calls.map(call=>new URL(call.url).pathname)};
}

// One browser tab without a socket. The page's fetch becomes a request object for the route
// and the route's answer a Response. A same-origin GET carries no Origin header. When the page
// aborts, its fetch rejects while the route keeps working, as a server would.
function browser(route,{session=SESSION,origin=RESEARCH_ORIGIN,delay}={}){
 const exchanges=[],open=new Set();
 async function deliver(entry,init){
  await delay?.(entry);
  const headers={host:HOST,'sec-fetch-site':origin===RESEARCH_ORIGIN?'same-origin':'cross-site',...Object.fromEntries(Object.entries(init.headers||{}).map(([name,value])=>[name.toLowerCase(),value])),...(entry.method==='GET'?{}:{origin}),...(entry.sent===null?{}:{'content-length':String(Buffer.byteLength(entry.sent))}),...(session?{cookie:'__Host-astarter_session='+session}:{})};
  const req=Object.assign(Readable.from(entry.sent===null?[]:[entry.sent]),{url:entry.url,method:entry.method,headers});
  let status,head,text;await route(req,{writeHead(code,values){status=code;head=values;},end(value){text=value;}});
  Object.assign(entry,{status,cache:new Headers(head).get('cache-control'),body:JSON.parse(text)});
  return new Response(text,{status,headers:head});
 }
 function fetchImpl(url,init={}){
  const entry={method:init.method||'GET',url,sent:init.body??null,mode:init.cache??null},work=deliver(entry,init);
  exchanges.push(entry);open.add(work);work.catch(()=>{}).finally(()=>open.delete(work));
  const gone=new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new DOMException('The page gave up','AbortError')),{once:true}));gone.catch(()=>{});
  return Promise.race([work,gone]);
 }
 return {fetchImpl,exchanges,idle:()=>Promise.allSettled([...open])};
}
function tab(t,f,{storage=memory(),net,client}={}){
 const link=browser(f.route,net),page=createResearchJobClient({fetchImpl:link.fetchImpl,storage,ownerRef:OWNER,symbols:['BTC'],now:()=>NOW,makeRequestId:()=>ID,...client});
 t.after(()=>page.destroy());
 return {client:page,net:link,storage};
}

test('a page request crosses the real route, runtime and private adapters as one claim before one provider call, and the card draws the report with authority NONE',async t=>{
 const f=fixture(),page=tab(t,f),shown=await page.client.start();
 // The private record holds a null error, as the private service returns it. No answer to the page may carry it.
 const [record]=[...f.records.values()];assert.equal(record.state,'complete');assert.equal(record.error,null);
 assert.deepEqual(page.net.exchanges.map(answer=>[answer.method,answer.url,answer.status,answer.body.state]),[['POST',ANALYZE,200,'complete']]);
 for(const answer of page.net.exchanges){assert.equal(Object.hasOwn(answer.body,'error'),false);assert.doesNotMatch(JSON.stringify(answer.body),/"error":null/);}
 assert.equal(shown.status,'complete');assert.equal(shown.requestId,ID);assert.equal(shown.executionAuthority,'NONE');assert.equal(shown.result.executionAuthority,'NONE');assert.equal(shown.result.responseId,'offline-provider-receipt-1');
 assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);
 const paths=f.paths();assert.ok(paths.indexOf('/internal/private/v1/research/claim')<paths.indexOf('/api/v1/chat/completions'));
 const html=renderResearchJob(shown);
 assert.match(html,/data-research-job-status="complete"/);assert.ok(html.includes(copy.complete()));
 for(const text of [HEADLINE,SUMMARY,CLAIM])assert.ok(html.includes(text),text);
 assert.ok(html.includes(`data-research-source="${shown.result.sources[0].id}"`));
 assert.ok(!renderResearchJob({...shown,result:{...shown.result,executionAuthority:'TRADE'}}).includes(HEADLINE),'a report with another authority is not drawn');
});

test('after a reload the saved request id reads the same report back with GET only: no POST, no new claim, no provider call',async t=>{
 const f=fixture(),storage=memory(),first=tab(t,f,{storage}),before=await first.client.start();
 assert.equal(before.status,'complete');first.client.destroy();const mark=f.calls.length;
 const reloaded=tab(t,f,{storage,client:{makeRequestId:()=>{throw Error('a reload must not make a new request id');}}}),restored=reloaded.client.snapshot();
 assert.equal(restored.status,'unknown');assert.equal(restored.error,'RESUME_REQUIRED');assert.equal(restored.requestId,ID);assert.equal(restored.result,null);assert.equal(restored.canStart,false);assert.equal(reloaded.net.exchanges.length,0);
 const after=await reloaded.client.resume();
 assert.deepEqual(reloaded.net.exchanges.map(answer=>[answer.method,answer.url,answer.status]),[['GET','/api/research/requests/'+ID,200]]);
 assert.equal(Object.hasOwn(reloaded.net.exchanges[0].body,'error'),false);
 assert.deepEqual(after,before);assert.equal(renderResearchJob(after),renderResearchJob(before));assert.ok(renderResearchJob(after).includes(HEADLINE));
 // Since the reload only private reads ran: no claim, finish, price source, provider key check or model call.
 const since=f.calls.slice(mark);assert.ok(since.length>0);assert.ok(since.every(call=>new URL(call.url).origin===PRIVATE_ORIGIN&&!/\/research\/(?:claim|finish)$/.test(call.url)));
 assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);
});

test('today a model answer citing evidence it was not given ends as unknown, not as a report: the card offers only a check that stays unconfirmed, and that asset takes no new research in the tab',async t=>{
 const f=fixture({foreign:'BTC'}),storage=memory(),link=browser(f.route);
 const load=()=>{const jobs=createResearchJobCoordinator({storage,fetchImpl:link.fetchImpl,now:()=>NOW});jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+3600000});t.after(()=>jobs.destroy());return jobs;};
 const jobs=load(),shown=await jobs.start('BTC'),id=shown.requestId,card=jobs.render('BTC');
 // Stored: one finish, kept as unknown, with no result.
 assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);
 const [finish]=f.finishes;assert.equal(finish.state,'unknown');assert.equal(finish.error,'MODEL_INVALID_RESPONSE');assert.equal(finish.queryOriginalRequest,true);assert.equal(finish.settledTokens,null);assert.equal(Object.hasOwn(finish,'result'),false);
 // Answered: HTTP 202 and no result.
 const [answer]=link.exchanges;assert.equal(answer.status,202);assert.equal(answer.body.ok,false);assert.equal(answer.body.state,'unknown');assert.equal(answer.body.error,'MODEL_INVALID_RESPONSE');assert.equal(answer.body.queryOriginalRequest,true);assert.equal(answer.body.result??null,null);
 // Drawn: result unconfirmed, and the check is the only action.
 assert.equal(shown.status,'unknown');assert.equal(shown.result,null);assert.equal(shown.canStart,false);assert.equal(shown.canQuery,true);assert.equal(shown.canRetryOriginal,false);
 assert.match(card,/data-research-job-status="unknown"/);assert.ok(card.includes(copy.unconfirmed()));assert.ok(card.includes(copy.retained()));assert.ok(card.includes(copy.check()));assert.deepEqual(actions(card),['query']);
 // A check reads the same unknown record, and a new start of this asset sends nothing.
 const checked=await jobs.query('BTC');assert.equal(link.exchanges[1].status,200);assert.equal(link.exchanges[1].body.state,'unknown');assert.equal(checked.status,'unknown');assert.deepEqual(actions(jobs.render('BTC')),['query']);
 assert.equal(await jobs.request('BTC'),copy.checkOriginal());assert.equal(link.exchanges.length,2);
 // That nothing of this answer is stored, answered or drawn holds whatever its visible form becomes, so it is asserted
 // in its own test below: 'a model answer citing evidence it was not given is never stored, answered or drawn as a report'.
 // After a reload of the tab the asset still reads unknown and takes no new research. Another asset still can.
 jobs.destroy();const again=load();
 assert.equal((await again.open('BTC')).status,'unknown');assert.equal(again.snapshot('BTC').requestId,id);assert.equal(await again.request('BTC'),copy.checkOriginal());
 assert.equal((await again.start('ETH')).status,'complete');
 assert.deepEqual(link.exchanges.map(sent=>[sent.method,sent.url]),[['POST',ANALYZE],['GET','/api/research/requests/'+id],['GET','/api/research/requests/'+id],['POST',ANALYZE]]);
 assert.equal(f.count('/research/claim'),2);assert.equal(f.providerCalls(),2);
});

test('a page timeout while the service still works is recovered by GET of the original id, with no second POST, claim or provider call',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release,reached;const providerGate=new Promise(resolve=>{release=resolve;}),atProvider=new Promise(resolve=>{reached=resolve;});
 const f=fixture({providerGate,providerStarted:reached}),page=tab(t,f,{client:{timeoutMs:5}});
 try{
  const first=page.client.start();assert.ok(await Promise.race([atProvider.then(()=>true),first.then(()=>false)]),'the provider call was never reached');t.mock.timers.tick(5);const late=await first;
  assert.equal(late.status,'unknown');assert.equal(late.error,'REQUEST_TIMEOUT');assert.equal(late.requestId,ID);assert.equal(late.canStart,false);assert.equal(late.canQuery,true);assert.equal(late.canRetryOriginal,false);
  await assert.rejects(()=>page.client.start(),{message:'ORIGINAL_REQUEST_PENDING'});await assert.rejects(()=>page.client.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
  // The claim exists, so the check finds the request pending and offers no new POST.
  const waiting=await page.client.query();
  assert.equal(page.net.exchanges[1].body.state,'pending');assert.equal(waiting.status,'processing');assert.equal(waiting.canStart,false);assert.equal(waiting.canRetryOriginal,false);
  await assert.rejects(()=>page.client.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
  release();await page.net.idle();assert.equal(page.net.exchanges[0].body.state,'complete');
  const done=await page.client.query();
  assert.equal(done.status,'complete');assert.equal(done.requestId,ID);assert.equal(done.result.responseId,'offline-provider-receipt-1');assert.ok(renderResearchJob(done).includes(HEADLINE));
  assert.deepEqual(page.net.exchanges.map(sent=>sent.method),['POST','GET','GET']);
  assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);
 }finally{release();}
});

test('the same id is posted again only after the route confirmed 404, and the delayed first POST then finds the stored report without a second claim',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release,arrived,posts=0,made=0;const held=new Promise(resolve=>{release=resolve;}),inNetwork=new Promise(resolve=>{arrived=resolve;});
 const delay=entry=>{if(entry.method==='POST'&&++posts===1){arrived();return held;}};
 const f=fixture(),page=tab(t,f,{net:{delay},client:{timeoutMs:5,makeRequestId:()=>{made++;return ID;}}});
 try{
  const first=page.client.start();await inNetwork;t.mock.timers.tick(5);const late=await first;
  // The POST has not reached the route. After the timeout the page may only check.
  assert.equal(late.status,'unknown');assert.equal(late.error,'REQUEST_TIMEOUT');assert.equal(late.canRetryOriginal,false);assert.equal(f.calls.length,0);
  await assert.rejects(()=>page.client.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
  const absent=await page.client.query();
  assert.equal(page.net.exchanges[1].status,404);assert.equal(page.net.exchanges[1].body.error,'REQUEST_NOT_FOUND');
  assert.equal(absent.status,'unknown');assert.equal(absent.canRetryOriginal,true);assert.equal(absent.canStart,false);
  const card=renderResearchJob(absent);assert.deepEqual(actions(card),['retry','query']);assert.ok(card.includes(copy.notFound()));
  await assert.rejects(()=>page.client.start(),{message:'ORIGINAL_REQUEST_PENDING'});
  const done=await page.client.retryOriginal();
  assert.equal(done.status,'complete');assert.equal(done.requestId,ID);assert.equal(f.count('/research/claim'),1);
  release();await page.net.idle();
  const [original,,repeat]=page.net.exchanges;
  assert.deepEqual(page.net.exchanges.map(sent=>sent.method),['POST','GET','POST']);assert.equal(repeat.sent,original.sent);assert.deepEqual(JSON.parse(original.sent),{requestId:ID,symbols:['BTC']});assert.equal(made,1);
  // The first POST arrives late and is answered from the stored record.
  assert.equal(original.body.state,'complete');assert.equal(original.body.result.responseId,done.result.responseId);
  assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);assert.deepEqual(page.client.snapshot(),done);
 }finally{release();}
});

test('private research data stays out of caches and page storage: every route answer says no-store and the page saves only the request reference',async t=>{
 const f=fixture(),storage=memory(),page=tab(t,f,{storage}),shown=await page.client.start();
 page.client.destroy();const reloaded=tab(t,f,{storage});assert.equal((await reloaded.client.resume()).status,'complete');
 assert.equal(storage.entries.size,1);const [[name,value]]=[...storage.entries],saved=JSON.parse(value);
 assert.deepEqual(saved,{version:1,ownerRef:OWNER,requestId:ID,symbols:['BTC'],createdAt:NOW});
 for(const text of [HEADLINE,SUMMARY,CLAIM,shown.result.responseId,shown.result.sources[0].id,SESSION])assert.ok(!(name+value).includes(text),text);
 const post=(body,headers={'Content-Type':'application/json'})=>({method:'POST',headers,body:JSON.stringify(body)}),next={requestId:'acceptance-request-0002',symbols:['BTC']};
 const reach=async(target,net,url,init)=>{const link=browser(target.route,net);await link.fetchImpl(url,init);return link.exchanges[0];};
 const answers=[...page.net.exchanges,...reloaded.net.exchanges];
 for(const [target,net,url,init] of [
  [f,{session:null},'/api/research/requests/'+ID,{method:'GET'}],
  [f,{origin:'https://other.example'},ANALYZE,post(next)],
  [f,{},ANALYZE,post(next,{'Content-Type':'text/plain'})],
  [f,{},ANALYZE,post({...next,requestId:'short'})],
  [f,{},ANALYZE,post({...next,padding:'x'.repeat(2100)})],
  [f,{},'/api/research/other',{method:'GET'}],
  [f,{},ANALYZE,{method:'PUT'}],
  [f,{},'/api/research/requests/'+next.requestId,{method:'GET'}],
  [fixture({sourceDown:true}),{},ANALYZE,post(next)],
  [fixture({providerDown:true}),{},ANALYZE,post(next)],
  [fixture({env:{...env(),ASTARTER_RESEARCH_MODEL_ENABLED:'0'}}),{},ANALYZE,post(next)],
  [fixture({env:{}}),{},ANALYZE,post(next)]
 ])answers.push(await reach(target,net,url,init));
 assert.deepEqual(answers.map(answer=>answer.body.state||answer.body.error),['complete','complete','AUTH_REQUIRED','ORIGIN_DENIED','JSON_REQUIRED','REQUEST_INVALID','BODY_TOO_LARGE','REQUEST_INVALID','METHOD_NOT_ALLOWED','REQUEST_NOT_FOUND','failed','unknown','MODEL_UNAVAILABLE','UNCONFIGURED']);
 for(const answer of answers)assert.equal(answer.cache,'no-store',answer.method+' '+answer.url);
 assert.deepEqual(answers.slice(0,2).map(sent=>sent.mode),['no-store','no-store']);
});

test('today a device clock behind the service clock shows a finished report as unconfirmed until the clock catches up, with no second request',async t=>{
 let device=NOW-2000;const f=fixture(),page=tab(t,f,{client:{now:()=>device}}),shown=await page.client.start();
 const [answer]=page.net.exchanges;assert.equal(answer.status,200);assert.equal(answer.body.state,'complete');assert.equal(answer.body.createdAt,NOW);assert.equal(f.providerCalls(),1);
 assert.equal(shown.status,'unknown');assert.equal(shown.error,'RESEARCH_RESPONSE_INVALID');assert.equal(shown.result,null);assert.equal(shown.canStart,false);assert.equal(shown.canQuery,true);assert.equal(shown.canRetryOriginal,false);
 const html=renderResearchJob(shown);
 assert.match(html,/data-research-job-status="unknown"/);assert.ok(html.includes(copy.unconfirmed()));assert.deepEqual(actions(html),['query']);assert.ok(!html.includes(HEADLINE));
 device=NOW-1;const still=await page.client.query();
 assert.equal(page.net.exchanges[1].body.state,'complete');assert.equal(still.status,'unknown');assert.equal(still.result,null);assert.equal(still.canStart,false);
 device=NOW;const caught=await page.client.query();
 assert.equal(caught.status,'complete');assert.equal(caught.requestId,ID);assert.ok(renderResearchJob(caught).includes(HEADLINE));
 assert.deepEqual(page.net.exchanges.map(sent=>sent.method),['POST','GET','GET']);assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);
});

// A second owner for the owner test, and the card copy of two more states.
const SESSION_B='offline_user_b_session_01234567890123456789',OWNER_B='wallet:56:0x'+'b'.repeat(40);
Object.assign(copy,{
 notEnabled:()=>pair('\u7814\u7a76\u989d\u5ea6\u5c1a\u672a\u5f00\u901a\uff0c\u539f\u8bf7\u6c42\u5df2\u4fdd\u7559\u3002','Research allowance is not enabled. The original request is retained.'),
 researching:()=>pair('\u6b63\u5728\u7814\u7a76','Researching')
});

test('leaving the page while the provider call is held keeps the original request: the late report is not shown, and coming back reads it with one GET of the original id, with no second POST, claim or provider call',async t=>{
 let release,reached;const providerGate=new Promise(resolve=>{release=resolve;}),atProvider=new Promise(resolve=>{reached=resolve;});
 const f=fixture({providerGate,providerStarted:reached}),link=browser(f.route),jobs=createResearchJobCoordinator({storage:memory(),fetchImpl:link.fetchImpl,now:()=>NOW});
 jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+3600000});t.after(()=>jobs.destroy());
 try{
  // The page goes into the back-forward cache (pagehide): every research view is left while the service still works on the request.
  const first=jobs.start('BTC');assert.ok(await Promise.race([atProvider.then(()=>true),first.then(()=>false)]),'the provider call was never reached');jobs.leave();
  const left=await first;assert.equal(left.status,'cancel-view');assert.equal(left.result,null);assert.equal(left.canStart,false);assert.equal(left.canQuery,false);
  release();await link.idle();
  const [post]=link.exchanges,id=JSON.parse(post.sent).requestId;assert.equal(post.body.state,'complete');assert.equal(f.finishes.length,1);
  const hidden=jobs.snapshot('BTC');assert.equal(hidden.status,'cancel-view');assert.equal(hidden.result,null);assert.ok(!jobs.render('BTC').includes(HEADLINE));
  // Coming back to the page (pageshow) opens the asset again and reads the original request.
  const back=await jobs.open('BTC');
  assert.deepEqual(link.exchanges.map(sent=>[sent.method,sent.url,sent.status]),[['POST',ANALYZE,200],['GET','/api/research/requests/'+id,200]]);
  assert.equal(back.status,'complete');assert.equal(back.requestId,id);assert.equal(back.result.responseId,'offline-provider-receipt-1');assert.ok(jobs.render('BTC').includes(HEADLINE));
  // Actions are read from the page client's card: the coordinator's card of a complete report may carry more buttons (the drafts branch adds a strategy draft).
  assert.deepEqual(actions(renderResearchJob(back)),['start','query']);
  assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);
 }finally{release();}
});

test('a model answer citing evidence it was not given is never stored, answered or drawn as a report: not at its answer, not after a check and not after a reload of the tab',async t=>{
 const f=fixture({foreign:'BTC'}),storage=memory(),link=browser(f.route);
 const load=()=>{const jobs=createResearchJobCoordinator({storage,fetchImpl:link.fetchImpl,now:()=>NOW});jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+3600000});t.after(()=>jobs.destroy());return jobs;};
 const jobs=load(),shown=await jobs.start('BTC'),card=jobs.render('BTC');
 assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);assert.equal(Object.hasOwn(f.finishes[0],'result'),false);
 assert.equal(link.exchanges[0].body.result??null,null);assert.notEqual(shown.status,'complete');assert.equal(shown.result,null);
 const checked=await jobs.query('BTC'),afterCheck=jobs.render('BTC');assert.notEqual(checked.status,'complete');assert.equal(checked.result,null);
 jobs.destroy();const again=load(),reopened=await again.open('BTC'),afterReload=again.render('BTC');assert.notEqual(reopened.status,'complete');assert.equal(reopened.result,null);
 const stored=JSON.stringify(f.calls.filter(call=>new URL(call.url).origin===PRIVATE_ORIGIN).map(call=>call.body)),answered=JSON.stringify(link.exchanges.map(sent=>sent.body)),drawn=card+afterCheck+afterReload;
 for(const text of [HEADLINE,SUMMARY,CLAIM,FOREIGN]){assert.ok(!stored.includes(text),text);assert.ok(!answered.includes(text),text);assert.ok(!drawn.includes(text),text);}
 assert.doesNotMatch(drawn,/data-research-job-status="complete"|data-research-source=/);
 assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);
});

test('the one claim of a page request reserves exactly 13056 tokens and 20890 micro-USD under the lease policy, and the finish of the report carries the provider receipt',async t=>{
 const f=fixture(),page=tab(t,f),shown=await page.client.start();assert.equal(shown.status,'complete');
 const sent=path=>f.calls.filter(call=>call.url.endsWith(path)).map(call=>call.body),claims=sent('/research/claim'),finishes=sent('/research/finish');
 assert.equal(claims.length,1);assert.equal(finishes.length,1);const [claim]=claims,[finish]=finishes;
 // 13056 = 12000 + 800 + 256 tokens; 20890 micro-USD = 13056 tokens at the highest per-token price, rounded up.
 assert.equal(claim.reservedTokens,13056);assert.equal(claim.reservedMicrousd,20890);
 assert.equal(claim.requestId,ID);assert.equal(claim.createdAt,NOW);assert.equal(claim.expiresAt,NOW+3600000);
 assert.deepEqual(claim.policy,{id:policy.id,from:policy.from,until:policy.until,tokenLimit:policy.tokenLimit,requestLimit:policy.requestLimit,model:policy.model,limitMicrousd:policy.limitMicrousd,fixedServiceMicrousd:policy.fixedServiceMicrousd,promptMicrousdPerMillion:policy.promptMicrousdPerMillion,completionMicrousdPerMillion:policy.completionMicrousdPerMillion});
 // A complete finish carries the provider's token count and receipt and no settled USD, as the private service's finish input requires for this state.
 assert.equal(finish.state,'complete');assert.equal(finish.settledTokens,140);assert.equal(finish.settledMicrousd,null);
 assert.deepEqual(finish.providerReceipt,{provider:'openrouter',responseId:'offline-provider-receipt-1',model:lease.model,costMicrousd:104,isByok:false});
 assert.deepEqual(finish.result.billing,finish.providerReceipt);assert.deepEqual(shown.result.billing,finish.providerReceipt);
});

test('a provider failure after the call keeps the original request: after a reload a check reads it, a new start and a retry are refused, and a repeated POST of the same id answers from the stored record, with no second claim or provider call',async t=>{
 const f=fixture({providerDown:true}),storage=memory(),first=tab(t,f,{storage}),shown=await first.client.start(),[answer]=first.net.exchanges;
 assert.equal(answer.status,202);assert.equal(answer.body.state,'unknown');assert.equal(answer.body.error,'MODEL_UNAVAILABLE');
 assert.equal(shown.status,'unknown');assert.equal(shown.requestId,ID);assert.equal(shown.canStart,false);assert.equal(shown.canRetryOriginal,false);
 // The finish of an unknown outcome carries no settled tokens, no settled USD and no receipt.
 const [finish]=f.finishes;assert.equal(finish.state,'unknown');assert.equal(finish.settledTokens,null);assert.equal(finish.settledMicrousd,null);assert.equal(finish.providerReceipt,null);
 first.client.destroy();
 const reloaded=tab(t,f,{storage,client:{makeRequestId:()=>{throw Error('a reload must not make a new request id');}}}),read=await reloaded.client.resume();
 assert.equal(read.status,'unknown');assert.equal(read.requestId,ID);
 await assert.rejects(()=>reloaded.client.start(),{message:'ORIGINAL_REQUEST_PENDING'});await assert.rejects(()=>reloaded.client.retryOriginal(),{message:'ORIGINAL_REQUEST_RETRY_UNAVAILABLE'});
 assert.equal((await reloaded.client.query()).status,'unknown');
 assert.deepEqual(reloaded.net.exchanges.map(sent=>[sent.method,sent.status,sent.body.state]),[['GET',200,'unknown'],['GET',200,'unknown']]);
 // A repeated POST of the same id, as a retrying client would send it.
 const repeat=browser(f.route);await repeat.fetchImpl(ANALYZE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:ID,symbols:['BTC']})});
 assert.equal(repeat.exchanges[0].status,202);assert.equal(repeat.exchanges[0].body.state,'unknown');
 assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);
});

test('a policy window that has ended, or a token limit below one reservation, is refused before any provider check, claim, price read or provider call, also on a retry of the original request',async t=>{
 for(const policyPatch of [{from:Date.UTC(2026,9),until:Date.UTC(2026,10)},{tokenLimit:RESEARCH_MODEL_LIMITS.reservedTokens-1}]){
  const f=fixture({policyPatch}),page=tab(t,f),shown=await page.client.start();
  assert.deepEqual(page.net.exchanges.map(sent=>[sent.method,sent.status,sent.body]),[['POST',503,{ok:false,error:'BUDGET_UNAVAILABLE',executionAuthority:'NONE'}]]);
  assert.equal(shown.status,'service-unavailable');assert.equal(shown.error,'BUDGET_UNAVAILABLE');assert.equal(shown.requestId,ID);assert.equal(shown.result,null);assert.equal(shown.canStart,false);
  assert.ok(renderResearchJob(shown).includes(copy.notEnabled()));
  // Nothing was stored, so a check finds no request and offers only a retry of the same id, which is refused the same way.
  const absent=await page.client.query();assert.equal(page.net.exchanges[1].status,404);assert.equal(absent.canRetryOriginal,true);
  const retried=await page.client.retryOriginal();assert.equal(page.net.exchanges[2].status,503);assert.equal(page.net.exchanges[2].body.error,'BUDGET_UNAVAILABLE');assert.equal(retried.status,'service-unavailable');
  assert.equal(f.count('/api/v1/key'),0);assert.equal(f.count('/research/claim'),0);assert.equal(f.calls.filter(call=>new URL(call.url).hostname==='data-api.binance.vision').length,0);assert.equal(f.providerCalls(),0);assert.equal(f.records.size,0);
 }
 // At the edge, a token limit of exactly one reservation is admitted.
 const f=fixture({policyPatch:{tokenLimit:RESEARCH_MODEL_LIMITS.reservedTokens}}),shown=await tab(t,f).client.start();
 assert.equal(shown.status,'complete');assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);
});

test('a second owner without a research policy, with the same request id, is refused before any claim or provider call, and the request and report of the first owner stay as they were',async t=>{
 const f=fixture({owners:[{session:SESSION_B,subjectId:'person-b',tenantId:'tenant-b',policy:null}]});
 const a=tab(t,f),done=await a.client.start();assert.equal(done.status,'complete');const resolved=f.count('/session/resolve');
 const b=tab(t,f,{net:{session:SESSION_B},client:{ownerRef:OWNER_B}}),refused=await b.client.start();
 // The private service's lease read needs the owner's policy for the month, so the second owner is refused before its session is resolved.
 assert.deepEqual(b.net.exchanges.map(sent=>[sent.method,sent.status,sent.body]),[['POST',503,{ok:false,error:'SERVICE_UNAVAILABLE',executionAuthority:'NONE'}]]);assert.equal(f.count('/session/resolve'),resolved);
 assert.equal(refused.status,'service-unavailable');assert.equal(refused.result,null);assert.equal(refused.canStart,false);assert.ok(!renderResearchJob(refused).includes(HEADLINE));
 assert.equal(f.count('/research/claim'),1);assert.equal(f.providerCalls(),1);assert.deepEqual([...f.records.keys()],['person-a:tenant-a:'+ID]);
 assert.deepEqual(await a.client.query(),done);assert.equal(f.providerCalls(),1);
});

test('today a request whose claim was stored while its answer was lost stays pending, and nothing in the chain finishes it: the page shows it as researching with only a check, also once the service flags it for an original-request query, and that asset takes no new research in the tab',async t=>{
 const f=fixture({commitUnknown:true}),link=browser(f.route),jobs=createResearchJobCoordinator({storage:memory(),fetchImpl:link.fetchImpl,now:()=>NOW});
 jobs.setIdentity({ownerRef:OWNER,expiresAt:NOW+3600000});t.after(()=>jobs.destroy());
 const shown=await jobs.start('BTC'),[answer]=link.exchanges;
 assert.equal(answer.status,503);assert.equal(answer.body.error,'OUTCOME_UNKNOWN');
 assert.equal(shown.status,'unknown');assert.equal(shown.error,'OUTCOME_UNKNOWN');assert.equal(shown.canStart,false);assert.equal(shown.canQuery,true);assert.equal(shown.canRetryOriginal,false);
 const [record]=[...f.records.values()];assert.equal(record.state,'pending');assert.equal(record.requestId,JSON.parse(answer.sent).requestId);
 // A later check, first within the request's expiry, then once the service flags it, as it does for a pending request past its expiry.
 for(const flagged of [false,true]){
  record.queryOriginalRequest=flagged;
  const read=await jobs.query('BTC'),sent=link.exchanges.at(-1),card=jobs.render('BTC');
  assert.equal(sent.method,'GET');assert.equal(sent.status,200);assert.equal(sent.body.state,'pending');assert.equal(sent.body.queryOriginalRequest,flagged);
  assert.equal(read.status,'processing');assert.equal(read.canStart,false);assert.equal(read.canQuery,true);assert.equal(read.canRetryOriginal,false);
  assert.match(card,/data-research-job-status="processing"/);assert.ok(card.includes(copy.researching()));assert.deepEqual(actions(card),['query']);
  const before=link.exchanges.length;assert.equal(await jobs.request('BTC'),null);assert.equal(link.exchanges.length,before);
 }
 assert.deepEqual(link.exchanges.map(sent=>sent.method),['POST','GET','GET']);
 assert.equal(f.count('/research/claim'),1);assert.equal(f.finishes.length,0);assert.equal(f.providerCalls(),0);assert.equal(record.state,'pending');
});
