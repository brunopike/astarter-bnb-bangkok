import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createWalletAuth} from './wallet-auth.mjs';
import {walletAuthenticated,walletLabels,walletMenuLabels,walletMenuPosition,walletEntryAction,walletStatusLabels} from './wallet-entry.mjs';
import {createWalletSession,walletRequest} from './wallet-session.mjs';
async function fixture(t,options={}){
 let time=Date.now();const create=()=>createWalletAuth({file:':memory:',now:()=>time,...options});let auth=create();const server=http.createServer((req,res)=>auth.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();auth.close();});const origin='http://127.0.0.1:'+server.address().port;
 const actor=(account=privateKeyToAccount(generatePrivateKey()))=>{
  let cookies={};
  const call=async(path,body,options={})=>{const res=await fetch(origin+'/api/wallet/'+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{origin,'content-type':'application/json',cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of res.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');cookies[k]=v;}return {status:res.status,data:await res.json()};};
  const challenge=async(chainId=56)=>{const {data:{nonce}}=await call('nonce',{});return call('message',{nonce,address:account.address,chainId});};
  return {call,account,challenge};
 };
 return {...actor(),actor,origin,advance:ms=>time+=ms,reopen(){auth.close();auth=create();}};
}
async function login(actor,referralCode){const {data:{message}}=await actor.challenge();return actor.call('verify',{message,signature:await actor.account.signMessage({message}),...(referralCode===undefined?{}:{referralCode})});}
async function prepareClient(client){const nonce=await client.adapter.getNonce();return client.adapter.createMessage({nonce,address:'0x'+'a'.repeat(40),chainId:56});}

test('browser wallet deadlines leave room for issuer calls and the hosted verification response',async t=>{
 const timeouts={},calls=[];let current;
 t.mock.method(AbortSignal,'timeout',ms=>{timeouts[current]=ms;return new AbortController().signal;});
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(current==='nonce'?{nonce:'offline-nonce'}:current==='message'?{message:'offline-message'}:current==='verify'?{session:{address:'0x'+'a'.repeat(40),chain:56,expires:Date.now()+60000}}:{session:null}),{headers:{'content-type':'application/json'}});});
 for(current of ['nonce','message','verify','session','logout'])await walletRequest(current,current==='session'?undefined:{});
 const hostedMs=JSON.parse(readFileSync(new URL('./vercel.json',import.meta.url),'utf8')).functions['api/wallet.mjs'].maxDuration*1000;
 assert.ok(timeouts.nonce>2*5000);assert.ok(timeouts.message>2*5000);assert.ok(timeouts.verify>=hostedMs+5000);assert.ok(Object.values(timeouts).every(ms=>ms>=10000&&ms<=60000));
 assert.equal(calls.length,5);assert.ok(calls.every(c=>c.options.credentials==='same-origin'&&c.options.cache==='no-store'));
});

test('pending referrals stay in the current tab through failed signing and are sent only with verification',async()=>{
 const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},code='A'.repeat(32),calls=[];
 let fail=true;
 const client=createWalletSession({update:()=>{},referralStorage:storage,referralSearch:'?ref='+code,request:async(path,body)=>{
  calls.push({path,body});if(path==='nonce')return {nonce:'fixture-nonce'};if(path==='message')return {message:'fixture-message-'+calls.length};if(fail)throw Error('invalid-signature');return {session:{address:'0x'+'a'.repeat(40),chain:56,expires:Date.now()+60000},referralApplied:'accepted'};
 }});
 assert.equal(storage.getItem('astarter.wallet.referral.v1'),code);
 assert.equal(await client.adapter.verify({message:await prepareClient(client),signature:'test-signature'}),false);assert.equal(storage.getItem('astarter.wallet.referral.v1'),code);
 fail=false;assert.equal(await client.adapter.verify({message:await prepareClient(client),signature:'retry-signature'}),true);
 assert.ok(calls.filter(call=>call.path==='verify').every(call=>call.body.referralCode===code));assert.ok(calls.filter(call=>call.path!=='verify').every(call=>call.body.referralCode===undefined));assert.equal(storage.getItem('astarter.wallet.referral.v1'),null);
});

