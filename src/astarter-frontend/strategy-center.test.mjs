import {normalizeConnections} from './connections.mjs?v=20261120c';
import {botPlanFingerprint} from './strategy-routing.mjs';
import {commerceFixture} from './commerce-test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {MultiResearch,DiscoveryDispatch} from './multi-research.mjs';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {BotBook,botParameters,botRequiredCapital} from './bot-runtime.mjs';
import {applyRecommendation} from './strategy-advisor.mjs';
import {strategyMemoryLines,strategyLaunchError,startStrategyWatch,reconcileStrategyWatch,createStrategyCenter,createStrategyJourneys} from './strategy-journeys.mjs';
import {CATALOG} from './strategy-catalog.mjs';
import {protectionConfig} from './strategy-protection.mjs';
import {withLocale} from './locale.mjs';

function editExitStub(){
 const note={textContent:''},focus={count:0,focus(){this.count++;}};
 return {handlers:{},innerHTML:'',open:false,note,focus,removed:false,setAttribute(){},querySelector:s=>s==='.sc-edit-exit-error'?note:focus,addEventListener(type,fn){this.handlers[type]=fn;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},remove(){this.removed=true;},choose(choice){return this.handlers.click({target:{closest:()=>({dataset:{editExit:choice}})}});}};
}

test('BOT return paths retain source, account and quote period; continue and Escape restore focus without leaving',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},exits=[],destinations=[],fields={cap:'',amount:'',mode:'auto',researchBudget:'200'},trigger={isConnected:true,focusCount:0,focus(){this.focusCount++;}};
 const form={reportValidity:()=>true,addEventListener(){}},scroll={scrollTop:0},marketHost={addEventListener(){}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>false,querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:s==='.sc-drawer-body'?scroll:s==='[data-trading-chart="strategy-create-market"]'?marketHost:null;},querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 let created=false;globalThis.document={activeElement:trigger,body:{dataset:{page:'execution'},append(){}},addEventListener(){},createElement(){if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};
 globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const w=new WorkspaceSim(),desk=deskStub(w),before=JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]);
 const center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go:id=>destinations.push(id),refresh(){},notify(){},readQuote:()=>({...route,period:'4H',price:75000,closedPrice:74900,closedAt:Date.now()-60000,asOf:Date.now(),state:'live'})});
 const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 for(const exit of ['close','navigate','return-source']){
  let returns=0;const source={type:'signal',id:'exit-'+exit,revision:1,instrument:{market:'BTC/USDT',symbol:'BTC',profileId:'cex-spot',venueId:'binance'}};
  Object.assign(fields,{cap:'',amount:''});center.openTemplate('S01',()=>returns++,source);const initialExits=exits.length;await click('return-source');assert.equal(exits.length,initialExits,'automatic first-quote parameters are not user edits');assert.equal(drawer.open,false);returns=0;center.openTemplate('S01',()=>returns++,source);if(drawer.dataset.phase==='resume')await click('resume-editor');
  Object.assign(fields,{cap:'320',amount:'60'});events.input({});events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});await click('apply-bot-parameters');
  const key=Object.keys(w.s.botEditors).find(key=>w.s.botEditors[key].source?.id===source.id),saved=JSON.stringify(w.s.botEditors[key]);assert.equal(center.beforeLeave(),null);assert.equal(w.s.botEditors[key].parameterReference.period,'4H');assert.equal(w.s.botEditors[key].executionRoute.accountId,'SIM-01');
  await click(exit,'execution');assert.equal(exits.at(-1).open,true,exit);exits.at(-1).choose('continue');assert.equal(drawer.open,true);assert.equal(JSON.stringify(w.s.botEditors[key]),saved);assert.equal(returns,0);
  await click(exit,'execution');let cancelled=false;exits.at(-1).handlers.cancel({preventDefault(){cancelled=true;}});assert.equal(cancelled,true);assert.equal(drawer.open,true);assert.equal(JSON.stringify(w.s.botEditors[key]),saved);assert.ok(trigger.focusCount>=2);
  await click(exit,'execution');exits.at(-1).choose('keep');assert.equal(drawer.open,false);assert.equal(JSON.stringify(w.s.botEditors[key]),saved);assert.equal(returns,exit==='navigate'?0:1);if(exit==='navigate')assert.equal(destinations.at(-1),'execution');
  center.openTemplate('S01',()=>returns++,source);const count=exits.length;await click(exit,'execution');assert.equal(exits.length,count,'opening an existing unsaved setup without editing does not prompt');assert.equal(drawer.open,false);
 }
 assert.equal(JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]),before);assert.equal(desk.calls.armed,0);
});

test('BOT discard affects the current instance only, restores earlier input, and blocks changed identity or failed writes',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},exits=[],fields={cap:'',amount:'',mode:'auto',researchBudget:'200'},data=new Map();let fault=false;
 const storage={getItem:key=>data.get(key)||null,setItem(key,value){if(fault)throw Error();data.set(key,value);}},w=new WorkspaceSim({storage}),desk=deskStub(w),form={reportValidity:()=>true,addEventListener(){}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>false,querySelector:s=>s==='#sc-config'&&drawer.dataset.phase==='configure'?form:null,querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 let created=false;globalThis.document={activeElement:null,body:{dataset:{page:'execution'},append(){}},addEventListener(){},createElement(){if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const {saveBotEditor}=await import('./strategy-routing.mjs'),center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
 const other={id:'S01',draftId:null,baseVersion:null,variant:'S01-SIM',cap:'210',amount:'40',mode:'auto',protection:protectionConfig(),researchBudget:200,executionRoute:{...route},botParameters:botParameters('S01'),source:null};saveBotEditor(w,other,'S01');
 const before=JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]);
 center.openTemplate('S01',null,null,{fresh:true});Object.assign(fields,{cap:'410',amount:'45'});events.input({});const key=Object.keys(w.s.botEditors).find(key=>key.startsWith('S01:new:'));
 await click('close');const dialog=exits.at(-1),current=JSON.stringify(w.s.botEditors[key]);
 const scope=w.s.setupContext.accountId;w.s.setupContext.accountId='SIM-02';assert.match(center.beforeLeave(),/账户已变化|account changed/);dialog.choose('discard');assert.equal(dialog.open,true);assert.equal(JSON.stringify(w.s.botEditors[key]),current);assert.match(dialog.note.textContent,/账户已变化|account changed/);w.s.setupContext.accountId=scope;
 w.s.botEditors[key].source={type:'signal',id:'changed',instrument:{}};w.persist();storage.setItem('hive.bot.editors.v1:local',JSON.stringify(w.s.botEditors));dialog.choose('discard');assert.equal(dialog.open,true);assert.match(dialog.note.textContent,/草稿已变化|draft changed/);w.s.botEditors[key].source=null;w.persist();storage.setItem('hive.bot.editors.v1:local',JSON.stringify(w.s.botEditors));
 fault=true;assert.match(center.beforeLeave(),/输入仍保留|inputs are retained/);dialog.choose('discard');assert.equal(dialog.open,true);assert.equal(drawer.open,true);assert.equal(JSON.stringify(w.s.botEditors[key]),current);assert.match(dialog.note.textContent,/当前输入仍保留|inputs are retained/);dialog.choose('keep');assert.equal(dialog.open,true);assert.equal(fields.cap,'410');
 fault=false;dialog.choose('discard');assert.equal(drawer.open,false);assert.equal(w.s.botEditors[key],undefined);assert.deepEqual(w.s.botEditors.S01,other);
 Object.assign(fields,{cap:other.cap,amount:other.amount});center.openTemplate('S01');await click('resume-editor');Object.assign(fields,{cap:'700',amount:'90'});events.input({});await click('close');exits.at(-1).choose('discard');assert.deepEqual(w.s.botEditors.S01,other,'discard restores input that existed before opening');
 assert.equal(JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]),before);assert.equal(desk.calls.armed,0);
});

test('BOT exits stay blocked during a save and a failed save leaves its input recoverable',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},exits=[],fields={cap:'320',amount:'60',mode:'auto',researchBudget:'200',...Object.fromEntries(Object.entries(botParameters('S01')).map(([k,v])=>['bot_'+k,String(v)]))},form={reportValidity:()=>true,addEventListener(){}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>false,querySelector:s=>s==='#sc-config'&&drawer.dataset.phase==='configure'?form:null,querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 let created=false;globalThis.document={activeElement:null,body:{dataset:{page:'execution'},append(){}},addEventListener(){},createElement(){if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const w=new WorkspaceSim(),desk=deskStub(w),destinations=[],center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go:id=>destinations.push(id),refresh(){},notify(){}}),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 center.openTemplate('S01',null,null,{fresh:true});events.change({target:{dataset:{strategyRoute:'market'},value:'BTC/USDT'}});events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});
 let release;w.createManagedDraft=()=>new Promise(resolve=>release=resolve);const saving=click('save');await Promise.resolve();assert.equal(typeof release,'function',drawer.innerHTML.slice(-1800));assert.match(center.beforeLeave(),/正在保存|Saving/);
 for(const action of ['close','navigate','return-source'])await click(action,'execution');let prevented=false;events.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(drawer.open,true);assert.equal(exits.length,0);assert.equal(destinations.length,0);
 release(null);await saving;assert.match(drawer.innerHTML,/输入已保留|inputs are retained/);assert.equal(drawer.open,true);assert.equal(Object.values(w.s.botEditors).find(row=>row.cap==='320').amount,'60');
 await click('close');exits.at(-1).choose('continue');assert.equal(drawer.open,true);assert.equal(fields.cap,'320');
 const count=exits.length;events.change({target:{dataset:{strategyRoute:'connectionId'},value:''}});await click('save');assert.equal(drawer.open,false);assert.equal(exits.length,count,'a successful explicit save leaves without an exit decision');assert.equal(desk.calls.armed,0);
});

test('discarding a saved-plan source editor also restores the alias that reopening actually reads',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},exits=[],fields={cap:'250',amount:'40',mode:'auto',researchBudget:'200'},form={reportValidity:()=>true,addEventListener(){}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>false,querySelector:s=>s==='#sc-config'&&drawer.dataset.phase==='configure'?form:null,querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 let created=false;globalThis.document={activeElement:null,body:{dataset:{page:'execution'},append(){}},addEventListener(){},createElement(){if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const data=new Map();let fault=false;const storage={getItem:key=>data.get(key)||null,setItem(key,value){if(fault)throw Error();data.set(key,value);}};
 const {saveBotEditor}=await import('./strategy-routing.mjs'),w=new WorkspaceSim({storage}),d=w.createDraft('S01'),desk=deskStub(w),source={type:'signal',id:'draft-exit',revision:1,instrument:{symbol:'BTC',market:'BTC/USDT',venueId:'binance',profileId:'cex-spot'}};
 const key='S01:source:'+JSON.stringify(['signal','draft-exit',1,null,'BTC','BTC/USDT',null,null,null,'binance','cex-spot']),alias='S01:draft:'+d.id;
 const original={id:'S01',draftId:d.id,baseVersion:d.version,variant:'S01-SIM',amount:'40',cap:'250',mode:'auto',protection:protectionConfig(),researchBudget:200,executionRoute:{...route},botParameters:botParameters('S01'),source};saveBotEditor(w,original,key);
 const before=JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]),center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
 center.openTemplate('S01',null,source);await click('resume-editor');Object.assign(fields,{cap:'400',amount:'70'});events.input({});assert.equal(w.s.botEditors[alias].cap,'400');await click('close');const dialog=exits.at(-1);fault=true;dialog.choose('discard');assert.equal(dialog.open,true);assert.equal(drawer.open,true);assert.equal(w.s.botEditors[alias].cap,'400');assert.equal(fields.cap,'400');fault=false;dialog.choose('discard');assert.equal(drawer.open,false);
 assert.deepEqual(w.s.botEditors[key],original);assert.deepEqual(w.s.botEditors[alias],original);
 Object.assign(fields,{cap:'250',amount:'40'});center.openTemplate('S01',null,source);await click('resume-editor');assert.match(drawer.innerHTML,/name="cap"[^>]*value="250"/);assert.match(drawer.innerHTML,/name="amount"[^>]*value="40"/);
 center.openDraft(d.id);assert.match(drawer.innerHTML,/name="cap"[^>]*value="250"/);assert.match(drawer.innerHTML,/name="amount"[^>]*value="40"/);
 center.openTemplate('S01',null,source);fault=true;Object.assign(fields,{cap:'330',amount:'55'});events.input({});assert.match(center.beforeLeave(),/输入仍保留|inputs are retained/);assert.equal(fields.cap,'330');fault=false;assert.equal(center.beforeLeave(),null,'a failed alias write can recover when storage returns');await click('close');exits.at(-1).choose('discard');Object.assign(fields,{cap:'250',amount:'40'});center.openTemplate('S01',null,source);await click('resume-editor');assert.match(drawer.innerHTML,/name="cap"[^>]*value="250"/);
 center.openTemplate('S01',null,source);Object.assign(fields,{cap:'500',amount:'80'});events.input({});const main=structuredClone(w.s.botEditors[key]),later={...w.s.botEditors[alias],cap:'900',source:{...source,id:'later-source'}};saveBotEditor(w,later,alias);await click('close');exits.at(-1).choose('discard');assert.equal(exits.at(-1).open,true);assert.deepEqual(w.s.botEditors[alias],later);assert.deepEqual(w.s.botEditors[key],main);assert.equal(fields.cap,'500');assert.match(exits.at(-1).note.textContent,/其它编辑|another editor/);
 assert.equal(JSON.stringify([w.s.drafts,w.s.risk,w.s.usage,w.available,desk.state]),before);assert.equal(desk.calls.armed,0);
});

