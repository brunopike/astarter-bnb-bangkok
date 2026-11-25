import test from 'node:test';
import assert from 'node:assert/strict';
import {ETH_DISCLOSED_ADDRESSES as addrs,publicEthDisclosedRequest,validateEthDisclosedBalance,renderEthDisclosedBalance,isEthDisclosedRpcSpec} from './public-eth-disclosed.mjs';
const hash='0x'+'b'.repeat(64),at=1794979560000, now=at+760000;
const head=()=>({jsonrpc:'2.0',id:1,result:{hash,number:'0x19370f0',timestamp:'0x'+(at/1000).toString(16)}});
const rows=()=>[1n,0n,30000000000000000123456n,40000n].map((v,i)=>({jsonrpc:'2.0',id:i+1,result:'0x'+v.toString(16)})).reverse();
const req=()=>publicEthDisclosedRequest(new URLSearchParams());
function run(h=head(),b=rows(),f=()=>{}){let n=0;return req().collect(async s=>{f(s);return ++n===1?h:b;},()=>now);}
test('restricts both reads, uses the same canonical finalized hash and exact wei regardless of RPC row order',async()=>{
  const specs=[],d=await run(undefined,undefined,s=>specs.push(s));
  assert.equal(publicEthDisclosedRequest(new URLSearchParams('address=other')),null);
  assert.ok(specs.every(isEthDisclosedRpcSpec));
  assert.deepEqual(JSON.parse(specs[0].body).params,['finalized',false]);
  assert.deepEqual(JSON.parse(specs[1].body).map(r=>r.params),addrs.map(a=>[a,{blockHash:hash,requireCanonical:true}]));
  assert.equal(d.totalWei,'30000000000000000163457');assert.equal(d.totalEth,'30000.000000000000163457');
  assert.equal(d.rows[1].eth,'0');assert.equal(d.sourceAsOf,at);assert.equal(d.currentControlVerified,false);
  assert.ok(validateEthDisclosedBalance(d,now));assert.equal(d.rows.length,4);
  for(const bad of [s=>{s.url='https://example.org';},s=>{s.method='GET';},
    s=>{s.body=s.body.replace(addrs[0],addrs[1]);},s=>{s.body=s.body.replace(hash,'0x'+'c'.repeat(64));},
    s=>{s.body=s.body.replace('true','false');},s=>{s.body=s.body.replace('eth_getBalance','eth_sendTransaction');}]){
    const spec={...specs[1]};bad(spec);assert.equal(isEthDisclosedRpcSpec(spec),false);
  }
});
test('rejects bad or stale headers before balance calls, rejects incomplete or malformed batches',async()=>{
 for (const mutate of [h=>{h.error={};},h=>{h.result.hash='../head';},h=>{h.result.timestamp='0x2';},h=>{h.result.number='0x01';}]) {
   const h=head();mutate(h);let n=0;await assert.rejects(run(h,rows(),()=>n++));assert.equal(n,1);
 }
 for (const mutate of [r=>r.pop(),r=>{r[0].id=r[1].id;},r=>{r[0].error={};},r=>{r[0].result='0x00';},r=>{r[0].result='0x'+'1'.repeat(65);}]){
   const b=rows();mutate(b);await assert.rejects(run(head(),b));
 }
});
test('bilingual view links the four fixed balances and primary disclosure, pins time and rejects altered source controls',async()=>{
 const d=await run();
 for(const lang of ['zh','en']){
  const html=renderEthDisclosedBalance(d,(zh,en)=>lang==='zh'?zh:en,now);
  assert.equal((html.match(/https:\/\/etherscan.io\/address\//g)||[]).length,4);
  assert.match(html,/30000\.000000000000163457/);assert.match(html,/company-news\/transparency-first/);
  assert.ok(html.includes(lang==='zh'?'当前控制权未经复核':'Current control is unverified'));
 }
 assert.match(renderEthDisclosedBalance(d,undefined,at+1800000),/数据已过期/);
 for (const mutate of [b=>{b.totalEth='30000';},b=>{b.rows[0].explorerUrl='javascript:alert(1)';},
   b=>{b.disclosedOn='2026-11-18';},b=>{b.currentControlVerified=true;},b=>{b.blockHash='0x1';}]){
    const b=structuredClone(d);mutate(b);assert.equal(validateEthDisclosedBalance(b,now),false);assert.equal(renderEthDisclosedBalance(b,undefined,now),'');
 }
});