test('malformed public referral values are never attached to authentication requests',async()=>{
 for(const code of ['A'.repeat(31),'A'.repeat(33),'a/b?c','<script>']){
  const calls=[],client=createWalletSession({update:()=>{},referralSearch:'?ref='+encodeURIComponent(code),request:async(path,body)=>{calls.push(body);return path==='nonce'?{nonce:'fixture-nonce'}:path==='message'?{message:'fixture-message'}:{session:null};}});
  await client.adapter.verify({message:await prepareClient(client),signature:'test'});assert.ok(calls.every(body=>body.referralCode===undefined));
 }
});

test('personal invitation codes require signed-in ownership, stay idempotent and expose only confirmed masked joins',async t=>{
 const owner=await fixture(t);assert.equal((await owner.call('invitation',{})).status,401);
 assert.equal((await login(owner)).status,200);const before=await owner.call('session');assert.equal(before.data.invitation.url,null);assert.equal(before.data.invitation.joinedCount,0);
 assert.deepEqual(before.data.security.capabilities,{email:false,totp:false});assert.equal(before.data.security.email,null);assert.equal(before.data.security.totp,null);
 assert.equal((await owner.call('invitation',{address:owner.account.address})).status,400);
 const generated=await Promise.all(Array.from({length:5},()=>owner.call('invitation',{})));assert.ok(generated.every(r=>r.status===200));
 const links=new Set(generated.map(r=>r.data.invitation.url));assert.equal(links.size,1);const url=new URL([...links][0]);assert.equal(url.origin,owner.origin);assert.match(url.searchParams.get('ref'),/^[A-Za-z0-9_-]{32}$/);
 const visitor=owner.actor();await visitor.challenge();assert.equal((await owner.call('session')).data.invitation.joinedCount,0);
 const joined=await login(visitor,url.searchParams.get('ref'));assert.equal(joined.status,200);assert.equal(joined.data.referralApplied,'accepted');
 const own=(await owner.call('session')).data.invitation;assert.equal(own.joinedCount,1);assert.equal(own.records.length,1);assert.match(own.records[0].name,/^0x[a-f0-9]{4}…[a-f0-9]{4}$/);assert.ok(Number.isFinite(own.records[0].joinedAt));assert.ok(!JSON.stringify(own).toLowerCase().includes(visitor.account.address.toLowerCase()));
 const other=owner.actor();await login(other);const otherUrl=new URL((await other.call('invitation',{})).data.invitation.url);
 assert.equal((await login(visitor,otherUrl.searchParams.get('ref'))).data.referralApplied,'already-linked');assert.equal((await owner.call('session')).data.invitation.joinedCount,1);assert.equal((await other.call('session')).data.invitation.joinedCount,0);
 const privateRead=await visitor.call('session?address='+encodeURIComponent(owner.account.address));assert.equal(privateRead.data.invitation.address,visitor.account.address);assert.equal(privateRead.data.invitation.joinedCount,0);
 assert.equal((await login(owner,url.searchParams.get('ref'))).data.referralApplied,'self');
 assert.equal((await owner.call('invitation',{}, {headers:{origin:'https://other.invalid'}})).status,403);
 owner.advance(7*86400000+1);assert.equal((await owner.call('invitation',{})).status,401);await login(owner);assert.equal((await owner.call('session')).data.invitation.joinedCount,1);assert.equal((await owner.call('invitation',{})).data.invitation.url,url.href);
});

test('invalid referral data never blocks a valid login and rejected signatures cannot create joins',async t=>{
 const owner=await fixture(t);await login(owner);const code=new URL((await owner.call('invitation',{})).data.invitation.url).searchParams.get('ref');
 for(const invalid of ['x'.repeat(31),'x'.repeat(33),'x'.repeat(32),{},['x'],null]){const visitor=owner.actor();const r=await login(visitor,invalid);assert.equal(r.status,200);assert.equal(r.data.referralApplied,'invalid');}
 const bad=owner.actor(),{data:{message}}=await bad.challenge();const wrong=owner.actor();const rejected=await bad.call('verify',{message,signature:await wrong.account.signMessage({message}),referralCode:code});assert.equal(rejected.status,401);assert.equal((await owner.call('session')).data.invitation.joinedCount,0);
});