test('the app page opener mounts creation inline, preserves edits on return, and rejects an invalid editor link',async t=>{
 const previous={document:globalThis.document,location:globalThis.location,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 const events={},fields={cap:'360',amount:'60',mode:'auto',researchBudget:'0'},shows={modal:0,inline:0},destinations=[],notices=[];
 const scroll={scrollTop:0},host={append(node){node.parentElement=this;}},form={reportValidity:()=>true,addEventListener(){}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>false,querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:['.sc-drawer-body','.bot-settings-scroll','.bot-creation-market'].includes(s)?scroll:null;},querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;shows.modal++;},show(){this.open=true;shows.inline++;},close(){this.open=false;events.close?.();}};
 t.after(()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{dataset:{page:'execution'},append(node){node.parentElement=this;}},createElement:()=>drawer,addEventListener(){},removeEventListener(){}};
 globalThis.location={search:'?page=execution'};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
 globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const w=new WorkspaceSim(),desk=deskStub(w),before={drafts:JSON.stringify(w.s.drafts),validations:w.s.validations.length,credits:w.available};
 const root={scrollTop:0,querySelector:s=>s==='[data-strategy-workspace-host]'&&document.body.dataset.page==='strategies'?host:null,querySelectorAll:()=>[]};
 let center;
 const go=(page,context={})=>{destinations.push({page,...context});document.body.dataset.page=page;if(!context.create)location.search='?page='+page;};
 center=createStrategyCenter({w,desk,root,go,refresh(){},notify:message=>notices.push(message),openPage:(id,editor)=>{assert.equal(center.beforeLeave(),null,'the internal editor navigation bypasses its own guard');document.body.dataset.page='strategies';location.search='?page=strategies&create='+id+'&editor='+encodeURIComponent(editor);center.render('strategies');center.bind();}});
 assert.equal(center.openTemplate('S01'),true);assert.equal(shows.modal,0);assert.equal(shows.inline,1);assert.equal(drawer.dataset.variant,'S01-SIM');assert.equal(drawer.dataset.phase,'configure');assert.match(drawer.innerHTML,/data-trading-chart="strategy-create-market"/);assert.doesNotMatch(drawer.innerHTML,/继续模拟草稿|Resume the saved draft/);
 events.input({});assert.equal(w.s.botEditors.S01.cap,'360');const protection=structuredClone(w.s.botEditors.S01.protection);
 center.openTemplate('S02');center.openTemplate('S01');assert.match(drawer.innerHTML,/name="cap"[^>]*value="360"/);assert.deepEqual(w.s.botEditors.S01.protection,protection);
 const key='S01:missing';location.search='?page=strategies&create=S01&editor='+key;center.render('strategies');center.bind();assert.equal(destinations.at(-1).page,'strategies');assert.equal(destinations.at(-1).replace,true);assert.equal(location.search,'?page=strategies');assert.ok(notices.length);
 assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(w.s.validations.length,before.validations);assert.equal(w.available,before.credits);assert.equal(desk.calls.armed,0);
 const oldEditor=JSON.stringify(w.s.botEditors.S01);center.openTemplate('S01',null,null,{fresh:true});
 const newKey=new URLSearchParams(location.search).get('editor');assert.match(newKey,/^S01:new:/);assert.equal(drawer.dataset.variant,'S01-SIM');assert.equal(w.s.botEditors[newKey].cap,'');assert.equal(JSON.stringify(w.s.botEditors.S01),oldEditor);
 center.render('strategies');center.bind();assert.equal(drawer.dataset.variant,'S01-SIM');assert.equal(w.s.botEditors[newKey].id,'S01');assert.equal(desk.calls.armed,0);assert.equal(w.available,before.credits);
 center.openTemplate('S03');center.openTemplate('S01');
 Object.assign(w.s.botEditors.S03,{cap:320,amount:40});w.s.botEditors.S03.executionRoute.market='';
 center.openTemplate('S03');assert.equal(w.s.botEditors.S03.executionRoute.market,'BTC/USDT');assert.equal(w.s.botEditors.S03.cap,320);assert.equal(w.s.botEditors.S03.amount,40);
 center.openTemplate('S01');w.s.botEditors.S03.executionRoute.market='ETH/USDT';center.openTemplate('S03');assert.equal(w.s.botEditors.S03.executionRoute.market,'ETH/USDT');
 center.openTemplate('S01');w.s.botEditors.S03.executionRoute.market='';w.s.botEditors.S03.localSaved={scope:'local',environment:'DEMO'};center.openTemplate('S03');assert.equal(w.s.botEditors.S03.executionRoute.market,'');
 center.openTemplate('S09-A');assert.equal(w.s.botEditors['S09-A'].executionRoute.profileId,'dex-spot');assert.equal(w.s.botEditors['S09-A'].executionRoute.venueId,'uniswap');assert.equal(w.s.botEditors['S09-A'].executionRoute.chainId,'1');assert.notEqual(w.s.botEditors['S09-A'].executionRoute.market,'BTC/USDT');
 assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(w.available,before.credits);assert.equal(desk.calls.armed,0);
});

const route={profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'legacy-exchange',chainId:'',market:'BTC/USDT'};

test('the combined instrument picker stages choices, cancels cleanly and commits pair plus venue without starting a run',async t=>{
 const previous={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},fields={cap:'360',amount:'60',mode:'auto',researchBudget:'0'},dialogs=[],marketEvents={};let returned=0,created=0;
 const marketHost={addEventListener(type,fn){marketEvents[type]=fn;}};
 const scroll={scrollTop:0},form={reportValidity:()=>true,addEventListener(){}},host={append(node){node.parentElement=this;}},trigger={isConnected:true,focus(){returned++;}};
 function makeDialog(picker=false){
  const input={focus(){}},results={innerHTML:''};
  return {handlers:{},innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains:()=>true,querySelector(s){if(picker)return s==='[data-instrument-search]'?input:s==='.sc-instrument-results'?results:null;return s==='#sc-config'?form:s==='[data-trading-chart="strategy-create-market"]'?marketHost:['.bot-settings-scroll','.bot-creation-market'].includes(s)?scroll:null;},querySelectorAll:()=>[],addEventListener(type,fn){this.handlers[type]=fn;},show(){this.open=true;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},remove(){this.removed=true;},results};
 }
 const drawer=makeDialog();
 t.after(()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:trigger,body:{dataset:{page:'strategies'},append(){}},addEventListener(){},createElement(){if(created++===0)return drawer;const d=makeDialog(true);dialogs.push(d);return d;}};
 globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const w=new WorkspaceSim(),desk=deskStub(w),before={drafts:JSON.stringify(w.s.drafts),credits:w.available},center=createStrategyCenter({w,desk,root:{querySelector:s=>s==='[data-strategy-workspace-host]'?host:null,querySelectorAll:()=>[]},go(){},refresh(){},notify(){}});
 center.openTemplate('S01');drawer.handlers.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});const original=structuredClone(w.s.botEditors.S01);
 assert.equal(typeof marketEvents['trading-chart:choose-instrument'],'function','the chart retains its picker handler when moved into fullscreen');
 assert.equal(original.executionRoute.accountId,'SIM-01');
 const click=(dialog,dataset)=>dialog.handlers.click({target:{closest:()=>({dataset,hasAttribute:key=>key==='data-instrument-close'&&dataset.close})}});
 await marketEvents['trading-chart:choose-instrument']();let dialog=dialogs.at(-1);assert.equal(dialog.open,true);assert.match(dialog.innerHTML,/role="listbox"/);assert.match(dialog.innerHTML,/data-instrument-search/);
 click(dialog,{instrumentVenue:'okx'});assert.deepEqual(w.s.botEditors.S01,original);assert.doesNotMatch(dialog.innerHTML,/aria-selected="true"/);
 click(dialog,{close:true});assert.equal(dialog.removed,true);assert.deepEqual(w.s.botEditors.S01,original);assert.equal(returned,1);
 await marketEvents['trading-chart:choose-instrument']();dialog=dialogs.at(-1);let prevented=false;
 dialog.handlers.keydown({key:'Escape',target:{hasAttribute:()=>false},preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(dialog.removed,true);assert.deepEqual(w.s.botEditors.S01,original);
 await marketEvents['trading-chart:choose-instrument']();dialog=dialogs.at(-1);
 dialog.handlers.input({target:{hasAttribute:key=>key==='data-instrument-search',value:'ETH'}});assert.match(dialog.results.innerHTML,/ETH\/USDT/);assert.doesNotMatch(dialog.results.innerHTML,/BTC\/USDT/);
 click(dialog,{instrumentVenue:'not-an-exchange'});click(dialog,{instrumentPair:'BNB/USDT'});assert.equal(dialog.open,true);assert.deepEqual(w.s.botEditors.S01,original);
 click(dialog,{instrumentVenue:'okx'});click(dialog,{instrumentPair:'ETH/USDT'});
 const changed=w.s.botEditors.S01;assert.equal(dialog.removed,true);assert.equal(changed.executionRoute.venueId,'okx');assert.equal(changed.executionRoute.market,'ETH/USDT');assert.equal(changed.executionRoute.profileId,'cex-spot');assert.equal(changed.executionRoute.connectionId,'');assert.equal(changed.executionRoute.accountId,'');
 assert.equal(changed.cap,original.cap);assert.equal(changed.amount,original.amount);assert.deepEqual(changed.protection,original.protection);assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(w.available,before.credits);assert.equal(w.s.validations.length,0);assert.equal(desk.calls.armed,0);
});

test('run controls distinguish accepted reconciliation, rejected actions and confirmed updates',async t=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},notices=[];
 const drawer={setAttribute(){},classList:{toggle(){}},addEventListener:(name,fn)=>events[name]=fn};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},createElement:()=>drawer,addEventListener(){}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const plan={id:'pending-copy',version:1,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:route,protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S01')};
 const book=new BotBook({debit(){},credit(){}}),run=book.create(plan,{requestId:'pending-copy-create'}).run,data={botBook:book.snapshot()},before=JSON.stringify(data);let outcome;
 const desk={readSnapshot:()=>data,snapshot:()=>data,botAction:async()=>outcome},w=new WorkspaceSim(),center=createStrategyCenter({w,desk,root:{querySelector(){},querySelectorAll:()=>[]},go(){},refresh(){},notify:(message,options)=>notices.push({message,...options})});
 const click=(sc,extra={})=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id:run.id,kind:'stop-keep',version:'1',account:'SIM-01',connection:route.connectionId,...extra}})}});
 for(const [result,tone,keepConfirmation]of [[{pending:true,message:'Orders are being reconciled'},'info',false],['Rejected by fixture','error',true],[null,'success',false]]){
  await click('bot-end');assert.match(center.instancesView(data),/bot-end-confirm/);outcome=result;await click('bot-action');
  assert.equal(notices.at(-1).tone,tone);assert.equal(typeof notices.at(-1).message,'string');assert.doesNotMatch(notices.at(-1).message,/\[object Object\]/);
  assert.equal(center.instancesView(data).includes('bot-end-confirm'),keepConfirmation);assert.equal(JSON.stringify(data),before);
 }
 outcome=null;
 for(const [status,label]of [['paused',/已暂停买入|Entries paused/],['stopping',/正在结束|Ending/],['stopped',/已结束|Ended/]]){
  data.botBook.runs[0].status=status;const original=JSON.stringify(data);await click('bot-action');
  assert.equal(notices.at(-1).tone,'success');assert.ok(notices.at(-1).message.includes(run.id));assert.ok(notices.at(-1).message.includes('BTC/USDT'));assert.match(notices.at(-1).message,label);
  assert.equal(JSON.stringify(data),original);
 }
});

test('explicit editor navigation survives the delayed close event while back still returns to its source',async t=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},destinations=[],contexts=[];let closed;
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(type,fn){events[type]=fn;},showModal(){this.open=true;},close(){this.open=false;closed=()=>events.close?.();}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const w=new WorkspaceSim(),desk=deskStub(w),center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go:(id,context)=>{destinations.push(id);contexts.push(context);},refresh(){},notify(){}}),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}}),back=()=>destinations.push('workbench');
 center.openTemplate('S02',back);await click('navigate','execution');closed();assert.deepEqual(destinations,['execution']);
 center.openTemplate('S01',back);await click('return-source');closed();assert.deepEqual(destinations,['execution','workbench']);assert.equal(desk.calls.armed,0);assert.equal(w.s.validations.length,0);
 const draft=w.createDraft('S01');draft.botLaunch={status:'started',runId:'BOT-000099'};center.openDraft(draft.id);await click('navigate','execution');closed();assert.deepEqual(contexts.at(-1),{runId:'BOT-000099'});assert.equal(desk.calls.armed,0);
});

