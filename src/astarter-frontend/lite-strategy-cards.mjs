import { tokenIcon } from './brand-icons.mjs';
import { liveSignalRow, signalClosePrice } from './live-signal-view.mjs';
import { sparkline, sparklinePoints } from './product-charts.mjs';
import { escapeUI as esc } from './product-experience.mjs';

const markets = new Set(['BTC', 'ETH', 'SOL']);
const readingFormats = {
  zh: new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }),
  en: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
};
const plans = {
  buy: { id: 'signals-spot-momentum-entry', label: ['现货动量跟随', 'Spot momentum entry'] },
  sell: { id: 'signals-spot-momentum-exit', label: ['现货持仓退出', 'Spot position exit'] },
  watch: { id: 'signals-watch', label: ['等待入场信号', 'Wait for an entry'] }
};

export function strategyLabelForId(id, lang = 'zh') {
  const plan = Object.values(plans).find((item) => item.id === id);
  return plan?.label[lang === 'en' ? 1 : 0] || '';
}

export function cardDisplayUntil(row) {
  return row.validUntil + (row.mode === 'live' ? 15_000 : 0);
}

function quantityFor(holding, symbol) {
  const value = typeof holding === 'number' ? holding : holding?.symbol === symbol ? holding.quantity : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Use the market observation's own identity. Catalog bots have separate trigger and order contracts.
export function strategyForSignal(row, holding, lang = 'zh', now = Date.now()) {
  if (
    !row ||
    !markets.has(row.symbol) ||
    row.market !== row.symbol + '/USDT' ||
    row.period !== '1m' ||
    !['live', 'practice'].includes(row.mode) ||
    typeof row.id !== 'string' ||
    !row.id ||
    !Number.isFinite(row.closedAt) ||
    row.closedAt > now ||
    !Number.isFinite(row.validUntil) ||
    row.validUntil <= now ||
    !(row.price > 0) ||
    ![row.price, row.momentumPct, row.rsi14, row.ema20].every(Number.isFinite)
  )
    return null;
  let side = 'watch';
  if (row.direction === 'up') side = 'buy';
  else if (row.direction === 'down' && quantityFor(holding, row.symbol) > 0) side = 'sell';
  if (!['up', 'down', 'neutral'].includes(row.direction)) return null;
  const definition = plans[side];
  return {
    id: definition.id,
    label: definition.label[lang === 'en' ? 1 : 0],
    side,
    actionable: side !== 'watch',
    rule: 'EMA20 / RSI14 / 5-bar momentum',
    signalId: row.id,
    sourceSignalId: row.id,
    symbol: row.symbol
  };
}

export function canSubmitLiteOrder(row, plan, balance, amount, blockedId, now = Date.now()) {
  if (!row || !plan?.actionable || row.id !== plan.signalId || row.id === blockedId ||
      row.validUntil <= now || !Number.isFinite(balance)) return false;
  if (plan.side === 'sell') return true;
  return plan.side === 'buy' && Number.isFinite(amount) && amount >= 10 && amount <= Math.min(balance, 1000);
}

export function liteOrderLabel(side, symbol, amount, lang) {
  if (side === 'sell') return lang === 'en' ? 'Sell all ' + symbol : '卖出全部 ' + symbol;
  const value = amount == null ? symbol : amount + ' USDT';
  return (lang === 'en' ? 'Buy ' : '买入 ') + value;
}

export function liteStrategyCard(row, { strategy, stale = false, lang = 'zh' }) {
  const o = row.live;
  const en = lang === 'en';
  const state = stale ? (en ? 'Previous close' : '上次收盘') : {
    buy: en ? 'Entry conditions met' : '已满足入场条件',
    sell: en ? 'Exit conditions met' : '已满足退出条件',
    watch: en ? 'Watching for entry' : '等待入场确认'
  }[strategy.side];
  const entryRule = en
    ? 'Close above EMA20, positive 5-bar change and RSI14 above 50.'
    : '收盘价高于 EMA20，5 根涨幅为正，且 RSI14 高于 50。';
  const enter = strategy.side === 'buy' ? entryRule : en
    ? 'Wait for a close above EMA20, positive 5-bar change and RSI14 above 50.'
    : '等待收盘站上 EMA20、5 根涨幅转正、RSI14 高于 50。';
  const exit = {
    sell: en ? 'All three exit conditions are met. Confirm to sell your full position.' : '退出条件已满足，可在操作台确认卖出全部持仓。',
    buy: en ? 'When all three reverse, confirm to sell the full position.' : '三项指标均转弱时，可确认卖出全部持仓。',
    watch: o.direction === 'down'
      ? (en ? 'No position to close on this downward signal.' : '当前无该币持仓，本次下行信号无需平仓。')
      : (en ? 'Wait for all three readings to turn down before closing a held position.' : '待三项指标均转弱，再确认是否卖出已有持仓。')
  }[strategy.side];
  const practice = o.mode === 'practice';
  const source = practice ? (en ? 'Local practice' : '本机演练') : o.source;
  const provider = !practice && o.source.startsWith('Binance') && markets.has(o.symbol)
    ? `<a data-ls="source" href="https://www.binance.com/en/trade/${o.symbol}_USDT" target="_blank" rel="noopener noreferrer">${esc(source)} ↗</a>`
    : esc(source);
  const iso = new Date(o.closedAt).toISOString();
  const reading = readingFormats[en ? 'en' : 'zh'];
  const momentum = (o.momentumPct > 0 ? '+' : '') + reading.format(o.momentumPct) + '%';
  const series = o.priceSeries;
  let chart = '';
  if (Array.isArray(series) && series.length >= 2 && series.at(-1) === o.price && series.every(n => Number.isFinite(n) && n > 0)) {
    const width = 208, height = 45;
    const points = sparklinePoints(series, width, height);
    const high = Math.max(...series), low = Math.min(...series);
    const prices = high === low ? [high] : [high, low];
    const axis = prices.map(price => {
      const top = points[series.indexOf(price)][1] / height * 100;
      return `<span style="top:${top.toFixed(2)}%">${reading.format(price)}</span>`;
    }).join('');
    const start = new Date(o.closedAt - (series.length - 1) * 60000).toISOString();
    chart = `<figure class="sig-live-chart" aria-label="${en ? 'Minute closing prices' : '分钟收盘走势'}">
      <div class="lite-chart-plot" aria-hidden="true">${sparkline(series, { width, height, color: 'var(--chart-accent)', fill: false })}<div class="lite-chart-scale">${axis}</div></div>
      <div class="lite-chart-times" aria-hidden="true"><span>${start.slice(11, 16)}</span><span>${iso.slice(11, 16)} UTC</span></div>
    </figure>`;
  }
  return `<article class="sig-event sig-live-observation lite-plan-card" data-freshness="${stale ? 'previous' : 'current'}" data-side="${strategy.side}" data-live-direction="${esc(o.direction)}" data-lite-asset="${esc(o.symbol)}" data-lite-id="${esc(o.id)}">
    <div class="lite-plan-body">
      <header class="lite-plan-pairline">${tokenIcon(o.symbol, { size: 30, className: 'sig-coin' })}
        <div class="lite-plan-identity"><span class="lite-plan-pair">${esc(o.market)}</span><h3 class="lite-plan-title">${esc(strategy.label)}</h3></div>
        <span class="lite-plan-state">${state}</span>
      </header>
      <div class="lite-plan-market"><div class="lite-plan-quote"><div class="sig-stats-quote"><span>${en ? 'Closing price' : '收盘价'}</span><strong class="dot-number">${esc(signalClosePrice(o.price))} <small>${esc(o.unit)}</small></strong></div>
        <div class="lite-card-source"><span>${provider}</span><time title="${iso}" datetime="${iso}">${iso.slice(11, 16)} UTC</time></div></div>
      ${chart}</div>
      <dl class="lite-plan-readings"><div><dt>EMA 20</dt><dd>${reading.format(o.ema20)}</dd></div><div data-change="${Math.sign(o.momentumPct)}"><dt>${en ? '5-bar change' : '5 根涨跌幅'}</dt><dd>${esc(momentum)}</dd></div><div><dt>RSI 14</dt><dd>${esc(reading.format(o.rsi14))}</dd></div></dl>
      <details class="lite-plan-rules-box"><summary>${en ? 'Entry and exit rules' : '入场与退出条件'}</summary>
        <dl class="lite-plan-rules"><div><dt>${en ? 'Entry' : '入场'}</dt><dd>${enter}</dd></div><div><dt>${en ? 'Exit' : '退出'}</dt><dd>${exit}</dd></div></dl></details>
    </div>
  </article>`;
}

function mountCloseInspector(card, observation, lang, previousTime) {
  const chart = card.querySelector('.sig-live-chart');
  if (!chart) return;
  const svg = chart.querySelector('svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const { width, height } = svg.viewBox.baseVal;
  const points = sparklinePoints(observation.priceSeries, width, height);
  const last = points.length - 1;
  const [firstX] = points[0], [lastX] = points[last];
  const stroke = svg.querySelector('.chart-light-line');
  const readout = chart.ownerDocument.createElement('figcaption');
  const unit = ' ' + observation.unit;
  const clamp = (value) => Math.max(0, Math.min(last, value));
  let index = Number.isFinite(previousTime) ? clamp(last - Math.round((observation.closedAt - previousTime) / 60_000)) : last;

  svg.insertAdjacentHTML('afterbegin', `<path class="lite-spark-area" d="${stroke.getAttribute('d')} L${lastX},${height} H${firstX} Z"/>`);
  svg.insertAdjacentHTML('beforeend', `<g class="lite-spark-cursor"><line y1="0" y2="${height}"/><circle r="3.5"/></g>`);
  const cursor = svg.lastElementChild;
  readout.className = 'lite-spark-readout';
  readout.setAttribute('aria-hidden', 'true');
  readout.innerHTML = '<time></time><b></b>';
  chart.append(readout);
  chart.tabIndex = 0;
  chart.dataset.ls = 'chart';
  chart.setAttribute('role', 'slider');
  chart.setAttribute('aria-label', observation.symbol + (lang === 'en' ? ' closing price history' : ' 分钟收盘走势'));
  chart.setAttribute('aria-valuemin', '1');
  chart.setAttribute('aria-valuemax', String(points.length));

  function update(value) {
    index = clamp(value);
    const closedAt = observation.closedAt - (last - index) * 60_000;
    const iso = new Date(closedAt).toISOString();
    const time = iso.slice(11, 16) + ' UTC';
    const quote = signalClosePrice(observation.priceSeries[index]) + unit;
    const [x, y] = points[index];
    cursor.setAttribute('transform', 'translate(' + x + ',0)');
    cursor.lastElementChild.setAttribute('cy', String(y));
    readout.firstElementChild.dateTime = iso;
    readout.firstElementChild.textContent = time;
    readout.lastElementChild.textContent = quote;
    chart.dataset.closeAt = String(closedAt);
    chart.setAttribute('aria-valuenow', String(index + 1));
    chart.setAttribute('aria-valuetext', iso.slice(0, 10) + ' ' + time + ', ' + quote);
  }
  update(index);
  let pointerType = '';
  chart.addEventListener('pointerdown', (event) => { pointerType = event.pointerType; });
  chart.addEventListener('click', (event) => {
    // WebKit reports the compatibility click after a tap as a mouse click.
    const touch = event.detail > 0 && (pointerType || event.pointerType) === 'touch';
    pointerType = '';
    if (touch) return;
    event.stopPropagation();
    chart.focus({ preventScroll: true });
    chart.setAttribute('data-inspecting', '');
  });
  chart.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' || event.buttons) return;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const pointer = svg.createSVGPoint();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const x = pointer.matrixTransform(matrix.inverse()).x;
    const hit = clamp(Math.round((x - firstX) / (lastX - firstX) * last));
    if (hit !== index) update(hit);
    chart.setAttribute('data-inspecting', '');
  });
  chart.addEventListener('pointerleave', () => {
    if (!chart.matches(':focus-visible')) chart.removeAttribute('data-inspecting');
  });
  chart.addEventListener('focus', () => {
    if (chart.matches(':focus-visible')) chart.setAttribute('data-inspecting', '');
  });
  chart.addEventListener('blur', () => chart.removeAttribute('data-inspecting'));
  chart.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      chart.removeAttribute('data-inspecting');
      return;
    }
    const targets = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowDown: index - 1, ArrowUp: index + 1, Home: 0, End: last };
    if (!Object.hasOwn(targets, event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    update(targets[event.key]);
    chart.setAttribute('data-inspecting', '');
  });
}

