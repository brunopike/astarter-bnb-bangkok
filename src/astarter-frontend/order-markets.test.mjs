import test from 'node:test';
import assert from 'node:assert/strict';
import {TradingDemo,DEFAULT_CONNECTIONS} from './trading-demo.mjs';
import {orderAuthorizationKey,orderWalletStep,orderMarket,orderTerms,marketTicketError} from './order-markets.mjs';
import {executionView} from './execution-views.mjs';
import {DEFAULT_SCOPE} from './execution-stream.mjs';
import {tradeAnalytics,assetsView,logsView} from './product-views.mjs';
const ctx={market:'ETH/USDT',price:100,ready:true,revision:'test-ETH:1'};
const draft={market:ctx.market,strategy:'S03',mode:'confirm',amount:100,cap:1000};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const step=(d,n=3,c=ctx)=>{for(let i=0;i<n*10;i++)d.tick(.1,c);};
const make=(profileId,direction='long',leverage=3)=>{const t={profileId,direction,leverage:profileId.endsWith('perp')?leverage:1,amount:100,cap:1000,sourceId:ctx.revision,revision:ctx.revision,quotePrice:100,quotedAt:0,maxGap:.5,stopLoss:direction==='short'?102:98,takeProfit:direction==='short'?96:104,slippage:.5,walletConnected:true,walletAuthorized:true,rpcReady:true};t.network=orderMarket(t).chain;t.authorizationKey=orderAuthorizationKey(t);return t;};
for(const profile of ['cex-spot','cex-perp','dex-spot','dex-perp'])for(const direction of profile.endsWith('perp')?['long','short']:['long']){
 test(`${profile} ${direction}: one entry, typed ledger, close once, realized cash reconciles`,()=>{
  const d=new TradingDemo(),t=make(profile,direction),p=orderMarket(t),v=orderTerms(t);assert.equal(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,t),null);
  const view=executionView({data:d,status:{state:'LIVE',scope:DEFAULT_SCOPE,lastSyncedAt:0}});assert.ok(view.includes(`<dt>资产</dt><dd>${d.orders[0].displayMarket}</dd>`));assert.ok(view.includes(p.venue));assert.ok(view.includes(p.venueType));if(profile==='dex-spot')assert.ok(view.includes('WETH/USDC'));
  const other=executionView({data:d,status:{state:'LIVE',scope:DEFAULT_SCOPE},marketFilter:profile==='dex-perp'?'cex-spot':'dex-perp',credits:{start:4}});assert.match(other,/此市场没有运行中的 Agent/);assert.doesNotMatch(other,/<section class="execution-summary"|<section class="execution-followup"/);
  assert.equal(d.orders[0].venueId,p.venueId);assert.equal(d.flow.plans[0].marketType,p.marketType);step(d);
  near(d.cash,10000-100-v.fee-v.gas);near(d.position.qty,v.quantity);near(d.equity,10000-v.fee-v.gas);
  assert.equal(tradeAnalytics({...d,flow:d.flow}).reconciles,true);
  const end=t.takeProfit;assert.equal(d.triggerProtection('takeProfit',end),null);assert.equal(d.orders[0].reduceOnly,profile.endsWith('perp'));step(d,3,{...ctx,price:end});
  assert.equal(d.position,null);assert.equal(d.orders.length,2);near(d.cash,10000+v.quantity*Math.abs(end-100)-v.fee-v.quantity*end*p.feeRate-v.gas*2);
  near(d.cash,10000+Number(d.records.totals.cashDelta));assert.equal(tradeAnalytics({...d,flow:d.flow}).reconciles,true);assert.ok(d.flow.reservations.every(r=>r.state==='RELEASED'));
  assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,{...t,quotedAt:d.time}));assert.equal(d.orders.length,2);
 });
}
test('DEX output protection is based on accepted quote, not the new price',()=>{const d=new TradingDemo(),t={...make('dex-spot'),slippage:.1};assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,{...ctx,price:100.4},t));assert.equal(d.orders.length,0);near(d.cash,10000);});
test('wallet checks stop wrong network, rejected authorization, disconnect and changed scope before billing',()=>{for(const patch of [{walletConnected:false},{walletAuthorized:false},{walletRefused:true},{rpcReady:false},{network:'Ethereum'},{amount:200}]){const d=new TradingDemo(),t={...make('dex-perp'),...patch};let billed=0;assert.ok(d.quickOrder({...draft,amount:t.amount},DEFAULT_CONNECTIONS,ctx,t,()=>billed++));assert.equal(billed,0);assert.equal(d.orders.length,0);}});
test('changing reviewed DEX costs, protection, wallet or quote never reuses the old authorization',()=>{
 for(const patch of [{slippage:1},{stopLoss:97},{takeProfit:105},{quotePrice:100.1},{quotedAt:-.1},{walletIdentity:'another-wallet'},{accountId:'another-account'},{market:'BTC/USDT'}]){
  const d=new TradingDemo(),ticket={...make('dex-spot'),...patch};let billed=0;
  assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,ticket,()=>billed++),JSON.stringify(patch));
  assert.equal(d.orders.length,0);assert.equal(billed,0);near(d.cash,10000);
 }
});
test('spot cannot open short; wrapped route does not silently pretend SOL is on Arbitrum',()=>{assert.ok(marketTicketError(make('dex-spot','short'),100,{market:'ETH/USDT'}));assert.ok(marketTicketError(make('dex-spot'),100,{market:'SOL/USDT'}));});
test('DEX is atomic, cannot cancel broadcast and revert consumes gas exactly once',()=>{const d=new TradingDemo();d.orderScenario='dex-revert';d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('dex-spot'));step(d,1.5);assert.equal(d.flow.fills.length,0);assert.equal(d.pending.status,'confirming');assert.ok(d.cancel());step(d,3);assert.equal(d.orders[0].status,'rejected');near(d.cash,9999.75);assert.equal(d.position,null);assert.equal(d.flow.ledger.filter(e=>e.type==='GAS').length,1);});
test('DEX unknown receipt keeps original order and gas; reconciliation does not double submit',()=>{const d=new TradingDemo();d.orderScenario='unknown';d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('dex-spot'));step(d);assert.ok(d.cancel());assert.equal(d.pending.status,'unknown');d.deliverReceipt();d.reconcile();step(d);assert.equal(d.orders.length,1);assert.equal(d.flow.fills.length,1);assert.equal(d.flow.ledger.filter(e=>e.type==='GAS').length,1);d.replayFill();near(d.cash,9899.45);});
test('late entry and exit fees stay reserved and cannot fund a new position',()=>{const d=new TradingDemo();d.cash=100.2;d.orderScenario='late-fee';d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('cex-spot'));step(d);d.closePosition();step(d);near(d.availableCash,100);const t=make('cex-spot');t.sourceId='next';t.quotedAt=d.time;assert.ok(d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,t));d.deliverFees();near(d.cash,100);near(d.availableCash,100);});
test('isolated gap settlement includes closing fees within allocated margin',()=>{const d=new TradingDemo();d.cash=100.5;d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('cex-perp','short',10));step(d);step(d,4,{...ctx,price:150});assert.equal(d.position,null);near(d.cash,0);near(d.cash,100.5+Number(d.records.totals.cashDelta));});
test('manual spot close uses the latest sample price; aggregate view distinguishes margin from notional',()=>{const d=new TradingDemo();d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('cex-spot'));step(d);step(d,.2,{...ctx,price:103});d.closePosition();assert.equal(d.orders[0].price,103);const p=new TradingDemo();p.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('dex-perp','short'));step(p);const snapshot={...p,flow:p.flow};assert.match(assetsView({d:snapshot}),/逐仓保证金/);assert.match(logsView({d:snapshot,rows:p.orders,filter:'全部'}),/Hyperliquid · DEX PERP/);});