test('two valid sign-ins for the same invited wallet cannot count twice or change the first inviter',async t=>{
 const first=await fixture(t),second=first.actor();await login(first);await login(second);
 const codes=await Promise.all([first,second].map(async actor=>new URL((await actor.call('invitation',{})).data.invitation.url).searchParams.get('ref')));
 const visitor=first.actor(),otherTab=first.actor(visitor.account);const results=await Promise.all([login(visitor,codes[0]),login(otherTab,codes[1])]);
 assert.deepEqual(results.map(r=>r.data.referralApplied).sort(),['accepted','already-linked']);
 const counts=await Promise.all([first,second].map(async actor=>(await actor.call('session')).data.invitation.joinedCount));assert.equal(counts[0]+counts[1],1);
});

test('logout while signature verification is pending prevents invitation attribution',async t=>{
 let delay=false,release,started;const ready=new Promise(resolve=>started=resolve);
 const owner=await fixture(t,{verifySignature:()=>delay?(started(),new Promise(resolve=>release=resolve)):true});await login(owner);const code=new URL((await owner.call('invitation',{})).data.invitation.url).searchParams.get('ref');
 const visitor=owner.actor();const {data:{message}}=await visitor.challenge();const signature=await visitor.account.signMessage({message});delay=true;
 const pending=visitor.call('verify',{message,signature,referralCode:code});await ready;assert.equal((await visitor.call('logout',{})).status,200);release(true);
 assert.equal((await pending).status,401);assert.equal((await owner.call('session')).data.invitation.joinedCount,0);
});

