import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchInsights,workbenchAccount,WorkbenchInsightHistory} from './workbench-insights.mjs';
const task={symbol:'BTC',domain:'Crypto',version:1,phase:'collect',evidence:[{key:'trend',status:'collected',text:'价格结构待确认'}]};

test('market view is read-only and never substitutes crypto data for TradFi',()=>{
 assert.deepEqual(workbenchInsights({task}).marketConfig,{market:'BTC/USDT',period:'1H',profileId:'cex-spot',venueId:'binance',trade:null});
 for(const symbol of ['SPX','NDX','XAU','DXY','US10Y']){
  const config=workbenchInsights({task:{...task,symbol,domain:'TradFi'}}).marketConfig;
  assert.equal(config.market,symbol);assert.equal(config.period,'1D');assert.equal(config.sessionBased,true);
  assert.equal(config.venueId,'yahoo');assert.equal(config.trade,null);
 }
 assert.equal(workbenchInsights({task:{...task,symbol:'UNKNOWN'}}).marketConfig,null);
 assert.equal(workbenchInsights({task:{...task,symbol:'XAU',domain:'TradFi'}}).evidence.find(item=>item.key==='chain').status,'na');
 assert.equal(workbenchInsights().capital.equity,null);
});

test('account allocation uses the ledger and held reservations without invented returns',()=>{
 const trade={cash:9800,position:{qty:2,price:100},totalFees:1,flow:{reservations:[{state:'HELD',unit:'USDT',amount:50},{state:'RELEASED',unit:'USDT',amount:80}]}};
 const before=structuredClone(trade),c=workbenchInsights({task,trade,risk:{cap:1000,dailyLoss:100}}).capital;
 assert.equal(c.equity,10000);assert.equal(c.held,200);assert.equal(c.reserved,50);assert.equal(c.available,9750);assert.equal(c.accountCap,1000);assert.equal(c.fees,1);
 assert.deepEqual(trade,before);assert.equal(c.cap,null);assert.equal(c.stopLoss,null);
});

test('selected research cannot inherit another asset or an unrelated run',()=>{
 const trade={cash:10000,session:{id:'run-eth',market:'ETH/USDT',cap:500,amount:100,ticket:{stopLoss:2900,takeProfit:3400}},orders:[{runId:'run-eth',filled:1},{runId:'old',filled:1}]};
 assert.equal(workbenchInsights({task,trade,focus:{linked:true,task}}).capital.runId,null);
 const eth={...task,symbol:'ETH'},focus={linked:true,task:eth};
 const c=workbenchInsights({task:eth,trade,focus}).capital;assert.equal(c.runId,'run-eth');assert.equal(c.cap,500);assert.equal(c.stopLoss,2900);assert.equal(c.filledOrders,1);
 assert.equal(workbenchInsights({task:eth,trade,focus:{...focus,linked:false}}).capital.stopLoss,null);
 assert.equal(workbenchInsights({task:eth,trade:{...trade,state:'paused'},focus}).capital.runState,'paused');
 assert.equal(workbenchInsights({task:eth,trade:{...trade,state:'stopped'},focus}).capital.runState,'stopped');
});

test('only changed evidence produces events, not every timer tick',()=>{
 const history=new WorkbenchInsightHistory();assert.deepEqual(history.record(task,100),[]);
 assert.deepEqual(history.record(task,110),[]);
 const next={...task,evidence:[{key:'trend',status:'retain',text:'价格结构已确认'}]};
 const events=history.record(next,112);assert.equal(events.length,1);assert.equal(events[0].from,'collected');assert.equal(events[0].to,'retain');assert.equal(events[0].at,112);
 assert.deepEqual(history.record(next,130),events);
});

test('evidence replacement and the next research round stay visible without fake timestamps',()=>{
 const history=new WorkbenchInsightHistory();history.record(task,2696);
 const next={...task,version:2,reason:'新资料到达',evidence:[{key:'trend',status:'collected',text:'另一来源待确认'}]};
 const events=history.record(next,2699);assert.equal(events.length,2);assert.ok(events.every(event=>event.at===2699));assert.ok(events.some(event=>event.type==='research'));assert.ok(events.some(event=>event.type==='evidence'));
});

test('a replacement source remains visible even when the conclusion is unchanged',()=>{
 const history=new WorkbenchInsightHistory(),original={...task,evidence:[{key:'trend',status:'retain',text:'结构得到支持',sourceId:'a',source:'来源 A'}]};
 history.record(original,30);
 const replacement={...original,evidence:[{...original.evidence[0],sourceId:'b',source:'来源 B'}]};
 const events=history.record(replacement,34);
 assert.equal(events.length,1);assert.equal(events[0].type,'evidence');assert.equal(events[0].source,'来源 B');assert.equal(events[0].from,'retain');assert.equal(events[0].to,'retain');
});

