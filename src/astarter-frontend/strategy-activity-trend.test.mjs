import test from 'node:test';
import assert from 'node:assert/strict';
import {BotBook,botParameters} from './bot-runtime.mjs';
import {createBotHub} from './bot-hub.mjs';

const subject=await import('./strategy-activity-trend.mjs').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
const model=subject.strategyActivityModel||(()=>null);
const view=subject.strategyActivityTrendView||(()=> '');
const mount=subject.mountStrategyActivityTrend;
const order=(id,extra={})=>({id,accountId:'SIM-01',runId:'r1',market:'BTC/USDT',currency:'USDT',side:'buy',qty:2,price:100,filled:.5,status:'partial',...extra});
const run=(id,extra={})=>({id,environment:'DEMO',plan:{strategy:'S01',market:'BTC/USDT',executionRoute:{accountId:'SIM-01',environment:'DEMO'}},initialAllocation:300,fees:.1,orders:[],...extra});
const snapshot=runs=>({botBook:{runs}});

test('activity distinguishes unavailable account data from an empty confirmed book',()=>{
 assert.equal(model(null)?.state,'unavailable');
 assert.equal(model({botBook:{}})?.state,'unavailable');
 assert.equal(model({...snapshot([]),botSummary:{recoveryError:'unreadable'}})?.state,'unavailable');
 assert.equal(model(snapshot([]),{accountId:'SIM-02'})?.state,'unavailable');
 const empty=model(snapshot([]));
 assert.equal(empty?.state,'empty');
 assert.deepEqual(empty?.totals,{fills:0,turnover:0,allocation:0,fees:0});
});
test('native BotBook plans reach activity through their declared scope without accepting conflicts',()=>{
 const book=new BotBook({debit:()=>true,credit:()=>true});
 const created=book.create({id:'ACTIVITY-NATIVE',version:1,strategy:'S02',planVariant:'S02-SIM',market:'BTC/USDT',executionRoute:{accountId:'SIM-01',connectionId:'legacy-exchange',profileId:'cex-spot',venueId:'binance',chainId:''},amount:20,cap:500,mode:'auto',protection:{id:'original',version:'strategy-original'},botParameters:botParameters('S02')},{requestId:'ACTIVITY-NATIVE-APPROVAL'});
 assert.ok(created.run);assert.equal(created.run.plan.environment,'DEMO');assert.equal(created.run.plan.executionRoute.environment,undefined);
 const input={botBook:book.snapshot()},before=JSON.stringify(input),m=model(input);
 assert.equal(m.state,'ready');assert.equal(m.rows.length,1);assert.equal(m.rows[0].id,created.run.id);assert.equal(m.totals.allocation,500);
 assert.ok(view(m).includes('?page=execution&amp;runId='+encodeURIComponent(created.run.id)));assert.equal(JSON.stringify(input),before);
 for(const patch of [r=>r.environment='LIVE',r=>r.plan.environment='LIVE',r=>r.plan.executionRoute.environment='LIVE',r=>r.plan.executionRoute.accountId='SIM-02',r=>delete r.plan.environment,r=>r.plan.environment=null,r=>r.plan.executionRoute.environment=null]){
  const copy=structuredClone(input);patch(copy.botBook.runs[0]);assert.equal(model(copy).rows.length,0,'unknown or conflicting scope must not be counted as a demo run');
 }
 const duplicate=structuredClone(input);duplicate.botBook.runs.push(structuredClone(duplicate.botBook.runs[0]));assert.equal(model(duplicate).totals.allocation,500);
});

test('each column is one original account run and confirmed partial orders count once',()=>{
 const a=order('o1'),b=order('o2',{side:'sell',qty:1,price:120,filled:1,status:'filled'});
 const runs=[run('r1',{orders:[a,a,b,order('pending',{filled:0,status:'unknown'})]}),run('foreign',{plan:{strategy:'S01',market:'BTC/USDT',executionRoute:{accountId:'SIM-02',environment:'DEMO'}}}),run('live',{environment:'LIVE'}),run('research',{plan:{strategy:'S03',executionRoute:{accountId:'SIM-01',environment:'DEMO'}}})];
 const input=snapshot(runs),before=JSON.stringify(input),m=model(input);
 assert.equal(m?.state,'ready');
 assert.deepEqual(m?.rows.map(({id,sequence,market,values})=>({id,sequence,market,values})),[{id:'r1',sequence:1,market:'BTC/USDT',values:{fills:2,turnover:220,allocation:300,fees:.1}}]);
 assert.deepEqual(m?.totals,{fills:2,turnover:220,allocation:300,fees:.1});
 assert.equal(JSON.stringify(input),before);
});

test('missing amounts stay unknown and foreign quote currency is never relabeled USDT',()=>{
 const m=model(snapshot([run('r1',{fees:NaN,initialAllocation:undefined,orders:[order('foreign',{market:'ETH/USDC',currency:'USDC'})]}),run('r2',{orders:undefined})]));
 assert.equal(m?.rows[0].values.turnover,null);
 assert.equal(m?.rows[0].values.fees,null);
 assert.equal(m?.rows[0].values.allocation,null);
 assert.equal(m?.rows[1].values.fills,null);
 assert.equal(m?.rows[1].values.turnover,null);
 assert.deepEqual(m?.totals,{fills:null,turnover:null,allocation:null,fees:null});
});

