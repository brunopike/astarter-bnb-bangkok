import {workbenchAttention} from './workbench-console.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffAllowed,opportunityRows,resumeReviewedResearch,signalStrategySource} from './business-pages.js';
import {canReviewResearchChange} from './execution-views.mjs';
import {guardedResearchContext,resumeWithResearch} from './trading-desk.js?v=20261120c';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {BotBook,botParameters} from './bot-runtime.mjs';

test('signal strategy suggestions preserve source identity and distinguish simulation time',()=>{
 const historical={signalId:'TRACK-ETH-4',version:'4',instrument:{symbol:'ETH',market:null,venue:null,chainId:'1',ca:'0x123'},clockKind:'historical',observedAt:'2026-10-24T12:10:00+08:00',condition:'Waiting for confirmation'};
 const source=signalStrategySource(historical);
 assert.equal(source.id,'TRACK-ETH-4');assert.equal(source.revision,'4');assert.deepEqual(source.instrument,historical.instrument);
 assert.equal(source.recordedAt,Date.parse(historical.observedAt));assert.equal(source.reason,historical.condition);assert.equal(source.instrument.market,null);
 assert.equal(signalStrategySource({...historical,clockKind:'simulation',observedAt:3600}).recordedAt,'SIM T+3600s');assert.equal(signalStrategySource({...historical,clockKind:'simulation',observedAt:null}).recordedAt,null);assert.equal(signalStrategySource(null),null);
});

