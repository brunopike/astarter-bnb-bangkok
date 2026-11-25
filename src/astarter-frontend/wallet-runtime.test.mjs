import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {createWalletRuntime} from './wallet-runtime.mjs';
import {createPrivateApiRoute} from './private-api-route.mjs';

const NOW=Date.UTC(2026,10,16,12),ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site',PRIVATE_ORIGIN='https://offline-private.example';
const CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1',ISSUER='offline_distinct_issuer_key_01234567890123456789',RUNTIME='offline_distinct_runtime_key_01234567890123456789';
const CHALLENGE='__Host-astarter_challenge',SESSION='__Host-astarter_session',hash=v=>createHash('sha256').update(v).digest('hex');
// Public deterministic test scalar: local signature verification only, never funded.
const wallet=privateKeyToAccount('0x'+'0'.repeat(63)+'1');
const env=()=>({ASTARTER_PRIVATE_SERVICE_ORIGIN:PRIVATE_ORIGIN,ASTARTER_PRIVATE_ISSUER_TOKEN:ISSUER,ASTARTER_PRIVATE_RUNTIME_TOKEN:RUNTIME});
const wire=result=>new Response(JSON.stringify({contract:CONTRACT,result}),{headers:{'Content-Type':'application/json'}});

function fixture(options={}){
 const calls=[],challenges=new Map(),sessions=new Map();let claims=0;
 const fetchImpl=async(url,request)=>{
  const body=JSON.parse(request.body),path=new URL(url).pathname.slice('/internal/private/v1/'.length);calls.push({url,request,body,path});
  assert.equal(new URL(url).origin,PRIVATE_ORIGIN);assert.equal(request.method,'POST');assert.equal(request.headers.Authorization,'Bearer '+ISSUER);assert.equal(request.headers.Cookie,undefined);assert.equal(request.headers['X-Astarter-Private-Session-Digest'],undefined);
  if(options.transportFailure)throw Error('offline-driver-secret '+ISSUER+' '+PRIVATE_ORIGIN);
  if(options.challengeDelayMs&&['auth/challenge/issue','auth/challenge/revoke'].includes(path))await new Promise(resolve=>setTimeout(resolve,options.challengeDelayMs));
  if(path==='auth/challenge/issue'){if(options.maxHintAgeMs&&options.now()-body.issuedAt>options.maxHintAgeMs)return wire(null);challenges.set(body.challengeHash,{record:structuredClone(body),consumed:false,revoked:false});return wire(body);}
  if(path==='auth/challenge/get'){const row=challenges.get(body.challengeHash);return wire(row&&!row.revoked&&!row.consumed?row.record:null);}
  if(path==='auth/challenge/prepare'){const row=challenges.get(body.challengeHash);if(!row||row.consumed||row.revoked)return wire(null);Object.assign(row.record,{address:body.address,chain:body.chain,message:body.message});return wire(row.record);}
  if(path==='auth/challenge/consume'){
   const row=challenges.get(body.challengeHash);if(!row||row.revoked||row.consumed)return wire(null);row.consumed=true;row.claimToken='offline_challenge_claim_'+(++claims);return wire({challenge:row.record,claimToken:row.claimToken});
  }
  if(path==='auth/session/issue'){
   const challenge=challenges.get(body.challengeHash);assert.equal(challenge.consumed,true);assert.equal(body.claimToken,challenge.claimToken);if(body.previousTokenHash)sessions.delete(body.previousTokenHash);
   const record={tokenHash:body.tokenHash,address:body.address,chain:body.chain,origin:body.origin,subjectId:'issuer-owned-person',scopeId:'issuer-owned-private',issuedAt:body.issuedAt,expires:body.expires,permissions:body.permissions};sessions.set(body.tokenHash,record);return wire(record);
  }
  if(path==='auth/session/resolve')return wire(sessions.get(body.tokenHash)||null);
  if(path==='auth/session/revoke'){sessions.delete(body.tokenHash);return wire(true);}
  if(path==='auth/challenge/revoke'){const row=challenges.get(body.challengeHash);if(row)row.revoked=true;return wire(true);}
  assert.fail('Unrecognized issuer path');
 };
 const runtime=createWalletRuntime({env:options.env||env(),fetchImpl,now:options.now||(()=>NOW)});return {runtime,calls,challenges,sessions};
}
async function server(t,runtime){
 const route=createPrivateApiRoute('wallet',runtime.handle),http=createServer((req,res)=>{void route(req,res).catch(()=>{res.writeHead(500);res.end('{}');});});http.listen(0,'127.0.0.1');await once(http,'listening');
 t.after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));});const local='http://127.0.0.1:'+http.address().port,jar=new Map();
 const cookies=()=>[...jar].map(([key,value])=>key+'='+value).join('; ');
 const call=async(path,body,headers={})=>new Promise((resolve,reject)=>{
  const method=body===undefined?'GET':'POST',raw=body===undefined?'':JSON.stringify(body),request=httpRequest(local+path,{method,headers:{host:HOST,origin:ORIGIN,...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}),...(jar.size?{cookie:cookies()}:{}),...headers}},response=>{
   const parts=[];response.on('data',chunk=>parts.push(chunk));response.on('end',()=>{try{const setCookies=response.headers['set-cookie']||[];for(const cookie of setCookies){const [part]=cookie.split(';'),i=part.indexOf('=');if(cookie.includes('Max-Age=0'))jar.delete(part.slice(0,i));else jar.set(part.slice(0,i),part.slice(i+1));}resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(parts).toString()),headers:response.headers,setCookies});}catch(error){reject(error);}});
  });request.on('error',reject);request.end(raw);
 });
 return {call,jar,cookies};
}

