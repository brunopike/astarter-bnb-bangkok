import test from 'node:test';
import assert from 'node:assert/strict';
import {publicEthExitsRequest, validateEthExits} from './public-eth-exits.mjs';

const slot = 15679712, asOf = 1606824023000 + slot * 12000, now = asOf + 720000;
const root = '0x' + 'a'.repeat(64), state = '0x' + 'b'.repeat(64);
const head = () => ({finalized:true, execution_optimistic:false, data:{root,canonical:true,header:{signature:'0x'+'d'.repeat(192),message:{
  slot:String(slot),proposer_index:'12',state_root:state,parent_root:root,body_root:root}}}});
const row = (id, effective) => ({index:String(id),balance:'1234',status:'active_exiting',validator:{
  pubkey:'0x'+String(id).padStart(96,'0'),slashed:false,activation_epoch:'0',exit_epoch:'500000',withdrawable_epoch:'500256',effective_balance:String(effective)}});
const records = () => ({finalized:true,execution_optimistic:false,data:[row(1,32000000000),row(2,1569000000000)]});
const req = () => publicEthExitsRequest(new URLSearchParams());
function collect(h = head(), rows = records(), ts = now) {
  let calls = 0;
  return req().collect(async() => JSON.stringify(++calls === 1 ? h : rows), () => ts);
}

test('server binds filtered rows to the finalized state root, caches for one epoch and only returns totals',async()=>{
  const specs = [], request = req();
  assert.equal(request.resource,'eth-validator-exits');
  assert.equal(request.policy.interval,384000);
  assert.equal(publicEthExitsRequest(new URLSearchParams('status=active')),null);
  assert.equal(publicEthExitsRequest(new URLSearchParams('url=https://bad.test/')),null);
  const body = await request.collect(async spec => {specs.push(spec);return JSON.stringify(specs.length===1?head():records());},()=>now);
  assert.deepEqual(specs,[
    {url:'https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/headers/finalized',format:'text',maxBytes:10000},
    {url:'https://ethereum-beacon-api.publicnode.com/eth/v1/beacon/states/'+state+'/validators?status=active_exiting',format:'text',maxBytes:6*1024*1024}
  ]);
  assert.equal(body.validatorCount,2);
  assert.equal(body.effectiveEth,'1601');
  assert.equal(body.effectiveGwei,'1601000000000');
  assert.equal(body.sourceAsOf,asOf);
  assert.equal(body.finalizedSlot,slot);
  assert.equal(body.coverage.balanceBasis,'effective_balance_gwei');
  assert.doesNotMatch(JSON.stringify(body),/pubkey|withdrawable_epoch/);
  assert.ok(validateEthExits(body,now));
});
test('empty filtered queue is valid and distinct from upstream errors or truncated input',async()=>{
  const empty = records();empty.data = [];
  const body = await collect(head(),empty);assert.equal(body.validatorCount,0);assert.equal(body.effectiveEth,'0');
  await assert.rejects(req().collect(async s => {if(s.url.includes('/headers/'))return JSON.stringify(head());throw Error('SOURCE_UNAVAILABLE');},()=>now),/SOURCE_UNAVAILABLE/);
  await assert.rejects(req().collect(async s=>s.url.includes('/headers/')?JSON.stringify(head()):'{',()=>now));
  await assert.rejects(req().collect(async s=>s.url.includes('/headers/')?JSON.stringify(head()):' '.repeat(6*1024*1024+1),()=>now),/INVALID_ETH_VALIDATOR_EXITS/);
});
test('rejects duplicate identities, wrong statuses, slashes, malformed balances or epochs and partial pages',async()=>{
  for(const mutate of [
    b=>{b.data[1].index='1';}, b=>{b.data[1].validator.pubkey=b.data[0].validator.pubkey;}, b=>{b.data[0].status='active_slashed';},
    b=>{b.data[0].validator.slashed=true;}, b=>{b.data[0].validator.effective_balance='2049000000000';},
    b=>{b.data[0].validator.effective_balance='3e10';}, b=>{b.data[0].validator.activation_epoch='500000';},
    b=>{b.data[0].validator.exit_epoch='18446744073709551615';}, b=>{b.data[0].validator.exit_epoch='1';},
    b=>{b.data[0].validator.withdrawable_epoch='1';}, b=>{b.finalized=false;}, b=>{b.execution_optimistic=true;}, b=>{b.next_page_token='more';}
  ]) {
    const b=records();mutate(b);await assert.rejects(collect(head(),b),/INVALID_ETH_VALIDATOR_EXITS/);
  }
});
test('rejects stale or invalid source before requesting validators; verifies receipt against original slot',async()=>{
  for(const mutate of [h=>{h.finalized=false;},h=>{h.execution_optimistic=true;},h=>{h.data.canonical=false;},
    h=>{h.data.header.message.state_root='../head';},h=>{h.data.header.message.slot=String(slot+1000);},h=>{h.data.header.message.slot=String(slot-300);}]){
    const h=head();mutate(h);let calls=0;
    await assert.rejects(req().collect(async()=>{calls++;return JSON.stringify(h);},()=>now),/INVALID_ETH_VALIDATOR_EXITS/);
    assert.equal(calls,1);
  }
  const b=await collect();
  assert.ok(validateEthExits(b,now+86400000));
  assert.equal(b.validUntil,asOf+1800000);
  for(const patch of [{effectiveEth:'64'},{validatorCount:0},{validUntil:now+1800000},{sourceAsOf:now},
    {sourceUrl:'https://example.com'},{stateRoot:'0x1'},{coverage:{...b.coverage,includesWithdrawalSweep:true}},{rows:[]}]){
    assert.equal(validateEthExits({...b,...patch},now),false);
  }
});