test('research strategy browsing keeps an active run untouched and rejects stale research',async()=>{
 const {createBusinessPages}=await import('./business-pages.js'),{WorkspaceSim}=await import('./workspace-sim.mjs'),{MultiResearch}=await import('./multi-research.mjs');
 const prior={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 const nodes=[],routes=[];
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'workbench'},append(node){node.parentElement=this;}},addEventListener(){},removeEventListener(){},createElement(){
   const events={},node={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},show(){this.open=true;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};nodes.push(node);return node;
  }};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const research=new MultiResearch();research.advance(50);const w=new WorkspaceSim({research}),trade=new TradingDemo();
  trade.state='running';trade.session={id:'existing-run',market:'BTC/USDT'};trade.position={market:'BTC/USDT',qty:.01};
  const before={trade:JSON.stringify(trade),drafts:JSON.stringify(w.s.drafts),credits:w.available},desk={snapshot:()=>trade,readSnapshot:()=>trade,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}})},host={append(node){node.parentElement=this;}},root={querySelector(selector){return selector==='[data-strategy-workspace-host]'?host:null;},querySelectorAll(){return [];}};
  const pages=createBusinessPages({workspace:w,desk,research,root,go:page=>routes.push(page),notify(){},show(){}}),item=research.handoff('ETH');
  let returned=0;assert.equal(pages.openResearchStrategy(item,()=>returned++),null);
  const drawer=nodes.find(node=>node.className==='sc-drawer');assert.deepEqual(routes,['strategies',null]);assert.match(pages.render('strategies'),/data-bot-page="overview"/);assert.match(drawer.innerHTML,/research-ETH|ETH/);assert.ok(drawer.innerHTML.includes(`SIM T+${Math.round(research.task('ETH').completed)}s`));assert.equal(drawer.dataset.family,'RX03-S');
  assert.doesNotMatch(drawer.innerHTML,/data-trading-chart=/);drawer.close();assert.equal(returned,1);
  assert.equal(JSON.stringify(trade),before.trade);assert.equal(JSON.stringify(w.s.drafts),before.drafts);assert.equal(w.available,before.credits);
  research.recheck('ETH');const unchanged=drawer.innerHTML;assert.ok(pages.openResearchStrategy(item));assert.ok(pages.openResearchStrategy(null));assert.deepEqual(routes,['strategies',null]);assert.equal(drawer.innerHTML,unchanged);
 }finally{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('research recovery cannot clear a different block, pending order or retained position',()=>{
 const data={state:'blocked',session:{market:'ETH/USDT'},events:[{text:'研究版本已变化，暂停新增风险；已有模拟持仓保留。'}]};
 assert.equal(canReviewResearchChange(data),true);
 for(const patch of [{pending:{status:'unknown'}},{position:{qty:1}},{session:{market:'ETH/USDT',singleShot:true}},{session:{market:'ETH/USDT',mode:'confirm'}},{state:'paused'},{events:[{text:'资金限制未通过'}]}])assert.equal(canReviewResearchChange({...data,...patch}),false);
});

test('bot evidence opens the exact research version in place and returns without changing a draft or run',async()=>{
 const {createBusinessPages}=await import('./business-pages.js'),{WorkspaceSim}=await import('./workspace-sim.mjs'),{MultiResearch}=await import('./multi-research.mjs'),{strategyRecommendations}=await import('./strategy-advisor.mjs');
 const previous={document:globalThis.document,location:globalThis.location,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver,requestAnimationFrame:globalThis.requestAnimationFrame};
 const frames=[],messages=[],shown=[],routes=[];let focused=false;
 const node=()=>({innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){},show(){this.open=true;},showModal(){this.open=true;},close(){this.open=false;}});
 try{
  const dialog=node();globalThis.document={activeElement:null,body:{dataset:{page:'strategies'},append(n){n.parentElement=this;}},addEventListener(){},removeEventListener(){},createElement:node,querySelector:s=>s==='.product-dialog'?dialog:null};
  globalThis.location={search:'?page=strategies'};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.requestAnimationFrame=fn=>frames.push(fn);
  const research=new MultiResearch();research.advance(50);const w=new WorkspaceSim({research}),trade=new TradingDemo(),row=strategyRecommendations(w,trade).find(r=>r.asset==='ETH'&&r.sourceType==='research');
  assert.ok(row);const button={dataset:{bh:'recommendation-source',id:row.id},focus(){focused=true;}},root={scrollTop:280,dataset:{renderedPage:'strategies'},querySelector(){return null;},querySelectorAll:s=>s==='[data-bh]'||s==='[data-bh="recommendation-source"]'?[button]:[]};
  const desk={snapshot:()=>trade,readSnapshot:()=>trade,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}})};
  const pages=createBusinessPages({workspace:w,desk,research,root,go:page=>routes.push(page),notify:text=>messages.push(text),show:(...args)=>shown.push(args)});
  const before=JSON.stringify({state:w.s,trade});pages.bind();await button.onclick();assert.equal(shown.length,1);assert.match(shown[0][0],/^ETH/);assert.match(shown[0][1],new RegExp(research.revision(research.task('ETH'))));assert.equal(typeof shown[0][2],'function');assert.equal(JSON.stringify({state:w.s,trade}),before);
  root.scrollTop=0;shown[0][2]();frames.splice(0).forEach(fn=>fn());assert.equal(root.scrollTop,280);assert.equal(focused,true);assert.ok(routes.every(page=>page===null));
  research.recheck('ETH');await button.onclick();assert.equal(shown.length,1);assert.ok(messages.length>0);assert.equal(JSON.stringify(trade),JSON.stringify(JSON.parse(before).trade));
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('reviewed resume rechecks account and evidence, and preserves the execution guards',()=>{
 const data={state:'blocked',session:{market:'ETH/USDT',amount:100,cap:500},events:[{text:'研究版本已变化'}]},calls=[];
 const item={market:'ETH/USDT',revision:'r2',mode:'simulation-only'};
 let live=true,ready=true,refusal=null;
 const desk={snapshot:()=>data,syncStatus:()=>({state:live?'LIVE':'STALE',scope:{accountId:'SIM-01',environment:'DEMO'}}),resumeReviewed:reviewed=>{calls.push(reviewed);return refusal;}};
 const research={handoff:market=>ready&&market==='ETH/USDT'?item:null};
 live=false;assert.match(resumeReviewedResearch(desk,research,'r2'),/读取/);assert.deepEqual(calls,[]);
 live=true;ready=false;assert.match(resumeReviewedResearch(desk,research,'r2'),/研究/);assert.deepEqual(calls,[]);
 ready=true;assert.match(resumeReviewedResearch(desk,research,'r1'),/变化/);assert.deepEqual(calls,[]);
 refusal='资金保护未恢复';assert.equal(resumeReviewedResearch(desk,research,'r2'),refusal);assert.deepEqual(calls,[item]);
 calls.length=0;refusal=null;assert.equal(resumeReviewedResearch(desk,research,'r2'),null);assert.deepEqual(calls,[item]);
 assert.deepEqual(data.session,{market:'ETH/USDT',amount:100,cap:500});
 data.session.mode='confirm';calls.length=0;
 assert.match(resumeReviewedResearch(desk,research,'r2'),/不可恢复/);assert.deepEqual(calls,[]);
});

