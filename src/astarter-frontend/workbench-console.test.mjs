import {presentationCopy} from './product-presentation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchConsole,workbenchConsoleRuns,workbenchConsoleAccount,workbenchSignalState,workbenchSignalShortlist,saveWorkbenchLimits,workbenchConsoleNotifications,workbenchNotificationGroups,workbenchUnreadNotifications,markWorkbenchNotificationsRead,workbenchOperationState,workbenchInformation,mergeWorkbenchInformation,selectWorkbenchInformation} from './workbench-console.mjs';
import {MultiResearch} from './multi-research.mjs';
import {MarketResearch} from './live-research.mjs';
import {normalizeResearchBackground} from './market-hub-data.mjs';
import {strategyRecommendations} from './strategy-advisor.mjs';
import {workbenchSignalList} from './workbench-console.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {BotBook,botParameters} from './bot-runtime.mjs';
import {TradingAccess,ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {normalizeConnections} from './connections.mjs?v=20261120c';
import {workbenchRiskUsage,workbenchKellyEstimate,workbenchRiskPreference,saveWorkbenchRiskPreference} from './workbench-console.mjs';
import {protectionConfig} from './strategy-protection.mjs';
import {pair,getLocale,initLocale} from './locale.mjs';
import {parsePublicNews,projectPublicNews} from './public-news.mjs';
import {normalizePublicSocial,projectPublicSocial} from './public-social.mjs';

const idle=()=>({state:'idle',session:null,discovery:{armed:false},orders:[],events:[]});
test('AI monitoring distinguishes no run, waiting policy, manual trade and an actual strategy',()=>{
 assert.equal(workbenchOperationState(null).phase,'unavailable');
 assert.equal(workbenchOperationState(idle()).phase,'idle');
 assert.equal(workbenchOperationState({...idle(),discovery:{armed:true}}).phase,'watching');
 const manual={...idle(),state:'running',session:{id:'M1',singleShot:true}};
 assert.equal(workbenchOperationState(manual).phase,'manual');
 assert.equal(workbenchOperationState(manual).run,null);
 const run={id:'AI1',strategy:'S03',market:'ETH/USDT',amount:100,cap:500};
 assert.equal(workbenchOperationState({...idle(),session:run,state:'paused'}).phase,'paused');
 assert.equal(workbenchOperationState({...idle(),session:run,state:'running',signal:{side:'buy'}}).phase,'confirm');
 assert.equal(workbenchOperationState({...idle(),session:run,state:'running',pending:{status:'unknown'}}).phase,'unknown');
 assert.equal(workbenchOperationState({...idle(),session:run,state:'stopped',position:{market:'ETH/USDT'}}).phase,'position');
});

test('pending and unknown orders remain visible while the manual task keeps its original route',()=>{
 const manual={...idle(),state:'running',session:{singleShot:true},pending:{status:'unknown'}};
 assert.equal(workbenchOperationState(manual).phase,'manual');
 assert.equal(workbenchOperationState(manual).status,'unknown');
 assert.equal(workbenchOperationState({...manual,pending:{status:'submitted'}}).status,'pending');
 assert.equal(workbenchOperationState({...manual,pending:null}).status,'manual');
 assert.equal(workbenchOperationState(null).status,'unavailable');
});

test('waiting for entry conditions remains an active strategy and never masks an unknown order',()=>{
 const data={...idle(),state:'running',session:{id:'AUTO1',mode:'auto',awaitingResearch:true}};
 const before=JSON.stringify(data),state=workbenchOperationState(data);
 assert.equal(state.phase,'running');assert.equal(state.status,'waiting');assert.equal(JSON.stringify(data),before);
 assert.equal(workbenchOperationState({...data,pending:{status:'unknown'}}).status,'unknown');
 assert.equal(workbenchOperationState({...data,pending:{status:'submitted'}}).status,'pending');
});

test('quote updates cannot bury news or fill the key feed with old samples',()=>{
 const brief={id:'brief:one',kind:'news',fixed:true};
 const old=[{id:'quote:old',kind:'market'},...Array.from({length:48},(_,i)=>({id:'trade:'+i,kind:'trade'})),brief];
 const current=[{id:'quote:new',kind:'market'},brief];
 const result=mergeWorkbenchInformation(old,current,[current[0]]);
 assert.ok(!result.some(row=>row.id==='quote:old'));
 assert.equal(result.filter(row=>row.kind==='market').length,1);
 assert.equal(result.filter(row=>row.id===brief.id).length,1);
 assert.ok(result.length<=49);
 assert.equal(result[0].id,'quote:new');
});

test('category filters retain source records after the mixed stream scrolls them out',()=>{
 const stream=Array.from({length:48},(_,i)=>({id:'analysis:'+i,kind:'analysis',symbol:'ETH'}));
 const current=[{id:'order:one',kind:'trade',symbol:'BTC'},{id:'order:two',kind:'trade',symbol:'ETH'},{id:'risk:all',kind:'risk'},stream[0]];
 assert.deepEqual(selectWorkbenchInformation(stream,current,'trade','BTC').map(row=>row.id),['order:one','risk:all']);
 assert.deepEqual(selectWorkbenchInformation(stream,current,'trade','ETH').map(row=>row.id),['order:two','risk:all']);
 assert.equal(selectWorkbenchInformation(stream,current).length,48);
});

test('the information stream uses stable source identities, scoped trade records and existing fixtures',()=>{
 const research=new MultiResearch();research.advance(90);
 const before=JSON.stringify(research);
 const trade={...idle(),events:[{id:7,at:10,text:'Order filled',kind:'order'}]};
 const rows=workbenchInformation(research,trade);
 assert.ok(rows.some(row=>row.id==='trade:7'&&row.kind==='trade'));
 assert.ok(rows.some(row=>row.kind==='analysis'));
 assert.ok(rows.some(row=>row.kind==='market'));
 assert.ok(rows.some(row=>row.kind==='news'&&row.fixed));
 assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
 assert.deepEqual(workbenchInformation(research,trade),rows);
 assert.equal(JSON.stringify(research),before);
 assert.ok(!workbenchInformation(research,null).some(row=>row.kind==='trade'));
 research.setScope('crypto');
 assert.ok(workbenchInformation(research,trade).filter(row=>row.symbol).every(row=>['BTC','ETH','SOL'].includes(row.symbol)));
});

test('asset filters associate order events with their original order, never a later session',()=>{
 const research=new MultiResearch();
 const trade={...idle(),session:{market:'ETH/USDT'},orders:[{id:'SIM-ORD-7',market:'BTC/USDT'}],events:[{id:8,at:20,text:'SIM-ORD-7 filled',kind:'order'},{id:9,at:21,text:'ETH/USDT started',kind:'info'},{id:10,at:22,text:'Account paused',kind:'risk'}]};
 const rows=workbenchInformation(research,trade);
 assert.equal(rows.find(row=>row.id==='trade:8').symbol,'BTC');
 assert.equal(rows.find(row=>row.id==='trade:9').symbol,'ETH');
 assert.equal(rows.find(row=>row.id==='trade:10').symbol,undefined);
 trade.orders.push({id:'SIM-ORD-70',market:'ETH/USDT'});trade.events.push({id:11,at:23,text:'SIM-ORD-70 filled',kind:'order'});
 assert.equal(workbenchInformation(research,trade).find(row=>row.id==='trade:11').symbol,'ETH');
});

test('receipt actions use confirmed spectrum ownership and the original order, never an asset or later run',()=>{
 const research=new MultiResearch(),order=(id,extra={})=>({id,accountId:'SIM-01',environment:'DEMO',tradeOwner:'AI_SPECTRUM',market:'BTC/USDT',runId:'original',...extra});
 const trade={...idle(),time:30,accountSummary:{accountId:'SIM-01',environment:'DEMO'},session:{id:'later',tradeOwner:'AI_SPECTRUM',market:'ETH/USDT'},
  flow:{plans:[{id:'conflict',accountId:'SIM-01',environment:'DEMO',tradeOwner:'STRATEGY_AGENT'}]},
  orders:[order('SIM-ORD-7'),order('SIM-ORD-8',{tradeOwner:undefined}),order('SIM-ORD-9',{accountId:'OTHER'}),order('SIM-ORD-10',{environment:'LIVE'}),order('SIM-ORD-11',{planId:'conflict'}),order('receipt-custom')],
  events:[7,8,9,10,11].map(id=>({id,at:20,text:`SIM-ORD-${id} filled`,kind:'order'})).concat([{id:12,at:21,text:'BTC/USDT checked',kind:'risk'},{id:13,at:22,orderId:'receipt-custom',text:'Fill received',kind:'order'}])};
 const before=JSON.stringify(trade),rows=workbenchInformation(research,trade,{signals:[{id:'current',runId:'later',market:'ETH/USDT',at:20}]});
 assert.equal(rows.find(row=>row.id==='trade:7').orderId,'SIM-ORD-7');
 assert.equal(rows.find(row=>row.id==='trade:7').runId,'original');
 assert.equal(rows.find(row=>row.id==='trade:13').orderId,'receipt-custom');
 for(const id of [8,9,10,11,12]){const row=rows.find(row=>row.id==='trade:'+id);assert.equal(row.orderId,undefined);assert.equal(row.runId,undefined);}
 assert.equal(rows.find(row=>row.id==='signal:current').runId,'later');
 assert.equal(JSON.stringify(trade),before);
});

import {workbenchAge,workbenchPlainEvent,workbenchFeedSelection,workbenchAttention} from './workbench-console.mjs';
test('information timestamps express age on their own clock, including long-running sessions',()=>{
 assert.equal(workbenchAge(2696*60+20,2696*60+23),pair('刚刚','Just now'));
 assert.equal(workbenchAge(10,45),pair('35 秒前','35s ago'));
 assert.equal(workbenchAge(10,136),pair('2 分钟前','2m ago'));
 assert.equal(workbenchAge(10,7210),pair('2 小时前','2h ago'));
 assert.equal(workbenchAge(10,172810),pair('2 天前','2d ago'));
 assert.equal(workbenchAge(null,10),pair('时间未提供','Time unavailable'));
 assert.equal(workbenchAge(12,10),pair('刚刚','Just now'));
});
test('display cleanup removes internal revision/order labels but retains financial quantities',()=>{
 assert.equal(workbenchPlainEvent('避险研究组 开始采集 · v772'),'避险研究组 开始采集');
 assert.equal(workbenchPlainEvent('定期检查新证据 · 进入 v772'),pair('正在检查新变化','Checking for new developments'));
 assert.equal(workbenchPlainEvent('SIM-ORD-192 部分成交 50% · 手续费 0.10 USDT'),'部分成交 50% · 手续费 0.10 USDT');
 assert.equal(workbenchPlainEvent('待补 · 权重证据 · v772'),pair('还需检查大盘股的带动作用','Checking the influence of large-cap stocks'));
});
test('mixed feed covers all eight assets and keeps news while old trades remain in the trade filter',()=>{
 const research=new MultiResearch();research.advance(90);
 const trade={...idle(),time:1000,events:Array.from({length:16},(_,i)=>({id:i+1,at:1,text:'ETH/USDT filled',kind:'order'}))};
 const raw=workbenchInformation(research,trade),before=JSON.stringify(raw),mixed=workbenchFeedSelection(raw);
 assert.equal(mixed.filter(r=>r.kind==='market').length,8);
 assert.ok(mixed.some(r=>r.kind==='news'));
 assert.equal(new Set(mixed.filter(r=>r.kind==='analysis').map(r=>r.symbol)).size,mixed.filter(r=>r.kind==='analysis').length);
 assert.ok(!mixed.some(r=>r.kind==='trade'));
 assert.equal(workbenchFeedSelection(raw,'trade').length,16);
 assert.ok(workbenchFeedSelection(raw,'all','ETH').every(r=>r.symbol==='ETH'));
 assert.equal(JSON.stringify(raw),before);
});
test('action inbox is account scoped and never mistakes old notifications or research for an actionable order',()=>{
 const ready={ready:true,control:true};
 assert.deepEqual(workbenchAttention(idle(),ready),[]);
 assert.deepEqual(workbenchAttention({...idle(),events:[{kind:'risk',text:'old'}]},ready),[]);
 assert.equal(workbenchAttention(null,ready)[0].action,'connect');
 assert.equal(workbenchAttention(idle(),{ready:false,code:'read-only'})[0].title,pair('当前只能查看数据','View-only access'));
 const unknown={...idle(),pending:{status:'unknown'},session:{singleShot:true},state:'running'};
 assert.equal(workbenchAttention(unknown,ready)[0].action,'reconcile');
 assert.equal(workbenchAttention(unknown,{ready:false,control:false})[0].disabled,true);
 assert.equal(workbenchAttention({...idle(),state:'running',session:{market:'ETH/USDT',mode:'confirm'},signal:{side:'buy'}},ready)[0].route,'execution');
 assert.equal(workbenchAttention({...idle(),state:'paused',session:{market:'ETH/USDT'}},ready)[0].id,'paused');
 assert.ok(workbenchAttention({...idle(),position:{market:'BTC/USDT'}},ready).some(r=>r.id==='position'));
});

test('automation inbox skips ordinary fills, avoids duplicate blockers, and keeps legacy position management',()=>{
 const ready={ready:true,control:true};
 assert.deepEqual(workbenchAttention({...idle(),state:'running',session:{mode:'auto'},pending:{status:'submitted'}},ready),[]);
 const blocked={...idle(),state:'blocked',session:{mode:'auto'},events:[{kind:'info',text:'new tick'},{kind:'risk',text:'Daily loss limit reached'}]};
 assert.equal(workbenchAttention(blocked,ready)[0].text,'Daily loss limit reached');
 assert.equal(workbenchAttention(blocked,ready)[0].route,'execution');
 assert.deepEqual(workbenchAttention(blocked,{ready:false,code:'read-only'}).map(row=>row.id),['connection']);
 assert.equal(workbenchAttention({...idle(),state:'stopped',session:{singleShot:true},position:{market:'ETH/USDT'}},ready)[0].view,'ai');
 const paused={...idle(),state:'paused',session:{mode:'auto'}};
 assert.match(workbenchAttention(paused,ready)[0].text,/没有持仓|No open positions/);
 assert.deepEqual(workbenchAttention(paused,{ready:false}).map(row=>row.id),['connection']);
});

test('the console never presents a selected draft as authorization or resumes an old run',()=>{
 const previous=globalThis.document,nodes=new Map(),events={},navigations=[],settings=[];
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},children:[],setAttribute(){},addEventListener(type,cb){events[key+':'+type]=cb;},parentElement:{scrollTop:0}});return nodes.get(key);};
 const host=node('host'),intervention=node('intervention');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 workspace.draft=()=>assert.fail('A draft is not a trading authorization');
 let trade={...idle(),state:'paused',session:{id:'ETH-OLD',mode:'auto',strategy:'S03',market:'ETH/USDT',amount:100,cap:500}};
 const before=JSON.stringify(trade);
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){},dispatchEvent:event=>navigations.push(event.detail)};
  const view=createWorkbenchConsole({host,intervention,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),settings:id=>settings.push(id),action(){assert.fail('This console must not change a run');}}});
  view.update();const tradingHTML=()=>['#ops-plan','#ops-runs','#ops-positions'].map(key=>node(key).innerHTML).join('');
  assert.match(node('#ops-plan').innerHTML,/交易限额|Trading limits/);assert.doesNotMatch(node('#ops-plan').innerHTML,/已授权|Authorized/);assert.match(node('#ops-plan').innerHTML,/data-ops-risk-form/);
  assert.match(node('#ops-plan').innerHTML,/data-ops-risk-open="protection"/);assert.match(node('#ops-plan').innerHTML,/data-ops-risk-open="kelly"/);
  assert.doesNotMatch(tradingHTML(),/data-ops-action|每次买入|Amount per entry/);assert.match(node('#ops-plan').innerHTML,/name="cap"[^>]*value="1000"/);
  assert.match(node('#ops-plan').innerHTML,/累计亏损 \/ 费用|Cumulative loss \/ fees/);
  assert.match(node('#ops-plan').innerHTML,/name="dailyLoss" aria-label="(?:累计亏损或费用暂停线|Cumulative loss or fee pause limit)"/);
  assert.match(node('#ops-plan').innerHTML,/累计亏损或手续费达上限时暂停新买入；已有挂单仍可能成交|New buys pause when cumulative loss or fees reach the limit; open orders can still fill/);
  assert.doesNotMatch(node('#ops-plan').innerHTML,/<details|ops-boundary-summary/,'limits are directly editable instead of hidden behind a duplicate summary');
  assert.match(node('#ops-plan').innerHTML,/data-ops-settings="exchange"/);
  assert.match(node('#ops-runs').innerHTML,/ETH\/USDT/);assert.match(node('#ops-runs').innerHTML,/已暂停|Paused/);
  assert.match(node('#ops-runs').innerHTML,/runId=ETH-OLD/);assert.match(intervention.innerHTML,/SIM-01/);
  assert.doesNotMatch(node('#ops-plan').innerHTML,/ops-choose-plan|data-ops-select-view="signals"/,'the existing Signals tab is not duplicated as a forced BOT step');
  assert.match(node('#ops-plan').innerHTML,/class="ops-capital-actions" hidden/,'saving is only offered for an edited limit');
  assert.equal((tradingHTML().match(/ops-primary/g)||[]).length,1);
  const rendered=tradingHTML();research.advance(80);view.update();assert.equal(tradingHTML(),rendered);assert.equal(JSON.stringify(trade),before);
  trade={...trade,pending:{status:'unknown'}};view.update();assert.match(node('#ops-runs').innerHTML,/data-state="unknown"/);assert.match(node('#ops-runs').innerHTML,/runId=ETH-OLD/);
  assert.equal(node('#ops-view-notifications').dataset.pendingCount,'1');
  events['host:click']({target:{closest:()=>({dataset:{opsNoticeView:'history'}})}});
  assert.equal(node('#ops-view-notifications').dataset.pendingCount,'1','reading history does not clear an unresolved order');
  events['host:click']({target:{closest:()=>({dataset:{opsNoticeView:'attention'}})}});
  trade={...trade,pending:null,state:'blocked'};view.update();assert.match(node('#ops-runs').innerHTML,/data-state="blocked"/);
  trade={...trade,botBook:{runs:[{id:'FAILED-HELD',status:'failed',quantity:2,plan:{market:'SOL/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}}]}};view.update();assert.match(node('#ops-runs').innerHTML,/执行失败 · 持仓保留|Failed · Position retained/);assert.match(node('#ops-runs').innerHTML,/runId=FAILED-HELD/);
  trade.botBook.runs.push({id:'ORDER-CHECK',status:'blocked',quantity:0,orders:[{id:'ORIGINAL',runId:'ORDER-CHECK',accountId:'SIM-01',status:'unknown'}],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}});view.update();assert.match(node('#ops-runs').innerHTML,/原订单回执待确认|Original order outcome unconfirmed/);assert.match(node('#ops-runs').innerHTML,/runId=ORDER-CHECK/);
  trade.botBook.runs[1].status='stopped';trade.botBook.runs[1].orders[0].status='cancelled';trade.botBook.flow={reservations:[{instanceId:'ORDER-CHECK',accountId:'SIM-01',state:'HELD',amount:'25'}]};view.update();assert.match(node('#ops-runs').innerHTML,/资金预留待核对|Reserved funds need review/);
  const closing=new BotBook({debit:()=>true,credit:()=>true});
  const started=closing.create({id:'CLOSING-CHECK',version:1,strategy:'S02',planVariant:'S02-SIM',market:'ETH/USDT',executionRoute:{accountId:'SIM-01',connectionId:'legacy-exchange',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S02')},{requestId:'CLOSING-CHECK'});
  assert.ok(!started.error);for(let i=0;i<40;i++)closing.tick(.1,{'ETH/USDT':100});
  const ending=closing.action(started.run.id,'stop-close',{requestId:'CLOSING-EXIT'});assert.equal(ending.run.status,'stopping');
  trade={...trade,session:null,botBook:closing.snapshot()};view.update();assert.match(node('#ops-runs').innerHTML,/正在结束|Ending/);assert.doesNotMatch(node('#ops-runs').innerHTML,/状态待确认|Status unconfirmed/);assert.match(node('#ops-runs').innerHTML,new RegExp('runId='+started.run.id));
  assert.doesNotMatch(node('#ops-tracking').innerHTML,/SPX|data-ops-source/);assert.match(node('#ops-tracking').innerHTML,/研究范围|Research scope/);
  events['host:click']({target:{closest:()=>({dataset:{opsRoute:'execution'}})}});assert.equal(navigations.at(-1),'execution');
  let prevented=0;events['host:click']({target:{closest:()=>({dataset:{opsRun:'ETH-OLD'}})},preventDefault:()=>prevented++});assert.equal(prevented,1);assert.deepEqual(navigations.at(-1),{kind:'run',id:'ETH-OLD'});
  events['host:click']({ctrlKey:true,target:{closest:()=>({dataset:{opsRun:'ETH-OLD'}})},preventDefault:()=>prevented++});assert.equal(prevented,1);
  trade=null;view.update();assert.match(node('#ops-runs').innerHTML,/暂无运行|No runs/);assert.match(node('#ops-positions').innerHTML,/暂不可用|unavailable/);
  assert.doesNotMatch(node('#ops-runs').innerHTML,/data-ops-route|data-ops-select-view/,'the empty run list does not duplicate the main plan action');
  assert.match(node('#ops-ai').innerHTML,/ops-ai-issues/);
  assert.match(node('#ops-ai').innerHTML,/data-ops-settings="data"/);
  events['host:click']({target:{closest:()=>({dataset:{opsRoute:'strategies'}})}});assert.equal(navigations.at(-1),'strategies');
  events['host:click']({target:{closest:()=>({dataset:{opsSettings:'data'}})}});assert.deepEqual(settings,['data']);
  const beforeSignalClick=navigations.length,first=workbenchSignalShortlist(strategyRecommendations(workspace,trade))[0];
  events['host:click']({target:{closest:()=>({dataset:{opsStrategy:'recommendation',id:first.id}})}});
  assert.equal(navigations.length,beforeSignalClick,'an ineligible signal cannot open trading configuration through a stale button');
  events['host:click']({target:{closest:()=>({dataset:{opsSignalView:'strategies'}})}});
  assert.match(node('#ops-signals').innerHTML,/data-ops-strategy="template" data-id="S01"/);
  assert.match(node('#ops-signals').innerHTML,/data-ops-strategy="template" data-id="S02"/);
  assert.equal((node('#ops-signals').innerHTML.match(/data-ops-strategy="template"/g)||[]).length,18);
  assert.match(node('#ops-signals').innerHTML,/data-id="RX05"/);
  assert.doesNotMatch(node('#ops-signals').innerHTML,/data-ops-route="strategies"/,'opening a plan does not leave the workbench');
  workspace.s.workbenchRisk={accountId:'SIM-01',environment:'DEMO',revision:2,protection:{id:'original',version:'strategy-original'}};
  // Only a revision is handed off; the receiver must read its own same-scope policy.
  events['host:click']({target:{closest:()=>({dataset:{opsStrategy:'template',id:'S01'}})}});
  assert.deepEqual(navigations.at(-1),{kind:'template',id:'S01',riskPreferenceRevision:2});
  events['host:click']({target:{closest:()=>({dataset:{opsStrategy:'source',id:'original-source'}})}});
  assert.deepEqual(navigations.at(-1),{kind:'source',id:'original-source'});
  assert.equal(JSON.stringify(trade),'null');
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('the access label queries the preferred connection and preserves its actual blocker',()=>{
 const previous=globalThis.document,nodes=new Map(),queries=[];
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},setAttribute(){},addEventListener(){}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 workspace.draft=()=>assert.fail('A draft cannot grant access');
 const connections=normalizeConnections({preferences:{exchange:{service:'binance',market:'spot',access:'read'}},tradingAccounts:[
  {id:'api-main',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'},
  {id:'api-read',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'SIM-01'},
  {id:'wallet-main',kind:'wallet',service:'metamask',chain:'42161',access:'read',accountId:'SIM-01'}
 ],preferredTradingConnection:'api-main'});
 const runtime=new TradingAccess(connections),stream={state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}};
 const trade={...idle(),connections};
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({...stream,access:runtime.status(stream)}),access:options=>{
   queries.push(options);const access=runtime.status(stream,options);
   return options.nativeBot&&['data-off','ai-off'].includes(access.code)?{...access,ready:true,code:'ready'}:access;
  }}});
  const check=(code,connectionId=connections.preferredTradingConnection)=>{
   const before=JSON.stringify({trade,stream});view.update();
   const row=node('#ops-plan').innerHTML.split('</button>')[0];
   assert.ok(ACCESS_COPY[code].slice(0,2).some(copy=>row.includes(presentationCopy(copy))),code+': '+row);
   assert.equal(queries.at(-1).connectionId,connectionId);
   assert.equal(JSON.stringify({trade,stream}),before,'rendering does not change access or connection settings');
  };
  check('connection-unchecked');
  runtime.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-main'});check('ready');
  connections.data=false;check('data-off');connections.data=true;
  connections.ai=false;check('ai-off');connections.ai=true;
  stream.state='DISCONNECTED';check('view-offline');stream.state='RESNAPSHOTTING';check('reading');stream.state='LIVE';
  runtime.configure(connections,{section:'exchange',operation:'verify',connectionId:'api-read'});
  connections.preferredTradingConnection='api-read';check('read-only');
  connections.preferredTradingConnection='removed';check('connection-missing','');
  connections.preferredTradingConnection='api-main';stream.scope.accountId='SIM-02';check('other-account');stream.scope.accountId='SIM-01';
  runtime.configure(connections,{section:'wallet',operation:'verify',connectionId:'wallet-main'});
  connections.preferredTradingConnection='wallet-main';check('wallet-authority');assert.equal(queries.at(-1).profileId,'dex-spot');
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('run summaries preserve instance and account identity, including retained positions',()=>{
 const trade={...idle(),state:'paused',session:{id:'legacy',market:'ETH/USDT',strategy:'S03'},botBook:{runs:[
  {id:'bot-1',plan:{market:'BTC/USDT',strategy:'S01',executionRoute:{accountId:'SIM-01'}},status:'running',realizedPnl:1,unrealizedPnl:-.5},
  {id:'bot-2',plan:{market:'SOL/USDT',strategy:'S02',executionRoute:{accountId:'SIM-02'}},status:'running'},
  {id:'retained',plan:{market:'SOL/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}},status:'stopped',quantity:2},
  {id:'ended',plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}},status:'stopped',quantity:0}
 ]}};
 const before=JSON.stringify(trade),rows=workbenchConsoleRuns(trade);
 assert.deepEqual(rows.map(r=>r.id),['bot-1','retained','legacy']);assert.equal(rows[0].pnl,.5);assert.equal(rows.at(-1).state,'paused');assert.equal(rows.at(-1).pnl,null);
 assert.equal(rows.find(row=>row.id==='retained').retained,true);assert.equal(rows.find(row=>row.id==='retained').state,'stopped');
 trade.botBook.runs[2].status='failed';const failed=workbenchConsoleRuns(trade).find(row=>row.id==='retained');assert.equal(failed.retained,true);assert.equal(failed.state,'failed');trade.botBook.runs[2].status='stopped';
 assert.deepEqual(workbenchConsoleRuns(null),[]);assert.equal(JSON.stringify(trade),before);
 trade.session.ticket={accountId:'SIM-01'};assert.deepEqual(workbenchConsoleRuns(trade,'SIM-02').map(r=>r.id),['bot-2']);
 trade.session.singleShot=true;trade.position={market:'ETH/USDT',qty:1};const manual=JSON.stringify(trade);assert.deepEqual(workbenchConsoleRuns(trade).map(r=>r.id),['bot-1','retained']);assert.equal(JSON.stringify(trade),manual,'manual positions stay in the account, outside the BOT run list');
});

test('an empty bot exposes its actual risk-budget wait without hiding positions or pending orders',()=>{
 const run={id:'TIGHT',status:'running',quantity:0,orders:[],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}},protectionDecision:{scope:'BOT_ALLOCATION',action:'pause',reason:'budget',amount:0}};
 const rows=()=>workbenchConsoleRuns({botBook:{runs:[run]}});
 assert.equal(rows()[0].riskIssue,'budget');assert.equal(rows()[0].state,'running','projection does not change the actual execution state');
 run.quantity=1;assert.equal(rows()[0].riskIssue,null);run.quantity=0;
 run.orders.push({id:'ORIGINAL',runId:'TIGHT',accountId:'SIM-01',status:'unknown'});assert.equal(rows()[0].riskIssue,null);assert.equal(rows()[0].attention,'unknown');
 run.orders[0].status='filled';assert.equal(rows()[0].riskIssue,'budget');
 run.protectionDecision.reason='account';assert.equal(rows()[0].riskIssue,null);
});

test('the console reads the shared account summary only for its live account and environment',()=>{
 const summary={accountId:'SIM-01',environment:'DEMO',unit:'USDT',equity:10100,available:9000,reserved:1000,positions:2,orders:1,asOf:500},trade={cash:999999,accountSummary:summary},sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}};
 const before=JSON.stringify({trade,sync});
 assert.equal(workbenchConsoleAccount(trade,sync),summary);
 for(const state of ['STALE','CONNECTING','DISCONNECTED'])assert.equal(workbenchConsoleAccount(trade,{...sync,state}),null);
 assert.equal(workbenchConsoleAccount(trade,{...sync,scope:{accountId:'SIM-02',environment:'DEMO'}}),null);
 assert.equal(workbenchConsoleAccount(trade,{...sync,scope:{accountId:'SIM-01',environment:'LIVE'}}),null);
 assert.equal(workbenchConsoleAccount({cash:10000},sync),null);
 assert.equal(workbenchConsoleAccount({...trade,accountSummary:{...summary,available:NaN}},sync),null);
 assert.equal(JSON.stringify({trade,sync}),before);
});

test('the inbox keeps manual unknown orders and approvals actionable until their source resolves them',()=>{
 const trade={...idle(),state:'running',time:100,accountSummary:{accountId:'SIM-01'},session:{id:'MANUAL-1',singleShot:true,market:'ETH/USDT',ticket:{accountId:'SIM-01'}},pending:{status:'unknown'},events:[]};
 const before=JSON.stringify(trade),rows=workbenchConsoleNotifications(trade,null);
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'attention');assert.equal(rows[0].runId,'MANUAL-1');assert.equal(rows[0].symbol,'ETH');
 workbenchNotificationGroups(rows);assert.equal(JSON.stringify(trade),before,'viewing or grouping is not resolution');
 assert.equal(workbenchConsoleNotifications(trade,null,'SIM-02').length,0);
 trade.pending=null;assert.equal(workbenchConsoleNotifications(trade,null).length,0,'only the actual outcome clears attention');
});

