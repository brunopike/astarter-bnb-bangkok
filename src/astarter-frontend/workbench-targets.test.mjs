import test from 'node:test';
import assert from 'node:assert/strict';
import {MultiResearch} from './multi-research.mjs';
import {WorkspaceSim,WORKSPACE_KEY} from './workspace-sim.mjs';
import {marketScanSymbols,workbenchTracking,toggleWorkbenchWatch,workbenchAIHealth,workbenchFilter,activeWorkbenchOrders} from './workbench-targets.mjs';
import {watchlistEntries} from './watchlist-view.mjs';
import * as targets from './workbench-targets.mjs';

test('market scans show existing research tasks independently of executable signal candidates',()=>{
 const research=new MultiResearch(),all=['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y'],before=JSON.stringify(research.snapshot());
 assert.deepEqual(marketScanSymbols(research),all);
 assert.deepEqual(marketScanSymbols(research,{focus:'onchain'}),['ETH']);
 assert.deepEqual(marketScanSymbols(research,{focus:'market'}),['BTC','SPX','NDX']);
 assert.deepEqual(marketScanSymbols(research,{focus:'macro'}),['XAU','DXY','US10Y']);
 assert.deepEqual(marketScanSymbols(research,{focus:'money'}),[]);
 assert.deepEqual(marketScanSymbols(research,{scope:'tradfi'}),['SPX','NDX','XAU','DXY','US10Y']);
 assert.deepEqual(marketScanSymbols(research,{strategy:'S00'}),all);
 assert.equal(JSON.stringify(research.snapshot()),before);
 research.setScope('crypto');
 assert.deepEqual(marketScanSymbols(research),['BTC','ETH','SOL']);
 assert.deepEqual(marketScanSymbols(research,{scope:'tradfi'}),[]);
 research.tasks=research.tasks.filter(task=>task.symbol!=='ETH');
 assert.deepEqual(marketScanSymbols(research,{focus:'onchain'}),[]);
});
test('all is the distinct union of research scope and watched assets without fabricating tasks',()=>{
 const research=new MultiResearch(),before=JSON.stringify(research.snapshot());
 assert.deepEqual(workbenchTracking(research,['ETH','SOL','SOL','UNKNOWN'],'all').map(t=>t.symbol),['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y']);
 assert.deepEqual(workbenchTracking(research,['ETH','SOL'],'scan').map(t=>t.symbol),['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y']);
 assert.deepEqual(workbenchTracking(research,['ETH','SOL'],'tracked').map(t=>t.symbol),['ETH','SOL']);
 assert.deepEqual(workbenchTracking(research,['SPX'],'all',{focus:'onchain'}).map(t=>t.symbol),['ETH','SPX']);
 assert.equal(JSON.stringify(research.snapshot()),before);
 research.setScope('tradfi');assert.deepEqual(workbenchTracking(research,['SPX'],'all').map(t=>t.symbol),['SPX','NDX','XAU','DXY','US10Y']);
 assert.deepEqual(workbenchTracking(research,[],'tracked'),[]);
 assert.equal(workbenchFilter('bad'),'all');
});
test('watchlist projects saved assets without presenting every scanned asset as a favorite or candidate',()=>{
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 workspace.s.aiSignalPreferences={scope:'tradfi',focus:'all',strategy:'S00'};
 const before=JSON.stringify({workspace:workspace.s,research:research.snapshot()});
 const entries=watchlistEntries(['SPX','coin:bitcoin'],[],research.tasks);
 assert.deepEqual(entries.map(entry=>entry.asset.symbol),['SPX','BTC']);
 assert.equal(entries[0].task,research.task('SPX'));assert.equal(entries[1].task,research.task('BTC'));
 assert.ok(entries.every(entry=>entry.asset.price===null));
 assert.equal(JSON.stringify({workspace:workspace.s,research:research.snapshot()}),before);
 research.advance(140);
 const scans=marketScanSymbols(research);
 assert.ok(scans.includes('SOL')&&scans.includes('NDX')&&scans.includes('XAU'));
 assert.equal(research.handoff('SOL'),null);
 assert.equal(research.handoff('NDX'),null);
 assert.equal(research.handoff('XAU'),null);
});
test('watch changes survive reload without changing orders, drafts, research or credits',()=>{
 const store=new Map(),storage={getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)};
 const research=new MultiResearch(),w=new WorkspaceSim({research,storage});
 const before=JSON.stringify({trade:w.s.trade,drafts:w.s.drafts,credits:w.s.credits,usage:w.s.usage,research:research.snapshot()});
 assert.equal(toggleWorkbenchWatch(w,'SOL'),null);
 assert.deepEqual(JSON.parse(storage.getItem(WORKSPACE_KEY)).aiSignalWatch,['SOL']);
 const restored=new WorkspaceSim({research:new MultiResearch(),storage});assert.deepEqual(restored.s.aiSignalWatch,['SOL']);
 assert.equal(toggleWorkbenchWatch(restored,'SOL'),null);assert.deepEqual(restored.s.aiSignalWatch,[]);
 assert.ok(toggleWorkbenchWatch(w,'UNSUPPORTED'));
 assert.equal(JSON.stringify({trade:w.s.trade,drafts:w.s.drafts,credits:w.s.credits,usage:w.s.usage,research:research.snapshot()}),before);
});
test('storage failure remains visible and old signal watches can still be removed',()=>{
 const w=new WorkspaceSim({storage:{getItem:()=>null,setItem:()=>{throw Error('storage blocked');}}});
 assert.match(toggleWorkbenchWatch(w,'BTC'),/保存/);
 w.s.aiSignalWatch=['LINK'];assert.match(toggleWorkbenchWatch(w,'LINK'),/保存/);assert.deepEqual(w.s.aiSignalWatch,[]);
});
test('stale pages cannot overwrite saved targets and current pages share the latest selection',()=>{
 const store=new Map(),storage={getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)};
 const first=new WorkspaceSim({storage}),second=new WorkspaceSim({storage}),oldSnapshot=JSON.stringify(first.s);
 assert.equal(toggleWorkbenchWatch(first,'SOL'),null);
 storage.setItem(WORKSPACE_KEY,oldSnapshot);
 assert.deepEqual(new WorkspaceSim({storage}).s.aiSignalWatch,['SOL']);
 second.s.aiSignalWatch=['ETH'];second.s.workbenchFilter='tracked';second.touch();
 assert.deepEqual(first.s.aiSignalWatch,['ETH']);assert.equal(first.s.workbenchFilter,'tracked');
 assert.equal(toggleWorkbenchWatch(first,'BTC'),null);assert.deepEqual(second.s.aiSignalWatch,['ETH','BTC']);
});
test('AI summary distinguishes configuration gaps and budget issues without probing or billing',()=>{
 const w=new WorkspaceSim(),before=JSON.stringify(w.s);
 assert.deepEqual(workbenchAIHealth({ai:true,data:true},w).issues,[]);
 assert.deepEqual(workbenchAIHealth({ai:false,data:false},w).issues.map(i=>i.id),['ai','data']);
 assert.equal(JSON.stringify(w.s),before);
 w.s.budget.daily=0;w.s.credits=0;
 assert.deepEqual(workbenchAIHealth({ai:true,data:true},w).issues.map(i=>i.id),['credits','budget']);
 const custom=workbenchAIHealth({ai:true,data:true,preferences:{ai:{source:'custom',agents:{A01:{model:'',version:''}}}}},w);
 assert.ok(custom.issues.some(i=>i.id==='models'));
});
test('position summaries count open orders without counting filled and cancelled history',()=>{
 const orders=[{id:'open',status:'submitted'},{id:'partial',status:'partial'},{id:'unknown',status:'unknown'},{id:'filled',status:'filled'},{id:'old',status:'cancelled'}];
 assert.deepEqual(activeWorkbenchOrders({orders}).map(o=>o.id),['open','partial','unknown']);
 assert.deepEqual(activeWorkbenchOrders(null),[]);
});

