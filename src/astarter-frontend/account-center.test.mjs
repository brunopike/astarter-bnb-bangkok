import test from 'node:test';
import assert from 'node:assert/strict';
import {personalIdentity,accountNavigation,accountCenterView,createAccountCenter} from './account-center.mjs';

const address='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
const session={address,chain:56,expires:Date.now()+60000};
const state={scope:'personal:test',plan:'pro',balance:{available:12151}};
const origin='http://127.0.0.1:4188';
const invitation={address,url:'/?ref=astarter-test',joinedCount:1,records:[{name:'研究伙伴',joinedAt:Date.now()-86400000}]};

test('profile includes security and invitations without presenting unknown security or invite counts as confirmed',()=>{
 const guest=accountCenterView({state,security:{address,email:'hello@astarter.local',totp:true},invitation});
 assert.match(guest,/安全设定/);assert.match(guest,/邀请好友/);assert.match(guest,/邀请链接/);assert.match(guest,/邀请记录/);
 assert.doesNotMatch(guest,/已开启|未开启|未绑定|研究伙伴|astarter-test/);
 const signed={state,session,connection:'authenticated',walletAddress:address,origin};
 const known=accountCenterView({...signed,security:{address,capabilities:{email:true,totp:true},email:'hello@astarter.local',totp:true},invitation});
 assert.match(known,/hello@astarter.local/);assert.match(known,/已开启/);assert.match(known,/研究伙伴/);
 assert.match(known,/data-account-action="copy-invitation"/);assert.match(known,/value="http:\/\/127\.0\.0\.1:4188\/\?ref=astarter-test"/);
 const unset=accountCenterView({...signed,security:{address,capabilities:{email:true,totp:true},email:null,totp:false}});assert.match(unset,/未绑定/);assert.match(unset,/未开启/);
 const unavailable=accountCenterView({...signed,security:{address,capabilities:{email:false,totp:false},email:null,totp:null}});assert.match(unavailable,/暂未开放/);assert.doesNotMatch(unavailable,/未绑定|未开启/);
 const unknown=accountCenterView({...signed,security:{address:other,email:'wrong@astarter.local',totp:true},invitation:{...invitation,address:other}});
 assert.doesNotMatch(unknown,/wrong@astarter.local|研究伙伴|astarter-test|已开启/);
});

