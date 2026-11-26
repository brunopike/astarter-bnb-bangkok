import {MARKET} from './data-center-fixtures.mjs';
import {strategyPlan} from './strategy-execution-data.mjs';
import {computeMarketStudy} from './workbench-market-analysis.mjs';
import {candleRequest,normalizeKlines} from './trading-chart-data.mjs';

// Fixed-date observation scenarios. These records never authorize an order.
export const TRACKING_CUTOFF='2026-10-24 14:00';
export const TRACKING_STAGES={
 discovered:['首次发现','First seen'],
 confirming:['交叉确认','Cross-check'],
 momentum:['持续跟踪','Tracking'],
 risk:['风险变化','Risk change'],
 closed:['观察结束','Observation ended']
};
export const TRACKING_SOURCES={market:['价量异动','Price & volume'],onchain:['链上资金','On-chain flows'],money:['账户动向','Account activity'],social:['社媒异动','Social activity'],macro:['宏观联动','Macro']};
export const TRACKING_GUIDANCE={
 market:{checks:[['对照突破位置与后续成交','Compare the breakout area with subsequent trading activity'],['检查成交是否持续，而非单次放大','Check for sustained activity rather than one volume spike']],risk:['放量不等于持续买盘；回到原区间时需重新评估。','Higher volume does not prove persistent buying. Reassess if price returns to the prior range.']},
 onchain:{checks:[['核对净流入、地址标签与内部调拨','Check net flows, address labels and internal transfers'],['用现货成交交叉验证资金线索','Cross-check the flow lead against spot trading']],risk:['转账不等于买入；缺少成交确认时仍只作线索。','Transfers are not purchases. Without trading confirmation this remains a lead.']},
 social:{checks:[['去重讨论并核对独立出处','Deduplicate discussion and check independent sources'],['对照现货成交与杠杆情绪','Compare spot activity with leveraged sentiment']],risk:['讨论热度与价格涨幅不能替代独立证据。','Attention and price gains do not replace independent evidence.']},
 money:{checks:[['核对账户归属与仓位集中度','Check account attribution and position concentration'],['区分现货增仓与杠杆敞口','Separate spot accumulation from leveraged exposure']],risk:['地址不等于主体；仓位变化本身不能证明交易意图。','An address is not an owner. Position changes alone do not prove trading intent.']},
 macro:{checks:[['核对事件时点与原始来源','Check event timing and the original source'],['比较美元、利率与相关市场的反应','Compare the dollar, rates and related market responses']],risk:['短时相关性可能失效，不能预设事件结果。','Short-term correlations can break down. Do not assume the event outcome.']}
};
const profiles=[
 ['BTC','market',4,[0,.6,1.3,.8],['成交回升，区间上沿仍有抛压','Volume recovers near range resistance'],['买盘增加，但上沿挂单仍未明显减少。','Buying grows, but overhead offers have yet to ease.']],
 ['ETH','onchain',4,[0,.8,1.7,1.2],['稳定币流入与现货成交同步增加','Stablecoin inflows align with spot activity'],['资金线索得到成交侧支持，继续观察转账去向。','Trading activity supports the flow lead. Destination labels still matter.']],
 ['SOL','social',3,[0,1.1,.5],['讨论升温，合约与现货反应不同','Discussion rises as spot and derivatives diverge'],['讨论增加，资金费率也在升高，现货买盘尚未同步。','Attention and funding rise without matching spot demand.']],
 ['BNB','market',5,[0,.5,1.2,.4,.2],['价格触及区间上沿，成交放大','Price reaches range resistance as volume grows'],['成交峰值没有延续，区间突破未获确认。','The volume peak fades and the range break is unconfirmed.']],
 ['LINK','social',4,[0,.7,1.5,.6],['资金话题集中，价格反应仍需对照','Flow discussion concentrates; compare price'],['讨论集中于资金去向，独立来源与价格变化仍需交叉确认。','Discussion centers on fund destinations. Independent sources and price still need cross-checking.']],
 ['AAVE','onchain',3,[0,.4,1.1],['借贷需求抬升，资金利用率变化','Borrowing demand and utilization rise'],['借贷活动与价格一起走强，需要继续看净流入。','Borrowing activity and price rise. Net flows remain relevant.']],
 ['AVAX','market',5,[0,-.8,-1.7,-1.1,-.5],['急跌伴随成交放大','Volume expands during a sharp drop'],['价格开始修复，但修复过程中成交有所回落。','Price starts recovering while trading activity cools.']],
 ['HYPE','money',4,[0,.9,2.3,1.4],['观察账户增仓，同时使用杠杆','A tracked account adds a leveraged position'],['账户增仓提供线索，仍要检查集中仓位与杠杆风险。','The account adds a position. Concentration and leverage still need review.']],
 ['SUI','social',3,[0,.5,1.4],['独立讨论增加，继续对照成交','Independent discussion grows; compare volume'],['去重后讨论仍在增加，接下来观察成交能否延续。','Discussion grows after deduplication. Watch whether trading follows.']],
 ['SPX','macro',4,[0,.3,.7,.2],['事件窗口临近，股指与美元分化','Equities and dollar diverge before an event'],['股指抬升，但美元与利率反应不同，事件前继续观察。','Equities rise while dollar and rates diverge ahead of the event.']],
 ['NDX','macro',3,[0,.4,.9],['科技板块走强，广度仍需观察','Technology strengthens; breadth needs review'],['指数抬升集中于部分权重，板块广度没有同步改善。','A few large constituents lead; breadth has yet to improve.']],
 ['XAU','macro',5,[0,.3,.8,.5,.4],['黄金与实际利率出现短时联动','Gold and real yields align in the short term'],['原有联动随后减弱，继续观察新的事件窗口。','The original alignment weakens; watch the next event window.']]
];
const reasons={
 discovered:['出现新的观察条件，建立追踪记录','A new observation condition starts this track'],
 confirming:['补看成交、资金和独立来源','Comparing volume, flows and independent sources'],
 momentum:['原有线索继续出现，保留跟踪','The original observations persist'],
 risk:['线索持续性减弱，重新检查风险','Persistence weakens; reviewing the changed risk'],
 closed:['本轮观察条件不再持续，保留完整记录','The observation condition has ended; history remains available']
};
const stageKeys=Object.keys(TRACKING_STAGES);
export function createTrackingCases(markets=MARKET){
 return profiles.flatMap(([symbol,source,count,moves,title,thesis],i)=>{
  const asset=markets.find(a=>a.symbol===symbol);if(!asset)return [];
  const firstPrice=asset.price/(1+moves[count-1]/100),start=10*60+18+i*7;
  const events=moves.slice(0,count).map((move,j)=>{
   const minute=start+j*35,stage=stageKeys[j],price=firstPrice*(1+move/100);
   return {id:`TRACK-${symbol}-${j+1}`,caseId:symbol,symbol,source,stage,index:j,time:`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`,minute,date:'2026-10-24',price,change:(price/firstPrice-1)*100,title,reason:reasons[stage]};
  });
  const isCrypto=asset.domain==='Crypto',metrics=isCrypto?[
   {label:['24h 成交额','24h volume'],value:asset.volume*1e6,unit:'USD'},
   {label:['持仓变化 · 24h','OI change · 24h'],value:asset.oiChange,unit:'%'}
  ]:[{label:['24h 价格变化','24h price change'],value:asset.change,unit:'%'},{label:['关联事件','Related events'],value:source==='macro'?2:1,unit:['项','events']}];
  const href=source==='macro'?'?page=intelligence':source==='social'?`?page=social&asset=${symbol}`:source==='money'?'?page=social&data=demo&trader=orbit':source==='onchain'?symbol==='ETH'?'?page=tracking&metric=stablecoins':'?page=tracking':`?page=markets&asset=${symbol}`;
  return [{id:symbol,asset,source,title,thesis,events,firstPrice,currentPrice:events.at(-1).price,stage:events.at(-1).stage,metrics,href}];
 });
}
export const TRACKING_CASES=createTrackingCases();
export const SIGNAL_PREFERENCE_OPTIONS={scope:['all','crypto','tradfi'],focus:['all',...Object.keys(TRACKING_SOURCES)],strategy:['all','S00','RX03-S','S03']};
export function signalPreferences(value={}){
 return Object.fromEntries(Object.entries(SIGNAL_PREFERENCE_OPTIONS).map(([key,choices])=>[key,choices.includes(value?.[key])?value[key]:'all']));
}
// A historical topic can suggest a library rule, never prove which version produced the record.
export const signalStrategy=c=>c?.id==='BTC'&&c.source==='market'?'S00':c?.id==='ETH'&&c.source==='onchain'?'RX03-S':null;
export function filterSignalPreferences(rows,value){
 const p=signalPreferences(value);
 return rows.filter(({track:c})=>(p.scope==='all'||(p.scope==='crypto')===(c.asset.domain==='Crypto'))&&(p.focus==='all'||c.source===p.focus)&&(p.strategy==='all'||(c.record?c.record.strategy:signalStrategy(c))===p.strategy));
}
export function trackingRows(cases=TRACKING_CASES,{source='all',stage='all',query='',watched=[],watchOnly=false,asset='all',latestOnly=false}={}){
 const q=query.trim().toLowerCase(),symbol=cases.find(c=>c.id.toLowerCase()===q)?.id;
 return cases.filter(c=>(source==='all'||c.source===source)&&(asset==='all'||c.id===asset)&&(!watchOnly||watched.includes(c.id)))
  .flatMap(c=>c.events.filter(ev=>(!latestOnly||ev.id===c.events.at(-1)?.id)&&(stage==='all'||stage==='active'&&ev.stage!=='closed'||ev.stage===stage)&&(!q||(symbol?c.id===symbol:[c.id,c.asset.name,...c.title,...c.thesis,...TRACKING_STAGES[ev.stage],...TRACKING_SOURCES[c.source]].join(' ').toLowerCase().includes(q)))).map(ev=>({...ev,track:c})))
  .sort((a,b)=>(latestOnly?Number(a.stage==='closed')-Number(b.stage==='closed'):0)||b.minute-a.minute||a.id.localeCompare(b.id));
}

