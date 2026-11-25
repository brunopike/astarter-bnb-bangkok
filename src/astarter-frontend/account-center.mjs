// Sidebar composition: 21st Settings Sidebar Layout (28366), adapted to Astarter tokens.
import {L} from './execution-views.mjs';
import {walletRequest} from './wallet-session.mjs';
import {walletAuthenticated} from './wallet-entry.mjs';
import {uiGlyph} from './product-composition.mjs';
import {PLANS} from './commerce-catalog.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const creditPages=['plans','topup','usage','billing'];
const settingsSections=['ux-connections','ux-preferences','ux-appearance'];
const accountPages=['profile','logs',...creditPages];
const accountSections=[['profile','个人信息','Profile','profile'],['logs','交易记录','Trade history','history'],['plans','订阅','Subscription','layers'],['topup','充值','Top up','plus'],['usage','用量','Usage','chart'],['billing','服务账单','Service billing','file']];

export function accountNavigation(page){
 if(!accountPages.includes(page))return '';
 const current=accountSections.find(([id])=>id===page);
 return '<div class="account-navigation-title">'+esc(L('个人中心','Account center'))+'</div><button type="button" class="account-menu-toggle" aria-expanded="false" aria-controls="account-navigation-links" data-account-menu><span>'+esc(L('个人中心','Account center'))+'</span><b>'+esc(L(current[1],current[2]))+'</b>'+uiGlyph('chevron')+'</button><div id="account-navigation-links" class="account-navigation-links">'+accountSections.map(([id,zh,en,icon])=>
  '<a href="?page='+id+'" data-account-go="'+id+'" aria-current="'+(id===page?'page':'false')+'" aria-label="'+esc(L(zh,en))+'">'+(icon==='profile'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>':uiGlyph(icon))+'<span>'+esc(L(zh,en))+'</span></a>'
 ).join('')+'</div>';
}

export function personalIdentity(session,connection='disconnected',walletAddress=''){
 const verified=Boolean(/^0x[0-9a-f]{40}$/i.test(walletAddress)&&typeof session?.address==='string'&&Number.isFinite(session.expires)&&walletAuthenticated(session,walletAddress,connection==='authenticated'?56:null,connection==='authenticated'?'connected':'disconnected'));
 return {verified,address:verified?session.address:'',connected:['connected','authenticated','wrong-network'].includes(connection),connection};
}

function confirmedInvitation(value,identity,origin){
 if(!identity.verified||typeof value?.address!=='string'||value.address.toLowerCase()!==identity.address.toLowerCase()||value.url!==null&&(typeof value.url!=='string'||!value.url)||!Number.isSafeInteger(value.joinedCount)||value.joinedCount<0||!Array.isArray(value.records)||value.joinedCount<value.records.length)return null;
 if(!value.records.every(row=>row&&typeof row.name==='string'&&row.name.length<=120&&Number.isFinite(row.joinedAt)&&row.joinedAt>=1e12&&Number.isFinite(new Date(row.joinedAt).getTime())))return null;
 if(value.url===null)return value;
 try{const url=new URL(value.url,origin);if(url.origin!==new URL(origin).origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;return {...value,url:url.href};}catch{return null;}
}

export function accountCenterView({session=null,connection='disconnected',walletAddress='',loading=false,walletError=false,state=null,accountError=false,security=null,invitation=null,origin='',invitationNotice='',invitationBusy=false}={}){
 const identity=personalIdentity(loading?null:session,connection,walletAddress);
 const walletAction=loading?L('钱包账户','Wallet account'):connection==='wrong-network'?L('切换到 BSC','Switch to BSC'):identity.verified?L('管理钱包','Manage wallet'):identity.connected?L('签名登录','Sign to log in'):L('钱包登录','Sign in');
 const walletStatus=loading?L('正在读取登录状态','Checking sign-in status'):walletError?L('登录状态暂不可用','Sign-in status unavailable'):identity.verified?L('已签名登录','Signed in'):identity.connected?L('已连接，未登录','Connected, not signed in'):L('未登录','Signed out');
 const walletNote=identity.verified?L('登录钱包','Sign-in wallet'):identity.connected?L('完成签名验证后即可登录。','Complete signature verification to sign in.'):L('连接钱包，查看你的账户信息','Connect your wallet to view your account details');
 const identityBody=identity.verified?'<dl class="account-facts"><div><dt>'+esc(walletNote)+'</dt><dd class="account-wallet-address">'+esc(identity.address)+'</dd></div></dl><a class="p-button" href="https://bscscan.com/address/'+encodeURIComponent(identity.address)+'" target="_blank" rel="noopener noreferrer">'+esc(L('在 BscScan 查看钱包资产','View wallet assets on BscScan'))+' ↗</a>':'<p class="account-description">'+esc(walletNote)+'</p>';
 const accountReady=typeof state?.scope==='string'&&state.scope.length>0,plan=accountReady&&Object.hasOwn(PLANS,state.plan)?PLANS[state.plan].name:'—';
 const credits=accountReady&&Number.isSafeInteger(state.balance?.available)&&state.balance.available>=0?state.balance.available.toLocaleString('en-US'):'—';
 const services='<section class="account-service-summary account-section-card" aria-labelledby="account-services-title"><header><h2 id="account-services-title">'+esc(L('AI 服务','AI services'))+'</h2>'+(accountError?'<p role="status">'+esc(L('账户信息待同步','Account sync unavailable'))+'</p>':'')+'</header><dl><div><dt>'+esc(L('订阅方案','Subscription'))+'</dt><dd>'+esc(plan)+'</dd></div><div><dt>'+esc(L('可用 Credit','Available Credits'))+'</dt><dd class="dot-number">'+esc(credits)+'</dd></div></dl></section>';
 const tracking='<a class="account-watchlist-link account-section-card" href="?page=watchlist" data-account-go="watchlist">'+uiGlyph('bookmark')+'<span>'+esc(L('我的追踪','My watchlist'))+'</span>'+uiGlyph('chevron')+'</a>';
 const securityKnown=identity.verified&&typeof security?.address==='string'&&security.address.toLowerCase()===identity.address.toLowerCase();
 const emailKnown=securityKnown&&security.capabilities?.email===true&&(security.email===null||typeof security.email==='string'),totpKnown=securityKnown&&security.capabilities?.totp===true&&typeof security.totp==='boolean';
 const securityRows=[[L('钱包认证','Wallet verification'),walletStatus],[L('安全邮箱','Security email'),emailKnown?(security.email||L('未绑定','Not linked')):securityKnown&&security.capabilities?.email===false?L('暂未开放','Not available yet'):'—'],[L('两步验证','Two-step verification'),totpKnown?L(security.totp?'已开启':'未开启',security.totp?'Enabled':'Not enabled'):securityKnown&&security.capabilities?.totp===false?L('暂未开放','Not available yet'):'—']];
 const sessionExpiry=identity.verified&&Number.isFinite(new Date(session.expires).getTime())?new Intl.DateTimeFormat(L('zh-CN','en-GB'),{dateStyle:'medium',timeStyle:'short'}).format(session.expires):'';
 const securityCard='<section class="account-section-card account-security-card" aria-labelledby="account-security-title"><header><h2 id="account-security-title">'+esc(L('安全设定','Security settings'))+'</h2></header><dl>'+securityRows.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl><div class="account-card-footer"><p>'+esc(loading?L('正在读取安全信息','Checking account security'):identity.verified?(sessionExpiry?L('会话有效至 ','Session expires ')+sessionExpiry:''):L('签名登录后查看账户安全信息','Sign in to view account security'))+'</p>'+(identity.verified?'<button type="button" class="p-button" data-account-action="wallet">'+esc(L('管理登录','Manage sign-in'))+'</button>':'')+'</div></section>';
 const confirmed=confirmedInvitation(invitation,identity,origin);
 let inviteAction='copy-invitation',inviteLabel=L('复制链接','Copy link'),inviteDisabled=!confirmed?.url;
 if(!loading&&!identity.verified){inviteAction='wallet';inviteLabel=walletAction;inviteDisabled=['loading','reconnecting'].includes(connection);}
 else if(confirmed&&!confirmed.url){inviteAction='create-invitation';inviteLabel=L('生成链接','Create link');inviteDisabled=false;}
 else if(!loading&&identity.verified&&!confirmed){inviteAction='retry-wallet';inviteLabel=L('重试','Retry');inviteDisabled=false;}
 if(invitationBusy){inviteDisabled=true;inviteLabel=L('正在生成','Creating link');}
 const inviteCard='<section class="account-section-card account-invitation-card" aria-labelledby="account-invitation-title"><header><h2 id="account-invitation-title">'+esc(L('邀请好友','Invite friends'))+'</h2><div class="account-invite-count"><strong>'+esc(confirmed?confirmed.joinedCount.toLocaleString('en-US'):'—')+'</strong><span>'+esc(L('已加入账户','Accounts joined'))+'</span></div></header><label class="account-invite-label" for="account-invitation-link">'+esc(L('邀请链接','Invitation link'))+'</label><div class="account-invite-copy"><input id="account-invitation-link" type="text" readonly data-invitation-link aria-label="'+esc(L('邀请链接','Invitation link'))+'" value="'+esc(confirmed?.url||'')+'" placeholder="'+esc(loading?L('正在读取','Loading'):confirmed?L('生成专属链接','Create a personal link'):identity.verified?L('链接暂不可用','Link unavailable'):L('登录后获取链接','Sign in to get a link'))+'"><button type="button" class="p-button" data-account-action="'+inviteAction+'" '+(inviteDisabled?'disabled':'')+'>'+esc(inviteLabel)+'</button></div><p class="account-invite-feedback" role="status">'+esc(invitationNotice)+'</p><div class="account-invite-records"><h3>'+esc(L('邀请记录','Invitation records'))+'</h3>'+(confirmed?.records.length?'<ul>'+confirmed.records.slice(0,20).map(row=>'<li><span>'+esc(row.name)+'</span><time datetime="'+new Date(row.joinedAt).toISOString()+'">'+esc(new Intl.DateTimeFormat(L('zh-CN','en-GB'),{year:'numeric',month:'short',day:'numeric'}).format(row.joinedAt))+'</time></li>').join('')+'</ul>':'<p>'+esc(confirmed?L('还没有邀请记录','No invitations yet'):loading?L('正在读取邀请记录','Loading invitation records'):identity.verified?L('邀请记录暂不可用','Invitation records unavailable'):L('登录后查看邀请记录','Sign in to view invitation records'))+'</p>')+'</div></section>';
 return '<div class="account-profile" data-localized-ui>'+
  '<header class="p-head"><div><h1>'+esc(L('个人信息','Personal information'))+'</h1></div><a class="p-button account-settings-shortcut" href="?page=settings" data-account-go="settings" aria-label="'+esc(L('设置','Settings'))+'">'+uiGlyph('settings')+'<span>'+esc(L('设置','Settings'))+'</span></a></header>'+
  '<div class="account-profile-sections"><section class="account-section-card account-identity-card" aria-labelledby="account-identity-title"><div class="account-identity"><div class="account-identity-summary"><span class="account-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg></span><div><h2 id="account-identity-title">'+esc(loading?L('钱包账户','Wallet account'):identity.verified?L('钱包用户','Wallet user'):L('访客','Guest'))+'</h2><p class="account-signin-state" role="status">'+esc(walletStatus)+'</p></div></div>'+
  '<div class="account-actions"><button type="button" class="p-button" data-account-action="wallet" '+(['loading','reconnecting'].includes(connection)?'disabled':'')+'>'+esc(walletAction)+'</button>'+
  (walletError?'<button type="button" class="p-button" data-account-action="retry-wallet">'+esc(L('重试','Retry'))+'</button>':'')+'</div></div>'+identityBody+'</section>'+services+tracking+securityCard+inviteCard+'</div></div>';
}

export function createAccountCenter({root,account,navigate,openWallet,onChange,readSession=()=>walletRequest('session'),issueInvitation=()=>walletRequest('invitation',{})}){
 const doc=root.ownerDocument,view=doc.defaultView;
 const currentWallet=()=>{
  const control=doc.querySelector('.header-wallet .wallet-control'),button=doc.querySelector('.header-wallet .wallet-login');
  const connection=control?.dataset.walletState||(button&&!button.disabled?'disconnected':'loading');
  // The authenticated header exposes its actual address in the accessible label.
  const address=connection==='authenticated'?button?.getAttribute('aria-label')?.match(/0x[0-9a-f]{40}/i)?.[0]||'':'';
  return {connection,address};
 };
 let active=false,session=null,security=null,invitation=null,invitationNotice='',invitationBusy=false,loading=true,walletError=false,version=0,observer,lastConnection,unsubscribeAccount,lastAccount;
 const accountStamp=()=>JSON.stringify([account?.s?.scope,account?.s?.plan,account?.s?.balance?.available,!!account?.error]);
 const changed=()=>{if(active)onChange();};
 async function refreshIdentity(){
  const request=++version;loading=true;walletError=false;security=null;invitation=null;invitationNotice='';invitationBusy=false;changed();
  try{const result=await readSession();if(active&&request===version){session=result?.session??null;security=result?.security??null;invitation=result?.invitation??null;loading=false;changed();}}
  catch{if(active&&request===version){session=null;loading=false;walletError=true;changed();}}
 }
 async function copyInvitation(){
  if(!active)return;
  const current=currentWallet(),identity=personalIdentity(loading?null:session,current.connection,current.address),confirmed=confirmedInvitation(invitation,identity,view?.location?.origin||'');
  if(!confirmed?.url)return;
  const request=version;
  try{await view.navigator.clipboard.writeText(confirmed.url);if(active&&request===version){invitationNotice=L('邀请链接已复制','Invitation link copied');changed();}}
  catch{if(active&&request===version){invitationNotice=L('复制失败，请选择链接手动复制','Copy failed. Select the link to copy it');changed();const input=root.querySelector('[data-invitation-link]');input?.focus();input?.select();}}
 }
 async function createInvitation(){
  if(!active||invitationBusy)return;
  const current=currentWallet(),identity=personalIdentity(loading?null:session,current.connection,current.address),confirmed=confirmedInvitation(invitation,identity,view?.location?.origin||'');
  if(!confirmed||confirmed.url)return;
  const request=version;invitationBusy=true;invitationNotice='';changed();
  try{
   const result=await issueInvitation();if(!active||request!==version)return;
   const wallet=currentWallet(),next=confirmedInvitation(result?.invitation,personalIdentity(session,wallet.connection,wallet.address),view?.location?.origin||'');
   if(!next?.url)throw Error('invalid-invitation');
   invitation=next;invitationNotice=L('邀请链接已生成','Invitation link created');
  }catch{if(active&&request===version)invitationNotice=L('暂时无法生成邀请链接，请重试','Could not create your invitation link. Try again.');}
  finally{if(active&&request===version){invitationBusy=false;changed();}}
 }
 function close(){
  active=false;++version;observer?.disconnect();observer=null;unsubscribeAccount?.();unsubscribeAccount=null;
  view?.removeEventListener('focus',refreshIdentity);
 }
 function decorate(page){
  const related=accountPages.includes(page);
  root.classList.toggle('account-context',related);
  const back=root.querySelector(':scope>.account-return');
  if(page!=='settings')back?.remove();
  let navigation=root.querySelector(':scope>.account-navigation');
  if(related){
   const legacy=root.querySelector(':scope>.layout-navigation-row');if(legacy?.querySelector('.biz-subnav'))legacy.remove();
   root.querySelector(':scope>.biz-subnav')?.remove();
   if(!navigation){navigation=doc.createElement('nav');navigation.className='account-navigation';navigation.setAttribute('aria-label',L('个人中心','Account center'));navigation.setAttribute('data-localized-ui','');root.prepend(navigation);}
   if(navigation.dataset.accountPage!==page){navigation.dataset.accountPage=page;navigation.classList.remove('is-open');navigation.innerHTML=accountNavigation(page);}
   let content=root.querySelector(':scope>.account-content');
   if(!content){content=doc.createElement('div');content.className='account-content';root.append(content);}
   // Move original nodes after their handlers are bound; the shared layout has already run.
   for(const node of [...root.children])if(node!==navigation&&node!==content)content.append(node);
  }else{
   navigation?.remove();
   const content=root.querySelector(':scope>.account-content');
   if(content){content.replaceWith(...content.childNodes);}
  }
  if(page==='settings'&&!back){
   const back=doc.createElement('a');back.className='account-return';back.href='?page=profile';back.dataset.accountGo='profile';
   back.setAttribute('aria-label',L('返回个人中心','Back to account center'));back.textContent='← '+L('个人中心','Account center');root.prepend(back);
  }
  if(page!=='profile'){if(active)close();return;}
  if(active)return;
  active=true;lastConnection=JSON.stringify(currentWallet());
  lastAccount=accountStamp();unsubscribeAccount=account?.subscribe(()=>{const next=accountStamp();if(next!==lastAccount&&!root.querySelector('.account-navigation.is-open')&&!doc.querySelector('dialog[open]')){lastAccount=next;changed();}});
  view?.addEventListener('focus',refreshIdentity);
  const walletHost=doc.querySelector('.header-wallet');
  if(walletHost&&view?.MutationObserver){
   observer=new view.MutationObserver(()=>{const next=JSON.stringify(currentWallet());if(next!==lastConnection){lastConnection=next;void refreshIdentity();}});
   observer.observe(walletHost,{subtree:true,childList:true,attributes:true,attributeFilter:['data-wallet-state','disabled','aria-label']});
  }
  void refreshIdentity();
 }
 const closeMenu=(restoreFocus=false)=>{
  const menu=root.querySelector('.account-menu-toggle[aria-expanded="true"]');
  if(!menu)return;
  menu.setAttribute('aria-expanded','false');menu.closest('.account-navigation').classList.remove('is-open');
  if(restoreFocus)menu.focus({preventScroll:true});
 };
 const click=event=>{
  const menu=event.target.closest?.('[data-account-menu]');
  if(menu&&root.contains(menu)){
   const open=menu.getAttribute('aria-expanded')!=='true';
   menu.setAttribute('aria-expanded',String(open));
   menu.closest('.account-navigation').classList.toggle('is-open',open);
   if(open&&doc.activeElement!==menu)menu.focus({preventScroll:true});
   return;
  }
  if(!event.target.closest?.('.account-navigation'))closeMenu();
  const target=event.target.closest?.('[data-account-go],[data-account-action]');
  if(!target||!root.contains(target))return;
  if(target.dataset.accountGo){
   if(event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   const page=target.dataset.accountGo,section=target.dataset.accountSection||'';
   if(!['profile','settings','logs','watchlist',...creditPages].includes(page)||section&&!settingsSections.includes(section))return;
   event.preventDefault();closeMenu();navigate(page,section);return;
  }
  if(target.disabled)return;
  if(target.dataset.accountAction==='wallet')openWallet();
  else if(target.dataset.accountAction==='retry-wallet')void refreshIdentity();
  else if(target.dataset.accountAction==='copy-invitation')void copyInvitation();
  else if(target.dataset.accountAction==='create-invitation')void createInvitation();
 };
 const keydown=event=>{
  if(event.key!=='Escape'||event.defaultPrevented||!root.querySelector('.account-navigation.is-open'))return;
  if(!doc.querySelector('dialog[open], [aria-modal="true"]:not([hidden]), [data-info-open], [data-liquid-open], .topbar details[open]'))closeMenu(true);
 };
 const desktop=view?.matchMedia?.('(min-width:1101px)'),resize=event=>{if(event.matches)closeMenu();};
 root.addEventListener('click',click);
 doc.addEventListener('keydown',keydown,true);
 desktop?.addEventListener('change',resize);
 return {
  render:()=>{const current=currentWallet();return accountCenterView({session,connection:current.connection,walletAddress:current.address,loading:loading||!active,walletError,state:account?.s,accountError:!!account?.error,security,invitation,origin:view?.location?.origin||'',invitationNotice,invitationBusy});},
  decorate,close,
  destroy(){close();root.removeEventListener('click',click);doc.removeEventListener('keydown',keydown,true);desktop?.removeEventListener('change',resize);}
 };
}
