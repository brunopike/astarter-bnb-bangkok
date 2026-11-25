import {commerceFixture} from './commerce-test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG} from './strategy-catalog.mjs';
import {EXECUTION_DEFAULTS,strategyPlan,strategyScope,strategyFlowAvailable,strategyVariants} from './strategy-execution-data.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch,DiscoveryDispatch} from './multi-research.mjs';
import {strategyLaunchError,createStrategyCenter} from './strategy-journeys.mjs';

test('catalog design coverage does not imply native execution acceptance',async t=>{
 for(const s of CATALOG){const p=strategyPlan(s.id);assert.ok(p);assert.equal(p.nativeAccepted,false);assert.equal(p.baseVersion,s.version);assert.equal(p.flowAvailable,s.id==='S03');}
 assert.equal(strategyPlan('unknown'),null);
});
test('template scope does not turn its reference instrument into an asset restriction or execution permission',async t=>{
 const before=JSON.stringify(EXECUTION_DEFAULTS);
 for(const strategy of CATALOG){
  const scope=strategyScope(strategy.id);assert.equal(scope.label.length,2);assert.ok(scope.icon);
  if(strategy.id!=='RX03-B')assert.doesNotMatch(scope.label.join(' '),/BTC|ETH\/|ARB\/|USDT/);
 }
 assert.match(strategyScope('RX03-B').label[0],/原生 BTC/);
 assert.match(strategyScope('S09-A').label[0],/Ethereum/);
 assert.match(strategyScope('RX04').label[0],/库存/);
 assert.equal(strategyScope('unknown'),null);assert.equal(JSON.stringify(EXECUTION_DEFAULTS),before);
 assert.equal(strategyFlowAvailable({strategy:'S03',market:'ETH/USDT'}),false);
});
test('baseline S03 keeps its original risk and no-target rules while experiments stay separate',async t=>{
 const p=strategyPlan('S03'),q=p.record.parameters;
 assert.equal(q.ema_fast.value,20);assert.equal(q.ema_slow.value,50);assert.equal(q.stop_atr.value,'2');
 assert.equal(q.risk_fraction.value,'0.005');assert.equal(q.notional_fraction.value,'0.20');assert.equal(q.target_enabled.value,false);assert.equal(q.hold_boundaries.value,36);
 for(const id of ['E01','E02']){const v=strategyPlan('S03',id);assert.equal(v.flowAvailable,false);assert.equal(v.baseVersion,p.baseVersion);assert.equal(v.record.parameters,q);}
 assert.equal(strategyPlan('S03','invalid').variant,'baseline');
 assert.equal(Object.values(EXECUTION_DEFAULTS).filter(x=>x.nativeAccepted).length,0);
});
test('the virtual-probe candidate preserves two virtual and three bounded physical layers',async t=>{
 const p=strategyPlan('S02','S02-VP');assert.equal(p.variant,'S02-VP');assert.equal(p.nativeAccepted,false);assert.equal(p.flowAvailable,false);
 const q=p.record.parameters;assert.equal(q.virtual_probe_layers.value,2);assert.equal(q.physical_layers.value,3);assert.deepEqual(q.size_weights.value,['1','1.5','2.25']);assert.equal(q.extra_pressure_multiplier_enabled.value,false);assert.equal(q.short_or_hedge_allowed.value,false);assert.match(p.entry[0],/C0−2d/);assert.match(p.exit[0],/C0−5d/);assert.match(p.exit[0],/0.75d/);
 assert.equal(strategyVariants('S03').length,2);assert.deepEqual(strategyVariants('S01').map(v=>v.id),['S01-SIM','E03']);
});
test('candidate or unadapted strategy drafts cannot acquire launch authority from a generic passed check',async t=>{
 const w=new WorkspaceSim(),d=w.draft(),desk={snapshot:()=>({state:'idle'})};
 for(const patch of [{strategy:'S01'},{planVariant:'E02'},{market:'ETH/USDT'}]){
  const draft={...d,...patch};assert.equal(strategyFlowAvailable(draft),false);w.s.drafts=[draft];
  assert.match(strategyLaunchError(w,desk),/适配|研究|标的/);
 }
});
test('market-bound strategy discovery cannot substitute a different asset candidate',async t=>{
 const research=new MultiResearch();research.advance(60);const dispatch=new DiscoveryDispatch(),trade={state:'idle'};
 dispatch.arm({strategy:'S03',market:'BTC/USDT'});assert.equal(dispatch.next(research,trade),null);
 dispatch.arm({strategy:'S03',market:'ETH/USDT'});assert.equal(dispatch.next(research,trade)?.market,'ETH/USDT');
});


test('instrument or research-variant changes invalidate a previously passed setup',async t=>{
 const w=new WorkspaceSim(),d=w.draft(),run=w.validateSetup().run;
 for(let i=0;i<50;i++)w.tick(.1);assert.equal(w.setupReady,run);
 d.market='ETH/USDT';assert.equal(w.setupReady,null);
 delete d.market;assert.equal(w.setupReady,run);
 d.planVariant='E02';assert.equal(w.setupReady,null);
 d.planVariant='baseline';assert.equal(w.setupReady,run);
});