test('new native templates inherit reviewed risk defaults while saved editors retain their own values',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'500',amount:'100',mode:'auto',researchBudget:'0'},notices=[];
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:null;},querySelectorAll(){return [];},addEventListener(type,fn){events[type]=fn;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const w=new WorkspaceSim(),desk=deskStub(w),center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify:text=>notices.push(text)}),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 const parameters={episode:.001,notional:.04,daily:.01,epoch:.025,soft:.02,hard:.06},policy=protectionConfig('astarter','normal',parameters);
 assert.equal(center.openTemplate('S01',null,null,{defaultProtection:policy}),true);events.input({});
 assert.deepEqual(w.s.botEditors.S01.protection.parameters,parameters);assert.match(drawer.innerHTML,/0\.1%/);assert.match(drawer.innerHTML,/2\.5%/);
 policy.parameters.episode=.002;assert.equal(w.s.botEditors.S01.protection.parameters.episode,.001);
 await click('risk-mode','conservative');assert.deepEqual(w.s.botEditors.S01.protection.parameters,parameters);
 const next=protectionConfig('astarter','normal',{...parameters,episode:.0015});
 center.openTemplate('S01',null,null,{defaultProtection:next});events.input({});assert.equal(w.s.botEditors.S01.protection.parameters.episode,.001,'an existing editor keeps its own approved defaults');
 await click('new-editor');events.input({});assert.equal(Object.entries(w.s.botEditors).find(([key])=>key.startsWith('S01:new:'))[1].protection.parameters.episode,.0015);
 const before=drawer.innerHTML;assert.equal(center.openTemplate('S02',null,null,{defaultProtection:protectionConfig('astarter','normal',{...parameters,episode:1})}),false);assert.equal(drawer.innerHTML,before);assert.ok(notices.length);
 assert.equal(desk.calls.armed,0);assert.equal(w.s.validations.length,0);
});

test('adopting a research recommendation binds the chosen asset, preserves edits and opens the exact source without execution',async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'',amount:'',mode:'signal',researchBudget:'0'},sources=[],notices=[];
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim();w.research=new MultiResearch();w.research.advance(80);const desk=deskStub(w,{time:80}),before=JSON.stringify(w.s.drafts),credits=w.available;
  let dismissed=0;
  const center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify:text=>{notices.push(text);return()=>dismissed++;},onRecommendationSource:(ref,onReturn)=>{sources.push(ref);onReturn?.();return true;}});
  const row=center.recommendations().find(r=>r.asset==='ETH'),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});let returned=0;
  assert.equal(center.chooseRecommendation('missing',null,{intent:'source'}),false);assert.equal(dismissed,0,'a failed source stays visible until the operation succeeds');
  assert.equal(center.chooseRecommendation(row.id,()=>returned++,{intent:'source'}),true);assert.deepEqual(sources[0],row.sourceRef);assert.equal(returned,1);assert.equal(drawer.open,false);assert.equal(dismissed,1);
  assert.equal(center.chooseRecommendation(row.id),true);assert.match(drawer.innerHTML,/ETH\/USDT/);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);
  assert.equal(dismissed,1,'successful opens must not resolve the same notice twice');
  Object.assign(fields,{cap:'350',amount:'70'});events.input({});
  const old=Object.values(w.s.botEditors).find(e=>e.source?.recommendationId===row.id);assert.equal(old.executionRoute.market,'ETH/USDT');assert.equal(old.executionRoute.accountId,'');assert.equal(old.cap,'350');assert.equal(old.amount,'70');assert.equal(old.mode,'signal');assert.equal(old.variant,row.variant);assert.equal(old.source.recordedAt,row.source.recordedAt);assert.match(drawer.innerHTML,/data-bot-section="recommendation"/);assert.match(drawer.innerHTML,/建议已采用|Recommendation applied/);
  assert.equal(center.chooseRecommendation(row.id),true);assert.match(drawer.innerHTML,/name="cap"[^>]*value="350"/);
  const html=drawer.innerHTML;w.research.recheck('ETH');assert.equal(center.chooseRecommendation(row.id),false);assert.equal(drawer.innerHTML,html);assert.ok(notices.length);
  assert.equal(dismissed,1,'an updated recommendation must keep its failure feedback');
  w.research.advance(80);const next=center.recommendations().find(r=>r.asset==='ETH');assert.notEqual(next.id,row.id);assert.equal(center.chooseRecommendation(next.id),true);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.equal(old.cap,'350');assert.equal(old.amount,'70');assert.equal(dismissed,2);
  const rejectedSource={...next.source,instrument:{...next.source.instrument,profileId:'cex-perp'}};
  const currentEditor=drawer.innerHTML;assert.equal(center.openTemplate(next.strategy,null,rejectedSource),false);assert.equal(drawer.innerHTML,currentEditor);assert.equal(dismissed,2);
  assert.equal(center.chooseRecommendation(next.id),true);assert.equal(dismissed,3,'a recommendation source rejected by the shared opener is resolved on a successful retry');
  const ordinarySource={...rejectedSource};delete ordinarySource.recommendationId;
  assert.equal(center.openTemplate(next.strategy,null,ordinarySource),false);assert.equal(center.chooseRecommendation(next.id),true);assert.equal(dismissed,3,'an ordinary template error is not owned by the recommendation retry');
  assert.equal(center.chooseRecommendation('missing',null,{intent:'source'}),false);
  assert.equal(center.chooseRecommendation(next.id),true);assert.equal(dismissed,4,'adopting a valid recommendation resolves the prior original-source failure');
  await click('workspace-select','S01');await click('start');assert.equal(desk.calls.armed,0);assert.equal(JSON.stringify(w.s.drafts),before);assert.equal(w.available,credits);
  assert.equal(center.chooseRecommendation('missing',null,{intent:'source'}),false);assert.equal(sources.length,1);
 }finally{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('an unpinned live research card opens on the connected Binance spot account and does not arm',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},fields={cap:'',amount:'',mode:'signal',researchBudget:'0'};
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:null;},querySelectorAll(){return [];},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const task={symbol:'BTC',domain:'Crypto',id:'market-research-BTC',phase:'complete',outcome:'missing',completed:1,title:'行情已核对',thesis:'Binance Spot',evidence:[{status:'missing'}]};
 const research={tasks:[task],accepts:()=>true,revision:()=>'v1',handoff:()=>null,time:10};
 const connections={tradingAccounts:[{id:'binance-spot',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'BINANCE-SPOT',label:'Binance',status:'connected'}],preferredTradingConnection:'binance-spot'};
 const w=new WorkspaceSim();w.research=research;const desk=deskStub(w,{time:10,connections});
 const center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify(){}});
 const row=center.recommendations().find(item=>item.asset==='BTC');
 assert.equal(row.canAdopt,false);assert.equal(row.strategy,'S03');assert.equal(row.source.instrument.profileId,undefined);
 assert.equal(center.chooseRecommendation(row.id),true);assert.equal(drawer.open,true);
 assert.match(drawer.innerHTML,/BTC\/USDT/);assert.match(drawer.innerHTML,/value="binance-spot"[^>]*selected|selected[^>]*value="binance-spot"/);
 assert.doesNotMatch(drawer.innerHTML,/data-sc="start"/);assert.equal(desk.calls.armed,0);
});

test('every strategy configure screen can submit and view without sending an order',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver,fetch:globalThis.fetch},events={},pages=[],fields={cap:'50',amount:'10',mode:'signal',researchBudget:'0',bot_deviationPct:'2',bot_sizeMultiplier:'1.5',bot_maxEntries:'3',bot_takeProfitPct:'2',bot_stopLossPct:'8',bot_lower:'59000',bot_upper:'64000',bot_count:'4',bot_spacing:'arithmetic'};
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:null;},querySelectorAll(){return [];},addEventListener(k,v){events[k]=v;},showModal(){this.open=true;},close(){this.open=false;}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const requests=[];
 globalThis.fetch=async(url,options={})=>{
  requests.push({url,method:options.method||'GET'});
  return Response.json({rules:[],lessons:[],choices:[]});
 };
 const checkRequests=()=>{
  for(const {url,method} of requests){
   assert.match(url,/^\/api\/memory\/context\?/);
   assert.equal(method,'GET');
  }
  assert.equal(desk.calls.armed,0);
 };
 const connections={tradingAccounts:[{id:'binance-spot',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'BINANCE-SPOT',label:'Binance',status:'connected'}],preferredTradingConnection:'binance-spot'};
 const w=new WorkspaceSim(),desk=deskStub(w,{connections}),center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(id){pages.push(id);},refresh(){},notify(){}});
 const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 for(const item of CATALOG){
  center.openTemplate(item.id);
  if(drawer.dataset.phase==='overview')await click('configure');
  if(drawer.dataset.phase==='resume')await click('resume-editor');
  assert.equal(drawer.dataset.phase,'configure',item.id);
  assert.match(drawer.innerHTML,/data-sc="save-plan"/,item.id);
  assert.match(drawer.innerHTML,/data-sc="view-list"/,item.id);
 }
 center.openTemplate('S01');if(drawer.dataset.phase==='resume')await click('resume-editor');
 assert.doesNotMatch(drawer.innerHTML,/data-sc="start"/);
 await click('save-plan');checkRequests();
 await click('view-list');assert.deepEqual(pages,['execution']);
 center.openTemplate('S02');if(drawer.dataset.phase!=='configure')await click('configure');
 await click('save-plan');
 checkRequests();
 assert.ok(requests.some(request=>request.method==='GET'));
 assert.equal(w.s.drafts.some(d=>d.strategy==='S02'&&d.executionRoute?.accountId==='BINANCE-SPOT')||Object.values(w.s.botEditors).some(e=>e.id==='S02'&&e.executionRoute?.accountId==='BINANCE-SPOT'),true);
});

test('viewing a configured bounded plan restores that allocation instead of another zero copy',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'0',amount:'',mode:'auto',researchBudget:'0',bot_deviationPct:'2',bot_sizeMultiplier:'1.5',bot_maxEntries:'3',bot_takeProfitPct:'2',bot_stopLossPct:'8'};
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:null;},querySelectorAll(){return [];},addEventListener(k,v){events[k]=v;},showModal(){this.open=true;},close(){this.open=false;}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const connections={tradingAccounts:[{id:'binance-spot',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'BINANCE-SPOT',label:'Binance',status:'connected'}],preferredTradingConnection:'binance-spot'};
 const w=new WorkspaceSim(),desk=deskStub(w,{connections}),center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify(){}});
 const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 center.openTemplate('S02');await click('save-plan');
 const blank=w.s.botEditors.S02;assert.ok(blank);
 w.s.botEditors['S02:20']=JSON.parse(JSON.stringify(blank));w.s.botEditors['S02:20'].cap='20';w.s.botEditors.S02.cap='0';
 await click('open-editor','S02:20');
 assert.match(drawer.innerHTML,/name="cap"[^>]*value="20"/);
});

test('source-backed editors preserve the supplied instrument and reject unsupported targets without rewriting them',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'',amount:'',mode:'signal',researchBudget:'0'},notices=[];
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector:s=>s==='#sc-config'?form:null,querySelectorAll:()=>[],addEventListener:(event,fn)=>events[event]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const w=new WorkspaceSim(),desk=deskStub(w),center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go(){},refresh(){},notify:text=>notices.push(text)}),before=JSON.stringify(w.s.drafts),credits=w.available,validationCount=w.s.validations.length;
 for(const [strategy,instrument]of [['RX03-S',{market:'WETH/USDC',profileId:'dex-spot',venueId:'pancakeswap',chainId:'8453'}],['S09-L',{market:'WETH/USDC',profileId:'dex-lp',venueId:'uniswap',chainId:'1'}],['S03',{market:'ETH/USDC',profileId:'cex-spot',venueId:'okx'}],['S01',{market:'BTC/USDT',profileId:'cex-spot',venueId:'binance'}]]){
  fields.mode=strategy==='S01'?'auto':'signal';
  const source={type:'signal',id:strategy+'-source',revision:1,instrument},snapshot=JSON.stringify(source);
  assert.equal(center.openTemplate(strategy,null,source),true);events.input({});
  const editor=Object.values(w.s.botEditors).find(row=>row.source?.id===source.id);
  assert.equal(editor.executionRoute.profileId,instrument.profileId);assert.equal(editor.executionRoute.venueId,instrument.venueId);assert.equal(editor.executionRoute.market,instrument.market);assert.equal(editor.executionRoute.chainId,instrument.chainId||'');
  assert.equal(editor.executionRoute.connectionId,'');assert.equal(editor.executionRoute.accountId,'');assert.equal(JSON.stringify(source),snapshot);
  assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.match(drawer.innerHTML,/name="amount"[^>]*value=""/);
 }
 events.change({target:{dataset:{strategyRoute:'market'},value:'ETH/USDT'}});
 await events.click({target:{closest:()=>({type:'button',dataset:{sc:'start'}})}});
 assert.match(drawer.innerHTML,/当前交易对象与来源不一致|trading instrument differs from the source/);assert.equal(w.s.validations.length,validationCount,'a changed source instrument cannot create a new check');
 const html=drawer.innerHTML,editors=JSON.stringify(w.s.botEditors);
 for(const [strategy,instrument]of [['S03',{market:'ETH/USDT',profileId:'cex-perp',venueId:'binance'}],['RX03-S',{market:'WETH/USDC',profileId:'dex-perp',venueId:'hyperliquid',chainId:'42161'}],['S09-L',{market:'WETH/USDC',profileId:'dex-lp',venueId:'uniswap',chainId:'8453'}],['S03',{market:'ETH/USDT',profileId:'cex-spot',venueId:'uniswap'}],['RX03-S',{market:'WETH/USDC',profileId:'unknown',venueId:'pancakeswap'}],['RX03-S',{market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:'56'}]]){
  assert.equal(center.openTemplate(strategy,null,{type:'signal',id:'unsupported',instrument}),false);
  assert.equal(drawer.innerHTML,html);assert.equal(JSON.stringify(w.s.botEditors),editors);
 }
 assert.equal(notices.length,6);assert.equal(JSON.stringify(w.s.drafts),before);assert.equal(w.available,credits);assert.equal(desk.calls.armed,0);
});