test('explicit asset focus is read-only by default and narrows sources without authorizing work',()=>{
 const research=new MultiResearch(),w=new WorkspaceSim({research});
 const business=()=>JSON.stringify([w.s.drafts,w.s.trade,w.s.usage,w.s.credits,w.s.risk]);
 const before=business(),selection=targets.readWorkbenchTargets(w,research);
 assert.equal(selection.focusAsset,null);assert.equal(w.s.workbenchFocusAsset,null);
 assert.equal(targets.matchesWorkbenchTarget('DOGE',selection),true);
 assert.equal(targets.setWorkbenchTargets(w,research,{focusAsset:'ETH'}),null);
 const focused=targets.readWorkbenchTargets(w,research);
 assert.equal(focused.focusAsset,'ETH');assert.equal(targets.matchesWorkbenchTarget('coin:ethereum',focused),true);
 assert.equal(targets.matchesWorkbenchTarget('BTC',focused),false);
 assert.equal(business(),before);
 const revision=w.revision;targets.readWorkbenchTargets(w,research);targets.renderWorkbenchTargets(w,research);
 assert.equal(w.revision,revision);assert.equal(business(),before);
});

test('scope changes retain a visible focus, clear an excluded focus and explicitly restore all',()=>{
 const research=new MultiResearch(),w=new WorkspaceSim({research});w.s.aiSignalWatch=['ETH'];
 assert.equal(targets.setWorkbenchTargets(w,research,{focusAsset:'ETH'}),null);
 targets.setWorkbenchTargets(w,research,{filter:'tracked'});
 assert.equal(targets.readWorkbenchTargets(w,research).focusAsset,'ETH');
 assert.equal(targets.matchesWorkbenchTarget('BTC',targets.readWorkbenchTargets(w,research)),false);
 w.s.aiSignalPreferences={focus:'macro'};targets.setWorkbenchTargets(w,research,{filter:'scan'});
 const scope=targets.readWorkbenchTargets(w,research);
 assert.equal(scope.focusAsset,null);assert.deepEqual(scope.tasks.map(t=>t.symbol),['XAU','DXY','US10Y']);
 assert.equal(targets.matchesWorkbenchTarget('ETH',scope),false);
 targets.setWorkbenchTargets(w,research,{focusAsset:'XAU'});targets.setWorkbenchTargets(w,research,{filter:'all'});
 assert.equal(targets.readWorkbenchTargets(w,research).focusAsset,null);
 assert.equal(targets.matchesWorkbenchTarget('DOGE',targets.readWorkbenchTargets(w,research)),true);
 const before=JSON.stringify(w.s);assert.ok(targets.setWorkbenchTargets(w,research,{focusAsset:'NOT-AN-ASSET'}));
 assert.equal(JSON.stringify(w.s),before);
});

