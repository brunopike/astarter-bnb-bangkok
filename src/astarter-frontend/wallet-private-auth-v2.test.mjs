import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {parseSiweMessage} from 'viem/siwe';
import {createPrivateWalletAuth} from './wallet-private-auth.mjs';

const ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site',NOW=Date.UTC(2026,10,16,14),FLAGS={authVersion:2,permissionProfile:'private-ui-v2'};
const LEGACY=['research:analyze'],PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const SESSION='__Host-astarter_session',CHALLENGE='__Host-astarter_challenge',RESOURCE='urn:astarter:permission-profile:private-ui-v2';
// Public deterministic local-test scalar. No real credentials, RPC or funded account.
const account=privateKeyToAccount('0x'+'0'.repeat(63)+'1'),hash=v=>createHash('sha256').update(v).digest('hex'),clone=structuredClone;
const pair=r=>Object.hasOwn(r,'authVersion')||Object.hasOwn(r,'permissionProfile')?{authVersion:r.authVersion,permissionProfile:r.permissionProfile}:{};
const legacy=r=>{const {authVersion,permissionProfile,...rest}=r;return rest;};

async function fixture(t,authVersion=2){
 let at=NOW,service,claims=0;const challenges=new Map(),sessions=new Map(),calls=[];
 // Offline owner protocol fixture, not proof of database atomicity or production issuance.
 const issuer={configured:true,
  async issueChallenge(record){calls.push(['issueChallenge',clone(record)]);challenges.set(record.challengeHash,{record:clone(record),consumed:false,revoked:false});return clone(record);},
  async getChallenge(input){calls.push(['getChallenge',clone(input)]);const row=challenges.get(input.challengeHash);return row&&!row.consumed&&!row.revoked&&row.record.expires>at?clone(row.record):null;},
  async prepareChallenge(input){calls.push(['prepareChallenge',clone(input)]);const row=challenges.get(input.challengeHash);if(!row||row.revoked||row.consumed||JSON.stringify(pair(row.record))!==JSON.stringify(pair(input)))return null;Object.assign(row.record,{address:input.address,chain:input.chain,message:input.message});return clone(row.record);},
  async consumeChallenge(input){calls.push(['consumeChallenge',clone(input)]);const row=challenges.get(input.challengeHash);if(!row||row.revoked||row.consumed||JSON.stringify(pair(row.record))!==JSON.stringify(pair(input)))return null;row.consumed=true;row.claimToken='claim-'+(++claims);return {challenge:clone(row.record),claimToken:row.claimToken};},
  async issueSession(input){calls.push(['issueSession',clone(input)]);const row=challenges.get(input.challengeHash);if(!row||row.revoked||!row.consumed||row.claimToken!==input.claimToken||row.record.expires<=at||JSON.stringify(pair(row.record))!==JSON.stringify(pair(input)))return null;if(input.previousTokenHash)sessions.delete(input.previousTokenHash);const record={tokenHash:input.tokenHash,address:input.address,chain:input.chain,origin:input.origin,subjectId:'server-person-v2',scopeId:'server-private-v2',issuedAt:input.issuedAt,expires:input.expires,permissions:[...input.permissions],...pair(input)};sessions.set(input.tokenHash,{record,challengeHash:input.challengeHash});return clone(record);},
  async resolveSession(input){calls.push(['resolveSession',clone(input)]);const row=sessions.get(input.tokenHash);return row&&row.record.expires>at?clone(row.record):null;},
  async revokeSession(input){calls.push(['revokeSession',clone(input)]);sessions.delete(input.tokenHash);return true;},
  async revokeChallenge(input){calls.push(['revokeChallenge',clone(input)]);const row=challenges.get(input.challengeHash);if(row)row.revoked=true;for(const [key,s]of sessions)if(s.challengeHash===input.challengeHash)sessions.delete(key);return true;}
 };
 const version=value=>{service=createPrivateWalletAuth({issuer,now:()=>at,authVersion:value});};version(authVersion);
 const server=createServer((req,res)=>{void service.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end('{}');}}).catch(()=>{res.writeHead(503);res.end('{}');});});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const local='http://127.0.0.1:'+server.address().port,jar=new Map(),cookies=()=>[...jar].map(([k,v])=>k+'='+v).join('; ');
 const call=(path,body,options={})=>new Promise((resolve,reject)=>{const raw=body===undefined?'':JSON.stringify(body),request=httpRequest(local+'/api/wallet/'+path,{method:body===undefined?'GET':'POST',headers:{host:HOST,...(body===undefined?{}:{origin:ORIGIN,'content-type':'application/json','content-length':Buffer.byteLength(raw)}),...(jar.size?{cookie:cookies()}:{}),...options.headers}},res=>{const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{try{const setCookies=res.headers['set-cookie']||[];if(options.applyCookies!==false)for(const value of setCookies){const [part]=value.split(';'),i=part.indexOf('=');if(value.includes('Max-Age=0'))jar.delete(part.slice(0,i));else jar.set(part.slice(0,i),part.slice(i+1));}resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(parts).toString()),setCookies});}catch(error){reject(error);}});});request.on('error',reject);request.end(raw);});
 const challenge=async()=>{const nonce=await call('nonce',{});assert.equal(nonce.status,200);const prepared=await call('message',{nonce:nonce.data.nonce,address:account.address,chainId:56});assert.equal(prepared.status,200);return {message:prepared.data.message,nonce:nonce.data.nonce};};
 const login=async()=>{const {message}=await challenge();return call('verify',{message,signature:await account.signMessage({message})});};
 return {issuer,calls,challenges,sessions,jar,cookies,call,challenge,login,version,advance:ms=>at+=ms,principal:()=>service.resolvePrincipal({method:'GET',headers:{host:HOST,cookie:cookies()}}),configured:()=>service.configured,claims:()=>claims};
}

