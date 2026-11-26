// Native adaptation of Efferd Auth Page, uvain OTP Input and Ahmed Mayara Enable 2FA Card.
// See the task's integration and verification guide for source URLs and service boundaries.
import {normalizeOtp,safeAccountReturn} from './account-security-policy.mjs';

export const SECURITY_PAGES=['login','security','account-social','email','two-factor','verify','recovery','sessions'];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unavailable=async()=>{throw Error('unavailable');};
const initialSnapshot=()=>({signedIn:false,email:null,wallet:null,totp:false,social:[],sessions:[]});
function checkedSnapshot(value) {
  if(!value||typeof value.signedIn!=='boolean')throw Error('invalid-response');
  const account={...initialSnapshot(),...value};
  if(typeof account.totp!=='boolean'||!['email','wallet'].every(key=>account[key]===null||typeof account[key]==='string')||
    !Array.isArray(account.social)||!account.social.every(s=>s&&['google','x','discord','telegram'].includes(s.provider)&&(s.label===undefined||typeof s.label==='string')&&(s.lastLoginMethod===undefined||typeof s.lastLoginMethod==='boolean'))||
    !Array.isArray(account.sessions)||!account.sessions.every(s=>s&&['id','label','lastSeenLabel'].every(key=>typeof s[key]==='string')&&typeof s.current==='boolean'))throw Error('invalid-response');
  return account;
}
const errors={
  unavailable:['此服务暂未开放，请稍后重试。','This service is not available yet. Please try again later.'],
  'wallet-unavailable':['请从主站的钱包入口连接并签名登录。','Connect and sign in using the wallet entry on the main site.'],
  'invalid-code':['请输入完整的 6 位数字验证码。','Enter the complete 6-digit verification code.'],
  'wrong-code':['验证码不正确，请检查后重试。','That code is incorrect. Check it and try again.'],
  expired:['验证已过期，请重新开始。','Verification expired. Please start again.'],
  throttled:['尝试次数过多，请稍后再试。','Too many attempts. Please try again later.'],
  'invalid-response':['暂时无法确认结果，请重新读取账户状态。','We could not confirm the result. Refresh your account status.'],
  'sign-in-required':['请先登录，再管理账户安全。','Sign in before managing account security.'],
  conflict:['这个账号已关联其他账户，请换一个账号。','This identity belongs to another account. Use a different one.'],
  'last-login-method':['请先添加另一种登录方式，再解除绑定。','Add another sign-in method before removing this one.'],
  cancelled:['授权已取消，你的账户设置未变更。','Authorization cancelled. Your account settings are unchanged.'],
  'invalid-email':['请输入有效的邮箱地址。','Enter a valid email address.'],
};

