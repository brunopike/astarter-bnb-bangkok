import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {MultiResearch} from './multi-research.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {researchMotionJobs} from './business-motion.mjs';
import * as targets from './workbench-targets.mjs';
import {workbenchWalletMetric} from './workbench-optical-header.mjs';
import {renderWorkbenchWalletButton,WorkbenchFeedCursor,workbenchTracking,workbenchFeed,workbenchFocus,workbenchEvents,workbenchNextAction,WorkbenchUpdateQueue,workbenchTeamActivity,workbenchSourceRevisions} from './workbench-terminal.mjs';
const controller=readFileSync(new URL('./workbench-terminal.mjs',import.meta.url),'utf8');

test('legacy and narrow-panel balance buttons render the same wallet action and visible state',()=>{
 for(const mobile of [false,true]){
  const tag=mobile?'strong':'b',render=state=>renderWorkbenchWalletButton(workbenchWalletMetric(state),mobile);
  const guest=render({status:'guest'});assert.match(guest,/data-terminal-action="wallet"/);assert.doesNotMatch(guest,/data-terminal-route/);
  assert.ok(guest.includes('<'+tag+' data-terminal-number="wallet">0.00</'+tag+'>'));
  for(const [status,expected] of [['loading',/读取中|Loading/],['error',/读取失败|Read failed/]]){
   const html=render({status,usdt:999});assert.match(html.match(/<small>([^<]*)<\/small>/)[1],expected);assert.ok(html.includes('>—</'+tag+'>'));
  }
  const small=render({status:'ready',usdt:.0045,updatedAt:Date.UTC(2026,10,25,9,8,7)});
  assert.ok(small.includes('>&lt;0.01</'+tag+'>'));assert.match(small,/BSC.*2026-11-25 09:08:07 UTC/);
 }
});

test('clicking a balance delegates once to the mounted header wallet control without navigating',async()=>{
 const binding=controller.slice(controller.indexOf(' async function action(event)'),controller.indexOf(" document.addEventListener('hive:workbench-filter'"));
 let clicks=0;
 const action=runInNewContext(binding+';action',{document:{querySelector(selector){assert.equal(selector,'.header-wallet .wallet-login');return {click(){clicks++;}};}}});
 await action({target:{closest:()=>({dataset:{terminalAction:'wallet'}})}});assert.equal(clicks,1);
});

test('the data-view shortcut lands on the chart immediately for both keyboard and pointer activation',()=>{
 const binding=controller.slice(controller.indexOf(' chartSuite.host.tabIndex='),controller.indexOf(' const handoff=document.createElement'));
 const calls=[],chartToggle={};
 const host={
  focus(options){calls.push(['focus',options.preventScroll]);},
  scrollIntoView(options){calls.push(['scroll',options.block,options.behavior]);}
 };
 runInNewContext(binding,{chartToggle,chartSuite:{host}});
 assert.equal(host.tabIndex,-1);
 for(const detail of [0,1]){
  chartToggle.onclick({detail});
  assert.deepEqual(calls.splice(0),[['focus',true],['scroll','start','instant']]);
 }
});