test('a locally saved research configuration is reachable in My Agents and resumes the same source without execution',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'240',amount:'40',mode:'signal',researchBudget:'0'};
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector:s=>s==='#sc-config'&&drawer.dataset.phase==='configure'?form:null,querySelectorAll:()=>[],addEventListener:(event,fn)=>events[event]=fn,showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 let failStorage=false;const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>{if(failStorage)throw Error('STORAGE_BLOCKED');data.set(key,value);}};
 const w=new WorkspaceSim({storage}),desk=deskStub(w),before=JSON.stringify(w.s.drafts),credits=w.available,root={querySelector:()=>null,querySelectorAll:()=>[]},center=createStrategyCenter({w,desk,root,go(){},refresh(){},notify(){}}),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
 const source={type:'research',id:'saved-lead',revision:7,instrument:{symbol:'ETH',market:'ETH/USDT'},reason:'Research evidence'};
 center.openTemplate('RX03-S',null,source);assert.doesNotMatch(center.savedPlans(),/data-local-editor=/,'viewing a source does not add a saved configuration');
 await click('save');
 const [key,editor]=Object.entries(w.s.botEditors).find(([,entry])=>entry.source?.id===source.id);
 const saved=center.savedPlans();assert.match(saved,/data-local-editor=/);assert.match(saved,/ETH\/USDT/);assert.match(saved,/data-sc="edit-local"/);assert.doesNotMatch(saved,/data-sc="(?:launch|start)"/);
 await click('edit-local',key);assert.equal(drawer.open,true);assert.match(drawer.innerHTML,/name="cap"[^>]*value="240"/);assert.match(drawer.innerHTML,/saved-lead/);
 fields.cap='280';events.input({});assert.match(center.savedPlans(),/data-local-editor=/,'continued editing retains its saved placement');
 const resumed=w.s.botEditors[key];assert.deepEqual(resumed.source,editor.source);assert.deepEqual(resumed.executionRoute,editor.executionRoute);assert.deepEqual(resumed.protection,editor.protection);
 const restored=new WorkspaceSim({storage}),restoredDesk=deskStub(restored),restoredCenter=createStrategyCenter({w:restored,desk:restoredDesk,root,go(){},refresh(){},notify(){}});
 assert.match(restoredCenter.savedPlans(),/data-local-editor=/,'a reload reads the explicit save from the existing editor store');
 restored.s.setupContext.environment='LIVE';assert.doesNotMatch(restoredCenter.savedPlans(),/data-local-editor=/);restored.s.setupContext.environment='DEMO';
 restored.account={scope:'other-workspace'};assert.doesNotMatch(restoredCenter.savedPlans(),/data-local-editor=/);await click('edit-local',key);assert.equal(drawer.open,true,'a rejected cross-workspace opener does not replace the current drawer');restored.account=null;
 await click('edit-local',key);assert.match(drawer.innerHTML,/name="cap"[^>]*value="280"/);
 events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});await click('save');
 const managed=restored.s.drafts.find(d=>d.researchSource?.id===source.id);assert.ok(managed);assert.deepEqual(managed.researchSource,resumed.source);assert.equal(managed.market,resumed.executionRoute.market);assert.deepEqual({...managed.executionRoute,market:managed.market},{...resumed.executionRoute,accountId:'SIM-01',connectionId:'legacy-exchange'});assert.deepEqual(managed.protection,resumed.protection);
 assert.doesNotMatch(restoredCenter.savedPlans(),/data-local-editor=/,'a managed draft replaces the local placement without duplicate cards');assert.equal(restored.available,credits);assert.equal(restoredDesk.calls.armed,0);
 const count=restored.s.drafts.length;restoredCenter.openTemplate('RX03-S',null,{...source,id:'failed-local-save'});failStorage=true;await click('save');
 assert.equal(drawer.open,true);assert.match(drawer.innerHTML,/本机草稿尚未确认保存|could not be confirmed saved/);assert.doesNotMatch(restoredCenter.savedPlans(),/data-local-editor=/);assert.equal(restored.s.drafts.length,count);assert.equal(restored.available,credits);assert.equal(restoredDesk.calls.armed,0);
 assert.equal(JSON.stringify(w.s.drafts),before);assert.equal(w.available,credits);assert.equal(desk.calls.armed,0);
});

