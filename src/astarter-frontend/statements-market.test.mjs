import test from 'node:test';
import assert from 'node:assert/strict';
import {statementRecords,statementScope,statementSearch,projectStatements,statementZoneLabel,statementCurveRange,statementCurveDay} from './statements-data.mjs';
import {statementsView,statementDetail} from './statements-view.mjs';
import {statementMarketExampleSnapshot,statementExampleSnapshot,STATEMENT_MARKET_EXAMPLE} from './trading-preview.mjs';
import {createStatements} from './statements.mjs';
const base={accountId:'REVIEW-01',environment:'DEMO',timeZone:'Asia/Shanghai'};
const project=(patch={},data=statementMarketExampleSnapshot())=>{const scope=statementScope('',{...base,...patch}),records=statementRecords(data,base);return {scope,records,model:projectStatements(records,scope)};};

test('All currencies includes every market without adding incompatible money values',()=>{
 const data=statementMarketExampleSnapshot(),before=structuredClone(data),p=project({currency:''},data);
 assert.equal(p.model.fills.length,8);assert.equal(p.model.openOrders.length,4);assert.equal(p.model.positions.length,4);
 assert.equal(p.model.net,null);assert.equal(p.model.fees,null);assert.deepEqual(p.model.points,[]);assert.deepEqual(p.model.days,[]);
 assert.deepEqual(p.model.currencyModels.map(row=>row.currency).sort(),['ETH','USDC','USDT']);
 for(const row of p.model.currencyModels){const expected=project({currency:row.currency}).model;assert.equal(row.model.net,expected.net);assert.equal(row.model.fees,expected.fees);}
 assert.deepEqual(statementScope(statementSearch(p.scope),base),p.scope);
 assert.ok(p.model.fills.every(row=>row.owner==='AI_SPECTRUM'));
 assert.deepEqual(data,before);
});

test('All currency scope preserves confirmed empty values and incomplete-settlement boundaries',()=>{
 const empty={orders:[],flow:{fills:[],ledger:[]},positions:[],accountSummary:base},p=project({currency:''},empty);
 assert.equal(p.model.net,'0');assert.equal(p.model.fees,'0');assert.deepEqual(p.model.currencyModels,[]);
 const single=statementExampleSnapshot(),a=project({currency:''},single),b=project({currency:'USDT'},single);
 assert.equal(a.model.net,b.model.net);assert.equal(a.model.fees,b.model.fees);assert.deepEqual(a.model.points,b.model.points);
 const before=structuredClone(single);single.flow.fills[0].feeState='PENDING';assert.equal(project({currency:''},single).model.net,null);
 assert.deepEqual(project({currency:'',owner:'STRATEGY_AGENT'},single).model.fills.map(row=>row.id),project({currency:'USDT',owner:'STRATEGY_AGENT'},before).model.fills.map(row=>row.id));
 const foreign=project({currency:''},statementMarketExampleSnapshot());assert.equal(foreign.model.currencyModels.find(row=>row.currency==='USDC').model.net,null);
});

test('a currency literally named ALL is a real currency, never the aggregate selector',()=>{
 const records={orders:[],fills:[],events:[],positions:[{owner:'AI_SPECTRUM',currency:'ALL',market:'TOKEN/ALL'}]},scope={owner:'AI_SPECTRUM',currency:'ALL',timeZone:'UTC'};
 assert.doesNotThrow(()=>projectStatements(records,scope));const exact=projectStatements(records,scope);
 assert.equal(exact.positions[0],records.positions[0]);assert.equal(exact.positions[0].currency,'ALL');
 const timestamp=Date.parse('2026-11-09T00:00:00Z');records.events=[{key:'all-event',owner:'AI_SPECTRUM',currency:'ALL',type:'REALIZED_PNL',amount:'5',timestamp},{key:'usdt-event',owner:'AI_SPECTRUM',currency:'USDT',type:'REALIZED_PNL',amount:'3',timestamp}];
 const combined=projectStatements(records,{...scope,currency:''});
 assert.equal(combined.positions[0].currency,'ALL');assert.equal(combined.events.length,2);assert.equal(combined.net,null);assert.deepEqual(combined.points,[]);
 assert.deepEqual(combined.currencyModels.map(row=>[row.currency,row.model.net]),[['ALL','5'],['USDT','3']]);
 for(const currency of ['', 'ALL']){const s=statementScope('',{...base,currency});assert.deepEqual(statementScope(statementSearch(s),base),s);}
});

