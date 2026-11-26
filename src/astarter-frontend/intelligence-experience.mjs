import {strategyName} from './strategy-journeys.mjs';
import {uiGlyph,canAutoRefresh} from './product-composition.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {orderMarket,marketTicketError,marketLabel} from './order-markets.mjs';
import {strategyById} from './strategy-catalog.mjs';
import {L} from './execution-views.mjs';
import {INTELLIGENCE} from './product-data.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {sentimentBoard} from './reference-surfaces.mjs';
import {createSignalTracker} from './signal-tracking-view.mjs';
const outcomes={retain:['值得跟踪','Watch closely'],context:['背景参考','Context'],missing:['待核实','Unverified'],conflict:['需注意风险','Risk review']};
const types={chain:['链上活动','On-chain'],trend:['AI 发现','AI discovery'],volatility:['风险变化','Risk change'],macro:['宏观事件','Macro'],social:['社媒舆情','Social']};
const copy={
 'macro-01':['利率决议窗口临近','Rate decision window approaches','利率决议临近，先检查事件可能带来的影响。','Check the event window before adding risk.'],
 'macro-02':['美元与风险资产相关性变化','Dollar / risk-asset correlation shifts','两类资产的关联变化，作为宏观背景观察。','Monitor cross-asset correlation as macro context.'],
 'social-01':['讨论升温，出处仍待确认','Discussion rises; source unverified','热度上升不等于消息真实，先核对原始出处。','Rising attention needs verification at the original source.'],
 'social-02':['去重后，讨论热度回落','Attention cools after deduplication','合并重复传播后，观察剩余讨论的独立性。','Assess independent discussion after removing duplicates.'],
 'chain-01':['地址组出现集中转账','Clustered transfers detected','240 BTC 转出线索；用途与主体尚未确认。','240 BTC transfer fixture; purpose and ownership unconfirmed.'],
 'chain-02':['合约交互频次上升','Contract interactions increase','12 次调用线索，等待核对具体执行类型。','12 call fixtures awaiting execution-type checks.'],
 'ai-01':['资金与价格出现一致性线索','Capital and price signals align','多维条件一致，继续核验风险与执行条件。','Aligned observations still require risk and execution checks.'],
 'ai-02':['波动升高，保护条件待复核','Volatility rises; review protection','先复核保护条件，再考虑增加风险。','Review protection before considering additional risk.']};