const recoveryFixture=()=>{
 const demo=new TradingDemo(),workspace={s:{risk:{version:1,dailyLoss:50}}};
 const context={market:'BTC/USDT',revision:'r2',ready:true,conflict:0,missing:0};
 const item={market:'BTC/USDT',revision:'r2',mode:'simulation-only'};
 assert.equal(demo.start({market:'BTC/USDT',strategy:'S03',mode:'auto',amount:100,cap:500,riskVersion:1},DEFAULT_CONNECTIONS,{...context,revision:'r1'}),null);
 demo.tick(.1,{...context,ready:false});
 return {demo,workspace,context,item,connections:{...DEFAULT_CONNECTIONS}};
};
test('reviewing a new revision keeps connection, account risk and evidence gates',()=>{
 const {demo,...options}=recoveryFixture();
 const input={...options,session:demo.session};
 assert.equal(guardedResearchContext(options.context,input).ready,false);
 const reviewed={...input,revision:options.item.revision};
 assert.equal(guardedResearchContext(options.context,reviewed).ready,true);
 for(const patch of [{ready:false},{conflict:1},{missing:1},{market:'ETH/USDT'},{revision:'r3'}])assert.equal(guardedResearchContext({...options.context,...patch},reviewed).ready,false);
 for(const key of ['exchange','data','ai'])assert.equal(guardedResearchContext(options.context,{...reviewed,connections:{...options.connections,[key]:false}}).ready,false);
 assert.equal(guardedResearchContext(options.context,{...reviewed,totalFees:50}).ready,false);
 assert.equal(guardedResearchContext(options.context,{...reviewed,session:{...demo.session,riskVersion:2}}).ready,false);
});
test('reviewed research resumes the real fixture without a new allocation or charge',()=>{
 const {demo,...options}=recoveryFixture(),cash=demo.cash;
 const locked={amount:demo.session.amount,cap:demo.session.cap,mode:demo.session.mode};
 assert.equal(resumeWithResearch(demo,options),null);
 assert.equal(demo.state,'running');assert.equal(demo.session.researchRevision,'r2');
 assert.deepEqual({amount:demo.session.amount,cap:demo.session.cap,mode:demo.session.mode},locked);
 assert.equal(demo.cash,cash);assert.equal(demo.totalFees,0);assert.equal(demo.orders.length,0);
 for(let i=0;i<100;i++)demo.tick(.1,options.context);
 assert.equal(demo.orders.length,1);assert.equal(demo.orders[0].status,'filled');
 assert.ok(demo.position.qty>0);assert.ok(demo.totalFees>0);
 assert.ok(Math.abs(demo.equity-(cash-demo.totalFees))<1e-7);
});
test('reviewed research cannot clear unrelated blocks, unknown orders or holdings',()=>{
 for(const patch of [{state:'paused'},{session:null},{pending:{status:'unknown'}},{position:{qty:1}},{events:[{text:'资金保护已暂停'}]}]){
  const {demo,...options}=recoveryFixture();Object.assign(demo,patch);
  const before=JSON.stringify(demo);assert.ok(resumeWithResearch(demo,options));assert.equal(JSON.stringify(demo),before);
 }
 for(const patch of [{mode:'live'},{market:'ETH/USDT'},{revision:'r3'}]){
  const {demo,...options}=recoveryFixture(),before=JSON.stringify(demo);
  assert.ok(resumeWithResearch(demo,{...options,item:{...options.item,...patch}}));assert.equal(JSON.stringify(demo),before);
 }
 const {demo,...options}=recoveryFixture();demo.session.singleShot=true;
 assert.ok(resumeWithResearch(demo,options));assert.equal(demo.state,'blocked');
});
test('the original capital-protection lock still refuses reviewed recovery',()=>{
 const {demo,...options}=recoveryFixture();demo.session.protection={id:'astarter'};demo.capitalProtection={locked:true};
 assert.match(resumeWithResearch(demo,options),/资金保护/);
 assert.notEqual(demo.state,'running');assert.equal(demo.orders.length,0);assert.equal(demo.cash,10000);
});

test('ready Crypto candidates come before work still in progress',()=>{
 const tasks=[
  {symbol:'ETH',phase:'collect',outcome:'candidate',domain:'Crypto'},
  {symbol:'BTC',phase:'complete',outcome:'watch',domain:'Crypto'},
  {symbol:'SOL',phase:'complete',outcome:'conflict',domain:'Crypto'},
  {symbol:'XAU',phase:'complete',outcome:'candidate',domain:'TradFi'},
  {symbol:'NDX',phase:'complete',outcome:'candidate',domain:'Crypto'}
 ];
 assert.deepEqual(opportunityRows(tasks,()=>true,'all').map(t=>t.symbol),['NDX','ETH','SOL','BTC','XAU']);
 assert.deepEqual(opportunityRows(tasks,t=>t.domain==='Crypto','candidate').map(t=>t.symbol),['NDX']);
 assert.deepEqual(opportunityRows(tasks,()=>true,'active').map(t=>t.symbol),['ETH']);
 assert.deepEqual(opportunityRows(tasks,()=>true,'attention').map(t=>t.symbol),['SOL']);
 assert.equal(handoffAllowed(tasks[0]),false);
 assert.equal(handoffAllowed(tasks[2]),false);
 assert.equal(handoffAllowed(tasks[3]),false);
 assert.equal(handoffAllowed(tasks[4]),true);
});