test('invitation copy requires a confirmed same-account link on the current site and preserves real empty records',()=>{
 const signed={state,session,connection:'authenticated',walletAddress:address,origin};
 for(const value of [null,{...invitation,address:42},{...invitation,url:undefined},{...invitation,url:''},{...invitation,url:'javascript:alert(1)'},{...invitation,url:'https://example.com/?ref=test'},{...invitation,joinedCount:-1},{...invitation,records:[{name:'broken',joinedAt:NaN}]}]){
  const html=accountCenterView({...signed,invitation:value});
  assert.doesNotMatch(html,/data-account-action="copy-invitation"/);assert.match(html,/data-account-action="retry-wallet"/);assert.doesNotMatch(html,/value="(?:javascript:|https:\/\/example\.com)/);
 }
 const empty=accountCenterView({...signed,invitation:{...invitation,joinedCount:0,records:[]}});
 assert.match(empty,/还没有邀请记录/);assert.match(empty,/>0<\/strong>/);
 const escaped=accountCenterView({...signed,invitation:{...invitation,records:[{name:'<img src=x onerror=1>',joinedAt:Date.now()}]}});
 assert.match(escaped,/&lt;img/);assert.doesNotMatch(escaped,/<img/);
});

test('a confirmed account without an invitation link can create one without treating unknown data as zero',()=>{
 const signed={state,session,connection:'authenticated',walletAddress:address,origin};
 const html=accountCenterView({...signed,invitation:{...invitation,url:null,joinedCount:0,records:[]}});
 assert.match(html,/data-account-action="create-invitation"/);assert.match(html,/生成链接/);assert.match(html,/>0<\/strong>/);
 const unknown=accountCenterView(signed);assert.doesNotMatch(unknown,/data-account-action="create-invitation"/);
});

test('a connected wallet, expired session or wrong identity cannot impersonate signed-in information',()=>{
 assert.equal(personalIdentity(null,'authenticated',address).verified,false);
 assert.equal(personalIdentity(session,'connected',address).verified,false);
 assert.equal(personalIdentity({...session,expires:0},'authenticated',address).verified,false);
 assert.equal(personalIdentity({...session,chain:1},'authenticated',address).verified,false);
 assert.equal(personalIdentity({...session,address:42},'authenticated',address).address,'');
 assert.equal(personalIdentity(session,'authenticated',other).address,'');
 assert.equal(personalIdentity(session,'authenticated',address).address,address);
});

test('all six account pages share one direct navigation with exactly one selected page',()=>{
 for(const selected of ['profile','logs','plans','topup','usage','billing']){
  const html=accountNavigation(selected);
  for(const page of ['profile','logs','plans','topup','usage','billing'])assert.equal((html.match(new RegExp('href="\\?page='+page+'"','g'))||[]).length,1);
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
  assert.match(html,new RegExp('data-account-go="'+selected+'"[^>]*aria-current="page"'));
  assert.match(html,/交易记录/);assert.doesNotMatch(html,/交易账单/);
 }
 assert.equal(accountNavigation('settings'),'');assert.equal(accountNavigation('assets'),'');
});

test('personal information shows identity and the original settings action without the rejected entry cards or invented data',()=>{
 const before=JSON.stringify(state),html=accountCenterView({state});
 assert.match(html,/href="\?page=settings"/);
 assert.doesNotMatch(html,/p-card|account-center-grid|account-credit-links|data-account-go="(?:plans|topup|usage|billing)"/);
 assert.match(html,/Pro/);assert.match(html,/12,151/);assert.match(html,/href="\?page=watchlist"[^>]*data-account-go="watchlist"/);
 assert.doesNotMatch(html,/SIM-01|astarter_preview|workspace|Ada|Jane|@example|type="email"|<form|[?&]page=assets/);
 assert.equal(JSON.stringify(state),before);
});

test('an identity service failure retains wallet recovery and the shared account navigation',()=>{
 const empty=accountCenterView({state:{},walletError:true});
 assert.doesNotMatch(empty,/<strong>0<\/strong>/);
 assert.match(empty,/retry-wallet/);assert.match(accountNavigation('profile'),/data-account-go="billing"/);
 const signed=accountCenterView({state,session,connection:'authenticated',walletAddress:address});
 assert.ok(signed.includes(address));
 assert.ok(!accountCenterView({state,session,connection:'connected',walletAddress:address}).includes(address));
});

test('a pending identity read never exposes an older signed-in address or declares the user signed out',()=>{
 const html=accountCenterView({state,session,connection:'authenticated',walletAddress:address,loading:true});
 assert.ok(!html.includes(address));assert.match(html,/正在读取登录状态/);assert.doesNotMatch(html,/account-signin-state">未登录/);
});

function fixture({initialConnection='authenticated',clipboardFails=false,issueInvitation=async()=>({invitation})}={}){
 const events=new Map(),created=[],reads=[],subscribers=new Set(),nav=[],windowEvents=new Map(),observers=[],copied=[];
 const mediaEvents=new Map(),desktop={addEventListener:(name,fn)=>mediaEvents.set(name,fn),removeEventListener:name=>mediaEvents.delete(name)};
 const mounted=new Map(),originalContent={className:'original-page',handler:()=>42};mounted.set(':scope>.original-page',originalContent);
 const legacyTabs={querySelector:()=>({}),remove(){mounted.delete(':scope>.layout-navigation-row');}};mounted.set(':scope>.layout-navigation-row',legacyTabs);
 let changed=0,walletClicks=0,creditRefreshes=0,invitationCalls=0,connection=initialConnection,walletAddress=address;
 const walletHost={};
 const doc={defaultView:{location:{origin},navigator:{clipboard:{writeText:async value=>{if(clipboardFails)throw Error('denied');copied.push(value);}}},matchMedia:()=>desktop,addEventListener:(n,f)=>windowEvents.set(n,f),removeEventListener:n=>windowEvents.delete(n),MutationObserver:class{
  constructor(callback){this.callback=callback;observers.push(this);}
  observe(host,options){this.host=host;this.options=options;this.active=true;}
  disconnect(){this.active=false;}
 }},
  addEventListener:(name,handler)=>events.set(name,handler),removeEventListener:name=>events.delete(name),
  querySelector:selector=>selector.includes('wallet-control')?(connection?{dataset:{walletState:connection}}:null):selector.includes('wallet-login')?{disabled:false,getAttribute:()=>connection==='authenticated'?'Signed in · BSC · '+walletAddress:'Connect wallet'}:selector==='.header-wallet'?walletHost:null,
  createElement(tag){const a={tag,dataset:{},children:[],classList:{remove(){}},setAttribute(k,v){this[k]=v;},querySelector:()=>null,append(node){for(const [key,value] of mounted)if(value===node)mounted.delete(key);this.children.push(node);},get childNodes(){return this.children;},replaceWith(...nodes){this.remove();for(const node of nodes)root.append(node);},remove(){for(const [key,value] of mounted)if(value===this)mounted.delete(key);}};created.push(a);return a;}};
 const root={ownerDocument:doc,classList:{toggle(){}},addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n),contains:()=>true,querySelector:selector=>mounted.get(selector)||null,get children(){return [...mounted.values()];},append(node){mounted.set(':scope>.'+node.className,node);},prepend(node){mounted.set(':scope>.'+node.className,node);}};
 const account={s:state,error:'',subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);},refresh(){creditRefreshes++;}};
 const center=createAccountCenter({root,account,navigate:(...args)=>nav.push(args),openWallet:()=>walletClicks++,onChange:()=>changed++,readSession:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),issueInvitation:()=>{invitationCalls++;return issueInvitation();}});
 const click=(dataset,extra={})=>{let prevented=false;events.get('click')({target:{closest:selector=>selector==='[data-account-go],[data-account-action]'?{dataset}:null},preventDefault(){prevented=true;},...extra});return prevented;};
 return {center,account,reads,subscribers,nav,events,windowEvents,created,click,observers,mounted,originalContent,mediaEvents,copied,
  setWallet(nextAddress,nextConnection=connection){walletAddress=nextAddress;connection=nextConnection;for(const observer of observers)if(observer.active)observer.callback();},
  get changed(){return changed;},get walletClicks(){return walletClicks;},get creditRefreshes(){return creditRefreshes;},get invitationCalls(){return invitationCalls;}};
}