test('All records show plain spot and perpetual sections with each market retaining its own first page',()=>{
 const p=project({currency:''}),view=statementsView({...p,month:'2026-11',limit:2});
 assert.match(view,/data-st-market-group="SPOT"/);assert.match(view,/data-st-market-group="PERPETUAL"/);
 for(const key of ['spectrum:F-REVIEW-0-dex-spot-1','spectrum:F-REVIEW-0-dex-perp-1'])assert.ok(view.includes('data-st-detail="'+key+'"'));
 assert.match(view,/现货|Spot/);assert.match(view,/永续合约|Perpetual/);
 assert.doesNotMatch(view,/>SPOT<|>PERP<|>AI 自主<|>AI autonomous</);
 assert.match(view,/<option value="" selected/);assert.match(view,/data-st-action="more"/);
 const full=statementsView({...p,month:'2026-11',limit:20});assert.doesNotMatch(full,/data-st-action="more"/);
 assert.doesNotMatch(full,/st-curve-plot/);
 const reference=statementsView({...p,example:true,month:'2026-11'});
 assert.match(reference,/参考数据 · 只读|Reference data · Read only/);assert.doesNotMatch(reference,/审阅账单|Review records/);
 assert.match(reference,/<th scope="col">成交数量<br>成交额<\/th>/);assert.match(reference,/<td data-label="成交数量 \/ 成交额"/);
 assert.match(reference,/\+14\.00<small>USDC<\/small>/);assert.match(reference,/\+16\.00<small>USDT<\/small>/);
 for(const tab of ['orders','openOrders','positions','funding']){
  const html=statementsView({...p,scope:{...p.scope,tab},month:'2026-11'});
  assert.ok(html.includes('data-st-market-group="SPOT"'),tab);assert.ok(html.includes('data-st-market-group="PERPETUAL"'),tab);
 }
});

test('trade side and position side use independent green and red text, including closing orders',()=>{
 const data=statementMarketExampleSnapshot();
 for(const [intent,direction,side]of [['open','long','buy'],['close','long','sell'],['open','short','sell'],['close','short','buy']]){
  const order=data.orders.find(row=>row.venueType==='CEX'&&row.marketType==='PERPETUAL');Object.assign(order,{intent,direction,side});
  const fill=data.flow.fills.find(row=>row.orderId===order.id);Object.assign(fill,{intent,direction,side});
  const p=project({currency:'USDT',marketType:'PERPETUAL',query:order.id},data),view=statementsView({...p,month:'2026-11'});
  assert.match(view,new RegExp('class="st-trade-side '+(side==='buy'?'profit':'loss')+'"'));
  assert.match(view,new RegExp('class="st-position-side '+(direction==='long'?'profit':'loss')+'"'));
  const detail=statementDetail(p.model.fills[0],p.scope,true);
  assert.match(detail,new RegExp('class="st-trade-side '+(side==='buy'?'profit':'loss')+'"'));
  assert.match(detail,new RegExp('class="st-position-side '+(direction==='long'?'profit':'loss')+'"'));
 }
 const order=data.orders.find(row=>row.venueType==='CEX'&&row.marketType==='PERPETUAL'),fill=data.flow.fills.find(row=>row.orderId===order.id);
 order.intent=fill.intent='unknown';const p=project({currency:'USDT',marketType:'PERPETUAL',query:order.id},data);
 assert.match(statementsView({...p,month:'2026-11'}),/class="st-position-side neutral">(?:方向待核对|Unverified direction)</);
});

test('unknown market metadata remains in a neutral section; spot holdings do not borrow margin fields',()=>{
 const data=statementMarketExampleSnapshot(),o=data.orders[0],f=data.flow.fills.find(row=>row.orderId===o.id);
 for(const row of [o,f]){delete row.marketType;delete row.profileId;}
 const p=project({currency:''},data),view=statementsView({...p,month:'2026-11'});
 assert.match(view,/data-st-market-group="UNKNOWN"/);assert.ok(view.includes('data-st-detail="spectrum:'+f.id+'"'));
 const spot=project({currency:'',marketType:'SPOT',tab:'positions'}),html=statementsView({...spot,month:'2026-11'});
 assert.doesNotMatch(html,/data-label="(?:保证金|Margin)"/);
 assert.doesNotMatch(html,/杠杆|leverage/);
});