test('the target bar marks only explicit focus, exposes cancellation and binds each action once',()=>{
 const research=new MultiResearch(),w=new WorkspaceSim({research});
 assert.doesNotMatch(targets.renderWorkbenchTargets(w,research),/data-target-asset="[^"]+" aria-pressed="true"/);
 targets.setWorkbenchTargets(w,research,{focusAsset:'ETH'});
 const html=targets.renderWorkbenchTargets(w,research);
 assert.match(html,/data-target-asset="ETH" aria-pressed="true"/);
 assert.match(html,/取消专注|Clear focus/);assert.doesNotMatch(html,/全部标的|All assets/);
 let changes=0,notifications=0,managed=0;
 const chip={dataset:{targetAsset:'ETH'},closest(){return this;}};
 const bar={contains:b=>b===chip,ownerDocument:{dispatchEvent(){notifications++;}}};
 const container={querySelectorAll:()=>[bar]};
 const options={workspace:w,research,onChange(){changes++;},onManage(){managed++;},notify:assert.fail};
 const oldDispose=targets.bindWorkbenchTargets(container,options);
 const dispose=targets.bindWorkbenchTargets(container,options);oldDispose();
 bar.onclick({target:chip});
 assert.equal(targets.readWorkbenchTargets(w,research).focusAsset,null);
 assert.equal(changes,1);assert.equal(notifications,1);assert.equal(managed,0);
 dispose();assert.equal(bar.onclick,null);assert.equal(bar.onchange,null);
});


test('guest workbench removal recognizes saved coin aliases and preserves other asset identities',()=>{
 const w=new WorkspaceSim(),ca='ca:ethereum:0x'+'a'.repeat(40);
 w.s.aiSignalWatch=['coin:bitcoin','BTC','coin:other-btc',ca,'ETH'];
 assert.equal(toggleWorkbenchWatch(w,'BTC'),null);
 assert.deepEqual(w.s.aiSignalWatch,['coin:other-btc',ca,'ETH']);
});