test('invitation creation is single-flight, requires confirmed current ownership and produces a copyable real response',async()=>{
 let release;const f=fixture({issueInvitation:()=>new Promise(resolve=>release=resolve)}),uncreated={...invitation,url:null,joinedCount:0,records:[]};
 f.center.decorate('profile');f.reads[0].resolve({session,invitation:uncreated});await Promise.resolve();await Promise.resolve();
 f.click({accountAction:'create-invitation'});f.click({accountAction:'create-invitation'});assert.equal(f.invitationCalls,1);assert.match(f.center.render(),/正在生成/);
 release({invitation});await Promise.resolve();await Promise.resolve();assert.match(f.center.render(),/邀请链接已生成/);assert.match(f.center.render(),/data-account-action="copy-invitation"/);
 f.click({accountAction:'copy-invitation'});await Promise.resolve();assert.deepEqual(f.copied,[origin+'/?ref=astarter-test']);
 const late=fixture({issueInvitation:()=>new Promise(resolve=>release=resolve)});late.center.decorate('profile');late.reads[0].resolve({session,invitation:uncreated});await Promise.resolve();await Promise.resolve();late.click({accountAction:'create-invitation'});late.setWallet(other);release({invitation});await Promise.resolve();await Promise.resolve();assert.doesNotMatch(late.center.render(),/astarter-test|邀请链接已生成/);
});