test('four venue/instrument combinations and both owners filter the same typed receipts',()=>{
 const data=statementMarketExampleSnapshot(),before=structuredClone(data);
 for(const owner of ['AI_SPECTRUM','STRATEGY_AGENT'])for(const [venueType,marketType,currency]of [['CEX','SPOT','USDT'],['CEX','PERPETUAL','USDT'],['DEX','SPOT','USDC'],['DEX','PERPETUAL','USDC']]){
  const {scope,model}=project({owner,venueType,marketType,currency},data);
  assert.equal(model.fills.length,2);assert.equal(model.positions.length,1);assert.equal(model.openOrders.length,1);assert.equal(model.historyOrders.length,2);
  assert.ok([...model.fills,...model.positions,...model.openOrders].every(row=>row.owner===owner&&row.venueType===venueType&&row.marketType===marketType));
  assert.deepEqual(statementScope(statementSearch(scope),base),scope);
 }
 assert.deepEqual(data,before);
 const original=statementExampleSnapshot(),records=statementRecords(original,base),m=projectStatements(records,statementScope('',base));assert.equal(m.fills.length,54);assert.equal(m.net,'124.40940454');assert.equal(m.fees,'45.11417046');
});
test('unknown and conflicting metadata remains visible in All without masquerading as a venue or instrument',()=>{
 const data=statementMarketExampleSnapshot(),o=data.orders[0];delete o.venueId;delete o.venueType;delete o.profileId;delete o.marketType;delete o.venue;
 const f=data.flow.fills.find(row=>row.orderId===o.id);delete f.venueId;delete f.venueType;delete f.profileId;delete f.marketType;delete f.venue;
 let p=project({},data);assert.equal(p.records.orders.find(row=>row.id===o.id).venueType,null);assert.equal(p.records.orders.find(row=>row.id===o.id).marketType,null);assert.ok(p.model.fills.some(row=>row.id===f.id));
 assert.ok(!project({venueType:'CEX'},data).model.fills.some(row=>row.id===f.id));
 o.marketType='PERPETUAL';o.profileId='cex-spot';assert.equal(project({},data).records.orders.find(row=>row.id===o.id).marketType,null);
});
test('open orders and current positions survive historical date filtering without entering settled PnL',()=>{
 const data=statementMarketExampleSnapshot(),p=project({from:'2020-01-01',to:'2020-01-31'},data);
 assert.equal(p.model.fills.length,0);assert.equal(p.model.events.length,0);assert.equal(p.model.net,'0');assert.equal(p.model.openOrders.length,2);assert.equal(p.model.positions.length,2);
 const before=project({},data).model.net;data.positions.forEach(row=>row.unrealizedPnl=999999);data.orders.filter(row=>row.status==='open').forEach(row=>row.qty=99999);assert.equal(project({},data).model.net,before);
});
test('standalone funding is accounted once, revisions win, rate is not an amount, and account/env/owner isolate',()=>{
 const data=statementMarketExampleSnapshot(),p=project({marketType:'PERPETUAL',venueType:'CEX'},data),f=data.flow.ledger.find(row=>row.type==='FUNDING');
 assert.equal(p.model.funding.filter(row=>row.type==='FUNDING').length,1);assert.equal(f.amount,'-0.176');assert.equal(p.model.net,'30.048');
 data.flow.ledger.push({...f,revision:2,amount:'-0.2'});data.flow.ledger.push({...f,revision:1,amount:'-99'});
 assert.equal(project({marketType:'PERPETUAL',venueType:'CEX'},data).model.net,'30.024');
 for(const change of [{accountId:'OTHER'},{environment:'LIVE'},{tradeOwner:'STRATEGY_AGENT'}]){
  const other=statementMarketExampleSnapshot(),row=other.flow.ledger.find(e=>e.type==='FUNDING');Object.assign(row,change);
  assert.equal(project({marketType:'PERPETUAL',venueType:'CEX'},other).model.funding.filter(e=>e.type==='FUNDING').length,0);
 }
});
test('DEX native gas remains in its own currency and blocks a misleading converted net',()=>{
 const p=project({venueType:'DEX',marketType:'SPOT',currency:'USDC'});assert.equal(p.model.foreignCosts,2);assert.equal(p.model.net,null);
 const order=p.records.orders.find(row=>row.venueType==='DEX'&&row.marketType==='SPOT'&&row.status==='filled');
 const html=statementDetail(order,p.scope,true);assert.match(html,/0.00008 ETH/);assert.match(html,/review-only-/);assert.match(html,/Arbitrum/);assert.match(html,/最少收到|Minimum received/);
});
test('PERP open/close, order side, position direction and leverage stay distinct in records and details',()=>{
 const p=project({venueType:'DEX',marketType:'PERPETUAL',currency:'USDC'}),opening=p.model.fills.find(row=>row.intent==='open'),closing=p.model.fills.find(row=>row.intent==='close');
 assert.equal(opening.side,'sell');assert.equal(opening.direction,'short');assert.equal(opening.closing,false);assert.equal(closing.side,'buy');assert.equal(closing.closing,true);
 assert.match(statementDetail(opening,p.scope,true),/开空|Open short/);assert.match(statementDetail(closing,p.scope,true),/平空|Close short/);
 const html=statementDetail(p.model.positions[0],p.scope,true);assert.match(html,/3×/);assert.match(html,/空单|Short/);assert.match(html,/未实现盈亏|Unrealized PnL/);assert.match(html,/0.01%/);
});
test('position snapshot normalizes native Agent lots, never infers ownership from a UI entry or closed fill',()=>{
 const data=statementMarketExampleSnapshot();data.positions=[];let p=project({},data);assert.equal(p.model.positions.length,0);
 data.botBook.runs[0].quantity=.1;data.botBook.runs[0].costBasis=7000;data.botBook.runs[0].markPrice=71000;data.botBook.runs[0].inventoryValue=7100;data.botBook.runs[0].unrealizedPnl=100;
 p=project({owner:'STRATEGY_AGENT'},data);assert.equal(p.model.positions.length,1);assert.equal(p.model.positions[0].entryPrice,'70000');assert.equal(p.model.positions[0].unrealizedPnl,'100');
 assert.equal(project({owner:'AI_SPECTRUM'},data).model.positions.length,0);
});
test('UTC labels cover half-hour zones and DST while preserving historical date boundaries',()=>{
 assert.equal(statementZoneLabel('Asia/Shanghai'),'UTC+8');assert.equal(statementZoneLabel('Asia/Kolkata'),'UTC+5:30');assert.equal(statementZoneLabel('America/St_Johns',Date.parse('2026-01-01')),'UTC-3:30');
 assert.equal(statementZoneLabel('America/New_York',Date.parse('2026-07-01')),'UTC-4');assert.equal(statementZoneLabel('America/New_York',Date.parse('2026-12-01')),'UTC-5');assert.equal(statementZoneLabel('UTC'),'UTC+0');
 const data=statementExampleSnapshot(),records=statementRecords(data,base),ny=statementScope('',{...base,timeZone:'America/New_York'}),sh=statementScope('',base);
 assert.equal(projectStatements(records,ny).net,projectStatements(records,sh).net);assert.notDeepEqual(projectStatements(records,ny).days,projectStatements(records,sh).days);
 const d=statementMarketExampleSnapshot();d.flow.ledger=d.flow.ledger.filter(r=>r.type==='FUNDING');d.flow.fills=[];d.orders=[];d.botBook.runs=[];
 const event=d.flow.ledger[0];event.recordedAt=Date.parse('2026-11-01T04:00:00Z');d.flow.ledger.push({...event,id:'DST-END',economicEventId:'DST-END',recordedAt:Date.parse('2026-11-02T04:59:59.999Z')},{...event,id:'NEXT-DAY',economicEventId:'NEXT-DAY',recordedAt:Date.parse('2026-11-02T05:00:00Z')});
 const p=project({timeZone:'America/New_York',from:'2026-11-01',to:'2026-11-01'},d);assert.equal(p.model.events.length,2);assert.equal(p.model.net,'-0.352');
});
test('daily curve honors inclusive range endpoints, zero-activity days and daily versus cumulative totals',()=>{
 const p=project({},statementExampleSnapshot());p.scope.from='2026-10-11';p.scope.to='2026-11-09';p.model=projectStatements(p.records,p.scope);
 assert.deepEqual([statementCurveRange(p.model,p.scope).from,statementCurveRange(p.model,p.scope).to],['2026-10-11','2026-11-09']);
 const empty=statementCurveDay(p.model,p.scope,'2026-10-11');assert.equal(empty.net,'0');assert.equal(empty.fills,0);
 const last=statementCurveDay(p.model,p.scope,'2026-11-09');assert.equal(last.net,'6.4824786');assert.equal(last.cumulative,p.model.net);assert.equal(last.fills,2);
 assert.equal(statementCurveDay(p.model,p.scope,'2026-11-10'),null);assert.equal(statementCurveDay(p.model,p.scope,'garbage'),null);
 const one={...p.scope,day:'2026-11-09'},m=projectStatements(p.records,one);assert.equal(statementCurveDay(m,one,'2026-11-09').cumulative,m.net);
 const html=statementsView({...p,month:'2026-11'});assert.match(html,/datetime="2026-10-11"/);assert.match(html,/datetime="2026-11-09"/);assert.match(html,/data-st-days="30"/);assert.doesNotMatch(html,/Asia\/Shanghai|st-curve-labels/);
});
test('unclassified standalone funding is reviewable without fabricating a linked order',()=>{
 const d=statementMarketExampleSnapshot(),e=d.flow.ledger.find(row=>row.type==='FUNDING');delete e.tradeOwner;
 const p=project({exceptions:true},d);assert.equal(p.model.events.length,1);assert.equal(p.model.scopedUnknownCount,1);assert.doesNotThrow(()=>statementDetail(p.model.events[0],p.scope));
});