test('receipt grouping retains each original run and order without borrowing the current strategy',()=>{
 const trade={...idle(),time:100,session:{id:'CURRENT',market:'ETH/USDT'},orders:[{id:'SIM-ORD-7',runId:'ORIGINAL',market:'BTC/USDT',accountId:'SIM-01'}],events:[{id:1,kind:'fill',at:95,text:'SIM-ORD-7 部分成交 50%'},{id:2,kind:'order',at:90,text:'SIM-ORD-7 买入已提交'},{id:3,kind:'order',at:97,text:'无关联的账户记录'}]};
 const before=JSON.stringify(trade),rows=workbenchConsoleNotifications(trade,null),groups=workbenchNotificationGroups(rows);
 assert.equal(groups.length,2);const original=groups.find(row=>row.runId==='ORIGINAL');
 assert.equal(original.id,'run:ORIGINAL');assert.equal(original.symbol,'BTC');assert.deepEqual(original.items.map(row=>row.id),['receipt:1','receipt:2']);
 assert.equal(groups.find(row=>row.id==='account').runId,null);assert.equal(JSON.stringify(trade),before);
 const next=workbenchNotificationGroups([{id:'new',runId:'ORIGINAL',kind:'receipt',text:'Filled',age:0},...rows]);
 assert.equal(next[0].id,original.id,'the expanded object identity survives a new receipt');assert.equal(next[0].items.length,3);
});

