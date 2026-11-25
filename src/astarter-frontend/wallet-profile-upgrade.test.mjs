import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalletSession} from './wallet-session.mjs';
import {reauthenticateWalletProfile,deferWalletAuthentication,walletProfileContinuation,walletAuthenticated} from './wallet-entry.mjs';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {privateKeyToAccount} from 'viem/accounts';
import {verifyMessage} from 'viem';
import {createSiweMessage} from 'viem/siwe';
const v1={address:'0x'+'a'.repeat(40),chain:56,expires:Date.now()+600000},v2={...v1,authVersion:2,permissionProfile:'private-ui-v2'};
function fixture(session=v1,logoutFails=false,afterLogout=null){
 const calls=[];let current=session,state;
 const auth=createWalletSession({update:s=>{state=s;},request:async path=>{calls.push(path);if(path==='logout'){if(logoutFails)throw Error('offline');current=afterLogout;}return {session:current};}});
 return {auth,calls,state:()=>state};
}
test('an explicit UI profile upgrade revokes a v1 session before asking the wallet to sign again',async()=>{
 const f=fixture();assert.deepEqual(await reauthenticateWalletProfile(f.auth,'private-ui-v2'),{session:null});assert.deepEqual(f.calls,['session','logout','session']);assert.equal(f.state().session,null);
});
test('v2 and ordinary sign-in refreshes do not revoke a compatible authenticated session',async()=>{
 for(const [session,required] of [[v2,'private-ui-v2'],[v1,undefined],[v1,'unknown-profile']]){const f=fixture(session);assert.deepEqual(await reauthenticateWalletProfile(f.auth,required),{session});assert.deepEqual(f.calls,['session']);}
});
test('failed logout cannot proceed to a fresh sign-in or silently reuse the v1 profile',async()=>{
 const f=fixture(v1,true);assert.equal(await reauthenticateWalletProfile(f.auth,'private-ui-v2'),null);assert.deepEqual(f.calls,['session','logout']);assert.equal(f.state().error,'logout');
});
test('changing the connected wallet before profile verification prevents revoking the next account',async()=>{
 const f=fixture();assert.equal(await reauthenticateWalletProfile(f.auth,'private-ui-v2',()=>false),null);assert.deepEqual(f.calls,['session']);
});
test('a wallet change during logout never starts another session refresh',async()=>{
 const f=fixture();let checks=0;assert.equal(await reauthenticateWalletProfile(f.auth,'private-ui-v2',()=>++checks===1),null);assert.deepEqual(f.calls,['session','logout']);
});
test('a second refresh cannot pass a legacy or unknown profile through as a v2 upgrade',async()=>{
 for(const session of [v1,{...v2,authVersion:3},{...v2,permissionProfile:'research-v1'},{...v2,authVersion:'2'}]){
  const f=fixture(v1,false,session);assert.equal(await reauthenticateWalletProfile(f.auth,'private-ui-v2'),null);assert.deepEqual(f.calls,['session','logout','session']);
 }
 const valid=fixture(v1,false,v2);assert.deepEqual(await reauthenticateWalletProfile(valid.auth,'private-ui-v2'),{session:v2});
});
test('the explicit v2 intent survives connection and BSC switching, but cancels on account changes or close',async()=>{
 const {walletProfileContinuation}=await import('./wallet-entry.mjs');
 let intent={requiredProfile:'private-ui-v2',address:null,stage:'connect'};
 let next=walletProfileContinuation(intent,{status:'disconnected'});assert.ok(next.intent);assert.equal(next.resume,false);
 next=walletProfileContinuation(next.intent,{address:v1.address,chainId:1,status:'connected'});assert.equal(next.intent.address,v1.address);assert.equal(next.resume,false);
 next=walletProfileContinuation(next.intent,{address:v1.address,chainId:56,status:'connected'});assert.equal(next.resume,true);
 assert.equal(walletProfileContinuation(next.intent,{address:'0x'+'b'.repeat(40),chainId:56,status:'connected'}).intent,null);
 assert.equal(walletProfileContinuation(intent,{status:'disconnected'},true).intent,null);
 assert.equal(walletProfileContinuation({...intent,address:v1.address},{status:'disconnected'}).intent,null);
 const connecting=walletProfileContinuation(intent,{status:'connecting'},true);assert.ok(connecting.intent);assert.equal(walletProfileContinuation(connecting.intent,{status:'disconnected'}).intent,null);
 assert.equal(walletProfileContinuation(null,{address:v1.address,chainId:56,status:'connected'}).resume,false);
});
test('a profile request before the wallet SDK mounts is handed to its real listener exactly once',()=>{
 const target=new EventTarget();let loads=0;deferWalletAuthentication(target,()=>{loads++;});
 const request=()=>new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:'private-ui-v2'},cancelable:true});
 assert.equal(target.dispatchEvent(request()),false);assert.equal(target.dispatchEvent(request()),false);assert.equal(loads,2);
 const received=[];target.addEventListener('astarter:authenticate-wallet',event=>{event.preventDefault();received.push(event.detail);});
 target.dispatchEvent(new Event('astarter:wallet-ui-ready'));assert.deepEqual(received,[{requiredProfile:'private-ui-v2'}]);
 target.dispatchEvent(new Event('astarter:wallet-ui-ready'));assert.equal(received.length,1);
 target.dispatchEvent(request());assert.equal(received.length,2);assert.equal(loads,2);
});
test('idle SDK readiness does not invent a profile request or a signature',()=>{
 const target=new EventTarget();let loads=0,requests=0;deferWalletAuthentication(target,()=>{loads++;});
 const generic=new CustomEvent('astarter:authenticate-wallet',{cancelable:true});assert.equal(target.dispatchEvent(generic),true);
 target.addEventListener('astarter:authenticate-wallet',()=>requests++);target.dispatchEvent(new Event('astarter:wallet-ui-ready'));assert.equal(loads,0);assert.equal(requests,0);
});
test('cancelling before SDK readiness discards the stale upgrade request',()=>{
 for(const name of ['astarter:wallet-flow-end','pagehide']){
  const target=new EventTarget();deferWalletAuthentication(target,()=>{});target.dispatchEvent(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:'private-ui-v2'},cancelable:true}));
  target.dispatchEvent(new Event(name));let calls=0;target.addEventListener('astarter:authenticate-wallet',()=>calls++);target.dispatchEvent(new Event('astarter:wallet-ui-ready'));assert.equal(calls,0);
 }
});

