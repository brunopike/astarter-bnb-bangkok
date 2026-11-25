import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPrivateResearchClient,createPrivateUIClient,createPrivateIssuerClient,PRIVATE_RESEARCH_CONTRACT} from './private-service-client.mjs';
import {createResearchPrivateAdapters} from './research-private-store.mjs';

const ORIGIN='https://reviewed-private.example',TOKEN='offline_private_service_credential_01234567890123456789',CAS='offline_cas_token_012345678901234567890';
const owner={subjectId:'person-one',scopeId:'private-tenant',tenantId:'private-tenant',requestId:'research-request-0001',leaseId:'lease-one',targetId:'reviewed-private-target',audience:'astarter-research'};
const payloads={
 inspectLease:{leaseId:owner.leaseId,targetId:owner.targetId,audience:owner.audience},
 resolveSession:{tokenDigest:'a'.repeat(64),audience:owner.audience,leaseId:owner.leaseId,targetId:owner.targetId,now:1000},
 get:{...owner},
 claim:{...owner,fingerprint:'b'.repeat(64),createdAt:1000,expiresAt:2000,reservedTokens:13056,reservedMicrousd:20890,policy:{id:'services-month',from:0,until:3000,tokenLimit:20000,requestLimit:1,model:'openai/gpt-4.1-mini',limitMicrousd:50000000,fixedServiceMicrousd:0,promptMicrousdPerMillion:400000,completionMicrousdPerMillion:1600000}},
 finish:{...owner,claimToken:CAS,state:'unknown',settledTokens:null,settledMicrousd:null,providerReceipt:null,error:'MODEL_TIMEOUT',queryOriginalRequest:true}
};
const response=(result={},options={})=>new Response(JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result}),{headers:{'Content-Type':'application/json'},...options});
const client=(fetchImpl,more={})=>createPrivateResearchClient({origin:ORIGIN,token:TOKEN,sessionDigest:'a'.repeat(64),fetchImpl,...more});
function sanitized(issue,unknown=false){assert.equal(issue.status,503);assert.equal(issue.outcomeUnknown,unknown);assert.ok(!String(issue.stack).includes(TOKEN));assert.ok(!String(issue.stack).includes(ORIGIN));assert.ok(!String(issue.stack).includes('driver-secret'));return true;}

