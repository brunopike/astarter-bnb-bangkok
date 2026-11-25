import {clearBotEditor,STRATEGY_MARKETS,strategyVenues,defaultStrategyRoute} from './strategy-routing.mjs';
import {protectionConfig,protectionKey} from './strategy-protection.mjs';
import {defaultBotVariant} from './strategy-execution-data.mjs';
import {strategyById} from './strategy-catalog.mjs';
import {publicRunSignals} from './signal-tracking.mjs';
import {BOT_MARKETS,isBotSimulation} from './bot-runtime.mjs';
import {translate} from './locale.mjs';
// Deterministic product simulation. No model call, address lookup or exchange API.
export const QUESTIONS=[
 {key:'goal',title:['希望这套策略帮你做什么？','What should this strategy do for you?'],hint:['选最像你的一项，后面都能改。','Choose what suits you. You can change this later.'],choices:[['observe','先观察，只接收提醒','Observe first, with alerts only'],['steady','少打扰，在限制内执行','Run within limits, with fewer interruptions'],['active','主动交易，我来调优','Active trading, with my own tuning']]},
 {key:'capital',title:['这套策略最多使用多少资金？','How much can this strategy use?'],hint:['这里只分配模拟额度，不发生转账。','This allocates simulated capital; no transfer occurs.'],choices:[['300','300 USDT','300 USDT'],['1000','1,000 USDT','1,000 USDT'],['3000','3,000 USDT','3,000 USDT']]},
 {key:'risk',title:['你希望的亏损暂停线是多少？','What loss pause limit would you like?'],hint:['先记录为草稿偏好，不改变当前账户或运行的实际限制。批准前会列出实际生效的限制；跳空可能超过计划损失。','Saved as a draft preference without changing current limits. Review the effective limits before approval; gaps can exceed planned loss.'],choices:[['low','额度的 1% · 谨慎','1% of allocation · cautious'],['medium','额度的 3% · 适中','3% of allocation · moderate'],['high','额度的 5% · 较高','5% of allocation · higher']]},
 {key:'pace',title:['希望以什么节奏研究？','How much research do you want?'],hint:['设定研究上限，不会立刻扣积分，也不会自动开启研究。','Set a research limit. No credits are charged and automatic research stays off.'],choices:[['quiet','精简观察','Light observation',1],['balanced','均衡研究','Balanced research',3],['deep','深入研究','Deeper research',6]]},
 {key:'autonomy',title:['希望 Agent 怎么帮你？','How should your Agent work?'],hint:['先检查账户和风险，再按你的选择处理。','All modes remain subject to limits, risk checks and prechecks.'],choices:[['auto','按我的设置自动执行','Execute within my limits'],['signal','先观察，有机会提醒我','Observe and notify me']]}
];
const lossRates={low:.01,medium:.03,high:.05};
export function profileLossLimit(capital,risk){
 const amount=Number(capital);return Number.isFinite(amount)&&amount>0&&Object.hasOwn(lossRates,risk)?Math.round(amount*lossRates[risk]):null;
}
export function recommend(a,researchCost=100){
 if(!Number.isSafeInteger(researchCost)||researchCost<0)return null;
 if(QUESTIONS.some(q=>!q.choices.some(c=>c[0]===a[q.key])))return null;
 const cap=Number(a.capital),riskRate=lossRates[a.risk];
 const amount=Math.max(10,Math.round(cap*({low:.03,medium:.06,high:.1}[a.risk])*(a.goal==='active'?1:.75)));
 // An explicit signal-only goal wins over a conflicting automation answer.
 const mode=a.goal==='observe'?'signal':a.autonomy;
 const strategy=a.goal==='observe'?'RX01':a.goal==='active'?'S04':a.risk==='low'?'S07':'S03';
 return {strategy,amount,cap,mode,dailyLoss:profileLossLimit(cap,a.risk),daily:researchCost*QUESTIONS.find(q=>q.key==='pace').choices.find(c=>c[0]===a.pace)[3],riskRate,conflict:a.goal==='observe'&&a.autonomy!=='signal',policy:'PROFILE-SIM-2'};
}
export function strategySetupCosts(w){
 return {check:w.quote(16),checkHeld:w.quote(20),start:w.quote(4),research:w.quote(8),researchUsed:w.quote(6),daily:w.account?w.account.s.preferences.autoBudget:w.s.budget.daily,available:w.available};
}
export function runnableRecommendation(answers,researchCost=100){return recommend(answers,researchCost);}
export const RESEARCH_STRATEGIES=Object.freeze({BTC:'S03',ETH:'RX03-S',SOL:'RX02-A'});
const MARKET_KINDS={SPOT:'spot',PERP:'perp',PERPETUAL:'perp',LP:'lp'};

