import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DOMAINS} from './business-pages.js';
import {interceptNavigation} from './product-layout.mjs';
import {Simulation} from './simulation.mjs';import {evidenceProcess} from './evidence-process.mjs';import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {armSources,tickSources,deliverSource,queueSource,INTELLIGENCE,portfolio,routePage,validateSetup,STRATEGIES} from './product-data.mjs';
import {MOBILE_DOCK,MOBILE_NAV,TRADING_TABS,tradingSection,mobileNavSection,createNavigationMemory,restoreNavigationSearch,wealthRoute} from './product-data.mjs';
test('changing a mobile destination retains motion and appearance preferences without leaking the prior asset',()=>{
 assert.equal(restoreNavigationSearch('?page=signals','?page=markets&asset=SOL&motion=reduced&look=classic'),'?page=signals&motion=reduced&look=classic');
 assert.equal(restoreNavigationSearch('?page=markets&asset=SOL&view=spot','?page=signals'),'?page=markets&asset=SOL&view=spot');
 assert.equal(restoreNavigationSearch('?page=signals&motion=reduced','?page=markets&motion=full'),'?page=signals&motion=reduced');
 assert.equal(restoreNavigationSearch('?page=markets&view=two%20words','?page=signals'),'?page=markets&view=two%20words');
});
test('the mobile dock and header cover the desktop sections without consuming account routes',()=>{
 assert.deepEqual(MOBILE_NAV.map(item=>item.id),['workbench','execution','signals','data','assistant']);
 assert.deepEqual(MOBILE_DOCK.map(item=>item.id),['workbench','execution','signals','data']);
 for(const page of ['signals','opportunities'])assert.equal(mobileNavSection(page),'signals');
 assert.equal(mobileNavSection('wealth'),null);assert.equal(routePage('?page=wealth'),'workbench');
 assert.equal(wealthRoute('?page=wealth&strategy=growth&asset=weth&motion=reduced'),'?page=workbench&motion=reduced');
 assert.equal(wealthRoute('?page=markets'),null);
 assert.equal(DOMAINS.some(item=>item.home==='wealth'||item.pages.includes('wealth')),false);
 for(const page of ['markets','tracking','intelligence','social','derivatives','etf'])assert.equal(mobileNavSection(page),'data');
 for(const page of ['execution','assets','inbox'])assert.equal(mobileNavSection(page),'execution');
 for(const page of ['advisor','validation','my-strategies'])assert.equal(mobileNavSection(page),'execution');
 assert.equal(mobileNavSection('assistant'),'assistant');assert.equal(mobileNavSection('settings'),null);assert.equal(mobileNavSection('logs'),null);
 for(const page of ['profile','logs','plans','topup','billing','usage','settings','setup'])assert.equal(mobileNavSection(page),null);
 const desktop=DOMAINS.filter(item=>!['settings','usage'].includes(item.home));assert.deepEqual(MOBILE_NAV.map(item=>item.home),desktop.map(item=>item.home));
});
test('mobile navigation restores the exact last route and scroll independently for signals and market data',()=>{
 const memory=createNavigationMemory();assert.equal(memory.target('signals'),'?page=signals');assert.equal(memory.target('data'),'?page=markets');
 memory.remember('?page=markets&asset=SOL&view=prices',520);
 memory.remember('?page=opportunities',180);
 memory.remember('?page=execution&runId=demo-run',120);memory.remember('?page=logs&order=demo-42',290);
 assert.equal(memory.target('signals'),'?page=opportunities');assert.equal(memory.target('data'),'?page=markets&asset=SOL&view=prices');
 assert.equal(memory.target('execution'),'?page=execution&runId=demo-run');assert.equal(memory.position('?page=logs&order=demo-42'),290);
 memory.remember('?page=intelligence&source=macro',64);assert.equal(memory.target('data'),'?page=intelligence&source=macro');assert.equal(memory.target('signals'),'?page=opportunities');
 memory.remember('?page=assistant',900);memory.remember('?page=workbench&asset=ETH',73);memory.remember('?page=settings',0);
 assert.equal(memory.target('assistant'),'?page=assistant');assert.equal(memory.position('?page=assistant'),900);assert.equal(memory.target('workbench'),'?page=workbench&asset=ETH');assert.equal(memory.position('?page=workbench&asset=ETH'),73);
 memory.remember('?page=assistant&asset=ETH',40);assert.equal(memory.target('assistant'),'?page=assistant&asset=ETH');
 assert.equal(memory.target('signals'),'?page=opportunities');assert.equal(memory.position('?page=markets&asset=SOL&view=prices'),520);
 assert.equal(memory.position('?page=signals'),0);assert.equal(memory.target('strategies'),'?page=strategies');
});
const finish=m=>{for(let i=0;i<450;i++){m.advance(.1);tickSources(m);}};
test('multi-source evidence closes with macro social and chain provenance',()=>{const m=new Simulation();m.reset('liquidity',1);armSources(m);finish(m);const p=evidenceProcess(m);assert.equal(p.ready,true);for(const key of ['macro','social','chain'])assert.ok(p.items.some(i=>i.event.source===key));assert.equal(p.counts.conflict,0);assert.equal(p.counts.missing,0);});
test('high-impact macro blocks new simulation and unverified social remains missing',()=>{for(const [id,decision]of [['macro-01','conflict'],['social-01','missing']]){const m=new Simulation();m.reset('liquidity',1);armSources(m);deliverSource(m,INTELLIGENCE.find(i=>i.id===id));finish(m);const p=evidenceProcess(m);assert.equal(p.ready,true);assert.ok(p.counts[decision]>0);const d=new TradingDemo();assert.ok(d.start({market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:p.ready,market:'BTC/USDT',conflict:p.counts.conflict,missing:p.counts.missing}));}});
test('asset report reconciles partial fill, cancellation and fees',()=>{const d=new TradingDemo();d.start({market:'BTC/USDT',strategy:'S03',mode:'confirm',amount:100,cap:500},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT'});for(let i=0;i<45;i++)d.tick(.1);d.submit();for(let i=0;i<14;i++)d.tick(.1);d.pause();const p=portfolio(d);assert.equal(p.filled,1);assert.ok(Math.abs(p.equity-(10000-d.totalFees))<1e-8);assert.ok(Math.abs(p.cash+p.held-p.equity)<1e-8);assert.equal(d.orders[0].status,'partial-cancelled');});
test('routes and setup reject unsupported execution scopes',()=>{assert.equal(routePage('?scene=bricks'),'workbench');assert.equal(routePage('?page=assets'),'assets');assert.equal(routePage('?page=inbox'),'inbox');assert.equal(routePage('?page=mandate'),'mandate');assert.ok(validateSetup({market:'XAU/USD',mode:'auto',amount:100,cap:500}));assert.ok(validateSetup({market:'BTC/USDT',mode:'auto',amount:500,cap:100}));assert.equal(validateSetup({market:'BTC/USDT',mode:'confirm',amount:100,cap:500}),null);assert.equal(new Set(STRATEGIES.map(s=>s[0])).size,10);});

test('selected source replaces background task and remains in final conclusion',()=>{const m=new Simulation();m.reset('liquidity',1);armSources(m);queueSource(m,INTELLIGENCE[0]);finish(m);const p=evidenceProcess(m);assert.equal(p.ready,true);assert.equal(p.counts.conflict,1);assert.ok(p.items.some(i=>i.event.sourceId==='macro-01'));assert.ok(!p.items.some(i=>i.event.sourceId==='macro-02'));});

test('multi-asset observation uses distinct units and normalized series without execution state',async()=>{
 const {observationSnapshot,observationPrice}=await import('./product-data.mjs');
 const rows=observationSnapshot(12);assert.equal(rows.length,8);assert.equal(new Set(rows.map(a=>a.symbol)).size,8);
 for(const a of rows){assert.equal(a.normalized[0],100);assert.equal(a.values.at(-1),a.price);assert.ok(a.values.every(Number.isFinite));assert.equal(a.mode,'simulation-only');}
 assert.equal(rows.find(a=>a.symbol==='US10Y').unit,'%');assert.equal(rows.find(a=>a.symbol==='XAU').unit,'USD/盎司');assert.ok(rows.find(a=>a.symbol==='SPX').price<10000);assert.throws(()=>observationPrice('UNKNOWN',0));
 assert.deepEqual(observationSnapshot(12),rows);assert.notDeepEqual(observationSnapshot(13),rows);
});

test('AI credits owns only four pages while protection belongs to trading',()=>{
 const credits=DOMAINS.find(d=>d.home==='usage'),settings=DOMAINS.find(d=>d.home==='settings'),trading=DOMAINS.find(d=>d.home==='strategies');
 assert.deepEqual(credits.pages,['plans','topup','usage','billing']);assert.deepEqual(credits.navPages,credits.pages);
 assert.deepEqual(settings.navPages,['settings']);assert.equal(DOMAINS.find(d=>d.pages.includes('risk')),trading);assert.deepEqual(trading.navPages,['strategies','execution']);
 assert.equal(mobileNavSection('risk'),'execution');assert.equal(routePage('?page=staking'),'plans');
});

test('two bot pages share setup, saved plans and execution while legacy links stay usable',()=>{
 const hub=DOMAINS.find(item=>item.home==='strategies');assert.equal(hub.name,'策略交易');
 assert.equal(DOMAINS.some(item=>item.home==='execution'),false);
 assert.deepEqual(TRADING_TABS.map(item=>item.id),['strategies','execution']);
 for(const page of ['strategies','advisor','my-strategies','validation','risk','assets','execution'])assert.equal(DOMAINS.find(item=>item.pages.includes(page)),hub);
 assert.equal(tradingSection('advisor'),'strategies');assert.equal(tradingSection('validation'),'execution');assert.equal(tradingSection('logs'),null);assert.equal(DOMAINS.some(item=>item.pages.includes('logs')),false);assert.equal(routePage('?page=logs&order=demo-42'),'logs');assert.equal(tradingSection('signals'),null);
 assert.equal(routePage('?page=my-strategies'),'execution');
 const memory=createNavigationMemory();assert.equal(memory.target('execution'),'?page=strategies');
 memory.remember('?page=strategies',270);memory.remember('?page=signals',30);
 assert.equal(memory.target('execution'),'?page=strategies');assert.equal(memory.position('?page=strategies'),270);
 memory.remember('?page=assistant',45);assert.equal(memory.target('assistant'),'?page=assistant');
});


test('header links respect the current route and open the last assistant view',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8');
 const brand={},assistantLink={dataset:{page:'assistant'}},nav={children:[{dataset:{page:'markets'}},assistantLink]};
 const routes=[],opened=[],location={search:'?page=workbench'};
 const bindLinks=source.slice(source.indexOf('for(const a of nav.children)a.onclick='),source.indexOf('const readingDetails='));
 runInNewContext(source.split('\n').find(line=>line.includes('brand.onclick='))+'\n'+bindLinks,{interceptNavigation,document:{querySelector:()=>brand},nav,assistantLink,location,go:id=>routes.push(id),openNavigation:id=>opened.push(id)});
 const event={button:0,preventDefault(){}};
 assistantLink.onclick({...event,metaKey:true});assert.deepEqual(opened,[]);
 assistantLink.onclick(event);assert.deepEqual(opened,['assistant']);
 brand.onclick(event);assert.deepEqual(routes,[]);
 location.search='?page=workbench&asset=BTC';brand.onclick(event);assert.deepEqual(routes,['workbench']);routes.length=0;
 location.search='?page=markets';nav.children[0].onclick(event);assert.deepEqual(routes,[]);
 location.search='?page=markets&asset=BTC';nav.children[0].onclick(event);assert.deepEqual(routes,['markets']);routes.length=0;
 location.search='?page=derivatives';nav.children[0].onclick(event);assert.deepEqual(routes,['markets']);
});

test('resolving an operation hides only its own notice and leaves later errors visible',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8'),body={},nodes=new Map();
 const live={hidden:true,dataset:{},parentElement:body,setAttribute(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{setAttribute(){}});return nodes.get(selector);}};
 let focusChanges=0;
 const context={live,noticeRevision:0,noticeOrigin:null,noticeUntil:0,document:{body,activeElement:{focus(){focusChanges++;}},querySelectorAll:()=>[]},performance:{now:()=>100},L:zh=>zh,friendlyText:text=>text,uiGlyph:name=>name,dismissNotice(){live.hidden=true;}};
 const notify=runInNewContext(source.slice(source.indexOf(' function notify('),source.indexOf(' function go('))+'\nnotify;',context);
 const resolve=notify('Source unavailable',{tone:'error'});assert.equal(typeof resolve,'function');assert.equal(live.hidden,false);
 resolve();assert.equal(live.hidden,true);assert.equal(focusChanges,0);
 const older=notify('Source changed',{tone:'error'});notify('Saving failed',{tone:'error'});older();
 assert.equal(live.hidden,false);assert.equal(nodes.get('.product-notice-message').textContent,'Saving failed');assert.equal(context.noticeUntil,0);
 const sameTextOlder=notify('Source changed',{tone:'error'});notify('Source changed',{tone:'error'});sameTextOlder();assert.equal(live.hidden,false,'identical wording does not give an older operation ownership of a newer error');
 const latest=notify('Current source unavailable',{tone:'error'});latest();assert.equal(live.hidden,true);assert.equal(focusChanges,0);
});