test('notification history keeps real run targets and omits account or unavailable-run fallbacks',()=>{
 const previous=globalThis.document,nodes=new Map(),events={};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},children:[],setAttribute(){},addEventListener(type,callback){events[key+':'+type]=callback;},parentElement:{scrollTop:0}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 workspace.s.clock=100;workspace.s.notices=[{id:'risk-history',kind:'risk',text:'Risk limits updated',at:90,read:false}];
 const trade={...idle(),time:100,session:{id:'CURRENT',strategy:'S03',market:'ETH/USDT',accountId:'SIM-01',environment:'DEMO'},accountSummary:{accountId:'SIM-01',environment:'DEMO',available:10000,equity:10000,reserved:0,positions:0,orders:0,unit:'USDT'},orders:[{id:'SIM-ORD-7',accountId:'SIM-01',environment:'DEMO',market:'ETH/USDT'},{id:'SIM-ORD-8',accountId:'SIM-01',environment:'DEMO',runId:'OLD',market:'BTC/USDT'}],events:[{id:'plain',kind:'order',text:'Account check completed',at:91},{id:'order-only',kind:'order',text:'SIM-ORD-7 acknowledged',at:92},{id:'historical',kind:'fill',text:'SIM-ORD-8 filled',at:93},{id:'current',kind:'risk',runId:'CURRENT',text:'Current run checked',at:94}],botBook:{time:100,runs:[{id:'ORIGINAL',environment:'DEMO',status:'stopped',quantity:0,orders:[],events:[{kind:'ended',at:92}],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}},{id:'WRONG-ENV',environment:'LIVE',status:'stopped',quantity:0,orders:[],events:[{kind:'ended',at:92}],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}}]}};
 const before=JSON.stringify({notices:workspace.s.notices,reads:workspace.s.workbenchNotificationReads,trade});
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});view.update();
  events['host:click']({target:{closest:()=>({dataset:{opsNoticeView:'history'}})}});
  const html=node('#ops-notices').innerHTML,group=id=>html.split('data-receipt-group="'+id+'"')[1].split('</details>')[0];
  assert.match(group('risk'),/Risk limits updated/);assert.doesNotMatch(group('risk'),/ops-signal-action|data-ops-strategy="account"/);
  assert.match(group('account'),/Account check completed/);assert.doesNotMatch(group('account'),/ops-signal-action|data-ops-strategy="account"/);
  assert.match(group('order:SIM-ORD-7'),/data-ops-notice-read="receipt:order-only"/);assert.match(group('order:SIM-ORD-7'),/<span>acknowledged<\/span>/);assert.doesNotMatch(group('order:SIM-ORD-7'),/ops-signal-action|data-ops-strategy="account"/);
  assert.match(group('run:OLD'),/data-ops-notice-read="receipt:historical"/);assert.match(group('run:OLD'),/<span>filled<\/span>/);assert.doesNotMatch(group('run:OLD'),/ops-signal-action|data-ops-run/);
  assert.doesNotMatch(group('run:WRONG-ENV'),/ops-signal-action|data-ops-run/);
  assert.match(group('run:ORIGINAL'),/data-ops-run="ORIGINAL"/);assert.match(group('run:ORIGINAL'),/查看这次运行|View this run/);
  assert.match(group('run:CURRENT'),/data-ops-run="CURRENT"/);assert.match(group('run:CURRENT'),/Current run checked/);
  assert.match(node('#ops-positions').innerHTML,/data-ops-strategy="account"/,'the actual account assets entry remains available');
  assert.match(node('#ops-positions').innerHTML,/模拟盘可用余额|Available paper balance/);
  assert.equal(JSON.stringify({notices:workspace.s.notices,reads:workspace.s.workbenchNotificationReads,trade}),before);
 }finally{globalThis.document=previous;}
});

test('the account button counts live Binance orders instead of the empty paper book',()=>{
 const previous=globalThis.document,nodes=new Map();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},textContent:'',querySelector(){return null;},querySelectorAll:()=>[],addEventListener(){},parentElement:{scrollTop:0}});return nodes.get(key);};
 const host=node('host');host.querySelector=selector=>node(selector);
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 const trade={...idle(),accountSummary:{accountId:'SIM-01',environment:'DEMO',equity:1,available:1,reserved:0,positions:0,orders:0},connections:{spotBook:{symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0,orders:[{orderId:'1',side:'BUY',strategy:'S01',origQty:'0.00012',price:'1',status:'NEW'},{orderId:'2',side:'BUY',strategy:'S01',origQty:'0.00011',price:'2',status:'NEW'}],history:[]}}};
 try{
  globalThis.document={activeElement:null,visibilityState:'visible',body:{dataset:{}},querySelector:selector=>selector==='.console-header h2'?node('title'):null,addEventListener(){}};
  createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}}).update();
  const html=node('#ops-positions').innerHTML;
  assert.match(html,/挂单详情|Open orders/);
  assert.match(html,/(挂单详情|Open orders)[\s\S]*<b>2<\/b>/);
  assert.match(html,/已挂在这个币安现货 2|Live on this Binance spot 2/);
  assert.doesNotMatch(html,/模拟挂单|Paper orders/);
 }finally{globalThis.document=previous;}
});

test('account assets show the Binance balance when Binance spot is connected and the paper account otherwise',()=>{
 const previous=globalThis.document,nodes=new Map();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},children:[],setAttribute(){},addEventListener(){},parentElement:{scrollTop:0}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 const paper={...idle(),time:100,accountSummary:{accountId:'SIM-01',environment:'DEMO',available:9000,equity:10000,reserved:1000,positions:0,orders:0,unit:'USDT'}};
 let trade=paper;
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>({state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});
  view.update();let html=node('#ops-positions').innerHTML;
  // No Binance connection: the paper balance keeps its paper label and the reserved line.
  assert.match(html,/模拟盘可用余额|Available paper balance/);assert.match(html,/已预留|Reserved/);assert.doesNotMatch(html,/币安可用|Binance available/);
  assert.match(html,/持仓详情|Paper positions/);assert.match(html,/模拟挂单|Paper orders/);
  trade={...paper,connections:{tradingAccounts:[{id:'binance-spot',kind:'exchange',service:'binance',market:'spot',access:'read',accountId:'BINANCE-SPOT',label:'Binance',status:'connected',checkedAt:1,available:9.91,locked:0.09}]}};
  view.update();html=node('#ops-positions').innerHTML;
  // Connected Binance spot: the Binance balance and its reserved amount, never under the paper label.
  assert.match(html,/币安可用|Binance available/);assert.match(html,/9\.91/);assert.match(html,/币安挂单冻结|Binance reserved/);assert.doesNotMatch(html,/模拟盘可用余额|Available paper balance/);
  assert.match(html,/data-ops-strategy="account"/);
  // A Binance spot book without a connected balance row still shows the Binance side.
  trade={...paper,connections:{spotBook:{symbol:'BTCUSDT',usdt:5,usdtLocked:0,btc:0.001,orders:[],history:[]}}};
  view.update();html=node('#ops-positions').innerHTML;
  assert.match(html,/币安可用|Binance available/);assert.match(html,/<span>BTC<\/span>/);assert.doesNotMatch(html,/模拟盘可用余额|Available paper balance/);
  // A spot book is the Binance balance even when the paper account summary is absent.
  trade={...idle(),time:100,connections:{spotBook:{symbol:'BTCUSDT',usdt:5,usdtLocked:0,btc:0.001,orders:[],history:[]}}};
  view.update();html=node('#ops-positions').innerHTML;
  assert.match(html,/币安可用|Binance available/);assert.match(html,/5\.00/);assert.doesNotMatch(html,/账户数据暂不可用|Account data is unavailable/);
 }finally{globalThis.document=previous;}
});

test('pausing entries does not hide a retained position with impaired protection',()=>{
 const trade={...idle(),state:'paused',session:{id:'PROTECTED',market:'ETH/USDT',ticket:{accountId:'SIM-01'}},position:{qty:1},flow:{protections:[{instanceId:'PROTECTED',state:'IMPAIRED',targetQuantity:'1'}]}};
 const before=JSON.stringify(trade),rows=workbenchConsoleNotifications(trade,null);
 assert.equal(rows.length,1);assert.equal(rows[0].runId,'PROTECTED');assert.match(rows[0].text,/保护|protection/);assert.equal(JSON.stringify(trade),before);
 trade.pending={status:'unknown'};const unknown=workbenchConsoleNotifications(trade,null);assert.equal(unknown.length,1);assert.match(unknown[0].text,/结果待确认|unconfirmed/,'the original unknown receipt remains the first task');
 trade.pending=null;trade.flow.protections[0].targetQuantity='0';assert.equal(workbenchConsoleNotifications(trade,null).length,0);
});