test('invitation codes and masked joins survive service reopen, and attribution failure rolls back sign-in',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'astarter-invitation-test-')),file=join(directory,'auth.sqlite');const owner=await fixture(t,{file});t.after(()=>rmSync(directory,{recursive:true,force:true}));
 await login(owner);const url=(await owner.call('invitation',{})).data.invitation.url,code=new URL(url).searchParams.get('ref');const joined=owner.actor();await login(joined,code);
 owner.reopen();assert.equal((await owner.call('session')).data.invitation.joinedCount,1);assert.equal((await owner.call('invitation',{})).data.invitation.url,url);
 const db=new DatabaseSync(file);db.exec("CREATE TRIGGER test_referral_failure BEFORE INSERT ON wallet_referrals BEGIN SELECT RAISE(ABORT,'test-only failure'); END");db.close();
 const visitor=owner.actor();const failed=await login(visitor,code);assert.equal(failed.status,500);assert.equal((await visitor.call('session')).data.session,null);assert.equal((await owner.call('session')).data.invitation.joinedCount,1);
 const repair=new DatabaseSync(file);repair.exec('DROP TRIGGER test_referral_failure');repair.close();assert.equal((await login(visitor,code)).data.referralApplied,'accepted');assert.equal((await owner.call('session')).data.invitation.joinedCount,2);
});
test('account menu remains anchored inside narrow and short viewports',()=>{
 assert.deepEqual(walletMenuPosition({right:1424,bottom:52},{width:1440,height:900}),{right:16,top:62});
 assert.deepEqual(walletMenuPosition({right:320,bottom:52},{width:320,height:640}),{right:12,top:62});
 assert.deepEqual(walletMenuPosition({right:325,bottom:590},{width:320,height:640}),{right:12,top:520});
 assert.deepEqual(walletMenuPosition({right:100,bottom:52},{width:1440,height:900}),{right:1084,top:62});
 for(const lang of ['zh-CN','en','ja-JP','ko-KR','vi-VN','es','fr','ru'])assert.equal(walletMenuLabels(lang).filter(Boolean).length,11);
 assert.deepEqual(walletMenuLabels('unknown'),walletMenuLabels('en'));
});
test('BSC login requires a verified signature and creates an expiring server session',async t=>{
 const f=await fixture(t);assert.equal((await f.call('session')).data.session,null);
 const {data:{message}}=await f.challenge();assert.match(message,/Chain ID: 56/);assert.match(message,/does not authorize trades/);
 const signature=await f.account.signMessage({message});const login=await f.call('verify',{message,signature});assert.equal(login.status,200);assert.equal(login.data.session.address,f.account.address);
 assert.equal((await f.call('session')).data.session.address,f.account.address);
 assert.equal((await f.call('verify',{message,signature})).status,401);
 f.advance(7*86400000+1);assert.equal((await f.call('session')).data.session,null);
});
test('ipfund.art can read the wallet session and other public hosts stay closed',async()=>{
 const auth=createWalletAuth({file:':memory:'});
 const call=(host,origin)=>new Promise(resolve=>{
  const req={url:'/api/wallet/session',method:'GET',headers:{host,...(origin?{origin}:{})}};
  const res={status:0,body:'',setHeader(){},writeHead(status){this.status=status;},end(body){this.body=body;resolve(this);}};
  auth.handle(req,res);
 });
 const site=await call('ipfund.art','https://ipfund.art');
 assert.equal(site.status,200);assert.equal(JSON.parse(site.body).session,null);
 assert.equal((await call('www.ipfund.art','https://www.ipfund.art')).status,200);
 assert.equal((await call('astarter.imstark.site','https://astarter.imstark.site')).status,200);
 assert.equal((await call('ipfund.art','https://astarter.imstark.site')).status,403);
 assert.equal((await call('astarter.imstark.site','https://ipfund.art')).status,403);
 assert.equal((await call('ipfund.art','http://ipfund.art')).status,403);
 assert.equal((await call('astarter.imstark.site.evil.invalid','https://astarter.imstark.site.evil.invalid')).status,403);
 assert.equal((await call('evil.example','https://evil.example')).status,403);
 auth.close();
});
test('other networks, cross-origin requests and changed SIWE messages are rejected',async t=>{
 const f=await fixture(t);assert.equal((await f.challenge(1)).status,400);
 assert.equal((await f.call('nonce',{}, {headers:{origin:'https://other.invalid'}})).status,403);
 const {data:{message}}=await f.challenge();const changed=message.replace('Sign in to Astarter.','Transfer all funds.');const signature=await f.account.signMessage({message:changed});assert.equal((await f.call('verify',{message:changed,signature})).status,401);assert.equal((await f.call('session')).data.session,null);
});
test('expired nonces and signatures by a different wallet cannot log in',async t=>{
 const f=await fixture(t);let {data:{message}}=await f.challenge();let signature=await f.account.signMessage({message});f.advance(300001);assert.equal((await f.call('verify',{message,signature})).status,401);
 ({data:{message}}=await f.challenge());signature=await privateKeyToAccount(generatePrivateKey()).signMessage({message});assert.equal((await f.call('verify',{message,signature})).status,401);
});
test('disconnect revokes the server session; client display checks address, BSC and expiry',async t=>{
 const f=await fixture(t);const {data:{message}}=await f.challenge();const signature=await f.account.signMessage({message});const {data:{session}}=await f.call('verify',{message,signature});
 assert.equal(walletAuthenticated(session,f.account.address,56,'connected'),true);assert.equal(walletAuthenticated(session,'0x0000000000000000000000000000000000000001',56,'connected'),false);assert.equal(walletAuthenticated({...session,chain:1},f.account.address,56,'connected'),false);assert.equal(walletAuthenticated({...session,expires:1},f.account.address,56,'connected'),false);
 assert.equal(walletAuthenticated(session,f.account.address,1,'connected'),false);assert.equal(walletAuthenticated(session,f.account.address),false);
 for(const status of ['connecting','reconnecting','disconnected',undefined])assert.equal(walletAuthenticated(session,f.account.address,56,status),false);
 assert.equal((await f.call('logout',{})).status,200);assert.equal((await f.call('session')).data.session,null);
 for(const lang of ['zh-CN','en','ja-JP','ko-KR','vi-VN','es','fr','ru'])assert.ok(walletLabels(lang).every(Boolean));
});

test('malformed wallet addresses are rejected at the API boundary',async t=>{
 const f=await fixture(t);const {data:{nonce}}=await f.call('nonce',{});
 for(const address of [null,42,{},[],false,'not-an-address'])assert.equal((await f.call('message',{nonce,address,chainId:56})).status,400);
});

