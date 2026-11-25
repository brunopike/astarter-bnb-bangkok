import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceFee,forecastWealth,parseWealthAmount,createWealthStore,WEALTH_PRODUCTS,YIELD_POOLS,productQuote,wealthAssetGroups} from './wealth-data.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};

test('asset summaries separate APR from APY and exclude the research-only leveraged quote',()=>{
 const group=wealthAssetGroups(WEALTH_PRODUCTS).find(row=>row.asset==='USDC');
 assert.equal(group.products.length,7);assert.equal(group.researchCount,1);
 const apy=group.quotes.find(row=>row.metric==='APY'),apr=group.quotes.find(row=>row.metric==='APR');
 close(apy.min,3.791088);close(apy.max,7.6980815);
 close(apr.min,20.65745639692017);close(apr.max,20.65745639692017);
 assert.ok(group.quotes.every(row=>row.max<79.48));
});

test('research-only and unreviewed groups have no purchasable yield range',()=>{
 const research=WEALTH_PRODUCTS.find(row=>row.id==='loop');
 const [group]=wealthAssetGroups([research]);
 assert.equal(group.researchCount,1);assert.deepEqual(group.quotes,[]);
 const [pending]=wealthAssetGroups([{...WEALTH_PRODUCTS[0],status:'pending'}]);
 assert.deepEqual(pending.quotes,[]);
});

test('asset grouping keeps token denominations separate and preserves the caller order',()=>{
 const input=['eth','sol'].map(id=>WEALTH_PRODUCTS.find(row=>row.id===id));
 const groups=wealthAssetGroups(input);
 assert.deepEqual(groups.map(row=>row.asset),['ETH','SOL']);
 close(groups[0].quotes[0].min,2.025567);close(groups[1].quotes[0].min,4.551435);
 assert.deepEqual(input.map(row=>row.id),['eth','sol']);assert.deepEqual(wealthAssetGroups([]),[]);
});

test('high water mark charges only new gains and carries a net-of-fee watermark',()=>{
 const first=performanceFee({shares:10000,nav:1.10,highWaterMark:1,rate:.20});
 close(first.fee,200);close(first.netNav,1.08);close(first.nextHighWaterMark,1.08);
 for(const nav of [.95,1.08])assert.equal(performanceFee({shares:10000,nav,highWaterMark:1.08,rate:.20}).fee,0);
 const next=performanceFee({shares:10000,nav:1.12,highWaterMark:1.08,rate:.20});
 close(next.fee,80);close(next.nextHighWaterMark,1.112);
 assert.equal(performanceFee({shares:10000,nav:next.netNav,highWaterMark:next.nextHighWaterMark,rate:.20}).fee,0);
});

test('partial redemption crystallises only its shares and rejects invalid valuation',()=>{
 close(performanceFee({shares:2500,nav:1.10,highWaterMark:1,rate:.20}).fee,50);
 for(const input of [{shares:0},{nav:NaN},{highWaterMark:-1},{rate:1.1}])assert.throws(()=>performanceFee({shares:100,nav:1.1,highWaterMark:1,rate:.2,...input}));
});

test('amount parsing preserves six decimals and rejects exponents, negatives and excess precision',()=>{
 assert.equal(parseWealthAmount('1.000001'),1000001);assert.equal(parseWealthAmount('10000'),10000000000);
 for(const input of ['',0,'0','-1','1e3','Infinity','NaN','1.0000001','9007199254740991'])assert.throws(()=>parseWealthAmount(input));
});

test('a forecast deducts management before performance fees, with no performance fee on losses',()=>{
 const product={managementRate:.01,performanceRate:.20,allocations:[],maxDays:365};
 const positive=forecastWealth(product,{amount:10000,days:365,annualRate:10,metric:'APR'});
 close(positive.grossProfit,1000);close(positive.managementFee,100);close(positive.performanceFee,180);close(positive.netProfit,720);
 const negative=forecastWealth(product,{amount:10000,days:365,annualRate:-10,metric:'APR'});
 close(negative.netProfit,-1100);assert.equal(negative.performanceFee,0);
 assert.throws(()=>forecastWealth({...product,maxDays:14},{amount:10000,days:30,annualRate:10}));
 assert.throws(()=>forecastWealth(WEALTH_PRODUCTS[0],{amount:100,days:365,annualRate:-99.99}));
});

