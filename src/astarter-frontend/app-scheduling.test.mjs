import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {MultiResearch,RESEARCH_GROUPS,PHASE_NAMES} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {reauthenticateWalletProfile} from './wallet-entry.mjs';
import {researchSharedDetail,researchPublicDetail} from './research-board.js';
import {getLocale} from './locale.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {DATA_PAGES} from './data-center-fixtures.mjs';

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const render=app.slice(app.indexOf('function renderUI(){'),app.indexOf('function startRun('));
const board=readFileSync(new URL('./research-board.js',import.meta.url),'utf8');
const update=board.slice(board.indexOf(' function update(){'),board.indexOf('\n update();return'));

const product=readFileSync(new URL('./product.js',import.meta.url),'utf8');
test('all six data channels retain their own patrol while Spectrum, navigation and preferences release inactive crews',()=>{
 const gate=product.slice(product.indexOf(' function ensureMascot(){'),product.indexOf('  if(petContext!==context)'))+'}\nensureMascot();';
 const cases=[['workbench',true,true],['workbench',true,false],['assistant',true,true],['strategies',true,true],['assistant',false,true],['signals',true,true],['signals',false,true],['signals',true,true,false],['opportunities',true,true],['opportunities',true,true,false],['signals',true,true,true,true,false],['strategies',true,true,true,true,true,true,true]];
 for(const page of DATA_PAGES)cases.push([page,true,true],[page,false,true],[page,true,true,true,false],[page,true,true,true,true,false],[page,true,true,true,true,true,false]);
 for(const [page,enabled,existing,signalEnabled=true,dataEnabled=true,sameRoute=true,hasContent=true,draft=false] of cases){
  const removed=!enabled||page==='workbench'||draft,search=draft?'?page='+page+'&privateDraft=draft-1':'?page='+page;
  let disposals=0,removals=0,courierDisposals=0,patrolDisposals=0;
  const motion={dispose(){disposals++;}},pocket={remove(){removals++;}};
  const courier={dispose(){courierDisposals++;}};
  const patrol={dispose(){patrolDisposals++;}};
  let stopped=0;
  const context={stopBriefFeed(){stopped++;},petOpen:true,page,DATA_PAGES,routeSearch:()=>search,URLSearchParams,petContext:sameRoute?page+search:'previous',petEnabled:enabled,petMotion:existing?motion:null,newsCourier:courier,newsPilot:false,newsMotionEnabled:dataEnabled,signalMotionEnabled:signalEnabled,signalCourier:patrol,
   root:{querySelector:()=>hasContent?pocket:null},document:{getElementById:id=>{assert.equal(id,'hive-mascot');return existing?pocket:null;}}};
  runInNewContext(gate,context);
  assert.equal(stopped,removed?1:0);
  assert.equal(disposals,removed&&existing?1:0);assert.equal(removals,removed&&existing?1:0);
  assert.equal(context.petMotion,removed?null:motion);assert.equal(context.petEnabled,enabled,'page navigation must not change the saved assistant preference');
  const activeData=DATA_PAGES.includes(page)&&enabled&&dataEnabled&&sameRoute&&hasContent;
  assert.equal(courierDisposals,activeData?0:1);assert.equal(context.newsCourier,activeData?courier:null);
  const activeSignals=['signals','opportunities'].includes(page)&&enabled&&signalEnabled&&hasContent&&sameRoute;
  assert.equal(patrolDisposals,activeSignals?0:1);assert.equal(context.signalCourier,activeSignals?patrol:null);
 }
});