test('actual blocked orders and accepted recovery holds remain visible without changing their records',()=>{
 const plan={id:'CONSOLE-CHECK',version:1,strategy:'S02',planVariant:'S02-SIM',market:'ETH/USDT',executionRoute:{accountId:'SIM-01',connectionId:'legacy-exchange',venueId:'binance',profileId:'cex-spot',chainId:''},amount:100,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S02')};
 const unknown=new BotBook({debit:()=>true,credit:()=>true});
 const created=unknown.create({...plan,simulationScenario:'unknown'},{requestId:'UNKNOWN'});assert.ok(!created.error);
 for(let i=0;i<30;i++)assert.ok(!unknown.tick(.1,{'ETH/USDT':100}).error);
 const blocked=unknown.snapshot(),unchanged=JSON.stringify(blocked),pending=workbenchConsoleRuns({botBook:blocked})[0];
 assert.equal(pending.id,created.run.id);assert.equal(pending.state,'blocked');assert.equal(pending.attention,'unknown');assert.equal(JSON.stringify(blocked),unchanged);
 assert.equal(workbenchConsoleRuns({botBook:blocked},'SIM-02').length,0);
 const book=new BotBook({debit:()=>true,credit:()=>true}),run=book.create(plan,{requestId:'HELD'}).run;
 assert.ok(!book.action(run.id,'stop-keep',{requestId:'STOP'}).error);
 const recovered=book.snapshot(),allocation=recovered.flow.reservations.find(row=>row.instanceId===run.id);
 Object.assign(allocation,{state:'HELD',amount:'25',releaseEvidenceId:null});
 const restored=new BotBook({debit:()=>assert.fail('Recovery must not debit'),credit:()=>assert.fail('Recovery must not credit')});
 assert.equal(restored.restore(recovered),true,'the current recovery validator accepts a stale allocation hold');
 const snapshot=restored.snapshot(),before=JSON.stringify(snapshot),rows=workbenchConsoleRuns({botBook:snapshot});
 assert.equal(rows.length,1);assert.equal(rows[0].id,run.id);assert.equal(rows[0].state,'stopped');assert.equal(rows[0].attention,'reserved');assert.equal(rows[0].retained,false);assert.equal(JSON.stringify(snapshot),before);
 const held=snapshot.flow.reservations.find(row=>row.instanceId===run.id);
 for(const patch of [{instanceId:'OTHER-RUN'},{instanceId:run.id,accountId:'SIM-02'},{accountId:'SIM-01',state:'RELEASED'},{state:'HELD',amount:'0'}]){Object.assign(held,patch);assert.equal(workbenchConsoleRuns({botBook:snapshot}).length,0);}
});

test('the feed shares opportunity targets, includes dated signal/on-chain sources and never mutates them',()=>{
 const research=new MultiResearch();research.advance(140);const tasks=research.tasks.filter(t=>['BTC','ETH'].includes(t.symbol));
 const before=JSON.stringify(research),rows=workbenchInformation(research,null,{tasks});
 assert.ok(rows.every(row=>!row.symbol||['BTC','ETH'].includes(row.symbol)));
 assert.ok(rows.some(row=>row.kind==='signal'&&row.fixed&&row.at.startsWith('2026-10-24')));
 assert.ok(rows.some(row=>row.kind==='anomaly'&&row.fixed&&row.route==='tracking'));
 const fixed=rows.filter(row=>row.fixed);research.time+=3;
 assert.deepEqual(workbenchInformation(research,null,{tasks}).filter(row=>row.fixed),fixed);
 research.time-=3;assert.equal(JSON.stringify(research),before);
 assert.equal(workbenchInformation(research,null,{tasks:[]}).length,0);
});
test('data-center alerts retain observed timestamps, reject stale quotes, and never fabricate a trade',()=>{
 const research=new MultiResearch(),now=1800000000000,marketData=[{symbol:'BTC',price:80000,change:-4,asOf:now-10000,provider:'Binance Spot',quote:'USDT'},{symbol:'ETH',price:3200,change:10,asOf:now-7200001}];
 const rows=workbenchInformation(research,null,{marketData,now}),quote=rows.find(r=>r.kind==='market'&&r.symbol==='BTC');
 assert.equal(quote.wallTime,true);assert.equal(quote.at,now-10000);assert.equal(quote.age,10);assert.equal(quote.source,'Binance Spot');
 assert.ok(rows.some(r=>r.kind==='anomaly'&&r.symbol==='BTC'&&r.wallTime&&r.at===quote.at));
 assert.ok(!rows.some(r=>r.kind==='anomaly'&&r.symbol==='ETH'&&r.wallTime));
 assert.ok(!rows.some(r=>r.kind==='trade'));
 assert.ok(workbenchFeedSelection(rows,'market').some(r=>r.kind==='anomaly'));
 assert.ok(workbenchFeedSelection(rows,'analysis').some(r=>r.kind==='signal'));
});

test('live information reads validated daily observations without synthetic prices or fixed stories',()=>{
 const day=86400,closedAt=Date.UTC(2026,10,17)/1000;let now=closedAt+100;
 const research=new MarketResearch({now:()=>now});
 assert.deepEqual(workbenchInformation(research,null,{now:now*1000}),[]);
 const row={symbol:'BTC',state:'ready',feedState:'snapshot',paused:false,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',source:'Binance Spot',timezone:'UTC',unit:'USDT',price:100,x:0,y:50,change:2,bars:300,sampleAt:closedAt-day,closedAt,validUntil:closedAt+day,signal:'balanced'};
 research.ingestMarket([row,{...row,symbol:'SPX',source:'Yahoo Finance · S&P 500',timezone:'America/New_York',unit:'index',price:6000}]);
 const rows=workbenchInformation(research,null,{now:now*1000}),quotes=rows.filter(item=>item.kind==='market');
 assert.deepEqual(quotes.map(item=>[item.symbol,item.price,item.unit]),[['BTC',100,'USDT'],['SPX',6000,'index']]);
 assert.ok(quotes.every(item=>item.at===closedAt*1000&&item.wallTime&&item.priceBasis==='daily-close'));
 assert.equal(quotes[0].source,'Binance Spot');assert.equal(quotes[0].change,2);
 assert.ok(!rows.some(item=>item.fixed||item.kind==='news'||item.id.startsWith('tracking:')));
 const latest=workbenchInformation(research,null,{now:now*1000,marketData:[{symbol:'BTC',price:101,change:3,asOf:now*1000-1000,provider:'Binance Spot',quote:'USDT'}]}).find(item=>item.kind==='market'&&item.symbol==='BTC');
 assert.equal(latest.price,101);assert.equal(latest.at,now*1000-1000);assert.notEqual(latest.priceBasis,'daily-close');
 now=closedAt+day;
 assert.ok(!workbenchInformation(research,null,{now:now*1000}).some(item=>item.kind==='market'&&item.symbol==='BTC'));
});
test('live news keeps publication time and multiple asset matches without reusing publisher body or fixed examples',()=>{
 const now=Date.UTC(2026,10,17,14),research=new MarketResearch({now:()=>now/1000});
 const raw=`<rss><channel><title>CoinDesk</title><item><title>Bitcoin and Ethereum update</title><link>https://www.coindesk.com/markets/story</link><pubDate>${new Date(now-60000).toUTCString()}</pubDate><description>Do not republish this text</description></item></channel></rss>`;
 const newsSnapshot=projectPublicNews(parsePublicNews(raw,now),{selection_version:1,limit:50},now),before=JSON.stringify(newsSnapshot);
 const rows=workbenchInformation(research,null,{newsSnapshot,now}),news=rows.filter(row=>row.kind==='news');
 assert.equal(news.length,1);assert.deepEqual(news[0].symbols,['BTC','ETH']);assert.equal(news[0].at,now-60000);assert.equal(news[0].wallTime,true);assert.equal(news[0].source,'CoinDesk');assert.equal(news[0].url,'https://www.coindesk.com/markets/story');
 assert.ok(!JSON.stringify(news).includes('Do not republish'));assert.equal(news[0].fixed,undefined);assert.equal(JSON.stringify(newsSnapshot),before);
 assert.equal(workbenchFeedSelection(rows,'news','BTC').length,1);assert.equal(workbenchFeedSelection(rows,'news','ETH').length,1);assert.equal(workbenchFeedSelection(rows,'news','SOL').length,0);
 assert.equal(selectWorkbenchInformation(rows,rows,'news','ETH').length,1);
 assert.equal(workbenchInformation(research,null,{newsSnapshot,now:now+86400000}).filter(row=>row.kind==='news').length,0);
 assert.equal(workbenchInformation(research,null,{newsSnapshot:{...newsSnapshot,mode:'offline_fixture'},now}).filter(row=>row.kind==='news').length,0);
});
test('the information feed labels the actual BTC daily index separately and expires it by source time',()=>{
 const now=Date.UTC(2026,10,17,14),asOf=Date.UTC(2026,10,17),research=new MarketResearch({now:()=>now/1000});
 research.background.sentiment={state:'ready',version:1,snapshot:{schema:'research-background-v1',resource:'sentiment',provider:'Alternative.me',asOf,receivedAt:now,validUntil:asOf+129600000,data:{value:12}}};
 const row=workbenchInformation(research,null,{now}).find(row=>row.id.startsWith('sentiment:'));
 assert.ok(row);assert.equal(row.symbol,'BTC');assert.equal(row.at,asOf);assert.equal(row.source,'Alternative.me');assert.equal(row.kind,'news');assert.ok(row.text.includes('12/100'));
 assert.equal(workbenchFeedSelection([row],'news','ETH').length,0);assert.equal(workbenchInformation(research,null,{now:asOf+129600000}).filter(row=>row.id.startsWith('sentiment:')).length,0);
 const many=[...Array.from({length:30},(_,i)=>({id:'news:'+i,kind:'news',age:i})),row],visible=workbenchFeedSelection(many,'news');assert.equal(visible.length,24);assert.ok(visible.includes(row),'the daily index remains available alongside a busy news feed');assert.equal(visible.at(-1).at,asOf);
});
test('social activity preserves authors, multiple exact tags, zero interactions and source clocks without inventing sentiment',()=>{
 const now=Date.UTC(2026,10,17,15),published=now-60000,research=new MarketResearch({now:()=>now/1000});
 const raw={id:'1',uri:'https://mastodon.social/users/alice/statuses/1',url:'https://mastodon.social/@alice/1',created_at:new Date(published).toISOString(),edited_at:null,visibility:'public',sensitive:false,spoiler_text:'',content:'<p>Ethereum v4 and Bitcoin</p>',tags:[{name:'bitcoin'},{name:'ethereum'}],account:{acct:'alice',display_name:'Alice',url:'https://mastodon.social/@alice',bot:true},favourites_count:0,reblogs_count:2,replies_count:3,reblog:null};
 const socialSnapshot=projectPublicSocial(normalizePublicSocial([[raw],[],[]],now),{selection_version:0,limit:50},now),rows=workbenchInformation(research,null,{socialSnapshot,now}),row=rows.find(row=>row.kind==='social');
 assert.ok(row);assert.deepEqual(row.symbols,['BTC','ETH']);assert.equal(row.at,published);assert.equal(row.source,'Mastodon');assert.equal(row.url,raw.url);assert.ok(row.text.includes('@alice')&&row.text.includes('v4'));assert.ok(row.hint.includes('0'));assert.ok(row.detail.includes(new Date(now).toISOString()));
 assert.equal(workbenchFeedSelection(rows,'social','ETH').length,1);assert.equal(workbenchFeedSelection(rows,'social','SOL').length,0);assert.equal(workbenchFeedSelection(rows,'news').length,0);
 assert.equal(workbenchInformation(research,null,{socialSnapshot,now:now+300000}).filter(row=>row.kind==='social').length,0);
 assert.equal(workbenchInformation(research,null,{socialSnapshot:{...socialSnapshot,mode:'offline_fixture'},now}).filter(row=>row.kind==='social').length,0);
 const changed=structuredClone(socialSnapshot);changed.items[0].data.likes=2;assert.notEqual(workbenchInformation(research,null,{socialSnapshot:changed,now}).find(row=>row.kind==='social').valueKey,row.valueKey);
});
test('active strategy signal events are account/run scoped and use the trading clock',()=>{
 const research=new MultiResearch(),trade={...idle(),time:100,session:{id:'current',strategy:'unknown'}},signals=[{id:'a',runId:'current',market:'ETH/USDT',at:90},{id:'b',runId:'old',market:'BTC/USDT',at:95}];
 const before=JSON.stringify({trade,signals}),rows=workbenchInformation(research,trade,{signals});
 assert.ok(rows.some(r=>r.id==='signal:a'&&r.clock==='trade'&&r.age===10));
 assert.ok(!rows.some(r=>r.id==='signal:b'));
 assert.equal(JSON.stringify({trade,signals}),before);
});
import {workbenchAgentLog} from './workbench-console.mjs';
test('Agent logs retain action, actual owner and next step without borrowing later conclusions',()=>{
 const research=new MultiResearch();research.advance(26);const tasks=[research.task('ETH')],before=JSON.stringify(research);
 const rows=workbenchAgentLog(research,null,tasks);
 assert.ok(rows.every(row=>row.symbol==='ETH'));
 assert.ok(rows.some(row=>row.stage==='collect'&&row.roles.join(',')==='3,7,8'));
 assert.ok(rows.some(row=>row.stage==='check'));
 assert.ok(rows.every(row=>row.result&&row.next&&row.owner));
 assert.ok(rows.every((row,i)=>!i||rows[i-1].age<=row.age));
 const original=rows.find(row=>row.stage==='collect').result;
 research.task('ETH').title='SHOULD NOT REWRITE HISTORY';
 assert.equal(workbenchAgentLog(research,null,tasks).find(row=>row.stage==='collect').result,original);
 research.task('ETH').title=JSON.parse(before).tasks.find(t=>t.symbol==='ETH').title;
 assert.equal(JSON.stringify(research),before);
});

import {workbenchEvidenceUpdates} from './workbench-console.mjs';
test('neon arrival cues are driven by new evidence states, never by rereading unchanged data',()=>{
 const research=new MultiResearch(),tasks=[research.task('ETH')],previous=new Map();
 assert.deepEqual(workbenchEvidenceUpdates(previous,tasks,0),[]);
 research.advance(11);const first=workbenchEvidenceUpdates(previous,tasks,research.time);
 assert.ok(first.length>0);assert.ok(first.every(row=>row.symbol==='ETH'&&row.id.startsWith('evidence:')&&row.at===research.time));
 assert.deepEqual(workbenchEvidenceUpdates(previous,tasks,research.time+1),[]);
 const before=JSON.stringify(research);assert.deepEqual(workbenchEvidenceUpdates(previous,tasks,research.time+2),[]);assert.equal(JSON.stringify(research),before);
 assert.deepEqual(workbenchEvidenceUpdates(previous,[],research.time),[]);assert.equal(previous.size,0);
 assert.deepEqual(workbenchEvidenceUpdates(previous,tasks,research.time),[]);
});

import {createWorkbenchInformationDesk} from './workbench-console.mjs';
test('activity rows keep their DOM while ages change, preserve actual headlines and cancel suspended reads',async()=>{
 const names=['document','window','matchMedia','IntersectionObserver'],previous=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const callbacks=[];
 const node=()=>{
  let html='';const queries=new Map();
  const n={dataset:{},children:[],writes:0,scrollTop:0,textContent:'',setAttribute(){},addEventListener(){},contains(){return false;},closest(){return null;},matches(){return false;},hasChildNodes(){return !!html||!!this.children.length;},querySelector(selector){if(!queries.has(selector))queries.set(selector,node());return queries.get(selector);},querySelectorAll(){return [];},insertBefore(child,before){child.remove();const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,child);child.parent=this;},remove(){if(this.parent){const siblings=this.parent.children;siblings.splice(siblings.indexOf(this),1);this.parent=null;}}};
  Object.defineProperty(n,'innerHTML',{get(){return html;},set(value){html=value;n.writes++;}});return n;
 };
 const page=new EventTarget(),doc={hidden:false,activeElement:null,body:{dataset:{page:'workbench',workbenchView:'photonic'}},documentElement:{lang:'zh',dataset:{}},addEventListener(){},createElement:node};
 const mocks={document:doc,window:page,matchMedia:()=>({matches:true,addEventListener(){}}),IntersectionObserver:class{constructor(callback){callbacks.push(callback);}observe(){}disconnect(){}}};
 for(const [key,value]of Object.entries(mocks))Object.defineProperty(globalThis,key,{configurable:true,value});
 try{
  const task={symbol:'ETH',group:1,evidence:[]},research={time:20,scope:'all',tasks:[task],events:[{id:'one',symbol:'ETH',text:'开始采集',at:0}],task:()=>task,accepts:()=>true};
  const reads=[],fetchImpl=(url,options)=>new URL(url,'https://app.test').searchParams.get('resource')==='social'?Promise.resolve(new Response(JSON.stringify(projectPublicSocial(normalizePublicSocial([[],[],[]],Date.now()),{selection_version:0,limit:50},Date.now())))):new Promise(resolve=>reads.push({url,signal:options.signal,resolve}));
  const feed=node(),records=node(),desk=createWorkbenchInformationDesk({feed,records,research,workspace:{s:{signals:[]}},fetchImpl}),list=records.querySelector('.desk-record-list');
  desk.update(null,'records',{},[task]);assert.equal(list.children.length,0,'offscreen panel stays unpainted');
  callbacks[0]([{target:records,isIntersecting:true}]);assert.equal(list.children.length,1);
  const row=list.children[0],summary=row.querySelector('summary'),initial=summary.writes,age=row.querySelector('time').textContent;
  assert.match(records.querySelector('.desk-record-controls').innerHTML,/data-statements="AI_SPECTRUM"/);
  assert.doesNotMatch(row.querySelector('.desk-record-body').innerHTML,/开始采集/,'the expanded row adds a next step without repeating its result');
  assert.ok(row.querySelector('.desk-record-body').innerHTML.includes(pair('当前研究','Current research')));
  research.time=21;desk.update(null,'records',{},[task]);assert.equal(list.children[0],row);assert.equal(summary.writes,initial);assert.notEqual(row.querySelector('time').textContent,age);
  research.events[0].text='核验完成';desk.update(null,'records',{},[task]);assert.equal(list.children[0],row);assert.ok(summary.writes>initial,'actual event changes update content');
  doc.hidden=true;research.events.unshift({id:'two',symbol:'ETH',text:'递交报告',at:21});desk.update(null,'records',{},[task]);assert.equal(list.children.length,1);
  doc.hidden=false;callbacks[0]([{target:records,isIntersecting:true}]);assert.equal(list.children.length,2,'visible panel catches up with the latest events');
  const before=list.children.map(n=>n.querySelector('summary').writes);callbacks[0]([{target:records,isIntersecting:false}]);research.events[0].text='形成判断';desk.update(null,'records',{},[task]);assert.deepEqual(list.children.map(n=>n.querySelector('summary').writes),before);
  callbacks[0]([{target:records,isIntersecting:true},{target:feed,isIntersecting:true}]);
  const trade={...idle(),time:30,accountSummary:{accountId:'SIM-01',environment:'DEMO'},orders:[{id:'SIM-ORD-7',accountId:'SIM-01',environment:'DEMO',tradeOwner:'AI_SPECTRUM',runId:'original',market:'ETH/USDT'}],events:[{id:7,at:29,text:'SIM-ORD-7 filled',kind:'order'},{id:8,at:28,text:'ETH/USDT checked',kind:'risk'}]};
  desk.update(trade,'workspace',{},[task]);
  const original=list.children.find(node=>node.dataset.recordId==='trade:7').querySelector('.desk-record-body').innerHTML;
  assert.match(original,/data-statements="AI_SPECTRUM"/);assert.match(original,/data-statement-run="original"/);assert.match(original,/data-statement-order="SIM-ORD-7"/);assert.match(original,/data-statement-tab="orders"/);
  assert.doesNotMatch(list.children.find(node=>node.dataset.recordId==='trade:8').querySelector('.desk-record-body').innerHTML,/data-statements|data-desk-logs/,'an unidentified event has no duplicate generic log button');
  const activity=feed.querySelector('.terminal-feed-list'),receipt=activity.children.find(node=>node.dataset.deskId==='trade:7').querySelector('.desk-feed-detail').innerHTML;
  assert.match(receipt,/data-statement-order="SIM-ORD-7"/);assert.doesNotMatch(receipt,/page=execution/);
  assert.doesNotMatch(activity.children.find(node=>node.dataset.kind==='analysis').querySelector('.desk-feed-detail').innerHTML,/<p[ >]/,'an analysis without source detail has no generic or empty description');
  assert.match(activity.children.find(node=>node.dataset.deskId==='brief:social-01').querySelector('.desk-feed-detail').innerHTML,/class="desk-source-detail"/,'an actual source description remains available when expanded');
  const generic=activity.children.find(node=>node.dataset.deskId==='trade:8').querySelector('.desk-feed-detail').innerHTML;
  assert.match(generic,/data-statements="AI_SPECTRUM"/);assert.doesNotMatch(generic,/data-statement-run|data-statement-order|page=execution/);
  const now=Date.now(),raw=`<rss><channel><title>CoinDesk</title><item><title>Ethereum v4 launches</title><link>https://www.coindesk.com/tech/version</link><pubDate>${new Date(now-60000).toUTCString()}</pubDate></item></channel></rss>`,news=projectPublicNews(parsePublicNews(raw,now),{selection_version:0,limit:50},now),reply=()=>new Response(JSON.stringify(news));
  research.mode='live_readonly';desk.update(null,'feed',{},[task]);assert.equal(reads.length,1);assert.match(reads[0].url,/^\/api\/market-hub\?resource=news&/);
  reads[0].resolve(reply());await new Promise(resolve=>setImmediate(resolve));desk.update(null,'feed',{},[task]);
  const headline=activity.children.find(node=>node.dataset.deskId.startsWith('news:')).querySelector('.desk-feed-summary').innerHTML;assert.ok(headline.includes('Ethereum v4 launches'),'media headlines must not lose version numbers');
  desk.suspend();desk.update(null,'feed',{},[task]);assert.equal(reads.length,2);
  doc.body.dataset.page='markets';desk.suspend();assert.equal(reads[1].signal.aborted,true);reads[1].resolve(reply());await new Promise(resolve=>setImmediate(resolve));
  doc.body.dataset.page='workbench';desk.update(null,'feed',{},[task]);assert.equal(reads.length,3,'late responses cannot refill a suspended news slot');assert.ok(!activity.children.some(node=>node.dataset.deskId.startsWith('news:')));
  callbacks[0]([{target:feed,isIntersecting:false}]);assert.equal(reads[2].signal.aborted,true);reads[2].resolve(reply());await new Promise(resolve=>setImmediate(resolve));

  // An active LensWave research consumer has its own lifecycle even if neither panel intersects.
  const actual=new MarketResearch({now:()=>now/1000}),requests=[],desk2=createWorkbenchInformationDesk({feed:node(),records:node(),research:actual,workspace:{s:{signals:[]}},fetchImpl:(url,options)=>new Promise(resolve=>requests.push({url,signal:options.signal,resolve}))});
  desk2.update(null,'teams',{},[actual.task('ETH')]);assert.equal(requests.length,2);
  const newsRequest=requests.find(req=>req.url.includes('resource=news')),socialRequest=requests.find(req=>req.url.includes('resource=social'));
  assert.ok(newsRequest&&socialRequest);
  callbacks[1]([{target:feed,isIntersecting:false}]);assert.equal(newsRequest.signal.aborted,false);
  const verified=structuredClone(news);verified.sources[0].provider_id=verified.items[0].provider_id='blockbeats-news-v1';verified.items[0].data.url='https://m.theblockbeats.info/flash/123';
  newsRequest.resolve(new Response(JSON.stringify(verified)));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(actual.task('ETH').publicFacts[0].title,'Ethereum v4 launches');assert.deepEqual(actual.task('BTC').publicFacts,[]);
  desk2.update(null,'records',{},[actual.task('ETH')]);assert.equal(requests.length,2);
  doc.body.dataset.paused='true';desk2.update(null,'teams',{},[actual.task('ETH')]);assert.equal(socialRequest.signal.aborted,true);assert.deepEqual(actual.task('ETH').publicFacts,[]);
  socialRequest.resolve(reply());await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(actual.task('ETH').publicFacts,[]);

 }finally{page.dispatchEvent(new Event('pagehide'));for(const key of names){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});


test('signal review eligibility preserves research, expiry and executable boundaries',()=>{
 const ready={canAdopt:true,status:'ready',executable:true,freshness:'current',clockKind:'wall'};
 assert.equal(workbenchSignalState(ready),'ready');
 assert.equal(workbenchSignalState({...ready,clockKind:'simulation'}),'research');
 assert.equal(workbenchSignalState({...ready,strategy:'S01',variant:'S01-SIM'}),'research');
 assert.equal(workbenchSignalState({...ready,clockKind:undefined}),'research');
 assert.equal(workbenchSignalState({...ready,status:'research',canAdopt:false}),'research');
 assert.equal(workbenchSignalState({...ready,executable:false}),'research');
 assert.equal(workbenchSignalState({...ready,freshness:'unknown'}),'research');
 assert.equal(workbenchSignalState({...ready,freshness:'expired'}),'unavailable');
 assert.equal(workbenchSignalState({...ready,canAdopt:false}),'unavailable');
 assert.equal(workbenchSignalState({...ready,status:'unavailable'}),'unavailable');
});

test('read-only signal review uses strategy requirements, contextual sources and the actual daily close',()=>{
 const closedAt=Date.UTC(2026,10,18)/1000,now=closedAt+100,research=new MarketResearch({now:()=>now});
 const bar={state:'ready',feedState:'snapshot',paused:false,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',source:'Binance Spot',timezone:'UTC',unit:'USDT',price:100,x:1.5,y:51,change:2,bars:300,sampleAt:closedAt-86400,closedAt,validUntil:closedAt+86400,signal:'balanced'};
 research.ingestMarket(['BTC','ETH','SOL'].map(symbol=>({...bar,symbol})));
 const snapshot=normalizeResearchBackground({schema:'public-market-relay-v1',resource:'chains',receivedAt:now*1000,body:[{name:'Ethereum',tvl:1000}]},'chains',now*1000);
 research.ingest([{resource:'chains',state:'ready',snapshot}]);
 const render=()=>workbenchSignalList(workbenchSignalShortlist(strategyRecommendations({research,s:{signals:[]}})),research);
 const html=render(),card=asset=>html.split(`data-signal-asset="${asset}"`)[1].split('</article>')[0];
 assert.match(html,/data-signal-count="ready"><dt>[^<]+<\/dt><dd>0/);
 assert.match(html,/data-signal-count="unavailable"><dt>[^<]+<\/dt><dd>3/);
 assert.doesNotMatch(html,/data-signal-count="research"|data-ops-strategy=|data-research-job-action|<dd>market-research-/);
 assert.match(card('ETH').split('<details')[0],/缺少指定池|Finalized swap records/);
 assert.match(card('ETH'),/Uniswap V3 WETH\/USDC 0\.05%/);assert.match(card('ETH'),/20%/);assert.match(card('ETH'),/95%/);
 assert.match(card('ETH'),/DefiLlama · Ethereum TVL/);assert.doesNotMatch(card('ETH'),/DefiLlama · DefiLlama|\.000Z/);
 assert.match(card('ETH'),/2026-11-18 00:01:40 UTC/);assert.match(card('ETH'),/Binance Spot · EMA20 \+1.5 ATR14 · RSI14 51 · 2026-11-18 00:00 UTC/);
 assert.match(card('BTC'),/250/);assert.match(card('BTC'),/5 分钟 K 线|five-minute candles/);
 assert.match(card('SOL'),/逐小时|Hourly mentions/);assert.doesNotMatch(card('SOL'),/WETH\/USDC/);
 research.recheck('ETH');const updated=render().split('data-signal-asset="ETH"')[1].split('</article>')[0];
 assert.doesNotMatch(updated,/RSI14 51|缺少指定池内已最终确认|Finalized swap records from the specified pool are missing/);
});

test('only a current eligible signal exposes configuration and paper research has its own count',()=>{
 const research=new MultiResearch();research.advance(80);
 const rows=workbenchSignalShortlist(strategyRecommendations({research,s:{signals:[]}}, {time:80})),paper=rows.find(row=>row.asset==='ETH');
 assert.equal(workbenchSignalState(paper),'research');
 const eligible={id:'test-eligible',asset:'BTC',market:'BTC/USDT',strategy:'S03',variant:'baseline',sourceType:'signal',sourceRef:{type:'signal',recordId:'test-record'},clockKind:'wall',canAdopt:true,status:'ready',executable:true,freshness:'current',reason:['已核验的测试记录','Verified test record']};
 const html=workbenchSignalList([paper,eligible,rows.find(row=>row.asset==='SOL')],research);
 for(const state of ['ready','research','unavailable'])assert.match(html,new RegExp(`data-signal-count="${state}"><dt>[^<]+</dt><dd>1`));
 assert.match(html,/模拟生成的研究记录|Simulated research record/);
 assert.match(html,/data-ops-strategy="source" data-id="test-eligible"/);
 assert.deepEqual([...html.matchAll(/data-ops-strategy="recommendation" data-id="([^"]+)"/g)].map(match=>match[1]),['test-eligible']);
});

test('console risk edits use the existing validator, reject stale versions and wrong accounts',()=>{
 const w=new WorkspaceSim({research:new MultiResearch()}),sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}},trade={accountSummary:{accountId:'SIM-01',environment:'DEMO',equity:10000,available:10000,reserved:0,positions:0,orders:0}};
 const original=JSON.stringify(w.s.risk),version=w.s.risk.version;
 for(const context of [{trade,sync:{...sync,state:'STALE'},version},{trade,sync:{...sync,scope:{...sync.scope,accountId:'OTHER'}},version},{trade,sync,version:version-1}])assert.ok(saveWorkbenchLimits(w,{cap:800,dailyLoss:80},context));
 assert.equal(JSON.stringify(w.s.risk),original);
 assert.ok(saveWorkbenchLimits(w,{cap:0,dailyLoss:80},{trade,sync,version}));assert.equal(JSON.stringify(w.s.risk),original);
 assert.equal(saveWorkbenchLimits(w,{cap:800,dailyLoss:80},{trade,sync,version}),null);
 assert.equal(w.s.risk.cap,800);assert.equal(w.s.risk.dailyLoss,80);assert.equal(w.s.risk.version,version+1);
 assert.notEqual(w.s.drafts[0].riskVersion,w.s.risk.version);
 assert.equal(w.s.trade,null);assert.equal(w.s.signals.length,0);
});

test('a failed limit save rolls back active limits and metadata so the same draft can be retried',()=>{
 let fail=true,writes=0;const saved=new Map(),storage={getItem:key=>saved.get(key)||null,setItem(key,value){writes++;if(fail)throw Error('storage unavailable');saved.set(key,value);}};
 const workspace=new WorkspaceSim({storage}),sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}},trade={accountSummary:{...sync.scope,equity:10000,available:10000,reserved:0,positions:0,orders:0}};
 const snapshot=()=>JSON.stringify({risk:workspace.s.risk,notices:workspace.s.notices,seq:workspace.s.seq,revision:workspace.revision}),before=snapshot(),version=workspace.s.risk.version;
 const values={cap:'800',dailyLoss:'80'},context={trade,sync,version};
 assert.ok(saveWorkbenchLimits(workspace,values,context));assert.equal(snapshot(),before);assert.equal(writes,1,'failure rollback does not attempt another write');
 fail=false;assert.equal(saveWorkbenchLimits(workspace,values,context),null,'the original draft version can be retried');
 assert.equal(writes,2);assert.equal(workspace.s.risk.version,version+1);assert.equal(workspace.s.risk.cap,800);assert.equal(workspace.s.notices.length,1);assert.equal(workspace.revision,1);
 const committed=JSON.parse([...saved.values()][0]);assert.deepEqual(committed.risk,workspace.s.risk);
 const touch=workspace.touch;workspace.touch=()=>{throw Error('write adapter failed');};const committedState=snapshot();
 assert.ok(saveWorkbenchLimits(workspace,{cap:700,dailyLoss:70},{...context,version:workspace.s.risk.version}));assert.equal(snapshot(),committedState);assert.equal(writes,2);
 workspace.touch=touch;
});

test('limit drafts reveal save and undo in place, survive updates and preserve their original version',()=>{
 const previousDocument=globalThis.document,previousFormData=globalThis.FormData,nodes=new Map(),events={};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},setAttribute(){},addEventListener(type,fn){events[key+':'+type]=fn;}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const research=new MultiResearch(),workspace=new WorkspaceSim({research}),sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}};
 const trade={...idle(),state:'paused',session:{id:'EXISTING',mode:'auto',strategy:'S03',market:'ETH/USDT'},accountSummary:{...sync.scope,equity:10000,available:10000,reserved:0,positions:0,orders:0}};
 const before=JSON.stringify(trade),original={...workspace.s.risk},actions={hidden:true},state={},runtime={hidden:true};
 const form={dataset:{version:String(original.version)},values:{cap:'1000',dailyLoss:'100'},querySelector:selector=>selector==='.ops-capital-actions'?actions:selector==='[data-ops-limits-state]'?state:selector==='[data-ops-limits-runtime]'?runtime:null};
 const event={target:{closest:()=>form},preventDefault(){}};
 try{
  globalThis.document={activeElement:null,querySelector:node,addEventListener(){}};
  globalThis.FormData=class{constructor(target){this.values=target.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:()=>trade,syncStatus:()=>sync}});view.update();
  assert.match(node('#ops-plan').innerHTML,/class="ops-capital-actions" hidden/);
  form.values.cap='800';events['host:input'](event);
  assert.equal(actions.hidden,false);assert.equal(runtime.hidden,false);assert.match(state.textContent,/未保存|Unsaved/);
  assert.deepEqual(workspace.s.risk,original,'editing does not save or authorize');
  view.update();assert.match(node('#ops-plan').innerHTML,/name="cap"[^>]*value="800"/);assert.doesNotMatch(node('#ops-plan').innerHTML,/class="ops-capital-actions" hidden/);
  form.values.cap='1e3';events['host:input'](event);assert.equal(actions.hidden,true);assert.equal(runtime.hidden,true,'equivalent numeric values do not create a change');
  form.values.cap='800';events['host:input'](event);
  workspace.setRisk({cap:900,dailyLoss:90});view.update();
  assert.match(node('#ops-plan').innerHTML,new RegExp('data-version="'+original.version+'"'));
  events['host:submit'](event);assert.equal(workspace.s.risk.cap,900);assert.match(node('#ops-plan').innerHTML,/资金边界已更新|Limits changed/);
  events['host:click']({target:{closest:()=>({dataset:{},hasAttribute:name=>name==='data-ops-risk-reset'})}});
  assert.match(node('#ops-plan').innerHTML,/name="cap"[^>]*value="900"/);assert.match(node('#ops-plan').innerHTML,/class="ops-capital-actions" hidden/);
  form.dataset.version=String(workspace.s.risk.version);form.values={cap:'850',dailyLoss:'85'};events['host:input'](event);
  const touch=workspace.touch,version=workspace.s.risk.version;workspace.touch=()=>{throw Error('write failed');};events['host:submit'](event);
  assert.equal(workspace.s.risk.cap,900);assert.equal(workspace.s.risk.version,version);assert.match(node('#ops-plan').innerHTML,/name="cap"[^>]*value="850"/);assert.match(node('#ops-plan').innerHTML,/role="alert"/);
  workspace.touch=touch;events['host:submit'](event);assert.equal(workspace.s.risk.version,version+1);
  assert.equal(workspace.s.risk.cap,850);assert.equal(workspace.s.risk.dailyLoss,85);assert.match(node('#ops-plan').innerHTML,/现有运行新增买入需重新核验|Recheck existing runs before new buys/);
  assert.equal(JSON.stringify(trade),before,'saving an account limit never starts or resumes a run');
  sync.state='STALE';view.update();assert.match(node('#ops-plan').innerHTML,/name="cap"[^>]*disabled/);
 }finally{globalThis.document=previousDocument;globalThis.FormData=previousFormData;}
});

