import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createS03Strategy,s03Parameters,s03Indicators} from './strategy-s03.mjs';

// Explicit offline gate. Never part of the portable default suite; missing
// dependencies are failures, never skips or implicit local-machine fallbacks.
const nativePython=process.env.S03_NATIVE_PYTHON;
const nativeSource=process.env.S03_NATIVE_SOURCE;
assert.ok(typeof nativePython==='string'&&isAbsolute(nativePython)&&existsSync(nativePython),'S03_NATIVE_PYTHON must explicitly name an installed Nautilus rc3 Python executable.');
assert.ok(typeof nativeSource==='string'&&isAbsolute(nativeSource)&&existsSync(join(nativeSource,'stark_trading_os/control/s03_bridge.py')),'S03_NATIVE_SOURCE must explicitly name the core engine src directory.');

const bar=(i,close=100+i*.03+Math.sin(i*.35)*1.5)=>({time:i*300,open:close,high:close+.4,low:close-.4,close,volume:100});
const series=(n=400)=>Array.from({length:n},(_,i)=>bar(i));
const feed=(strategy,bars)=>bars.map(value=>strategy.onBar(value,{now:value.time+300}));
function prepared(){const strategy=createS03Strategy(),bars=series(251);feed(strategy,bars);const candidate=strategy.snapshot().candidate;assert.ok(candidate);return {strategy,bars,candidate};}
function filled(){const value=prepared(),{strategy,candidate}=value;strategy.applyPaperReceipt({id:'submit-one',type:'submitted',candidateId:candidate.id,intentId:'intent-one',stop:candidate.riskProposal.stopUnrounded,at:candidate.closedAt+.1});strategy.applyPaperReceipt({id:'fill-one',type:'fill',candidateId:candidate.id,intentId:'intent-one',quantity:1,price:candidate.signal.close,at:candidate.closedAt+.2});return value;}

test('installed Nautilus rc3 is an independent offline oracle for every EMA/ATR/RSI prefix',()=>{
 const scenarios=[{p:s03Parameters(),bars:Array.from({length:600},(_,i)=>{const close=60000+i*.17+Math.sin(i*.35)*500;return {time:i*300,open:close,close,high:close+100+(i%7)*13,low:close-100-(i%5)*17,volume:100};})},{p:s03Parameters({ema_fast:10,ema_slow:30,rsi_period:5,atr_period:5,rsi_cross:48,rsi_ceiling:62,rsi_fail:42},'s03-oracle-custom'),bars:series(350)},{p:s03Parameters(),bars:Array.from({length:300},(_,i)=>bar(i,100))},{p:s03Parameters(),bars:Array.from({length:300},(_,i)=>bar(i,200-i*.1))}];
 const python=`import json,sys,nautilus_trader\nfrom nautilus_trader.indicators import ExponentialMovingAverage,RelativeStrengthIndex,AverageTrueRange,MovingAverageType\nassert nautilus_trader.__version__=='2.0.0rc3'\nresult=[]\nfor case in json.load(sys.stdin):\n p=case['p'];f=ExponentialMovingAverage(p['ema_fast']);s=ExponentialMovingAverage(p['ema_slow']);r=RelativeStrengthIndex(p['rsi_period'],MovingAverageType.Wilder);a=AverageTrueRange(p['atr_period'],MovingAverageType.Wilder,True);out=[]\n for b in case['bars']:\n  f.update_raw(b['close']);s.update_raw(b['close']);r.update_raw(b['close']);a.update_raw(b['high'],b['low'],b['close']);out.append(dict(emaFast=f.value,emaSlow=s.value,rsi=r.value*100,atr=a.value,nativeReady=f.initialized and s.initialized and r.initialized and a.initialized))\n result.append(out)\nprint(json.dumps(result))`;
 const run=spawnSync(nativePython,['-c',python],{input:JSON.stringify(scenarios),encoding:'utf8',maxBuffer:2e6,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:20000});assert.equal(run.status,0,run.stderr);const oracle=JSON.parse(run.stdout);
 scenarios.forEach((scenario,index)=>s03Indicators(scenario.bars,scenario.p).forEach((actual,i)=>{const expected=oracle[index][i];assert.equal(actual.nativeReady,expected.nativeReady);for(const key of ['emaFast','emaSlow','atr','rsi'])assert.equal(actual[key],expected[key],`${index}:${i}:${key}: differs from native rc3`);}));
});

