import {commerceFixture} from './commerce-test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {QUESTIONS,recommend,profileLossLimit,publicAddressValid,COPY_DEFAULTS,COPY_EVENTS,replayCopy,copyConfigError,applyRecommendation,strategySetupCosts,strategyRecommendations} from './strategy-advisor.mjs';
import {MultiResearch} from './multi-research.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {strategyById} from './strategy-catalog.mjs';
test('strategy advice preserves research provenance without turning retained evidence into a DCA executor',()=>{
 const research=new MultiResearch();research.advance(80);
 const w={research,s:{signals:[],drafts:[{id:'keep',amount:75,cap:375}]}},before=JSON.stringify({state:w.s,research:research.snapshot()});
 const rows=strategyRecommendations(w,{time:80}),eth=rows.find(r=>r.asset==='ETH');
 assert.ok(eth);assert.equal(eth.strategy,'RX03-S');assert.equal(eth.status,'research');assert.equal(eth.canAdopt,true);assert.equal(eth.executable,false);
 assert.equal(eth.sourceId,research.task('ETH').id);assert.equal(eth.sourceRevision,research.revision(research.task('ETH')));
 assert.equal(eth.asOf,research.task('ETH').completed);assert.equal(eth.clockKind,'simulation');assert.equal(eth.dataAsOf,null);assert.equal(eth.freshness,'unknown');assert.equal(eth.expiresAt,null);assert.equal(eth.expiryKind,'source-version');
 assert.ok(rows.filter(r=>['BTC','SOL'].includes(r.asset)).every(r=>!r.canAdopt&&!r.executable));
 assert.ok(rows.every(r=>r.strategy!=='S02'));assert.equal(JSON.stringify({state:w.s,research:research.snapshot()}),before);
 const oldId=eth.id;research.task('ETH').direction='sell';research.task('ETH').evidence.forEach(e=>{if(e.status!=='na')e.status='retain';});
 assert.ok(strategyRecommendations(w,{time:80}).every(r=>r.strategy!=='S02'&&!r.executable));
 research.task('ETH').strategy='S02';research.task('ETH').direction='buy';const insufficient=strategyRecommendations(w,{time:80}).find(r=>r.asset==='ETH');assert.equal(insufficient.canAdopt,false);assert.equal(insufficient.executable,false);delete research.task('ETH').strategy;
 research.task('ETH').evidence.find(e=>e.key==='risk').status='conflict';assert.equal(strategyRecommendations(w,{time:80}).find(r=>r.asset==='ETH').canAdopt,false);
 research.recheck('ETH');assert.ok(!strategyRecommendations(w,{time:80}).some(r=>r.id===oldId));
});
test('signal advice respects source time and does not infer an executable version from a strategy family',()=>{
 const signal={id:'SIG-1',sourceId:'AI-1',revision:'v1',runId:'RUN-1',strategy:'S01',market:'BTC/USDT',venueId:'binance',marketType:'SPOT',executionKind:'AI_AUTO',side:'buy',clockKind:'simulation',observedAt:100,validUntil:130};
 const w={s:{signals:[signal]}},snapshot={time:110,orders:[]};
 const row=()=>strategyRecommendations(w,snapshot)[0];
 assert.equal(row().status,'research');assert.equal(row().canAdopt,false);assert.equal(row().executable,false);assert.equal(row().variant,null);assert.equal(row().sourceId,'SIG-1');assert.equal(row().asOf,100);assert.equal(row().expiresAt,130);assert.equal(row().dataAsOf,null);
 signal.planVariant='S01-SIM';signal.condition='unfiltered condition';signal.invalidation='unfiltered stop';snapshot.botBook={runs:[{id:'RUN-1',plan:{strategy:'S01',planVariant:'S01-SIM'}}]};assert.equal(row().executable,false);assert.doesNotMatch(row().reason.join(' '),/unfiltered/);
 signal.strategy='S03';assert.equal(row().canAdopt,true);assert.equal(row().executable,false);assert.deepEqual(row().sourceRef,{type:'signal',recordId:'AI-1:v1:RUN-1:SIG-1',sourceId:'AI-1',signalId:'SIG-1',runId:'RUN-1',revision:'v1',asset:'BTC'});
 const id=row().id;assert.equal(row().id,id);snapshot.time=131;assert.equal(row().canAdopt,false);assert.match(row().unavailableReason.join(' '),/过期|expired/);
 snapshot.time=110;signal.observedAt=120;assert.equal(row().canAdopt,false);
 signal.observedAt=100;delete signal.validUntil;assert.equal(row().canAdopt,false);
 signal.validUntil=130;signal.side='sell';assert.equal(row().canAdopt,false);
 signal.side='buy';signal.strategy='S01';signal.venueId='okx';assert.equal(row().canAdopt,false);assert.equal(row().status,'unavailable');
 signal.venueId='binance';snapshot.orders=[{id:'O-1',signalId:'SIG-1',runId:'RUN-1'}];assert.equal(row().canAdopt,false);
 signal.strategy='S03';snapshot.orders=[];w.s.signals.push({...signal,runId:'RUN-2'});const both=strategyRecommendations(w,snapshot);assert.equal(both.length,2);assert.equal(new Set(both.map(r=>r.id)).size,2);assert.deepEqual(new Set(both.map(r=>r.sourceRef.runId)),new Set(['RUN-1','RUN-2']));
 w.s.signals=[{...signal,clockKind:'wall',observedAt:Date.now()-1000,validUntil:Date.now()+60_000}];const wall=row();assert.equal(wall.clockKind,'wall');assert.equal(wall.dataAsOf,null);assert.equal(wall.freshness,'unknown','a recent signal event is not proof of the underlying market-data time');
});
test('recommendation markets preserve explicit source context and never turn missing market type into perpetuals',()=>{
 const signal={id:'SIG-META',sourceId:'AI-META',revision:'v1',runId:'RUN-META',strategy:'S03',market:'ETH/USDT',venueId:'binance',side:'buy',observedAt:10,validUntil:100};
 const w={s:{signals:[signal]}},snapshot={time:20},read=()=>strategyRecommendations(w,snapshot)[0];
 for(const marketType of [undefined,null,'UNKNOWN']){signal.marketType=marketType;assert.equal(read().source.instrument.profileId,undefined);}
 signal.marketType='SPOT';assert.equal(read().source.instrument.profileId,'cex-spot');const spot=read();
 signal.marketType='PERP';assert.equal(read().source.instrument.profileId,'cex-perp');assert.equal(read().canAdopt,false);assert.notEqual(read().id,spot.id);assert.equal(read().sourceId,spot.sourceId);assert.equal(read().sourceRevision,spot.sourceRevision);
 const research=new MultiResearch();research.advance(80);const task=research.task('ETH'),before=JSON.stringify(task);
 const rw={research,s:{signals:[]}},base=strategyRecommendations(rw,{time:80}).find(r=>r.asset==='ETH');
 task.instrument={symbol:'WETH',market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:'8453',accountId:'private-account',secret:'private-secret'};
 const dex=strategyRecommendations(rw,{time:80}).find(r=>r.sourceId===task.id);
 assert.deepEqual(dex.source.instrument,{symbol:'WETH',market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:'8453'});assert.equal(dex.market,'WETH/USDC');assert.equal(dex.asset,'WETH');assert.equal(dex.canAdopt,true);assert.equal(dex.executable,false);assert.doesNotMatch(JSON.stringify(dex),/private-account|private-secret/);
 task.instrument.chainId=8453;assert.equal(strategyRecommendations(rw,{time:80}).find(r=>r.sourceId===task.id).id,dex.id,'numeric and canonical string chain IDs must resume the same source draft');
 task.instrument={...task.instrument,profileId:'dex-perp',venueId:'hyperliquid'};const perp=strategyRecommendations(rw,{time:80}).find(r=>r.sourceId===task.id);assert.equal(perp.source.instrument.profileId,'dex-perp');assert.equal(perp.canAdopt,false);assert.notEqual(perp.id,dex.id);assert.equal(perp.sourceRevision,dex.sourceRevision);
 delete task.instrument;assert.equal(JSON.stringify(task),before);assert.equal(strategyRecommendations(rw,{time:80}).find(r=>r.sourceId===task.id).id,base.id);
});
test('public DEX signal context reaches recommendation setup without losing the network or source identity',()=>{
 const signal={id:'SIG-DEX',sourceId:'AI-DEX',version:3,runId:'RUN-DEX',strategy:'RX03-S',market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:8453,marketType:'SPOT',side:'buy',observedAt:10,validUntil:100};
 const w={s:{signals:[signal]}},read=()=>strategyRecommendations(w,{time:20})[0],before=JSON.stringify(signal),row=read();
 assert.deepEqual(row.source.instrument,{symbol:'WETH',market:'WETH/USDC',profileId:'dex-spot',venueId:'uniswap',chainId:'8453'});assert.equal(row.canAdopt,true);assert.equal(row.executable,false);assert.equal(row.sourceId,'SIG-DEX');assert.equal(row.sourceRevision,'3');assert.equal(JSON.stringify(signal),before);
 signal.chainId=42161;const other=read();assert.notEqual(other.id,row.id);assert.equal(other.sourceId,row.sourceId);assert.equal(other.sourceRevision,row.sourceRevision);
 signal.profileId='dex-perp';signal.marketType='PERPETUAL';signal.venueId='hyperliquid';assert.equal(read().source.instrument.profileId,'dex-perp');assert.equal(read().canAdopt,false);assert.equal(read().executable,false);
});
test('questionnaire loss choices show actual money and preserve the selected pause threshold',async t=>{
 for(const [capital,expected] of [[300,[3,9,15]],[1000,[10,30,50]],[3000,[30,90,150]]])for(const [i,risk] of ['low','medium','high'].entries()){
  assert.equal(profileLossLimit(capital,risk),expected[i]);
  assert.equal(recommend({goal:'steady',capital:String(capital),risk,pace:'quiet',autonomy:'auto'}).dailyLoss,expected[i]);
 }
 for(const [capital,risk] of [[0,'low'],[-100,'low'],[NaN,'low'],[1000,'unknown']])assert.equal(profileLossLimit(capital,risk),null);
});
test('exactly five answers produce executable amount/cap/mode and bounded risk',async t=>{
 assert.equal(QUESTIONS.length,5);assert.equal(recommend({}),null);
 for(const goal of ['observe','steady','active'])for(const capital of ['300','1000','3000'])for(const risk of ['low','medium','high'])for(const pace of ['quiet','balanced','deep'])for(const autonomy of ['signal','auto']){
 const r=recommend({goal,capital,risk,pace,autonomy});const w=new WorkspaceSim();const d=w.createDraft(r.strategy);
 assert.equal(w.saveDraft(d.id,r),null);assert.equal(w.setRisk({cap:r.cap,dailyLoss:r.dailyLoss}),null);assert.equal(w.setBudget({daily:r.daily}),null);assert.equal(d.status,'draft');assert.equal(r.mode,goal==='observe'?'signal':autonomy);
 }
});
test('public addresses validate network and base58 byte length, not ownership',async t=>{
 assert.equal(publicAddressValid('0x'+'1'.repeat(40),'evm'),true);assert.equal(publicAddressValid('0x123','evm'),false);
 assert.equal(publicAddressValid('11111111111111111111111111111111','solana'),true);
 assert.equal(publicAddressValid('1'.repeat(44),'solana'),false);assert.equal(publicAddressValid('0'.repeat(32),'solana'),false);
});
test('copy replay excludes transfers, duplicate fills, stale events and unowned exits',async t=>{
 const r=replayCopy(COPY_DEFAULTS);assert.equal(r.records[0].reason,'not-trade');assert.equal(r.records[1].amount,50);assert.equal(r.records[2].reason,'duplicate');assert.equal(r.records[3].reason,'stale');assert.equal(r.records[4].reason,'not-owned');assert.equal(r.records[5].amount,25);assert.equal(r.records[6].reason,'liquidity');assert.equal(r.records[7].status,'paper-protection');assert.equal(r.records[8].reason,'halted');assert.equal(r.exposure,0);
});
test('copy notional caps and leverage are enforced; historical snapshots never replay',async t=>{
 assert.equal(copyConfigError({...COPY_DEFAULTS,cap:20}),'invalid-cap');assert.throws(()=>replayCopy({...COPY_DEFAULTS,amount:NaN}));
 const fill=COPY_EVENTS[1];const r=replayCopy({...COPY_DEFAULTS,cap:100,assetCap:100},Array.from({length:4},(_,i)=>({...fill,id:String(i)})));assert.equal(r.exposure,100);assert.equal(r.records[2].reason,'cap');
 assert.equal(replayCopy({...COPY_DEFAULTS,market:'perp'},[{...fill,leverage:4}]).records[0].reason,'leverage');
 assert.equal(replayCopy(COPY_DEFAULTS,[{...fill,snapshot:true}]).records[0].reason,'duplicate');
 assert.equal(replayCopy({...COPY_DEFAULTS,followExit:false},[fill,COPY_EVENTS[5]]).records[1].reason,'exit-off');
});
test('credit billing remains separate: BYOK rounding, cancellation and depleted budgets',async t=>{
 const w=new WorkspaceSim();w.setBudget({daily:200,byok:true});const {usage}=w.reserve('跟随规则演练',4,'COPY:1');assert.equal(usage.reserved,4);w.settle(usage.id,3);assert.equal(usage.settled,3);assert.equal(usage.released,1);assert.equal(w.settle(usage.id,3),false);
 const {usage:v}=w.reserve('策略检查',20,'draft');assert.equal(v.reserved,16);w.cancelUsage(v.id);assert.equal(v.released,16);assert.equal(w.spent,3);w.setBudget({daily:0});assert.ok(w.reserve('研究',8,'test').error);
});