test('selecting a wider last asset keeps it in view and repaints preserve a partially scrolled strip',()=>{
 const repaint=controller.slice(controller.indexOf(' function put('),controller.indexOf(' function navigate('));
 const put=runInNewContext(repaint+';put',{stamps:new Map(),captureProductFocus:()=>()=>{},cue(){}});
 function stripOf(width){
  let left=0;
  return {clientWidth:296,scrollWidth:width,
   get scrollLeft(){return left;},
   set scrollLeft(value){left=Math.max(0,Math.min(value,width-this.clientWidth));}
  };
 }
 let strip=stripOf(692),nextWidth=711;
 const node={querySelector:selector=>selector.includes('.pw-target-chips')?strip:null,querySelectorAll:()=>[],set innerHTML(_html){strip=stripOf(nextWidth);}};
 strip.scrollLeft=396;put(node,'last asset selected');assert.equal(strip.scrollLeft,415);
 strip.scrollLeft=129;nextWidth=692;put(node,'selection cleared');assert.equal(strip.scrollLeft,129);
 nextWidth=200;put(node,'narrower list');assert.equal(strip.scrollLeft,0);
});
test('opening a watched asset is explicit focus while automatic research projections never write it',()=>{
 const {research,workspace,trade}=setup();workspace.s.aiSignalWatch=['ETH'];
 targets.setWorkbenchTargets(workspace,research,{filter:'tracked',focusAsset:'ETH'});
 const business=JSON.stringify([workspace.s.drafts,workspace.s.trade,workspace.s.usage,workspace.s.credits]);
 assert.equal(targets.focusWorkbenchAsset(workspace,research,'BTC'),null);
 assert.equal(workspace.s.workbenchFocusAsset,'BTC');assert.equal(workspace.s.workbenchFilter,'all');
 assert.deepEqual(workspace.s.aiSignalWatch,['ETH']);
 assert.equal(targets.focusWorkbenchAsset(workspace,research,'ETH'),null);
 assert.equal(workspace.s.workbenchFilter,'tracked');
 research.advance(140);
 for(const symbol of ['BTC','SOL','XAU']){
  assert.equal(workbenchFocus(research,trade,workspace,symbol).task.symbol,symbol);
  assert.equal(workspace.s.workbenchFocusAsset,'ETH');
 }
 const before=JSON.stringify(workspace.s);assert.ok(targets.focusWorkbenchAsset(workspace,research,'UNKNOWN'));
 assert.equal(JSON.stringify(workspace.s),before);assert.equal(JSON.stringify([workspace.s.drafts,workspace.s.trade,workspace.s.usage,workspace.s.credits]),business);
});
test('data cues follow actual changes, start quietly and drain fairly in bounded batches',()=>{
 const q=new WorkbenchUpdateQueue();
 assert.deepEqual(q.read({depth:'1',trend:'2',macro:'2',chain:'3'}),[]);
 assert.deepEqual(q.read({depth:'1',trend:'2',macro:'2',chain:'3'}),[]);
 assert.deepEqual(q.read({depth:'2',trend:'3',macro:'4',chain:'5'}),['depth','trend']);
 assert.deepEqual(q.read({depth:'3',trend:'4',macro:'4',chain:'5'}),['macro','chain']);
 assert.deepEqual(q.read({depth:'3',trend:'4',macro:'4',chain:'5'}),['depth','trend']);
 assert.deepEqual(q.read({depth:'3',trend:'4',macro:'4',chain:'5'}),[]);
});
test('paused, reduced-motion and hidden views do not replay old flashes or create data',()=>{
 const q=new WorkbenchUpdateQueue(),initial={depth:'1',trend:'2',macro:'3'};q.read(initial);
 assert.deepEqual(q.read({depth:'2',trend:'3',macro:'4'},false),[]);
 assert.deepEqual(q.read({depth:'2',trend:'3',macro:'4'}),[]);
 q.read({depth:'3',trend:'4',macro:'5'});
 assert.deepEqual(q.read({depth:'3',trend:'4'}),[]);
 q.reset();const next={depth:'8',trend:'9'};
 assert.deepEqual(q.read(next),[]);assert.deepEqual(next,{depth:'8',trend:'9'});
});
const setup=()=>{const research=new MultiResearch(),workspace=new WorkspaceSim({research});return{research,workspace,trade:{session:null,orders:[]}};};
test('team surfaces expose actual evidence and handoff progress without moving a research task',()=>{
 const {research,workspace}=setup(),before=JSON.stringify(research.snapshot()),credits=JSON.stringify(workspace.s);
 const initial=workbenchTeamActivity(research);assert.equal(initial.length,6);assert.equal(initial[1].task.symbol,'ETH');assert.equal(initial[1].phase,'collect');assert.equal(initial[1].evidence.length,6);assert.equal(initial[4].evidence.length,5);
 assert.equal(JSON.stringify(research.snapshot()),before);assert.equal(JSON.stringify(workspace.s),credits);
 research.advance(22);const queued=workbenchTeamActivity(research);assert.ok(queued.some(t=>t.phase==='core'));assert.ok(queued.some(t=>t.phase==='queuedCore'));assert.ok(queued.every(t=>t.progress>=0&&t.progress<=100));
 research.advance(118);assert.equal(workbenchTeamActivity(research)[1].phase,'complete');
 research.setScope('crypto');assert.equal(workbenchTeamActivity(research)[4].available,false);assert.equal(workbenchTeamActivity(research)[4].task,null);
});
test('team coverage includes its whole queue and only actual in-scope collaboration assets',()=>{
 const {research,workspace}=setup(),before=JSON.stringify({research:research.snapshot(),workspace:workspace.s});
 const jobs=[{station:2,roles:[4,16,8],symbol:'SOL'}, {roles:[8],subjects:['BTC','SOL','UNKNOWN']}, {roles:[0],symbol:'ETH/USDT'}];
 const teams=workbenchTeamActivity(research,jobs);
 assert.deepEqual(teams[1].assets.map(t=>t.symbol),['BTC','ETH','SOL']);
 assert.deepEqual(teams[0].assets.map(t=>t.symbol),['BTC','ETH']);
 assert.deepEqual(teams[3].assets.map(t=>t.symbol),['SPX','NDX']);
 assert.deepEqual(teams[5].assets.map(t=>t.symbol),['DXY','US10Y']);
 assert.equal(JSON.stringify({research:research.snapshot(),workspace:workspace.s}),before);
 research.setScope('crypto');
 const scoped=workbenchTeamActivity(research,[{roles:[5],subjects:['XAU','ETH','ETH']}]);
 assert.deepEqual(scoped[4].assets.map(t=>t.symbol),['ETH']);
 assert.equal(scoped[4].available,true);
 assert.equal(scoped[4].task,null);
 assert.equal(scoped[4].phase,'monitor');
 assert.equal(scoped[5].available,false);
});
test('team coverage follows the real cross-team research assignments',()=>{
 const {research}=setup();research.advance(140);
 const before=JSON.stringify(research.snapshot()),teams=workbenchTeamActivity(research,researchMotionJobs(research));
 assert.deepEqual(teams[1].assets.map(t=>t.symbol),['ETH','SOL']);
 assert.deepEqual(teams[2].assets.map(t=>t.symbol),['ETH','SOL']);
 assert.deepEqual(teams[3].assets.map(t=>t.symbol),['SPX','NDX','XAU']);
 assert.deepEqual(teams[4].assets.map(t=>t.symbol),['SPX','NDX','XAU']);
 assert.equal(JSON.stringify(research.snapshot()),before);
});
test('unchanged source numbers can announce a new evidence receipt, never a missing or old task',()=>{
 const {research}=setup(),queue=new WorkbenchUpdateQueue();assert.deepEqual(workbenchSourceRevisions(research),{});
 const values=()=>Object.fromEntries(['trend','depth','macro','social','chain','risk'].map(k=>[k,'3|'+(workbenchSourceRevisions(research)[k]||'')]));
 queue.read(values());research.advance(5);assert.ok(queue.read(values()).includes('trend'));assert.match(workbenchSourceRevisions(research).trend,/research-BTC:v1/);
 const atFive=workbenchSourceRevisions(research);assert.equal(atFive.risk,undefined);assert.doesNotMatch(atFive.chain||'',/na|pending/);
 research.advance(135);research.recheck('ETH');assert.doesNotMatch(workbenchSourceRevisions(research).chain||'',/research-ETH:v1/);
 research.advance(12);assert.match(workbenchSourceRevisions(research).chain,/research-ETH:v2/);
 research.setScope('crypto');assert.doesNotMatch(workbenchSourceRevisions(research).macro||'',/research-(XAU|DXY|NDX|SPX|US10Y)/);
});
test('the main workbench action guides new users through setup and rechecks stale settings',()=>{
 const trade={state:'idle',session:null},builtin={version:1,validationId:'V-BUILTIN'},personal={version:2,validationId:'V-2'};
 assert.equal(workbenchNextAction(trade,{draft:builtin,ready:true}),'choose');
 assert.equal(workbenchNextAction(trade,{draft:personal}),'configure');
 assert.equal(workbenchNextAction(trade,{draft:personal,ready:true}),'start');
 assert.equal(workbenchNextAction(trade,{draft:personal,ready:true,scope:'tradfi'}),'research');
});
test('existing orders, confirmations and holdings take priority over a new launch',()=>{
 const settings={draft:{version:2},ready:true},trade={state:'running',session:{mode:'confirm'},signal:{side:'buy'}};
 const before=JSON.stringify(trade);
 assert.equal(workbenchNextAction(trade,settings),'confirm');
 assert.equal(workbenchNextAction({...trade,pending:{status:'partial'}},settings),'order');
 assert.equal(workbenchNextAction({...trade,pending:{status:'unknown'}},settings),'reconcile');
 assert.equal(workbenchNextAction({...trade,state:'paused'},settings),'paused');
 assert.equal(workbenchNextAction({state:'stopped',position:{qty:1}},settings),'position');
 assert.equal(JSON.stringify(trade),before);
});
test('watching and account recovery remain separate from trading authorization',()=>{
 const trade={state:'idle',discovery:{armed:true}},settings={draft:{version:2},ready:true};
 assert.equal(workbenchNextAction(trade,settings),'watching');
 assert.equal(workbenchNextAction(trade,{...settings,synced:false}),'account');
});
test('the workbench follows actual research phases and never opens execution from a visual step',()=>{
 const {research,workspace,trade}=setup(),before=JSON.stringify(workspace.s);
 const collecting=workbenchFocus(research,trade,workspace,'ETH');assert.equal(collecting.stages[0].state,'active');assert.equal(collecting.stages[2].state,'waiting');assert.equal(collecting.candidate,false);
 research.advance(140);const done=workbenchFocus(research,trade,workspace);assert.equal(done.task.symbol,'ETH');assert.equal(done.candidate,true);assert.equal(done.stages[2].state,'ready');assert.equal(done.stages[4].state,'waiting');assert.deepEqual(done.orders,[]);assert.equal(JSON.stringify(workspace.s),before);
});
test('conflicting and TradFi findings retain their research result without gaining execution status',()=>{
 const {research,workspace,trade}=setup();research.advance(140);
 const conflict=workbenchFocus(research,trade,workspace,'SOL');assert.equal(conflict.blocked,true);assert.equal(conflict.stages[1].state,'blocked');assert.equal(conflict.stages[2].state,'waiting');
 const gold=workbenchFocus(research,trade,workspace,'XAU');assert.equal(gold.complete,true);assert.equal(gold.candidate,false);assert.equal(gold.stages[4].state,'waiting');
});
test('only the current research revision and exact run can supply orders and recorded fills',()=>{
 const {research,workspace,trade}=setup();research.advance(140);const task=research.task('ETH');
 trade.session={id:'SIM-TEST',market:'ETH/USDT',researchRevision:research.revision(task),authorizationId:'AUTH-TEST'};trade.state='running';
 trade.orders=[{id:'ours',runId:'SIM-TEST',filled:.5,status:'partial',fee:.05},{id:'old',runId:'SIM-OLD',filled:1,status:'filled',fee:99}];
 const current=workbenchFocus(research,trade,workspace,'ETH');assert.equal(current.linked,true);assert.deepEqual(current.orders.map(x=>x.id),['ours']);assert.equal(current.stages[5].state,'done');
 trade.orders[0].status='unknown';const unknown=workbenchFocus(research,trade,workspace,'ETH');assert.equal(unknown.stages[4].state,'blocked');assert.equal(unknown.filled.length,1);
 research.recheck('ETH');const replaced=workbenchFocus(research,trade,workspace,'ETH');assert.equal(replaced.linked,false);assert.equal(replaced.orders.length,0);assert.equal(replaced.stages[5].state,'waiting');
});
test('a strategy revision or exhausted budget cannot be presented as ready sizing',()=>{
 const {research,workspace,trade}=setup();research.advance(140);workspace.s.credits=0;
 const credits=workbenchFocus(research,trade,workspace,'ETH');assert.equal(credits.stages[3].state,'blocked');assert.match(credits.issue,/积分/);
 workspace.s.credits=1000;workspace.s.drafts[0].version++;const changed=workbenchFocus(research,trade,workspace,'ETH');assert.equal(changed.stages[2].state,'setup');assert.equal(changed.stages[3].state,'waiting');
});

