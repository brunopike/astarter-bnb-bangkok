import {routeHref,routeSearch} from './site-routes.mjs';
import {syncSiteMeta} from './site-seo-client.mjs';
import {assistantNavIcon,createDesktopNavigationSelection,createMobileNavigation} from './mobile-navigation.mjs';
import {mountSweepingTitle} from './workbench-optical-header.mjs';
import {createNumberInputs} from './product-number-input.mjs';
import {CATALOG} from './strategy-catalog.mjs';
import {accessPanel} from './trading-access-view.mjs';
import {mountWalletEntry} from './wallet-entry.mjs';
import {companionMood,mountCompanionMotion} from './page-companion.mjs';
import {mountNewsCourier,mountSignalCourier} from './collection-motion.mjs';
import {newsDeliveryBrief} from './intelligence-news-feed.mjs';
import {mountAIOperator} from './ai-operator.mjs';
import {TradingPreview,hasActiveTrade} from './trading-preview.mjs';
import {previewToolbar,previewExecutionView,previewPositionDetail,previewOrderDetail} from './trading-preview-view.mjs';
import {currentPlan,estimate} from './commerce-catalog.mjs';
import {createMembership} from './membership.mjs';
import {createAccountCenter} from './account-center.mjs';
import {createStatements} from './statements.mjs?v=20261123p';
import {createTradingAssistant} from './trading-assistant.mjs?v=20261125a';
import {decorateBento} from './bento-system.mjs';
import {createDataCenter} from './data-center.mjs';
import {liveDataRoute} from './data-live-views.mjs';
import {createPrivateWatchAccountAdapter} from './workspace-sim.mjs';
import {relatedAssetTarget,relatedAssetView} from './related-data.mjs';
import {hubOwnsRoute} from './market-hub.mjs';
import {DATA_PAGES} from './data-center-fixtures.mjs';
import {HUB_ASSET_IDS} from './market-hub-data.mjs';
import {createCompanionMarket} from './page-companion-market.mjs';
import {readCompanionNews} from './page-companion-news.mjs';
import {composeProduct,uiGlyph,canAutoRefresh,captureProductFocus,bindSearchRender,bindSelectValues,bindCardEdges} from './product-composition.mjs';
import {captureDataChannel,captureDataTab,readDataTabScroll,interceptNavigation,unifyProductLayout} from './product-layout.mjs';
import {enhanceProductCopy,friendlyText,helpContent,bindInfoPopovers} from './product-help.mjs';
import {intelligenceExperience,intelligenceRows} from './intelligence-experience.mjs';
import {marketOverview} from './market-observatory.mjs';
import {createProductShell} from './product-shell.mjs';
import {scopeHeader,ledgerPanel,L,patchExecutionPrices} from './execution-views.mjs';
import {executionRenderStamp} from './execution-stream.mjs';
import {createBusinessPages,DOMAINS} from './business-pages.js?v=20261126a';
import {mountReference} from './reference-surfaces.mjs';
import {mountCharts} from './product-chart-ui.mjs';
import {mountTradeActivity} from './trade-activity-skyline.mjs';
import {marketView,feedView,feedCardsView,strategyView,logsView,tradeLogEntries,assetsView,pageHead} from './product-views.mjs';
import {BRAIN_PAGE_NAME,PAGES,INTELLIGENCE,STRATEGIES,ASSETS,TRADING_TABS,tradingSection,marketSeries,portfolio,accountOrders,routePage,watchlistRoute,wealthRoute,currentIntelligenceRoute,validateSetup,MOBILE_DOCK,ASSISTANT_NAV,mobileNavSection,createNavigationMemory,restoreNavigationSearch,brainEntrySearch,updateBrainEntry} from './product-data.mjs';
import {evidenceProcess} from './evidence-process.mjs';
import {t,getLocale} from './locale.mjs';
import {connectedAccountBalances} from './connection-options.mjs?v=20261125c';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const readBrowser=(k,f)=>{try{return JSON.parse(localStorage.getItem(k))??f;}catch{return f;}};
const saveBrowser=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return localStorage.getItem(k)===JSON.stringify(v);}catch{return false;}};
const card=(title,html,cls='')=>`<section class="p-card ${cls}"><h2>${title}</h2>${html}</section>`;
const btn=(label,attr='',primary=false)=>`<button class="p-button ${primary?'p-primary':''}" ${attr}>${label}</button>`;
const tag=s=>`<span class="p-tag">${esc(s)}</span>`;
const empty=s=>`<div class="p-empty">${s}</div>`;
const table=(heads,rows)=>`<div class="p-table-scroll"><table class="p-table"><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>${rows.length?'':empty('没有符合筛选条件的记录。')}</div>`;
export function createProduct({getTeamContext=()=>null,desk,model,research,resize,workspace,researchModel,onHandoff,onResearchStart,onOpenResearch}){
 const isolated=desk.syncStatus?.().source==='LOCAL_SERVICE';
 const read=isolated?(key,fallback)=>{try{return JSON.parse(workspace.storage.getItem(key))??fallback;}catch{return fallback;}}:readBrowser;
 const save=isolated?(key,value)=>{try{const text=JSON.stringify(value);workspace.storage.setItem(key,text);return workspace.storage.getItem(key)===text;}catch{return false;}}:saveBrowser;
 const isolatedPages=new Set(['workbench','strategies','execution','logs','assets']);
 if(isolated&&!isolatedPages.has(routePage(routeSearch()))){const u=new URL(location.href);u.searchParams.set('page','strategies');history.replaceState(null,'',u);}
 const initialWatchlist=watchlistRoute(routeSearch());if(initialWatchlist)history.replaceState(null,'',routeHref(initialWatchlist));
 const retiredWealth=wealthRoute(routeSearch());if(retiredWealth)history.replaceState(null,'',routeHref(retiredWealth));
 let marketDisplay='map',marketSurface='overview',marketSort='change',marketSearch='',marketFavorites=[];
 let disposeLayerTitle=null;
 let disposeActivity=()=>{},logActivityView='3d';
 let equityHistory=workspace.s.equityHistory||[10000],disposeCharts=()=>{},logQuery=new URLSearchParams(routeSearch()).get('order')||'',logSide='全部',strategyQuery='',petOpen=false;
 let page=routePage(routeSearch()),domain='Crypto',symbol='BTC',period='1H',metric='行情',feedFilter='全部',query='',logFilter='全部',strategyFilter='全部',step=1,pendingStart=false,elapsed=0,lastLedger='',lastContractStamp='';
 let tradingPreview=null,previewMarket='all',previewTab='positions',previewMode=false;
 const preview=()=>tradingPreview||(tradingPreview=new TradingPreview());
 const tradeData=()=>previewMode?preview().snapshot():desk.readSnapshot();
 const contractStamp=()=>{if(previewMode&&['execution','logs','assets'].includes(page))return 'preview:'+preview().revision;const data=desk.readSnapshot(),review=data?.state==='blocked'&&data.session?researchModel.handoff(data.session.market):null;return executionRenderStamp(data,desk.syncStatus(),review);};
 let watched=read('hive.product.watch',[]);if(!Array.isArray(watched))watched=[];
 let drafts=read('hive.product.strategies',[]);if(!Array.isArray(drafts))drafts=[];
 let setup={market:'BTC/USDT',mode:'auto',amount:100,cap:500,...read('hive.product.setup',{})};if(validateSetup(setup))setup={market:'BTC/USDT',mode:'auto',amount:100,cap:500};
 const navigation=createNavigationMemory(),viewStates=new Map();
 let localBanner=null;
 if(isolated){
  const banner=localBanner=document.createElement('section');banner.className='p-card local-sim-notice';banner.setAttribute('data-localized-ui','');
  const label=document.createElement('b');label.textContent=L('隔离本机模拟 · 无真实交易','Isolated local simulation · No live trading');
  const status=document.createElement('div');const showStatus=()=>{status.innerHTML=accessPanel(desk.access(),{compact:true});};showStatus();document.addEventListener('hive:access',showStatus);banner.append(label,status);
 }
 let currentSearch=routeSearch(),assistantReturn='?page=brain',pageAnimation=null,brainModule=null,brainAttempts=0;
 let historyView=readHistoryView(),returningHistory=null;
 const mobileLabel=item=>item[getLocale()]||item.en;
 const desktopLabel=item=>getLocale()==='en'?({workbench:'LensWave',strategies:'Agents',signals:'Signals',markets:'Data',assistant:'Chat'}[item.home]||item.en):L(item.name,item.en);
 function headerLabel(domain){
  const full=desktopLabel(domain),item=MOBILE_DOCK.find(entry=>entry.home===domain.home);
  const compact=item&&item.id!=='workbench'?mobileLabel(item):full;
  return '<span class="header-nav-name">'+esc(full)+'</span>'+(compact!==full?'<span class="header-nav-short">'+esc(compact)+'</span>':'');
 }
 const settingsButton=document.createElement('button');settingsButton.type='button';settingsButton.className='header-settings';settingsButton.setAttribute('data-localized-ui','');settingsButton.setAttribute('aria-label',L('个人中心','Account center'));settingsButton.title=L('个人中心','Account center');settingsButton.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>';settingsButton.onclick=()=>go('profile');document.querySelector('.topbar').append(settingsButton);if(!isolated)mountWalletEntry(document.querySelector('.topbar'),settingsButton);
 const nav=document.createElement('nav');nav.className='product-nav';nav.setAttribute('data-no-translate','');nav.setAttribute('aria-label',L('产品页面','Product navigation'));
 nav.innerHTML=DOMAINS.filter(d=>!['settings','usage'].includes(d.home)).map(d=>{
  const label=d.home==='assistant'?mobileLabel(ASSISTANT_NAV):desktopLabel(d);
  return `<a href="${routeHref('?page='+d.home)}" data-page="${d.home}" title="${esc(label)}">${d.home==='assistant'?assistantNavIcon+'<span>'+esc(label)+'</span>':headerLabel(d)}</a>`;
 }).join('')+'<a class="biz-credit-link" href="/usage" data-page="usage"><span class="credit-name"></span><span class="credit-short"></span> <b id="biz-credit-count"></b></a>';
 document.querySelector('.topbar').insertBefore(nav,document.querySelector('.simulation-badge'));
 const positionHeaderSelection=createDesktopNavigationSelection(nav);
 const assistantLink=nav.querySelector('[data-page="assistant"]');
 const creditLink=nav.querySelector('.biz-credit-link'),creditLabel=creditLink.querySelector('.credit-name'),creditShort=creditLink.querySelector('.credit-short'),creditValue=creditLink.querySelector('b');
 function syncCredits(){
  const account=workspace.account,label=L('AI 积分','AI credits');
  const confirmed=!account||Boolean(account.s.scope);
  const value=confirmed?workspace.available.toLocaleString('en-US'):'—';
  const display=confirmed&&account?.error?L('上次 ','Last ')+value:value;
  const status=confirmed?display:account.error?L('余额暂不可用','Balance unavailable'):L('正在读取余额','Loading balance');
  if(creditValue.textContent!==display)creditValue.textContent=display;
  if(creditLabel.textContent!==label)creditLabel.textContent=label;
  const shortLabel=L('积分','Credits');
  if(creditShort.textContent!==shortLabel)creditShort.textContent=shortLabel;
  const description=label+' · '+status;
  if(creditLink.title!==description){creditLink.title=description;creditLink.setAttribute('aria-label',description);}
 }
 syncCredits();
 workspace.account?.subscribe(syncCredits);
 const mobileNav=document.createElement('nav');mobileNav.className='biz-mobile-nav';mobileNav.setAttribute('data-localized-ui','');mobileNav.setAttribute('data-no-translate','');mobileNav.setAttribute('aria-label',L('手机产品导航','Mobile navigation'));
 document.body.append(mobileNav);
 const mobileNavigation=createMobileNavigation(mobileNav,{items:MOBILE_DOCK,onNavigate:(section,event)=>{if(interceptNavigation(event))openNavigation(section);}});
 const root=document.createElement('main');root.id='product-page';root.className='product-page';root.hidden=true;document.querySelector('.workspace').after(root);
 const closeInfo=bindInfoPopovers();
 bindSelectValues();
 createNumberInputs();
 bindCardEdges();
 let membershipRendering=false;
 const membershipHost=document.createElement('div');membershipHost.id='membership-app';
 const membership=createMembership({root:membershipHost,account:workspace.account,navigate:go,cancelExternalTask:ref=>workspace.cancelUsage(ref),onChange:()=>workspace.touch(),onRender:()=>{if(!membershipRendering&&['plans','topup','usage','staking','billing'].includes(page))render();else ensureMascot();},onNotice:notify});
 const accountCenter=createAccountCenter({root,account:workspace.account,navigate:(next,section)=>{go(next);if(section)root.querySelector('.ux-settings-index a[href="#'+section+'"]')?.click();},openWallet:()=>document.querySelector('.header-wallet .wallet-login')?.click(),onChange:()=>{if(page==='profile')render();}});
 let lastCommerceRevision=-1;
 const live=document.createElement('div');live.className='product-notice';live.setAttribute('role','status');live.setAttribute('aria-atomic','true');live.hidden=true;live.innerHTML=`<span class="product-notice-icon" aria-hidden="true"></span><span class="product-notice-message"></span><button type="button" class="product-notice-action" hidden></button><button type="button" class="product-notice-close">${uiGlyph('close')}</button>`;document.body.append(live);let noticeUntil=0,noticeOrigin=null,noticeRevision=0;
 const dismissNotice=()=>{const restore=live.contains(document.activeElement);live.hidden=true;if(restore&&noticeOrigin?.isConnected)noticeOrigin.focus();};
 live.querySelector('.product-notice-close').onclick=dismissNotice;
 document.addEventListener('close',event=>{if(event.target.contains?.(live))document.body.append(live);},true);
 const dialog=document.createElement('dialog');dialog.className='product-dialog product-flow-dialog';dialog.innerHTML=`<header class="p-dialog-head"><h2 id="product-dialog-title"></h2><button type="button" class="p-dialog-close" aria-label="${L('关闭详情','Close details')}">${uiGlyph('close')}</button></header><div class="p-dialog-body"></div>`;document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();
 let helpOrigin=null;
 const helpDialog=document.createElement('dialog');helpDialog.className='product-dialog ux-help-dialog';helpDialog.setAttribute('aria-labelledby','ux-help-title');document.body.append(helpDialog);
 const closeHelp=()=>helpDialog.close();
 document.addEventListener('click',ev=>{const b=ev.target.closest('[data-info]');if(!b||!b.closest('#product-page,.product-dialog'))return;ev.preventDefault();const help=helpContent(b.dataset.info);if(!help)return;helpOrigin=b;helpDialog.innerHTML=`<button type="button" class="p-dialog-close" aria-label="${L('关闭提示','Close help')}">${uiGlyph('close')}</button><h2 id="ux-help-title">${esc(help.title)}</h2>${help.body}<button class="p-button p-primary" data-help-close>${L('知道了','Got it')}</button>`;helpDialog.querySelectorAll('button').forEach(b=>b.onclick=closeHelp);helpDialog.showModal();});
 helpDialog.addEventListener('click',ev=>{if(ev.target===helpDialog){const r=helpDialog.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)closeHelp();}});
 helpDialog.addEventListener('close',()=>{if(helpOrigin?.isConnected)helpOrigin.focus();helpOrigin=null;});
 const brand=document.querySelector('.brand');brand.onclick=e=>{if(!interceptNavigation(e))return;const query=new URLSearchParams(routeSearch());if(query.get('page')!=='brain'||query.has('scope'))go('brain');};
 const skip=document.createElement('a');skip.className='product-skip';skip.setAttribute('data-localized-ui','');brand.before(skip);
 document.querySelector('.workspace').id='workbench-content';
 skip.onclick=event=>{if(interceptNavigation(event))focusView();};
 document.querySelector('.top-context').textContent='Lego AI Quant';
 for(const a of nav.children)a.onclick=e=>{
  if(!interceptNavigation(e))return;
  if(a===assistantLink)openNavigation('assistant');
  else if(routeSearch()!=='?page='+a.dataset.page)go(a.dataset.page);
 };
 const readingDetails='.bh-help details[data-persist-key]';
 function rememberView(search=currentSearch){
  dataCenter.capture();navigation.remember(search,root.scrollTop);
  const reading=[...root.querySelectorAll(readingDetails)].filter(el=>el.open).map(el=>el.dataset.persistKey);
  viewStates.set(search,{feedFilter,query,logQuery,logSide,logFilter,reading});
 }
 function restoreView(search){const state=viewStates.get(search);if(state)({feedFilter,query,logQuery,logSide,logFilter}=state);else{feedFilter='全部';query='';logQuery=new URLSearchParams(search).get('order')||'';}}
 function placeView(search,restoreTab){
  const reading=viewStates.get(search)?.reading,details=reading?[...root.querySelectorAll(readingDetails)]:[];
  for(const el of details)el.open=reading.includes(el.dataset.persistKey);
  root.scrollTop=search?navigation.position(search):0;
  if(root.scrollTop>0&&!root.hidden){
   const bounds=root.getBoundingClientRect();
   const visible=el=>{
    if(!el||el.closest('[inert],[hidden]'))return false;
    const r=el.getBoundingClientRect();
    return r.height>0&&r.width>0&&r.top>=bounds.top&&r.top<bounds.bottom&&r.left<bounds.right&&r.right>bounds.left&&getComputedStyle(el).visibility==='visible';
   };
   const target=details.filter(el=>el.open).map(el=>el.querySelector('summary')).find(visible)
      ||[...root.querySelectorAll('summary,a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].find(visible);
   if(target){target.focus({preventScroll:true});return;}
  }
  if(!restoreTab?.())focusView();
 }
 function openNavigation(section){rememberView();const search=navigation.target(section);if(search===routeSearch())return;go(routePage(search),{restore:true,search});}
 function animateNavigation(){
  pageAnimation?.cancel();
  pageAnimation=null;
  if(document.documentElement.dataset.reducedMotion==='true'||matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  const surface=page==='workbench'?document.getElementById('workbench-content'):root;
  pageAnimation=surface.animate?.([{opacity:.76},{opacity:1}],{duration:170,easing:'ease-out',id:'page-enter'});
 }
 function updateNavigation(){
  positionHeaderSelection();
  const section=mobileNavSection(page);
  const hrefFor=id=>id===section&&routeSearch()?routeSearch():restoreNavigationSearch(navigation.target(id),routeSearch());
  brand.href=routeHref(restoreNavigationSearch('?page=brain',routeSearch()));
  for(const link of nav.querySelectorAll('a[data-page]')){
   const href=routeHref(restoreNavigationSearch('?page='+link.dataset.page,routeSearch()));
   if(link!==assistantLink&&link.getAttribute('href')!==href)link.href=href;
  }
  assistantLink.href=routeHref(hrefFor('assistant'));assistantLink.title=L('AI 助手','AI Chat');
  assistantLink.setAttribute('aria-label',mobileLabel(ASSISTANT_NAV));
  mobileNavigation.update({section,hrefs:MOBILE_DOCK.map(item=>routeHref(hrefFor(item.id))),labels:MOBILE_DOCK.map(mobileLabel),label:L('手机产品导航','Mobile navigation'),reducedMotion:document.documentElement.dataset.reducedMotion==='true'});
  skip.href=page==='workbench'?'#workbench-content':'#product-page';skip.textContent=L('跳至主要内容','Skip to content');
 }
 function readHistoryView(){return {url:location.href,state:history.state,key:window.navigation?.currentEntry?.key};}
 function restoreBlockedHistory(){
  const expected=returningHistory=historyView;
  const recover=()=>{
   if(returningHistory!==expected)return;
   // shortcut: Older browsers recover as a new visit, losing the forward branch; native entry traversal preserves it when available.
   history.pushState(expected.state,'',expected.url);historyView=readHistoryView();returningHistory=null;
  };
  if(expected.key&&typeof window.navigation?.traverseTo==='function'){
   try{window.navigation.traverseTo(expected.key).finished.then(()=>{if(returningHistory!==expected)return;if(window.navigation.currentEntry?.key===expected.key&&location.href===expected.url)returningHistory=null;else recover();},recover);}
   catch{recover();}
  }else recover();
 }
 window.addEventListener('popstate',()=>{
  if(returningHistory){if(window.navigation?.currentEntry?.key===returningHistory.key&&location.href===returningHistory.url){historyView=readHistoryView();returningHistory=null;}return;}
  const issue=business.beforeLeave();if(issue){restoreBlockedHistory();notify(issue,{tone:'error'});return;}
  if(isolated&&(!isolatedPages.has(routePage(routeSearch()))||new URLSearchParams(routeSearch()).get('localSim')!==desk.syncStatus().scope.workspaceId)){location.reload();return;}
  workspace.privateDrafts?.leave();workspace.researchJobs?.leave();
  business.closeWatchlist();const legacyWatchlist=watchlistRoute(routeSearch());if(legacyWatchlist)history.replaceState(null,'',routeHref(legacyWatchlist));const retiredWealth=wealthRoute(routeSearch());if(retiredWealth)history.replaceState(null,'',routeHref(retiredWealth));
  rememberView();closeInfo();if(page==='assistant'){assistant.capture();assistant.closeSource();}else if(routePage(routeSearch())==='assistant')assistantReturn=currentSearch;
  const nextPage=routePage(routeSearch()),restoreTab=page===nextPage&&DATA_PAGES.includes(page)?captureDataTab(root,location.href):null;
  const moveChannel=page!==nextPage&&DATA_PAGES.includes(page)&&DATA_PAGES.includes(nextPage)?captureDataChannel(root):null;
  page=nextPage;restoreView(routeSearch());if(page==='validation')workspace.s.selectedValidation=new URLSearchParams(routeSearch()).get('check')||null;
  render();placeView(routeSearch(),restoreTab);moveChannel?.();if(legacyWatchlist)business.openWatchlist();
 });
 function notify(s,{tone='info',action=null,actionLabel=L('查看记录','View records')}={}){
  const revision=++noticeRevision;
  noticeOrigin=document.activeElement;noticeUntil=tone==='error'?0:performance.now()+8000;
  live.dataset.tone=tone;live.setAttribute('role',tone==='error'?'alert':'status');
  live.querySelector('.product-notice-message').textContent=friendlyText(s);
  live.querySelector('.product-notice-icon').innerHTML=tone==='success'?uiGlyph('check'):tone==='error'?'!':'i';
  const button=live.querySelector('.product-notice-action');button.hidden=!action;button.textContent=actionLabel;button.onclick=()=>{dismissNotice();action?.();};
  live.querySelector('.product-notice-close').setAttribute('aria-label',L('关闭通知','Dismiss notification'));
  const parent=[...document.querySelectorAll('dialog[open]')].filter(el=>el.getClientRects().length).at(-1)||document.body;if(live.parentElement!==parent)parent.append(live);live.hidden=false;
  return()=>{if(noticeRevision===revision)live.hidden=true;};
 }
 function go(id,context={}){
  if(returningHistory)return false;
  if(id===page&&DATA_PAGES.includes(id)&&routeSearch()==='?page='+id&&!Object.keys(context).length){
   const menu=root.querySelector('.layout-data-menu');
   if(menu?.open&&matchMedia('(max-width:900px)').matches){
    menu.open=false;menu.querySelector('summary')?.focus({preventScroll:true});
   }
   return;
  }
  if(isolated&&id&&!isolatedPages.has(id)&&id!=='my-strategies'){notify(L('此隔离工作区仅提供操作台、策略、运行和本账户记录。返回普通工作区后可使用其它功能。','This isolated workspace provides its control panel, strategies, runs and account records. Return to the regular workspace for other features.'));return;}
  if(id==='watchlist'||context.search&&watchlistRoute(context.search)){business.openWatchlist();return;}
  if(id==='staking')id='plans';
  if(id==='my-strategies')id='execution';
  if(id==='wealth'||context.search&&wealthRoute(context.search))id='workbench';
  if(id){const issue=business.beforeLeave();if(issue){notify(issue,{tone:'error'});return false;}}
  const currentRun=desk.readSnapshot();if(!context.restore&&['execution','logs','assets'].includes(id)&&hasActiveTrade(currentRun)){previewMode=false;save('hive.product.trade-preview',false);}
  closeInfo();membership.close();if(page==='assistant'){assistant.capture();assistant.closeSource();}
  if(!id){const y=root.scrollTop;render();root.scrollTop=y;return;}
  workspace.privateDrafts?.leave();workspace.researchJobs?.leave();
  business.closeWatchlist();
  rememberView();if(id==='assistant'&&page!=='assistant')assistantReturn=currentSearch;
  if(context.orderId){logQuery=context.orderId;logSide='全部';logFilter='全部';}else if(id==='logs'&&page!=='logs'&&!context.restore){logQuery='';logSide='全部';logFilter='全部';}
  dialog.close();if(!context.restore&&id!=='assistant')business.resetFilter();helpDialog.close();if(id!==page&&!context.restore){feedFilter='全部';query='';}
  const moveChannel=id!==page&&DATA_PAGES.includes(page)&&DATA_PAGES.includes(id)?captureDataChannel(root):null;
  page=id;const u=new URL(location.href);
  if(context.search){const retired=wealthRoute(context.search);u.search=restoreNavigationSearch(retired||context.search,u.search);}
  else{
   u.searchParams.set('page',id);u.searchParams.delete('scene');for(const key of ['strategy','asset','coin','metric','story','trader','view','scope','fund','exchange','chain','task','run','runId','ref','create','editor','privateDraft','sourceRequestId','researchSymbol'])u.searchParams.delete(key);
   if(id==='strategies'&&CATALOG.some(item=>item.id===context.create)){u.searchParams.set('create',context.create);if(typeof context.editor==='string'&&context.editor.length<=4096&&(context.editor===context.create||context.editor.startsWith(context.create+':')))u.searchParams.set('editor',context.editor);}
   if(id==='strategies'&&typeof context.privateDraft==='string'&&/^[A-Za-z0-9:_-]{1,96}$/.test(context.privateDraft)){u.searchParams.set('privateDraft',context.privateDraft);if(typeof context.sourceRequestId==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(context.sourceRequestId)&&['BTC','ETH','SOL'].includes(context.symbol)){u.searchParams.set('sourceRequestId',context.sourceRequestId);u.searchParams.set('researchSymbol',context.symbol);}}
   if(id==='execution'&&typeof context.runId==='string'&&context.runId.length<=128)u.searchParams.set('runId',context.runId);
   if(id==='logs'&&logQuery)u.searchParams.set('order',logQuery);else u.searchParams.delete('order');
   if(id==='validation'&&workspace.s.selectedValidation)u.searchParams.set('check',workspace.s.selectedValidation);else u.searchParams.delete('check');
  }
  if(isolated)u.searchParams.set('localSim',desk.syncStatus().scope.workspaceId);
  if(id!=='settings'&&u.hash.startsWith('#ux-'))u.hash='';
  if(context.restore)restoreView(u.search);
  const entryState=context.brainReturn?{brainReturn:context.brainReturn}:null;
  if(context.replace)history.replaceState(entryState,'',routeHref(u));else history.pushState(entryState,'',routeHref(u));render();placeView(context.restore?u.search:null);moveChannel?.();
  if(context.researchTaskId){const task=workspace.s.usage.find(u=>u.id===context.researchTaskId);if(task?.symbol)onOpenResearch?.(task.symbol);}
 }

 function focusView(){
  let target=root.querySelector('h1');
  if(page==='workbench'){
   const pane=matchMedia('(max-width:900px)').matches&&document.body.dataset.mobileView;
   target=document.querySelector(pane==='console'?'.console-panel':pane==='status'?'.status-panel':'.network-stage');
  }
  if(target?.closest('.layout-context-only')){
   const row=root.querySelector('.layout-navigation-row');
   target=row?.querySelector('.layout-data-menu:not([open])>summary,.layout-section-tabs [aria-current=page],.layout-section-tabs [aria-pressed=true]');
  }
  target||=root;if(!target.matches('button,a[href],summary,[tabindex]'))target.tabIndex=-1;target.focus({preventScroll:true});
 }
 let relatedController=null,disposeRelated=()=>{},dialogOrigin=null,dialogReturn=null,relatedReturn=null;
 function clearRelated(){relatedController?.abort();relatedController=null;disposeRelated();disposeRelated=()=>{};dialog.classList.remove('related-data-dialog');}
 dialog.addEventListener('close',()=>{if(dialog.open)return;clearRelated();const returnTo=dialogReturn;dialogReturn=null;if(returnTo)returnTo();else if(dialogOrigin?.isConnected)dialogOrigin.focus({preventScroll:true});dialogOrigin=null;});
 function show(title,body,onReturn){for(const slot of dialog.querySelectorAll('[data-live-research]'))if(!body.includes('data-live-research="'+slot.dataset.liveResearch+'"'))workspace.researchJobs?.leave(slot.dataset.liveResearch);clearRelated();if(!dialog.open){dialogOrigin=document.activeElement;dialogReturn=null;}if(typeof onReturn==='function')dialogReturn=onReturn;dialog.querySelector('.p-dialog-head h2').textContent=friendlyText(title);dialog.querySelector('.p-dialog-body').innerHTML=body;enhanceProductCopy(dialog);dialog.setAttribute('aria-labelledby','product-dialog-title');if(!dialog.open)dialog.showModal();}
 function askResearch(asset,title){
  if(workspace.research?.mode==='live_readonly'&&workspace.researchJobs){void workspace.researchJobs.open(asset);show(L('研究 ','Research ')+asset,workspace.researchJobs.render(asset));return;}
  show(L('研究 ','Research ')+asset,`<div data-localized-ui><p>${esc(title)}</p><p>${L('预留','Holds')} <b>${workspace.quote(8)} ${L('AI 积分','AI credits')}</b>${L('，完成后按实际使用结算。这次只做研究，不会下单。','; settled on completion. This task researches the asset and does not place an order.')}</p><button class="p-button p-primary" data-dc-confirm-research>${L('开始研究','Start research')}</button></div>`);
  dialog.querySelector('[data-dc-confirm-research]').onclick=async()=>{
   const err=await workspace.requestResearch(asset,{title,href:routeSearch()});
   if(err){notify(err,{tone:'error'});return;}
   onResearchStart?.();dialogReturn=null;dialog.close();go();notify(asset+' '+L('已加入研究，进度会在这里继续更新。','added to research. Progress will continue updating.'),{tone:'success',action:()=>business.openResearch(asset),actionLabel:L('查看进度','View progress')});
  };
 }
 function openRelatedData(href){
  if(typeof href!=='string'||!href.startsWith('?'))return false;
  const targetPage=new URLSearchParams(href).get('page');if(!DATA_PAGES.includes(targetPage))return false;
  const origin=relatedReturn||{search:routeSearch(),page};relatedReturn=origin;
  go(targetPage,{search:href});return true;
 }
 async function previewRelated(href,onReturn=null){
  const target=relatedAssetTarget(href);if(!target)return openRelatedData(href);
  show(target.symbol+' · '+L('行情快览','Market preview'),`<div class="related-empty" role="status">${L('正在读取行情…','Loading market data…')}</div>`);
  dialogReturn=onReturn;dialog.classList.add('related-data-dialog');const controller=new AbortController();relatedController=controller;
  let result;try{result=await dataCenter.previewAsset(target,controller.signal);}catch{if(controller.signal.aborted)return;result={state:'unavailable'};}
  if(controller.signal.aborted||!dialog.open||relatedController!==controller)return;
  const researchable=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'].includes(target.symbol);
  dialog.querySelector('.p-dialog-body').innerHTML=`<div data-localized-ui>${relatedAssetView(target,result)}<footer class="related-actions">${researchable?`<button type="button" class="p-button p-primary" data-related-research>${L('交给 AI 研究','Research with AI')}</button>`:''}<button type="button" class="p-button" data-related-full>${L('打开数据中心','Open data center')} ${uiGlyph('arrow')}</button></footer></div>`;
  dialog.querySelector('[data-related-full]').onclick=()=>openRelatedData(href);
  dialog.querySelector('[data-related-research]')?.addEventListener('click',()=>askResearch(target.symbol,target.symbol+' · '+L('行情快览','Market preview')));
  dialog.querySelector('[data-related-retry]')?.addEventListener('click',()=>previewRelated(href,onReturn));
  disposeRelated=mountCharts(dialog);enhanceProductCopy(dialog);
 }
 function relatedLink(href,onReturn=null){const params=new URLSearchParams(href);if(!DATA_PAGES.includes(params.get('page')))return false;void previewRelated(href,onReturn);return true;}
 window.addEventListener('hive:related-data',event=>relatedLink(event.detail?.href,event.detail?.onReturn));
 function renderRelatedReturn(){
  if(!relatedReturn||page==='assistant')return;if(!DATA_PAGES.includes(page)){relatedReturn=null;return;}
  const back=document.createElement('button');back.type='button';back.className='p-button related-return';back.innerHTML=uiGlyph('arrow')+L('返回','Back to')+' '+esc(({signals:L('AI 信号','AI signals'),strategies:new URLSearchParams(routeSearch()).has('create')?L('创建 Agent','Create Agent'):L('策略总览','Strategy overview'),execution:L('我的 Agent','My Agents')})[relatedReturn.page]||L('刚才的页面','previous page'));
  back.onclick=()=>{const origin=relatedReturn;relatedReturn=null;go(origin.page,{search:origin.search,restore:true,replace:true});};root.prepend(back);
 }
 function oldHeadline(title,sub,actions=''){return `<header class="p-head"><div><div class="p-eyebrow">HIVE / ${page.toUpperCase()} <b>SIM</b></div><h1>${title}</h1><p>${sub}</p></div><div class="p-actions">${actions}</div></header>`;}
 function headline(title,sub,actions=''){return pageHead(title,sub,actions,'GETTING STARTED');}
 function stats(items){return `<div class="p-stats">${items.map(([l,v,n])=>`<div><span>${l}</span><strong>${v}</strong><small>${n||''}</small></div>`).join('')}</div>`;}
 function filters(items,current,key){return `<div class="p-segments">${items.map(v=>btn(v,`data-filter="${key}" data-value="${v}" aria-pressed="${v===current}"`)).join('')}</div>`;}
 function marketPage(){return marketSurface==='overview'?marketOverview({domain,sort:marketSort,search:marketSearch,favorites:marketFavorites,view:marketDisplay}):`<button class="p-button ux-back" data-market-surface="overview">${L('← 市场总览','← Market overview')}</button>`+marketView({domain:domain==='All'?'Crypto':domain,symbol,period,metric});}
 function feedRows(kind){return INTELLIGENCE.filter(i=>feedFilter==='我的追踪'?true:kind==='tracking'?['chain','trend','volatility'].includes(i.source):['macro','social'].includes(i.source)).filter(i=>(feedFilter==='全部'||feedFilter==='我的追踪'&&watched.includes(i.id)||feedFilter==='链上'&&i.source==='chain'||feedFilter==='AI追踪'&&['trend','volatility'].includes(i.source)||feedFilter==='宏观'&&i.source==='macro'||feedFilter==='舆情'&&i.source==='social')&&`${i.symbol} ${i.title}`.toLowerCase().includes(query.toLowerCase()));}
 function feedPage(kind){return intelligenceExperience({kind,rows:feedRows(kind),watched,filter:feedFilter,query});}
 function feedCards(rows){return intelligenceRows(rows,watched,page);}
 function strategyPage(){return strategyView({filter:strategyFilter,drafts,query:strategyQuery});}
 function orderRows(d){return accountOrders(d).filter(o=>['全部','交易记录','策略操作'].includes(logFilter)||logFilter==='已成交'&&o.status==='filled'||logFilter==='在途'&&['partial','submitted','unknown'].includes(o.status)||logFilter==='已撤销'&&o.status.includes('cancel'));}
 const status=s=>({unknown:'回执未知 · 待对账',rejected:'已拒绝',filled:'已成交',partial:'部分成交',submitted:'已提交',cancelled:'已撤销','partial-cancelled':'部分成交后撤销'}[s]||s);
 function logsPage(){return statements.page(routeSearch());}
 function liveHoldingsPage(connections){
  const books=connectedAccountBalances(connections);if(!books.length)return '';
  const money=value=>Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const label=row=>row.kind==='wallet'?L('我的钱包','My wallet'):L('共享币安现货','Shared Binance spot');
  const unit=row=>row.basis==='equity'?'USDT eq.':'USDT';
  return `<div class="tc-root tc-assets" data-localized-ui><header class="p-head"><div><h1>${L('资产信息','Assets')}</h1><p>${L('钱包和共享币安现货分开显示。模拟盘的 10,000 不计入这里。','Wallet and shared Binance spot are shown separately. The 10,000 paper balance is not included.')}</p></div></header><section class="tc-balance-facts">${books.map(row=>`<div><span>${label(row)}</span><b>${money(row.equity)}</b><small>${unit(row)}</small></div>`).join('')}</section></div>`;
 }
 function assetsPage(){if(!previewMode){const live=liveHoldingsPage(desk.readSnapshot()?.connections);if(live)return live;}const d=tradeData(),scope=previewMode?'':scopeHeader(desk.syncStatus());return d?assetsView({d,equityHistory:desk.syncStatus().state==='LIVE'?equityHistory:[portfolio(d).equity]}).replace('</header>','</header>'+scope)+(previewMode?'':`<details class="ux-detail-rules"><summary>${L('查看成交与费用的原始记录','Original fills and fee records')}</summary>${ledgerPanel(d)}</details>`):scope+`<div class="contract-empty">${L('当前账户或环境尚无可读取资产。','No readable assets for this account or environment.')}</div>`;}
 function setupPage(){const steps=['观察范围','连接与模型','选择策略','风险与执行','确认并启动'];return headline('开始你的第一个协作任务','5 步了解工作方式。设置保存在本浏览器；不会接收真实 API Key 或连接真实交易账户。')+`<div class="setup-progress-heading"><span>设置进度</span><b>${step} / 5</b><small>选择 → 配置 → 核验 → 开跑</small></div><ol class="p-stepper">${steps.map((s,i)=>`<li class="${step===i+1?'active':step>i+1?'done':''}"><b>${i+1}</b><span>${s}</span></li>`).join('')}</ol><div class="p-setup-grid">${card(`${String(step).padStart(2,'0')} / ${steps[step-1]}`,step===1?`<p>AI 协作台同时观察 Crypto 与 TradFi。这里选择优先研究的资产；六组独立协作持续推进。</p><div class="setup-market-options">${[['BTC','Bitcoin'],['ETH','Ethereum'],['SOL','Solana']].map(([k,l])=>`<button data-setup-market="${k}/USDT" aria-pressed="${setup.market===k+'/USDT'}"><b>${k}</b><span>${l}</span><small>现货 / USDT</small></button>`).join('')}</div><label class="p-field">模拟盘口<select id="setup-market">${['BTC/USDT','ETH/USDT','SOL/USDT'].map(m=>`<option ${setup.market===m?'selected':''}>${m}</option>`).join('')}</select></label><p class="p-footnote">TradFi 在市场页观察，本轮不开放 TradFi 下单。</p>`:step===2?`<div class="p-setup-connections">${[['exchange','模拟账户 · 10,000 USDT'],['data','研究数据 · 固定样例'],['ai','18 个角色 · 无真实模型调用'],['notifications','站内执行通知']].map(([k,s])=>`<div>${desk.snapshot().connections[k]?'✓':'○'} <span>${s} · ${desk.snapshot().connections[k]?'已启用示例':'已关闭'}</span></div>`).join('')}</div>${btn('检查连接与预算','data-settings')}<p class="p-footnote">底部连接配置在所有页面可用；设置中的关闭状态会阻止模拟启动。</p>`:step===3?`<h3>S03 · 均线 + RSI</h3><p>观察收盘趋势与动量，独立核对反证、敞口、保护及执行条件。</p><div class="p-modules">${['趋势','动量','仓位','退出','风控'].map(tag).join('')}</div><p class="p-footnote">本轮用预设信号演示完整交互；不声称已运行真实 S03 指标。其余策略可在广场复制研究草稿。</p>`:step===4?`<label class="p-field">执行方式<select id="setup-mode">${[['auto','Agent 自动执行'],['signal','只观察并提醒']].map(([v,l])=>`<option value="${v}" ${setup.mode===v?'selected':''}>${l}</option>`).join('')}</select></label><div class="p-two"><label class="p-field">单笔 / USDT<input id="setup-amount" type="number" min="10" max="1000" value="${setup.amount}"></label><label class="p-field">总敞口上限 / USDT<input id="setup-cap" type="number" min="10" max="3000" value="${setup.cap}"></label></div><p class="p-footnote">自主模拟最多 3 个信号后暂停。分歧或研究版本变化会阻止新增风险，暂停保留已成交持仓。</p>`:`<dl class="p-report"><div><dt>盘口 / 策略</dt><dd>${setup.market} / S03</dd></div><div><dt>执行方式</dt><dd>${{confirm:'逐笔确认',signal:'仅信号',auto:'自主模拟'}[setup.mode]}</dd></div><div><dt>单笔 / 敞口上限</dt><dd>${setup.amount} / ${setup.cap} USDT</dd></div></dl><p>完成设置后开始多组研究。候选汇总后，从资产详情交给操作台，再按这里的参数启动模拟。</p><p class="p-footnote">有真实阻断会显示原因；不会绕过核验。刷新不会自动重启。</p>`)}${card('你的 Agent 如何工作',`<div class="p-vertical-flow">${['采集 · 技术 / 宏观 / 舆情 / 链上','核验 · 去重、出处与独立反证','决策 · 条件、失效与 A/B/C 预案','执行 · 规则信号与独立风险检查','复盘 · 委托、成交与资产对账'].map((s,i)=>`<div><i>${i+1}</i><span>${s}</span></div>`).join('')}</div>`)}</div><div class="p-setup-bottom"><p id="setup-feedback" role="status">${pendingStart?'正在等待研究完成…':'草稿仅保存在本浏览器'}</p><div>${step>1?btn('上一步','data-prev'):''}${btn(step===5?'完成并开始研究':'保存并继续','data-next',true)}</div></div>`;}
 if(page==='validation')workspace.s.selectedValidation=new URLSearchParams(routeSearch()).get('check')||null;
 const shell=createProductShell({workspace,desk,go,research:researchModel,resize});
 const dataCenter=createDataCenter({root,account:createPrivateWatchAccountAdapter(workspace),watchStorage:workspace.storage,rerender:render,notify,onSaveWatch:(asset,remove)=>business.saveWatch(asset,remove),beforeNavigate:rememberView,onRelatedLink:relatedLink,onAskSource:source=>{if(assistant.accept(source))go('assistant');},onResearch:askResearch,onNewsDelivery:item=>{
  if(page==='intelligence'&&newsPilot)newsCourier?.offer(item);
 }});
 workspace.onError=message=>notify(message,{tone:'error'});
 const assistant=createTradingAssistant({getTeamContext,root,account:workspace.account,getWatchKeys:()=>workspace.s.aiSignalWatch,refresh:render,go,notify,returnTo:()=>assistantReturn,signalSource:()=>business.signalSource(),context:()=>({available:workspace.available,reserved:workspace.reserved,spent:workspace.spent,researchCost:workspace.quote(8)})});
 const business=createBusinessPages({workspace,desk,research:researchModel,onHandoff,onResearchStart,go,notify,show,root});
 const statements=createStatements({desk,root,dialog,show,navigate:go,notify,storage:workspace.storage});
 mountAIOperator({desk,notify,onNavigate:id=>{if(['execution','logs','assets'].includes(id)){previewMode=false;save('hive.product.trade-preview',false);}go(id);},onPlan:()=>{
  const trade=desk.readSnapshot();
  if(trade?.discovery?.armed||trade?.session&&trade.state!=='stopped'||trade?.position||trade?.pending){
   previewMode=false;save('hive.product.trade-preview',false);go('execution');
   const settings=root.querySelector('.execution-settings');if(settings){settings.open=true;settings.querySelector('summary')?.focus({preventScroll:true});settings.scrollIntoView({block:'nearest'});}return;
  }
  const draft=workspace.draft();if(!draft){go('advisor');return;}go('my-strategies');business.openSelectedStrategy(draft.mode);
 },onAsk:prompt=>{go('assistant');if(prompt.trim())return assistant.compose(prompt);return true;}});
 desk.configure(workspace.draft());
 window.addEventListener('beforeunload',event=>{if(business.beforeLeave()){event.preventDefault();event.returnValue='';return;}workspace.tick(0,desk.snapshot());workspace.persist();});
 // The companion uses the active data source; a click never starts research or spends credits.
 let petCursor=-1,petContext='',petRendered='',petBrief=null,petMotion=null;
 const companionPreference='hive.product.companion-enabled';
 let petEnabled=read(companionPreference,true)!==false,petMenuOpen=false;
 const newsMotionPreference='hive.product.news-courier-enabled';
 let newsMotionEnabled=read(newsMotionPreference,true)!==false,newsPilot=false,newsCourier=null;
 const signalMotionPreference='hive.product.signal-courier-enabled';
 let signalMotionEnabled=read(signalMotionPreference,true)!==false,signalCourier=null;
 let newsDelivered=null,openedStory=null,newsUnread=false;
 let briefPaint=0,newsRequest=null,newsKey='',generalNews=null,newsTimer=null;
 function refreshBrief(){
  if(briefPaint||!petOpen||document.hidden)return;
  briefPaint=requestAnimationFrame(()=>{briefPaint=0;if(petOpen&&!document.hidden)ensureMascot();});
 }
 const companionMarket=createCompanionMarket({onChange:refreshBrief});
 function stopGeneralNews(){
  newsRequest?.abort();newsRequest=null;clearTimeout(newsTimer);newsTimer=null;newsKey='';generalNews=null;
 }
 function stopBriefFeed(){companionMarket.stop();stopGeneralNews();}
 function selectGeneralNews(cursor){
  const locale=getLocale(),key=locale+':'+cursor;
  if(newsKey===key)return;
  stopGeneralNews();newsKey=key;
  async function refresh(){
   const controller=new AbortController();newsRequest=controller;
   try{
    const brief=await readCompanionNews({cursor,locale,signal:controller.signal});
    if(newsRequest!==controller)return;
    generalNews=brief;refreshBrief();
   }catch{
    if(newsRequest!==controller||controller.signal.aborted)return;
    generalNews={kind:'status',label:L('市场快讯','Market news'),modeLabel:'',title:L('快讯暂不可用','News temporarily unavailable'),body:'',visual:'',source:'',timestamp:null,href:'?page=intelligence',action:L('查看快讯','View news')};
    refreshBrief();
   }finally{
    if(newsRequest===controller){newsRequest=null;newsTimer=setTimeout(refresh,60000);}
   }
  }
  void refresh();
 }

 function setCompanionEnabled(enabled,fromMenu=false){
  petEnabled=enabled;const stored=save(companionPreference,enabled);closeCompanion();
  const setting=root.querySelector('[data-companion-enabled]');setting?.setAttribute('aria-checked',String(enabled));
  ensureMascot();
  if(fromMenu){(document.querySelector('.header-wallet .wallet-login.is-authenticated')||settingsButton).focus({preventScroll:true});notify(L('页面助手已关闭，可在设置中重新开启。','Page companion hidden. Turn it back on in Settings.'),{action:()=>go('settings'),actionLabel:L('打开设置','Open settings')});}
  if(!stored)notify(L('显示偏好已在本页生效，浏览器未能保存。','Applied for this page, but the browser could not save your preference.'),{tone:'error'});
 }
 function companionBrief(){
  if(newsPilot&&openedStory){
   const brief=newsDeliveryBrief(openedStory);
   if(openedStory.quality==='stale')brief.label=L('缓存快讯','Cached story');
   else if(openedStory.record_id!==newsDelivered?.record_id)brief.label=L('本页快讯','Current story');
   return brief;
  }
  if(['plans','topup','usage','staking','billing'].includes(page)){
   const account=workspace.account,p=currentPlan(account.s),cost=estimate('R2',account.s.plan,account.payers).normal;
   const items=[{title:L('充值不要求订阅','Top-ups are available to everyone'),body:'$10 = 10,000 Credit',href:'?page=topup',action:L('看看充值','Review top-up')},{title:L('这次研究先看报价','Check the task price first'),body:`${p.name} · ≈${cost} Credit`,href:'?page=usage',action:L('查看我的用量','View my usage')}];
   return {kind:'analysis',label:L('账户小提示','Account tip'),...items[Math.max(0,petCursor)%items.length],visual:'',source:'',timestamp:null};
  }
  const publicBrief=dataCenter.companionBrief(petCursor,page);
  const newsEmpty=newsPilot&&root.querySelector('#pd-feed-panel .df-timeline :is(.df-calm,.pd-empty)');
  if(!newsEmpty&&publicBrief&&(!newsPilot||publicBrief.kind!=='news'))return publicBrief;
  if(DATA_PAGES.includes(page)){
   const sample=!!root.querySelector('.dc-root:not([data-public-data])');
   const emptyTitle=newsEmpty&&(newsEmpty.querySelector('strong')||newsEmpty.firstChild)?.textContent.trim();
   return {kind:'status',label:newsPilot?L('快讯','Headlines'):L('数据中心','Data center'),
    modeLabel:sample?L('示例','Sample'):L('数据状态','Data status'),
    title:emptyTitle||(newsPilot?L('暂无可递送的快讯','No stories available to deliver'):sample?L('当前视图使用示例数据','This view uses sample data'):L('暂无可用数据','No data available')),
    body:newsEmpty?newsEmpty.querySelector('p')?.textContent.trim()||'':'',visual:'',source:'',timestamp:null,href:sample?'?page='+page+'&data=live':'',action:L('查看公开数据','View public data')};
  }
  const sequence=Math.max(0,petCursor),round=Math.floor(sequence/3),kind=sequence%3;
  if(kind===1){
   companionMarket.stop();selectGeneralNews(round);
   return generalNews||{kind:'status',label:L('市场快讯','Market news'),modeLabel:L('公开数据','Public data'),title:L('正在读取最新快讯…','Loading the latest headlines…'),body:'',visual:'',source:'',timestamp:null,href:'',action:''};
  }
  stopGeneralNews();
  const requested=new URLSearchParams(routeSearch()).get('asset');
  const symbols=[...new Set([requested,'BTC','ETH','SOL','BNB'].filter(symbol=>Object.hasOwn(HUB_ASSET_IDS,symbol)))];
  companionMarket.select(symbols[round%symbols.length]);
  return companionMarket.brief(kind===2);
 }
 function closeCompanion(returnFocus=false){
  stopBriefFeed();petOpen=false;petMenuOpen=false;const pocket=document.getElementById('hive-mascot');if(!pocket)return;
  pocket.classList.remove('open');pocket.querySelector('.mascot-speech').hidden=true;
  pocket.querySelector('.mascot-menu').hidden=true;
  pocket.querySelector('.mascot-trigger').setAttribute('aria-expanded','false');
  pocket.querySelector('.mascot-trigger').setAttribute('aria-controls',page==='signals'?'mascot-actions':'mascot-speech');
  pocket.dataset.mood=companionMood(page);
  petMotion?.layout();
  if(returnFocus)pocket.querySelector('.mascot-trigger').focus({preventScroll:true});
 }
 function ensureMascot(){
  let pocket=document.getElementById('hive-mascot');
  const context=page+routeSearch();
  const dataPatrol=DATA_PAGES.includes(page)&&!!root.querySelector('.dc-root');
  newsPilot=page==='intelligence'&&!!root.querySelector('[data-public-data=intelligence] #pd-feed-panel[aria-labelledby=pd-tab-news]');
  const onSignals=page==='signals'&&!!root.querySelector('.sig-tracking')||page==='opportunities'&&!!root.querySelector('.biz-op-layout');
  if(!dataPatrol||!newsMotionEnabled||!petEnabled||petContext!==context){newsCourier?.dispose();newsCourier=null;}
  if(!onSignals||!signalMotionEnabled||!petEnabled||petContext!==context){signalCourier?.dispose();signalCourier=null;}
  if(!petEnabled||page==='workbench'||page==='brain'||page==='strategies'&&new URLSearchParams(routeSearch()).has('privateDraft')){stopBriefFeed();petOpen=false;petMotion?.dispose();petMotion=null;pocket?.remove();return;}
  if(petContext!==context){stopBriefFeed();petCursor=-1;petContext=context;petOpen=false;petMenuOpen=false;petRendered='';openedStory=null;}
  if(!pocket){
   pocket=document.createElement('div');pocket.id='hive-mascot';pocket.className='mascot-pocket';pocket.setAttribute('data-localized-ui','');
   pocket.innerHTML=`<button type="button" class="mascot-trigger" aria-expanded="false" aria-controls="mascot-speech"><span class="mascot-orb" aria-hidden="true"><i></i><i></i></span><span class="mascot-paper" aria-hidden="true"><span></span><span></span></span><span class="mascot-hand mascot-hand-left" aria-hidden="true"></span><span class="mascot-hand mascot-hand-right" aria-hidden="true"></span></button><div class="mascot-speech" id="mascot-speech" hidden><div class="pet-kicker"></div><button type="button" class="pet-close">${uiGlyph('close')}</button><div class="pet-content" tabindex="0" aria-live="polite" aria-atomic="true"></div><div class="pet-footer"><a class="pet-detail"></a><button type="button" class="pet-next"></button><button type="button" class="pet-ask">${L('问 AI','Ask AI')}</button></div></div><div class="mascot-menu" role="menu" hidden><button type="button" role="menuitem" data-companion-hide></button></div>`;
   const next=()=>{
    openedStory=newsPilot?dataCenter.currentNewsStory(newsDelivered?.record_id):null;
    if(newsPilot)newsUnread=false;
    petMenuOpen=false;petCursor++;petOpen=true;ensureMascot();
    pocket.classList.remove('responding');void pocket.offsetWidth;pocket.classList.add('responding');
   };
   pocket.querySelector('.mascot-trigger').addEventListener('click',()=>{
    if(page!=='signals'&&page!=='opportunities'){next();return;}
    if(petMenuOpen)closeCompanion(true);else menu();
   });
   pocket.querySelector('.mascot-orb').addEventListener('animationend',e=>{if(e.animationName==='companion-ack')pocket.classList.remove('responding');});
   const menu=()=>{stopBriefFeed();petOpen=false;petMenuOpen=true;ensureMascot();pocket.querySelector('.mascot-menu button:not([hidden])').focus({preventScroll:true});};
   pocket.querySelector('.mascot-menu').id='mascot-actions';
   pocket.querySelector('.mascot-trigger').addEventListener('contextmenu',e=>{e.preventDefault();menu();});
   pocket.querySelector('.mascot-trigger').addEventListener('keydown',e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();menu();}});
   pocket.querySelector('[data-companion-hide]').addEventListener('click',()=>setCompanionEnabled(false,true));
   const optionsButton=document.createElement('button');optionsButton.type='button';optionsButton.className='news-delivery-options';optionsButton.textContent='⋯';optionsButton.setAttribute('aria-haspopup','menu');optionsButton.hidden=true;optionsButton.onclick=menu;pocket.querySelector('.pet-close').before(optionsButton);
   const motionButton=document.createElement('button');motionButton.type='button';motionButton.dataset.newsCourierToggle='';motionButton.setAttribute('role','menuitem');motionButton.hidden=true;pocket.querySelector('.mascot-menu').prepend(motionButton);
   motionButton.onclick=()=>{
    let stored;
    if(page==='signals'||page==='opportunities'){signalMotionEnabled=!signalMotionEnabled;stored=save(signalMotionPreference,signalMotionEnabled);}
    else{newsMotionEnabled=!newsMotionEnabled;newsUnread=false;stored=save(newsMotionPreference,newsMotionEnabled);}
    closeCompanion(true);ensureMascot();
    if(!stored)notify(L('偏好仅在当前页面生效','Preference applies to this session'));
   };
   pocket.querySelector('.mascot-menu').addEventListener('keydown',e=>{
    if(e.key==='Tab'){closeCompanion(true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    const buttons=[...e.currentTarget.querySelectorAll('button:not([hidden])')],index=buttons.indexOf(document.activeElement);
    e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
   });
   pocket.querySelector('.pet-next').addEventListener('click',()=>{
    if(newsPilot&&openedStory){closeCompanion(true);newsCourier?.replay(openedStory);}else next();
   });
   pocket.querySelector('.pet-ask').addEventListener('click',()=>{
    const brief=petBrief;if(!brief||brief.kind==='status')return;
    const source=brief.askSource??{id:'companion:'+petCursor,title:brief.title,
     text:[brief.title,brief.body,brief.source,brief.timestamp,brief.external?brief.href:''].filter(Boolean).join(' · '),
     href:brief.external?'?page=intelligence':brief.href,kind:brief.kind==='news'?'news':'excerpt'};
    if(assistant.accept(source)){closeCompanion();if(page==='assistant')render();else go('assistant');}
   });
   pocket.querySelector('.pet-close').addEventListener('click',()=>closeCompanion(true));
   pocket.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeCompanion(true);}});
   pocket.querySelector('.pet-detail').addEventListener('click',e=>{
    if(e.currentTarget.target==='_blank'||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    e.preventDefault();const url=new URL(e.currentTarget.href);closeCompanion();go(routePage(url.search),{search:url.search});
   });
   document.body.append(pocket);petRendered='';
   petMotion=mountCompanionMotion(pocket);
  }
  pocket.classList.remove('in-header','layout-action-group');
  if(pocket.parentElement!==document.body)document.body.append(pocket);
  const speech=pocket.querySelector('.mascot-speech'),trigger=pocket.querySelector('.mascot-trigger');
  const optionsButton=pocket.querySelector('.news-delivery-options'),motionButton=pocket.querySelector('[data-news-courier-toggle]');
  pocket.toggleAttribute('data-news-received',newsPilot&&newsMotionEnabled&&newsUnread);
  optionsButton.hidden=!dataPatrol;optionsButton.setAttribute('aria-label',L('巡查选项','Patrol options'));
  motionButton.hidden=!dataPatrol&&!onSignals;motionButton.toggleAttribute('data-signal-courier-toggle',onSignals);
  motionButton.textContent=onSignals?(signalMotionEnabled?L('暂停信号巡查','Pause signal patrol'):L('恢复信号巡查','Resume signal patrol')):(newsMotionEnabled?L('暂停数据巡查','Pause data patrol'):L('恢复数据巡查','Resume data patrol'));
  pocket.classList.toggle('open',petOpen);speech.hidden=!petOpen;
  pocket.querySelector('.mascot-menu').hidden=!petMenuOpen;
  pocket.querySelector('.mascot-menu').setAttribute('aria-label',L('页面助手','Page companion'));
  pocket.querySelector('[data-companion-hide]').textContent=L('关闭页面助手','Hide page companion');
  const accountPage=['plans','topup','usage','staking','billing'].includes(page);
  trigger.setAttribute('aria-expanded',String(onSignals?petMenuOpen:petOpen||dataPatrol&&petMenuOpen));
  trigger.setAttribute('aria-controls',onSignals||dataPatrol&&petMenuOpen?'mascot-actions':'mascot-speech');
  if(onSignals)trigger.setAttribute('aria-haspopup','menu');else trigger.removeAttribute('aria-haspopup');
  trigger.setAttribute('aria-label',onSignals?L('大白 · 信号巡查选项','Signal patrol options'):newsPilot?L('大白 · 快讯与采集选项','News companion and collection options'):dataPatrol?L('大白 · 数据简报与巡查选项','Data brief and patrol options'):L('点我，带来一条新情报','Bring me another insight'));
  trigger.title=onSignals?L('信号巡查选项','Signal patrol options'):L('点击查看内容，右键可关闭','Click for insights; right-click to hide');
  trigger.setAttribute('aria-keyshortcuts','Shift+F10');
  const brief=petOpen&&!document.hidden?companionBrief():null;
  const key=brief?JSON.stringify([petCursor,getLocale(),brief]):'';
  if(brief&&key!==petRendered){
   const newCard=brief.title!==petBrief?.title||brief.kind!==petBrief?.kind;
   petBrief=brief;pocket.dataset.brief=brief.kind;
   pocket.dataset.mood=companionMood(page,brief.kind);
    speech.querySelector('.pet-kicker').innerHTML=`<b>${esc(brief.label)}</b>${brief.modeLabel===''?'':'<span>'+esc(brief.modeLabel??L('本页','Page'))+'</span>'}`;
    const content=speech.querySelector('.pet-content');content.setAttribute('aria-live',brief.askSource&&brief.kind!=='news'?'off':'polite');content.innerHTML=`<h3${newsPilot&&openedStory?' data-no-translate':''}>${esc(brief.title)}</h3>${brief.visual}${brief.body?'<p>'+esc(brief.body)+'</p>':''}${brief.source||brief.timestamp?'<small>'+[brief.source,brief.timestamp].filter(Boolean).map(esc).join(' · ')+'</small>':''}`;if(newCard)content.scrollTop=0;
   const detail=speech.querySelector('.pet-detail');if(brief.href)detail.href=brief.href;else detail.removeAttribute('href');
   detail.textContent=brief.action;detail.hidden=!brief.href||accountPage&&brief.href==='?page='+page;
   if(brief.external||dataPatrol&&brief.href&&detail.origin!==location.origin){detail.target='_blank';detail.rel='noopener noreferrer';}else{detail.removeAttribute('target');detail.removeAttribute('rel');}
   const nextButton=speech.querySelector('.pet-next');
   nextButton.textContent=newsPilot&&openedStory?L('重看递送','Replay delivery'):L('再来一条 ↻','Another one ↻');
   nextButton.hidden=brief.kind==='status'&&dataPatrol||newsPilot&&(!newsMotionEnabled||!openedStory||!root.querySelector('[data-news-record="'+CSS.escape(openedStory.record_id)+'"]'));
   speech.querySelector('.pet-ask').textContent=L('问 AI','Ask AI');
   speech.querySelector('.pet-close').setAttribute('aria-label',L('收起情报','Close insight'));
   petRendered=key;
  }
  speech.querySelector('.pet-ask').hidden=accountPage||petBrief?.kind==='status';
  if(!petOpen)pocket.dataset.mood=companionMood(page);
  if(dataPatrol&&!petOpen&&!petMenuOpen)petMotion?.requestLayout?.();
  else petMotion?.layout();
  if(dataPatrol&&newsMotionEnabled){
   newsCourier??=mountNewsCourier(root,pocket,item=>{
    if(!newsPilot||petContext!==context||!newsMotionEnabled||!item?.record_id)return;
    newsDelivered=item;newsUnread=true;pocket.setAttribute('data-news-received','');
    pocket.classList.remove('responding');void pocket.offsetWidth;pocket.classList.add('responding');
   });
   newsCourier.layout();
  }
  if(onSignals&&signalMotionEnabled){
   signalCourier??=mountSignalCourier(root,pocket);
   signalCourier.layout();
  }
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopBriefFeed();else if(petOpen)refreshBrief();});
 window.addEventListener('pagehide',stopBriefFeed);
 window.addEventListener('pageshow',()=>{if(petOpen)refreshBrief();});
 window.addEventListener('resize',ensureMascot,{passive:true});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(petOpen||petMenuOpen))closeCompanion(true);});
 document.addEventListener('pointerdown',e=>{const pocket=document.getElementById('hive-mascot');if((petOpen||petMenuOpen)&&pocket&&!pocket.contains(e.target))closeCompanion();});
 document.addEventListener('input',e=>{if(e.target.closest?.('.chat-composer'))ensureMascot();});
 function mountBrainView(locale){
  const view=document.createElement('astarter-brain');
  view.dataset.locale=locale;
  view.dataset.view='cortexa';
  view.setAttribute('data-localized-ui','');
  root.replaceChildren(view);
  if(customElements.get('astarter-brain'))return;
  const panel=document.createElement('section'),message=document.createElement('span');
  panel.className='brain-page-status';
  message.setAttribute('role','status');
  message.textContent=L('正在加载链上深脑…','Loading Deep Brain…');
  panel.append(message);
  view.append(panel);
  if(!brainModule){
   const attempt=brainAttempts++;
   brainModule=(attempt?import('./brain-observatory.mjs?retry='+attempt):import('./brain-observatory.mjs')).catch(error=>{
    brainModule=null;
    throw error;
   });
  }
  brainModule.catch(()=>{
   if(!view.isConnected||page!=='brain')return;
   panel.classList.add('is-error');
   message.textContent=L('链上深脑加载失败。','Deep Brain could not load.');
   const retry=document.createElement('button');
   retry.type='button';
   retry.className='p-button';
   const reload=brainAttempts>1;
   retry.textContent=reload?L('重新加载页面','Reload page'):L('重试','Retry');
   retry.onclick=()=>{
    if(reload){location.reload();return;}
    root.tabIndex=-1;
    root.focus({preventScroll:true});
    mountBrainView(getLocale());
   };
   panel.append(retry);
  });
 }
 function render(){
  if(returningHistory||workspace.privateDrafts?.holdRender())return;
  const previousPage=root.dataset.renderedPage,previousSearch=currentSearch;
  renderPage();
  if(previousPage&&(previousPage!==page||previousSearch!==currentSearch))animateNavigation();
 }
 function renderPage(){
  if(page==='intelligence'){
   const current=currentIntelligenceRoute(routeSearch());
   if(current)history.replaceState(history.state,'',routeHref(current+location.hash));
  }
  const previousPage=root.dataset.renderedPage;
  if(previousPage&&previousPage!==page){
   dialogReturn=null;dialogOrigin=null;if(dialog.open)dialog.close();
   if(helpDialog.open){helpOrigin=null;closeHelp();}
   document.dispatchEvent(new CustomEvent('hive:page-leave',{detail:previousPage}));
   // The workbench uses a separate root. Release the hidden Brain iframe and its quote subscriptions.
   if(previousPage==='brain'&&page==='workbench')root.querySelector('astarter-brain')?.remove();
  }
  const retainedTabs=page===previousPage&&DATA_PAGES.includes(page)&&currentSearch===routeSearch()?readDataTabScroll(root):null;
  historyView=readHistoryView();const samePage=previousPage===page,restoreFocus=samePage?captureProductFocus(root):()=>{};root.dataset.renderedPage=page;const openSections=new Set(samePage?[...root.querySelectorAll("details[open]")].map(el=>el.dataset.persistKey||el.querySelector("summary")?.textContent):[]);disposeLayerTitle?.();disposeLayerTitle=null;disposeActivity();disposeCharts();document.body.dataset.page=page;document.body.toggleAttribute('data-agent-creation',page==='strategies'&&CATALOG.some(item=>item.id===new URLSearchParams(routeSearch()).get('create')));const dataBadge=document.querySelector('.simulation-badge');if(dataBadge){const readOnlyData=page==='workbench'&&document.body.dataset.researchMode==='live_readonly'||hubOwnsRoute(page,routeSearch())||!!liveDataRoute(page,routeSearch())||(page==='intelligence'&&new URLSearchParams(routeSearch()).get('data')!=='demo')||(page==='markets'&&new URLSearchParams(routeSearch()).get('data')==='live'),description=readOnlyData?L('模拟交易','Simulated trading')+' · '+L('只读数据与交易隔离','Read-only data stays separate'):L('演示数据','Demo data')+' · '+L('仅供界面体验','UI preview only');dataBadge.innerHTML='<i></i><b data-no-translate>'+ (readOnlyData?'SIM':'DEMO')+'</b>';dataBadge.setAttribute('title',description);dataBadge.setAttribute('aria-label',description);}shell.render(page);const section=DOMAINS.find(d=>d.pages.includes(page));settingsButton.setAttribute('aria-pressed',String(['profile','logs','settings','plans','topup','usage','billing'].includes(page)));for(const a of nav.children)a.setAttribute('aria-current',a.dataset.page===section?.home?'page':'false');updateNavigation();currentSearch=routeSearch();const work=page==='workbench';document.querySelector('.workspace').hidden=!work;root.hidden=work;syncSiteMeta(page,getLocale(),routeSearch());if(page==='brain'){
   delete root.dataset.layout;
   const locale=getLocale();
   if(!root.querySelector('astarter-brain')||root.firstElementChild.dataset.locale!==locale)mountBrainView(locale);
   ensureMascot();return;
  }
  if(work){
   // The mounted LensWave DOM survives navigation even when its render clock is paused.
   updateBrainEntry(document.querySelector('.pw-runtime-heading .brain-entry'));
   accountCenter.decorate(page);composeProduct(root,page);decorateBento(root,page);unifyProductLayout(root,page);ensureMascot();resize();return;}const tradeSection=tradingSection(page);const sub=['strategies','execution','logs'].includes(page)?'':tradeSection?`<nav class="biz-subnav trading-nav" data-localized-ui aria-label="${L('策略交易','Strategy Agents')}">${TRADING_TABS.map(item=>`<button type="button" data-go="${item.id}" aria-current="${tradeSection===item.id?'page':'false'}" aria-label="${L(item.zh,item.en)}"><span class="trading-tab-long">${L(item.zh,item.en)}</span><span class="trading-tab-short" aria-hidden="true">${item.id==='execution'?L('交易','Trade'):item.id==='strategies'?L('策略','Strategies'):L('记录','History')}</span></button>`).join('')}</nav>`:page==='setup'||page==='assistant'||!section?'':`<nav class="biz-subnav" aria-label="当前分区">${(section.navPages||section.pages).filter(id=>id!=='setup').map(id=>`<button type="button" data-go="${id}" aria-current="${id===page?'page':'false'}">${({settings:L('连接设置','Connections'),risk:L('资金保护','Protection'),mandate:L('交易方式','Trading mode'),usage:L('用量','Usage'),plans:L('订阅','Subscription'),topup:L('充值','Top up'),staking:L('质押奖励','Staking'),billing:L('账单','Billing')})[id]||t(PAGES.find(p=>p[0]===id)?.[1])}</button>`).join('')}</nav>`;if(['plans','topup','usage','staking','billing'].includes(page)){root.innerHTML=sub;root.append(membershipHost);membershipRendering=true;try{membership.render(page);}finally{membershipRendering=false;}lastCommerceRevision=workspace.account.revision;root.querySelectorAll('.biz-subnav [data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));composeProduct(root,page);decorateBento(root,page);unifyProductLayout(root,page);membership.setHeader(root.querySelector('.layout-heading-actions'));accountCenter.decorate(page);restoreFocus();ensureMascot();return;}root.innerHTML=sub+(page==='profile'?accountCenter.render():page==='assistant'?assistant.render():(dataCenter.render(page)??business.render(page)??(page==='markets'?marketPage():page==='tracking'||page==='intelligence'?feedPage(page):page==='logs'?logsPage():assetsPage())));if(!isolated&&page==='assets')root.querySelector('.p-head')?.insertAdjacentHTML(previewMode?'afterend':'beforeend',previewToolbar(previewMode));enhanceProductCopy(root);composeProduct(root,page);for(const el of root.querySelectorAll("details"))if(openSections.has(el.dataset.persistKey||el.querySelector("summary")?.textContent))el.open=true;decorateBento(root,page,{account:['execution','logs','assets'].includes(page)?tradeData():desk.readSnapshot(),credits:workspace});renderRelatedReturn();bind();if(page!=='assistant'){business.bind();dataCenter.bind();if(!root.querySelector('[data-public-data]'))assistant.decorate(page);}if(root.querySelector('.bh-root'))delete root.dataset.layout;else unifyProductLayout(root,page,retainedTabs);disposeLayerTitle=mountSweepingTitle(root.querySelector('.bh-overview-hero .lw-dot-face'));disposeCharts=mountCharts(root);disposeActivity=mountTradeActivity(root,{onPick:next=>{logQuery=next.query;logSide=next.side;logFilter=next.filter;render();root.querySelector('#log-query')?.focus({preventScroll:true});},onViewChange:mode=>{logActivityView=mode;}});if(page==='assistant')assistant.bind();mountReference(root);accountCenter.decorate(page);if(['execution','logs','assets'].includes(page))lastContractStamp=contractStamp();if(localBanner)root.prepend(localBanner);restoreFocus();ensureMascot();}

 async function researchItem(item,market){const err=await research(market,item);if(err){notify(err);return;}notify(item?`${item.type}已加入本轮采集，等待汇聚与筛选。`:'已开始研究此盘口。');}
 function applyPreviewAction(id,action){
  let issue;try{issue=preview().action(id,action);}catch(error){issue=error.message;}
  if(issue){notify(issue,{tone:'error'});return;}
  const y=root.scrollTop;render();root.scrollTop=y;notify(L('示例已更新','Example updated'));return true;
 }
 function bindPreview(){
  root.querySelectorAll('[data-preview-mode]').forEach(b=>b.onclick=()=>{if(isolated)return;previewMode=b.dataset.previewMode==='examples';logQuery='';logFilter='全部';render();});
  root.querySelectorAll('[data-preview-market]').forEach(b=>b.onclick=()=>{previewMarket=b.dataset.previewMarket;render();});
  root.querySelectorAll('[data-preview-tab]').forEach(b=>b.onclick=()=>{previewTab=b.dataset.previewTab;render();});
  root.querySelectorAll('[data-preview-action]').forEach(b=>b.onclick=()=>{
   const action=b.dataset.previewAction,id=b.dataset.previewId;
   if(action==='reset'){tradingPreview=new TradingPreview();render();notify(L('示例数据已重新载入','Examples reloaded'));return;}
   if(action==='position'){const detail=previewPositionDetail(preview().snapshot(),id);if(detail)show(L('模拟持仓','Example position'),detail);return;}
   if(action==='review-close'||action==='stop'){
    const data=preview().snapshot(),detail=previewPositionDetail(data,id)||'',closing=action==='review-close';
    show(L(closing?'确认模拟平仓':'停止示例策略',closing?'Close example position':'Stop example strategy'),detail+`<p>${L(closing?'按当前示例价格平仓，结果会更新到持仓和交易日志。':'停止后不再运行这套示例策略，已有持仓保留。',closing?'Close at the example price and update positions and trade history.':'Stop this example strategy and keep its existing position.')}</p><button type="button" class="p-button p-primary" data-preview-confirm>${L(closing?'确认模拟平仓':'确认停止',closing?'Close example position':'Stop example strategy')}</button>`);
    dialog.querySelector('[data-preview-confirm]').onclick=()=>{if(applyPreviewAction(id,closing?'close':'stop'))dialog.close();};return;
   }
   applyPreviewAction(id,action);
  });
 }
 function bind(){
 const companionSetting=root.querySelector('[data-companion-enabled]');if(companionSetting){companionSetting.setAttribute('aria-checked',String(petEnabled));companionSetting.onclick=()=>setCompanionEnabled(!petEnabled);}
 bindPreview();root.querySelectorAll('[data-market-display]').forEach(b=>b.onclick=()=>{marketDisplay=b.dataset.marketDisplay;render();});root.querySelectorAll('[data-market-surface]').forEach(b=>b.onclick=()=>{marketSurface=b.dataset.marketSurface;render();});root.querySelectorAll('[data-market-watch]').forEach(b=>b.onclick=()=>{const k=b.dataset.marketWatch;marketFavorites=marketFavorites.includes(k)?marketFavorites.filter(x=>x!==k):[...marketFavorites,k];render();});const ms=root.querySelector('#market-search');if(ms)ms.onchange=()=>{marketSearch=ms.value;render();};const so=root.querySelector('#market-sort');if(so)so.onchange=()=>{marketSort=so.value;render();};root.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));root.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{const {filter,value}=b.dataset;if(filter==='domain'){domain=value;symbol=value==='TradFi'?'SPX':'BTC';}if(filter==='period')period=value;if(filter==='metric')metric=value; if(filter==='feed')feedFilter=value;if(filter==='logs')logFilter=value;if(filter==='strategies')strategyFilter=value;render();});root.querySelectorAll('[data-symbol]').forEach(b=>b.onclick=()=>{symbol=b.dataset.symbol;domain=ASSETS.find(a=>a[0]===symbol)?.[2]||'Crypto';marketSurface='chart';render();});root.querySelector('[data-research-market]')?.addEventListener('click',()=>researchItem(null,domain==='TradFi'?symbol:symbol+'/USDT'));
 root.querySelectorAll('[data-setup-market]').forEach(b=>b.onclick=()=>{capture();setup.market=b.dataset.setupMarket;render();});
 for(const [selector,set]of [['#strategy-query',v=>strategyQuery=v],['#log-query',v=>logQuery=v]]){const input=root.querySelector(selector);if(input)bindSearchRender(input,set,()=>{render();return root.querySelector(selector);});}
 root.querySelector('#log-side')?.addEventListener('change',e=>{logSide=e.target.value;render();});
 root.querySelectorAll('[data-strategy-detail]').forEach(b=>b.onclick=()=>{const s=STRATEGIES.find(s=>s[0]===b.dataset.strategyDetail);show(s[1],`<div class="detail-summary">${tag(s[0]+' / v0.1')} ${tag(s[0]==='S03'?'可交互模拟':'研究模板')}<p>${s[2]}</p></div><ol class="research-path">${['观察：明确市场、周期与数据口径','核验：检查入场条件与独立反证','保护：先确定单笔、总仓位和失效条件','执行：通过核验后运行预设模拟','复盘：按委托、成交和手续费对账'].map((t,i)=>`<li><span>0${i+1}</span><b>${t}</b></li>`).join('')}</ol><div class="quiet-callout">${s[0]==='S03'?'当前 S03 使用预设信号，未运行真实指标或 Nautilus 引擎。':s[0]==='S01'||s[0]==='S02'?'已接到已核对的币安现货账户，交易对 BTC/USDT。保存方案记在这个账户上，不会从这里发单。':'此模板尚未接入执行，不能直接下单。'} 未提供未经验证的收益、回撤或胜率。</div>`);});
 root.querySelector('#feed-query')?.addEventListener('input',e=>{query=e.target.value;root.querySelector('#feed-results').innerHTML=feedCards(feedRows(page));bindFeed();});bindFeed();
 root.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>{const id=b.dataset.copy;if(!drafts.includes(id)){const next=[...drafts,id];if(!save('hive.product.strategies',next)){notify('草稿保存失败');return;}drafts=next;render();}const s=STRATEGIES.find(s=>s[0]===id);show(s[1]+' · 个人草稿',`<p>已保存模板 ${id} / v0.1。${s[2]}</p><p>版本、周期、入场、退出、仓位、失效及验证记录需在执行前齐备。</p><p>${id==='S03'?'可通过初始设定体验预设信号模拟。':'此策略尚无执行适配；保存草稿不会启动交易。'}</p>`);});
 root.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>{if(previewMode){const detail=previewOrderDetail(preview().snapshot(),b.dataset.order);if(detail)show(b.dataset.order,detail);return;}const data=desk.readSnapshot();if(!data)return;const o=accountOrders(data).find(o=>o.id===b.dataset.order);if(!o)return;show(o.id,`<dl class="p-report">${Object.entries({运行:o.runId,交易对:o.market,状态:status(o.status),方向:o.side==='buy'?'买入':'卖出',成交数量:(o.status==='unknown'?'待对账':(o.qty*o.filled).toFixed(8))+' '+o.market.split('/')[0],成交价:o.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' USDT',手续费:o.fee.toFixed(4)+' USDT'}).map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`);});
 root.querySelector('[data-export]')?.addEventListener('click',e=>{const d=tradeData(),kind=e.currentTarget.dataset.export,data=kind==='logs'?{filter:logFilter,records:tradeLogEntries({d,rows:orderRows(d),filter:logFilter,query:logQuery,side:logSide})}:previewMode?{...portfolio(d),positions:d.positions}:portfolio(d);const url=URL.createObjectURL(new Blob([JSON.stringify({mode:'simulation-only',scope:previewMode?'example-portfolio':'current-page-session',...data},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`hive-${kind}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已生成本次会话的 JSON 导出。');});
 root.querySelector('[data-settings]')?.addEventListener('click',()=>desk.settings());root.querySelector('[data-prev]')?.addEventListener('click',()=>{capture();step--;render();});root.querySelector('[data-next]')?.addEventListener('click',async()=>{capture();const err=validateSetup(setup);if(err){root.querySelector('#setup-feedback').textContent=err;return;}if(!save('hive.product.setup',setup)){root.querySelector('#setup-feedback').textContent='本浏览器无法保存草稿，请检查存储权限。';return;}if(step<5){step++;render();return;}const error=await research(setup.market);if(error){root.querySelector('#setup-feedback').textContent=error;return;}desk.configure(setup);pendingStart=false;go('workbench');document.body.dataset.mobileView='network';notify('配置已保存，各组开始研究；从候选详情交给操作台后启动模拟。');});}
 function bindFeed(){root.querySelectorAll('[data-watch]').forEach(b=>b.onclick=()=>{const id=b.dataset.watch,next=watched.includes(id)?watched.filter(x=>x!==id):[...watched,id];if(!save('hive.product.watch',next)){notify('追踪保存失败');return;}watched=next;render();});root.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>{const i=INTELLIGENCE.find(i=>i.id===b.dataset.detail);show(i.title,`<p>${i.detail}</p><dl class="p-report"><div><dt>来源</dt><dd>本地 ${i.source} 示例</dd></div><div><dt>样本日期</dt><dd>2026-10-24 ${i.time}</dd></div><div><dt>证据编号</dt><dd>${i.id}</dd></div><div><dt>核验职责</dt><dd>A${String(i.role+1).padStart(2,'0')}</dd></div></dl><p>${i.reason}</p>`);});root.querySelectorAll('[data-intel]').forEach(b=>b.onclick=()=>{const i=INTELLIGENCE.find(i=>i.id===b.dataset.intel);researchItem(i,i.symbol+'/USDT');});}
 function capture(){for(const k of ['market','mode','amount','cap']){const el=root.querySelector('#setup-'+k);if(el)setup[k]=['amount','cap'].includes(k)?Number(el.value):el.value;}}
 document.addEventListener('click',event=>{
  const link=event.composedPath().find(node=>node.dataset?.brainRoute);
  if(!link||!interceptNavigation(event))return;
  const destination=link.dataset.brainRoute;
  if(destination==='brain')go(destination,{search:brainEntrySearch()});
  else if(link.closest('astarter-brain[data-view=cortexa]'))go(destination,{brainReturn:brainEntrySearch(routeSearch())});
  else go(destination);
 });
 document.addEventListener('hive:navigate',e=>{if(PAGES.some(p=>p[0]===e.detail))go(e.detail);});
 document.addEventListener('hive:configure-strategy',event=>{if(!workspace.draft()){go('advisor');return;}business.openSelectedStrategy(event.detail?.mode);});
 document.addEventListener('hive:locale',()=>{
  for(const a of nav.querySelectorAll('[data-page]')){
   const d=DOMAINS.find(x=>x.home===a.dataset.page);
   if(a===assistantLink)a.querySelector('span').textContent=mobileLabel(ASSISTANT_NAV);
   else if(a.dataset.page==='usage')syncCredits();
   else if(d){a.innerHTML=headerLabel(d);a.title=desktopLabel(d);}
  }
  nav.setAttribute('aria-label',L('产品页面','Product navigation'));mobileNav.setAttribute('aria-label',L('手机产品导航','Mobile navigation'));settingsButton.setAttribute('aria-label',L('个人中心','Account center'));settingsButton.title=L('个人中心','Account center');const y=root.scrollTop;render();root.scrollTop=y;
 });
 document.addEventListener('hive:access',()=>{if(page!=='workbench'&&!document.querySelector('dialog[open]')&&canAutoRefresh(root))render();});
 render();if(initialWatchlist)queueMicrotask(()=>business.openWatchlist());return {go,openPrivateDraft:input=>go('strategies',{privateDraft:input.draftId,sourceRequestId:input.sourceRequestId,symbol:input.symbol}),openResearchStrategy:business.openResearchStrategy,tick(dt){business.tick(dt);shell.tick(dt);dataCenter.tick(page,dt);elapsed+=dt;if(noticeUntil&&performance.now()>noticeUntil&&!live.contains(document.activeElement)&&!live.matches(':hover'))live.hidden=true;if(pendingStart&&(model.runId!==pendingStart.runId||document.body.dataset.stopped==='true'&&!model.completed)){pendingStart=false;notify('原配置的启动等待已取消，请按当前研究重新启动。');}if(pendingStart&&evidenceProcess(model).ready){pendingStart=false;notify(desk.start()||'研究核验完成，模拟已启动。可在操作台处理信号。');}if(elapsed>1){elapsed=0;if(!workspace.account)syncCredits();statements.tick();if(page==='execution'&&!previewMode)patchExecutionPrices(root,desk.readSnapshot(),desk.syncStatus());if(['plans','topup','usage','staking','billing'].includes(page)&&workspace.account.revision!==lastCommerceRevision&&!document.querySelector('dialog[open]')&&canAutoRefresh(root)){const y=root.scrollTop;render();root.scrollTop=y;}if((page!=='execution'||lastContractStamp!==contractStamp())&&business.isPage(page)&&!petOpen&&canAutoRefresh(root)&&!document.querySelector('dialog[open]')&&(['execution','validation','opportunities','inbox','mandate'].includes(page)||page==='signals'&&!root.querySelector('.sig-tracking')||page==='setup'&&business.setupLive)){const y=root.scrollTop;render();root.scrollTop=y;}if(page==='assets'&&lastContractStamp!==contractStamp()&&!petOpen&&!document.querySelector('dialog[open]')&&canAutoRefresh(root))render();const d=desk.snapshot(),sig=JSON.stringify([d.seq,d.cash,d.position?.markPrice?.toFixed(2),d.orders.map(o=>o.status)]);if(sig!==lastLedger){lastLedger=sig;const eq=portfolio(d).equity;if(eq!==equityHistory.at(-1)){equityHistory.push(eq);workspace.s.equityHistory=equityHistory;}}}}};
}