test('unconfigured or reused issuer/runtime credentials remain inert through the real wallet HTTP route',async t=>{
 for(const configuration of [{},{...env(),ASTARTER_PRIVATE_ISSUER_TOKEN:''},{...env(),ASTARTER_PRIVATE_ISSUER_TOKEN:RUNTIME},{...env(),ASTARTER_PRIVATE_SERVICE_ORIGIN:'http://offline-private.example'}]){
  const f=fixture({env:configuration});assert.equal(f.runtime.configured,false);assert.equal(f.calls.length,0);const a=await server(t,f.runtime),r=await a.call('/api/wallet/nonce',{});assert.equal(r.status,503);assert.equal(r.body.error,'wallet-service-unavailable');assert.equal(f.calls.length,0);assert.equal(await f.runtime.resolvePrincipal({}),null);
 }
});
test('configured wallet construction is inert and nonce issuance uses only the fixed issuer endpoint',async t=>{
 const f=fixture();assert.equal(f.runtime.configured,true);assert.equal(f.calls.length,0);const a=await server(t,f.runtime),r=await a.call('/api/wallet?route=nonce',{});assert.equal(r.status,200);assert.match(r.body.nonce,/^[a-f0-9]{64}$/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,PRIVATE_ORIGIN+'/internal/private/v1/auth/challenge/issue');assert.equal(f.calls[0].body.challengeHash,hash(a.jar.get(CHALLENGE)));assert.equal(f.calls[0].body.nonce,r.body.nonce);
 assert.ok(!JSON.stringify(f.calls[0].body).includes(a.jar.get(CHALLENGE)));assert.match(r.setCookies[0],/Path=\/; Secure; HttpOnly; SameSite=Strict;/);assert.doesNotMatch(JSON.stringify(r.body),/offline_distinct|tokenHash|challengeHash/);
});
test('wallet issuance tolerates a bounded response beyond three seconds without sending a second mutation',async t=>{
 const f=fixture({challengeDelayMs:3100}),a=await server(t,f.runtime),r=await a.call('/api/wallet/nonce',{});
 assert.equal(r.status,200);assert.match(r.body.nonce,/^[a-f0-9]{64}$/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'auth/challenge/issue');assert.ok(a.jar.has(CHALLENGE));
});
test('renewing an old challenge gives the new issuance a fresh timestamp after bounded revocation',async t=>{
 const f=fixture({challengeDelayMs:3100,maxHintAgeMs:5000,now:Date.now}),a=await server(t,f.runtime);a.jar.set(CHALLENGE,'a'.repeat(64));
 const r=await a.call('/api/wallet/nonce',{});assert.equal(r.status,200);assert.deepEqual(f.calls.map(c=>c.path),['auth/challenge/revoke','auth/challenge/issue']);
 assert.ok(f.calls[1].body.issuedAt-f.calls[0].body.now>=3000);assert.notEqual(a.jar.get(CHALLENGE),'a'.repeat(64));
});
test('wallet runtime crosses fixed issuer RPC and verifies a real local EOA signature before publishing a secure session',async t=>{
 const f=fixture(),a=await server(t,f.runtime),nonce=await a.call('/api/wallet/nonce',{}),message=await a.call('/api/wallet/message',{nonce:nonce.body.nonce,address:wallet.address,chainId:56});assert.equal(message.status,200);
 const signature=await wallet.signMessage({message:message.body.message}),verified=await a.call('/api/wallet/verify',{message:message.body.message,signature});assert.equal(verified.status,200);assert.equal(verified.body.session.address,wallet.address);assert.equal(verified.body.session.chain,56);assert.equal(a.jar.has(CHALLENGE),false);assert.match(a.jar.get(SESSION),/^[a-f0-9]{64}$/);assert.ok(f.sessions.has(hash(a.jar.get(SESSION))));
 const rawSession=a.jar.get(SESSION),sessionRead=await a.call('/api/wallet/session');assert.equal(sessionRead.status,200);assert.equal(sessionRead.body.session.address,wallet.address);assert.equal(sessionRead.body.invitation,null);assert.doesNotMatch(JSON.stringify(sessionRead.body),/issuer-owned|tokenHash|challengeHash|offline_distinct/);
 const principal=await f.runtime.resolvePrincipal({method:'GET',headers:{host:HOST,origin:ORIGIN,cookie:a.cookies()}});assert.deepEqual(principal,{subjectId:'issuer-owned-person',scopeId:'issuer-owned-private',expiresAt:NOW+604800000,permissions:['research:analyze']});
 await a.call('/api/wallet/nonce',{});const logout=await a.call('/api/wallet/logout',{});assert.equal(logout.status,200);assert.equal(logout.body.session,null);assert.equal(a.jar.size,0);assert.equal(f.sessions.size,0);
 const paths=new Set(f.calls.map(c=>c.path));assert.deepEqual(paths,new Set(['auth/challenge/issue','auth/challenge/get','auth/challenge/prepare','auth/challenge/consume','auth/session/issue','auth/session/resolve','auth/session/revoke','auth/challenge/revoke']));
 assert.ok(f.calls.every(c=>c.request.headers.Authorization==='Bearer '+ISSUER&&c.request.headers.Authorization!=='Bearer '+RUNTIME));assert.ok(f.calls.every(c=>!JSON.stringify(c.body).includes(rawSession)));assert.ok(f.calls.find(c=>c.path==='auth/challenge/consume'));assert.ok(f.calls.find(c=>c.path==='auth/session/issue').body.claimToken);
});
test('wallet origin, host and route rejection prevent issuer IO rather than trusting client identity fields',async t=>{
 const f=fixture(),a=await server(t,f.runtime);
 for(const headers of [{host:'evil.example'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])assert.equal((await a.call('/api/wallet/nonce',{},headers)).status,403);
 assert.equal((await a.call('/api/wallet?route=nonce&user_id=attacker',{})).status,400);assert.equal((await a.call('/api/wallet/nonce',{user_id:'attacker'})).status,400);assert.equal(f.calls.length,0);
});
test('a dispatched issuer failure is sanitized and never silently retried by the runtime HTTP adapter',async t=>{
 const f=fixture({transportFailure:true}),a=await server(t,f.runtime),r=await a.call('/api/wallet/nonce',{});assert.equal(r.status,503);assert.equal(r.body.error,'wallet-service-unavailable');assert.equal(f.calls.length,1);assert.equal(a.jar.size,0);assert.doesNotMatch(JSON.stringify(r.body),/offline-driver-secret|offline_distinct|offline-private/);
});