test('v2 explicitly binds its exact permission profile to a real SIWE signature and HTTP session',async t=>{
 const f=await fixture(t);assert.equal(f.calls.length,0);const {message}=await f.challenge(),parsed=parseSiweMessage(message);assert.deepEqual(parsed.resources,[RESOURCE]);assert.equal(parsed.domain,HOST);assert.equal(parsed.uri,ORIGIN);assert.equal(parsed.chainId,56);assert.equal(parsed.expirationTime.getTime()-parsed.issuedAt.getTime(),300000);
 const r=await f.call('verify',{message,signature:await account.signMessage({message})});assert.equal(r.status,200);assert.deepEqual(r.data.session,{address:account.address,chain:56,expires:NOW+604800000,...FLAGS});assert.deepEqual(await f.principal(),{subjectId:'server-person-v2',scopeId:'server-private-v2',expiresAt:NOW+604800000,permissions:PERMISSIONS,...FLAGS});
 for(const method of ['issueChallenge','prepareChallenge','consumeChallenge','issueSession'])assert.deepEqual(pair(f.calls.find(([name])=>name===method)[1]),FLAGS,method);
 assert.deepEqual(f.calls.find(([name])=>name==='issueSession')[1].permissions,PERMISSIONS);assert.ok(f.calls.findIndex(([name])=>name==='consumeChallenge')<f.calls.findIndex(([name])=>name==='issueSession'));
 assert.ok(r.setCookies.every(cookie=>cookie.includes('Path=/; Secure; HttpOnly; SameSite=Strict')));assert.doesNotMatch(JSON.stringify(r.data),/tokenHash|subjectId|scopeId|server-private|permissions/);
});
test('legacy is the unchanged default and remains readable in v2 without a silent permission upgrade',async t=>{
 const f=await fixture(t,1),r=await f.login();assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data.session),['address','chain','expires']);assert.deepEqual(await f.principal(),{subjectId:'server-person-v2',scopeId:'server-private-v2',expiresAt:NOW+604800000,permissions:LEGACY});
 for(const [method,input] of f.calls)if(['issueChallenge','prepareChallenge','consumeChallenge','issueSession'].includes(method)){assert.equal(Object.hasOwn(input,'authVersion'),false);assert.equal(Object.hasOwn(input,'permissionProfile'),false);}
 f.version(2);assert.deepEqual((await f.call('session')).data.session,r.data.session);assert.deepEqual((await f.principal()).permissions,LEGACY);assert.equal((await f.principal()).authVersion,undefined);
 const before=f.calls.filter(([name])=>name==='issueSession').length;await f.call('session');assert.equal(f.calls.filter(([name])=>name==='issueSession').length,before);
});
test('an existing challenge follows its durable profile across runtime version changes',async t=>{
 for(const [issued,running] of [[1,2],[2,1]]){
  const f=await fixture(t,issued),nonce=(await f.call('nonce',{})).data.nonce;f.version(running);const result=await f.call('message',{nonce,address:account.address,chainId:56}),message=result.data.message;assert.equal(result.status,200);assert.deepEqual(parseSiweMessage(message).resources,issued===2?[RESOURCE]:undefined);
  const signed=await f.call('verify',{message,signature:await account.signMessage({message})});assert.equal(signed.status,200);const p=await f.principal();assert.deepEqual(p.permissions,issued===2?PERMISSIONS:LEGACY);assert.equal(p.authVersion,issued===2?2:undefined);
 }
});
test('nonce issuance rejects downgraded, partial, widened or unrecognized profile records',async t=>{
 for(const alter of [r=>legacy(r),r=>{const {permissionProfile,...x}=r;return x;},r=>({...r,authVersion:1}),r=>({...r,permissionProfile:'trade-execute'}),r=>({...r,scope:'PUBLIC'})]){
  const f=await fixture(t),issue=f.issuer.issueChallenge.bind(f.issuer);f.issuer.issueChallenge=async input=>alter(await issue(input));const r=await f.call('nonce',{});assert.equal(r.status,503);assert.equal(r.data.error,'wallet-service-unavailable');assert.equal(f.jar.has(CHALLENGE),false);
 }
 for(const version of [0,3,'2',null]){const f=await fixture(t,version);assert.equal(f.configured(),false);assert.equal((await f.call('nonce',{})).status,503);assert.equal(f.calls.length,0);}
});
test('client fields cannot select or append permissions to nonce, message or verification',async t=>{
 const f=await fixture(t);assert.equal((await f.call('nonce',FLAGS)).status,400);assert.equal(f.calls.length,0);const {message,nonce}=await f.challenge();
 assert.equal((await f.call('message',{nonce,address:account.address,chainId:56,...FLAGS})).status,400);assert.equal((await f.call('verify',{message,signature:await account.signMessage({message}),permissions:PERMISSIONS})).status,400);assert.equal(f.sessions.size,0);
});
test('removing the permission resource from a signed message consumes the challenge without minting a v2 session',async t=>{
 const f=await fixture(t),{message}=await f.challenge(),originalCookie=f.cookies(),tampered=message.replace('\nResources:\n- '+RESOURCE,'');assert.notEqual(tampered,message);
 const r=await f.call('verify',{message:tampered,signature:await account.signMessage({message:tampered})});assert.equal(r.status,401);assert.equal(r.data.error,'invalid-signature');assert.equal(f.claims(),1);assert.equal(f.sessions.size,0);
 assert.equal((await f.call('verify',{message,signature:await account.signMessage({message})},{headers:{cookie:originalCookie}})).status,401);assert.equal(f.claims(),1);
});
test('a real v2 signature is admitted at most once across simultaneous verification and replay',async t=>{
 const f=await fixture(t),{message}=await f.challenge(),cookie=f.cookies(),body={message,signature:await account.signMessage({message})},results=await Promise.all([f.call('verify',body,{headers:{cookie}}),f.call('verify',body,{headers:{cookie}})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal(f.claims(),1);assert.equal(f.sessions.size,1);assert.equal((await f.call('verify',body,{headers:{cookie}})).status,401);
});
test('prepare and consume cannot downgrade the durable challenge before signature verification',async t=>{
 for(const method of ['prepareChallenge','consumeChallenge']){
  const f=await fixture(t),run=f.issuer[method].bind(f.issuer);f.issuer[method]=async input=>{const r=await run(input);return method==='consumeChallenge'?{...r,challenge:legacy(r.challenge)}:legacy(r);};
  if(method==='prepareChallenge'){const nonce=(await f.call('nonce',{})).data.nonce;assert.equal((await f.call('message',{nonce,address:account.address,chainId:56})).status,401);}
  else{const {message}=await f.challenge();assert.equal((await f.call('verify',{message,signature:await account.signMessage({message})})).status,401);}
  assert.equal(f.sessions.size,0);assert.equal(f.calls.some(([name])=>name==='issueSession'),false);
 }
});
test('issued and final reread sessions cannot downgrade profile or permissions and are revoked on mismatch',async t=>{
 for(const method of ['issueSession','resolveSession']){
  const f=await fixture(t),run=f.issuer[method].bind(f.issuer);f.issuer[method]=async input=>{const r=await run(input);return r?{...legacy(r),permissions:LEGACY}:r;};const r=await f.login();assert.equal(r.status,503);assert.equal(r.data.error,'wallet-service-unavailable');assert.equal(f.jar.has(SESSION),false);assert.equal(f.sessions.size,0);
 }
});
test('only two exact session profiles are readable; partial, reordered, extra permission or scope fields fail closed',async t=>{
 for(const change of [r=>{const {permissionProfile,...x}=r;return x;},r=>{const {authVersion,...x}=r;return x;},r=>({...r,permissionProfile:'research-only'}),r=>({...r,permissions:LEGACY}),r=>({...r,permissions:[...PERMISSIONS].reverse()}),r=>({...r,permissions:[...PERMISSIONS,'trade:execute']}),r=>({...legacy(r),permissions:PERMISSIONS}),r=>({...r,scope:'PUBLIC'})]){
  const f=await fixture(t);await f.login();const saved=f.sessions.get(hash(f.jar.get(SESSION)));saved.record=change(saved.record);assert.equal(await f.principal(),null);assert.equal((await f.call('session')).data.session,null);assert.equal(f.jar.has(SESSION),false);
 }
});
test('v2 retains challenge/session expiry and late logout checks before cookie publication',async t=>{
 const expired=await fixture(t),{message}=await expired.challenge(),signature=await account.signMessage({message});expired.advance(300000);assert.equal((await expired.call('verify',{message,signature})).status,401);assert.equal(expired.sessions.size,0);
 const f=await fixture(t),prepared=await f.challenge(),issue=f.issuer.issueSession.bind(f.issuer);let release,started;const ready=new Promise(resolve=>started=resolve);
 f.issuer.issueSession=async input=>{const result=await issue(input);started();await new Promise(resolve=>release=resolve);return result;};const pending=f.call('verify',{message:prepared.message,signature:await account.signMessage({message:prepared.message})});await ready;assert.equal(f.sessions.size,1);assert.equal((await f.call('logout',{})).status,200);release();assert.equal((await pending).status,401);assert.equal(f.sessions.size,0);assert.equal(f.jar.has(SESSION),false);
});
test('canonical issuer clock skew preserves v2 resources and exact lifetimes, with no expiry grace',async t=>{
 for(const offset of [-3000,3000]){
  const f=await fixture(t),challenge=f.issuer.issueChallenge.bind(f.issuer),session=f.issuer.issueSession.bind(f.issuer);
  f.issuer.issueChallenge=input=>challenge({...input,issuedAt:input.issuedAt+offset,expires:input.expires+offset});f.issuer.issueSession=input=>session({...input,issuedAt:input.issuedAt+offset,expires:input.expires+offset});
  const prepared=await f.challenge(),parsed=parseSiweMessage(prepared.message);assert.deepEqual(parsed.resources,[RESOURCE]);assert.equal(parsed.issuedAt.getTime(),NOW+offset);assert.equal(parsed.expirationTime.getTime()-parsed.issuedAt.getTime(),300000);
  const r=await f.call('verify',{message:prepared.message,signature:await account.signMessage({message:prepared.message})});assert.equal(r.status,200);assert.equal(r.data.session.expires,NOW+offset+604800000);assert.deepEqual((await f.principal()).permissions,PERMISSIONS);
  f.advance(offset+604800000);assert.equal(await f.principal(),null);assert.equal((await f.call('session')).data.session,null);
 }
 const tooFar=await fixture(t),issue=tooFar.issuer.issueChallenge.bind(tooFar.issuer);tooFar.issuer.issueChallenge=input=>issue({...input,issuedAt:input.issuedAt+5001,expires:input.expires+5001});assert.equal((await tooFar.call('nonce',{})).status,503);assert.equal(tooFar.jar.has(CHALLENGE),false);
});