const B=(z,en,a)=>`<button class="p-button" ${a}>${L(z,en)}</button>`;
export function intelligenceRows(rows,watched,kind){return rows.length?`<div class="ux-news-list">${rows.map(i=>{const c=copy[i.id];return `<article class="ux-news-item"><time>${i.time}<small>10 / 24</small></time><div class="ux-news-body"><div class="ux-news-meta"><span class="ux-pill">${L(...types[i.source])}</span><b>${i.symbol}</b><span class="ux-pill ${i.decision==='retain'?'good':''}">${L(...outcomes[i.decision])}</span></div><button class="ux-news-title" data-detail="${i.id}">${L(c[0],c[1])} <span>↗</span></button><p>${L(c[2],c[3])}</p><footer><span>${L('本地模拟来源','Local fixture source')} · ${i.id}</span><div>${B(watched.includes(i.id)?'已关注':'关注',watched.includes(i.id)?'Watching':'Watch',`data-watch="${i.id}" aria-pressed="${watched.includes(i.id)}"`)}${B('交给研究组','Investigate',`data-intel="${i.id}"`)}</div></footer></div><div class="ux-news-value"><b>${i.value}</b><span>${L(i.unit,({'分钟':'min','热度':'score','笔':'transfers','指数':'index','项':'items','次':'calls','%':'%'})[i.unit]||i.unit)}</span></div></article>`;}).join('')}</div>`:`<div class="ux-empty">${L('暂无匹配消息，调整关键词或筛选条件。','No matching updates. Adjust your search or filters.')}</div>`;}
export function intelligenceExperience({kind,rows,watched,filter,query}){
 const chain=kind==='tracking',filters=chain?[['全部','全部动态','All updates'],['AI追踪','AI 发现','AI discoveries'],['链上','链上异动','On-chain'],['我的追踪','我的关注','Watchlist']]:[['全部','全部消息','All news'],['宏观','宏观','Macro'],['舆情','社媒','Social']];
 const local=INTELLIGENCE.filter(i=>chain?['chain','trend','volatility'].includes(i.source):['macro','social'].includes(i.source));
 return `<div class="ux-page" data-localized-ui><header class="p-head"><div><h1>${chain?L('AI 与链上追踪','AI & on-chain tracking'):L('新闻舆情','News & sentiment')}</h1><p>${chain?L('从首次发现到风险变化，连续跟踪同一条线索。','Follow a lead from initial discovery through changing risk.'):L('看发生了什么、影响谁，以及哪些信息仍需核实。','See what happened, who it affects and what still needs verification.')}</p></div><div class="p-actions">${B('研究发现','Research discoveries','data-go="opportunities"')}</div></header>
 <div class="ux-feed-brief"><span class="ux-live"></span><b>${L('观察窗口','Observation window')} · 10 / 24</b><span>${local.length} ${L('条线索','leads')}</span><span>${local.filter(i=>['missing','conflict'].includes(i.decision)).length} ${L('项需复核','need review')}</span><small>${L('模拟快照 · 非实时消息','Simulation snapshot · not live news')}</small></div>
 <div class="ux-intelligence-layout"><section><div class="ux-toolbar"><div class="p-segments">${filters.map(([id,z,en])=>`<button class="p-button" data-filter="feed" data-value="${id}" aria-pressed="${filter===id}">${L(z,en)}</button>`).join('')}</div><input id="feed-query" value="${e(query)}" placeholder="${L('搜索资产或消息','Search asset or news')}" aria-label="${L('搜索资产或消息','Search asset or news')}"></div><div id="feed-results">${intelligenceRows(rows,watched,kind)}</div></section><aside><section class="ux-run-panel"><div class="ux-section-title"><h2>${chain?L('重点观察','On the radar'):L('事件日历','Event calendar')}</h2></div>${(chain?local.filter(i=>i.decision==='conflict'||i.decision==='retain'):local.filter(i=>i.source==='macro')).map(i=>`<button class="ux-radar-row" data-detail="${i.id}"><small>${i.time} · ${i.symbol}</small><b>${L(copy[i.id][0],copy[i.id][1])}</b><span>${L(...outcomes[i.decision])} ↗</span></button>`).join('')}</section><section class="ux-run-panel"><h2>${L('我的关注','My watchlist')}</h2>${watched.length?INTELLIGENCE.filter(i=>watched.includes(i.id)).map(i=>`<button class="ux-radar-row" data-detail="${i.id}"><small>${i.symbol}</small><b>${L(copy[i.id][0],copy[i.id][1])}</b></button>`).join(''):`<div class="ux-watch-empty">${L('关注一条线索，后续变化集中在这里查看。','Watch a lead to keep its updates here.')}</div>`}</section></aside></div>${chain?'':sentimentBoard()}</div>`;
}
export function signalsExperience({w,desk,filter='all'}){
 const d=desk.snapshot(),signals=w.s.signals,rows=signals.filter(s=>filter==='all'||s.status===filter),current=d.signal;
 const state=s=>({waiting:L('待确认','Awaiting confirmation'),notified:L('已通知','Notified'),expired:L('已失效 / 跳过','Expired / skipped'),filled:L('已成交','Filled'),submitted:L('已提交','Submitted'),confirmed:L('已确认','Confirmed')})[s]||s;
 return `<div class="ux-page" data-localized-ui><header class="p-head"><div><h1>${L('策略信号','Strategy signals')}</h1><p>${L('信号由运行实例产生，确认、执行与结果沿同一编号追踪。','Signals originate from strategy runs. Follow each through confirmation, execution and outcome.')}</p></div><div class="p-actions">${B('管理策略','Manage strategies','data-biz="go" data-id="my-strategies"')}</div></header><div class="ux-metrics"><div><span>${L('信号总数','Total signals')}</span><strong>${signals.length}</strong></div><div><span>${L('待确认','Awaiting confirmation')}</span><strong>${current&&d.session?.mode==='confirm'?1:0}</strong></div><div><span>${L('本轮模式','Current mode')}</span><strong style="font-size:20px">${d.session?L(...({auto:['自主模拟','Automatic'],confirm:['逐笔确认','Confirm each'],signal:['仅信号','Signals only']}[d.session.mode]||['—','—'])):'—'}</strong></div></div>${current&&d.session?.mode==='confirm'?`<section class="ux-task"><div class="ux-task-mark">↗</div><div><small>${current.id}</small><h2>${d.session.market} · ${current.side==='buy'?L('买入信号','Buy signal'):L('退出信号','Exit signal')}</h2><p>${L('核对后确认，或跳过本次信号。','Review and confirm, or skip this signal.')}</p><div class="p-actions">${B('查看并处理','Review signal','data-biz="go" data-id="execution"')}</div></div></section>`:''}<div class="ux-toolbar"><div class="p-segments">${[['all','全部','All'],['waiting','待处理','Pending'],['notified','仅通知','Notified'],['expired','已失效','Expired']].map(([id,z,en])=>`<button class="p-button" data-biz="signal-filter" data-id="${id}" aria-pressed="${filter===id}">${L(z,en)}</button>`).join('')}</div><span class="ux-pill">SIM-01 · DEMO</span></div><section class="ux-run-panel">${rows.length?`<div class="signal-activity-feed">${rows.map(s=>`<article class="signal-activity-item" data-state="${e(s.status)}"><div class="signal-activity-symbol"><span>${s.status==='filled'?'✓':s.status==='waiting'?'!':'↗'}</span></div><div class="signal-activity-main"><header><b>${e(s.market)}</b><span class="ux-pill">${state(s.status)}</span></header><p>${L(...({auto:['按设置自动处理','Handled automatically'],confirm:['每笔由你确认','You confirm each order'],signal:['发送提醒，不创建订单','Notify without placing an order']}[s.mode]||['—','—']))}</p><small>${e(s.id)} · ${e(s.runId)}</small></div><div class="signal-activity-action">${B('查看记录','View record',`data-biz="signal-record" data-id="${e(s.id)}"`)}<small>${L('触发 → 处理 → 结果','Trigger → Action → Outcome')}</small></div></article>`).join('')}</div>`:`<div class="ux-empty"><h3>${L('等待策略条件触发','Waiting for strategy conditions')}</h3><p>${L('研究发现不会直接变成信号。配置并启动策略后，在这里查看触发与处置。','Research discoveries are not execution signals. Set up a strategy to see triggers and outcomes here.')}</p>${B('配置策略','Set up strategy','data-biz="go" data-id="strategies"')}</div>`}</section></div>`;
}