test('the recent-run window uses original sequence rather than invented calendar dates',()=>{
 const runs=Array.from({length:32},(_,i)=>run('r'+i,{createdAt:i%2?1794200000000+i:i,initialAllocation:100,fees:0}));
 const m=model(snapshot(runs));
 assert.equal(m?.rows.length,30);
 assert.equal(m?.rows[0].id,'r2');assert.equal(m?.rows[0].sequence,3);
 assert.equal(m?.rows.at(-1).sequence,32);
 assert.deepEqual(m?.totals,{fills:0,turnover:0,allocation:3000,fees:0});
});

test('a non-USDT run cannot contribute allocation or fee amounts to USDT totals',()=>{
 const m=model(snapshot([run('foreign-quote',{plan:{strategy:'S01',market:'ETH/USDC',executionRoute:{accountId:'SIM-01',environment:'DEMO'}},orders:[order('o',{market:'ETH/USDC',currency:'USDC'})]})]));
 assert.equal(m?.totals.fills,1);
 assert.equal(m?.totals.turnover,null);
 assert.equal(m?.totals.allocation,null);
 assert.equal(m?.totals.fees,null);
});

test('malformed order records do not crash the overview or become confirmed zeros',()=>{
 const m=model(snapshot([run('r1',{orders:[order(123),null]})]));
 assert.equal(m?.rows[0].values.fills,null);
 assert.equal(m?.rows[0].values.turnover,null);
});

test('the view exposes measured metrics, escapes run data and never supplies demo growth',()=>{
 const m=model(snapshot([run('r<bad>',{orders:[order('x')],plan:{strategy:'S01',market:'BTC/USDT<script>',executionRoute:{accountId:'SIM-01',environment:'DEMO'}}})]));
 const html=view(m,'turnover');
 assert.match(html,/data-strategy-activity-trend/);
 assert.match(html,/data-sat-metric="turnover"[^>]*aria-selected="true"/);
 assert.match(html,/100/);assert.match(html,/USDT/);
 assert.doesNotMatch(html,/<bad>|<script>|vs last year|2025|1\.46M/);
 assert.match(html,/\\u003c/);
 assert.match(view(model(null)),/data-sat-state="unavailable"/);
 assert.match(view(model(snapshot([]))),/data-sat-state="empty"/);
 assert.doesNotMatch(view(model(snapshot([]))),/data-sat-column/);
 assert.doesNotMatch(view(model(snapshot([]))),/role="tablist"|role="tabpanel"/);
 assert.doesNotMatch(view(model(null)),/role="tablist"|role="tabpanel"/);
});

function activityLinkFixture(){
 const data=model(snapshot([run('older'),run('latest')])),output={innerHTML:''},content={setAttribute(){}},chart={},plot={},anchor={href:'?page=execution&runId=latest'};
 const tabs=['fills','turnover','allocation','fees'].map(key=>({dataset:{satMetric:key},setAttribute(){},focus(){}}));
 const columns=data.rows.map((_,index)=>({dataset:{satColumn:String(index)},toggleAttribute(){}}));
 const host={dataset:{satMetric:'fills'},contains:node=>node===anchor,querySelector(selector){return {'[data-sat-data]':{textContent:JSON.stringify(data)},'.sat-readout':output,'#sat-content':content,'.sat-chart':chart,'.sat-plot':plot}[selector]||null;},querySelectorAll:selector=>selector==='.sat-metrics button'?tabs:selector==='[data-sat-column]'?columns:[]};
 const root={querySelector:selector=>selector==='[data-strategy-activity-trend]'?host:null,querySelectorAll:()=>[]};
 const click=(patch={})=>({button:0,target:{closest:selector=>selector==='.sat-readout a'?anchor:null},preventDefault(){this.prevented=true;},...patch});
 return {root,host,plot,tabs,columns,anchor,output,click};
}

test('activity run links navigate within the page for the current readout and preserve native link gestures',()=>{
 const f=activityLinkFixture(),opened=[];mount(f.root,{onViewRun:id=>opened.push(id)});
 let event=f.click();f.host.onclick(event);assert.equal(event.prevented,true);assert.deepEqual(opened,['latest']);
 f.plot.onkeydown({key:'Home',preventDefault(){}});assert.ok(f.output.innerHTML.includes('runId=older'));
 event=f.click();f.host.onclick(event);assert.equal(event.prevented,true);assert.equal(opened.at(-1),'older');
 f.tabs[3].onclick();event=f.click();f.host.onclick(event);assert.equal(opened.at(-1),'older','changing metrics keeps the selected run');
 f.columns[1].onpointerenter();event=f.click();f.host.onclick(event);assert.equal(opened.at(-1),'latest','a new readout must not retain the old run ID');
 const count=opened.length;
 for(const patch of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{button:2},{defaultPrevented:true}]){event=f.click(patch);f.host.onclick(event);assert.notEqual(event.prevented,true);assert.equal(opened.length,count);}
 mount(f.root);event=f.click();f.host.onclick(event);assert.notEqual(event.prevented,true);assert.equal(f.anchor.href,'?page=execution&runId=latest','without a callback, href remains the fallback');
});

test('the hub passes the exact activity run to its existing page router without changing account data',()=>{
 const f=activityLinkFixture(),routes=[],w={s:{}},before=JSON.stringify(w);
 createBotHub({w,desk:{},root:f.root,go:(page,context)=>routes.push({page,context})}).bind();
 const event=f.click();f.host.onclick(event);assert.equal(event.prevented,true);assert.deepEqual(routes,[{page:'execution',context:{runId:'latest'}}]);assert.equal(JSON.stringify(w),before);
 const fallback=activityLinkFixture();createBotHub({w,desk:{},root:fallback.root}).bind();const native=fallback.click();fallback.host.onclick(native);assert.notEqual(native.prevented,true);
});
