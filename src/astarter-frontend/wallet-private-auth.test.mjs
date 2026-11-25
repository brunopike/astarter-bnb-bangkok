import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {parseSiweMessage} from 'viem/siwe';
import {createPrivateWalletAuth} from './wallet-private-auth.mjs';

const ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site',NOW=Date.UTC(2026,10,16,12);
const SESSION='__Host-astarter_session',CHALLENGE='__Host-astarter_challenge';
// Public deterministic secp256k1 test scalars. Never funded or sent to any network.
const account=privateKeyToAccount('0x'+'0'.repeat(63)+'1'),other=privateKeyToAccount('0x'+'0'.repeat(63)+'2');
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(value).digest('hex');

// Independent offline issuer double: models the required atomic operations, not production persistence.
class Issuer{
 configured=true;challenges=new Map();sessions=new Map();subjects=new Map();calls=[];claims=0;onConsumed=null;onIssue=null;
 async issueChallenge(record){this.calls.push(['issueChallenge',clone(record)]);this.challenges.set(record.challengeHash,{record:clone(record),consumed:false,revoked:false,issued:false});return clone(record);}
 async getChallenge(input){this.calls.push(['getChallenge',clone(input)]);const row=this.challenges.get(input.challengeHash);return row&&!row.consumed&&!row.revoked&&row.record.expires>input.now?clone(row.record):null;}
 async prepareChallenge(input){this.calls.push(['prepareChallenge',clone(input)]);const row=this.challenges.get(input.challengeHash);if(!row||row.consumed||row.revoked||row.record.expires<=input.now||row.record.nonce!==input.nonce||row.record.address&&row.record.address!==input.address)return null;Object.assign(row.record,{address:input.address,chain:input.chain,message:input.message});return clone(row.record);}
 async consumeChallenge(input){this.calls.push(['consumeChallenge',clone(input)]);const row=this.challenges.get(input.challengeHash);if(!row||row.consumed||row.revoked||row.record.expires<=input.now||['nonce','address','chain','message'].some(key=>row.record[key]!==input[key]))return null;row.consumed=true;row.claimToken='claim-'+(++this.claims);if(this.onConsumed)await this.onConsumed();return {challenge:clone(row.record),claimToken:row.claimToken};}
 async issueSession(input){this.calls.push(['issueSession',clone(input)]);if(this.onIssue)await this.onIssue();const row=this.challenges.get(input.challengeHash);if(!row||!row.consumed||row.revoked||row.issued||row.claimToken!==input.claimToken||row.record.expires<=this.now()||row.record.address!==input.address)return null;row.issued=true;if(input.previousTokenHash)this.sessions.delete(input.previousTokenHash);let owner=this.subjects.get(input.address);if(!owner){owner={subjectId:'server-person-'+(this.subjects.size+1),scopeId:'server-private-'+(this.subjects.size+1)};this.subjects.set(input.address,owner);}const record={tokenHash:input.tokenHash,address:input.address,chain:input.chain,origin:input.origin,issuedAt:input.issuedAt,expires:input.expires,permissions:[...input.permissions],...owner};this.sessions.set(input.tokenHash,{record,challengeHash:input.challengeHash});return clone(record);}
 async resolveSession(input){this.calls.push(['resolveSession',clone(input)]);const row=this.sessions.get(input.tokenHash);return row&&row.record.expires>input.now?clone(row.record):null;}
 async revokeSession(input){this.calls.push(['revokeSession',clone(input)]);this.sessions.delete(input.tokenHash);return true;}
 async revokeChallenge(input){this.calls.push(['revokeChallenge',clone(input)]);const row=this.challenges.get(input.challengeHash);if(row)row.revoked=true;for(const [key,value]of this.sessions)if(value.challengeHash===input.challengeHash)this.sessions.delete(key);return true;}
}
function fixture(){
 let at=NOW;const issuer=new Issuer();issuer.now=()=>at;const service=createPrivateWalletAuth({issuer,now:()=>at});
 const actor=(wallet=account)=>{
  const jar=new Map();
  const cookies=()=>[...jar].map(([key,value])=>key+'='+value).join('; ');
  const call=async(path,body,options={})=>{
   const raw=options.raw!==undefined?options.raw:body===undefined?'':JSON.stringify(body),req=Readable.from(raw?[Buffer.from(raw)]:[]),headers={host:HOST,...(body!==undefined?{origin:ORIGIN,'content-type':'application/json','content-length':String(Buffer.byteLength(raw))}:{}),...(cookies()?{cookie:cookies()}:{}),...options.headers};
   Object.assign(req,{url:options.url||'/api/wallet/'+path,method:options.method||(body===undefined?'GET':'POST'),headers});
   if(options.mode==='parsed')req.body=body;else if(options.mode==='raw')req.body=raw;
   const responseHeaders=new Map();let status,result;
   const res={setHeader:(key,value)=>responseHeaders.set(key.toLowerCase(),value),getHeader:key=>responseHeaders.get(key.toLowerCase()),writeHead:value=>status=value,end:value=>result=value};
   const handled=await service.handle(req,res);if(!handled)return {handled};
   const setCookies=responseHeaders.get('set-cookie')||[];
   if(options.applyCookies!==false)for(const value of setCookies){const [part]=value.split(';'),i=part.indexOf('=');if(value.includes('Max-Age=0'))jar.delete(part.slice(0,i));else jar.set(part.slice(0,i),part.slice(i+1));}
   return {status,data:JSON.parse(result),headers:responseHeaders,setCookies,handled};
  };
  const challenge=async(mode='stream')=>{const nonce=await call('nonce',{}, {mode});assert.equal(nonce.status,200);const result=await call('message',{nonce:nonce.data.nonce,address:wallet.address,chainId:56},{mode});assert.equal(result.status,200);return {...result,nonce:nonce.data.nonce};};
  const login=async(mode='stream')=>{const {data:{message}}=await challenge(mode);return call('verify',{message,signature:await wallet.signMessage({message})},{mode});};
  return {wallet,jar,cookies,call,challenge,login,principal:()=>service.resolvePrincipal({method:'GET',headers:{host:HOST,cookie:cookies()}})};
 };
 return {issuer,service,actor,advance:ms=>at+=ms};
}

