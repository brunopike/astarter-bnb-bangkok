import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createS03Strategy,s03Parameters,s03Indicators,s03EntryConditions,s03RiskProposal,S03_SOURCE} from './strategy-s03.mjs';
import {wilderSeries} from './workbench-market-analysis.mjs';
import {EXECUTION_DEFAULTS} from './strategy-execution-data.mjs';

const bar=(i,close=100+i*.03+Math.sin(i*.35)*1.5)=>({time:i*300,open:close,high:close+.4,low:close-.4,close,volume:100});
const series=(n=400)=>Array.from({length:n},(_,i)=>bar(i));
const feed=(strategy,bars)=>bars.map(value=>strategy.onBar(value,{now:value.time+300}));
function prepared(){const strategy=createS03Strategy(),bars=series(251);feed(strategy,bars);const candidate=strategy.snapshot().candidate;assert.ok(candidate);return {strategy,bars,candidate};}
function filled(){const value=prepared(),{strategy,candidate}=value;strategy.applyPaperReceipt({id:'submit-one',type:'submitted',candidateId:candidate.id,intentId:'intent-one',stop:candidate.riskProposal.stopUnrounded,at:candidate.closedAt+.1});strategy.applyPaperReceipt({id:'fill-one',type:'fill',candidateId:candidate.id,intentId:'intent-one',quantity:1,price:candidate.signal.close,at:candidate.closedAt+.2});return value;}

test('baseline and editable parameter domains match the frozen registry and original S03 card',()=>{
 const p=s03Parameters(),expected=Object.fromEntries(Object.entries(EXECUTION_DEFAULTS.S03.parameters).map(([key,item])=>[key,typeof item.value==='string'?Number(item.value):item.value]));assert.deepEqual(p,expected);
 assert.equal(p.risk_fraction,.005);assert.equal(p.notional_fraction,.20);assert.equal(p.hold_boundaries,36);assert.equal(p.cooldown_full_bars,3);assert.equal(p.target_enabled,false);assert.equal(S03_SOURCE.nativeAccepted,false);
 const source=readFileSync(new URL('strategy-catalog.mjs',import.meta.url),'utf8');assert.match(source,/原版没有固定止盈/);assert.match(source,/归零后3根完整5m冷却/);
 const custom={ema_fast:10,ema_slow:30,rsi_cross:48,rsi_ceiling:62,rsi_fail:42,stop_atr:1.5,risk_fraction:.003,notional_fraction:.10,hold_boundaries:24,cooldown_full_bars:4};
 assert.throws(()=>s03Parameters(custom),/VERSION_REQUIRED/);assert.equal(createS03Strategy({parameters:custom,version:'s03-custom-v2'}).snapshot().parameters.rsi_cross,48);
 for(const patch of [{ema_fast:50,ema_slow:20},{rsi_fail:50},{rsi_ceiling:50},{volatility_min:0},{risk_fraction:.0051},{notional_fraction:.21},{target_enabled:true},{signal_ttl:6},{quote_max_age:3000},{take_profit:2}])assert.throws(()=>s03Parameters(patch,'custom'),/PARAMETERS_INVALID/);
 assert.throws(()=>createS03Strategy({market:'ETH/USDT'}),/MARKET_UNSUPPORTED/);
 assert.equal(createS03Strategy({parameters:{ema_fast:100,ema_slow:250},version:'s03-long-warmup-v2'}).snapshot().warmup,1250);
});

test('native first-value Wilder seeding, flat RSI scale and TR jumps are explicit S03 adaptations',()=>{
 const p={...s03Parameters(),ema_fast:3,ema_slow:3,rsi_period:3,atr_period:3};
 const values=[1,2,3,4,3,2,2,2].map((close,i)=>({time:i*300,open:close,close,high:close+.5,low:close-.5,volume:1}));const got=s03Indicators(values,p);
 assert.deepEqual(got.map(row=>row.emaFast),[1,1.5,2.25,3.125,3.0625,2.53125,2.265625,2.1328125]);assert.equal(got[0].rsi,100);assert.equal(got[2].nativeReady,true);assert.ok(Math.abs(got[4].rsi-58.46153846153847)<1e-13);
 const flat=Array.from({length:30},(_,i)=>bar(i,100));assert.equal(s03Indicators(flat).at(-1).rsi,100);assert.equal(wilderSeries(flat).rsi.at(-1).value,50,'the shared chart convention is intentionally not changed');
 const ranges=[1,3,9,2,4].map((range,i)=>({time:i*300,open:10,close:10,high:10+range/2,low:10-range/2,volume:1}));assert.deepEqual(s03Indicators(ranges,p).map(row=>row.atr),[1,1.6666666666666667,4.111111111111112,3.407407407407408,3.604938271604939]);
});

