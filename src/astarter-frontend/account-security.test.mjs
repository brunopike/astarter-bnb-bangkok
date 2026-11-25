import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurityFlow,securityView,SECURITY_PAGES} from './account-security.mjs';
import {normalizeOtp,safeAccountReturn,verificationPlan} from './account-security-policy.mjs';

const current=1_000_000;
const challenge=(method='email',purpose='login',id='fixture-only')=>({id,method,purpose,expiresAt:current+300000,resendAt:current+60000});
const enrolled=()=>({signedIn:true,wallet:null,email:'qa@example.invalid',totp:true,social:[],sessions:[]});

test('default adapter fails closed without sending email or claiming success',async()=>{
  const flow=createSecurityFlow();await flow.startEmail('qa@example.invalid');
  assert.equal(flow.state.error,'unavailable');assert.equal(flow.state.challenge,null);assert.equal(flow.state.success,false);
  assert.equal(flow.state.snapshot.signedIn,false);
});
test('email validation rejects malformed addresses before adapter invocation',async()=>{
  let calls=0;const flow=createSecurityFlow({request:async()=>calls++});
  for(const email of ['','x','a@','a @b.com','a@b','x'.repeat(255)+'@example.invalid'])await flow.startEmail(email);
  assert.equal(calls,0);assert.equal(flow.state.error,'invalid-email');
});
test('six digit normalization supports paste without accepting partial or non-numeric codes',()=>{
  assert.equal(normalizeOtp('001 234'),'001234');assert.equal(normalizeOtp('001-234'),'001234');
  for(const code of ['12345','1234567','12a456','<script>','１２３４５６'])assert.equal(normalizeOtp(code),null);
});
test('return URLs remain local and preserve the existing draft query',()=>{
  assert.equal(safeAccountReturn('?page=strategies&draft=existing-42'),'?page=strategies&draft=existing-42');
  for(const value of ['https://evil.invalid','//evil.invalid','?page=evil','javascript:alert(1)','?page=security\n'])assert.equal(safeAccountReturn(value),'?page=security');
});
test('email challenge is only displayed after a valid response',async()=>{
  const flow=createSecurityFlow({now:()=>current,request:async()=>({challenge:challenge()})});
  await flow.startEmail('qa@example.invalid');assert.equal(flow.state.step,'code');assert.equal(flow.state.success,false);
  assert.match(securityView(flow.state),/qa@example.invalid/);
});
test('wrong method, wrong purpose, expired and malformed challenges are rejected',async()=>{
  for(const c of [null,challenge('totp'),challenge('email','bind-email'),{...challenge(),expiresAt:current},{...challenge(),resendAt:null}]){
    const f=createSecurityFlow({now:()=>current,request:async()=>({challenge:c})});await f.startEmail('qa@example.invalid');
    assert.equal(f.state.error,'invalid-response');assert.equal(f.state.challenge,null);
  }
});
test('duplicate sends are coalesced and cannot change the pending identity',async()=>{
  let resolve,calls=0;const f=createSecurityFlow({now:()=>current,request:()=>{calls++;return new Promise(r=>resolve=r);}});
  const pending=f.startEmail('first@example.invalid');await f.startEmail('second@example.invalid');
  resolve({challenge:challenge()});await pending;
  assert.equal(calls,1);assert.equal(f.state.email,'first@example.invalid');
});
test('navigation and identity changes discard late responses',async()=>{
  for(const action of ['navigate','identity','cancel','dispose']){
    let resolve;const f=createSecurityFlow({now:()=>current,request:()=>new Promise(r=>resolve=r)});
    const pending=f.startEmail('qa@example.invalid');
    if(action==='navigate')f.navigate('account-social');else if(action==='identity')f.setIdentity(enrolled());else f[action]();
    resolve({challenge:challenge()});await pending;
    assert.equal(f.state.challenge,null);assert.equal(f.state.success,false);assert.equal(f.state.busy,false);
  }
});
test('resend respects server retry time and replaces the challenge',async()=>{
  let now=current,calls=0;const f=createSecurityFlow({now:()=>now,request:async()=>({challenge:{...challenge('email','login',String(++calls)),resendAt:now+60000,expiresAt:now+300000}})});
  await f.startEmail('qa@example.invalid');await f.startEmail('qa@example.invalid');assert.equal(calls,1);
  now+=60000;await f.startEmail('qa@example.invalid');assert.equal(calls,2);assert.equal(f.state.challenge.id,'2');
});
test('verification requires a matching receipt, not a truthy response',async()=>{
  for(const response of [{ok:true},{verified:true,challengeId:'other'},{verified:false,challengeId:'fixture-only'}]){
    const f=createSecurityFlow({now:()=>current,request:async action=>action==='email/start'?{challenge:challenge()}:response});
    await f.startEmail('qa@example.invalid');await f.verify('123456');assert.equal(f.state.success,false);assert.equal(f.state.error,'invalid-response');
  }
});
test('successful verification consumes local challenge and does not grant account or transaction authority',async()=>{
  let verifyCalls=0;const f=createSecurityFlow({now:()=>current,request:async action=>{
    if(action==='email/start')return {challenge:challenge()};verifyCalls++;return {verified:true,challengeId:'fixture-only'};
  }});
  await f.startEmail('qa@example.invalid');await f.verify('001234');
  assert.equal(f.state.success,true);assert.equal(f.state.snapshot.signedIn,false);assert.equal(f.state.challenge,null);
  await f.verify('001234');assert.equal(verifyCalls,1);
});
test('expired challenges cannot be submitted or accepted after a slow verification response',async()=>{
  let now=current,resolve;const f=createSecurityFlow({now:()=>now,request:async action=>action==='email/start'?{challenge:challenge()}:new Promise(r=>resolve=r)});
  await f.startEmail('qa@example.invalid');const pending=f.verify('123456');now+=300001;
  resolve({verified:true,challengeId:'fixture-only'});await pending;
  assert.equal(f.state.success,false);assert.equal(f.state.error,'expired');
});
test('server wrong code and throttling are visible and retain email context',async()=>{
  for(const message of ['wrong-code','throttled']){
    const f=createSecurityFlow({now:()=>current,request:async action=>{if(action==='email/start')return {challenge:challenge()};throw Error(message);}});
    await f.startEmail('qa@example.invalid');await f.verify('123456');assert.equal(f.state.error,message);assert.equal(f.state.email,'qa@example.invalid');
    assert.match(securityView(f.state),/role="alert"/);
  }
});
test('binding, TOTP and step-up operations require an authenticated identity',async()=>{
  let calls=0;const f=createSecurityFlow({request:async()=>calls++});f.navigate('email');
  await f.startEmail('qa@example.invalid');await f.beginTotp();await f.beginChallenge();await f.social('x');
  assert.equal(calls,0);assert.equal(f.state.error,'sign-in-required');
});
test('TOTP has no fake QR and refuses remote QR, malformed keys and untrusted responses',async()=>{
  assert.doesNotMatch(securityView({...createSecurityFlow().state,page:'two-factor'}),/otpauth:|123456|<img[^>]*qr/);
  const f=createSecurityFlow({snapshot:enrolled(),now:()=>current,request:async()=>({challenge:challenge('totp','enroll-totp'),qrDataUrl:'https://third-party.invalid/secret',manualKey:'ABCDEFGHIJKLMNOP'})});
  await f.beginTotp();assert.equal(f.state.enrollment,null);assert.equal(f.state.error,'invalid-response');
});
test('recovery codes require acknowledgment and are cleared on leave',async()=>{
  const f=createSecurityFlow({snapshot:enrolled(),now:()=>current,request:async action=>{
    if(action==='totp/enroll')return {challenge:challenge('totp','enroll-totp'),qrDataUrl:'data:image/png;base64,aGVsbG8=',manualKey:'ABCDEFGHIJKLMNOP'};
    if(action==='challenge/verify')return {verified:true,challengeId:'fixture-only',recoveryCodes:['TEST-ONLY-01','TEST-ONLY-02']};
    return {enabled:true};
  }});f.navigate('two-factor');await f.beginTotp();await f.verify('123456');
  assert.equal(f.state.step,'backup');assert.equal(await f.finishEnrollment(),false);
  f.setSaved(true);await f.finishEnrollment();assert.equal(f.state.codes.length,0);assert.equal(f.state.success,true);
  f.navigate('security');assert.equal(f.state.enrollment,null);assert.equal(f.state.success,false);
});
test('wallet connection callback cannot assert a signed-in session',async()=>{
  const f=createSecurityFlow({openWallet:async()=>({address:'0x'+'1'.repeat(40)})});await f.wallet();assert.equal(f.state.snapshot.signedIn,false);assert.equal(f.state.success,false);
});
test('last login method cannot be unlinked and social binding cannot self-confirm',async()=>{
  let calls=0;const f=createSecurityFlow({snapshot:{...enrolled(),social:[{provider:'google',lastLoginMethod:true}]},request:async()=>{calls++;return {status:'connected'};}});
  await f.social('google','unlink');assert.equal(calls,0);assert.equal(f.state.error,'last-login-method');
  await f.social('x');assert.equal(f.state.error,'invalid-response');assert.equal(f.state.snapshot.social.length,1);
});
test('recovering a code never disables MFA or resumes a sensitive action',async()=>{
  const f=createSecurityFlow({snapshot:enrolled(),request:async()=>({recoveryPending:true})});f.navigate('recovery');await f.recover('TEST-ONLY-01');
  assert.equal(f.state.step,'recovery-pending');assert.equal(f.state.snapshot.totp,true);
});
test('all page output escapes identities and has one semantic heading',()=>{
  const f=createSecurityFlow({snapshot:{...enrolled(),wallet:'<script>alert(1)</script>',email:'<img onerror=x>',social:[{provider:'x',label:'<script>x</script>'}],sessions:[{id:'" onmouseover="x',label:'<script>x</script>',lastSeenLabel:'now',current:false}]}});
  for(const page of SECURITY_PAGES){f.navigate(page);const html=securityView(f.state);assert.equal((html.match(/<h1[ >]/g)||[]).length,1);assert.doesNotMatch(html,/<script>|<img onerror/);}
});
test('UI is one real OTP input, numeric autocomplete, and no fixed valid code',()=>{
  const f=createSecurityFlow();f.navigate('verify');const html=securityView(f.state);
  assert.equal((html.match(/id="as-otp"/g)||[]).length,1);assert.match(html,/autocomplete="one-time-code"/);assert.match(html,/inputmode="numeric"/);assert.doesNotMatch(html,/123456/);
});
test('risk routing preserves protective actions, blocks unknowns, and requires strong verification',()=>{
  assert.equal(verificationPlan('browse').screen,'continue');assert.equal(verificationPlan('purchase').screen,'login');
  assert.equal(verificationPlan('purchase',{signedIn:true}).screen,'confirm');
  assert.equal(verificationPlan('purchase',{signedIn:true,totp:true,risk:'new-device'}).screen,'verify');
  for(const action of ['pause-new-orders','revoke-trading','sign-out'])assert.equal(verificationPlan(action,{signedIn:true,risk:'new-device'}).screen,'confirm');
  for(const action of ['disable-2fa','change-email','link-wallet','start-live-trading','increase-budget']){
    assert.equal(verificationPlan(action,{signedIn:true}).screen,'two-factor');
    assert.equal(verificationPlan(action,{signedIn:true,totp:true}).screen,'verify');
  }
  assert.equal(verificationPlan('unknown',{signedIn:true}).screen,'blocked');
  assert.equal(verificationPlan('unlink-wallet',{signedIn:true,totp:true,lastLoginMethod:true}).reason,'last-login-method');
});
test('account social route does not overwrite the existing market social route',()=>{
  assert.ok(SECURITY_PAGES.includes('account-social'));assert.ok(!SECURITY_PAGES.includes('social'));
  assert.match(securityView({...createSecurityFlow().state,page:'security'}),/page=account-social/);
});
test('enrollment acknowledgment and session revocation cannot skip their prerequisites',async()=>{
  let calls=0;const f=createSecurityFlow({request:async()=>{calls++;return {enabled:true,revoked:true};}});
  f.setSaved(true);assert.equal(await f.finishEnrollment(),false);await f.revokeSession('unowned');assert.equal(calls,0);
  f.setIdentity({...enrolled(),sessions:[{id:'current',label:'This test device',lastSeenLabel:'Now',current:true}]});await f.revokeSession('current');assert.equal(calls,0);
});