test('unconfigured construction performs no issuer I/O and the production endpoint fails closed',async()=>{
 const service=createPrivateWalletAuth();assert.equal(service.configured,false);assert.equal(await service.resolvePrincipal({}),null);
 const f=fixture();f.issuer.configured=false;const unconfigured=createPrivateWalletAuth({issuer:f.issuer});let status,result;
 await unconfigured.handle(Object.assign(Readable.from(['{}']),{url:'/api/wallet/nonce',method:'POST',headers:{host:HOST,origin:ORIGIN,'content-type':'application/json'}}),{setHeader(){},writeHead:s=>status=s,end:s=>result=JSON.parse(s)});
 assert.equal(status,503);assert.equal(result.error,'wallet-service-unavailable');assert.equal(f.issuer.calls.length,0);
});

test('real EOA signatures authenticate streamed, Vercel parsed and raw JSON bodies with server-issued identity only',async()=>{
 for(const mode of ['stream','parsed','raw']){
  const f=fixture(),a=f.actor(),result=await a.login(mode);assert.equal(result.status,200);assert.equal(result.data.session.address,account.address);assert.equal(result.data.session.chain,56);
  const read=await a.call('session');assert.equal(read.status,200);assert.deepEqual(read.data.security.capabilities,{email:false,totp:false});assert.equal(read.data.invitation,null);
  assert.deepEqual(await a.principal(),{subjectId:'server-person-1',scopeId:'server-private-1',expiresAt:NOW+604800000,permissions:['research:analyze']});
  assert.equal(a.jar.has(CHALLENGE),false);assert.equal(a.jar.get(SESSION).length,64);assert.ok(f.issuer.sessions.has(hash(a.jar.get(SESSION))));
  assert.ok(!JSON.stringify(result.data).includes('server-person'));assert.ok(!JSON.stringify(result.data).includes('tokenHash'));
  for(const value of result.setCookies){assert.match(value,/Path=\/; Secure; HttpOnly; SameSite=Strict;/);assert.doesNotMatch(value,/Domain=/);}
 }
});