test('decision trails do not borrow the previous revision even when two checks start at the same clock',()=>{
 const {research}=setup();research.advance(140);research.recheck('ETH');const old=research.events.filter(e=>e.symbol==='ETH').map(e=>e.id);research.recheck('ETH');const task=research.task('ETH'),events=workbenchEvents(research,task);assert.ok(events.length>0);assert.ok(events.every(e=>!old.includes(e.id)));assert.ok(events.some(e=>e.text.includes('v'+task.version)));
});

test('the operating desk uses complete English action labels',async()=>{const {translate}=await import('./locale.mjs');assert.equal(translate('开启机会跟进','en'),'Enable opportunity follow-up');assert.equal(translate('研究这个市场','en'),'Research this market');assert.equal(translate('最多使用 / USDT','en'),'Allocation limit / USDT');});

test('a handoff is visible before a trading session exists and expires with its research version',()=>{const {research,workspace,trade}=setup();research.advance(140);const handoff=research.handoff('ETH');const view=workbenchFocus(research,trade,workspace,'ETH',handoff);assert.equal(view.handedOff,true);assert.equal(view.linked,false);assert.equal(view.stages[4].state,'waiting');research.recheck('ETH');assert.equal(workbenchFocus(research,trade,workspace,'ETH',handoff).handedOff,false);});

