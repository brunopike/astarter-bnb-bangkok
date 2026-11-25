import test from 'node:test';
import assert from 'node:assert/strict';
import {botRunHistory,botRunStats,botManagementSummary,botCreationFrame,botInstancesView,botHistoryView,botParameterFields,botParameterRows} from './strategy-bot-views.mjs';
import {BotBook,botParameters} from './bot-runtime.mjs';
import {protectionConfig} from './strategy-protection.mjs';

test('only an opted-in creation chart exposes the combined instrument dialog trigger',()=>{
 const args={content:'',market:'BTC/USDT',strategyId:'S01',nativeBot:true};
 assert.doesNotMatch(botCreationFrame(args),/data-tc-action="choose-instrument"/);
 assert.doesNotMatch(botCreationFrame({...args,embedded:{header:'',footer:''}}),/data-tc-action="choose-instrument"/);
 const active=botCreationFrame({...args,embedded:{header:'',footer:'',instrumentPicker:true}});
 assert.match(active,/data-tc-action="choose-instrument"/);assert.match(active,/aria-haspopup="dialog"/);assert.match(active,/data-trading-chart="strategy-create-market"/);
});

test('parameter editing uses integer keyboards for counts and keeps one local recommendation action',()=>{
 for(const strategy of ['S01','S02']){
  const plan={strategy,planVariant:strategy+'-SIM',market:'BTC/USDT',botParameters:botParameters(strategy)},before=structuredClone(plan);
  const html=botParameterFields(plan,'recommended',80000),count=strategy==='S01'?'count':'maxEntries';
  assert.match(html,new RegExp('name="bot_'+count+'"[^>]*inputmode="numeric"'));
  assert.match(html,/name="bot_(lower|deviationPct)"[^>]*inputmode="decimal"/);
  assert.match(html,/data-sc="apply-bot-parameters"[^>]*>[\s\S]*?<svg/);
  assert.doesNotMatch(html,/↗/);
  assert.equal((html.match(/data-sc="apply-bot-parameters"/g)||[]).length,1);
  assert.match(html,/<small>[\s\S]*?80,000[\s\S]*?<\/small>/);
  assert.match(html,/<p>[\s\S]*?<\/p>/);
  assert.match(botParameterFields(plan,'recommended'),/data-sc="apply-bot-parameters" disabled/);
  assert.doesNotMatch(botParameterFields(plan,'manual',80000),/class="bot-recommendation"/);
  assert.deepEqual(plan,before);
 }
});

test('custom protection review shows the six frozen values without changing the approved plan',()=>{
 const protection=protectionConfig('astarter','normal',{episode:.001,notional:.04,daily:.01,epoch:.025,soft:.02,hard:.06});
 const plan={strategy:'S01',planVariant:'S01-SIM',amount:50,protection,botParameters:botParameters('S01')},before=JSON.stringify(plan);
 const rows=botParameterRows(plan);
 assert.deepEqual(rows.slice(-6).map(row=>row[1]),['0.1%','4%','1%','2.5%','2%','6%']);
 assert.equal(JSON.stringify(plan),before);
 assert.equal(botParameterRows({...plan,protection:{id:'original',version:'strategy-original'}}).length,5);
});
test('paused buying and interrupted runs explain different resume actions without changing orders',()=>{
 const plan={id:'resume-copy',version:1,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'paper-main'},protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S01')};
 const book=new BotBook({debit(){},credit(){}});book.create(plan,{requestId:'resume-copy-create'});
 const trade={botBook:book.snapshot()},run=trade.botBook.runs[0];
 run.orders=[{id:'rejected-order',status:'rejected',side:'buy',qty:1,filled:0,price:1,fee:0}];
 run.status='paused';const before=JSON.stringify(trade),paused=botInstancesView(trade,{S01:'Grid'});
 assert.match(paused,/恢复买入|Resume entries/);assert.match(paused,/订单被拒绝|Rejected/);assert.match(paused,/账面盈亏|Simulated PnL/);assert.equal(JSON.stringify(trade),before);
 assert.match(paused,/暂停新买入；原订单与已有库存保留|New buys are paused; existing orders and holdings remain/);
 const confirmation=botInstancesView(trade,{S01:'Grid'},{endRunId:run.id});
 assert.match(confirmation,/结束运行|End run/);assert.match(confirmation,/保留持仓，或卖出后结束/);assert.match(confirmation,/data-kind="stop-keep"/);assert.match(confirmation,/data-kind="stop-close"/);assert.doesNotMatch(confirmation,/实际资产|actual holdings/);
 assert.match(confirmation,new RegExp('aria-label="[^\"]*'+run.id+'[^\"]*BTC/USDT'));
 assert.equal(JSON.stringify(trade),before);
 run.status='interrupted';const interrupted=botInstancesView(trade,{S01:'Grid'});
 assert.match(interrupted,/恢复运行|Resume/);assert.doesNotMatch(interrupted,/恢复买入|Resume entries/);assert.equal(run.orders[0].filled,0);
 run.status='stopped';run.pauseReason='Previous pause reason';run.endReason='user-keep';
 const endedBefore=JSON.stringify(trade),ended=botInstancesView(trade,{S01:'Grid'},{history:true});
 assert.match(ended,/<p class="bot-instance-reason">(?:用户结束 · 保留持仓|Ended by user · keep holdings)<\/p>/);assert.doesNotMatch(ended,/<p class="bot-instance-reason">Previous pause reason/);assert.equal(JSON.stringify(trade),endedBefore);
});