test('actual core domain enforces the exclusive five-second deadline and a fresh cross after the third cooldown close',()=>{
 const bars=series(251).map(value=>{const close=Number(value.close.toFixed(2));return {...value,open:close,close,high:Number((close+.4).toFixed(2)),low:Number((close-.4).toFixed(2))};});
 // Existing native classes and lifecycle boundary functions only: no ControlStore
 // is constructed/opened, no activation, orders, database or venue is touched.
 const python=`import json,sys\nfrom dataclasses import replace\nfrom stark_trading_os.domain.s03_signal import S03Parameters\nfrom stark_trading_os.domain.s03_bridge import S03RawBar,S03Life,_native_bar,_full_bar\nfrom stark_trading_os.runner.s03_indicators import S03SignalStream\nfrom stark_trading_os.control.s03_bridge import S03BridgeControl\nbars=json.load(sys.stdin);ns=10**9;ttl=[];valid=None\nfor delay in [4,5,6]:\n stream=S03SignalStream(S03Parameters(),'BTCUSDT.SIM','a'*64,seed_close_ns=300*ns)\n for i,b in enumerate(bars):\n  close=(b['time']+300)*ns;available=close+(delay*ns if i==len(bars)-1 else 0);raw=S03RawBar(open=str(b['open']),high=str(b['high']),low=str(b['low']),close=str(b['close']),volume=str(b['volume']),bar_close_ns=close,ts_init_ns=available,available_at_ns=available);obs=stream.update(_native_bar(raw,'BTCUSDT.SIM'),source_revision='a'*64,available_at_ns=available)\n ttl.append(dict(delay=delay,expired=obs.expired,signal=obs.signal is not None))\n if delay==4:valid=obs\nassert valid is not None and valid.signal is not None\nflat=(bars[-1]['time']+310)*ns;closes=[(bars[-1]['time']+300*(i+2))*ns for i in range(5)];full=[_full_bar(replace(valid,bar_close_ns=close),flat) for close in closes];completed=[close for close,ok in zip(closes,full) if ok][2]\nlife=S03Life(flat_ns=flat,cooldown_bars=3,cooldown_open_after_ns=completed);bridge=object.__new__(S03BridgeControl);bridge._life=lambda run_id:life\nblocked=[bridge._entry_rejection('offline-boundary',replace(valid.signal,bar_close_ns=close)) for close in [completed,completed+300*ns]]\nprint(json.dumps(dict(ttl=ttl,full=full,blocked=blocked)))`;
 const run=spawnSync(nativePython,['-c',python],{input:JSON.stringify(bars),encoding:'utf8',env:{...process.env,PYTHONPATH:nativeSource,PYTHONDONTWRITEBYTECODE:'1'},timeout:20000});assert.equal(run.status,0,run.stderr);const oracle=JSON.parse(run.stdout);
 for(const native of oracle.ttl){const strategy=createS03Strategy();feed(strategy,bars.slice(0,-1));const last=bars.at(-1),value=strategy.onBar(last,{now:last.time+300+native.delay});assert.equal(value.decision.candidate.status==='expired',native.expired);assert.equal(native.signal,!native.expired);if(native.delay===5)assert.throws(()=>strategy.applyPaperReceipt({id:'at-deadline',type:'submitted',candidateId:value.decision.candidate.id,intentId:'expired',at:last.time+305,stop:value.decision.candidate.riskProposal.stopUnrounded}),/INTENT_INVALID/);}
 assert.deepEqual(oracle.full,[false,true,true,true,true]);assert.deepEqual(oracle.blocked,['S03_COOLDOWN_SIGNAL',null]);
 const {strategy,candidate}=filled();strategy.applyPaperReceipt({id:'flat-native-boundary',type:'flat',intentId:'intent-one',at:75310,confirmed:true,ordersTerminal:true,inventoryQty:0});
 for(const [i,offset] of [[251,-.2],[252,-.4],[253,-.6],[254,.1]]){const value=strategy.onBar(bar(i,candidate.signal.close+offset),{now:(i+1)*300});assert.equal(value.conditions.cooldown,false);assert.equal(value.decision,null);if(i===254)assert.equal(value.conditions.cross,true,'the third cooldown bar itself contains a real crossing that must be discarded');}
 const after=strategy.onBar(bar(255,candidate.signal.close+.2),{now:76800});assert.equal(after.conditions.cooldown,true);assert.equal(after.conditions.cross,false);assert.equal(after.decision,null,'the previous blocked crossing is never replayed');
});