test('non-default market scope survives detail, full-records navigation, day presets and return',async t=>{
 const saved={document:globalThis.document,location:globalThis.location,history:globalThis.history,CSS:globalThis.CSS};
 t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const data={orders:[],flow:{fills:[],ledger:[]},cash:10000,totalFees:0,accountSummary:{accountId:'SIM-01',environment:'DEMO',unit:'USDT'},positions:[],botSummary:{cash:0,equity:0,inventoryValue:0,fees:0,unrealizedPnl:0}},handlers={},routes=[];let html='';
 const host={querySelector:()=>null,set outerHTML(value){html=value;}};
 const doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};
 globalThis.document=doc;globalThis.location={hostname:'127.0.0.1',search:'?page=workbench'};globalThis.CSS={escape:value=>value};globalThis.history={replaceState(){}};
 const root={ownerDocument:doc,scrollTop:50,querySelector:()=>host},dialog={ownerDocument:doc,open:false,classList:{add(){},remove(){}},querySelector:()=>null,addEventListener(){},close(){this.open=false;}};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',source:'LOCAL_FIXTURE',scope:{accountId:'SIM-01',environment:'DEMO'}})},show:(_,body)=>{html=body;dialog.open=true;},navigate:(page,context)=>routes.push({page,context})});
 const action=dataset=>handlers.click({target:{closest:selector=>selector==='[data-statements]'?null:{dataset,closest:()=>({})}},preventDefault(){}});
 controller.open({example:STATEMENT_MARKET_EXAMPLE.id,owner:'STRATEGY_AGENT',venueType:'DEX',marketType:'PERPETUAL',currency:'USDC',timeZone:'Asia/Kolkata',tab:'fills'});
 assert.match(html,/UTC\+5:30/);assert.match(html,/data-st-detail="agents:F-REVIEW-1-dex-perp-1"/);assert.doesNotMatch(html,/data-st-detail="spectrum:/);
 await action({stDetail:'agents:F-REVIEW-1-dex-perp-1'});assert.match(html,/平空|Close short/);await action({stAction:'back-detail'});assert.match(html,/<option value="DEX" selected/);
 await action({stAction:'range',stDays:'7'});assert.match(html,/2026-11-03 – 2026-11-09/);
 await action({stAction:'full'});let url=routes.at(-1).context.search;for(const [field,value]of Object.entries({st_venue:'DEX',st_market:'PERPETUAL',st_owner:'STRATEGY_AGENT',st_currency:'USDC',st_zone:'Asia/Kolkata',st_example:STATEMENT_MARKET_EXAMPLE.id}))assert.equal(new URLSearchParams(url).get(field),value);
 html=controller.page(url);assert.match(html,/<option value="DEX" selected/);assert.match(html,/data-st-detail="agents:F-REVIEW-1-dex-perp-1"/);await action({stAction:'return'});assert.equal(routes.at(-1).context.search,'?page=workbench');
 controller.open({example:STATEMENT_MARKET_EXAMPLE.id,owner:'AI_SPECTRUM',currency:'USDT'});const field={dataset:{stFilter:'venueType'},value:'DEX',closest(){return this;}};handlers.change({target:{closest:()=>field}});assert.match(html,/<option value="USDC" selected/);
 controller.open({example:STATEMENT_MARKET_EXAMPLE.id,owner:'AI_SPECTRUM'});assert.match(html,/<option value="" selected/);
 handlers.change({target:{closest:()=>field}});assert.match(html,/<option value="" selected/);assert.match(html,/data-st-detail="spectrum:F-REVIEW-0-dex-spot-1"/);assert.match(html,/data-st-detail="spectrum:F-REVIEW-0-dex-perp-1"/);
});