test('construction performs no IO and missing or unsafe server configuration remains closed',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response();};
 const good=client(fetchImpl);assert.equal(good.configured,true);assert.equal(good.contract,PRIVATE_RESEARCH_CONTRACT);assert.equal(calls,0);assert.ok(Object.isFrozen(good));
 for(const patch of [{origin:''},{origin:'http://private.example'},{origin:ORIGIN+'/'},{origin:ORIGIN+':444'},{origin:'https://user:password@private.example'},{origin:ORIGIN+'?x=1'},{origin:ORIGIN+'#fragment'},{origin:ORIGIN+'/api'},{origin:'https://reviewed-private.example:443'},{token:'short'},{token:TOKEN+'\r\nX-Test: exposed'},{timeoutMs:0},{timeoutMs:15001}]){
  const c=client(fetchImpl,patch);assert.equal(c.configured,false);await assert.rejects(()=>c.inspectLease(payloads.inspectLease),e=>{assert.equal(e.message,'PRIVATE_RPC_UNCONFIGURED');return sanitized(e);});
 }
 assert.equal(createPrivateResearchClient().configured,false);assert.equal(calls,0);
});
test('five fixed POST endpoints omit browser cookies and carry only dedicated server authentication',async()=>{
 const calls=[],paths=['lease','session/resolve','research/get','research/claim','research/finish'];
 const c=client(async(url,options)=>{calls.push({url,options});return response(url.endsWith('/claim')?{acquired:true,claimToken:CAS}:{state:'fixture-result'});});
 for(const [method,payload] of Object.entries(payloads))await c[method](payload);
 assert.deepEqual(calls.map(call=>call.url),paths.map(path=>ORIGIN+'/internal/private/v1/'+path));
 for(const [i,call] of calls.entries()){
  assert.equal(call.options.method,'POST');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');assert.equal(call.options.cache,'no-store');
  assert.deepEqual(call.options.headers,{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json','X-Astarter-Private-Session-Digest':'a'.repeat(64)});assert.equal(call.options.headers.Cookie,undefined);
  assert.deepEqual(JSON.parse(call.options.body),Object.values(payloads)[i]);assert.ok(!call.options.body.includes(TOKEN));assert.ok(call.options.signal instanceof AbortSignal);
 }
 assert.equal(c.post,undefined);assert.equal(c.fetch,undefined);
});
test('private records require a per-request session digest and resolve cannot swap the bound identity',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response();};
 for(const sessionDigest of ['',undefined,'bad','a'.repeat(63),'A'.repeat(64),'a'.repeat(64)+'\r\nX-Test: secret']){
  const c=client(fetchImpl,{sessionDigest});
  for(const method of Object.keys(payloads))await assert.rejects(()=>c[method](payloads[method]),e=>{assert.equal(e.message,'AUTH_REQUIRED');assert.equal(e.status,401);assert.equal(e.outcomeUnknown,false);return true;});
 }
 const c=client(fetchImpl);await assert.rejects(()=>c.resolveSession({...payloads.resolveSession,tokenDigest:'b'.repeat(64)}),{message:'AUTH_REQUIRED'});assert.equal(calls,0);
 await assert.rejects(()=>client(fetchImpl,{sessionDigest:''}).inspectLease(payloads.inspectLease),{message:'AUTH_REQUIRED'});assert.equal(calls,0,'the tenant lease also requires the outer request session');
 const sent=[],a=client(async(_url,options)=>{sent.push(options.headers);return response();}),b=client(async(_url,options)=>{sent.push(options.headers);return response();},{sessionDigest:'b'.repeat(64)});
 await Promise.all([a.get(payloads.get),b.get(payloads.get)]);assert.deepEqual(sent.map(h=>h['X-Astarter-Private-Session-Digest']),['a'.repeat(64),'b'.repeat(64)]);
 await assert.rejects(()=>a.get({...owner,'X-Astarter-Private-Session-Digest':'b'.repeat(64)}),{message:'PRIVATE_RPC_INVALID_REQUEST'});assert.equal(sent.length,2);
});
test('browser-shaped, URL-bearing, secret-bearing or oversized request payloads fail before transport',async()=>{
 let calls=0;const c=client(async()=>{calls++;return response();});
 for(const payload of [null,[],{...owner,url:'https://evil.example'},{...owner,origin:ORIGIN},{...owner,cookie:'astarter_preview=anything'},{...owner,maxPrice:1},{...owner,subjectId:undefined},{...owner,subjectId:TOKEN},{...owner,subjectId:NaN}])await assert.rejects(()=>c.get(payload),{message:'PRIVATE_RPC_INVALID_REQUEST'});
 const huge={...payloads.finish,result:{text:'x'.repeat(16384)}};await assert.rejects(()=>c.finish(huge),{message:'PRIVATE_RPC_INVALID_REQUEST'});
 const getter={...owner};Object.defineProperty(getter,'subjectId',{enumerable:true,get(){throw Error('driver-secret');}});await assert.rejects(()=>c.get(getter),{message:'PRIVATE_RPC_INVALID_REQUEST'});
 assert.equal(calls,0);
});
test('a bounded camelCase lease/session/request envelope is returned unchanged, including explicit null reads',async()=>{
 const result={kind:'PRIVATE',leaseId:'lease-one',database:'private_research',runtimeRole:'research_runtime',policy:{limitMicrousd:50000000,heldMicrousd:20890},notes:'已核对私有目标'};
 assert.deepEqual(await client(async()=>response(result)).inspectLease(payloads.inspectLease),result);
 for(const method of ['get','resolveSession'])assert.equal(await client(async()=>response(null))[method](payloads[method]),null);
 await assert.rejects(()=>client(async()=>response(null)).inspectLease(payloads.inspectLease),e=>{assert.equal(e.message,'PRIVATE_RPC_PROTOCOL');return sanitized(e);});
});
test('redirects, unexpected final URLs and non-JSON transport are never followed or passed through',async()=>{
 for(const make of [()=>new Response('',{status:302,headers:{Location:'https://evil.example','Content-Type':'application/json'}}),()=>{const r=response();Object.defineProperty(r,'redirected',{value:true});return r;},()=>{const r=response();Object.defineProperty(r,'url',{value:'https://evil.example/internal/private/v1/lease'});return r;},()=>new Response('html driver-secret',{headers:{'Content-Type':'text/html'}}),()=>new Response(null,{status:204})]){
  let calls=0;await assert.rejects(()=>client(async()=>{calls++;return make();}).inspectLease(payloads.inspectLease),sanitized);assert.equal(calls,1);
 }
});
test('malformed, wrong-contract, primitive and extra-field envelopes cannot become a DAL result',async()=>{
 for(const raw of ['{','null','[]',JSON.stringify({contract:'PUBLIC_READER',result:{}}),JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result:{},debug:'driver-secret'}),JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result:1}),JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT}),JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result:[]})])await assert.rejects(()=>client(async()=>new Response(raw,{headers:{'Content-Type':'application/json'}})).inspectLease(payloads.inspectLease),e=>sanitized(e));
});
test('content length and accumulated stream bytes enforce the same hard response limit',async()=>{
 for(const r of [response({}, {headers:{'Content-Type':'application/json','Content-Length':'65537'}}),response({}, {headers:{'Content-Type':'application/json','Content-Length':'invalid'}}),new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(40000));controller.enqueue(new Uint8Array(30000));controller.close();}}),{headers:{'Content-Type':'application/json'}})])await assert.rejects(()=>client(async()=>r).inspectLease(payloads.inspectLease),e=>{assert.equal(e.message,'PRIVATE_RPC_PROTOCOL');return sanitized(e);});
});
test('the whole-call deadline aborts hanging fetch without trusting transport cancellation',async()=>{
 let calls=0,aborted=0;const c=client(async(_url,{signal})=>{calls++;signal.addEventListener('abort',()=>aborted++);return new Promise(()=>{});},{timeoutMs:50});
 await assert.rejects(()=>c.inspectLease(payloads.inspectLease),e=>{assert.equal(e.message,'PRIVATE_RPC_UNAVAILABLE');return sanitized(e);});assert.equal(calls,1);assert.equal(aborted,1);
});
test('the deadline includes a body that hangs after successful response headers',async()=>{
 let cancelled=0;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"contract":'));},cancel(){cancelled++;}});
 await assert.rejects(()=>client(async()=>new Response(stream,{headers:{'Content-Type':'application/json'}}),{timeoutMs:50}).inspectLease(payloads.inspectLease),e=>{assert.equal(e.message,'PRIVATE_RPC_UNAVAILABLE');return sanitized(e);});assert.equal(cancelled,1);
});
test('stream errors and invalid UTF-8 return sanitized failures rather than raw response details',async()=>{
 for(const stream of [new ReadableStream({start(controller){controller.error(Error('driver-secret '+TOKEN+' '+ORIGIN));}}),new ReadableStream({start(controller){controller.enqueue(new Uint8Array([0xc3,0x28]));controller.close();}})])await assert.rejects(()=>client(async()=>new Response(stream,{headers:{'Content-Type':'application/json'}})).inspectLease(payloads.inspectLease),e=>sanitized(e));
});
test('response credentials, database URLs and escaped service tokens are rejected, while CAS is confined to claim',async()=>{
 for(const result of [{authorization:'Bearer anything'},{nested:{private_key:'0x'+'a'.repeat(64)}},{sessionToken:'different-secret'},{config:{password:'different-secret'}},{dsn:'postgres://user:password@database/db'},{text:'https://name:password@database.example/'},{text:TOKEN},{text:'sk-or-v1-'+'a'.repeat(32)},{claimToken:CAS}])await assert.rejects(()=>client(async()=>response(result)).get(payloads.get),e=>{assert.equal(e.message,'PRIVATE_RPC_PROTOCOL');return sanitized(e);});
 const raw=JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,result:{text:TOKEN}}).replace(TOKEN,[...TOKEN].map(ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
 await assert.rejects(()=>client(async()=>new Response(raw,{headers:{'Content-Type':'application/json'}})).get(payloads.get),e=>sanitized(e));
 assert.deepEqual(await client(async()=>response({acquired:true,claimToken:CAS})).claim(payloads.claim),{acquired:true,claimToken:CAS});
 await assert.rejects(()=>client(async()=>response({acquired:false,record:{claimToken:CAS}})).claim(payloads.claim),e=>sanitized(e,true));
});
test('claim and finish failures after dispatch are unknown and never automatically retried',async()=>{
 for(const method of ['claim','finish'])for(const make of [()=>{throw Error('driver-secret '+TOKEN+' '+ORIGIN);},()=>new Response('driver-secret',{status:503}),()=>new Response('{',{headers:{'Content-Type':'application/json'}}),()=>new Response('',{status:307,headers:{Location:'https://evil.example'}})]){
  let calls=0;const c=client(async()=>{calls++;return make();});
  await assert.rejects(()=>c[method](payloads[method]),e=>{assert.equal(e.message,'PRIVATE_RPC_OUTCOME_UNKNOWN');return sanitized(e,true);});assert.equal(calls,1);
 }
});
test('timed-out mutation preserves the original request ID for an explicit read reconciliation',async()=>{
 const calls=[];const c=client(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);if(url.endsWith('/claim'))return new Promise(()=>{});return response({...owner,state:'pending'});},{timeoutMs:50});
 await assert.rejects(()=>c.claim(payloads.claim),e=>sanitized(e,true));
 assert.equal(calls.length,1);const original=await c.get(payloads.get);assert.equal(original.requestId,owner.requestId);assert.equal(original.state,'pending');assert.equal(calls.length,2);assert.ok(calls.every(([,body])=>body.requestId===owner.requestId));
});
test('the concrete RPC contract composes with the private session, budget and CAS adapter',async()=>{
 // Offline wire-contract fixture; this does not establish PostgreSQL durability.
 const now=Date.UTC(2026,10,16,12),lease={leaseId:owner.leaseId,targetId:owner.targetId,database:'private_research',schema:'astarter_private_research',runtimeRole:'research_runtime',audience:owner.audience,budgetId:'services-2026-11',model:'openai/gpt-4.1-mini',expiresAt:now+3600000};
 const policy={id:lease.budgetId,from:Date.UTC(2026,10),until:Date.UTC(2026,11),tokenLimit:30000,requestLimit:2,model:lease.model,limitMicrousd:50000000,fixedServiceMicrousd:0,heldMicrousd:0,spentMicrousd:0,promptMicrousdPerMillion:400000,completionMicrousdPerMillion:1600000,blocked:false};
 let record=null;const calls=[],dal=client(async(url,options)=>{
  const body=JSON.parse(options.body),method=url.slice((ORIGIN+'/internal/private/v1/').length);calls.push(method);
  if(method==='lease')return response({contract:PRIVATE_RESEARCH_CONTRACT,kind:'PRIVATE',...lease,now,policy});
  if(method==='session/resolve')return response({subjectId:owner.subjectId,tenantId:owner.tenantId,audience:owner.audience,notBefore:now-1000,expiresAt:now+3600000,revokedAt:null,permissions:['research:analyze']});
  if(method==='research/get')return response(record);
  if(method==='research/claim'){record={...body,state:'pending'};return response({acquired:true,claimToken:CAS});}
  if(method==='research/finish'){const {claimToken,...safe}=body;assert.equal(claimToken,CAS);Object.assign(record,safe);return response(record);}
  assert.fail('Unexpected RPC path');
 },{sessionDigest:createHash('sha256').update('offline_browser_session_01234567890123456789').digest('hex')});
 const a=createResearchPrivateAdapters({dal,lease,now:()=>now});assert.equal(a.configured,true);
 const principal=await a.authorize({headers:{authorization:'Bearer offline_browser_session_01234567890123456789'}}),admission=await a.admission(principal);
 assert.equal(principal.subjectId,owner.subjectId);assert.equal(principal.scopeId,owner.tenantId);assert.equal(await a.store.get(owner),null);
 const claimed=await a.store.claim({...owner,fingerprint:'b'.repeat(64),createdAt:now,expiresAt:now+1800000,reservedTokens:13056,policy:admission});assert.equal(claimed.claimToken,CAS);assert.equal(record.reservedMicrousd,20890);
 const finished=await a.store.finish({...owner,claimToken:claimed.claimToken,state:'unknown',settledTokens:null,error:'MODEL_TIMEOUT',queryOriginalRequest:true});assert.equal(finished.state,'unknown');assert.equal(finished.settledMicrousd,null);assert.equal(finished.queryOriginalRequest,true);
 assert.equal((await a.store.get(owner)).state,'unknown');assert.equal(calls.filter(m=>m==='research/claim').length,1);
});

