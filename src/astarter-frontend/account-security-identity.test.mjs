import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurityFlow,securityView} from './account-security.mjs';

const current=1_000_000;
const challenge=()=>({id:'fixture-only',method:'email',purpose:'bind-email',expiresAt:current+300000,resendAt:current+60000});
const owner=(wallet,email=null)=>({signedIn:true,wallet,email,totp:false,social:[],sessions:[]});
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);

test('switching to another identity clears the previous typed email, codes and challenge',async()=>{
  const f=createSecurityFlow({now:()=>current,snapshot:owner(A),request:async()=>({challenge:challenge()})});
  f.navigate('email');
  await f.startEmail('first-owner@example.invalid');
  assert.equal(f.state.email,'first-owner@example.invalid');assert.ok(f.state.challenge);
  f.setCode('123');
  f.setIdentity(owner(B));
  assert.equal(f.state.email,'');assert.equal(f.state.code,'');assert.equal(f.state.challenge,null);assert.deepEqual(f.state.codes,[]);
  assert.doesNotMatch(securityView(f.state,{locale:'en',now:current}),/first-owner@example\.invalid/);
});

test('signing out clears the typed email of the previous identity',()=>{
  const f=createSecurityFlow({snapshot:owner(A)});
  f.navigate('email');f.setEmail('first-owner@example.invalid');
  f.setIdentity(null);
  assert.equal(f.state.snapshot.signedIn,false);assert.equal(f.state.email,'');
});

test('re-reading the same identity keeps the typed email in place',()=>{
  const f=createSecurityFlow({snapshot:owner(A)});
  f.navigate('email');f.setEmail('draft@example.invalid');
  f.setIdentity(owner(A));
  assert.equal(f.state.email,'draft@example.invalid');
});

test('an unconnected service on a security flow page points back to the security center in place',async()=>{
  for(const page of ['email','two-factor','verify','recovery','account-social','sessions']){
    const f=createSecurityFlow({snapshot:owner(A)});f.navigate(page);
    if(page==='email')await f.startEmail('qa@example.invalid');
    else if(page==='two-factor')await f.beginTotp();
    else if(page==='verify')await f.beginChallenge();
    else if(page==='recovery')await f.recover('ABCD-1234');
    else await f.refresh();
    assert.equal(f.state.error,'unavailable',page);
    for(const [locale,label] of [['en','Back to security'],['zh','返回安全中心']]){
      const html=securityView(f.state,{locale});
      const feedback=html.slice(html.indexOf('id="as-feedback"'));
      assert.match(feedback,/role="alert"/,page);
      assert.ok(feedback.includes(`data-security-page="security">${label}</a>`),page+' '+locale);
    }
    assert.equal(f.state.success,false,page);assert.equal(f.state.snapshot.totp,false,page);
  }
});

test('the login and security pages do not add a redundant security link to the unavailable message',async()=>{
  for(const page of ['login','security']){
    const f=createSecurityFlow();f.navigate(page);
    if(page==='login')await f.startEmail('qa@example.invalid');else await f.refresh();
    assert.equal(f.state.error,'unavailable',page);
    const html=securityView(f.state,{locale:'en'}),feedback=html.slice(html.indexOf('id="as-feedback"'));
    assert.doesNotMatch(feedback,/Back to security/,page);
  }
});

const draft='?page=strategies&draft=existing-42';

test('a different signed-in identity does not keep the previous person\'s return address',async()=>{
  const direct=createSecurityFlow({snapshot:owner(A)});
  direct.navigate('verify',{returnTo:draft});assert.equal(direct.state.returnTo,draft);
  direct.setIdentity(owner(B));
  assert.equal(direct.state.returnTo,'?page=security');
  const read=createSecurityFlow({snapshot:owner(null,'first-owner@example.invalid'),request:async()=>({account:owner(null,'second-owner@example.invalid')})});
  read.navigate('verify',{returnTo:draft});
  assert.equal(await read.refresh(),true);
  assert.equal(read.state.snapshot.email,'second-owner@example.invalid');assert.equal(read.state.returnTo,'?page=security');
});

test('a plain sign-in and the same person signing in again keep the return address',()=>{
  const f=createSecurityFlow();
  f.navigate('login',{returnTo:draft});
  f.setIdentity(owner(A));assert.equal(f.state.returnTo,draft);
  f.setIdentity({...owner(A),totp:true});assert.equal(f.state.returnTo,draft);
  f.setIdentity(null);assert.equal(f.state.returnTo,draft);
  f.setIdentity(owner(A));assert.equal(f.state.returnTo,draft);
});

test('signing out and then in as a different person drops the previous return address',()=>{
  const f=createSecurityFlow({snapshot:owner(A)});
  f.navigate('verify',{returnTo:draft});
  f.setIdentity(null);f.setIdentity(owner(B));
  assert.equal(f.state.returnTo,'?page=security');
  f.navigate('security',{returnTo:draft});f.setIdentity(owner(B));
  assert.equal(f.state.returnTo,draft);
});
