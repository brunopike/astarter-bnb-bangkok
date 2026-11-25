import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG,BOT_PRODUCT_CAPABILITIES} from './strategy-catalog.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {TradingAccess} from './trading-access.mjs?v=20261120c';
import {defaultStrategyRoute,strategyRouteValid,strategyRouteReady,strategyRouteFields,saveBotEditor,clearBotEditor,readBotEditor,botPlanFingerprint,botGridPreviewKey,botGridPreview,botRecommendationIssue,strategyConnection,bindStrategyConnection,signedWalletRoute,strategyAccessOptions,strategyRouteConnected,botBudgetAmount} from './strategy-routing.mjs';
import {botParameters,botRequiredCapital} from './bot-runtime.mjs';

test('suggested entry sizing fits the explicit allocation with the existing fees and entry schedule',()=>{
 for(const [strategy,expected] of [['S01',124.87],['S02',105.15]]){
  const plan={strategy,planVariant:strategy+'-SIM',cap:500,botParameters:botParameters(strategy)},before=JSON.stringify(plan),amount=botBudgetAmount(plan);
  assert.equal(amount,expected);assert.ok(botRequiredCapital({...plan,amount})<=500);assert.equal(JSON.stringify(plan),before);
  assert.equal(botBudgetAmount({...plan,cap:5}),null);assert.equal(botBudgetAmount({...plan,cap:NaN}),null);
 }
 assert.equal(botBudgetAmount({strategy:'S03',cap:500}),null);
 assert.equal(botBudgetAmount({strategy:'S01',planVariant:'S01-SIM',cap:500,botParameters:{count:1}}),null);
});

test('native setup keeps the instrument visible and opens account repair without changing the binding',()=>{
 const route={...defaultStrategyRoute('S01'),market:'ETH/USDT',accountId:'SIM-01',connectionId:'original-missing'};
 const before=JSON.stringify(route),html=strategyRouteFields('S01',route,{},null,'S01-SIM');
 assert.ok(html.indexOf('name="routeMarket"')<html.indexOf('<details'));
 assert.match(html,/data-bot-section="account" open/);
 assert.match(html,/value="original-missing" selected/);
 assert.match(html,/原接入不可用|Original connection unavailable/);
 for(const name of ['routeVenue','routeAccount','routeProfile','routeMarket'])assert.match(html,new RegExp('name="'+name+'"'));
 assert.equal(JSON.stringify(route),before);
});
import {strategyFlowAvailable,strategyVariants,strategyPlan} from './strategy-execution-data.mjs';

const routeFixture=id=>({...defaultStrategyRoute(id),accountId:'SIM-01',connectionId:'legacy-exchange',market:id.startsWith('S09')?'WETH/USDC':'BTC/USDT'});

test('creation keeps account binding and access repair while the header owns instrument selection',()=>{
 for(const [id,variant]of [['S01','S01-SIM'],['S03','baseline'],['S09-A','baseline']]){
  const route=routeFixture(id),before=JSON.stringify(route),html=strategyRouteFields(id,route,DEFAULT_CONNECTIONS,null,variant,true);
  assert.match(html,/name="routeAccount"/);assert.match(html,/data-sc="route-connect"/);
  for(const name of ['routeVenue','routeProfile','routeMarket','routeChain'])assert.doesNotMatch(html,new RegExp('name="'+name+'"'));
  assert.equal(JSON.stringify(route),before);
 }
});

test('catalog coverage keeps families, experiments and execution methods distinct',()=>{
 assert.equal(CATALOG.length,18);assert.equal(BOT_PRODUCT_CAPABILITIES.length,10);assert.equal(new Set(BOT_PRODUCT_CAPABILITIES.map(x=>x.id)).size,10);
 assert.deepEqual(CATALOG.flatMap(x=>strategyVariants(x.id).map(v=>v.id)).sort(),['E01','E02','E03','E04','E05','E06','S01-SIM','S02-SIM','S02-VP']);
 assert.deepEqual(BOT_PRODUCT_CAPABILITIES.filter(x=>x.family).map(x=>x.family),['S01','S02']);
 assert.equal(BOT_PRODUCT_CAPABILITIES.filter(x=>x.kind==='execution').length,3);
 assert.ok(BOT_PRODUCT_CAPABILITIES.every(x=>!strategyFlowAvailable({strategy:x.id})));
});