test('exact RSI, EMA and volatility edges follow the contract, including non-default parameters',()=>{
 const current={emaFast:101,emaSlow:100,close:102,rsi:65,atr:.102};assert.deepEqual(s03EntryConditions({rsi:50},current),{trend:true,cross:true,volatility:true});
 for(const patch of [{rsi:50},{rsi:65.00001}])assert.equal(s03EntryConditions({rsi:50},{...current,...patch}).cross,false);
 assert.equal(s03EntryConditions({rsi:50.0001},current).cross,false);assert.equal(s03EntryConditions({rsi:50},{...current,emaSlow:101}).trend,false);assert.equal(s03EntryConditions({rsi:50},{...current,close:101}).trend,false);
 assert.equal(s03EntryConditions({rsi:50},{...current,atr:2.04}).volatility,true);assert.equal(s03EntryConditions({rsi:50},{...current,atr:2.04001}).volatility,false);assert.equal(s03EntryConditions({rsi:50},{...current,atr:.10199}).volatility,false);
 const p=s03Parameters({rsi_cross:48,rsi_ceiling:62,rsi_fail:42},'s03-edges-v2');assert.equal(s03EntryConditions({rsi:48},{...current,rsi:62},p).cross,true);assert.equal(s03EntryConditions({rsi:48},{...current,rsi:62.01},p).cross,false);
});

test('recorded native deadline and cooldown boundaries remain deterministic',()=>{
 const bars=series(251).map(value=>{const close=Number(value.close.toFixed(2));return {...value,open:close,close,high:Number((close+.4).toFixed(2)),low:Number((close-.4).toFixed(2))};});
 // Golden boundary facts come from the separate strict native-domain gate.
 const recordedTTL=[{delay:4,expired:false,signal:true},{delay:5,expired:true,signal:false},{delay:6,expired:true,signal:false}];
 for(const native of recordedTTL){const strategy=createS03Strategy();feed(strategy,bars.slice(0,-1));const last=bars.at(-1),value=strategy.onBar(last,{now:last.time+300+native.delay});assert.equal(value.decision.candidate.status==='expired',native.expired);assert.equal(native.signal,!native.expired);if(native.delay===5)assert.throws(()=>strategy.applyPaperReceipt({id:'at-deadline',type:'submitted',candidateId:value.decision.candidate.id,intentId:'expired',at:last.time+305,stop:value.decision.candidate.riskProposal.stopUnrounded}),/INTENT_INVALID/);}
 const {strategy,candidate}=filled();strategy.applyPaperReceipt({id:'flat-native-boundary',type:'flat',intentId:'intent-one',at:75310,confirmed:true,ordersTerminal:true,inventoryQty:0});
 for(const [i,offset] of [[251,-.2],[252,-.4],[253,-.6],[254,.1]]){const value=strategy.onBar(bar(i,candidate.signal.close+offset),{now:(i+1)*300});assert.equal(value.conditions.cooldown,false);assert.equal(value.decision,null);if(i===254)assert.equal(value.conditions.cross,true,'the third cooldown bar itself contains a real crossing that must be discarded');}
 const after=strategy.onBar(bar(255,candidate.signal.close+.2),{now:76800});assert.equal(after.conditions.cooldown,true);assert.equal(after.conditions.cross,false);assert.equal(after.decision,null,'the previous blocked crossing is never replayed');
});

test('250 continuous closed bars warm up, and only a fresh crossing creates a non-order candidate',()=>{
 const strategy=createS03Strategy();feed(strategy,series(249));assert.equal(strategy.snapshot().ready,false);assert.equal(strategy.snapshot().candidate,null);strategy.onBar(bar(249),{now:75000});assert.equal(strategy.snapshot().ready,true);
 const result=strategy.onBar(bar(250),{now:75300});assert.equal(result.decision.branch,'A');assert.equal(result.decision.candidate.status,'awaiting_next_available_price');assert.equal(result.decision.candidate.admission,'NOT_EVALUATED');assert.equal(result.decision.candidate.executionAuthority,'NONE');assert.equal(strategy.snapshot().position,null);
 const before=strategy.snapshot();assert.equal(strategy.onBar(bar(250),{now:75301}).reason,'DUPLICATE_BAR');assert.deepEqual(strategy.snapshot(),before);
 const stale=createS03Strategy();const decisions=series(251).map(value=>stale.onBar(value,{now:100000})).filter(value=>value.decision);assert.equal(decisions.at(-1).decision.candidate.status,'expired');assert.equal(stale.snapshot().position,null);
});