test('curve supports pointer and keyboard day inspection without changing ledger or selected filters',async t=>{
 const saved={document:globalThis.document,location:globalThis.location};t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 const data=statementExampleSnapshot(),before=structuredClone(data),handlers={};
 const doc={activeElement:null,body:{dataset:{page:'logs'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};globalThis.document=doc;globalThis.location={search:'?page=logs'};
 const dialog={addEventListener(){},classList:{add(){},remove(){}}},root={ownerDocument:doc,querySelector:()=>null};
 const controller=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'LIVE',scope:base})}});
 controller.page('?page=logs&st_from=2026-10-11&st_to=2026-11-09&st_zone=Asia%2FShanghai');
 const tip={style:{}},line={style:{}},chart={dataset:{from:'2026-10-11',to:'2026-11-09'}},attrs={},plot={dataset:{},clientWidth:660,closest:()=>chart,querySelector:s=>s.includes('tooltip')?tip:line,getBoundingClientRect:()=>({left:0,width:660}),setAttribute:(k,v)=>attrs[k]=v,contains:()=>false};
 handlers.pointermove({target:{closest:()=>plot},clientX:660});assert.equal(plot.dataset.day,'2026-11-09');assert.match(tip.innerHTML,/\+6.48/);assert.match(tip.innerHTML,/\+124.41/);assert.equal(tip.hidden,false);
 handlers.keydown({target:{closest:()=>plot},key:'Home',preventDefault(){}});assert.equal(plot.dataset.day,'2026-10-11');assert.match(tip.innerHTML,/0.00/);
 handlers.keydown({target:{closest:()=>plot},key:'End',preventDefault(){}});assert.equal(attrs['aria-valuenow'],'29');handlers.keydown({target:{closest:()=>plot},key:'Escape'});assert.equal(tip.hidden,true);assert.deepEqual(data,before);
});

