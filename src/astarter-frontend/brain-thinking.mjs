import replay from './brain-merge-case.json' with {type:'json'};
import block from './brain-evidence/BLOCK-15537394@1.json' with {type:'json'};
import before from './brain-evidence/COINBASE-ETH-USD-0644@1.json' with {type:'json'};
import after from './brain-evidence/COINBASE-ETH-USD-0649@1.json' with {type:'json'};

const pair = (zh, en) => [zh, en];
const utc = iso => iso.slice(11, 16);
const usd = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'});
const atMinute = time => new Date(time * 1000).toISOString().slice(11, 16);
const snapshotTime = utc(replay.decisionCutoff);
const expiry = utc(replay.reviewAsOf);
const market = replay.outcome.marketObservation;
const candles = [...before].sort((a, b) => a[0] - b[0]);
const later = [...after].sort((a, b) => a[0] - b[0]);
const current = candles.at(-1);
const replayPhases = [
  {title:pair('锁定市场快照', 'Lock market snapshot'), source:'ETH / USD',
    rows:[
      ['识别事件', 'Identify event', pair('以太坊合并', 'Ethereum Merge')],
      ['匹配交易对', 'Match instrument', market.instrument],
      ['载入行情源', 'Read venue', market.venue],
      ['关联链上源', 'Load chain', 'Ethereum'],
      ['设定时间窗', 'Set cutoff', `${snapshotTime} UTC`],
      ['提取分钟线', 'Read candles', pair(`${candles.length} 根分钟线`, `${candles.length} candles`)],
      ['锁定证据', 'Pin sources', pair('区块 + 行情', 'Block + candles')],
      ['派发快照', 'Dispatch snapshot', pair('同一版本 v1', 'Revision v1')]
    ]},
  {title:pair('核对链上区块', 'Verify chain data'), source:'Ethereum',
    rows:[
      ['定位区块', 'Locate block', `#${block.height.toLocaleString('en-US')}`],
      ['读取时间戳', 'Read timestamp', `${block.timestamp.slice(11, 19)} UTC`],
      ['核对区块哈希', 'Match block hash', `${block.hash.slice(0, 8)}…${block.hash.slice(-4)}`],
      ['统计交易', 'Count transactions', pair(`${block.transactions_count} 笔`, `${block.transactions_count} tx`)],
      ['核对难度', 'Read difficulty', block.difficulty],
      ['验证共识', 'Verify consensus', pair('首个 PoS 区块', 'First PoS block')],
      ['检查资金流向', 'Check flow direction', pair('待核实', 'Unverified')]
    ]},
  {title:pair('核查市场反应', 'Cross-check market'), source:market.venue,
    rows:[
      [`${atMinute(candles[0][0])} 收盘`, `${atMinute(candles[0][0])} close`, usd.format(candles[0][4])],
      [`${atMinute(current[0])} 开盘`, `${atMinute(current[0])} open`, usd.format(current[3])],
      ['提取最低价', 'Read minute low', usd.format(current[1])],
      ['提取最高价', 'Read minute high', usd.format(current[2])],
      [`${atMinute(current[0])} 收盘`, `${atMinute(current[0])} close`, usd.format(current[4])],
      ['核对场所覆盖', 'Check venue coverage', pair('单一场所', 'One venue')],
      ['检查盘口深度', 'Check market depth', pair('缺少证据', 'Unavailable')]
    ]},
  {title:pair('发布观察策略', 'Publish watch signal'), source:pair('智选信号', 'Signals'),
    rows:[
      ['绑定策略', 'Link strategy', pair('观察策略 v1', 'Watch v1')],
      ['核对价格基准', 'Pin reference price', usd.format(market.startClose)],
      ['检查升级条件', 'Check conditions', pair('待跨场所佐证', 'Await 2nd venue')],
      ['检查可成交深度', 'Check trade depth', pair('待验证', 'Unverified')],
      ['显示信号', 'Show signal', pair('继续观察', 'Observe')],
      ['设定到期时间', 'Set expiry', `${expiry} UTC`]
    ]},
  {title:pair('复盘写回记忆', 'Return case memory'), source:pair('Astarter 研究库', 'Astarter Research'),
    rows:[
      ...later.map(candle => [`${atMinute(candle[0])} 收盘`, `${atMinute(candle[0])} close`, usd.format(candle[4])]),
      ['计算窗口涨幅', 'Measure market move', `+${market.changePct}%`],
      ['核对自主成交', 'Check user receipt', pair('成交未知', 'Unknown')],
      ['核对 AI 交易回执', 'LensWave orders', pair('未授权 · 0 单', '0 · No mandate')],
      ['归档复盘', 'Index review', pair('关联策略 v1', 'Linked to v1')]
    ]}
];
const cadence = [305, 350, 285, 375, 320];
const localText = (value, en) => Array.isArray(value) ? value[en ? 1 : 0] : value;