// Only this allowlist crosses into signal views, clipboard, exports and assistant sources.
const publicId=value=>typeof value==='string'&&/^[\w.:/@-]{1,100}$/.test(value)&&!/(?:0x[\da-f]{32,}|key|secret|token|password)/i.test(value)?value:null;
const publicVersion=value=>typeof value==='string'||Number.isSafeInteger(value)?publicId(String(value)):null;
const finite=value=>Number.isFinite(value)?value:null;
const publicProfileId=value=>['cex-spot','cex-perp','dex-spot','dex-perp','dex-lp'].includes(value)?value:null;
const publicChainId=value=>{
 const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
 return typeof id==='string'&&/^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id))?id:null;
};
export function publicRunSignals(signals=[],snapshot={}){
 const rows=new Map();
 for(const raw of Array.isArray(signals)?signals:[]){
  const id=publicId(raw?.id),runId=publicId(raw?.runId),market=typeof raw?.market==='string'&&/^[A-Z0-9]{1,20}[/][A-Z0-9]{1,12}$/.test(raw.market)?raw.market:null;
  if(!id||!runId||!market)continue;
  const plan=(snapshot.flow?.plans||[]).find(p=>p.signalId===id&&p.instanceId===runId),session=snapshot.session?.id===runId?snapshot.session:null;
  const strategySources=[raw,...(snapshot.flow?.plans||[]).filter(p=>p.signalId===id&&p.instanceId===runId),session].filter(Boolean),strategyIssues=[];
  const strategyField=(key,aliases=[key])=>{
   const values=strategySources.flatMap(source=>aliases.filter(alias=>source[alias]!==undefined&&source[alias]!==null).map(alias=>publicVersion(source[alias])));
   if(values.some(value=>value===null)||new Set(values).size>1)strategyIssues.push(key);
   return values.find(Boolean)||null;
  };
  const strategy=strategyField('strategy'),strategyVersion=strategyField('strategyVersion'),variant=strategyField('variant',['variant','planVariant']);
  const executionKind=raw.executionKind||plan?.executionKind||session?.executionKind;
  if(executionKind==='MANUAL'||session?.singleShot&&!session.mandateRef&&executionKind!=='AI_AUTO')continue;
  const sourceId=publicId(raw.sourceId)||publicId(raw.revision)||runId,clockKind=raw.clockKind==='wall'?'wall':'simulation';
  const orders=(snapshot.orders||[]).filter(o=>o.signalId===id&&o.runId===runId),order=orders[0];
  const displayMarket=order?.displayMarket||plan?.instrumentId?.split(':').at(-1),instrumentMarket=typeof displayMarket==='string'&&/^[A-Z0-9]{1,20}[/][A-Z0-9]{1,12}$/.test(displayMarket)?displayMarket:market;
  const venue=publicId(plan?.venueId)||publicId(order?.venueId)||publicId(raw.venueId),marketType=publicId(plan?.marketType)||publicId(order?.marketType)||publicId(raw.marketType);
  // Recover only matching canonical identity; missing market metadata is not a perpetual contract.
  const canonical=[plan?.instrumentId,order?.instrumentId,raw.instrumentId].map(value=>typeof value==='string'?/^([\w.-]+):(SPOT|PERPETUAL):([A-Z0-9]{1,20}\/[A-Z0-9]{1,12})$/.exec(value):null).find(parts=>parts&&publicId(parts[1])&&parts[3]===instrumentMarket&&(!venue||parts[1]===venue)&&(!marketType||parts[2]===marketType));
  const fills=(snapshot.flow?.fills||[]).filter(f=>orders.some(o=>o.id===f.orderId&&(!f.instrumentId||f.instrumentId===o.instrumentId)&&(!f.accountId||f.accountId===o.accountId))&&Number.isFinite(Number(f.quantity))&&Number(f.quantity)>0);
  const timestamp=value=>Number.isFinite(value)&&value>=0&&(clockKind!=='wall'||Number.isFinite(new Date(value).getTime()))?value:null;
  const at=timestamp(raw.observedAt??raw.at),validUntil=timestamp(raw.validUntil??raw.approval?.expiresAt),now=clockKind==='wall'?Date.now():finite(snapshot.time);
  const record={signalId:id,sourceId,runId,version:publicId(String(raw.version??raw.revision??'1')),sourceType:raw.sourceType==='autonomous'||executionKind==='AI_AUTO'?'autonomous':'bot',
   instrument:{symbol:instrumentMarket.split('/')[0],market:instrumentMarket,venue:venue||canonical?.[1]||null,marketType:marketType||canonical?.[2]||null,profileId:publicProfileId(plan?.profileId)||publicProfileId(order?.profileId)||publicProfileId(raw.profileId),chainId:publicChainId(plan?.chainId)||publicChainId(order?.chainId)||publicChainId(raw.chainId)},
   clockKind,observedAt:at,validUntil,validity:raw.status==='expired'||validUntil!==null&&now!==null&&now>=validUntil?'expired':validUntil===null||now===null?'unknown':'active',
   direction:raw.side==='buy'?'buy':raw.side==='sell'?'sell':'wait',stage:fills.length?'confirmed-fill':orders.length?'submitted':'analysis',
   strategy,strategyVersion,variant,strategyIssues,price:finite(raw.price),priceMarket:market,condition:null,invalidation:null};
  rows.set([sourceId,record.version,runId,id].join(':'),record);
 }
 return [...rows.values()];
}
export function signalCandleIdentity(row){
 const c=row.track,r=row.record;
 if(r)return r.instrument.venue==='binance'&&r.instrument.marketType==='SPOT'&&r.instrument.market===c.id+'/USDT'?{market:r.instrument.market,venueId:'binance',profileId:'cex-spot',period:'15m'}:null;
 return c.asset.domain==='Crypto'?{market:c.id+'/USDT',venueId:'binance',profileId:'cex-spot',period:'15m'}:null;
}
export function trackingReview(row){
 if(row?.record||!row?.track?.events)return null;
 const end=row.track.events.findIndex(event=>event.id===row.id);if(end<0)return null;
 const events=row.track.events.slice(0,end+1),last=events.at(-1),first=events[0],previous=events.at(-2);
 if(row.price!==last.price||events.some(event=>!Number.isFinite(event.price)||event.price<=0))return null;
 const at=event=>`${event.date}T${event.time}:00+08:00`,guide=TRACKING_GUIDANCE[row.track.source];
 return {source:'historical-scenario',precision:'minute',from:at(first),asOf:at(last),observations:events.length,initialPrice:first.price,
  changePercent:(last.price/first.price-1)*100,latestChangePercent:previous?(last.price/previous.price-1)*100:null,
  drawdownFromPeakPercent:(last.price/Math.max(...events.map(event=>event.price))-1)*100,
  path:events.map(event=>({at:at(event),price:event.price,stage:event.stage})),checks:guide?.checks.map(item=>item[1])||[],risk:guide?.risk[1]||null};
}
export function trackingRecord(row){
 if(row.record)return row.record;
 const c=row.track;
 return {signalId:row.id,sourceId:'TRACK-'+c.id,version:String(row.index+1),sourceType:'historical',
  instrument:{symbol:c.id,market:null,venue:null,marketType:null},clockKind:'historical',observedAt:`${row.date}T${row.time}:00+08:00`,precision:'minute',
  validUntil:null,validity:'historical',direction:'wait',stage:'analysis',strategy:null,price:row.price,plan:null,condition:null,invalidation:null,
  review:trackingReview(row)};
}
export function signalQuote(row){
 const market=row.record?.priceMarket;
 if(typeof market==='string'&&/^[A-Z0-9]{1,20}\/[A-Z0-9]{1,12}$/.test(market)){
  const quoteAsset=market.split('/')[1];return {market,quoteAsset,measurementUnit:null,priceUnit:quoteAsset,settlementAsset:null};
 }
 const sourceUnit=row.track?.asset?.unit,unit=!row.record&&typeof sourceUnit==='string'&&sourceUnit.trim()?sourceUnit:null,parts=unit?/^([A-Z0-9]{2,12})\/(.+)$/.exec(unit):null;
 return {market:null,quoteAsset:parts?.[1]||(/^[A-Z0-9]{2,12}$/.test(unit)?unit:null),measurementUnit:parts?.[2]||(['点','%'].includes(unit)?unit:null),priceUnit:unit,settlementAsset:null};
}
export function signalExcerpt(row){return JSON.stringify({...trackingRecord(row),quote:signalQuote(row),...(row.track?{referencePlan:signalReferenceFor(row)}:{})},null,2);}

