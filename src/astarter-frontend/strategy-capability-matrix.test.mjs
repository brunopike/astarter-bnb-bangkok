import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG,BOT_PRODUCT_CAPABILITIES,strategyById} from './strategy-catalog.mjs';
import {EXECUTION_DEFAULTS,strategyPlan,strategyVariants} from './strategy-execution-data.mjs';
import {s03Parameters,s03RiskProposal,S03_SOURCE} from './strategy-s03.mjs';

// S1 capability matrix: users choose a method; the engine executes a frozen rule version.
const IDS=['S00','S01','S02','S03','S04','S05','S06','S07','S08','S09-A','S09-L','RX01','RX02-P','RX02-A','RX03-S','RX03-B','RX04','RX05'];

test('S1 matrix covers exactly the 18 strategies, each with a frozen version and unit-bearing parameters',()=>{
 assert.deepEqual(CATALOG.map(s=>s.id),IDS);
 for(const s of CATALOG){
  const record=EXECUTION_DEFAULTS[s.id];assert.ok(record,s.id);
  assert.equal(record.version,s.version,s.id);assert.equal(record.nativeAccepted,false,s.id);
  assert.ok(typeof record.phase==='string'&&record.phase.length,s.id);
  assert.ok(Object.keys(record.parameters).length>0,s.id);
  for(const [key,item] of Object.entries(record.parameters))assert.ok(typeof item.unit==='string'&&item.unit.length>0,`${s.id}.${key}`);
  assert.ok(s.market&&s.timeframe&&s.data&&s.risk,s.id);
 }
});

test('S1 matrix: only the S03 baseline and the S01/S02 simulation variants have a run flow; none is native-accepted',()=>{
 assert.deepEqual(CATALOG.filter(s=>strategyPlan(s.id)?.flowAvailable).map(s=>s.id),['S03']);
 const sim=CATALOG.flatMap(s=>strategyVariants(s.id).filter(v=>v.kind==='simulation').map(v=>({id:s.id,variant:v.id,plan:strategyPlan(s.id,v.id)})));
 assert.deepEqual(sim.map(v=>`${v.id}:${v.variant}`),['S01:S01-SIM','S02:S02-SIM']);
 for(const {plan} of sim){assert.equal(plan.flowAvailable,true);assert.equal(plan.record.phase,'LOCAL_SIMULATION');assert.equal(plan.nativeAccepted,false);}
 assert.equal(S03_SOURCE.nativeAccepted,false);
});

test('S1 matrix: the ten BOT product categories never add runnable strategies',()=>{
 assert.equal(BOT_PRODUCT_CAPABILITIES.length,10);
 assert.equal(new Set(BOT_PRODUCT_CAPABILITIES.map(p=>p.id)).size,10);
 for(const p of BOT_PRODUCT_CAPABILITIES){
  assert.equal(strategyById(p.id),undefined,p.id);assert.equal(strategyPlan(p.id),null,p.id);
  assert.ok(['family','candidate','execution'].includes(p.kind),p.id);
  if(p.kind!=='family')assert.equal(p.family,undefined,p.id);
 }
 assert.deepEqual(BOT_PRODUCT_CAPABILITIES.filter(p=>p.kind==='family').map(p=>[p.id,p.family]),[['spot-grid','S01'],['spot-dca','S02']]);
 assert.equal(CATALOG.length,18);
});

test('S1 matrix: S01 keeps four equal buy levels and S02 keeps three layers 1/1.5/2.25; the grid chart is a preview',()=>{
 const s01=EXECUTION_DEFAULTS.S01.parameters,s02=EXECUTION_DEFAULTS.S02.parameters,vp=EXECUTION_DEFAULTS['S02-VP'].parameters;
 assert.equal(s01.levels.value,4);assert.deepEqual(s01.size_weights.value,['1','1','1','1']);
 assert.equal(s02.physical_layers.value,3);assert.deepEqual(s02.size_weights.value,['1','1.5','2.25']);
 assert.equal(vp.physical_layers.value,3);assert.deepEqual(vp.size_weights.value,['1','1.5','2.25']);
 assert.match(strategyById('S01').entry,/i=1\.\.4/);assert.match(strategyById('S02').entry,/1\/1\.5\/2\.25/);
 const grid=BOT_PRODUCT_CAPABILITIES.find(p=>p.id==='spot-grid');
 assert.match(grid.detail[0],/预览/);assert.match(grid.detail[1],/preview/);
});

test('S1 matrix: S03 keeps its original 0.5% risk, 20% notional and 2% daily-loss contract',()=>{
 const p=EXECUTION_DEFAULTS.S03.parameters;
 assert.equal(p.risk_fraction.value,'0.005');assert.equal(p.notional_fraction.value,'0.20');
 assert.equal(p.risk_fraction.unit,'equity fraction');assert.equal(p.notional_fraction.unit,'equity fraction');
 const proposal=s03RiskProposal({close:60000,atr:500});
 assert.equal(proposal.riskFraction,.005);assert.equal(proposal.notionalFraction,.2);assert.equal(proposal.dailyLossFraction,.02);
 assert.equal(proposal.executionAuthority,'NONE');
 assert.match(strategyById('S03').risk,/r=0\.5%、名义20%、日损2%/);
 assert.throws(()=>s03Parameters({risk_fraction:.0051},'custom'),/S03_PARAMETERS_INVALID/);
 assert.throws(()=>s03Parameters({notional_fraction:.21},'custom'),/S03_PARAMETERS_INVALID/);
});