test('a data channel without a usable brief shows its own status and respects news filters',()=>{
 const source=product.slice(product.indexOf(' function companionBrief(){'),product.indexOf(' function closeCompanion('))+'\ncompanionBrief();';
 const brief=(page,live,{sample=false,message='',body=''}={})=>runInNewContext(source,{page,DATA_PAGES,petCursor:0,openedStory:null,newsPilot:page==='intelligence',L:(zh,en)=>en,dataCenter:{companionBrief:()=>live},
  root:{querySelector:s=>s.startsWith('.dc-root')?sample:message?{firstChild:{textContent:message},querySelector:tag=>tag==='p'&&body?{textContent:body}:null}:null}});
 const actual={kind:'data',title:'Public report',body:'Updated'};
 for(const page of DATA_PAGES){
  assert.equal(brief(page,actual),actual);
  const unavailable=brief(page,null);assert.equal(unavailable.kind,'status');assert.equal(unavailable.href,'');assert.equal(unavailable.timestamp,null);
 }
 const filtered=brief('intelligence',{kind:'news',title:'Story outside of the current filter'},{message:'No matching stories'});assert.equal(filtered.title,'No matching stories');assert.equal(filtered.href,'');
 const pending=brief('intelligence',actual,{message:'Loading headlines',body:'Fetching the latest stories'});assert.equal(pending.title,'Loading headlines');assert.equal(pending.body,'Fetching the latest stories');
 const sample=brief('etf',null,{sample:true});assert.equal(sample.modeLabel,'Sample');assert.equal(sample.href,'?page=etf&data=live');
});

test('data patrols acknowledge a news article only when it reaches the current news companion',()=>{
 const code=product.slice(product.indexOf('  if(dataPatrol&&newsMotionEnabled){'),product.indexOf('  if(onSignals&&signalMotionEnabled){'));
 const item={record_id:'published-story'},attrs=[],route='intelligence?page=intelligence';let received;
 const state={dataPatrol:true,newsMotionEnabled:true,newsPilot:false,newsCourier:null,context:route,petContext:route,newsDelivered:null,newsUnread:false,root:{},
  pocket:{setAttribute:key=>attrs.push(key),classList:{add(){},remove(){}}},mountNewsCourier(root,pocket,onReceived){received=onReceived;return {layout(){}};}};
 runInNewContext(code,state);assert.deepEqual(attrs,[]);
 received(item);assert.equal(state.newsUnread,false,'another data channel cannot manufacture a news receipt');
 state.newsPilot=true;state.petContext='intelligence?page=intelligence&view=calendar';received(item);assert.deepEqual(attrs,[]);
 state.petContext=route;state.newsMotionEnabled=false;received(item);assert.deepEqual(attrs,[]);
 state.newsMotionEnabled=true;received({});assert.deepEqual(attrs,[]);
 received(item);assert.deepEqual(attrs,['data-news-received']);assert.equal(state.newsDelivered,item);assert.equal(state.newsUnread,true);
});

test('photonic updates shared pause state and research details without touching the hidden legacy UI',()=>{
 const controls=new Map(['play-pause','step','stop-run'].map(id=>[id,{setAttribute(k,v){this[k]=v;}}]));
 const document={body:{dataset:{}}},model={elapsed:12.3,key:'liquidity',config:{actors:[1,2]},phase:2};
 const before=JSON.stringify(model);let detailUpdates=0;
 const context={document,model,paused:true,stopped:false,active:{market:'BTC/USDT'},version:2,dirty:()=>false,workbenchView:'photonic',research:{time:42.5},globe:{fps:60,drawCalls:7},
  $:id=>{assert.ok(controls.has(id),`hidden legacy node queried: ${id}`);return controls.get(id);},
  researchBoard:{update(){detailUpdates++;}},renderMotionActivity(){assert.fail('hidden activity must not render');}};
 runInNewContext(render+';renderUI();',context);
 assert.equal(document.body.dataset.paused,'true');assert.equal(document.body.dataset.researchTime,'42.50');
 assert.equal(controls.get('play-pause')['aria-pressed'],'true');assert.equal(controls.get('step').disabled,false);assert.equal(detailUpdates,1);
 context.paused=false;runInNewContext('renderUI()',context);
 assert.equal(controls.get('play-pause')['aria-pressed'],'false');assert.equal(controls.get('step').disabled,true);assert.equal(detailUpdates,2);
 assert.equal(JSON.stringify(model),before);
});

