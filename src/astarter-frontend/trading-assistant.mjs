import {routeSearch,routeHref} from './site-routes.mjs';
// UI adapted from 21st.dev Chat02 (ephraimduncan) and Conversation List
// (arihantcodes_1f7b8c4d). See REFERENCE-ADOPTION.md for retrieved source IDs.
import {EXCHANGE_ASSETS,EXCHANGE_PERIODS,EXCHANGE_OPERATIONS,PRIVATE_EXCHANGE_OPERATIONS,EXCHANGE_CAPABILITIES} from './assistant-exchange-data.mjs';
import {visibleTurn} from './commerce-catalog.mjs';
import {commerceContextLink} from './commerce-ui.mjs';
import {createAssistantTeam} from './assistant-team.mjs';
import {uiGlyph as icon} from './product-composition.mjs';
import {venueIcon,tokenIcon} from './brand-icons.mjs';
import {MARKET,METRICS,NEWS,SNAPSHOT,DATA_PAGES} from './data-center-fixtures.mjs';
import {chartPanel,makeBars} from './product-chart-ui.mjs';
import {tradingChartPanel,captureTradingChart} from './trading-chart.mjs';
import {L} from './execution-views.mjs';
import {forceLocale} from './locale.mjs';
import {sameWatchAssetKey} from './market-watchlist.mjs';
import {getLocale,translate} from './locale.mjs';
import {assistantQuoteInstrument,readAssistantQuotes} from './assistant-exchange-data.mjs';
import {assistantConversationMessages,assistantPublicSources,requestAssistantAnswer} from './assistant-chat-client.mjs';
import {assistantDecisionContext,asksMarketDecision,asksOtherMarketTime,readAssistantMarketContext} from './assistant-market-context.mjs';
import {questionQuoteSymbols,orderRuleQuestion,cleanAnswerEvidence} from './assistant-analysis.mjs';
import {hubSourceTime} from './market-hub-data.mjs';
import {explicitThreadRecall,sourceNeedsNewThread,addSource,extractMaterial,analyzeBars,questionTopic,questionLanguage,technicalIntent,normalizeChatStore,CHAT_LIMITS,clipText,BINANCE_AGENT_OS,ASSISTANT_TOOLSETS,RESEARCH_OPTIONS,RESEARCH_AS_OF,researchDate,researchRange,researchAssets,normalizeResearchConfig,buildResearchReport,technicalContext,encodeSharedOutput,decodeSharedOutput,sharedOutputURL,socialDraft} from './assistant-analysis.mjs?v=20261124b';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';
const price=v=>n(v,v<.001?8:v<10?4:2);
const para=s=>`<p>${esc(s)}</p>`;
function tableCells(line){
 const tokens=line?.trim().match(/\\[\\|]|[^|\\]+|[\\|]/g);
 if(!tokens?.includes('|'))return null;
 if(tokens[0]==='|')tokens.shift();
 if(tokens.at(-1)==='|')tokens.pop();
 const cells=[''];
 for(const token of tokens){
  if(token==='|')cells.push('');
  else cells[cells.length-1]+=token.length===2&&token[0]==='\\'?token[1]:token;
 }
 return cells.length>1?cells.map(cell=>cell.trim()):null;
}
function modelAnswerHTML(text,evidence=[]){
 const links=new Set(evidence.filter(item=>item.status==='observed')
  .flatMap(item=>[item.href,item.sourceUrl]).filter(Boolean).map(esc));
 function formatInline(safe){
  return safe.replace(/(`+)(.+?)\1|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(((?:https:\/\/|\/?\?page=)[^()\s]+)\)/g,(literal,ticks,code,bold,label,href)=>{
   if(ticks)return `<code>${code}</code>`;
   if(bold)return `<strong>${formatInline(bold)}</strong>`;
   if(!links.has(href))return literal;
   const external=href.startsWith('https://')?' target="_blank" rel="noopener noreferrer"':'';
   return `<a href="${href}"${external}>${label}</a>`;
  });
 }
 const inline=line=>formatInline(esc(line));
 const lines=text.split(/\r\n?|\n/),blocks=[];
 const itemPattern=/^ {0,3}(?:([-+*])|(\d{1,9})[.)])[ \t]+(.+)$/;
 for(let i=0;i<lines.length;){
  const line=lines[i++];
  const fence=/^ {0,3}(`{3,})[^`]*$/.exec(line);
  if(fence){
   const code=[];
   while(i<lines.length){
    const next=lines[i++],end=/^ {0,3}(`{3,})[ \t]*$/.exec(next);
    if(end&&end[1].length>=fence[1].length)break;
    code.push(next);
   }
   blocks.push(`<code>${esc(code.join('\n'))}</code>`);
   continue;
  }
  const header=tableCells(line),divider=header&&tableCells(lines[i]);
  if(divider&&divider.length===header.length&&divider.every(cell=>/^:?-{3,}:?$/.test(cell))){
   i++;
   const cellHTML=(cells,heading)=>cells.map((cell,col)=>{
    const tag=heading?'th':'td',align=divider[col].endsWith(':')?(divider[col].startsWith(':')?'center':'end'):'start';
    return `<${tag}${heading?' scope="col"':''} data-align="${align}">${inline(cell)}</${tag}>`;
   }).join('');
   const rows=[];
   while(i<lines.length){
    const cells=tableCells(lines[i]);
    if(cells?.length!==header.length)break;
    rows.push(`<tr>${cellHTML(cells,false)}</tr>`);i++;
   }
   blocks.push(`<section class="chat-table-scroll" tabindex="0" aria-label="${L('回答中的表格','Table in answer')}"><table><thead><tr>${cellHTML(header,true)}</tr></thead><tbody>${rows.join('')}</tbody></table></section>`);
   continue;
  }
  let item=itemPattern.exec(line);
  if(!item){
   const heading=/^ {0,3}(#{1,3})[ \t]+(\S.*)$/.exec(line);
   blocks.push(heading?`<strong role="heading" aria-level="${heading[1].length+2}">${inline(heading[2])}</strong>`:inline(line));
   continue;
  }
  const list=item[2]?'ol':'ul',items=[];
  while(item){
   const value=item[2]?` value="${Number(item[2])}"`:'';
   items.push(`<li${value}>${inline(item[3])}</li>`);
   item=itemPattern.exec(lines[i]??'');
   if(!item||Boolean(item[2])!==(list==='ol'))break;
   i++;
  }
  blocks.push(`<${list}>${items.join('')}</${list}>`);
 }
 return blocks.join('\n');
}
function modelReceiptHTML(receipt){
 if(!receipt)return '';
 const effort=receipt.effort==='high'?L(' · 高推理',' · High reasoning'):'';
 return `<small class="chat-response-meta" data-no-translate>OpenAI · GPT-6.2 Sol${effort}</small>`;
}
const orb=()=>'<span class="chat-orb" aria-hidden="true"><i></i><i></i></span>';
const label=mode=>({ask:L('交易问答','Trading Q&A'),material:L('投研报告','Research report'),technical:L('解读行情','Read a chart')})[mode];
const prompts=()=>[
 {label:L('BTC 报价','BTC price'),question:L('BTC 现在的现货价格是多少？','What is the current BTC spot price?'),icon:'chart'},
 {label:L('ETH 信号','ETH signals'),question:L('ETH 最新的信号是什么？依据是什么？','What is the latest ETH signal and what supports it?'),icon:'pulse'},
 {label:L('最新快讯','Headlines'),question:L('总结最新的市场快讯，列出来源和发布时间。','Summarize the latest market headlines with their sources and publication times.'),icon:'file'}
];
const followups=()=>[
 ['levels','关键价位在哪里？','Which price levels matter?','关键价位','Key levels'],
 ['rsi','这段行情的 RSI 和动量怎么样？','What do RSI and momentum show in this window?','RSI 动量','RSI momentum'],
 ['trend','这段行情的趋势和均线怎么样？','What do the trend and moving averages show?','趋势结构','Trend'],
 ['risk','这段行情的主要风险是什么？','What are the main risks in this window?','主要风险','Risks'],
 ['news','这段时间有哪些相关消息？','What news matches this window?','同期消息','News']
];
function resultText(result){
 if(!result)return '';const copy=result.cloneNode(true);copy.querySelectorAll('.chat-evidence,.chat-sources,.chat-response-meta,.chat-provenance,button').forEach(el=>el.remove());copy.querySelectorAll('th,td').forEach(el=>el.append('  '));copy.querySelectorAll('.chat-analysis-metrics>div>span').forEach(el=>el.append(': '));copy.querySelectorAll('.chat-analysis-metrics>div').forEach(el=>el.append('\n'));copy.querySelectorAll('.chat-report-kicker,.chat-answer-facts>span,.chat-related li>span,.chat-report-strategies summary>span,.chat-report-strategies details>a').forEach(el=>el.append('\n'));copy.querySelectorAll('small').forEach(el=>el.prepend(' '));copy.querySelectorAll('h3,h4,p,li,section,tr,summary,dt,dd').forEach(el=>el.append('\n'));
 return (copy.textContent||'').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function assistantBars(asset,period='1H'){
 const raw=makeBars(asset.series,'1H');if(period!=='4H')return raw;
 const result=[];for(let i=0;i<raw.length;i+=4){const g=raw.slice(i,i+4);if(g.length<4)break;result.push({time:g.at(-1).time,open:g[0].open,close:g.at(-1).close,high:Math.max(...g.map(b=>b.high)),low:Math.min(...g.map(b=>b.low)),volume:g.reduce((s,b)=>s+b.volume,0)});}return result;
}
const isSimpleGreeting = question => /^(?:(?:hi|hello|hey)(?:[ ,]+(?:can (?:you|u) help(?: me)?))?|can (?:you|u) help(?: me)?|你好|您好|嗨)[!.?！？。\s]*$/i.test(question.trim());

export function createTradingAssistant({root,account,refresh,go,notify,context,returnTo=()=>null,signalSource=()=>null,getTeamContext=()=>null,getWatchKeys=()=>[]}){
 const team=createAssistantTeam({getContext:getTeamContext});
 let exchangeTools=null,exchangeLoadTicket=0,pickerListeners=null;
 const toolSelections=new Map();
 const exchangeIcons={market:'pulse',orderbook:'layers',candles:'chart',funding:'clock',analysis:'compass',account:'credits',positions:'columns',fills:'history'};
 const toolTasks=toolset=>toolset.exchange?Object.fromEntries(EXCHANGE_OPERATIONS.map(id=>[id,{label:EXCHANGE_CAPABILITIES[id],icon:exchangeIcons[id]}])):toolset.tasks;
 async function openExchangeTool(toolset,task,selection){
  const ticket=++exchangeLoadTicket,target=providerDialog;
  try{
   const {createAssistantExchangeTools}=await import('./assistant-exchange-tools.mjs');
   if(ticket!==exchangeLoadTicket||!target?.open||target!==providerDialog)return;
   exchangeTools??=createAssistantExchangeTools({onSource:source=>{capture();if(!attach(source))return false;toolSelections.delete(selected().id);selected().providerTask=null;selected().mode='ask';persist();repaint('[data-chat-input]');providerOrigin=root.querySelector('[data-chat-input]');return true;}});
   exchangeTools.open(target,toolset.brand,task,selection);
  }catch{if(ticket===exchangeLoadTicket&&target?.open)notify(L('交易所工具暂不可用，请稍后重试','Exchange tools are unavailable. Try again shortly'),{tone:'error'});}
 }
 const billingScope=account?.scope||'',key='hive.trading-assistant.v1'+(billingScope?':'+billingScope:'');let sharedToken=typeof location==='undefined'?'':new URLSearchParams(location.hash.slice(1)).get('astarter-share');
 function readStore(){let value;try{value=normalizeChatStore(JSON.parse(localStorage.getItem(key)||(account?.s.scopeType==='personal'?localStorage.getItem('hive.trading-assistant.v1'):null)));}catch{value=normalizeChatStore(null);}for(const thread of value.threads)if(!MARKET.some(a=>a.symbol===thread.asset)){thread.asset='BTC';thread.range=null;}return value;}
 let store=sharedToken?normalizeChatStore(null):readStore();
 let drawerOpen=false,petPrompt=0,storageError=false,restoreScroll=null,sourceDialog=null,origin=null,providerDialog=null,providerOrigin=null,shareDialog=null,shareOrigin=null,shareVersion=0;
 let sharedView=null,sharedLoading=false,sharedError=false,freshTurnId='';
 const selected=()=>store.threads.find(t=>t.id===store.active);
 const sourceReturn=()=>selected()?.sources.at(-1)?.href||selected()?.turns.at(-1)?.sources.at(-1)?.href||returnTo();
 const selectedReport=(thread=selected())=>{const reports=thread.turns.filter(t=>t.mode==='material');return reports.find(t=>t.id===thread.reportId)||reports.at(-1);};
 const newThread=()=>({id:crypto.randomUUID(),at:Date.now(),title:'',pinned:false,mode:'ask',draft:'',sources:[],turns:[],asset:'BTC',period:'1H',providerTask:null,research:normalizeResearchConfig(),reportId:'',reportOpen:true,chartOpen:true});
 const ensureThread=()=>{if(!selected()){const thread=newThread();store.threads.unshift(thread);store.active=thread.id;}};ensureThread();
 function persist(){try{localStorage.setItem(key,JSON.stringify(store));storageError=false;}catch{storageError=true;}}
 function repaint(focus=''){const feed=root.querySelector('.chat-feed');restoreScroll=feed?.scrollTop??null;refresh();if(focus)root.querySelector(focus)?.focus();}
 function repaintAnswer(turn){
  const feed=root.querySelector('.chat-feed');
  const following=turn&&selected()?.turns.at(-1)===turn&&feed&&feed.scrollHeight-feed.scrollTop-feed.clientHeight<=60;
  repaint();
  if(!following)return;
  const updated=root.querySelector('.chat-feed'),answer=root.querySelector('.chat-turn:last-child .chat-answer');
  if(updated&&answer)updated.scrollTop+=Math.max(0,answer.getBoundingClientRect().top-updated.getBoundingClientRect().top-12);
 }
 function capture(){if(sharedToken&&typeof location!=='undefined'&&!new URLSearchParams(location.hash.slice(1)).get('astarter-share')){store=readStore();ensureThread();sharedToken=null;sharedView=null;}const input=root.querySelector('[data-chat-input]');if(input)selected().draft=input.value;const chart=root.querySelector('[data-chart="assistant-window"]');if(chart&&Number(chart.dataset.visibleCount)>0)selected().range={start:Number(chart.dataset.rangeStart),count:Number(chart.dataset.visibleCount)};}
 function startChat(draft=''){
  capture();if(store.threads.length>=CHAT_LIMITS.threads){notify(L('已保留 12 个对话，请选择已有对话继续；记录可以导出。','All 12 chat slots are in use. Continue in an existing chat; records can be exported.'));return false;}
  const thread=newThread();thread.draft=draft;store.threads.unshift(thread);store.active=thread.id;drawerOpen=false;persist();restoreScroll=0;repaint('[data-chat-input]');return true;
 }
 function sourcesHTML(sources,removable=false){return sources.length?`<div class="chat-sources">${sources.map((s,i)=>{
  const params=new URLSearchParams(s.href),currentNews=s.href?.startsWith('?')&&params.get('page')==='intelligence'&&!params.get('story');
  return `<div class="chat-source">${icon(s.kind==='market'?'chart':'file')}<details><summary data-no-translate>${esc(s.title)}</summary><p data-no-translate>${esc(s.text)}</p>${s.href?`<a href="${esc(s.href)}" data-chat-source-link="${esc(s.id)}">${currentNews?L('当前资讯','Current news'):L('打开来源','Open source')} ↗</a>`:''}</details>${removable?`<button type="button" class="chat-icon" data-no-translate data-chat-remove="${i}" aria-label="${esc(L('移除资料：','Remove source: ')+s.title)}">${icon('close')}</button>`:''}</div>`;
 }).join('')}</div>`:'';}
 function materialReply(sources){
  const result=extractMaterial(sources);if(!result.sources)return para(L('先加一段原文，或从数据中心把行情、消息带进来。我会列出原文重点、涉及资产和需要继续确认的地方。','Add an excerpt or bring a market or story from the data center. I can organize the claims, assets and missing information.'));
  return `<h3>${L('先把资料拆清楚','What the sources actually say')}</h3><div class="chat-answer-facts"><span>${result.sources} ${L('份资料','sources')}</span><span>${result.assets.length?esc(result.assets.join(' · ')):L('未识别资产','No asset identified')}</span><span>${result.characters} ${L('字','characters')}</span></div><ol class="chat-claims">${result.claims.map(c=>`<li><span data-no-translate>${esc(c.text)}</span><button type="button" class="chat-citation" data-chat-citation="${c.source}" aria-label="${L('查看资料','View sources')} ${c.source+1}">[${c.source+1}]</button></li>`).join('')}</ol>${result.numbers.length?`<div class="chat-number-row"><span>${L('原文数字','Numbers in the text')}</span>${result.numbers.map(x=>`<b>${esc(x)}</b>`).join('')}</div>`:''}<h4>${L('接下来确认什么','What to check next')}</h4>${para(result.hasTransfer?L('资料里有资金转移。先分清普通转账、交易所充值和真实成交，再判断是否存在买卖压力。','The sources mention a transfer. Distinguish transfers, exchange deposits and actual trades before inferring buying or selling pressure.'):L('补齐原始出处、发布时间和独立来源，再与价格、成交量对照。这里只摘取原文，没有替它验证真伪。','Check the original source, publication time and independent corroboration, then compare price and volume. This extraction does not verify the claims.'))}<details class="chat-evidence"><summary>${L('查看资料','View sources')}</summary>${sourcesHTML(sources)}</details>`;
 }
 const dateTime=time=>researchDate(time).replace('T',' ');
 const trendName=value=>({rising:L('偏强','Stronger'),falling:L('偏弱','Weaker'),range:L('震荡','Range-bound')})[value]||'—';
 function assetOptions(items,selected=''){
  const keys=getWatchKeys(),tracked=items.filter(([id])=>(Array.isArray(keys)?keys:[]).some(key=>sameWatchAssetKey(key,id)));
  const option=([id,name])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(name)}</option>`;
  if(!tracked.length)return items.map(option).join('');
  const ids=new Set(tracked.map(([id])=>id));
  return [[L('我的追踪','My watchlist'),tracked],[L('其它资产','Other assets'),items.filter(([id])=>!ids.has(id))]].filter(([,rows])=>rows.length).map(([label,rows])=>`<optgroup label="${label}">${rows.map(option).join('')}</optgroup>`).join('');
 }
 const watchManageButton=text=>`<button type="button" class="chat-watch-manage" data-chat-watchlist aria-label="${L('管理追踪','Manage watchlist')}" title="${L('管理追踪','Manage watchlist')}">${icon('sliders')}${text?`<span>${L('管理追踪','Manage watchlist')}</span>`:''}</button>`;
 function researchSummary(config){const assets=researchAssets(config);return config.scope==='market'?L('全市场','All markets')+` · ${assets.length}`:config.scope==='sectors'?config.sectors.map(s=>L(...RESEARCH_OPTIONS.sectors[s])).join(' / '):config.assets.join(' / ');}
 function reportBuilder(){
  const thread=selected(),c=thread.research||normalizeResearchConfig(),assets=researchAssets(c),open=thread.reportOpen!==false,valid=(()=>{try{researchRange(c);return assets.length>0;}catch{return false;}})();
  const options=items=>Object.entries(items).map(([value,labels])=>`<option value="${value}" ${c.scope===value||c.focus===value?'selected':''}>${L(...labels)}</option>`).join('');
  return `<section class="chat-report-builder"><header><div>${icon('file')}<div><strong>${open?L('投研报告','Research report'):L('研究设置','Research settings')}</strong>${!open?`<span class="chat-report-preset">${esc(researchSummary(c))} · ${c.window==='custom'?esc(c.start.slice(0,10))+'–'+esc(c.end.slice(0,10)):c.window.toUpperCase()} · ${L(...RESEARCH_OPTIONS.focus[c.focus])}</span>`:''}</div></div><div class="chat-report-builder-actions"><button type="button" class="chat-inline-action" data-report-toggle aria-expanded="${open}" aria-label="${open?L('收起','Collapse'):L('调整研究范围','Edit research scope')}"><span class="chat-report-label-long">${open?L('收起','Collapse'):L('调整研究范围','Edit research scope')}</span><span class="chat-report-label-short">${open?L('收起','Collapse'):L('调整','Edit')}</span>${icon('chevron')}</button><button type="button" class="p-button p-primary" data-report-generate aria-label="${L('生成报告','Generate report')}" ${valid?'':'disabled'}><span class="chat-report-label-long">${L('生成报告','Generate report')}</span><span class="chat-report-label-short">${L('生成','Generate')}</span>${icon('arrow')}</button></div></header>${open?`<div class="chat-report-fields"><div class="chat-report-field chat-report-universe"><div class="chat-watch-label"><label for="report-scope">${L('研究范围','Research scope')}</label>${watchManageButton(true)}</div><div class="chat-report-scope"><select id="report-scope" data-report-field="scope">${options(RESEARCH_OPTIONS.scopes)}</select>${c.scope!=='market'?`<select data-report-add aria-label="${L(c.scope==='assets'?'添加交易标的':'添加赛道板块',c.scope==='assets'?'Add an asset':'Add a sector')}"><option value="">${L(c.scope==='assets'?'添加交易标的':'添加赛道板块',c.scope==='assets'?'Add an asset':'Add a sector')} +</option>${c.scope==='assets'?assetOptions(MARKET.filter(a=>!c.assets.includes(a.symbol)).map(a=>[a.symbol,a.symbol+' · '+L(a.name,translate(a.name,'en'))])):Object.entries(RESEARCH_OPTIONS.sectors).filter(([id])=>!c.sectors.includes(id)).map(([id,labels])=>`<option value="${esc(id)}">${esc(L(...labels))}</option>`).join('')}</select>`:`<span>${assets.length} ${L('项资产','assets')}</span>`}</div>${c.scope!=='market'?`<div class="chat-report-chips">${(c.scope==='assets'?c.assets:c.sectors).map(id=>`<button type="button" data-report-remove="${esc(id)}" aria-label="${L('移除','Remove')} ${esc(id)}">${c.scope==='assets'?tokenIcon(id,{size:19}):''}${esc(c.scope==='assets'?id:L(...RESEARCH_OPTIONS.sectors[id]))}${icon('close')}</button>`).join('')}<span>${(c.scope==='assets'?c.assets:c.sectors).length}/${c.scope==='assets'?5:3}</span></div>`:''}</div><div class="chat-report-field"><label for="report-window">${L('研究时间','Research period')}</label><select id="report-window" data-report-field="window">${[['24h','最近 24 小时','Last 24 hours'],['7d','最近 7 天','Last 7 days'],['30d','最近 30 天','Last 30 days'],['custom','自定义时间','Custom dates']].map(([id,z,en])=>`<option value="${id}" ${c.window===id?'selected':''}>${L(z,en)}</option>`).join('')}</select>${c.window==='custom'?`<div class="chat-report-dates"><label>${L('开始','From')}<input type="datetime-local" data-report-field="start" value="${esc(c.start)}" aria-label="${L('研究开始时间 UTC+8','Research start UTC+8')}"></label><label>${L('结束','To')}<input type="datetime-local" data-report-field="end" value="${esc(c.end)}" aria-label="${L('研究结束时间 UTC+8','Research end UTC+8')}"></label></div>`:`<span class="chat-report-date">${esc(c.start.replace('T',' '))} → ${esc(c.end.replace('T',' '))} UTC+8</span>`}</div><div class="chat-report-field"><label for="report-focus">${L('研究重点','Research focus')}</label><select id="report-focus" data-report-field="focus">${options(RESEARCH_OPTIONS.focus)}</select></div><fieldset class="chat-report-field"><legend>${L('报告篇幅','Report length')}</legend><div class="chat-report-length" role="group" aria-label="${L('报告篇幅','Report length')}">${[['brief','简报','Brief'],['full','详报','Full']].map(([id,z,en])=>`<button type="button" data-report-depth="${id}" aria-pressed="${c.depth===id}">${L(z,en)}</button>`).join('')}</div></fieldset></div>`:''}${open?`<footer><div class="chat-report-bases"><span>${L('样例截至','Sample as of')} ${dateTime(RESEARCH_AS_OF)} UTC+8</span></div></footer>`:''}${open?`<div class="chat-report-source-actions"><button type="button" class="p-button" data-chat-add>${icon('plus')}${L('补充资料','Add sources')}</button><label class="p-button chat-upload">${icon('attach')}${L('添加文本文件','Add a text file')}<input type="file" data-chat-file accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"></label></div>`:`<input type="file" data-chat-file hidden accept=".txt,.md,.csv,.json">`}${sourcesHTML(thread.sources,true)}${!valid?`<p class="chat-report-warning" role="status">${L(assets.length?'开始时间需早于结束时间':'至少选择一项交易标的或板块',assets.length?'Start must be earlier than end':'Choose at least one asset or sector')}</p>`:''}</section>`;
 }
 function reportRecords(){
  const thread=selected(),reports=thread.turns.filter(t=>t.mode==='material'),current=selectedReport(thread);if(!reports.length)return '';
  return `<div class="chat-report-records"><label><span>${L('报告记录','Report history')}</span><select data-report-record aria-label="${L('已存报告','Saved reports')}">${reports.map((turn,i)=>`<option value="${esc(turn.id)}" ${turn.id===current?.id?'selected':''}>#${i+1} · ${esc(turn.report?researchSummary(turn.report.config)+' · '+L(...RESEARCH_OPTIONS.focus[turn.report.config.focus]):L('资料分析','Source analysis'))}</option>`).join('')}</select></label>${current?.report?`<button type="button" class="chat-inline-action" data-report-reuse>${L('使用这份设置','Use these settings')}${icon('arrow')}</button>`:''}</div>`;
 }
 function relatedContextHTML(evidence,full=false){
  const news=evidence?.news||[],signals=evidence?.signals||[];
  return `<section class="chat-related"><h4>${L('消息与资金线索','News & flow evidence')}</h4>${!news.length&&!signals.length?para(L('所选资产与时间内没有匹配的消息或信号记录。','No news or signal records match this asset and time range.')):`<ul>${news.slice(0,full?6:2).map(item=>`<li><span>${dateTime(item.at)} UTC+8 · ${L('消息','News')}</span><a href="${esc(item.href)}">${esc(L(item.title,translate(item.title,'en')))} ↗</a>${full?para(L(item.body,translate(item.body,'en'))):''}</li>`).join('')}${signals.slice(0,full?8:3).map(item=>`<li><span>${esc(item.asset)} · ${dateTime(item.at)} UTC+8 · ${L('AI 信号','AI signals')}</span><a href="${esc(item.href)}">${esc(L(...item.title))} ↗</a>${full?para(L(...item.reason)):''}</li>`).join('')}</ul>${para(L('同一时段的情景记录，用于对照，不代表消息导致了价格变化。','These are contemporaneous scenario records for comparison; they do not establish a cause of price movement.'))}`}</section>`;
 }
 function reportReply(report){
  if(!report)return '';const {config:c,rows}=report,complete=rows.filter(r=>r.analysis),rising=complete.filter(r=>r.analysis.trend==='rising').length,falling=complete.filter(r=>r.analysis.trend==='falling').length,partial=rows.some(r=>r.coverage!=='full'),full=c.depth==='full';
  const technical=`<section><h4>${L('行情对照','Market comparison')}</h4><div class="chat-report-table-wrap"><table class="chat-report-table" role="table"><thead><tr><th>${L('资产','Asset')}</th><th>${L('区间涨跌','Window return')}</th><th>${L('技术结构','Technical structure')}</th><th>${L('区间低点 / 高点','Window low / high')}</th></tr></thead><tbody>${rows.slice(0,full?40:8).map(r=>`<tr><th><a href="?page=markets&asset=${r.asset}">${tokenIcon(r.asset,{size:20})}${esc(r.asset)}</a></th><td data-label="${L('区间涨跌','Window return')}" class="${r.analysis?.change>=0?'up':'down'}">${r.analysis?(r.analysis.change>=0?'+':'')+n(r.analysis.change)+'%':'—'}</td><td data-label="${L('技术结构','Structure')}">${r.analysis?trendName(r.analysis.trend):L('K 线不足','Insufficient candles')}${r.analysis&&c.focus==='technical'?`<small>RSI ${r.analysis.rsi==null?'—':n(r.analysis.rsi,1)} · MA5 ${price(r.analysis.ma5)}</small>`:''}</td><td data-label="${L('区间低点 / 高点','Window low / high')}">${r.analysis?price(r.analysis.low)+' / '+price(r.analysis.high):'—'}<small>${esc(L(r.unit,({'点':'pts','USD/盎司':'USD/oz'})[r.unit]||r.unit))}${r.coverage!=='full'?' · '+L('覆盖不足','Partial coverage'):''}</small></td></tr>`).join('')}</tbody></table></div>${rows.length>8&&!full?para(L(`已对照 ${rows.length} 项资产，上表列出前 8 项。切换详报查看全部。`,`Compared ${rows.length} assets; the table shows the first 8. Choose Full to see all.`)):''}</section>`;
  const strategies=`<section class="chat-report-strategies"><h4>${L('策略适用性','Strategy fit')}</h4>${report.strategies.length?report.strategies.slice(0,full?6:2).map(s=>`<details ${c.focus==='strategy'?'open':''}><summary><span>${esc(s.id)} · ${esc(L(s.name,translate(s.name,'en')))}</span><span>${esc(s.symbol)}</span></summary><dl><div><dt>${L('执行周期','Execution timeframe')}</dt><dd>${esc(L(s.timeframe,translate(s.timeframe,'en')))}</dd></div><div><dt>${L('入场条件','Entry conditions')}</dt><dd>${esc(L(...s.entry))}</dd></div><div><dt>${L('退出与保护','Exits & protection')}</dt><dd>${esc(L(...s.exit))}</dd></div><div><dt>${L('当前可用性','Availability')}</dt><dd>${esc(L(...s.need))}</dd></div></dl><a href="${s.href}">${L('去策略广场','Open strategies')} ↗</a></details>`).join(''):para(L('策略库中没有与所选标的匹配的原生方案，未套用其它标的参数。','No native strategy matches the selected assets; parameters from other assets have not been applied.'))}</section>`;
  return `<div class="chat-report-result"><div class="chat-report-kicker">${L('投研报告','Research report')} · ${L(...RESEARCH_OPTIONS.focus[c.focus])} · ${L(full?'详报':'简报',full?'Full':'Brief')}</div><h3 class="chat-report-title">${c.scope==='assets'?c.assets.map(asset=>`<span>${tokenIcon(asset,{size:24})}${esc(asset)}</span>`).join(' '):esc(researchSummary(c))}</h3><div class="chat-answer-facts"><span>${esc(c.start.replace('T',' '))} → ${esc(c.end.replace('T',' '))} UTC+8</span><span>${L('样例截至','Sample as of')} ${dateTime(report.asOf)} UTC+8</span></div>${partial?`<p class="chat-report-warning">${L('所选时间超出样例覆盖范围；以下仅使用有记录的区间，缺失部分未补算。','The requested period exceeds sample coverage. Only recorded intervals are used; missing data has not been filled in.')}</p>`:''}<section class="chat-report-conclusion"><h4>${L('区间结论','Window summary')}</h4>${complete.length?`<dl class="chat-report-overview"><div><dt>${L('覆盖资产','Assets covered')}</dt><dd>${complete.length}</dd></div><div><dt>${L('偏强','Stronger')}</dt><dd>${rising}</dd></div><div><dt>${L('震荡','Range-bound')}</dt><dd>${complete.length-rising-falling}</dd></div><div><dt>${L('偏弱','Weaker')}</dt><dd>${falling}</dd></div></dl>`:''}${complete.length?'':para(L('这段时间没有足够 K 线形成技术结论。请调整时间，或补充对应时期的资料。','There are not enough candles for a technical conclusion. Change the dates or add sources from that period.'))}</section>${c.focus==='news'?relatedContextHTML(report,full):c.focus==='strategy'?strategies:technical}${c.focus==='news'?technical:c.focus==='strategy'?technical:relatedContextHTML(report,full)}${c.focus!=='strategy'?strategies:''}<details class="chat-evidence"><summary>${L('数据依据与待确认项','Sources & remaining gaps')}</summary><p>${L('行情仅使用时间区间内完整的 1H 样例 K 线，技术结构对照最近5根与最多20根收盘均值；消息和信号按资产及发生时间匹配。策略规则不表示入场已满足或实盘已验证。','Uses only complete 1H demo candles within the requested interval; structure compares the last 5 closes with up to 20 closes. News and signals are matched by asset and event time. Strategy rules are not confirmed entries or verified live performance.')}</p>${rows.filter(r=>r.analysis).map(r=>`<p>${esc(r.asset)} · ${r.count} ${L('根 K 线','candles')} · ${dateTime(r.analysis.start)} → ${dateTime(r.analysis.end)} UTC+8${full&&r.volume24h!=null?' · '+L('截止时点的 24h 成交额','24h volume at cutoff')+' '+n(r.volume24h,0)+' '+L('百万 USD','million USD'):''}</p>`).join('')}<p>${L('仍需核对最新行情、原始新闻、交易成本与策略运行门槛。','Current quotes, original news, trading costs and strategy readiness still need verification.')}</p></details></div>`;
 }
 function technicalReply(t,turn={}){
  if(!t)return para(L('选择资产和一段 K 线，再点“分析这段行情”。','Choose an asset and a candle window, then select “Analyze this window”.'));
  const rawUnit=t.clockKind==='wall'?'USDT':MARKET.find(a=>a.symbol===t.asset)?.unit||'USD',unit=L(rawUnit,({'点':'pts','USD/盎司':'USD/oz'})[rawUnit]||rawUnit);
  const trend=({rising:L('短线偏强','Short-term strength'),falling:L('短线偏弱','Short-term weakness'),range:L('暂未形成清晰方向','No clear direction yet')})[t.trend]||L('等待更多数据','More data needed');
  if(turn.followup||(!turn.generatedQuestion&&technicalIntent(turn.question)!=='overview')){
   const intent=technicalIntent(turn.question),titles={levels:L('关键价位','Key levels'),rsi:L('动量与 RSI','Momentum & RSI'),trend:L('趋势与均线','Trend & moving averages'),risk:L('风险与失效条件','Risks & invalidation'),news:L('同期消息','News from this window'),unsupported:L('指标数据不足','Indicator data unavailable'),overview:L('继续解读','Continue analysis')};let body='';
   if(intent==='news')body=relatedContextHTML(turn.marketContext,true);
   else if(intent==='rsi')body=t.rsi==null?para(L(`当前只有 ${t.count} 根 K 线，RSI(14) 至少需要 15 根完整 K 线。请扩大观察区间后重新分析。`,`There are ${t.count} candles; RSI(14) requires at least 15 complete candles. Widen the window and analyze it again.`)):`<div class="chat-rsi-reading"><strong>RSI(14) <b>${n(t.rsi,1)}</b></strong><span>${t.rsi>70?L('高位区间','Upper range'):t.rsi<30?L('低位区间','Lower range'):L('中间区间','Middle range')}</span></div>${para(t.rsi>70?L('RSI 高于 70，动量较强，进入常用的超买观察区。它不能单独确认顶部或做空时机，需继续看价格能否站稳区间高点。','RSI is above 70, in the commonly used overbought observation zone. This alone does not confirm a top or a short entry; watch whether price holds above the window high.'):t.rsi<30?L('RSI 低于 30，动量偏弱，进入常用的超卖观察区。它不能单独确认底部或抄底时机，需继续看价格是否收回关键边界。','RSI is below 30, in the commonly used oversold observation zone. This alone does not confirm a bottom or a long entry; watch whether price reclaims the key boundaries.'):L('RSI 位于 30–70，未进入常用的超买或超卖观察区。方向仍需结合均线位置与区间高低点判断。','RSI is between 30 and 70, outside the commonly used overbought and oversold zones. Combine it with moving averages and the window boundaries.'))}<details class="chat-evidence"><summary>${L('指标口径','Indicator definition')}</summary><p>RSI(14) · Wilder · ${t.count} ${L('根 K 线','candles')}</p><a href="https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/" target="_blank" rel="noopener noreferrer">${L('RSI 参考','RSI reference')} ↗</a></details>`;
   else if(intent==='levels')body=`<div class="chat-analysis-metrics"><div><span>${L('区间低点','Window low')}</span><strong>${price(t.low)}</strong></div><div><span>${L('当前收盘','Window close')}</span><strong>${price(t.close)}</strong></div><div><span>${L('区间高点','Window high')}</span><strong>${price(t.high)}</strong></div></div>${para(L(`价格上破 ${price(t.high)} 或下破 ${price(t.low)} 时，先看 ${t.period} 收盘是否确认。这里是所选窗口的价格边界，不是已经验证的支撑、阻力或委托价。`,`Watch for a confirmed ${t.period} close above ${price(t.high)} or below ${price(t.low)}. These are window boundaries, not validated support, resistance or order prices.`))}`;
   else if(intent==='risk')body=para(L(`这段行情振幅为 ${n(t.rangePct)}%，价格边界为 ${price(t.low)}–${price(t.high)}。突破后回到区间内、跳空与滑点，都可能使预期失效。具体止损和止盈需按所用策略的原定规则确认，不能直接把区间边界当成委托价。`,`The window spans ${n(t.rangePct)}%, with boundaries at ${price(t.low)}–${price(t.high)}. A failed breakout, gaps and slippage can invalidate an expectation. Use the selected strategy’s own stop and take-profit rules; window boundaries are not order prices.`));
   else if(intent==='unsupported')body=para(L('当前窗口只计算了 MA5、MA20、RSI(14) 和价格区间，没有这个指标的数据。可以先查看这些已计算的指标，或补充对应的指标资料。','This window contains MA5, MA20, RSI(14) and price-range calculations. The requested indicator is unavailable. Use the calculated indicators or add the relevant indicator data.'));
   else body=(t.count<20?para(L(`当前只有 ${t.count} 根 K 线，不足以计算完整 MA20。MA${t.count} 仅作为本区间参考。`,`Only ${t.count} candles are available, so a full MA20 cannot be calculated. MA${t.count} is a window reference only.`)):'')+para(L(`这段 ${t.period} 行情${trend}。MA5 为 ${price(t.ma5)}，MA${Math.min(20,t.count)} 为 ${price(t.ma20)}，收盘价为 ${price(t.close)}。${t.ma5>t.ma20?'短均线位于长均线上方':'短均线未高于长均线'}；这只是该窗口的结构，不能单独确认反转或策略入场。`,`This ${t.period} window shows ${trend.toLowerCase()}. MA5 is ${price(t.ma5)}, MA${Math.min(20,t.count)} is ${price(t.ma20)}, and the close is ${price(t.close)}. The short average ${t.ma5>t.ma20?'is above':'is not above'} the long average. This describes the selected window, not a confirmed reversal or strategy entry.`));
   return `<h3>${esc(t.asset)} · ${titles[intent]}</h3><div class="chat-answer-facts"><span>${esc(t.period)} · ${dateTime(t.start)} → ${dateTime(t.end)} UTC+8</span><span>${L('计价','Unit')}: ${esc(unit)}</span><span>${turn.followup?L('沿用上一段行情','Same candle window'):L('选定行情区间','Selected candle window')} · ${t.clockKind==='wall'?'Binance Spot':L('历史样例','Historical example')}</span></div>${body}`;
  }
  return `<h3>${esc(t.asset)} · ${trend}</h3><div class="chat-answer-facts"><span>${esc(t.period)} · ${t.count} ${L('根 K 线','candles')}</span><span>${dateTime(t.start)} → ${dateTime(t.end)} UTC+8</span><span>${L('计价','Unit')}: ${esc(unit)}</span><span>${t.clockKind==='wall'?'Binance Spot · '+L('已收盘 K 线','Closed candles'):L('样例行情 · 本地计算','Demo candles · local calculation')}</span></div><div class="chat-analysis-metrics"><div><span>${L('区间涨跌','Window return')}</span><strong class="${t.change>=0?'up':'down'}">${t.change>=0?'+':''}${n(t.change)}%</strong></div><div><span>${L('区间低点','Window low')}</span><strong>${price(t.low)}</strong></div><div><span>${L('区间高点','Window high')}</span><strong>${price(t.high)}</strong></div></div>${para(L(`这段区间从 ${price(t.open)} 运行到 ${price(t.close)}。最近 5 根收盘均价为 ${price(t.ma5)}，最近 ${Math.min(20,t.count)} 根为 ${price(t.ma20)}。`, `This window moves from ${price(t.open)} to ${price(t.close)}. The last 5 closes average ${price(t.ma5)}; the last ${Math.min(20,t.count)} average ${price(t.ma20)}.`))}<h4>${L('接下来盯哪里','Levels to watch')}</h4>${para(L(`先看价格能否在区间高点 ${price(t.high)} 上方收稳，回落时关注低点 ${price(t.low)} 是否守住。这里的高低点是所选区间的边界，不是保证有效的支撑或阻力。`, `Watch for a confirmed close above ${price(t.high)}, or a move below ${price(t.low)}. These are the selected window’s boundaries, not guaranteed support or resistance.`))}<details class="chat-evidence"><summary>${L('查看计算依据','Calculation details')}</summary><dl><div><dt>MA5 / MA${Math.min(20,t.count)}</dt><dd>${price(t.ma5)} / ${price(t.ma20)}</dd></div><div><dt>RSI(14) · Wilder</dt><dd>${t.rsi==null?L('至少需要 15 根 K 线','At least 15 candles required'):n(t.rsi)}</dd></div><div><dt>${L('区间振幅','Window range')}</dt><dd>${n(t.rangePct)}%</dd></div></dl>${para(t.clockKind==='wall'?L('按选定窗口的已收盘 K 线计算；已固定原始价格、周期和来源，后续行情不会改写这份解读。','Calculated from closed candles in the selected window. Prices, interval and source are frozen for this analysis.'):L('只使用选中的样例 K 线与同时段的站内情景记录；未接实时行情，不会触发交易。','Uses selected demo candles and contemporaneous site scenario records. Live data is not connected and no trade is triggered.'))}</details>${relatedContextHTML(turn.marketContext)}`;
 }
 function quoteReply(quotes){
  return quotes.map(q=>{
   const instrument=assistantQuoteInstrument(q.symbol);
   if(!instrument)return '';
   const {market,source,unit,resource}=instrument,title=esc(market)+' · '+(resource==='cross-candles'?L('最近已收盘日线','Last closed session'):L('报价快照','Quote snapshot'));
   if(q.state==='pending')return `<h3>${title}</h3><p role="status">${esc(source)} · ${L('正在查询公开行情…','Reading the public quote…')}</p>`;
   if(q.state!=='observed')return `<h3>${title}</h3>${para(q.state==='stale'?L(`${source} 上次更新于 ${hubSourceTime(q.asOf)}，当前报价已过期。`,`The last ${source} update was ${hubSourceTime(q.asOf)}. A current quote is unavailable.`):L(`${source} 暂时没有返回这个标的的有效报价。`,`${source} has no verified quote for this instrument right now.`))}`;
   return `<h3>${title}</h3><div class="chat-answer-facts"><span>${esc(source)}</span><span>${L(resource==='cross-candles'?'收盘时间':'来源时间',resource==='cross-candles'?'Session close':'Source time')} · ${hubSourceTime(q.asOf)}</span></div><p><strong>${price(q.price)} ${esc(unit==='index'?L('点','pts'):unit)}</strong>${q.change==null?'':' · 24h '+(q.change>0?'+':'')+n(q.change)+'%'}</p>`;
  }).join('');
 }
 function questionReply(turn){
  if(turn.quotes?.length)return quoteReply(turn.quotes);
  const topic=turn.topic||questionTopic(translate(turn.question,'en')),sources=turn.sources,asset=MARKET.find(a=>new RegExp('\\b'+a.symbol+'\\b','i').test(turn.question))||MARKET.find(a=>sources.some(s=>s.title.includes(a.symbol)))||MARKET[0];
  const c=turn.context||{};
  const replies={
   credits:[L('这次聊天不消耗积分','This chat uses no credits'),L(`规则和计费说明免费。新增分析会先显示报价，查看已有结果不重复扣费。当前可用 ${c.available??0}，暂占 ${c.reserved??0}，已用 ${c.spent??0}。从数据页启动深度研究是另一项任务，确认前会列出最多占用的积分。`,`Rule and billing explanations are free. New analysis requires a quote; existing results are free to reopen. At the time of this message: ${c.available??0} available, ${c.reserved??0} held and ${c.spent??0} used. A separate deep-research task shows its credit allowance before confirmation.`),'usage',L('积分记录','Credit history')],
   risk:[L('先定好最多能用多少钱','Start with a spending limit'),L('账户上限控制总投入，策略保护控制单次买入和退出条件。暂停买入不会自动卖出已有持仓。可以到资金保护查看当前规则，再决定是否修改。','The account limit caps allocation; strategy protection controls individual entries and exits. Pausing buys does not sell existing holdings. Review the active rules in capital protection.'),'risk',L('查看资金保护','View capital protection')],
   strategy:[L('先看适合什么行情，再看参数','Match the market before changing parameters'),L('趋势策略等待方向延续；网格策略依赖有边界的区间。把适用行情、总预算和退出条件一起确认，再用模拟运行观察，不能只看一个指标。','Trend strategies look for continuation; grids rely on a bounded range. Review market fit, total allocation and exits together, then observe a simulation. A single indicator is insufficient.'),'strategies',L('去策略广场','Open strategies')],
   chain:[L('先辨认发生了什么，再判断含义','Identify the event before interpreting it'),L('链上转账不等于买卖。先查交易类型、地址标签、前后余额和时间，再与现货成交对照；缺少归属信息时保留未知。','A transfer is not a trade. Check transaction type, address labels, balance changes and time, then compare spot trades. Keep attribution unknown when evidence is missing.'),'tracking',L('查看链上追踪','Open on-chain tracking')],
   news:[L('先把消息和市场反应分开','Separate the news from the market reaction'),L('先确认原始出处与发布时间，剔除重复转发，再比较消息前后的价格和成交量。可以把一条消息带到这里，逐项整理原文和待确认的地方。','Verify the original source and time, remove duplicate posts, then compare price and volume around the event. Bring a story here to organize its claims and missing context.'),'intelligence',L('查看宏观消息','Open macro news')],
   returns:[L('可以帮你持续观察，不能保证赚钱','Monitoring can help; returns are not guaranteed'),L('策略需要在成本、风险限制和实际成交条件下评估；已有样例表现不能代表未来收益。','Evaluate costs, risk limits and fill conditions; sample behavior does not establish future returns.'),'my-strategies',L('查看我的策略','Open my strategies')],
   help:[L('可以直接问','Ask a specific question'),L('日常问答不消耗积分。可以直接问行情、消息、策略、风险或链上问题，也可以切到「解读行情」或「投研报告」。','General questions are free. Ask about markets, news, strategy, risk or on-chain activity, or switch to “Read a chart” or “Research report”.'),'',''],
   market:[L('这条历史回答未保存报价','No quote was saved with this reply'),L('重新提问可查看当前行情。','Ask again to see current market data.'),'','']
  };
  if(topic==='market'&&!sources.length&&!turn.billingJob){
   return para(L('这条历史回答未保存报价。','No quote was saved with this reply.'))+`<button type="button" class="chat-inline-action" data-chat-repeat="${esc(turn.id)}">${L('重新提问','Ask again')}</button>`;
  }
  const [title,body,page,action]=replies[topic];return `<h3>${esc(title)}</h3>${para(body)}${sources.length?materialReply(sources):''}${page?`<button type="button" class="chat-inline-action" data-chat-go="${page}">${esc(action)} ↗</button>`:''}`;
 }
 function providerReply(turn){
  const task=BINANCE_AGENT_OS.tasks[turn.providerTask];
  return `<div class="chat-provider-label">${venueIcon('binance',{size:16})}<b>Binance</b><span>${L('未接入','Not integrated')}</span></div><h3>${L(...task.label)}</h3>${para(L('当前还不能读取这项 Binance 数据。可以查看连接说明，或用现有资料继续分析。','This Binance data is not connected yet. Read the connection guide, or continue with your existing sources.'))}<div class="chat-provider-actions"><button type="button" class="chat-inline-action" data-chat-local="${esc(turn.id)}">${L('分析资料','Analyze sources')}${icon('arrow')}</button><button type="button" class="chat-inline-action" data-chat-go="${task.page}">${L('打开工作区','Open workspace')}${icon('arrow')}</button><a href="${BINANCE_AGENT_OS.docs}" target="_blank" rel="noopener noreferrer">${L('连接说明','Connection guide')} ↗</a></div>`;
 }
 const delivered=turn=>turn.modelReply?turn.modelReply.state==='complete':turn.quotes?turn.quotes.every(q=>q.state!=='pending'):!turn.billingJob||account?.scope===billingScope&&account?.s.tasks.find(job=>job.id===turn.billingJob)?.status==='complete';
 const taskLink=(turn,text)=>{const href=commerceContextLink({taskId:turn.billingJob},'usage');return href?`<a class="chat-inline-action" data-commerce-context href="${esc(href)}">${text}</a>`:`<button type="button" class="chat-inline-action" data-chat-go="usage">${text}</button>`;};
 function marketRuleSummary(evidence){
  const readings=evidence?.filter(row=>row.status==='observed' && row.asOf && row.symbol && ['quote','signal'].includes(row.kind))||[];
  if(!readings.length)return '';
  const lines=readings.map(row=>{
   const fields=row.text.split(' · ');
   return `<li>${esc(row.title)} · ${esc(fields[0])}<br><small>${esc(fields.at(-1))} · ${esc(hubSourceTime(row.asOf))}</small></li>`;
  }).join('');
  const limit=readings.some(row=>row.kind==='signal')?L('短周期动量只描述近期变化，单靠这些读数无法确认入场时机。','Short-term momentum describes recent moves. These readings alone cannot confirm an entry point.'):L('报价是一个时间点的记录，单靠这个价格无法判断买卖时机。','A quote records one point in time. Price alone cannot establish when to buy or sell.');
  return `<div class="chat-market-rule-summary"><strong>${L('行情摘要 · 规则解读','Market summary · Rule-based')}</strong><ul>${lines}</ul>${para(limit)}</div>`;
 }
 function evidenceHTML(turn){
  const display=turn.evidence?.filter(item=>item.status!=='unavailable');
  if(!display?.length)return '';
  const rows=display.map(item=>{
   const when=item.asOf?`<time datetime="${new Date(item.asOf).toISOString()}">${esc(hubSourceTime(item.asOf))}</time>`:'';
   const title=esc(item.title),link=item.sourceUrl||item.href;
   const label=item.turnId?`<button type="button" class="chat-inline-action" data-chat-reference="${esc(item.turnId)}">${title} ↗</button>`:link?`<a href="${esc(link)}" ${item.sourceUrl?'target="_blank" rel="noopener noreferrer"':''}>${title} ↗</a>`:title;
   return `<li><div>${label}${when}</div><p data-no-translate>${esc(item.text)}</p></li>`;
  }).join('');
  const list=`<ul class="chat-answer-evidence">${rows}</ul>`;
  return turn.evidenceReply?list:`<details class="chat-answer-references"${turn.modelReply?.state==='error'&&turn.evidence.some(item=>item.status==='observed')?' open':''}><summary>${L('参考资料','Sources')} · ${display.length}</summary>${list}</details>`;
 }
 function reply(turn){
  const turns=selected()?.turns||[],index=turns.indexOf(turn);
  const replyQuestion=index>0&&turns[index-1].needsMarketAsset?assistantDecisionContext(turn.question,turns.slice(0,index)).question:turn.question;
  const locale=questionLanguage(replyQuestion);
  return locale?forceLocale(locale,()=>renderReply(turn)):renderReply(turn);
 }
 function renderReply(turn){
  if(turn.localRecall){
   const turns=selected()?.turns||[],index=turns.indexOf(turn);
   const text=index>0?explicitThreadRecall(turn.question,turns.slice(0,index)):null;
   return `<div class="chat-local-recall" data-no-translate style="white-space:pre-wrap">${esc(text??L('这段对话里找不到原消息。','The original message is unavailable in this chat.'))}</div>`;
  }
  if(turn.needsMarketAsset)return para(L('你想看哪个标的？可以回复币名或交易对。','Which asset should I look at? Enter its name or trading pair.'));
  if(turn.evidenceReply)return evidenceHTML(turn);
  if(turn.modelReply){
   const {state,text,code}=turn.modelReply;
   if(state==='complete'){
    const last=selected()?.turns.at(-1)===turn;
    const more=turn.modelReply.truncated?`<p class="chat-source-note chat-continuation">${L('本条回答已达长度上限。','This reply reached its length limit.')}${last?` <button type="button" class="chat-inline-action" data-chat-continue="${esc(turn.id)}">${L('继续回答','Continue reply')}${icon('arrow')}</button>`:''}</p>`:'';
    return `<div class="chat-model-answer" data-no-translate>${modelAnswerHTML(text,turn.evidence)}</div>`+modelReceiptHTML(turn.modelReply.receipt)+more+evidenceHTML(turn);
   }
   if(state==='pending')return `<div class="chat-model-status" role="status"><span class="chat-task-indicator" aria-hidden="true"></span>${L('正在回答…','Thinking…')}</div>`+evidenceHTML(turn);
   const reason={
    INTERRUPTED:L('上次回答被中断了。','The previous reply was interrupted.'),
    UNCONFIGURED:L('模型服务尚未就绪。','The model service is not ready.'),
    RATE_LIMITED:L('模型繁忙，请稍后重试。','The model is busy. Try again shortly.'),
    MODEL_TIMEOUT:L('等待模型回复超时。','The model took too long to respond.'),
    REQUEST_INVALID:L('模型未能读取这个问题。','The model could not read this question.')
   }[code]||L('暂时无法连接模型。','The model is temporarily unavailable.');
   return marketRuleSummary(turn.evidence)+`<div class="chat-model-status" role="status">${reason}<button type="button" class="chat-inline-action" data-chat-retry="${esc(turn.id)}">${L('重新回答','Retry reply')}</button></div>`+evidenceHTML(turn);
  }

  if(turn.billingJob){const job=account?.s.tasks.find(j=>j.id===turn.billingJob);if(!job||['reserved','unknown'].includes(job.status)){const unknown=!job||job.status==='unknown';return `<div class="chat-task-status ${unknown?'is-unknown':''}" role="status"><span class="chat-task-indicator" aria-hidden="true"></span><div><strong>${unknown?L('任务状态待确认','Task status needs checking'):L('任务处理中','Processing your request')}</strong>${para(unknown?L('先核对任务状态，再继续分析。','Check the task status before continuing.'):L('完成后会在这里显示结果，离开页面后仍可查看。','The result will appear here and remains available if you leave this page.'))}${taskLink(turn,L('查看任务状态','View task status')+icon('arrow'))}</div></div>`;}if(job.status!=='complete')return para(L('本次任务未交付结果，Credit 预留已释放。','No result was delivered. The Credit hold was released.'))+taskLink(turn,L('查看任务状态','View task status')+icon('arrow'));}
  if(turn.freeHelp&&/限价|市价|limit order|market order/i.test(turn.question))return para(L('市价单按市场当前可成交价格执行，成交价可能滑点；限价单只接受指定价格或更优价格，可能无法成交。设置和规则说明免费。','Market orders execute against available prices and may slip. Limit orders accept your price or better but may not fill. Settings and rule explanations are free.'));
  const receipt=turn.billingJob?`<p class="chat-provenance"><span>${L('模拟结果 · 实扣','Simulated result · settled')} ${account.s.tasks.find(j=>j.id===turn.billingJob)?.settled||0} Credit</span>${taskLink(turn,L('查看用量','View usage'))}</p>`:'';
  return receipt+replyBody(turn);
 }
 function replyBody(turn){if(BINANCE_AGENT_OS.tasks[turn.providerTask])return providerReply(turn);return turn.mode==='technical'?technicalReply(turn.technical,turn)+(turn.sources.length?materialReply(turn.sources):''):turn.mode==='material'?(turn.report?reportReply(turn.report):materialReply(turn.sources))+(turn.report&&turn.sources.length?materialReply(turn.sources):''):questionReply(turn);}
 function currentBars(){const thread=selected(),snapshot=thread.turns.find(t=>t.id===thread.windowTurnId)?.technical,a=MARKET.find(a=>a.symbol===thread.asset)||MARKET[0];return snapshot?.bars?.length&&snapshot.bars.length===snapshot.count&&snapshot.asset===thread.asset&&snapshot.period===thread.period?snapshot.bars:assistantBars(a,thread.period);}
 function chartWorkbench(){
  const thread=selected(),asset=MARKET.find(a=>a.symbol===thread.asset),snapshot=thread.turns.find(t=>t.id===thread.windowTurnId)?.technical,previous=[...thread.turns].reverse().find(t=>t.mode==='technical'&&t.technical);
  if(thread.chartOpen===false&&previous)return `<div class="chat-window-summary"><span>${tokenIcon(previous.technical.asset,{size:22})}<b>${esc(previous.technical.asset)}</b> ${esc(previous.technical.period)}</span><button type="button" class="chat-inline-action" data-chat-change-window>${icon('chart')}${L('调整区间','Change window')}</button></div>`;
  const frozen=!!thread.windowTurnId,valid=!frozen||snapshot?.bars?.length===snapshot?.count&&snapshot?.asset===thread.asset&&snapshot?.period===thread.period,live=!frozen&&asset?.domain==='Crypto';
  const chart=live?tradingChartPanel('assistant-market',{market:thread.asset+'/USDT',period:thread.period,venueId:'binance',profileId:'cex-spot'}):valid?chartPanel('assistant-window',{title:thread.asset+' · '+L('选取行情区间','Select a candle window'),bars:currentBars(),unit:asset?.unit||'USD',period:thread.period,height:270,initialWindow:thread.period==='4H'?'all':null,initialRange:thread.range||null}):`<p role="status">${L('原行情记录无法读取，请查看当前行情','The original chart record is unavailable. Open the current market.')}</p>`;
  return `<section class="chat-chart-workbench"><header><label><span class="chat-asset-label">${L('资产','Asset')}</span><select data-chat-asset aria-label="${L('分析资产','Analysis asset')}">${assetOptions(MARKET.map(a=>[a.symbol,a.symbol+' · '+L(a.name,({SPX:'S&P 500',NDX:'Nasdaq 100',XAU:'Gold',DXY:'USD Index',US10Y:'US 10Y yield'})[a.symbol]||a.name)]),thread.asset)}</select>${watchManageButton(false)}</label>${frozen?`<span class="chat-chart-source">${esc(snapshot?.provider||L('历史样例','Historical example'))} · ${L('报告快照','Report snapshot')} · ${esc(thread.period)}</span>`:live?'':`<div class="chat-periods" role="group" aria-label="${L('K 线周期','Candle period')}">${['1H','4H'].map(p=>`<button type="button" data-chat-period="${p}" aria-pressed="${thread.period===p}">${p}</button>`).join('')}</div><span>${L('历史样例','Historical example')}</span>`}<div class="chat-chart-actions">${frozen?`<button type="button" class="chat-inline-action" data-chat-change-window>${L('当前行情','Current market')}${icon('arrow')}</button>`:''}${previous?`<button type="button" class="chat-inline-action chat-chart-return" data-chat-chart-close aria-label="${L('返回行情解读','Back to the analysis')}">${icon('arrow')}${L('返回解读','Back')}</button>`:''}<button type="button" class="p-button p-primary" data-chat-analyze aria-label="${L('分析这段行情','Analyze this window')}" ${!valid||live?'disabled':''}><span class="chat-analyze-long">${L('分析这段行情','Analyze this window')}</span><span class="chat-analyze-short">${L('分析','Analyze')}</span>${icon('send')}</button></div></header>${chart}</section>`;
 }
 function historyTitle(thread){const turn=thread.turns[0];return turn?.generatedQuestion?(turn.report?researchSummary(turn.report.config)+' · '+L(...RESEARCH_OPTIONS.focus[turn.report.config.focus]):turn.technical?turn.technical.asset+' · '+label('technical'):label(turn.mode)):thread.title||thread.draft?.trim().slice(0,30)||thread.sources[0]?.title;}
 function historyHTML(){
  const list=[...store.threads].filter(t=>t.title||t.pinned||sourceNeedsNewThread(t)||t.id===store.active).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.at-a.at);
  return `<header><b>${L('研究对话','Research chats')}</b><button type="button" class="chat-icon chat-history-dismiss" data-chat-history-close aria-label="${L('关闭会话列表','Close chat history')}">${icon('close')}</button></header><button type="button" class="chat-new" data-chat-new>${icon('plus')}${L('新对话','New chat')}</button><nav aria-label="${L('历史对话','Conversation history')}">${list.map(t=>`<div class="chat-thread"><button type="button" data-chat-thread="${esc(t.id)}" aria-current="${t.id===store.active?'true':'false'}">${icon('chat')}<span><span ${t.title||t.draft||t.sources.length?'data-no-translate':''}>${esc(historyTitle(t)||L('新的研究','New research'))}</span><small>${label(t.mode)}</small></span></button><button type="button" class="chat-icon chat-pin" data-no-translate data-chat-pin="${esc(t.id)}" aria-label="${esc((t.pinned?L('取消置顶：','Unpin: '):L('置顶：','Pin: '))+(historyTitle(t)||L('新对话','New chat')))}" aria-pressed="${t.pinned}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="${t.pinned?'currentColor':'none'}" stroke="currentColor" stroke-width="1.6"><path d="m8 3 8 0-1 7 4 4H5l4-4ZM12 14v7"/></svg></button></div>`).join('')}</nav>`;
 }
 function contextHTML(thread){const staged=thread.sources.length>0,sources=staged?thread.sources:thread.turns.at(-1)?.sources||[],previous=!staged&&sources.length>0;return `<aside class="chat-context" aria-label="${L('引用资料','Sources')}"><header><b>${previous?L('上一轮资料','Previous sources'):L('引用资料','Sources')}</b><span>${sources.length}${staged?' / 6':''}</span></header>${sources.length?sourcesHTML(sources,staged):`<div class="chat-context-empty">${icon('file')}<p>${L('先带一份资料过来','Start with one source')}</p><button type="button" class="p-button" data-chat-add>${L('粘贴资料','Paste an excerpt')}</button></div>`}${previous?`<button type="button" class="p-button chat-reuse" data-chat-reuse>${icon('plus')}${L('用于提问','Use in prompt')}</button>`:''}<div class="chat-context-links"><button type="button" data-chat-go="markets">${icon('chart')}<span>${L('市场行情','Markets')}</span>${icon('arrow')}</button><button type="button" data-chat-go="intelligence">${icon('file')}<span>${L('新闻舆情','News & sentiment')}</span>${icon('arrow')}</button><button type="button" data-chat-go="tracking">${icon('pulse')}<span>${L('AI 与链上追踪','AI & on-chain')}</span>${icon('arrow')}</button></div></aside>`;}
 function renderShared(){
  return `<section class="chat-shared" data-localized-ui><header><span>${icon('file')}${L('分享预览','Share preview')} · DEMO</span><button type="button" class="p-button" data-chat-share-back>${L('返回 AI 助手','Back to AI assistant')}${icon('arrow')}</button></header>${sharedView?`<article><div class="chat-report-kicker">${label(sharedView.mode)} · ${L('样例截至','Sample as of')} ${dateTime(sharedView.asOf)} UTC+8</div><h1 data-no-translate>${esc(sharedView.title)}</h1><div class="chat-shared-text" data-no-translate>${esc(sharedView.text)}</div>${sharedView.sources.length?`<footer>${sharedView.sources.map(source=>`<a href="${esc(source.href)}" data-no-translate>${esc(source.title)} ↗</a>`).join('')}</footer>`:''}</article><p class="chat-shared-note">${L('用户选取的样例结果；邀请码未校验。','A user-selected sample result; invitation code is unverified.')}</p>`:`<div class="chat-shared-empty" role="status">${sharedError?L('链接无法读取，请重新生成分享预览。','This link could not be read. Create a new preview.'):L('正在读取分享内容…','Reading shared content…')}</div>`}</section>`;
 }
 function openShare(button){
  capture();const thread=selected(),turn=thread.turns.find(t=>t.id===button.dataset.chatShare),result=button.closest('.chat-answer-body')?.querySelector('.chat-result');if(!turn||!result)return;
  const text=resultText(result),title=result.querySelector('h3')?.textContent||label(turn.mode);
  const sources=turn.report?[{title:L('数据中心','Data center'),href:'?page=markets'},{title:L('策略广场','Strategies'),href:'?page=strategies'},{title:L('AI 信号','AI signals'),href:'?page=signals'}]:turn.technical?[{title:turn.technical.asset+' · '+L('市场行情','Markets'),href:'?page=markets&asset='+turn.technical.asset},...(turn.marketContext?.news||[]).map(n=>({title:L(n.title,translate(n.title,'en')),href:n.href}))]:[];
  const version=++shareVersion;shareOrigin=button;if(!shareDialog){shareDialog=document.createElement('dialog');shareDialog.className='product-dialog chat-source-dialog chat-share-dialog';shareDialog.setAttribute('aria-labelledby','chat-share-title');document.body.append(shareDialog);shareDialog.addEventListener('close',()=>{shareVersion++;if(shareOrigin?.isConnected)shareOrigin.focus();});}
  let invite='';try{invite=localStorage.getItem('hive.assistant.invite-preview.v1')||'';}catch{}
  shareDialog.innerHTML=`<header class="p-dialog-head"><h2 id="chat-share-title">${L('分享这条结果','Share this result')}</h2><button type="button" class="p-dialog-close" data-share-close aria-label="${L('关闭分享窗口','Close share dialog')}">${icon('close')}</button></header><form><div class="p-dialog-body"><label class="p-field">${L('标题','Title')}<input name="title" maxlength="120" required value="${esc(title.slice(0,120))}"></label><label class="p-field">${L('分享内容','Shared content')}<textarea name="text" rows="9" required maxlength="16000">${esc(text)}</textarea></label><label class="p-field">${L('测试邀请码','Test invitation code')}<input name="invite" required minlength="4" maxlength="32" pattern="[A-Za-z0-9_-]{4,32}" autocomplete="off" placeholder="${L('4–32 个字符','4–32 characters')}" value="${esc(invite)}"></label><p class="chat-share-boundary">${L('只分享你确认的这段内容，不自动附上其它对话或附件。公开链接与邀请码校验待接入，当前仅作本地预览。','Shares only the text you confirm, without automatically attaching other chats or files. Public links and invitation verification are not connected; this is a local preview.')}</p><div data-share-status role="status"></div><div data-share-generated></div></div><footer class="chat-source-footer"><button type="submit" class="p-button p-primary">${L('生成预览链接','Create preview link')}${icon('arrow')}</button></footer></form>`;
  shareDialog.querySelector('[data-share-close]').onclick=()=>shareDialog.close();
  let revision=0;const form=shareDialog.querySelector('form'),generated=shareDialog.querySelector('[data-share-generated]');
  form.oninput=()=>{revision++;generated.innerHTML='';shareDialog.querySelector('[data-share-status]').textContent='';};
  form.onsubmit=async event=>{
   event.preventDefault();const current=++revision,data=new FormData(form),submit=form.querySelector('button[type=submit]'),status=shareDialog.querySelector('[data-share-status]');submit.disabled=true;status.textContent=L('正在生成预览…','Creating preview…');
   try{const output={version:1,sample:true,mode:turn.mode,title:data.get('title'),text:data.get('text'),asOf:turn.report?.asOf||turn.technical?.end||RESEARCH_AS_OF,sources},token=await encodeSharedOutput(output),url=sharedOutputURL(location.origin,token,String(data.get('invite')||''));if(current!==revision||version!==shareVersion||!shareDialog.open)return;
    try{localStorage.setItem('hive.assistant.invite-preview.v1',String(data.get('invite')));}catch{}
    status.textContent=L('预览链接已生成，仅供本地查看','Preview link ready for local viewing');
    generated.innerHTML=`<label class="p-field">${L('预览链接（含测试邀请码）','Preview link (with test invitation code)')}<input readonly data-share-url value="${esc(url)}"></label><div class="chat-share-links"><a class="p-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${L('打开预览','Open preview')} ↗</a><button type="button" class="p-button" data-share-link-copy>${L('复制链接','Copy link')}</button></div><div class="chat-share-platforms">${[['x','X'],['telegram','Telegram'],['discord','Discord']].map(([id,name])=>`<button type="button" class="p-button" data-share-channel="${id}">${L('复制','Copy')} ${name} ${L('草稿','draft')}</button>`).join('')}</div>`;
    const copyText=async value=>{try{await navigator.clipboard.writeText(value);notify(L('已复制，尚未发布','Copied; not published'),{tone:'success'});}catch{status.textContent=L('复制未成功，可手动选择文字或链接','Copy failed. Select the text or link manually.');}};
    generated.querySelector('[data-share-link-copy]').onclick=()=>copyText(url);generated.querySelector('[data-share-url]').onclick=event=>event.target.select();
    generated.querySelectorAll('[data-share-channel]').forEach(button=>button.onclick=()=>copyText(socialDraft(output,url,button.dataset.shareChannel)));
   }catch(error){if(current===revision&&version===shareVersion)status.textContent=error.message==='share-invite'?L('邀请码需为 4–32 位字母、数字、下划线或短横线','Use 4–32 letters, digits, underscores or hyphens for the invitation code'):L('内容过长或格式有误，请精简后重试','The content is too long or invalid. Shorten it and try again.');}finally{submit.disabled=false;}
  };shareDialog.showModal();
 }
 function toolsHTML(report=false){
  return `<div class="chat-input-tools${report?' chat-report-tools':''}" role="group" aria-label="${L('工具','Tools')}">${ASSISTANT_TOOLSETS.filter(toolset=>toolset.exchange).map(toolset=>`<button type="button" class="chat-exchange-shortcut" data-chat-exchange="${toolset.brand}" aria-haspopup="dialog" aria-expanded="false" aria-controls="chat-exchange-picker">${venueIcon(toolset.brand,{size:20})}<span>${L(...toolset.label)}</span></button>`).join('')}<button type="button" class="chat-tools-all" data-chat-tools aria-label="${L('打开工具','Open tools')}" aria-haspopup="dialog"><span>${L('全部工具','All tools')}</span>${icon('chevron')}</button><div id="chat-exchange-picker" class="chat-exchange-picker" popover="auto" role="dialog" aria-labelledby="chat-exchange-picker-title"></div></div>`;
 }
 function toolSelectionHTML(){
  const tool=toolSelections.get(selected().id);if(!tool)return '';
  return `<div class="chat-tool-selection"><div><span>${venueIcon(tool.provider,{size:20})}<b>${tool.provider==='okx'?'OKX':'Binance'} · ${L(...EXCHANGE_CAPABILITIES[tool.operation])}</b></span><button type="button" class="chat-icon" data-chat-tool-clear aria-label="${L('移除所选工具','Remove selected tool')}">${icon('close')}</button></div><div class="chat-tool-parameters">${!['account','positions'].includes(tool.operation)?`<label>${L('资产','Asset')}<select data-chat-tool-asset>${EXCHANGE_ASSETS.map(id=>`<option ${id===tool.asset?'selected':''}>${id}</option>`).join('')}</select></label>`:''}${['candles','analysis'].includes(tool.operation)?`<label>${L('周期','Interval')}<select data-chat-tool-period>${EXCHANGE_PERIODS.map(id=>`<option ${id===tool.period?'selected':''}>${id}</option>`).join('')}</select></label>`:''}</div><p>${PRIVATE_EXCHANGE_OPERATIONS.includes(tool.operation)?L('只读账户 · 问题草稿保留','Read-only account · Question draft kept'):L('公开市场 · 问题草稿保留','Public markets · Question draft kept')}</p></div>`;
 }
 function selectExchangeTool(toolset,operation){
  if(!toolset?.exchange||!EXCHANGE_OPERATIONS.includes(operation))return;
  capture();const thread=selected(),previous=toolSelections.get(thread.id);
  toolSelections.set(thread.id,{provider:toolset.brand,operation,asset:previous?.asset||(EXCHANGE_ASSETS.includes(thread.asset)?thread.asset:'BTC'),period:previous?.period||(EXCHANGE_PERIODS.includes(thread.period)?thread.period:'1H')});
  thread.providerTask=null;thread.mode='ask';persist();repaint('[data-chat-input]');
 }
 function openCapabilityPicker(button){
  const picker=root.querySelector('#chat-exchange-picker'),toolset=ASSISTANT_TOOLSETS.find(item=>item.exchange&&item.brand===button.dataset.chatExchange);if(!picker||!toolset)return;
  if(picker.matches(':popover-open')&&picker.dataset.provider===toolset.brand){picker.hidePopover();return;}
  if(picker.matches(':popover-open'))picker.hidePopover();
  capture();picker.dataset.provider=toolset.brand;
  picker.innerHTML=`<header><h2 id="chat-exchange-picker-title">${venueIcon(toolset.brand,{size:20})}${L(...toolset.label)}</h2><button type="button" class="chat-icon" data-chat-picker-close aria-label="${L('关闭能力词条','Close capabilities')}">${icon('close')}</button></header>${[false,true].map(privateScope=>`<section><h3>${privateScope?L('当前账户 · 只读连接后使用','Your account · Requires read-only connection'):L('公开市场 · 直接查询','Public markets · No connection needed')}</h3><div>${EXCHANGE_OPERATIONS.filter(id=>PRIVATE_EXCHANGE_OPERATIONS.includes(id)===privateScope).map(id=>`<button type="button" data-chat-capability="${id}" aria-pressed="${toolSelections.get(selected().id)?.provider===toolset.brand&&toolSelections.get(selected().id)?.operation===id}">${L(...EXCHANGE_CAPABILITIES[id])}</button>`).join('')}</div></section>`).join('')}`;
  const win=button.ownerDocument.defaultView,viewport=win.visualViewport;
  function position(){
   const rect=button.getBoundingClientRect(),inset=12;
   const left=(viewport?.offsetLeft??0)+inset,top=(viewport?.offsetTop??0)+inset;
   const availableWidth=Math.max(0,(viewport?.width??win.innerWidth)-2*inset);
   const availableHeight=Math.max(0,(viewport?.height??win.innerHeight)-2*inset);
   const width=Math.min(420,availableWidth),above=Math.max(0,Math.min(availableHeight,rect.top-8-top));
   const aboveTrigger=above>=160;
   picker.style.width=width+'px';
   picker.style.left=Math.max(left,Math.min(rect.left,left+availableWidth-width))+'px';
   picker.style.top=aboveTrigger?'auto':top+'px';
   picker.style.bottom=aboveTrigger?win.innerHeight-top-above+'px':'auto';
   picker.style.maxHeight=Math.min(480,aboveTrigger?above:availableHeight)+'px';
  }
  pickerListeners?.abort();
  const listeners=pickerListeners=new AbortController(),options={signal:listeners.signal,passive:true};
  win.addEventListener('resize',position,options);
  win.addEventListener('scroll',position,{...options,capture:true});
  viewport?.addEventListener('resize',position,options);
  viewport?.addEventListener('scroll',position,options);
  picker.onbeforetoggle=event=>{if(event.newState==='closed')listeners.abort();};
  position();
  picker.ontoggle=event=>{for(const trigger of root.querySelectorAll('[data-chat-exchange]'))trigger.setAttribute('aria-expanded',String(event.newState==='open'&&trigger.dataset.chatExchange===picker.dataset.provider));};
  const close=()=>{picker.hidePopover();button.focus({preventScroll:true});};
  picker.querySelector('[data-chat-picker-close]').onclick=close;
  picker.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  const choices=[...picker.querySelectorAll('[data-chat-capability]')];
  choices.forEach((choice,i)=>{choice.onclick=()=>{picker.hidePopover();selectExchangeTool(toolset,choice.dataset.chatCapability);};choice.onkeydown=event=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(i+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+choices.length)%choices.length;choices[next].focus();};});
  picker.showPopover({source:button});choices[0]?.focus({preventScroll:true});
 }
 function runSelectedTool(){
  capture();const selection=toolSelections.get(selected().id);if(!selection)return;
  const toolset=ASSISTANT_TOOLSETS.find(item=>item.exchange&&item.brand===selection.provider);if(!toolset)return;
  prepareProviderDialog(root.querySelector('.chat-send'));
  providerDialog.innerHTML=`<header class="p-dialog-head"><h2 id="chat-provider-title">${L(...toolset.label)} · ${L(...EXCHANGE_CAPABILITIES[selection.operation])}</h2><button type="button" class="p-dialog-close" data-chat-provider-close aria-label="${L('关闭工具','Close tools')}">${icon('close')}</button></header><div class="p-dialog-body" role="status">${L('正在打开工具…','Opening tool…')}</div>`;
  providerDialog.querySelector('[data-chat-provider-close]').onclick=()=>providerDialog.close();if(!providerDialog.open)providerDialog.showModal();providerDialog.querySelector('[data-chat-provider-close]').focus({preventScroll:true});
  return openExchangeTool(toolset,selection.operation,selection);
 }
 function render(){
  pickerListeners?.abort();
  if(typeof location!=='undefined'){const token=new URLSearchParams(location.hash.slice(1)).get('astarter-share');if(token!==sharedToken){if(sharedToken&&!token){store=readStore();ensureThread();}sharedToken=token;sharedView=null;sharedError=false;sharedLoading=false;}}if(sharedToken)return renderShared();if(restoreScroll==null)restoreScroll=root.querySelector('.chat-feed')?.scrollTop??null;const thread=selected(),report=selectedReport(thread),turns=thread.mode==='material'?(report?[report]:[]):thread.turns.filter(turn=>turn.mode===thread.mode),lastTechnical=[...turns].reverse().find(turn=>turn.technical);return `<div class="chat-app ${drawerOpen?'history-open':''}" data-localized-ui><button type="button" class="chat-history-scrim" data-chat-history-close aria-label="${L('关闭会话列表','Close chat history')}"></button><aside class="chat-history" ${drawerOpen&&matchMedia('(max-width:900px)').matches?'role="dialog" aria-modal="true"':''} aria-label="${L('历史对话','Conversation history')}">${historyHTML()}</aside><section data-chat-task="${thread.mode}" class="chat-main ${thread.mode!=='material'&&(thread.sources.length||thread.turns.at(-1)?.sources.length)?'has-context':''}" ${drawerOpen&&matchMedia('(max-width:900px)').matches?'inert':''}><header class="chat-heading"><div><button type="button" class="chat-icon chat-history-toggle" data-chat-history aria-label="${L('打开历史对话','Open chat history')}">${icon('history')}</button><h1>${L('交易助手','Trading assistant')}</h1><details class="chat-capability"><summary>${L('问答说明','About chat')}<span>i</span></summary><p>${L('助手会结合本次对话和可用的公开资料回答。报价显示来源时间，投研报告中的历史示例另有标注。','Answers use this conversation and available public sources. Quotes show their source time, and historical report examples are labeled.')}</p></details></div><div class="chat-heading-actions"><button type="button" class="chat-inline-action chat-team-trigger" data-chat-team aria-haspopup="dialog">${icon('orbit')}${L('AI 小队','AI squad')}</button></div></header><div class="chat-modebar" role="group" aria-label="${L('助手功能','Assistant task')}">${['ask','material','technical'].map(mode=>`<button type="button" data-chat-mode="${mode}" aria-pressed="${thread.mode===mode}" aria-label="${label(mode)}">${icon(mode==='ask'?'chat':mode==='material'?'file':'chart')}<span class="chat-mode-label-long">${label(mode)}</span><span class="chat-mode-label-short">${({ask:L('问答','Ask'),material:L('报告','Report'),technical:L('行情','Chart')})[mode]}</span></button>`).join('')}</div>${storageError?`<p class="chat-storage-error" role="alert">${L('这次对话暂未保存，请导出后再离开。','This conversation could not be saved. Export it before leaving.')}</p>`:''}<div class="chat-feed-layout"><div class="chat-feed" tabindex="0" aria-label="${L('对话内容','Conversation')}">${thread.mode==='technical'?chartWorkbench():thread.mode==='material'?toolsHTML(true)+reportBuilder()+reportRecords():''}${turns.length?`<div class="chat-turns">${turns.map(turn=>`<article class="chat-turn${turn.id===freshTurnId?' is-new':''}">${turn.generatedQuestion?'':`<div class="chat-user"><span data-no-translate>${esc(turn.question)}</span>${turn.sources.length?`<span>${turn.sources.length} ${L('份资料','sources')}</span>`:''}</div>`}<div class="chat-answer"><div class="chat-answer-avatar">${orb()}</div><div class="chat-answer-body"><div class="chat-result"${questionLanguage(turn.question)?' data-no-translate':''}>${reply(turn)}</div>${delivered(turn)?`<div class="chat-answer-actions"><button type="button" class="chat-inline-action chat-share-action" data-chat-share="${esc(turn.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4"/></svg>${L('分享','Share')}</button>${turn.mode==='technical'?`<button type="button" class="chat-inline-action" data-chat-window="${esc(turn.id)}">${icon('chart')}${L('在图表中查看','Show this window')}</button>`:''}<button type="button" class="chat-icon" data-chat-copy="${esc(turn.id)}" aria-label="${L('复制这条回答','Copy this answer')}" title="${L('复制回答','Copy answer')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg></button></div>`:''}</div></div></article>`).join('')}</div>`:thread.mode==='ask'?`<div class="chat-welcome"><button type="button" class="chat-welcome-pet" data-chat-pet aria-label="${L('推荐话题','Suggest a topic')}">${orb()}</button><h2>${L('从一个问题开始','Start with a question')}</h2><div class="chat-suggestions">${prompts().map((prompt,i)=>`<button type="button" data-chat-prompt="${i}" aria-label="${esc(prompt.question)}">${icon(prompt.icon)}<strong>${esc(prompt.label)}</strong><span>${esc(prompt.question)}</span><b>↗</b></button>`).join('')}</div></div>`:''}${thread.mode==='technical'&&thread.chartOpen===false&&lastTechnical&&delivered(lastTechnical)?`<div class="chat-followups" ${thread.draft.trim()?'hidden':''} aria-label="${L('继续追问','Follow-up questions')}">${followups().map(([id,z,en,labelZ,labelEn])=>`<button type="button" data-chat-followup="${id}">${L(labelZ,labelEn)}${icon('plus')}</button>`).join('')}</div>`:''}</div>${thread.mode!=='material'&&(thread.sources.length||thread.turns.at(-1)?.sources.length)?contextHTML(thread):''}</div>${thread.mode==='material'?'':`<div class="chat-composer-area">${thread.providerTask?`<div class="chat-provider-selection"><span>${venueIcon('binance',{size:16})}<b>Binance</b><span>${L(...BINANCE_AGENT_OS.tasks[thread.providerTask].label)} · ${L('未接入','Not integrated')}</span></span><button type="button" class="chat-icon" data-chat-provider-clear aria-label="${L('移除 Binance 工具','Remove Binance tool')}">${icon('close')}</button></div>`:''}${toolSelectionHTML()}${sourcesHTML(thread.sources,true)}${!thread.sources.length&&thread.turns.at(-1)?.sources.length?`<button type="button" class="chat-reuse-mobile" data-chat-reuse>${icon('plus')}${L('上一轮资料','Previous sources')} · ${L('用于提问','Use in prompt')}</button>`:''}<form class="chat-composer"><label class="sr-only" for="chat-message">${L('输入你的问题','Your question')}</label><textarea id="chat-message" data-chat-input enterkeyhint="enter" maxlength="2000" rows="${thread.mode==='ask'?2:1}" placeholder="${L(thread.mode==='technical'?'继续问关键价位、风险或消息':thread.mode==='material'?'补充你关心的问题（选填）':'问行情、读消息，或者让它帮你梳理资料',thread.mode==='technical'?'Follow up on levels, risks or news':thread.mode==='material'?'Add a research question (optional)':'Ask about markets, news, or your research sources')}">${esc(thread.draft)}</textarea><div class="chat-composer-tools"><div><button type="button" class="chat-icon" data-chat-add aria-label="${L('添加一段资料','Add an excerpt')}" title="${L('粘贴资料','Paste an excerpt')}">${icon('plus')}</button><label class="chat-icon chat-upload" title="${L('添加文本文件','Add a text file')}">${icon('attach')}<span class="sr-only">${L('添加文本文件','Add a text file')}</span><input type="file" data-chat-file accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"></label>${thread.sources.length?`<span class="chat-composer-count">${thread.sources.length} / 6 ${L('资料','sources')}</span>`:''}</div><button type="submit" class="chat-send" aria-label="${toolSelections.has(thread.id)?L('获取所选工具数据','Fetch selected tool data'):thread.mode==='material'?L('生成报告','Generate report'):L('发送问题','Send question')}" ${(waiting(thread)||!toolSelections.has(thread.id)&&thread.mode==='ask'&&!thread.draft.trim()&&!thread.sources.length)?'disabled':''}>${toolSelections.has(thread.id)?`<span>${L('获取数据','Fetch data')}</span>`:icon('send')}</button></div></form>${toolsHTML()}</div>`}</section></div>`;
 }
 function selectedTechnical(){
  const thread=selected(),asset=MARKET.find(a=>a.symbol===thread.asset);
  if(!thread.windowTurnId&&asset?.domain==='Crypto'){
   const snapshot=captureTradingChart(root.querySelector('[data-trading-chart="assistant-market"]'));
   if(snapshot.market!==thread.asset+'/USDT')throw Error('MARKET_NOT_READY');
   thread.period=snapshot.period;return {...snapshot,...analyzeBars(snapshot.bars),asset:thread.asset};
  }
  const bars=currentBars(),chart=root.querySelector('[data-chart="assistant-window"]'),start=Number(chart?.dataset.rangeStart??Math.max(0,bars.length-40)),count=Number(chart?.dataset.visibleCount??40),source=thread.turns.find(t=>t.id===thread.windowTurnId)?.technical;
  if(thread.windowTurnId&&(!source||source.bars?.length!==source.count))throw Error('MARKET_NOT_READY');
  const window=bars.slice(start,start+count);return {...source,...analyzeBars(window),asset:thread.asset,period:thread.period,clockKind:source?.clockKind||'historical',provider:source?.provider||'Astarter fixture',precision:source?.precision||'hour',bars:window.map(bar=>({...bar}))};
 }
 async function loadAnswer(thread,turn){
  const visible=()=>store.threads.includes(thread)&&(account?.scope||'')===billingScope;
  try{
   if(turn.quotes){turn.quotes=await readAssistantQuotes(turn.quotes.map(q=>q.symbol));}
   else{
    const priorTurns=thread.turns.slice(0,thread.turns.indexOf(turn));
    const previous=priorTurns.map(t=>t.question),decision=assistantDecisionContext(turn.question,priorTurns);
    const rows=turn.sources.length?[]:await readAssistantMarketContext({question:decision.question,previousQuestions:previous,locale:questionLanguage(decision.question)||getLocale()}).catch(()=>[]);
    if(!turn.sources.length&&decision.needsAsset){turn.needsMarketAsset=true;delete turn.modelReply;delete turn.evidence;delete turn.evidenceStatus;}
    else {
    turn.evidence=cleanAnswerEvidence(rows);
    const observed=turn.evidence.filter(r=>r.status==='observed');
    turn.evidenceStatus=turn.evidence.length?(observed.length===turn.evidence.length?'available':observed.length?'partial':'unavailable'):undefined;
    if(!visible())return;
    turn.modelReply={state:'complete',...await requestAssistantAnswer(assistantConversationMessages(thread.turns,{...turn,question:decision.question}))};
    }
   }
   turn.answeredAt=Date.now();
  }catch(error){turn.modelReply={state:'error',code:error.code||'MODEL_UNAVAILABLE'};}
  if(!visible())return;
  persist();if(selected()===thread&&!sharedToken&&document.body.dataset.page==='assistant')repaintAnswer(turn);
 }
 const pendingThreads=new Set();
 function busy(thread){return pendingThreads.has(thread);}
 function waiting(thread){return busy(thread)&&thread.turns.some(turn=>turn.modelReply?.state==='pending'||turn.quotes?.some(q=>q.state==='pending'));}
 async function send({fromChart=false,continueId}={}){const target=selected();if(busy(target))return;
  if(continueId){
   const last=target.turns.at(-1);
   if(target.mode!=='ask'||last?.id!==continueId||!last.modelReply?.truncated)return;
   if(target.sources.length||toolSelections.has(target.id)||target.providerTask){
    notify(L('请先发送或移除待用的资料和工具，再继续这条回答。','Send or remove staged sources and tools before continuing this reply.'));return;
   }
  }
  pendingThreads.add(target);try{
  capture();const thread=selected();if(!fromChart&&thread.mode!=='material'&&toolSelections.has(thread.id)){await runSelectedTool();return;}if(thread.turns.length>=CHAT_LIMITS.turns){notify(L('这段对话已达到 24 轮，请开新对话继续，原记录会保留。','This chat reached 24 turns. Start a new chat; the existing record is retained.'));repaint('[data-chat-input]');return;}let question=thread.mode==='material'?'':clipText(thread.draft,2000),technical=null,report=null,evidence=null,followup=false;
  if(continueId)question=L('从上一条回答中断的地方继续，接着最后一句往下写。','Continue from the end of your last answer, picking up where it stopped.');
  if(thread.mode==='ask'&&!question&&!thread.sources.length)return;
  if(thread.mode==='material'&&!thread.providerTask){try{report=buildResearchReport(thread.research);}catch(error){notify(error.message==='research-assets'?L('至少选择一项交易标的或板块','Choose at least one asset or sector'):L('开始时间需早于结束时间','Start must be earlier than end'),{tone:'error'});return;}}
  if(thread.mode==='technical'&&!thread.providerTask){try{const previous=[...thread.turns].reverse().find(t=>t.mode==='technical'&&t.technical);if(!fromChart&&thread.chartOpen===false&&previous&&!delivered(previous)){notify(L('该次解读尚未交付，请先查看任务状态，或重新选择行情区间。','This analysis is not available yet. Check the task status or choose a new candle window.'));return;}followup=!fromChart&&thread.chartOpen===false&&!!previous;technical=followup?{...previous.technical}:selectedTechnical();evidence=followup?previous.marketContext:technicalContext(technical);}catch(error){notify(error.message==='MARKET_NOT_READY'?L('行情尚未就绪或已中断，请刷新后再分析','Market data is not ready. Refresh before analyzing.'):L('请至少选取 8 根已收盘 K 线','Select at least 8 closed candles'),{tone:'error'});return;}}
  const generatedQuestion=!question;if(!question)question=thread.mode==='technical'?L('解读这段行情，列出重点与风险','Explain this price move, key levels and risks'):report?researchSummary(report.config)+' · '+L(...RESEARCH_OPTIONS.focus[report.config.focus]):L('整理这些资料的重点和待确认内容','Summarize these sources and the missing information');
  const turn={id:crypto.randomUUID(),question,generatedQuestion,topic:questionTopic(translate(question,'en')),mode:thread.mode,providerTask:thread.providerTask||null,sources:thread.sources.map(x=>({...x})),technical,marketContext:evidence,report,followup,context:context()};
  if(turn.mode==='ask'&&!turn.providerTask&&!generatedQuestion&&(turn.sources.length||!isSimpleGreeting(question))){
   const decision=assistantDecisionContext(question,thread.turns);
   const symbols=decision.quoteSymbols??questionQuoteSymbols(question,turn.topic);
   const wantsQuote=!!decision.quoteSymbols||/现价|市价|价格|报价|多少钱|现在多少|price|quote|how much/i.test(question)||
    symbols.some(s=>s.toLowerCase()===question.trim().toLowerCase());
   const wantsExplanation=/为什么|为何|原理|解释|区别|比较|意味着|信号|策略|分析|新闻|社媒|清算|充提|成交量|资金流|故事|写一|翻译|\b(?:ETF|why|explain|compare|signals?|strategy|news|social|funding|liquidations?|write|story|translate)\b|analy[sz]/i.test(question);
   const attached=turn.sources.length>0,publicAttachments=assistantPublicSources(turn.sources);
   if(!attached&&explicitThreadRecall(question,thread.turns)!==null)turn.localRecall=true;
   else if(!attached&&decision.needsAsset)turn.needsMarketAsset=true;
   else if(!attached&&symbols.length&&wantsQuote&&!wantsExplanation&&!asksMarketDecision(decision.question)&&!asksOtherMarketTime(question))turn.quotes=symbols.map(symbol=>({symbol,state:'pending'}));
   else if(publicAttachments.length===turn.sources.length&&(attached||!(orderRuleQuestion(question)&&/区别|什么是|是什么|差[别异]|\b(differ\w*|what (?:is|are))\b/i.test(question))&&!(turn.topic==='credits'&&/积分|credits?|クレジット|크레딧/i.test(question))))
    turn.modelReply={state:'pending'};
  }
  turn.freeHelp=!!turn.modelReply||!!turn.quotes||!!thread.providerTask||thread.mode==='ask'&&!thread.sources.length;
  if(account&&!turn.freeHelp){
   let profile=followup?'Q1':thread.mode==='technical'?'M1':thread.sources.length?'Q1':'Q2',scope={};
   if(report){const range=researchRange(report.config),days=Math.ceil((range.end-range.start)/86400000),assets=report.rows.map(x=>x.asset),sector=report.config.scope==='sectors';profile=report.config.depth==='full'||assets.length>3||days>90?'R3':assets.length===1&&days<=7?'R1':'R2';scope={assets,days,scope:report.config.scope,...(sector?{sectors:report.config.sectors}:{})};}
   else if(technical)scope={assets:[thread.asset],bars:technical.count||8};
   const job=await account.runTask({profile,input:{title:question.slice(0,120),source:'assistant',threadId:thread.id,turn,...scope}});if(!job)return;turn.billingJob=job.id;
  }
  if(technical)thread.chartOpen=false;
  freshTurnId=turn.id;thread.turns.push(turn);thread.turns=thread.turns.slice(-CHAT_LIMITS.turns);
  if(!thread.title)thread.title=question.slice(0,30);thread.at=Date.now();if(thread.mode==='material'){thread.reportId=thread.turns.at(-1).id;thread.reportOpen=false;}else if(!continueId)thread.draft='';thread.sources=[];persist();repaint('[data-chat-input]');const feed=root.querySelector('.chat-feed'),last=root.querySelector('.chat-turn:last-child');if(feed&&last)feed.scrollTop+=last.getBoundingClientRect().top-feed.getBoundingClientRect().top-8;
  if(turn.quotes||turn.modelReply)await loadAnswer(thread,turn);
 }catch(error){notify(error.message,{tone:'error'});}finally{pendingThreads.delete(target);}
 }
 let billingStamp='';
 const clientId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
 function recoverJobs(){if(!account||pendingThreads.size||account.scope!==billingScope)return;let changed=false;for(const job of [...account.s.tasks].reverse()){
  const input=job.input;if(input?.source!=='assistant'||!input.turn)continue;
  if(!account.s.person||job.actor!==account.s.person||!clientId(input.threadId)||!clientId(input.turn.id))continue;
  const saved=normalizeChatStore({schema:1,threads:[{...newThread(),id:input.threadId,title:input.title,turns:[input.turn]}]}).threads[0],turn=saved?.turns[0];if(!turn)continue;
  let thread=store.threads.find(t=>t.id===input.threadId);if(!thread){if(store.threads.length>=CHAT_LIMITS.threads)continue;thread={...saved,mode:turn.mode,chartOpen:turn.mode!=='technical',asset:turn.technical?.asset||saved.asset,period:turn.technical?.period||saved.period,turns:[]};store.threads.push(thread);}
  const existing=thread.turns.find(t=>t.billingJob===job.id);if(!existing&&thread.turns.length<CHAT_LIMITS.turns){thread.turns.push({...turn,billingJob:job.id});changed=true;}else if(existing&&job.status==='complete'&&(!existing.report&&turn.report||!existing.technical&&turn.technical)){Object.assign(existing,turn,{billingJob:job.id});changed=true;}
 }
 if(changed)persist();const next=account.s.tasks.map(j=>j.id+j.status+j.settled).join('|');if(next!==billingStamp){billingStamp=next;if(document.body.dataset.page==='assistant'&&!document.querySelector('.commerce-flow[open]')){capture();repaint();}}
 }
 account?.subscribe(recoverJobs);queueMicrotask(recoverJobs);
 function attach(source){const thread=selected(),result=addSource(thread.sources,source);if(result.error){notify(L(({empty:'资料内容为空',duplicate:'这份资料已经添加',limit:'最多同时分析 6 份资料'})[result.error],({empty:'The source is empty',duplicate:'This source is already attached',limit:'Up to 6 sources per message'})[result.error]));return false;}thread.sources=result.sources;persist();return true;}
 function openExcerpt(){
  capture();origin=root.querySelector('[data-chat-add]');if(!sourceDialog){sourceDialog=document.createElement('dialog');sourceDialog.className='product-dialog chat-source-dialog';sourceDialog.setAttribute('aria-labelledby','chat-source-title');document.body.append(sourceDialog);sourceDialog.addEventListener('close',()=>{if(origin?.isConnected)origin.focus();});}
  sourceDialog.innerHTML=`<header class="p-dialog-head"><h2 id="chat-source-title">${L('添加资料','Add a source')}</h2><button type="button" class="p-dialog-close" data-chat-source-close aria-label="${L('关闭资料窗口','Close source dialog')}">${icon('close')}</button></header><form id="chat-excerpt-form"><div class="p-dialog-body"><label class="p-field">${L('资料名称（选填）','Source title (optional)')}<input name="title" maxlength="100" placeholder="${L('例如：ETH 转账消息','e.g. ETH transfer report')}"></label><label class="p-field">${L('原文或摘录','Text or excerpt')}<textarea name="excerpt" required maxlength="6000" rows="7" placeholder="${L('粘贴原文，最多 6,000 字','Paste source text, up to 6,000 characters')}"></textarea></label></div><footer class="chat-source-footer"><button type="submit" name="intent" value="attach" class="p-button">${L('先加入对话','Attach to chat')}</button><button type="submit" name="intent" value="analyze" class="p-button p-primary">${L('加入并分析','Attach & analyze')}</button></footer></form>`;
  sourceDialog.querySelector('[data-chat-source-close]').onclick=()=>sourceDialog.close();sourceDialog.querySelector('form').onsubmit=e=>{e.preventDefault();const data=new FormData(e.currentTarget);if(attach({id:crypto.randomUUID(),title:data.get('title')||L('粘贴资料','Pasted excerpt'),text:data.get('excerpt'),kind:'excerpt'})){selected().mode='material';selected().providerTask=null;sourceDialog.close();if(e.submitter?.value==='attach')repaint('[data-chat-input]');else send();}};sourceDialog.showModal();
 }
 function setMode(mode,reveal=false){
  if(!['ask','material','technical'].includes(mode))return;
  capture();const thread=selected();thread.providerTask=null;thread.mode=mode;
  if(mode==='technical'&&(reveal||!thread.turns.some(t=>t.technical)))thread.chartOpen=true;
  if(mode==='material'&&reveal)thread.reportOpen=true;
  persist();repaint(reveal?'[data-chat-tools]':'');
  const feed=root.querySelector('.chat-feed');if(mode!=='ask'&&feed)feed.scrollTop=0;
 }
 function prepareProviderDialog(trigger){
  capture();providerOrigin=trigger||(providerOrigin?.isConnected?providerOrigin:root.querySelector('[data-chat-tools]'));
  exchangeLoadTicket++;exchangeTools?.dispose();
  if(!providerDialog){providerDialog=document.createElement('dialog');providerDialog.className='product-dialog chat-source-dialog chat-provider-dialog';providerDialog.setAttribute('aria-labelledby','chat-provider-title');document.body.append(providerDialog);providerDialog.addEventListener('close',()=>{exchangeLoadTicket++;exchangeTools?.dispose();if(!sourceDialog?.open)(providerOrigin?.isConnected?providerOrigin:root.querySelector('[data-chat-tools]'))?.focus();});}
 }
 function openProviderTools(event){
  prepareProviderDialog(event?.currentTarget);
  const sections=ASSISTANT_TOOLSETS.map(toolset=>{
   const entries=Object.entries(toolTasks(toolset));
   const button=([id,task])=>`<button type="button" data-chat-toolset="${toolset.id}" data-chat-tool="${id}" ${toolset.available?'':'disabled'}><span class="chat-tool-icon">${icon(task.icon)}</span><span>${L(...task.label)}</span></button>`;
   const heading=`<h3>${toolset.brand?venueIcon(toolset.brand,{size:20}):''}${L(...toolset.label)}</h3>`;
   const tools=toolset.exchange?[false,true].map(isPrivate=>{
    const items=entries.filter(([id])=>PRIVATE_EXCHANGE_OPERATIONS.includes(id)===isPrivate);
    if(!items.length)return '';
    return `<section class="chat-tool-group ${isPrivate?'is-account':'is-market'}"><h4>${isPrivate?L('账户查询 · 只读','Account · Read only'):L('公开行情','Public markets')}</h4><div class="chat-tool-choices">${items.map(button).join('')}</div></section>`;
   }).join(''):entries.map(button).join('');
   return `<section class="chat-toolset"><header>${heading}${toolset.available?'':`<span>${L('未接入','Not integrated')}</span>`}</header><div class="${toolset.exchange?'chat-tool-groups':'chat-workspace-choices'}">${tools}</div></section>`;
  }).join('');
  providerDialog.innerHTML=`<header class="p-dialog-head"><h2 id="chat-provider-title" tabindex="-1" autofocus>${L('全部工具','All tools')}</h2><button type="button" class="p-dialog-close" data-chat-provider-close aria-label="${L('关闭工具','Close tools')}">${icon('close')}</button></header><div class="p-dialog-body chat-toolset-grid">${sections}</div>`;
  providerDialog.querySelector('[data-chat-provider-close]').onclick=()=>providerDialog.close();
  providerDialog.querySelectorAll('[data-chat-tool]').forEach(button=>{
   if(button.disabled)return;
   button.onclick=()=>{
    const toolset=ASSISTANT_TOOLSETS.find(item=>item.id===button.dataset.chatToolset);
    if(!toolset?.available||!Object.hasOwn(toolTasks(toolset),button.dataset.chatTool))return;
    if(toolset.exchange){selectExchangeTool(toolset,button.dataset.chatTool);providerOrigin=root.querySelector('[data-chat-input]');providerDialog.close();return;}
    if(toolset.id!=='workspace')return;
    providerDialog.close();
    if(button.dataset.chatTool==='sources')openExcerpt();else setMode(button.dataset.chatTool,true);
   };
  });
  if(!providerDialog.open)providerDialog.showModal();
  providerDialog.querySelector('#chat-provider-title').focus({preventScroll:true});
 }

 function bind(){
  root.querySelector('[data-chat-team]')?.addEventListener('click',event=>{
   capture();persist();
   const button=event.currentTarget;
   const menuTrigger=button.closest('.layout-actions-menu')?.querySelector(':scope > summary');
   team.open(menuTrigger?.getClientRects().length ? menuTrigger : button);
  });
  root.querySelectorAll('[data-chat-source-link]').forEach(link=>link.onclick=event=>{
   const href=link.getAttribute('href'),params=new URLSearchParams(href),targetPage=params.get('page'),currentNews=href?.startsWith('?')&&targetPage==='intelligence'&&!params.get('story');
   if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||targetPage!=='signals'&&!currentNews)return;
   event.preventDefault();const id=link.dataset.chatSourceLink;capture();persist();go(targetPage,{search:href,restore:true});
   if(targetPage==='signals')window.dispatchEvent(new CustomEvent('hive:signal-source',{detail:{id}}));
  });
  if(sharedToken){
   root.querySelector('[data-chat-share-back]')?.addEventListener('click',()=>{sharedToken='';store=readStore();ensureThread();sharedView=null;sharedError=false;history.replaceState(null,'',routeHref('?page=assistant'));refresh();});
   if(!sharedView&&!sharedLoading&&!sharedError){sharedLoading=true;const token=sharedToken;decodeSharedOutput(token).then(value=>{if(sharedToken===token)sharedView=value;}).catch(()=>{if(sharedToken===token)sharedError=true;}).finally(()=>{sharedLoading=false;if(sharedToken===token)refresh();});}return;
  }
  freshTurnId='';const thread=selected(),feed=root.querySelector('.chat-feed');if(feed&&restoreScroll!=null)feed.scrollTop=restoreScroll;else if(feed&&thread.turns.some(t=>t.mode===thread.mode)){const last=root.querySelector('.chat-turn:last-child');if(last)feed.scrollTop+=last.getBoundingClientRect().top-feed.getBoundingClientRect().top-8;}restoreScroll=null;
  const input=thread.mode==='material'?null:root.querySelector('[data-chat-input]');if(input){input.oninput=()=>{thread.draft=input.value;root.querySelector('.chat-send').disabled=waiting(thread)||!toolSelections.has(thread.id)&&thread.mode==='ask'&&!input.value.trim()&&!thread.sources.length;const suggestions=root.querySelector('.chat-followups');if(suggestions)suggestions.hidden=!!input.value.trim();persist();};input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229&&(!globalThis.matchMedia?.('(pointer:coarse)').matches||e.metaKey||e.ctrlKey)){e.preventDefault();send();}};root.querySelector('.chat-composer').onsubmit=e=>{e.preventDefault();send();};}
  root.querySelectorAll('[data-chat-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.chatMode));
  root.querySelectorAll('[data-chat-watchlist]').forEach(button=>button.onclick=()=>{capture();persist();restoreScroll=root.querySelector('.chat-feed')?.scrollTop??null;go('watchlist');});
  root.querySelector('[data-chat-tools]')?.addEventListener('click',openProviderTools);
  root.querySelectorAll('[data-chat-exchange]').forEach(button=>{button.onclick=()=>openCapabilityPicker(button);button.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();openCapabilityPicker(button);}};});
  root.querySelector('[data-chat-tool-clear]')?.addEventListener('click',()=>{capture();toolSelections.delete(thread.id);repaint('[data-chat-input]');});
  for(const [selector,field]of [['[data-chat-tool-asset]','asset'],['[data-chat-tool-period]','period']]){const control=root.querySelector(selector);if(control)control.onchange=()=>{const selection=toolSelections.get(thread.id);if(selection)selection[field]=control.value;};}
  root.querySelector('[data-chat-provider-clear]')?.addEventListener('click',()=>{capture();thread.providerTask=null;persist();repaint('[data-chat-input]');});
  root.querySelectorAll('[data-chat-repeat]').forEach(button=>button.onclick=()=>{const previous=thread.turns.find(t=>t.id===button.dataset.chatRepeat);if(!previous||busy(thread))return;capture();if(thread.draft.trim()||thread.sources.length||thread.mode!=='ask'){if(!startChat(previous.question))return;}else{thread.draft=previous.question;thread.providerTask=null;toolSelections.delete(thread.id);repaint();}void send();});
  root.querySelectorAll('[data-chat-local]').forEach(button=>button.onclick=()=>{const turn=thread.turns.find(t=>t.id===button.dataset.chatLocal);if(!turn)return;capture();if(thread.draft.trim()&&thread.draft.trim()!==turn.question){notify(L('输入框里还有草稿，请先发送或保存到新对话。','There is a draft in the composer. Send it or keep it in a new chat first.'));return;}let sources=thread.sources.map(s=>({...s}));for(const source of turn.sources){const result=addSource(sources,source);if(result.error==='limit'){notify(L('资料已达上限，请先处理当前资料。','The source limit is reached. Finish with the current sources first.'));return;}if(!result.error)sources=result.sources;}thread.providerTask=null;thread.draft=turn.question;thread.sources=sources;thread.mode='ask';persist();repaint('[data-chat-input]');});
  root.querySelector('[data-chat-analyze]')?.addEventListener('click',()=>send({fromChart:true}));
  const marketChart=root.querySelector('[data-trading-chart="assistant-market"]');if(marketChart?.dataset?.tradingChart==='assistant-market'){const ready=()=>{const button=root.querySelector('[data-chat-analyze]');if(button)button.disabled=!['live','snapshot'].includes(marketChart.dataset.chartState);};marketChart.addEventListener('trading-chart:state',ready);ready();}
  root.querySelector('[data-chat-chart-close]')?.addEventListener('click',()=>{capture();thread.chartOpen=false;persist();repaint();});
  root.querySelector('[data-chat-change-window]')?.addEventListener('click',()=>{capture();thread.windowTurnId='';thread.chartOpen=true;persist();repaint();root.querySelector('.chat-feed').scrollTop=0;});
  root.querySelector('[data-report-generate]')?.addEventListener('click',()=>send());
  root.querySelector('[data-report-record]')?.addEventListener('change',event=>{capture();thread.reportId=event.target.value;persist();repaint('[data-report-record]');});
  root.querySelector('[data-report-reuse]')?.addEventListener('click',()=>{const report=selectedReport(thread)?.report;if(!report)return;capture();thread.research=normalizeResearchConfig(report.config);thread.reportOpen=true;persist();repaint();root.querySelector('.chat-feed').scrollTop=0;});
  root.querySelectorAll('[data-chat-followup]').forEach(button=>button.onclick=()=>{capture();if(thread.draft.trim())return;const prompt=followups().find(([id])=>id===button.dataset.chatFollowup);if(!prompt)return;thread.draft=L(prompt[1],prompt[2]);const input=root.querySelector('[data-chat-input]');if(input)input.value=thread.draft;send();});
  root.querySelector('[data-report-toggle]')?.addEventListener('click',()=>{capture();thread.reportOpen=thread.reportOpen===false;persist();repaint();});
  root.querySelectorAll('[data-report-field]').forEach(field=>field.addEventListener('change',()=>{capture();const value={...thread.research,[field.dataset.reportField]:field.value};if(field.dataset.reportField==='window'&&field.value!=='custom')value.end=researchDate(RESEARCH_AS_OF);thread.research=normalizeResearchConfig(value);persist();repaint('[data-report-field="'+field.dataset.reportField+'"]');}));
  root.querySelectorAll('[data-report-depth]').forEach(button=>button.onclick=()=>{capture();thread.research=normalizeResearchConfig({...thread.research,depth:button.dataset.reportDepth});persist();repaint();});
  root.querySelector('[data-report-add]')?.addEventListener('change',event=>{capture();const c=thread.research,field=c.scope==='assets'?'assets':'sectors',limit=field==='assets'?5:3;if(!event.target.value)return;if(c[field].length>=limit){notify(L(`最多选择 ${limit} 项`,`Choose up to ${limit} items`));event.target.value='';return;}thread.research=normalizeResearchConfig({...c,[field]:[...c[field],event.target.value]});persist();repaint('[data-report-add]');});
  root.querySelectorAll('[data-report-remove]').forEach(button=>button.onclick=()=>{capture();const c=thread.research,field=c.scope==='assets'?'assets':'sectors';thread.research=normalizeResearchConfig({...c,[field]:c[field].filter(id=>id!==button.dataset.reportRemove)});persist();repaint();});
  root.querySelectorAll('[data-chat-add]').forEach(b=>b.onclick=openExcerpt);
  root.querySelectorAll('[data-chat-reuse]').forEach(b=>b.addEventListener('click',()=>{capture();for(const source of thread.turns.at(-1)?.sources||[])attach({...source});thread.mode='material';thread.providerTask=null;persist();repaint('[data-chat-input]');}));
  root.querySelectorAll('[data-chat-remove]').forEach(b=>b.onclick=()=>{capture();thread.sources.splice(Number(b.dataset.chatRemove),1);persist();repaint();});
  root.querySelectorAll('[data-chat-go]').forEach(b=>b.onclick=()=>{capture();persist();go(b.dataset.chatGo);});
  root.querySelectorAll('[data-commerce-context]').forEach(link=>link.onclick=()=>{capture();persist();});
  root.querySelector('[data-chat-asset]')?.addEventListener('change',e=>{capture();thread.asset=e.target.value;thread.windowTurnId='';thread.range=null;thread.chartOpen=true;persist();repaint();});
  root.querySelectorAll('[data-chat-period]').forEach(b=>b.onclick=()=>{capture();thread.period=b.dataset.chatPeriod;thread.windowTurnId='';thread.range=null;thread.chartOpen=true;persist();repaint();});
  root.querySelector('[data-chat-new]').onclick=()=>startChat();
  root.querySelectorAll('[data-chat-thread]').forEach(b=>b.onclick=()=>{capture();store.active=b.dataset.chatThread;drawerOpen=false;persist();restoreScroll=0;repaint();});
  root.querySelectorAll('[data-chat-pin]').forEach(b=>b.onclick=()=>{capture();const t=store.threads.find(t=>t.id===b.dataset.chatPin);t.pinned=!t.pinned;persist();repaint();});
  root.querySelector('[data-chat-history]').onclick=()=>{capture();drawerOpen=true;persist();repaint();root.querySelector('.chat-history-dismiss')?.focus();};root.querySelectorAll('[data-chat-history-close]').forEach(b=>b.onclick=()=>{capture();drawerOpen=false;persist();repaint('[data-chat-history]');});
  const suggest=i=>{
   const prompt=prompts()[i];if(!prompt||busy(thread))return;
   capture();
   if(thread.draft.trim()||thread.sources.length||toolSelections.has(thread.id)){
    if(!startChat(prompt.question))return;
   }else{
    thread.providerTask=null;thread.mode='ask';thread.draft=prompt.question;
    persist();repaint('[data-chat-input]');
   }
   void send();
  };
  root.querySelectorAll('[data-chat-prompt]').forEach(b=>b.onclick=()=>suggest(Number(b.dataset.chatPrompt)));root.querySelector('[data-chat-pet]')?.addEventListener('click',()=>suggest(petPrompt++%3));
  root.querySelectorAll('[data-chat-window]').forEach(b=>b.onclick=()=>{capture();const v=thread.turns.find(t=>t.id===b.dataset.chatWindow)?.technical,asset=MARKET.find(a=>a.symbol===v?.asset);if(!v||!asset)return;if(v.bars?.length!==v.count||v.bars[0]?.time!==v.start||v.bars.at(-1)?.time!==v.end){notify(L('原区间已不在当前资料中，请重新选择','This window is no longer in the current source. Select a new window.'));return;}thread.asset=v.asset;thread.period=v.period;thread.windowTurnId=b.dataset.chatWindow;thread.range={start:0,count:v.count};thread.chartOpen=true;thread.providerTask=null;thread.mode='technical';persist();repaint();root.querySelector('.chat-feed').scrollTop=0;});
  root.querySelectorAll('[data-chat-retry]').forEach(b=>b.onclick=async()=>{const turn=thread.turns.find(t=>t.id===b.dataset.chatRetry);if(!turn||busy(thread)||turn.modelReply?.state!=='error')return;pendingThreads.add(thread);try{turn.modelReply={state:'pending'};persist();repaint();await loadAnswer(thread,turn);}finally{pendingThreads.delete(thread);}});
  root.querySelectorAll('[data-chat-continue]').forEach(b=>b.onclick=()=>send({continueId:b.dataset.chatContinue}));
  root.querySelectorAll('[data-chat-citation]').forEach(b=>b.onclick=()=>{const body=b.closest('.chat-answer-body'),evidence=body.querySelector('.chat-evidence'),source=evidence?.querySelectorAll('.chat-source details')[Number(b.dataset.chatCitation)];if(!source)return;evidence.open=true;source.open=true;source.scrollIntoView({block:'nearest'});});
  root.querySelectorAll('[data-chat-copy]').forEach(b=>b.onclick=async()=>{const text=resultText(b.closest('.chat-answer-body').querySelector('.chat-result'));try{await navigator.clipboard.writeText(text);notify(L('回答已复制','Answer copied'),{tone:'success'});}catch{notify(L('复制未成功，可直接选中回答文字','Copy failed. Select the answer text to copy it.'),{tone:'error'});}});
  root.querySelectorAll('[data-chat-share]').forEach(button=>button.onclick=()=>openShare(button));
  root.querySelector('[data-chat-file]').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>CHAT_LIMITS.fileBytes||!/[.](txt|md|csv|json)$/i.test(file.name)){notify(L('支持 64 KB 以内的 TXT、MD、CSV、JSON 文件','Use a TXT, MD, CSV or JSON file up to 64 KB'),{tone:'error'});return;}try{const text=await file.text();if(document.body.dataset.page!=='assistant'||selected().id!==thread.id)return;if(text.includes('\u0000')){notify(L('这个文件不是可读取的文本','This file is not readable text'),{tone:'error'});return;}if(text.length>6000){notify(L('资料超过 6,000 字，请先摘取需要的部分','Source exceeds 6,000 characters. Paste the relevant excerpt instead.'),{tone:'error'});return;}if(attach({id:crypto.randomUUID(),title:file.name,text,kind:'file'})){thread.providerTask=null;thread.mode='material';persist();repaint();}}catch{if(document.body.dataset.page!=='assistant'||selected().id!==thread.id)return;notify(L('没有读到文件，请换一份文本资料','Could not read the file. Try another text source.'),{tone:'error'});}};
 }
 function accept(source){
  capture();const current=selected(),checked=addSource([],source);
  if(checked.error){notify(L('资料内容为空','The source is empty'),{tone:'error'});return false;}
  if(current.sources.some(item=>item.text===checked.sources[0].text&&item.title===checked.sources[0].title)){persist();return true;}
  if(sourceNeedsNewThread(current)){
   if(store.threads.length>=CHAT_LIMITS.threads){notify(L('已保留 12 个对话，请选择已有对话继续；记录可以导出。','All 12 chat slots are in use. Continue in an existing chat; records can be exported.'));return false;}
   const thread=newThread();store.threads.unshift(thread);store.active=thread.id;
  }
  const thread=selected();thread.sources=checked.sources;thread.providerTask=null;thread.mode='ask';
  thread.draft=L('这份资料说明了什么？哪些地方还需要确认？','What does this source say, and what still needs confirmation?');persist();return true;
 }

 function pageSource(page,selection=''){
  if(!selection&&page==='signals')return signalSource();
  if(!selection&&['opportunities','strategies','my-strategies','validation'].includes(page)){
   const detail=root.querySelector('.sig-detail-aside,.sc-my-card,.biz-op-detail,.validation-detail');
   const cards=[...root.querySelectorAll('.sc-card,.sig-event')].slice(0,3);
   const text=(detail?.innerText||cards.map(el=>el.matches('.sc-card')?[...el.querySelectorAll('.sc-strategy-code,h3,p,.sc-facts')].map(part=>part.innerText).join('\n'):el.innerText).join('\n\n')||root.innerText).slice(0,6000);
   return {id:routeSearch(),title:root.querySelector('h1')?.innerText||L('页面摘录','Page excerpt'),text,href:routeSearch(),kind:'excerpt'};
  }
  const params=new URLSearchParams(location.search),a=MARKET.find(a=>a.symbol===params.get('asset')),m=METRICS.find(m=>m.id===params.get('metric')),story=NEWS.find(n=>n.id===params.get('story'));
  const title=selection?L('页面摘录','Page excerpt'):a?`${a.symbol} · ${L('行情快照','Market snapshot')}`:m?m.name:story?story.title:root.querySelector('h1')?.innerText||L('市场资料','Market sources');
  const text=selection|| (a?`${SNAPSHOT}\n${a.symbol}: ${price(a.price)} ${a.unit}\n24h: ${n(a.change)}%\nOI: ${a.oi??'—'} million USD\n${L('本地模拟快照','Local demo snapshot')}`:m?`${SNAPSHOT}\n${m.name}: ${m.value} ${m.unit}\n${m.description}\n${m.observation||m.reason||''}\n${m.caution||''}`:story?`${story.title}\n${story.body||story.detail||story.title}\n${SNAPSHOT}`:page==='intelligence'?NEWS.slice(0,3).map(n=>n.title+'\n'+(n.body||n.detail||'')).join('\n\n'):page==='tracking'?METRICS.slice(0,3).map(m=>m.name+': '+m.value+' '+m.unit+'\n'+m.description).join('\n\n'):MARKET.slice(0,8).map(a=>`${a.symbol}: ${price(a.price)} ${a.unit}; 24h ${n(a.change)}%`).join('\n'));
  return {id:routeSearch()+(selection?':excerpt':''),title,text,href:routeSearch(),kind:a?'market':m?'chain':story||page==='intelligence'?'news':'excerpt'};
 }
 function decorate(page){
  if(!DATA_PAGES.includes(page)&&!['signals','opportunities','strategies','my-strategies','validation'].includes(page))return;const header=root.querySelector('.sc-heading-end,.sig-page-header>div,.da-breadcrumb,.dc-market-heading,.dc-head,.df-page-head,.df-top,.p-head');if(!header||header.querySelector('[data-chat-context]'))return;
  const b=document.createElement('button');b.type='button';b.className='chat-context-button';b.dataset.chatContext='';b.setAttribute('aria-label',L('问 AI','Ask AI'));b.title=L('问 AI','Ask AI');b.innerHTML=icon('chat')+`<span class="chat-context-long">${L('问 AI','Ask AI')}</span><span class="chat-context-short">${L('问 AI','Ask AI')}</span>`;b.setAttribute('data-localized-ui','');let selection='';b.onpointerdown=()=>{selection=window.getSelection()?.toString().trim()||'';};b.onclick=()=>{const source=pageSource(page,selection);if(page==='signals'&&!source){notify(L('调整筛选或研究偏好，也可以查看全市场。','Adjust your filters or preferences, or view all markets.'));return;}if(accept(source))go('assistant');};header.append(b);
 }
 document.addEventListener('keydown',e=>{if(e.key==='Tab'&&drawerOpen&&matchMedia('(max-width:900px)').matches&&document.body.dataset.page==='assistant'){const items=[...root.querySelectorAll('.chat-history button:not(:disabled),.chat-history a[href]')].filter(el=>el.getClientRects().length),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}if(e.key==='Escape'&&drawerOpen&&document.body.dataset.page==='assistant'){capture();drawerOpen=false;persist();repaint('[data-chat-history]');}});
 return {render,bind,decorate,accept,capture,compose(prompt){return startChat(clipText(prompt,2000));},closeSource(){team.close(false);exchangeLoadTicket++;exchangeTools?.dispose();pickerListeners?.abort();sourceDialog?.close();providerDialog?.close();shareDialog?.close();drawerOpen=false;}};
}