export function createSecurityFlow({request=unavailable,openWallet=unavailable,now=Date.now,onChange=()=>{},snapshot=initialSnapshot()}={}) {
  let state={page:'login',step:'start',email:'',code:'',challenge:null,enrollment:null,codes:[],saved:false,busy:false,error:'',success:false,snapshot:checkedSnapshot(snapshot),returnTo:'?page=security'};
  let version=0,lastSignedIn=state.snapshot.signedIn?state.snapshot:null;
  const publish=patch=>{state={...state,...patch};onChange(state);};
  const error=key=>publish({error:errors[key]?key:'unavailable',busy:false});
  async function run(action,payload,accept) {
    if(state.busy)return false;
    const current=++version;publish({busy:true,error:''});
    try {
      const result=await request(action,payload);
      if(current!==version)return false;
      accept(result);publish({busy:false});return true;
    } catch(e) {if(current===version)error(e.message);return false;}
  }
  const validChallenge=(data,method,purpose)=>{
    const c=data?.challenge;
    if(!c || typeof c.id!=='string' || !c.id || c.method!==method || c.purpose!==purpose || !Number.isFinite(c.expiresAt) || c.expiresAt<=now() || !Number.isFinite(c.resendAt))throw Error('invalid-response');
    return c;
  };
  function navigate(page,{returnTo=state.returnTo}={}) {
    ++version;
    // Never persist codes, enrollment material or verification receipts across routes.
    publish({page:SECURITY_PAGES.includes(page)?page:'security',step:'start',challenge:null,enrollment:null,codes:[],saved:false,code:'',error:'',success:false,busy:false,returnTo:safeAccountReturn(returnTo)});
  }
  function setIdentity(next) {
    const snapshot=checkedSnapshot(next||initialSnapshot()),prior=state.snapshot;
    // A different signed-in identity must not inherit the previous person's typed email.
    const switched=prior.signedIn!==snapshot.signedIn||prior.wallet!==snapshot.wallet||prior.email!==snapshot.email;
    // A return address can name the last signed-in person's draft: another signed-in person drops it, a plain sign-in or the same person again keeps it.
    const replaced=snapshot.signedIn&&lastSignedIn&&(lastSignedIn.wallet!==snapshot.wallet||lastSignedIn.email!==snapshot.email);
    if(snapshot.signedIn)lastSignedIn=snapshot;
    ++version;
    publish({snapshot,challenge:null,enrollment:null,codes:[],saved:false,success:false,busy:false,code:'',step:'start',error:'',...(switched?{email:''}:{}),...(replaced?{returnTo:'?page=security'}:{})});
  }
  async function startEmail(email) {
    if(state.busy)return false;
    const value=String(email??'').trim();
    publish({email:value});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)||value.length>254){error('invalid-email');return false;}
    const purpose=state.page==='login'?'login':'bind-email';
    if(purpose!=='login'&&!state.snapshot.signedIn){error('sign-in-required');return false;}
    if(state.challenge&&now()<state.challenge.resendAt)return false;
    return run('email/start',{email:value,purpose},data=>publish({challenge:validChallenge(data,'email',purpose),step:'code',code:'',success:false}));
  }
  async function verify(value) {
    if(state.busy)return false;
    const code=normalizeOtp(value);if(!code){error('invalid-code');return false;}
    const c=state.challenge;
    if(!c||c.expiresAt<=now()){error('expired');return false;}
    return run('challenge/verify',{challengeId:c.id,code},data=>{
      if(c.expiresAt<=now())throw Error('expired');
      if(data?.verified!==true||data.challengeId!==c.id)throw Error('invalid-response');
      if(c.purpose==='enroll-totp'){
        if(!Array.isArray(data.recoveryCodes)||!data.recoveryCodes.length||!data.recoveryCodes.every(x=>typeof x==='string'&&/^[A-Za-z0-9-]{8,32}$/.test(x)))throw Error('invalid-response');
        publish({codes:data.recoveryCodes,enrollment:null,challenge:null,code:'',step:'backup'});
      } else publish({success:true,code:'',challenge:null,step:'complete'});
    });
  }
  async function beginTotp() {
    if(state.busy)return false;
    if(!state.snapshot.signedIn){error('sign-in-required');return false;}
    return run('totp/enroll',{},data=>{
      const challenge=validChallenge(data,'totp','enroll-totp');
      if(typeof data.qrDataUrl!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrDataUrl)||data.qrDataUrl.length>100000)throw Error('invalid-response');
      if(typeof data.manualKey!=='string'||!/^[A-Z2-7]{16,64}$/.test(data.manualKey))throw Error('invalid-response');
      publish({enrollment:{qrDataUrl:data.qrDataUrl,manualKey:data.manualKey},challenge,step:'code'});
    });
  }
  async function beginChallenge() {
    if(state.busy)return false;
    if(!state.snapshot.signedIn){error('sign-in-required');return false;}
    return run('challenge/start',{purpose:'reauth',method:'totp'},data=>publish({challenge:validChallenge(data,'totp','reauth'),step:'code'}));
  }
  async function recover(value) {
    if(state.busy)return false;
    const code=String(value??'').trim();
    if(!/^[A-Za-z0-9-]{8,32}$/.test(code)){error('wrong-code');return false;}
    return run('recovery/verify',{code},data=>{
      // Recovery never toggles 2FA off or resumes a protected action in the client.
      if(data?.recoveryPending!==true)throw Error('invalid-response');
      publish({success:true,step:'recovery-pending'});
    });
  }
  async function social(provider,operation='link') {
    if(state.busy)return false;
    if(!['google','x','discord','telegram'].includes(provider)||!['link','unlink'].includes(operation))return false;
    if(!state.snapshot.signedIn){error('sign-in-required');return false;}
    if(operation==='unlink'&&state.snapshot.social?.find(x=>x.provider===provider)?.lastLoginMethod){error('last-login-method');return false;}
    return run('social/'+operation,{provider},data=>{
      // OAuth redirects and binding commits belong to the trusted host adapter, never to URL input.
      if(data?.status!=='pending')throw Error('invalid-response');
      publish({step:'social-pending'});
    });
  }
  async function wallet() {
    if(state.busy)return false;
    const current=++version;publish({busy:true,error:''});
    try {await openWallet();if(current===version)publish({busy:false});return true;}
    catch {if(current===version)error('wallet-unavailable');return false;}
  }
  return {
    get state(){return state;},navigate,setIdentity,startEmail,verify,beginTotp,beginChallenge,recover,social,wallet,
    setCode(value){state={...state,code:String(value)};},
    setEmail(value){state={...state,email:String(value)};},
    setSaved(value){state={...state,saved:Boolean(value)};},
    refresh:()=>run('account/read',{},data=>{if(typeof data?.account?.signedIn!=='boolean')throw Error('invalid-response');setIdentity(data.account);}),
    google:()=>run('login/google',{},data=>{if(data?.status!=='pending')throw Error('invalid-response');publish({step:'social-pending'});}),
    finishEnrollment:()=>Boolean(state.saved&&state.step==='backup'&&state.codes.length)&&run('totp/acknowledge-recovery',{},data=>{if(data?.enabled!==true)throw Error('invalid-response');publish({codes:[],step:'complete',success:true,snapshot:{...state.snapshot,totp:true}});}),
    revokeSession:id=>{
      if(state.busy)return false;
      if(!state.snapshot.signedIn){error('sign-in-required');return false;}
      const session=state.snapshot.sessions?.find(x=>x.id===id);
      if(!session||session.current)return false;
      return run('sessions/revoke',{id},data=>{if(data?.revoked!==true)throw Error('invalid-response');publish({snapshot:{...state.snapshot,sessions:state.snapshot.sessions.filter(x=>x.id!==id)}});});
    },
    cancel(){++version;publish({challenge:null,enrollment:null,codes:[],code:'',saved:false,busy:false,step:'start',success:false,error:''});},
    dispose(){++version;state={...state,challenge:null,enrollment:null,codes:[],code:'',busy:false};},
  };
}

