import {renderPaperCase} from './paper-replay/view.mjs';
// Present the registered decision first. Historical simulation is loaded on demand.
import {escapeUI as e} from './product-experience.mjs';
import {uiGlyph} from './product-composition.mjs';

const strategies={
  trend:['趋势跟随','Trend following'],breakout:['突破','Breakout'],pullback:['回调','Pullback'],cash:['持有现金','Cash']
};
const reasons={
  filled:['已模拟成交','Simulated fill'],skipped:['未下单','No trade'],stop_loss:['触发止损','Stop loss'],
  session_close:['收盘退出','Session close'],pending:['等待核对','Awaiting outcome'],
  settled:['已核对','Settled'],expired:['已过期','Expired'],
  highest_eligible_score:['合格策略中得分最高','Highest eligible score'],no_candidate_beats_cash:['合格策略均未跑赢现金门槛','No qualifying score above cash'],
  signal_absent:['当日信号未触发','No signal at cutoff'],small_sample:['校准样本不足','Insufficient calibration samples'],
  nonpositive_score:['风险调整后得分未高于零','Risk-adjusted score at or below zero'],qualified:['通过信号与样本检验','Signal and sample checks passed'],
  cash_baseline:['零收益现金基准','Zero-return cash benchmark'],cash_selected:['持有现金','Cash selected'],within_limits:['风险敞口在限额内','Exposure within limits'],
  volatility_limit:['波动率超过上限','Volatility limit exceeded'],opening_gap:['开盘跳空超过上限','Opening gap exceeded limit'],
  allow:['允许建仓','Allow entry'],reduce:['缩减仓位','Reduce size'],wait:['等待','Wait'],pause:['暂停','Pause'],
  conservative:['保守','Conservative'],normal:['常规','Standard'],budget:['可用风险预算不足','Risk budget exhausted'],
  account:['账户状态待核对','Account check required'],daily:['触及单日亏损限额','Daily loss limit'],epoch:['触及周期亏损限额','Period loss limit'],
  drawdown:['触及回撤限额','Drawdown limit'],policy:['风控配置无效','Invalid risk policy'],
  open_risk_reduced:['开盘复核后缩减','Reduced at open'], verified:['已核验','Verified'],
  blocked:['已拦截','Blocked'],waiting:['等待核验','Waiting'], abstain:['持有现金','Hold cash'],
  hold_cash:['维持现金','Hold cash'],admit_paper:['允许模拟下单','Paper entry permitted'],
  awaiting_session_close:['等待交易日收盘','Awaiting session close'],
  paper_only:['仅限模拟执行','Paper execution only'],unavailable:['暂无可用操作','No action available'],
  standard_volatility:['波动在常规范围','Normal volatility'],elevated_volatility:['波动升高','Elevated volatility'],
  equity_drawdown:['账户回撤','Account drawdown'],
  venue_conflict_veto:['复查发现行情冲突，原模拟指令已撤销','Market data conflict. Original paper dispatch revoked'],
  matched:['逐根匹配','Matched'],conflict:['行情不一致','Conflict'],stale:['行情过期','Stale data'],
  halt:['暂停','Halt'],
  source_observation_missing:['缺少登记前的交易所行情核对','No pre-registration venue observation'],
  source_observation_conflict:['交易所行情与归档不一致','Venue candles differ from the archive'],
  source_observation_stale:['交易所观察已过期','Venue observation is stale'],
  source_observation_unavailable:['暂时无法核对交易所行情','Venue observation unavailable'],
  stale_evidence:['缺少本次研判所需的最新收盘日线','Latest required daily close is missing'],
  invalid_evidence:['采集的行情未通过完整性检查','Collected market data failed integrity checks'],
  insufficient_evidence:['已收盘日线数量不足','Too few closed daily bars'],
  missed_commit_window:['已错过开盘前的登记窗口','Pre-open registration window elapsed'],
  awaiting_registration:['等待事前登记','Awaiting registration'],awaiting_session_open:['等待目标市场开盘','Awaiting session open'],
  awaiting_handoff:['等待下达模拟指令','Awaiting paper dispatch'],awaiting_receipt:['等待模拟回执','Awaiting paper receipt'],
  record_frozen:['原始登记与指纹一致','Registration matches its fingerprint'],source_and_instrument_verified:['交易场所、交易对与行情匹配','Source matches the instrument'],
  closed_before_registration:['日线收盘先于决策登记','All bars closed before registration'],candidate_ranking_reproduced:['从冻结数据复算出相同排名','Ranking reproduced from frozen data'],
  abstention_binding:['持有现金的下单额度为零','Cash decision limits notional to zero'],size_within_limits:['额度未超出冻结预算','Notional fits the frozen risk budget'],
  paper_handoff_verified:['指令与登记及额度一致','Dispatch matches the decision and limit'],paper_receipt_reconciled:['模拟回执与冻结指令相符','Paper receipt matches the dispatch'],
  prerequisite_unverified:['等待前置核验','Preceding check incomplete'],invalid_request:['核验请求无效','Invalid review request'],
  commit_digest_mismatch:['登记指纹不匹配','Registration fingerprint mismatch'],intent_digest_mismatch:['决策指纹不匹配','Decision fingerprint mismatch'],
  unsupported_intent:['决策版本不受支持','Unsupported decision version'],wrong_registration:['登记市场或日期不匹配','Registered market or date mismatch'],
  invalid_registration_clock:['登记时间无效','Invalid registration time'],source_digest_mismatch:['行情归档指纹不匹配','Market archive fingerprint mismatch'],
  instrument_mismatch:['交易市场不匹配','Market identity mismatch'],snapshot_digest_mismatch:['行情快照指纹不匹配','Market snapshot fingerprint mismatch'],
  stale_or_future_evidence:['行情时间与登记窗口不符','Market timestamps fall outside the decision window'],
  candidate_replay_mismatch:['候选策略无法复算','Candidate ranking could not be reproduced'],selection_mismatch:['所选策略与排名不符','Selected strategy differs from ranking'],
  risk_replay_mismatch:['风控结果无法复算','Risk decision could not be reproduced'],risk_budget_exceeded:['订单超过风险额度','Order exceeds the risk budget'],
  route_not_authorized:['执行通道未获授权','Execution route not authorized'],dispatch_digest_mismatch:['指令指纹不匹配','Dispatch fingerprint mismatch'],
  dispatch_scope_mismatch:['指令超出登记范围','Dispatch differs from its registered scope'],invalid_dispatch_clock:['指令未在规定时间下达','Dispatch outside the permitted window'],
  missing_preopen_handoff:['开盘前未下达指令','No dispatch before open'],receipt_lineage_mismatch:['回执与原始指令不匹配','Receipt does not match the dispatch'],
  invalid_receipt_clock:['回执时间无效','Invalid receipt time'],receipt_exceeds_authority:['回执中的执行超出授权','Receipt exceeds the authorized amount'],
  unbound_receipt:['回执与登记尚未关联','Receipt is not bound to this registration'],invalid_market_evidence:['行情未通过校验','Invalid market evidence'],
  receipt_replay_mismatch:['模拟回执无法复算','Paper receipt could not be reproduced'],invalid_proof:['凭据未通过校验','Decision proof failed verification']
};
const residual=value=>String(value??'').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
const endpoint=params=>'/api/brain/proof'+(params?'?'+new URLSearchParams(params):'');
const date=value=>{
  const time=new Date(value??'').getTime();
  return Number.isFinite(time)?new Date(time).toISOString().slice(0,10):'—';
};
const stamp=value=>{
  const time=new Date(value??'').getTime();
  return Number.isFinite(time)?new Date(time).toISOString().slice(0,19).replace('T',' ')+' UTC':'—';
};
function sourceLink(value,label){
  if(typeof value!=='string')return '';
  try{
    const url=new URL(value,location.origin);
    if(url.protocol!=='https:' && !(url.origin===location.origin && url.protocol==='http:'))return '';
    return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(label)}&nbsp;↗</a>`;
  }catch{return '';}
}
function formatters(en){
  const locale=en?'en-US':'zh-CN';
  const formats=new Map();
  function number(value,digits=2){
    if(!Number.isFinite(value))return '—';
    if(!formats.has(digits))formats.set(digits,new Intl.NumberFormat(locale,{maximumFractionDigits:digits}));
    return formats.get(digits).format(value);
  }
  return {
    number,
    percent:(value,signed=false)=>Number.isFinite(value)?(signed && value>0?'+':'')+number(value)+'%':'—',
    amount:(value,unit,digits=2)=>Number.isFinite(value)?number(value,digits)+' '+unit:'—'
  };
}
const signClass=value=>(value>0?'is-positive':value<0?'is-negative':'');
const fact=(label,value)=>`<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;

// The next calendar decision may have been frozen before this session closed.
export function nextLearningSession(decisions,record){
  const close=Date.parse(record.execution.barCloseAt);
  return decisions.find(row=>row.barOpenAt>record.barOpenAt && Date.parse(row.asOf)>=close);
}
export function linksLearningReceipt(before,after){
  return Boolean(before.execution?.id && after.assetKey===before.assetKey && after.mode===before.mode &&
    after.previousReceiptId===before.execution.id && after.previousReceiptAt===before.execution.barCloseAt &&
    Date.parse(after.asOf)>=Date.parse(before.execution.barCloseAt));
}

// Native adaptation of Klyv Animated Beam (21st.dev/@klyv-ui/components/klyv-animated-beam).
/*
MIT License

Copyright (c) 2026 Klyv contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
function mountLearningBeam(flow,replay,signal){
  const svg=flow.querySelector('.bl-links');
  const nodes=[...flow.querySelectorAll('.bl-node')];
  const links=[...svg.querySelectorAll('g')];
  function measure(){
    const bounds=flow.getBoundingClientRect();
    if(!bounds.width || !bounds.height)return;
    const centers=nodes.map(node=>{
      const r=node.getBoundingClientRect();
      return {x:r.left-bounds.left+r.width/2,y:r.top-bounds.top+r.height/2};
    });
    svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);
    links.forEach((group,i)=>{
      const a=centers[i],b=centers[i+1],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
      const bend=Math.min(29,len*.13)*(i===0?1:-1);
      for(const path of group.children){
        const bow=bend*Number(path.dataset.bow);
        const cx=(a.x+b.x)/2-dy/len*bow,cy=(a.y+b.y)/2+dx/len*bow;
        path.setAttribute('d',`M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`);
      }
    });
  }
  measure();
  const resize=new ResizeObserver(measure);
  for(const element of [flow,...nodes])resize.observe(element);
  let inView=false;
  function updatePlayback(){
    flow.toggleAttribute('data-visible',inView&&!document.hidden);
    if(inView&&!document.hidden)flow.setAttribute('data-play','');
  }
  const observer=new IntersectionObserver(([entry])=>{inView=entry.intersectionRatio>=.25;updatePlayback();},{threshold:.25});
  observer.observe(flow);
  document.addEventListener('visibilitychange',updatePlayback,{signal});
  replay.hidden=false;
  replay.addEventListener('click',()=>{
    flow.removeAttribute('data-play');
    void flow.offsetWidth;
    flow.setAttribute('data-play','');
  },{signal});
  signal.addEventListener('abort',()=>{resize.disconnect();observer.disconnect();replay.hidden=true;},{once:true});
}

export function mountProofView(host,replayHost,learningHost,en){
  // In these two locales the financial terms here are already rendered explicitly.
  if(/^(en|zh)(-|$)/.test(host.closest('astarter-brain')?.dataset.locale??'en')){
    for(const section of [host,replayHost,learningHost])section.dataset.noTranslate='';
  }
  const t=(zh,english)=>en?english:zh;
  const {number,percent,amount}=formatters(en);
  const name=id=>strategies[id]?.[en?1:0]??residual(id);
  const reason=id=>reasons[id]?.[en?1:0]??residual(id);
  const q=selector=>host.querySelector(selector)??replayHost.querySelector(selector);
  host.innerHTML=`
    <header class="bp-heading"><h2 id="br-proof-title">${t('决策依据','Decision proof')}</h2>
      <div class="bp-controls"><label>${t('市场','Market')}<select data-market data-native-select></select></label></div>
    </header>
    <div class="bp-panel bp-current" data-current>
      <div class="bp-state" data-current-state role="status"></div><div data-current-result hidden></div>
    </div>
    <details class="bp-replay" data-paper-example><summary>${t('模拟成交复盘 · BTC/USDT','Paper trade review · BTC/USDT')}</summary>
      <div data-paper-example-body></div></details>
    `;
  replayHost.innerHTML=`
    <header class="br-layer-head"><div class="br-layer-title"><h2 id="br-backtest-title">${t('回测复盘','Backtest review')}</h2></div>
      <div class="bp-controls"><label><span class="bp-sr">${t('市场','Market')}</span><select data-replay-market data-native-select></select></label>
        <label><span class="bp-sr">${t('回测窗口','Window')}</span><select data-window data-native-select></select></label></div>
    </header>
    <div class="bp-replay">
      <div class="bp-state" data-state role="status"></div>
      <div data-result hidden>
        <div class="bp-overview"><figure class="bp-equity" hidden>
          <figcaption><div><span>${t('模拟净值','Simulated equity')}</span><strong data-equity-value></strong></div><small data-venue></small></figcaption>
          <div class="bp-chart-frame"><div class="bp-equity-plot" data-equity-chart></div><div class="bp-chart-scale" data-equity-scale aria-hidden="true"></div></div>
          <div class="bp-axis" data-period></div>
        </figure><dl class="bp-metrics" data-metrics></dl></div>
        <div class="bp-ledger">
          <header class="bp-ledger-head"><h3>${t('决策回放','Decision replay')}</h3><div>
            <label class="bp-day"><span class="bp-sr">${t('选择执行日 (UTC)','Select execution day (UTC)')}</span><select data-day data-native-select></select></label>
            <button type="button" data-prev aria-label="${t('前一条决策','Previous decision')}" title="${t('前一条决策','Previous decision')}">‹</button>
            <button type="button" data-next-day aria-label="${t('后一条决策','Next decision')}" title="${t('后一条决策','Next decision')}">›</button>
          </div></header>
          <div data-detail></div>
        </div>
        <div class="bp-tools">
          <div class="bp-tools-nav">${[
            ['method','filter',t('成本与口径','Method & costs')],
            ['cohort','columns',t('市场对照','Compare markets')],
            ['forward','history',t('事前登记','Forward record')]
          ].map(([key,icon,label])=>`<button type="button" data-review-tool="${key}" aria-controls="bp-tool-${key}" aria-expanded="false">${uiGlyph(icon)}${label}</button>`).join('')}</div>
          <div id="bp-tool-method" data-method hidden></div>
          <div id="bp-tool-cohort" data-cohort-body hidden></div>
          <div id="bp-tool-forward" data-forward hidden></div>
        </div>
      </div>
    </div>`;
  learningHost.innerHTML=`<header class="br-layer-head"><div class="br-layer-title"><h2 id="br-learning-title">${t('Agent 自我学习','Agent learning')}</h2></div>
    <div class="bl-controls"><span class="bl-period" data-learning-period></span><button class="bl-replay" type="button" hidden
      aria-label="${t('重播学习过程','Replay learning sequence')}" title="${t('重播学习过程','Replay learning sequence')}">${uiGlyph('play')}</button></div></header>
    <div class="bl-body" data-learning-body aria-busy="false"></div>`;
  const learningBody=learningHost.querySelector('[data-learning-body]'),learningPeriod=learningHost.querySelector('[data-learning-period]');
  const emptyLearning=t('等待所选市场的模拟复盘记录。','Awaiting a replay record for this market.');
  function learningState(message,action){
    learningPeriod.textContent='';
    notice(learningBody,message,action);
    learningBody.setAttribute('aria-busy','false');
  }
  learningState(emptyLearning);
  const market=q('[data-market]'),period=q('[data-window]'),day=q('[data-day]');
  const previous=q('[data-prev]'),next=q('[data-next-day]'),cohort=q('[data-review-tool="cohort"]');
  const toolButtons=replayHost.querySelectorAll('[data-review-tool]');
  function showTool(key){
    for(const button of toolButtons){
      const open=button.dataset.reviewTool===key;
      button.setAttribute('aria-expanded',String(open));
      q('#'+button.getAttribute('aria-controls')).hidden=!open;
    }
    if(key==='cohort')loadCohort();
  }
  for(const button of toolButtons)button.onclick=()=>showTool(button.getAttribute('aria-expanded')==='true'?'':button.dataset.reviewTool);
  let scope=null,scopeLabel='',selectedMarket='',days=90,directory=null,run=null;
  let replayVisible=false;
  const currentResult=q('[data-current-result]'),currentState=q('[data-current-state]');
  let mainRequest=null,currentRequest=null,replayRequest=null,recordRequest=null,cohortRequest=null,cohortLoaded=false,disposed=false;
  let reviewDate='',latestSession='',pendingLayer='';

  async function request(params,signal){
    const response=await fetch(endpoint(params),{signal,headers:{Accept:'application/json'}});
    if(!response.ok){
      const body=await response.json().catch(()=>null);
      throw Object.assign(new Error('HTTP '+response.status),{code:body?.error?.code});
    }
    return response.json();
  }
  function notice(el,message,action){
    el.hidden=false;el.replaceChildren(document.createTextNode(message));
    if(action){
      const button=document.createElement('button');
      button.type='button';button.className='bp-retry';button.textContent=t('重试','Retry');
      button.onclick=action;el.append(' ',button);
    }
  }
  function clearRecord(){
    learningState(emptyLearning);
    recordRequest?.abort();recordRequest=null;
    run=null;cohortRequest?.abort();cohortRequest=null;cohortLoaded=false;
    showTool('');cohort.hidden=true;q('[data-forward]').replaceChildren();
    q('[data-result]').hidden=true;
  }
  function setOptions(el,rows,value){
    el.replaceChildren(...rows.map(([key,label])=>new Option(label,String(key))));
    el.value=String(value);
  }
  function setControls(){
    const all=scope==='all',assets=directory.assets;
    if(all){
      const match=assets.find(item=>item.key===selectedMarket)??assets[0];
      selectedMarket=match?.key??'';
      setOptions(market,assets.map(item=>[item.key,item.market]),selectedMarket);
    }else{
      selectedMarket=scope;
      setOptions(market,[[scope,assets.find(item=>item.key===scope)?.market??scopeLabel??scope]],scope);
    }
    market.disabled=!all || assets.length<2;
    const replayMarket=q('[data-replay-market]');
    setOptions(replayMarket,[...market.options].map(option=>[option.value,option.textContent]),selectedMarket);
    replayMarket.disabled=market.disabled;
    const windows=directory.windows??[];
    if(!windows.some(window=>String(window)===String(days)))days=directory.defaultDays??windows[0];
    setOptions(period,windows.map(window=>[window,window==='all'?t('全部历史','Full history'):t(window+' 天',window+' days')]),days);
  }
  function renderEquity(){
    const {asset,decisions,assumptions,summary}=run,figure=q('.bp-equity');
    let balance=assumptions.initialCapital;
    const equitySeries=decisions.map(row=>(balance+=Number.isFinite(row.netPnl)?row.netPnl:NaN));
    figure.hidden=!equitySeries.length || !equitySeries.every(Number.isFinite);
    if(figure.hidden)return;
    q('[data-equity-value]').innerHTML=e(number(balance))+' <small>'+e(asset.quote)+'</small>';
    q('[data-venue]').textContent=asset.venue;
    q('[data-period]').innerHTML='<time>'+date(summary.startAt)+'</time><time>'+date(summary.endAt)+' UTC</time>';
    const low=Math.min(...equitySeries),high=Math.max(...equitySeries);
    q('[data-equity-scale]').innerHTML=high===low?`<span style="top:50%">${e(number(high))}</span>`:
      `<span style="top:8%">${e(number(high))}</span><span style="top:92%">${e(number(low))}</span>`;
    const points=equitySeries.map((value,i)=>({
      x:equitySeries.length===1?50:100*i/(equitySeries.length-1),
      y:high===low?50:8+84*(high-value)/(high-low)
    }));
    const line=points.map(({x,y})=>x.toFixed(3)+','+y.toFixed(3)).join(' ');
    const dots=points.map(({x,y},i)=>decisions[i].status==='filled'
      ?`<i class="bp-fill-dot" style="left:${x}%;top:${y}%" aria-hidden="true"></i>`:'').join('');
    q('[data-equity-chart]').innerHTML=`<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="bp-equity-wash" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="currentColor" stop-opacity=".17"/><stop offset="1" stop-color="currentColor" stop-opacity=".01"/></linearGradient></defs>
        <polygon points="0,100 ${line} 100,100" fill="url(#bp-equity-wash)"/>
        <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/>
      </svg>${dots}<span class="bp-cursor" aria-hidden="true"><i></i></span>
      <output class="bp-chart-readout" aria-hidden="true"></output>
      <input data-chart-day type="range" aria-label="${t('选择回放日期','Select replay date')}" min="0" max="${points.length-1}" step="1">`;
    const slider=q('[data-chart-day]');
    const box=slider.parentElement,readout=box.querySelector('output');
    const pointLabel=index=>date(decisions[index].barOpenAt)+' · '+amount(equitySeries[index],asset.quote);
    slider.onpointermove=event=>{
      if(event.pointerType!=='mouse' || event.buttons)return;
      const rect=slider.getBoundingClientRect();
      const fraction=Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width));
      const index=Math.round(fraction*(points.length-1));
      box.style.setProperty('--bp-peek',points[index].x+'%');box.dataset.preview='';
      readout.textContent=pointLabel(index);
    };
    slider.onpointerleave=()=>{delete box.dataset.preview;readout.textContent=pointLabel(Number(slider.value));};
    slider.oninput=()=>markSession(Number(slider.value));
    slider.onchange=()=>{const row=decisions[Number(slider.value)];if(row && row.id!==day.value)loadRecord(row.id);};
    function markSession(index){
      const point=points[index];if(!point)return;
      delete box.dataset.preview;
      box.style.setProperty('--bp-x',point.x+'%');box.style.setProperty('--bp-y',point.y+'%');
      const text=pointLabel(index);
      slider.value=index;slider.setAttribute('aria-valuetext',text);
      readout.textContent=text;
    }
    return markSession;
  }
  let markEquityDay=null;
  function renderSummary(){
    const {asset,brain,summary:s,assumptions:a}=run,quote=asset.quote;
    markEquityDay=renderEquity();
    const scale=Math.max(...[s.netReturnPct,s.buyHoldReturnPct].filter(Number.isFinite).map(Math.abs),.01);
    const performance=(label,value)=>{
      const width=Number.isFinite(value)?Math.abs(value)/scale*50:0;
      return `<div class="bp-return"><dt>${label}</dt><dd><span class="bp-bar" aria-hidden="true"><i style="width:${width}%;${value<0?'right':'left'}:50%"></i></span>
        <b class="${signClass(value)}">${e(percent(value,true))}</b></dd></div>`;
    };
    q('[data-metrics]').innerHTML=performance(t('策略净收益','Net return'),s.netReturnPct)+performance(t('买入持有','Buy & hold'),s.buyHoldReturnPct)+
      `<div class="bp-stat"><dt>${t('最大回撤','Max drawdown')}</dt><dd>${e(percent(s.maxDrawdownPct))}</dd></div>
       <div class="bp-stat"><dt>${t('成交 / 决策','Trades / decisions')}</dt><dd>${e(number(s.trades,0))} <small>/ ${e(number(s.observations,0))}</small></dd></div>`;
    q('[data-method]').innerHTML=`<dl class="bp-facts">${[
      fact(t('初始资金','Starting capital'),amount(a.initialCapital,quote)),
      fact(t('扣费后损益','Net P&L'),amount(s.netPnl,quote)),
      fact(t('持有现金','Cash return'),percent(s.cashReturnPct)),
      fact(t('持仓 '+number(a.cappedHoldAllocationPct)+'% 的持有基准','Buy & hold at '+number(a.cappedHoldAllocationPct)+'% allocation'),percent(s.cappedHoldReturnPct,true)),
      fact(t('平均实际仓位','Mean capital exposure'),percent(s.meanExposurePct)),
      fact(t('每边手续费 / 滑点','Fee / slippage per side'),number(a.feeBps)+' / '+number(a.slippageBps)+' bps'),
      fact(t('模拟手续费','Simulated fees'),amount(s.fees,quote)),
      fact(t('模拟滑点成本','Simulated slippage'),amount(s.slippage,quote)),
      fact(t('盈利 / 亏损 / 持平交易','Winning / losing / flat trades'),[s.wins,s.losses,s.flat].map(v=>number(v,0)).join(' / ')),
      fact(t('跳过的决策','Skipped decisions'),number(s.skips,0)),
      fact(t('数据归档时间','Archive retrieved'),stamp(brain.retrievedAt)),
      fact(t('回测版本','Replay version'),run.version)
    ].join('')}</dl><p class="bp-method-note">${t('按历史日线逐日决策，成交价格、手续费与滑点按模拟规则计算。','Decisions use daily historical bars. Fills, fees and slippage follow the simulation rules.')}</p>
    <div class="bp-sources">${sourceLink(brain.sourceUrl,t('行情来源','Market source'))} ${sourceLink(run.sourceArchive?.url,t('冻结归档','Frozen archive'))} ${sourceLink(run.reportUrl,t('完整回测记录','Full replay record'))}</div>`;
    renderForward(run.forward,run.forwardError,quote);
    cohort.hidden=scope!=='all' || days==='all';
    const list=run.decisions;
    const latestFill=list.findLast(item=>item.status==='filled')??list.at(-1);
    setOptions(day,[...list].reverse().map(item=>[item.id,date(item.barOpenAt)+' UTC'+(item.status==='filled'?' · '+t('成交','Fill'):'')]),latestFill?.id??'');
    q('[data-state]').hidden=true;q('[data-result]').hidden=false;
    if(list.length)loadRecord(day.value);
    else{
      day.disabled=previous.disabled=next.disabled=true;
      notice(q('[data-detail]'),t('该窗口没有可核对的决策。','No decisions are available for this window.'));
    }
  }
  function renderForward(forward,forwardError,quote){
    const output=q('[data-forward]');
    if(!forward){
      output.innerHTML=`<div class="bp-forward"><h3>${t('事前登记','Forward record')}</h3><span>${forwardError?t('事前记录暂时无法读取','Forward record unavailable'):t('该市场暂无登记','No registration for this market')}</span></div>`;
      return;
    }
    const prior=Array.isArray(forward.recent)?forward.recent:[];
    const history=prior.length?`<details class="bp-forward-history"><summary>${t('往期登记','Earlier registrations')} · ${prior.length}</summary>
      <table><thead><tr><th>${t('执行日','Session')} (UTC)</th><th>${t('策略','Strategy')}</th><th>${t('结果','Outcome')}</th></tr></thead><tbody>${prior.map(row=>`<tr>
        <th scope="row">${sourceLink(endpoint({forward:1,asset:run.asset.key,date:row.date}),row.date)}</th>
        <td>${e(name(row.selected))}</td><td>${e(row.status==='settled'?reason(row.action)+' · '+amount(row.netPnl,forward.quote??quote):reason(row.status))}</td>
      </tr>`).join('')}</tbody></table></details>`:'';
    output.innerHTML=`<div class="bp-forward"><h3>${t('事前登记','Forward record')}</h3><strong>${e(reason(forward.status))}</strong>
    <dl class="bp-facts">${fact(t('登记时间','Recorded at'),stamp(forward.recordedAt))}${fact(t('目标开盘','Target open'),stamp(forward.targetOpenAt))}
    ${fact(t('选定策略','Selected strategy'),name(forward.selected))}${fact(t('风控模式','Risk policy'),reason(forward.riskMode))}
    ${fact(t('模拟损益','Simulated P&L'),forward.receipt && Number.isFinite(forward.receipt.netPnl)?amount(forward.receipt.netPnl,forward.quote??quote):reason(forward.status))}</dl>
    <details><summary>${t('登记编号','Record ID')}</summary><code>${e(forward.id)}</code>
    <div class="bp-sources">${sourceLink(endpoint({forward:1,asset:run.asset.key,date:date(forward.targetOpenAt),evidence:1}),t('登记依据与回执','Registration and evidence'))}</div></details>${history}</div>`;
  }
  async function loadHistory(){
    if(!replayVisible || !directory || !selectedMarket)return;
    replayRequest?.abort();
    const controller=replayRequest=new AbortController();
    clearRecord();notice(q('[data-state]'),t('正在读取回测记录…','Loading replay…'));
    try{
      const response=await request({asset:selectedMarket,days},controller.signal);
      if(disposed || controller.signal.aborted)return;
      if(response.asset?.key!==selectedMarket || !Array.isArray(response.decisions))throw new Error('Invalid replay');
      run=response;renderSummary();
    }catch(error){
      if(disposed || controller.signal.aborted)return;
      const errors={
        INSUFFICIENT_EVIDENCE:t('历史样本不足，无法核对这个窗口。','There is insufficient history for this window.'),
        INVALID_EVIDENCE:t('归档行情未通过完整性检查。','The market archive failed its integrity checks.'),
        UNSUPPORTED_ASSET:t('该市场暂无历史回测。','No historical replay for this market.')
      };
      const message=errors[error.code]??t('回测记录暂时无法读取。','Replay data is temporarily unavailable.');
      const retry=errors[error.code]?null:loadHistory;
      notice(q('[data-state]'),message,retry);learningState(message,retry);
    }finally{
      if(replayRequest===controller)replayRequest=null;
    }
  }
  async function load(){
    mainRequest?.abort();currentRequest?.abort();replayRequest?.abort();clearRecord();
    reviewDate='';latestSession='';
    const controller=mainRequest=new AbortController();
    currentResult.hidden=true;currentResult.replaceChildren();
    notice(currentState,t('正在核对事前记录…','Checking the registered decision…'));
    try{
      directory??=await request(null,controller.signal);
      if(disposed || controller.signal.aborted)return;
      setControls();
      if(replayVisible)loadHistory();
      if(!selectedMarket){
        const empty=t('暂无可核对的市场。','No market is available for review.');
        clearRecord();notice(currentState,empty);notice(q('[data-state]'),empty);learningState(empty);
        return;
      }
      await loadCurrent();
    }catch{
      if(!disposed && !controller.signal.aborted){
        const message=t('市场列表暂时无法读取。','The market list is temporarily unavailable.');
        notice(currentState,message,load);notice(q('[data-state]'),message,load);learningState(message,load);
      }
    }
  }
  async function loadCurrent(){
    currentRequest?.abort();
    const controller=currentRequest=new AbortController();
    try{
      const params={current:1,asset:selectedMarket};
      if(reviewDate)params.date=reviewDate;
      const response=await request(params,controller.signal);
      if(disposed || controller.signal.aborted)return;
      if(response.assetKey!==selectedMarket || !response.decisionProof || (reviewDate && response.targetDate!==reviewDate))throw new Error('Invalid decision proof');
      if(!reviewDate)latestSession=response.targetDate;
      renderCurrent(response);
    }catch(error){
      if(disposed || controller.signal.aborted)return;
      currentResult.hidden=true;
      if(error.code==='UNSUPPORTED_ASSET')notice(currentState,t('尚未覆盖该资产的决策登记。','Decision records do not cover this asset yet.'));
      else notice(currentState,t('本次决策暂时无法核对。','The decision could not be checked.'),loadCurrent);
    }
  }
  function stage(title,main,body){
    return `<article class="bp-stage" tabindex="-1" data-proof-layer="${title.split(' ')[0].toLowerCase()}"><h4>${title}</h4><strong>${e(main)}</strong>${body}</article>`;
  }
  function venueDetail(response){
    const source=response.decisionProof.assurance?.source,review=response.venueReview;
    if(!source && !review)return '';
    const bound=source?.status==='verified';
    const legacy=source?.status==='not_recorded_at_registration';
    const records=[];
    if(bound)records.push([t('登记前逐根核对','Cross-check at registration'),source,review?.id===source.id?review:null]);
    if(review && (!bound || review.id!==source.id)){
      const afterRegistration=Date.parse(review.observedAt)>Date.parse(response.decisionProof.recordedAt);
      const label=afterRegistration?t('登记后补查','Post-registration cross-check'):t('交易所复查','Venue cross-check');
      records.push([label,review,review]);
    }
    const registration=legacy?fact(t('登记时来源','At registration'),t('原始登记未绑定交易所复查','No venue observation was bound to the original registration')):
      source?.status==='blocked'?fact(t('登记时来源','At registration'),reason(source.reason)):'';
    return `<div data-venue-audit>${registration?`<dl class="bp-facts">${registration}</dl>`:''}${records.map(([label,row,links])=>{
      const total=row.totalBars??response.decisionProof.evidence?.barCount;
      const matched=Number.isSafeInteger(row.matchedBars) && Number.isSafeInteger(total)?
        t(row.matchedBars+' / '+total+' 根日线匹配',row.matchedBars+' / '+total+' daily bars matched'):'';
      const result=[row.venue,matched,row.status && row.status!=='verified' && row.status!=='matched'?(row.status==='unavailable'?t('无法取得行情','Venue data unavailable'):reason(row.status)):''].filter(Boolean).join(' · ');
      return `<dl class="bp-facts">${fact(label,result || '—')}${fact(t('观测时间','Observed at'),stamp(row.observedAt))}</dl>
        <div class="bp-sources">${sourceLink(links?.documentUrl,t('核对记录','Observation'))} ${sourceLink(links?.responseUrl,t('交易所原始响应','Venue response'))}</div>`;
    }).join('')}</div>`;
  }
  function policyDetail(witness,quote){
    const risk=witness?.risk;
    if(witness?.status!=='verified' || !risk?.profiles?.length)return '';
    return `<details data-policy-audit><summary>${t('风控方案','Risk policies')} · ${e(reason(risk.effectiveProfile))}</summary>
      <table><thead><tr><th>${t('方案','Policy')}</th><th>${t('风险预算','Risk budget')}</th><th>${t('最高额度','Order limit')}</th></tr></thead>
      <tbody>${risk.profiles.map(row=>`<tr><th scope="row">${e(reason(row.mode))}${row.applies?' · '+t('已选','Selected'):''}</th><td>${e(amount(row.riskBudget,quote))}</td><td>${e(amount(row.maxNotional,quote))}</td></tr>`).join('')}</tbody></table></details>`;
  }
  function comparisonDetail(comparison,quote){
    if(!comparison || !['verified','pending'].includes(comparison.status) || !comparison.planId)return '';
    const results=comparison.results;
    const cashLabel=t('持有现金','Hold cash');
    const allocation=results?.cappedHold?.allocationPct??10;
    const holdLabel=t(allocation+'% 仓位开盘买、收盘卖',allocation+'% open-to-close hold');
    const unit=comparison.quote??quote;
    const content=comparison.status==='verified' && results?`<dl class="bp-facts">${[
      fact(t('策略净损益','Strategy net P&L'),amount(results.strategyNetPnl,unit)),fact(cashLabel,amount(results.cash.netPnl,unit)),
      fact(holdLabel,amount(results.cappedHold.netPnl,unit)),fact(t('相对持有的差额','Difference vs hold'),amount(results.excessVsCappedHold,unit))
    ].join('')}</dl>`:`<p class="bp-current-note">${t('对照组已在开盘前固定，等待模拟回执。','The controls were set before the open. Awaiting the paper receipt.')} ${e(cashLabel)} · ${e(holdLabel)}</p>`;
    return `<details data-forward-controls><summary>${t('事前对照','Pre-registered controls')}</summary>${content}</details>`;
  }
  function renderCurrent(response){
    const proof=response.decisionProof,ev=proof.evidence,d=proof.decision,x=proof.execution;
    const checks=Array.isArray(proof.checks)?proof.checks:[];
    const refusal=!response.commitId && proof.status==='blocked'?response.refusal?.document:null;
    const veto=proof.reason==='venue_conflict_veto',blocked=proof.status==='blocked'||veto;
    const dispatch=blocked?null:response.dispatch?.document;
    const receipt=blocked?null:response.receipt,asset=directory.assets.find(row=>row.key===selectedMarket);
    const quote=ev?.quote??x?.quote??asset?.quote??'';
    const cash=d?.selected==='cash',r=d?.risk,f=d?.features;
    const candidates=Array.isArray(d?.candidates)?d.candidates:[];
    const marketName=ev?.market??asset?.market??scopeLabel;
    const why=code=>reason(code)||'—';
    const waitingForRegistration=!proof.commitId&&!response.commitId&&!blocked;
    const status=veto?t('暂停执行','Execution paused'):refusal?t('未予登记','Registration declined'):blocked?t('执行已拦截','Execution blocked'):waitingForRegistration?t('等待事前登记','Awaiting registration'):
      cash?t('持有现金','Hold cash'):d?.selected?name(d.selected):why(proof.reason);
    const disposition=dispatch?.disposition;
    const dispatchText=blocked?t('执行已拦截','Execution blocked'):disposition==='hold_cash'?t('已登记维持现金','Cash hold recorded'):
      disposition==='admit_paper'?t('已登记模拟执行额度','Paper allocation recorded'):t('尚未下达执行指令','No dispatch recorded');
    const outcome=receipt?.document??receipt;
    const paperResult=outcome?.execution??outcome;
    const settled=Boolean(x?.receiptId && paperResult);
    const facts=rows=>'<dl class="bp-facts">'+rows.join('')+'</dl>';
    const allowed=disposition==='admit_paper'||disposition==='hold_cash';
    const execHeadline=veto?t('原模拟指令已撤销','Original paper dispatch revoked'):blocked?dispatchText:settled?why(paperResult.status):dispatchText;
    const tradeCandidates=candidates.filter(row=>row.id!=='cash');
    const noSignals=tradeCandidates.length>0 && tradeCandidates.every(row=>row.signal===false);
    const cutoff=ev?.asOf,ruleText=d?why(d.reason??(cash?'no_candidate_beats_cash':'highest_eligible_score')):'';
    const trigger={
      trend:t('收盘价 > 10 日均线 > 30 日均线','Close > 10-day MA > 30-day MA'),
      breakout:t('收盘价 > 前 10 日最高价 ','Close > previous 10-day high of ')+number(f?.priorHigh,6),
      pullback:t('收盘价低于回调线 ','Close below pullback threshold ')+number(f?.average10*(1-f?.atrPct/2),6)+
        t('，且高于前收盘 ',' and above prior close ')+number(d?.previousClose,6)

    };
    const labels={
      registration:t('登记完整性','Registration integrity'),source:t('行情来源','Market provenance'),cutoff:t('数据时序','Data chronology'),
      candidates:t('候选复算','Candidate recomputation'),risk:t('风控复算','Risk recomputation'),
      authority:t('执行授权','Execution authority'),receipt:t('回执核对','Receipt reconciliation')
    };
    const audit=checks.map(row=>`<li><div><b>${e(labels[row.id]??residual(row.id))}</b><span>${e(why(row.status))}</span></div>
        <small>${e(why(row.reason))}</small></li>`).join('');
    const alternatives=candidates.filter(row=>row.id!=='cash').map(row=>`<li><div><b>${e(name(row.id))}</b>
      <span>${e(row.id===d.selected?t('入选','Selected'):row.eligible?t('可选','Eligible'):t('未通过','Ineligible'))}</span></div>
      <small>${e(why(row.reason))}${row.signal && Number.isFinite(row.score)?' · '+t('得分 ','Score ')+e(number(row.score,4)):''}</small><small>${e(trigger[row.id]??'')}</small></li>`).join('');
    const detailIntro=noSignals?t(tradeCandidates.length+' 种交易策略均未触发，保留现金。',tradeCandidates.length+' trade signals checked. None fired.'):ruleText;
    const executionWitness=proof.assurance?.execution;
    const independent=blocked?null:executionWitness?.status==='verified'?t('数量、费用与权益已独立复算','Quantity, costs and equity reconciled'):
      executionWitness?.status==='waiting'?t('暂无可结算回执','No settled receipt yet'):
      executionWitness?.status==='blocked'?t('回执未通过核对','Receipt failed verification'):null;
    const paperState=veto?t('已暂停','Paused'):settled?why(paperResult.status):waitingForRegistration?t('尚无登记','Awaiting registration'):
      why(proof.reason);
    const empty=(message)=>`<p class="bp-current-note">${e(message)}</p>`;
    const percentFraction=value=>Number.isFinite(value)?percent(value*100):'—';
    const refusalStages=refusal?[
      stage('Brain Layer',t('未通过登记检查','Registration check failed'),facts([
        fact(t('原因','Reason'),why(refusal.reason.toLowerCase())),
        ...(refusal.asOf?[fact(t('行情截至','Market data through'),stamp(refusal.asOf))]:[]),
        fact(t('采集核对时间','Collector check'),stamp(refusal.observedAt)),
        fact(t('目标交易日','Target session'),refusal.targetDate+' UTC')
      ])),
      stage('Thinking Layer',t('未选定策略','No strategy selected'),empty(t('本交易日没有已登记的决策或风险额度。','No decision or risk budget was registered for this session.'))),
      stage('Execution Layer',t('未下达执行指令','No dispatch issued'),facts([
        fact(t('模拟回执','Paper receipt'),t('无','None')),
        fact(t('实盘下单权限','Live order authority'),t('未授权','Not authorized'))
      ]))
    ].join(''):'';
    currentResult.innerHTML=`<header class="bp-current-head"><div>
        <span class="bp-market-name">${e(marketName)} · ${e(response.targetDate)} UTC</span>
        <h3>${e(status)}</h3>${veto?`<p class="bp-market-name">${t('交易所复查发现行情冲突','Venue recheck found conflicting market data')}</p>`:''}</div><span class="bp-route">${t('模拟执行通道','Paper execution')}</span></header>
      <div class="bp-current-trace bp-trace">${refusal?refusalStages:`
        ${stage('Brain Layer',ev?t('冻结的行情','Frozen market data'):t('行情依据','Market evidence'),ev?facts([
          fact(t('交易场所','Venue'),ev.venue),fact(t('数据截至','Information cutoff'),stamp(cutoff)),
          fact(t('已收盘日线','Closed daily bars'),number(ev.barCount,0)),
          ...(f?[fact(t('最后收盘价','Last close'),amount(f.close,quote,8)),
          fact(t('前一日收盘','Previous close'),amount(d.previousClose,quote,8)),
          fact(t('10 日 / 30 日均价','10-day / 30-day MA'),number(f.average10,6)+' / '+number(f.average30,6)),
          fact(t('前 10 日最高价','Previous 10-day high'),amount(f.priorHigh,quote,8)),
          fact(t('ATR 占收盘价','ATR / close'),percentFraction(f.atrPct))]:[])
        ])+`<div class="bp-sources">${sourceLink(response.evidenceUrl,t('冻结输入','Frozen inputs'))} ${sourceLink(ev.sourceUrl,t('行情来源','Market source'))}</div>`:
          empty(blocked?t('本次行情依据未通过核对。','The market evidence did not clear verification.'):t('等待用于本次研判的冻结快照。','Waiting for the frozen market snapshot.')))}
        ${stage('Thinking Layer',d?name(d.selected):t('等待可核对的决策','Awaiting a decision'),d?
          empty(detailIntro)+facts([
            fact(veto?t('登记时风控','Registered risk policy'):t('风控决定','Risk decision'),(veto?[r?.mode]:[r?.mode,r?.action,r?.reason]).filter(Boolean).map(why).join(' · ')||'—'),
            fact(t('风险预算','Risk budget'),amount(r?.riskBudget,quote)),
            fact(t('冻结额度','Planned amount'),amount(r?.amount,quote)),
            fact(t('止损 / 跳空上限','Stop / opening gap limit'),percentFraction(r?.stopFraction)+' / '+percentFraction(r?.openGapLimit))
          ])+(alternatives?`<details open class="bp-alternatives"><summary>${t('比较的策略','Strategies compared')} · ${tradeCandidates.length}</summary><ul class="bp-candidates">${alternatives}</ul></details>`:'')+(!veto?policyDetail(proof.assurance?.strategy,quote):'')+
          (!blocked?`<details data-choice-sensitivity><summary>${t('选择对样本有多敏感','Sensitivity to the sample')}</summary><div role="status"></div></details>`:''):
          empty(blocked?t('策略与风控依据尚未通过核对。','The strategy and risk policy have not cleared verification.'):t('登记后可查看候选策略、弃选原因与风险额度。','The registered decision supplies the alternatives, reasons and risk limits.')))}
        ${stage('Execution Layer',execHeadline,facts([
          fact(t('目标开盘','Target open'),proof.targetOpenAt?stamp(proof.targetOpenAt):response.targetDate+' UTC'),
          ...(allowed?[fact(t('下达的额度上限','Dispatched limit'),amount(dispatch.maxNotional,dispatch.quote??quote)),
            fact(t('指令登记时间','Dispatch recorded at'),stamp(dispatch.issuedAt))]:[]),
          fact(t('模拟回执','Paper receipt'),paperState),
          ...(independent?[fact(t('独立核算','Independent reconciliation'),independent)]:[]),
          ...(settled && Number.isFinite(paperResult.netPnl)?[fact(t('模拟净损益','Paper net P&L'),amount(paperResult.netPnl,quote))]:[]),
          fact(t('实盘下单权限','Live order authority'),proof.liveAuthorized===false?t('未授权','Not authorized'):t('未核实','Unconfirmed'))
        ])+(!blocked && response.handoffUrl?sourceLink(response.handoffUrl,t('模拟执行指令','Paper dispatch')):'')+(!blocked?comparisonDetail(response.comparison,quote):''))}`}
      </div><footer class="bp-current-foot"><details class="bp-checks"><summary>${t('核验记录','Verification record')}</summary>
        ${venueDetail(response)}
        ${audit?`<ul class="bp-candidates">${audit}</ul>`:''}
        ${facts([fact(t('核验时间','Checked at'),stamp(response.checkedAt)),
            ...(response.refusal?.sha256 && refusal?[fact(t('拒绝记录指纹','Refusal fingerprint'),response.refusal.sha256)]:[]),
            ...(proof.recordedAt?[fact(t('事前登记','Registered at'),stamp(proof.recordedAt))]:[]),
            ...(proof.commitId?[fact(t('登记编号','Commit ID'),proof.commitId)]:[]),
            ...(x?.dispatchId?[fact(t('指令编号','Dispatch ID'),x.dispatchId)]:[]),
            ...(x?.receiptId?[fact(t('回执编号','Receipt ID'),x.receiptId)]:[])])}
        <div class="bp-sources">${sourceLink(response.recordUrl,t('事前登记原件','Original registration'))} ${sourceLink(response.reviewUrl,t('核验结果','Verification JSON'))} ${sourceLink(endpoint({brief:'1',asset:response.assetKey,date:response.targetDate}),t('AI 决策摘要','AI decision brief'))}</div>
      </details><div class="bp-review-actions">
        <label>${t('交易日 (UTC)','Session (UTC)')} <input type="date" data-session aria-label="${t('查看交易日的登记','Review registered session')}" value="${e(response.targetDate)}" max="${e(latestSession || response.targetDate)}"></label>
        ${reviewDate?`<button type="button" data-latest class="bp-refresh">${t('返回当前','Current session')}</button>`:''}
        <button type="button" class="bp-refresh" data-refresh>${t('重新核对','Check again')}</button></div></footer>`;
    currentState.hidden=true;currentResult.hidden=false;
    const sensitivity=q('[data-choice-sensitivity]');
    if(sensitivity){
      const output=sensitivity.querySelector('[role=status]'),signal=currentRequest.signal;
      const inspect=async()=>{
        if(!sensitivity.open)return;
        sensitivity.ontoggle=null;
        notice(output,t('正在逐日复算…','Rechecking each omission…'));
        try{
          const brief=await request({brief:1,asset:response.assetKey,date:response.targetDate},signal);
          if(signal.aborted || !output.isConnected)return;
          const check=brief.thinking?.sensitivity;
          if(brief.decisionId!==proof.decisionId || brief.status==='blocked' || !check)throw new Error('Decision changed');
          const days=number(check.omissions,0),same=number(check.retained,0);
          const lines=[t(`每次剔除一个校准日，${days} 次重算中有 ${same} 次仍选择${name(brief.thinking.selected)}。`,
            `Leaving out one calibration day at a time kept ${name(brief.thinking.selected)} in ${same} of ${days} rankings.`)];
          for(const change of check.switches)lines.push(t(`${change.count} 次改选${name(change.to)}，例如剔除 ${change.example.omittedDate}。`,
            `${change.count} switched to ${name(change.to)}, including when ${change.example.omittedDate} was omitted.`));
          output.textContent=lines.join(' ');
        }catch{
          if(!signal.aborted && output.isConnected)notice(output,t('暂时无法核对，请重新核对本次决策。','Recheck the decision to load its sensitivity.'));
        }
      };
      sensitivity.ontoggle=inspect;
    }
    q('[data-refresh]').onclick=event=>{event.currentTarget.disabled=true;loadCurrent();};
    q('[data-session]').onchange=event=>{
      const field=event.currentTarget;
      if(!field.value || !field.validity.valid)return;
      changeSession(field.value===latestSession?'':field.value);
    };
    if(reviewDate)q('[data-latest]').onclick=()=>changeSession('');
    if(pendingLayer){
      const key=pendingLayer;pendingLayer='';
      if(document.activeElement===q('[data-current]'))focusStage(key);
    }
  }
  function renderRecord(record,evidenceUrl){
    const {asset,brain}=run,quote=asset.quote,r=record.risk,x=record.execution;
    const filled=x.status==='filled';
    const facts=rows=>'<dl class="bp-facts">'+rows.join('')+'</dl>';
    const candidates=record.candidates.map(c=>`<li><div><b>${e(name(c.id))}</b><span>${e(c.id===record.selected?t('入选','Selected'):c.eligible?t('可选','Eligible'):t('未通过','Ineligible'))}</span></div>
      <small>${e(reason(c.reason))}${Number.isFinite(c.score)?' · '+t('得分 ','Score ')+e(number(c.score,4)):''}${Number.isFinite(c.sampleCount)?' · '+e(number(c.sampleCount,0))+' '+t('个样本','samples'):''}</small></li>`).join('');
    const source=`<div class="bp-sources">${sourceLink(evidenceUrl,t('冻结输入','Frozen inputs'))} ${sourceLink(record.sourceUrl??brain.sourceUrl,t('行情来源','Market source'))}</div>`;
    const identifiers=`<details class="bp-ids"><summary>${t('决策与回执编号','Decision and receipt IDs')}</summary><dl class="bp-facts">${[
      fact(t('回测','Replay'),run.runId),fact(t('证据归档','Evidence archive'),brain.evidenceId),
      fact(t('决策快照','Snapshot'),record.snapshotId),fact(t('决策','Decision'),record.id),fact(t('风控版本','Risk policy'),r.policyVersion),
      fact(t('模拟回执','Simulated receipt'),x.id)
    ].join('')}</dl>${sourceLink(endpoint({run:run.runId,decision:record.id}),t('原始决策记录','Decision JSON'))}</details>`;
    const step=(icon,layer,main,caption,body,tone='')=>`<details class="bp-step">
      <summary><span class="bp-step-icon">${uiGlyph(icon)}</span><span class="bp-step-layer">${layer}</span>${uiGlyph('chevron')}
        <strong class="${tone}">${e(main)}</strong><small>${e(caption)}</small></summary><div class="bp-step-body">${body}</div></details>`;
    q('[data-detail]').innerHTML=`<div class="bp-trace bp-replay-trace">
      ${step('layers','Brain Layer',number(record.barCount,0)+' '+t('根日线','daily bars'),t('收盘 ','Close ')+amount(record.features.close,quote),facts([
        fact(t('可用数据截至','Information cutoff'),stamp(record.asOf)),
        fact(t('研判时间','Decision time'),stamp(record.observedAt)),
        fact(t('交易市场','Instrument'),asset.venue+' · '+asset.market),
        fact(t('输入日线','Daily bars'),number(record.barCount,0)+' · '+date(record.evidenceStartAt)+' – '+date(record.asOf)),
        fact(t('最后收盘','Last known close'),amount(record.features.close,quote,8)),
        fact(t('波动幅度 (ATR)','ATR / close'),percent(record.features.atrPct*100))
      ])+source)}
      ${step('strategy','Thinking Layer',name(record.selected),reason(r.action),facts([
        fact(t('选用依据','Selection rule'),reason(record.reason)),
        fact(t('风控决策','Risk decision'),reason(r.mode)+' · '+reason(r.action)+' · '+reason(r.reason)),
        fact(t('风险预算','Risk budget'),amount(r.riskBudget,quote)),
        fact(t('冻结下单额度','Planned allocation'),amount(r.amount,quote)),
        fact(t('止损 / 开盘跳空上限','Stop / gap limit'),percent(r.stopFraction*100)+' / '+percent(r.openGapLimit*100))
      ])+`<details><summary>${t('候选策略','Candidates')} · ${record.candidates.length}</summary><ul class="bp-candidates">${candidates}</ul></details>`)}
      ${step('pulse','Execution Layer',filled?(x.netPnl>0?'+':'')+amount(x.netPnl,quote):reason(x.status),
        filled?t('扣费后','Net P&L')+' · '+reason(x.reason):reason(x.reason),facts([
        fact(t('目标开盘','Target open'),stamp(record.barOpenAt)),
        fact(t('开盘期初权益','Opening equity'),amount(x.equityBefore,quote)),
        fact(t('开盘复核','Risk check at open'),x.openRisk?reason(x.openRisk.action)+' · '+reason(x.openRisk.reason):'—'),
        fact(t('实际模拟下单额','Simulated notional'),amount(x.amount,quote)),
        fact(filled?t('退出原因','Exit rule'):t('未成交原因','Reason'),reason(x.reason)),
        ...(filled?[
          fact(t('开仓 / 平仓','Entry / exit'),number(x.entryPrice,8)+' / '+number(x.exitPrice,8)+' '+quote),
          fact(t('成交数量','Quantity'),amount(x.quantity,asset.symbol,8)),
          fact(t('手续费 / 滑点成本','Fees / slippage'),number(x.fees)+' / '+number(x.slippage)+' '+quote)
        ]:[]),
        fact(t('扣费后损益','Net P&L'),amount(x.netPnl,quote)),
        fact(t('期末权益','Closing equity'),amount(x.equityAfter,quote))
      ])+identifiers,filled?signClass(x.netPnl):'')}
    </div>`;
  }
  async function learnFromRecord(record,activeRun,signal){
    const receipt=record.execution,following=nextLearningSession(activeRun.decisions,record);
    learningPeriod.textContent=activeRun.asset.market+' · '+date(record.barOpenAt)+' UTC';
    const reviewUrl=decision=>endpoint({run:activeRun.runId,decision:decision.id});
    const inspectLabel=t('查看校准依据','Inspect calibration');
    const cell=(icon,label,main,detail,inspect=false)=>`<div class="bl-cell">${inspect
      ?`<button type="button" class="bl-node bl-inspect" aria-label="${inspectLabel}" title="${inspectLabel}" aria-controls="bl-calibration" aria-expanded="false">${icon}</button>`
      :`<div class="bl-node" aria-hidden="true">${icon}</div>`}
      <div class="bl-copy"><h3>${e(label)}</h3><strong>${main}</strong><p>${e(detail)}</p></div></div>`;
    const observed=cell(uiGlyph('file'),t('模拟执行结果','Paper outcome'),e(reason(receipt.reason)),
      name(record.selected)+' · '+t('净损益 ','Net P&L ')+amount(receipt.netPnl,activeRun.asset.quote));
    const origin=sourceLink(reviewUrl(record),t('原始决策与回执','Decision and receipt'));
    learningBody.innerHTML=`<div class="bl-grid">${observed}</div><div class="bl-feedback"></div>`;
    const feedback=learningBody.querySelector('.bl-feedback');
    if(!following){
      feedback.innerHTML=`<p>${e(t('此窗口尚无包含本场结果的后续决策。','This window ends before a later decision can use this outcome.'))}</p>${origin}`;
      return;
    }
    learningBody.setAttribute('aria-busy','true');
    try{
      const response=await request({run:activeRun.runId,decision:following.id},signal);
      if(signal.aborted || disposed || run!==activeRun)return;
      const after=response.decision;
      if(response.runId!==activeRun.runId || after?.id!==following.id || !linksLearningReceipt(record,after))throw Error('Unlinked learning record');
      const score=value=>(value>0?'+':'')+number(value,4);
      const focus=record.selected==='cash'?record.candidates.filter(c=>c.id!=='cash').sort((a,b)=>b.score-a.score)[0]:
        record.candidates.find(c=>c.id===record.selected);
      const update=after.candidates.find(c=>c.id===focus?.id);
      if(!update || !Number.isFinite(update.score) || !Number.isFinite(focus.score))throw Error('Missing calibration');
      // Zero is twelve o'clock. Both score markers share the candidates' symmetric scale.
      const range=Math.max(...[...record.candidates,...after.candidates].map(c=>c.score).filter(Number.isFinite).map(Math.abs),.000001);
      const rim=score=>{const angle=score/range*2.1;return [32+27*Math.sin(angle),32-27*Math.cos(angle)];};
      const [x1,y1]=rim(focus.score),[x2,y2]=rim(update.score);
      const arc=`M ${x1} ${y1} A 27 27 0 ${Math.abs(update.score-focus.score)/range*2.1>Math.PI?1:0} ${update.score>focus.score?1:0} ${x2} ${y2}`;
      const nucleus=`<svg class="bl-nucleus" viewBox="0 0 64 64" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="32" cy="32" r="27" stroke-dasharray=".8 3.25" opacity=".55"/><path d="M32 2v5" opacity=".8"/>
        <path class="bl-score-arc" d="${arc}" pathLength="1"/><circle cx="${x1}" cy="${y1}" r="1.8" fill="var(--b-panel)"/>
        <circle cx="${x2}" cy="${y2}" r="2.2" fill="currentColor"/>
        <g class="bl-orbits">${[0,60,120].map(angle=>`<ellipse cx="32" cy="32" rx="19" ry="7.5" transform="rotate(${angle} 32 32)"/>`).join('')}</g>
        <circle cx="32" cy="32" r="4" fill="currentColor"/></svg>`;
      const change=cell(nucleus,t('策略评分','Strategy score'),`<span class="bl-prior">${e(score(focus.score))}</span> <i>→</i> <span class="bl-updated">${e(score(update.score))}</span>`,
        name(focus.id)+' · '+t('有效样本 ','Qualifying samples ')+number(focus.sampleCount,0)+' → '+number(update.sampleCount,0),true);
      const choice=cell(uiGlyph(after.selected==='cash'?'pause':'strategy'),t('后续模拟决策','Subsequent decision'),e(name(after.selected)),date(after.barOpenAt)+' UTC · '+reason(after.reason));
      const calibration=number(activeRun.assumptions.calibrationBars,0);
      const link=`<g><path class="bl-fiber" data-bow="-1"/><path class="bl-fiber" data-bow="0"/><path class="bl-track" data-bow="1"/>
        <path class="bl-comet bl-halo" data-bow="1" pathLength="100"/><path class="bl-comet" data-bow="1" pathLength="100"/></g>`;
      learningBody.innerHTML=`<div class="bl-grid bl-flow"><svg class="bl-links" fill="none" aria-hidden="true">${link}${link}</svg>${observed}${change}${choice}</div>
        <details class="bl-comparison" id="bl-calibration"><summary>${inspectLabel}</summary>
        <p>${e(t('评分使用最近 '+calibration+' 场的扣费后表现，并计入下行风险。','Scores use the last '+calibration+' sessions of after-cost returns and account for downside risk.'))}</p>
        <table><thead><tr><th>${t('候选策略','Candidate')}</th><th>${date(record.asOf)}</th><th>${date(after.asOf)}</th></tr></thead><tbody>
        ${record.candidates.map(c=>{const revised=after.candidates.find(v=>v.id===c.id);return `<tr><th scope="row">${e(name(c.id))}</th><td>${e(score(c.score))}</td><td>${e(revised?score(revised.score):'—')}</td></tr>`;}).join('')}</tbody></table></details>
        <footer class="bl-footer"><div>${origin} ${sourceLink(reviewUrl(after),t('后续决策原件','Subsequent decision record'))}</div>
        <button type="button" class="bp-refresh" data-next-learning>${t('复盘这次决策','Review this decision')} →</button></footer>`;
      mountLearningBeam(learningBody.querySelector('.bl-flow'),learningHost.querySelector('.bl-replay'),signal);
      const dial=learningBody.querySelector('.bl-inspect'),comparison=learningBody.querySelector('.bl-comparison');
      dial.onclick=()=>{comparison.open=!comparison.open;};
      comparison.ontoggle=()=>dial.setAttribute('aria-expanded',String(comparison.open));
      learningBody.querySelector('[data-next-learning]').onclick=()=>{
        loadRecord(after.id);day.focus({preventScroll:true});day.scrollIntoView({block:'center',behavior:'instant'});
      };
    }catch{
      if(!signal.aborted && !disposed)notice(feedback,t('暂时无法核对后续决策与本场回执。','The subsequent decision could not be matched to this receipt.'),()=>loadRecord(record.id));
    }finally{
      if(!signal.aborted)learningBody.setAttribute('aria-busy','false');
    }
  }
  async function loadRecord(id){
    recordRequest?.abort();
    const controller=recordRequest=new AbortController();
    const activeRun=run;
    learningState(emptyLearning);
    const index=activeRun.decisions.findIndex(item=>item.id===id);
    if(index<0)return;
    day.disabled=false;day.value=id;previous.disabled=index===0;next.disabled=index===activeRun.decisions.length-1;
    markEquityDay?.(index);
    notice(q('[data-detail]'),t('正在核对决策记录…','Loading decision record…'));
    try{
      const response=await request({run:activeRun.runId,decision:id},controller.signal);
      if(controller.signal.aborted || disposed || run!==activeRun)return;
      if(response.runId!==run.runId || response.decision?.id!==id)throw new Error('Mismatched decision');
      renderRecord(response.decision,response.evidenceUrl);
      void learnFromRecord(response.decision,activeRun,controller.signal);
    }catch{
      if(!controller.signal.aborted && !disposed){
        const message=t('该条决策暂时无法读取。','This decision is temporarily unavailable.');
        notice(q('[data-detail]'),message,()=>loadRecord(id));learningState(message,()=>loadRecord(id));
      }
    }
  }
  async function loadCohort(){
    if(cohort.getAttribute('aria-expanded')!=='true' || cohortLoaded || cohortRequest)return;
    cohortRequest?.abort();
    const controller=cohortRequest=new AbortController(),el=q('[data-cohort-body]');
    notice(el,t('正在核对同期市场…','Loading market comparison…'));
    try{
      const data=await request({cohort:1,days},controller.signal);
      if(controller.signal.aborted || disposed)return;
      const rows=data.rows.filter(row=>row.eligible);
      el.innerHTML=`<dl class="bp-facts">${[
        fact(t('共同回测区间','Common window'),date(data.startAt)+' – '+date(data.endAt)+' UTC'),
        fact(t('有完整样本的市场','Markets covered'),number(data.coveredAssets,0)+' / '+number(data.totalAssets,0)),
        fact(t('盈利市场','Profitable markets'),number(data.positiveAssets,0)+' / '+number(data.coveredAssets,0)),
        fact(t('跑赢持有','Beat buy & hold'),number(data.beatHoldAssets,0)+' / '+number(data.coveredAssets,0)),
        fact(t('净收益率中位数','Median net return'),percent(data.medianNetReturnPct,true)),
        fact(t('超额收益中位数','Median excess return'),Number.isFinite(data.medianExcessPct)?number(data.medianExcessPct)+' '+t('个百分点','pp'):'—')
      ].join('')}</dl>${rows.length?`<table><thead><tr><th>${t('资产','Asset')}</th><th>${t('策略','Strategy')}</th><th>${t('持有','Hold')}</th><th>${t('回撤','Drawdown')}</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${e(row.symbol)}</th><td>${e(percent(row.netReturnPct,true))}</td><td>${e(percent(row.buyHoldReturnPct,true))}</td><td>${e(percent(row.maxDrawdownPct))}</td></tr>`).join('')}</tbody></table>`:''}`;
      if(data.reportUrl)el.insertAdjacentHTML('beforeend',`<div class="bp-sources">${sourceLink(data.reportUrl,t('固定版本','Archived comparison'))}</div>`);
      cohortLoaded=true;
    }catch{
      if(!controller.signal.aborted && !disposed)notice(el,t('同期市场对照暂时无法读取。','Market comparison is temporarily unavailable.'),loadCohort);
    }finally{if(cohortRequest===controller)cohortRequest=null;}
  }
  function changeSession(value){
    reviewDate=value;
    currentResult.hidden=true;currentResult.replaceChildren();
    notice(currentState,t('正在核对事前记录…','Checking the registered decision…'));
    loadCurrent();
  }
  function focusStage(key){
    if(reviewDate)changeSession('');
    const target=currentResult.querySelector(`[data-proof-layer="${key}"]`)??q('[data-current]');
    pendingLayer=currentResult.hidden?key:'';
    if(!target.hasAttribute('tabindex'))target.tabIndex=-1;
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }
  const paperExample=q('[data-paper-example]');
  const exampleBody=q('[data-paper-example-body]');
  let exampleRequest,exampleLoaded=false;
  async function loadExample(){
    if(disposed || exampleLoaded || exampleRequest || !paperExample.open)return;
    exampleRequest=new AbortController();
    notice(exampleBody,t('正在读取成交凭证…','Loading the execution receipt…'));
    try{
      const record=await request({example:'btc-pullback'},exampleRequest.signal);
      if(disposed)return;
      exampleBody.innerHTML=renderPaperCase(record,en);
      exampleLoaded=true;
    }catch{
      if(!disposed)notice(exampleBody,t('成交凭证暂时无法读取。','The receipt is temporarily unavailable.'),loadExample);
    }finally{exampleRequest=null;}
  }
  paperExample.ontoggle=loadExample;
  for(const control of [market,q('[data-replay-market]')]){
    control.onchange=()=>{selectedMarket=control.value;load();};
  }
  period.onchange=()=>{days=period.value;loadHistory();};
  const observer=new IntersectionObserver(entries=>{
    if(!entries.some(entry=>entry.isIntersecting))return;
    replayVisible=true;observer.disconnect();loadHistory();
  },{root:host.closest('#product-page'),rootMargin:'300px 0px'});
  observer.observe(replayHost);observer.observe(learningHost);
  day.onchange=()=>loadRecord(day.value);
  const step=offset=>{
    const index=run?.decisions.findIndex(item=>item.id===day.value)??-1;
    if(index>=0 && run.decisions[index+offset])loadRecord(run.decisions[index+offset].id);
  };
  previous.onclick=()=>step(-1);next.onclick=()=>step(1);
  return {
    focusStage,
    setScope(key,label){
      if(key===scope)return;
      scope=key;scopeLabel=label||key;
      load();
    },
    dispose(){
      disposed=true;exampleRequest?.abort();observer.disconnect();mainRequest?.abort();currentRequest?.abort();replayRequest?.abort();recordRequest?.abort();cohortRequest?.abort();
    }
  };
}
