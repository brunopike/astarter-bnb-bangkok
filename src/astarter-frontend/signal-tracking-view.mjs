import {routeSearch,routeHref} from './site-routes.mjs';
import {BRAIN_PAGE_NAME,brainEntrySearch} from './product-data.mjs';
import {TRACKING_CASES,TRACKING_SOURCES,TRACKING_STAGES,TRACKING_GUIDANCE,trackingReview,trackingRows,TRACKING_CUTOFF,signalPreferences,filterSignalPreferences,signalStrategy,publicRunSignals,trackingRecord,signalExcerpt,signalCandleIdentity,signalReferenceKey,signalReferencePlan,signalReferenceFor,loadSignalReferencePlan,signalQuote} from './signal-tracking.mjs';
import {liveSignalRow,liveSignalCard,liveSignalDetail,liveSignalExcerpt,liveSignalCopyText} from './live-signal-view.mjs';
import {TOKEN_IDS} from './brand-icon-data.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {chartPanel,mountCharts} from './product-chart-ui.mjs';
import {tradingChartPanel} from './trading-chart.mjs';
import {HUB_ASSET_IDS} from './market-hub-data.mjs';
import {sameWatchAssetKey} from './market-watchlist.mjs';
import {uiGlyph,bindSearchRender,canAutoRefresh,captureProductFocus} from './product-composition.mjs';
import {escapeUI as esc} from './product-experience.mjs';
import {L} from './execution-views.mjs';
import {getLocale,localeInfo} from './locale.mjs';
import {sparkline} from './product-charts.mjs';
import {HUB_REFRESH_SECONDS,parseHubRefreshSeconds} from './market-hub-data.mjs';
import {CONNECTION_OPTIONS} from './connection-options.mjs?v=20261120c';
import {formatSimulationTime as simClock} from './product-help.mjs';
import {readWorkbenchTargets,matchesWorkbenchTarget,renderWorkbenchTargets,bindWorkbenchTargets,setWorkbenchTargets} from './workbench-targets.mjs';

const number=n=>!Number.isFinite(n)?'—':n.toLocaleString('en-US',n!==0&&Math.abs(n)<.01?{maximumSignificantDigits:10}:{maximumFractionDigits:Math.abs(n)<10?4:2});
let statsModule,statsLoadAttempt=0;
function loadStats(){
 if(!statsModule){
  const url=new URL('./signal-ui/advanced-stats.js',import.meta.url);
  // A failed module URL can remain in the browser's module map until navigation.
  if(statsLoadAttempt)url.searchParams.set('retry',String(statsLoadAttempt));
  statsModule=import(url.href).catch(error=>{statsModule=null;statsLoadAttempt++;throw error;});
 }
 return statsModule;
}
const historicalRows=trackingRows(TRACKING_CASES,{latestOnly:true});
// These labels identify fixed examples distinctly from runtime records in every supported locale.
const feedLabels={
 zh:{runs:'运行信号',all:'全部来源（含样例）',examples:'历史示例',archive:n=>`查看 ${n} 条历史样例`,empty:'暂无运行信号',hint:'AI 自主或 BOT 运行产生信号后，会显示在这里。',refresh:'列表按所选间隔读取已有运行记录。',charts:'信号图表暂时无法加载。',retry:'重试图表'},
 en:{runs:'Run signals',all:'All origins (including examples)',examples:'Example archive',archive:n=>`View ${n} historical example${n===1?'':'s'}`,empty:'No run signals yet',hint:'Signals from autonomous AI and bot runs appear here.',refresh:'The list checks existing run records at this interval.',charts:'Signal charts are temporarily unavailable.',retry:'Retry charts'},
 ja:{runs:'実行シグナル',all:'すべてのソース（サンプルを含む）',examples:'過去のサンプル',archive:n=>`過去のサンプルを${n}件見る`,empty:'実行シグナルはまだありません',hint:'自律型AIやBOTが生成したシグナルがここに表示されます。',refresh:'設定した間隔で実行記録を確認します。',charts:'現在、シグナルのチャートを読み込めません。',retry:'チャートを再読み込み'},
 ko:{runs:'실행 신호',all:'모든 출처(예시 포함)',examples:'과거 예시',archive:n=>`과거 예시 ${n}개 보기`,empty:'아직 실행 신호가 없습니다',hint:'자율 AI 또는 봇 실행에서 생성된 신호가 여기에 표시됩니다.',refresh:'선택한 간격으로 실행 기록을 확인합니다.',charts:'지금은 신호 차트를 불러올 수 없습니다.',retry:'차트 다시 시도'},
 vi:{runs:'Tín hiệu từ phiên chạy',all:'Tất cả nguồn (gồm ví dụ)',examples:'Ví dụ lịch sử',archive:n=>`Xem ${n} ví dụ lịch sử`,empty:'Chưa có tín hiệu từ phiên chạy',hint:'Tín hiệu do AI tự động hoặc bot tạo sẽ xuất hiện ở đây.',refresh:'Danh sách kiểm tra các phiên chạy theo khoảng thời gian đã chọn.',charts:'Tạm thời không thể tải biểu đồ tín hiệu.',retry:'Tải lại biểu đồ'},
 es:{runs:'Señales de ejecución',all:'Todos los orígenes (incluye ejemplos)',examples:'Ejemplos históricos',archive:n=>n===1?'Ver 1 ejemplo histórico':`Ver ${n} ejemplos históricos`,empty:'Aún no hay señales de ejecución',hint:'Aquí aparecerán las señales generadas por la IA autónoma o los bots.',refresh:'La lista consulta las ejecuciones con el intervalo seleccionado.',charts:'Los gráficos de señales no están disponibles en este momento.',retry:'Reintentar gráficos'},
 fr:{runs:'Signaux d’exécution',all:'Toutes les sources (exemples inclus)',examples:'Exemples historiques',archive:n=>n===1?'Voir 1 exemple historique':`Voir ${n} exemples historiques`,empty:'Aucun signal d’exécution pour le moment',hint:'Les signaux générés par l’IA autonome ou les bots apparaîtront ici.',refresh:'La liste vérifie les exécutions à l’intervalle choisi.',charts:'Les graphiques des signaux sont temporairement indisponibles.',retry:'Recharger les graphiques'},
 ru:{runs:'Сигналы запусков',all:'Все источники (включая примеры)',examples:'Архив примеров',archive:n=>`Посмотреть примеры из архива (${n})`,empty:'Пока нет сигналов запусков',hint:'Здесь появятся сигналы, созданные автономным ИИ или ботами.',refresh:'Список проверяет записи запусков с выбранным интервалом.',charts:'Графики сигналов временно недоступны.',retry:'Загрузить графики снова'}
};

const unitText=row=>{const unit=signalQuote(row).priceUnit;return unit?L(unit,({'点':'pts','USD/盎司':'USD/oz'})[unit]||unit):L('单位待确认','Unit unknown');};
const priceLabel=row=>{
 const quote=signalQuote(row);
 if(row.record&&quote.market&&quote.market!==row.record.instrument?.market)return L(`信号记录价格 · ${quote.market}`,`Signal record price · ${quote.market}`);
 return quote.priceUnit==='点'?L('信号记录点位','Recorded level'):quote.priceUnit==='%'?L('信号记录值','Recorded value'):L('信号记录价格','Signal record price');
};
const price=(row,n)=>`${number(n)} <small>${esc(unitText(row))}</small>`;
function quoteFacts(row){
 const q=signalQuote(row),facts=[[L('价格单位','Price unit'),unitText(row)]];
 if(q.market)facts.unshift([L('报价交易对','Quoted pair'),q.market]);
 if(row.record?.instrument?.market&&row.record.instrument.market!==q.market)facts.push([L('交易标的','Trading instrument'),row.record.instrument.market]);
 if(q.quoteAsset)facts.push([L('报价币','Quote asset'),q.quoteAsset]);
 if(q.measurementUnit)facts.push([L('计量单位','Measurement unit'),L(q.measurementUnit,q.measurementUnit==='点'?'points':q.measurementUnit==='盎司'?'oz':q.measurementUnit)]);
 return facts;
}
const signedPercent=value=>!Number.isFinite(value)?'—':value!==0&&Math.abs(value)<.01?`${value>0?'+':'-'}<0.01%`:`${value>0?'+':''}${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}%`;
const source=c=>c.record?(c.record.sourceType==='bot'?'AI BOT':L('AI 自主','Autonomous AI')):L(...TRACKING_SOURCES[c.source]);
const icon=c=>tokenIcon(c.id,{size:30,className:'sig-coin'});
const marketLink=(c,label)=>`<a data-track-link data-dc-link href="?page=markets&asset=${c.id}">${label}</a>`;
const preferenceOptions={scope:[['all','全市场','All markets'],['crypto','加密资产','Crypto'],['tradfi','传统市场','Traditional markets']],focus:[['all','全部信息','All information'],...Object.entries(TRACKING_SOURCES).map(([id,label])=>[id,...label])],strategy:[['all','全部策略','All strategies'],['S00','多周期结构 · S00','Multi-timeframe · S00'],['RX03-S','链上成交 · RX03-S','On-chain flow · RX03-S'],['S03','EMA / RSI · S03','EMA / RSI · S03']]};
const choice=(type,value)=>preferenceOptions[type].map(([id,z,en])=>`<option value="${id}" ${value===id?'selected':''}>${L(z,en)}</option>`).join('');
function connectionLabel(){
 try{const c=JSON.parse(localStorage.getItem('hive-demo.connections.v1')||'null');if(c?.data===false)return L('研究数据未启用','Research data disabled');if(c?.preferences?.data?.source==='custom'){const ids=Array.isArray(c.preferences.data.services)?c.preferences.data.services:[],names=ids.map(id=>CONNECTION_OPTIONS.data.find(item=>item.id===id)?.name).filter(Boolean);return `${L('自带 API 配置','Your API settings')}${names.length?' · '+names.join(' / '):''} · ${L('演示','demo')}`;}}catch{}
 return L('Astarter 数据配置 · 演示','Astarter data settings · demo');
}
function refreshInterval(){try{return parseHubRefreshSeconds(localStorage.getItem('hive.market.refreshSeconds')||60);}catch{return 60;}}