test('market scan and watched assets overlap by source while all remains a distinct union',()=>{
 const {research,workspace,trade}=setup();research.advance(140);
 const watched=['ETH','SOL','XAU','unknown'],before=JSON.stringify({research:research.snapshot(),workspace:workspace.s,trade});
 const all=workbenchTracking(research,watched),scan=workbenchTracking(research,watched,'scan'),mine=workbenchTracking(research,watched,'tracked');
 assert.deepEqual(mine.map(t=>t.symbol),['ETH','SOL','XAU']);assert.deepEqual(scan.map(t=>t.symbol),['BTC','ETH','SOL','SPX','NDX','XAU','DXY','US10Y']);assert.equal(scan.some(t=>watched.includes(t.symbol)),true);assert.deepEqual(all.map(t=>t.symbol),scan.map(t=>t.symbol));
 const selected=workbenchFocus(research,trade,workspace,mine[0].symbol);assert.equal(selected.task.symbol,'ETH');assert.equal(selected.candidate,true);assert.equal(selected.orders.length,0);
 assert.deepEqual(workbenchTracking(research,[],'tracked'),[]);assert.equal(JSON.stringify({research:research.snapshot(),workspace:workspace.s,trade}),before);
 research.setScope('crypto');assert.deepEqual(workbenchTracking(research,watched,'tracked').map(t=>t.symbol),['ETH','SOL']);
});
test('feed rows preserve real event identity and distinguish research, market, trading and protection',()=>{
 const {research,trade}=setup();research.advance(140);
 trade.events=[{id:1,at:2,text:'ETH/USDT simulated fill',kind:'fill'},{id:2,at:3,text:'No permission for a new order',kind:'risk'}];
 const before=JSON.stringify({research:research.snapshot(),trade});const rows=workbenchFeed(research,trade);
 assert.equal(rows.length,new Set(rows.map(r=>r.key)).size);assert.deepEqual(rows.filter(r=>r.key.startsWith('trade:')).map(r=>r.kind),['trade','risk']);
 for(const row of rows.filter(r=>r.key.startsWith('research:'))){assert.ok(research.events.some(e=>'research:'+e.id===row.key&&e.symbol===row.symbol&&e.text===row.text));}
 assert.ok(rows.some(r=>r.kind==='analysis'));assert.equal(JSON.stringify({research:research.snapshot(),trade}),before);
 research.setScope('crypto');assert.ok(workbenchFeed(research,trade).filter(r=>r.symbol).every(r=>research.task(r.symbol).domain==='Crypto'));
});

