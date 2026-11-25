import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWealthPublicMarket,wealthMarketFailure,WEALTH_MARKET_ASSETS} from './wealth-market-data.mjs';

const NOW=Date.UTC(2026,10,17,12);
function sample(){return {schema:'wealth-public-market-v1',mode:'cloud-readonly',readOnly:true,realFundingEnabled:false,testFundingEnabled:false,modelEnabled:false,trackingEnabled:false,assetId:'usdc',status:'observed',error:null,observation:{id:'aave-1-usdc-4660',kind:'market',status:'observed',provider:'Aave V3 · Ethereum',assetId:'usdc',chainId:1,blockNumber:'4660',blockHash:'0x'+'a'.repeat(64),asOf:NOW,receivedAt:NOW,expiresAt:NOW+300000,reserveUpdatedAt:NOW,aprPercent:'4.465853',aprBps:446,availableLiquidityUnits:'123456789000',active:true,frozen:false,paused:false,url:'https://etherscan.io/block/4660',contractUrl:'https://etherscan.io/address/0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',admission:'research_only'}};}
const rejected=run=>assert.throws(run,error=>['MARKET_INVALID','MARKET_STALE'].includes(error.code));

test('public projection binds its fixed source and capabilities without mutating the original observation',()=>{
 const input=sample(),value=validateWealthPublicMarket(input,'usdc',NOW);assert.deepEqual(value,input);value.observation.aprPercent='1';assert.equal(input.observation.aprPercent,'4.465853');assert.deepEqual(Object.keys(WEALTH_MARKET_ASSETS),['usdc','usdt','weth','wbtc']);
 for(const key of ['realFundingEnabled','testFundingEnabled','modelEnabled','trackingEnabled'])rejected(()=>validateWealthPublicMarket({...sample(),[key]:true},'usdc',NOW));
 rejected(()=>validateWealthPublicMarket({...sample(),readOnly:false},'usdc',NOW));
});
test('asset, chain, block identity, source links and source time cannot be swapped or refreshed',()=>{
 for(const patch of [{assetId:'usdt'},{chainId:31337},{blockHash:['0x'+'a'.repeat(64)]},{blockHash:'0x123'},{blockNumber:'04660'},{id:'invented-source'},{provider:'Other pool'},{url:'https://other.example'},{contractUrl:'https://etherscan.io/address/0x'+'b'.repeat(40)},{admission:'funding_allowed'},{asOf:NOW+31000,expiresAt:NOW+331000},{receivedAt:NOW+31000},{reserveUpdatedAt:NOW+1000}]){
  const value=sample();Object.assign(value.observation,patch);rejected(()=>validateWealthPublicMarket(value,'usdc',NOW));
 }
 assert.throws(()=>validateWealthPublicMarket(sample(),'usdc',NOW+180001),{code:'MARKET_STALE'});rejected(()=>validateWealthPublicMarket(sample(),'weth',NOW));
});
test('APR fractions and integer liquidity preserve asset units and reject unbounded or incoherent values',()=>{
 for(const patch of [{aprPercent:'<img>'},{aprPercent:'NaN'},{aprPercent:'10001'},{aprPercent:'4.4658531'},{aprPercent:'04.4'},{aprBps:445},{aprBps:446.5},{availableLiquidityUnits:'-1'},{availableLiquidityUnits:'1.5'},{availableLiquidityUnits:(1n<<256n).toString()},{paused:'false'}]){
  const value=sample();Object.assign(value.observation,patch);rejected(()=>validateWealthPublicMarket(value,'usdc',NOW));
 }
 const zero=sample();Object.assign(zero.observation,{aprPercent:'0',aprBps:0,availableLiquidityUnits:'0'});assert.equal(validateWealthPublicMarket(zero,'usdc',NOW).observation.aprPercent,'0');
});
test('extra private, account or authority fields and accessors cannot enter the public schema',()=>{
 let calls=0;
 for(const key of ['walletBalance','nav','ownerRef','token','account','executionAuthority']){
  const value=sample();value[key]='untrusted';rejected(()=>validateWealthPublicMarket(value,'usdc',NOW));const nested=sample();nested.observation[key]='untrusted';rejected(()=>validateWealthPublicMarket(nested,'usdc',NOW));
 }
 const value=sample();Object.defineProperty(value,'assetId',{enumerable:true,get(){calls++;return 'usdc';}});rejected(()=>validateWealthPublicMarket(value,'usdc',NOW));assert.equal(calls,0);
});
test('unavailable states contain no observed APR, invented balances or raw upstream diagnostics',()=>{
 const value=wealthMarketFailure('usdc','MARKET_TIMEOUT');assert.deepEqual(validateWealthPublicMarket(value,'usdc',NOW),value);assert.equal(value.observation,null);
 assert.equal(wealthMarketFailure('usdc','secret upstream details').error,'MARKET_UNAVAILABLE');rejected(()=>validateWealthPublicMarket({...value,observation:sample().observation},'usdc',NOW));rejected(()=>validateWealthPublicMarket({...value,error:'unknown error'},'usdc',NOW));
});