test('logout cancels verification already in flight',async t=>{
 let release,started;const ready=new Promise(r=>started=r);
 const f=await fixture(t,{verifySignature:()=>{started();return new Promise(r=>release=r);}});
 const {data:{message}}=await f.challenge(),signature=await f.account.signMessage({message});
 const verification=f.call('verify',{message,signature});await ready;
 assert.equal((await f.call('logout',{})).status,200);release(true);
 assert.equal((await verification).status,401);assert.equal((await f.call('session')).data.session,null);
});

test('a new challenge or expiry cancels an older pending verification',async t=>{
 for(const action of ['renew','expire'])await t.test(action,async t=>{
  let release,started;const ready=new Promise(r=>started=r);
  const f=await fixture(t,{verifySignature:()=>{started();return new Promise(r=>release=r);}});
  const {data:{message}}=await f.challenge(),signature=await f.account.signMessage({message});
  const verification=f.call('verify',{message,signature});await ready;
  if(action==='renew')await f.call('nonce',{});else f.advance(300001);
  release(true);assert.equal((await verification).status,401);assert.equal((await f.call('session')).data.session,null);
 });
});

test('sign-in retries renew consumed and expired challenges without reconnecting',async t=>{
 const f=await fixture(t);let state;
 const client=createWalletSession({update:s=>state=s,request:async(...args)=>{const result=await f.call(...args);if(result.status!==200)throw Error(result.data.error);return result.data;}});
 const nonce=await client.adapter.getNonce(),params={nonce,address:f.account.address,chainId:56};
 let message=await client.adapter.createMessage(params);
 const wrong=privateKeyToAccount(generatePrivateKey());assert.equal(await client.adapter.verify({message,signature:await wrong.signMessage({message})}),false);
 assert.equal(state.error,'verify');message=await client.adapter.createMessage(params);
 assert.equal(await client.adapter.verify({message,signature:await f.account.signMessage({message})}),true);
 assert.equal(state.session.address,f.account.address);assert.equal(state.error,null);
 await client.adapter.signOut();const nextNonce=await client.adapter.getNonce();f.advance(300001);
 message=await client.adapter.createMessage({...params,nonce:nextNonce});
 assert.equal(await client.adapter.verify({message,signature:await f.account.signMessage({message})}),true);
});

test('an older session response cannot restore a login after sign-out',async()=>{
 let release,started,state;const ready=new Promise(r=>started=r);
 const client=createWalletSession({update:s=>state=s,request:async path=>{if(path==='session'){started();return new Promise(r=>release=r);}return {session:null};}});
 const refresh=client.refresh();await ready;await client.adapter.signOut();
 release({session:{address:'old-account'}});assert.equal(await refresh,false);assert.equal(state.session,null);
});

test('failed logout is retried before restoring a session, including after reload',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 let state,calls=[],offline=true;
 const request=async path=>{calls.push(path);if(offline)throw Error('offline');return {session:null};};
 let client=createWalletSession({request,storage,update:s=>state=s});
 assert.equal(await client.adapter.signOut(),false);assert.equal(state.error,'logout');assert.equal(state.session,null);
 client=createWalletSession({request,storage,update:s=>state=s});
 assert.equal(await client.refresh(),false);assert.deepEqual(calls,['logout','logout']);
 offline=false;assert.equal(await client.refresh(),true);assert.deepEqual(calls,['logout','logout','logout','session']);assert.equal(values.size,0);assert.equal(state.error,null);
});

test('duplicate disconnect notifications share one logout and late verification stays signed out',async()=>{
 let releaseLogout,releaseVerify,state,logoutCalls=0,started;const ready=new Promise(resolve=>started=resolve);
 const client=createWalletSession({update:s=>state=s,request:path=>{if(path==='nonce')return Promise.resolve({nonce:'fixture-nonce'});if(path==='message')return Promise.resolve({message:'fixture-message'});if(path==='verify'){started();return new Promise(r=>releaseVerify=r);}logoutCalls++;return new Promise(r=>releaseLogout=r);}});
 const verification=client.adapter.verify({message:await prepareClient(client),signature:'test'});await ready;const first=client.adapter.signOut(),second=client.adapter.signOut();
 assert.equal(logoutCalls,1);releaseVerify({session:{address:'stale'}});await Promise.resolve();releaseLogout({session:null});
 await Promise.all([first,second]);assert.equal(await verification,false);assert.equal(state.session,null);
});

