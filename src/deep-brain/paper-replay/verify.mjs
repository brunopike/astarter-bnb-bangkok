import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildBrainProof} from '../brain-proof-engine.mjs';
import {featuredCase} from './replay.mjs';


const bytes = name => readFileSync(new URL(name, import.meta.url));
const read = name => JSON.parse(bytes(name));
const hash = data => createHash('sha256').update(data).digest('hex');
const hashJson = value => hash(JSON.stringify(value));
function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual-expected) < 1e-8, label);
}
const pinned=read('example/proof.json'),source=read('example/market.json');
const report=buildBrainProof(source,{assetKey:'coin:bitcoin',days:90});
const position=report.decisions.findLastIndex(d=>d.execution.status==='filled');
const item={decision:report.decisions[position]};
const {execution:r,id,...intent}=item.decision;
const {id:receiptId,...receipt}=r;
const {runId,...run}=report;
assert.equal(hashJson(run),runId);assert.equal(runId,pinned.runId);
assert.equal(id,pinned.decisionId);assert.equal(receiptId,pinned.receiptId);
assert.equal(hashJson(intent),id);assert.equal(hashJson(receipt),receiptId);
const venue=read('example/venue.json').map(row=>[row[0]/1000,...row.slice(1,6).map(Number)]);
assert.equal(intent.previousReceiptId, report.decisions[position-2].execution.id);
assert.equal(r.openRisk.previousReceiptId, report.decisions[position-1].execution.id);
assert.equal(r.decisionId,id);
assert.equal(r.snapshotId,intent.snapshotId);
assert.equal(intent.mode, 'historical_replay');
const bars=source.assets[0].bars.filter(row=>row[0]*1000>=Date.parse(intent.evidenceStartAt)&&row[0]*1000<Date.parse(intent.asOf));
assert.equal(bars.length,91);
assert.equal(hashJson([intent.assetKey,intent.market,report.asset.venue,intent.quote,bars]),intent.snapshotId);
assert.deepEqual(venue.slice(0,91),bars);
assert.equal(venue.length,93);
for (let i=1;i<venue.length;i++) assert.equal(venue[i][0]-venue[i-1][0],86400);
assert.deepEqual(venue[92],r.settlementBar);
const market=source.assets.find(row=>row.key===intent.assetKey);
assert.deepEqual(market.bars.filter(row=>row[0]>=venue[0][0]&&row[0]<=venue[92][0]),venue);
assert.ok(Date.parse(intent.asOf)<Date.parse(intent.observedAt) && Date.parse(intent.observedAt)<venue[92][0]*1000);
const mean=rows=>rows.reduce((a,b)=>a+b,0)/rows.length;
function signal(window) {
  const marks=window.map(row=>row[4]);
  const end=marks.at(-1), mean10=mean(marks.slice(-10)), mean30=mean(marks);
  const ranges=window.slice(-14).map((r,i)=>Math.max(r[2],marks[i+15])-Math.min(r[3],marks[i+15]));
  const atr=mean(ranges)/end;
  return {trend:mean10>mean30&&end>mean10,breakout:end>Math.max(...window.slice(-11,-1).map(r=>r[2])),
    pullback:(end-mean10)/mean10 < -atr/2 && end>marks.at(-2),atr,end,mean10,
    stop:Math.max(.01,Math.min(.1,1.5*atr)),gap:Math.max(.02,Math.min(.08,2*atr))};
}
const fee=.001, slip=.0005;
function fills(candle,stop) {
  const [,open,,low,closePrice]=candle;
  const trigger=open*(1-stop), stopped=low<=trigger,exitReference=stopped?trigger:closePrice;
  const buy=open*(1+slip),sell=exitReference*(1-slip);
  return {buy,sell,stopped,trigger,exitReference,unitReturn:sell/buy-1-fee*(1+sell/buy)};
}
const current=signal(bars.slice(-30)), contenders=[];
for(const strategy of ['trend','breakout','pullback']){
  const returns=[];
  for(let t=31;t<91;t++){
    const then=signal(bars.slice(t-31,t-1));
    if(then[strategy]&&Math.abs(bars[t][1]/then.end-1)<=then.gap) returns.push(fills(bars[t],then.stop).unitReturn);
  }
  const downside=Math.sqrt(returns.reduce((n,x)=>n+Math.min(0,x)**2,0)/60);
  const score=100*(returns.reduce((a,b)=>a+b,0)/60-.5*downside/Math.sqrt(60));
  const c=intent.candidates.find(c=>c.id===strategy);
  close(c.score,score,strategy+' score');
  assert.equal(c.sampleCount,returns.length);assert.equal(c.signal,current[strategy]);
  assert.equal(c.eligible,Boolean(current[strategy]&&returns.length>=3&&score>0));
  if(c.eligible)contenders.push(c);
}
contenders.push({id:'cash',score:0});
assert.equal(contenders.sort((a,b)=>b.score-a.score)[0].id,intent.selected);
assert.equal(intent.selected,'pullback');
const risk=intent.risk,usable=intent.equityBefore-risk.reserve;
assert.equal(risk.locked,null);
assert.ok(current.atr<.035 && intent.equityBefore/risk.priorHigh>.97);
close(risk.stopFraction,current.stop,'stop fraction');
close(risk.openGapLimit,current.gap,'opening-gap limit');
close(risk.riskBudget,usable*.0025,'episode budget');
close(risk.riskBudget,Math.min(...Object.values(risk.limits)),'binding limit');
const amount=Math.floor(100*Math.min(usable*.10,usable/(1+fee),risk.riskBudget/(current.stop+2*(slip+fee))))/100;
close(amount,risk.amount,'frozen cap');
assert.ok(r.amount<=amount && r.amount>0);
close(r.openRisk.amount,r.amount,'opening cap');
const target=venue.at(-1), gap=Math.abs(target[1]/current.end-1);
assert.ok(gap<=risk.openGapLimit);
const f=fills(target,current.stop),quantity=r.amount/f.buy;
const entryFee=r.amount*fee,exitFee=quantity*f.sell*fee;
const marketMovePnl=quantity*(f.exitReference-target[1]);
const slippageCost=quantity*((f.buy-target[1])+(f.exitReference-f.sell));
const beforeFees=quantity*(f.sell-f.buy),net=beforeFees-entryFee-exitFee;
assert.equal(r.reason,f.stopped?'stop_loss':'session_close');
for(const [a,b,label] of [[r.entryPrice,f.buy,'buy'],[r.exitPrice,f.sell,'sell'],[r.quantity,quantity,'quantity'],
  [r.stopPrice,f.trigger,'stop'],[r.fees,entryFee+exitFee,'fees'],[r.slippage,slippageCost,'slippage'],
  [r.netPnl,net,'net'],[marketMovePnl-slippageCost-entryFee-exitFee,net,'attribution'],[r.equityAfter-r.equityBefore,net,'ledger delta']]) close(a,b,label);
{
  assert.equal(buildBrainProof(source,{assetKey:intent.assetKey,days:90}).runId,runId);
  // Perturb only the unseen target close and low, and remove the original stop event.
  const alternative=structuredClone(source),bar=alternative.assets.find(a=>a.key===intent.assetKey).bars.find(b=>b[0]===target[0]);
  bar[3]=bar[1];bar[4]=bar[2];
  const test=buildBrainProof(alternative,{assetKey:intent.assetKey,days:90}).decisions[position];
  assert.equal(test.id,id);assert.notEqual(test.execution.id,receiptId);assert.equal(test.execution.reason,'session_close');
}
await featuredCase();
console.log(JSON.stringify({mode:intent.mode,runId,decisionId:id,receiptId,venueMatched:venue.length,calibrationSessions:60,selected:intent.selected,
  previousClose:bars.at(-2)[4],signalClose:current.end,mean10:current.mean10,atrPct:100*current.atr,entryGapPct:100*gap,entryGapLimitPct:100*current.gap,
  riskBudget:risk.riskBudget,notional:r.amount,entryPrice:f.buy,exitPrice:f.sell,quantity,stop:f.trigger,low:target[3],open:target[1],close:target[4],
  referenceMarketPnl:marketMovePnl,slippageCost,fillPnlBeforeFees:beforeFees,entryFee,exitFee,netPnl:net,balanceBefore:r.equityBefore,balanceAfter:r.equityAfter,
  venueResponseSHA256:hash(bytes('example/venue.json')),productionEngineReplayed:true,futurePricePerturbationTested:true},null,2));