test('a notice skips an open dialog without a layout box, such as the editor left open in the hidden product page',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8'),nodes=new Map();
 const holder=rects=>({getClientRects:()=>rects,append(child){child.parentElement=this;}});
 const body=holder([{}]),hiddenEditor=holder([]),shown=holder([{}]);let open=[];
 const live={hidden:true,dataset:{},parentElement:body,setAttribute(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{setAttribute(){}});return nodes.get(selector);}};
 const context={live,noticeRevision:0,noticeOrigin:null,noticeUntil:0,document:{body,activeElement:null,querySelectorAll:selector=>selector==='dialog[open]'?open:[]},performance:{now:()=>100},L:zh=>zh,friendlyText:text=>text,uiGlyph:name=>name,dismissNotice(){live.hidden=true;}};
 const notify=runInNewContext(source.slice(source.indexOf(' function notify('),source.indexOf(' function go('))+'\nnotify;',context);
 open=[hiddenEditor];notify('The account changed. Reopen the account.',{tone:'error'});
 assert.equal(live.parentElement,body,'an editor still open inside the hidden product page does not take the notice');assert.equal(live.hidden,false);
 live.parentElement=hiddenEditor;notify('Research started');assert.equal(live.parentElement,body,'a notice left inside the hidden editor returns to the page');
 open=[hiddenEditor,shown];notify('Saved');assert.equal(live.parentElement,shown,'a shown dialog still receives the notice');
 open=[shown,hiddenEditor];notify('Saved again');assert.equal(live.parentElement,shown,'the last shown dialog wins, not the last open one');
 open=[];notify('Done');assert.equal(live.parentElement,body);
});