test('session service failure can be retried without leaving the button busy',async()=>{
 let state,offline=true;const client=createWalletSession({update:s=>state=s,request:async()=>{if(offline)throw Error('offline');return {session:null};}});
 assert.equal(await client.refresh(),false);assert.equal(state.error,'service');assert.equal(state.busy,false);
 offline=false;assert.equal(await client.refresh(),true);assert.equal(state.error,null);assert.equal(state.busy,false);
});

test('two simultaneous signature submissions establish only one session',async t=>{
 const f=await fixture(t);const {data:{message}}=await f.challenge();const signature=await f.account.signMessage({message});
 const results=await Promise.all([f.call('verify',{message,signature}),f.call('verify',{message,signature})]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,401]);assert.equal((await f.call('session')).data.session.address,f.account.address);
});


test('wallet connection remains reachable when the sign-in service cannot restore a session',()=>{
 for(const error of ['service','logout',null])assert.equal(walletEntryAction({error}), 'connect');
 assert.equal(walletEntryAction({error:'service',busy:'session'}),'connect');
 for(const error of ['service','logout'])assert.equal(walletEntryAction({error,address:'0xabc'}),'retry-session');
 assert.equal(walletEntryAction({error:'service',address:'0xabc',wrongNetwork:true}),'network');
 assert.equal(walletEntryAction({error:'service',reconnectSlow:true}),'reset');
 assert.equal(walletEntryAction({busy:'logout',error:'logout',reconnectSlow:true}),'reset');
 assert.equal(walletEntryAction({busy:'session',address:'0xabc',error:'service',wrongNetwork:true}),'network');
 assert.equal(walletEntryAction({busy:'verify',address:'0xabc',wrongNetwork:true}),'network');
 assert.equal(walletEntryAction({busy:'logout'}),'wait');
 assert.equal(walletEntryAction({address:'0xabc',busy:'session'}),'wait');
 for(const lang of ['zh','en','ja','ko','vi','es','fr','ru'])assert.equal(walletStatusLabels(lang).length,3);
});

test('sign-in distinguishes an unavailable service from a rejected signature',async()=>{
 let state,prepare=false;const client=createWalletSession({update:s=>state=s,request:async path=>{if(prepare&&path==='nonce')return {nonce:'fixture-nonce'};if(prepare&&path==='message')return {message:'fixture-message'};throw Object.assign(Error('unavailable'),{status:503});}});
 await assert.rejects(client.adapter.getNonce(),/unavailable/);assert.equal(state.error,'service');
 await assert.rejects(client.adapter.createMessage({nonce:'test',address:'0xabc',chainId:56}),/unavailable/);assert.equal(state.error,'service');
 prepare=true;assert.equal(await client.adapter.verify({message:await prepareClient(client),signature:'test'}),false);assert.equal(state.error,'service');assert.equal(state.session,null);
 const rejected=createWalletSession({update:s=>state=s,request:async path=>{if(path==='nonce')return {nonce:'fixture-nonce'};if(path==='message')return {message:'fixture-message'};throw Object.assign(Error('invalid-signature'),{status:401});}});
 assert.equal(await rejected.adapter.verify({message:await prepareClient(rejected),signature:'test'}),false);assert.equal(state.error,'verify');
});