function recommendationInstrument(input,symbol,market){
 const raw=input&&typeof input==='object'&&!Array.isArray(input)?input:{},instrument={symbol,market};
 for(const key of ['symbol','market','profileId','venueId','chainId'])if(raw[key]!=null&&['string','number'].includes(typeof raw[key]))instrument[key]=raw[key];
 if(Number.isSafeInteger(instrument.chainId)&&instrument.chainId>0)instrument.chainId=String(instrument.chainId);
 if(raw.symbol==null&&typeof raw.market==='string'&&/^[A-Z0-9]{1,20}\/[A-Z0-9]{1,12}$/.test(raw.market))instrument.symbol=raw.market.split('/')[0];
 if(instrument.venueId==null&&typeof raw.venue==='string')instrument.venueId=raw.venue;
 if(instrument.profileId==null){
  const kind=MARKET_KINDS[raw.marketType];
  const profile=kind&&STRATEGY_MARKETS.find(p=>p.id.endsWith('-'+kind)&&strategyVenues(p.id).some(v=>v.id===instrument.venueId));
  if(profile)instrument.profileId=profile.id;
 }
 return instrument;
}
function recommendationInstrumentIssue(strategy,instrument,raw){
 const invalid=raw!=null&&(typeof raw!=='object'||Array.isArray(raw)||['symbol','market','profileId','venueId','chainId'].some(key=>raw[key]!=null&&!['string','number'].includes(typeof raw[key]))||raw.chainId!=null&&(!/^[1-9]\d*$/.test(String(raw.chainId))||!Number.isSafeInteger(Number(raw.chainId))));
 const seed=defaultStrategyRoute(strategy,{market:instrument.market,executionRoute:instrument});
 const fields=['market','profileId','venueId',...(seed.profileId.startsWith('dex')?['chainId']:[])];
 const type=MARKET_KINDS[raw?.marketType];
 return invalid||instrument.symbol!==String(instrument.market).split('/')[0]||fields.some(key=>instrument[key]!=null&&instrument[key]!==''&&String(instrument[key])!==seed[key])||type&&type!==seed.profileId.split('-')[1]?['该市场或场所尚未适配这套方案','This market or venue is not supported by this plan']:null;
}
// Project existing research and signals; this never runs a model, reserves funds or starts a bot.
export function strategyRecommendations(w,snapshot={},now=Date.now()){
 const rows=[],copy=text=>[String(text||''),translate(String(text||''),'en')];
 const add=row=>{
  row.id=JSON.stringify([row.sourceType,row.sourceId,row.sourceRevision,row.sourceRef.recordId||row.sourceRef.taskId,row.strategy,row.variant,row.market,row.clockKind,row.asOf,row.expiresAt,...['symbol','profileId','venueId','chainId'].map(key=>row.source.instrument[key]??null)]);
  row.source.recommendationId=row.id;rows.push(row);
 };
 for(const record of publicRunSignals(w?.s?.signals||[],snapshot)){
  if(!strategyById(record.strategy))continue;
  const {symbol:asset,market,venue,marketType}=record.instrument,strategy=record.strategy,native=isBotSimulation({strategy,planVariant:defaultBotVariant(strategy)}),variant=native?null:defaultBotVariant(strategy);
  const instrument=recommendationInstrument(record.instrument,asset,market),instrumentIssue=recommendationInstrumentIssue(strategy,instrument,record.instrument);
  const clock=record.clockKind==='wall'?now:snapshot.time,hasTime=Number.isFinite(record.observedAt)&&Number.isFinite(clock)&&record.observedAt<=clock;
  const expired=record.validity==='expired'||record.validUntil!==null&&Number.isFinite(clock)&&clock>=record.validUntil;
  let issue=!hasTime?['来源时间需要核对','Review the source time']:expired?['这条信号已过期，请查看最新研究','This signal expired. Review the latest research']:record.validUntil===null?['来源未提供有效期，先补充研究','The source has no expiry. Update the research first']:record.direction!=='buy'?['这条信号不支持新增买入','This signal does not support a new buy']:record.stage!=='analysis'?['这条信号已有交易记录，请先查看原运行','This signal already has trading activity. Review the original run']:instrumentIssue||(native&&(venue!=='binance'||!Object.hasOwn(BOT_MARKETS,market))?['该市场或场所尚未适配这套方案','This market or venue is not supported by this plan']:null);
  // The current public signal record omits planVariant and entry/invalidation evidence.
  const canAdopt=!issue&&!native;
  add({strategy,variant,asset,market,sourceId:record.signalId,sourceRevision:record.version,sourceType:'signal',asOf:record.observedAt,clockKind:record.clockKind,expiresAt:record.validUntil,expiryKind:'time',
   dataAsOf:null,freshness:expired?'expired':'unknown',
   reason:record.condition?copy(record.condition):['信号提供策略线索，采用后核对入场、退出与投入','Use the signal as a starting point, then review entries, exits and allocation'],
   status:issue?'unavailable':'research',canAdopt,executable:false,
   unavailableReason:issue||(native?['尚未核实执行版本、入场与失效依据，请先查看原信号','The execution version, entry and invalidation evidence are unverified. Review the original signal']:['该版本目前用于研究，尚未开放机器人模拟','This version is a research plan; bot simulation is not available']),
   sourceHref:'?page=signals',sourceRef:{type:'signal',recordId:[record.sourceId,record.version,record.runId,record.signalId].join(':'),sourceId:record.sourceId,signalId:record.signalId,runId:record.runId,revision:record.version,asset},source:{type:'signal',id:record.signalId,revision:record.version,instrument,recordedAt:record.clockKind==='simulation'?`SIM T+${Math.round(record.observedAt)}s`:record.observedAt,reason:record.condition||''}});
 }
 const research=w?.research;
 for(const task of research?.tasks||[]){
  const strategy=task.strategy??RESEARCH_STRATEGIES[task.symbol];
  if(!strategyById(strategy)||task.domain!=='Crypto'||!research.accepts(task))continue;
  const revision=research.revision(task),handoff=research.handoff(task.symbol),asOf=Number.isFinite(task.completed)?task.completed:null;
  const native=isBotSimulation({strategy,planVariant:defaultBotVariant(strategy)}),conflict=task.evidence?.some(e=>e.status==='conflict'),missing=task.evidence?.some(e=>e.status==='missing');
  let issue=task.phase!=='complete'?['研究还在汇总，请等待最新结论','Research is still in progress. Wait for the updated conclusion']:task.outcome==='conflict'||conflict?['研究存在分歧，先核对依据','Research has conflicting evidence. Review it first']:task.outcome==='missing'||missing?['研究缺少必要依据，请先补充','Required research evidence is missing']:task.outcome!=='candidate'?['当前结论是继续观察，尚不形成交易方案','The current conclusion is to watch, without a trading plan']:!handoff||handoff.revision!==revision||asOf===null||asOf>research.time?['研究版本或时间需要重新核对','Review the research version and time']:native?['研究未提供这套原生策略的执行依据，请先补充','Research has not provided an execution plan for this native strategy']:null;
  const instrument=recommendationInstrument(task.instrument,task.symbol,task.symbol+'/USDT'),market=instrument.market,asset=instrument.symbol;
  issue=issue||recommendationInstrumentIssue(strategy,instrument,task.instrument);const canAdopt=!issue;
  add({strategy,variant:defaultBotVariant(strategy),asset,market,sourceId:task.id,sourceRevision:revision,sourceType:'research',asOf,clockKind:'simulation',expiresAt:null,expiryKind:'source-version',dataAsOf:null,freshness:'unknown',reason:copy(task.thesis||task.title),status:canAdopt?'research':'unavailable',canAdopt,executable:false,
   unavailableReason:issue||['研究建议已整理；当前行情和执行条件仍需单独核对','Review the research plan; current market data and execution conditions still need checking'],sourceHref:'?page=opportunities',sourceRef:{type:'research',taskId:task.id,revision,asset:task.symbol,asOf},
   source:{type:'research',id:task.id,revision,instrument,recordedAt:asOf===null?null:`SIM T+${Math.round(asOf)}s`,reason:task.thesis||task.title||''}});
 }
 const rank={ready:0,research:1,unavailable:2};
 return rows.sort((a,b)=>rank[a.status]-rank[b.status]||a.asset.localeCompare(b.asset)||a.id.localeCompare(b.id));
}
const applying=new WeakMap();
export function applyRecommendation(w,answers){
 if(applying.has(w))return applying.get(w);
 const pending=saveRecommendation(w,answers).finally(()=>applying.delete(w));applying.set(w,pending);return pending;
}
async function saveRecommendation(w,answers){
 const r=runnableRecommendation(answers,w.quote(8));
 if(!r)return {error:'answers'};
 const t=w.s.trade;
 const previous=w.s.advisor?.draftId?w.draft(w.s.advisor.draftId):null;
 if(t?.discovery?.armed||t?.session&&t.state!=='stopped'||t?.position||t?.pending||w.s.drafts.some(d=>d.status==='validating'))return {error:'busy'};
 if(previous&&(t?.discovery?.armed&&w.s.strategyCenterArmedDraftId===previous.id||t?.session?.draftId===previous.id&&t.state!=='stopped'||previous.status==='validating'))return {error:'busy'};
 const protection=protectionConfig('astarter',answers.risk==='low'?'conservative':'normal');
 const same=previous?.strategy===r.strategy;
 if(same&&QUESTIONS.every(q=>previous.advisor?.answers?.[q.key]===answers[q.key]))return {draft:previous};
 // Applying advice edits the same draft; account-wide risk and research budgets stay user-owned.
 const draft=same?previous:await w.createManagedDraft(r.strategy);
 if(!draft)return {error:'resource'};
 const error=w.saveDraft(draft.id,{...r,protection});if(error)return {error:'draft',message:error};
 draft.combination=true;draft.advisor={...r,answers:{...answers}};
 w.s.advisor={...w.s.advisor,answers:{...answers},draftId:draft.id};
 clearBotEditor(w,draft.strategy);
 w.s.setupStep=3;w.s.setupPrecheckId=null;w.touch();return {draft};
}
export function publicAddressValid(value,chain){
 const v=String(value||'').trim();
 if(chain==='evm')return /^0x[\da-fA-F]{40}$/.test(v);
 if(chain!=='solana'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))return false;
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;
 for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));
 let bytes=0;while(n){bytes++;n>>=8n;}return bytes+(v.match(/^1*/)?.[0].length||0)===32;
}
export const COPY_DEFAULTS={market:'spot',sizing:'fixed',amount:50,ratio:10,cap:300,assetCap:150,maxDelay:30,maxGap:1,maxSlippage:.5,minLiquidity:100000,maxLeverage:2,stopLoss:5,followExit:true};
export function copyConfigError(p){
 const ranges={amount:[10,1000],ratio:[1,100],cap:[10,3000],assetCap:[10,3000],maxDelay:[1,120],maxGap:[.1,5],maxSlippage:[.1,3],minLiquidity:[1000,10000000],maxLeverage:[1,3],stopLoss:[1,20]};
 if(!['spot','perp'].includes(p.market)||!['fixed','ratio'].includes(p.sizing))return 'invalid-mode';
 if(Object.entries(ranges).some(([k,[min,max]])=>!Number.isFinite(Number(p[k]))||Number(p[k])<min||Number(p[k])>max))return 'invalid-limit';
 if(Number(p.amount)>Number(p.assetCap)||Number(p.assetCap)>Number(p.cap))return 'invalid-cap';
 return null;
}
export const COPY_EVENTS=[
 {id:'F-01',kind:'transfer',symbol:'SOL',side:'buy',notional:500,age:2,gap:.2,slippage:.2,liquidity:2000000},
 {id:'F-02',kind:'fill',symbol:'SOL',side:'buy',notional:500,age:4,gap:.3,slippage:.2,liquidity:2000000},
 {id:'F-02',kind:'fill',symbol:'SOL',side:'buy',notional:500,age:4,gap:.3,slippage:.2,liquidity:2000000},
 {id:'F-03',kind:'fill',symbol:'SOL',side:'buy',notional:800,age:70,gap:1.8,slippage:.7,liquidity:2000000},
 {id:'F-04',kind:'fill',symbol:'ETH',side:'sell',notional:300,age:3,gap:.2,slippage:.2,liquidity:3000000},
 {id:'F-05',kind:'fill',symbol:'SOL',side:'sell',notional:250,sellFraction:.5,age:5,gap:.2,slippage:.2,liquidity:2000000},
 {id:'F-06',kind:'fill',symbol:'NEW',side:'buy',notional:900,age:2,gap:.2,slippage:.2,liquidity:20000},
 {id:'R-01',kind:'risk',symbol:'SOL',drawdown:6},
 {id:'F-07',kind:'fill',symbol:'SOL',side:'buy',notional:500,age:2,gap:.2,slippage:.2,liquidity:2000000,leverage:4}
];
// A bounded event replay with owned-lot accounting. No order is sent to the main execution engine.
export function replayCopy(p,events=COPY_EVENTS){
 if(copyConfigError(p))throw Error('Invalid copy configuration');
 const seen=new Set(),owned={},records=[];let used=0,halted=false;
 for(const event of events){const r={...event,status:'skipped',reason:'',amount:0};
  if(event.kind==='risk'){if(event.drawdown>=Number(p.stopLoss)){r.amount=owned[event.symbol]||0;used-=r.amount;owned[event.symbol]=0;halted=true;r.status='paper-protection';r.reason='stop';}else r.reason='within-risk';}
  else if(event.kind!=='fill')r.reason='not-trade';
  else if(event.snapshot||seen.has(event.id))r.reason='duplicate';
  else{seen.add(event.id);
   if(halted&&event.side==='buy')r.reason='halted';
   else if(event.age>Number(p.maxDelay))r.reason='stale';
   else if(event.gap>Number(p.maxGap)||event.slippage>Number(p.maxSlippage))r.reason='price';
   else if(event.side==='sell'){
    if(!p.followExit)r.reason='exit-off';
    else if(!(owned[event.symbol]>0))r.reason='not-owned';
    else{r.amount=+(owned[event.symbol]*Math.min(1,Math.max(0,event.sellFraction??1))).toFixed(2);owned[event.symbol]-=r.amount;used-=r.amount;r.status='paper-exit';r.reason='owned-exit';}
   }else if(event.liquidity<Number(p.minLiquidity))r.reason='liquidity';
   else if(p.market==='perp'&&(event.leverage||1)>Number(p.maxLeverage))r.reason='leverage';
   else{const requested=p.sizing==='ratio'?event.notional*Number(p.ratio)/100:Number(p.amount);const amount=Math.max(0,Math.min(requested,Number(p.amount),Number(p.cap)-used,Number(p.assetCap)-(owned[event.symbol]||0)));
    if(amount<10)r.reason='cap';else{r.amount=+amount.toFixed(2);r.status='paper-entry';r.reason='accepted';owned[event.symbol]=(owned[event.symbol]||0)+r.amount;used+=r.amount;}}
  }records.push(r);
 }
 return {records,exposure:+used.toFixed(2),owned,accepted:records.filter(r=>r.status==='paper-entry').length};
}