test('app navigation checks the active editor before changing the page, while a watchlist overlay stays usable',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8');let checks=0,reads=0,overlays=0;const notices=[];
 const context={page:'strategies',returningHistory:null,isolated:false,business:{beforeLeave(){checks++;return 'Cache unavailable';},openWatchlist(){overlays++;}},notify:(...args)=>notices.push(args),desk:{readSnapshot(){reads++;throw Error('allowed navigation');}}};
 const go=runInNewContext(source.slice(source.indexOf(' function go('),source.indexOf(' function focusView('))+'\ngo;',context);
 assert.equal(go('signals'),false);assert.equal(checks,1);assert.equal(reads,0);assert.equal(notices[0][0],'Cache unavailable');
 go('watchlist');assert.equal(overlays,1);assert.equal(checks,1);
 context.business.beforeLeave=()=>{checks++;return null;};assert.throws(()=>go('signals'),/allowed navigation/);assert.equal(reads,1);
 context.returningHistory={key:'editor'};assert.equal(go('markets'),false);assert.equal(reads,1);
});

test('reselecting the active data overview closes an open mobile channel picker without pushing another entry',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8');
 let focused=0,leaveChecks=0;
 const menu={open:true,querySelector:()=>({focus(){focused++;}})};
 const context={page:'markets',DATA_PAGES:['markets'],returningHistory:null,isolated:false,location:{search:'?page=markets'},root:{querySelector:()=>menu},matchMedia:()=>({matches:true}),business:{beforeLeave(){leaveChecks++;return 'editing';}},notify(){}};
 const go=runInNewContext(source.slice(source.indexOf(' function go('),source.indexOf(' function focusView('))+'\ngo;',context);
 go('markets');assert.equal(menu.open,false);assert.equal(focused,1);assert.equal(leaveChecks,0);
 go('markets');assert.equal(focused,1);assert.equal(leaveChecks,0);
 context.location.search='?page=markets&view=exchanges';assert.equal(go('markets'),false);assert.equal(leaveChecks,1);
});