test('future, invalid, missing, revised and out-of-order bars cannot create historical successes',()=>{
 const {strategy,bars,candidate}=prepared(),before=strategy.snapshot();assert.equal(strategy.onBar(bar(251),{now:75599}).reason,'BAR_NOT_CLOSED');assert.deepEqual(strategy.snapshot(),before);
 assert.throws(()=>strategy.onBar({...bar(251),time:75301},{now:75600}),/BAR_INVALID/);
 const revised={...bars[100],close:bars[100].close+.01,revision:1};assert.equal(strategy.onBar(revised,{now:75600}).reason,'HISTORY_REVISION');assert.equal(strategy.snapshot().ready,false);assert.deepEqual(strategy.snapshot().decisions,before.decisions);assert.equal(strategy.snapshot().candidate,null);
 const version=strategy.snapshot().dataVersion;assert.equal(strategy.onBar(revised,{now:75600}).reason,'DUPLICATE_BAR');assert.equal(strategy.snapshot().dataVersion,version);
 assert.throws(()=>strategy.restoreHistory(series(251),{now:75600,verified:true}),/VERIFIED_HISTORY/);strategy.restoreHistory(series(251),{now:75600,verified:true,reconciled:true});assert.equal(strategy.snapshot().ready,true);assert.equal(strategy.snapshot().candidate,null);assert.equal(strategy.snapshot().decisions[0].candidate.id,candidate.id);
 const gap=strategy.onBar(bar(253),{now:76200});assert.equal(gap.state.dataLock,'DATA_GAP');assert.equal(gap.state.ready,false);assert.equal(gap.decision,null);
 const other=createS03Strategy();other.restoreHistory(series(250).slice(0),{now:75000,verified:true,reconciled:true});assert.equal(other.onBar({...bar(1),time:0},{now:75000}).reason,'HISTORY_REVISION');
});

test('prefix indicators and recorded decisions are invariant to later suffixes',()=>{
 const bars=series(420),full=s03Indicators(bars);
 for(const end of [1,14,50,249,250,251,300,419])assert.deepEqual(s03Indicators(bars.slice(0,end)),full.slice(0,end));
 const strategy=createS03Strategy();feed(strategy,bars.slice(0,251));const old=copy(strategy.snapshot().decisions);feed(strategy,bars.slice(251));assert.deepEqual(strategy.snapshot().decisions.slice(0,old.length),old);
 const altered=bars.map((value,i)=>i<251?value:bar(i,1000+i));assert.deepEqual(s03Indicators(altered).slice(0,251),full.slice(0,251));
});

test('paper receipts alone establish fills, preserve first-fill time and never reuse signal-bar extremes',()=>{
 const {strategy,candidate,bars}=prepared();assert.equal(strategy.snapshot().position,null);assert.throws(()=>strategy.applyPaperReceipt({id:'bad-fill',type:'fill',candidateId:candidate.id,intentId:'missing',at:75301,price:1,quantity:1}),/FILL_INVALID/);
 strategy.applyPaperReceipt({id:'submit',type:'submitted',candidateId:candidate.id,intentId:'intent',stop:candidate.riskProposal.stopUnrounded,at:75300.1});const fill={id:'fill',type:'fill',candidateId:candidate.id,intentId:'intent',at:75301,price:candidate.signal.close,quantity:.25};strategy.applyPaperReceipt(fill);assert.equal(strategy.applyPaperReceipt(fill).reason,'DUPLICATE_RECEIPT');assert.equal(strategy.snapshot().position.quantity,.25);assert.equal(strategy.snapshot().position.firstFillAt,75301);assert.equal(strategy.snapshot().exitTarget,null);
 strategy.applyPaperReceipt({...fill,id:'partial',at:75303,quantity:.1});assert.equal(strategy.snapshot().position.firstFillAt,75301);assert.equal(strategy.snapshot().position.stop,candidate.riskProposal.stopUnrounded);assert.throws(()=>strategy.applyPaperReceipt({...fill,quantity:2}),/RECEIPT_CONFLICT/);
 assert.equal(strategy.onBar(bars.at(-1),{now:75303}).reason,'DUPLICATE_BAR');assert.equal(strategy.snapshot().position.holdBoundaries,0);
 assert.throws(()=>strategy.applyPaperReceipt({id:'fake-flat',type:'flat',intentId:'intent',at:75304,confirmed:true,ordersTerminal:true,inventoryQty:.000001}),/CONFIRMED_FLAT/);
});