test('Kelly estimates use explicit net odds and probability, and stay within the fixed risk ceiling',()=>{
 const values={capital:10000,winRate:34,netOdds:2,fraction:.25};
 const result=workbenchKellyEstimate(values);
 assert.equal(result.valid,true);assert.ok(Math.abs(result.fullKelly-.01)<1e-12);assert.equal(result.riskFraction,.0025);assert.equal(result.riskAmount,25);
 const negative=workbenchKellyEstimate({...values,netOdds:1.6});assert.ok(Math.abs(negative.fullKelly+.0725)<1e-12);assert.equal(negative.riskAmount,0);assert.equal(negative.positive,false);
 const capped=workbenchKellyEstimate({...values,winRate:90});assert.equal(capped.riskFraction,.0025);assert.equal(capped.capped,true);
 assert.equal(workbenchKellyEstimate(values,.001).riskAmount,10);
 for(const patch of [{winRate:''},{winRate:undefined,score:400},{capital:0},{capital:1e20},{winRate:101},{netOdds:0},{netOdds:Infinity},{fraction:.75}])assert.equal(workbenchKellyEstimate({...values,...patch}).valid,false);
 assert.equal(workbenchKellyEstimate(values,.01).valid,false);
 assert.equal(workbenchKellyEstimate({...values,winRate:0}).riskAmount,0);
});