test('a stored zero risk budget explains held entries without pausing the run or hiding a higher priority state',()=>{
 const plan={id:'held-budget',version:1,strategy:'S02',planVariant:'S02-SIM',mode:'auto',amount:50,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'paper-main'},protection:protectionConfig('astarter','normal'),botParameters:botParameters('S02')};
 const book=new BotBook({debit(){},credit(){}});const created=book.create(plan,{requestId:'held-budget-create'});assert.equal(created.error,undefined);
 const state={botBook:book.snapshot()},run=state.botBook.runs[0];
 run.status='running';run.protectionDecision={scope:'BOT_ALLOCATION',action:'pause',reason:'budget',amount:0,requested:9.14};
 const before=JSON.stringify(state),html=botInstancesView(state,{S02:'DCA'});
 assert.match(html,/风控后额度不足，暂不新增买入/);
 assert.match(html,/data-kind="pause"/);assert.doesNotMatch(html,/data-kind="resume"|9\.14/);
 assert.equal(run.status,'running');assert.equal(run.orders.length,0);assert.equal(JSON.stringify(state),before);
 for(const change of [
  s=>s.botBook.runs[0].status='waiting',s=>s.botBook.runs[0].status='paused',
  s=>s.botBook.runs[0].status='interrupted',s=>s.botBook.runs[0].status='blocked',
  s=>s.botBook.runs[0].status='stopping',s=>s.botBook.runs[0].status='stopped',
  s=>s.botBook.runs[0].endIntent='close',s=>s.botBook.runs[0].endReason='Receipt needs review',
  s=>s.botBook.runs[0].pauseReason='Connection needs review',
  s=>s.botBook.runs[0].orders.push({id:'unknown-order',status:'unknown',side:'buy',qty:1,filled:0,price:1,fee:0}),
  s=>s.botBook.residentControl={cancelRequests:[{runId:run.id,orderId:'pending-cancel',state:'UNKNOWN'}]},
  s=>s.botSummary={recoveryError:'Offline'},
  s=>s.botBook.runs[0].protectionDecision.amount=9.14,
  s=>s.botBook.runs[0].protectionDecision.amount='0',
  s=>s.botBook.runs[0].protectionDecision.amount=null,
  s=>s.botBook.runs[0].protectionDecision.reason='daily',
  s=>s.botBook.runs[0].protectionDecision.action='allow',
  s=>s.botBook.runs[0].protectionDecision.scope='ACCOUNT',
  s=>s.botBook.runs[0].protectionDecision=null
 ]){
  const sample=structuredClone(state);change(sample);const saved=JSON.stringify(sample);
  const output=botInstancesView(sample,{S02:'DCA'});
  assert.doesNotMatch(output,/风控后额度不足，暂不新增买入/);
  if(sample.botBook.runs[0].endReason)assert.match(output,/Receipt needs review/);
  if(sample.botBook.runs[0].pauseReason)assert.match(output,/Connection needs review/);
  if(sample.botBook.runs[0].orders.some(order=>order.status==='unknown'))assert.match(output,/data-kind="query"/);
  assert.equal(JSON.stringify(sample),saved);
 }
});