function signalPlanPresentation(row){
 const p=signalReferenceFor(row);
 return {p,state:L(...({ready:['回看计算','Retrospective calculation'],'not-triggered':['条件未满足','Conditions not met'],'needs-bars':['待核行情','Market check pending'],loading:['正在核算','Calculating'],error:['行情暂不可用','Market unavailable']}[p.status]||['待补依据','Evidence pending'])),entry:p.rules?L(...p.rules.entry):'',exit:p.rules?L(...p.rules.exit):''};
}
export function signalActionGuidance(row){
 const r=trackingRecord(row),p=signalReferenceFor(row);
 const code=r.stage==='confirmed-fill'?'fill':r.stage==='submitted'?'order':!row.record&&row.stage==='closed'?'closed':r.validity==='expired'?'expired':p.status==='loading'?'loading':p.status==='error'?'error':p.status==='ready'?'ready':p.status==='not-triggered'?'unmet':!row.record&&row.stage==='risk'?'risk':r.direction==='sell'?'sell':'missing';
 const copy={
  fill:[['已有成交记录','Fill recorded'],['核对成交与保护','Review fills and protection'],['按原订单编号核对成交数量及剩余订单，再复核止损和退出设置。成交记录不表示仓位已全部建立或结束。','Check filled quantity and remaining orders under the original order ID, then review stops and exits. A fill does not establish a complete entry or exit.']],
  order:[['已记录下单尝试','Order attempt recorded'],['核对订单状态','Check order status'],['先核对原订单是否被接受、部分成交或撤销；状态未明确前避免重复提交。','Check whether the original order was accepted, partially filled or cancelled before submitting another order.']],
  closed:[['本轮观察已结束','This observation has ended'],['等待新信号','Wait for a new signal'],['旧观察不再作为新开仓依据。如已持仓，按原策略核对止损和退出条件；观察结束不表示已经平仓。','Do not use the ended observation for a new entry. If already holding, review the original stop and exit rules; an ended observation does not mean the position is closed.']],
  expired:[['原信号已过有效期','The original signal has expired'],['重新核验条件','Recheck conditions'],['先重新核验当前行情和策略触发条件。原记录的参考点位不直接作为新开仓价格。','Recheck current market data and strategy triggers. The recorded reference levels are not a new entry quote.']],
  loading:[['正在核算原时点条件','Checking original-time conditions'],['等待核算完成','Wait for the calculation'],['先等待本次核算完成，再查看条件检查与参考点位。','Wait for this calculation, then review its condition checks and reference levels.']],
  error:[['行情请求未完成','Market request failed'],['重试核算','Retry calculation'],['使用卡内“重试核算”重新获取本次所需行情。','Use Retry calculation in this card to request the required market data again.']],
  ready:[['回看价格条件满足','Retrospective price checks pass'],['复核当前条件','Recheck current conditions'],['下方点位按原信号时点计算。考虑新开仓前，仍需用同一交易对和策略版本重新核验当前条件。','The levels below are calculated at the original signal time. Before considering a new entry, recheck current conditions for the same pair and strategy version.']],
  unmet:[['原时点入场条件未全部满足','Original-time entry checks do not all pass'],['等待条件确认','Wait for confirmation'],['先看未通过的条件，等待同一策略重新形成有效信号；暂不据此设置新的入场、止损或止盈价。','Review the failed checks and wait for a valid signal under the same strategy before setting new entry, stop or target levels.']],
  risk:[['观察证据转弱','Observation evidence has weakened'],['复核风险变化','Review the changed risk'],['先核对价格、成交与相关证据的分歧，待策略条件和适用市场明确后再评估新交易。如已持仓，复核原有保护条件。','Resolve differences in price, trading activity and supporting evidence, then confirm strategy conditions and the applicable market before evaluating a new trade. If holding, review existing protection.']],
  sell:[['原记录为卖出方向','The recorded direction is sell'],['核对卖出依据','Review the sell rationale'],['先核对原策略的卖出条件和可用持仓；仅凭卖出方向不能判断这是平仓还是建立空头。','Check the original sell conditions and available holdings. Sell direction alone does not establish whether this closes a position or opens a short.']],
  missing:[['交易依据尚未核齐','Trading evidence is incomplete'],['补齐策略依据','Complete the strategy evidence'],['先确认交易对、策略版本与所缺证据，再核验触发和退出条件。资料未齐时不推算交易点位。','Confirm the pair, strategy version and missing evidence, then check triggers and exits. Do not infer trade levels from incomplete inputs.']]
 }[code];
 return {code,judgment:L(...copy[0]),label:L(...copy[1]),detail:L(...copy[2])};
}
function referenceReport(row,money){
 const {p,state,entry,exit}=signalPlanPresentation(row),guidance=signalActionGuidance(row),facts=[[L('核算状态','Calculation status'),state],[L('当前判断','Assessment'),guidance.judgment],[L('操作参考','Action guidance'),guidance.detail]];
 if(p.strategy)facts.push([L('参考策略','Strategy'),p.strategy],[L('原策略版本','Recorded strategy version'),p.version||L('未提供','Not provided')],[L('当前库版本','Current library version'),p.libraryVersion||L('未提供','Not provided')],[L('变体','Variant'),p.variant||L('未提供','Not provided')]);
 if(p.rules)facts.push([L('观察周期','Timeframe'),p.rules.timeframe],[L('入场条件','Entry condition'),entry],[L('退出条件','Exit condition'),exit],[L('止损规则','Stop rule'),p.rules.stop],[L('止盈规则','Target rule'),p.rules.target||L('无固定止盈，按退出条件处理','No fixed target; follow the exit conditions')]);
 if(p.levels)facts.unshift([L('参考入场','Reference entry'),money(p.levels.entry)],[L('参考止损','Reference stop'),money(p.levels.stopLoss)],[L('止盈建议','Take-profit guidance'),p.levels.takeProfit===null?L('条件退出','Conditional exit'):money(p.levels.takeProfit)]);
 const paragraphs=p.reasons.map(reason=>L(...reason));
 if(p.provenance==='retrospective'){
  paragraphs.unshift(L('按原信号时点回看计算，不代表当时已接收行情、已触发或可执行。','Recalculated at the original signal time; this does not establish contemporaneous receipt, triggering or executability.'));
  for(const [label,value]of [[L('信号时点','Signal as of'),p.asOf],[L('收盘截止','Closed through'),p.evidence.closedAt],[L('本次取数','Retrieved at'),p.receivedAt],[L('本次计算','Calculated at'),p.calculatedAt]])facts.push([label,new Date(value).toISOString()]);
  facts.push([L('原时点可得时间','Originally available at'),L('未知','Unknown')],[L('指标方法','Indicator method'),p.evidence.methodVersion],[L('K 线依据','Candle evidence'),`${p.evidence.source} · ${p.evidence.period} · ${p.evidence.bars}`],[L('ATR 14','ATR 14'),money(p.evidence.metrics.atr)],[L('RSI 14 · 0–100','RSI 14 · 0–100'),number(p.evidence.metrics.rsi)]);
  for(const check of p.evidence.checks)facts.push([L(check.zh,check.en),check.value?L('满足','Pass'):L('未满足','Not met')]);
 }
 return {title:L('交易参考','Trade reference'),facts,paragraphs};
}
const recordState=r=>(r.validity==='expired'?L('已过期','Expired')+' · ':'')+(r.stage==='confirmed-fill'?L('已确认成交','Confirmed fill'):r.stage==='submitted'?L('下单尝试','Order attempt'):L('分析判断','Analysis'));
const signalClockSuffix=row=>row.record?.clockKind==='simulation'?(row.record.observedAt===null?'SIM':''):row.record?'UTC':'UTC+8';
function signalReportTime(record,value=record.observedAt){
 if(value===null||value===undefined)return L('未提供','Not provided');
 if(record.clockKind==='historical')return String(value).replace('T',' ');
 if(!Number.isFinite(value))return L('未提供','Not provided');
 if(record.clockKind==='simulation')return simClock(value);
 const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString().replace('T',' ').replace('Z',' UTC'):L('未提供','Not provided');
}
function signalReportContent(row){
 const c=row.track,r=trackingRecord(row),view=signalPlanPresentation(row),review=r.review,guide=row.record?null:TRACKING_GUIDANCE[c.source],missing=L('未提供','Not provided');
 const unit=unitText(row),money=value=>Number.isFinite(value)?(value!==0&&Math.abs(value)<1e-6?value.toLocaleString('en-US',{maximumSignificantDigits:10}):number(value))+' '+unit:missing;
 const stage=row.record?recordState(r):L(...TRACKING_STAGES[row.stage]),title=c.title?L(...c.title):r.direction==='buy'?L('买入判断','Buy assessment'):r.direction==='sell'?L('卖出判断','Sell assessment'):L('等待条件','Waiting for conditions');
 const sections=[{title:L('信号解读','Signal analysis'),paragraphs:[row.record?r.condition||missing:L(...c.thesis)]}];
 sections.push(referenceReport(row,money));
 if(review)sections.push({title:L('追踪脉络','Tracking path'),facts:[[L('观察记录','Observation history'),String(review.observations)],[L('较首次记录','From first record'),signedPercent(review.changePercent)],[L('最近一段','Latest interval'),signedPercent(review.latestChangePercent)],[L('距本轮高点','From tracking high'),signedPercent(review.drawdownFromPeakPercent)]],paragraphs:[review.from+' → '+review.asOf,L('价格变化，非交易收益','Price changes, not trading returns')]});
 if(guide)sections.push({title:L('继续核验','Verify next'),paragraphs:guide.checks.map(item=>L(...item))});
 sections.push({title:L('风险与失效','Risk and invalidation'),paragraphs:guide?[L(...guide.risk),r.invalidation||L('本记录未提供数值失效条件。','No numeric invalidation rule was recorded.')]:[r.invalidation||missing]});
 const instrument=r.instrument||{},identity=[[L('来源','Source'),r.sourceId],[L('信号','Signal'),r.signalId],[L('版本','Version'),r.version]];
 for(const [label,value]of [[L('运行','Run'),r.runId],[L('交易所','Exchange'),instrument.venue],[L('市场类型','Market type'),instrument.marketType],[L('市场分类','Market category'),instrument.profileId],[L('链 ID','Chain ID'),instrument.chainId]])if(value!==null&&value!==undefined&&value!=='')identity.push([label,String(value)]);
 const validity=L(...({active:['有效期内','Within validity'],expired:['已过期','Expired'],historical:['历史记录','Historical record']}[r.validity]||['未提供','Not provided']));
 const facts=[[L('信号阶段','Signal stage'),stage],[L('时间','Time'),signalReportTime(r)],[L('有效期','Validity'),validity+(r.validUntil!==null&&r.validUntil!==undefined?' · '+signalReportTime(r,r.validUntil):'')],...quoteFacts(row)];
 if(r.strategy&&!view)facts.push([L('参考策略','Strategy'),r.strategy]);
 const history=(c.events||[]).slice(0,review?.observations||0).map(event=>[event.date+' '+event.time+' UTC+8',L(...TRACKING_STAGES[event.stage]),money(event.price),L(...event.reason)]);
 return {symbol:instrument.symbol||c.id,title,source:source(c),priceLabel:priceLabel(row),price:money(r.price),facts,sections,identity,history,values:review?.path?.map(event=>event.price)||[]};
}
export function signalCopyText(row){
 if(row.live)return liveSignalCopyText(row);
 const report=signalReportContent(row),lines=[report.symbol+' · '+L('AI 信号','AI signal'),report.title,report.source,report.priceLabel+': '+report.price,...report.facts.map(([label,value])=>label+': '+value)];
 for(const section of report.sections)lines.push('',section.title,...section.paragraphs||[],...(section.facts||[]).map(([label,value])=>label+': '+value));
 lines.push('',L('数据来源','Data source'),...report.identity.map(([label,value])=>label+': '+value));return lines.join('\n');
}
export function signalReportHTML(row){
 const report=signalReportContent(row),facts=rows=>`<dl>${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
 const chart=report.values.length>1?`<figure role="img" aria-label="${esc(signalQuote(row).priceUnit==='点'?L('记录点位走势','Recorded level history'):L('记录价格走势','Recorded price history'))}"><div aria-hidden="true">${sparkline(report.values,{width:720,height:130,color:'#00667d',fill:true})}</div><figcaption><span>${esc(report.history[0]?.[0])}</span><span>${esc(report.history.at(-1)?.[0])}</span></figcaption></figure>`:'';
 return `<!doctype html><html lang="${esc(localeInfo(getLocale()).tag)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(report.symbol)} · ${esc(L('信号报告','Signal report'))} · Astarter</title><style>
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#f3f4f5;color:#15171b;font:14px/1.65 -apple-system,BlinkMacSystemFont,Inter,'Noto Sans SC','Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}article{overflow-wrap:anywhere;max-width:860px;margin:32px auto;padding:36px 40px;background:#fff;border:1px solid #15171b26;border-radius:14px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#48505b;font-size:12px;padding-bottom:20px;border-bottom:1px solid #15171b26}header strong{color:#15171b;font-size:16px;letter-spacing:.12em}h1{margin:24px 0 4px;font-size:28px;line-height:1.3;font-weight:600}h1 span{font-size:14px;color:#48505b;font-weight:400}.title{margin:8px 0 4px;font-size:20px;font-weight:500;line-height:1.5}.source{margin:0;color:#48505b}.quote{margin:24px 0 18px;padding-left:16px;border-left:3px solid #00667d}.quote span{display:block;color:#48505b;font-size:12px}.quote strong{font-size:32px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums}h2{font-size:16px;margin:0 0 12px;font-weight:600;break-after:avoid}section{border-top:1px solid #15171b26;padding-top:20px;margin-top:20px}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}dl{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px}dl div{min-width:0;break-inside:avoid}dt{font-size:12px;color:#48505b}dd{margin:4px 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}figure{margin:20px 0}figure svg{width:100%;height:auto}figcaption{display:flex;justify-content:space-between;gap:16px;font-size:11px;color:#48505b}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #15171b26;padding:10px 8px 10px 0;overflow-wrap:anywhere}th{color:#48505b;font-weight:500}th:first-child{width:24%}th:nth-child(2){width:15%}th:nth-child(3){width:20%}tr{break-inside:avoid}footer{border-top:1px solid #15171b26;margin-top:24px;padding-top:18px}footer dl{grid-template-columns:repeat(3,minmax(0,1fr));font-size:12px}footer dt{font-size:11px}@media(max-width:600px){article{margin:0;padding:24px 20px;border:0;border-radius:0}h1{font-size:24px}.title{font-size:18px}dl{grid-template-columns:minmax(0,1fr);gap:12px}footer dl{grid-template-columns:repeat(2,minmax(0,1fr))}table{font-size:11px}th:first-child{width:28%}th:nth-child(2),th:nth-child(3){width:22%}figcaption{flex-wrap:wrap}}@page{size:A4 portrait;margin:14mm}@media print{body{background:white;color:#111;font-size:11pt}article{max-width:none;margin:0;padding:0;border:0;border-radius:0}section{margin-top:16px;padding-top:14px}header{padding-bottom:14px}.quote{margin:18px 0}h1{margin-top:18px}a{color:inherit;text-decoration:none}}
</style></head><body><article><header><strong>ASTARTER</strong><span>${esc(L('信号报告','Signal report'))}</span></header><h1>${esc(report.symbol)}</h1><p class="title">${esc(report.title)}</p><p class="source">${esc(report.source)}</p><div class="quote"><span>${esc(report.priceLabel)}</span><strong>${esc(report.price)}</strong></div>${facts(report.facts)}${chart}${report.sections.map(section=>`<section><h2>${esc(section.title)}</h2>${(section.paragraphs||[]).map(text=>`<p>${esc(text)}</p>`).join('')}${section.facts?facts(section.facts):''}</section>`).join('')}${report.history.length?`<section><h2>${esc(L('观察记录','Observation history'))}</h2><table><thead><tr>${[L('时间','Time'),L('状态','Status'),signalQuote(row).priceUnit==='点'?L('点位','Level'):L('价格','Price'),L('原因','Reason')].map(label=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${report.history.map(event=>`<tr>${event.map(value=>`<td>${esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`:''}<footer><h2>${esc(L('数据来源','Data source'))}</h2>${facts(report.identity)}</footer></article></body></html>`;
}

export function signalHistoryPreview(row){
 const events=row.track.events;if(events.length<2)return '';
 return `<figure class="sig-card-spark"><figcaption><span>${L('记录走势','Recorded path')}</span><span>${esc(events[0].time)} — ${esc(events.at(-1).time)}</span></figcaption></figure>`;
}

export function signalStatsData(row){
 const c=row.track,r=trackingRecord(row),history=c.events.filter(event=>Number.isFinite(event.price)).map(event=>({time:event.time,price:event.price,priceText:number(event.price)})),strategy=row.record?row.record.strategy:signalStrategy(c),missing=L('未提供','Not provided');
 const unit=unitText(row);
 return {history,unit,unitDescription:priceLabel(row)+' · '+quoteFacts(row).map(([label,value])=>label+': '+value).join(' · '),price:Number.isFinite(row.price)?row.price:null,priceText:number(row.price),condition:row.record?r.condition||'':L(...c.thesis),change:r.review?.changePercent,changeText:signedPercent(r.review?.changePercent),stage:row.record?(r.stage==='confirmed-fill'?L('已确认成交','Confirmed fill'):r.stage==='submitted'?L('下单尝试','Order attempt'):L('分析判断','Analysis')):L(...TRACKING_STAGES[row.stage]),source:source(c),domain:c.asset.domain,validityInState:r.validity==='expired',validity:L(...({active:['有效期内','Within validity'],expired:['已过期','Expired'],historical:['历史记录','Historical record']}[r.validity]||['未提供','Not provided'])),
  labels:{summary:L('信号数据概览','Signal data overview'),price:priceLabel(row),unavailable:missing,noEvidence:L('判断依据未提供','Assessment evidence not provided'),path:L('记录走势','Recorded path'),keyboard:L('左右方向键查看记录','Use left and right arrows to explore'),change:L('较首次记录','From first record'),priceChange:L('价格变化，非交易收益','Price changes, not trading returns'),stage:L('信号阶段','Signal stage'),validity:L('有效期','Validity'),historical:L('历史观察记录','Historical observations')},
  kpis:row.record?[{label:L('运行','Run'),value:r.runId||missing},{label:L('信号','Signal'),value:r.signalId||missing}]:[{label:signalQuote(row).priceUnit==='点'?L('首次记录点位','First recorded level'):L('首次记录价格','First record price'),value:history.length?number(history[0].price):missing,unit,numeric:history.length>0},{label:L('观察记录','Observation history'),value:String(history.length),numeric:true},{label:strategy?L('对照策略','Library reference'):L('策略','Strategy'),value:strategy||L('未关联策略','No linked strategy')}]};
}

const marketFeedCopy={
 zh:['行情信号','正在分析最新行情','最新行情暂不可用','有了近期已收盘 K 线后会自动更新。','重新获取行情','加密资产有新分钟收盘才重算。选 120 或 300 秒时按该间隔读取。跨市场每 15 分钟核对最近交易日收盘。','行情待更新'],
 en:['Market signals','Analyzing market data','Current market data unavailable','Analysis resumes when recent closed candles are available.','Retry market data','Crypto analysis changes with a new closed minute. The 120- and 300-second settings check less often. Other markets check their latest daily close every 15 minutes.','Awaiting data'],
 ja:['市場シグナル','最新の相場を分析中','最新の相場を取得できません','直近の確定足を取得すると自動で更新します。','相場を再取得','暗号資産は1分足の確定後に更新します。120秒・300秒を選んだ場合はその間隔で取得します。その他の市場は15分ごとに直近の日足終値を確認します。','データ待ち'],
 ko:['시장 신호','최신 시세 분석 중','최신 시세를 불러올 수 없습니다','최근 마감 봉을 받으면 자동으로 갱신됩니다.','시세 다시 받기','암호화폐는 새 1분 봉이 마감된 뒤 갱신됩니다. 120초 또는 300초를 선택하면 해당 간격으로 조회합니다. 다른 시장은 15분마다 최근 일봉 종가를 확인합니다.','갱신 대기'],
 vi:['Tín hiệu thị trường','Đang phân tích thị trường','Chưa có dữ liệu thị trường mới','Phân tích tự cập nhật khi có nến đã đóng gần đây.','Tải lại dữ liệu','Tiền mã hóa cập nhật khi nến phút đóng. Nếu chọn 120 hoặc 300 giây, dữ liệu được kiểm tra theo chu kỳ đó. Các thị trường khác kiểm tra giá đóng cửa ngày gần nhất mỗi 15 phút.','Chờ dữ liệu'],
 es:['Señales de mercado','Analizando el mercado','Datos de mercado no disponibles','El análisis se actualiza cuando hay velas cerradas recientes.','Reintentar','Las señales cripto cambian con cada vela de un minuto cerrada. Con 120 o 300 segundos se consulta con menor frecuencia. Los demás mercados comprueban el último cierre diario cada 15 minutos.','Pendiente de actualización'],
 fr:['Signaux de marché','Analyse du marché en cours','Données de marché indisponibles','L’analyse reprend dès que des bougies clôturées récentes sont disponibles.','Réessayer','Les signaux crypto évoluent à la clôture des bougies d’une minute. Les réglages de 120 ou 300 secondes espacent les lectures. La dernière clôture des autres marchés est vérifiée toutes les 15 minutes.','Données en attente'],
 ru:['Рыночные сигналы','Анализируем рынок','Свежие рыночные данные недоступны','Анализ обновится при получении свежих закрытых свечей.','Повторить запрос','Сигналы по криптовалютам обновляются после закрытия минутной свечи. При выборе 120 или 300 секунд проверки идут реже. Для других рынков последнее дневное закрытие проверяется каждые 15 минут.','Ожидание данных']
};
export function createSignalTracker({w,research,createLiveFeed,loadReference=loadSignalReferencePlan,loadCardStats=loadStats,localizeResearch=text=>text,root,refresh,notify=()=>{},onBrowse,onManageWatch,onStrategy=()=>{},onRelatedLink=()=>false,readSnapshot=()=>({})}){
 const defaultOrigin=createLiveFeed?'live':'runtime';
 let kind='all',origin=defaultOrigin,validity='all',query='',page=1,selected='',mode='personal',dispose=()=>{},pendingOpen=false,prefError=false,sourceView=null,readerOrigin=null;
 let disposeStats=()=>{},statsRevision=0,statsFailed=false,lastSignalRoute;
 const statsRecords=new Map(),referencePlans=new Map(),referenceTasks=new Map();
 const targetSelection=()=>readWorkbenchTargets(w,research),targetSignature=()=>{const s=targetSelection();return JSON.stringify([s.filter,s.focusAsset,s.tasks.map(task=>task.symbol)]);};
 let targetsRevision=targetSignature(),scopePagePinned=false,disposeTargets=()=>{};
 const targetsChanged=()=>{const next=targetSignature();if(next===targetsRevision)return;targetsRevision=next;page=1;scopePagePinned=true;refresh();};
 const clearTargetScope=()=>{const issue=research||w.research?setWorkbenchTargets(w,research||w.research,{filter:'all',focusAsset:null}):null;if(issue){notify(issue,{tone:'error'});return false;}return true;};
 const withReference=row=>row.live?row:({...row,referencePlan:referencePlans.get(signalReferenceKey(row))||signalReferencePlan(row)});
 const stopReferences=container=>{for(const [host,controller]of referenceTasks)if(!host.isConnected||container?.contains?.(host)){controller.abort();referenceTasks.delete(host);}};
 const prefKey='hive.ai-signal.preferences.v1';
 const size=15,dialog=document.createElement('dialog');dialog.className='sig-track-dialog';dialog.setAttribute('data-localized-ui','');dialog.setAttribute('aria-labelledby','sig-dialog-title');document.body.append(dialog);
 let readerLiveSymbol='',readerLiveRevision='';
 const dismiss=()=>{readerOrigin=null;readerLiveSymbol='';readerLiveRevision='';if(!dialog.open)return;stopReferences(dialog);sourceView=null;dispose();dispose=()=>{};dialog.close();};
 let linkedLiveAsset=null,routeLiveAsset=null,routeSignalId=null,followFirstLive=true,paintTimer=null,paintedRevision='',requestedSymbols='',liveOwner=false;
 const liveFeed=createLiveFeed?.({onChange:scheduleLivePaint});
 const wantsLive=()=>Boolean(liveFeed)&&(origin==='live'||origin==='all');
 const liveRows=()=>liveFeed?.snapshot().rows.map(liveSignalRow).filter(Boolean)||[];
 function observationRevision(row){
  return [row.symbol,row.closedAt,row.price,row.direction,row.momentumPct,row.ema20,row.rsi14,row.volumeRatio,row.freshness,row.refreshFailed];
 }
 function liveRevision(){
  if(!wantsLive())return '';
  const {rows,loading,failed}=liveFeed.snapshot();
  return JSON.stringify([rows.map(observationRevision),failed.map(item=>item.symbol),!rows.length&&loading]);
 }
 function refreshLiveReader(){
  const body=dialog.querySelector('.sig-dialog-body');
  if(!readerLiveSymbol||!body||document.getSelection?.()?.toString())return;
  const row=liveRows().find(item=>item.symbol===readerLiveSymbol);
  const revision=row?JSON.stringify(observationRevision(row.live)):'unavailable';
  if(revision===readerLiveRevision)return;
  const restore=captureProductFocus(body),scroll=dialog.scrollTop,bodyScroll=body.scrollTop,expanded=body.querySelector('.sig-live-exact')?.open;
  readerLiveRevision=revision;
  if(row){
   body.innerHTML=detail(row,true);
   const exact=body.querySelector('.sig-live-exact');if(expanded&&exact)exact.open=true;
  }else{
   const copy=marketFeedCopy[getLocale()]||marketFeedCopy.en;
   body.innerHTML='<div class="sig-empty"><h2 id="sig-dialog-title">'+esc(readerLiveSymbol)+'</h2><p role="status">'+esc(copy[2])+'</p><button type="button" class="p-button" data-track-live-retry>'+esc(copy[4])+'</button></div>';
  }
  bind(body);restore();dialog.scrollTop=scroll;body.scrollTop=bodyScroll;
 }
 function scheduleLivePaint(){
  if(paintTimer!==null||!liveOwner||document.hidden||!wantsLive())return;
  paintTimer=setTimeout(()=>{
   paintTimer=null;
   if(!liveOwner||document.hidden||document.body.dataset?.page!=='signals'||!wantsLive()||!root.querySelector('.sig-tracking'))return;
   if(dialog.open){refreshLiveReader();return;}
   if(paintedRevision===liveRevision()||!canAutoRefresh(root))return;
   const scroll=root.scrollTop;refresh();root.scrollTop=scroll;
  },90);
 }
 function syncLiveFeed(){
  if(!liveFeed)return;
  const active=liveOwner&&document.body.dataset?.page==='signals'&&!document.hidden&&wantsLive();
  if(active){
   const symbols=watchKeys().map(key=>typeof key==='string'&&key.startsWith('coin:')?TOKEN_IDS[key.slice(5)]:key).filter(Boolean);
   if(routeLiveAsset)symbols.push(routeLiveAsset);
   const priority=routeLiveAsset||targetSelection().focusAsset;
   const key=JSON.stringify([symbols,priority]);
   if(key!==requestedSymbols){requestedSymbols=key;liveFeed.setSymbols(symbols,priority);}
   liveFeed.setRefreshSeconds(refreshInterval());
  }
  liveFeed.setActive(active);
 }
 function stopLiveFeed(){
  liveOwner=false;clearTimeout(paintTimer);paintTimer=null;liveFeed?.setActive(false);
 }
 document.addEventListener?.('hive:page-leave',event=>{if(event.detail==='signals'){stopLiveFeed();lastSignalRoute=undefined;linkedLiveAsset=null;routeLiveAsset=null;routeSignalId=null;
   if(liveFeed){origin=defaultOrigin;selected='';pendingOpen=false;followFirstLive=true;page=1;}}dismiss();});
 if(liveFeed){
  document.addEventListener?.('visibilitychange',()=>{syncLiveFeed();scheduleLivePaint();});
  root.addEventListener?.('focusout',scheduleLivePaint);
  globalThis.window?.addEventListener('pagehide',stopLiveFeed);
  globalThis.window?.addEventListener('pageshow',()=>{liveOwner=document.body.dataset?.page==='signals';syncLiveFeed();scheduleLivePaint();});
 }
 function originButton(origin){
  if(!origin)return null;
  const card=`[data-track-record="${origin.id}"]`;
  return (origin.read&&root.querySelector(card+' [data-track-read]'))||root.querySelector(card+' .sig-event-title');
 }
 const close=(returnToCard=true)=>{
  if(!dialog.open)return;
  const y=root.scrollTop,context=sourceView,origin=readerOrigin;dismiss();
  if(context){if(returnToCard)context.onReturn?.();return;}
  refresh();root.scrollTop=y;
  const original=originButton(origin);
  const target=original||root.querySelector('[data-track-record][aria-current="true"] .sig-event-title')||root.querySelector('.sig-event-title')||root.querySelector('.sig-empty button')||root.querySelector('#sig-search');
  target?.focus({preventScroll:true});if(!original)target?.scrollIntoView?.({block:'nearest',behavior:'instant'});
 };
 const closePanels=except=>{for(const panel of root.querySelectorAll('.sig-filter-panel[open],.sig-preferences[open]'))if(panel!==except)panel.open=false;};
 document.addEventListener?.('click',event=>closePanels(event.target.closest?.('.sig-filter-panel,.sig-preferences')));
 document.addEventListener?.('keydown',event=>{if(event.key!=='Escape')return;const panel=root.querySelector('.sig-filter-panel[open],.sig-preferences[open]');if(panel){event.preventDefault();closePanels();panel.querySelector('summary')?.focus();}});
 dialog.addEventListener('cancel',ev=>{ev.preventDefault();close();});dialog.addEventListener('click',ev=>{if(ev.target===dialog)close();});
 const watchKeys=()=>Array.isArray(w.s.aiSignalWatch)?w.s.aiSignalWatch:[];
 const watched=()=>[...new Set([...TRACKING_CASES.map(row=>row.id),...recordRows().map(row=>row.symbol),...liveRows().map(row=>row.symbol)])].filter(symbol=>watchKeys().some(key=>sameWatchAssetKey(key,symbol)));
 const prefs=()=>{try{const saved=localStorage.getItem(prefKey);if(saved!==null){const value=signalPreferences(JSON.parse(saved));w.s.aiSignalPreferences=value;return value;}}catch{}return signalPreferences(w.s.aiSignalPreferences);};
 const savePrefs=value=>{w.s.aiSignalPreferences=signalPreferences(value);try{localStorage.setItem(prefKey,JSON.stringify(w.s.aiSignalPreferences));prefError=false;}catch{prefError=true;}w.touch();};
 try{if(localStorage.getItem(prefKey)!==null)prefs();}catch{}
 if(typeof window!=='undefined'){
  const syncInterval=()=>{syncLiveFeed();const select=root.querySelector('[data-sig-interval]');if(select)select.value=String(refreshInterval());};
  window.addEventListener('hive:market-refresh-interval',syncInterval);
  window.addEventListener('hive:signal-source',({detail})=>{
   if(document.body.dataset?.page!=='signals'||typeof detail?.id!=='string')return;
   if(origin!=='all'&&historicalRows.some(row=>row.id===detail.id))origin='historical';
   else if(origin!=='all'&&recordRows().some(row=>row.id===detail.id))origin='runtime';
   else if(origin!=='all'&&liveRows().some(row=>row.id===detail.id))origin='live';
   open(detail.id);
   const title=[...root.querySelectorAll('[data-track-record]')].find(card=>card.dataset.trackRecord===detail.id)?.querySelector('.sig-event-title');
   if(dialog.open)title?.scrollIntoView({block:'nearest'});else title?.focus();
  });
  window.addEventListener('storage',event=>{if(event.key==='hive.market.refreshSeconds')syncInterval();if(event.key===prefKey){try{w.s.aiSignalPreferences=signalPreferences(JSON.parse(event.newValue||'{}'));}catch{w.s.aiSignalPreferences=signalPreferences();}}});
 }
 const recordRows=()=>publicRunSignals(w.s.signals||[],readSnapshot()).map(record=>{
   const symbol=record.instrument.symbol,base=TRACKING_CASES.find(c=>c.id===symbol)?.asset;
   const labels=record.direction==='buy'?['买入判断','Buy assessment']:record.direction==='sell'?['卖出判断','Sell assessment']:['等待条件','Waiting for conditions'];
   const time=record.clockKind==='simulation'?(record.observedAt===null?'—':simClock(record.observedAt)):record.observedAt===null?'—':new Date(record.observedAt).toISOString().slice(11,16);
   const track={id:symbol,asset:{symbol,name:base?.name||symbol,domain:base?.domain||'Crypto',unit:record.instrument.market.split('/')[1]},source:'market',title:labels,thesis:[record.sourceType==='bot'?'BOT 运行判断':'AI 自主判断',record.sourceType==='bot'?'BOT run assessment':'Autonomous AI assessment'],events:[],record};
   return {id:[record.sourceId,record.version,record.runId,record.signalId].join(':'),symbol,track,record,price:record.price,time,date:record.clockKind==='wall'&&record.observedAt!==null?new Date(record.observedAt).toISOString().slice(0,10):'',minute:record.observedAt??0};
  });
 const sourceRow=ref=>{
  if(ref?.type!=='signal'||typeof ref.revision!=='string')return null;
  return recordRows().map(withReference).find(row=>row.id===ref.recordId&&row.record.sourceId===ref.sourceId&&row.record.signalId===ref.signalId&&row.record.runId===ref.runId&&row.record.version===ref.revision&&row.symbol===ref.asset)||null;
 };
 function rowsInScope(){
  const selection=targetSelection(),watch=mode==='watch'?watched():null;
  const rows=[...(wantsLive()?liveRows():[]),...recordRows(),...historicalRows].filter(row=>(kind==='all'||row.track.source===kind)&&(!watch||watch.includes(row.symbol))&&matchesWorkbenchTarget(row.symbol,selection));
  return mode==='personal'?filterSignalPreferences(rows,prefs()):rows;
 }
 function filteredRows(candidates,sourceFilter=origin,validityFilter=validity){
  let rows=candidates.filter(row=>(sourceFilter==='all'||(sourceFilter==='runtime'?Boolean(row.record):sourceFilter===(row.live?'live':row.record?.sourceType||'historical')))&&(validityFilter==='all'||validityFilter===(row.live?'active':row.record?.validity||'historical')));
  const q=query.trim().toLowerCase(),symbol=rows.find(row=>row.symbol.toLowerCase()===q)?.symbol;
  if(q)rows=rows.filter(({track:c,live})=>symbol?c.id===symbol:[c.id,c.asset.name,...c.title,...c.thesis,...TRACKING_SOURCES[c.source],live?live.source:c.record?c.record.strategy:signalStrategy(c)].join(' ').toLowerCase().includes(q));
  return rows.sort((a,b)=>Number(!!b.live)-Number(!!a.live)||Number(!!b.record)-Number(!!a.record)||b.minute-a.minute);
 }
 const allRows=(candidates=rowsInScope())=>filteredRows(candidates).map(withReference);
 function selectExample(symbol,keepSelectionFilters=false){
  const row=historicalRows.find(item=>item.symbol===symbol);if(!row)return false;
  if(!keepSelectionFilters||selected!==row.id){kind='all';origin='historical';validity='all';query='';}
  selected=row.id;scopePagePinned=false;page=1;pendingOpen=true;return true;
 }
 function applySignalRoute(){
  const params=new URLSearchParams(routeSearch());
  if(params.get('page')!=='signals')return;
  const data=params.get('data'),asset=params.get('asset')?.toUpperCase(),signalId=params.get('signalId'),route=JSON.stringify([data,asset,signalId]);
  if(route===lastSignalRoute)return;
  const wasLinked=lastSignalRoute!==undefined;lastSignalRoute=route;
  routeLiveAsset=liveFeed&&asset&&data!=='demo'?asset:null;linkedLiveAsset=routeLiveAsset;
  routeSignalId=routeLiveAsset&&signalId?.startsWith(routeLiveAsset+':')?signalId:null;
  if(asset&&(data==='demo'||!liveFeed&&data!=='live')&&selectExample(asset,wasLinked))return;
  if(data==='demo'||data==='live'||linkedLiveAsset||wasLinked){
   kind='all';origin=data==='demo'?'historical':defaultOrigin;validity='all';query='';selected='';page=1;pendingOpen=false;
  }
 }
 function changeList(){if(!allRows().some(row=>row.id===selected))selected='';page=1;refresh();}
 function plan(c,ev){
  const {p,state}=signalPlanPresentation(ev),guidance=signalActionGuidance(ev),report=referenceReport(ev,n=>number(n)+' '+(p.levels?.unit||unitText(ev)));
  const levels=p.levels?`<dl class="sig-plan-levels">${report.facts.slice(0,3).map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`:'';
  return `<section class="sig-plan"><div class="sig-plan-heading"><h3>${report.title}</h3><span role="status">${state}</span></div>${p.strategy?`<div class="sig-plan-strategy"><b>${esc(p.strategy)}</b><span>${esc(p.version||L('原版本未登记','Original version unrecorded'))}${p.variant?' · '+esc(p.variant):''}</span></div>`:''}${levels}<div class="sig-plan-advice"><b>${esc(guidance.label)}</b><p>${esc(guidance.detail)}</p></div>${report.paragraphs.map(text=>`<p class="sig-plan-note">${esc(text)}</p>`).join('')}${p.status==='error'||p.retrying?`<div class="sig-plan-actions"><button type="button" class="p-button" data-track-reference-retry ${p.status==='loading'?'disabled aria-busy="true"':''}>${p.status==='loading'?L('正在核算','Calculating'):L('重试核算','Retry calculation')}</button></div>`:''}${p.rules?`<div class="sig-plan-rules"><p><b>${L('入场条件','Entry')}</b><span>${esc(L(...p.rules.entry))}</span></p><p><b>${L('退出条件','Exit')}</b><span>${esc(L(...p.rules.exit))}</span></p></div><details class="sig-plan-inputs"><summary>${L('策略规则与核算依据','Rules and calculation evidence')}</summary>${report.facts.slice(p.levels?3:0).map(([label,value])=>`<p><b>${esc(label)}</b> · ${esc(value)}</p>`).join('')}</details><div class="sig-plan-actions"><button type="button" class="p-button" data-track-strategy="${esc(p.strategy)}">${L('查看策略','View strategy')}</button></div>`:''}</section>`;
 }
 function recordSummary(row){
  const r=trackingRecord(row),validUntil=r.validUntil===null?L('未提供','Not provided'):r.clockKind==='simulation'?simClock(r.validUntil):new Date(r.validUntil).toISOString();
  const invalidation=r.invalidation||L('未提供','Not provided');
  return `<div class="sig-record-state"><strong>${r.clockKind==='historical'?L('历史记录','Historical record')+' · '+L(...TRACKING_STAGES[row.stage]):recordState(r)}</strong><details class="dc-info"><summary aria-label="${L('信号来源与时效','Signal source and validity')}">i</summary><div><b>${esc(r.sourceId)} · ${esc(r.version)}</b><p>${esc(r.signalId)} · ${r.clockKind==='simulation'?L('模拟','Demo'):r.clockKind==='historical'?L('历史记录','Historical record'):'UTC'}</p><p>${L('有效期','Validity')}: ${esc(validUntil)}</p>${quoteFacts(row).map(([label,value])=>`<p>${esc(label)}: ${esc(value)}</p>`).join('')}<p>${L('失效条件','Invalidation')}: ${esc(invalidation)}</p></div></details></div>`;
 }
 function recordContext(ev){
  const r=trackingRecord(ev);
  if(ev.record)return `<dl class="sig-record-identity"><div><dt>${L('运行','Run')}</dt><dd>${esc(r.runId)}</dd></div><div><dt>${L('信号','Signal')}</dt><dd>${esc(r.signalId)}</dd></div><div><dt>${L('版本','Version')}</dt><dd>${esc(r.version||L('未提供','Not provided'))}</dd></div></dl><div class="sig-record-evidence"><span>${L('证据','Evidence')}</span><p>${esc(r.condition||L('未提供','Not provided'))}</p></div><div class="sig-record-evidence"><span>${L('失效条件','Invalidation')}</span><p>${esc(r.invalidation||L('未提供','Not provided'))}</p></div>`;
  const review=r.review,guide=TRACKING_GUIDANCE[ev.track.source];if(!review||!guide)return '';
  const stat=(label,value)=>`<div><dt>${label}</dt><dd>${signedPercent(value)}</dd></div>`;
  return `<section class="sig-review"><header><h3>${L('追踪脉络','Tracking path')}</h3><span>${review.observations} ${L('次观察','observations')}</span></header><dl class="sig-review-stats">${stat(L('较首次记录','From first record'),review.changePercent)}${stat(L('最近一段','Latest interval'),review.latestChangePercent)}${stat(L('距本轮高点','From tracking high'),review.drawdownFromPeakPercent)}</dl><p class="sig-review-clock">${esc(ev.track.events[0].time)} → ${esc(ev.time)} · ${esc(ev.date)} UTC+8<br>${L('价格变化，非交易收益','Price changes, not trading returns')}</p><div class="sig-review-checks"><h3>${L('继续核验','Verify next')}</h3><ul>${guide.checks.map(item=>`<li>${L(...item)}</li>`).join('')}</ul></div><div class="sig-review-risk"><h3>${L('风险与失效','Risk and invalidation')}</h3><p>${L(...guide.risk)}</p><p>${esc(r.invalidation||L('本记录未提供数值失效条件。','No numeric invalidation rule was recorded.'))}</p></div></section>`;
 }
 function recordActions(row){return `<div class="sig-record-actions"><button type="button" class="p-button" data-track-copy="${row.id}">${L('复制信号','Copy signal')}</button><button type="button" class="p-button" data-track-export="${row.id}">${L('导出报告','Export report')}</button></div>`;}
 function detail(ev,popup=false){
  if(ev.live)return liveSignalDetail(ev,{popup,watched:watched().includes(ev.symbol),previousObservation:Boolean(routeSignalId&&routeLiveAsset===ev.symbol&&ev.live.id!==routeSignalId)});
  const c=ev.track,id=popup?'sig-dialog-title':'sig-detail-title',r=trackingRecord(ev),thesis=ev.record?r.condition||'':ev.simulation?.thesis||L(...c.thesis),clockSuffix=signalClockSuffix(ev);
  return `<div class="sig-reading-tools">${popup?'':`<h3 tabindex="-1" data-track-reading-heading aria-describedby="sig-detail-title">${L('信号解读','Signal analysis')}</h3>`}${recordActions(ev)}</div><section class="sig-reading-hero"><div class="sig-detail-title sig-asset">${icon(c)}<div><h2 id="${id}">${c.id}</h2><small>${source(c)} · ${c.asset.domain}</small></div><button type="button" class="sig-watch" data-track-watch="${c.id}" aria-pressed="${watched().includes(c.id)}">${uiGlyph('star')}${watched().includes(c.id)?L('已关注','Following'):L('关注','Follow')}</button></div>${recordSummary(ev)}<section class="sig-reading-lead"><h3>${esc(ev.simulation?.title||L(...c.title))}</h3>${thesis?`<p class="sig-detail-thesis">${esc(thesis)}</p>`:''}</section><div class="sig-detail-quote"><small>${priceLabel(ev)} · ${esc(ev.date)} ${esc(ev.time)}${clockSuffix?' '+clockSuffix:''}</small><div class="sig-price-focus">${Number.isFinite(ev.price)?`<strong class="dot-number">${price(ev,ev.price)}</strong>`:`<strong class="sig-price-missing">${L('未提供','Not provided')}</strong>`}</div></div></section>${recordContext(ev)}<div data-signal-reference="${esc(signalReferenceKey(ev))}" data-signal-reference-id="${esc(ev.id)}">${plan(c,ev)}</div>${signalCandleIdentity(ev)&&Object.hasOwn(HUB_ASSET_IDS,c.asset.symbol)?`<details class="sig-candle-view"><summary>${L('当前市场 K 线','Current market candles')}${uiGlyph('chevron')}</summary>${tradingChartPanel(popup?'sig-modal-candles':'sig-side-candles',{...signalCandleIdentity(ev),hostedMarket:true})}</details>`:''}${c.events.length?`<details class="sig-history"><summary>${L('观察记录','Observation history')} <span>${c.events.length}</span></summary><ol>${c.events.map(event=>`<li><time datetime="${event.date}T${event.time}:00+08:00">${event.time}</time><div><b>${L(...TRACKING_STAGES[event.stage])}</b><p>${L(...event.reason)}</p></div><span>${price(ev,event.price)}</span></li>`).join('')}</ol></details>`:''}${c.events.length?chartPanel(popup?'sig-modal-chart':'sig-side-chart',{title:signalQuote(ev).priceUnit==='点'?L('记录点位走势','Recorded level history'):L('记录价格走势','Recorded price history'),kind:'line',values:c.events.map(x=>x.price),labels:c.events.map(x=>x.time),unit:unitText(ev),height:160,color:'var(--chart-accent)',initialWindow:'all',compact:true,showPresets:false}):''}<div class="sig-detail-links">${marketLink(c,L('当前市场概览','Current market overview'))}${c.href&&c.href!=='?page=markets&asset='+c.id&&!(c.source==='macro'&&c.href==='?page=intelligence')&&!(c.source==='onchain'&&c.href==='?page=tracking')?`<a data-track-link data-dc-link href="${c.href}">${L(...({onchain:['打开链上数据','Open on-chain data'],macro:['打开宏观消息','Open macro news'],social:['打开社媒数据','Open social data'],money:['打开账户动态','Open account activity']}[c.source]||['打开相关数据','Open related data']))} ↗</a>`:''}</div>`;
 }
 function card(ev){
  if(ev.live)return liveSignalCard(ev,{selected:selected===ev.id,watched:watched().includes(ev.symbol)});
  const c=ev.track,r=trackingRecord(ev),on=selected===ev.id,isWatched=watched().includes(c.id),strategy=ev.record?r.strategy:signalStrategy(c),change=r.review?.changePercent,compact=ev.record&&!Number.isFinite(ev.price)&&!r.condition,clockSuffix=signalClockSuffix(ev);
  const originLabel=origin==='all'&&!ev.record?(feedLabels[getLocale()]||feedLabels.en).examples+' · ':'';
  const guidance=signalActionGuidance(ev),metrics=ev.record?`<span>${L('运行','Run')}<b class="sig-record-reference">${esc(r.runId)}</b></span><span>${L('信号','Signal')}<b class="sig-record-reference">${esc(r.signalId)}</b></span>`:`${r.review?`<span>${L('较首次记录','From first record')}<b class="${change>0?'is-positive':change<0?'is-negative':''}">${signedPercent(change)}</b></span>`:''}${strategy?`<span>${L('参考策略','Strategy')}<b class="sig-record-reference">${esc(strategy)}</b></span>`:''}<span>${L('观察记录','Observation history')}<b>${c.events.length}</b></span>`;
  const actionMetric=`<p class="sig-card-guidance"><span>${L('操作参考','Action guidance')}</span><b data-signal-action="${esc(ev.id)}" data-signal-action-key="${esc(signalReferenceKey(ev))}">${esc(guidance.judgment)} · ${esc(guidance.label)}</b></p>`;
  statsRecords.set(ev.id,signalStatsData(ev));
  return `<article class="sig-event ${on?'selected':''}" data-track-record="${ev.id}" aria-current="${on}" data-signal-density="${compact?'compact':'full'}">${on?'<span class="sig-current-marker" aria-hidden="true">✓</span>':''}<div class="sig-event-body"><header><span class="sig-event-asset">${icon(c)}<span><b>${c.id}</b><small>${originLabel}${source(c)} · ${c.asset.domain}</small></span></span><button type="button" class="sig-event-title" data-track-open="${ev.id}" tabindex="0">${esc(ev.simulation?.title||L(...c.title))}</button><span class="sig-card-state" data-stage="${ev.record?r.stage:ev.stage}">${ev.record?recordState(r):L(...TRACKING_STAGES[ev.stage])}</span></header>
   
   <div data-signal-stats="${ev.id}"><div class="sig-card-insights"><div class="sig-card-quote"><div><span>${priceLabel(ev)}</span><strong class="${Number.isFinite(ev.price)?'dot-number':'sig-card-price-missing'}">${Number.isFinite(ev.price)?price(ev,ev.price):L('未提供','Not provided')}</strong></div></div>${signalHistoryPreview(ev)}<div class="sig-event-data">${metrics}</div></div></div>
   ${actionMetric}<footer><div class="sig-event-time"><time${ev.date?` datetime="${ev.date}T${ev.time}:00${ev.record?'Z':'+08:00'}"`:''}>${ev.date?esc(ev.date)+' · ':''}${esc(ev.time)}</time>${clockSuffix?`<span>${clockSuffix}</span>`:''}</div><button type="button" class="sig-watch" data-track-watch="${c.id}" aria-pressed="${isWatched}" aria-label="${isWatched?L('取消关注','Unfollow'):L('关注','Follow')} ${c.id}">${uiGlyph('star')}${isWatched?L('已关注','Following'):L('关注','Follow')}</button><button type="button" data-track-open="${ev.id}" data-track-read>${L('解读信号','Analyze signal')} ${uiGlyph('arrow')}</button></footer></div></article>`;
 }
 function render({nav,myWatch=false,view='personal'}){
  applySignalRoute();liveOwner=true;syncLiveFeed();paintedRevision=liveRevision();
  const nextTargets=targetSignature();if(nextTargets!==targetsRevision){targetsRevision=nextTargets;page=1;scopePagePinned=true;}
  stopReferences(root);statsRevision++;disposeStats();disposeStats=()=>{};statsRecords.clear();
  const nextMode=myWatch?'watch':view,viewChanged=mode!==nextMode;mode=nextMode;
  const labels=feedLabels[getLocale()]||feedLabels.en;
  const [marketLabel,marketLoading,marketUnavailable,marketHint,marketRetry,marketRefresh,marketMissing]=marketFeedCopy[getLocale()]||marketFeedCopy.en;
  const candidates=rowsInScope(),rows=allRows(candidates),runCount=rows.filter(row=>row.record).length,liveCount=rows.filter(row=>row.live).length;
  if(origin==='live'&&followFirstLive)selected=rows[(page-1)*size]?.id||'';
  if(linkedLiveAsset){
   const linked=rows.find(row=>row.live&&row.symbol===linkedLiveAsset);
   if(linked){selected=linked.id;pendingOpen=true;followFirstLive=false;scopePagePinned=false;linkedLiveAsset=null;}
  }
  if(selected&&!rows.some(row=>row.id===selected)&&wantsLive()&&!sourceView)selected='';
  const pages=Math.max(1,Math.ceil(rows.length/size)),index=rows.findIndex(row=>row.id===selected);
  if(viewChanged&&index<0&&!pendingOpen){selected='';page=1;}
  if(index>=0&&!scopePagePinned)page=Math.floor(index/size)+1;else page=Math.min(page,pages);
  const visible=rows.slice((page-1)*size,page*size),picked=selected?rows.find(ev=>ev.id===selected):visible[0],p=prefs(),preferenceCount=mode==='personal'?Object.values(p).filter(value=>value!=='all').length:0,noWatch=mode==='watch'&&!watchKeys().length;selected=picked?.id||selected;
  const pagination=rows.length?`<div class="sig-pagination"><span>${rows.length?`${(page-1)*size+1}–${Math.min(page*size,rows.length)} / ${rows.length}`:'0'}</span><div><button type="button" data-track-page="${page-1}" ${page===1?'disabled':''} aria-label="${L('上一页','Previous page')}">${uiGlyph('chevron')}</button><span>${page} / ${pages}</span><button type="button" data-track-page="${page+1}" ${page===pages?'disabled':''} aria-label="${L('下一页','Next page')}">${uiGlyph('chevron')}</button></div></div>`:'';
  const selection=targetSelection(),scoped=selection.filter!=='all'||selection.focusAsset;
  const side=rows.length?`<aside class="sig-detail-aside">${picked?detail(picked):`<div class="sig-empty">${selected?(scoped?L('当前范围内未选中信号','No signal selected in this scope'):L('记录暂不可用','Record unavailable')):L('选择一条信号查看解读','Select a signal to read its analysis')}</div>`}</aside>`:'';
  const hasFilters=Boolean(query.trim())||kind!=='all'||origin!==defaultOrigin||validity!=='all';
  const defaultEmpty=mode!=='watch'&&!scoped&&!preferenceCount&&!hasFilters;
  const archiveCount=origin==='historical'||wantsLive()||origin==='all'?0:filteredRows(candidates,'historical','all').length;
  const archiveAction=archiveCount?`<button type="button" class="p-button sig-archive-action" data-track-archive data-no-translate>${esc(labels.archive(archiveCount))}</button>`:'';
  const state=wantsLive()?liveFeed.snapshot():null;
  const marketEmpty=defaultEmpty&&origin==='live';
  const emptyTitle=marketEmpty?(state.loading?marketLoading:marketUnavailable):noWatch?L('还没有追踪的标的','Your watchlist is empty'):mode==='watch'?L('追踪标的暂无匹配信号','No matching signals for your watchlist'):scoped&&selected?L('当前范围内未选中信号','No signal selected in this scope'):defaultEmpty?labels.empty:L('没有匹配的信号','No matching signals');
  const emptyHint=marketEmpty?(state.loading?'':marketHint):mode==='watch'?L('在这里集中查看追踪标的的相关信号。','Signals for your tracked assets appear here.'):defaultEmpty?labels.hint:L('调整筛选或研究偏好，也可以查看全市场。','Adjust your filters or preferences, or view all markets.');
  const empty=`<div class="sig-empty${defaultEmpty?' sig-empty-run':''}">${uiGlyph('search')}<h2${marketEmpty?' role="status"':''}>${emptyTitle}</h2>${emptyHint?'<p>'+esc(emptyHint)+'</p>':''}<div class="sig-empty-actions">${noWatch&&onManageWatch?`<button type="button" class="p-button" data-track-manage>${L('添加标的','Add assets')}</button>`:''}${archiveAction}${marketEmpty&&!state.loading?'<button type="button" class="p-button" data-track-live-retry>'+esc(marketRetry)+'</button>':''}${!defaultEmpty?`<button type="button" class="p-button" data-track-browse>${L('查看全市场','View all markets')}</button>`:''}</div></div>`;
  const counts=`<span class="sig-feed-counts">${wantsLive()?`<span>${esc(marketLabel)} <b>${liveCount}</b></span>`:''}${state?.failed.length?`<span>${esc(marketMissing)} · ${esc(state.failed.map(item=>item.symbol).join(', '))}</span>`:''}${origin!=='historical'&&origin!=='live'?`<span>${L('运行记录','Run history')} <b>${runCount}</b></span>`:''}${origin==='all'||origin==='historical'?`<span>${labels.examples} <b>${rows.length-runCount-liveCount}</b></span>`:''}${origin==='historical'?`<time datetime="${TRACKING_CUTOFF.slice(0,10)}">${TRACKING_CUTOFF.slice(0,10)}</time>`:''}${visible.length?archiveAction:''}</span>`;
  const chartStatus=visible.some(row=>!row.live)?`<div class="sig-chart-status" data-signal-chart-status ${statsFailed?'':'hidden'}><span role="status">${labels.charts}</span><button type="button" class="p-button" data-signal-chart-retry>${labels.retry}</button></div>`:'';
  return `<div class="as-page sig-tracking" data-localized-ui>${nav}${renderWorkbenchTargets(w,research)}<div class="sig-controls"><div class="sig-toolbar sig-toolbar-simple"><a class="brain-entry" data-brain-route="brain" href="${esc(brainEntrySearch())}">${L(...BRAIN_PAGE_NAME)} ↗</a><label class="as-search">${uiGlyph('search')}<input id="sig-search" value="${esc(query)}" placeholder="${L('搜索资产或信号','Search assets or signals')}" aria-label="${L('搜索 AI 信号','Search AI signals')}"></label>
   <label class="sig-origin-control"><span class="sr-only">${L('信号来源','Signal origin')}</span><select data-track-origin>${[...(liveFeed?[['live',marketLabel]]:[]),['runtime',labels.runs],['autonomous',L('AI 自主','Autonomous AI')],['bot','AI BOT'],['historical',labels.examples],['all',labels.all]].map(([id,label])=>`<option value="${id}" ${origin===id?'selected':''}>${esc(label)}</option>`).join('')}</select></label>
   <details class="sig-filter-panel" data-persist-key="signal-filters"><summary>${uiGlyph('filter')}${L('筛选','Filter')}${kind!=='all'||validity!=='all'?'<b>'+[kind,validity].filter(v=>v!=='all').length+'</b>':''}</summary><div class="sig-filter-body"><div class="sig-sources" role="group" aria-label="${L('信息类型','Information type')}">${[['all',['全部','All']],...Object.entries(TRACKING_SOURCES)].map(([id,label])=>`<button type="button" data-track-source="${id}" aria-pressed="${kind===id}">${L(...label)}</button>`).join('')}</div><label class="sig-record-filter">${L('有效期','Validity')}<select data-track-validity>${[['all',L('全部时效','All validity states')],['active',L('有效期内','Within validity')],['expired',L('已过期','Expired')],['unknown',L('有效期未提供','Validity unavailable')],['historical',labels.examples]].map(([id,label])=>`<option value="${id}" ${validity===id?'selected':''}>${esc(label)}</option>`).join('')}</select></label>${hasFilters?`<button type="button" class="p-button" data-track-reset>${L('清除筛选','Clear filter')}</button>`:''}</div></details>
   ${mode==='watch'&&!noWatch&&onManageWatch?`<button type="button" class="p-button sig-watch-manage" data-track-manage>${uiGlyph('sliders')}${L('管理追踪','Manage watchlist')}</button>`:''}
   <details class="sig-preferences" ${mode==='watch'?'hidden':''} data-persist-key="signal-preferences"><summary>${uiGlyph('settings')}${L('研究偏好','Research preferences')}${preferenceCount?`<b class="sig-applied-count">${preferenceCount}</b>`:''}</summary><div class="sig-preferences-panel"><h2>${L('研究偏好','Research preferences')}</h2><p class="sig-pref-hint">${L('用于“为你精选”；全市场不受影响。','Applies to For you; All markets remains unfiltered.')}</p><label>${L('研究市场','Markets')}<select data-sig-pref="scope">${choice('scope',p.scope)}</select></label><label>${L('关注信息','Focus')}<select data-sig-pref="focus">${choice('focus',p.focus)}</select></label><label>${L('参考策略','Strategies')}<select data-sig-pref="strategy">${choice('strategy',p.strategy)}</select></label><div class="sig-pref-source">${connectionLabel()}</div><button type="button" class="p-button" data-pref-reset>${L('恢复默认','Reset defaults')}</button>${prefError?`<p role="status" class="sig-pref-hint">${L('当前浏览器无法保存偏好，请检查存储设置。','Preferences could not be saved. Check browser storage.')}</p>`:''}</div></details>
   ${hasFilters?`<button type="button" class="p-button sig-reset" data-track-reset><span class="sig-reset-label">${L('清除筛选','Clear filters')}</span>${uiGlyph('close')}</button>`:''}</div>
   <div class="sig-feed-meta">${counts}<div class="sig-refresh-controls"><label><span class="sig-refresh-label">${L('列表刷新','List refresh')}</span> <select data-sig-interval aria-label="${L('列表刷新','List refresh')}">${HUB_REFRESH_SECONDS.map(s=>`<option value="${s}" ${refreshInterval()===s?'selected':''}>${s} ${L('秒','sec')}</option>`).join('')}</select></label><details class="dc-info"><summary aria-label="${L('数据说明','About the data')}">i</summary><div>${wantsLive()?marketRefresh:labels.refresh}${origin==='historical'||origin==='all'?`<br>${labels.examples} · ${TRACKING_CUTOFF} UTC+8`:''}</div></details></div></div></div>
   ${chartStatus}
   <div class="sig-workspace"><section class="sig-feed" aria-label="${L('AI 信号','AI signals')}">${visible.length?visible.map(card).join(''):empty}${pagination}</section>${side}</div></div>`;
 }
 function showDetail(ev){
  readerLiveSymbol=ev.live?ev.symbol:'';readerLiveRevision=ev.live?JSON.stringify(observationRevision(ev.live)):'';
  stopReferences(dialog);ev=withReference(ev);dispose();dispose=()=>{};dialog.innerHTML=`<header><h2>${L('信号解读','Signal analysis')}</h2><button type="button" data-track-close aria-label="${L('关闭','Close')}">${uiGlyph('close')}</button></header><div class="sig-dialog-body">${detail(ev,true)}</div>`;bind(dialog);dialog.showModal();dispose=mountCharts(dialog);}
 function openSource(ref,onReturn){
  if(dialog.open)return false;
  const row=sourceRow(ref);if(!row)return false;
  const {type,recordId,sourceId,signalId,runId,revision,asset}=ref;
  sourceView={ref:{type,recordId,sourceId,signalId,runId,revision,asset},onReturn:typeof onReturn==='function'?onReturn:null};
  try{showDetail(row);return true;}catch{sourceView=null;dispose();dispose=()=>{};if(dialog.open)dialog.close();return false;}
 }
 function open(id,read=false){
  scopePagePinned=false;const y=root.scrollTop,ev=allRows().find(x=>x.id===id);selected=id;
  if(!ev){if(dialog.open)close();else{refresh();root.scrollTop=y;}notify(L('记录暂不可用','Record unavailable')+' · '+L('选择一条信号查看解读','Select a signal to read its analysis'));return;}
  readerOrigin={id,read};if(ev.live)followFirstLive=false;refresh();root.scrollTop=y;
  if(matchMedia('(max-width:1000px)').matches){showDetail(ev);return;}
  if(read){
   const heading=root.querySelector('[data-track-reading-heading]');
   heading?.focus({preventScroll:true});heading?.scrollIntoView?.({block:'nearest',behavior:'instant'});
  }
 }

 function updateCardGuidance(row){
  const key=signalReferenceKey(row),guidance=signalActionGuidance(row);
  for(const node of root.querySelectorAll('[data-signal-action]'))if(node.dataset.signalAction===row.id&&node.dataset.signalActionKey===key)node.textContent=guidance.judgment+' · '+guidance.label;
 }
 function startReference(host,row,retrying=false){
  if(referenceTasks.has(host)||host.dataset.signalReference!==signalReferenceKey(row))return;
  const controller=new AbortController(),key=signalReferenceKey(row),initial=signalReferencePlan(row);referenceTasks.set(host,controller);
  const loading={...row,referencePlan:{...initial,status:'loading',retrying,reasons:[]}};host.innerHTML=plan(row.track,loading);updateCardGuidance(loading);bind(host);
  const finish=result=>{
   if(controller.signal.aborted||!host.isConnected||host.dataset.signalReference!==key||result.recordKey!==key)return;
   referencePlans.set(key,result);const updated={...row,referencePlan:result};host.innerHTML=plan(row.track,updated);updateCardGuidance(updated);bind(host);
  };
  loadReference(row,{signal:controller.signal}).then(finish).catch(()=>finish({...initial,status:'error',reasons:[['参考核算暂不可用，请重试','Reference calculation is unavailable. Please retry']]})).finally(()=>referenceTasks.delete(host));
 }
 function bindCardStats(container){
  const hosts=[...container.querySelectorAll('[data-signal-stats]')];if(!hosts.length)return;
  const revision=++statsRevision,records=new Map(statsRecords),notice=container.querySelector('[data-signal-chart-status]'),retry=container.querySelector('[data-signal-chart-retry]');
  const current=()=>revision===statsRevision&&!container.hidden&&hosts.every(host=>host.isConnected);
  disposeStats();disposeStats=()=>{};
  let mounting=false;
  async function mount(){
   if(!current()||mounting)return;
   const hadFocus=document.activeElement===retry;
   mounting=true;if(retry)retry.disabled=true;
   try{
    const {mountAdvancedStats}=await loadCardStats();if(!current())return;
    disposeStats=mountAdvancedStats(container,records);statsFailed=false;
    if(notice){
     if(hadFocus&&(document.activeElement===retry||document.activeElement===document.body))(container.querySelector('[data-track-record][aria-current="true"] .sig-event-title')||container.querySelector('.sig-event-title'))?.focus({preventScroll:true});
     notice.hidden=true;
    }
   }catch{
    if(!current())return;
    statsFailed=true;if(notice)notice.hidden=false;
   }finally{mounting=false;if(retry&&current())retry.disabled=false;}
  }
  if(retry)retry.onclick=mount;
  if(!statsFailed||retry?.disabled)void mount();
 }
 function bind(container=root){
  stopReferences();
  const referenceRow=host=>sourceView&&(container===dialog||dialog.contains?.(host))?sourceRow(sourceView.ref):allRows().find(row=>row.id===host.dataset.signalReferenceId);
  for(const host of container.querySelectorAll('[data-signal-reference]')){
   const row=referenceRow(host);if(row&&signalReferenceFor(row).status==='needs-bars')startReference(host,row);
  }
  container.querySelectorAll('[data-track-reference-retry]').forEach(button=>button.onclick=()=>{
   const host=button.closest('[data-signal-reference]'),row=host&&referenceRow(host);
   if(!row||referenceTasks.has(host)||signalReferenceFor(row).status!=='error')return;
   referencePlans.delete(signalReferenceKey(row));startReference(host,row,true);
  });
  container.querySelectorAll('[data-track-manage]').forEach(button=>button.onclick=()=>onManageWatch?.());
  if(container===root){
   disposeTargets();disposeTargets=bindWorkbenchTargets(root,{workspace:w,research,onChange:targetsChanged,onManage:()=>onManageWatch?.(),notify:issue=>notify(issue,{tone:'error'})});
   bindCardStats(container);
  }
  for(const action of ['copy','export'])container.querySelectorAll(`[data-track-${action}]`).forEach(button=>button.onclick=async()=>{
   const id=button.dataset[action==='copy'?'trackCopy':'trackExport'],row=container===dialog&&sourceView?sourceRow(sourceView.ref):allRows().find(row=>row.id===id);if(!row||row.id!==id)return;
   try{const text=action==='copy'?signalCopyText(row):signalReportHTML(row);if(action==='copy')await navigator.clipboard.writeText(text);else{const url=URL.createObjectURL(new Blob([text],{type:'text/html;charset=utf-8'}));try{const a=document.createElement('a');a.href=url;a.download=('Astarter-'+row.track.id+'-'+trackingRecord(row).signalId+'-report').replace(/[^\w.-]/g,'_').slice(0,160)+'.html';a.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}}notify(action==='copy'?L('已复制','Copied'):L('已导出','Exported'),{tone:'success'});}
   catch{notify(L('操作失败，请重试','Action failed. Try again.'),{tone:'error'});}
  });
  container.querySelectorAll('[data-track-open]').forEach(b=>b.onclick=()=>open(b.dataset.trackOpen,b.dataset.trackRead!==undefined));
  const reader=container.querySelector('.sig-detail-aside');
  if(reader)reader.onkeydown=event=>{
   if(event.key!=='Tab'||!event.shiftKey||!readerOrigin?.read||readerOrigin.id!==selected)return;
   if(!event.target.matches('[data-track-reading-heading],[data-track-copy]'))return;
   const origin=originButton(readerOrigin);if(origin){event.preventDefault();origin.focus();}
  };
  container.querySelectorAll('[data-track-record]').forEach(card=>card.onclick=event=>{
   if(event.defaultPrevented||event.target.closest('button,a,input,select,textarea,summary,label,[contenteditable]')||document.getSelection?.()?.toString())return;
   card.querySelector('.sig-event-title')?.focus({preventScroll:true});open(card.dataset.trackRecord);
  });
  const closeButton=container.querySelector('[data-track-close]');if(closeButton)closeButton.onclick=()=>close();
  container.querySelectorAll('[data-track-watch]').forEach(b=>{if(container===dialog&&sourceView){b.remove();return;}b.onclick=async()=>{const id=b.dataset.trackWatch,list=watched(),popupId=dialog.open?selected:null;const issue=await w.toggleTracked(id);if(issue){w.onError?.(issue);return;}refresh();if(dialog.open){const ev=allRows().find(x=>x.id===popupId);if(ev){dispose();dialog.querySelector('.sig-dialog-body').innerHTML=detail(ev,true);bind(dialog);dispose=mountCharts(dialog);dialog.querySelector(`[data-track-watch="${id}"]`)?.focus();}else close();}};});
  container.querySelectorAll('[data-track-strategy]').forEach(b=>b.onclick=()=>{
   const context=sourceView&&(container===dialog||dialog.contains?.(b))?sourceView:null,returnId=b.closest?.('[data-signal-reference-id]')?.dataset.signalReferenceId||selected,row=context?sourceRow(context.ref):allRows().find(row=>row.id===returnId);
   if(!row){if(context)close();else open(returnId);return;}
   const read=readerOrigin?.id===returnId&&readerOrigin.read;
   const returnTo=context?()=>{if(!openSource(context.ref,context.onReturn))context.onReturn?.();}:()=>{if(document.body.dataset?.page==='signals')open(returnId,read);};
   if(dialog.open)close(!context);onStrategy(b.dataset.trackStrategy,returnTo,trackingRecord(row));
  });
  container.querySelectorAll('[data-track-source]').forEach(b=>b.onclick=()=>{kind=b.dataset.trackSource;changeList();});
  container.querySelector('[data-track-origin]')?.addEventListener('change',e=>{origin=e.target.value;followFirstLive=true;changeList();});
  container.querySelector('[data-track-validity]')?.addEventListener('change',e=>{validity=e.target.value;if(validity==='historical'&&(origin==='runtime'||origin==='live'))origin='historical';changeList();});
  container.querySelectorAll('[data-track-page]').forEach(b=>b.onclick=()=>{selected='';followFirstLive=true;page=Math.max(1,Number(b.dataset.trackPage));refresh();root.querySelector('.sig-feed-meta')?.scrollIntoView({block:'start'});});
  container.querySelectorAll('[data-track-reset]').forEach(b=>b.onclick=()=>{kind='all';origin=defaultOrigin;followFirstLive=true;validity='all';query='';changeList();});
  container.querySelector('[data-track-live-retry]')?.addEventListener('click',()=>liveFeed?.refresh());
  container.querySelector('[data-track-archive]')?.addEventListener('click',()=>{
   origin='historical';validity='all';changeList();
   root.querySelector('.sig-event-title')?.focus({preventScroll:true});
  });
  container.querySelector('[data-track-browse]')?.addEventListener('click',()=>{if(!clearTargetScope())return;kind='all';validity='all';query='';page=1;onBrowse();});
  const q=container.querySelector('#sig-search');if(q)bindSearchRender(q,value=>{query=value;},()=>{changeList();return root.querySelector('#sig-search');});
  container.querySelectorAll('[data-sig-pref]').forEach(el=>el.onchange=()=>{savePrefs({...prefs(),[el.dataset.sigPref]:el.value});changeList();});
  container.querySelector('[data-pref-reset]')?.addEventListener('click',()=>{savePrefs({});changeList();});
  const interval=container.querySelector('[data-sig-interval]');if(interval)interval.onchange=()=>{try{const seconds=parseHubRefreshSeconds(interval.value);localStorage.setItem('hive.market.refreshSeconds',String(seconds));window.dispatchEvent(new CustomEvent('hive:market-refresh-interval',{detail:{seconds}}));}catch{interval.value=String(refreshInterval());}};
  if(container===dialog)container.querySelectorAll('[data-track-link]').forEach(a=>a.onclick=ev=>{
   if(ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;ev.preventDefault();
   const href=a.getAttribute('href'),returnId=selected,context=sourceView;
   const read=readerOrigin?.id===returnId&&readerOrigin.read;
   const returnTo=context?()=>{const opened=openSource(context.ref,context.onReturn);if(!opened)context.onReturn?.();return opened;}:()=>{if(document.body.dataset?.page==='signals')open(returnId,read);};
   close(!context);if(onRelatedLink(href,returnTo))return;
   if(context)context.onReturn?.();history.pushState(null,'',routeHref(href));window.dispatchEvent(new PopStateEvent('popstate'));
  });
  if(container===root&&pendingOpen){
   const id=selected;pendingOpen=false;
   if(matchMedia('(max-width:1000px)').matches)queueMicrotask(()=>{if(selected===id&&!dialog.open&&document.body.dataset?.page==='signals')open(id);});
  }
 }
 function sourceSnapshot(){
  const row=allRows().find(row=>row.id===selected);if(!row)return null;
  const params=new URLSearchParams(routeSearch());params.set('page','signals');
  if(row.live){params.set('data','live');params.set('asset',row.symbol);}
  else if(!row.record){params.set('data','demo');params.set('asset',row.symbol);}
  else{params.delete('asset');if(params.get('data')==='demo')params.delete('data');}
  return {id:row.id,title:row.symbol+' · '+L('AI 信号','AI signal'),text:row.live?liveSignalExcerpt(row):signalExcerpt(row),href:'?'+params,kind:'excerpt'};
 }
 return {render,bind,openSource,clearTargetScope,sourceSnapshot,watchCount:()=>watched().length,revision:()=>JSON.stringify([watchKeys(),targetSignature(),liveRevision(),publicRunSignals(w.s.signals||[],readSnapshot())]),get refreshSeconds(){return refreshInterval();},select:selectExample};
}