test('hidden research cards stay untouched while an open detail and pause control remain current',()=>{
 let paint=0,detail=0;const step={},dialog={open:false};
 const context={document:{body:{dataset:{paused:'true',workbenchView:'photonic'}}},step,dialog,
  paintPause(){paint++;},updateDetail(){detail++;},research:{summary(){assert.fail('hidden board must not render');}}};
 runInNewContext(update+';update();',context);assert.equal(step.hidden,false);assert.equal(detail,0);
 dialog.open=true;runInNewContext('update()',context);assert.equal(detail,1);assert.equal(paint,2);
 context.document.body.dataset.workbenchView='agents';let resumed=false;
 context.research.summary=()=>{resumed=true;throw new Error('visible board render reached');};
 assert.throws(()=>runInNewContext('update()',context),/visible board render reached/);assert.equal(resumed,true);
});

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const preload=html.match(/<script id="app-preload-controller">([\s\S]*?)<\/script>/)?.[1];
function loadingFixture({reduced=false,appReduced=false,locale='zh',storageBlocked=false}={}){
 const classes=new Set(),bodyClasses=new Set(['app-loading']),timers=new Map(),events=new Map(),scriptEvents=new Map(),retryEvents=new Map();
 let now=0,next=0,reloads=0;
 const label={textContent:''},retry={hidden:true,addEventListener:(name,fn)=>retryEvents.set(name,fn)};
 const root={isConnected:true,inert:false,classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},remove(){this.isConnected=false;},querySelector:s=>s==='[data-load-label]'?label:retry};
 const skip={focus(){context.document.activeElement=skip;}};
 const window={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 const context={window,document:{getElementById:()=>root,querySelector:s=>s==='.product-skip'?skip:({addEventListener:(name,fn)=>scriptEvents.set(name,fn)}),body:{classList:{remove:name=>bodyClasses.delete(name)}}},
  localStorage:{getItem(){if(storageBlocked)throw Error('storage blocked');return locale;},setItem(){assert.fail('loading must not change stored preferences');}},location:{search:appReduced?'?motion=reduced':'',reload(){reloads++;}},URLSearchParams,matchMedia:()=>({matches:reduced}),
  performance:{now:()=>now},requestAnimationFrame:fn=>context.setTimeout(fn,16),
  setTimeout(fn,ms){const id=++next;timers.set(id,{at:now+ms,fn});return id;},clearTimeout:id=>timers.delete(id)};
 assert.ok(preload,'inline controller must be available before the module graph loads');runInNewContext(preload,context);
 return {root,label,retry,skip,document:context.document,classes,bodyClasses,events,scriptEvents,controller:window.__appPreload,get reloads(){return reloads;},retryLoad(){retryEvents.get('click')();},
  advance(ms){const end=now+ms;for(;;){const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>end)break;timers.delete(entry[0]);now=entry[1].at;entry[1].fn();}now=end;}};
}