test('approved parameter review retains entered price and allocation precision',()=>{
 const rows=botParameterRows({strategy:'S01',planVariant:'S01-SIM',amount:12.3456,botParameters:{lower:.12345678,upper:1.23456789,count:3,spacing:'arithmetic',takeProfitPrice:89340.757,stopLossPrice:73096.983}});
 assert.equal(rows[0][1],'0.12345678 – 1.23456789 USDT');
 assert.equal(rows[2][1],'12.3456 USDT');
 assert.equal(rows[3][1],'89,340.757 / 73,096.983');
});

test('bot history groups actual fills by run and keeps unknown orders out of filled value',()=>{
 const trade={state:'running',session:{id:'new',draftId:'d'},events:[{runId:'old',strategy:'S03',market:'BTC/USDT',recordedAt:100},{runId:'new',strategy:'S03',market:'ETH/USDT',recordedAt:300}],orders:[
  {id:'a',runId:'old',strategy:'S03',market:'BTC/USDT',price:100,qty:2,filled:.5,fee:.1,recordedAt:200,status:'partial-cancelled'},
  {id:'b',runId:'new',strategy:'S03',market:'ETH/USDT',price:200,qty:2,filled:0,fee:0,recordedAt:300,status:'unknown'},
  {id:'manual',runId:'manual',strategy:'MANUAL',price:50,qty:10,filled:1,fee:2}
 ]};
 const before=JSON.stringify(trade),runs=botRunHistory(trade);
 assert.equal(runs.length,2);assert.equal(runs[0].state,'running');assert.equal(runs[0].notional,0);
 assert.equal(runs[1].state,'stopped');assert.equal(runs[1].notional,100);assert.equal(runs[1].fees,.1);
 assert.equal(JSON.stringify(trade),before);assert.match(botRunStats({id:'d'},trade),/Pending orders|待处理订单/);
});
test('a watching strategy uses its bound version allocation when another draft is selected',()=>{
 const workspace={s:{drafts:[{id:'d',version:2,cap:300,executionRoute:{connectionId:'api-main'}},{id:'other',version:1,cap:900}]},draft:()=>({id:'other',cap:900})};
 const trade={discovery:{armed:true,draftId:'d',version:2,connectionId:'api-main'},session:{cap:900},state:'stopped',orders:[]},html=botManagementSummary(workspace,trade);
 assert.match(html,/300/);assert.doesNotMatch(html,/900/);
 const unknown=botManagementSummary(workspace,{...trade,discovery:{...trade.discovery,version:3}});assert.match(unknown,/—<small>USDT/);assert.doesNotMatch(unknown,/300|900/);
});
test('a waiting native BOT is visible before fills and its ended history keeps the frozen parameters and returned cash',()=>{
 const plan={id:'d-grid',version:3,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'paper-main',chainId:''},protection:{id:'original',version:'strategy-original'},botParameters:{...botParameters('S01'),count:3,triggerPrice:78200}};
 const book=new BotBook({debit(){},credit(){}}),run=book.create(plan,{requestId:'approved-3'}).run;
 const waiting=botInstancesView({botBook:book.snapshot()},{S01:'Grid'});assert.match(waiting,new RegExp(run.id));assert.match(waiting,/78200|78,200/);assert.match(waiting,/Waiting for trigger|等待触发/);
 plan.botParameters.count=99;
 assert.equal(book.action(run.id,'stop-keep',{requestId:'end-3'}).error,undefined);
 const history=botHistoryView({botBook:book.snapshot()},{S01:'Grid'});assert.match(history,/Returned capital|已返还资金/);assert.match(history,/300/);assert.match(history,/3 ·/);assert.doesNotMatch(history,/99 ·/);
 const fields=botParameterFields(book.snapshot().runs[0].plan);assert.match(fields,/name="bot_count"/);assert.doesNotMatch(fields,/risk_fraction|ATR/);
 const frame=botCreationFrame({content:fields,strategyId:'S01',nativeBot:true,market:'BTC/USDT',view:null});assert.doesNotMatch(frame,/data-tc-grid=|data-sc="config-view"/);
});