function riskPreferenceStorage(){
 const records=new Map();
 return {getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};
}

test('saved Kelly inputs remain account-scoped advice, with stale and failed writes rejected',()=>{
 const w=new WorkspaceSim({storage:riskPreferenceStorage()}),sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}},trade={accountSummary:{accountId:'SIM-01',environment:'DEMO',equity:10000,available:10000,reserved:0,positions:0,orders:0}};
 const kelly={capital:'10000',winRate:'34',netOdds:'2',fraction:'.25',ignored:'not stored'},context={trade,sync,scope:{...sync.scope},revision:0,riskVersion:w.s.risk.version};
 const before=JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts});
 assert.equal(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly},context),null);
 assert.deepEqual(workbenchRiskPreference(w,sync.scope).kelly,{capital:10000,winRate:34,netOdds:2,fraction:.25});
 assert.equal(workbenchRiskPreference(w,{accountId:'OTHER',environment:'DEMO'}),null);
 assert.equal(JSON.stringify({risk:w.s.risk,trade:w.s.trade,drafts:w.s.drafts}),before,'advice does not authorize or modify trading');
 const saved=JSON.stringify(w.s.workbenchRisk);
 assert.ok(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly},context));
 assert.ok(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly},{...context,revision:1,sync:{...sync,state:'STALE'}}));
 assert.ok(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly},{...context,revision:1,riskVersion:0}));
 assert.ok(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly},{...context,revision:1,scope:{accountId:'SIM-02',environment:'DEMO'}}));
 assert.equal(JSON.stringify(w.s.workbenchRisk),saved);
 w.touch=()=>{throw new Error('storage unavailable');};
 assert.ok(saveWorkbenchRiskPreference(w,{kind:'kelly',kelly:{...kelly,winRate:50}},{...context,revision:1}));
 assert.equal(JSON.stringify(w.s.workbenchRisk),saved);
});

test('a default protection save requires storage and restores the prior revision after a failed write',()=>{
 const sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}},trade={accountSummary:{...sync.scope,equity:10000,available:10000,reserved:0,positions:0,orders:0}};
 const context={trade,sync,scope:sync.scope,revision:0,riskVersion:1},values={kind:'protection',protection:{id:'original',version:'strategy-original'}};
 const unavailable=new WorkspaceSim();
 assert.ok(saveWorkbenchRiskPreference(unavailable,values,context));assert.equal(unavailable.s.workbenchRisk,undefined);
 const storage=riskPreferenceStorage(),workspace=new WorkspaceSim({storage});
 assert.equal(saveWorkbenchRiskPreference(workspace,values,context),null);
 const saved=workspace.s.workbenchRisk,revision=workspace.revision;
 storage.setItem=()=>{};
 assert.ok(saveWorkbenchRiskPreference(workspace,values,{...context,revision:saved.revision}));
 assert.equal(workspace.s.workbenchRisk,saved);assert.equal(workspace.revision,revision);
 assert.deepEqual(new WorkspaceSim({storage}).s.workbenchRisk,saved);
});