test('Agent opportunities do not become manual order tasks; real execution exceptions stay actionable',()=>{
 const ready={ready:true,control:true},desk={state:'running',session:{id:'R1',mode:'auto'},events:[],discovery:{armed:true}};
 assert.deepEqual(workbenchAttention(desk,ready),[]);
 const legacy={...desk,session:{id:'R1',mode:'confirm'}};
 assert.equal(workbenchAttention(legacy,ready)[0].route,'execution');
 assert.equal(workbenchAttention(legacy,ready).some(item=>item.action==='confirm'),false);
 const problem={...desk,flow:{protections:[{instanceId:'R1',state:'IMPAIRED',targetQuantity:1}]}};
 assert.equal(workbenchAttention(problem,ready)[0].id,'protection');
 assert.equal(workbenchAttention({...problem,pending:{status:'unknown'}},ready)[0].action,'reconcile');
});

test('a read-only access result cannot prepare a new strategy entry',()=>{
 const {demo,...options}=recoveryFixture();
 const c=guardedResearchContext(options.context,{...options,session:demo.session,revision:options.item.revision,access:{ready:false,code:'read-only'}});
 assert.equal(c.ready,false);
});

test('hard strategy configuration failures stay distinct from temporary research waiting',async()=>{
 const {strategyConfigurationError}=await import('./trading-desk.js?v=20261120c');
 const base={connections:{exchange:true,data:true,ai:true},workspace:{s:{risk:{version:2,dailyLoss:100}}},session:{riskVersion:2},totalFees:0};
 assert.equal(strategyConfigurationError(base),'');
 assert.match(strategyConfigurationError({...base,session:{riskVersion:1}}),/资金保护设置已变化/);
 assert.match(strategyConfigurationError({...base,totalFees:100}),/资金保护上限/);
 assert.match(strategyConfigurationError({...base,connections:{...base.connections,data:false}}),/恢复.*连接/);
});