test('resident cancellation exposes original-order recovery without repeating an accepted end intent',()=>{
 const plan={id:'pending-end',version:1,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'local-fixture'},protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S01')};
 const book=new BotBook({debit(){},credit(){}});book.create(plan,{requestId:'create-pending-end'});
 const state=book.snapshot(),run=state.runs[0];run.status='stopping';run.endIntent='close';run.orders=[{id:'ORIGINAL-SELL',status:'submitted',side:'sell',qty:.01,filled:0,price:80000,fee:0}];
 state.residentControl={cancelRequests:[{runId:run.id,orderId:'ORIGINAL-SELL',state:'UNKNOWN'}]};
 const before=JSON.stringify(state),html=botInstancesView({botBook:state},{S01:'Grid'},{endRunId:run.id});
 assert.match(html,/data-kind="query"[^>]*data-order="ORIGINAL-SELL"/);
 assert.match(html,/撤单待确认|Cancellation unconfirmed/);assert.match(html,/资金继续保留|Capital stays reserved/);
 assert.doesNotMatch(html,/data-sc="bot-end"|data-kind="stop-close"|data-kind="stop-keep"/);
 assert.equal(JSON.stringify(state),before);
});

test('flat settled history stays stable while retained holdings and unresolved capital remain visible',()=>{
 const plan={id:'view-history',version:1,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'paper-main',chainId:''},protection:{id:'original',version:'strategy-original'},botParameters:{...botParameters('S01'),count:3,triggerPrice:78200}};
 const book=new BotBook({debit(){},credit(){}}),run=book.create(plan,{requestId:'view-create'}).run;
 assert.equal(book.action(run.id,'stop-keep',{requestId:'view-end'}).error,undefined);
 const settled=book.snapshot(),before=JSON.stringify(settled),html=botHistoryView({botBook:settled},{S01:'Grid'});
 assert.doesNotMatch(html,/bot-instance-balance/);assert.match(html,/Returned capital|已返还资金/);assert.match(html,/Approved parameters|原批准参数/);
 book.tick(1);assert.equal(botHistoryView({botBook:book.snapshot()},{S01:'Grid'}),html);assert.equal(JSON.stringify(settled),before);
 for(const change of [state=>state.runs[0].cash=.01,state=>state.runs[0].allocated=.01,state=>state.flow.reservations[0].state='HELD',state=>state.runs[0].orders.push({id:'unconfirmed',status:'unknown',price:100,qty:1,filled:0,fee:0}),state=>state.runs[0].orders.push({id:'pending',status:'submitted',price:100,qty:1,filled:0,fee:0})]){
  const state=structuredClone(settled);change(state);assert.match(botHistoryView({botBook:state},{S01:'Grid'}),/bot-instance-balance/);
 }
 const retainedBook=new BotBook({debit(){},credit(){}}),retained=retainedBook.create({...plan,id:'view-retained',strategy:'S02',planVariant:'S02-SIM',botParameters:botParameters('S02')},{requestId:'view-retained-create'}).run;
 retainedBook.tick(.1,{'BTC/USDT':100});retainedBook.tick(.1,{'BTC/USDT':100});retainedBook.tick(3,{'BTC/USDT':100});
 assert.equal(retainedBook.action(retained.id,'stop-keep',{requestId:'view-retained-end'}).error,undefined);
 assert.ok(retainedBook.snapshot().runs[0].quantity>0);assert.match(botHistoryView({botBook:retainedBook.snapshot()},{S02:'DCA'}),/bot-instance-balance/);
});