test('native setup can size blank entry amounts from allocation without overwriting a custom amount',async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 try{
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  for(const [strategy,expected] of [['S01',124.87],['S02',105.15]]){
   const events={},fields={cap:'500',amount:'',mode:'auto',researchBudget:'0'},note={textContent:'',classList:{toggle(){}}},form={reportValidity:()=>true,addEventListener(){}};
   const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:s==='[data-bot-funding]'?note:null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
   globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
   const market=strategy==='S01'?'BTC/USDT':'ETH/USDT',w=new WorkspaceSim(),desk=deskStub(w,{time:10,cash:10000});desk.access=opts=>({ready:true,connectionId:opts.connectionId});
   const center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},readQuote:()=>({market,profileId:'cex-spot',venueId:'binance',period:'1H',closedPrice:strategy==='S01'?75775.91:2235.05,price:strategy==='S01'?75780:2236,closedAt:Date.now()-60_000,asOf:Date.now(),state:'live'}),go(){},refresh(){},notify(){}}),click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
   center.openTemplate(strategy);assert.equal(drawer.dataset.phase,'configure','a fresh native template opens its existing configuration directly');events.change({target:{dataset:{strategyRoute:'market'},value:market}});events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});await click('apply-bot-parameters');
   assert.match(drawer.innerHTML,/placeholder="(?:自动分配|Auto)"/);assert.match(note.textContent,/预算|allocation/);
   await click('start');const d=w.s.drafts.find(d=>d.strategy===strategy);assert.ok(d);assert.equal(d.amount,expected);assert.equal(d.cap,500);assert.ok(botRequiredCapital({...d,planVariant:strategy+'-SIM'})<=500);
   assert.equal(Object.values(w.s.botEditors).find(e=>e.id===strategy).amount,'','automatic sizing remains automatic after checking');
   await click('configure');Object.assign(fields,{cap:'300',amount:'37'});events.input({});await click('start');assert.equal(d.amount,37);assert.equal(d.cap,300);
   await click('configure');Object.assign(fields,{cap:'20',amount:''});events.input({});await click('start');assert.match(drawer.innerHTML,/至少需要|need at least/);assert.equal(d.amount,37);assert.equal(d.cap,300);
   assert.equal(desk.calls.armed,0);
  }
 }finally{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
const bindRoute=d=>Object.assign(d,{market:route.market,executionRoute:{...route}});
const advance=(w,seconds=5)=>{for(let i=0;i<seconds*10;i++)w.tick(.1);};
for(const memoryAccepted of [false,true])test('a connected wallet grid submit keeps the plan when the saved-item cap is full, memory accepted '+memoryAccepted,async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver,fetch:globalThis.fetch},events={};
 const form={reportValidity(){return true;},addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'?form:null;},querySelectorAll(){return [];},addEventListener(k,v){events[k]=v;},showModal(){this.open=true;},close(){this.open=false;}};
 const address='0x'+'ab'.repeat(20),wallet={profileId:'dex-spot',venueId:'pancakeswap',accountId:address,connectionId:'wallet-bsc',chainId:'56',market:'BTC/USDT'};
 const parameters={lower:58984.47,upper:63899.85,count:4,spacing:'arithmetic'};
  const fields={cap:'25',amount:'6.24',mode:'auto',researchBudget:'200',...Object.fromEntries(Object.entries(parameters).map(([key,value])=>['bot_'+key,String(value)]))};
 try{
  const writes=[];
  globalThis.fetch=async(url,options={})=>{
   if(options.method==='POST'){
    writes.push({url,body:JSON.parse(options.body)});
    return Response.json({saved:true,memory:memoryAccepted},{status:memoryAccepted?202:200});
   }
   return Response.json({rules:[],lessons:[],choices:[]});
  };
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
  const w=new WorkspaceSim(),ensures=[],notes=[],pages=[];
  w.s.botEditors={S01:{id:'S01',draftId:null,baseVersion:null,variant:'S01-SIM',amount:6.24,cap:25,mode:'auto',protection:protectionConfig('original'),researchBudget:200,executionRoute:wallet,botParameters:parameters}};
  w.createManagedDraft=async()=>{w.draftSaveError='已达保存上限，请移除不用的项目或选择更高容量套餐。';return null;};
  w.ensureDraftEntitlement=async()=>{ensures.push(1);return w.draftSaveError;};
  const center=createStrategyCenter({w,desk:{snapshot:()=>({connections:{tradingAccounts:[{id:'wallet-bsc',status:'connected',accountId:address,chain:'56'}]}}),access:()=>({ready:false,code:'wallet-held'})},root:{querySelector(){return null;},querySelectorAll(){return [];}},go(id){pages.push(id);},refresh(){},notify(message){notes.push(message);}});
  center.openTemplate('S01');if(drawer.dataset.phase==='resume')await events.click({target:{closest:()=>({type:'button',dataset:{sc:'resume-editor'}})}});
  assert.match(drawer.innerHTML,/data-sc="save-plan"[\s\S]*data-sc="view-list"/);assert.match(drawer.innerHTML,/>(?:查看|View)</);
  await events.click({target:{closest:()=>({type:'button',dataset:{sc:'view-list'}})}});
  assert.deepEqual(pages,['execution']);
  await events.click({target:{closest:()=>({type:'button',dataset:{sc:'save-plan'}})}});
  assert.deepEqual(writes.map(({url,body})=>[url,body.strategyId,body.cap,body.venue]),[['/api/memory/plan','S01',25,'pancakeswap']]);
  const feedback=drawer.innerHTML.match(/class="sc-feedback"[^>]*>([^<]*)/)?.[1]||'';
  assert.equal(ensures.length,0);assert.equal(feedback,'');assert.equal(notes.length,1);assert.match(notes[0],memoryAccepted?/^(方案已保存在当前钱包名下。 Living Brain 已接收此版本。|Plan saved for this wallet\. Living Brain received this version\.)$/:/^(方案已保存在当前钱包名下。 记忆未写入。|Plan saved for this wallet\. Memory was not written\.)$/);assert.equal(w.s.drafts.some(d=>d.strategy==='S01'&&d.executionRoute?.connectionId==='wallet-bsc'&&d.cap===25),true);
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('an unrelated save failure is not hidden by an unverified trading connection',async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};
 const form={reportValidity(){return true;},addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'?form:null;},querySelectorAll(){return [];},addEventListener(k,v){events[k]=v;},showModal(){this.open=true;}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim(),d=w.createDraft('S02');Object.assign(d,{planVariant:'S02-SIM',market:'BTC/USDT',executionRoute:route,protection:{id:'original',version:'strategy-original'},botParameters:{deviationPct:2,sizeMultiplier:1.5,maxEntries:3,takeProfitPct:2,stopLossPct:8}});
  const fields={amount:'100',cap:'500',mode:'auto',...Object.fromEntries(Object.entries(d.botParameters).map(([k,v])=>['bot_'+k,String(v)]))};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
  w.ensureDraftEntitlement=async()=> '已达保存上限，请保留现有草稿。';
  const center=createStrategyCenter({w,desk:{snapshot:()=>({connections:DEFAULT_CONNECTIONS}),access:()=>({ready:false,code:'unverified',connectionId:route.connectionId})},root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify(){}});
  assert.equal(typeof center.instancesView,'function');assert.match(center.instancesView({botSummary:{recoveryError:'原账本已保留'}}),/原账本已保留/);const nativeCard=center.savedPlans().split('data-draft="'+d.id+'"')[1]?.split('</article>')[0];assert.match(nativeCard,/批准方案后运行|Run the approved plan/);assert.doesNotMatch(nativeCard,/AI 自动执行/);center.openDraft(d.id);await events.click({target:{closest:()=>({type:'button',dataset:{sc:'save'}})}});
  assert.match(drawer.innerHTML,/已达保存上限，请保留现有草稿。/);assert.doesNotMatch(drawer.innerHTML,/data-sc="resolve-access"/);assert.equal(d.status,'draft');assert.equal(w.s.validations.length,0);
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('the actual setup dispatcher keeps protection choices interactive while native form submission stays separate',async t=>{
 const saved={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},pageEvents={};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(type,handler){pageEvents[type]=handler;},createElement:()=>drawer};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const {account,workspace:w}=await commerceFixture(t),root={querySelector(){return null;},querySelectorAll(){return [];}};
  const native=w.createDraft('S02');assert.equal(w.saveDraft(native.id,{amount:100,cap:500,mode:'auto',market:route.market,executionRoute:route,planVariant:'S02-SIM',botParameters:botParameters('S02')}),null);
  const center=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS})},root,go(){},refresh(){},notify(){}});
  const unchanged=JSON.stringify(w.s);center.openDraft(w.draft().id,false,'auto');
  assert.match(drawer.innerHTML,/type="hidden" name="mode" value="auto"/);assert.equal(JSON.stringify(w.s),unchanged);assert.equal(w.s.validations.length,0);
  drawer.innerHTML='<p>stale language</p>';pageEvents['hive:locale']();assert.match(drawer.innerHTML,/id="sc-drawer-title"/);assert.match(drawer.innerHTML,/type="hidden" name="mode" value="auto"/);
  center.openDraft(w.draft().id,true);
  const click=(sc,id,form=null)=>events.click({target:{closest:()=>({type:'submit',form,dataset:{sc,id}})}});
  await click('policy','astarter');assert.match(drawer.innerHTML,/data-id="astarter" aria-pressed="true"/);
  await click('risk-mode','conservative');assert.match(drawer.innerHTML,/data-id="conservative" aria-pressed="true"/);assert.match(drawer.innerHTML,/按本 BOT 分配额度、止损距离|Uses this BOT allocation, stop distance/);assert.equal(w.s.botEditors.S02.protection.mode,'conservative');
  await click('policy','original');assert.match(drawer.innerHTML,/data-id="original" aria-pressed="true"/);pageEvents['hive:access']();assert.match(drawer.innerHTML,/data-id="original" aria-pressed="true"/);
  const before=drawer.innerHTML;await click('check','',{id:'sc-config'});assert.equal(drawer.innerHTML,before);assert.equal(w.available,600);assert.equal(w.s.validations.length,0);await click('close','');assert.equal(drawer.open,false);
  const draft=w.draft();draft.amount=180;draft.cap=100;draft.version++;bindRoute(draft);center.openDraft(draft.id,true);
  await click('check','');assert.match(drawer.innerHTML,/data-tone="error" role="alert"/);assert.match(drawer.innerHTML,/单笔至少|An entry must/);
  assert.equal(w.available,600);assert.equal(w.s.validations.length,0);
  await click('cancel','');assert.match(drawer.innerHTML,/data-tone="info" role="status"/);
  await click('check','');assert.match(drawer.innerHTML,/data-tone="error" role="alert"/);await click('close','');
  assert.equal(w.saveDraft(draft.id,{amount:50,cap:300,mode:'auto'}),null);
  const savedView=center.render('my-strategies');assert.match(savedView,/已保存设置|Settings saved/);assert.doesNotMatch(savedView,/待设置|Needs setup/);
  const embedded=center.savedPlans();assert.match(embedded,/trading-saved-plans/);assert.match(embedded,/已保存方案|Saved plans/);assert.doesNotMatch(embedded,/sc-heading|sc-market-tabs|bot-management-summary|mine-filter/);
  const candidate=w.createDraft('S07');assert.equal(center.prepareDraft(candidate.id),true);assert.equal(drawer.dataset.phase,'configure');assert.match(drawer.innerHTML,/保存这份研究配置不会启动交易|Saving this research setup does not start trading/);assert.doesNotMatch(drawer.innerHTML,/data-sc="start"|data-sc="launch"/);assert.equal(w.s.validations.length,0);await click('close','');
  const untouched=JSON.stringify(w.s);w.s.strategyCenterArmedDraftId=draft.id;
  const active=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS,discovery:{armed:true,draftId:draft.id,version:draft.version,connectionId:route.connectionId,accountId:route.accountId,status:'watching'}})},root,go(){},refresh(){},notify(){}});
  assert.doesNotMatch(active.savedPlans(),new RegExp('data-draft="'+draft.id+'"'));
  delete w.s.strategyCenterArmedDraftId;assert.equal(JSON.stringify(w.s),untouched);

 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('incomplete legacy setup switches views without validation but saving and checking still validate',async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};
 let validations=0;const fields={cap:'123456.78',amount:'',researchBudget:''},body={scrollTop:137},detail={open:false},formEvents={},validationInert=[],form={addEventListener(type,handler){formEvents[type]=handler;},reportValidity(){validations++;validationInert.push(this.inert===true);return false;}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:s==='.sc-drawer-body'?body:['.sc-config-advanced','.sc-protection-settings'].includes(s)?detail:null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim(),d=w.draft();d.mode='confirm';bindRoute(d);const before=JSON.stringify(d),root={querySelector(){return null;},querySelectorAll(){return [];}};
  const accountData={state:'idle',connections:DEFAULT_CONNECTIONS,cash:1000},sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}},desk={snapshot:()=>accountData,syncStatus:()=>sync};
  const center=createStrategyCenter({w,desk,root,go(){},refresh(){},notify(){}}),click=(sc,id)=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
  center.openDraft(d.id);body.scrollTop=137;
  for(const view of ['full','quick']){await click('config-view',view);assert.match(drawer.innerHTML,new RegExp('data-config-mode="'+view+'"'));assert.match(drawer.innerHTML,/name="cap"[^>]*value="123456.78"/);assert.match(drawer.innerHTML,/name="amount"[^>]*value=""/);assert.equal(validations,0);}
  await click('mobile-view','market');body.scrollTop=29;await click('mobile-view','settings');assert.equal(body.scrollTop,137);
  assert.equal(w.s.botEditors.S03.amount,'');assert.equal(w.s.botEditors.S03.cap,'123456.78');assert.equal(w.s.botEditors.S03.mode,'confirm');
  await click('start');await click('save');assert.equal(validations,2);assert.deepEqual(validationInert,[false,false],'invalid fields must be able to receive focus before the pending state');assert.equal(JSON.stringify(d),before);assert.equal(w.s.validations.length,0);
  center.openTemplate('S01');assert.doesNotMatch(drawer.innerHTML,/77,970|84,467|value="BTC\/USDT" selected/);await click('configure');assert.match(drawer.innerHTML,/name="bot_lower"[^>]*value=""/);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.match(drawer.innerHTML,/name="amount"[^>]*value=""/);assert.match(drawer.innerHTML,/选择账户后显示|Select an account to view/);assert.match(drawer.innerHTML,/data-id="0.25" disabled/);assert.equal(drawer.dataset.phase,'configure');assert.doesNotMatch(drawer.innerHTML,/<b>Quote currency<\/b>|<b>报价币<\/b>/);
  const outer={open:false,parentElement:null},inner={open:false,parentElement:{closest:()=>outer}};
  formEvents.invalid({target:{closest:()=>inner}});assert.equal(inner.open,true);assert.equal(outer.open,true,'invalid settings are reachable through every collapsed section');
  events.change({target:{dataset:{strategyRoute:'connectionId'},value:'legacy-exchange'}});assert.match(drawer.innerHTML,/(?:可分配额度|Available allocation)[\s\S]*?<b>1,000 USDT<\/b>/);
  accountData.botSummary={allocated:200};accountData.session={cap:300};accountData.state='paused';await click('mobile-view','settings');assert.match(drawer.innerHTML,/(?:可分配额度|Available allocation)[\s\S]*?<b>500 USDT<\/b>/);
  sync.scope.accountId='SIM-02';await click('mobile-view','settings');assert.match(drawer.innerHTML,/额度暂不可用|Balance unavailable/);assert.match(drawer.innerHTML,/data-id="0.25" disabled/);
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('a novice profile reaches bounded fills and separate research-credit settlement with original protection',async t=>{
 const {research,account,workspace:w,advance:advanceClock}=await commerceFixture(t);
 const {draft}=(await applyRecommendation(w,{goal:'steady',capital:'1000',risk:'medium',pace:'balanced',autonomy:'auto'}));
 assert.equal(draft.protection.id,'astarter');assert.equal(w.s.risk.dailyLoss,100);
 assert.equal(w.available,600);assert.equal(w.reserved,0);assert.equal(w.account.s.preferences.autoEnabled,false);
 assert.equal(w.saveDraft(draft.id,{...draft,amount:100,cap:500,market:route.market,executionRoute:route}),null);
 const check=w.validateSetup();assert.equal(check.error,undefined);advance(w);
 assert.equal(check.run.status,'passed');assert.equal(w.spent,0);
 const demo=new TradingDemo(),dispatch=new DiscoveryDispatch();let policy;
 const desk={snapshot:()=>({...demo,connections:DEFAULT_CONNECTIONS,discovery:{armed:Boolean(dispatch.policy),status:'watching',accountId:dispatch.policy?.executionRoute.accountId,draftId:dispatch.policy?.id,version:dispatch.policy?.version,connectionId:dispatch.policy?.executionRoute.connectionId,requestId:dispatch.policy?.botLaunch.requestId}}),configure:d=>policy=d,arm(){dispatch.arm(policy);return null;}};
 assert.equal(startStrategyWatch(w,desk),null);assert.equal(demo.orders.length,0);
 research.advance(60);assert.equal(dispatch.next(research,demo),null);
 research.task('BTC').outcome='candidate'; // This fixture supplies a qualified BTC opportunity; ETH must not substitute for it.
 const item=dispatch.next(research,demo);assert.equal(item.market,'BTC/USDT');
 const context=research.context(item.market,item.revision);
 assert.equal(demo.start({...dispatch.policy,market:item.market},DEFAULT_CONNECTIONS,context),null);w.started(demo.session);dispatch.accepted(item);
 assert.equal(demo.session.protection.id,'astarter');assert.equal(demo.session.amount,100);assert.equal(demo.session.cap,500);
 for(let i=0;i<450;i++){demo.tick(.1,context);w.tick(.1,{...demo,flow:demo.flow});}
 assert.equal(demo.orders.length,3);assert.ok(demo.orders.every(o=>o.status==='filled'));assert.equal(demo.state,'paused');
 assert.ok(Math.abs(demo.totalFees-.3)<1e-8);assert.ok(Math.abs(demo.equity-9999.7)<1e-8);
 assert.equal(w.available,600);assert.equal(w.spent,0);assert.equal(w.reserved,0);
 const holding=demo.position.qty,cash=demo.cash;
 assert.equal(await w.requestResearch('BTC'),null);assert.equal(w.available,396);assert.equal(w.reserved,204);
 research.advance(80);await advanceClock(1001);w.tick(.1,{...demo,flow:demo.flow});
 assert.equal(w.available,510);assert.equal(w.reserved,0);assert.equal(w.spent,90);
 assert.equal(demo.position.qty,holding);assert.equal(demo.cash,cash);assert.equal(demo.orders.length,3);
});
function prepared({scope='all',byok=false}={}){
 const w=new WorkspaceSim();
 w.setScope(scope);
 w.setBudget({daily:200,byok});
 const d=w.createDraft('S03');
 assert.equal(w.saveDraft(d.id,{amount:125,cap:600,mode:'auto',market:route.market,executionRoute:route}),null);
 const {run,error}=w.validateSetup();
 assert.equal(error,undefined);
 advance(w);
 assert.equal(run.status,'passed');
 assert.equal(w.setupReady,run);
 return {w,d,run};
}
function deskStub(w,patch={},armError=null){
 const state={state:'idle',connections:DEFAULT_CONNECTIONS,session:null,position:null,pending:null,discovery:{armed:false},...patch};
 const calls={configured:[],armed:0};
 return {
  state,calls,
  snapshot:()=>state,
  configure:d=>calls.configured.push({...d}),
  arm(d){calls.armed++;if(armError)return armError;Object.assign(state.discovery,{armed:true,status:'watching',draftId:d.id,version:d.version,connectionId:d.executionRoute.connectionId,accountId:d.executionRoute.accountId,requestId:d.botLaunch.requestId});return null;}
 };
}
function assertRejected(w,desk,pattern){
 let researchStarts=0;
 const credits=w.s.credits,usageCount=w.s.usage.length;
 assert.match(strategyLaunchError(w,desk),pattern);
 assert.match(startStrategyWatch(w,desk,()=>researchStarts++),pattern);
 assert.equal(desk.calls.configured.length,0);
 assert.equal(desk.calls.armed,0);
 assert.equal(researchStarts,0);
 assert.equal(w.s.started,false);
 assert.equal(w.s.strategyCenterArmedDraftId,undefined);
 assert.equal(w.s.credits,credits);
 assert.equal(w.s.usage.length,usageCount);
}

test('strategy setup check reserves credits, finishes, and unlocks the same configuration',async t=>{
 const w=new WorkspaceSim(),d=w.createDraft('S03'),desk=deskStub(w);
 bindRoute(d);const {run}=w.validateSetup();
 assert.equal(run.status,'running');
 assert.equal(w.setupReady,null);
 assert.equal(w.available,980);
 assert.equal(w.s.credits,1000);
 assert.equal(w.reserved,20);
 assertRejected(w,desk,/检查/);
 advance(w);
 assert.equal(d.status,'passed');
 assert.equal(d.validatedVersion,d.version);
 assert.equal(w.setupReady,run);
 assert.equal(w.spent,16);
 assert.equal(w.reserved,0);
 assert.equal(w.available,984);
 assert.equal(w.s.usage.find(u=>u.id===run.usageId).released,4);
 assert.equal(strategyLaunchError(w,desk),null);
});

test('launching a strategy watch configures the selected draft without charging the future start',async t=>{
 const {w,d}=prepared(),desk=deskStub(w);
 let researchStarts=0;
 assert.equal(startStrategyWatch(w,desk,()=>researchStarts++),null);
 assert.equal(desk.calls.configured.length,1);
 assert.equal(desk.calls.configured[0].market,d.market);assert.deepEqual(desk.calls.configured[0].executionRoute,d.executionRoute);assert.equal(desk.calls.configured[0].version,d.version);
 assert.equal(desk.calls.armed,1);
 assert.equal(desk.state.discovery.armed,true);
 assert.equal(w.s.strategyCenterArmedDraftId,d.id);
 assert.equal(w.s.started,true);
 assert.equal(researchStarts,1);
 assert.equal(w.spent,16);
 assert.equal(w.s.usage.length,1);
 assert.equal(w.s.usage.filter(u=>u.kind==='账户私有复核').length,0);
 const session={id:'SIM-START-TEST',market:'ETH/USDT'};
 w.started(session);
 assert.equal(w.spent,20);
 assert.equal(w.s.usage.find(u=>u.id===session.usageId).settled,4);
 assert.equal(session.draftId,d.id);
});

