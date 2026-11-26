import {L} from './execution-views.mjs';
import {pendingStrategyApproval} from './trading-demo.mjs';
import {t} from './locale.mjs';
import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {preferredTradingConnection,walletTradingProfile,connectedSpotBalance,connectedAccountBalances,tradingConnections} from './connection-options.mjs?v=20261125c';
import * as Protection from './strategy-protection.mjs';
import {CATALOG,strategyById} from './strategy-catalog.mjs';
import {strategyRecommendations} from './strategy-advisor.mjs';
import {strategyPlan} from './strategy-execution-data.mjs';
import {isBotSimulation} from './bot-runtime.mjs';
import {strategyName,strategyDescription} from './strategy-journeys.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {uiGlyph,captureProductFocus} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {ASSETS,INTELLIGENCE,observationPrice} from './product-data.mjs';
import {workbenchFilter,watchedSymbols,marketScanSymbols,workbenchAIHealth,activeWorkbenchOrders} from './workbench-targets.mjs';
import {TRACKING_CASES,trackingRows,TRACKING_SOURCES} from './signal-tracking.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {createMarketHubClient,validateResearchBackground} from './market-hub-data.mjs';
import {createPublicDataClient,validatePublicEnvelope,safePublicURL,PUBLIC_ASSETS} from './public-data-client.mjs';
import {statementRecords} from './statements-data.mjs';
import {executionRunIdentity} from './execution-stream.mjs';
import {workbenchExamplesAvailable,workbenchExampleNotices,workbenchExampleRunList,workbenchExampleDetail} from './workbench-console-examples.mjs';

const number=(value,digits=2)=>Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const kinds={trade:['交易','Trading'],risk:['资金保护','Protection'],analysis:['AI 分析','AI analysis'],market:['行情','Markets'],news:['消息','News'],social:['社媒','Social'],signal:['AI 信号','AI signal'],anomaly:['数据异动','Data alert']};
const unitFor=symbol=>{const unit=ASSETS.find(asset=>asset[0]===symbol)?.[3];return unit==='点'?L('点','pts'):unit==='USD/盎司'?'USD/oz':unit||'';};

export function workbenchOperationState(trade){
 if(!trade)return {phase:'unavailable',run:null,status:'unavailable'};
 const run=trade.session?.singleShot?null:trade.session;
 const phase=trade.session?.singleShot&&(trade.state!=='stopped'||trade.pending||trade.position)?'manual'
  :trade.pending?.status==='unknown'?'unknown':trade.pending?'pending'
  :pendingStrategyApproval(trade)?'approval'
  :run&&trade.state==='running'&&trade.signal&&run.mode!=='auto'&&run.mode!=='signal'&&run.mode!=='review'?'confirm'
  :run&&trade.state!=='stopped'?trade.state
  :trade.position?'position':trade.discovery?.armed?'watching':run?'stopped':'idle';
 return {phase,run,status:trade.pending?.status==='unknown'?'unknown':trade.pending?'pending':phase==='running'&&run?.awaitingResearch?'waiting':phase};
}

export function workbenchOperationLabel(phase){
 return L(...({idle:['待启动','Ready to start'],watching:['等待机会','Watching for an entry'],waiting:['等待交易条件','Waiting for entry conditions'],running:['策略运行中','Strategy running'],approval:['等待你批准入场','Entry awaits your approval'],paused:['策略已暂停','Strategy paused'],blocked:['策略需要处理','Strategy needs attention'],confirm:['待确认交易','A trade needs confirmation'],pending:['订单处理中','Order processing'],unknown:['订单结果待确认','Order outcome unconfirmed'],stopped:['策略已停止','Strategy stopped'],position:['策略已停，持仓保留','Stopped; position retained'],manual:['已有交易正在管理','Managing an existing trade'],unavailable:['当前账户未接入','Account not connected']}[phase]||['状态待确认','Status unconfirmed']));
}

export function workbenchInformation(research,trade,{tasks=research.tasks,signals=[],marketData=[],newsSnapshot=null,socialSnapshot=null,now=Date.now()}={}){
 const live=research.mode==='live_readonly';
 const symbols=new Set(tasks.map(task=>task.symbol));
 const accepts=symbol=>{const task=research.task(symbol);return symbols.has(symbol)&&task&&research.accepts(task);};
 const receipts=statementRecords(trade);
 const analysis=research.events.filter(event=>accepts(event.symbol)).slice(0,24).map(event=>({id:'research:'+event.id,kind:'analysis',symbol:event.symbol,text:event.text,at:event.at,age:Math.max(0,research.time-event.at),route:'research'}));
 const orders=(trade?.events||[]).slice(0,16).map(event=>{
  const orderId=event.orderId||event.text.match(/\bSIM-ORD-\d+\b/)?.[0],order=trade.orders?.find(item=>item.id===orderId),explicit=event.text.match(/\b(BTC|ETH|SOL)\/(?:USDT|USDC)\b/);
  const receipt=receipts.orders.find(item=>item.key==='spectrum:'+orderId&&item.owner==='AI_SPECTRUM');
  return {id:'trade:'+event.id,kind:event.kind==='risk'?'risk':'trade',symbol:order?.market?.split('/')[0]||explicit?.[1],orderId:receipt?.id,runId:receipt?.runId,text:event.text,at:event.at,age:Number.isFinite(trade.time)?Math.max(0,trade.time-event.at):null,route:'execution'};
 });
 // Closed-bar facts keep their source clock; a missing live quote never becomes a sample price.
 const markets=tasks.filter(task=>accepts(task.symbol)).map((task,index)=>{const sample=Math.max(0,Math.floor((research.time-index*.8)/3)*3),real=marketData.find(row=>row.symbol===task.symbol&&Number.isFinite(row.price)&&row.price>0&&Number.isFinite(row.asOf)&&now>=row.asOf&&now-row.asOf<=30000);
  if(real)return {id:`market:${task.symbol}:${real.asOf}`,kind:'market',symbol:task.symbol,price:real.price,change:real.change,at:real.asOf,wallTime:true,age:(now-real.asOf)/1000,unit:real.quote||'USD',source:real.provider||'CoinGecko',route:'markets'};
  const observation=live?research.task(task.symbol)?.observation:null;
  if(observation?.state==='ready'&&Number.isFinite(observation.price)&&observation.price>0&&now>=observation.closedAt*1000&&now<observation.validUntil*1000)return {id:`market:${task.symbol}:close:${observation.closedAt}`,kind:'market',symbol:task.symbol,price:observation.price,change:observation.change,at:observation.closedAt*1000,wallTime:true,priceBasis:'daily-close',age:(now-observation.closedAt*1000)/1000,unit:observation.unit,source:observation.source,route:'markets'};
  return live?null:{id:`market:${task.symbol}:${sample}`,kind:'market',symbol:task.symbol,price:observationPrice(task.symbol,sample*2),previous:observationPrice(task.symbol,Math.max(0,sample-3)*2),at:sample,age:research.time-sample,source:L('合成行情 · 较 3 秒前','Synthetic price · vs 3s ago'),route:'markets'};
 }).filter(Boolean);
 let news=[],social=[];
 if(live){
  if(newsSnapshot?.mode==='live_readonly')try{
   validatePublicEnvelope(newsSnapshot,'news',{selection_version:newsSnapshot.selection_version,limit:50});
   news=newsSnapshot.items.filter(item=>item.quality==='fresh'&&Number.isFinite(item.valid_until_ms)&&now<item.valid_until_ms&&item.data.published_at_ms<=now+60000&&safePublicURL(item.data.url)).map(item=>{
    const d=item.data,symbols=d.symbols??d.asset_ids.map(id=>PUBLIC_ASSETS[id]);
    return {id:'news:'+item.record_id,kind:'news',symbols,symbol:symbols.length===1?symbols[0]:null,text:d.title,detail:L('媒体报道 · 查看原文','Publisher report · Open the source'),at:d.published_at_ms,wallTime:true,age:Math.max(0,(now-d.published_at_ms)/1000),source:({'coindesk-rss-v1':'CoinDesk','blockbeats-news-v1':L('律动 BlockBeats','BlockBeats')})[item.provider_id]||item.provider_id,url:safePublicURL(d.url),route:'intelligence'};
   }).filter(row=>!row.symbols.length||row.symbols.some(accepts));
  }catch{}
  if(socialSnapshot?.mode==='live_readonly')try{
   validatePublicEnvelope(socialSnapshot,'social',{selection_version:socialSnapshot.selection_version,limit:50});
   social=socialSnapshot.items.filter(item=>item.quality==='fresh'&&now<item.valid_until_ms&&item.data.observed_at_ms<=now+1000).map(item=>{
    const d=item.data,symbols=d.symbols;
    if(item.provider_id==='lunarcrush-v4'){
     const author=d.author.display_name||d.author.acct,excerpt=Array.from(d.text);
     const kol=d.kol;if(socialSnapshot.coverage.scope!=='LUNARCRUSH_KOL_TOPICS'||!kol)return null;
     const rank=kol.evidenceSymbol+' #'+kol.topicRank,followers=number(kol.followers,0);
     return {id:'social:'+item.record_id,kind:'social',symbols,symbol:symbols.length===1?symbols[0]:null,text:(author?author+' · ':'')+excerpt.slice(0,140).join('')+(excerpt.length>140?'…':''),detail:d.text+'\n'+L('本帖 24h 互动 ','Post interactions, 24h: ')+number(d.interactions_24h,0)+' · '+L('采样时间','Observed')+': '+new Date(d.observed_at_ms).toISOString(),hint:L(followers+' 粉丝 · 主题排名 '+rank,followers+' followers · topic rank '+rank),at:d.published_at_ms,wallTime:true,age:Math.max(0,(now-d.published_at_ms)/1000),source:'LunarCrush · '+d.platform,url:d.url,valueKey:JSON.stringify([d.text,author,d.interactions_24h,followers,rank]),route:'intelligence'};
    }
    return {id:'social:'+item.record_id,kind:'social',symbols,symbol:symbols.length===1?symbols[0]:null,text:`@${d.author.acct} · ${d.text.slice(0,140)}${d.text.length>140?'…':''}`,detail:`${d.text}\n${L('互动采样','Engagement observed')}: ${new Date(d.observed_at_ms).toISOString()}${d.author.bot===true?' · '+L('自动账号','Automated account'):''}`,hint:L(`${number(d.likes,0)} 赞 · ${number(d.reposts,0)} 转发 · ${number(d.replies,0)} 回复`,`${number(d.likes,0)} likes · ${number(d.reposts,0)} reposts · ${number(d.replies,0)} replies`),at:d.published_at_ms,wallTime:true,age:Math.max(0,(now-d.published_at_ms)/1000),source:'Mastodon',url:safePublicURL(d.url),valueKey:JSON.stringify([d.text,d.likes,d.reposts,d.replies,d.edited_at_ms]),route:'intelligence'};
   }).filter(row=>row&&(!row.symbols.length||row.symbols.some(accepts)));
   const coverage=socialSnapshot.coverage,at=coverage.observed_at_ms;
   if(coverage.scope==='LUNARCRUSH_KOL_TOPICS'&&['fresh','partial'].includes(socialSnapshot.quality)&&at<=now+1000&&now<at+3600000){
    for(const topic of coverage.topics.filter(row=>accepts(row.symbol))){
     const stamp=topic.asOf??at,networks=Object.entries(topic.sentimentByNetwork).map(([network,score])=>network+' '+score+'/100').join(' · ');
     const measures=[[topic.posts24h,'条帖子','posts'],[topic.contributors24h,'位作者','contributors'],[topic.interactions24h,'次互动','interactions']].filter(([value])=>value!==null).map(([value,zh,en])=>number(value,0)+' '+L(zh,en)).join(' · ');
     social.push({id:'social:topic:'+topic.symbol,kind:'social',symbols:[topic.symbol],symbol:topic.symbol,text:topic.symbol+' · '+L('主题整体讨论 · 24h','Topic-wide discussion · 24h'),hint:measures,detail:[networks?L('平台情绪：','Platform sentiment: ')+networks:'',(topic.asOf===null?L('采样时间','Observed'):L('来源更新','Source updated'))+': '+new Date(stamp).toISOString()].filter(Boolean).join('\n'),at:stamp,wallTime:true,age:Math.max(0,(now-stamp)/1000),source:'LunarCrush',valueKey:JSON.stringify([measures,networks]),url:'https://lunarcrush.com',route:'intelligence'});
    }
   }
  }catch{}
  const background=research.background?.sentiment;
  if(accepts('BTC')&&background?.state==='ready')try{
   const snapshot=validateResearchBackground(background.snapshot,'sentiment',now);
   news.push({id:'sentiment:BTC:'+snapshot.asOf,kind:'news',symbol:'BTC',text:L(`BTC 情绪指数 ${snapshot.data.value}/100`,`BTC sentiment index ${snapshot.data.value}/100`),detail:L('BTC 日度指数','BTC daily index'),at:snapshot.asOf,wallTime:true,age:Math.max(0,(now-snapshot.asOf)/1000),source:snapshot.provider,url:'https://coinmarketcap.com/charts/fear-and-greed-index/',route:'intelligence'});
  }catch{}
 }else news=INTELLIGENCE.filter(item=>accepts(item.symbol)).map(item=>({id:'brief:'+item.id,kind:item.source==='chain'?'anomaly':'news',symbol:item.symbol,text:item.title,detail:item.detail,hint:item.reason,at:item.time,fixed:true,source:L(item.type,'Source scenario'),route:item.source==='social'?'social':item.source==='chain'?'tracking':'intelligence'}));
 const tracks=live?[]:trackingRows(TRACKING_CASES,{latestOnly:true}).filter(row=>accepts(row.symbol)).map(row=>({id:'tracking:'+row.id,kind:'signal',symbol:row.symbol,text:L(...row.title),detail:L(...row.track.thesis),hint:L(...row.reason),at:row.date+' '+row.time,fixed:true,source:L(...TRACKING_SOURCES[row.source]),route:'signals'}));
 const alerts=marketData.filter(row=>accepts(row.symbol)&&Number.isFinite(row.asOf)&&now>=row.asOf&&now-row.asOf<=7200000&&Number.isFinite(row.change)&&Math.abs(row.change)>=3).map(row=>({id:`anomaly:${row.symbol}:${row.asOf}`,kind:'anomaly',symbol:row.symbol,at:row.asOf,wallTime:true,age:(now-row.asOf)/1000,source:row.provider||'CoinGecko',route:'markets',text:L(`24 小时${row.change>0?'上涨':'下跌'} ${number(Math.abs(row.change))}%`,`24h ${row.change>0?'gain':'decline'} of ${number(Math.abs(row.change))}%`),hint:L('数据中心 · 价格变化超过 3%','Data center · Price change exceeds 3%'),detail:L('这是价格变化提醒，仍需结合成交与风险判断。','A price-change alert; volume and risk still need review.')}));
 const strategySignals=signals.filter(signal=>accepts(signal.market?.split('/')[0])&&trade?.session?.id===signal.runId).map(signal=>({id:'signal:'+signal.id,kind:'signal',symbol:signal.market.split('/')[0],runId:receipts.runs.find(run=>run.id===signal.runId&&run.owner==='AI_SPECTRUM')?.id,text:L(signal.intent==='close'?'策略出现退出条件':'策略出现入场条件',signal.intent==='close'?'Strategy exit condition detected':'Strategy entry condition detected'),hint:strategyById(signal.strategy||trade.session.strategy)?strategyName(strategyById(signal.strategy||trade.session.strategy)):L('运行中的策略','Active strategy'),detail:L('执行结果以交易回执为准。','Check the trade receipt for the execution outcome.'),at:signal.at,age:Number.isFinite(signal.at)?Math.max(0,trade.time-signal.at):null,clock:'trade',route:'execution'}));
 return [...orders.filter(row=>!row.symbol||accepts(row.symbol)),...strategySignals,...analysis,...alerts,...markets,...tracks,...news,...social];
}