const remote=(code,status)=>new Response(JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,code}),{status,headers:{'Content-Type':'application/json'}});
test('only exact owner error codes and status pairs pass through, preserving known rejection versus unknown commit',async()=>{
 for(const [code,status] of [['PRIVATE_AUTH_REQUIRED',401],['PRIVATE_FORBIDDEN',403],['PRIVATE_TARGET_MISMATCH',403],['PRIVATE_REQUEST_INVALID',400],['PRIVATE_CONFLICT',409],['BUDGET_EXCEEDED',409],['PRIVATE_UNCONFIGURED',503]]){
  let calls=0;await assert.rejects(()=>client(async()=>{calls++;return remote(code,status);}).claim(payloads.claim),e=>{assert.equal(e.message,code);assert.equal(e.code,code);assert.equal(e.status,status);assert.equal(e.outcomeUnknown,false);assert.ok(!e.stack.includes(TOKEN));return true;});assert.equal(calls,1);
 }
 for(const [code,status] of [['PRIVATE_COMMIT_UNKNOWN',409],['PRIVATE_UNAVAILABLE',503]])await assert.rejects(()=>client(async()=>remote(code,status)).finish(payloads.finish),e=>{assert.equal(e.code,code);assert.equal(e.status,status);assert.equal(e.outcomeUnknown,true);return true;});
 await assert.rejects(()=>client(async()=>remote('PRIVATE_UNAVAILABLE',503)).get(payloads.get),e=>{assert.equal(e.code,'PRIVATE_UNAVAILABLE');return sanitized(e);});
 for(const [code,status] of [['driver-secret '+TOKEN,503],['BUDGET_EXCEEDED',401],['PRIVATE_AUTH_REQUIRED',409],['PRIVATE_CONFLICT',500]])await assert.rejects(()=>client(async()=>remote(code,status)).claim(payloads.claim),e=>{assert.equal(e.code,'PRIVATE_RPC_OUTCOME_UNKNOWN');return sanitized(e,true);});
 const extra=new Response(JSON.stringify({contract:PRIVATE_RESEARCH_CONTRACT,code:'BUDGET_EXCEEDED',debug:'driver-secret'}),{status:409,headers:{'Content-Type':'application/json'}});await assert.rejects(()=>client(async()=>extra).claim(payloads.claim),e=>sanitized(e,true));
});

