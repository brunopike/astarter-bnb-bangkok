import assert from 'node:assert/strict';
import test from 'node:test';
import {PUBLIC_ETH_ACTIVE_BALANCE_SOURCE,publicEthActiveBalanceRequest,normalizeEthActiveBalance,validateEthActiveBalance} from './public-eth-consensus.mjs';

const SLOT=15679616,EPOCH=489988,AS_OF=1606824023000+EPOCH*384000,NOW=AS_OF+1200000;
const root='0x'+'a'.repeat(64),stateRoot='0x'+'b'.repeat(64);
const header=(patch={})=>JSON.stringify({execution_optimistic:false,finalized:true,data:{root,canonical:true,header:{message:{slot:String(SLOT),proposer_index:'2014243',parent_root:'0x'+'c'.repeat(64),state_root:stateRoot,body_root:'0x'+'d'.repeat(64)},signature:'0x'+'e'.repeat(192)}},...patch});
const aggregate=(value='44345549000000001')=>' {"data":{"current_epoch_active_gwei":'+value+',"current_epoch_target_attesting_gwei":42925392000000000,"previous_epoch_target_attesting_gwei":44241516000000000,"previous_epoch_head_attesting_gwei":44138672000000000}}';
const raw=()=>[header(),aggregate()];

test('fixed mainnet source rejects arbitrary query inputs and collect requests only finalized header then its epoch',async()=>{
 const req=publicEthActiveBalanceRequest(new URLSearchParams());assert.equal(req.resource,'eth-active-balance');assert.equal(req.policy,PUBLIC_ETH_ACTIVE_BALANCE_SOURCE);assert.equal(req.policy.interval,384000);assert.equal(req.policy.stale,1800000);
 for(const query of ['epoch=0','url=https://bad.test','network=sepolia','resource=eth-active-balance'])assert.equal(publicEthActiveBalanceRequest(new URLSearchParams(query)),null);
 const specs=[],times=[NOW-1000,NOW-900,NOW];
 const body=await req.collect(async spec=>{specs.push(spec);return specs.length===1?header():aggregate();},()=>times.shift());
 assert.deepEqual(specs,[{url:'https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/headers/finalized',format:'text',maxBytes:10000},{url:'https://ethereum-beacon-api.publicnode.com/lighthouse/validator_inclusion/489988/global',format:'text',maxBytes:10000}]);
 assert.equal(body.requestStartedAt,NOW-1000);assert.equal(body.receivedAt,NOW);assert.equal(validateEthActiveBalance(body,NOW),true);
});
test('raw unsafe JSON integers retain exact gwei and decimal ETH without float rounding',()=>{
 const body=normalizeEthActiveBalance(raw(),NOW,NOW-8000);
 assert.equal(body.activeEffectiveGwei,'44345549000000001');assert.equal(body.activeEffectiveEth,'44345549.000000001');assert.equal(body.epoch,EPOCH);assert.equal(body.finalizedSlot,SLOT);assert.equal(body.blockRoot,root);assert.equal(body.stateRoot,stateRoot);assert.equal(body.sourceAsOf,AS_OF);assert.equal(body.validUntil,AS_OF+1800000);
 assert.equal(body.symbol,'ETH');assert.equal(body.unit,'ETH');assert.equal(body.source,'PublicNode');assert.equal(body.sourceUrl,'https://ethereum-beacon-api.publicnode.com');
 assert.deepEqual(body.coverage,{scope:'ETHEREUM_ACTIVE_EFFECTIVE_BALANCE',network:'Ethereum mainnet',balanceBasis:'active_effective_gwei',finality:'provider_reported_finalized',actualPrincipal:false});
 assert.equal(body.totalStaked,undefined);assert.equal(body.validatorCount,undefined);assert.equal(body.executionAuthority,undefined);
 const strings=normalizeEthActiveBalance([header(),aggregate('"44345549000000000"')],NOW);assert.equal(strings.activeEffectiveEth,'44345549');
 assert.equal(normalizeEthActiveBalance([header(),aggregate('1').replace('42925392000000000','0')],NOW).activeEffectiveEth,'0.000000001');
});
test('non-finalized, optimistic, noncanonical and malformed headers fail before an aggregate request',async()=>{
 for(const mutate of [h=>{h.finalized=false;},h=>{h.execution_optimistic=true;},h=>{h.data.canonical=false;},h=>{h.data.header.message.slot='489988/../head';},h=>{h.data.root='0x1';},h=>{h.data.header.message.state_root='https://bad.test';},h=>{delete h.finalized;}]){
  const h=JSON.parse(header());mutate(h);let calls=0;
  await assert.rejects(publicEthActiveBalanceRequest(new URLSearchParams()).collect(async()=>{calls++;return JSON.stringify(h);},()=>NOW),/INVALID_ETH_ACTIVE_BALANCE/);assert.equal(calls,1);
 }
});
test('malformed, missing, unsafe pre-parsed, fractional, exponential or out-of-range balances never become zero',()=>{
 for(const value of ['0','-1','1.5','4.4345549e16','18446744073709551616','null','true','"01"','"-1"','"unknown"'])assert.throws(()=>normalizeEthActiveBalance([header(),aggregate(value)],NOW),/INVALID_ETH_ACTIVE_BALANCE/);
 for(const value of [{error:'unavailable'},JSON.parse(aggregate()),'[]','{}','{"data":{}}',aggregate().replace('"previous_epoch_head_attesting_gwei"','"unknown"'),aggregate().slice(0,-1)])assert.throws(()=>normalizeEthActiveBalance([header(),value],NOW),/INVALID_ETH_ACTIVE_BALANCE/);
 assert.throws(()=>normalizeEthActiveBalance([header(),aggregate().replace('42925392000000000','44345549000000002')],NOW),/INVALID_ETH_ACTIVE_BALANCE/);
});
test('epoch time and original deadline stay fixed; old or future finalized headers are rejected as fresh inputs',async()=>{
 const body=normalizeEthActiveBalance(raw(),NOW);
 assert.equal(validateEthActiveBalance(body,body.validUntil),true);assert.equal(body.validUntil,AS_OF+1800000);
 assert.throws(()=>normalizeEthActiveBalance(raw(),body.validUntil),/INVALID_ETH_ACTIVE_BALANCE/);
 assert.throws(()=>normalizeEthActiveBalance(raw(),AS_OF-1001),/INVALID_ETH_ACTIVE_BALANCE/);
 for(const [at,start]of [[NOW+.5,NOW],[NOW,NOW+1],[NOW,NOW-8001],[0,0],[NaN,NOW]])assert.throws(()=>normalizeEthActiveBalance(raw(),at,start),/INVALID_ETH_ACTIVE_BALANCE/);
 let calls=0;await assert.rejects(publicEthActiveBalanceRequest(new URLSearchParams()).collect(async()=>{calls++;return header();},()=>AS_OF+1800000),/INVALID_ETH_ACTIVE_BALANCE/);assert.equal(calls,1);
});
test('failed second source and late completion propagate without retries or fresh empty snapshots',async()=>{
 const req=publicEthActiveBalanceRequest(new URLSearchParams());let calls=0;
 await assert.rejects(req.collect(async()=>{calls++;if(calls===1)return header();throw Error('SOURCE_UNAVAILABLE');},()=>NOW),/SOURCE_UNAVAILABLE/);assert.equal(calls,2);
 const times=[NOW-8001,NOW-8000,NOW];calls=0;await assert.rejects(req.collect(async()=>++calls===1?header():aggregate(),()=>times.shift()),/INVALID_ETH_ACTIVE_BALANCE/);assert.equal(calls,2);
});
test('snapshot validator recomputes units, coverage and source clock without granting authority',()=>{
 const original=normalizeEthActiveBalance(raw(),NOW,NOW-1000);assert.equal(validateEthActiveBalance(original,NOW),true);assert.equal(validateEthActiveBalance(original,NOW-1001),false);
 for(const patch of [b=>{b.activeEffectiveEth='44345549';},b=>{b.activeEffectiveGwei='4e16';},b=>{b.source='Beaconcha.in';},b=>{b.sourceUrl='https://bad.test';},b=>{b.finalizedSlot+=32;},b=>{b.epoch++;},b=>{b.sourceAsOf++;},b=>{b.validUntil++;},b=>{b.coverage.actualPrincipal=true;},b=>{b.coverage.finality='independently_verified';},b=>{b.executionAuthority='TRADE';},b=>{b.blockRoot='0x0';}]){
  const body=structuredClone(original);patch(body);assert.equal(validateEthActiveBalance(body,NOW),false);
 }
});