const phaseCaptions = new Map([
  ['确定研究范围', pair('范围','Scope')], ['读取公开行情', pair('行情','Quotes')],
  ['核对流动性', pair('流动性','Liquidity')], ['检查执行依据', pair('执行','Trade')],
  ['索引证据', pair('索引','Index')], ['锁定市场快照', pair('快照','Snapshot')],
  ['核对链上区块', pair('区块','Block')], ['核查市场反应', pair('市场','Market')],
  ['发布观察策略', pair('策略','Strategy')], ['复盘写回记忆', pair('复盘','Review')]
]);

// Port of the moving active segment in ShadcnSpace's 21st.dev stepper-04.
// Each segment here contains the individual checks recorded in that phase.
function phaseSegment(phase, index) {
  const rows = phase.rows ?? [];
  return `<button class="ast-thinking__stop" type="button" data-phase-index="${index}" ${rows.length?'':'disabled'}>
    <span class="ast-thinking__caption"></span>
    <span class="ast-thinking__checks" aria-hidden="true">${rows.map(() => '<i></i>').join('')}</span>
  </button>`;
}

function mountThinking(host, {en = false, reduced = false, onPhaseChange, tape, playback} = {}) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const t = (zh, english) => en ? english : zh;
  const phases = tape ? (tape.phases ?? []) : replayPhases;
  const events = phases.flatMap((phase,id) => (phase.rows ?? []).map((row,step) => ({phase:id,step,row})));
  const windowSize = 7;
  const suppliedTime = tape ? (tape.asOf ? Date.parse(tape.asOf) : NaN) : Date.parse(replay.decisionCutoff);
  const asOf = Number.isFinite(suppliedTime) ? new Date(suppliedTime).toISOString() : null;
  const media = win.matchMedia('(prefers-reduced-motion: reduce)');
  const forceReduced=reduced && !media.matches && doc.documentElement.dataset.reducedMotion!=='true';
  const prefersLess=()=>Boolean(forceReduced || media.matches || doc.documentElement.dataset.reducedMotion==='true');
  reduced=prefersLess();
  let requested = !reduced && playback?.requested!==false;
  let round = Number.isSafeInteger(playback?.round) && playback.round>0 ? playback.round : 1;
  const root = doc.createElement('div');
  root.className = 'ast-thinking';
  root.lang = en ? 'en' : 'zh-CN';
  root.style.setProperty('--ast-visible-rows', Math.min(windowSize, events.length));
  const style = doc.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('./brain-thinking.css', import.meta.url).href;
  root.innerHTML = `<div class="ast-thinking__toolbar">
      <div class="ast-thinking__stage"><strong></strong></div>
      <span class="ast-thinking__count"><span>${t('已处理', 'Processed')}</span> <b></b> / ${events.length}</span>
      <button class="ast-thinking__toggle" type="button"><svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path></path></svg></button>
    </div>
    <div class="ast-thinking__activity">
      <div class="ast-thinking__phases" role="group" aria-label="${t('研判阶段','Research stages')}" style="--phase-count:${Math.max(1,phases.length)}">
        <i class="ast-thinking__cursor" aria-hidden="true"></i>${phases.map(phaseSegment).join('')}
      </div>
    </div>
    <div class="ast-thinking__columns"><span>${t('核验记录','Evidence checks')}</span><span>${t('结果','Result')}</span></div>
    <div class="ast-thinking__window"><ol class="ast-thinking__list" aria-live="off"></ol></div>
    <div class="ast-thinking__date"><small>${t('快照时间','Snapshot time')}</small><time></time><span></span></div>`;
  root.prepend(style);
  host.replaceChildren(root);
  const toggle = root.querySelector('.ast-thinking__toggle');
  const icon = toggle.querySelector('path');
  const stage = root.querySelector('strong');
  const list = root.querySelector('ol');
  const date = root.querySelector('time');
  const time = root.querySelector('.ast-thinking__date span');
  const count = root.querySelector('.ast-thinking__count b');
  const meter = root.querySelector('.ast-thinking__phases');
  const stops = Array.from(meter.querySelectorAll('[data-phase-index]'));
  stops.forEach((button,index)=>{
    const title=phases[index].title;
    const label=localText(title,en);
    button.querySelector('.ast-thinking__caption').textContent=localText(phaseCaptions.get(localText(title,false))??title,en);
    const replayLabel=t('回放至'+label, 'Replay to '+label);
    button.setAttribute('aria-label',replayLabel);
    button.title=[replayLabel, localText(phases[index].source,en)].filter(Boolean).join(' · ');
  });
  const marks = Array.from(meter.querySelectorAll('.ast-thinking__checks i'));
  list.setAttribute('aria-label', tape ? t('快照研判，最新在前','Snapshot research, newest first') : t('历史研判事件，最新在前', 'Historical research events, newest first'));
  if(asOf){
    date.dateTime = tape ? asOf : asOf.slice(0,10);
    date.textContent = asOf.slice(0,10);
    time.textContent = `${asOf.slice(11,19)} UTC`;
  } else {
    date.textContent = t('快照时间待确认','Snapshot time unavailable');
  }
  if(!events.length){
    stage.textContent = t('暂无快照记录','No snapshot records');
    root.querySelector('.ast-thinking__count').remove();
    root.querySelector('.ast-thinking__window').remove();
    root.querySelector('.ast-thinking__columns')?.remove();
    toggle.remove();meter.remove();
    return {seek(){},getPlaybackState(){return {requested,phase:null,step:null,round};},dispose(){root.remove();}};
  }

  // Open on the snapshot already in progress so the feed has context at first paint.
  let cursor = events.findLastIndex(event => event.phase === events[0].phase);
  if(Number.isInteger(playback?.phase) && playback.phase>=0 && Number.isInteger(playback.step) && playback.step>=0) {
    // A newer snapshot can omit a row or a whole phase. Keep the last
    // available step at or before the reader's saved position.
    cursor = Math.max(0,events.findLastIndex(event =>
      event.phase<playback.phase || (event.phase===playback.phase && event.step<=playback.step)));
  }
  let visible = true, disposed = false;
  let running = false, lastCursor = -1, lastPlaying;
  let timer, shift, meterPhase = -1;
  function paintMeter() {
    const phase = events[cursor].phase;
    count.textContent = String(cursor + 1).padStart(2, '0');
    marks.forEach((mark,index) => {
      const state = index < cursor ? 'done' : index === cursor ? 'current' : 'pending';
      if (mark.dataset.state !== state) mark.dataset.state = state;
    });
    if (phase === meterPhase) return;
    meterPhase = phase;
    meter.style.setProperty('--phase-index', phase);
    stops.forEach((button,index) => {
      button.dataset.state = index<phase ? 'complete' : index===phase ? 'current' : 'pending';
      if (index===phase) button.setAttribute('aria-current','step');
      else button.removeAttribute('aria-current');
    });
  }
  function makeRow(event, index, pending = false) {
    const [zh, english, result] = event.row;
    const item = doc.createElement('li');
    const label = doc.createElement('span');
    const value = doc.createElement('b');
    label.textContent = t(zh, english);
    value.textContent = pending ? t('待处理', 'Pending') : localText(result, en);
    if (pending) item.dataset.pending = '';
    item.dataset.group = event.phase;
    const ordinal = doc.createElement('small');
    ordinal.className = 'ast-thinking__ordinal';
    ordinal.setAttribute('aria-hidden','true');
    ordinal.textContent = String(index + 1).padStart(2, '0');
    item.append(ordinal);
    value.title = value.textContent;
    item.append(label, value);
    return item;
  }
  function paintHeader() {
    const phase = events[cursor].phase;
    root.dataset.phase = phase;
    root.dataset.round = round;
    stage.textContent = localText(phases[phase].title, en);
    if(!tape) time.textContent = `${phase === 4 ? expiry : snapshotTime} UTC`;
  }
  function refill() {
    const start = Math.max(0, cursor - windowSize + 1);
    const recorded = events.slice(start, cursor + 1).reverse().map((event, offset) => makeRow(event, cursor - offset));
    const upcoming = events.slice(cursor + 1, start + windowSize).map((event, offset) => makeRow(event, cursor + 1 + offset, true));
    list.replaceChildren(...recorded, ...upcoming);
    paintHeader();
    paintMeter();
  }
  function emit() {
    if (cursor === lastCursor && running === lastPlaying) return;
    lastCursor = cursor;
    lastPlaying = running;
    const {phase, step} = events[cursor];
    onPhaseChange?.(phase, running, step);
  }
  function next() {
    if (!running || disposed) return;
    const wrapped = cursor === events.length - 1;
    cursor = (cursor + 1) % events.length;
    shift?.cancel();
    if (wrapped) {
      round += 1;
      refill();
    } else {
      list.prepend(makeRow(events[cursor], cursor));
      (list.querySelector('[data-pending]') || list.lastElementChild).remove();
      if (!reduced && list.animate) {
        shift = list.animate([{transform:'translateY(calc(-1 * var(--ast-thinking-row)))'}, {transform:'translateY(0)'}],
          {duration:150, easing:'cubic-bezier(.22,.8,.3,1)'});
      }
      if (events[cursor - 1].phase !== events[cursor].phase) paintHeader();
      paintMeter();
    }
    emit();
    schedule();
  }
  function schedule() {
    win.clearTimeout(timer);
    if (running && !disposed) timer = win.setTimeout(next, reduced ? 1250 : cadence[cursor % cadence.length]);
  }
  function sync() {
    running = requested && visible && !doc.hidden;
    root.dataset.playing = String(running);
    root.dataset.motion = String(!reduced);
    const action = tape ? (requested ? t('暂停思维流','Pause research flow') : t('继续思维流','Resume research flow'))
      : (requested ? t('暂停回放', 'Pause replay') : t('继续回放', 'Resume replay'));
    toggle.setAttribute('aria-label', action);
    toggle.title = action;
    icon.setAttribute('d', requested ? 'M4 3h4.5v14H4zm7.5 0H16v14h-4.5z' : 'M5 3.5v13l11-6.5z');
    if (!running) {
      shift?.cancel();
    }
    schedule();
    emit();
  }
  function seek(index) {
    if (!Number.isInteger(index) || index < 0 || index >= phases.length || disposed) return;
    const last=events.findLastIndex(event => event.phase === index);
    if(last<0)return;
    requested = false;
    shift?.cancel();
    cursor = last;
    refill();
    sync();
  }
  function togglePlayback() { requested = !requested; sync(); }
  function motionChange() {
    const next=prefersLess();
    if(next===reduced)return;
    reduced=next;
    if (reduced) requested = false;
    sync();
  }
  toggle.addEventListener('click', togglePlayback);
  meter.onclick=event=>{
    const button=event.target.closest('[data-phase-index]');
    if(button)seek(Number(button.dataset.phaseIndex));
  };
  meter.onkeydown=event=>{
    const target=event.target.closest('[data-phase-index]');
    if(!target)return;
    const enabled=stops.filter(button=>!button.disabled);
    const index=enabled.indexOf(target);
    const destinations={ArrowLeft:Math.max(0,index-1),ArrowRight:Math.min(enabled.length-1,index+1),Home:0,End:enabled.length-1};
    if(!Object.hasOwn(destinations,event.key))return;
    event.preventDefault();
    const button=enabled[destinations[event.key]];
    button.focus({preventScroll:true});
    seek(Number(button.dataset.phaseIndex));
  };
  doc.addEventListener('visibilitychange', sync);
  media.addEventListener('change', motionChange);
  const motionSettings=new MutationObserver(motionChange);
  motionSettings.observe(doc.documentElement,{attributes:true,attributeFilter:['data-reduced-motion']});
  const observer = 'IntersectionObserver' in win ? new win.IntersectionObserver(entries => {
    if (disposed) return;
    const onScreen = entries.at(-1).isIntersecting;
    if (visible !== onScreen) { visible = onScreen; sync(); }
  }) : null;
  // The same replay clock also drives the brain and execution panels on small screens.
  observer?.observe(root.closest('.br-workspace') || root);
  refill();
  sync();
  function dispose() {
    disposed = true;
    running = false;
    win.clearTimeout(timer);
    shift?.cancel();
    observer?.disconnect();
    motionSettings.disconnect();
    media.removeEventListener('change', motionChange);
    doc.removeEventListener('visibilitychange', sync);
    toggle.removeEventListener('click', togglePlayback);
    root.remove();
  }
  function getPlaybackState() {
    const {phase, step}=events[cursor];
    return {requested,phase,step,round};
  }
  return {seek, dispose, getPlaybackState};
}

export {mountThinking};