test('pause, asset switches and a clock reset do not replay fabricated transitions',()=>{
 const history=new WorkbenchInsightHistory();history.record(task,10);const updated={...task,phase:'complete',outcome:'watch'};
 assert.deepEqual(history.record(updated,20,true),[]);assert.deepEqual(history.record(updated,21),[]);
 assert.deepEqual(history.record({...task,symbol:'ETH'},22),[]);
 const events=history.record({...updated,phase:'collect',version:2},23);assert.ok(events.length>0);assert.ok(events.every(event=>event.symbol==='BTC'));
 assert.deepEqual(history.record(task,0),[]);
});


test('capital chart reflects ledger amounts including empty and over-reserved accounts',()=>{
 const allocation=trade=>workbenchInsights({task,trade}).capital;
 const funded=allocation({cash:800,position:{qty:2,price:100},flow:{reservations:[{state:'HELD',unit:'USDT',amount:100}]}});
 assert.deepEqual(funded.allocation.map(b=>[b.key,b.value,b.level]),[['available',700,1],['held',200,200/700],['reserved',100,100/700]]);
 assert.equal(funded.allocationMax,700);
 assert.deepEqual(allocation(null).allocation,[]);
 assert.ok(allocation({cash:0}).allocation.every(b=>b.value===0&&b.level===0));
 const excess=allocation({cash:100,flow:{reservations:[{state:'HELD',unit:'USDT',amount:200}]}});
 assert.equal(excess.allocation[0].value,0);assert.equal(excess.allocation[2].value,200);assert.equal(excess.allocation[2].level,1);
});

test('capital uses the shared account book without treating BOT allocation as a loss',()=>{
 const trade={cash:9000,totalFees:0,botSummary:{cash:1000,equity:1000,inventoryValue:0,fees:0,unrealizedPnl:0},accountSummary:{accountId:'SIM-01',environment:'DEMO',available:8500}};
 const saved=structuredClone(trade),c=workbenchAccount(trade);
 assert.equal(c.equity,10000);assert.equal(c.cash,10000);assert.equal(c.available,8500);assert.equal(c.reserved,1500);assert.equal(c.pnl,0);assert.equal(c.realized,0);assert.equal(c.unrealized,0);assert.deepEqual(trade,saved);
 const profitable=workbenchAccount({...trade,totalFees:2,botSummary:{cash:800,equity:1100,inventoryValue:300,fees:3,unrealizedPnl:70}});
 assert.equal(profitable.pnl,100);assert.equal(profitable.realized,30);assert.equal(profitable.unrealized,70);assert.equal(profitable.fees,5);assert.equal(profitable.realized+profitable.unrealized,profitable.pnl,'fees are already included, never subtracted twice');
 const losing=workbenchAccount({...trade,botSummary:{cash:800,equity:970,inventoryValue:170,fees:3,unrealizedPnl:-20}});
 assert.equal(losing.pnl,-30);assert.equal(losing.realized,-10);
});
test('legacy spot never claims a fabricated realized/unrealized split',()=>{
 const c=workbenchAccount({cash:9799,position:{qty:2,price:100,markPrice:120},totalFees:1});
 assert.equal(c.equity,9999);assert.equal(c.pnl,-1);assert.equal(c.spotUnmarked,true);assert.equal(c.realized,null);assert.equal(c.unrealized,null);
 const perp=workbenchAccount({cash:9900,totalFees:0,position:{marketType:'PERPETUAL',qty:1,price:100,markPrice:120,margin:100,direction:'long'}});
 assert.equal(perp.pnl,20);assert.equal(perp.realized,0);assert.equal(perp.unrealized,20);
});
test('unknown, broken and other-account data never becomes a valid zero profit',()=>{
 for(const trade of [null,{cash:NaN},{cash:10000,cashKnown:false},{cash:10000,botSummary:{recoveryError:'unreadable'}},{cash:10000,botSummary:{equity:NaN}},{cash:10000,position:{qty:1,price:NaN}},{cash:10000,flow:{reservations:[{state:'HELD',unit:'USDT',amount:'bad'}]}}])assert.equal(workbenchAccount(trade).known,false);
 const other=workbenchAccount({cash:5000,totalFees:0,accountSummary:{accountId:'OTHER',environment:'DEMO'}});assert.equal(other.known,true);assert.equal(other.pnl,null);assert.equal(other.realized,null);assert.equal(other.unrealized,null);
 const incomplete=workbenchAccount({cash:9000,totalFees:0,botSummary:{cash:500,equity:1050,inventoryValue:550}});assert.equal(incomplete.pnl,50);assert.equal(incomplete.unrealized,null);
});
