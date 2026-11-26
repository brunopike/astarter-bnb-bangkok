import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchExampleRows,workbenchExampleNotices,workbenchExamplesAvailable,workbenchExampleDetail,workbenchExampleRunList} from './workbench-console-examples.mjs';
import {workbenchUnreadNotifications,createWorkbenchConsole} from './workbench-console.mjs';
import {MultiResearch} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {pair} from './locale.mjs';
const scope={accountId:'SIM-01',environment:'DEMO'};
const idle=()=>({state:'idle',session:null,orders:[],events:[]});
test('examples cover four markets, map notices to real sample runs and never claim user balances',()=>{
 const rows=workbenchExampleRows();assert.equal(rows.length,10);
 assert.deepEqual(new Set(rows.map(row=>row.profileId)),new Set(['cex-spot','cex-perp','dex-spot','dex-perp']));
 for(const notice of workbenchExampleNotices())assert.ok(rows.some(row=>row.previewId===notice.exampleId));
 assert.equal(rows.find(row=>row.previewId==='btc-unknown').state,'unknown');assert.equal(rows.find(row=>row.previewId==='btc-swap').state,'confirming');
 const unknown=workbenchExampleDetail('btc-unknown');assert.ok(unknown.includes(pair('回执待核对','Receipt unconfirmed')));assert.ok(unknown.includes(pair('空头','Short')+' · 2×'));
 assert.equal(workbenchExampleDetail('missing'),null);
 const detail=workbenchExampleDetail('history');for(const [zh,en] of [['开仓','Open'],['平仓','Close'],['已成交','Filled'],['部分成交后撤单','Part-filled · Cancelled'],['回执待核对','Unconfirmed']])assert.ok(detail.includes(pair(zh,en)));
 assert.doesNotMatch(detail,/data-ops-run|data-statements|data-action|data-ops-strategy/);
 assert.equal((workbenchExampleRunList().match(/data-ops-example=/g)||[]).length,4);
});
test('automatic samples never mask actual runs, ledger history, corruption or other accounts',()=>{
 assert.equal(workbenchExamplesAvailable(idle(),scope),true);
 for(const d of [null,{...idle(),unreadableTrade:true},{...idle(),session:{id:'one'}},{...idle(),position:{}},{...idle(),pending:{}},{...idle(),orders:[{}]},{...idle(),botBook:{runs:[{}]}},{...idle(),botSummary:{recoveryError:true}},{...idle(),events:[{kind:'fill'}]}])assert.equal(workbenchExamplesAvailable(d,scope),false);
 assert.equal(workbenchExamplesAvailable(idle(),{...scope,environment:'LIVE'}),false);assert.equal(workbenchExamplesAvailable(idle(),{...scope,accountId:'another'}),false);
});
test('empty account renders labelled sample notices and runs without modifying user storage',()=>{
 const previous=globalThis.document,nodes=new Map(),events={};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},setAttribute(){},addEventListener(type,cb){events[key+':'+type]=cb;}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research}),trade=idle(),before=JSON.stringify(workspace.s);
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({scope})}});view.update();
  assert.ok(node('#ops-runs').innerHTML.includes(pair('模拟示例 · 不计入账户','Examples · separate from account')));assert.match(node('#ops-runs').innerHTML,/data-ops-example="history"/);
  assert.equal(node('#ops-view-notifications').dataset.unreadCount,'4');assert.equal(node('#ops-view-notifications').dataset.pendingCount,'2');
  assert.equal(JSON.stringify(workspace.s),before);
  events['host:click']({target:{closest:()=>({dataset:{},hasAttribute:name=>name==='data-ops-example-toggle'})}});
  assert.ok(node('#ops-runs').innerHTML.includes(pair('暂无运行','No runs yet')));assert.equal(node('#ops-view-notifications').dataset.unreadCount,'');assert.equal(JSON.stringify(workspace.s),before);
 }finally{globalThis.document=previous;}
});

test('live controls show the current empty account until examples are explicitly opened',()=>{
 const previous=globalThis.document,nodes=new Map(),events={};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},setAttribute(){},addEventListener(type,cb){events[key+':'+type]=cb;}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MarketResearch(),workspace=new WorkspaceSim({research}),trade=idle(),before=JSON.stringify(workspace.s);
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({scope})}});view.update();
  assert.ok(node('#ops-runs').innerHTML.includes(pair('暂无运行','No runs yet')));
  assert.doesNotMatch(node('#ops-runs').innerHTML,/data-ops-example="history"/);
  assert.equal(node('#ops-view-notifications').dataset.unreadCount,'');
  events['host:click']({target:{closest:()=>({dataset:{},hasAttribute:name=>name==='data-ops-example-toggle'})}});
  assert.match(node('#ops-runs').innerHTML,/data-ops-example="history"/);
  assert.equal(JSON.stringify(workspace.s),before);
 }finally{globalThis.document=previous;}
});