test('a visible startup intro releases the page on readiness, before its brief exit completes',()=>{
 const f=loadingFixture();f.advance(199);assert.equal(f.classes.has('present'),false);
 f.advance(1);assert.equal(f.classes.has('present'),true);
 assert.equal(f.bodyClasses.has('app-loading'),true);assert.equal(f.root.inert,false);
 f.controller.done();
 assert.equal(f.bodyClasses.has('app-loading'),false);assert.equal(f.root.inert,true);
 assert.equal(f.root.isConnected,true);f.advance(180);
 assert.equal(f.root.isConnected,false);assert.equal(f.events.has('error'),false);
 f.controller.done();f.controller.fail();f.advance(15000);assert.equal(f.retry.hidden,true);
 assert.match(app,/initLocale\(\);\s*requestAnimationFrame\(\(\)=>\{[\s\S]*?window\.__appPreload\?\.done\(/);
 assert.doesNotMatch(html,/构建协作空间|INITIALIZING NETWORK|class="loading-state"/);
});

test('a fast startup never flashes the intro or delays interactivity',()=>{
 const f=loadingFixture();f.advance(190);f.controller.done();
 assert.equal(f.bodyClasses.has('app-loading'),false);assert.equal(f.root.isConnected,false);
 f.controller.done();f.advance(15000);
 assert.equal(f.classes.has('present'),false);assert.equal(f.retry.hidden,true);
});

test('ready data and signal views dismiss even a visible loader in the same frame',()=>{
 const f=loadingFixture();f.advance(250);assert.equal(f.classes.has('present'),true);
 f.controller.done({immediate:true});
 assert.equal(f.bodyClasses.has('app-loading'),false);assert.equal(f.root.isConnected,false);
 assert.match(app,/immediate:DATA_PAGES.includes\(page\)\|\|page==='signals'\|\|page==='opportunities'/);
});

test('slow loading offers reload and still allows eventual successful startup',()=>{
 const f=loadingFixture({locale:'en'});f.advance(15000);
 assert.equal(f.label.textContent,'Taking longer than usual');assert.equal(f.retry.hidden,false);assert.equal(f.classes.has('attention'),true);assert.equal(f.classes.has('present'),true);
 f.retryLoad();assert.equal(f.reloads,1);assert.equal(f.bodyClasses.has('app-loading'),true);
 f.document.activeElement=f.retry;f.controller.done();assert.equal(f.document.activeElement,f.skip);
 assert.equal(f.retry.hidden,true);assert.equal(f.classes.has('attention'),false);f.advance(180);
 assert.equal(f.root.isConnected,false);assert.equal(f.bodyClasses.has('app-loading'),false);
});

test('module and startup errors keep a usable retry without exposing the unfinished page',()=>{
 for(const error of ['module','runtime']){
  const f=loadingFixture({storageBlocked:true});(error==='module'?f.scriptEvents:f.events).get('error')();
  assert.equal(f.label.textContent,'Unable to load. Try again.');assert.equal(f.retry.hidden,false);assert.equal(f.classes.has('present'),true);f.advance(20000);
  assert.equal(f.label.textContent,'Unable to load. Try again.');assert.equal(f.root.isConnected,true);assert.equal(f.bodyClasses.has('app-loading'),true);
  f.retryLoad();assert.equal(f.reloads,1);
 }
});

test('reduced motion reveals the ready page immediately and all existing locales have startup copy',()=>{
 for(const locale of ['zh','en','ja','ko','vi','es','fr','ru']){
  const f=loadingFixture({reduced:true,locale});assert.ok(f.label.textContent);assert.ok(f.retry.textContent);
  f.controller.done();assert.equal(f.root.isConnected,false);assert.equal(f.bodyClasses.has('app-loading'),false);
  f.advance(15000);assert.equal(f.retry.hidden,true);
 }
 const f=loadingFixture({appReduced:true});assert.equal(f.classes.has('reduce'),true);
 f.controller.done();assert.equal(f.root.isConnected,false);assert.equal(f.bodyClasses.has('app-loading'),false);
 assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(html,/<div id="app-preload" role="status" aria-live="polite"/);
});


test('research details lead with readable evidence while preserving record identity in disclosure',()=>{
 const research=new MultiResearch();research.advance(145);
 const task=research.task('ETH'),before=JSON.stringify(research),meta={},title={};
 let markup='',record={open:false},focusRestores=0;
 const body={get innerHTML(){return markup;},set innerHTML(value){markup=value;record={open:false};},querySelector:()=>record};
 const buttons=['recheck','handoff','shared'].map(action=>({dataset:{detailAction:action}}));
 const context={research,live:false,researchJobs:null,source:null,selected:'ETH',detailSig:'',RESEARCH_GROUPS,PHASE_NAMES,pair:(zh)=>zh,captureProductFocus:()=>()=>{focusRestores++;},
  LABELS:{pending:'待采集',collected:'待核验',retain:'保留',context:'旁证',conflict:'分歧',missing:'待补',na:'不适用'},
  document:{getElementById:id=>id==='multi-detail-meta'?meta:title},
  dialog:{querySelector:selector=>selector==='.multi-detail-body'?body:buttons[1],querySelectorAll:()=>buttons}};
 const detail=board.slice(board.indexOf(' function updateDetail(){'),board.indexOf(' function update(){'));
 runInNewContext(detail+';updateDetail();',context);
 assert.match(meta.textContent,/ETH|Crypto/);assert.match(meta.textContent,/SIM/);assert.doesNotMatch(meta.textContent,/v\d+/);
 const visible=body.innerHTML.split('<details>')[0];assert.doesNotMatch(visible,/fixture-|<span>A\d{2}<\/span>/);
 for(const evidence of task.evidence.filter(e=>e.status!=='na')){assert.ok(visible.includes(evidence.source));assert.ok(body.innerHTML.includes(evidence.sourceId));}
 assert.match(body.innerHTML,/<details><summary[^>]*>记录信息<\/summary>/);
 assert.ok(body.innerHTML.includes('v'+task.version));assert.equal(JSON.stringify(research),before);
 record.open=true;research.recheck('ETH');research.advance(2);
 runInNewContext('updateDetail()',context);assert.equal(record.open,true);assert.equal(focusRestores,1);
 context.selected='BTC';context.detailSig='';runInNewContext('updateDetail()',context);
 assert.equal(record.open,false);assert.equal(focusRestores,1);
});

test('live details render the selected asset job without simulated provenance, fees or trade actions',()=>{
 const research=new MarketResearch(),before=JSON.stringify(research),meta={},title={},footer={hidden:false};
 const renders=[];let markup='';
 const body={get innerHTML(){return markup;},set innerHTML(value){markup=value;}};
 const context={research,live:true,source:null,selected:'ETH',detailSig:'',pair:zh=>zh,getLocale,esc,researchSharedDetail,researchPublicDetail,captureProductFocus:()=>()=>{},
  researchJobs:{render(symbol){renders.push(symbol);return `<section data-live-research="${symbol}">${symbol} job</section>`;}},
  document:{documentElement:{lang:getLocale()},getElementById:id=>id==='multi-detail-meta'?meta:title},
  dialog:{querySelector:selector=>selector==='.multi-detail-body'?body:footer}};
 const detail=board.slice(board.indexOf(' function updateDetail(){'),board.indexOf(' function update(){'));
 runInNewContext(detail+';updateDetail();',context);
 assert.equal(footer.hidden,true);assert.match(meta.textContent,/行情观察/);assert.match(title.textContent,/ETH/);
 assert.match(markup,/data-live-research="ETH"/);assert.doesNotMatch(markup,/SIM|fixture|本地样例|8 积分|选择策略|BTC job/);
 context.selected='BTC';runInNewContext('updateDetail()',context);assert.match(markup,/BTC job/);assert.doesNotMatch(markup,/ETH job/);
 context.source=research.shared[0].id;runInNewContext('updateDetail()',context);assert.match(markup,/尚无可用背景资料|No background data available/);assert.match(markup,/data-status="missing"/);assert.doesNotMatch(markup,/SIM|fixture|样例/);
 assert.deepEqual(renders,['ETH','BTC']);assert.equal(JSON.stringify(research),before);
});

test('wallet overlay completion waits across chain-to-connect transitions and closes exactly once',()=>{
 const header=readFileSync(new URL('./header-wallet.jsx',import.meta.url),'utf8'),source=header.slice(header.indexOf('const finishWalletFlow='),header.indexOf('function WalletHeader('));
 let connect=false,chain=false,cleanup;const wasOpen={current:false},frames=new Map(),events=[];
 const context={useConnectModal:()=>({connectModalOpen:connect}),useChainModal:()=>({chainModalOpen:chain}),useRef:()=>wasOpen,useEffect:effect=>{cleanup?.();cleanup=effect();},requestAnimationFrame:fn=>{frames.set(1,fn);return 1;},cancelAnimationFrame:id=>frames.delete(id),Event,CustomEvent,window:{dispatchEvent:event=>events.push(event.type)}};
 runInNewContext(source+';WalletOverlayLifecycle()',context);assert.equal(events.length,0);
 chain=true;runInNewContext('WalletOverlayLifecycle()',context);assert.deepEqual(events,['astarter:wallet-modal-open']);
 chain=false;runInNewContext('WalletOverlayLifecycle()',context);assert.equal(frames.size,1);
 connect=true;runInNewContext('WalletOverlayLifecycle()',context);assert.equal(frames.size,0);assert.deepEqual(events,['astarter:wallet-modal-open']);
 connect=false;runInNewContext('WalletOverlayLifecycle()',context);frames.get(1)();assert.deepEqual(events,['astarter:wallet-modal-open','astarter:wallet-flow-end']);
 runInNewContext('WalletOverlayLifecycle()',context);assert.equal(events.length,2);
});

test('wallet revalidation without an overlay releases the research handoff on success, outage and account change',async()=>{
 const header=readFileSync(new URL('./header-wallet.jsx',import.meta.url),'utf8'),start=header.indexOf('  const authenticate=event=>{'),source=header.slice(start,header.indexOf("window.addEventListener('astarter:authenticate-wallet'",start));
 assert.ok(start>0);
 for(const outcome of [{result:null,error:'service'},{result:{session:{expires:1}}},{result:{session:{expires:1}},changed:true}]){
  const finished=[],events=[],currentWallet={current:'original'};let connects=0;
  const context={currentWallet,reauthenticateWalletProfile,address:'0x'+'a'.repeat(40),chainId:56,connectionStatus:'connected',wrongNetwork:false,document:{getElementById:()=>null},window:{dispatchEvent:event=>events.push(event)},CustomEvent,auth:{reauthenticate:()=>Promise.resolve(outcome.result)},finishWalletFlow:error=>finished.push(error),walletAuthenticated:()=>true,setConnectRequest:()=>{connects++;}};
  runInNewContext(source+';authenticate({preventDefault(){}})',context);if(outcome.changed)currentWallet.current='different';await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(finished,[outcome.error]);assert.equal(connects,0);
  assert.equal(events.filter(event=>event.detail.ownerRef).length,outcome.result&&!outcome.changed?1:0);
 }
});

test('repainted research rows keep focus by asset even when their market label changes',()=>{
 const source=readFileSync(new URL('./photonic-workbench.mjs',import.meta.url),'utf8'),start=source.indexOf('if(runs.dataset.stamp!==runStamp)'),code=source.slice(start,source.indexOf('\n   list.forEach',start));
 let restored=0;const document={activeElement:null},old={dataset:{pwResult:'ETH'},closest(){return this;}},replacement={dataset:{pwResult:'ETH'},focus(){document.activeElement=this;}};
 document.activeElement=old;
 const runs={dataset:{stamp:'old'},contains:el=>el===old,querySelectorAll:()=>[replacement],set innerHTML(value){document.activeElement=null;}};
 runInNewContext(code,{runs,document,runStamp:'new-label',list:[{}],photonicResultRow:()=>'<button>updated ETH</button>',captureProductFocus:()=>()=>{restored++;}});
 assert.equal(document.activeElement,replacement);assert.equal(restored,0);
});

test('closing research restores a replaced asset entrance only on the original route',()=>{
 const start=board.indexOf(' function rememberFocus(){'),source=board.slice(start,board.indexOf('\n dialog.addEventListener(\'close\'',start));
 let focused=0;const asset={dataset:{pwResult:'ETH'}},replacement={isConnected:true,closest:()=>null,focus:()=>{focused++;}},location={href:'https://astarter.imstark.site/?page=workbench'};
 const context={location,document:{activeElement:{closest:()=>asset},querySelector:()=>replacement},captureProductFocus:()=>()=>assert.fail('asset should resolve without a generic fallback'),returnFocus:null};
 runInNewContext(source+';rememberFocus();returnFocus();',context);assert.equal(focused,1);
 location.href='https://astarter.imstark.site/?page=markets';runInNewContext('returnFocus()',context);assert.equal(focused,1);
});