test('DEX exit with no gas stays unbroadcast and never creates negative cash',()=>{const d=new TradingDemo();d.cash=100.55;d.quickOrder(draft,DEFAULT_CONNECTIONS,ctx,make('dex-spot'));step(d);d.orderScenario='dex-revert';assert.ok(d.closePosition());assert.equal(d.orders.length,1);assert.equal(d.pending,null);near(d.cash,0);near(d.position.qty,1);assert.equal(d.flow.ledger.filter(x=>x.type==='GAS').length,1);});

test('the primary DEX action follows account, network and current trade review without granting authority',()=>{
 const t=make('dex-spot'),before=JSON.stringify(t);
 assert.equal(orderWalletStep(t),null);assert.equal(JSON.stringify(t),before);
 assert.equal(orderWalletStep({...t,walletConnected:false}),'connect');
 assert.equal(orderWalletStep({...t,network:'Ethereum'}),'network');
 assert.equal(orderWalletStep({...t,rpcReady:false}),'reconnect');
 for(const patch of [{walletAuthorized:false},{walletRefused:true},{stopLoss:97},{quotePrice:101}])assert.equal(orderWalletStep({...t,...patch}),'review');
 assert.equal(orderWalletStep({...make('cex-spot'),walletConnected:false}),null);
});

test('wallet approval is invalidated when the explicit connection changes within one account',()=>{
 const ticket={...make('dex-spot'),accountId:'SIM-01',connectionId:'wallet-main'};
 ticket.authorizationKey=orderAuthorizationKey(ticket);assert.equal(orderWalletStep(ticket),null);
 assert.equal(orderWalletStep({...ticket,connectionId:'wallet-other'}),'review');
});