test('positionId-only snapshots have distinct stable detail keys and unknown PERP settlement is never calculated',()=>{
 const accountId='review-only',raw={accountId,environment:'DEMO',tradeOwner:'AI_SPECTRUM',venueType:'CEX',marketType:'PERPETUAL',market:'BTC/USD',direction:'long',qty:2,entryPrice:100,markPrice:110,currency:'BTC',contractType:'INVERSE'};
 const data={accountSummary:{accountId,environment:'DEMO'},positions:[{...raw,positionId:'position-one'},{...raw,positionId:'position-two',qty:3},{...raw}]};
 const records=statementRecords(data),scope=statementScope('',{accountId,environment:'DEMO',currency:'BTC'});
 assert.equal(records.positions.length,2);assert.equal(new Set(records.positions.map(row=>row.key)).size,2);
 for(const row of records.positions){assert.equal(row.runId,'');assert.equal(row.notional,null);assert.equal(row.unrealizedPnl,null);assert.equal(row.quantityAsset,'');const detail=statementDetail(row,scope);assert.doesNotMatch(detail,/20.00 BTC|220.00 BTC|2 BTC/);}
 const selected=records.positions.find(row=>row.key.includes('position-two'));assert.equal(selected.quantity,'3');assert.match(statementDetail(selected,scope),/3 /);
 data.positions[0].notional='220';data.positions[0].notionalCurrency='USD';data.positions[0].unrealizedPnl='.002';
 const supplied=statementRecords(data).positions.find(row=>row.key.includes('position-one'));assert.equal(supplied.notional,'220');assert.equal(supplied.notionalCurrency,'USD');assert.equal(supplied.unrealizedPnl,'0.002');
 delete data.positions[1].contractType;assert.equal(statementRecords(data).positions.find(row=>row.key.includes('position-two')).unrealizedPnl,null);
});