test('the server SIWE message binds domain, URI, chain, nonce, issued time, expiry and a non-trading statement',async()=>{
 const f=fixture(),a=f.actor(),{data:{message},nonce}=await a.challenge(),parsed=parseSiweMessage(message);
 assert.equal(parsed.domain,HOST);assert.equal(parsed.uri,ORIGIN);assert.equal(parsed.chainId,56);assert.equal(parsed.nonce,nonce);assert.equal(parsed.address,account.address);
 assert.equal(parsed.issuedAt.getTime(),NOW);assert.equal(parsed.expirationTime.getTime(),NOW+300000);assert.match(parsed.statement,/does not authorize trades, token approvals or transfers/);
 const same=await a.call('message',{nonce,address:account.address.toLowerCase(),chainId:56});assert.equal(same.data.message,message);
});

function canonicalTimestamp(f,method,offset,lifetimeDelta=0){
 const issue=f.issuer[method].bind(f.issuer);
 f.issuer[method]=input=>issue({...input,issuedAt:input.issuedAt+offset,expires:input.expires+offset+lifetimeDelta});
}

test('trusted canonical issuer timestamps tolerate bounded clock skew without changing SIWE or session lifetime',async()=>{
 for(const offset of [-5000,-150,150,5000]){
  const f=fixture();canonicalTimestamp(f,'issueChallenge',offset);canonicalTimestamp(f,'issueSession',offset);
  const a=f.actor(),result=await a.login();assert.equal(result.status,200,'offset '+offset);
  const challenge=[...f.issuer.challenges.values()][0].record,parsed=parseSiweMessage(challenge.message);
  assert.equal(parsed.issuedAt.getTime(),NOW+offset);assert.equal(parsed.expirationTime.getTime(),NOW+offset+300000);
  assert.equal(result.data.session.expires,NOW+offset+604800000);assert.equal((await a.principal()).expiresAt,result.data.session.expires);
  assert.equal((await a.call('session')).data.session.address,account.address);
  f.advance(604800000+offset);assert.equal((await a.call('session')).data.session,null);assert.equal(await a.principal(),null);
 }
});

test('canonical challenge or session timestamps beyond the five-second window fail closed',async()=>{
 for(const offset of [-5001,5001]){
  const f=fixture(),a=f.actor();canonicalTimestamp(f,'issueChallenge',offset);
  assert.equal((await a.call('nonce',{})).status,503);assert.equal(a.jar.has(CHALLENGE),false);assert.equal(a.jar.has(SESSION),false);
  const g=fixture(),b=g.actor();canonicalTimestamp(g,'issueSession',offset);
  assert.equal((await b.login()).status,503);assert.equal(b.jar.has(SESSION),false);assert.equal(g.issuer.sessions.size,0);
 }
});

test('canonical timestamps cannot shorten or extend the fixed challenge and session lifetimes',async()=>{
 for(const delta of [-1,1]){
  const f=fixture(),a=f.actor();canonicalTimestamp(f,'issueChallenge',150,delta);
  assert.equal((await a.call('nonce',{})).status,503);assert.equal(a.jar.has(CHALLENGE),false);
  const g=fixture(),b=g.actor();canonicalTimestamp(g,'issueSession',150,delta);
  assert.equal((await b.login()).status,503);assert.equal(b.jar.has(SESSION),false);assert.equal(g.issuer.sessions.size,0);
 }
});