test('route choices belong to each strategy and never imply an execution adapter',()=>{
 for(const item of CATALOG)assert.equal(strategyRouteValid(item.id,routeFixture(item.id)),true,item.id);
 const route=routeFixture('S03');
 assert.equal(strategyRouteValid('S03',route),true);assert.equal(strategyRouteReady(route),true);
 assert.equal(strategyRouteValid('S09-A',route),false);
 for(const patch of [{venueId:'okx'},{accountId:'SIM-02'},{profileId:'cex-perp'},{chainId:'1'},{market:'ETH/USDT'}]){
  const changed={...route,...patch};assert.equal(strategyRouteReady(changed),false);
  assert.equal(strategyFlowAvailable({strategy:'S03',market:changed.market,executionRoute:changed}),false);
 }
 const chain=routeFixture('S09-A');assert.equal(chain.chainId,'1');assert.equal(strategyRouteValid('S09-A',chain),true);
 assert.equal(strategyRouteValid('S09-A',{...chain,venueId:'binance'}),false);assert.equal(strategyRouteValid('S09-A',{...chain,chainId:'42161'}),false);
 const address='0x1111111111111111111111111111111111111111';
 const wallet={id:'wallet-bsc',kind:'wallet',service:'metamask',network:'evm',chain:'56',venue:'wallet',access:'confirm',accountId:address,label:'0x1111…1111',status:'connected'};
 const walletRoute=signedWalletRoute(wallet,'BTC/USDT');
 assert.equal(strategyRouteValid('S01',walletRoute),true);
 assert.equal(strategyRouteValid('S09-A',walletRoute),false);
 assert.equal(strategyRouteValid('RX03-S',{...walletRoute,venueId:'uniswap'}),false);
 const html=strategyRouteFields('S01',routeFixture('S01'),{tradingAccounts:[wallet]},null,'S01-SIM',true);
 assert.match(html,/value="wallet-bsc"/);assert.match(html,/链上钱包|On-chain wallet/);assert.doesNotMatch(html,new RegExp(address));
 const dex=strategyRouteFields('S01',walletRoute,{tradingAccounts:[wallet]});
 assert.match(dex,/BNB Chain/);assert.doesNotMatch(dex,/Arbitrum|Ethereum|Base|Solana/);
 const research=strategyRouteFields('S09-A',{...walletRoute,venueId:'uniswap',chainId:'1'},{});
 assert.match(research,/Ethereum/);assert.doesNotMatch(research,/BNB Chain/);
});
test('malformed saved route data cannot crash the setup or gain execution authority',()=>{
 const draft={strategy:'S03',market:55,executionRoute:{profileId:42,venueId:[],accountId:{},chainId:7}};
 const snapshot=JSON.stringify(draft),route=defaultStrategyRoute('S03',draft);
 assert.equal(route.accountId,'');assert.equal(route.market,'');assert.equal(strategyRouteValid('S03',route),false);assert.equal(strategyFlowAvailable(draft),false);
 assert.doesNotThrow(()=>strategyRouteFields('S03',route,{}));assert.equal(JSON.stringify(draft),snapshot);
});
test('explicit connection IDs preserve old bindings and never inherit another record or preferred permission',()=>{
 const connections={...DEFAULT_CONNECTIONS,tradingAccounts:[{id:'api-main',kind:'exchange',service:'binance',label:'Main',accountId:'SIM-01',market:'spot',access:'trade'},{id:'api-read',kind:'exchange',service:'binance',label:'Read',accountId:'SIM-01',market:'spot',access:'read'},{id:'api-perp',kind:'exchange',service:'binance',accountId:'SIM-01',market:'perp',access:'trade'}],preferredTradingConnection:'api-main'};
 const fresh=defaultStrategyRoute('S03',null,connections);assert.equal(fresh.connectionId,'');assert.equal(fresh.accountId,'');
 const checked={tradingAccounts:[{id:'binance-spot',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'BINANCE-SPOT',label:'Binance',status:'connected'}],preferredTradingConnection:'binance-spot'};
 const live=defaultStrategyRoute('RX02-A',{market:'SOL/USDT'},checked);
 assert.equal(live.connectionId,'binance-spot');assert.equal(live.accountId,'BINANCE-SPOT');assert.equal(live.venueId,'binance');assert.equal(live.profileId,'cex-spot');assert.equal(live.chainId,'');assert.equal(live.market,'SOL/USDT');
 assert.equal(defaultStrategyRoute('S03',{executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'api-read',chainId:'',market:'BTC/USDT'}},checked).connectionId,'api-read');
 assert.equal(defaultStrategyRoute('S09-L',null,checked).connectionId,'');assert.equal(strategyRouteReady(live),false);
 const route=bindStrategyConnection({...fresh,market:'BTC/USDT'},'api-read',connections);assert.equal(route.connectionId,'api-read');assert.equal(strategyConnection(route,connections).access,'read');
 const draft={strategy:'S03',market:route.market,executionRoute:route};assert.equal(defaultStrategyRoute('S03',draft,{...connections,preferredTradingConnection:'api-main'}).connectionId,'api-read');
 assert.equal(bindStrategyConnection(route,'api-perp',connections),null);assert.equal(strategyConnection({...route,accountId:'SIM-02'},connections),null);assert.equal(strategyConnection({...route,venueId:'okx'},connections),null);
 const stream={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'},generation:1},runtime=new TradingAccess(connections);runtime.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-main'});
 assert.equal(runtime.status(stream,strategyAccessOptions(route,'auto')).code,'connection-unchecked');runtime.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-read'});
 const view=runtime.status(stream,strategyAccessOptions(route,'auto'));assert.equal(view.code,'read-only');assert.equal(strategyRouteConnected(route,connections,view),false);assert.equal(runtime.status(stream,strategyAccessOptions(route,'signal')).ready,true);
 const removed={...connections,tradingAccounts:connections.tradingAccounts.filter(r=>r.id!=='api-read')};assert.equal(defaultStrategyRoute('S03',draft,removed).connectionId,'api-read');assert.equal(strategyConnection(route,removed),null);
 const html=strategyRouteFields('S03',route,removed);assert.match(html,/value="api-read" selected/);assert.match(html,/原接入不可用|Original connection unavailable/);assert.doesNotMatch(html,/is-connected/);
 assert.equal(strategyAccessOptions({profileId:'dex-spot',connectionId:'wallet-main'},'auto').operation,'auto');
 assert.notEqual(botGridPreviewKey(route),botGridPreviewKey({...route,connectionId:'api-main'}));
});
test('connection settings return to the original draft only and never rebind an approved run',async()=>{
 const {createStrategyCenter}=await import('./strategy-journeys.mjs'),prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 try{
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  for(const scenario of ['apply','cancel','wrong-context','new-version','wrong-product','removed','other-scope','other-editor']){
   const events={},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
   globalThis.document={activeElement:null,body:{dataset:{page:'strategies'},append(){}},addEventListener(){},createElement:()=>drawer};
   const connections={...DEFAULT_CONNECTIONS,tradingAccounts:[{id:'api-main',kind:'exchange',service:'binance',label:'Main',accountId:'SIM-01',market:'spot',access:'trade'},{id:'api-read',kind:'exchange',service:'binance',label:'Read',accountId:'SIM-01',market:'spot',access:'read'},{id:'api-perp',kind:'exchange',service:'binance',label:'Perp',accountId:'SIM-01',market:'perp',access:'trade'}],preferredTradingConnection:'api-main'};
   const w=new WorkspaceSim(),d=w.draft();Object.assign(d,{amount:75,cap:375,market:'BTC/USDT',executionRoute:{...routeFixture('S03'),connectionId:'api-main'}});w.validateSetup();for(let i=0;i<60;i++)w.tick(.1);assert.ok(w.setupReady);
   const run={id:'RUN-ONE',draftId:d.id,connectionId:'api-main',version:d.version},runBefore=JSON.stringify(run),canonical=JSON.stringify(d),credits=w.available,accessCalls=[];let settings,armed=0;
   const desk={snapshot:()=>({connections,state:'paused',session:run}),access:options=>{accessCalls.push(options);return {connectionId:options.connectionId,ready:options.connectionId==='api-main',code:options.connectionId==='api-main'?'ready':'read-only'};},settings(_key,options){settings=options;},arm(){armed++;}};
   const center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
   center.openDraft(d.id);await click('route-connect');assert.equal(settings.connectionId,'api-main');assert.deepEqual(settings.returnContext,{route:'bot',draftId:d.id,version:d.version});assert.equal(drawer.open,false);
   const returned={connectionId:scenario==='wrong-product'?'api-perp':'api-read',context:{...settings.returnContext}};
   if(scenario==='wrong-context')returned.context.draftId='another-draft';if(scenario==='new-version')d.version++;if(scenario==='removed')connections.tradingAccounts=connections.tradingAccounts.filter(r=>r.id!=='api-read');if(scenario==='other-scope')w.s.setupContext.accountId='SIM-02';if(scenario==='other-editor')center.openTemplate('S02');
   connections.preferredTradingConnection='api-read';if(scenario!=='cancel')settings.onReturn(returned);settings.onClose();
   assert.equal(JSON.stringify(run),runBefore,scenario);assert.equal(armed,0);assert.equal(w.available,credits);assert.equal(d.executionRoute.connectionId,'api-main');assert.ok(accessCalls.every(call=>Object.hasOwn(call,'connectionId')));
   if(scenario==='apply'){assert.equal(w.s.botEditors.S03.executionRoute.connectionId,'api-read');assert.equal(w.s.botEditors.S03.cap,375);assert.equal(w.s.botEditors.S03.amount,75);assert.equal(w.setupReady,null);assert.equal(JSON.stringify(d),canonical);assert.match(drawer.innerHTML,/只读|View-only/);}
   else {assert.equal(w.s.botEditors.S03.executionRoute.connectionId,'api-main',scenario);if(scenario==='other-scope')assert.equal(drawer.open,false);else if(scenario==='other-editor')assert.match(drawer.innerHTML,/有限分批|Bounded scaling/);else if(scenario!=='cancel')assert.match(drawer.innerHTML,/未应用|不一致|not applied|does not match/,scenario);}
  }
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('saved exchange and pair are preserved and route changes invalidate prior checks',()=>{
 const w=new WorkspaceSim(),d=w.draft(),base=routeFixture('S03');
 assert.equal(w.saveDraft(d.id,{amount:100,cap:500,mode:'review',market:base.market,executionRoute:base}),null);
 const result=w.validateSetup();for(let i=0;i<60;i++)w.tick(.1);assert.equal(w.setupReady,result.run);
 const next={...base,venueId:'okx',market:'ETH/USDT'};
 assert.equal(w.saveDraft(d.id,{amount:100,cap:500,mode:'review',market:next.market,executionRoute:next}),null);
 assert.equal(w.setupReady,null);assert.equal(d.executionRoute.venueId,'okx');assert.equal(d.market,'ETH/USDT');
 assert.ok(w.validateSetup().error);assert.ok(w.checkStart(d));
 next.venueId='bybit';assert.equal(d.executionRoute.venueId,'okx');
 const before=JSON.stringify(d);assert.ok(w.saveDraft(d.id,{amount:100,cap:500,mode:'review',market:'ETH/USDT',executionRoute:{...base,venueId:'unknown'}}));assert.equal(JSON.stringify(d),before);
});
test('all strategy configurations expose venue, account and asset without invented connection status',()=>{
 const route=defaultStrategyRoute('S03'),html=strategyRouteFields('S03',route,{exchange:false});
 for(const name of ['routeProfile','routeVenue','routeAccount','routeMarket'])assert.match(html,new RegExp('name="'+name+'"'));
 assert.match(html,/请选择交易接入|Choose a trading connection/);
 const chain=strategyRouteFields('S09-L',defaultStrategyRoute('S09-L'),{wallet:false});
 assert.match(chain,/name="routeChain"/);assert.match(chain,/dex-lp/);
});

test('pending strategy saves reject duplicate clicks and cannot launch after closing',async()=>{
 const {createStrategyCenter}=await import('./strategy-journeys.mjs');
 const previous={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim();w.saveDraft(w.draft().id,{...w.draft(),market:'BTC/USDT',executionRoute:routeFixture('S03')});const root={querySelector:()=>null,querySelectorAll:()=>[]};let calls=0,release;
  w.setBudget=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const center=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS})},root,go(){},refresh(){},notify(){}});
  center.openDraft(w.draft().id);
  const click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
  const before=w.s.drafts.length,pending=click('save');const duplicate=click('save');assert.equal(calls,1);await duplicate;
  await click('close');release(null);await pending;
  assert.equal(drawer.open,false);assert.equal(w.s.validations.length,0);assert.equal(w.s.drafts.length,before);
  w.setBudget=async()=>null;delete w.s.botEditors.S03;let finishCreate;w.createManagedDraft=()=>new Promise(resolve=>{finishCreate=resolve;});
  const form={reportValidity(){return true;},addEventListener(){}};drawer.querySelector=selector=>selector==='#sc-config'&&drawer.dataset.phase==='configure'?form:null;
  globalThis.FormData=class extends Map{constructor(){super(Object.entries({amount:'100',cap:'500',researchBudget:'200',mode:'auto',...(drawer.dataset.family==='S01'?{bot_lower:'78000',bot_upper:'84000',bot_count:'3',bot_spacing:'arithmetic',bot_stopLossPrice:'73000',bot_takeProfitPrice:'90000',bot_triggerPrice:''}:{})}));}};
  center.openTemplate('S03');await click('configure');events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});events.change({target:{dataset:{strategyRoute:'market'},value:'BTC/USDT'}});const delayed=click('save');await new Promise(resolve=>setImmediate(resolve));
  await click('close');center.openTemplate('S09-A');
  const created=w.createDraft('S03');finishCreate(created);await delayed;
  assert.equal(created.executionRoute.profileId,'cex-spot');assert.equal(created.market,'BTC/USDT');
  assert.equal(w.s.botEditors.S03.draftId,created.id);
  assert.equal(w.s.validations.length,0);assert.equal(drawer.open,true);assert.match(drawer.innerHTML,/链上价差|On-chain spreads/);

  await click('close');center.openTemplate('S01');await click('configure');events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});events.change({target:{dataset:{strategyRoute:'market'},value:'BTC/USDT'}});
  w.createManagedDraft=async()=>null;const count=w.s.drafts.length;await click('save');assert.match(drawer.innerHTML,/草稿未能保存，输入已保留|Could not save this draft/);assert.match(drawer.innerHTML,/role="alert"/);assert.equal(drawer.open,true);assert.equal(w.s.drafts.length,count);assert.equal(w.s.validations.length,0);assert.equal(w.s.botEditors.S01.executionRoute.market,'BTC/USDT');

 }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('editor recovery preserves incomplete inputs without changing the canonical plan or reserving credits',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)},w=new WorkspaceSim({storage}),d=w.draft();
 const before=JSON.stringify(d),editor={id:'S03',draftId:d.id,baseVersion:d.version,variant:'baseline',amount:'',cap:'375.5',mode:'auto',protection:{id:'original',version:'strategy-original'},researchBudget:'0',executionRoute:defaultStrategyRoute('S03'),mobileView:'settings'};
 const olderTab=new WorkspaceSim({storage});
 assert.equal(saveBotEditor(w,editor),true);assert.equal(JSON.stringify(d),before);assert.equal(w.reserved,0);
 olderTab.touch(); // A stale full-workspace write must not erase the editor buffer.
 const restored=new WorkspaceSim({storage}),buffer=readBotEditor(restored,'S03',restored.draft());assert.deepEqual(buffer,editor);
 buffer.cap='999';assert.equal(readBotEditor(restored,'S03',restored.draft()).cap,'375.5');
 restored.draft().version++;assert.equal(readBotEditor(restored,'S03',restored.draft()),null);
 w.storage=null;
 for(const patch of [{amount:'\" autofocus onfocus=alert(1)'},{executionRoute:{profileId:42}},{protection:{id:'unknown'}},{id:'S01'}]){
  w.s.botEditors.S03={...editor,...patch};assert.equal(readBotEditor(w,'S03',d),null);
 }
});