test('BYOK check settles the locked task price without an early execution debit',async t=>{
 const {w}=prepared({byok:true}),desk=deskStub(w);
 assert.equal(w.s.usage[0].reserved,16);
 assert.equal(w.s.usage[0].settled,13);
 assert.equal(w.s.usage[0].released,3);
 assert.equal(startStrategyWatch(w,desk),null);
 assert.equal(w.spent,13);
 assert.equal(w.available,987);
});

test('a draft above the account cap cannot obtain a setup check or spend credits',async t=>{
 const w=new WorkspaceSim(),d=w.createDraft('S03'),desk=deskStub(w);
 assert.equal(w.saveDraft(d.id,{amount:100,cap:1500,mode:'auto'}),null);
 assert.match(w.validateSetup().error,/资金限额/);
 assert.equal(w.s.usage.length,0);
 assertRejected(w,desk,/检查/);
});

test('changing capital, mode, or the selected draft invalidates launch authority',async t=>{
 for(const change of [
  (w,d)=>w.saveDraft(d.id,{...d,cap:700}),
  (w,d)=>w.saveDraft(d.id,{...d,mode:'confirm'}),
  w=>w.createDraft('S03')
 ]){
  const {w,d}=prepared(),desk=deskStub(w);
  change(w,d);
  assert.equal(w.setupReady,null);
  assertRejected(w,desk,/检查/);
 }
});

test('changing risk version or account context requires a fresh check',async t=>{
 for(const change of [
  w=>w.setRisk({cap:800,dailyLoss:80}),
  w=>w.setSetupContext('binance-perp')
 ]){
  const {w}=prepared(),desk=deskStub(w);
  change(w);
  assert.equal(w.setupReady,null);
  assertRejected(w,desk,/检查/);
 }
});

test('a passed check expires at its recorded boundary',async t=>{
 const {w,run}=prepared(),desk=deskStub(w);
 w.s.clock=run.expiresAt-.01;
 assert.equal(strategyLaunchError(w,desk),null);
 w.s.clock=run.expiresAt;
 assert.equal(w.setupReady,null);
 assertRejected(w,desk,/检查已过期/);
});

test('a TradFi-only research universe cannot start the spot simulation',async t=>{
 const {w}=prepared({scope:'tradfi'}),desk=deskStub(w);
 assert.ok(w.setupReady);
 assertRejected(w,desk,/TradFi/);
});

test('existing sessions, positions, and unknown orders all block another watch',async t=>{
 for(const patch of [
  {state:'running',session:{id:'SIM-EXISTING'}},
  {state:'paused',session:{id:'SIM-EXISTING'}},
  {state:'stopped',position:{market:'BTC/USDT',qty:.01}},
  {state:'blocked',pending:{id:'SIM-ORDER',status:'unknown'}}
 ]){
  const {w}=prepared(),desk=deskStub(w,patch);
  assertRejected(w,desk,/已有交易或持仓/);
 }
 const {w}=prepared(),desk=deskStub(w,{state:'stopped',session:{id:'SIM-ENDED'}});
 assert.equal(strategyLaunchError(w,desk),null);
});

test('an already armed watch cannot be silently replaced or charged twice',async t=>{
 const {w}=prepared(),desk=deskStub(w,{discovery:{armed:true}});
 assertRejected(w,desk,/已有策略在等待机会/);
});

test('launch retains WorkspaceSim checkStart and its remaining-credit gate',async t=>{
 const {w}=prepared(),desk=deskStub(w);
 const original=w.checkStart.bind(w);let checked=0;
 w.checkStart=d=>{checked++;return original(d);};
 w.s.credits=3;
 assert.ok(w.setupReady);
 assertRejected(w,desk,/积分/);
 assert.equal(checked,2);
});

test('desk refusal leaves the watch inactive and does not start research or debit credits',async t=>{
 const {w}=prepared(),desk=deskStub(w,{},'当前执行状态已变化');
 let researchStarts=0;
 assert.equal(startStrategyWatch(w,desk,()=>researchStarts++),'当前执行状态已变化');
 assert.equal(desk.calls.configured.length,1);
 assert.equal(desk.calls.armed,1);
 assert.equal(desk.state.discovery.armed,false);
 assert.equal(w.s.started,false);
 assert.equal(w.s.strategyCenterArmedDraftId,undefined);
 assert.equal(researchStarts,0);
 assert.equal(w.spent,16);
});

test('cancelling an in-panel check releases its reservation and cannot later unlock launch',async t=>{
 const w=new WorkspaceSim(),d=w.createDraft('S03'),desk=deskStub(w);
 bindRoute(d);const {run}=w.validateSetup();
 advance(w,1);
 w.cancelValidation(run.id);
 w.cancelValidation(run.id);
 advance(w);
 assert.equal(run.status,'cancelled');
 assert.equal(d.status,'draft');
 assert.equal(w.setupReady,null);
 assert.equal(w.available,1000);
 assert.equal(w.spent,0);
 assert.equal(w.reserved,0);
 assert.equal(w.s.usage[0].released,20);
 assert.equal(w.s.creditEntries.filter(e=>e.kind==='debit').length,0);
 assertRejected(w,desk,/检查/);
});

test('trader discovery reads shared accounts without offering an unavailable paid action',async()=>{
 const {traderDiscoveryView}=await import('./strategy-journeys.mjs');
 const {TRADERS}=await import('./data-center-fixtures.mjs');
 const {usageExperience}=await import('./product-experience.mjs');
 const {SOCIAL_POSTS}=await import('./social-trading.mjs');
 const w=new WorkspaceSim(),before=JSON.stringify([w.s,TRADERS,SOCIAL_POSTS]);
 const html=traderDiscoveryView();
 for(const trader of TRADERS){
  const profile=`?page=social&amp;data=demo&amp;trader=${trader.id}`;
  assert.ok(html.includes(`href="${profile}"`));
  assert.ok(html.includes(`href="${profile}&amp;view=history"`));
 }
 assert.match(html,/href="\?page=social&amp;data=demo"/);
 assert.equal((html.match(/class="copy-trader-row"/g)||[]).length,8);
 assert.match(html,/class="copy-directory-notice"><span>示例数据<\/span>/);
 assert.match(html,/自动跟单尚未开放/);
 assert.equal(html.includes('data-journey="copy-replay"'),false);
 assert.equal(usageExperience(w).includes('Copy-rule replay'),false);
 assert.equal(usageExperience(w).includes('跟随规则演练'),false);
 assert.equal(JSON.stringify([w.s,TRADERS,SOCIAL_POSTS]),before);
});

test('a legacy approval draft is preserved but cannot start a new Agent watch without a new choice',async t=>{
 const w=new WorkspaceSim(),draft=w.draft();draft.mode='confirm';bindRoute(draft);
 const before=JSON.stringify(w.s),calls=[],desk={snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS}),configure:()=>calls.push('configure'),arm:()=>calls.push('arm')};
 assert.match(startStrategyWatch(w,desk),/旧的逐笔确认/);assert.deepEqual(calls,[]);assert.equal(JSON.stringify(w.s),before);
 assert.equal(w.draft().mode,'confirm');assert.equal(w.createDraft('S03').mode,'auto');
});

test('an uncertain start is reconciled after refresh and never sent a second time',()=>{
 const {w,d}=prepared();let starts=0;
 const desk={snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS}),configure(){},arm(){starts++;throw Error('reply lost');}};
 assert.match(startStrategyWatch(w,desk),/尚未确认/);const request=d.botLaunch.requestId;
 const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};w.storage=storage;w.touch();
 const restored=new WorkspaceSim({storage});
 assert.match(startStrategyWatch(restored,desk),/不会重复启动/);assert.equal(starts,1);assert.equal(restored.draft().botLaunch.requestId,request);
 restored.draft().amount=110;restored.draft().version++;
 assert.match(startStrategyWatch(restored,desk),/不会重复启动/);assert.equal(starts,1);
 const original=new WorkspaceSim({storage});
 const receipt={draftId:d.id,version:d.version,connectionId:d.executionRoute.connectionId,accountId:d.executionRoute.accountId,requestId:request};
 for(const mismatch of [{requestId:'another-request'},{connectionId:'another-connection'},{accountId:'SIM-02'},{draftId:'another-draft'},{version:d.version+1}]){
  assert.match(reconcileStrategyWatch(original,{snapshot:()=>({state:'running',discovery:{armed:true,...receipt,...mismatch},session:{id:'OTHER-RUN',...receipt,...mismatch}})}),/不会重复启动/);
  assert.equal(original.draft().botLaunch.status,'unknown');
 }
 assert.match(reconcileStrategyWatch(original,{snapshot:()=>({discovery:{armed:true}})}),/不会重复启动/);
 assert.equal(reconcileStrategyWatch(original,{snapshot:()=>({state:'running',session:{id:'RUN-ONE',...receipt}})}),null);
 assert.equal(original.draft().botLaunch.runId,'RUN-ONE');
});