test('risk editing keeps drafts across policy tabs and saves only future-plan defaults or Kelly inputs',async()=>{
 const previousDocument=globalThis.document,previousFormData=globalThis.FormData,nodes=new Map(),openers={},listeners=new Map();
 let dialog,focused='';
 const focusable=key=>({dataset:{opsRiskOpen:key},isConnected:true,closest:()=>null,focus(){focused=key;globalThis.document.activeElement=this;}});
 const node=key=>{
  if(nodes.has(key))return nodes.get(key);
  let html='';const item={dataset:{},events:{},setAttribute(){},contains:()=>false,querySelectorAll:()=>[],addEventListener(type,fn){this.events[type]=fn;}};
  Object.defineProperty(item,'innerHTML',{get:()=>html,set:value=>{
   html=value;
   if(key==='#ops-plan')for(const kind of ['protection','kelly']){if(openers[kind])openers[kind].isConnected=false;openers[kind]=focusable(kind);}
   if(key==='dialog'){
    const values={};for(const match of html.matchAll(/<input\b[^>]*>/g)){const tag=match[0];if(/\bdisabled\b/.test(tag))continue;const name=tag.match(/\bname="([^"]+)"/)?.[1];if(name)values[name]=tag.match(/\bvalue="([^"]*)"/)?.[1]||'';}
    for(const match of html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){const option=[...match[2].matchAll(/<option\b[^>]*>/g)].find(row=>/\bselected\b/.test(row[0]));if(option)values[match[1]]=option[0].match(/value="([^"]+)"/)[1];}
    item.form={values};item.scrollBody={scrollTop:0};
   }
  }});
  item.querySelector=selector=>key==='dialog'?(selector==='form'?item.form:selector==='.ops-risk-body'?item.scrollBody:selector==='[role=alert]'?html.includes('role="alert"')?{focus(){focused='error';},scrollIntoView(){}}:null:selector==='.ops-kelly-output'?node('kelly-output'):selector.startsWith('#ops-risk-tab-')?{focus(){focused=selector;}}:null):selector.startsWith('[data-ops-risk-open=')?openers[selector.match(/="([^"]+)"/)[1]]:node(selector);
  nodes.set(key,item);return item;
 };
 const host=node('host'),research=new MultiResearch(),storage=riskPreferenceStorage(),workspace=new WorkspaceSim({research,storage}),sync={state:'LIVE',scope:{accountId:'SIM-01',environment:'DEMO'}};
 const trade={...idle(),accountSummary:{...sync.scope,equity:10000,available:10000,reserved:0,positions:0,orders:0}},before=JSON.stringify({trade,risk:workspace.s.risk,drafts:workspace.s.drafts});
 const click=(target,events)=>events.click({target:{closest:()=>target}});
 const change=dataset=>click({dataset,hasAttribute:()=>false},dialog.events);
 const open=kind=>{globalThis.document.activeElement=globalThis.document.body;click(openers[kind],host.events);};
 const submit=()=>dialog.events.submit({preventDefault(){}});
 const cancel=()=>click({dataset:{},hasAttribute:key=>key==='data-risk-close'},dialog.events);
 const plan=()=>node('#ops-plan').innerHTML;
 const assertUnset=()=>{
  const card=plan().split('<div class="ops-protection-card">')[1];
  assert.match(card,/未设置默认风控|No default protection set/);
  assert.match(card,/data-ops-risk-open="protection"[^>]*aria-haspopup="dialog"[\s\S]*?<small class="ops-access-edit">(?:设置|Set up)<svg/);
  assert.doesNotMatch(card,/ops-protection-grid|Astarter 分层风控|Astarter layered protection|策略自带风控|Original strategy rules|\d+(?:\.\d+)?%/);
 };
 const renderWorkspace=source=>createWorkbenchConsole({host,research,workspace:source,desk:{readSnapshot:()=>trade,syncStatus:()=>sync}});
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'workbench'},append:item=>{dialog=item;}},querySelector:node,addEventListener:(type,fn)=>listeners.set(type,fn),createElement:()=>{
   const item=node('dialog');item.showModal=()=>{item.open=true;};item.close=()=>{item.open=false;queueMicrotask(()=>item.events.close());};return item;
  }};
  globalThis.FormData=class{constructor(form){this.values=form.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}};
  const view=renderWorkspace(workspace);view.update();assertUnset();
  for(const protection of [undefined,{id:'original',version:'broken'},protectionConfig('astarter','normal',{hard:1})]){
   workspace.s.workbenchRisk={...sync.scope,revision:1,protection,kelly:{capital:10000,winRate:34,netOdds:2,fraction:.25}};view.update();assertUnset();
  }
  workspace.s.workbenchRisk.protection=protectionConfig('astarter','normal');view.update();
  assert.match(plan(),/0\.25%/,'a saved legacy policy still resolves its fixed rule version');
  delete workspace.s.workbenchRisk;view.update();open('protection');
  assert.equal(dialog.open,true);assert.equal((dialog.innerHTML.match(/<fieldset/g)||[]).length,3);
  assert.match(dialog.innerHTML,/草稿预览，保存后用于新方案|Draft preview\. Save to apply to new plans/);
  assert.match(dialog.innerHTML,/策略模板默认设置|Strategy template defaults/);assert.match(dialog.innerHTML,/现有运行保持原设置|Existing runs keep their settings/);assert.doesNotMatch(dialog.innerHTML,/H5|起步档位/);
  assert.match(dialog.innerHTML,/name="policy_episode"[^>]*max="0.25"/);assert.match(dialog.innerHTML,/name="policy_hard"[^>]*max="8"/);
  dialog.form.values.policy_episode='.1';dialog.events.input();view.update();assertUnset();cancel();await Promise.resolve();
  assert.equal(focused,'protection','touch dismissal returns to the button that opened the dialog');
  open('kelly');dialog.form.values.capital='1234';listeners.get('hive:page-leave')({detail:'workbench'});
  assert.equal(dialog.open,false);assert.equal(workspace.s.workbenchRisk,undefined);await Promise.resolve();
  assertUnset();assert.equal(new WorkspaceSim({storage}).s.workbenchRisk,undefined);open('protection');assert.equal(dialog.form.values.policy_episode,'0.25');
  dialog.form.values.policy_soft='2';dialog.form.values.policy_hard='1';submit();
  assert.equal(dialog.open,true);assert.equal(focused,'error');assert.match(dialog.innerHTML,/降风险阈值必须小于暂停阈值|risk-reduction threshold must be below/);assert.equal(workspace.s.workbenchRisk,undefined);
  Object.assign(dialog.form.values,{policy_soft:'3',policy_hard:'8',policy_episode:'.15'});dialog.scrollBody.scrollTop=139;change({riskMode:'conservative'});
  assert.equal(dialog.scrollBody.scrollTop,139,'changing mode keeps the visible part of the form');
  assert.match(dialog.innerHTML,/50%/);assert.equal(dialog.form.values.policy_episode,'.15');
  change({riskPolicy:'original'});assert.doesNotMatch(dialog.innerHTML,/<fieldset/);change({riskPolicy:'astarter'});assert.equal(dialog.form.values.policy_episode,'.15');
  change({riskTab:'kelly'});assert.equal(dialog.scrollBody.scrollTop,0,'a newly selected panel starts at the top');
  Object.assign(dialog.form.values,{capital:'10000',winRate:'34',netOdds:'2',fraction:'.25'});dialog.events.input();
  assert.match(node('kelly-output').innerHTML,/25\.00/);change({riskTab:'protection'});assert.equal(dialog.form.values.policy_episode,'.15');
  submit();await Promise.resolve();
  assert.equal(dialog.open,false);assert.equal(workspace.s.workbenchRisk.protection.mode,'conservative');assert.equal(workspace.s.workbenchRisk.protection.parameters.episode,.0015);
  assert.match(plan(),/Astarter (分层风控 · 保守|layered protection · Conservative)/);assert.match(plan(),/0\.15%/);assert.doesNotMatch(plan(),/未设置默认风控|No default protection set/);
  assert.match(node('#ops-plan').innerHTML,/模板默认风控已保存|Template risk defaults saved/);assert.equal(focused,'protection','closing after a panel refresh restores the recreated opener');
  const saved=JSON.stringify(workspace.s.workbenchRisk);open('protection');dialog.form.values.policy_episode='.1';
  cancel();await Promise.resolve();assert.equal(JSON.stringify(workspace.s.workbenchRisk),saved);assert.match(plan(),/0\.15%/);assert.doesNotMatch(plan(),/0\.1%/);
  open('kelly');assert.equal(dialog.form.values.capital,'','unsaved Kelly inputs are discarded on close');Object.assign(dialog.form.values,{capital:'10000',winRate:'34',netOdds:'2',fraction:'.25'});dialog.events.input();
  assert.match(node('kelly-output').innerHTML,/15\.00/,'the estimate uses the saved risk ceiling, not an abandoned draft');submit();await Promise.resolve();
  assert.deepEqual(workspace.s.workbenchRisk.kelly,{capital:10000,winRate:34,netOdds:2,fraction:.25});
  assert.equal(JSON.stringify({trade,risk:workspace.s.risk,drafts:workspace.s.drafts}),before,'neither save authorizes trading or changes existing limits, plans or runs');
  const refreshed=new WorkspaceSim({research,storage}),freshView=renderWorkspace(refreshed);freshView.update();
  assert.equal(refreshed.s.workbenchRisk.protection.parameters.episode,.0015);assert.match(plan(),/0\.15%/);
  open('protection');assert.equal(dialog.form.values.policy_episode,'0.15');
  sync.scope={accountId:'SIM-01',environment:'LIVE'};freshView.update();assert.equal(dialog.open,false);await Promise.resolve();assertUnset();
  sync.scope={accountId:'OTHER',environment:'DEMO'};freshView.update();assertUnset();assert.doesNotMatch(plan(),/测算参数已保存|Estimate inputs saved/);
  open('protection');assert.match(dialog.innerHTML,/type="submit" disabled/);
  const unchanged=JSON.stringify(refreshed.s.workbenchRisk);submit();assert.equal(JSON.stringify(refreshed.s.workbenchRisk),unchanged);assert.equal(dialog.open,true);
  sync.scope={accountId:'SIM-01',environment:'DEMO'};freshView.update();await Promise.resolve();assert.match(plan(),/0\.15%/);
  open('protection');change({riskPolicy:'original'});submit();await Promise.resolve();
  assert.match(plan(),/策略自带风控|Original strategy rules/);assert.doesNotMatch(plan(),/ops-protection-grid|未设置默认风控|No default protection set/);
  assert.deepEqual(new WorkspaceSim({storage}).s.workbenchRisk.protection,{id:'original',version:'strategy-original'});
 }finally{globalThis.document=previousDocument;globalThis.FormData=previousFormData;}
});

test('notification rows retain their account and original run, while routine research stays out',()=>{
 const w={s:{clock:100,notices:[{id:'R1',kind:'research',text:'research finished',at:99},{id:'R2',kind:'risk',text:'Limits changed',at:98}]}};
 const trade={state:'idle',session:null,time:100,events:[{id:'E1',kind:'fill',runId:'mine',accountId:'SIM-01',text:'Filled',at:95},{id:'E2',kind:'fill',runId:'other',accountId:'OTHER',text:'other fill',at:96}],botBook:{time:100,runs:[{id:'mine',status:'blocked',quantity:0,orders:[{id:'original',runId:'mine',accountId:'SIM-01',status:'unknown'}],events:[{kind:'created',at:80}],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}},{id:'other',status:'blocked',quantity:0,orders:[],events:[],plan:{market:'BTC/USDT',strategy:'S01',executionRoute:{accountId:'OTHER'}}}]}};
 const before=JSON.stringify({w,trade}),rows=workbenchConsoleNotifications(trade,w);
 assert.equal(rows[0].id,'attention:mine');assert.equal(rows[0].runId,'mine');assert.equal(rows[0].symbol,'ETH');
 assert.ok(rows.some(row=>row.id==='receipt:E1'&&row.runId==='mine'));
 assert.ok(rows.some(row=>row.id==='notice:R2'));assert.ok(!rows.some(row=>row.id==='notice:R1'||row.runId==='other'));
 assert.equal(JSON.stringify({w,trade}),before);assert.deepEqual(workbenchConsoleNotifications(null,w),[]);
});

test('notification reading keeps unseen messages unread and does not resolve pending work',()=>{
 let writes=0;
 const workspace={s:{risk:{cap:1000},trade:{pending:{status:'unknown'}}},account:{scope:'user-one'},touch(){writes++;}},scope={accountId:'SIM-01',environment:'DEMO'};
 const rows=[{id:'attention:run-one',revision:'unknown',kind:'attention'},{id:'receipt:one',kind:'receipt'},{id:'notice:legacy',kind:'receipt',read:true}];
 const original=JSON.stringify({risk:workspace.s.risk,trade:workspace.s.trade});
 assert.deepEqual(workbenchUnreadNotifications(rows,workspace,scope).map(row=>row.id),['attention:run-one','receipt:one']);
 assert.equal(markWorkbenchNotificationsRead([rows[0]],workspace,scope),true);
 assert.deepEqual(workbenchUnreadNotifications(rows,workspace,scope).map(row=>row.id),['receipt:one']);
 assert.equal(rows.filter(row=>row.kind==='attention').length,1,'reading is independent of resolving an order');
 assert.equal(markWorkbenchNotificationsRead([rows[0]],workspace,scope),false);
 assert.equal(writes,1,'clock refreshes and repeated visibility do not persist again');
 assert.equal(JSON.stringify({risk:workspace.s.risk,trade:workspace.s.trade}),original);
 const later=[...rows,{id:'receipt:later',kind:'receipt'}];
 assert.deepEqual(workbenchUnreadNotifications(later,workspace,scope).map(row=>row.id),['receipt:one','receipt:later']);
 assert.equal(markWorkbenchNotificationsRead([rows[1]],workspace,scope),true);
 assert.deepEqual(workbenchUnreadNotifications(later,workspace,scope).map(row=>row.id),['receipt:later']);
});

