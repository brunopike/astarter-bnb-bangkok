import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingDemo,DEFAULT_CONNECTIONS,pendingStrategyApproval} from './trading-demo.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
import {strategySuggestions,startStrategyWatch} from './strategy-journeys.mjs';
import {strategyApprovalView} from './execution-views.mjs';
import {ExecutionFeed} from './execution-stream.mjs';

const context={ready:true,market:'BTC/USDT',revision:'research:1',price:81218.87};
const draft={strategy:'S03',market:'BTC/USDT',mode:'review',amount:100,cap:500,version:1};
const advance=(trade,seconds)=>{for(let i=0;i<Math.ceil(seconds*10);i++)trade.tick(.1,context);};
function waiting(){const trade=new TradingDemo();assert.equal(trade.start(draft,DEFAULT_CONNECTIONS,context),null);advance(trade,5);return trade;}

test('automatic mode uses the same plan and submits without an entry approval',()=>{
 const trade=new TradingDemo();assert.equal(trade.start({...draft,mode:'auto'},DEFAULT_CONNECTIONS,context),null);
 advance(trade,7);assert.equal(pendingStrategyApproval(trade),null);
 assert.equal(trade.orders.length,1);assert.equal(trade.orders[0].market,'BTC/USDT');
 assert.equal(trade.session.amount,100);assert.equal(trade.session.cap,500);
});
test('approval mode waits for the exact entry, then submits only once',()=>{
 const trade=waiting(),proposal=pendingStrategyApproval(trade);
 assert.ok(proposal);assert.equal(proposal.market,'BTC/USDT');assert.equal(trade.orders.length,0);
 assert.match(trade.submit(),/批准/);
 assert.match(trade.approve('replaced-signal'),/变化|失效/);assert.equal(trade.orders.length,0);
 assert.equal(trade.approve(proposal.id),null);assert.equal(trade.orders.length,1);
 assert.match(trade.approve(proposal.id),/变化|失效/);assert.equal(trade.orders.length,1);
});
test('expired or changed plans cannot be approved',()=>{
 const expired=waiting(),id=expired.signal.id;advance(expired,31);
 assert.equal(expired.orders.length,0);assert.match(expired.approve(id),/变化|失效/);
 const changed=waiting(),proposal=changed.signal.id;changed.session.amount=200;
 assert.match(changed.approve(proposal),/变化|失效/);assert.equal(changed.orders.length,0);
 const research=waiting(),signal=research.signal.id;research.session.researchRevision='research:2';
 assert.match(research.approve(signal),/变化|失效/);assert.equal(research.orders.length,0);
});
test('skip and pause invalidate approval; approved position exits do not await another approval',()=>{
 const skipped=waiting(),id=skipped.signal.id;assert.equal(skipped.skip(id),null);
 assert.equal(skipped.orders.length,0);assert.match(skipped.approve(id),/变化|失效/);
 const paused=waiting(),pid=paused.signal.id;paused.pause();assert.equal(pendingStrategyApproval(paused),null);assert.match(paused.approve(pid),/变化|失效/);
 const trade=waiting();assert.equal(trade.approve(trade.signal.id),null);advance(trade,22);
 assert.ok(trade.orders.some(order=>order.side==='sell'));assert.equal(trade.position,null);
});
test('new BOT plans require plan approval while legacy runs retain their shared approval panel',()=>{
 const w=new WorkspaceSim(),d=w.draft();assert.equal(w.saveDraft(d.id,{...d,mode:'auto',market:'BTC/USDT',executionRoute:{profileId:'cex-spot',venueId:'binance',accountId:'SIM-01',connectionId:'legacy-exchange',chainId:''}}),null);
 assert.ok(w.validateSetup().run);for(let i=0;i<50;i++)w.tick(.1);
 let policy=null,armed=false;const desk={snapshot:()=>({state:'idle',connections:DEFAULT_CONNECTIONS,discovery:{armed,status:'watching',accountId:policy?.executionRoute.accountId,draftId:policy?.id,version:policy?.version,connectionId:policy?.executionRoute.connectionId,requestId:policy?.botLaunch.requestId}}),configure:value=>policy=value,arm:value=>{assert.equal(value,policy);armed=true;return null;}};
 assert.equal(startStrategyWatch(w,desk),null);assert.equal(policy.mode,'auto');assert.equal(policy.market,'BTC/USDT');
 const trade=waiting(),html=strategyApprovalView(trade);
 assert.match(html,/approval-accept/);assert.match(html,new RegExp(trade.signal.id));assert.match(html,/100 USDT/);
 trade.pause();assert.equal(strategyApprovalView(trade),'');
});
test('research suggestions retain their original asset and never pretend all official templates can execute',()=>{
 const research=new MultiResearch(),w=new WorkspaceSim({research});research.advance(90);
 const suggestions=strategySuggestions(w),eth=suggestions.find(row=>row.symbol==='ETH');
 assert.ok(eth);assert.equal(eth.strategy,'RX03-S');assert.equal(eth.available,false);
 assert.ok(suggestions.every(row=>row.symbol!=='XAU'));
 assert.equal(suggestions.find(row=>row.symbol==='BTC').available,true);
});
test('arming and pausing a strategy publishes the changed discovery state to the controls',()=>{
 const feed=new ExecutionFeed(),trade={time:0,seq:0,state:'idle',orders:[],discovery:{armed:false,message:'idle'}};
 feed.publish(trade);assert.equal(feed.data.discovery.armed,false);
 feed.publish({...trade,discovery:{armed:true,message:'watching'}});
 assert.equal(feed.data.discovery.armed,true);
 feed.publish(trade);assert.equal(feed.data.discovery.armed,false);
});
test('a waiting approval publishes its actual remaining seconds without a new market event',()=>{
 const feed=new ExecutionFeed(),trade={time:10,seq:1,state:'running',orders:[],signal:{id:'approval-1',approval:{expiresAt:40}}};
 feed.publish(trade);feed.publish({...trade,time:11.2});assert.equal(feed.data.time,11.2);
});