test('the final approval is explicit and double clicks keep one immutable launch snapshot',async()=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim(),d=w.createDraft('S02'),desk=deskStub(w),root={querySelector(){return null;},querySelectorAll(){return [];}};
  assert.equal(w.saveDraft(d.id,{amount:100,cap:500,mode:'auto',market:route.market,executionRoute:route,planVariant:'S02-SIM',botParameters:botParameters('S02')}),null);
  const book=new BotBook({debit:()=>true,credit:()=>true});let creates=0;
  desk.createBot=approved=>{creates++;const result=book.create(approved,{requestId:approved.botLaunch.requestId});desk.state.botBook=book.snapshot();return result.error||null;};
  let quote=null;
  const center=createStrategyCenter({w,desk,root,readQuote:()=>quote,go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
  center.openDraft(d.id);await click('launch');assert.equal(creates,0,'approval cannot skip the review screen');
  const before=JSON.stringify(d);await click('start');assert.equal(drawer.dataset.phase,'configure');assert.equal(JSON.stringify(d),before);assert.equal(w.s.validations.length,0);assert.match(drawer.innerHTML,/行情暂不可用|Market data is unavailable/);
  quote={...route,period:'1H',price:81218.07,closedPrice:81218.076543,closedAt:Date.now()-60_000,asOf:Date.now(),state:'live'};await click('start');advance(w);center.tick(1);
  assert.equal(drawer.dataset.phase,'check');assert.match(drawer.innerHTML,/开始运行|Start run/);assert.equal(creates,0);assert.equal(d.simulationReference.closedPrice,quote.closedPrice);assert.deepEqual(Object.keys(d.simulationReference).sort(),['market','profileId','venueId','period','closedPrice','closedAt','asOf'].sort());
  quote.asOf=Date.now()-30_001;await click('launch');assert.equal(creates,0);assert.equal(drawer.dataset.phase,'configure','an expired quote returns to review without creating a run');
  quote.asOf=Date.now();await click('start');
  const usage=w.s.usage.length;await click('launch');await click('launch');assert.equal(creates,1);assert.equal(w.s.usage.length,usage);
  const frozen=JSON.stringify(book.snapshot().runs[0].plan);center.openDraft(d.id);await click('save');assert.match(drawer.innerHTML,/运行中的方案不能覆盖|This plan is running/);assert.equal(JSON.stringify(book.snapshot().runs[0].plan),frozen);
  d.protection.mode='conservative';assert.equal(JSON.stringify(book.snapshot().runs[0].plan),frozen);
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('new restored and source research plans cannot enter native BOT approval',async()=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 try{
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  for(const entry of ['new','saved','restored','source']){
   const events={},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){this.open=true;}};
   globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};
   const {w,d}=prepared(),desk=deskStub(w);let creates=0;desk.createBot=()=>{creates++;};
   if(entry==='restored')w.s.botEditors={S03:{id:'S03',draftId:d.id,baseVersion:d.version,variant:'baseline',amount:d.amount,cap:d.cap,mode:'auto',protection:d.protection,researchBudget:200,executionRoute:route}};
   const center=createStrategyCenter({w,desk,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
   if(entry==='saved')center.openDraft(d.id);
   else center.openTemplate('S03',null,entry==='source'?{type:'signal',id:'s03-source',instrument:{market:'BTC/USDT'}}:null);
   if(entry==='restored')await click('resume-editor');else await click('configure');
   assert.equal((drawer.innerHTML.match(/class="ux-inline-note"/g)||[]).length,1,entry+' keeps one research-only notice');
   assert.doesNotMatch(drawer.innerHTML,/data-sc="start"|data-sc="launch"/,entry);assert.doesNotMatch(center.savedPlans(),/设置并启动|Set up & start/,entry);
   const validations=w.s.validations.length;await click('start');await click('launch');
   assert.equal(drawer.dataset.phase,'configure',entry);assert.equal(w.s.validations.length,validations,entry);assert.equal(creates,0,entry);assert.equal(desk.calls.armed,0,entry);
  }
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('a successful arm without a matching receipt stays unknown and cannot submit again',()=>{
 const {w,d}=prepared(),desk=deskStub(w);let starts=0;desk.arm=approved=>{desk.calls.armed++;Object.assign(desk.state.discovery,{armed:true,status:'watching',draftId:approved.id,version:approved.version,connectionId:'different-connection',accountId:approved.executionRoute.accountId,requestId:approved.botLaunch.requestId});return null;};
 assert.match(startStrategyWatch(w,desk,()=>starts++),/不会重复启动/);assert.equal(d.botLaunch.status,'unknown');assert.equal(w.s.started,false);assert.equal(starts,0);
 const request=d.botLaunch.requestId;assert.match(startStrategyWatch(w,desk),/不会重复启动/);assert.equal(desk.calls.armed,1);assert.equal(d.botLaunch.requestId,request);
 desk.state.discovery.connectionId=d.executionRoute.connectionId;assert.equal(reconcileStrategyWatch(w,desk),null);assert.equal(d.botLaunch.status,'accepted');assert.equal(desk.calls.armed,1);
});

test('a precise stopped or interrupted receipt ends the request and requires a fresh check before another approval',()=>{
 for(const status of ['stopped','interrupted','failed']){
  const {w,d}=prepared(),desk=deskStub(w);assert.equal(startStrategyWatch(w,desk),null);const first=d.botLaunch.requestId,receipt={...desk.state.discovery,status};delete receipt.armed;
  desk.state.discovery={armed:false};d.botLaunch.receipt={...receipt,requestId:'other-request'};assert.match(reconcileStrategyWatch(w,desk),/不会重复启动/);assert.equal(d.botLaunch.status,'unknown');
  d.botLaunch.receipt=receipt;desk.state.discovery={...receipt,status:'started',armed:false};assert.equal(reconcileStrategyWatch(w,desk),null);assert.equal(d.botLaunch.status,status);assert.equal(w.setupReady,null);assert.equal(w.s.strategyCenterArmedDraftId,null);
  assert.match(startStrategyWatch(w,desk),/重新检查/);assert.equal(desk.calls.armed,1);
  w.validateSetup();advance(w);assert.equal(startStrategyWatch(w,desk),null);assert.equal(desk.calls.armed,2);assert.notEqual(d.botLaunch.requestId,first);assert.equal(d.botLaunch.attempt,2);
 }
});

test('an exact session receipt identifies its run and distinguishes completed work from waiting',()=>{
 const {w,d}=prepared(),desk=deskStub(w);assert.equal(startStrategyWatch(w,desk),null);
 desk.state.discovery={armed:false};desk.state.session={id:'SIM-BOUND',draftId:d.id,version:d.version,requestId:d.botLaunch.requestId,connectionId:d.executionRoute.connectionId,accountId:d.executionRoute.accountId};desk.state.state='paused';desk.state.position={qty:.01};
 d.botLaunch.receipt={...desk.state.session,status:'stopped',runId:'SIM-STALE'};
 assert.equal(reconcileStrategyWatch(w,desk),null);assert.equal(d.botLaunch.status,'started');assert.equal(d.botLaunch.runId,'SIM-BOUND');assert.equal(desk.calls.armed,1);
 desk.state.state='stopped';desk.state.position=null;assert.equal(reconcileStrategyWatch(w,desk),null);assert.equal(d.botLaunch.status,'stopped');assert.equal(w.setupReady,null);assert.equal(desk.calls.armed,1);
});

test('reopening an old draft after another run replaces its session preserves the saved terminal result',()=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const {w,d}=prepared(),desk=deskStub(w);assert.equal(startStrategyWatch(w,desk),null);
  const identity={draftId:d.id,version:d.version,requestId:d.botLaunch.requestId,connectionId:d.executionRoute.connectionId,accountId:d.executionRoute.accountId};
  Object.assign(desk.state,{state:'stopped',session:{...identity,id:'SIM-OLD'},discovery:{...identity,status:'started',armed:false}});
  const tick=()=>w.tick(0,{...desk.state,orders:[],signalHistory:[]});tick();assert.equal(d.botLaunch.receipt.status,'stopped');assert.equal(d.botLaunch.receipt.runId,'SIM-OLD');
  desk.state.session={...identity,id:'SIM-NEW',draftId:'OTHER-DRAFT',requestId:'other-request'};desk.state.state='running';tick();
  const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};w.storage=storage;w.persist();
  const restored=new WorkspaceSim({storage}),root={querySelector(){return null;},querySelectorAll(){return [];}},center=createStrategyCenter({w:restored,desk,root,go(){},refresh(){},notify(){}});
  center.openDraft(d.id);
  assert.equal(drawer.dataset.phase,'ended');assert.equal(restored.draft(d.id).botLaunch.status,'stopped');assert.equal(restored.draft(d.id).botLaunch.runId,'SIM-OLD');assert.equal(restored.setupReady,null);assert.equal(desk.calls.armed,1);
  assert.match(center.savedPlans(),/<i><\/i>(已结束|Ended)<\/span>/);
  delete restored.draft(d.id).botLaunch.runId;assert.match(center.savedPlans(),/<i><\/i>(已结束|Ended)<\/span>/);
  delete restored.draft(d.id).botLaunch.receipt.runId;assert.match(center.savedPlans(),/<i><\/i>(观察已关闭|Watch stopped)<\/span>/);
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('the creation directory contains all strategies and no management or catalog filter noise',async t=>{
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.matchMedia=()=>({matches:false});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 const {w}=prepared(),desk=deskStub(w),before=JSON.stringify(w.s),center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go(){},refresh(){},notify(){}}),html=center.render('strategies');
 assert.equal((html.match(/data-strategy=/g)||[]).length,18);assert.match(html,/data-bot-page="create"/);assert.match(html,/策略总览|Strategy overview/);assert.match(html,/data-strategy-workspace-host/);
 assert.doesNotMatch(html,/mp-group|sc-search|mp-time|添加 Agent|Add Agent|data-id="(?:my-strategies|logs|execution)"/);assert.equal(JSON.stringify(w.s),before);assert.equal(desk.calls.armed,0);
 await events.click({target:{closest:()=>({type:'button',dataset:{sc:'workspace-select',id:'S01'}})}});assert.equal(drawer.dataset.family,'S01');assert.equal(drawer.dataset.phase,'configure');assert.equal(desk.calls.armed,0);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);
});

test('one sidebar selection drives an inline chart and configuration while preserving each editor without starting',async()=>{
 let narrow=false;
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},settings={cap:'320',amount:'80',mode:'signal',researchBudget:'0'},scroll={scrollTop:0};
 const shows={modal:0,inline:0},host={append(node){node.parentElement=this;}},form={reportValidity(){return true;},addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:['.sc-drawer-body','.bot-settings-scroll','.bot-creation-market'].includes(s)?scroll:null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},showModal(){shows.modal++;this.open=true;},show(){shows.inline++;this.open=true;},close(){this.open=false;}};
 try{
  globalThis.document={activeElement:null,scrollingElement:{scrollTop:55},body:{dataset:{page:'strategies'},append(node){node.parentElement=this;}},addEventListener(){},removeEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(settings));}};globalThis.matchMedia=query=>({matches:query.includes('prefers-reduced-motion')||narrow&&query==='(max-width:767px)',addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const {w}=prepared(),desk=deskStub(w),fields=Object.fromEntries(['mp-scope','mp-time','mp-sort','mp-group','sc-search','sc-ready','sw-strategy-choice'].map(id=>['#'+id,{value:'',focus(){},setSelectionRange(){}}]));
  const before={drafts:JSON.stringify(w.s.drafts),validations:JSON.stringify(w.s.validations),credits:w.available},root={scrollTop:0,querySelector:s=>s==='[data-strategy-workspace-host]'?host:fields[s]||null,querySelectorAll(){return [];}};
  let html,center;const refresh=()=>{html=center.render('strategies');center.bind();};center=createStrategyCenter({w,desk,root,go(){},refresh,notify(){}});refresh();
  const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
  assert.match(html,/sw-workspace/);assert.doesNotMatch(html,/mp-grid|mp-card/);assert.equal((html.match(/data-strategy=/g)||[]).length,18);assert.equal((html.match(/data-capability=/g)||[]).length,0);assert.equal(shows.modal,0);assert.equal(shows.inline,1);assert.equal(drawer.dataset.phase,'configure');assert.equal(drawer.dataset.family,'S01');
  await click('workspace-select','S03');await click('workspace-select','S01');assert.equal(drawer.dataset.family,'S01');assert.equal(w.s.botEditors.S03.cap,'320');assert.match(drawer.innerHTML,/name="bot_lower"/);assert.match(drawer.innerHTML,/data-sc="save-plan"/);assert.match(drawer.innerHTML,/data-sc="view-list"/);assert.doesNotMatch(drawer.innerHTML,/data-sc="launch"/);
  await click('workspace-select','S03');assert.equal(drawer.dataset.family,'S03');assert.match(drawer.innerHTML,/name="cap"[^>]*value="320"/);
  events.change({target:{dataset:{strategyRoute:'market'},value:'ETH/USDT'}});assert.equal(w.s.botEditors.S03.executionRoute.market,'ETH/USDT');assert.match(drawer.innerHTML,/ETH\/USDT/);assert.match(drawer.innerHTML,/data-trading-chart="strategy-create-market"/);
  await click('workspace-select','product:perp-grid');assert.equal(drawer.dataset.phase,'candidate');assert.match(drawer.innerHTML,/Futures grid|合约网格/);assert.doesNotMatch(drawer.innerHTML,/<form|data-sc="start"|data-sc="launch"|data-sc="choose-instrument"/);
  await click('workspace-select','S03');assert.equal(drawer.dataset.family,'S03');assert.equal(w.s.botEditors.S03.executionRoute.market,'ETH/USDT');assert.match(drawer.innerHTML,/name="cap"[^>]*value="320"/);
  narrow=true;root.scrollTop=420;await click('mobile-view','market');assert.equal(root.scrollTop,0);assert.equal(document.scrollingElement.scrollTop,55);root.scrollTop=75;await click('mobile-view','settings');assert.equal(root.scrollTop,420);narrow=false;
  desk.access=()=>({ready:false,code:'connection-missing'});
  await click('save');assert.equal(drawer.open,true,'Saving a local draft must keep the inline workspace available');assert.match(drawer.innerHTML,/草稿已保存，可在“我的 Agent”继续配置|Draft saved\. Continue setup in My Agents/);assert.doesNotMatch(drawer.innerHTML,/data-sc="resolve-access"/);assert.match(drawer.innerHTML,/name="cap"[^>]*value="320"/);
  await click('check');assert.match(drawer.innerHTML,/data-tone="error" role="alert"/);
  assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(JSON.stringify(w.s.validations),before.validations);assert.equal(w.available,before.credits);assert.equal(desk.calls.armed,0);
 }finally{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('source templates load the requested compatible variant and preserve its saved edits',async t=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'300',amount:'60',mode:'signal',researchBudget:'0'},notices=[];
 const form={reportValidity:()=>true,addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector:s=>s==='#sc-config'?form:null,querySelectorAll:()=>[],addEventListener:(type,fn)=>events[type]=fn,showModal(){this.open=true;},close(){this.open=false;}};
 globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 t.after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const w=new WorkspaceSim(),desk=deskStub(w),center=createStrategyCenter({w,desk,root:{querySelector:()=>null,querySelectorAll:()=>[]},go(){},refresh(){},notify:text=>notices.push(text)});
 const source={type:'research',id:'variant-source',revision:'v1',instrument:{symbol:'BTC',market:'BTC/USDT'},recordedAt:1234,reason:'Keep this original evidence'},before=JSON.stringify(source),drafts=JSON.stringify(w.s.drafts),credits=w.available;
 assert.equal(center.openTemplate('S03',null,source,{variant:'E02'}),true);assert.match(drawer.innerHTML,/已带入来源|Source attached/);assert.doesNotMatch(drawer.innerHTML,/建议已采用|Recommendation applied/);events.input({});
 const saved=Object.values(w.s.botEditors).find(editor=>editor.source?.id===source.id);assert.equal(saved.variant,'E02');assert.equal(saved.cap,'300');assert.equal(saved.source.recordedAt,1234);
 assert.equal(center.openTemplate('S03',null,source,{variant:'baseline'}),true);assert.match(drawer.innerHTML,/name="cap"[^>]*value="300"/);assert.equal(saved.variant,'E02','a reopened source keeps the user draft rather than reapplying a preset');
 const current=drawer.innerHTML;assert.equal(center.openTemplate('S03',null,{...source,id:'bad-variant'},{variant:'S01-SIM'}),false);assert.equal(drawer.innerHTML,current);assert.ok(notices.length);
 assert.equal(JSON.stringify(source),before);assert.equal(JSON.stringify(w.s.drafts),drafts);assert.equal(w.available,credits);assert.equal(desk.calls.armed,0);
});
test('source entry seeds its explicit asset without overwriting an existing draft, and old inputs require an explicit resume',async()=>{
 const prior={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={},fields={cap:'375',amount:'75',mode:'signal',researchBudget:'0'},scroll={scrollTop:0},host={append(node){node.parentElement=this;}};
 const form={reportValidity(){return true;},addEventListener(){}},drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},querySelector(s){return s==='#sc-config'&&this.dataset.phase==='configure'?form:['.sc-drawer-body','.bot-settings-scroll','.bot-creation-market'].includes(s)?scroll:null;},querySelectorAll(){return [];},addEventListener(t,h){events[t]=h;},show(){this.open=true;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  const exits=[];let created=false;
  globalThis.document={activeElement:null,body:{dataset:{page:'strategies'},append(node){node.parentElement=this;}},addEventListener(){},removeEventListener(){},createElement:()=>{if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};globalThis.matchMedia=q=>({matches:q.includes('prefers-reduced-motion'),addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const {saveBotEditor}=await import('./strategy-routing.mjs'),w=new WorkspaceSim(),d=w.draft(),desk=deskStub(w),root={querySelector:s=>s==='[data-strategy-workspace-host]'?host:null,querySelectorAll(){return [];}};
  const old={id:'S03',draftId:d.id,baseVersion:d.version,variant:'baseline',amount:'75',cap:'375',mode:'signal',protection:{id:'original',version:'strategy-original'},researchBudget:'0',executionRoute:{...route}};
  saveBotEditor(w,old);const beforeDrafts=JSON.stringify(w.s.drafts),beforeTrade=JSON.stringify(desk.state),credits=w.available;let returned1=0,returned2=0;
  const center=createStrategyCenter({w,desk,root,go(){},refresh(){},notify(){}});
  const click=(sc,id='')=>events.click({target:{closest:()=>({type:'button',dataset:{sc,id}})}});
  center.openTemplate('S03');assert.equal(drawer.dataset.phase,'resume');assert.doesNotMatch(drawer.innerHTML,/data-trading-chart=|id="sc-config"/);
  await click('new-editor');assert.equal(drawer.dataset.phase,'configure');assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.match(drawer.innerHTML,/data-trading-chart="strategy-create-market"/);assert.match(drawer.innerHTML,/BTC\/USDT/);assert.ok(w.s.botEditors['S03:previous']);
  Object.assign(fields,{cap:'500',amount:'100',mode:'auto'});await click('restore-previous');assert.match(drawer.innerHTML,/name="cap"[^>]*value="375"/);assert.match(drawer.innerHTML,/BTC\/USDT/);Object.assign(fields,{cap:'375',amount:'75',mode:'signal'});
  const originalEditor=JSON.stringify(w.s.botEditors.S03),source={type:'signal',id:'signal-ETH',revision:2,instrument:{symbol:'ETH',market:'ETH/USDC',chainId:'1',ca:'0x111'},recordedAt:'2026-11-07'};
  assert.equal(center.openTemplate('S03',()=>returned1++,source),true);assert.equal(drawer.dataset.phase,'configure');assert.match(drawer.innerHTML,/signal-ETH|0x111/);assert.match(drawer.innerHTML,/来源|Source/);assert.match(drawer.innerHTML,/data-trading-chart="strategy-create-market"/);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.match(drawer.innerHTML,/来源未标明交易市场|does not specify a trading market/);assert.match(drawer.innerHTML,/<aside class="sw-source-note"[^>]*><details open>/);
  source.instrument.ca='changed-by-caller';assert.doesNotMatch(drawer.innerHTML,/changed-by-caller/);
  Object.assign(fields,{cap:'220',amount:'55',mode:'signal'});events.input({});assert.equal(JSON.stringify(w.s.botEditors.S03),originalEditor);
  const first=Object.values(w.s.botEditors).find(x=>x.source?.id==='signal-ETH'&&x.source?.instrument?.ca==='0x111');assert.equal(first.cap,'220');assert.equal(first.executionRoute.market,'ETH/USDC');assert.equal(first.executionRoute.accountId,'');
  assert.equal(center.openTemplate('S03',()=>returned1++,{...source,instrument:first.source.instrument}),true);assert.match(drawer.innerHTML,/name="cap"[^>]*value="220"/);assert.equal(JSON.stringify(w.s.botEditors.S03),originalEditor);
  assert.equal(center.openTemplate('S03',()=>returned2++,{...source,instrument:{symbol:'ETH',chainId:'56',ca:'0x222'}}),true);assert.match(drawer.innerHTML,/0x222/);assert.match(drawer.innerHTML,/name="cap"[^>]*value=""/);assert.doesNotMatch(drawer.innerHTML,/data-trading-chart=/);
  const unchanged=drawer.innerHTML;assert.equal(center.openTemplate('S03',null,{type:'signal',id:'bad',instrument:{symbol:{invalid:true}}}),false);assert.equal(drawer.innerHTML,unchanged);
  Object.assign(fields,{cap:'500',amount:'100',mode:'auto'});await click('return-source');assert.equal(returned2,0);assert.equal(exits.at(-1).open,true);exits.at(-1).choose('keep');assert.equal(returned1,0);assert.equal(returned2,1);
  let backToList=0;center.openTemplate('S04',()=>backToList++);assert.match(drawer.innerHTML,/返回列表|Back to list/);assert.match(drawer.innerHTML,/data-sc="return-source"/);Object.assign(fields,{cap:'',amount:'',mode:'signal',researchBudget:String(w.s.botEditors.S04.researchBudget)});const count=exits.length;await click('return-source');assert.equal(backToList,1);assert.equal(exits.length,count,'ordinary viewing does not show an exit decision');
  assert.equal(JSON.stringify(w.s.drafts),beforeDrafts);assert.equal(JSON.stringify(desk.state),beforeTrade);assert.equal(w.available,credits);assert.equal(desk.calls.armed,0);
 }finally{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('the questionnaire presents research plans and execution preferences without granting BOT execution',async()=>{
 for(const choices of [{goal:'steady',risk:'medium'},{goal:'active',risk:'medium'},{goal:'steady',risk:'low'},{goal:'observe',risk:'medium'}]){
  const w=new WorkspaceSim();w.s.advisor={answers:{...choices,capital:'1000',pace:'balanced',autonomy:'auto'}};
  const before=JSON.stringify([w.s.drafts,w.s.risk,w.s.budget,w.available]),next={dataset:{journey:'next'}},root={scrollTop:0,querySelector(){return null;},querySelectorAll(){return [next];}};
  const journeys=createStrategyJourneys({w,root,go(){},refresh(){},notify(){}});journeys.bind(root);
  for(let i=0;i<5;i++)await next.onclick();
  const html=journeys.render('advisor');
  assert.ok(html.includes('你的起步方案'));assert.ok(html.includes('研究方案起步'));assert.ok(html.includes('该版本尚未开放机器人运行'));
  assert.ok(html.includes('你的执行偏好'));assert.ok(!html.includes('模拟流程，需继续选择账户与资产'));assert.ok(!html.includes('信号出现后'));
  assert.equal(JSON.stringify([w.s.drafts,w.s.risk,w.s.budget,w.available]),before,'viewing the result cannot change capability, limits, saved plans or funds');
 }
});

test('resource failure, elapsed time and reapplying a fresh quote do not leave an unapproved stale reference in the editor',async()=>{
 const previous={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},realNow=Date.now;
 let now=Date.UTC(2026,10,7,23,3,26),creates=0,ensures=0;
 Date.now=()=>now;
 const route={market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'legacy-exchange',chainId:''};
 const quote=()=>({...route,period:'1H',price:75790.01,closedPrice:75747.98,closedAt:Date.UTC(2026,10,7,23),asOf:now,state:'live'});
 const seed=({market,profileId,venueId,period,closedPrice,closedAt,asOf})=>({market,profileId,venueId,period,closedPrice,closedAt,asOf});
 try{
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  for(const kind of ['new','existing','saved']){
   const saved=kind==='saved',id=kind==='new'?'S01':'S02';
   const events={},note={textContent:''},cardNodes={small:{},p:{},button:{}},card={querySelector:key=>cardNodes[key]};
   const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(key){return key==='[data-bot-range-note]'?note:key==='.bot-recommendation'?card:null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},showModal(){this.open=true;}};
   globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};
   const w=new WorkspaceSim(),d=kind==='new'?null:w.createDraft(id),parameters=botParameters(id,quote().closedPrice);
   if(d)assert.equal(w.saveDraft(d.id,{amount:100,cap:500,mode:'auto',market:route.market,executionRoute:route,planVariant:id+'-SIM',botParameters:parameters}),null);
   if(saved)assert.equal(w.saveDraft(d.id,{...d,simulationReference:seed(quote())}),null);
   const original=JSON.stringify(w.s.drafts),fingerprint=d?botPlanFingerprint(d):null;
   w.s.botEditors={[id]:{id,draftId:d?.id||null,baseVersion:d?.version||null,variant:id+'-SIM',amount:100,cap:500,mode:'auto',protection:d?.protection||{id:'original',version:'strategy-original'},researchBudget:200,executionRoute:route,botParameters:parameters,parameterSource:'recommended',parameterReference:quote(),...(saved?{simulationReference:d.simulationReference}:{})}};
   w.createManagedDraft=async()=>{creates++;w.draftSaveError='The saved-item limit has been reached.';return null;};
   w.ensureDraftEntitlement=async()=>{ensures++;return 'The saved-item limit has been reached.';};
   const center=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS})},root:{querySelector(){return null;},querySelectorAll(){return [];}},readQuote:quote,go(){},refresh(){},notify(){}});
   const click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
   if(d)center.openDraft(d.id);else {center.openTemplate(id);await click('resume-editor');}
   await click('start');assert.match(drawer.innerHTML,/saved-item limit/);assert.equal(JSON.stringify(w.s.drafts),original);
   now+=31_000;await click('apply-bot-parameters');
   assert.equal(note.textContent,'','fresh market data must not be called stale because a failed check had an old seed');
   assert.equal(JSON.stringify(w.s.drafts),original);if(d)assert.equal(botPlanFingerprint(d),fingerprint);
   assert.equal(Object.hasOwn(w.s.botEditors[id],'simulationReference'),false,'only the transient editor reference is cleared');
   assert.equal(w.s.validations.length,0);assert.equal(w.s.trade,null);
  }
  assert.equal(creates,1);assert.equal(ensures,2);
 }finally{
  Date.now=realNow;
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
 }
});