test('discard restores only the exact editor key and keeps its input on failed or stale persistence',()=>{
 const data=new Map();let fault='';const storage={getItem(key){if(fault==='read')throw Error();return data.get(key)||null;},setItem(key,value){if(fault==='write'||fault==='cache-write'&&key.startsWith('hive.bot.editors.v1:'))throw Error();if(fault==='unconfirmed'&&key.startsWith('hive.bot.editors.v1:'))return;data.set(key,value);}},w=new WorkspaceSim({storage});
 const original={id:'S01',draftId:'D-1',cap:'250',source:{id:'one'}},current={...original,cap:'450'},key='S01:source:one',alias='S01:draft:D-1';
 saveBotEditor(w,current,key);saveBotEditor(w,{id:'S01',cap:'300',source:{id:'two'}},'S01:source:two');
 const state=JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available]),other=JSON.stringify(w.s.botEditors['S01:source:two']);
 assert.equal(clearBotEditor(w,key,original,current,{key:alias,restore:original,expected:current}),true);assert.deepEqual(w.s.botEditors[key],original);assert.deepEqual(w.s.botEditors[alias],original,'the alias written by this editor is restored with its source');
 assert.equal(JSON.stringify(w.s.botEditors['S01:source:two']),other);
 for(fault of ['read','write','cache-write','unconfirmed']){
  const before=JSON.stringify(w.s.botEditors);assert.equal(clearBotEditor(w,key,null,original,{key:alias,restore:current,expected:original}),false,fault);assert.equal(JSON.stringify(w.s.botEditors),before,fault);assert.ok(w.persistenceError,fault);
 }
 fault='';assert.equal(clearBotEditor(w,key,null,current),false,'a stale dialog cannot remove a changed buffer');assert.deepEqual(w.s.botEditors[key],original);
 const later={...current,cap:'900',source:{id:'later'}};saveBotEditor(w,later,alias);assert.equal(clearBotEditor(w,key,null,original,{key:alias,restore:original,expected:original}),false,'a later alias write cannot be rolled back');assert.deepEqual(w.s.botEditors[key],original);assert.deepEqual(w.s.botEditors[alias],later);
 assert.equal(clearBotEditor(w,key,null,original),true);assert.equal(w.s.botEditors[key],undefined);assert.deepEqual(w.s.botEditors[alias],later);assert.equal(JSON.stringify(w.s.botEditors['S01:source:two']),other);
 assert.equal(clearBotEditor(w,'missing'),true,'existing two-argument callers remain idempotent');
 assert.equal(JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available]),state);
});