test('canonical challenge expiry has no clock-skew grace period',async()=>{
 const f=fixture(),a=f.actor();canonicalTimestamp(f,'issueChallenge',150);
 const {data:{message}}=await a.challenge(),signature=await account.signMessage({message});f.advance(300150);
 assert.equal((await a.call('verify',{message,signature})).status,401);assert.equal(f.issuer.sessions.size,0);
});

test('host, origin, methods, content type, exact fields, query injection and UTF8 byte limits are enforced before issuer calls',async()=>{
 const f=fixture(),a=f.actor();
 for(const options of [{headers:{host:'evil.invalid'}},{headers:{origin:'https://evil.invalid'}},{headers:{origin:undefined}},{headers:{'sec-fetch-site':'cross-site'}},{url:'https://evil.invalid/api/wallet/nonce'}])assert.equal((await a.call('nonce',{},options)).status,403);
 assert.equal((await a.call('nonce',{}, {method:'GET'})).status,405);assert.equal((await a.call('nonce',{}, {headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await a.call('nonce',{}, {url:'/api/wallet/nonce?user_id=attacker'})).status,400);
 for(const body of [{user_id:'attacker'},{token:'preview-session'},[],null])assert.equal((await a.call('nonce',body,{mode:'parsed'})).status,400);
 for(const mode of ['stream','parsed','raw'])assert.equal((await a.call('nonce',{text:'😀'.repeat(5000)},{mode})).status,413);
 assert.equal((await a.call('nonce',{}, {raw:'{'})).status,400);assert.equal((await a.call('nonce',{}, {headers:{'content-length':'999999'}})).status,413);
 assert.equal((await a.call('nonce',{}, {mode:'raw',headers:{'content-length':'1'}})).status,400);assert.equal((await a.call('session',undefined,{headers:{'content-length':'invalid'}})).status,400);
 assert.equal(f.issuer.calls.length,0);assert.equal((await a.call('session',undefined,{url:'/unrelated'})).handled,false);
});

test('client identity, arbitrary SIWE fields, wrong chain and signed message modifications cannot be accepted',async()=>{
 const f=fixture(),a=f.actor(),{data:{message},nonce}=await a.challenge();
 assert.equal((await a.call('message',{nonce,address:account.address,chainId:1})).status,400);
 assert.equal((await a.call('message',{nonce,address:account.address,chainId:56,domain:'evil.invalid'})).status,400);
 assert.equal((await a.call('verify',{message,signature:await account.signMessage({message}),user_id:'attacker'})).status,400);
 const altered=message.replace(ORIGIN,'https://evil.invalid');const result=await a.call('verify',{message:altered,signature:await account.signMessage({message:altered})});assert.equal(result.status,401);assert.equal(result.data.error,'invalid-signature');assert.equal(f.issuer.sessions.size,0);
});

test('wrong-wallet signatures consume the nonce and cannot be retried with a valid signature',async()=>{
 const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge(),cookie=a.cookies();
 assert.equal((await a.call('verify',{message,signature:await other.signMessage({message})})).status,401);
 assert.equal((await a.call('verify',{message,signature:await account.signMessage({message})},{headers:{cookie}})).status,401);assert.equal(f.issuer.claims,1);assert.equal(f.issuer.sessions.size,0);
});

test('a valid nonce is consumed once across concurrent real signature verifications and replay',async()=>{
 const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge(),cookie=a.cookies(),body={message,signature:await account.signMessage({message})};
 const results=await Promise.all([a.call('verify',body,{headers:{cookie}}),a.call('verify',body,{headers:{cookie}})]);assert.deepEqual(results.map(value=>value.status).sort(),[200,401]);assert.equal(f.issuer.claims,1);assert.equal(f.issuer.sessions.size,1);
 assert.equal((await a.call('verify',body,{headers:{cookie}})).status,401);assert.equal(f.issuer.sessions.size,1);
});

test('expired challenges and sessions cannot authenticate or extend the original validity',async()=>{
 const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge(),signature=await account.signMessage({message});f.advance(300000);
 assert.equal((await a.call('verify',{message,signature})).status,401);assert.equal(f.issuer.sessions.size,0);
 assert.equal((await a.login()).status,200);f.advance(604800000);assert.equal((await a.call('session')).data.session,null);assert.equal(await a.principal(),null);assert.equal(a.jar.has(SESSION),false);
});

test('changing wallets invalidates the prepared challenge and a later successful login rotates server identity and old session',async()=>{
 const f=fixture(),a=f.actor(),prepared=await a.challenge();assert.equal((await a.call('message',{nonce:prepared.nonce,address:other.address,chainId:56})).data.error,'challenge-expired');
 assert.equal((await a.call('verify',{message:prepared.data.message,signature:await account.signMessage({message:prepared.data.message})})).status,401);
 assert.equal((await a.login()).status,200);const old=a.jar.get(SESSION),first=await a.principal();
 const nonce=(await a.call('nonce',{})).data.nonce,{data:{message}}=await a.call('message',{nonce,address:other.address,chainId:56});
 assert.equal((await a.call('verify',{message,signature:await other.signMessage({message})})).status,200);const second=await a.principal();assert.notEqual(first.subjectId,second.subjectId);assert.equal(f.issuer.sessions.has(hash(old)),false);assert.equal((await a.call('session')).data.session.address,other.address);
});

test('logout or a newer nonce while the consumed claim awaits verification prevents a late session',async()=>{
 for(const action of ['logout','nonce']){
  const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge();let release,started;const ready=new Promise(resolve=>started=resolve);
  f.issuer.onConsumed=()=>{started();return new Promise(resolve=>release=resolve);};
  const pending=a.call('verify',{message,signature:await account.signMessage({message})});await ready;assert.equal((await a.call(action,{})).status,200);release();
  const result=await pending;assert.equal(result.status,401);assert.equal(f.issuer.sessions.size,0);assert.equal(a.jar.has(SESSION),false);
 }
});

test('challenge expiration during issuer session commit revokes any late issued session',async()=>{
 const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge(),issue=f.issuer.issueSession.bind(f.issuer);f.issuer.issueSession=async input=>{const record=await issue(input);f.advance(300000);return record;};
 assert.equal((await a.call('verify',{message,signature:await account.signMessage({message})})).status,401);assert.equal(f.issuer.sessions.size,0);assert.equal(a.jar.has(SESSION),false);
});

test('logout after issuer commit but before its RPC response cannot publish the already revoked session cookie',async()=>{
 const f=fixture(),a=f.actor(),{data:{message}}=await a.challenge(),issue=f.issuer.issueSession.bind(f.issuer);let release,started;const ready=new Promise(resolve=>started=resolve);
 f.issuer.issueSession=async input=>{const record=await issue(input);started();await new Promise(resolve=>release=resolve);return record;};
 const pending=a.call('verify',{message,signature:await account.signMessage({message})});await ready;assert.equal(f.issuer.sessions.size,1);
 assert.equal((await a.call('logout',{})).status,200);assert.equal(f.issuer.sessions.size,0);release();
 const result=await pending;assert.equal(result.status,401);assert.equal(a.jar.has(SESSION),false);assert.equal(await a.principal(),null);
});

test('issuer failures never echo internal errors or mint fallback principals',async()=>{
 for(const method of ['issueChallenge','getChallenge','prepareChallenge','consumeChallenge','issueSession','resolveSession','revokeSession','revokeChallenge']){
  const f=fixture(),a=f.actor();let prepared;
  if(['getChallenge','prepareChallenge'].includes(method))await a.call('nonce',{});
  if(['consumeChallenge','issueSession'].includes(method))prepared=await a.challenge();
  if(['resolveSession','revokeSession'].includes(method))assert.equal((await a.login()).status,200);
  if(method==='revokeChallenge')await a.challenge();
  f.issuer[method]=async()=>{throw Object.assign(Error('SECRET_INTERNAL_ISSUER_DETAIL'),{status:400});};
  const result=method==='issueChallenge'||method==='revokeChallenge'?await a.call('nonce',{}):method==='getChallenge'||method==='prepareChallenge'?await a.call('message',{nonce:[...f.issuer.challenges.values()][0].record.nonce,address:account.address,chainId:56}):method==='resolveSession'?await a.call('session'):method==='revokeSession'?await a.call('logout',{}):await a.call('verify',{message:prepared.data.message,signature:await account.signMessage({message:prepared.data.message})});
  assert.equal(result.status,503,method);assert.equal(result.data.error,'wallet-service-unavailable',method);assert.doesNotMatch(JSON.stringify(result.data),/SECRET|tokenHash|subjectId/);const principal=await a.principal();if(method==='revokeSession')assert.equal(principal.subjectId,'server-person-1');else assert.equal(principal,null);
 }
});

test('asynchronous issuer reads cannot authenticate a session or prepare a challenge after wall-clock expiry',async()=>{
 for(const operation of ['principal','session']){
  const f=fixture(),a=f.actor();await a.login();const resolve=f.issuer.resolveSession.bind(f.issuer);f.issuer.resolveSession=async input=>{const record=await resolve(input);f.advance(604800000);return record;};
  if(operation==='principal')assert.equal(await a.principal(),null);else assert.equal((await a.call('session')).data.session,null);
 }
 const f=fixture(),a=f.actor(),nonce=(await a.call('nonce',{})).data.nonce,get=f.issuer.getChallenge.bind(f.issuer);f.issuer.getChallenge=async input=>{const record=await get(input);f.advance(300000);return record;};
 assert.equal((await a.call('message',{nonce,address:account.address,chainId:56})).data.error,'challenge-expired');assert.equal(f.issuer.calls.some(([name])=>name==='prepareChallenge'),false);
});

test('an issuer cannot widen session permissions or substitute a different wallet or token digest',async()=>{
 for(const patch of [{permissions:['research:analyze','trade']},{address:other.address},{tokenHash:'f'.repeat(64)},{scopeId:''}]){
  const f=fixture(),a=f.actor(),issue=f.issuer.issueSession.bind(f.issuer);f.issuer.issueSession=async input=>({...await issue(input),...patch});
  assert.equal((await a.login()).status,503);assert.equal(a.jar.has(SESSION),false);assert.equal(f.issuer.sessions.size,0);
 }
});

test('logout revokes durable identity and clears both secure cookies; failure remains retryable',async()=>{
 const f=fixture(),a=f.actor();await a.login();const before=a.jar.get(SESSION),revoke=f.issuer.revokeSession.bind(f.issuer);f.issuer.revokeSession=async()=>false;
 const failed=await a.call('logout',{});assert.equal(failed.status,503);assert.equal(a.jar.get(SESSION),before);assert.equal(failed.setCookies.length,0);
 f.issuer.revokeSession=revoke;const result=await a.call('logout',{});assert.equal(result.status,200);assert.equal(result.data.session,null);assert.equal(a.jar.size,0);assert.equal(f.issuer.sessions.size,0);assert.equal(await a.principal(),null);assert.equal(result.setCookies.length,2);assert.ok(result.setCookies.every(value=>value.includes('Max-Age=0')));
});

test('preview tokens, legacy cookies and unconfigured invitation or 2FA never become production identity',async()=>{
 const f=fixture(),a=f.actor();
 for(const cookie of ['astarter_wallet='+'a'.repeat(64),SESSION+'=preview-token','user_id=browser-user'])assert.equal((await a.call('session',undefined,{headers:{cookie}})).data.session,null);
 assert.equal(f.issuer.calls.length,0);await a.login();const read=await a.call('session');assert.equal(read.data.invitation,null);assert.deepEqual(read.data.capabilities,{invitation:false,email:false,totp:false});
 const invitation=await a.call('invitation',{});assert.equal(invitation.status,503);assert.equal(invitation.data.invitation,null);assert.equal(invitation.data.capabilities.invitation,false);
});