test('trading mode page renders review and legacy drafts and rejects stale checks',async()=>{
 const {createBusinessPages}=await import('./business-pages.js'),{WorkspaceSim}=await import('./workspace-sim.mjs'),{MultiResearch}=await import('./multi-research.mjs');
 const saved={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver};
 try{
  globalThis.document={body:{append(){}},activeElement:null,addEventListener(){},createElement:()=>({setAttribute(){},addEventListener(){}})};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const research=new MultiResearch(),workspace=new WorkspaceSim({research}),data={...new TradingDemo()},desk={snapshot:()=>data};
  const pages=createBusinessPages({workspace,desk,research,root:{querySelector(){return null;},querySelectorAll(){return [];}},go(){},notify(){},show(){}}),draft=workspace.draft();
  Object.assign(draft,{status:'passed',validatedVersion:draft.version,riskVersion:workspace.s.risk.version});
  for(const [mode,label] of [['auto','自动执行'],['review','入场前先批准'],['signal','只研究与提醒'],['confirm','旧版逐笔确认'],['unknown','需要更新执行设置']]){
   draft.mode=mode;const html=pages.render('mandate');assert.ok(html.includes(label));
   if(mode==='review')assert.match(html,/成交后按方案执行止损、止盈和退出/);
   if(['confirm','unknown'].includes(mode))assert.doesNotMatch(html,/data-id="setup"/);
  }
  draft.mode='review';draft.validatedVersion=draft.version-1;assert.doesNotMatch(pages.render('mandate'),/data-id="setup"/);
  draft.validatedVersion=draft.version;workspace.s.validations=[{id:'V-check',draftId:draft.id,version:draft.version,riskVersion:workspace.s.risk.version,status:'passed',progress:100,at:0}];
  assert.match(pages.render('validation'),/data-biz="setup-draft"/);draft.version++;
  const stale=pages.render('validation');assert.match(stale,/这条记录对应旧设置/);assert.doesNotMatch(stale,/data-biz="setup-draft"/);
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('bound strategy research follows its own connection rather than legacy exchange preferences',async()=>{
 const {normalizeConnections}=await import('./connections.mjs?v=20261120c');
 const {strategyConfigurationError}=await import('./trading-desk.js?v=20261120c');
 const route={connectionId:'api-main',profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',chainId:''};
 const connections=normalizeConnections({exchange:false,tradingAccounts:[{id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'}],preferredTradingConnection:'api-main'});
 const session={executionRoute:route,riskVersion:1,market:'BTC/USDT',researchRevision:'r1'},workspace={s:{risk:{version:1,dailyLoss:100}}};
 const context={ready:true,market:'BTC/USDT',revision:'r1'},options={connections,workspace,session,access:{ready:true}};
 assert.equal(strategyConfigurationError(options),'');assert.equal(guardedResearchContext(context,options).ready,true);
 assert.equal(guardedResearchContext(context,{...options,access:{ready:false}}).ready,false);
 assert.equal(guardedResearchContext(context,{...options,access:undefined}).ready,false);
 assert.ok(strategyConfigurationError({...options,connections:{...connections,tradingAccounts:[]}}));
});

async function managementFixture(t){
 const {createBusinessPages}=await import('./business-pages.js'),{WorkspaceSim}=await import('./workspace-sim.mjs'),{MultiResearch}=await import('./multi-research.mjs');
 const globals={document:globalThis.document,window:globalThis.window,location:globalThis.location,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver,CustomEvent:globalThis.CustomEvent},listeners={},routes=[],calls=[],shown=[],created=[],notices=[];
 const node=()=>{const events={},el={open:false,dataset:{},scrollTop:0,style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},contains(button){return this.buttons.includes(button);},querySelector(selector){return selector==='.p-dialog-body'?this:null;},querySelectorAll(selector){return selector==='button'?this.buttons:selector==='[data-biz]'?this.buttons.filter(b=>b.dataset.biz):selector==='[data-sc]'?this.buttons.filter(b=>b.dataset.sc):[];},addEventListener(type,fn){events[type]=fn;},show(){this.open=true;},showModal(){this.open=true;},close(){if(!this.open)return;this.open=false;events.close?.();const back=this.back;this.back=null;back?.();},focus(){}};
  Object.defineProperty(el,'innerHTML',{get(){return this.html||'';},set(value){this.html=value;this.buttons=[...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([,attrs,text])=>({type:'button',tagName:'BUTTON',dataset:Object.fromEntries([...attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([,key,v])=>[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v.replaceAll('&quot;','"')])),disabled:/\bdisabled\b/.test(attrs),textContent:text.replace(/<[^>]*>/g,''),closest(){return null;},focus(){document.activeElement=this;}}));}});el.innerHTML='';return el;};
 const dialog=node(),root=node();
 globalThis.document={activeElement:null,hidden:false,body:{dataset:{page:'workbench'},append(el){el.parentElement=this;}},createElement:()=>{const el=node();created.push(el);return el;},querySelector:s=>s==='.product-dialog'||s==='dialog[open]'&&dialog.open?dialog:null,addEventListener:(type,fn)=>{listeners[type]=fn;},removeEventListener(){},dispatchEvent(event){listeners[event.type]?.(event);}};
 globalThis.window={matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}};globalThis.location={search:'?page=workbench'};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options?.detail;}};
 t.after(()=>{for(const[k,v]of Object.entries(globals)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const research=new MultiResearch(),w=new WorkspaceSim({research}),trade=new TradingDemo();let status={state:'LIVE',scope:{workspaceId:'test-workspace',accountId:'SIM-01',environment:'DEMO'},generation:1};
 const book=new BotBook({debit(amount){trade.cash-=amount;return true;},credit(amount){trade.cash+=amount;return true;}}),executionRoute={accountId:'SIM-01',connectionId:'api-main',venueId:'binance',profileId:'cex-spot',chainId:''};
 const create=(strategy,id)=>{const result=book.create({id,version:1,strategy,planVariant:strategy+'-SIM',market:'ETH/USDT',executionRoute,amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters(strategy)},{requestId:id+':approved'});assert.ok(result.run,result.error);return result.run;};
 const first=create('S02','D-MANAGED'),other=create('S01','D-OTHER');
 const read=()=>({...trade,flow:trade.flow,botBook:book.snapshot(),botSummary:{...book.summary(),revision:book.s.revision}});
 const desk={snapshot:read,readSnapshot:read,syncStatus:()=>status,access:()=>({ready:true}),botAction(id,kind,options){calls.push({id,kind,options});const result=book.action(id,kind,options);return result.error||null;},action(kind,id,options){calls.push({kind,id,options});if(kind==='pause')trade.state='paused';return null;}};
 const pages=createBusinessPages({workspace:w,desk,research,root,go:(...args)=>routes.push(args),notify:text=>notices.push(text),show(title,body,back){shown.push({title,body});dialog.innerHTML=body;dialog.back=back;dialog.showModal();}});
 return {pages,w,trade,book,desk,dialog,root,first,other,calls,shown,routes,created,notices,setStatus:value=>{status=value;},status:()=>status,listeners};
}

test('run management stays on the exact native instance and pauses it without navigation',async t=>{
 const f=await managementFixture(t),before=f.book.snapshot();let returned=0;
 assert.equal(typeof f.pages.openRun,'function');assert.equal(f.pages.openRun(f.first.id,{onReturn:()=>returned++}),true);
 assert.ok(f.dialog.innerHTML.includes(`data-bot-instance="${f.first.id}"`));assert.ok(!f.dialog.innerHTML.includes(`data-bot-instance="${f.other.id}"`));assert.deepEqual(f.book.snapshot(),before);
 const pause=f.dialog.buttons.find(b=>b.dataset.kind==='pause');assert.ok(pause);await pause.onclick();
 assert.equal(f.book.snapshot().runs.find(r=>r.id===f.first.id).status,'paused');assert.equal(f.book.snapshot().runs.find(r=>r.id===f.other.id).status,'running');assert.equal(f.dialog.open,true);assert.deepEqual(f.routes,[]);
 assert.ok(f.dialog.innerHTML.includes(`data-bot-instance="${f.first.id}"`));f.dialog.close();assert.equal(returned,1);f.dialog.close();assert.equal(returned,1);
});

test('an open run dialog refreshes budget holds without issuing actions or redrawing changing risk amounts',async t=>{
 const f=await managementFixture(t),run=f.book.s.runs.find(row=>row.id===f.first.id),message=/风控后额度不足|Risk-adjusted allocation is insufficient/;
 f.pages.openRun(run.id);assert.doesNotMatch(f.dialog.innerHTML,message);
 run.protectionDecision={scope:'BOT_ALLOCATION',action:'pause',reason:'budget',amount:0};
 f.pages.tick(0);assert.match(f.dialog.innerHTML,message);
 const painted=f.shown.length;f.pages.tick(0);assert.equal(f.shown.length,painted);
 const read=f.desk.readSnapshot;let cancelling=true;
 f.desk.readSnapshot=()=>{const data=read();return {...data,botBook:{...data.botBook,residentControl:{cancelRequests:cancelling?[{runId:run.id,orderId:'awaiting-cancel',state:'PENDING'}]:[]}}};};
 f.pages.tick(0);assert.doesNotMatch(f.dialog.innerHTML,message);
 cancelling=false;f.pages.tick(0);assert.match(f.dialog.innerHTML,message);
 run.protectionDecision={scope:'BOT_ALLOCATION',action:'allow',reason:null,amount:10};
 f.pages.tick(0);assert.doesNotMatch(f.dialog.innerHTML,message);
 const cleared=f.shown.length;run.protectionDecision.amount=12;f.pages.tick(0);assert.equal(f.shown.length,cleared);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.routes,[]);assert.equal(run.status,'running');
});

test('a frozen run dialog rejects changed scope, versions and absent run IDs instead of selecting another run',async t=>{
 const f=await managementFixture(t);assert.equal(typeof f.pages.openRun,'function');
 f.pages.openRun(f.first.id);const replaced=f.dialog.buttons.find(b=>b.dataset.kind==='pause');f.pages.openRun(f.other.id);await replaced.onclick();assert.equal(f.calls.length,0,'A removed control must not act after the managed run changes');
 f.pages.openRun(f.first.id);const stale=f.dialog.buttons.find(b=>b.dataset.kind==='pause');assert.ok(stale);
 f.setStatus({...f.status(),scope:{...f.status().scope,accountId:'SIM-02'}});await stale.onclick();assert.equal(f.calls.length,0);assert.doesNotMatch(f.dialog.innerHTML,/data-bot-instance=/);assert.match(f.dialog.innerHTML,/账户|account/i);
 f.dialog.close();f.setStatus({...f.status(),scope:{...f.status().scope,accountId:'SIM-01'}});f.pages.openRun(f.first.id);const old=f.dialog.buttons.find(b=>b.dataset.kind==='pause');
 const changed=f.book.s.runs.find(r=>r.id===f.first.id);changed.plan={...changed.plan,version:2};await old.onclick();assert.equal(f.calls.length,0);assert.doesNotMatch(f.dialog.innerHTML,/data-bot-instance=/);
 f.dialog.close();f.pages.openRun('not-a-run');assert.doesNotMatch(f.dialog.innerHTML,/data-bot-instance=/);assert.equal(f.calls.length,0);
});

test('legacy and single-shot management retain original run guards and query an unknown original order',async t=>{
 const f=await managementFixture(t);assert.equal(typeof f.pages.openRun,'function');
 assert.equal(f.trade.start({market:'BTC/USDT',strategy:'S03',mode:'auto',amount:100,cap:500,executionRoute:{accountId:'SIM-01',connectionId:'api-main',venueId:'binance',profileId:'cex-spot',chainId:''}},DEFAULT_CONNECTIONS,{ready:true,market:'BTC/USDT',revision:'r1'}),null);
 Object.assign(f.trade.session,{accountId:'SIM-01',environment:'DEMO',connectionId:'api-main'});const id=f.trade.session.id;
 f.pages.openRun(id);const pause=f.dialog.buttons.find(b=>b.dataset.biz==='trade'&&b.dataset.id==='pause');assert.ok(pause);await pause.onclick();assert.equal(f.trade.state,'paused');assert.equal(f.calls.at(-1).options.run.runId,id);assert.equal(f.dialog.open,true);
 f.dialog.close();f.trade.session.singleShot=true;f.trade.pending={id:'UNCONFIRMED-ORDER',accountId:'SIM-01',runId:id,market:'BTC/USDT',status:'unknown',side:'buy',qty:1,filled:0,price:100,fee:0};f.trade.orders=[f.trade.pending];
 f.pages.openRun(id);const query=f.dialog.buttons.find(b=>b.dataset.biz==='trade'&&b.dataset.id==='reconcile');assert.ok(query);await query.onclick();assert.equal(f.calls.at(-1).kind,'reconcile');assert.equal(f.calls.at(-1).options.run.runId,id);assert.deepEqual(f.routes,[]);
 const oldQuery=f.dialog.buttons.find(b=>b.dataset.biz==='trade'&&b.dataset.id==='reconcile'),count=f.calls.length;
 f.trade.pending={...f.trade.pending,id:'DIFFERENT-ORDER'};f.trade.orders=[f.trade.pending];await oldQuery.onclick();assert.equal(f.calls.length,count,'A query for an old order must not target its replacement');
});

test('account management captures its scope and an old tab action cannot reveal another account',async t=>{
 const f=await managementFixture(t);assert.equal(typeof f.pages.openAccount,'function');const before=f.book.snapshot();
 f.pages.openAccount();assert.match(f.dialog.innerHTML,/SIM-01/);const tab=f.dialog.buttons.find(b=>b.dataset.biz==='account-tab'&&b.dataset.id==='orders');assert.ok(tab);
 await tab.onclick();assert.match(f.dialog.innerHTML,/data-account-orders/);assert.deepEqual(f.book.snapshot(),before);
 const stale=f.dialog.buttons.find(b=>b.dataset.biz==='account-tab');f.setStatus({...f.status(),scope:{...f.status().scope,environment:'LIVE'}});await stale.onclick();assert.doesNotMatch(f.dialog.innerHTML,/data-account-orders|data-account-positions/);assert.equal(f.calls.length,0);assert.deepEqual(f.routes,[]);
});

test('workbench run and account bridges open in place, while a disconnected feed disables old actions',async t=>{
 const f=await managementFixture(t);f.listeners['hive:workbench-strategy']({detail:{kind:'run',id:f.first.id}});
 assert.ok(f.dialog.innerHTML.includes(`data-bot-instance="${f.first.id}"`));assert.deepEqual(f.routes,[]);
 const stale=f.dialog.buttons.find(b=>b.dataset.kind==='pause');f.setStatus({...f.status(),state:'DISCONNECTED'});await stale.onclick();assert.equal(f.calls.length,0);assert.match(f.dialog.innerHTML,/读取已中断|feed is interrupted/);
 f.dialog.close();f.setStatus({...f.status(),state:'LIVE'});f.listeners['hive:workbench-strategy']({detail:{kind:'account',id:'SIM-01'}});assert.match(f.dialog.innerHTML,/data-account-positions/);assert.deepEqual(f.routes,[]);
 f.setStatus({...f.status(),scope:{...f.status().scope,accountId:'SIM-02'}});f.pages.tick(.5);assert.doesNotMatch(f.dialog.innerHTML,/data-account-positions|data-account-orders/);assert.equal(f.calls.length,0);
});

test('an unavailable account feed offers a read-only retry in the same captured scope',async t=>{
 const f=await managementFixture(t),read=f.desk.readSnapshot;f.desk.readSnapshot=()=>null;
 f.desk.streamAction=id=>{assert.equal(id,'retry');f.desk.readSnapshot=read;return null;};
 f.pages.openAccount();const retry=f.dialog.buttons.find(b=>b.dataset.biz==='stream'&&b.dataset.id==='retry');assert.ok(retry);
 await retry.onclick();assert.match(f.dialog.innerHTML,/data-account-positions/);assert.equal(f.calls.length,0);assert.deepEqual(f.routes,[]);
});

test('opening a run from account holdings starts at the top and returns to the account scroll position',async t=>{
 const f=await managementFixture(t);for(let i=0;i<100;i++)f.book.tick(.1,{'ETH/USDT':3246.52});assert.ok(f.book.snapshot().runs.find(run=>run.id===f.first.id).quantity>0);
 let returned=0;f.pages.openAccount({onReturn:()=>returned++});f.dialog.scrollTop=280;
 const open=f.dialog.buttons.find(b=>b.dataset.biz==='manage-run'&&b.dataset.id===f.first.id);assert.ok(open);await open.onclick();
 assert.equal(f.dialog.scrollTop,0);assert.ok(f.dialog.innerHTML.includes(`data-bot-instance="${f.first.id}"`));
 f.dialog.close();assert.equal(f.dialog.open,true);assert.match(f.dialog.innerHTML,/data-account-positions/);assert.equal(f.dialog.scrollTop,280);assert.equal(returned,0);
 f.dialog.close();assert.equal(returned,1);
});

test('an account order opens its original run and returns to the same order row and scroll',async t=>{
 const f=await managementFixture(t);for(let i=0;i<100;i++)f.book.tick(.1,{'ETH/USDT':3246.52});const order=f.book.snapshot().runs.find(run=>run.id===f.first.id).orders[0];
 f.pages.openAccount();await f.dialog.buttons.find(b=>b.dataset.biz==='account-tab'&&b.dataset.id==='orders').onclick();f.dialog.scrollTop=340;
 const open=f.dialog.buttons.find(b=>b.dataset.biz==='manage-run'&&b.dataset.orderId===order.id);assert.ok(open);open.focus();await open.onclick();assert.ok(f.dialog.innerHTML.includes(`data-bot-instance="${f.first.id}"`));assert.equal(f.dialog.scrollTop,0);
 f.dialog.close();assert.match(f.dialog.innerHTML,/data-account-orders/);assert.equal(f.dialog.scrollTop,340);assert.equal(document.activeElement.dataset.orderId,order.id);assert.deepEqual(f.routes,[]);
});


test('workbench risk defaults are read from the exact saved account revision, never from event values',async t=>{
 const {protectionConfig}=await import('./strategy-protection.mjs'),f=await managementFixture(t);
 const policy=protectionConfig('astarter','normal',{episode:.001,notional:.04,daily:.01,epoch:.025,soft:.02,hard:.06});
 f.w.s.workbenchRisk={accountId:'SIM-01',environment:'DEMO',revision:2,protection:policy};
 const send=detail=>f.listeners['hive:workbench-strategy']({detail:{kind:'template',id:'S01',...detail}}),before=JSON.stringify(f.book.snapshot());
 for(const revision of [1,'2',0,2.5]){send({riskPreferenceRevision:revision});assert.match(f.notices.at(-1),/风控配置已变化|Risk settings changed/);}
 f.setStatus({...f.status(),scope:{...f.status().scope,accountId:'OTHER'}});send({riskPreferenceRevision:2});assert.match(f.notices.at(-1),/风控配置已变化|Risk settings changed/);
 f.setStatus({...f.status(),scope:{...f.status().scope,accountId:'SIM-01'}});
 send({riskPreferenceRevision:2,protection:protectionConfig('astarter','normal',{...policy.parameters,episode:1})});
 const editor=f.created.find(el=>el.open&&el.innerHTML.includes('sc-drawer-title'));assert.ok(editor);assert.match(editor.innerHTML,/0\.1%/);assert.match(editor.innerHTML,/2\.5%/);
 assert.deepEqual(f.w.s.workbenchRisk.protection,policy);assert.equal(JSON.stringify(f.book.snapshot()),before);assert.equal(f.calls.length,0);assert.deepEqual(f.routes,[['strategies',{create:'S01',editor:'S01'}],[null]],'open the selected creation page, then refresh without executing');
});