export function signalReferenceKey(row){
 const r=trackingRecord(row);return JSON.stringify([r.sourceId,r.version,r.runId,r.signalId,r.instrument,r.clockKind,r.observedAt,r.direction,r.price,r.priceMarket,r.strategy,r.strategyVersion,r.variant,r.strategyIssues]);
}
export const signalReferenceFor=row=>row.referencePlan?.recordKey===signalReferenceKey(row)?row.referencePlan:signalReferencePlan(row);
export function signalReferencePlan(row,{bars,receivedAt=null,calculatedAt=null}={}){
 const r=trackingRecord(row),id=r.strategy||(!row.record?signalStrategy(row.track):null),library=['S00','RX03-S','S03'].includes(id)?strategyPlan(id,r.variant||'baseline'):null;
 const p=library?Object.fromEntries(Object.entries(library.record.parameters).map(([key,item])=>[key,item.value])):{},reasons=[];
 const result={recordKey:signalReferenceKey(row),status:'pending',strategy:id,version:r.strategyVersion||null,variant:r.variant||null,libraryVersion:library?.record.version||null,asOf:r.clockKind==='historical'?Date.parse(r.observedAt):r.clockKind==='wall'?r.observedAt:null,receivedAt,calculatedAt,availableAt:null,provenance:null,levels:null,evidence:null,reasons,
  rules:library?{entry:library.entry,exit:library.exit,timeframe:id==='S00'?'4h / 1h / 15m':id==='RX03-S'?'30m / 15m':'5m',
   stop:id==='S00'?`floor_tick(min(L15m[-${p.structural_low_lookback}:]) − ${p.stop_buffer_atr} × ATR${p.atr_period}_1h)`:`C − ${p.stop_atr} × ATR${p.atr_period||14}_${id==='S03'?'5m':'15m'}`,
   target:id==='S03'?null:`C + ${p.target_r} × (C − stop)`}:null};
 const missing=(zh,en)=>reasons.push([zh,en]);
 if(!id)missing('原记录未关联策略规则','No strategy rule is linked to this record');
 else if(!library)missing('当前参考核算尚未覆盖该策略','Reference calculation does not cover this strategy');
 if(!row.record)missing('原记录未登记策略版本与适用市场；当前库规则仅供对照','The original strategy version and market were not recorded; current library rules are for comparison');
 else{
  if(r.strategyIssues?.length)missing('策略来源字段存在冲突或无效值','Strategy metadata is conflicting or invalid');
  if(!signalQuote(row).market)missing('原信号未记录价格的报价交易对','The original price quote pair is not recorded');
  else if(r.priceMarket!==r.instrument?.market)missing('原价格的报价交易对与交易标的不一致，需先核实','The original price quote pair differs from the trading instrument and needs verification');
  if(!r.strategyVersion||!r.variant)missing('原记录缺少明确的策略版本或变体','The original strategy version or variant is missing');
  else if(library&&(library.variant!==r.variant||library.record.version!==r.strategyVersion))missing('原策略版本或变体与当前库不匹配','The recorded strategy version or variant does not match the library');
  if(id==='S03'&&r.variant&&r.variant!=='baseline')missing('当前参考核算仅覆盖 S03 原版规则','Reference calculation currently covers the S03 baseline only');
  if(library&&(r.instrument?.venue!=='binance'||r.instrument.marketType!=='SPOT'||r.instrument.market!==library.symbol+'/USDT'||r.instrument.profileId&&r.instrument.profileId!=='cex-spot'))missing('交易所、现货市场或标的不符合该策略','The exchange, spot market or symbol does not match this strategy');
  if(r.direction!=='buy')missing('该规则仅适用现货做多入场，当前信号方向不匹配','This rule covers spot long entry; the signal direction does not match');
  if(r.clockKind!=='wall'||!Number.isFinite(result.asOf)||result.asOf<0)missing('信号时钟无法对应原始 UTC 行情时点','The signal clock cannot be matched to an original UTC market time');
 }
 if(id==='S00')missing('待补当时评分日志、评分版本及已冻结的突破区间；另需连续已收盘 15m / 1h / 4h K 线与价格步长','Point-in-time scores, scoring version and frozen breakout range are missing; continuous closed 15m / 1h / 4h bars and tick size are also required');
 if(id==='RX03-S')missing('待登记池地址、最终链上成交窗、14 日覆盖与 USDC/USDT 换算证据','The registered pool, finalized trade window, 14-day coverage and USDC/USDT conversion evidence are missing');
 // shortcut: external score/pool evidence has no public point-in-time schema yet; add numeric plans only when that contract exists.
 if(reasons.length)return result;
 result.status='needs-bars';
 if(!bars)return result;
 if(!Number.isFinite(receivedAt)||receivedAt<result.asOf||!Number.isFinite(calculatedAt)||calculatedAt<receivedAt){missing('行情取数时间缺失或早于信号时点','Market receipt time is missing or precedes the signal');result.status='pending';return result;}
 // Pin the warmup window too, so later retrievals cannot change the EMA/RSI seed at the same signal time.
 const window=Array.isArray(bars)?bars.filter(bar=>bar?.time*1000+300000<=result.asOf).slice(-250):bars;
 const study=computeMarketStudy(window,{period:'5m',kind:'momentum',plan:{id,variant:r.variant,parameters:p,minimumBars:250}},result.asOf/1000);
 if(study.state!=='ready'){
  result.status='pending';missing(study.state==='warmup'?'原信号时点不足 250 根连续已收盘 5m K 线':study.state==='stale'?'行情窗口未覆盖原信号的最新收盘 K 线':'原信号行情存在缺口或无效 OHLCV',study.state==='warmup'?'Fewer than 250 continuous closed 5m bars at the original signal time':study.state==='stale'?'The market window does not cover the original signal close':'The original market data has gaps or invalid OHLCV');return result;
 }
 const last=study.bars.at(-1),rsi=study.oscillators[0].points,metrics=study.metrics;
 const checks=[...study.checks.filter(check=>['trend','above-ema','volatility'].includes(check.key)),{key:'rsi-cross',zh:`RSI${p.rsi_period} 上穿 ${p.rsi_cross} 且 ≤ ${p.rsi_ceiling}`,en:`RSI${p.rsi_period} crosses ${p.rsi_cross} and ≤ ${p.rsi_ceiling}`,value:rsi.at(-2).value<=Number(p.rsi_cross)&&metrics.rsi>Number(p.rsi_cross)&&metrics.rsi<=Number(p.rsi_ceiling)}];
 result.provenance='retrospective';result.evidence={source:'Binance Spot klines',period:'5m',bars:study.bars.length,closedAt:study.closedAt*1000,methodVersion:study.methodVersion,metrics,checks};
 if(checks.some(check=>check.value!==true)){result.status='not-triggered';missing('原信号时点的入场条件未全部满足','Not all entry conditions pass at the original signal time');return result;}
 const stop=last.close-Number(p.stop_atr)*metrics.atr;
 if(!(stop>0&&stop<last.close)){result.status='pending';missing('止损距离无效，暂不提供数值参考','The stop distance is invalid; numeric reference is unavailable');return result;}
 result.status='ready';result.levels={entry:last.close,stopLoss:stop,takeProfit:null,unit:'USDT'};return result;
}
export async function loadSignalReferencePlan(row,{fetchImpl=globalThis.fetch,signal,now=Date.now}={}){
 const initial=signalReferencePlan(row);if(initial.status!=='needs-bars')return initial;
 const request=candleRequest({market:row.record.instrument.market,period:'5m'}),query=new URLSearchParams({resource:'candles',symbol:request.symbol,interval:request.interval});
 let received=false;
 try{
  const response=await fetchImpl('/api/market-hub?'+query,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000),credentials:'omit',cache:'no-store'});
  if(!response.ok)throw Error('MARKET_UNAVAILABLE');
  received=true;
  const body=await response.json(),bars=normalizeKlines(body.body,request),calculatedAt=now();
  if(!Number.isFinite(body.receivedAt)||body.receivedAt>calculatedAt||calculatedAt-body.receivedAt>30_000)throw Error('STALE_MARKET');
  return signalReferencePlan(row,{bars,receivedAt:body.receivedAt,calculatedAt});
 }catch{
  if(received)return {...initial,status:'pending',reasons:[['行情快照无效或取数时间已过期，暂无法核算原信号时点','The market snapshot is invalid or its receipt time is stale; the original signal time cannot be calculated']]};
  return {...initial,status:'error',reasons:[['原时点行情请求失败，请重试核算','The original-time market request failed. Retry the calculation']]};
 }
}