test('signal-bar lows cannot stop a later fill, and expiry or unconfirmed cancellation cannot create an entry',()=>{
 const strategy=createS03Strategy();feed(strategy,series(250));const signal={...bar(250),low:bar(250).close-2.5};strategy.onBar(signal,{now:75300});const candidate=strategy.snapshot().candidate;assert.ok(signal.low<candidate.riskProposal.stopUnrounded);
 const submitted={id:'submitted',type:'submitted',candidateId:candidate.id,intentId:'i',stop:Math.floor(candidate.riskProposal.stopUnrounded*100)/100,at:75300.1};
 assert.throws(()=>strategy.applyPaperReceipt({...submitted,at:75305.01}),/INTENT_INVALID/);assert.equal(strategy.snapshot().position,null);
 strategy.applyPaperReceipt(submitted);strategy.applyPaperReceipt({id:'fill',type:'fill',candidateId:candidate.id,intentId:'i',at:75300.2,price:signal.close,quantity:1});assert.equal(strategy.snapshot().exitTarget,null);assert.equal(strategy.snapshot().position.stop,submitted.stop);
 const empty=prepared();empty.strategy.applyPaperReceipt({id:'s',type:'submitted',candidateId:empty.candidate.id,intentId:'empty',stop:empty.candidate.riskProposal.stopUnrounded,at:75300.1});assert.throws(()=>empty.strategy.applyPaperReceipt({id:'not-final',type:'unfilled',intentId:'empty',at:75300.2,confirmed:true,ordersTerminal:false}),/TERMINAL_RECEIPT_REQUIRED/);empty.strategy.applyPaperReceipt({id:'final',type:'unfilled',intentId:'empty',at:75300.3,confirmed:true,ordersTerminal:true});assert.equal(empty.strategy.snapshot().position,null);assert.equal(empty.strategy.snapshot().intent,null);
});

test('36 actual boundaries use the first fill; exit is a stable request to the unique owner, not a fabricated sale',()=>{
 const {strategy,candidate}=filled();
 for(let i=251;i<=286;i++){
  if(i===260)strategy.applyPaperReceipt({id:'later-fill',type:'fill',candidateId:candidate.id,intentId:'intent-one',at:i*300+.1,price:candidate.signal.close+1,quantity:.1});
  const result=strategy.onBar(bar(i,candidate.signal.close+(i-250)*.1),{now:(i+1)*300});if(i<286)assert.equal(result.state.exitTarget,null);else{assert.equal(result.decision.branch,'B');assert.ok(result.decision.reasons.includes('HOLD_LIMIT'));}
 }
 const state=strategy.snapshot();assert.equal(state.position.holdBoundaries,36);assert.ok(state.position.quantity>0);const id=state.exitTarget.id;const next=strategy.onBar(bar(287,candidate.signal.close+4),{now:86400});assert.equal(strategy.snapshot().exitTarget.id,id);assert.equal(next.decision,null,'unchanged exit targets do not emit another sell suggestion');
});

test('two RSI failures must be consecutive closed bars; a recovered bar and duplicates do not add failures',()=>{
 const {strategy,candidate}=filled();
 for(const [i,offset,count] of [[251,-.2,0],[252,-.4,0],[253,-.6,1],[254,.1,0],[255,-.6,1],[256,-.8,2]]){
  const value=bar(i,candidate.signal.close+offset),result=strategy.onBar(value,{now:(i+1)*300});assert.equal(result.state.momentumFailures,count);
  if(i<256)assert.equal(result.decision,null);else{assert.equal(result.decision.branch,'B');assert.ok(result.decision.reasons.includes('RSI_FAILURE'));}
  const prior=strategy.snapshot();assert.equal(strategy.onBar(value,{now:(i+1)*300+1}).reason,'DUPLICATE_BAR');assert.deepEqual(strategy.snapshot(),prior);
 }
});