test('recommended parameters require a fresh matching chart and a grid containing its current price',()=>{
 const now=1_000_000,executionRoute=routeFixture('S01'),plan={strategy:'S01',market:executionRoute.market,executionRoute,botParameters:{lower:90,upper:110}},quote={...executionRoute,price:100,closedPrice:99,closedAt:now-60_000,asOf:now,state:'live'};
 assert.equal(botRecommendationIssue(plan,quote,quote,now),null);
 for(const changed of [null,{...quote,state:'paper'},{...quote,asOf:now-30_001},{...quote,asOf:now+30_001},{...quote,market:'ETH/USDT'},{...quote,venueId:'okx'},{...quote,profileId:'dex-spot'},{...quote,price:NaN},{...quote,closedPrice:NaN},{...quote,closedAt:quote.asOf+1},{...quote,closedAt:now+1,asOf:now+10}])assert.equal(botRecommendationIssue(plan,quote,changed,now),'MARKET_NOT_READY');
 assert.equal(botRecommendationIssue(plan,{...quote,market:'ETH/USDT'},quote,now),'MARKET_NOT_READY');
 assert.equal(botRecommendationIssue(plan,quote,{...quote,price:111},now),'DEFAULT_RANGE_STALE');
 assert.equal(botRecommendationIssue(plan,null,{...quote,price:111},now),null,'manual and preserved conditional ranges remain valid');
 assert.equal(botRecommendationIssue(plan,null,null,now),'MARKET_NOT_READY','new manual approvals also require a valid matching quote');
 assert.equal(botRecommendationIssue({...plan,simulationReference:{...quote,asOf:now-30_001}},null,quote,now),'MARKET_NOT_READY');
 assert.equal(botRecommendationIssue({...plan,strategy:'S02'},quote,{...quote,price:111},now),null);
});

