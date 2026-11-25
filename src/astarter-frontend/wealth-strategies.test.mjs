import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DAY_MS} from './wealth-fees.mjs';
import {STRATEGY_ACCOUNT_KEY,ASSET_SPECS,parseStrategyAmount,formatStrategyUnits,validateStrategyConfig,selectedStrategy,strategyFundingGate,buildAllocationPlan,strategyBalance,createStrategyWealthStore} from './wealth-strategies.mjs';
const config=JSON.parse(await readFile(new URL('../../任务/2026-11-11_AI理财/wealth-strategy-config.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(config);
function local(){const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};}
function fund(book,profile='balanced',asset='usdc',amount='100',time=1000,c=config){const auth=book.authorize(c,profile,asset,amount,time);book.confirmFunding(auth,c,profile,asset,amount,time+1);return auth;}

test('four strategies have explicit risk, assets, independent fee terms and no guarantee',()=>{
 assert.equal(validateStrategyConfig(config),config);
 assert.deepEqual(config.profiles.map(p=>[p.id,p.risk]),[['growth','high'],['balanced','medium'],['steady','low'],['defensive','defensive']]);
 assert.deepEqual(config.assets.map(a=>[a.symbol,a.decimals]),[['USDC',6],['USDT',6],['WETH',18],['WBTC',8]]);
 assert.equal(new Set(config.profiles.map(p=>p.fees.version)).size,4);
 assert.equal(config.profiles.every(p=>p.principalGuaranteed===false),true);
 assert.equal(config.profiles.every(p=>p.fees.managementRate===.02&&p.fees.subscriptionRate===0),true);
 assert.equal(new Set(config.profiles.map(p=>p.terms.lockDays)).size,4);
});
test('unlisted assets, bad weights, excessive concentration and false principal guarantees are rejected',()=>{
 const cases=[
  c=>c.assets[2].decimals=6,
  c=>c.chain.id=8453,
  c=>c.profiles[0].allocations.weth[0].weightBps=3501,
  c=>c.profiles[0].guards.maxProductBps=3400,
  c=>c.profiles[1].guards.reserveBps=1100,
  c=>c.profiles[0].guards.allowLeverage=true,
  c=>c.profiles[0].allocations.weth[0].productId='missing',
  c=>c.profiles[3].principalGuaranteed=true,
  c=>c.profiles[3].allocations.usdc[0].productId='term-yield',
  c=>c.profiles[3].assetIds.push('weth'),
  c=>c.profiles[0].fees.performanceRate=NaN,
  c=>c.assets.push({...c.assets[0]})
 ];
 for(const mutate of cases){const c=clone();mutate(c);assert.throws(()=>validateStrategyConfig(c),/CONFIG/);}
 assert.throws(()=>selectedStrategy(config,'steady','weth'),/SELECTION/);
 assert.throws(()=>selectedStrategy(config,'missing','usdc'),/SELECTION/);
});
test('six, eight and eighteen decimal amounts use exact integers rather than floating point',()=>{
 assert.equal(parseStrategyAmount('100.123456',6),'100123456');
 assert.equal(parseStrategyAmount('0.12345678',8),'12345678');
 assert.equal(parseStrategyAmount('1.000000000000000001',18),'1000000000000000001');
 assert.equal(formatStrategyUnits('1000000000000000001',18),'1.000000000000000001');
 assert.equal(formatStrategyUnits('10000123000',6),'10,000.123');
 assert.equal(formatStrategyUnits('10000123000',6,false),'10000.123');
 for(const value of ['0','-1','1e3','1,000','01','1.0000001','NaN','9'.repeat(110)])assert.throws(()=>parseStrategyAmount(value,6),/AMOUNT/);
 assert.throws(()=>parseStrategyAmount((1n<<256n).toString(),0),/AMOUNT/);
});
test('allocation plans conserve every wei and assign rounding residue to the reserve',()=>{
 const eth=buildAllocationPlan(config,'growth','weth','0.010000000000000001');
 assert.deepEqual(eth.allocations.map(row=>row.units),['3500000000000000','3000000000000000','2500000000000000','1000000000000001']);
 assert.equal(eth.amountUnits,'10000000000000001');
 const btc=buildAllocationPlan(config,'growth','wbtc','0.12345678');
 assert.deepEqual(btc.allocations.map(row=>row.units),['4938271','3703703','2469135','1234569']);
 assert.equal(eth.allocations.at(-1).productId,'cash-reserve');
});
test('previewing an allocation neither creates an authority nor moves any wallet funds',()=>{
 const store=local(),book=createStrategyWealthStore(store),before=book.read();
 const plan=buildAllocationPlan(config,'balanced','usdc','100');
 assert.deepEqual(plan.allocations.map(row=>row.units),['35000000','30000000','25000000','10000000']);
 assert.deepEqual(book.read(),before);assert.equal(store.getItem(STRATEGY_ACCOUNT_KEY),null);
});
test('authorisation binds strategy, asset, amount, configuration and fee version',()=>{
 const book=createStrategyWealthStore(local()),auth=book.authorize(config,'balanced','usdc','100',1000);
 assert.equal(book.read().events.length,0);assert.equal(book.read().wallet.usdc,'10000000000');
 for(const args of [['steady','usdc','100'],['balanced','usdt','100'],['balanced','usdc','101']])assert.throws(()=>book.confirmFunding(auth,config,...args,1001),/AUTH_CHANGED/);
 const changed=clone();changed.profiles[1].fees.version='balanced-terms-3';
 assert.throws(()=>book.confirmFunding(auth,changed,'balanced','usdc','100',1001),/AUTH_CHANGED/);
 changed.version='draft-new';assert.throws(()=>book.confirmFunding(auth,changed,'balanced','usdc','100',1001),/AUTH_CHANGED/);
 assert.equal(book.read().wallet.usdc,'10000000000');
});
test('four assets retain separate balances and funding creates pending cash only',()=>{
 const book=createStrategyWealthStore(local());
 fund(book,'balanced','usdc','100',1000);
 fund(book,'steady','usdt','123.456789',2000);
 fund(book,'growth','weth','0.100000000000000001',3000);
 fund(book,'growth','wbtc','0.01',4000);
 const state=book.read();
 assert.deepEqual(state.wallet,{usdc:'9900000000',usdt:'9876543211',weth:'9899999999999999999',wbtc:'24000000'});
 assert.equal(strategyBalance(state,'growth','weth').pendingUnits,'100000000000000001');
 assert.equal(strategyBalance(state,'balanced','usdt').pendingUnits,'0');
 assert.equal(state.events.length,4);
 assert.equal(state.intents.every(row=>row.nav===null&&row.highWaterMark===null),true);
 assert.equal('investedUnits' in state,false);
});
test('fund confirmation is idempotent and expiry rejects unfunded intents',()=>{
 const book=createStrategyWealthStore(local()),auth=fund(book);
 const before=book.read();assert.deepEqual(book.confirmFunding(auth,config,'balanced','usdc','100',99999999),before);
 const next=book.authorize(config,'steady','usdc','100',2000);
 assert.throws(()=>book.confirmFunding(next,config,'steady','usdc','100',602000),/AUTH_EXPIRED/);
 assert.equal(book.read().events.length,1);
});
test('wallet cash, min size, paused scope and invalid configuration cannot silently fund',()=>{
 const book=createStrategyWealthStore(local()),paused=clone();paused.status='paused';
 assert.throws(()=>book.authorize(paused,'balanced','usdc','100',1000),/PAUSED/);
 assert.throws(()=>book.authorize(null,'balanced','usdc','100',1000),/CONFIG/);
 assert.throws(()=>book.authorize(config,'balanced','usdc','99',1000),/MINIMUM/);
 assert.throws(()=>book.authorize(config,'balanced','usdc','10001',1000),/BALANCE/);
 assert.throws(()=>book.authorize(config,'growth','weth','0.001',1000),/MINIMUM/);
 assert.throws(()=>book.authorize(config,'growth','wbtc','0.0001',1000),/MINIMUM/);
 assert.throws(()=>book.authorize(config,'balanced','usdc','100',NaN),/TIME/);
 assert.equal(book.read().events.length,0);
});
test('the same-asset cap is rechecked across strategies after earlier authorisations',()=>{
 const c=clone();c.assets[0].maximumUnits='150000000';
 const book=createStrategyWealthStore(local()),first=book.authorize(c,'balanced','usdc','100',1000),second=book.authorize(c,'steady','usdc','100',1001);
 book.confirmFunding(first,c,'balanced','usdc','100',1002);
 assert.throws(()=>book.confirmFunding(second,c,'steady','usdc','100',1003),/LIMIT/);
 assert.equal(book.read().wallet.usdc,'9900000000');
});
test('FIFO partial exits preserve each fee contract and leave other assets untouched',()=>{
 const book=createStrategyWealthStore(local());fund(book,'balanced','usdc','100',1000);
 const c=clone();c.profiles[1].fees.version='balanced-terms-3';c.profiles[1].fees.performanceRate=.15;
 fund(book,'balanced','usdc','200',2000,c);
 const state=book.withdraw('balanced','usdc','150','exit-one',3000);
 assert.deepEqual(state.intents.map(row=>row.remainingUnits),['0','150000000']);
 assert.deepEqual(state.intents.map(row=>[row.fees.version,row.fees.performanceRate]),[['balanced-terms-2',.12],['balanced-terms-3',.15]]);
 assert.deepEqual(state.events.at(-1).lots.map(row=>row.units),['100000000','50000000']);
 assert.equal(state.wallet.usdt,'10000000000');
 book.withdraw('balanced','usdc','150','exit-two',3001);
 assert.equal(book.read().wallet.usdc,'9700000000');
 assert.equal(strategyBalance(book.read(),'balanced','usdc').queuedUnits,'300000000');
 book.settle('exit-one',3000+2*DAY_MS);book.settle('exit-two',3001+2*DAY_MS);
 assert.equal(book.read().wallet.usdc,'10000000000');
 assert.equal(book.read().intents.every(row=>row.highWaterMark===null),true);
});
test('withdrawals remain available without configuration and request replay is scope-specific',()=>{
 const book=createStrategyWealthStore(local());fund(book,'steady','usdt','100');
 const state=book.withdraw('steady','usdt','25','exit',2000);
 assert.deepEqual(book.withdraw('steady','usdt','25','exit',3000),state);
 assert.throws(()=>book.withdraw('balanced','usdt','25','exit',3001),/REQUEST/);
 assert.throws(()=>book.withdraw('steady','usdc','25','exit',3001),/REQUEST/);
 assert.throws(()=>book.withdraw('steady','usdt','26','exit',3001),/REQUEST/);
 book.withdraw('steady','usdt','75','exit-rest',3002);
 book.settle('exit',2000+2*DAY_MS);book.settle('exit-rest',3002+2*DAY_MS);
 assert.equal(book.read().wallet.usdt,'10000000000');
});
test('18-decimal withdrawals preserve individual wei',()=>{
 const book=createStrategyWealthStore(local());fund(book,'growth','weth','0.100000000000000001');
 book.withdraw('growth','weth','0.000000000000000001','one-wei',2000);
 assert.equal(strategyBalance(book.read(),'growth','weth').pendingUnits,'100000000000000000');
 book.withdraw('growth','weth','0.1','rest',2001);
 book.settle('one-wei',2000+2*DAY_MS);book.settle('rest',2001+2*DAY_MS);
 assert.equal(book.read().wallet.weth,'10000000000000000000');
});
test('failed saving reports no success and preserves earlier stored money',()=>{
 const store=local(),book=createStrategyWealthStore(store),auth=book.authorize(config,'balanced','usdc','100',1000),before=store.getItem(STRATEGY_ACCOUNT_KEY);
 store.setItem=()=>{};assert.throws(()=>book.confirmFunding(auth,config,'balanced','usdc','100',1001),/STORAGE/);
 assert.equal(store.getItem(STRATEGY_ACCOUNT_KEY),before);assert.equal(book.read().wallet.usdc,'10000000000');
});
test('corrupt cash, events, lot remainder and fake NAV are rejected without a reset',()=>{
 for(const mutate of [
  s=>s.wallet.usdc='0',
  s=>s.intents[0].highWaterMark=1,
  s=>s.events[0].assetId='usdt',
  s=>s.events[1].lots[0].units='24000000',
  s=>s.intents[0].remainingUnits='76000000',
  s=>s.events.push({...s.events[0]}),
  s=>s.intents[0].fees.version=null
 ]){
  const store=local(),book=createStrategyWealthStore(store);fund(book);book.withdraw('balanced','usdc','25','exit',2000);
  const state=JSON.parse(store.getItem(STRATEGY_ACCOUNT_KEY));mutate(state);const raw=JSON.stringify(state);store.setItem(STRATEGY_ACCOUNT_KEY,raw);
  assert.throws(()=>book.read(),/STORAGE/);assert.equal(store.getItem(STRATEGY_ACCOUNT_KEY),raw);
 }
 const store=local();store.setItem(STRATEGY_ACCOUNT_KEY,'bad JSON');assert.throws(()=>createStrategyWealthStore(store).read(),/STORAGE/);
});
test('legacy product and USDC-only account records are never migrated, merged or overwritten',()=>{
 const store=local(),legacyKeys=['astarter.wealth.paper.v1','astarter.wealth.managed-paper.v1'];
 for(const key of legacyKeys)store.setItem(key,'original:'+key);
 const book=createStrategyWealthStore(store);fund(book,'growth','wbtc','0.01');book.withdraw('growth','wbtc','0.01','exit',2000);
 for(const key of legacyKeys)assert.equal(store.getItem(key),'original:'+key);
});
test('published metadata and wallet login still do not create a live funding adapter',()=>{
 assert.equal(strategyFundingGate(config,'balanced','usdc'),'CONFIG_NOT_PUBLISHED');
 const c=clone();c.status='published';assert.equal(strategyFundingGate(c,'balanced','usdc'),'FUNDING_DISABLED');
 c.liveEnabled=true;assert.equal(strategyFundingGate(c,'balanced','usdc'),'VAULT_NOT_READY');
 c.assets[0].tokenAddress='0x1111111111111111111111111111111111111111';c.vault={address:'0x2222222222222222222222222222222222222222',spender:'0x2222222222222222222222222222222222222222'};
 assert.equal(strategyFundingGate(c,'balanced','usdc'),'ADAPTER_UNAVAILABLE');
});

test('T+2 queue never credits cash early, settlement is exact and idempotent',()=>{
 const book=createStrategyWealthStore(local());fund(book);
 assert.throws(()=>book.withdraw('balanced','usdc','100','past',1000),/TIME/);
 book.withdraw('balanced','usdc','100','t2',2000);
 assert.equal(book.read().wallet.usdc,'9900000000');
 assert.throws(()=>book.settle('t2',2000+2*DAY_MS-1),/SETTLEMENT_PENDING/);
 const settled=book.settle('t2',2000+2*DAY_MS);
 assert.equal(settled.wallet.usdc,'10000000000');assert.deepEqual(book.settle('t2',2000+3*DAY_MS),settled);
});
test('queued withdrawals still consume the same-asset funding cap and term edits invalidate authority',()=>{
 const c=clone();c.assets[0].maximumUnits='150000000';const book=createStrategyWealthStore(local());fund(book,'balanced','usdc','100',1000,c);
 book.withdraw('balanced','usdc','100','out',2000);
 assert.throws(()=>book.authorize(c,'steady','usdc','100',3000),/LIMIT/);
 const auth=book.authorize(config,'steady','usdt','100',4000),changed=clone();changed.profiles[2].terms.lockDays=8;
 assert.throws(()=>book.confirmFunding(auth,changed,'steady','usdt','100',4001),/AUTH_CHANGED/);
});

test('earlier local draft fee snapshots remain readable and unchanged under current rules',()=>{
 const old=clone();old.version='draft-20261112.3';for(const p of old.profiles){delete p.terms.maturityAction;p.fees.crystallisation='monthly-and-redemption';p.fees.version=p.id+'-proposal-1';delete p.fees.managementSettlement;delete p.fees.recipients;}
 const storage=local(),book=createStrategyWealthStore(storage);fund(book,'growth','wbtc','0.01',1000,old);
 const before=book.read().intents[0];book.withdraw('growth','wbtc','0.005','previous',2000);
 assert.equal(book.read().intents[0].fees.crystallisation,'monthly-and-redemption');assert.deepEqual(book.read().intents[0].terms,before.terms);
 fund(book,'balanced','usdc','100',3000);assert.equal(book.read().intents.at(-1).fees.crystallisation,'annual-maturity-and-redemption');
 const invalid=structuredClone(old);invalid.status='published';assert.throws(()=>validateStrategyConfig(invalid),/CONFIG/);
});

