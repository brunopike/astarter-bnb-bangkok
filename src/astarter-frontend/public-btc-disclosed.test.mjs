import assert from 'node:assert/strict';
import test from 'node:test';
import {BTC_DISCLOSED_ADDRESSES,PUBLIC_BTC_DISCLOSED_SOURCE,normalizeBtcDisclosedBalance,validateBtcDisclosedBalance,publicBtcDisclosedRequest} from './public-btc-disclosed.mjs';

const NOW=Date.UTC(2026,10,18,6);
const raws=()=>BTC_DISCLOSED_ADDRESSES.map(address=>({address,chain_stats:{funded_txo_count:2,funded_txo_sum:200000001,spent_txo_count:1,spent_txo_sum:100000000,tx_count:2},mempool_stats:{funded_txo_sum:999999999,spent_txo_sum:0}}));
test('fixed policy covers exactly the six officially disclosed BTC addresses, without arbitrary address or URL inputs',()=>{
 assert.equal(BTC_DISCLOSED_ADDRESSES.length,6);assert.equal(new Set(BTC_DISCLOSED_ADDRESSES).size,6);assert.equal(Object.isFrozen(BTC_DISCLOSED_ADDRESSES),true);
 const request=publicBtcDisclosedRequest(new URLSearchParams());assert.equal(request.resource,'btc-disclosed-balance');assert.equal(request.policy.parallel,true);assert.deepEqual(request.policy.urls,BTC_DISCLOSED_ADDRESSES.map(address=>'https://mempool.space/api/address/'+address));
 assert.equal(PUBLIC_BTC_DISCLOSED_SOURCE.interval,900000);assert.equal(PUBLIC_BTC_DISCLOSED_SOURCE.stale,1800000);
 for(const params of ['address=anything','url=https://invalid.test','exchange=Binance','metric=exchange-netflow','resource=btc-disclosed-balance'])assert.equal(publicBtcDisclosedRequest(new URLSearchParams(params)),null);
});
test('confirmed balances use exact satoshis and exclude mempool values without mutating input',()=>{
 const raw=raws(),before=structuredClone(raw),body=normalizeBtcDisclosedBalance(raw,NOW,NOW-1000);
 assert.equal(validateBtcDisclosedBalance(body,NOW),true);assert.equal(body.totalConfirmedSats,'600000006');assert.equal(body.totalConfirmedBtc,'6.00000006');assert.equal(body.rows[0].confirmedSats,'100000001');assert.equal(body.rows[0].confirmedBtc,'1.00000001');assert.equal(body.rows[0].confirmedTxCount,2);assert.deepEqual(raw,before);
 assert.equal(body.receivedAt,NOW);assert.equal(body.requestStartedAt,NOW-1000);assert.equal(body.validUntil,NOW+1800000);
 assert.equal(body.symbol,'BTC');assert.equal(body.unit,'BTC');assert.equal(body.source,'mempool.space');assert.ok(body.rows.every(row=>row.explorerUrl==='https://mempool.space/address/'+row.address));
});
test('historical attribution and complete-address sample never claim current ownership, full reserves, solvency or net flow',()=>{
 const body=normalizeBtcDisclosedBalance(raws(),NOW);
 assert.equal(body.disclosure.organization,'Crypto.com');assert.equal(body.disclosure.publishedOn,'2022-11-11');assert.equal(body.disclosure.currentControlVerified,false);assert.equal(body.disclosure.attribution,'historical_self_disclosure');assert.equal(body.disclosure.url,'https://crypto.com/en/company-news/transparency-first');
 assert.deepEqual(body.coverage,{scope:'DISCLOSED_ADDRESS_BALANCE_SAMPLE',addressCount:6,disclosedSetComplete:true,exchangeCoverageComplete:false,balanceBasis:'confirmed_utxos',timeBasis:'request_observation_window',netflowAvailable:false,netflowReason:'TRANSACTION_WINDOW_NOT_TRAVERSED'});
 assert.equal(body.metric,'btc-disclosed-balance');assert.equal(body.netFlow,undefined);assert.equal(body.reserveRatio,undefined);assert.equal(body.solvency,undefined);
});
test('one missing or duplicated address, partial source failure and wrong source identity fail instead of zero filling',()=>{
 const complete=raws();
 for(const raw of [null,[],complete.slice(1),[...complete,complete[0]],{error:'rate limited'},complete.map((row,i)=>i===2?{error:'unavailable'}:row),complete.map((row,i)=>i===2?complete[0]:row),[...complete].reverse(),new Array(6)])assert.throws(()=>normalizeBtcDisclosedBalance(raw,NOW),/INVALID_BTC_DISCLOSED_BALANCE/);
});
test('malformed amounts and unsafe counters cannot become a balance, while genuine zero is retained',()=>{
 for(const field of ['funded_txo_sum','spent_txo_sum','funded_txo_count','spent_txo_count','tx_count'])for(const value of [null,undefined,'0',-1,NaN,Infinity,.5,Number.MAX_SAFE_INTEGER+1]){
  const raw=raws();raw[0].chain_stats[field]=value;assert.throws(()=>normalizeBtcDisclosedBalance(raw,NOW),/INVALID_BTC_DISCLOSED_BALANCE/);
 }
 const invalid=raws();invalid[0].chain_stats.spent_txo_sum=300000000;assert.throws(()=>normalizeBtcDisclosedBalance(invalid,NOW));
 const excessive=raws();for(const row of excessive)row.chain_stats.funded_txo_sum=2100000000000000;assert.throws(()=>normalizeBtcDisclosedBalance(excessive,NOW));
 const zero=raws();for(const row of zero)row.chain_stats.spent_txo_sum=row.chain_stats.funded_txo_sum;const body=normalizeBtcDisclosedBalance(zero,NOW);assert.equal(body.totalConfirmedSats,'0');assert.equal(body.totalConfirmedBtc,'0');
});
test('validators recompute every address and aggregate, reject forged scope and keep the original validity deadline',()=>{
 const original=normalizeBtcDisclosedBalance(raws(),NOW,NOW-8000);assert.equal(validateBtcDisclosedBalance(original,NOW+1800000),true);assert.equal(original.validUntil,NOW+1800000);
 for(const patch of [b=>{b.totalConfirmedSats='1';},b=>{b.rows[0].confirmedBtc='9';},b=>{b.rows[0].address='bad';},b=>{b.rows[0].explorerUrl='https://invalid.test';},b=>{b.coverage.exchangeCoverageComplete=true;},b=>{b.disclosure.currentControlVerified=true;},b=>{b.source='CoinMetrics';},b=>{b.validUntil++;},b=>{b.executionAuthority='TRADE';}]){
  const body=structuredClone(original);patch(body);assert.equal(validateBtcDisclosedBalance(body,NOW),false);
 }
 assert.equal(validateBtcDisclosedBalance(original,NOW-1001),false);
 for(const [at,start]of [[NaN,NOW],[NOW,NOW+1],[NOW,NOW-8001],[0,0],[NOW+.5,NOW]])assert.throws(()=>normalizeBtcDisclosedBalance(raws(),at,start),/INVALID_BTC_DISCLOSED_BALANCE/);
});