export function mergeWorkbenchInformation(previous,current,additions){
 const quotes=new Set(current.filter(row=>row.kind==='market').map(row=>row.id));
 const stream=[...additions,...previous].filter(row=>!row.fixed&&(row.kind!=='market'||quotes.has(row.id)));
 return [...stream.slice(0,48),...current.filter(row=>row.fixed)];
}

export function selectWorkbenchInformation(stream,current,filter='all',asset='all'){
 return (filter==='all'?stream:current).filter(row=>(filter==='all'||row.kind===filter||filter==='trade'&&row.kind==='risk')&&(asset==='all'||row.symbol===asset||row.symbols?.includes(asset)||row.kind==='risk'&&!row.symbol));
}

export function workbenchConsoleRuns(trade,accountId='SIM-01'){
 if(!trade)return [];
 const runs=[],reservations=trade.botBook?.flow?.reservations||[];
 for(const run of trade.botBook?.runs||[]){
  if(run.plan?.executionRoute?.accountId!==accountId)continue;
  const ended=['stopped','failed'].includes(run.status),orders=(run.orders||[]).filter(order=>order.runId===run.id&&order.accountId===accountId);
  const held=ended&&reservations.some(row=>row.accountId===accountId&&(row.instanceId===run.id||orders.some(order=>order.id===row.orderId))&&row.state==='HELD'&&Number.isFinite(Number(row.amount))&&Number(row.amount)>0);
  const attention=orders.some(order=>order.status==='unknown')?'unknown':held&&!(run.quantity>0)?'reserved':null;
  if(ended&&!(run.quantity>0)&&!held)continue;
  const riskIssue=['running','waiting'].includes(run.status)&&!(run.quantity>0)&&run.protectionDecision?.scope==='BOT_ALLOCATION'&&run.protectionDecision.action==='pause'&&run.protectionDecision.reason==='budget'&&orders.every(order=>['filled','cancelled','rejected','expired'].includes(order.status))?'budget':null;
  runs.push({id:run.id,market:run.plan.market,strategy:run.plan.strategy,source:'BOT',state:run.status,retained:run.quantity>0&&ended,attention,riskIssue,pnl:Number.isFinite(run.realizedPnl)&&Number.isFinite(run.unrealizedPnl)?run.realizedPnl+run.unrealizedPnl:null});
 }
 const run=trade.session;
 if(run?.id&&!run.singleShot&&(!run.ticket?.accountId||run.ticket.accountId===accountId)&&(trade.state!=='stopped'||trade.position||trade.pending)&&!runs.some(row=>row.id===run.id))runs.push({id:run.id,market:run.market,strategy:run.strategy,source:run.mandateId?'AI':'BOT',state:workbenchOperationState(trade).status,pnl:null});
 return runs;
}

export function workbenchConsoleAccount(trade,sync){
 const summary=trade?.accountSummary;
 if(sync?.state!=='LIVE'||!summary||summary.accountId!==sync.scope?.accountId||summary.environment!==sync.scope?.environment)return null;
 return ['equity','available','reserved','positions','orders'].every(key=>Number.isFinite(summary[key])&&summary[key]>=0)?summary:null;
}

export function workbenchRiskUsage(account,limits){
 const risk=account?.risk;
 if(!risk||!['allocated','loss','fees'].every(key=>Number.isFinite(risk[key])&&risk[key]>=0)||!['cap','dailyLoss'].every(key=>Number.isFinite(limits?.[key])&&limits[key]>0))return null;
 // Loss and fees are independent pause gates; adding them would count fees twice.
 const lossUsed=Math.max(risk.loss,risk.fees);
 return {...risk,lossUsed,allocationRemaining:Math.max(0,limits.cap-risk.allocated),lossRemaining:Math.max(0,limits.dailyLoss-lossUsed),paused:risk.locked===true||lossUsed>=limits.dailyLoss};
}

export function workbenchSignalState(row){
 if(!row||row.freshness==='expired')return 'unavailable';
 if(row.status==='research')return 'research';
 if(row.status!=='ready'||row.canAdopt!==true)return 'unavailable';
 const paper=isBotSimulation({strategy:row.strategy,planVariant:row.variant});
 return row.executable===true&&row.freshness==='current'&&row.clockKind==='wall'&&!paper?'ready':'research';
}