const ISSUER_TOKEN='offline_distinct_issuer_credential_01234567890123456789',CHALLENGE_HASH='c'.repeat(64),SESSION_HASH='d'.repeat(64),NONCE='e'.repeat(64);
const challenge={challengeHash:CHALLENGE_HASH,nonce:NONCE,origin:'https://astarter.imstark.site',issuedAt:1000,expires:301000,address:null,chain:null,message:null};
const prepared={...challenge,address:'0x0000000000000000000000000000000000000001',chain:56,message:'Astarter SIWE message fixture'};
const session={tokenHash:SESSION_HASH,address:prepared.address,chain:56,origin:challenge.origin,subjectId:owner.subjectId,scopeId:owner.scopeId,issuedAt:1000,expires:604801000,permissions:['research:analyze']};
const issuerPayloads={
 issueChallenge:challenge,
 getChallenge:{challengeHash:CHALLENGE_HASH,now:1000},
 prepareChallenge:{challengeHash:CHALLENGE_HASH,nonce:NONCE,address:prepared.address,chain:56,message:prepared.message,now:1000},
 consumeChallenge:{challengeHash:CHALLENGE_HASH,nonce:NONCE,address:prepared.address,chain:56,message:prepared.message,now:1000},
 revokeChallenge:{challengeHash:CHALLENGE_HASH,now:1000},
 issueSession:{tokenHash:SESSION_HASH,previousTokenHash:null,challengeHash:CHALLENGE_HASH,claimToken:CAS,address:prepared.address,chain:56,origin:challenge.origin,issuedAt:1000,expires:604801000,permissions:['research:analyze']},
 resolveSession:{tokenHash:SESSION_HASH,now:1000},
 revokeSession:{tokenHash:SESSION_HASH,now:1000}
};
const issuer=(fetchImpl,more={})=>createPrivateIssuerClient({origin:ORIGIN,token:ISSUER_TOKEN,fetchImpl,...more});
test('issuer exposes eight fixed endpoints with its own credential and no browser cookie or runtime session header',async()=>{
 const calls=[],results={issueChallenge:challenge,getChallenge:challenge,prepareChallenge:prepared,consumeChallenge:{challenge:prepared,claimToken:CAS},revokeChallenge:true,issueSession:session,resolveSession:session,revokeSession:true};
 const paths=['auth/challenge/issue','auth/challenge/get','auth/challenge/prepare','auth/challenge/consume','auth/challenge/revoke','auth/session/issue','auth/session/resolve','auth/session/revoke'];
 const c=issuer(async(url,options)=>{calls.push({url,options});return response(Object.values(results)[calls.length-1]);});
 assert.equal(c.configured,true);assert.equal(calls.length,0);assert.equal(c.claim,undefined);assert.equal(c.get,undefined);assert.equal(c.inspectLease,undefined);assert.equal(client(async()=>response()).issueSession,undefined);
 for(const [method,body] of Object.entries(issuerPayloads))assert.deepEqual(await c[method](body),results[method]);
 assert.deepEqual(calls.map(call=>call.url),paths.map(path=>ORIGIN+'/internal/private/v1/'+path));
 for(const [index,{options}] of calls.entries()){
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.deepEqual(options.headers,{Authorization:'Bearer '+ISSUER_TOKEN,'Content-Type':'application/json',Accept:'application/json'});
  assert.deepEqual(JSON.parse(options.body),Object.values(issuerPayloads)[index]);assert.ok(!options.body.includes(ISSUER_TOKEN));assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers['X-Astarter-Private-Session-Digest'],undefined);
 }
});
test('issuer accepts typed nullable records and boolean revocation results without interpreting identity DTOs',async()=>{
 for(const method of ['getChallenge','prepareChallenge','consumeChallenge','issueSession','resolveSession'])assert.equal(await issuer(async()=>response(null))[method](issuerPayloads[method]),null);
 for(const method of ['revokeSession','revokeChallenge'])for(const value of [true,false])assert.equal(await issuer(async()=>response(value))[method](issuerPayloads[method]),value);
 await assert.rejects(()=>issuer(async()=>response(true)).getChallenge(issuerPayloads.getChallenge),{code:'PRIVATE_RPC_PROTOCOL'});
 assert.equal(createPrivateIssuerClient().configured,false);
});
test('issuer allows only 64-hex identity digests and its top-level consume CAS token up to 128 characters',async()=>{
 assert.equal((await issuer(async()=>response({challenge:prepared,claimToken:'x'.repeat(128)})).consumeChallenge(issuerPayloads.consumeChallenge)).claimToken.length,128);
 for(const result of [{challenge:prepared,claimToken:'x'.repeat(129)},{challenge:prepared,claimToken:'invalid\nclaim'},{challenge:prepared,claimToken:ISSUER_TOKEN},{challenge:{...prepared,challengeHash:'raw-cookie'},claimToken:CAS},{challenge:prepared,nested:{claimToken:CAS}},{challenge:prepared,privateKey:'different-private-key'}])await assert.rejects(()=>issuer(async()=>response(result)).consumeChallenge(issuerPayloads.consumeChallenge),e=>{assert.equal(e.code,'PRIVATE_RPC_OUTCOME_UNKNOWN');assert.equal(e.outcomeUnknown,true);assert.ok(!e.stack.includes(ISSUER_TOKEN));return true;});
 for(const result of [{...session,tokenHash:'not-a-digest'},{...session,tokenHash:'d'.repeat(63)},{...session,claimToken:CAS},{...session,accessToken:'different-raw-token'}])await assert.rejects(()=>issuer(async()=>response(result)).resolveSession(issuerPayloads.resolveSession),{code:'PRIVATE_RPC_PROTOCOL'});
 let calls=0;const c=issuer(async()=>{calls++;return response();});
 for(const body of [{...issuerPayloads.issueSession,tokenHash:'raw-token'},{...issuerPayloads.issueSession,previousTokenHash:'short'},{...issuerPayloads.issueSession,token:'raw-token'},{...issuerPayloads.issueSession,cookie:'anything'},{...issuerPayloads.issueSession,claimToken:'x'.repeat(129)}])await assert.rejects(()=>c.issueSession(body),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 assert.equal(calls,0);
});
test('issuer writes and nonce consumption never retry uncertain outcomes while read methods remain read-only',async()=>{
 for(const method of ['issueChallenge','prepareChallenge','consumeChallenge','revokeChallenge','issueSession','revokeSession']){
  let calls=0;await assert.rejects(()=>issuer(async()=>{calls++;throw Error('driver-secret '+ISSUER_TOKEN);})[method](issuerPayloads[method]),e=>{assert.equal(e.code,'PRIVATE_RPC_OUTCOME_UNKNOWN');assert.equal(e.outcomeUnknown,true);assert.equal(e.status,503);assert.ok(!e.stack.includes(ISSUER_TOKEN));return true;});assert.equal(calls,1);
  await assert.rejects(()=>issuer(async()=>remote('PRIVATE_COMMIT_UNKNOWN',409))[method](issuerPayloads[method]),e=>{assert.equal(e.code,'PRIVATE_COMMIT_UNKNOWN');assert.equal(e.outcomeUnknown,true);return true;});
  await assert.rejects(()=>issuer(async()=>remote('PRIVATE_CONFLICT',409))[method](issuerPayloads[method]),e=>{assert.equal(e.code,'PRIVATE_CONFLICT');assert.equal(e.outcomeUnknown,false);return true;});
 }
 for(const method of ['getChallenge','resolveSession'])await assert.rejects(()=>issuer(async()=>{throw Error('driver-secret '+ISSUER_TOKEN);})[method](issuerPayloads[method]),e=>{assert.equal(e.code,'PRIVATE_RPC_UNAVAILABLE');assert.equal(e.outcomeUnknown,false);assert.ok(!e.stack.includes(ISSUER_TOKEN));return true;});
});
test('issuer inherits the bounded body deadline and redirect rejection without exposing its secret',async()=>{
 let cancelled=0;const stream=new ReadableStream({cancel(){cancelled++;}});
 await assert.rejects(()=>issuer(async()=>new Response(stream,{headers:{'Content-Type':'application/json'}}),{timeoutMs:50}).consumeChallenge(issuerPayloads.consumeChallenge),{code:'PRIVATE_RPC_OUTCOME_UNKNOWN',outcomeUnknown:true});assert.equal(cancelled,1);
 await assert.rejects(()=>issuer(async()=>new Response('',{status:307,headers:{Location:'https://evil.example'}})).issueSession(issuerPayloads.issueSession),{code:'PRIVATE_RPC_OUTCOME_UNKNOWN'});
});

const uiBase={leaseId:owner.leaseId,targetId:owner.targetId,audience:owner.audience};
const uiPayloads={
 inspectLease:payloads.inspectLease,
 resolveSession:payloads.resolveSession,
 notificationsState:{...uiBase,cursor:null,limit:20},
 notificationsCommand:{...uiBase,requestId:'notifications-request-0001',baseRevision:0,action:'save',payload:{events:['orders'],enabled:{telegram:false,email:false},inapp:true}},
 notificationsRequest:{...uiBase,requestId:'notifications-request-0001'},
 workspaceState:{...uiBase},
 workspaceSave:{...uiBase,requestId:'workspace-request-0001',baseRevision:0,preferences:{workbenchFilter:'all',workbenchFocusAsset:'BTC',watchedAssets:[]},drafts:[],selectedDraftId:null},
 workspaceRequest:{...uiBase,requestId:'workspace-request-0001'}
};
const ui=(fetchImpl,more={})=>createPrivateUIClient({origin:ORIGIN,token:TOKEN,sessionDigest:'a'.repeat(64),fetchImpl,...more});
test('only notifications state opts into responseVersion integer two without changing legacy request bytes',async()=>{
 const calls=[],c=ui(async(url,options)=>{calls.push({url,options});return response({});});
 await c.notificationsState(uiPayloads.notificationsState);assert.equal(calls[0].options.body,JSON.stringify(uiPayloads.notificationsState));
 const next={...uiPayloads.notificationsState,responseVersion:2};await c.notificationsState(next);assert.equal(calls[1].options.body,JSON.stringify(next));assert.equal(calls[1].url,ORIGIN+'/internal/private/v1/notifications/state');assert.equal(calls[1].options.headers['X-Astarter-Private-Session-Digest'],'a'.repeat(64));
 for(const responseVersion of [1,3,'2',true,null,undefined,2.1])await assert.rejects(()=>c.notificationsState({...uiPayloads.notificationsState,responseVersion}),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 for(const method of Object.keys(uiPayloads).filter(method=>method!=='notificationsState'))await assert.rejects(()=>c[method]({...uiPayloads[method],responseVersion:2}),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 assert.equal(calls.length,2);
});
test('UI construction is inert and exposes only its eight fixed POST APIs with owner-free bodies',async()=>{
 const paths=['lease','session/resolve','notifications/state','notifications/command','notifications/request','workspace/state','workspace/save','workspace/request'];
 const calls=[],c=ui(async(url,options)=>{calls.push({url,options});return response({revision:0});});
 assert.equal(c.configured,true);assert.equal(c.contract,PRIVATE_RESEARCH_CONTRACT);assert.equal(calls.length,0);assert.ok(Object.isFrozen(c));
 assert.deepEqual(Object.keys(c).filter(key=>typeof c[key]==='function'),Object.keys(uiPayloads));
 for(const name of ['get','claim','finish','issueChallenge','issueSession','post','fetch'])assert.equal(c[name],undefined);
 for(const [method,body] of Object.entries(uiPayloads))await c[method](body);
 assert.deepEqual(calls.map(call=>call.url),paths.map(path=>ORIGIN+'/internal/private/v1/'+path));
 for(const [index,{options}] of calls.entries()){
  const payload=Object.values(uiPayloads)[index];assert.equal(options.body,JSON.stringify(payload));
  assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(options.headers,{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json','X-Astarter-Private-Session-Digest':'a'.repeat(64)});
  assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers['X-Astarter-Owner'],undefined);
  for(const key of ['subjectId','scopeId','tenantId','ownerRef','owner','authVersion','permissionProfile'])assert.equal(Object.hasOwn(payload,key),false);
 }
 const closed=createPrivateUIClient({fetchImpl:async()=>{assert.fail('unconfigured client must not perform IO');}});assert.equal(closed.configured,false);
 await assert.rejects(()=>closed.workspaceState(uiPayloads.workspaceState),{code:'PRIVATE_RPC_UNCONFIGURED'});
});
test('every UI API binds its session digest in its request closure and rejects owner or header injection',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response();};
 for(const sessionDigest of ['',undefined,'bad','a'.repeat(63),'A'.repeat(64),'a'.repeat(64)+'\r\nX-Test: invalid']){
  const c=ui(fetchImpl,{sessionDigest});for(const [method,payload] of Object.entries(uiPayloads))await assert.rejects(()=>c[method](payload),{code:'AUTH_REQUIRED',status:401,outcomeUnknown:false});
 }
 await assert.rejects(()=>ui(fetchImpl).resolveSession({...uiPayloads.resolveSession,tokenDigest:'b'.repeat(64)}),{code:'AUTH_REQUIRED'});
 for(const [method,payload] of Object.entries(uiPayloads))for(const [key,value] of [['subjectId','different-person'],['scopeId','different-scope'],['tenantId','different-tenant'],['ownerRef','wallet:56:forged'],['headers',{'X-Astarter-Private-Session-Digest':'b'.repeat(64)}],['sessionDigest','b'.repeat(64)],['url','https://unreviewed.example']])await assert.rejects(()=>ui(fetchImpl)[method]({...payload,[key]:value}),{code:'PRIVATE_RPC_INVALID_REQUEST',outcomeUnknown:false});
 assert.equal(calls,0);
 const sent=[],fetchBound=async(url,options)=>{sent.push({url,options});return response();};
 const a=ui(fetchBound),b=ui(fetchBound,{sessionDigest:'b'.repeat(64)});
 await Promise.all([a.workspaceState(uiPayloads.workspaceState),b.notificationsState(uiPayloads.notificationsState),a.notificationsRequest(uiPayloads.notificationsRequest),b.workspaceRequest(uiPayloads.workspaceRequest)]);
 assert.deepEqual(sent.map(({options})=>options.headers['X-Astarter-Private-Session-Digest']),['a'.repeat(64),'b'.repeat(64),'a'.repeat(64),'b'.repeat(64)]);
 assert.ok(sent.every(({options})=>!options.body.includes('sessionDigest')));
});
test('UI original-request reads preserve explicit null while state reads reject missing state',async()=>{
 for(const method of ['notificationsRequest','workspaceRequest','resolveSession'])assert.equal(await ui(async()=>response(null))[method](uiPayloads[method]),null);
 for(const method of ['notificationsState','workspaceState','inspectLease'])await assert.rejects(()=>ui(async()=>response(null))[method](uiPayloads[method]),{code:'PRIVATE_RPC_PROTOCOL',outcomeUnknown:false});
 for(const method of ['notificationsRequest','workspaceRequest']){
  const expected={requestId:uiPayloads[method].requestId,status:'applied',revision:1};
  assert.deepEqual(await ui(async()=>response(expected))[method](uiPayloads[method]),expected);
 }
});
test('UI writes retain known rejection semantics and reconcile uncertain commits only by the original ID',async()=>{
 for(const [method,readMethod] of [['notificationsCommand','notificationsRequest'],['workspaceSave','workspaceRequest']]){
  for(const [code,status] of [['PRIVATE_AUTH_REQUIRED',401],['PRIVATE_FORBIDDEN',403],['PRIVATE_CONFLICT',409]]){
   let calls=0;await assert.rejects(()=>ui(async()=>{calls++;return remote(code,status);})[method](uiPayloads[method]),{code,status,outcomeUnknown:false});assert.equal(calls,1);
  }
  for(const [code,status] of [['PRIVATE_COMMIT_UNKNOWN',409],['PRIVATE_UNAVAILABLE',503]]){
   let calls=0;await assert.rejects(()=>ui(async()=>{calls++;return remote(code,status);})[method](uiPayloads[method]),{code,status,outcomeUnknown:true});assert.equal(calls,1);
  }
  const calls=[],c=ui(async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(calls.length===1)throw Error('driver-secret '+TOKEN);return response(null);});
  await assert.rejects(()=>c[method](uiPayloads[method]),e=>{assert.equal(e.code,'PRIVATE_RPC_OUTCOME_UNKNOWN');return sanitized(e,true);});assert.equal(calls.length,1);
  assert.equal(await c[readMethod](uiPayloads[readMethod]),null);assert.equal(calls.length,2);
  assert.ok(calls.every(({body})=>body.requestId===uiPayloads[method].requestId));assert.ok(calls[1].url.endsWith('/request'));
 }
});

const profileV2={authVersion:2,permissionProfile:'private-ui-v2'};
const permissionsV2=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const profileMethods=['issueChallenge','prepareChallenge','consumeChallenge','issueSession'];
test('legacy issuer profile calls serialize exactly as before with no implicit version or permission upgrade',async()=>{
 const calls=[],c=issuer(async(url,options)=>{calls.push({url,body:options.body});return response({});});
 for(const method of profileMethods)await c[method](issuerPayloads[method]);
 assert.deepEqual(calls.map(({body})=>body),profileMethods.map(method=>JSON.stringify(issuerPayloads[method])));
 for(const {body} of calls){assert.equal(body.includes('authVersion'),false);assert.equal(body.includes('permissionProfile'),false);assert.equal(body.includes('workspace:write'),false);}
});
test('issuer v2 accepts the explicit profile pair only on the four intended calls and preserves exact permission order',async()=>{
 const calls=[],c=issuer(async(url,options)=>{calls.push({url,options});return response({});});
 for(const method of profileMethods){const payload={...issuerPayloads[method],...(method==='issueSession'?{permissions:permissionsV2}:{}),...profileV2};await c[method](payload);assert.equal(calls.at(-1).options.body,JSON.stringify(payload));}
 assert.deepEqual(calls.map(({url})=>url),['auth/challenge/issue','auth/challenge/prepare','auth/challenge/consume','auth/session/issue'].map(path=>ORIGIN+'/internal/private/v1/'+path));
 assert.ok(calls.every(({options})=>options.headers.Authorization==='Bearer '+ISSUER_TOKEN&&options.headers['X-Astarter-Private-Session-Digest']===undefined));
 assert.deepEqual(JSON.parse(calls.at(-1).options.body).permissions,permissionsV2);
 for(const method of ['getChallenge','revokeChallenge','resolveSession','revokeSession'])await assert.rejects(()=>c[method]({...issuerPayloads[method],...profileV2}),{code:'PRIVATE_RPC_INVALID_REQUEST'});
 assert.equal(calls.length,4);
});
test('issuer rejects partial, unsupported, downgraded and malformed v2 profile pairs before dispatch',async()=>{
 let calls=0;const c=issuer(async()=>{calls++;return response();});
 const invalidPairs=[{authVersion:2},{permissionProfile:'private-ui-v2'},{authVersion:1,permissionProfile:'private-ui-v2'},{authVersion:3,permissionProfile:'private-ui-v2'},{authVersion:'2',permissionProfile:'private-ui-v2'},{authVersion:2,permissionProfile:'private-ui-v1'},{authVersion:2,permissionProfile:null},{authVersion:undefined,permissionProfile:'private-ui-v2'},{authVersion:2,permissionProfile:undefined}];
 for(const method of profileMethods)for(const pair of invalidPairs)await assert.rejects(()=>c[method]({...issuerPayloads[method],...(method==='issueSession'?{permissions:permissionsV2}:{}),...pair}),{code:'PRIVATE_RPC_INVALID_REQUEST',outcomeUnknown:false});
 for(const permissions of [['research:analyze'],[...permissionsV2].reverse(),[...permissionsV2,'trade:execute'],permissionsV2.slice(0,-1),[...permissionsV2,'workspace:write'],'workspace:write',null])await assert.rejects(()=>c.issueSession({...issuerPayloads.issueSession,...profileV2,permissions}),{code:'PRIVATE_RPC_INVALID_REQUEST',outcomeUnknown:false});
 assert.equal(calls,0);
});
test('issuer refuses additional legacy permissions when the v2 profile pair is absent',async()=>{
 let calls=0;const c=issuer(async()=>{calls++;return response();});
 for(const permissions of [permissionsV2,['research:analyze','trade:execute'],[],['notifications:read']])await assert.rejects(()=>c.issueSession({...issuerPayloads.issueSession,permissions}),{code:'PRIVATE_RPC_INVALID_REQUEST',outcomeUnknown:false});
 assert.equal(calls,0);
});