test('research quotes retain APR/APY, incentive provenance and a complete allocation',()=>{
 assert.ok(WEALTH_PRODUCTS.length>=8);assert.ok(YIELD_POOLS.length>=24);
 for(const product of WEALTH_PRODUCTS){
  assert.equal(product.allocations.reduce((sum,row)=>sum+row.weight,0),100);
  for(const row of product.allocations.filter(row=>row.source!=='cash'))assert.ok(YIELD_POOLS.some(pool=>pool.id===row.source));
  const quote=productQuote(product);assert.ok(Number.isFinite(quote.rate));
  assert.equal(product.principalProtected,false);
 }
 assert.equal(YIELD_POOLS.find(pool=>pool.id==='hlp').metric,'APR');
 assert.ok(WEALTH_PRODUCTS.find(product=>product.id==='maturity').maxDays<=14);
});

test('simulated deposits create separate lots, persist, and leave other currencies alone',()=>{
 const storage=memory(),store=createWealthStore(storage),initial=store.read();
 store.deposit('cash','100',1000);store.deposit('cash','100',2000);
 const state=createWealthStore(storage).read();assert.equal(state.positions.length,2);
 assert.equal(state.cash.USDC,initial.cash.USDC-200000000);assert.equal(state.cash.ETH,initial.cash.ETH);
 assert.equal(state.positions[0].highWaterMark,1);assert.equal(state.positions[1].highWaterMark,1);
 assert.throws(()=>store.deposit('cash','0.01'));assert.throws(()=>store.deposit('cash','20000'));assert.throws(()=>store.deposit('loop','100'));
});

test('partial redemption preserves the remaining lot watermark and cash conservation',()=>{
 const store=createWealthStore(memory());store.deposit('cash','100',1000);
 const lot=store.read().positions[0];store.redeem(lot.id,'25',2000);
 const state=store.read();assert.equal(state.positions[0].units,75000000);assert.equal(state.positions[0].highWaterMark,lot.highWaterMark);
 assert.equal(state.cash.USDC+state.positions[0].units,10000000000);assert.equal(state.events.length,2);
 assert.throws(()=>store.redeem(lot.id,'100'));store.redeem(lot.id,'75');assert.equal(store.read().positions.length,0);
 assert.equal(store.read().cash.USDC,10000000000);
});

test('failed storage does not report a deposit or mutate the account',()=>{
 const storage=memory(),store=createWealthStore(storage);const initial=store.read();
 storage.setItem=()=>{throw new Error('quota');};
 assert.throws(()=>store.deposit('cash','100'));assert.deepEqual(store.read(),initial);
 const corrupt={getItem:()=>'{broken',setItem:()=>assert.fail('must not overwrite corrupt history')};
 assert.throws(()=>createWealthStore(corrupt).read());
});

test('a fractional full redemption uses integer units without a float round trip',()=>{
 const store=createWealthStore(memory());store.deposit('eth','0.12965');
 const lot=store.read().positions[0];assert.equal(lot.units,129650);
 store.redeem(lot.id,'0.12965');assert.equal(store.read().positions.length,0);assert.equal(store.read().cash.ETH,10000000);
});

test('corrupt activity is rejected before a page dereferences its product',()=>{
 const storage=memory(),store=createWealthStore(storage);store.deposit('cash','100');
 const raw=JSON.parse(storage.getItem('astarter.wealth.paper.v1'));
 for(const patch of [{productId:'missing'},{kind:'unknown'},{asset:'ETH'},{units:-1},{at:'bad'}]){
  const state=structuredClone(raw);Object.assign(state.events[0],patch);storage.setItem('astarter.wealth.paper.v1',JSON.stringify(state));assert.throws(()=>store.read());
 }
});