test('recommended research limits follow the current quote, including plan and BYOK discounts',async t=>{
 const answers={goal:'steady',capital:'1000',risk:'low',pace:'balanced',autonomy:'auto'};
 assert.equal(recommend(answers,100).daily,300);assert.equal(recommend(answers,72).daily,216);
 assert.equal(recommend({...answers,pace:'quiet'},72).daily,72);assert.equal(recommend({...answers,pace:'deep'},72).daily,432);
 assert.equal(recommend(answers,0).daily,0);assert.equal(recommend(answers,NaN),null);
 assert.ok(!QUESTIONS.find(q=>q.key==='risk').title[1].includes('daily'));
});

const profile={goal:'steady',capital:'1000',risk:'medium',pace:'balanced',autonomy:'auto'};
test('five answers select a compatible method as well as amounts and limits',async t=>{
 for(const [answers,id] of [[profile,'S03'],[{...profile,goal:'observe'},'RX01'],[{...profile,goal:'active'},'S04'],[{...profile,risk:'low'},'S07']]){
  const r=recommend(answers);assert.equal(r.strategy,id);assert.equal(strategyById(r.strategy).execution,'spot');
 }
});
test('applying a profile saves a protected draft without charging or duplicating it',async t=>{
 const {workspace:w}=await commerceFixture(t);const count=w.s.drafts.length,balance=w.available,budget=w.account.s.preferences.autoBudget,risk=JSON.stringify(w.s.risk);
 const {draft}=(await applyRecommendation(w,profile));assert.equal(w.s.drafts.length,count+1);assert.equal(draft.amount,recommend(profile).amount);assert.equal(draft.cap,1000);assert.equal(draft.protection.id,'astarter');assert.equal(w.s.budget.daily,budget);assert.equal(JSON.stringify(w.s.risk),risk);assert.equal(w.available,balance);assert.equal(w.s.usage.length,0);assert.equal(w.account.s.preferences.autoEnabled,false);
 assert.equal((await applyRecommendation(w,profile)).draft.id,draft.id);assert.equal(w.s.drafts.length,count+1);
 w.saveDraft(draft.id,{...draft,amount:30});assert.equal((await applyRecommendation(w,profile)).draft.id,draft.id);assert.equal(draft.amount,30);
});
test('incomplete, active and resource-blocked profiles preserve current settings',async t=>{
 const w=new WorkspaceSim();const initial=JSON.stringify(w.s);assert.equal((await applyRecommendation(w,{})).error,'answers');assert.equal(JSON.stringify(w.s),initial);
 for(const trade of [{discovery:{armed:true}},{position:{qty:1}},{pending:{id:'P'}},{session:{id:'S'},state:'paused'}]){
  w.s.trade=trade;const before=JSON.stringify(w.s);assert.equal((await applyRecommendation(w,profile)).error,'busy');assert.equal(JSON.stringify(w.s),before);
 }
 w.s.trade=null;w.createManagedDraft=()=>null;const before=JSON.stringify(w.s);assert.equal((await applyRecommendation(w,profile)).error,'resource');assert.equal(JSON.stringify(w.s),before);
});
test('setup costs use the same membership quote as the ledger, including BYOK',async t=>{
 const {workspace:w}=await commerceFixture(t);let cost=strategySetupCosts(w);assert.equal(cost.check,0);assert.equal(cost.start,0);assert.equal(cost.research,w.quote(8));assert.equal(cost.researchUsed,w.quote(6));assert.equal(cost.daily,w.account.s.preferences.autoBudget);
 w.account.payers={model:'own',data:'official'};cost=strategySetupCosts(w);assert.equal(cost.research,w.account.price(8));assert.equal(cost.research,29);
 const legacy=new WorkspaceSim();assert.equal((await applyRecommendation(legacy,profile)).draft.advisor.daily,legacy.quote(8)*3);cost=strategySetupCosts(legacy);assert.equal(cost.check,16);assert.equal(cost.checkHeld,20);assert.equal(cost.research,8);assert.equal(cost.researchUsed,6);assert.equal(cost.start,4);
});
test('strategy setup preserves the current payer selection instead of a stale workspace preference',async t=>{
 const {account,workspace:w}=await commerceFixture(t);account.payers={model:'own',data:'official'};
 assert.equal(w.s.budget.byok,false);
 const {draft}=(await applyRecommendation(w,profile));
 assert.equal(account.payers.model,'own');assert.equal(w.s.budget.byok,false);assert.equal(draft.advisor.daily,87);assert.equal(strategySetupCosts(w).research,29);
});

test('legacy approval answers require a fresh choice and do not silently enable automatic trading',async t=>{
 const w=new WorkspaceSim(),before=JSON.stringify(w.s),answers={...profile,autonomy:'confirm'};
 assert.equal(recommend(answers),null);assert.equal((await applyRecommendation(w,answers)).error,'answers');assert.equal(JSON.stringify(w.s),before);
});