test('email challenge descriptions escape the submitted identity',async()=>{
  const f=createSecurityFlow({now:()=>current,request:async()=>({challenge:challenge()})});
  await f.startEmail('<svg/onload=alert(1)>@example.invalid');
  assert.equal(f.state.step,'code');
  for(const locale of ['zh','en']){
    const html=securityView(f.state,{locale});
    assert.doesNotMatch(html,/<svg\/onload/);assert.match(html,/&lt;svg\/onload/);
  }
});
test('invalid repeated verification cannot release the active request lock',async()=>{
  let resolve,calls=0;
  const f=createSecurityFlow({now:()=>current,request:async action=>{
    if(action==='email/start')return {challenge:challenge()};
    calls++;return new Promise(r=>resolve=r);
  }});
  await f.startEmail('qa@example.invalid');const pending=f.verify('001234');
  await f.verify('bad');await f.recover('bad');await f.beginTotp();
  assert.equal(f.state.busy,true);assert.equal(f.state.error,'');assert.equal(calls,1);
  resolve({verified:true,challengeId:'fixture-only'});await pending;
  assert.equal(f.state.success,true);assert.equal(f.state.busy,false);
});


test('malformed account responses cannot replace the current identity',async()=>{
  for(const patch of [{social:{}},{sessions:[null]},{totp:'true'},{email:{value:'unsafe'}},{sessions:[{id:'a',label:'device',lastSeenLabel:'now',current:'true'}]}]){
    const f=createSecurityFlow({snapshot:enrolled(),request:async()=>({account:{...enrolled(),...patch}})});
    await f.refresh();assert.equal(f.state.error,'invalid-response');assert.equal(f.state.snapshot.email,'qa@example.invalid');assert.deepEqual(f.state.snapshot.sessions,[]);
  }
});


test('login keeps its decorative spectrum outside text and uses monochrome VI assets',()=>{
  const html=securityView(createSecurityFlow().state);
  assert.doesNotMatch(html,/astarter-icon-gradient-primary/);
  assert.match(html,/account-mark-light\.svg/);assert.match(html,/account-mark-dark\.svg/);
  assert.match(html,/<svg class="as-paths"[^>]*aria-hidden="true"/);
  assert.match(html,/<g class="as-paths-thread">/);
  assert.match(html,/<h2>从研究到执行<br>始终由你掌控<\/h2>/);
});