test('verification requires the exact prepared message and cannot revive a flow cancelled by failed logout or recovery',async()=>{
 let state,offline=true,n=0;const calls=[];
 const client=createWalletSession({update:s=>state=s,request:async path=>{calls.push(path);if(path==='nonce')return {nonce:'nonce-'+(++n)};if(path==='message')return {message:'prepared-'+n};if(path==='logout'&&offline)throw Object.assign(Error('unavailable'),{status:503});return {session:path==='verify'?{address:'0x'+'a'.repeat(40),chain:56,expires:Date.now()+60000}:null};}});
 assert.equal(await client.adapter.verify({message:'unprepared',signature:'test'}),false);assert.equal(calls.length,0);
 const message=await prepareClient(client);assert.equal(await client.adapter.verify({message:message+'modified',signature:'test'}),false);assert.equal(calls.includes('verify'),false);
 assert.equal(await client.adapter.signOut(),false);assert.equal(state.error,'logout');assert.equal(await client.adapter.verify({message,signature:'late-signature'}),false);assert.equal(calls.includes('verify'),false);
 offline=false;assert.equal(await client.refresh(),true);assert.equal(await client.adapter.verify({message,signature:'late-after-recovery'}),false);assert.equal(calls.includes('verify'),false);
 assert.equal(await client.adapter.verify({message:await prepareClient(client),signature:'new-signature'}),true);assert.equal(calls.filter(path=>path==='verify').length,1);
});

test('a real SIWE signature prepared before failed logout stays cancelled after service recovery',async t=>{
 const f=await fixture(t);let offline=true,verifications=0;
 const client=createWalletSession({update:()=>{},request:async(path,body)=>{if(path==='logout'&&offline)throw Object.assign(Error('wallet-service-unavailable'),{status:503});if(path==='verify')verifications++;const result=await f.call(path,body);if(result.status!==200)throw Object.assign(Error(result.data.error),{status:result.status});return result.data;}});
 const prepare=async()=>{const nonce=await client.adapter.getNonce();return client.adapter.createMessage({nonce,address:f.account.address,chainId:56});};
 const message=await prepare(),signature=await f.account.signMessage({message});assert.equal(await client.adapter.signOut(),false);assert.equal(await client.adapter.verify({message,signature}),false);assert.equal(verifications,0);
 offline=false;assert.equal(await client.refresh(),true);assert.equal(await client.adapter.verify({message,signature}),false);assert.equal(verifications,0);
 const current=await prepare();assert.notEqual(current,message);assert.equal(await client.adapter.verify({message:current,signature:await f.account.signMessage({message:current})}),true);assert.equal(verifications,1);
});

test('verify rechecks its epoch after the pending logout barrier and never sends the old signature',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};let release,state;const calls=[];
 const client=createWalletSession({storage,update:s=>state=s,request:async path=>{calls.push(path);if(path==='nonce')return {nonce:'fixture-nonce'};if(path==='message')return {message:'fixture-message'};if(path==='logout')return new Promise(resolve=>release=resolve);return {session:{address:'unexpected'}};}});
 const message=await prepareClient(client);values.set('astarter.wallet.logout','pending');const verification=client.adapter.verify({message,signature:'late'});await Promise.resolve();assert.equal(state.busy,'logout');release({session:null});assert.equal(await verification,false);assert.equal(calls.includes('verify'),false);
});

test('expire releases a cancelled session read, preserves active logout, and invalidates prepared or still-preparing messages',async()=>{
 let state,releaseSession,count=0;const client=createWalletSession({update:s=>state=s,request:async()=>++count===1?{session:{address:'0xabc',chain:56,expires:Date.now()+10}}:new Promise(resolve=>releaseSession=resolve)});
 await client.refresh();const pending=client.refresh();await Promise.resolve();client.expire();assert.equal(state.session,null);assert.equal(state.busy,false);releaseSession({session:{address:'stale'}});assert.equal(await pending,false);assert.equal(state.busy,false);assert.equal(walletEntryAction({...state,address:'0xabc'}),'connect');
 let releaseLogout;const logout=createWalletSession({update:s=>state=s,request:async()=>new Promise(resolve=>releaseLogout=resolve)}),out=logout.adapter.signOut();logout.expire();assert.equal(state.busy,'logout');releaseLogout({session:null});await out;assert.equal(state.busy,false);
 let releaseMessage;const calls=[],preparing=createWalletSession({update:s=>state=s,request:async path=>{calls.push(path);if(path==='nonce')return {nonce:'fixture-nonce'};return new Promise(resolve=>releaseMessage=resolve);}});
 const nonce=await preparing.adapter.getNonce(),messagePromise=preparing.adapter.createMessage({nonce,address:'0xabc',chainId:56});await Promise.resolve();preparing.expire();releaseMessage({message:'cancelled-message'});await assert.rejects(messagePromise,/authentication-cancelled/);assert.equal(await preparing.adapter.verify({message:'cancelled-message',signature:'late'}),false);assert.equal(calls.includes('verify'),false);
});