test('a frozen simulation reference changes approval identity while legacy fingerprints remain byte-for-byte stable',()=>{
 const d=new WorkspaceSim().draft(),legacy=JSON.stringify([d.id,d.version,d.strategy,d.planVariant||'baseline',d.market,d.executionRoute,d.amount,d.cap,d.mode,d.protection,d.botParameters||null]);
 assert.equal(botPlanFingerprint(d),legacy);assert.equal(botPlanFingerprint({...d,simulationReference:null}),legacy);
 const reference={market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',period:'1H',closedPrice:75747.987654,closedAt:1000,asOf:2000},plan={...d,simulationReference:reference};
 assert.notEqual(botPlanFingerprint(plan),legacy);
 for(const patch of [{closedPrice:75747.987655},{asOf:2001},{market:'ETH/USDT'}])assert.notEqual(botPlanFingerprint({...plan,simulationReference:{...reference,...patch}}),botPlanFingerprint(plan));
 const w=new WorkspaceSim(),editor={id:d.strategy,draftId:d.id,baseVersion:d.version,variant:'baseline',amount:d.amount,cap:d.cap,mode:d.mode,protection:d.protection,researchBudget:0,executionRoute:routeFixture(d.strategy),simulationReference:reference};
 saveBotEditor(w,editor);assert.deepEqual(readBotEditor(w,d.strategy,w.draft()).simulationReference,reference);
});

test('grid previews retain incomplete inputs and keep prices isolated by route without changing execution rules',()=>{
 const route=routeFixture('S01'),key=botGridPreviewKey(route),drafts={[key]:{lower:'70000',upper:'80000',count:'15',mode:'arithmetic',applied:true}};
 assert.deepEqual(botGridPreview(drafts,route),drafts[key]);
 assert.equal(botGridPreview(drafts,route,'E03'),null);
 for(const patch of [{accountId:'SIM-02'},{market:'ETH/USDT'},{venueId:'okx'},{profileId:'dex-spot',chainId:'1'}])assert.equal(botGridPreview(drafts,{...route,...patch}),null);
 drafts[key].lower='';assert.equal(botGridPreview(drafts,route).lower,'');assert.equal(botGridPreview(drafts,route).applied,false);
 drafts[key]={lower:'80000',upper:'70000',count:'15',mode:'geometric',applied:true};assert.equal(botGridPreview(drafts,route).applied,false);
 drafts[key]={lower:'70000',upper:'80000',count:'101',mode:'arithmetic',applied:true};assert.equal(botGridPreview(drafts,route).applied,false);
 drafts[key].count='\" autofocus onfocus=alert(1)';assert.equal(botGridPreview(drafts,route),null);
 const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},w=new WorkspaceSim({storage}),d=w.createDraft('S01'),before=JSON.stringify(d);
 const editor={id:'S01',draftId:d.id,baseVersion:d.version,variant:'baseline',amount:'100',cap:'500',mode:'auto',protection:{id:'original',version:'strategy-original'},researchBudget:'0',executionRoute:route,gridPreviews:{[key]:{lower:'70000',upper:'80000',count:'15',mode:'arithmetic',applied:true}}};
 assert.equal(saveBotEditor(w,editor),true);const restored=readBotEditor(new WorkspaceSim({storage}),'S01',d);assert.equal(botGridPreview(restored.gridPreviews,route).count,'15');assert.equal(JSON.stringify(d),before);assert.equal(strategyPlan('S01').record.parameters.levels.value,4);assert.equal(w.s.validations.length,0);assert.equal(w.reserved,0);
});