test('an evicted feed record cannot return as a fresh event after many market readings',()=>{
 const cursor=new WorkbenchFeedCursor(),research={stream:'research',sequence:1};
 assert.equal(cursor.accept(research),true);
 for(let i=1;i<500;i++){assert.equal(cursor.accept({stream:'source',sequence:i}),true);assert.equal(cursor.accept(research),false);}
 assert.equal(cursor.accept({stream:'trade',sequence:1}),true);assert.equal(cursor.accept({stream:'research',sequence:2}),true);assert.equal(cursor.accept({stream:'research',sequence:1}),false);assert.equal(cursor.accept({stream:'trade',sequence:NaN}),false);
});

test('team cards only expose targets visible in Tracks and opportunities without changing research',()=>{
 const {research}=setup();research.advance(140);const before=JSON.stringify(research.snapshot());
 const visible=[research.task('ETH')],jobs=[{station:2,roles:[16],symbol:'ETH'},{station:3,roles:[6],symbol:'SPX'}];
 const view=workbenchTeamActivity(research,jobs,visible);
 assert.ok(view.every(group=>group.assets.every(task=>task.symbol==='ETH')));
 assert.equal(view[0].available,false);assert.equal(view[1].task.symbol,'ETH');
 assert.equal(view[2].assets[0].symbol,'ETH');assert.equal(view[2].task,null);
 assert.equal(view[3].available,false);assert.equal(workbenchTeamActivity(research,jobs,[]).some(g=>g.available),false);
 assert.equal(JSON.stringify(research.snapshot()),before);
});