test('unavailable exact-order entry never dereferences a stale projection; positionId details return to their own item',async t=>{
 const saved={document:globalThis.document,location:globalThis.location,CSS:globalThis.CSS};t.after(()=>{for(const[k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
 const handlers={},doc={activeElement:null,body:{dataset:{page:'workbench'}},addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>[]};globalThis.document=doc;globalThis.location={search:'?page=workbench'};globalThis.CSS={escape:value=>value};
 let data=null,html='',focusSelector='';const root={ownerDocument:doc,scrollTop:0,querySelector:()=>null},dialog={ownerDocument:doc,open:false,classList:{add(){},remove(){}},querySelector:s=>({focus(){focusSelector=s;}}),addEventListener(){}};
 const ctl=createStatements({root,dialog,desk:{readSnapshot:()=>data,syncStatus:()=>({state:'UNAVAILABLE',scope:base})},show:(_,body)=>{html=body;dialog.open=true;}});
 assert.doesNotThrow(()=>ctl.open({query:'missing-order',tab:'orders'}));assert.match(html,/记录暂不可用|Records unavailable/);
 data={accountSummary:base,positions:[{...base,tradeOwner:'AI_SPECTRUM',positionId:'one',market:'BTC/USD',marketType:'PERPETUAL',currency:'BTC',qty:2,entryPrice:100,markPrice:110},{...base,tradeOwner:'AI_SPECTRUM',positionId:'two',market:'BTC/USD',marketType:'PERPETUAL',currency:'BTC',qty:3,entryPrice:101,markPrice:112}]};
 ctl.open({tab:'positions',currency:'BTC'});const second=statementRecords(data,base).positions.find(p=>p.key.includes('two'));
 const click=dataset=>handlers.click({target:{closest:s=>s==='[data-statements]'?null:{dataset,closest:()=>({})}},preventDefault(){}});
 await click({stDetail:second.key});assert.match(html,/3 /);assert.match(html,/101/);assert.doesNotMatch(html,/112 BTC|3 BTC/);await click({stAction:'back-detail'});assert.ok(focusSelector.includes(second.key));assert.match(html,/data-st-tab="positions" aria-pressed="true"/);
 data=null;assert.doesNotThrow(()=>ctl.open({query:'stale',tab:'orders'}));assert.match(html,/记录暂不可用|Records unavailable/);assert.doesNotMatch(html,/data-st-detail/);
});

test('DEX receipt legs keep the received asset and only applicable detail fields are shown',()=>{
 const {scope,model}=project({venueType:'DEX',marketType:'SPOT',currency:'USDC'});
 const sell=model.fills.find(row=>row.side==='sell'),buy=model.fills.find(row=>row.side==='buy');
 assert.equal(sell.outputAmount,890);assert.equal(sell.outputAsset,'USDC');assert.equal(sell.minReceived,885.55);
 assert.equal(buy.outputAmount,.4);assert.equal(buy.outputAsset,'WETH');
 const detail=statementDetail(sell,scope,true);assert.match(detail,/890 USDC/);assert.doesNotMatch(detail,/890 WETH/);
 const perp=project({owner:'STRATEGY_AGENT',venueType:'DEX',marketType:'PERPETUAL',currency:'USDC',tab:'positions'});
 const positionDetail=statementDetail(perp.model.positions[0],perp.scope,true);
 assert.match(positionDetail,/空单|Short/);assert.doesNotMatch(positionDetail,/支付数量|收到数量|滑点上限|最少收到|Amount sent|Amount received|Slippage tolerance|Minimum received/);
 const html=statementsView({...perp,month:'2026-11',calendar:true});assert.doesNotMatch(html,/Hyperliquid · Hyperliquid/);
 const orderDetail=statementDetail(perp.model.openOrders[0],perp.scope,true);assert.match(orderDetail,/委托数量|Order quantity/);assert.match(orderDetail,/152 USDC/);
});