export function workbenchSignalShortlist(rows){
 const rank={ready:0,research:1,unavailable:2},seen=new Set();
 const sorted=[...rows].sort((a,b)=>rank[workbenchSignalState(a)]-rank[workbenchSignalState(b)]||Number(b.sourceType==='research')-Number(a.sourceType==='research')||(a.clockKind===b.clockKind&&a.sourceType===b.sourceType?(b.asOf??-Infinity)-(a.asOf??-Infinity):0));
 return sorted.filter(row=>{const key=row.asset||row.market;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,3);
}

const signalStates={ready:['可批准','Ready for approval'],unavailable:['待补充','Evidence needed'],research:['研究分析','Research only']};

function signalEvidenceRequirements(plan,asset){
 const p=plan.record.parameters;
 if(plan.id==='RX03-S'){
  const fee=p.pool_fee_tier.value/10000+'%',coverage=Number(p.coverage_min.value)*100+'%',imbalance=Number(p.flow_imbalance_min.value)*100+'%';
  return [
   L(`Ethereum · Uniswap V3 WETH/USDC ${fee} 池的 Swap 记录，登记池地址并核对 USDC/USDT 换算。`,`Ethereum · swaps from the registered Uniswap V3 WETH/USDC ${fee} pool, with a verified USDC/USDT conversion.`),
   L(`${p.chain_window.value} 分钟最终确认成交窗内，净买入占成交额 ≥ ${imbalance}，成交额 ≥ ${p.baseline.value} 日中位数的 ${p.volume_multiple_chain.value} 倍，基线覆盖 ≥ ${coverage}。再核对 ${p.price_tf.value} 现货放量突破。`,`Finalized ${p.chain_window.value}-minute swaps must show net buying ≥ ${imbalance} of turnover and volume ≥ ${p.volume_multiple_chain.value}× the ${p.baseline.value}-day median, with ≥ ${coverage} baseline coverage. Then confirm the ${p.price_tf.value} spot breakout on volume.`)
  ];
 }
 if(plan.id==='RX02-A')return [
  L(`${asset} 同一统计口径的逐小时社媒提及数与互动数，${p.baseline.value} 日基线覆盖 ≥ ${Number(p.coverage_min.value)*100}%。`,`Hourly mentions and interactions for ${asset} from one consistent source, with ≥ ${Number(p.coverage_min.value)*100}% coverage over ${p.baseline.value} days.`),
  L(`提及数 ≥ ${p.mentions_min.value} 且 ≥ 历史中位数的 ${p.mentions_multiple.value} 倍，互动数 ≥ 中位数的 ${p.interactions_multiple.value} 倍，再核对 ${p.price_tf.value} 价格与成交量突破。`,`Mentions must reach ${p.mentions_min.value} and ≥ ${p.mentions_multiple.value}× their median, and interactions ≥ ${p.interactions_multiple.value}× their median. Then confirm the ${p.price_tf.value} price and volume breakout.`)
 ];
 if(plan.id==='S03')return [L('Binance Spot · BTC/USDT 连续 250 根已收盘的 5 分钟 K 线。','Binance Spot · 250 consecutive closed five-minute BTC/USDT candles.'),L(...plan.entry)];
 return [L(...plan.need),L(...plan.entry)];
}

function workbenchSignalCard(row,research){
 const state=workbenchSignalState(row),plan=strategyPlan(row.strategy,row.variant),ref=row.sourceRef;
 const current=ref?.type==='research'?research.task(ref.asset):null;
 const task=current&&current.id===ref.taskId&&research.revision(current)===ref.revision?current:null;
 const live=task?.mode==='live_readonly',paperRun=row.clockKind==='simulation'||plan.candidate?.kind==='simulation';
 const sourceLabel=row.sourceType==='research'
  ?research.mode==='live_readonly'?L('公开只读研究','Public read-only research'):L('模拟生成的研究记录','Simulated research record')
  :paperRun?L('模拟生成的运行信号','Simulated run signal'):L('运行信号记录','Run signal record');
 const [required,conditions]=signalEvidenceRequirements(plan,row.asset);
 const copy=value=>Array.isArray(value)?L(...value):t(value||'');
 const key={'RX03-S':'chain','RX02-A':'social'}[plan.id],evidence=task?.evidence?.find(item=>item.key===key),trend=task?.evidence?.find(item=>item.key==='trend');
 let summary=copy(state==='unavailable'||state==='research'&&!row.canAdopt&&row.unavailableReason?row.unavailableReason:row.reason);
 if(state==='unavailable'&&live&&task.phase==='complete'&&task.outcome==='missing'&&row.freshness!=='expired'&&!task.evidence.some(item=>item.status==='conflict')){
  if(plan.id==='S03'&&trend?.period==='1D')summary=L('尚缺信号时点的 5 分钟 K 线与 RSI 上穿核验。','The five-minute candles and RSI cross at the signal time have not been verified.');
  if(['missing','context'].includes(evidence?.status)){
   if(plan.id==='RX03-S')summary=L('缺少指定池内已最终确认的 Swap 成交记录。','Finalized swap records from the specified pool are missing.');
   if(plan.id==='RX02-A')summary=L('缺少逐小时的提及数、互动数及 14 日基线。','Hourly mentions, interactions and their 14-day baseline are missing.');
  }
 }
 const verdict=state==='ready'?L('策略条件已有可复核的执行依据。','The strategy conditions have execution evidence ready for review.'):state==='research'?L('仅有研究结论，尚无可批准的入场记录。','Research is available. No entry is ready for approval.'):copy(row.unavailableReason);
 const field=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
 const context=trend?.text?t(trend.text):'';
 const close=live&&Number.isFinite(trend?.closedAt)?' · '+new Date(trend.closedAt*1000).toISOString().slice(0,16).replace('T',' ')+' UTC':'';
 const originalSignal=ref?.type==='signal'&&ref.recordId&&row.clockKind==='wall'&&!paperRun;
 let observed=evidence?.sourceId&&t(evidence.text);
 if(observed&&evidence.timeBasis==='retrieval-time'&&Number.isSafeInteger(evidence.receivedAt)){
  const stamp=new Date(evidence.receivedAt).toISOString();
  observed=observed.replace(stamp,stamp.slice(0,19).replace('T',' ')+' UTC');
 }
 const details=[
  field(L('所需来源','Required source'),required),field(L('触发条件','Entry conditions'),conditions),field(L('条件匹配','Condition match'),verdict),
  originalSignal?`<div><dt>${L('来源记录','Source record')}</dt><dd><button type="button" class="ops-mini-link" data-ops-strategy="source" data-id="${esc(row.id)}">${L('查看原始运行信号','View original run signal')}</button></dd></div>`:'',
  observed?field(evidence.status==='context'?L('已接入的背景资料','Connected background source'):L('研究资料','Research evidence'),evidence.source&&!observed.includes(evidence.source)?evidence.source+' · '+observed:observed):'',
  context?field(live?L('日线行情背景','Daily market context'):L('模拟行情背景','Paper market context'),context+close):''
 ].join('');
 const foldKey=JSON.stringify([row.sourceType,row.sourceId,ref?.runId,row.market,row.strategy]);
 return `<article class="ops-signal-item" data-recommendation="${esc(row.id)}" data-signal-asset="${esc(row.asset)}" data-signal-state="${state}">
  <div class="ops-candidate-head">${tokenIcon(row.asset,{size:24})}<strong>${esc(row.asset||row.market)}</strong><span data-state="${state}">${L(...signalStates[state])}</span></div>
  <h4>${esc(strategyName(strategyById(row.strategy)))}</h4><p class="ops-signal-origin">${sourceLabel}</p><p>${esc(summary)}</p>
  <details class="ops-signal-evidence" data-ops-signal-evidence="${esc(foldKey)}"><summary class="ops-signal-action" data-signal-detail-for="${esc(row.asset)}">${state==='research'?L('查看分析','View analysis'):L('查看依据','View evidence')}${uiGlyph('chevron')}</summary><dl>${details}</dl></details>
  ${state==='ready'?`<button class="ops-signal-action" type="button" data-ops-strategy="recommendation" data-id="${esc(row.id)}">${L('配置交易方案','Configure trade plan')}${uiGlyph('arrow')}</button>`:''}
 </article>`;
}

export function workbenchSignalList(rows,research){
 const counts={ready:0,unavailable:0,research:0};
 for(const row of rows)counts[workbenchSignalState(row)]++;
 const summary=`<dl class="ops-signal-counts">${Object.entries(counts).filter(([state,count])=>state!=='research'||count).map(([state,count])=>`<div data-signal-count="${state}"><dt>${L(...signalStates[state])}</dt><dd>${count}</dd></div>`).join('')}</dl>`;
 return summary+(rows.length?`<div class="ops-signal-list">${rows.map(row=>workbenchSignalCard(row,research)).join('')}</div>`:`<p class="ops-empty">${L('暂无待评估信号','No signals to review')}</p>`);
}

export function saveWorkbenchLimits(workspace,values,{trade,sync,version}={}){
 if(!workbenchConsoleAccount(trade,sync)||sync.scope.accountId!=='SIM-01'||sync.scope.environment!=='DEMO')return L('当前账户不可配置，请先恢复账户数据。','Restore account data before changing these limits.');
 if(version!==workspace.s.risk.version)return L('资金边界已更新，请重新载入后再保存。','Limits changed. Reload the values before saving.');
 const previous={risk:workspace.s.risk,notices:[...workspace.s.notices],seq:workspace.s.seq},revision=workspace.revision;
 let error;
 try{error=workspace.setRisk(values)||workspace.persistenceError;}
 catch{error=L('限额未保存，请重试。','Could not save limits. Try again.');}
 if(!error)return null;
 Object.assign(workspace.s,previous);workspace.revision=revision;
 return t(error);
}

export function workbenchKellyEstimate(values={},riskLimit=Protection.PROTECTION_RULES.episode){
 const keys=['capital','winRate','netOdds','fraction'];
 if(keys.some(key=>values[key]===undefined||values[key]===null||String(values[key]).trim()===''))return {valid:false,reason:'missing'};
 const {capital,winRate,netOdds,fraction}=Object.fromEntries(keys.map(key=>[key,Number(values[key])]));
 if(![capital,winRate,netOdds,fraction,riskLimit].every(Number.isFinite)||capital<=0||capital>Number.MAX_SAFE_INTEGER/100||winRate<0||winRate>100||netOdds<=0||![.1,.25,.5,1].includes(fraction)||riskLimit<=0||riskLimit>Protection.PROTECTION_RULES.episode)return {valid:false,reason:'invalid'};
 const probability=winRate/100,fullKelly=probability-(1-probability)/netOdds;
 if(!Number.isFinite(fullKelly))return {valid:false,reason:'invalid'};
 const fractional=fullKelly*fraction,riskFraction=Math.max(0,Math.min(fractional,riskLimit)),riskAmount=Math.floor(capital*riskFraction*100)/100;
 return Number.isFinite(riskAmount)?{valid:true,fullKelly,fractional,riskFraction,riskAmount,capped:fractional>riskLimit,positive:fullKelly>0}:{valid:false,reason:'invalid'};
}

export function workbenchRiskPreference(workspace,scope){
 const saved=workspace.s.workbenchRisk;
 return saved&&scope?.accountId&&scope.environment&&Number.isSafeInteger(saved.revision)&&saved.revision>0&&saved.accountId===scope.accountId&&saved.environment===scope.environment?saved:null;
}

function savedProtection(preference){
 const policy=preference?.protection;
 return policy&&Protection.protectionValid(policy)?policy:null;
}

export function saveWorkbenchRiskPreference(workspace,values,{trade,sync,scope,revision,riskVersion}={}){
 if(!workbenchConsoleAccount(trade,sync)||sync.scope.accountId!=='SIM-01'||sync.scope.environment!=='DEMO')return L('当前账户不可配置，请先恢复账户数据。','Restore account data before changing these limits.');
 if(scope?.accountId!==sync.scope.accountId||scope?.environment!==sync.scope.environment)return L('账户已变化，请重新打开风控设置。','The account changed. Reopen risk settings.');
 const current=workbenchRiskPreference(workspace,sync.scope);
 if(revision!==(current?.revision||0)||riskVersion!==workspace.s.risk.version)return L('风控设置已变化，请重新打开后调整。','Risk settings changed. Reopen them before editing.');
 if(values.kind==='protection'){
  if(!Protection.PARAMETER_PROTECTION_VERSION)return L('当前只能查看规则，参数尚未接入新方案。','Rules are view-only until parameters are available for new plans.');
  const parameters=values.protection?.parameters;
  if(values.protection?.id==='astarter'&&Number.isFinite(parameters?.soft)&&Number.isFinite(parameters?.hard)&&parameters.soft>=parameters.hard)return L('降风险阈值必须小于暂停阈值。','The risk-reduction threshold must be below the pause threshold.');
  if(!values.protection||!Protection.protectionValid(values.protection))return L('请检查风控参数与暂停线。','Check the risk parameters and pause limits.');
 }else if(values.kind!=='kelly'||!workbenchKellyEstimate(values.kelly).valid)return L('请填写有效的资金、胜率和净盈亏比。','Enter valid capital, win probability and net odds.');
 if(!workspace.storage)return L('当前浏览器无法保存偏好，请检查存储设置。','Preferences could not be saved. Check browser storage.');
 const previous=workspace.s.workbenchRisk,workspaceRevision=workspace.revision;
 workspace.s.workbenchRisk={...current,accountId:sync.scope.accountId,environment:sync.scope.environment,revision:(current?.revision||0)+1,...(values.kind==='protection'?{protection:Protection.protectionConfig(values.protection.id,values.protection.mode,values.protection.parameters)}:{kelly:Object.fromEntries(['capital','winRate','netOdds','fraction'].map(key=>[key,Number(values.kelly[key])]))})};
 try{
  workspace.touch();
  if(workspace.persistenceError)throw new Error(workspace.persistenceError);
 }catch{
  if(previous===undefined)delete workspace.s.workbenchRisk;else workspace.s.workbenchRisk=previous;
  workspace.revision=workspaceRevision;
  return L('保存未完成，请重试。','Could not save. Try again.');
 }
 return null;
}

export function workbenchConsoleNotifications(trade,workspace,accountId='SIM-01'){
 if(!trade||trade.accountSummary?.accountId&&trade.accountSummary.accountId!==accountId)return [];
 const rows=[],runs=workbenchConsoleRuns(trade,accountId);
 for(const run of runs){
  const reason=run.attention==='unknown'?L('订单结果待确认','Order outcome unconfirmed'):run.attention==='reserved'?L('资金预留待核对','Reserved funds need review'):run.state==='blocked'?L('交易受阻，需要处理','Trading needs attention'):run.state==='failed'?L('执行失败，检查已有资产','Execution failed; review retained assets'):null;
  if(reason)rows.push({id:'attention:'+run.id,revision:run.attention||run.state,runId:run.id,kind:'attention',symbol:run.market?.split('/')[0],text:reason,age:null});
 }
 for(const run of trade.botBook?.runs||[]){
  if(run.plan?.executionRoute?.accountId!==accountId)continue;
  const labels={created:['方案已批准','Plan approved'],triggered:['入场条件已触发','Entry condition triggered'],paused:['已暂停新买入','New entries paused'],resumed:['已恢复运行','Run resumed'],ended:['运行已结束','Run ended'],reconciled:['订单结果已核对','Order reconciled']};
  for(const [index,event]of (run.events||[]).entries())if(labels[event.kind])rows.push({id:`bot:${run.id}:${index}`,revision:[event.kind,event.at],runId:run.id,kind:'receipt',symbol:run.plan.market?.split('/')[0],text:L(...labels[event.kind]),age:Number.isFinite(event.at)&&Number.isFinite(trade.botBook.time)?Math.max(0,trade.botBook.time-event.at):null});
 }
 const own=new Set((trade.botBook?.runs||[]).filter(run=>run.plan?.executionRoute?.accountId===accountId).map(run=>run.id));
 const session=trade.session;if(session&&(!session.ticket?.accountId||session.ticket.accountId===accountId))own.add(session.id);
 if(session?.id&&own.has(session.id)&&!rows.some(row=>row.kind==='attention'&&row.runId===session.id)){
  const phase=workbenchOperationState(trade).status;
  if(['approval','unknown','blocked'].includes(phase))rows.push({id:'attention:'+session.id,revision:phase,runId:session.id,kind:'attention',symbol:session.market?.split('/')[0],text:workbenchOperationLabel(phase),age:null});
 }
 if(session?.id&&own.has(session.id)&&!rows.some(row=>row.kind==='attention'&&row.runId===session.id)){
  const protection=workbenchAttention(trade,{ready:true,control:true}).find(row=>row.id==='protection');
  if(protection)rows.push({id:'attention:'+session.id,revision:'protection',runId:session.id,kind:'attention',symbol:session.market?.split('/')[0],text:protection.title,age:null});
 }
 for(const event of trade.events||[]){
  if(typeof event.text!=='string'||!event.text.trim()||!['fill','risk','order'].includes(event.kind)||event.accountId&&event.accountId!==accountId||event.runId&&!own.has(event.runId))continue;
  const orderId=event.text.match(/\bSIM-ORD-\d+\b/)?.[0],order=(trade.orders||[]).find(row=>row.id===orderId&&(!row.accountId||row.accountId===accountId));
  rows.push({id:'receipt:'+event.id,revision:[event.kind,event.at],runId:event.runId||order?.runId||null,orderId:order?.id||null,kind:'receipt',symbol:order?.market?.split('/')[0],text:workbenchPlainEvent(t(event.text)),age:Number.isFinite(event.at)&&Number.isFinite(trade.time)?Math.max(0,trade.time-event.at):null});
 }
 if(accountId==='SIM-01')for(const notice of workspace?.s?.notices||[]){
  if(notice.kind!=='risk')continue;
  rows.push({id:'notice:'+notice.id,kind:'receipt',read:notice.read===true,route:'risk',text:workbenchPlainEvent(t(notice.text)),age:Number.isFinite(notice.at)&&Number.isFinite(workspace.s.clock)?Math.max(0,workspace.s.clock-notice.at):null});
 }
 return rows.sort((a,b)=>Number(b.kind==='attention')-Number(a.kind==='attention')||(a.age??Infinity)-(b.age??Infinity)).slice(0,20);
}

export function workbenchNotificationGroups(rows){
 const groups=new Map();
 for(const row of rows.filter(row=>row.kind!=='attention')){
  const key=row.runId?'run:'+row.runId:row.orderId?'order:'+row.orderId:row.route==='risk'?'risk':'account';
  if(!groups.has(key))groups.set(key,{...row,id:key,items:[]});
  groups.get(key).items.push(row);
 }
 return [...groups.values()];
}

const notificationReadScope=(workspace,scope)=>scope?.accountId&&scope?.environment?JSON.stringify([workspace.account?.scope||'local',scope.environment,scope.accountId]):null;
const notificationReadKey=row=>typeof row.id==='string'&&row.id?JSON.stringify([row.id,row.revision||'']):null;
export function workbenchUnreadNotifications(rows,workspace,scope){
 const key=notificationReadScope(workspace,scope);if(!key)return [];
 const saved=workspace.s.workbenchNotificationReads?.[key],read=new Set(Array.isArray(saved)?saved:[]);
 return rows.filter(row=>!row.read&&notificationReadKey(row)&&!read.has(notificationReadKey(row)));
}
export function markWorkbenchNotificationsRead(rows,workspace,scope){
 const unread=workbenchUnreadNotifications(rows,workspace,scope);if(!unread.length)return false;
 const key=notificationReadScope(workspace,scope),previous=workspace.s.workbenchNotificationReads,saved=previous?.[key];
 workspace.s.workbenchNotificationReads={...previous,[key]:[...new Set([...(Array.isArray(saved)?saved:[]),...unread.map(notificationReadKey)])]};
 try{workspace.touch();if(workspace.persistenceError)throw new Error(workspace.persistenceError);}
 catch{if(previous===undefined)delete workspace.s.workbenchNotificationReads;else workspace.s.workbenchNotificationReads=previous;return false;}
 return true;
}

export function createWorkbenchConsole({host,research,desk,workspace,intervention=null,privateUI=null}){
 const stamps=new Map();let riskValues=null,riskVersion=null,riskFeedback='',riskError=false,preferenceFeedback='',signalView='signals',noticeView='attention';
 let riskDialog=null,riskDialogTab='protection',riskDialogPolicy='astarter',riskDialogMode='normal',riskDialogValues={},riskDialogContext=null,riskDialogError='',riskDialogOpener=null;
 host.className='terminal-new workbench-console';
 host.innerHTML='<section class="ops-section ops-authorization" id="ops-plan"></section><section class="ops-section" id="ops-runs"></section><section class="ops-section" id="ops-positions"></section><section class="ops-section" id="ops-tracking"></section><section class="ops-section" id="ops-ai"></section><section class="ops-section" id="ops-signals"></section><section class="ops-section" id="ops-notices"></section>';
 const panels=Object.fromEntries(['plan','runs','positions','tracking','ai','signals','notices'].map(id=>[id,host.querySelector('#ops-'+id)]));
 let notificationRows=[],notificationScope=null,notificationWorkspace=workspace,exampleDialog=null,exampleOpener=null,examplesEnabled=research.mode!=='live_readonly',exampleScope='',privateNoticesVisible=false,privateNoticeScope='';
 const exampleReads={s:{},account:{scope:'workbench-examples'},touch(){}};
 function syncNotificationBadges(){
  if(privateUI){const state=privateUI.snapshot().notifications.state,count=state?.schema==='private-notifications-v2'?state.reminderUnreadCount:0,tab=document.querySelector('#ops-view-notifications');if(tab){tab.dataset.pendingCount='';tab.dataset.unreadCount=count?String(count):'';tab.setAttribute('aria-label',L('通知','Notices')+(count?' · '+L('未读提醒','Unread reminders')+' '+count:''));}return;}
  const unread=workbenchUnreadNotifications(notificationRows,notificationWorkspace,notificationScope),ids=new Set(unread.map(row=>row.id)),pending=notificationRows.filter(row=>row.kind==='attention').length;
  const tab=document.querySelector('#ops-view-notifications');if(tab){tab.dataset.pendingCount=pending?String(pending):'';tab.dataset.unreadCount=unread.length?String(unread.length):'';tab.setAttribute('aria-label',L('通知','Notices')+(unread.length?' · '+L('未读','Unread')+' '+unread.length:'')+(pending?' · '+L('待处理','To do')+' '+pending:''));}
  for(const button of panels.notices.querySelectorAll?.('[data-ops-notice-view]')||[]){const count=unread.filter(row=>(row.kind==='attention')===(button.dataset.opsNoticeView==='attention')).length;button.dataset.unreadCount=count?String(count):'';button.setAttribute('aria-label',(button.dataset.opsNoticeView==='attention'?L('待处理','To do'):L('记录','History'))+(count?' · '+L('未读','Unread')+' '+count:''));}
  const groups=workbenchNotificationGroups(notificationRows);
  for(const node of panels.notices.querySelectorAll?.('[data-receipt-group]')||[]){const count=groups.find(group=>group.id===node.dataset.receiptGroup)?.items.filter(row=>ids.has(row.id)).length||0;node.dataset.unreadCount=count?String(count):'';}
 }
 function notificationReadingVisible(){return document.visibilityState!=='hidden'&&document.body?.dataset.page==='workbench'&&document.querySelector('#ops-view-notifications')?.getAttribute('aria-selected')==='true'&&(typeof matchMedia!=='function'||!matchMedia('(max-width:900px)').matches||document.body.dataset.mobileView==='console');}
 const readObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
  if(!notificationReadingVisible())return;
  const scope=notificationReadScope(notificationWorkspace,notificationScope),ids=new Set(entries.filter(entry=>entry.isIntersecting&&entry.intersectionRatio>=.6&&entry.target.isConnected&&entry.target.dataset.opsNoticeScope===scope).map(entry=>entry.target.dataset.opsNoticeRead));
  if(markWorkbenchNotificationsRead(notificationRows.filter(row=>ids.has(row.id)),notificationWorkspace,notificationScope)){syncNotificationBadges();observeNotifications();}
 },{threshold:.6}):null;
 function observeNotifications(){
  if(privateUI){readObserver?.disconnect();if(document.visibilityState==='hidden')privateNoticesVisible=false;return;}
  if(!readObserver)return;readObserver.disconnect();readObserver.takeRecords();
  if(!notificationReadingVisible())return;
  const ids=new Set(workbenchUnreadNotifications(notificationRows,notificationWorkspace,notificationScope).map(row=>row.id));
  for(const node of panels.notices.querySelectorAll('[data-ops-notice-read]'))if(ids.has(node.dataset.opsNoticeRead)){node.dataset.opsNoticeScope=notificationReadScope(notificationWorkspace,notificationScope);readObserver.observe(node);}
 }
 document.addEventListener('visibilitychange',observeNotifications);
 const foldKey=fold=>fold.dataset.opsSignalEvidence||fold.dataset.receiptGroup||fold.className;
 function put(node,html){if(stamps.get(node)===html)return;const opened=[...(node.querySelectorAll?.('details[open]')||[])].map(foldKey),restore=captureProductFocus(node);node.innerHTML=html;for(const fold of node.querySelectorAll?.('details')||[])fold.open=opened.includes(foldKey(fold));stamps.set(node,html);restore();}
 const navigate=page=>document.dispatchEvent(new CustomEvent('hive:navigate',{detail:page}));
 const action=(title,page)=>`<button type="button" class="ops-mini-link" data-ops-route="${page}">${title}${uiGlyph('arrow')}</button>`;
 const heading=(title,extra='')=>`<header class="ops-section-heading"><h3>${title}</h3>${extra}</header>`;
 const percent=value=>Number.isFinite(value)?Number((value*100).toFixed(4))+'%':'—';
 const riskFields=[['episode','单次风险上限','Risk per entry'],['notional','单笔投入上限','Order allocation limit'],['daily','单日亏损暂停','Daily loss pause'],['epoch','风险期亏损暂停','Risk-period loss pause'],['soft','降风险阈值','Reduce risk at'],['hard','暂停阈值','Pause new entries at']];
 const limitsChanged=()=>Boolean(riskValues&&['cap','dailyLoss'].some(key=>Number(riskValues[key])!==workspace.s.risk[key]));
 function captureRiskDialog(){const form=riskDialog?.querySelector('form');if(form)Object.assign(riskDialogValues,Object.fromEntries(new FormData(form)));}
 function kellyResult(){
  const selected=savedProtection(workbenchRiskPreference(workspace,desk.syncStatus().scope));
  const ceiling=selected?.id==='astarter'?Protection.protectionRules(selected).episode:Protection.PROTECTION_RULES.episode;
  const result=workbenchKellyEstimate(riskDialogValues,ceiling);
  if(!result.valid)return `<div class="ops-kelly-empty">${L(result.reason==='missing'?'输入资金、胜率和净盈亏比，计算风险额度':'请检查输入数值',result.reason==='missing'?'Enter capital, win probability and net odds to estimate risk':'Check the input values')}</div>`;
  return `<div class="ops-kelly-result"><div><span>${L('测算风险比例','Estimated risk fraction')}</span><strong>${percent(result.riskFraction)}</strong></div><div><span>${L('测算风险金额','Estimated risk amount')}</span><strong>${number(result.riskAmount)} <small>USDT</small></strong></div></div><p class="ops-risk-explanation">${result.positive?L(result.capped?'已按单次风险上限封顶':'按输入条件计算，不代表已验证的胜率',result.capped?'Capped by the per-entry risk limit':'Based on your inputs; win probability is not verified'):L('按输入条件没有正向凯利额度','These inputs produce no positive Kelly allocation')}</p><details class="ops-risk-calculation"><summary>${L('查看计算依据','View calculation')}</summary><p>${L('完整凯利','Full Kelly')} ${percent(result.fullKelly)} · ${L('净盈亏比须扣除费用','Net odds must include costs')}</p><code>f = p − (1 − p) / b</code><p>${L('测算的是可承担的风险金额，不是下单金额','This estimates capital at risk, not order size')}</p></details>`;
 }
 function renderRiskDialog(){
  const sync=desk.syncStatus(),account=workbenchConsoleAccount(desk.readSnapshot?desk.readSnapshot():desk.snapshot(),sync),scopeSupported=sync.scope.accountId==='SIM-01'&&sync.scope.environment==='DEMO',canSave=Boolean(account&&scopeSupported&&sync.scope.accountId===riskDialogContext?.accountId&&sync.scope.environment===riskDialogContext?.environment),parametersReady=Boolean(Protection.PARAMETER_PROTECTION_VERSION);
  const field=(name,label,unit,min,max,step='any',enabled=true,description='')=>`<label class="ops-risk-field"><span>${label}</span><span class="ops-risk-input"><input name="${name}" aria-label="${label}" ${description?`aria-describedby="${description}"`:''} type="number" inputmode="decimal" min="${min}" ${max===null?'':`max="${max}"`} step="${step}" required value="${esc(riskDialogValues[name])}" ${enabled?'':'disabled'}><b>${unit}</b></span></label>`;
  const group=(id,title,description,keys)=>`<fieldset class="ops-risk-group"><legend>${title}</legend><p id="ops-risk-basis-${id}">${description}</p><div class="ops-risk-fields">${riskFields.filter(([key])=>keys.includes(key)).map(([key,zh,en])=>field('policy_'+key,L(zh,en),'%',.001,Protection.PROTECTION_RULES[key]*100,'any',canSave&&parametersReady,'ops-risk-basis-'+id)).join('')}</div></fieldset>`;
  const policyOptions=`<div class="ops-risk-policy-choices" role="group" aria-label="${L('选择风控策略','Choose a risk policy')}">${[['original','策略自带风控','Original strategy rules','沿用方案的止损与退出规则','Use the plan’s stops and exits'],['astarter','Astarter 分层风控','Astarter layered protection','叠加风险预算与回撤约束','Add risk budgets and drawdown limits']].map(([id,zh,en,descriptionZh,descriptionEn])=>`<button type="button" data-risk-policy="${id}" aria-pressed="${riskDialogPolicy===id}"><span class="ops-risk-radio" aria-hidden="true"></span><span><b>${L(zh,en)}</b><small>${L(descriptionZh,descriptionEn)}</small></span></button>`).join('')}</div>`;
  const policyBody=policyOptions+(riskDialogPolicy==='astarter'?`<div class="ops-risk-mode"><span>${L('风险档位','Risk mode')}</span><div role="group" aria-label="${L('风险档位','Risk mode')}">${[['normal','标准','Standard'],['conservative','保守','Conservative']].map(([id,zh,en])=>`<button type="button" data-risk-mode="${id}" aria-pressed="${riskDialogMode===id}">${L(zh,en)}</button>`).join('')}</div></div><p class="ops-risk-mode-note">${riskDialogMode==='conservative'?L('单次风险预算按标准档的 50% 执行','Per-entry risk uses 50% of the standard budget'):L('回撤达到降风险阈值后，单次风险预算减半','Per-entry risk halves at the drawdown threshold')}</p>`+
   group('entry',L('仓位与单次风险','Sizing & entry risk'),L('基于扣除利润储备后的方案权益','Based on plan equity after profit reserves'),['episode','notional'])+
   group('loss',L('亏损边界','Loss limits'),L('单日以日初权益计，风险期以初始资金计','Daily loss uses day-start equity; the risk period uses initial capital'),['daily','epoch'])+
   group('drawdown',L('回撤保护','Drawdown protection'),L('相对方案权益历史峰值；暂停不等于平仓','Relative to peak plan equity. A pause does not close positions'),['soft','hard']):`<div class="ops-risk-original">${uiGlyph('shield')}<p>${L('止损、止盈与退出条件在每份交易方案中设置，账户限额继续生效','Set stops, targets and exits in each trading plan. Account limits still apply')}</p></div>`)+
   `<p class="ops-risk-footnote">${L(parametersReady?'仅影响从模板新建的方案，现有运行保持原设置':'当前可查看既有规则；自定义参数尚未接入新方案',parametersReady?'Only for new plans created from templates. Existing runs keep their settings':'Existing rules are available to inspect. Custom parameters are not yet available for new plans')}</p>`;
  const kellyBody=`<div class="ops-kelly-intro"><p>${L('根据你的胜率与净盈亏比测算风险预算','Estimate risk from your win probability and net odds')}</p></div><div class="ops-risk-fields">${field('capital',L('测算资金','Capital for estimate'),'USDT',.01,Number.MAX_SAFE_INTEGER/100)}${field('winRate',L('预估胜率','Win probability'),'%',0,100)}${field('netOdds',L('净盈亏比','Net odds'),'R',.0001,null)}<label class="ops-risk-field"><span>${L('凯利系数','Kelly fraction')}</span><select name="fraction" aria-label="${L('凯利系数','Kelly fraction')}">${[.1,.25,.5,1].map(value=>`<option value="${value}" ${Number(riskDialogValues.fraction)===value?'selected':''}>${value===.25?L('四分之一凯利','¼ Kelly'):value===.5?L('半凯利','½ Kelly'):value===1?L('完整凯利','Full Kelly'):'0.1 × Kelly'}</option>`).join('')}</select></label></div><div class="ops-kelly-output" aria-live="polite">${kellyResult()}</div>`;
  riskDialog.innerHTML=`<header class="ops-risk-header"><div><h2 id="ops-risk-title">${L('风控设置','Risk settings')}</h2><p>${esc(riskDialogContext.accountId)} · ${esc(riskDialogContext.environment)} · ${riskDialogTab==='kelly'?L('仓位风险测算','Position risk estimate'):L('策略模板默认设置','Strategy template defaults')}</p></div><button type="button" class="ops-risk-close" data-risk-close aria-label="${L('关闭风控设置','Close risk settings')}">${uiGlyph('close')}</button></header><div class="ops-risk-tabs" role="tablist" aria-label="${L('风控设置','Risk settings')}">${[['protection','风控方案','Risk policy'],['kelly','凯利测算','Kelly estimate']].map(([id,zh,en])=>`<button type="button" role="tab" id="ops-risk-tab-${id}" data-risk-tab="${id}" aria-selected="${riskDialogTab===id}" tabindex="${riskDialogTab===id?0:-1}" aria-controls="ops-risk-dialog-panel">${L(zh,en)}</button>`).join('')}</div><form class="ops-risk-form"><div class="ops-risk-body" id="ops-risk-dialog-panel" role="tabpanel" aria-labelledby="ops-risk-tab-${riskDialogTab}">${riskDialogError?`<p class="ops-risk-feedback" role="alert" tabindex="-1">${esc(riskDialogError)}</p>`:''}${riskDialogTab==='kelly'?kellyBody:policyBody}${!canSave?`<p class="ops-risk-feedback" role="status">${scopeSupported?L('恢复当前账户数据后可保存','Restore this account’s data before saving'):L('当前账户暂不支持此配置','This configuration is not available for the current account')}</p>`:''}</div><footer class="ops-risk-footer"><span class="ops-risk-save-scope">${riskDialogTab==='kelly'?L('不自动应用到交易','Not applied to trades'):L('草稿预览，保存后用于新方案','Draft preview. Save to apply to new plans.')}</span>${riskDialogTab==='kelly'||parametersReady?`<button type="button" class="ops-button" data-risk-close>${L('取消','Cancel')}</button>`:''}${riskDialogTab==='kelly'||parametersReady?`<button class="ops-button ops-primary" type="submit" ${!canSave?'disabled':''}>${L(riskDialogTab==='kelly'?'保存测算参数':'保存默认设置',riskDialogTab==='kelly'?'Save estimate inputs':'Save defaults')}</button>`:`<button class="ops-button" type="button" data-risk-close>${L('关闭','Close')}</button>`}</footer></form>`;
 }
 function openRiskDialog(opener){
  const tab=opener.dataset.opsRiskOpen;
  const sync=desk.syncStatus(),saved=workbenchRiskPreference(workspace,sync.scope),policy=savedProtection(saved);
  riskDialogContext={...sync.scope,revision:saved?.revision||0,riskVersion:workspace.s.risk.version};riskDialogPolicy=policy?.id||'astarter';riskDialogMode=policy?.mode||'normal';riskDialogTab=tab;riskDialogError='';preferenceFeedback='';riskDialogOpener=opener;
  riskDialogValues={capital:'',winRate:'',netOdds:'',fraction:.25,...saved?.kelly,...Object.fromEntries(riskFields.map(([key])=>['policy_'+key,Number(((policy?.parameters?.[key]??Protection.PROTECTION_RULES[key])*100).toFixed(6))]))};
  if(!riskDialog){
   riskDialog=document.createElement('dialog');riskDialog.className='product-dialog ops-risk-dialog';riskDialog.setAttribute('aria-labelledby','ops-risk-title');riskDialog.setAttribute('data-localized-ui','');document.body.append(riskDialog);
   riskDialog.addEventListener('click',event=>{
    const target=event.target.closest('[data-risk-close],[data-risk-tab],[data-risk-policy],[data-risk-mode]');if(!target)return;
    if(target.hasAttribute('data-risk-close')){riskDialog.close();return;}
    const {riskTab,riskPolicy,riskMode}=target.dataset,restore=captureProductFocus(riskDialog);
    const panelScroll=riskDialog.querySelector('.ops-risk-body')?.scrollTop||0;
    captureRiskDialog();riskDialogError='';
    if(riskTab)riskDialogTab=riskTab;
    if(riskPolicy)riskDialogPolicy=riskPolicy;
    if(riskMode)riskDialogMode=riskMode;
    renderRiskDialog();
    if(riskTab)riskDialog.querySelector('#ops-risk-tab-'+riskDialogTab)?.focus({preventScroll:true});
    else {
     if(panelScroll)riskDialog.querySelector('.ops-risk-body').scrollTop=panelScroll;
     restore();
    }
   });
   riskDialog.addEventListener('keydown',event=>{if(!event.target.closest('[data-risk-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();captureRiskDialog();riskDialogTab=event.key==='Home'?'protection':event.key==='End'?'kelly':riskDialogTab==='protection'?'kelly':'protection';renderRiskDialog();riskDialog.querySelector('#ops-risk-tab-'+riskDialogTab)?.focus();});
   riskDialog.addEventListener('input',()=>{captureRiskDialog();riskDialogError='';riskDialog.querySelector('[role=alert]')?.remove();const output=riskDialog.querySelector('.ops-kelly-output');if(output)output.innerHTML=kellyResult();});
   riskDialog.addEventListener('change',()=>{captureRiskDialog();const output=riskDialog.querySelector('.ops-kelly-output');if(output)output.innerHTML=kellyResult();});
   riskDialog.addEventListener('submit',event=>{event.preventDefault();captureRiskDialog();const trade=desk.readSnapshot?desk.readSnapshot():desk.snapshot(),sync=desk.syncStatus();const parameters=Object.fromEntries(riskFields.map(([key])=>[key,Number(riskDialogValues['policy_'+key])/100]));const values=riskDialogTab==='kelly'?{kind:'kelly',kelly:riskDialogValues}:{kind:'protection',protection:Protection.protectionConfig(riskDialogPolicy,riskDialogMode,riskDialogPolicy==='astarter'?parameters:undefined)};riskDialogError=saveWorkbenchRiskPreference(workspace,values,{trade,sync,scope:riskDialogContext,revision:riskDialogContext.revision,riskVersion:riskDialogContext.riskVersion});if(riskDialogError){renderRiskDialog();riskDialog.querySelector('[role=alert]')?.focus({preventScroll:true});riskDialog.querySelector('[role=alert]')?.scrollIntoView?.({block:'nearest'});return;}preferenceFeedback=riskDialogTab==='kelly'?L('测算参数已保存，未应用到交易','Estimate inputs saved. No trades changed'):L('模板默认风控已保存，现有运行不变','Template risk defaults saved. Existing runs are unchanged');riskDialog.close();update();});
   riskDialog.addEventListener('close',()=>{const opener=riskDialogOpener?.isConnected?riskDialogOpener:riskDialogOpener?.dataset.opsRiskOpen?host.querySelector('[data-ops-risk-open="'+riskDialogOpener.dataset.opsRiskOpen+'"]'):null;if(opener&&!opener.closest('[hidden]'))opener.focus({preventScroll:true});});
  }
  renderRiskDialog();riskDialog.showModal();
 }
 function openExample(id){
  const html=workbenchExampleDetail(id);if(!html)return;
  exampleOpener=document.activeElement;
  if(!exampleDialog){
   exampleDialog=document.createElement('dialog');exampleDialog.className='product-dialog ops-example-dialog';document.body.append(exampleDialog);
   exampleDialog.addEventListener('click',event=>{if(event.target.closest('[data-example-close]')||event.target===exampleDialog)exampleDialog.close();});
   exampleDialog.addEventListener('close',()=>exampleOpener?.isConnected&&exampleOpener.focus());
  }
  exampleDialog.innerHTML=html;exampleDialog.setAttribute('aria-label',L('模拟交易示例','Simulated trade example'));exampleDialog.showModal();
 }
 host.addEventListener('click',event=>{
  if(event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const target=event.target.closest('[data-ops-route],[data-ops-settings],[data-ops-strategy],[data-ops-risk-reset],[data-ops-run],[data-ops-signal-view],[data-ops-notice-view],[data-ops-risk-open],[data-ops-example],[data-ops-example-toggle]');
  if(target?.dataset.opsExample){openExample(target.dataset.opsExample);}
  else if(target?.hasAttribute?.('data-ops-example-toggle')){examplesEnabled=!examplesEnabled;update();}
  else if(target?.dataset.opsRiskOpen){openRiskDialog(target);}
  else if(target?.dataset.opsRoute){if(target.tagName==='A')event.preventDefault();navigate(target.dataset.opsRoute);}
  else if(target?.dataset.opsRun){event.preventDefault();document.dispatchEvent(new CustomEvent('hive:workbench-strategy',{detail:{kind:'run',id:target.dataset.opsRun}}));}
  else if(target?.dataset.opsSettings)desk.settings(target.dataset.opsSettings);
  else if(target?.dataset.opsStrategy){
   if(target.dataset.opsStrategy==='recommendation'){
    const trade=desk.readSnapshot?desk.readSnapshot():desk.snapshot(),row=strategyRecommendations(workspace,trade||{}).find(item=>item.id===target.dataset.id);
    if(workbenchSignalState(row)!=='ready'){update();return;}
   }
   const kind=target.dataset.opsStrategy,preference=workbenchRiskPreference(workspace,desk.syncStatus().scope);
   document.dispatchEvent(new CustomEvent('hive:workbench-strategy',{detail:{kind,id:target.dataset.id,...(kind==='template'&&savedProtection(preference)?{riskPreferenceRevision:preference.revision}:{})}}));
  }
  else if(['signals','strategies'].includes(target?.dataset.opsSignalView)){signalView=target.dataset.opsSignalView;update();}
  else if(['attention','history'].includes(target?.dataset.opsNoticeView)){noticeView=target.dataset.opsNoticeView;update();}
  else if(target?.hasAttribute('data-ops-risk-reset')){riskValues=null;riskVersion=null;riskFeedback='';riskError=false;update();}
 });
 host.addEventListener('input',event=>{const form=event.target.closest('[data-ops-risk-form]');if(!form)return;riskValues=Object.fromEntries(new FormData(form));riskVersion=Number(form.dataset.version);riskFeedback='';riskError=false;form.querySelector('.ops-risk-feedback')?.remove();const changed=limitsChanged();form.querySelector('.ops-capital-actions').hidden=!changed;form.querySelector('[data-ops-limits-state]').textContent=changed?L('未保存','Unsaved'):L('账户共用','Account-wide');const runtime=form.querySelector('[data-ops-limits-runtime]');if(runtime)runtime.hidden=!changed;});
 host.addEventListener('submit',event=>{
  const form=event.target.closest('[data-ops-risk-form]');if(!form)return;event.preventDefault();
  const trade=desk.readSnapshot?desk.readSnapshot():desk.snapshot();
  const previous=workspace.s.risk.version,error=saveWorkbenchLimits(workspace,Object.fromEntries(new FormData(form)),{trade,sync:desk.syncStatus(),version:Number(form.dataset.version)});
  riskError=Boolean(error);riskFeedback=error||L('交易限额已保存','Trading limits saved');
  if(!error&&previous!==workspace.s.risk.version&&workbenchConsoleRuns(trade,desk.syncStatus().scope.accountId).length)riskFeedback=L('限额已保存，现有运行新增买入需重新核验','Limits saved. Recheck existing runs before new buys');
  if(!error){riskValues=null;riskVersion=null;}update();
 });
 function update(){
  const trade=desk.readSnapshot?desk.readSnapshot():desk.snapshot(),sync=desk.syncStatus(),accountId=sync.scope.accountId;
  if(riskDialog?.open&&(riskDialogContext.accountId!==accountId||riskDialogContext.environment!==sync.scope.environment))riskDialog.close();
  const runs=workbenchConsoleRuns(trade,accountId),account=workbenchConsoleAccount(trade,sync);
  document.querySelector('.console-header h2').textContent=L('操作台','Controls');
  const liveBooks=connectedAccountBalances(trade?.connections);
  const liveIdentity=liveBooks.map(row=>row.kind==='wallet'?L('我的钱包','My wallet'):L('共享币安现货','Shared Binance spot')).join(' · ');
  if(intervention)put(intervention,`<span class="ops-account-identity" title="${esc(accountId)} · ${esc(sync.scope.environment)}">${liveIdentity||(sync.scope.environment==='DEMO'?L('模拟盘','Paper trading'):esc(accountId))}</span>`);
  const scopeKey=JSON.stringify(sync.scope);if(scopeKey!==exampleScope){exampleScope=scopeKey;examplesEnabled=research.mode!=='live_readonly';}
  const examplesAvailable=workbenchExamplesAvailable(trade,sync.scope),examples=examplesAvailable&&examplesEnabled;
  const exampleToggle=examplesAvailable?`<button type="button" class="ops-example-toggle" data-ops-example-toggle>${examples?L('查看账户','View account'):L('查看示例','View examples')}</button>`:'';
  const exampleSwitch=examplesAvailable?`<div class="ops-example-source"><span>${examples?L('模拟示例 · 不计入账户','Examples · separate from account'):L('当前账户','Current account')}</span>${exampleToggle}</div>`:'';
  const limits=workspace.s.risk,editing=riskValues||limits,changed=limitsChanged(),canConfigure=Boolean(account&&accountId==='SIM-01'&&sync.scope.environment==='DEMO');
  const connection=preferredTradingConnection(trade?.connections),profileId=connection?.kind==='wallet'?walletTradingProfile(connection):'cex-'+(connection?.market||'spot');
  const access=desk.access?.({connectionId:connection?.id||'',profileId})||sync.access,accessCopy=ACCESS_COPY[access?.code];
  const accessLabel=accessCopy?L(accessCopy[0],accessCopy[1]):L('检查接入','Check access');
  const selectedPolicy=savedProtection(workbenchRiskPreference(workspace,sync.scope));
  const rules=selectedPolicy?.id==='astarter'?Protection.protectionRules(selectedPolicy):null;
  const policyName=rules?L('Astarter 分层风控','Astarter layered protection')+' · '+(selectedPolicy.mode==='conservative'?L('保守','Conservative'):L('标准','Standard'))
   :selectedPolicy?L('策略自带风控','Original strategy rules'):'';
  const usage=workbenchRiskUsage(account,limits);
  const meter=(label,value,max,remaining)=>`<div class="ops-risk-meter"><div><span>${label}</span><b>${number(value)} / ${number(max)} <small>USDT</small></b></div><meter min="0" max="${max}" value="${value}" aria-label="${label}"></meter><small>${L('剩余','Remaining')} ${number(remaining)} USDT</small></div>`;
  const riskUsage=`<div class="ops-risk-usage">${usage?meter(L('已分配额度','Allocated'),usage.allocated,limits.cap,usage.allocationRemaining)+meter(L('亏损 / 费用占用','Loss / fee use'),usage.lossUsed,limits.dailyLoss,usage.lossRemaining)+`<p class="ops-risk-live" data-paused="${usage.paused}">${uiGlyph('shield')}${usage.paused?L('账户保护已限制新增买入','Account protection restricts new buys'):L('账户限额内；每笔仍需通过策略风控','Within account limits; each entry still needs strategy checks')}</p>`:`<p class="ops-field-help">${L('当前用量待账户同步；未将未知数据当作零。','Usage awaits account sync; unknown values are not zero.')}</p>`}</div>`;
  const protectionStats=rules?`<div class="ops-protection-grid">${[['episode','单次风险上限','Risk per entry'],['notional','单笔投入','Order allocation'],['daily','单日暂停线','Daily loss pause'],['hard','回撤暂停线','Drawdown pause']].map(([key,zh,en])=>`<div><span>${L(zh,en)}</span><b>${percent(rules[key])}</b></div>`).join('')}</div><p class="ops-field-help">${L('仅影响从模板新建的方案，现有运行保持原设置','Only for new plans created from templates. Existing runs keep their settings')}</p>`
   :selectedPolicy?`<p class="ops-field-help">${L('使用每个策略自己的止损与退出规则。账户总额度和暂停线仍同时生效。','Each strategy uses its own stop and exit rules. Account allocation and pause limits still apply.')}</p>`:'';
  const policyRow=`<div class="ops-protection-card">
   <header class="ops-policy-heading"><h3 id="ops-protection-title">${L('新方案风控','New plan risk policy')}</h3>${selectedPolicy?'':`<span class="ops-policy-state">${L('未设置','Not configured')}</span>`}</header>
   ${policyName?`<p class="ops-policy-name">${policyName}</p>`:''}
   ${protectionStats}
   <div class="ops-policy-actions" role="group" aria-labelledby="ops-protection-title">
    <button type="button" data-ops-risk-open="protection" aria-haspopup="dialog">${selectedPolicy?L('编辑','Edit'):L('设置','Set up')}${uiGlyph('chevron')}</button>
    <button type="button" data-ops-risk-open="kelly" aria-haspopup="dialog">${L('凯利测算','Kelly estimate')}</button>
   </div></div>${preferenceFeedback&&riskDialogContext?.accountId===accountId&&riskDialogContext.environment===sync.scope.environment?`<p class="ops-risk-feedback" role="status">${esc(preferenceFeedback)}</p>`:''}`;
  put(panels.plan,`<button class="ops-access-row" type="button" data-ops-settings="exchange"><span class="ops-access-icon">${uiGlyph('shield')}</span><span><b>${L('交易接入','Trading access')}</b><small>${esc(accessLabel)}</small></span><span class="ops-access-edit">${L('管理','Manage')}${uiGlyph('chevron')}</span></button>`+
   `<form class="ops-capital-form" data-ops-risk-form data-version="${riskVersion??limits.version}">${heading(L('交易限额','Trading limits'),`<span class="ops-limits-state" data-ops-limits-state>${changed?L('未保存','Unsaved'):L('账户共用','Account-wide')}</span>`)}<div class="ops-capital-fields"><label>${L('总投入上限','Allocation limit')}<span><input name="cap" aria-label="${L('账户总额度','Account allocation')}" type="number" inputmode="decimal" min="10" max="3000" step="any" required value="${esc(editing.cap)}" ${canConfigure?'':'disabled'}><b>USDT</b></span></label><label>${L('累计亏损 / 费用','Cumulative loss / fees')}<span><input name="dailyLoss" aria-label="${L('累计亏损或费用暂停线','Cumulative loss or fee pause limit')}" type="number" inputmode="decimal" min="1" max="500" step="any" required value="${esc(editing.dailyLoss)}" ${canConfigure?'':'disabled'}><b>USDT</b></span></label></div><p class="ops-field-help">${L('累计亏损或手续费达上限时暂停新买入；已有挂单仍可能成交','New buys pause when cumulative loss or fees reach the limit; open orders can still fill')}</p><div class="ops-capital-actions" ${changed?'':'hidden'}><button class="ops-button ops-primary" type="submit" ${canConfigure?'':'disabled'}>${L('保存限额','Save limits')}</button><button class="ops-mini-link" type="button" data-ops-risk-reset>${L('撤销修改','Undo changes')}</button></div>${runs.length?`<p class="ops-risk-runtime" data-ops-limits-runtime ${changed?'':'hidden'}>${L('限额变更后，现有运行新增买入需重新核验','Changed limits require existing runs to be rechecked before new buys')}</p>`:''}${riskFeedback?`<p class="ops-risk-feedback" role="${riskError?'alert':'status'}">${esc(riskFeedback)}</p>`:''}${!canConfigure?`<p class="ops-risk-feedback" role="status">${L('恢复当前账户数据后可调整。','Restore this account before adjusting limits.')}</p>`:''}</form>${riskUsage}${policyRow}`);

  const labels={running:['运行中','Running'],waiting:['等待触发','Waiting'],paused:['已暂停','Paused'],interrupted:['已中断','Interrupted'],blocked:['需处理','Needs attention'],unknown:['回执待确认','Receipt unconfirmed'],pending:['订单处理中','Order pending'],approval:['待批准','Approval pending'],confirm:['待确认','Confirmation needed'],position:['持仓保留','Position retained'],manual:['交易管理中','Managing trade'],stopping:['正在结束','Ending'],stopped:['已停止','Stopped'],failed:['执行失败','Failed']};
  const runCount=examples?4:runs.length;
  const runHeading=heading(L('策略运行','Strategy runs')+(runCount?`<span class="ops-section-count">${runCount}</span>`:''),`<button type="button" class="ops-link" ${examples?'data-ops-example="history"':'data-statements="AI_SPECTRUM"'} aria-haspopup="dialog">${L('交易记录','Trade history')}${uiGlyph('arrow')}</button>`);
  const emptyRuns=`<div class="ops-run-empty"><p class="ops-empty">${L('暂无运行','No runs yet')}</p>${exampleToggle}</div>`;
  put(panels.runs,runHeading+(examples?exampleSwitch+workbenchExampleRunList():runs.length?`<div class="ops-run-list">${runs.map(run=>{const profile=strategyById(run.strategy),name=profile?strategyName(profile):L('Agent 运行','Agent run');return `<a class="ops-run-row" href="?page=execution&runId=${encodeURIComponent(run.id)}" data-ops-run="${esc(run.id)}"><span class="ops-run-heading">${tokenIcon(run.market?.split('/')[0],{size:22})}<strong>${esc(name)}</strong><span class="ops-run-manage">${L('管理','Manage')}${uiGlyph('chevron')}</span></span><span class="ops-run-market">${esc(run.market||'—')}</span><span class="ops-run-bottom"><span class="ops-run-state" data-state="${esc(run.state)}"><i></i>${L(...(labels[run.state]||['状态待确认','Status unconfirmed']))}${run.retained?L(' · 持仓保留',' · Position retained'):''}</span>${Number.isFinite(run.pnl)?`<b aria-label="${L('总盈亏','Total PnL')}">${(run.pnl>0?'+':'')+number(run.pnl)} USDT</b>`:''}</span>${run.attention?`<span class="ops-inline-issue">${run.attention==='unknown'?L('原订单回执待确认','Original order outcome unconfirmed'):L('资金预留待核对','Reserved funds need review')}</span>`:run.riskIssue==='budget'?`<span class="ops-inline-issue">${L('风控额度不足，等待可交易条件','Risk budget is too small. Waiting for eligible conditions')}</span>`:''}</a>`;}).join('')}</div>`:emptyRuns));
  const spot=connectedSpotBalance(trade?.connections),linkedSpot=tradingConnections(trade?.connections).find(record=>record.id==='binance-spot'&&record.status==='connected'&&typeof record.available==='number'),binanceUsdt=spot?spot.available:linkedSpot?linkedSpot.available:null,binanceLocked=spot?spot.locked:linkedSpot&&typeof linkedSpot.locked==='number'?linkedSpot.locked:0,book=spot?trade?.connections?.spotBook:null;
  const binanceOrders=book?.orders?.map(row=>`<li>${row.strategy?esc(row.strategy)+' ':''}${row.side==='BUY'?L('买入','Buy'):L('卖出','Sell')} ${esc(row.origQty)} @ ${esc(row.price)}</li>`).join('')||'';
  const liveCount=id=>book?.orders?.filter(row=>row.strategy===id).length||0;
  const openOrders=Array.isArray(book?.orders)?book.orders.length:null;
  const liveBots=book?`<div class="ops-reserved"><span>S01 ${L('现货网格','Spot grid')}</span><b>${liveCount('S01')?L('已挂在这个币安现货','Live on this Binance spot')+' '+liveCount('S01'):L('账户已接上，这一轮没有挂单','Account connected, no open order this round')}</b></div><div class="ops-reserved"><span>S02 ${L('三层篮子','Three-layer basket')}</span><b>${liveCount('S02')?L('已挂在这个币安现货','Live on this Binance spot')+' '+liveCount('S02'):L('账户已接上，还没有挂单','Account connected, no order yet')}</b></div><p class="ops-field-help">${L('S01 和 S02 使用已核对的币安现货，交易对 BTC/USDT，提现关闭。保存方案记在这个账户上，不会发单。','S01 and S02 use the checked Binance spot account, pair BTC/USDT, withdrawals off. A saved plan stays on this account and does not send an order.')}</p>`:'';
  const binanceHoldings=binanceUsdt!==null?`<div class="ops-available"><span>${L('币安可用','Binance available')}</span><b>${number(binanceUsdt)} <small>USDT</small></b></div>${binanceLocked>0?`<div class="ops-reserved"><span>${L('币安挂单冻结','Binance reserved')}</span><b>${number(binanceLocked)} USDT</b></div>`:''}${book?`<div class="ops-reserved"><span>BTC</span><b>${book.btc}</b></div><div class="ops-reserved"><span>${L('币安挂单','Binance orders')}</span><b>${book.orders.length}</b></div>${binanceOrders?`<ul class="ops-field-help">${binanceOrders}</ul>`:''}${liveBots}`:''}<button class="ops-account-open" type="button" data-ops-strategy="account" data-id="${esc(accountId)}"><span>${L('模拟持仓','Paper positions')} <b>${account?.positions??0}</b></span><span>${L(openOrders===null?'模拟挂单':'挂单详情',openOrders===null?'Paper orders':'Open orders')} <b>${openOrders??account?.orders??0}</b></span>${uiGlyph('arrow')}</button>`:'';
  const paperHoldings=account?`<div class="ops-available"><span>${account.environment==='DEMO'?L('模拟盘可用余额','Available paper balance'):L('可用余额','Available balance')}</span><b>${number(account.available)} <small>${esc(account.unit||'USDT')}</small></b></div>${account.reserved>0?`<div class="ops-reserved"><span>${L('已预留','Reserved')}</span><b>${number(account.reserved)} ${esc(account.unit||'USDT')}</b></div>`:''}<button class="ops-account-open" type="button" data-ops-strategy="account" data-id="${esc(accountId)}"><span>${L('模拟持仓','Paper positions')} <b>${account?.positions??0}</b></span><span>${L('模拟挂单','Paper orders')} <b>${account?.orders??0}</b></span>${uiGlyph('arrow')}</button>`:'';
  put(panels.positions,heading(L('账户资产','Account assets'))+(binanceHoldings||paperHoldings||`<p class="ops-empty">${L('账户数据暂不可用','Account data is unavailable')}</p>`));
  const watched=watchedSymbols(workspace),scan=marketScanSymbols(research,workspace.s.aiSignalPreferences);
  put(panels.tracking,heading(L('研究范围','Research scope'),action(L('管理','Manage'),'watchlist'))+`<div class="ops-scope-summary"><span>${L('我的追踪','My watchlist')}<b>${watched.length}</b></span><span>${L('市场扫描','Market scan')}<b>${scan.length}</b></span></div>`);
  const health=workbenchAIHealth(trade?.connections,workspace),{preferences,issues}=health;
  put(panels.ai,heading(L('研究配置','Research settings'))+`<button type="button" class="ops-config-row" data-ops-settings="ai"><span><small>${L('模型','Model')}</small><b>${esc(health.model)}</b></span>${uiGlyph('chevron')}</button><button type="button" class="ops-config-row" data-ops-settings="data"><span><small>${L('数据来源','Data sources')}</small><b>${preferences.data.source==='custom'?L('自带数据 API','Own data API'):L('Astarter 数据','Astarter data')}</b></span>${uiGlyph('chevron')}</button>${issues.length?`<div class="ops-ai-issues">${issues.map(issue=>`<button type="button" ${issue.route?`data-ops-route="${esc(issue.route)}"`:`data-ops-settings="${esc(issue.action)}"`}><span>${esc(issue.text)}</span>${uiGlyph('chevron')}</button>`).join('')}</div>`:''}`);  const recommendations=workbenchSignalShortlist(strategyRecommendations(workspace,trade||{}));
  const signalTabs=`<div class="ops-source-switch" role="group" aria-label="${L('选择信号来源','Choose a source')}"><button type="button" data-ops-signal-view="signals" aria-pressed="${signalView==='signals'}">${L('AI 信号','AI signals')}</button><button type="button" data-ops-signal-view="strategies" aria-pressed="${signalView==='strategies'}">${L('策略模板','Strategy templates')}<span>${CATALOG.length}</span></button></div>`;
  const templates=CATALOG.map(strategy=>`<button class="ops-strategy-choice" type="button" data-ops-strategy="template" data-id="${strategy.id}"><span class="ops-strategy-icon">${uiGlyph(strategy.kind==='event'?'calendar':strategy.execution==='research'?'layers':'activity')}</span><span><b>${esc(strategyName(strategy))}</b><small>${esc(strategyDescription(strategy))}</small></span>${uiGlyph('chevron')}</button>`).join('');
  put(panels.signals,signalTabs+(signalView==='signals'?workbenchSignalList(recommendations,research):`<p class="ops-template-hint">${L('按策略查看适用市场、参数与可用状态。','Review each strategy’s markets, parameters and availability.')}</p><div class="ops-strategy-list">${templates}</div>`));
  if(privateUI){
   const privateState=privateUI.snapshot(),scope=privateState.identityStatus+':'+privateState.ownerRef,visible=notificationReadingVisible(),entering=visible&&(!privateNoticesVisible||scope!==privateNoticeScope);privateNoticesVisible=visible;privateNoticeScope=scope;
   put(panels.notices,`<div class="ops-source-switch"><button type="button" data-ops-settings="notifications">${L('通知设置','Notification settings')}${uiGlyph('settings')}</button></div>`+privateUI.renderInbox());syncNotificationBadges();
   if(entering)queueMicrotask(()=>{if(notificationReadingVisible())void privateUI.loadNotifications();});
  }else{
  const actualNotices=workbenchConsoleNotifications(trade,workspace,accountId),exampleNotices=examples&&!actualNotices.length;
  const notices=exampleNotices?workbenchExampleNotices():actualNotices;
  const attention=notices.filter(row=>row.kind==='attention'),history=workbenchNotificationGroups(notices);
  const noticeTarget=row=>row.exampleId?`data-ops-example="${esc(row.exampleId)}"`:row.runId?`data-ops-run="${esc(row.runId)}"`:`data-ops-strategy="account" data-id="${esc(accountId)}"`;
  const currentRun=executionRunIdentity(trade,sync.scope);
  // shortcut: mirrors the manager's SIM-01/DEMO boundary; use shared eligibility when the manager exposes it.
  const canOpenNoticeRun=id=>{
   if(!id||accountId!=='SIM-01'||sync.scope.environment!=='DEMO'||trade?.botSummary?.recoveryError)return false;
   const reported=trade?.accountSummary?.accountId||trade?.accountId;if(reported&&reported!==accountId)return false;
   const native=trade?.botBook?.runs?.find(run=>run.id===id);
   return native?native.plan?.executionRoute?.accountId===accountId&&native.environment===sync.scope.environment:currentRun?.runId===id&&currentRun.accountId===accountId&&currentRun.environment===sync.scope.environment;
  };
  const filters=`<div class="ops-source-switch" role="group" aria-label="${L('通知类型','Notification type')}"><button type="button" data-ops-notice-view="attention" aria-pressed="${noticeView==='attention'}">${L('待处理','To do')}<span>${attention.length}</span></button><button type="button" data-ops-notice-view="history" aria-pressed="${noticeView==='history'}">${L('记录','History')}<span>${notices.length-attention.length}</span></button><button class="ops-notice-settings" type="button" data-ops-settings="notifications" aria-label="${L('通知设置','Notification settings')}">${uiGlyph('settings')}</button></div>`;
  const attentionItems=attention.map(row=>`<article class="ops-issue"><span class="ops-issue-symbol">${row.symbol?tokenIcon(row.symbol,{size:24}):uiGlyph('shield')}<b>${esc(row.symbol||L('当前账户','Current account'))}</b></span><h4 data-ops-notice-read="${esc(row.id)}">${esc(row.text)}</h4>${row.detail?`<p class="ops-field-help">${esc(row.detail)}</p>`:''}<button class="ops-signal-action" type="button" ${noticeTarget(row)}>${row.exampleId?L('查看示例','View example'):L('查看并处理','Review & resolve')}${uiGlyph('arrow')}</button></article>`).join('');
  const records=history.map(group=>`<details class="ops-receipt-group" data-receipt-group="${esc(group.id)}"><summary data-ops-notice-read="${esc(group.items[0].id)}"><span class="ops-receipt-icon">${group.symbol?tokenIcon(group.symbol,{size:22}):uiGlyph('check')}</span><span><b>${esc(group.symbol||L('账户记录','Account activity'))}</b><small>${esc(group.text)}</small></span><span class="ops-receipt-meta">${group.age!==null?`<time>${workbenchAge(0,group.age)}</time>`:''}<em>${group.items.length} ${L('条','events')}</em></span>${uiGlyph('chevron')}</summary><ol>${group.items.map(row=>`<li data-ops-notice-read="${esc(row.id)}"><span>${esc(row.text)}</span></li>`).join('')}</ol>${group.exampleId?`<button class="ops-signal-action" type="button" data-ops-example="${esc(group.exampleId)}">${L('查看示例运行','View example run')}${uiGlyph('arrow')}</button>`:canOpenNoticeRun(group.runId)?`<button class="ops-signal-action" type="button" data-ops-run="${esc(group.runId)}">${L('查看这次运行','View this run')}${uiGlyph('arrow')}</button>`:''}</details>`).join('');
  const empty=noticeView==='attention'?`<div class="ops-notices-empty">${uiGlyph(trade?'check':'refresh')}<b>${trade?L('当前没有待处理事项','Nothing needs attention'):L('通知暂不可用','Notifications unavailable')}</b></div>`:`<p class="ops-empty">${L('还没有交易记录','No trading activity yet')}</p>`;
  put(panels.notices,(exampleNotices||!actualNotices.length?exampleSwitch:'')+filters+(noticeView==='attention'?(attentionItems||empty):(records||empty)));
  notificationRows=notices;notificationScope={...sync.scope};notificationWorkspace=exampleNotices?exampleReads:workspace;syncNotificationBadges();observeNotifications();
  }
 }
 document.addEventListener('hive:locale',()=>{stamps.clear();if(riskDialog?.open){captureRiskDialog();renderRiskDialog();}update();});
 function closeDialogs(){if(riskDialog?.open)riskDialog.close();if(exampleDialog?.open)exampleDialog.close();}
 document.addEventListener('hive:navigate',()=>{privateNoticesVisible=false;readObserver?.disconnect();closeDialogs();});
 document.addEventListener('hive:page-leave',event=>{if(event.detail==='workbench')closeDialogs();});
 return {update,stopReading(){privateNoticesVisible=false;readObserver?.disconnect();}};
}

// The research and execution clocks are independent; display age, never elapsed minutes as a wall clock.
export function workbenchAge(at,now){
 if(!Number.isFinite(at)||!Number.isFinite(now))return L('时间未提供','Time unavailable');
 const seconds=Math.max(0,Math.floor(now-at));
 if(seconds<10)return L('刚刚','Just now');
 if(seconds<60)return L(`${seconds} 秒前`,`${seconds}s ago`);
 if(seconds<3600)return L(`${Math.floor(seconds/60)} 分钟前`,`${Math.floor(seconds/60)}m ago`);
 if(seconds<86400)return L(`${Math.floor(seconds/3600)} 小时前`,`${Math.floor(seconds/3600)}h ago`);
 return L(`${Math.floor(seconds/86400)} 天前`,`${Math.floor(seconds/86400)}d ago`);
}
export function workbenchPlainEvent(text=''){
 let clean=text.replace(/\bSIM-ORD-\d+\s*/g,'').replace(/\s*[·•]\s*(?:进入\s*)?v\d+\b/gi,'').replace(/\bv\d+\s*/gi,'');
 for(const [source,zh,en]of [['共享美元背景','美元变化已同步给相关小组','Dollar changes shared with relevant teams'],['共享利率背景','利率变化已同步给相关小组','Rate changes shared with relevant teams'],['组内核验完成，报告等待核心','小组已完成检查，等待汇总','Team checks complete; awaiting core review'],['向核心递交报告','报告已送达核心','Report delivered to the core'],['定期检查新证据','正在检查新变化','Checking for new developments'],['进入策略候选','发现可继续跟进的机会','Opportunity ready for further review'],['等待结构确认','等待价格走势确认','Waiting for price confirmation'],['分歧 · 暂缓跟进','不同资料有冲突，暂不跟进','Conflicting evidence; follow-up on hold'],['待补 · 权重证据','还需检查大盘股的带动作用','Checking the influence of large-cap stocks'],['避险候选 · 待跟踪','发现避险线索，继续跟踪','Defensive opportunity under review']])clean=clean.replace(source,L(zh,en));
 return clean;
}
export function workbenchAttention(trade,access){
 const phase=workbenchOperationState(trade).status,rows=[];
 // Querying an unknown order takes priority over starting or resuming anything.
 if(phase==='unknown')rows.push({id:'unknown',title:L('先确认这一笔订单的结果','Resolve the open order'),text:L('结果尚未返回，查清前不要重复下单。','The outcome is unknown. Check it before submitting again.'),action:'reconcile',cta:L('查询原订单','Check original order'),disabled:!access?.control});
 else if(phase==='approval')rows.push({id:'approval',title:L('有一份入场方案待批准','An entry awaits approval'),text:L('核对金额与保护后批准；过期自动跳过。','Review the entry and protection. Expired plans are skipped.'),route:'workbench',cta:L('查看入场方案','Review entry')});
 else if(trade?.session?.mode==='confirm'&&trade.state!=='stopped')rows.push({id:'confirm',title:L('旧运行需要更新设置','Legacy run needs updated settings'),text:L('先停止旧运行，再配置 Agent 自动执行。已有订单和持仓保留。','Stop the legacy run before configuring Agent execution. Existing orders and holdings are retained.'),route:'execution',cta:L('查看旧运行','Review legacy run')});
 const impaired=trade?.flow?.protections?.some(p=>p.instanceId===trade.session?.id&&['IMPAIRED','UNKNOWN'].includes(p.state)&&Number(p.targetQuantity)>0);
 if(impaired)rows.push({id:'protection',title:L('持仓保护需要处理','Position protection needs attention'),text:L('新的买入已受限制。先检查已有持仓的保护状态。','New entries are restricted. Check protection on existing holdings.'),route:'execution',cta:L('检查资金保护','Review protection')});
 if(!trade||!access?.ready){const copy=ACCESS_COPY[access?.code];rows.push({id:'connection',title:copy?L(copy[0],copy[1]):L('交易接入需要处理','Trading access needs attention'),text:copy?L(copy[2],copy[3]):L('检查当前账户的连接和权限。','Check the current account connection and permissions.'),action:'connect',cta:L('检查接入','Check access')});}
 if(phase==='blocked'&&access?.ready)rows.push({id:'blocked',title:L('策略暂时不能继续','Strategy is blocked'),text:workbenchPlainEvent(trade.events?.find(event=>event.kind==='risk')?.text||L('检查交易限制和资金保护，再决定是否继续。','Check trading limits and protection before continuing.')),route:'execution',cta:L('查看原因与处理方式','Review & resolve')});
 if(phase==='paused'&&access?.ready&&trade.session?.mode!=='confirm')rows.push({id:'paused',title:L('策略已暂停','Strategy is paused'),text:trade.position?L('已有持仓保留；检查后可恢复接收机会。','Positions are retained. Review before resuming new entries.'):L('当前没有持仓；检查后可继续等待机会。','No open positions. Review before watching for entries again.'),view:'ai',cta:L('检查运行设置','Review run settings')});
 if(phase==='position'||trade?.state==='stopped'&&trade?.position)rows.push({id:'position',title:L('策略停止后仍有持仓','A position remains after stopping'),text:trade.position?.market||'',view:'ai',cta:L('管理持仓','Manage position')});
 return rows;
}

export function workbenchFeedSelection(rows,kind='all',asset='all'){
 const selected=rows.filter(row=>(asset==='all'||row.symbol===asset||row.symbols?.includes(asset)||row.kind==='risk'&&!row.symbol)&&(kind==='all'||row.kind===kind||kind==='trade'&&row.kind==='risk'||kind==='analysis'&&row.kind==='signal'||kind==='market'&&row.kind==='anomaly'));
 if(kind!=='all'){
  if(kind==='social'){
   const topics=selected.filter(row=>row.id?.startsWith('social:topic:'));
   return [...selected.filter(row=>!row.id?.startsWith('social:topic:')).slice(0,24-topics.length),...topics];
  }
  const visible=selected.slice(0,24),index=kind==='news'&&selected.find(row=>row.id?.startsWith('sentiment:'));
  if(index&&!visible.includes(index))visible[visible.length-1]=index;
  return visible;
 }
 const seen=new Set(),live=selected.filter(row=>!row.fixed).filter(row=>row.kind!=='analysis'||!seen.has(row.symbol)&&seen.add(row.symbol)).filter(row=>!['trade','risk'].includes(row.kind)||row.age==null||row.age<=300);
 return [...live.toSorted((a,b)=>(a.age??Infinity)-(b.age??Infinity)),...selected.filter(row=>row.fixed)].slice(0,32);
}

export function workbenchAgentLog(research,trade,tasks=research.tasks){
 return workbenchInformation(research,trade,{tasks}).filter(row=>['analysis','trade','risk'].includes(row.kind)).map(row=>{
  const group=RESEARCH_GROUPS[research.task(row.symbol)?.group],text=row.text;
  const stage=row.kind!=='analysis'?'execution':/开始采集|新证据|定期检查/.test(text)?'collect':/核验完成/.test(text)?'check':/递交报告/.test(text)?'handoff':'decision';
  const roles=stage==='handoff'||stage==='decision'?[12]:stage==='execution'?[15,16,17]:group?.roles||[];
  const next={collect:['对照行情、消息和资金变化','Compare market, news and flow data'],check:['交给核心比较各组判断','Send to the core for comparison'],handoff:['汇总一致意见与冲突','Compare agreement and conflicts'],decision:['查看当前研究，再按策略条件处理','Review the current research against strategy rules'],execution:['核对当前账户的交易回执','Review receipts for the current account']}[stage];
  return {...row,stage,roles,owner:stage==='execution'?L('执行与记录','Execution & recording'):stage==='handoff'||stage==='decision'?L('协作核心','Coordination core'):t(group?.label||''),result:t(workbenchPlainEvent(text)),next:L(...next)};
 }).sort((a,b)=>(a.age??Infinity)-(b.age??Infinity)||String(b.id).localeCompare(String(a.id),undefined,{numeric:true})).slice(0,40);
}

export function workbenchEvidenceUpdates(previous,tasks,at){
 const initialized=previous.size>0,changes=[],current=new Set();
 const status={collected:['资料已带回','source received'],retain:['资料支持当前判断','supports the current assessment'],context:['纳入背景参考','added as context'],conflict:['发现相反线索','conflicting evidence found'],missing:['仍缺少关键资料','key evidence still missing']};
 for(const task of tasks)for(const item of task.evidence){
  const key=task.symbol+':'+item.key,value=item.id+':'+item.status;current.add(key);
  if(initialized&&previous.has(key)&&previous.get(key)!==value&&status[item.status])changes.push({id:'evidence:'+value,kind:'analysis',symbol:task.symbol,at,route:'research',text:t(item.name)+' · '+L(...status[item.status]),hint:L('Agent 资料交接','Agent source handoff'),source:t(item.source),detail:item.status==='collected'?L('资料已送回，下一步对照其他来源。','The source has returned and will be compared with other evidence.'):t(item.text)});
  previous.set(key,value);
 }
 for(const key of previous.keys())if(!current.has(key))previous.delete(key);
 return changes;
}

export function createWorkbenchInformationDesk({feed,records,research,workspace,onOpen,onFocus,fetchImpl}){
 let filter='all',asset='all',recordFilter='all',paused=false,rows=[],latest=[],trade=null,scope='',initial=true,pending=0,tasks=[],marketData=[],cacheAt=-Infinity;
 const researchReader=typeof research.ingestPublic==='function';let readingSources=false;
 const newsClient=createPublicDataClient({fetchImpl,onChange(resource){
  if(readingSources&&!document.hidden&&document.body.dataset.page==='workbench'&&document.body.dataset.paused!=='true')research.ingestPublic?.(resource,newsClient.read(resource).snapshot);
 }});
 function stopReadingSources(){
  if(!readingSources)return;
  readingSources=false;newsClient.clear();
  for(const resource of ['news','social'])research.ingestPublic?.(resource,null);
 }
 const cache=new WeakMap(),seen=new Set(),animations=new Set(),evidenceState=new Map();let evidenceRows=[],recordIds=null,feedStamp='',recordStamp='',currentMode='';
 const reduced=matchMedia('(prefers-reduced-motion:reduce)');
 function put(node,html){if(cache.get(node)===html&&node.hasChildNodes())return;const restore=captureProductFocus(node);node.innerHTML=html;cache.set(node,html);restore();}
 const receiptTarget=row=>`data-statements="AI_SPECTRUM"${row.runId?` data-statement-run="${esc(row.runId)}"`:''}${row.orderId?` data-statement-order="${esc(row.orderId)}" data-statement-tab="orders"`:''}`;
 const sourceTime=row=>row.fixed?L('参考 · ','Reference · ')+row.at.replace('2026-',''):row.wallTime?workbenchAge(row.at/1000,Date.now()/1000):workbenchAge(row.at,row.clock==='trade'||['trade','risk'].includes(row.kind)?trade?.time:research.time);
 feed.innerHTML='<div class="desk-feed-controls"></div><button class="desk-new-updates" hidden></button><div class="terminal-feed-list" aria-label="市场与研究信息流"></div>';
 records.innerHTML='<div class="desk-record-controls"></div><div class="desk-record-list"></div>';
 const list=feed.querySelector('.terminal-feed-list'),controls=feed.querySelector('.desk-feed-controls'),newButton=feed.querySelector('.desk-new-updates');
 const onscreen=new Set();
 const canPaint=node=>onscreen.has(node)&&!document.hidden&&document.body.dataset.page==='workbench';
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting)onscreen.add(entry.target);else onscreen.delete(entry.target);}if(!researchReader&&!onscreen.has(feed))stopReadingSources();if(['feed','workspace'].includes(currentMode))paintFeed();if(['records','workspace'].includes(currentMode))paintRecords();});
 observer.observe(feed);observer.observe(records);
 window.addEventListener('pagehide',()=>{observer.disconnect();stopReadingSources();stopMotion();});
 function updateTimes(parent,visible,attribute,key){
  const times=new Map(visible.map(row=>[key(row),sourceTime(row)]));
  for(const node of parent.children){const time=node.querySelector('time'),text=times.get(node.dataset[attribute]);if(time&&text!==undefined&&time.textContent!==text)time.textContent=text;}
 }

 function stopMotion(){for(const a of animations)a.cancel();animations.clear();}
 function flash(node,enter=false){
  if(initial||document.hidden||paused||document.body.dataset.paused==='true'||reduced.matches||document.documentElement.dataset.reducedMotion==='true')return;
  const play=(element,frames,options)=>{const a=element?.animate?.(frames,options);if(a){animations.add(a);a.onfinish=a.oncancel=()=>animations.delete(a);}};
  if(enter)play(node,[{opacity:0,transform:'translateY(-4px)'},{opacity:1,transform:'translateY(0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  play(node.querySelector('.desk-feed-summary'),[{opacity:.72},{opacity:1}],{duration:260,easing:'ease-out'});
  play(node.querySelector('.desk-quote'),[{opacity:.45},{opacity:1}],{duration:330});
 }
 reduced.addEventListener('change',()=>{if(reduced.matches)stopMotion();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){stopReadingSources();stopMotion();}});
 function paintFeed(force=false){
  if(!canPaint(feed))return;
  const reading=list.matches(':hover')||list.contains(document.activeElement)||list.scrollTop>8||(feed.closest('.console-scroll')?.scrollTop||0)>8;
  pending=latest.filter(row=>!rows.some(old=>old.id===row.id)).length;
  if(force||!paused&&!reading||initial){rows=latest;pending=0;}
  newButton.hidden=!pending&&!paused;const notice=paused?L(`已暂停 · ${pending} 项更新`, `Paused · ${pending} updates`):L(`${pending} 项更新 · 点击查看`,`${pending} updates · View`);if(newButton.textContent!==notice)newButton.textContent=notice;
  const newsState=newsClient.read(filter==='social'?'social':'news'),newsNotice=['news','social'].includes(filter)&&(newsState.pending||newsState.error)?`<span class="desk-feed-hint" role="status">${newsState.pending?L('正在读取','Loading'):L('来源暂时无法更新','Source update unavailable')}</span>`:'';
  put(controls,`<div class="desk-feed-toolbar"><span class="desk-panel-label">${L('信息流','Market activity')}</span><select data-desk-asset aria-label="${L('信息流资产','Feed asset')}"><option value="all">${L('全部标的','All assets')}</option>${tasks.map(task=>`<option ${asset===task.symbol?'selected':''}>${task.symbol}</option>`).join('')}</select><button data-desk-pause aria-pressed="${paused}" aria-label="${paused?L('继续信息流','Resume feed'):L('暂停信息流','Pause feed')}">${uiGlyph(paused?'play':'pause')}</button></div><div class="desk-filter-bar">${[['all','全部','All'],['market','行情','Markets'],['analysis','研究','Research'],['news','消息','News'],['social','社媒','Social'],['trade','交易','Trades']].map(([id,zh,en])=>`<button data-desk-filter="${id}" aria-pressed="${id===filter}">${L(zh,en)}</button>`).join('')}</div>${newsNotice}`);
  const visible=workbenchFeedSelection(rows,filter,asset),key=row=>row.kind==='market'?'quote:'+row.symbol:row.id,ids=new Set(visible.map(key));
  const stamp=JSON.stringify([document.documentElement.lang,visible.map(({age,...row})=>row)]);
  if(stamp===feedStamp){updateTimes(list,visible,'deskId',key);return;}feedStamp=stamp;
  const nodes=new Map([...list.children].map(node=>[node.dataset.deskId,node]));
  for(const node of [...list.children])if(!ids.has(node.dataset.deskId))node.remove();
  if(visible.length)cache.delete(list);
  let flashes=0;
  visible.forEach((row,index)=>{
   const id=key(row);let node=nodes.get(id),fresh=!node;
   if(!node){node=document.createElement('details');node.className='desk-feed-row';node.dataset.deskId=id;node.dataset.kind=row.kind;node.addEventListener('toggle',()=>{if(node.open&&onFocus?.(node.dataset.deskSymbol,node.dataset.kind)===true)for(const other of list.querySelectorAll('details[open]'))if(other!==node)other.open=false;});node.innerHTML='<summary><span class="desk-feed-summary"></span></summary><div class="desk-feed-detail"></div>';}
   const quote=row.kind==='market',rawChange=quote?(row.wallTime?row.change:(row.price-row.previous)*(row.symbol==='US10Y'?100:100/row.previous)):0,change=Number.isFinite(rawChange)?rawChange:0;
   const rounded=Math.abs(change)<.005?0:change,changeText=(rounded>0?'+':'')+number(rounded)+(row.symbol==='US10Y'&&!row.wallTime?' bp':'%');
   const headline=quote?`<strong class="desk-quote">${number(row.price,row.price<10?4:2)}<small>${esc(row.unit||unitFor(row.symbol))}</small></strong><em data-direction="${rounded<0?'down':rounded>0?'up':'flat'}">${changeText}</em>`:['news','social'].includes(row.kind)&&row.wallTime?esc(row.text):esc(t(workbenchPlainEvent(row.text)));
   const task=research.task(row.symbol),source=row.source|| (row.kind==='analysis'?t(RESEARCH_GROUPS[task?.group||0].label):L('当前账户记录','Current account record'));
   const hint=quote?row.priceBasis==='daily-close'?L('日线收盘 · 涨跌幅','Daily close · change'):row.wallTime?L('24h 变化','24h change'):'':row.hint&&!row.id?.startsWith('evidence:')?t(row.hint):'';
   const valueKey=quote?String(row.price):row.valueKey||row.id,changed=node.dataset.valueKey&&node.dataset.valueKey!==valueKey;
   const sourceURL=['news','social'].includes(row.kind)?safePublicURL(row.url):null,assets=row.symbols?.length?row.symbols:row.symbol?[row.symbol]:[];
   put(node.querySelector('.desk-feed-summary'),`<span class="desk-feed-meta"><span class="desk-kind">${quote&&!row.wallTime?L('示例行情','Sample quote'):row.kind==='analysis'?L('研究','Research'):L(...kinds[row.kind])}</span>${assets.length?`<b>${assets.slice(0,3).map(symbol=>tokenIcon(symbol,{size:22})).join('')}${row.symbol?esc(row.symbol):''}</b>`:''}${sourceURL?`<a href="${esc(sourceURL)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a>`:''}<time></time>${uiGlyph('chevron')}</span><span class="desk-feed-title">${headline}</span>${hint?`<span class="desk-feed-hint">${esc(hint)}</span>`:''}`);
   const explanation=quote?row.wallTime?L('数据中心已读取的行情快照；更新时间保留为来源时间。','The market snapshot read by Data Center, with its original timestamp.'):L('合成行情用于展示变化；不作为真实交易价格。','Synthetic prices illustrate changes and are not executable quotes.'):row.detail?row.kind==='social'&&row.wallTime?row.detail:t(row.detail):row.kind==='analysis'?'':L('执行结果以当前账户的交易记录为准。','Execution outcomes are recorded against the current account.');
   put(node.querySelector('.desk-feed-detail'),`${explanation?`<p${row.detail?' class="desk-source-detail"':''}>${esc(explanation)}</p>`:''}<span>${esc(source)}</span>${row.kind==='analysis'?`<button data-desk-open="${esc(row.symbol)}">${L('查看当前研究','View current research')}${uiGlyph('arrow')}</button>`:row.route==='execution'?`<button type="button" class="desk-record-open" ${receiptTarget(row)} aria-haspopup="dialog">${L(row.orderId?'查看订单':row.runId?'运行记录':'AI 交易记录',row.orderId?'View order':row.runId?'Run history':'LensWave trade history')}${uiGlyph('arrow')}</button>`:`<a href="?page=${row.route}&asset=${encodeURIComponent(row.symbol||'')}">${L(...({signals:['查看信号追踪','Open signal track'],tracking:['查看链上数据','View on-chain data'],social:['查看舆情来源','View social sources'],intelligence:['查看消息来源','View news sources'],markets:['查看市场数据','View market data']}[row.route]||['查看详情','View details']))}${uiGlyph('arrow')}</a>`}`);
   node.dataset.valueKey=valueKey;node.dataset.deskSymbol=row.symbol||'';
   if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);
   if(!row.fixed&&flashes<2&&(fresh&&!seen.has(row.id)||changed)){flash(node,fresh);flashes++;}
   seen.add(row.id);
  });
  if(seen.size>600){seen.clear();for(const row of latest)seen.add(row.id);}
  if(!visible.length)put(list,`<p class="desk-empty">${L('暂无这类动态','No matching activity')}</p>`);
  updateTimes(list,visible,'deskId',key);initial=false;
 }
 function paintRecords(){
  if(!canPaint(records))return;
  put(records.querySelector('.desk-record-controls'),`<div class="desk-filter-bar">${[['all','全部','All'],['collect','采集','Research'],['decision','判断','Decisions'],['execution','执行','Execution']].map(([id,zh,en])=>`<button data-record-filter="${id}" aria-pressed="${recordFilter===id}">${L(zh,en)}</button>`).join('')}</div><div class="desk-record-toolbar"><span class="desk-panel-label">${L('Agent 日志','Agent activity')}</span><button type="button" class="desk-log-link" data-statements="AI_SPECTRUM" aria-haspopup="dialog">${L('交易记录','Trade history')}${uiGlyph('arrow')}</button></div>`);
  const log=workbenchAgentLog(research,trade,tasks),arrivals=new Set(recordIds?log.filter(row=>!recordIds.has(row.id)).map(row=>row.id):[]);
  recordIds=new Set(log.map(row=>row.id));
  const visible=log.filter(row=>recordFilter==='all'||row.stage===recordFilter||recordFilter==='collect'&&row.stage==='check'||recordFilter==='decision'&&row.stage==='handoff');
  const host=records.querySelector('.desk-record-list'),ids=new Set(visible.map(row=>row.id));
  const stamp=JSON.stringify([document.documentElement.lang,visible.map(({age,...row})=>row)]);
  if(stamp===recordStamp){updateTimes(host,visible,'recordId',row=>row.id);return;}recordStamp=stamp;
  const nodes=new Map([...host.children].map(node=>[node.dataset.recordId,node]));
  for(const node of [...host.children])if(!ids.has(node.dataset.recordId))node.remove();
  if(visible.length)cache.delete(host);
  visible.forEach((row,index)=>{
   let node=nodes.get(row.id);if(!node){node=document.createElement('details');node.className='desk-research-record';node.dataset.recordId=row.id;node.innerHTML='<summary></summary><div class="desk-record-body"></div>';}
   node.dataset.stage=row.stage;
   put(node.querySelector('summary'),`<span class="desk-record-asset">${row.symbol?tokenIcon(row.symbol,{size:22})+'<b>'+esc(row.symbol)+'</b>':''}<span class="desk-kind">${L(...({collect:['采集','Collect'],check:['核验','Verify'],handoff:['汇总','Merge'],decision:['判断','Review'],execution:['执行','Execute']}[row.stage]))}</span><time></time>${uiGlyph('chevron')}</span><strong>${esc(row.result)}</strong>`);
   put(node.querySelector('.desk-record-body'),`<span class="desk-record-owner">${esc(row.owner)}</span><dl class="desk-log-facts"><div><dt>${L('接下来','Next')}</dt><dd>${esc(row.next)}</dd></div></dl>${row.stage==='execution'?(row.orderId||row.runId?`<button type="button" class="desk-record-open" ${receiptTarget(row)} aria-haspopup="dialog">${L(row.orderId?'查看订单':'运行记录',row.orderId?'View order':'Run history')}${uiGlyph('arrow')}</button>`:''):`<button class="desk-record-open" data-desk-open="${esc(row.symbol)}">${L('当前研究','Current research')}${uiGlyph('arrow')}</button>`}`);
   if(host.children[index]!==node)host.insertBefore(node,host.children[index]||null);
   if(index<2&&arrivals.has(row.id))flash(node,true);
  });
  if(!visible.length)put(host,`<p class="desk-empty">${L('暂无这类 Agent 记录','No matching Agent activity')}</p>`);
  updateTimes(host,visible,'recordId',row=>row.id);
 }
 feed.addEventListener('change',event=>{if(event.target.matches('[data-desk-asset]')){asset=event.target.value;initial=true;paintFeed(true);}});
 feed.addEventListener('click',event=>{if(event.target.closest('[data-desk-pause]')){paused=!paused;if(paused)stopMotion();paintFeed(!paused);}const button=event.target.closest('[data-desk-filter]');if(button){filter=button.dataset.deskFilter;initial=true;paintFeed(true);}const open=event.target.closest('[data-desk-open]');if(open)onOpen(open.dataset.deskOpen);});
 newButton.onclick=()=>{paused=false;list.scrollTop=0;paintFeed(true);};
 records.addEventListener('click',event=>{const button=event.target.closest('[data-record-filter],[data-desk-open]');if(!button)return;if(button.dataset.recordFilter){recordFilter=button.dataset.recordFilter;paintRecords();}else if(button.dataset.deskOpen)onOpen(button.dataset.deskOpen);});
 return {suspend(){stopReadingSources();stopMotion();},update(nextTrade,mode,nextScope,visibleTasks=research.tasks.filter(task=>research.accepts(task))){
  trade=nextTrade;tasks=visibleTasks;currentMode=mode;
  const key=JSON.stringify([research.scope,nextScope,tasks.map(task=>task.symbol)]);
  if(key!==scope){scope=key;rows=[];seen.clear();evidenceState.clear();evidenceRows=[];initial=true;asset='all';}
  evidenceRows=[...workbenchEvidenceUpdates(evidenceState,tasks,research.time),...evidenceRows].slice(0,24);
  if(document.hidden||document.body.dataset.page!=='workbench'){stopReadingSources();stopMotion();return;}
  const readFeeds=research.mode==='live_readonly'&&tasks.length>0&&document.body.dataset.paused!=='true'&&(researchReader||canPaint(feed)&&['feed','workspace'].includes(mode)&&!paused);
  if(readFeeds)readingSources=true;else stopReadingSources();
  for(const resource of ['news','social']){
   const state=newsClient.read(resource),interval=resource==='news'?300000:120000;
   if(readFeeds&&(resource==='news'||!researchReader||tasks.some(task=>task.domain==='Crypto'))&&!state.pending&&!state.retryIn&&(state.error||state.lastAttempt==null||Date.now()-state.lastAttempt>=interval))newsClient.load(resource,{limit:50});
   if(!readFeeds&&state.pending)newsClient.cancel(resource);
  }
  if(!['feed','records','workspace'].includes(mode)){stopMotion();return;}
  if(Date.now()-cacheAt>15000){cacheAt=Date.now();const client=createMarketHubClient({WebSocketImpl:null});marketData=client.read('tickers').snapshot?.data||client.read('assets').snapshot?.data||[];client.dispose();}
  const socialSnapshot=newsClient.read('social').snapshot;
  latest=[...evidenceRows.map(row=>({...row,age:Math.max(0,research.time-row.at)})),...workbenchInformation(research,trade,{tasks,signals:workspace?.s.signals||[],marketData,newsSnapshot:newsClient.read('news').snapshot,socialSnapshot:socialSnapshot?.coverage.scope==='LUNARCRUSH_KOL_TOPICS'?socialSnapshot:null})].sort((a,b)=>(a.fixed?Infinity:a.age??Infinity)-(b.fixed?Infinity:b.age??Infinity));
  if(mode==='workspace'){paintFeed();paintRecords();}else if(mode==='feed')paintFeed();else paintRecords();
 }};
}