test('failed creation keeps confirmed zero records and offers a retry without inventing a link',async()=>{
 const f=fixture({issueInvitation:async()=>{throw Error('unavailable');}});f.center.decorate('profile');f.reads[0].resolve({session,invitation:{...invitation,url:null,joinedCount:0,records:[]}});await Promise.resolve();await Promise.resolve();
 f.click({accountAction:'create-invitation'});await Promise.resolve();await Promise.resolve();const html=f.center.render();assert.match(html,/暂时无法生成邀请链接，请重试/);assert.match(html,/data-account-action="create-invitation"/);assert.doesNotMatch(html,/astarter-test|邀请链接已生成/);
});

test('confirmed invitation copy uses the current session and stops on wallet changes or page exit',async()=>{
 const f=fixture();f.center.decorate('profile');f.reads[0].resolve({session,invitation});await Promise.resolve();await Promise.resolve();
 f.click({accountAction:'copy-invitation'});await Promise.resolve();await Promise.resolve();
 assert.deepEqual(f.copied,[origin+'/?ref=astarter-test']);assert.match(f.center.render(),/邀请链接已复制/);
 f.setWallet(other);f.click({accountAction:'copy-invitation'});await Promise.resolve();assert.equal(f.copied.length,1);assert.doesNotMatch(f.center.render(),/astarter-test/);
 f.center.decorate('usage');f.click({accountAction:'copy-invitation'});await Promise.resolve();assert.equal(f.copied.length,1);
 assert.equal(f.creditRefreshes,0);
});

test('clipboard failure preserves the invitation link and gives a manual copy path without claiming success',async()=>{
 const f=fixture({clipboardFails:true});f.center.decorate('profile');f.reads[0].resolve({session,invitation});await Promise.resolve();await Promise.resolve();
 f.click({accountAction:'copy-invitation'});await Promise.resolve();await Promise.resolve();
 assert.equal(f.copied.length,0);const html=f.center.render();assert.match(html,/复制失败，请选择链接手动复制/);assert.match(html,/astarter-test/);assert.doesNotMatch(html,/邀请链接已复制/);
});

test('leaving and reopening rejects old identity reads, updates only the active view and releases identity watchers',async()=>{
 const f=fixture();f.center.decorate('profile');assert.equal(f.reads.length,1);
 f.center.decorate('usage');assert.equal(f.subscribers.size,0);assert.equal(f.windowEvents.size,0);
 f.setWallet(other);f.center.decorate('profile');assert.equal(f.reads.length,2);
 f.reads[1].resolve({session:{address:other,chain:56,expires:Date.now()+60000}});await Promise.resolve();await Promise.resolve();
 assert.ok(f.center.render().includes(other));const changed=f.changed;
 f.reads[0].resolve({session:{address,chain:56,expires:Date.now()+60000}});await Promise.resolve();await Promise.resolve();
 assert.equal(f.changed,changed);assert.ok(!f.center.render().includes(address));
 f.center.destroy();assert.equal(f.events.size,0);assert.equal(f.subscribers.size,0);
});

test('profile account facts never turn unconfirmed data into Free or zero and keep sync failures visible',()=>{
 for(const missing of [null,{}, {...state,scope:''},{...state,plan:'unknown',balance:{available:-1}}]){
  const html=accountCenterView({state:missing});
  assert.doesNotMatch(html,/<dd[^>]*>(?:Free|0)<\/dd>/);assert.doesNotMatch(html,/12,151/);
 }
 const html=accountCenterView({state,accountError:true});assert.match(html,/12,151/);assert.match(html,/账户信息待同步/);
 const free=accountCenterView({state:{...state,plan:'free',balance:{available:0}}});assert.match(free,/>Free<\/dd>/);assert.match(free,/<dd class="dot-number">0<\/dd>/);
});