function historyGuardFixture({native=true,reject=false}={}){
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8'),start=source.indexOf(' function readHistoryView(');
 assert.ok(start>=0,'the product must retain the actual history entry for a blocked return');
 const url='http://127.0.0.1:4188/?page=strategies&create=S01&editor=one',location={href:url,search:'?page=strategies&create=S01&editor=one'},writes=[],traversals=[],notices=[],events={};let captures=0;
 const navigation=native?{currentEntry:{key:'editor'},traverseTo(key){traversals.push(key);return {finished:reject?Promise.reject(Error('entry expired')):new Promise(()=>{})};}}:undefined;
 const history={state:{retained:'state'},pushState(state,_,next){writes.push({state,url:next});location.href=next;location.search=new URL(next).search;this.state=state;}};
 const context={window:{navigation,addEventListener:(name,fn)=>events[name]=fn},history,location,historyView:{key:'editor',url,state:history.state},returningHistory:null,isolated:false,business:{beforeLeave:()=> 'Cache unavailable'},notify:(text)=>notices.push(text),rememberView(){captures++;}};
 runInNewContext(source.slice(start,source.indexOf(' function notify(')),context);
 return {context,history,location,navigation,writes,traversals,notices,events,url,captures:()=>captures};
}

test('blocked Back and Forward restore the exact history entry without remounting the editor or rewriting history',()=>{
 for(const target of ['older-entry','forward-entry']){
  const f=historyGuardFixture();f.location.href='http://127.0.0.1:4188/?page=signals';f.location.search='?page=signals';f.navigation.currentEntry={key:target};
  f.events.popstate();assert.deepEqual(f.traversals,['editor']);assert.equal(f.writes.length,0);assert.equal(f.captures(),0);assert.equal(f.notices.length,1);
  f.location.href=f.url;f.navigation.currentEntry={key:'editor'};f.events.popstate();assert.equal(f.context.returningHistory,null);assert.equal(f.captures(),0);assert.equal(f.writes.length,0);
 }
});

test('legacy or rejected history restoration protects the current editor by creating a recovery entry',async()=>{
 for(const options of [{native:false},{native:true,reject:true}]){
  const f=historyGuardFixture(options);f.location.href='http://127.0.0.1:4188/?page=signals';f.location.search='?page=signals';
  if(f.navigation)f.navigation.currentEntry={key:'older-entry'};
  f.events.popstate();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.location.href,f.url);assert.equal(f.context.returningHistory,null);assert.equal(f.writes.length,1);assert.equal(f.writes[0].state.retained,'state');assert.equal(f.captures(),0);
 }
});