// Reuse the product's existing line-icon geometry without importing its trading/scene dependency graph.
const glyphs={back:'<path d="M19 12H5m6-6-6 6 6 6"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',shield:'<path d="M12 2l8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5z"/><path d="M8 12l3 3 5-6"/>',wallet:'<path d="M20 8V5H5a3 3 0 0 0 0 6h15v10H3V8m17 4h-6v5h6m-3-2.5h.1"/>',email:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',key:'<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m-6 0 3-3"/>',device:'<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]||glyphs.shield}</svg>`;
const brand=()=>'<span class="as-brand"><span class="as-brand-mark" aria-hidden="true"><img class="as-mark-on-dark" src="/brand/account-mark-light.svg" width="43" height="24" alt=""><img class="as-mark-on-light" src="/brand/account-mark-dark.svg" width="43" height="24" alt=""></span><span>Astarter</span></span>';

export function securityView(state,{locale='zh',now=Date.now()}={}) {
  const L=(zh,en)=>locale.startsWith('zh')?zh:en;
  let controlIndex=0;
  const button=(label,action,{primary=false,disabled=false,extra=''}={})=>`<button id="as-action-${action}-${controlIndex++}" type="button" class="as-button${primary?' as-primary':''}" data-security-action="${action}" ${state.busy||disabled?'disabled':''} ${extra}>${label}</button>`;
  const link=(page,label,cls='')=>`<a class="as-link ${cls}" href="?page=${page}" data-security-page="${page}">${label}</a>`;
  const feedback=()=>`<div id="as-feedback" class="as-feedback" role="${state.error?'alert':'status'}" aria-live="polite">${state.error?esc(L(...(errors[state.error]||errors.unavailable)))+(state.error==='sign-in-required'?link('login',L('前往登录','Sign in')):state.error==='unavailable'&&!['login','security'].includes(state.page)?link('security',L('返回安全中心','Back to security')):''):state.busy?L('正在处理…','Working…'):state.step==='social-pending'?L('请在授权窗口继续，完成后刷新状态。','Continue in the authorization window, then refresh your status.'):''}</div>`;
  const otp=()=>`<label class="as-label" for="as-otp">${L('6 位验证码','6-digit code')}</label><div class="as-otp" data-otp-group><input id="as-otp" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" aria-describedby="as-code-hint as-feedback" ${['invalid-code','wrong-code','expired'].includes(state.error)?'aria-invalid="true"':''} value="${esc(state.code)}" ${state.busy||!state.challenge?'disabled':''} required><div class="as-otp-slots" aria-hidden="true">${Array.from({length:6},(_,i)=>`<span ${i===3?'class="as-otp-split"':''}>${esc(state.code[i]||'')}</span>`).join('')}</div></div><p class="as-hint" id="as-code-hint">${L('支持粘贴完整验证码','You can paste the full code')}</p>`;
  const codeForm=()=>`<form data-security-form="verify">${otp()}<button id="as-verify-submit" class="as-button as-primary as-wide" type="submit" ${state.busy||!state.challenge||state.challenge.expiresAt<=now?'disabled':''}>${L('验证并继续','Verify and continue')}</button></form>`;
  const back=(page='security')=>link(page,icon('back')+L('返回','Back'),'as-back');
  const complete=()=>`<div class="as-complete"><span class="as-success-icon">${icon('check')}</span><h1 tabindex="-1">${state.page==='two-factor'?L('两步验证已开启','Two-step verification enabled'):L('验证已完成','Verification complete')}</h1><p>${L('返回原页面，确认后再继续操作。','Return to your previous page and confirm before continuing.')}</p>${button(L('返回并继续','Return and continue'),'return',{primary:true})}</div>`;
  const title=(heading,description)=>`<header class="as-heading"><h1 tabindex="-1">${heading}</h1><p>${esc(description)}</p></header>`;
  const nav=`<nav class="as-nav" aria-label="${L('账户安全','Account security')}">${[['security','安全中心','Security'],['account-social','社媒绑定','Accounts'],['sessions','设备与会话','Devices']].map(([id,zh,en])=>`<a href="?page=${id}" data-security-page="${id}" aria-current="${state.page===id?'page':'false'}">${L(zh,en)}</a>`).join('')}</nav>`;
  const account=state.snapshot;
  const emailForm=()=>`<form data-security-form="email"><label class="as-label" for="as-email">${L('邮箱地址','Email address')}</label><div class="as-input-icon">${icon('email')}<input id="as-email" name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com" value="${esc(state.email)}" required ${state.busy?'disabled':''}></div><button id="as-email-submit" type="submit" class="as-button as-primary as-wide" ${state.busy?'disabled':''}>${L('使用邮箱继续','Continue with email')}${icon('arrow')}</button></form>`;
  const emailCode=()=>`<span class="as-feature-icon">${icon('email')}</span>${title(L('查看你的邮箱','Check your email'),L('请输入发送至 '+state.email+' 的验证码','Enter the code sent to '+state.email))}${codeForm()}<div class="as-inline-actions">${button(L('修改邮箱','Change email'),'cancel')}${button(L('重新发送','Resend code'),'resend',{disabled:now<(state.challenge?.resendAt||0),extra:'data-resend'})}</div><p class="as-hint" data-resend-hint>${now<(state.challenge?.resendAt||0)?L(Math.ceil((state.challenge.resendAt-now)/1000)+' 秒后可重新发送','Resend in '+Math.ceil((state.challenge.resendAt-now)/1000)+'s'):''}</p>`;
  let body='';
  if(state.page==='login') {
    const paths=[1,-1].flatMap(position=>Array.from({length:18},(_,i)=>{const n=i*2;return `<path d="M-${380-n*5*position} -${189+n*6}C-${380-n*5*position} -${189+n*6} -${312-n*5*position} ${216-n*6} ${152-n*5*position} ${343-n*6}C${616-n*5*position} ${470-n*6} ${684-n*5*position} ${875-n*6} ${684-n*5*position} ${875-n*6}"/>`;})).join('');
    const spectrum=['#ff4b3e','#ff9a2b','#ffd84d','#4dff7a','#3dd5ff','#4a6bff','#a24dff'];
    const artwork=`<svg class="as-paths" viewBox="0 0 696 900" fill="none" aria-hidden="true"><defs><linearGradient id="as-auth-spectrum" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="696" y2="0">${spectrum.map((color,i)=>`<stop offset="${i/6}" stop-color="var(--ast-spectrum-${i+1},${color})"/>`).join('')}</linearGradient></defs><g class="as-paths-halo">${paths}</g><g class="as-paths-thread">${paths}</g></svg>`;
    body=`<div class="as-auth"><aside class="as-auth-art">${brand()}${artwork}<div class="as-auth-story"><h2>${L('从研究到执行<br>始终由你掌控','From research to execution.<br>You stay in control.')}</h2><p>${L('在一个账户里，管理你的策略、连接与安全','Your strategies, connections and security, in one account')}</p></div></aside><section class="as-auth-form">${link('security',icon('back')+L('账户中心','Account center'),'as-back')}<div class="as-auth-content">${state.success?complete():state.step==='code'?emailCode():`<div class="as-mobile-brand">${brand()}</div>${title(L('登录或创建账户','Sign in or create an account'),L('欢迎来到 Astarter','Welcome to Astarter'))}${button(icon('wallet')+L('使用钱包继续','Continue with wallet'),'wallet',{primary:true})}<p class="as-wallet-note">${L('仅验证钱包归属，不授权交易或转账','Verifies wallet ownership. No trading or transfer approval.')}</p>${button('<span class="as-google" aria-hidden="true">G</span>'+L('使用 Google 继续','Continue with Google'),'google')}<div class="as-divider"><span>${L('或使用邮箱','or with email')}</span></div>${emailForm()}<p class="as-hint as-auth-note">${L('首次验证后创建账户，无需设置密码','Your first verification creates an account. No password needed.')}</p>`}${feedback()}</div></section></div>`;
  } else if(state.page==='security') {
    const rows=[['wallet',L('登录钱包','Sign-in wallet'),account.wallet||L('连接钱包并完成签名验证','Connect your wallet and verify ownership'),L('管理钱包','Manage wallet'),'wallet'],['email',L('安全邮箱','Security email'),account.email||L('接收安全提醒与账户验证邮件','Receive security alerts and verification emails'),L('绑定邮箱','Link email'),'email'],['phone',L('验证器 App','Authenticator app'),L('使用动态验证码保护敏感操作','Protect sensitive actions with time-based codes'),L('设置两步验证','Set up 2FA'),'two-factor']];
    body=`${nav}${title(L('安全中心','Security'),L('管理登录方式，为重要操作增加一道验证','Manage sign-in methods and protect important actions'))}<section class="as-security-summary"><span class="as-feature-icon">${icon('shield')}</span><div><h2>${account.signedIn?L('保护你的账户','Protect your account'):L('从安全登录开始','Start with a secure sign-in')}</h2><p>${account.signedIn?L('建议绑定安全邮箱，并开启验证器','Add a security email and an authenticator'):L('登录后查看并管理你的安全设置','Sign in to view and manage your security settings')}</p></div>${link(account.signedIn?'sessions':'login',account.signedIn?L('查看设备','Review devices'):L('登录 / 注册','Sign in / Join'),'as-button')}</section><section class="as-section"><h2>${L('登录与验证','Sign-in & verification')}</h2>${rows.map(([glyph,name,desc,action,page])=>`<div class="as-setting-row"><span class="as-row-icon">${icon(glyph)}</span><div><h3>${name}</h3><p>${esc(desc)}</p></div><span class="as-status">${account.signedIn?(glyph==='phone'&&account.totp||glyph==='email'&&account.email||glyph==='wallet'&&account.wallet?L('已设置','Set up'):L('未设置','Not set up')):L('登录后查看','Sign in to view')}</span>${page==='wallet'?button(action,'wallet'):link(page,action,'as-button')}</div>`).join('')}</section><section class="as-section"><h2>${L('账户管理','Account management')}</h2><div class="as-shortcuts">${link('account-social',`<span>${L('社媒绑定','Connected accounts')}<small>${L('管理 Google、X、Discord 与 Telegram','Manage Google, X, Discord and Telegram')}</small></span>${icon('arrow')}`)}${link('sessions',`<span>${L('设备与会话','Devices & sessions')}<small>${L('查看并退出其他登录设备','Review and sign out other devices')}</small></span>${icon('arrow')}`)}${link('recovery',`<span>${L('账户恢复','Account recovery')}<small>${L('无法使用验证器时找回访问权限','Recover access without your authenticator')}</small></span>${icon('arrow')}`)}</div></section>${feedback()}`;
  } else if(state.page==='account-social') {
    body=`${nav}${title(L('社媒绑定','Connected accounts'),L('关联你的账号，统一管理登录与社区身份','Manage your sign-in and community identities'))}<div class="as-context-note">${icon('shield')}<p>${L('Google 可用于登录；X、Discord、Telegram 用于社区身份，不替代安全验证。','Google can be used to sign in. X, Discord and Telegram are community identities, not security factors.')}</p></div><section class="as-section">${[['google','Google','G'],['x','X','X'],['discord','Discord','D'],['telegram','Telegram','T']].map(([id,name,mark])=>{const bound=account.social?.find(x=>x.provider===id);return `<div class="as-setting-row"><span class="as-provider-mark" aria-hidden="true">${mark}</span><div><h3>${name}</h3><p>${bound?esc(bound.label):id==='google'?L('登录方式','Sign-in method'):L('社区身份','Community identity')}</p></div><span class="as-status">${account.signedIn?(bound?L('已绑定','Connected'):L('未绑定','Not connected')):L('登录后查看','Sign in to view')}</span>${button(bound?L('解除绑定','Disconnect'):L('绑定账号','Connect'),'social',{extra:`data-provider="${id}" data-operation="${bound?'unlink':'link'}"`})}</div>`;}).join('')}</section><p class="as-hint">${L('绑定只申请必要的身份信息，不自动关注、发帖或加入社区。','Linking requests identity access only. It does not post, follow or join communities.')}</p>${button(L('刷新绑定状态','Refresh connection status'),'refresh')}${feedback()}`;
  } else if(state.page==='sessions') {
    body=`${nav}${title(L('设备与会话','Devices & sessions'),L('检查账户访问，退出不再使用的设备','Review account access and sign out devices you no longer use'))}<section class="as-section">${account.signedIn&&account.sessions?.length?account.sessions.map(s=>`<div class="as-setting-row"><span class="as-row-icon">${icon('device')}</span><div><h3>${esc(s.label)}</h3><p>${esc(s.lastSeenLabel)}</p></div><span class="as-status">${s.current?L('当前会话','Current session'):''}</span>${s.current?'':button(L('退出登录','Sign out'),'revoke-session',{extra:`data-session-id="${esc(s.id)}"`})}</div>`).join(''):`<div class="as-empty">${icon('device')}<h2>${account.signedIn?L('暂无可显示的会话','No sessions to display'):L('登录后查看设备','Sign in to view your devices')}</h2><p>${L('这里只显示服务器确认的登录会话','Only server-confirmed sessions appear here')}</p>${link('login',L('前往登录','Go to sign in'),'as-button')}</div>`}</section>${button(L('刷新会话','Refresh sessions'),'refresh')}${feedback()}`;
  } else {
    body=`<div class="as-flow-wrap">${back()}<section class="as-flow-card">`;
    if(state.success&&state.step!=='recovery-pending')body+=complete();
    else if(state.page==='email')body+=state.step==='code'?emailCode():`<span class="as-feature-icon">${icon('email')}</span>${title(L('绑定安全邮箱','Link a security email'),L('用于账户验证和接收安全提醒','For account verification and security alerts'))}${emailForm()}<p class="as-hint">${L('更换邮箱时，需先验证原登录方式，再验证新邮箱。','Changing an email requires your existing sign-in method and verification of the new email.')}</p>`;
    else if(state.page==='two-factor') {
      if(state.step==='backup')body+=`${title(L('保存恢复码','Save your recovery codes'),L('无法使用验证器时，每个恢复码只能使用一次','Each code can be used once if you lose access to your authenticator'))}<div class="as-recovery-codes">${state.codes.map(c=>`<code>${esc(c)}</code>`).join('')}</div><label class="as-checkbox"><input type="checkbox" data-backup-saved ${state.busy?'disabled':''} ${state.saved?'checked':''}>${L('我已将恢复码保存在安全的位置','I have stored these codes somewhere safe')}</label>${button(L('完成设置','Finish setup'),'finish-enrollment',{primary:true,disabled:!state.saved})}`;
      else body+=`<span class="as-feature-icon">${icon('shield')}</span>${title(L('开启两步验证','Enable 2FA'),L('登录验证之外，再用验证器保护重要操作','Add an authenticator for important account actions'))}<ol class="as-steps"><li><span class="as-step-number">1</span><div><h2>${L('准备验证器','Get an authenticator')}</h2><p>${L('打开 Google Authenticator、1Password 或其他兼容验证器','Use Google Authenticator, 1Password or a compatible app')}</p></div></li><li><span class="as-step-number">2</span><div><h2>${L('扫描绑定二维码','Scan your setup QR code')}</h2><p>${L('在验证器中添加 Astarter 账户','Add your Astarter account in the app')}</p>${state.enrollment?`<div class="as-qr"><img src="${esc(state.enrollment.qrDataUrl)}" width="160" height="160" alt="${L('验证器绑定二维码','Authenticator setup QR code')}"></div><details><summary>${L('无法扫码？使用设置密钥','Cannot scan? Use the setup key')}</summary><code class="as-manual-key">${esc(state.enrollment.manualKey)}</code></details>`:`<div class="as-qr-placeholder">${icon('phone')}<span>${L('准备好后获取专属二维码','Get your setup code when you are ready')}</span>${button(L('获取绑定二维码','Get setup QR code'),'begin-totp')}</div>`}</div></li><li><span class="as-step-number">3</span><div><h2>${L('输入动态验证码','Enter the current code')}</h2><p>${L('验证通过后，保存一次性恢复码','After verification, save your recovery codes')}</p>${codeForm()}</div></li></ol>`;
    } else if(state.page==='verify')body+=`<span class="as-feature-icon">${icon('shield')}</span>${title(L('确认是你本人','Confirm it is you'),L('重要操作前，请输入验证器的动态验证码','Enter your authenticator code before continuing'))}${!state.challenge?button(L('开始安全验证','Start verification'),'begin-challenge'):''}${codeForm()}${link('recovery',L('无法使用验证器','Cannot use your authenticator'))}`;
    else if(state.page==='recovery')body+=state.step==='recovery-pending'?`${title(L('恢复申请已受理','Recovery request received'),L('完成后续核验前，敏感操作保持关闭','Sensitive actions remain unavailable until recovery checks are complete'))}${link('security',L('返回安全中心','Back to security'),'as-button')}`:`<span class="as-feature-icon">${icon('key')}</span>${title(L('使用恢复码','Use a recovery code'),L('输入启用两步验证时保存的一个恢复码','Enter a recovery code saved when you enabled two-step verification'))}<form data-security-form="recovery"><label class="as-label" for="as-recovery">${L('恢复码','Recovery code')}</label><input id="as-recovery" name="recovery" type="text" autocomplete="off" spellcheck="false" minlength="8" maxlength="32" required><button class="as-button as-primary as-wide" type="submit" ${state.busy?'disabled':''}>${L('验证恢复码','Verify recovery code')}</button></form><details class="as-recovery-help"><summary>${L('恢复码也无法使用','I cannot use a recovery code')}</summary><p>${L('使用仍可访问的原登录方式进入账户恢复流程。邮箱验证码或社媒绑定不能直接关闭两步验证。','Use an existing sign-in method to begin account recovery. Email codes and social connections cannot directly disable two-step verification.')}</p>${link('login',L('返回登录','Back to sign in'))}</details>`;
    body+=feedback()+'</section></div>';
  }
  return `<div class="account-security" data-localized-ui data-security-page-view="${state.page}">${body}</div>`;
}

export function mountAccountSecurity(root,{navigate,openWallet,request,getLocale=()=>root.ownerDocument.documentElement.lang||'zh',now=Date.now}={}) {
  const doc=root.ownerDocument;
  let disposed=false,lastPage=null,focusId='';
  const render=()=>{
    if(disposed)return;
    const samePage=lastPage===flow.state.page,active=doc.activeElement;
    if(!samePage)focusId='';
    else if(root.contains(active)&&active.id)focusId=active.id;
    root.innerHTML=securityView(flow.state,{locale:getLocale(),now:now()});
    lastPage=flow.state.page;
    if(focusId){const field=doc.getElementById(focusId);if(root.contains(field)&&!field.disabled)field.focus({preventScroll:true});}
  };
  const flow=createSecurityFlow({request,openWallet,now,onChange:render});
  const focus=()=>root.querySelector('h1')?.focus({preventScroll:true});
  const changePage=(page)=>{const returnTo=page==='login'&&flow.state.page!=='login'?'?page='+flow.state.page:flow.state.returnTo;flow.navigate(page,{returnTo});navigate?.(page);focus();};
  const click=async event=>{
    const target=event.target.closest?.('[data-security-page],[data-security-action]');if(!target||!root.contains(target)||target.disabled)return;
    if(target.dataset.securityPage){if(event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();changePage(target.dataset.securityPage);return;}
    const action=target.dataset.securityAction;
    if(action==='wallet')await flow.wallet();
    else if(action==='google')await flow.google();
    else if(action==='cancel'){flow.cancel();root.querySelector('#as-email')?.focus();}
    else if(action==='resend')await flow.startEmail(flow.state.email);
    else if(action==='begin-totp')await flow.beginTotp();
    else if(action==='begin-challenge')await flow.beginChallenge();
    else if(action==='refresh')await flow.refresh();
    else if(action==='finish-enrollment')await flow.finishEnrollment();
    else if(action==='social')await flow.social(target.dataset.provider,target.dataset.operation);
    else if(action==='revoke-session')await flow.revokeSession(target.dataset.sessionId);
    else if(action==='return'){
      const returnTo=flow.state.returnTo,next=new URLSearchParams(returnTo).get('page');
      flow.cancel();
      if(navigate)navigate(next,{returnTo});else changePage(SECURITY_PAGES.includes(next)?next:'security');
    }
    const field=root.querySelector('[aria-invalid=true]');if(field)field.focus();
  };
  const submit=async event=>{
    const form=event.target.closest?.('[data-security-form]');if(!form)return;event.preventDefault();
    const data=new FormData(form),kind=form.dataset.securityForm;
    if(kind==='email')await flow.startEmail(data.get('email'));
    else if(kind==='verify')await flow.verify(data.get('code'));
    else if(kind==='recovery')await flow.recover(data.get('recovery'));
    root.querySelector('[aria-invalid=true],#as-otp')?.focus();
  };
  const input=event=>{
    if(event.target.id==='as-email')flow.setEmail(event.target.value);
    if(event.target.id==='as-otp'){
      flow.setCode(event.target.value);
      root.querySelectorAll('.as-otp-slots>span').forEach((s,i)=>{s.textContent=event.target.value[i]||'';});
    }
    if(event.target.matches('[data-backup-saved]')){flow.setSaved(event.target.checked);root.querySelector('[data-security-action="finish-enrollment"]').disabled=!event.target.checked;}
  };
  const paste=event=>{
    if(event.target.id!=='as-otp')return;
    const code=normalizeOtp(event.clipboardData.getData('text'));
    if(code){event.preventDefault();event.target.value=code;input(event);}
  };
  const tick=setInterval(()=>{
    const c=flow.state.challenge;if(!c)return;
    const button=root.querySelector('[data-resend]'),hint=root.querySelector('[data-resend-hint]');
    if(button)button.disabled=flow.state.busy||now()<c.resendAt;
    if(hint){const secs=Math.max(0,Math.ceil((c.resendAt-now())/1000));hint.textContent=secs?(getLocale().startsWith('zh')?`${secs} 秒后可重新发送`:`Resend in ${secs}s`):'';}
    if(now()>=c.expiresAt)root.querySelector('[data-security-form="verify"] button')?.setAttribute('disabled','');
  },1000);
  root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',input);root.addEventListener('paste',paste);
  return {flow,render,show:(page,options)=>{flow.navigate(page,options);},destroy(){disposed=true;clearInterval(tick);flow.dispose();root.removeEventListener('click',click);root.removeEventListener('submit',submit);root.removeEventListener('input',input);root.removeEventListener('paste',paste);}};
}