test('the profile tracking link uses the existing modal navigation and preserves native modified links',()=>{
 const f=fixture();assert.equal(f.click({accountGo:'watchlist'}),true);assert.deepEqual(f.nav,[['watchlist','']]);
 assert.equal(f.click({accountGo:'watchlist'},{metaKey:true}),false);assert.equal(f.walletClicks,0);assert.equal(f.creditRefreshes,0);f.center.destroy();
});

test('profile facts update from the existing account only when they change and release the subscription on exit',()=>{
 const f=fixture();f.center.decorate('profile');assert.equal(f.subscribers.size,1);assert.match(f.center.render(),/12,151/);
 const unchanged=f.changed;for(const notify of f.subscribers)notify();assert.equal(f.changed,unchanged);
 f.account.s={...state,balance:{available:12000}};for(const notify of f.subscribers)notify();assert.equal(f.changed,unchanged+1);assert.match(f.center.render(),/12,000/);
 f.center.decorate('usage');assert.equal(f.subscribers.size,0);f.center.destroy();
});

test('a background balance change waits for the open account menu and catches up after it closes',()=>{
 const f=fixture();f.center.decorate('profile');const before=f.changed;
 f.mounted.set('.account-navigation.is-open',{});f.account.s={...state,balance:{available:12001}};
 for(const notify of f.subscribers)notify();assert.equal(f.changed,before);
 f.mounted.delete('.account-navigation.is-open');for(const notify of f.subscribers)notify();assert.equal(f.changed,before+1);assert.match(f.center.render(),/12,001/);f.center.destroy();
});

test('an address change with the same authenticated state hides the old identity and rejects its late response',async()=>{
 const f=fixture();f.center.decorate('profile');
 f.reads[0].resolve({session});await Promise.resolve();await Promise.resolve();
 assert.ok(f.center.render().includes(address));
 assert.ok(f.observers[0].options.attributeFilter.includes('aria-label'));
 f.windowEvents.get('focus')();assert.equal(f.reads.length,2);
 f.setWallet(other);assert.equal(f.reads.length,3);
 assert.ok(!f.center.render().includes(address));assert.match(f.center.render(),/正在读取登录状态/);
 f.reads[2].resolve({session:{...session,address:other}});await Promise.resolve();await Promise.resolve();
 assert.ok(f.center.render().includes(other));
 f.reads[1].resolve({session});await Promise.resolve();await Promise.resolve();
 assert.ok(!f.center.render().includes(address));assert.ok(f.center.render().includes(other));
 f.setWallet(other,'connected');assert.ok(!f.center.render().includes(other));
 f.center.destroy();assert.ok(f.observers.every(observer=>!observer.active));
});

test('ordinary links use existing navigation, modified links remain native, and actions never write a payment or profile',()=>{
 const f=fixture();
 assert.equal(f.click({accountGo:'billing'}),true);assert.deepEqual(f.nav,[['billing','']]);
 assert.equal(f.click({accountGo:'settings',accountSection:'ux-preferences'}),true);
 assert.equal(f.click({accountGo:'profile'},{ctrlKey:true}),false);
 assert.equal(f.click({accountGo:'assets'}),false);assert.equal(f.click({accountGo:'settings',accountSection:'bad'}),false);
 f.click({accountAction:'wallet'});assert.equal(f.walletClicks,1);
 f.click({accountAction:'retry-credits'});assert.equal(f.creditRefreshes,0);
 f.center.decorate('settings');assert.equal(f.created[0].href,'?page=profile');f.center.destroy();
});