test('reload and leaving the document only ask for native confirmation when the editor cannot safely leave',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8').split('\n');let listener,blocked=true,persisted=0;
 runInNewContext(source.find(line=>line.includes("window.addEventListener('beforeunload'")),{window:{addEventListener:(_,fn)=>listener=fn},business:{beforeLeave:()=>blocked?'Saving':null},workspace:{tick(){},persist(){persisted++;}},desk:{snapshot:()=>({})}});
 const event={prevented:false,preventDefault(){this.prevented=true;}};listener(event);assert.equal(event.prevented,true);assert.equal(event.returnValue,'');assert.equal(persisted,0);
 blocked=false;const normal={preventDefault(){throw Error('ordinary navigation must not ask for confirmation');}};listener(normal);assert.equal(persisted,1);assert.equal(normal.returnValue,undefined);
});

test('page changes dismiss the old detail and help once while background repaints keep both open',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8');
 const start=source.indexOf('const previousPage=root.dataset.renderedPage;');
 const leave=source.slice(start,source.indexOf('const retainedTabs=',start));
 const events=[],dialog={open:true,close(){this.open=false;}},helpDialog={open:true};
 const context={root:{dataset:{renderedPage:'signals'}},page:'signals',dialog,helpDialog,dialogReturn:()=>{},dialogOrigin:{},helpOrigin:{},
  closeHelp(){helpDialog.open=false;},CustomEvent,document:{dispatchEvent(event){events.push([event.type,event.detail]);}}};
 runInNewContext('{'+leave+'}',context);
 assert.ok(dialog.open&&helpDialog.open);assert.equal(typeof context.dialogReturn,'function');assert.deepEqual(events,[]);
 context.page='markets';runInNewContext('{'+leave+'}',context);
 assert.equal(dialog.open,false);assert.equal(helpDialog.open,false);assert.equal(context.dialogReturn,null);assert.equal(context.dialogOrigin,null);assert.equal(context.helpOrigin,null);
 assert.deepEqual(events,[['hive:page-leave','signals']]);
});

test('desktop and mobile English navigation both use LensWave with unchanged workbench routes and Chinese copy',()=>{
 const source=readFileSync(new URL('./product.js',import.meta.url),'utf8'),expression=source.match(/const desktopLabel=([^\n]+);/)[1];
 const label=runInNewContext(expression,{getLocale:()=> 'en',L:(_zh,en)=>en});
 const desktop=DOMAINS.find(item=>item.home==='workbench'),mobile=MOBILE_NAV.find(item=>item.id==='workbench');
 assert.equal(label(desktop),'LensWave');assert.equal(mobile.en,'LensWave');assert.equal(mobile.zh,'AI 星谱');assert.equal(mobile.home,'workbench');assert.deepEqual(mobile.pages,['workbench']);assert.equal(mobileNavSection('workbench'),'workbench');
});