test('three full bars begin at or after the confirmed zero-inventory time; old crosses are not replayed',()=>{
 const {strategy,candidate}=filled();strategy.applyPaperReceipt({id:'flat',type:'flat',intentId:'intent-one',at:75310,confirmed:true,ordersTerminal:true,inventoryQty:0});
 for(const [i,remaining] of [[251,3],[252,2],[253,1],[254,0]]){const value=strategy.onBar(bar(i,candidate.signal.close+.2*(i-250)),{now:(i+1)*300});assert.equal(value.state.cooldownRemaining,remaining);assert.equal(value.decision,null);}
 assert.equal(strategy.snapshot().candidate,null);assert.equal(strategy.snapshot().position,null);
});

test('C risk dominates B and A, preserving frozen stops and unresolved inventory',()=>{
 const {strategy,candidate}=filled(),stop=strategy.snapshot().position.stop;
 const result=strategy.onBar(bar(251,stop-.1),{now:75600});assert.equal(result.decision.branch,'C');assert.ok(result.decision.reasons.includes('STOP_CLOSE_BREACH'));assert.equal(result.state.position.stop,stop);assert.ok(result.state.position.quantity>0);
 const id=result.state.exitTarget.id;strategy.applyPaperReceipt({id:'unknown',type:'unknown',intentId:'intent-one',at:75601});assert.equal(strategy.snapshot().exitTarget.id,id);assert.equal(strategy.snapshot().exitTarget.action,'retain_protection_and_reconcile');
 strategy.applyPaperReceipt({id:'risk',type:'risk',reason:'DAILY_LOSS',at:75602});assert.equal(strategy.snapshot().dataLock,'DAILY_LOSS');assert.ok(strategy.snapshot().position);assert.throws(()=>strategy.restoreHistory(series(251),{now:75603,verified:true,reconciled:true}),/RISK_LOCK/);
 assert.equal(candidate.riskProposal.takeProfit,null);assert.equal(candidate.riskProposal.trailingStop,null);
});

test('gap and unknown state pause risk rather than assuming a fill, cancellation or flat inventory',()=>{
 const {strategy,candidate}=filled();const arrival=strategy.onBar(bar(253),{now:76200});const state=strategy.snapshot();assert.equal(arrival.decision.branch,'C');assert.equal(state.dataLock,'DATA_GAP');assert.equal(state.exitTarget.branch,'C');assert.equal(state.exitTarget.action,'retain_protection_and_reconcile');assert.ok(!state.exitTarget.reasons.includes('EMA_INVALID'),'an unready seed after a gap is not evidence of an EMA reversal');assert.equal(state.position.stop,candidate.riskProposal.stopUnrounded);assert.equal(state.position.quantity,1);assert.throws(()=>strategy.restoreHistory(series(251),{now:76200,verified:true,reconciled:true}),/STALE_HISTORY/);
 const pending=prepared();pending.strategy.applyPaperReceipt({id:'sub',type:'submitted',candidateId:pending.candidate.id,intentId:'pending',stop:pending.candidate.riskProposal.stopUnrounded,at:pending.candidate.closedAt+.1});pending.strategy.onBar(bar(251),{now:75600});assert.equal(pending.strategy.snapshot().intent.status,'pending');assert.equal(pending.strategy.snapshot().candidate.status,'awaiting_paper_receipt');assert.equal(pending.strategy.snapshot().position,null);
});

test('risk proposals retain original limits but defer precision, fees, sizing and execution to the ledger owner',()=>{
 const proposal=s03RiskProposal({close:60000,atr:500});assert.equal(proposal.stopUnrounded,59000);assert.equal(proposal.riskFraction,.005);assert.equal(proposal.notionalFraction,.2);assert.equal(proposal.dailyLossFraction,.02);assert.equal(proposal.capMultiplier,1.002);assert.equal(proposal.stressExitMultiplier,.998);assert.equal(proposal.feeBuy,.001);assert.equal(proposal.quantity,null);assert.equal(proposal.reservedQuote,null);assert.equal(proposal.executionAuthority,'NONE');assert.equal(proposal.takeProfit,null);assert.ok(proposal.requires.includes('versioned-tick-step-quote-unit'));
});

function copy(value){return structuredClone(value);}
