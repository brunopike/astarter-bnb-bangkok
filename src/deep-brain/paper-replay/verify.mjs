import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {buildBrainProof} from '../brain-proof-engine.mjs';
import {bundledMarket,sha256} from './replay.mjs';

const {values}=parseArgs({options:{archive:{type:'string'},asset:{type:'string'},days:{type:'string',default:'90'}}});
const archive=JSON.parse(await readFile(values.archive??bundledMarket,'utf8'));
const assetKey=values.asset??archive.assets[0]?.key;
const days=values.days==='all'?'all':Number(values.days);
const {runId,...run}=buildBrainProof(archive,{assetKey,days});
const hash=value=>sha256(JSON.stringify(value));
const near=(a,b,label)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-7,label);
assert.equal(hash(run),runId);
const asset=archive.assets.find(row=>row.key===assetKey);
let equity=run.assumptions.initialCapital;
for(const {id,execution,...intent} of run.decisions){
  const {id:receiptId,...receipt}=execution;
  assert.equal(hash(intent),id);assert.equal(hash(receipt),receiptId);
  assert.equal(receipt.decisionId,id);assert.equal(receipt.snapshotId,intent.snapshotId);
  const start=Date.parse(intent.evidenceStartAt),end=Date.parse(intent.asOf);
  const bars=asset.bars.filter(row=>row[0]*1000>=start&&row[0]*1000<=end);
  assert.equal(bars.length,intent.barCount);
  assert.equal(hash([asset.key,asset.market,asset.venue,asset.quote,bars]),intent.snapshotId);
  assert.ok(end<Date.parse(intent.observedAt)&&Date.parse(intent.observedAt)<Date.parse(intent.barOpenAt));
  const eligible=intent.candidates.filter(c=>c.eligible).sort((a,b)=>b.score-a.score);
  assert.equal(intent.selected,eligible[0]?.id??'cash');
  assert.deepEqual(receipt.settlementBar,asset.bars.find(row=>row[0]*1000===Date.parse(intent.barOpenAt)));
  assert.ok(receipt.amount>=0&&receipt.amount<=intent.risk.amount);
  near(receipt.equityBefore,equity,'opening equity');
  if(receipt.status==='filled'){
    const bar=receipt.settlementBar,fee=run.assumptions.feeBps/10000,slip=run.assumptions.slippageBps/10000;
    const stop=bar[1]*(1-intent.risk.stopFraction),stopped=bar[3]<=stop;
    assert.equal(receipt.reason,stopped?'stop_loss':'session_close');
    const entry=bar[1]*(1+slip),exit=(stopped?stop:bar[4])*(1-slip),qty=receipt.amount/entry;
    near(receipt.entryPrice,entry,'entry');near(receipt.exitPrice,exit,'exit');near(receipt.quantity,qty,'quantity');
    const fees=fee*qty*(entry+exit);
    near(receipt.fees,fees,'fees');near(receipt.netPnl,qty*(exit-entry)-fees,'net P&L');
    near(receipt.slippage,qty*(bar[1]+(stopped?stop:bar[4]))*slip,'slippage');
  }else{
    assert.equal(receipt.status,'skipped');assert.equal(receipt.amount,0);assert.equal(receipt.fees,0);assert.equal(receipt.netPnl,0);
  }
  equity+=receipt.netPnl;near(receipt.equityAfter,equity,'closing equity');
}
near(run.summary.netPnl,equity-run.assumptions.initialCapital,'window balance');
console.log(JSON.stringify({runId,market:asset.market,verifiedDecisions:run.decisions.length}));
