import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createManagedWealthStore,validateWealthConfig,allocationPreview,liveFundingGate,WEALTH_ACCOUNT_KEY} from './wealth-account.mjs';
const config=JSON.parse(await readFile(new URL('../../任务/2026-11-11_AI理财/wealth-admin-config.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(config);
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),data};};

test('admin configuration binds products, portfolios and strategies and rejects invalid admission limits',()=>{
 assert.equal(validateWealthConfig(config),config);
 for(const mutate of [
  c=>c.portfolios[0].allocations[0].weightBps=4600,
  c=>c.portfolios[0].allocations[0].productId='unlisted',
  c=>c.strategies[0].portfolioId='missing',
  c=>c.guards.allowLeverage=true,
  c=>c.guards.maxProductBps=4000,
  c=>c.asset.decimals=18,
  c=>c.fees.performanceRate=NaN,
  c=>c.products.push({...c.products[0]})
 ]){const c=copy();mutate(c);assert.throws(()=>validateWealthConfig(c),/CONFIG/);}
});

test('allocation is a preview only and conserves integer units with rounding',()=>{
 assert.deepEqual(allocationPreview(config,1_000_001).map(row=>row.units),[450000,450000,100001]);
 assert.deepEqual(allocationPreview(config,0).map(row=>row.units),[0,0,0]);
 assert.throws(()=>allocationPreview(config,1.1),/AMOUNT/);
});

test('wallet login or published metadata never grants a live funding capability',()=>{
 assert.equal(liveFundingGate(config),'CONFIG_NOT_PUBLISHED');
 const c=copy();c.status='published';assert.equal(liveFundingGate(c),'FUNDING_DISABLED');
 c.liveEnabled=true;assert.equal(liveFundingGate(c),'VAULT_NOT_READY');
 c.asset.tokenAddress='0x1111111111111111111111111111111111111111';
 c.vault={address:'0x2222222222222222222222222222222222222222',spender:'0x2222222222222222222222222222222222222222'};
 assert.equal(liveFundingGate(c),'ADAPTER_UNAVAILABLE');
});

test('authorization alone moves no money; funding is exact, idempotent and stays pending AI allocation',()=>{
 const book=createManagedWealthStore(storage()),id=book.authorize(config,'100',1000);
 assert.equal(book.read().cashUnits,10_000_000_000);assert.equal(book.read().pendingUnits,0);
 assert.throws(()=>book.confirmFunding(id,config,'101',1001),/AUTH_CHANGED/);
 const changed=copy();changed.fees.version='proposal-2';
 assert.throws(()=>book.confirmFunding(id,changed,'100',1001),/AUTH_CHANGED/);
 const state=book.confirmFunding(id,config,'100',1001);
 assert.equal(state.cashUnits,9_900_000_000);assert.equal(state.pendingUnits,100_000_000);
 assert.equal(state.events.length,1);assert.equal(state.intents[0].status,'funded');
 assert.deepEqual(book.confirmFunding(id,config,'100',9999999),state);
 assert.equal('investedUnits' in state,false);
});

test('expired, paused, excess-balance and below-minimum funding fail without moving cash',()=>{
 const book=createManagedWealthStore(storage()),id=book.authorize(config,'100',1000);
 assert.throws(()=>book.confirmFunding(id,config,'100',601000),/AUTH_EXPIRED/);
 const paused=copy();paused.status='paused';assert.throws(()=>book.authorize(paused,'100',1000),/PAUSED/);
 assert.throws(()=>book.authorize(config,'10001',1000),/BALANCE/);
 assert.throws(()=>book.authorize(config,'99',1000),/MINIMUM/);
 assert.throws(()=>book.authorize(config,'1e3',1000),/AMOUNT/);
 assert.equal(book.read().pendingUnits,0);
});

test('account limit and wallet cash are rechecked after an earlier authorization',()=>{
 const c=copy();c.maximumUnits=150_000_000;
 const book=createManagedWealthStore(storage()),first=book.authorize(c,'100',1000),second=book.authorize(c,'100',1001);
 book.confirmFunding(first,c,'100',1002);
 assert.throws(()=>book.confirmFunding(second,c,'100',1003),/LIMIT/);
 assert.equal(book.read().pendingUnits,100_000_000);
});

test('partial account withdrawal preserves remaining lot watermarks and is idempotent by request',()=>{
 const book=createManagedWealthStore(storage()),id=book.authorize(config,'100',1000);
 book.confirmFunding(id,config,'100',1001);
 const state=book.withdraw('25','withdraw-1',1002);
 assert.equal(state.cashUnits,9_925_000_000);assert.equal(state.pendingUnits,75_000_000);
 assert.equal(state.intents[0].remainingUnits,75_000_000);assert.equal(state.intents[0].highWaterMark,1);
 assert.deepEqual(book.withdraw('25','withdraw-1',1003),state);
 assert.throws(()=>book.withdraw('26','withdraw-1',1003),/REQUEST/);
 book.withdraw('75','withdraw-2',1004);
 assert.equal(book.read().cashUnits,10_000_000_000);assert.equal(book.read().pendingUnits,0);
 assert.equal(book.read().events.length,3);
});

test('failed persistence never reports funding success or consumes cash, and old product history is untouched',()=>{
 const local=storage(),legacy='{"keep":"original product history"}';local.setItem('astarter.wealth.paper.v1',legacy);
 const book=createManagedWealthStore(local),id=book.authorize(config,'100',1000),before=local.getItem(WEALTH_ACCOUNT_KEY);
 local.setItem=()=>{};
 assert.throws(()=>book.confirmFunding(id,config,'100',1001),/STORAGE/);
 assert.equal(local.getItem(WEALTH_ACCOUNT_KEY),before);assert.equal(book.read().cashUnits,10_000_000_000);
 assert.equal(local.getItem('astarter.wealth.paper.v1'),legacy);
});

test('corrupt account state is reported rather than reset or shown as a zero balance',()=>{
 const local=storage();local.setItem(WEALTH_ACCOUNT_KEY,'{"version":1,"cashUnits":0}');
 assert.throws(()=>createManagedWealthStore(local).read(),/STORAGE/);
 assert.equal(local.getItem(WEALTH_ACCOUNT_KEY),'{"version":1,"cashUnits":0}');
});


test('pending cash remains withdrawable when the management configuration is paused',()=>{
 const book=createManagedWealthStore(storage()),id=book.authorize(config,'100',1000);
 book.confirmFunding(id,config,'100',1001);
 const paused=copy();paused.status='paused';assert.throws(()=>book.authorize(paused,'100',1002),/PAUSED/);
 assert.equal(book.withdraw('100','exit-paused',1003).cashUnits,10_000_000_000);
});

test('malformed withdrawal request identity is rejected on reload',()=>{
 const local=storage(),book=createManagedWealthStore(local),id=book.authorize(config,'100',1000);
 book.confirmFunding(id,config,'100',1001);book.withdraw('25','exit-1',1002);
 const state=JSON.parse(local.getItem(WEALTH_ACCOUNT_KEY));delete state.events[1].requestId;
 local.setItem(WEALTH_ACCOUNT_KEY,JSON.stringify(state));assert.throws(()=>book.read(),/STORAGE/);
});
