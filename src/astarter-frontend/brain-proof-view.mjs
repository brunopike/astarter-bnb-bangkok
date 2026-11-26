import {renderPaperCase} from './paper-replay/view.mjs';
// Present the registered decision first. Historical simulation is loaded on demand.
import {escapeUI as e} from './product-experience.mjs';
import {sparkline} from './product-charts.mjs';

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

export function mountProofView(host,replayHost,en){
  // In these two locales the financial terms here are already rendered explicitly.
  if(/^(en|zh)(-|$)/.test(host.closest('astarter-brain')?.dataset.locale??'en')){
    host.dataset.noTranslate='';replayHost.dataset.noTranslate='';
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
      <div class="bp-controls"><label>${t('市场','Market')}<select data-replay-market data-native-select></select></label>
        <label>${t('回测窗口','Window')}<select data-window data-native-select></select></label></div>
    </header>
    <div class="bp-replay">
      <div class="bp-state" data-state role="status"></div>
      <div data-result hidden>
        <header class="bp-run"><div><strong data-instrument></strong><span data-venue></span></div><span data-period></span></header>
        <div class="bp-overview"><figure class="bp-equity" hidden><figcaption>${t('模拟账户权益','Simulated equity')}<strong data-equity-value></strong></figcaption><div data-equity-chart aria-hidden="true"></div></figure>
        <dl class="bp-metrics" data-metrics></dl></div>
        <details class="bp-method"><summary>${t('成本与计算口径','Costs & methodology')}</summary><div data-method></div></details>
        <details class="bp-cohort" data-cohort hidden><summary>${t('同期市场对照','Cross-market comparison')}</summary><div data-cohort-body></div></details>
        <div class="bp-ledger">
          <header class="bp-ledger-head"><h3>${t('决策记录','Decision ledger')}</h3><div>
            <label class="bp-day"><span class="bp-sr">${t('选择执行日 (UTC)','Select execution day (UTC)')}</span><select data-day data-native-select></select></label>
            <button type="button" data-prev aria-label="${t('前一条决策','Previous decision')}" title="${t('前一条决策','Previous decision')}">‹</button>
            <button type="button" data-next-day aria-label="${t('后一条决策','Next decision')}" title="${t('后一条决策','Next decision')}">›</button>
          </div></header>
          <div data-detail></div>
        </div>
        <div data-forward></div>
      </div>
    </div>`;
  const market=q('[data-market]'),period=q('[data-window]'),day=q('[data-day]');
  const previous=q('[data-prev]'),next=q('[data-next-day]'),cohort=q('[data-cohort]');
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
    recordRequest?.abort();recordRequest=null;
    run=null;cohortRequest?.abort();cohortRequest=null;cohortLoaded=false;
    cohort.open=false;cohort.hidden=true;q('[data-forward]').replaceChildren();
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
  function headline(label,value,tone=''){
    return `<div><dt>${e(label)}</dt><dd class="${tone}">${e(value)}</dd></div>`;
  }
  function renderSummary(){
    const {asset,brain,summary:s,assumptions:a}=run,quote=asset.quote;
    q('[data-instrument]').textContent=asset.market;
    q('[data-venue]').textContent=asset.venue+' · '+t('历史模拟','Historical simulation');
    q('[data-period]').textContent=date(s.startAt)+' – '+date(s.endAt)+' UTC';
    q('[data-metrics]').innerHTML=[
      headline(t('策略净收益率','Strategy net return'),percent(s.netReturnPct,true),signClass(s.netReturnPct)),
      headline(t('买入持有','Buy & hold'),percent(s.buyHoldReturnPct,true)),
      headline(t('最大回撤','Max drawdown'),percent(s.maxDrawdownPct)),
      headline(t('成交 / 决策','Trades / decisions'),number(s.trades,0)+' / '+number(s.observations,0))
    ].join('');
    const equity=[a.initialCapital];
    for(const session of run.decisions){
      if(!Number.isFinite(session.netPnl))break;
      equity.push(equity.at(-1)+session.netPnl);
    }
    const figure=q('.bp-equity');
    figure.hidden=!Number.isFinite(a.initialCapital) || !run.decisions.length || equity.length!==run.decisions.length+1;
    if(!figure.hidden){
      q('[data-equity-value]').textContent=amount(equity.at(-1),quote);
      q('[data-equity-chart]').innerHTML=sparkline(equity,{width:420,height:76,color:'#91cfe3'});
    }
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
    setOptions(day,[...list].reverse().map(item=>[item.id,date(item.barOpenAt)+' UTC · '+name(item.selected)+' · '+reason(item.status)]),latestFill?.id??'');
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
      if(error.code==='INSUFFICIENT_EVIDENCE')notice(q('[data-state]'),t('历史样本不足，无法核对这个窗口。','There is insufficient history for this window.'));
      else if(error.code==='INVALID_EVIDENCE')notice(q('[data-state]'),t('归档行情未通过完整性检查。','The market archive failed its integrity checks.'));
      else if(error.code==='UNSUPPORTED_ASSET')notice(q('[data-state]'),t('该市场暂无历史回测。','No historical replay for this market.'));
      else notice(q('[data-state]'),t('回测记录暂时无法读取。','Replay data is temporarily unavailable.'),loadHistory);
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
        clearRecord();notice(currentState,empty);notice(q('[data-state]'),empty);
        return;
      }
      await loadCurrent();
    }catch{
      if(!disposed && !controller.signal.aborted){
        const message=t('市场列表暂时无法读取。','The market list is temporarily unavailable.');
        notice(currentState,message,load);notice(q('[data-state]'),message,load);
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
        <button type="button" class="bp-refresh" data-refresh>${t('重新核对','Check again')}</button>
        </div></footer>`;
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
    q('[data-detail]').innerHTML=`<div class="bp-trace">
      ${stage('Brain Layer',t('锁定行情快照','Market snapshot'),facts([
        fact(t('可用数据截至','Information cutoff'),stamp(record.asOf)),
        fact(t('研判时间','Decision time'),stamp(record.observedAt)),
        fact(t('交易市场','Instrument'),asset.venue+' · '+asset.market),
        fact(t('输入日线','Daily bars'),number(record.barCount,0)+' · '+date(record.evidenceStartAt)+' – '+date(record.asOf)),
        fact(t('最后收盘','Last known close'),amount(record.features.close,quote,8)),
        fact(t('波动幅度 (ATR)','ATR / close'),percent(record.features.atrPct*100))
      ])+source)}
      ${stage('Thinking Layer',name(record.selected),facts([
        fact(t('选用依据','Selection rule'),reason(record.reason)),
        fact(t('风控决策','Risk decision'),reason(r.mode)+' · '+reason(r.action)+' · '+reason(r.reason)),
        fact(t('风险预算','Risk budget'),amount(r.riskBudget,quote)),
        fact(t('冻结下单额度','Planned allocation'),amount(r.amount,quote)),
        fact(t('止损 / 开盘跳空上限','Stop / gap limit'),percent(r.stopFraction*100)+' / '+percent(r.openGapLimit*100))
      ])+`<details><summary>${t('候选策略','Candidates')} · ${record.candidates.length}</summary><ul class="bp-candidates">${candidates}</ul></details>`)}
      ${stage('Execution Layer',reason(x.status),facts([
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
      ]))}
    </div><details class="bp-ids"><summary>${t('决策与回执编号','Decision and receipt IDs')}</summary><dl class="bp-facts">${[
      fact(t('回测','Replay'),run.runId),fact(t('证据归档','Evidence archive'),brain.evidenceId),
      fact(t('决策快照','Snapshot'),record.snapshotId),fact(t('决策','Decision'),record.id),fact(t('风控版本','Risk policy'),r.policyVersion),
      fact(t('模拟回执','Simulated receipt'),x.id)
    ].join('')}</dl>${sourceLink(endpoint({run:run.runId,decision:record.id}),t('原始决策记录','Decision JSON'))}</details>`;
  }
  async function loadRecord(id){
    recordRequest?.abort();
    const controller=recordRequest=new AbortController();
    const activeRun=run;
    const index=activeRun.decisions.findIndex(item=>item.id===id);
    if(index<0)return;
    day.disabled=false;day.value=id;previous.disabled=index===0;next.disabled=index===activeRun.decisions.length-1;
    notice(q('[data-detail]'),t('正在核对决策记录…','Loading decision record…'));
    try{
      const response=await request({run:activeRun.runId,decision:id},controller.signal);
      if(controller.signal.aborted || disposed || run!==activeRun)return;
      if(response.runId!==run.runId || response.decision?.id!==id)throw new Error('Mismatched decision');
      renderRecord(response.decision,response.evidenceUrl);
    }catch{
      if(!controller.signal.aborted && !disposed)notice(q('[data-detail]'),t('该条决策暂时无法读取。','This decision is temporarily unavailable.'),()=>loadRecord(id));
    }
  }
  async function loadCohort(){
    if(!cohort.open || cohortLoaded)return;
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
    }
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
  observer.observe(replayHost);
  day.onchange=()=>loadRecord(day.value);
  const step=offset=>{
    const index=run?.decisions.findIndex(item=>item.id===day.value)??-1;
    if(index>=0 && run.decisions[index+offset])loadRecord(run.decisions[index+offset].id);
  };
  previous.onclick=()=>step(-1);next.onclick=()=>step(1);
  cohort.ontoggle=loadCohort;
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