test('notification read identities survive translation and refresh but remain scoped to user, account and environment',()=>{
 const storage=new Map(),workspace=new WorkspaceSim({storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}}),scope={accountId:'SIM-01',environment:'DEMO'};
 const row={id:'attention:run-one',revision:'unknown',kind:'attention',text:'Order outcome unconfirmed',age:2};
 assert.equal(markWorkbenchNotificationsRead([row],workspace,scope),true);
 const restored=new WorkspaceSim({storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
 assert.deepEqual(workbenchUnreadNotifications([{...row,text:'订单结果待确认',age:30}],restored,scope),[]);
 assert.equal(workbenchUnreadNotifications([{...row,revision:'blocked'}],restored,scope).length,1);
 assert.equal(workbenchUnreadNotifications([row],restored,{...scope,accountId:'SIM-02'}).length,1);
 assert.equal(workbenchUnreadNotifications([row],restored,{...scope,environment:'LIVE'}).length,1);
 restored.account={scope:'different-user'};
 assert.equal(workbenchUnreadNotifications([row],restored,scope).length,1);
 assert.equal(markWorkbenchNotificationsRead([row],restored,{}),false);
});

test('failed notification read persistence preserves the previous unread state',()=>{
 const workspace={s:{workbenchNotificationReads:{old:['kept']}},touch(){this.persistenceError='Storage unavailable';}},scope={accountId:'SIM-01',environment:'DEMO'},rows=[{id:'receipt:one'}];
 const before=workspace.s.workbenchNotificationReads;
 assert.equal(markWorkbenchNotificationsRead(rows,workspace,scope),false);
 assert.equal(workspace.s.workbenchNotificationReads,before);
 assert.equal(workbenchUnreadNotifications(rows,workspace,scope).length,1);
});

test('a new source event remains unread when a bounded history reuses its previous index',()=>{
 const workspace={s:{notices:[]},touch(){}},scope={accountId:'SIM-01',environment:'DEMO'};
 const run={id:'one',status:'stopped',quantity:0,events:[{kind:'created',at:10}],plan:{market:'ETH/USDT',strategy:'S02',executionRoute:{accountId:'SIM-01'}}},trade={...idle(),botBook:{time:20,runs:[run]}};
 const first=workbenchConsoleNotifications(trade,workspace);
 assert.equal(markWorkbenchNotificationsRead(first,workspace,scope),true);
 trade.botBook.time=30;
 assert.deepEqual(workbenchUnreadNotifications(workbenchConsoleNotifications(trade,workspace),workspace,scope),[]);
 run.events=[{kind:'paused',at:25}];
 const next=workbenchConsoleNotifications(trade,workspace);
 assert.equal(next[0].id,first[0].id);assert.equal(workbenchUnreadNotifications(next,workspace,scope).length,1);
});

test('the notification observer reads only visible message heads in the active desktop or mobile console',()=>{
 const previous={document:globalThis.document,observer:globalThis.IntersectionObserver,media:globalThis.matchMedia},nodes=new Map(),events={},scope={accountId:'SIM-01',environment:'DEMO'};
 let observer,writes=0,phone=false;
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},attrs:{},children:[],isConnected:true,setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name]??null;},addEventListener(type,cb){events[key+':'+type]=cb;},parentElement:{scrollTop:0},querySelectorAll(){return [];}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;
 const notices=node('#ops-notices');
 notices.querySelectorAll=selector=>selector==='[data-ops-notice-read]'?[...notices.innerHTML.matchAll(/data-ops-notice-read="([^"]+)"/g)].map((match,index)=>{const row=node('message:'+index+':'+match[1]);row.dataset.opsNoticeRead=match[1];return row;}):[];
 const research=new MultiResearch(),workspace=new WorkspaceSim({research});workspace.touch=()=>{writes++;};
 workspace.s.clock=100;workspace.s.notices=[1,2,3].map(i=>({id:'R'+i,kind:'risk',text:'Notice '+i,at:100-i,read:false}));
 const tab=node('#ops-view-notifications');tab.setAttribute('aria-selected','false');
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'workbench',mobileView:'console'}},visibilityState:'visible',querySelector:node,addEventListener(type,callback){events['document:'+type]=callback;}};
  globalThis.matchMedia=()=>({matches:phone});
  globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;this.nodes=[];observer=this;}observe(target){this.nodes.push(target);}disconnect(){this.nodes=[];}takeRecords(){return [];}};
  const view=createWorkbenchConsole({host,research,workspace,desk:{readSnapshot:idle,syncStatus:()=>({scope}),settings(){}}});
  view.update();assert.equal(tab.dataset.unreadCount,'3');assert.equal(observer.nodes.length,0,'hidden notification panes are not observed');
  tab.setAttribute('aria-selected','true');
  events['host:click']({target:{closest:()=>({dataset:{opsNoticeView:'history'}})}});
  assert.match(notices.innerHTML,/summary data-ops-notice-read="notice:R1"/);
  const target=id=>observer.nodes.find(row=>row.dataset.opsNoticeRead===id);
  const first=target('notice:R1'),second=target('notice:R2'),third=target('notice:R3');
  observer.callback([{target:first,isIntersecting:true,intersectionRatio:.7},{target:second,isIntersecting:false,intersectionRatio:0},{target:third,isIntersecting:true,intersectionRatio:.59}]);
  assert.equal(tab.dataset.unreadCount,'2');assert.equal(writes,1,'only the visible message was marked read');
  observer.callback([{target:first,isIntersecting:true,intersectionRatio:1}]);assert.equal(writes,1);
  tab.setAttribute('aria-selected','false');view.update();assert.equal(observer.nodes.length,0);
  observer.callback([{target:second,isIntersecting:true,intersectionRatio:1}]);assert.equal(tab.dataset.unreadCount,'2');
  phone=true;document.body.dataset.mobileView='network';tab.setAttribute('aria-selected','true');view.update();
  observer.callback([{target:second,isIntersecting:true,intersectionRatio:1}]);assert.equal(writes,1,'the hidden phone console cannot read a stale intersection');
  document.body.dataset.mobileView='console';view.update();observer.callback([{target:target('notice:R2'),isIntersecting:true,intersectionRatio:1}]);assert.equal(tab.dataset.unreadCount,'1');
  workspace.s.notices.unshift({id:'LATER',kind:'risk',text:'New notice',at:100,read:false});view.update();
  assert.equal(tab.dataset.unreadCount,'2','later messages start unread');
  const later=target('notice:LATER');observer.callback([{target:later,isIntersecting:false,intersectionRatio:0}]);assert.equal(tab.dataset.unreadCount,'2');
  document.visibilityState='hidden';events['document:visibilitychange']();assert.equal(observer.nodes.length,0);
  observer.callback([{target:later,isIntersecting:true,intersectionRatio:1}]);assert.equal(writes,2,'background pages do not mark messages read');
  document.visibilityState='visible';events['document:visibilitychange']();observer.callback([{target:target('notice:LATER'),isIntersecting:true,intersectionRatio:1}]);assert.equal(tab.dataset.unreadCount,'1');assert.equal(writes,3);
  const oldTarget=target('notice:R3');workspace.account={scope:'different-user'};
  observer.callback([{target:oldTarget,isIntersecting:true,intersectionRatio:1}]);assert.equal(writes,3,'a queued old-user intersection cannot mark the new user read');
  document.body.dataset.page='signals';events['document:hive:navigate']();assert.equal(observer.nodes.length,0);
 }finally{globalThis.document=previous.document;globalThis.IntersectionObserver=previous.observer;globalThis.matchMedia=previous.media;}
});

test('private notification badge uses the verified global reminder count and retains muted historical inbox rows',()=>{
 const previous={document:globalThis.document,observer:globalThis.IntersectionObserver,media:globalThis.matchMedia},nodes=new Map();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},attrs:{},children:[],isConnected:true,setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name]??null;},addEventListener(){},parentElement:{scrollTop:0},querySelectorAll(){return [];}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 let state={schema:'private-notifications-v2',inapp:true,events:['risk'],unreadCount:19,reminderUnreadCount:7,inbox:[{type:'research',readAt:null}],nextCursor:'older_page'};
 const privateUI={snapshot:()=>({identityStatus:'ready',ownerRef:'offline-owner',notifications:{state}}),renderInbox:()=>'<article>Historical report remains available</article>',loadNotifications:()=>assert.fail('hidden pane must not fetch')};
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'signals'}},visibilityState:'visible',querySelector:node,addEventListener(){}};globalThis.matchMedia=()=>({matches:false});globalThis.IntersectionObserver=undefined;
  const view=createWorkbenchConsole({host,research,workspace,privateUI,desk:{readSnapshot:idle,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});view.update();
  const tab=node('#ops-view-notifications');assert.equal(tab.dataset.unreadCount,'7','do not aggregate the visible research-only page or use nineteen historical unread');assert.match(tab.attrs['aria-label'],/7/);assert.match(node('#ops-notices').innerHTML,/Historical report/);
  state={...state,inapp:false,reminderUnreadCount:0};view.update();assert.equal(tab.dataset.unreadCount,'');assert.doesNotMatch(tab.attrs['aria-label'],/19|7/);assert.match(node('#ops-notices').innerHTML,/Historical report/);
  const {reminderUnreadCount,...legacy}=state;state={...legacy,schema:'private-notifications-v1'};view.update();assert.equal(tab.dataset.unreadCount,'','immutable v1 receipts carry no verified reminder count');
 }finally{globalThis.document=previous.document;globalThis.IntersectionObserver=previous.observer;globalThis.matchMedia=previous.media;}
});
test('returning to the mobile notification console after stopReading reloads its private inbox',async()=>{
 const previous={document:globalThis.document,observer:globalThis.IntersectionObserver,media:globalThis.matchMedia},nodes=new Map();let loads=0;
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},attrs:{},children:[],isConnected:true,setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name]??null;},addEventListener(){},parentElement:{scrollTop:0},querySelectorAll(){return [];}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;node('#ops-view-notifications').setAttribute('aria-selected','true');const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 const privateUI={snapshot:()=>({identityStatus:'ready',ownerRef:'offline-owner',notifications:{state:{schema:'private-notifications-v2',reminderUnreadCount:0}}}),renderInbox:()=>'<div>Account inbox</div>',loadNotifications(){loads++;}};
 try{globalThis.document={activeElement:null,body:{dataset:{page:'workbench',mobileView:'console'}},visibilityState:'visible',querySelector:node,addEventListener(){}};globalThis.matchMedia=()=>({matches:true});globalThis.IntersectionObserver=undefined;
  const view=createWorkbenchConsole({host,research,workspace,privateUI,desk:{readSnapshot:idle,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});view.update();await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,1);
  document.body.dataset.mobileView='network';view.stopReading();document.body.dataset.mobileView='console';view.update();await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,2);
 }finally{globalThis.document=previous.document;globalThis.IntersectionObserver=previous.observer;globalThis.matchMedia=previous.media;}
});


test('signal shortlist keeps distinct assets, prioritizes eligible plans, and preserves exact sources',()=>{
 const base={status:'unavailable',canAdopt:false,sourceType:'signal',clockKind:'simulation'};
 const old={...base,id:'ETH-old',asset:'ETH',asOf:10},latest={...base,id:'ETH-latest',asset:'ETH',asOf:20};
 const ready={...base,id:'BTC-eligible-source',asset:'BTC',canAdopt:true,status:'ready',executable:true,freshness:'current',clockKind:'wall'};
 const research={...base,id:'SOL-research',asset:'SOL',sourceType:'research'};
 const rows=[old,{...base,id:'BTC-old',asset:'BTC'},latest,research,ready,{...base,id:'XAU',asset:'XAU'}],before=JSON.stringify(rows);
 const result=workbenchSignalShortlist(rows);
 assert.deepEqual(result,[ready,research,latest]);
 assert.equal(result[2],latest);assert.equal(JSON.stringify(rows),before);
});


test('account risk usage follows allocation and independent loss or fee gates',()=>{
 const limits={cap:1000,dailyLoss:100},account={risk:{allocated:450,loss:22,fees:8,locked:false}};
 const result=workbenchRiskUsage(account,limits);
 assert.equal(result.allocationRemaining,550);assert.equal(result.lossUsed,22);assert.equal(result.lossRemaining,78);assert.equal(result.paused,false);
 assert.equal(workbenchRiskUsage({risk:{...account.risk,fees:100}},limits).paused,true);
 assert.equal(workbenchRiskUsage({risk:{...account.risk,locked:true}},limits).paused,true);
 assert.equal(workbenchRiskUsage({risk:{...account.risk,allocated:1200}},limits).allocationRemaining,0);
 for(const broken of [null,{}, {risk:{...account.risk,loss:NaN}},{risk:{...account.risk,fees:-1}}])assert.equal(workbenchRiskUsage(broken,limits),null);
 assert.equal(workbenchRiskUsage(account,{cap:0,dailyLoss:100}),null);
 assert.equal(account.risk.loss,22,'rendering does not mutate the accounting source');
});

// Selects the app language the way the language picker does (locale.mjs initLocale().set), on a throwaway page, so the console renders in that language.
async function selectAppLanguage(id){
 const keys=['document','MutationObserver','NodeFilter','localStorage'],prior=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
 const page=Object.assign(new EventTarget(),{body:{nodeType:1,querySelectorAll:()=>[]},documentElement:{dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),querySelector:()=>null,querySelectorAll:()=>[]});
 const values={document:page,MutationObserver:class{observe(){}disconnect(){}},NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=>null,setItem(){}}};
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:values[key]});
 try{await initLocale().set(id);}finally{keys.forEach((key,i)=>prior[i]?Object.defineProperty(globalThis,key,prior[i]):delete globalThis[key]);}
 assert.equal(getLocale(),id);
}
test('the private notices tab names its unread reminders in the selected language',async()=>{
 const previous={document:globalThis.document,observer:globalThis.IntersectionObserver,media:globalThis.matchMedia},nodes=new Map(),before=getLocale();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',dataset:{},attrs:{},children:[],isConnected:true,setAttribute(name,value){this.attrs[name]=value;},getAttribute(name){return this.attrs[name]??null;},addEventListener(){},parentElement:{scrollTop:0},querySelectorAll(){return [];}});return nodes.get(key);};
 const host=node('host');host.querySelector=node;const research=new MultiResearch(),workspace=new WorkspaceSim({research});
 const state={schema:'private-notifications-v2',inapp:true,events:['risk','research'],unreadCount:2,reminderUnreadCount:2,inbox:[],nextCursor:null};
 const privateUI={snapshot:()=>({identityStatus:'ready',ownerRef:'offline-owner',notifications:{state}}),renderInbox:()=>'',loadNotifications:()=>assert.fail('hidden pane must not fetch')};
 try{
  globalThis.document={activeElement:null,body:{dataset:{page:'signals'}},visibilityState:'visible',querySelector:node,addEventListener(){}};globalThis.matchMedia=()=>({matches:false});globalThis.IntersectionObserver=undefined;
  const view=createWorkbenchConsole({host,research,workspace,privateUI,desk:{readSnapshot:idle,syncStatus:()=>({scope:{accountId:'SIM-01',environment:'DEMO'}}),settings(){}}});
  for(const id of ['ja','ko','vi','es','fr','ru']){
   await selectAppLanguage(id);view.update();
   const pack=(await import(`./locales/${id}.mjs`)).default,label=node('#ops-view-notifications').attrs['aria-label'];
   // The badge in workbench-console.mjs joins the notices label, unread label, and count.
   assert.equal(label,pack.Notices+' · '+pack['Unread reminders']+' 2',id);
   assert.doesNotMatch(label,/Notices|Unread|reminders/,id);
  }
 }finally{await selectAppLanguage(before);globalThis.document=previous.document;globalThis.IntersectionObserver=previous.observer;globalThis.matchMedia=previous.media;}
});