const signalEnglish={
 '等待结构确认':'Waiting for price confirmation','进入策略候选':'Trend and capital align','分歧 · 暂缓跟进':'Conflicting signals · wait','等待事件落地':'Waiting for the event outcome','待补 · 权重证据':'Concentration data still missing','避险候选 · 待跟踪':'Potential defensive opportunity','共享美元背景':'Dollar context','共享利率背景':'Interest-rate context',
 '结构修复，但流动性尚未同步；保留观察。':'Price structure is improving, but liquidity has yet to follow.',
 '结构与流动性证据一致，链上流入提供旁证。':'Price and liquidity agree; on-chain inflows add supporting context.',
 '舆情热度上升，但大额流动与盘口证据相反。':'Social attention is rising, while large flows and market depth disagree.',
 '板块强弱不一，宏观事件前保留观察。':'Sector performance is mixed. Watch until the macro event passes.',
 '指数走强，但权重集中度证据仍缺失。':'The index is rising, but concentration evidence is missing.',
 '避险需求与利率背景形成交叉支持。':'Defensive demand and interest-rate context support the same view.',
 '美元变化作为加密、权益与黄金的共同风险背景。':'Dollar moves inform the shared risk view for crypto, equities and gold.',
 '利率变化用于压力情景，不直接推导资产涨跌。':'Rate moves inform stress scenarios, not a standalone price forecast.',
 '等待价格结构与盘口同时确认。':'Wait for both price structure and market depth to confirm.',
 '可交给操作台，核对额度与保护条件后模拟。':'Review the amount and exit conditions, then place a simulated order.',
 '补查流动归因，未消除分歧前不进入执行。':'Investigate the flows. Do not enter while the evidence conflicts.',
 '对照事件结果与板块广度，暂不形成执行任务。':'Compare the event outcome with market breadth before taking action.',
 '补齐权重及广度样例后重新核验。':'Add concentration and breadth data before reassessing.',
 '跟踪美元与实际利率；当前没有 TradFi 执行适配。':'Track the dollar and real yields. TradFi execution is unavailable.',
 '共享给相关组，不单独形成交易信号。':'Share with related teams; this is not a standalone trade signal.',
 '同步给权益与避险组，检查事件窗口。':'Share with equity and defensive teams to review the event window.',
 '行情结构':'Price structure','流动性':'Liquidity','宏观':'Macro','舆情':'Sentiment','链上':'On-chain','风险':'Risk',
 '回踩结构与中周期方向一致':'The pullback agrees with the medium-term trend.',
 '双边深度恢复，价差处于示例阈值内':'Depth has recovered; the spread is within the demo threshold.',
 '利率背景纳入压力情景':'Interest rates are included in the stress scenario.',
 '生态讨论有多来源交叉印证':'Independent sources corroborate ecosystem activity.',
 '资金流入获另一数据切片旁证':'A second data slice supports the inflow observation.',
 '示例风险条件齐备，仍需执行侧额度检查':'Demo risk checks pass. Account limits are checked before entry.',
 '区间上沿尚未形成有效确认':'The range high is not yet confirmed.',
 '盘口支撑存在，但厚度未持续增加':'Book support exists, but depth is not consistently improving.',
 '利率事件临近，降低方向性权重':'The approaching rate event reduces directional confidence.',
 '讨论升温，独立来源不足':'Discussion is growing; independent sources are limited.',
 '大额转账仅作旁证，不等同于卖出':'Large transfers provide context, not proof of selling.',
 '等待结构确认；限制组合相关性敞口':'Wait for confirmation and limit correlated positions.',
 '短周期走强，中周期尚未确认':'Short-term strength lacks medium-term confirmation.',
 '薄盘口放大冲击，存在反向证据':'Thin depth increases price impact and conflicts with the signal.',
 '高波动资产对宏观冲击更敏感':'Volatile assets are more sensitive to macro shocks.',
 '热度集中，不能作为独立交易信号':'Concentrated attention cannot justify a trade on its own.',
 '转入交易所样例与买盘支持相冲突':'The exchange-inflow fixture conflicts with buying support.',
 '分歧未解，禁止模拟新单':'Conflicting evidence blocks a new simulated entry.',
 '指数结构修复，板块广度尚未同步':'Index structure improves, but market breadth lags.',
 '使用指数成交代理，不伪装成交易盘口':'Index volume proxy; no exchange order book is implied.',
 '等待经济事件确认':'Waiting for the economic event outcome.',
 '新闻情绪偏正面，作为旁证':'Positive news sentiment provides supporting context.',
 '事件风险未落地，维持观察':'Event risk remains unresolved; keep watching.',
 '上涨集中于少数权重股':'Gains are concentrated in a few large constituents.',
 '指数成交代理仅作旁证':'Index volume proxy is supporting context only.',
 '利率上行情景影响估值':'Higher-rate scenarios affect valuations.',
 '新闻集中于科技板块':'Coverage is concentrated in technology.',
 '缺少集中度核验记录，暂不放行':'Missing concentration checks block an entry.',
 '回撤后结构保持':'Structure holds after the pullback.',
 '使用黄金报价代理观察流动性':'A gold-quote proxy informs liquidity analysis.',
 '利率与避险需求形成交叉支持':'Rates and defensive demand support the view.',
 '避险叙事保留为旁证':'The defensive narrative is supporting context only.',
 '保留方向候选，等待执行市场适配':'Keep the candidate; this execution market is not supported.',
 '美元区间变化已归入跨资产背景':'Dollar-range changes are shared cross-asset context.',
 '指数代理仅作观察':'The index proxy is observation only.',
 '美元方向与利率预期对照':'Compare dollar direction with rate expectations.',
 '宏观新闻交叉核对':'Cross-check macro coverage.',
 '背景证据不能单独放行策略':'Context cannot authorize a strategy on its own.',
 '收益率走势用于情景比较':'Yield trends are used to compare scenarios.',
 '不以收益率伪造可交易盘口':'Yields are not represented as a tradable order book.',
 '事件窗口与利率预期对照':'Compare the event window with rate expectations.',
 '宏观消息核对发布时间':'Check macro news publication times.',
 '仅作背景，不单独生成执行任务':'Context only; no execution task is generated.'
};
const signalText=value=>L(value,signalEnglish[value]||value);
// Market discovery is independent of execution signals emitted by an active run.
export function marketSignalRows(research){
 const primary={BTC:'strategy',ETH:'onchain',SOL:'social',SPX:'macro',NDX:'strategy',XAU:'macro',DXY:'macro',US10Y:'macro'};
 const rows=research.tasks.filter(t=>research.accepts(t)).map(t=>({id:t.symbol,task:t,source:primary[t.symbol]||'strategy',strategy:'S03',title:t.title}));
 for(const symbol of ['ETH','SOL']){const task=research.task(symbol);if(task&&research.accepts(task))rows.push({id:'wallet-'+symbol,task,source:'money',strategy:'S03',title:symbol==='ETH'?'观察钱包 A 增持 ETH':'观察钱包 B 增加 SOL 风险'});}
 return rows.sort((a,b)=>Number(b.task.phase==='complete'&&b.task.outcome==='candidate')-Number(a.task.phase==='complete'&&a.task.outcome==='candidate'));
}
const ticketMessage=value=>value?.includes(' / ')?L(...value.split(' / ')):value;
export function refreshedSignalTicket(ticket,context,now){
 if(!context?.ready||context.market!==ticket.market||!context.revision||!Number.isFinite(context.price)||context.price<=0||!Number.isFinite(now))return null;
 return {...ticket,sourceId:context.revision,revision:context.revision,quotePrice:context.price,quotedAt:now,walletAuthorized:false,authorizationKey:'',researchUnavailable:false};
}
export function ticketConfigError(ticket,price,w){return ticketMessage(marketTicketError(ticket,price,{cap:w.s.risk.cap,dailyLoss:w.s.risk.dailyLoss,market:ticket.market||'ETH/USDT',wallet:false}));}
export function createAISignals({w,desk,research,root,refresh,go,notify,onResearchStart,onStrategy=()=>go('strategies')}){
 let source='all',filter='all',query='',selected='ETH',opener=null,feedView='personal',signalSequence=research.sequence,signalRevision=null,lastSignalPaint=0;
 const dialog=document.createElement('dialog');dialog.className='as-ticket';dialog.setAttribute('data-localized-ui','');dialog.setAttribute('aria-labelledby','as-ticket-title');document.body.append(dialog);
 const sourceNames={strategy:['策略条件','Strategy'],onchain:['链上异动','On-chain'],money:['聪明钱动向','Smart money'],macro:['宏观事件','Macro'],social:['舆情变化','Sentiment']};
 const money=(v,d=2)=>Number(v||0).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
 const action=(z,en,a,id='',primary=false,disabled=false)=>`<button type="button" class="p-button ${primary?'p-primary':''}" data-as-action="${a}" data-id="${e(id)}" ${disabled?'disabled':''}>${L(z,en)}</button>`;
 const ready=t=>t.phase==='complete'&&t.outcome==='candidate'&&t.domain==='Crypto';
 const status=t=>t.phase!=='complete'?L('评估中','Assessing'):L(...({candidate:['可继续评估','Candidate'],watch:['继续观察','Watching'],conflict:['暂缓操作','Conflicting'],missing:['等待补充','Missing data'],context:['市场背景','Context']}[t.outcome]||['观察','Watch']));
 const close=()=>{dialog.close();opener?.focus?.();};
 const tracker=createSignalTracker({w,research,readSnapshot:()=>desk.readSnapshot?.()||desk.snapshot?.()||{},notify,localizeResearch:signalText,root,refresh,onBrowse:()=>{feedView='all';refresh();},onManageWatch:()=>go('watchlist'),onStrategy,onRelatedLink:(href,onReturn)=>{window.dispatchEvent(new CustomEvent('hive:related-data',{detail:{href,onReturn}}));return true;}});
 signalRevision=tracker.revision();
 const feedNav=()=>`<header class="sig-page-header"><h1>${L('AI 信号','AI signals')}<small class="sig-mobile-label">${L('模拟','DEMO')}</small></h1><nav aria-label="${L('信号视图','Signal views')}">${[['personal','为你精选','For you'],['all','全市场','All markets'],['watch','我的追踪','My watchlist']].map(([id,z,en])=>`<button type="button" data-as-view="${id}" aria-pressed="${feedView===id}">${L(z,en)}${id==='watch'?` <span class="sig-watch-count">${tracker.watchCount()}</span>`:''}</button>`).join('')}</nav><div>${action('我的交易','My trades','go','execution')}</div></header>`;
 dialog.addEventListener('cancel',ev=>{ev.preventDefault();close();});dialog.addEventListener('click',ev=>{if(ev.target===dialog)close();});
 function render(){
  if(feedView!=='research')return tracker.render({nav:feedNav(),myWatch:feedView==='watch',view:feedView});
  const all=marketSignalRows(research),rows=all.filter(r=>(source==='all'||r.source===source)&&(filter==='all'||filter==='ready'&&ready(r.task)||filter==='watch'&&(w.s.aiSignalWatch||[]).includes(r.id))&&`${r.task.symbol} ${r.title}`.toLowerCase().includes(query.toLowerCase()));
  const picked=rows.find(r=>r.id===selected)||rows[0],working=research.summary().working,eligible=all.filter(r=>ready(r.task)).length;
  return `<div class="as-page" data-localized-ui>${feedNav()}<div class="as-scan-strip"><span><i></i>${working?L('小组正在采集','Teams collecting'):L('持续观察市场','Watching markets')}</span><span><b>${research.summary().total}</b> ${L('市场','markets')}</span><span><b>${eligible}</b> ${L('可评估线索','candidate leads')}</span><span><b>${w.s.aiSignalWatch?.length||0}</b> ${L('已关注','watched')}</span><details class="as-info"><summary aria-label="${L('关于 AI 评估','About AI assessments')}">i</summary><p>${L('这里展示本地模拟扫描和预设分析。聪明钱动向是独立样例，不是地址实绩；转账也不等于买卖。真实行情、链上与模型 API 尚未接入。','Local scan and rule-based analysis fixtures. Wallet activity is illustrative, not a real track record; transfers do not prove trades. Live data and model APIs are not connected.')}</p></details></div><div class="as-toolbar"><div class="as-filters">${[['all','全部信号','All'],...Object.entries(sourceNames).map(([k,v])=>[k,...v])].map(([id,z,en])=>`<button data-as-source="${id}" aria-pressed="${source===id}">${L(z,en)}</button>`).join('')}</div><label class="as-search">${uiGlyph('search')}<input aria-label="${L('搜索信号','Search signals')}" id="as-query" placeholder="${L('搜索资产或机会','Search asset or opportunity')}" value="${e(query)}"></label></div><div class="as-workspace"><section class="as-feed"><div class="as-feed-heading"><b>${rows.length} ${L('条市场线索','market leads')}</b><select aria-label="${L('信号状态','Signal status')}" id="as-filter"><option value="all" ${filter==='all'?'selected':''}>${L('全部状态','All states')}</option><option value="ready" ${filter==='ready'?'selected':''}>${L('可供策略评估','Ready for strategy review')}</option><option value="watch" ${filter==='watch'?'selected':''}>${L('我的关注','Watchlist')}</option></select></div>${rows.length?rows.map(r=>signalCard(r,picked?.id===r.id)).join(''):`<div class="as-empty"><h2>${L('这里还没有信号','No signals here yet')}</h2><p>${L('切换分类，或调整搜索条件。','Change the category or search.')}</p>${action('查看全部','Show all','reset')}</div>`}</section><aside class="as-assessment">${picked?assessment(picked):''}</aside></div></div>`;
 }
 function signalCard(r,on){const t=r.task,watched=(w.s.aiSignalWatch||[]).includes(r.id),dimensions=t.evidence.filter(e=>e.status==='retain').length;return `<article class="as-signal ${on?'selected':''}" data-tone="${ready(t)?'ready':t.outcome==='conflict'?'risk':'watch'}"><button class="as-select" data-as-action="select" data-id="${r.id}" aria-label="${L('评估','Assess')} ${t.symbol} ${e(r.title)}"><div class="as-card-top"><span class="as-asset">${tokenIcon(t.symbol,{size:26})}</span><div><strong>${t.symbol}</strong><small>${L(...sourceNames[r.source])} · ${t.domain}</small></div><span class="as-state">${status(t)}</span></div><h2>${r.source==='money'?L(r.title,t.symbol==='ETH'?'Watch wallet A adding ETH':'Watch wallet B increasing SOL risk'):e(signalText(t.title))}</h2><p>${r.source==='money'?L('地址样例与市场证据一起看，不直接照着买。','Read the wallet fixture alongside market evidence before acting.'):e(signalText(t.thesis))}</p><footer><span>${t.phase==='complete'?`${dimensions} ${L('项支持','supporting factors')}`:`${t.progress}% ${L('已汇总','reviewed')}`}</span><span>${L('查看 AI 评估','AI assessment')} →</span></footer></button><button class="as-star" data-as-action="watch" data-id="${r.id}" aria-label="${watched?L('取消关注','Unwatch'):L('关注','Watch')} ${t.symbol}" aria-pressed="${watched}">${watched?'★':'☆'}</button></article>`;}
 function assessment(r){const t=r.task,ev=t.evidence.filter(x=>x.status!=='na'),can=ready(t),title=can?L('线索一致，等待策略条件确认','Evidence aligns; strategy checks come next.'):t.outcome==='conflict'?L('信号打架，先别急','Evidence conflicts. Wait for clarity.'):t.phase!=='complete'?L('先把证据拼完整','Putting the evidence together'):L('先看，不急着操作','Watch before acting');return `<div class="as-ai-title"><span class="as-pet" aria-hidden="true"><i></i><i></i></span><div><b>${L('AI 评估','AI assessment')}</b><small>${t.symbol} · ${L('规则模拟','Rule-based demo')}</small></div><span class="as-assess-badge">${t.phase==='complete'?'✓':'…'}</span></div><h2>${title}</h2><p class="as-thesis">${e(signalText(t.thesis))}</p>${r.source==='money'?`<div class="as-wallet"><span>◈</span><div><b>${L('观察钱包','Watch wallet')} ${t.symbol==='ETH'?'A':'B'} · ${t.symbol==='ETH'?'EVM':'Solana'}</b><p>${L('增持事件样例 · 无真实地址归属与收益记录','Accumulation fixture · no real ownership or return claims')}</p></div></div>`:''}<div class="as-next"><b>${L('下一步','Next step')}</b><p>${e(signalText(t.next))}</p>${can?`<div class="as-assessment-actions">${action('查看当前行情','View current market','market',t.symbol,true)}</div>`:action('查看当前行情','View current market','market',t.symbol)}${t.domain!=='Crypto'?`<small>${L('TradFi 当前仅观察，尚未接入交易。','TradFi is observation only; execution is not connected.')}</small>`:''}</div><div class="as-evidence">${ev.map(x=>`<div><i class="${x.status}">${x.status==='retain'?'✓':x.status==='conflict'?'!':x.status==='missing'?'?':'·'}</i><span><b>${e(signalText(x.name))}</b><small>${e(signalText(x.summary||x.text||L('等待采集','Collecting')))}</small></span></div>`).join('')}</div><div class="as-strategy-match"><span>${L('使用策略','Strategy in use')}</span><b>${t.domain==='Crypto'?e(strategyName(strategyById(w.draft()?.strategy)||strategyById('S03'))):L('仅观察','Observation only')}</b><small>${L('配置只决定执行规则。Agent 会重新检查最新证据、账户和金额，再决定是否交易。','Setup defines your rules. The Agent rechecks evidence, account access and limits before deciding whether to trade.')}</small></div>`;}
 async function handle(a,id){
  if(a==='close'){close();return;}if(a==='go'){close();go(id);return;}
  if(a==='select'){selected=id;refresh();if(matchMedia('(max-width:760px)').matches)root.querySelector('.as-assessment')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});return;}
  if(a==='watch'){const issue=await w.toggleTracked(id);if(issue)notify(issue,{tone:'error'});refresh();return;}
  if(a==='reset'){source='all';filter='all';query='';refresh();return;}
  if(a==='market'){window.dispatchEvent(new CustomEvent('hive:related-data',{detail:{href:'?page=markets&asset='+encodeURIComponent(id)}}));return;}

 }
 dialog.addEventListener('click',ev=>{const button=ev.target.closest('[data-as-action]');if(button)handle(button.dataset.asAction,button.dataset.id);});
 function bind(container=root){tracker.bind(container);container.querySelectorAll('[data-as-view]').forEach(b=>b.onclick=()=>{if(b.dataset.asView==='all'&&!tracker.clearTargetScope())return;feedView=b.dataset.asView;refresh();});container.querySelectorAll('[data-as-action]').forEach(b=>b.onclick=()=>handle(b.dataset.asAction,b.dataset.id));container.querySelectorAll('[data-as-source]').forEach(b=>b.onclick=()=>{source=b.dataset.asSource;refresh();});const q=container.querySelector('#as-query');if(q)q.oninput=()=>{query=q.value;const pos=q.selectionStart;refresh();const next=root.querySelector('#as-query');next?.focus();next?.setSelectionRange(pos,pos);};const f=container.querySelector('#as-filter');if(f)f.onchange=()=>{filter=f.value;refresh();};}
 function protection({compact=false}={}){const d=desk.readSnapshot();if(!d?.session?.singleShot||!d.pending&&!d.position)return '';const s=d.session,t=s.ticket,instrument=d.position?.displayMarket||d.pending?.displayMarket||d.orders.find(o=>o.runId===s.id)?.displayMarket||s.market;return `<section class="as-protection ${compact?'as-protection-inline':''}" data-localized-ui><div><span class="as-demo">${t.origin==='manual'?L('手动交易 · 单笔模拟','Manual trade · one-shot demo'):L('AI 信号 · 单笔模拟','AI signal · one-shot demo')}</span><h2>${compact?L('退出条件','Exit conditions'):d.pending?L('订单正在处理','Order processing'):d.position?(t.exitAttempted?L('退出尚未完成，请查看订单','Exit incomplete. Review the order.'):L('持仓已建立，退出条件在观察','Position open; monitoring exits')):L('本次单笔交易已结束','This one-shot trade has ended')}</h2><p>${e(signalText(t.title))} · ${e(instrument)} · ${marketLabel(orderMarket(t))} · ${t.direction==='short'?L('做空','Short'):L('做多 / 买入','Long / buy')}</p></div><div class="as-protection-prices"><span>${L('止盈价','Take profit')}<b>${money(t.takeProfit)}</b></span><span>${L('止损价','Stop loss')}<b>${money(t.stopLoss)}</b></span></div></section>`;}
 return {render,bind,protection,openSource:tracker.openSource,sourceSnapshot:()=>tracker.sourceSnapshot(),review(symbol){if(!tracker.select(symbol))return false;feedView='all';return true;},tick(){
  if(!root.querySelector?.('.sig-tracking')||root.querySelector('details[open]')||document.querySelector('dialog[open]')||!canAutoRefresh(root))return;
  const at=Date.now();if(at-lastSignalPaint<tracker.refreshSeconds*1000)return;
  const revision=tracker.revision();lastSignalPaint=at;if(research.sequence===signalSequence&&revision===signalRevision)return;
  signalSequence=research.sequence;signalRevision=revision;const y=root.scrollTop;refresh();root.scrollTop=y;
 }};
}