test('an existing BTC reference does not lock a changed instrument or connection after reapplying and reopening the editor',async()=>{
 const previous={document:globalThis.document,FormData:globalThis.FormData,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 try{
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  for(const change of ['market','connectionId']){
   const events={},form={reportValidity:()=>true,addEventListener(){}},note={textContent:''};
   const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(key){return key==='#sc-config'&&this.dataset.phase==='configure'?form:key==='[data-bot-range-note]'?note:null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
   const exits=[];let created=false;
   globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>{if(!created){created=true;return drawer;}const dialog=editExitStub();exits.push(dialog);return dialog;}};
   const fields={amount:'100',cap:'500',mode:'auto',researchBudget:'200',...Object.fromEntries(Object.entries(botParameters('S02')).map(([k,v])=>['bot_'+k,String(v)]))};
   globalThis.FormData=class extends Map{constructor(){super(Object.entries(fields));}};
   const route={market:'BTC/USDT',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'api-main',chainId:''},w=new WorkspaceSim(),d=w.createDraft('S02');
   const reference={market:route.market,profileId:route.profileId,venueId:route.venueId,period:'1H',closedPrice:75747.98,closedAt:Date.now()-60_000,asOf:Date.now()-31_000};
   assert.equal(w.saveDraft(d.id,{amount:100,cap:500,mode:'auto',market:route.market,executionRoute:route,planVariant:'S02-SIM',botParameters:botParameters('S02'),simulationReference:reference}),null);
   const before=JSON.stringify(d),oldReference=structuredClone(d.simulationReference);
   const connections=normalizeConnections({exchange:true,tradingAccounts:['api-main','api-alt'].map(id=>({id,label:id,kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'}))});
   const readQuote=()=>{const selected=w.s.botEditors.S02?.executionRoute||route;return {...selected,period:'1H',price:selected.market==='ETH/USDT'?2233:75790,closedPrice:selected.market==='ETH/USDT'?2232.87:75747.98,closedAt:Date.now()-60_000,asOf:Date.now(),state:'live'};};
   const center=createStrategyCenter({w,desk:{snapshot:()=>({state:'idle',connections})},root:{querySelector(){return null;},querySelectorAll(){return [];}},readQuote,go(){},refresh(){},notify(){}}),click=sc=>events.click({target:{closest:()=>({type:'button',dataset:{sc}})}});
   center.openDraft(d.id);events.change({target:{dataset:{strategyRoute:change},value:change==='market'?'ETH/USDT':'api-alt'}});await click('apply-bot-parameters');
   assert.equal(note.textContent,'');assert.equal(JSON.stringify(d),before,'uncommitted edits cannot change the canonical plan');
   await click('close');assert.equal(exits.at(-1).open,true);exits.at(-1).choose('keep');center.openDraft(d.id);await click('save');
   assert.equal(d.market,change==='market'?'ETH/USDT':'BTC/USDT');assert.equal(d.executionRoute.connectionId,change==='connectionId'?'api-alt':'api-main');
   assert.equal(Object.hasOwn(d,'simulationReference'),false,'saving edited settings clears the old approval reference');assert.deepEqual(reference,oldReference);
   assert.equal(w.s.validations.length,0);assert.equal(w.s.trade,null);
  }
 }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('English strategy memory shows source status and structured legacy choices without leaking source references',()=>{
 const render=(state,rows=[])=>withLocale('en',()=>strategyMemoryLines(state,rows));
 assert.equal(render('ready'),'<p>Nothing saved yet</p>');
 assert.equal(render('loading'),'<p>Reading Living Brain…</p>');
 assert.equal(render('unavailable'),'<p>Living Brain is unavailable.</p>');
 const plan={amount:'11',cap:'37',venue:'binance',instrument:'BTC/USDT',parameters:''};
 const html=render('ready',[{status:'completed',marketType:'cex-spot',body:'金额: 11\n上限: 37\noriginRef: private',plan},
  {status:'compiling',marketType:'cex-spot',plan,decision:{standard:true}}]);
 for(const label of ['Saved plan','Compiled','Save decision','Compiling','cex-spot','binance','BTC/USDT','Amount 11','Cap 37','No order was sent.']){
  assert.ok(html.includes(label),label);
 }
 assert.doesNotMatch(html,/originRef|金额|上限|private/);
});