test('source editor keys isolate suggestions from the existing draft and from another source',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},w=new WorkspaceSim({storage}),d=w.draft(),before=JSON.stringify(w.s.drafts);
 const original={id:'S03',draftId:d.id,baseVersion:d.version,variant:'baseline',amount:'75',cap:'375',mode:'signal',protection:{id:'original',version:'strategy-original'},researchBudget:'0',executionRoute:routeFixture('S03')};
 saveBotEditor(w,original);
 const sourceKey='S03:source:signal-ETH-v2',otherKey='S03:source:signal-ETH-v3';
 assert.equal(readBotEditor(w,'S03',null,sourceKey),null);
 const suggestion={...original,draftId:null,baseVersion:null,cap:'420',executionRoute:defaultStrategyRoute('S03'),source:{type:'signal',id:'signal-ETH',revision:2,instrument:{symbol:'ETH',chainId:'1',ca:'0x111'}}};
 saveBotEditor(w,suggestion,sourceKey);
 assert.equal(readBotEditor(w,'S03',d).cap,'375');assert.equal(readBotEditor(w,'S03',null,sourceKey).cap,'420');assert.equal(readBotEditor(w,'S03',null,otherKey),null);
 const restored=new WorkspaceSim({storage});assert.deepEqual(readBotEditor(restored,'S03',null,sourceKey).source,suggestion.source);assert.equal(JSON.stringify(w.s.drafts),before);assert.equal(w.reserved,0);
});