export function mountStrategyCard(host, lang) {
  let lastMarkup = '';
  let lastId = '';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  return function show(observation, strategy) {
    const row = observation && strategy && liveSignalRow(observation);
    const markup = row ? liteStrategyCard(row, { strategy, lang, stale: observation.validUntil <= Date.now() }) : '';
    if (lastMarkup === markup) return;
    const oldCard = host.firstElementChild;
    const oldRules = oldCard?.querySelector('details');
    const keepRules = oldRules?.open && oldCard.dataset.liteAsset === observation?.symbol;
    const focus = host.ownerDocument.activeElement;
    const restoreFocus = focus?.matches('.sig-live-chart, .lite-plan-rules-box summary') && host.contains(focus);
    const pointTime = focus?.matches('.sig-live-chart') ? Number(focus.dataset.closeAt) : null;
    lastMarkup = markup;
    host.innerHTML = markup;
    const card = host.firstElementChild;
    if (card) {
      if (keepRules) card.querySelector('details').open = true;
      mountCloseInspector(card, observation, lang, pointTime);
      if (restoreFocus) card.querySelector(focus.tagName === 'SUMMARY' ? 'summary' : '.sig-live-chart')?.focus({ preventScroll: true });
      if (lastId !== observation.id && !host.ownerDocument.hidden && !reducedMotion.matches && document.documentElement.dataset.reducedMotion !== 'true') {
        card.animate([{ opacity: .65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      }
    }
    lastId = observation?.id || '';
  };
}

function feedCardBody({ row, strategy }, lang) {
  const en = lang === 'en';
  const reading = readingFormats[en ? 'en' : 'zh'];
  const iso = new Date(row.closedAt).toISOString();
  const series = row.priceSeries;
  const hasChart = Array.isArray(series) && series.length > 1 && series.at(-1) === row.price &&
    series.every(value => Number.isFinite(value) && value > 0);
  return `<span class="lite-feed-pair">${tokenIcon(row.symbol, { size: 30 })}
      <span><b>${esc(row.symbol)}</b><small> / USDT</small></span><i class="lite-feed-check" aria-hidden="true">✓</i></span>
    <span class="lite-feed-name">${esc(strategy.label)}</span>
    <span class="lite-feed-state"></span>
    <span class="lite-feed-quote"><small>${en ? 'Close' : '收盘价'}</small>
      <span><b class="dot-number">${esc(signalClosePrice(row.price))}</b> <small>${esc(row.unit)}</small></span></span>
    <span class="lite-feed-line" aria-hidden="true">${hasChart ? sparkline(series, { width: 208, height: 45, color: 'var(--chart-accent)', fill: true }) : ''}</span>
    <span class="lite-feed-foot"><span>${en ? '5m change' : '5 分钟涨跌'} <b data-change="${Math.sign(row.momentumPct)}">${row.momentumPct > 0 ? '+' : ''}${reading.format(row.momentumPct)}%</b></span>
      <time datetime="${iso}" title="${iso}">${iso.slice(11,16)} UTC</time></span>`;
}

export function mountLiteSignalFeed(host, { lang, onSelect }) {
  const en = lang === 'en';
  const labels = en
    ? { buy: 'Entry confirmed', sell: 'Exit confirmed', watch: 'Watching', expired: 'Expired', filled: 'Recorded', skipped: 'Skipped' }
    : { buy: '已满足入场条件', sell: '已满足退出条件', watch: '观察中', expired: '已过期', filled: '已记录', skipped: '已跳过' };
  host.innerHTML = `<div class="lite-feed-rail" role="group" aria-label="${en ? 'Strategy cards' : '策略卡片'}"></div>
    <details class="lite-feed-detail" hidden><summary>${en ? 'Strategy details' : '策略详情'}<span></span></summary>
      <div class="lite-strategy-deck"></div></details>`;
  const rail = host.querySelector('.lite-feed-rail');
  const detail = host.querySelector('.lite-feed-detail');
  const detailLabel = detail.querySelector('summary span');
  const showDetails = mountStrategyCard(detail.lastElementChild, lang);
  const nodes = new Map();
  let selected = null;
  function refreshDetail() {
    if (detail.open && selected) showDetails(selected.row, selected.strategy);
  }
  detail.addEventListener('toggle', refreshDetail);
  function choose(event) {
    const card = event.target.closest('[data-feed-id]');
    if (card && !card.disabled) onSelect(card.dataset.feedId);
  }
  function moveFocus(event) {
    const card = event.target.closest('[data-feed-id]');
    if (!card || event.altKey || event.ctrlKey || event.metaKey) return;
    const cards = Array.from(rail.children);
    const at = cards.indexOf(card);
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: cards.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    cards[Math.min(cards.length - 1, Math.max(0, next))]?.focus();
  }
  rail.addEventListener('click', choose);
  rail.addEventListener('keydown', moveFocus);
  return {
    render(items, { selectedId, busy }) {
      const before = rail.getBoundingClientRect();
      const browsing = rail.scrollLeft > 6 || rail.scrollTop > 6;
      const anchor = browsing && Array.from(rail.children).find(node => {
        const rect = node.getBoundingClientRect();
        return rect.right > before.left + 2 && rect.bottom > before.top + 2;
      });
      const prevRect = anchor && anchor.getBoundingClientRect();
      const animate = nodes.size > 0 && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches &&
        document.documentElement.dataset.reducedMotion !== 'true';
      const oldId = selected?.row.id;
      selected = null;
      const keep = new Set();
      let slot = rail.firstElementChild;
      for (const item of items) {
        const { row, strategy, state } = item;
        if (!strategy || strategy.signalId !== row.id || keep.has(row.id)) continue;
        keep.add(row.id);
        let card = nodes.get(row.id);
        const entering = !card;
        if (entering) {
          card = document.createElement('button');
          card.type = 'button';
          card.className = 'lite-feed-card';
          card.dataset.feedId = row.id;
          card.dataset.feedAsset = row.symbol;
          card.setAttribute('aria-controls', 'lite-controls');
          nodes.set(row.id, card);
        }
        if (entering || card.dataset.side !== strategy.side) {
          card.innerHTML = feedCardBody(item, lang);
          card.querySelector('.lite-feed-line svg')?.setAttribute('preserveAspectRatio', 'none');
          card.dataset.side = strategy.side;
        }
        const chosen = selectedId === row.id;
        if (chosen) selected = item;
        const status = labels[state === 'current' ? strategy.side : state] || labels.expired;
        if (card.dataset.state !== state || card.querySelector('.lite-feed-state').textContent !== status) {
          card.dataset.state = state;
          card.querySelector('.lite-feed-state').textContent = status;
        }
        card.disabled = Boolean(busy);
        card.setAttribute('aria-pressed', String(chosen));
        if (slot !== card) rail.insertBefore(card, slot);
        slot = card.nextElementSibling;
        if (entering && animate) {
          card.animate([{opacity: .3, transform: 'translateY(-8px)'}, {opacity: 1, transform: 'translateY(0)'}],
            {duration: 360, easing: 'cubic-bezier(.2,.75,.2,1)'});
        }
      }
      for (const [id, card] of nodes) {
        if (!keep.has(id)) { card.remove(); nodes.delete(id); }
      }
      if (anchor?.isConnected && prevRect && oldId === selectedId) {
        const now = anchor.getBoundingClientRect();
        rail.scrollLeft += now.left - prevRect.left;
        rail.scrollTop += now.top - prevRect.top;
      }
      if (selected && oldId !== selectedId && rail.scrollWidth > rail.clientWidth + 2) {
        const rect = nodes.get(selectedId).getBoundingClientRect();
        if (rect.left < before.left || rect.right > before.right) rail.scrollLeft += rect.left - before.left;
      }
      detail.hidden = !selected;
      detailLabel.textContent = selected ? selected.row.market : '';
      if (selected) refreshDetail();
      else detail.open = false;
    },
    focus(id) { (nodes.get(id) || rail.firstElementChild)?.focus({ preventScroll: true }); },
    destroy() {
      rail.removeEventListener('click', choose);
      rail.removeEventListener('keydown', moveFocus);
      detail.removeEventListener('toggle', refreshDetail);
    }
  };
}