function headerEffects(auth){
 const header=readFileSync(new URL('./header-wallet.jsx',import.meta.url),'utf8'),events=[],finished=[];let connects=0;
 const source=(start,end)=>{const i=header.indexOf(start);assert.ok(i>=0);return header.slice(i,header.indexOf(end,i));};
 const context={auth,address:undefined,chainId:undefined,connectionStatus:'disconnected',wrongNetwork:false,authenticated:false,session:null,currentWallet:{current:'disconnected'},reauthenticateWalletProfile,walletProfileContinuation,walletAuthenticated,CustomEvent,document:{getElementById:()=>null},finishWalletFlow:error=>finished.push(error),setConnectRequest:()=>connects++};
 context.window={dispatchEvent(event){events.push(event);if(event.type==='astarter:authenticate-wallet')context.authenticate(event);return true;}};
 runInNewContext(source('  const authenticate=event=>{',"window.addEventListener('astarter:authenticate-wallet'")+';globalThis.authenticate=authenticate;',context);
 runInNewContext(source(' const continueProfile=()=>{',' useEffect(continueProfile,')+';globalThis.continueProfile=continueProfile;',context);
 runInNewContext(source(' const profileOverlayClosed=()=>{',' const appInfo=')+';globalThis.profileOverlayClosed=profileOverlayClosed;',context);
 return {context,events,finished,connects:()=>connects,request(){context.authenticate(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:'private-ui-v2'},cancelable:true}));},wallet(address,chainId,status='connected'){Object.assign(context,{address,chainId,connectionStatus:status,wrongNetwork:Boolean(address&&chainId!==56)});context.currentWallet.current=[address,chainId,status].join(':');}};
}

test('the actual Header continuation retains v2 through connector and network changes, then uses the existing sign-in path',async()=>{
 const f=fixture(),h=headerEffects(f.auth);h.request();assert.equal(h.connects(),1);assert.equal(f.calls.length,0);assert.equal(f.auth.profileIntent.requiredProfile,'private-ui-v2');
 h.wallet(v1.address,1);h.context.continueProfile();assert.equal(f.auth.profileIntent.address,v1.address);assert.equal(f.calls.length,0);
 h.wallet(v1.address,56);h.context.continueProfile();assert.equal(f.auth.profileIntent.stage,'refresh');assert.equal(h.context.profileOverlayClosed(),false,'intermediate network close must not restore the previous dialog over the signing UI');
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.calls,['session','logout','session']);assert.equal(f.auth.profileIntent.stage,'sign');assert.equal(h.connects(),2);
 h.context.continueProfile();assert.equal(f.calls.length,3,'waiting for wallet confirmation must not reissue refresh or signature requests');
 Object.assign(h.context,{session:v2,authenticated:true});h.context.continueProfile();assert.equal(f.auth.profileIntent,null);assert.deepEqual(h.finished,[undefined]);assert.ok(f.calls.every(path=>!['nonce','message','verify'].includes(path)),'the bridge itself never signs or verifies a wallet');
});