test('non-JSON, primitive or malformed success payloads are fixed service errors without upstream body disclosure',async()=>{
 const original=globalThis.fetch;
 try{
  for(const [path,body,status] of [['verify','gateway-private-diagnostic',503],['verify','',503],['verify','{}',401],['session','null',200],['nonce','[]',200],['nonce','{}',200],['message','{}',200],['verify','{"session":null}',200],['session','{"session":{"address":"bad","chain":56,"expires":1}}',200]]){
   globalThis.fetch=async()=>new Response(body,{status});await assert.rejects(()=>walletRequest(path,path==='session'?undefined:{}),error=>error.message==='wallet-service-unavailable'&&error.status>=500&&!String(error).includes('gateway-private-diagnostic'));
  }
  let state;globalThis.fetch=async()=>new Response('gateway-private-diagnostic',{status:503});const client=createWalletSession({update:s=>state=s,request:(path,body)=>path==='verify'?walletRequest(path,body):Promise.resolve(path==='nonce'?{nonce:'fixture-nonce'}:{message:'fixture-message'})});assert.equal(await client.adapter.verify({message:await prepareClient(client),signature:'test'}),false);assert.equal(state.error,'service');assert.equal(state.busy,false);
 }finally{globalThis.fetch=original;}
});

test('explicit identity recovery clears stale proof, shares concurrent reads and invalidates prepared signatures',async()=>{
 let state,release,refreshes=0,verifies=0;
 const client=createWalletSession({update:s=>state=s,request:async path=>{if(path==='nonce')return {nonce:'test-nonce'};if(path==='message')return {message:'prepared-message'};if(path==='verify'){verifies++;return {session:null};}refreshes++;return new Promise(resolve=>release=resolve);}});
 const nonce=await client.adapter.getNonce();await client.adapter.createMessage({nonce,address:'0xabc',chainId:56});
 const first=client.reauthenticate(),second=client.reauthenticate();assert.equal(first,second);assert.equal(state.session,null);await Promise.resolve();assert.equal(refreshes,1);
 release({session:null});assert.deepEqual(await first,{session:null});assert.equal(await client.adapter.verify({message:'prepared-message',signature:'late'}),false);assert.equal(verifies,0);assert.equal(state.busy,false);
});

test('identity recovery preserves valid server sessions and treats outages and cancelled reads as unavailable',async()=>{
 const session={address:'0x'+'a'.repeat(40),chain:56,expires:Date.now()+60000};let state;
 const valid=createWalletSession({update:s=>state=s,request:async path=>{assert.equal(path,'session');return {session};}});
 assert.deepEqual(await valid.reauthenticate(),{session});assert.equal(state.busy,false);
 const offline=createWalletSession({update:s=>state=s,request:async()=>{throw Object.assign(Error('offline'),{status:503});}});
 assert.equal(await offline.reauthenticate(),null);assert.equal(state.error,'service');assert.equal(state.busy,false);
 let release;const cancelled=createWalletSession({update:s=>state=s,request:()=>new Promise(resolve=>release=resolve)});
 const recovering=cancelled.reauthenticate();await Promise.resolve();cancelled.expire();release({session});assert.equal(await recovering,null);assert.equal(state.session,null);assert.equal(state.busy,false);
});

test('identity recovery cannot bypass an unfinished server logout',async()=>{
 let state;const calls=[];const client=createWalletSession({update:s=>state=s,request:async path=>{calls.push(path);throw Object.assign(Error('offline'),{status:503});}});
 assert.equal(await client.adapter.signOut(),false);assert.equal(await client.reauthenticate(),null);assert.deepEqual(calls,['logout','logout']);assert.equal(state.error,'logout');assert.equal(state.session,null);
});