test('candidate UI can configure without launch authority, and saving preserves the chosen research version',async t=>{
 const saved={document:globalThis.document,matchMedia:globalThis.matchMedia,IntersectionObserver:globalThis.IntersectionObserver},events={};let selectChange,route,noticeAction;
 const picker={addEventListener(type,handler){if(type==='change')selectChange=handler;}};
 const drawer={innerHTML:'',open:false,dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(selector){return selector==='[data-plan-variant]'?picker:null;},querySelectorAll(){return [];},addEventListener(type,handler){events[type]=handler;},showModal(){this.open=true;},close(){this.open=false;events.close?.();}};
 try{
  globalThis.document={activeElement:null,body:{append(){}},addEventListener(){},createElement:()=>drawer};
  globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  const w=new WorkspaceSim(),root={querySelector(){return null;},querySelectorAll(){return [];}},state={state:'idle'},desk={snapshot:()=>state};
  const center=createStrategyCenter({w,desk,root,go:page=>route=page,refresh(){},notify(_text,options){noticeAction=options?.action;}});
  const catalog=center.render('strategies'),directory=[...catalog.matchAll(/<button[^>]*data-strategy="([^"]+)"[^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>/g)];
  assert.equal(directory.length,CATALOG.length);assert.deepEqual(new Set(directory.map(row=>row[1])),new Set(CATALOG.map(row=>row.id)));assert.ok(directory.every(row=>!row[2].includes('brand-mark')&&!row[2].includes('/USDT')));
  center.openTemplate('S03');assert.match(drawer.innerHTML,/CEX 现货 · 多资产/);assert.match(drawer.innerHTML,/供研究和后续配置使用|for research and later configuration/);assert.doesNotMatch(drawer.innerHTML,/data-sc="start"|data-sc="launch"|AI then waits/);
  const click=(sc,id='')=>events.click({target:{closest:()=>({dataset:{sc,id}})}});
  center.openDraft(w.draft().id);await click('overview');selectChange({target:{value:'E02'}});
  assert.match(drawer.innerHTML,/E02/);assert.match(drawer.innerHTML,/data-sc="save-research"/);assert.match(drawer.innerHTML,/data-sc="configure"/);
  const initial=JSON.stringify(w.s);
  await click('configure');assert.doesNotMatch(drawer.innerHTML,/data-sc="start"/);await click('check');assert.equal(JSON.stringify(w.s),initial);
  await click('save-research');const candidate=w.s.drafts.find(d=>d.planVariant==='E02');
  assert.ok(candidate);assert.equal(route,undefined);assert.equal(typeof noticeAction,'function');noticeAction();assert.equal(route,'execution');assert.equal(w.s.usage.length,0);assert.equal(w.spent,0);assert.equal(w.s.started,false);
  center.openDraft(candidate.id);assert.match(drawer.innerHTML,/value="E02"[^>]*selected/);
  await click('save-research');assert.equal(w.s.drafts.filter(d=>d.planVariant==='E02').length,1);
  const vp=w.createDraft('S02');center.openDraft(vp.id);selectChange({target:{value:'S02-VP'}});await click('plan-tab','abc');
  assert.match(drawer.innerHTML,/C0 − 2d/);assert.match(drawer.innerHTML,/不入账|Excluded/);assert.match(drawer.innerHTML,/data-sc="configure"/);
  await click('save-research');const virtual=w.s.drafts.find(d=>d.planVariant==='S02-VP');assert.ok(virtual);assert.equal(w.s.usage.length,0);
  center.openDraft(virtual.id);assert.match(drawer.innerHTML,/value="S02-VP"[^>]*selected/);
  await click('configure');assert.match(drawer.innerHTML,/bot-family-rules/);assert.match(drawer.innerHTML,/bot-editor-version">S02-VP/);assert.equal((drawer.innerHTML.match(/<tr class="virtual">/g)||[]).length,2);assert.match(drawer.innerHTML,/C0 − 4d/);assert.doesNotMatch(drawer.innerHTML,/data-sc="start"|data-sc="launch"/);
  const active=w.createDraft('S01');state.state='running';state.session={draftId:active.id};const before=JSON.stringify(active);
  center.openDraft(active.id);await click('save-research');assert.equal(JSON.stringify(active),before);assert.equal(w.s.drafts.filter(d=>d.strategy==='S01').length,1);assert.match(drawer.innerHTML,/先处理原运行|Resolve the original run/);
  for(const [id,pattern]of [['S09-A',/nonce/],['S09-L',/两种资产|two assets/],['RX04',/唯一退出|single exit/]]){center.openTemplate(id);await click('plan-tab','abc');await click('scenario','C');assert.match(drawer.innerHTML,pattern);assert.match(drawer.innerHTML,/data-sc="configure"/);}
  assert.equal(w.s.usage.length,0);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