test('a failed lazy wallet UI retains its existing enabled sign-in retry and identity failures never block the credit links',async()=>{
 const f=fixture({initialConnection:null});
 assert.doesNotMatch(f.center.render(),/data-account-action="wallet" disabled/);
 f.center.decorate('profile');f.reads[0].reject(Error('unavailable'));await Promise.resolve();await Promise.resolve();
 assert.match(f.center.render(),/retry-wallet/);assert.match(accountNavigation('profile'),/data-account-go="billing"/);
 f.click({accountAction:'wallet'});assert.equal(f.walletClicks,1);f.center.destroy();
});

test('the dashboard preserves original page nodes, replaces legacy tabs once and unwraps content outside account routes',()=>{
 const f=fixture();f.center.decorate('billing');
 assert.equal(f.mounted.has(':scope>.layout-navigation-row'),false);
 assert.equal(f.mounted.has(':scope>.account-return'),false);
 const content=f.mounted.get(':scope>.account-content');assert.deepEqual(content.children,[f.originalContent]);assert.equal(content.children[0].handler(),42);
 assert.match(f.mounted.get(':scope>.account-navigation').innerHTML,/data-account-go="billing"[^>]*aria-current="page"/);
 f.center.decorate('billing');assert.equal(f.created.filter(n=>n.tag==='nav').length,1);assert.equal(f.created.filter(n=>n.className==='account-content').length,1);assert.equal(content.children.length,1);
 f.mounted.get(':scope>.account-navigation').querySelector=()=>({scrollIntoView(){assert.fail('switching account pages must not scroll the outer document');}});
 f.center.decorate('usage');assert.match(f.mounted.get(':scope>.account-navigation').innerHTML,/data-account-go="usage"[^>]*aria-current="page"/);
 f.center.decorate('settings');assert.equal(f.mounted.has(':scope>.account-content'),false);assert.equal(f.mounted.get(':scope>.original-page'),f.originalContent);assert.equal(f.mounted.has(':scope>.account-navigation'),false);assert.equal(f.mounted.get(':scope>.account-return').href,'?page=profile');
 f.center.decorate('assets');assert.equal(f.mounted.has(':scope>.account-return'),false);f.center.destroy();
});


test('compact account navigation toggles, closes on Escape with focus restored and keeps ordinary links usable',()=>{
 const f=fixture();f.center.decorate('billing');
 const navigation=f.mounted.get(':scope>.account-navigation');let expanded='false',open=false,focused=0;
 navigation.classList={toggle(name,value){assert.equal(name,'is-open');open=value;if(value)f.mounted.set('.account-navigation.is-open',navigation);else f.mounted.delete('.account-navigation.is-open');},remove(name){assert.equal(name,'is-open');open=false;f.mounted.delete('.account-navigation.is-open');}};
 const menu={getAttribute:()=>expanded,setAttribute(name,value){assert.equal(name,'aria-expanded');expanded=value;},closest:()=>navigation,focus(options){assert.equal(options.preventScroll,true);focused++;}};
 f.mounted.set('.account-menu-toggle[aria-expanded="true"]',menu);
 const toggle=()=>f.events.get('click')({target:{closest:selector=>selector==='[data-account-menu]'?menu:null}});
 toggle();assert.equal(expanded,'true');assert.equal(open,true);assert.equal(focused,1);
 f.events.get('keydown')({key:'Escape',defaultPrevented:true});assert.equal(open,true);
 f.events.get('keydown')({key:'Escape'});assert.equal(expanded,'false');assert.equal(open,false);assert.equal(focused,2);
 toggle();assert.equal(f.click({accountGo:'topup'}),true);assert.equal(expanded,'false');assert.deepEqual(f.nav,[['topup','']]);
 toggle();assert.equal(open,true);f.mediaEvents.get('change')({matches:true});assert.equal(open,false);assert.equal(expanded,'false');
 f.center.destroy();assert.equal(f.events.size,0);assert.equal(f.mediaEvents.size,0);
});