test('actual Header close and account-change paths discard v2 intents before a later connection can reuse them',()=>{
 for(const cancel of ['close','account']){
  const f=fixture(),h=headerEffects(f.auth);h.wallet(v1.address,1);h.request();assert.equal(f.auth.profileIntent.address,v1.address);
  if(cancel==='close')assert.equal(h.context.profileOverlayClosed(),true);else{h.wallet('0x'+'b'.repeat(40),56);h.context.continueProfile();}
  assert.equal(f.auth.profileIntent,null);h.wallet(v1.address,56);h.context.continueProfile();assert.deepEqual(f.calls,[]);assert.equal(h.events.filter(event=>event.type==='astarter:authenticate-wallet').length,0);
 }
});
test('a late refresh from the previous connected account cannot publish an upgraded identity',async()=>{
 let release;const calls=[],auth=createWalletSession({update(){},request:path=>{calls.push(path);return new Promise(resolve=>{release=()=>resolve({session:v2});});}}),h=headerEffects(auth);
 h.wallet(v1.address,56);h.request();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['session']);
 h.wallet('0x'+'b'.repeat(40),56);h.context.continueProfile();assert.equal(auth.profileIntent,null);release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.events.filter(event=>event.detail?.ownerRef).length,0);assert.deepEqual(calls,['session']);assert.deepEqual(h.finished,[]);
});

async function preparedHeaderSigning({holdVerify=false}={}){
 // Public, intentionally insecure offline test key; never used for a funded wallet or network call.
 const account=privateKeyToAccount('0x'+'1'.repeat(64)),calls=[];let state,release;
 const session={...v2,address:account.address},auth=createWalletSession({update:value=>{state=value;},request:async(path,body)=>{
  calls.push(path);
  if(path==='nonce')return {nonce:'offlineNonce1234'};
  if(path==='message')return {message:createSiweMessage({domain:'astarter.imstark.site',address:body.address,statement:'Offline profile-epoch regression only.',uri:'https://astarter.imstark.site',version:'1',chainId:56,nonce:body.nonce,issuedAt:new Date()})};
  if(path==='verify'){
   assert.equal(await verifyMessage({address:account.address,message:body.message,signature:body.signature}),true);
   if(holdVerify)await new Promise(resolve=>{release=resolve;});
   return {session};
  }
  return {session:null};
 }}),h=headerEffects(auth);
 h.wallet(account.address,56);h.request();await new Promise(resolve=>setImmediate(resolve));assert.equal(auth.profileIntent.stage,'sign');
 const nonce=await auth.adapter.getNonce(),message=await auth.adapter.createMessage({nonce,address:account.address,chainId:56}),signature=await account.signMessage({message});
 return {auth,h,calls,message,signature,state:()=>state,release:()=>release()};
}

test('actual Header cancellation, account change and pagehide expire a prepared real SIWE signature epoch',async()=>{
 for(const action of ['close','account','pagehide']){
  const f=await preparedHeaderSigning();
  if(action==='close')assert.equal(f.h.context.profileOverlayClosed(),true);
  else if(action==='account'){f.h.wallet('0x'+'b'.repeat(40),56);f.h.context.continueProfile();}
  else{
   const header=readFileSync(new URL('./header-wallet.jsx',import.meta.url),'utf8'),start=header.indexOf('const hide=()=>{'),end=header.indexOf(',show=',start);assert.ok(start>=0&&end>start);runInNewContext(header.slice(start,end)+';hide();',{auth:f.auth});
  }
  assert.equal(f.auth.profileIntent,null);assert.equal(await f.auth.adapter.verify({message:f.message,signature:f.signature}),false,action);assert.equal(f.calls.includes('verify'),false,action);assert.equal(f.state().session,null,action);
 }
});

test('an intermediate refresh close preserves its real prepared signature rather than cancelling the ongoing flow',async()=>{
 const f=await preparedHeaderSigning();f.auth.profileIntent.stage='refresh';assert.equal(f.h.context.profileOverlayClosed(),false);assert.ok(f.auth.profileIntent);
 assert.equal(await f.auth.adapter.verify({message:f.message,signature:f.signature}),true);assert.equal(f.calls.filter(path=>path==='verify').length,1);assert.equal(f.state().session.authVersion,2);
});

test('cancelling an already sent verification rejects its late v2 session and requests sign-out',async()=>{
 const f=await preparedHeaderSigning({holdVerify:true}),verification=f.auth.adapter.verify({message:f.message,signature:f.signature});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(path=>path==='verify').length,1);
 assert.equal(f.h.context.profileOverlayClosed(),true);f.release();assert.equal(await verification,false);assert.equal(f.state().session,null);assert.equal(f.calls.at(-1),'logout');
});