test('BOT event times use their own creation event and identify timestamps when that basis is missing',()=>{
 const plan={id:'view-clock',version:1,strategy:'S01',planVariant:'S01-SIM',mode:'auto',amount:60,cap:300,market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'paper-main',chainId:''},protection:{id:'original',version:'strategy-original'},botParameters:{...botParameters('S01'),count:3,triggerPrice:78200}};
 const book=new BotBook({debit(){},credit(){}});book.tick(137);
 const run=book.create(plan,{requestId:'view-clock-create',at:2}).run;book.tick(1.25);book.action(run.id,'pause',{requestId:'view-clock-pause'});
 const state=book.snapshot(),before=JSON.stringify(state),html=botInstancesView({botBook:state},{S01:'Grid'});
 assert.match(html,/<time>\+0\.0s · SIM<\/time>/);assert.match(html,/<time>\+1\.3s · SIM<\/time>/);assert.doesNotMatch(html,/<time>\+13[78]/);assert.equal(JSON.stringify(state),before);
 state.runs[0].events=state.runs[0].events.filter(event=>event.kind!=='created');
 const withoutBasis=botInstancesView({botBook:state},{S01:'Grid'});assert.match(withoutBasis,/(SIM time|记录时间) 138\.3s/);assert.doesNotMatch(withoutBasis,/<time>\+/);
});
test('the creation frame uses one existing form and reviewable allocation controls',()=>{
 const html=botCreationFrame({content:'<form id="sc-config"><input name="cap" value="500"></form>',market:'BTC/USDT',limit:1000,entry:'Entry',exit:'Exit'});
 assert.equal((html.match(/id="sc-config"/g)||[]).length,1);
 assert.match(html,/data-sc="allocation" data-id="0.25"/);
 assert.match(html,/data-trading-chart="strategy-create-market"/);
 assert.match(html,/data-config-mode="quick"/);
 assert.doesNotMatch(html,/ROI|胜率| гарант/);
});

test('the embedded workspace keeps its chart and one form in separate columns with phase-specific actions',()=>{
 const frame=botCreationFrame({market:'ETH/USDT',content:'<form id="sc-config"><input name="cap" value="500"></form>',embedded:{header:'<header id="editor-heading">Selected strategy</header>',footer:'<footer id="editor-actions"><button data-sc="start">Check</button></footer>',details:'<section id="selected-rules">Selected rules</section>'}});
 const market=frame.slice(frame.indexOf('<section class="bot-creation-market"'),frame.indexOf('<section class="bot-creation-settings"'));
 const settings=frame.slice(frame.indexOf('<section class="bot-creation-settings"'));
 assert.match(market,/ETH\/USDT/);assert.match(market,/data-trading-chart="strategy-create-market"/);assert.match(market,/id="selected-rules"/);assert.doesNotMatch(market,/<form|data-sc="start"/);
 assert.equal((settings.match(/<form/g)||[]).length,1);assert.ok(settings.indexOf('id="editor-heading"')<settings.indexOf('id="sc-config"'));assert.ok(settings.indexOf('id="sc-config"')<settings.indexOf('id="editor-actions"'));
 const approval=botCreationFrame({market:'ETH/USDT',view:null,content:'<article id="approval">Immutable checked plan</article>',embedded:{footer:'<button data-sc="launch">Approve</button>'}});
 assert.match(approval,/id="approval"/);assert.match(approval,/data-sc="launch"/);assert.doesNotMatch(approval,/data-sc="config-view"|data-sc="allocation"/);
 const empty=botCreationFrame({market:'',content:'<form id="sc-config"></form>',embedded:{art:'<svg aria-label="Selected strategy mechanism"></svg>'}});
 assert.match(empty,/Selected strategy mechanism/);assert.match(empty,/data-sc="choose-instrument"/);assert.doesNotMatch(empty,/data-trading-chart=|BTC\/USDT/);
});
