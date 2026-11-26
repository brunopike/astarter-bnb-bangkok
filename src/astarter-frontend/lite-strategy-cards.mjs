import { tokenIcon } from './brand-icons.mjs';
import { liveSignalRow, signalClosePrice } from './live-signal-view.mjs';
import { sparkline, sparklinePoints } from './product-charts.mjs';
import { uiGlyph } from './product-composition.mjs';
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

export function liteOrderLabel(side, symbol, amount, lang) {
  if (side === 'sell') return lang === 'en' ? 'Sell all ' + symbol : '卖出全部 ' + symbol;
  const value = amount == null ? symbol : amount + ' USDT';
  return (lang === 'en' ? 'Buy ' : '买入 ') + value;
}

export function liteStrategyCard(row, { strategy, selected = false, busy = false, stale = false, quickOrder, lang = 'zh' }) {
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
  const execute = strategy.actionable && !stale;
  const action = stale ? (en ? 'Awaiting close' : '等待新收盘') : execute
    ? liteOrderLabel(strategy.side, o.symbol, quickOrder?.amount, lang)
    : (en ? 'View signal' : '查看信号');
  const unavailable = !quickOrder?.ready || quickOrder.blockedId === o.id ||
    (strategy.side === 'buy' && (quickOrder.amount == null || quickOrder.amount > quickOrder.balance));
  const actionDisabled = busy || stale || (execute && unavailable);
  const evidence = en ? 'Evidence' : '查看依据';
  const practice = o.mode === 'practice';
  const source = practice ? (en ? 'Local practice' : '本机演练') : o.source;
  const provider = !practice && o.source.startsWith('Binance') && markets.has(o.symbol)
    ? `<a data-ls="source" href="https://www.binance.com/en/trade/${o.symbol}_USDT" target="_blank" rel="noopener noreferrer">${esc(source)} ↗</a>`
    : esc(source);
  const iso = new Date(o.closedAt).toISOString();
  const reading = readingFormats[en ? 'en' : 'zh'];
  const momentum = (o.momentumPct > 0 ? '+' : '') + reading.format(o.momentumPct) + '%';
  const series = o.priceSeries;
  const chart = Array.isArray(series) && series.length >= 2 && series.at(-1) === o.price && series.every(n => Number.isFinite(n) && n > 0)
    ? `<figure class="sig-live-chart" aria-label="${en ? 'Minute closing prices' : '分钟收盘走势'}"><div aria-hidden="true">${sparkline(series, { width: 208, height: 45, color: 'var(--chart-accent)', fill: false })}</div></figure>` : '';
  const disabled = busy || stale ? ' disabled' : '';
  return `<article class="sig-event sig-live-observation lite-plan-card${selected ? ' selected' : ''}" data-freshness="${stale ? 'previous' : 'current'}" data-side="${esc(strategy.side)}" data-live-direction="${esc(o.direction)}" data-lite-asset="${esc(o.symbol)}" data-lite-id="${esc(o.id)}" aria-current="${selected}">
    <div class="lite-plan-body">
      <div class="lite-plan-state"><span>${state}</span>${execute ? '<small class="lite-plan-account">' + (en ? 'Practice account' : '练习账户') + '</small>' : ''}${selected ? '<span class="sig-current-marker" aria-hidden="true">✓</span>' : ''}</div>
      <h3 class="lite-plan-title">${esc(strategy.label)}</h3>
      <div class="lite-plan-pairline"><span class="lite-plan-pair">${tokenIcon(o.symbol, { size: 24, className: 'sig-coin' })}${esc(o.market)}</span>
        <span class="lite-plan-period">${en ? '1m candles' : '1 分钟 K 线'}</span></div>
      <div class="lite-plan-quote"><div class="sig-stats-quote"><span>${en ? 'Closing price' : '收盘价'}</span>
        <strong class="dot-number">${esc(signalClosePrice(o.price))} <small>${esc(o.unit)}</small></strong></div>${chart}</div>
      <dl class="lite-plan-readings"><div><dt>${en ? '5-bar change' : '5 根涨跌幅'}</dt><dd>${esc(momentum)}</dd></div><div><dt>RSI 14</dt><dd>${esc(reading.format(o.rsi14))}</dd></div></dl>
      <dl class="lite-plan-rules"><div><dt>${en ? 'Entry' : '入场'}</dt><dd>${enter}</dd></div><div><dt>${en ? 'Exit' : '退出'}</dt><dd>${exit}</dd></div></dl>
      <div class="lite-card-source"><span>${provider}</span><time title="${iso}" datetime="${iso}">${iso.slice(11, 16)} UTC</time></div>
    </div>
    <footer class="lite-plan-actions"><button type="button" data-ls="evidence" aria-label="${esc(o.symbol + ' · ' + evidence)}"${disabled}>${evidence}</button>
      <button type="button" data-ls="${execute ? 'execute' : 'select'}"${execute ? ' data-side="' + strategy.side + '" data-amount="' + esc(quickOrder?.amount) + '"' : ''} aria-controls="lite-controls" aria-label="${esc(o.symbol + ' · ' + action + (execute ? en ? ' · Practice account' : ' · 练习账户' : ''))}"${actionDisabled ? ' disabled' : ''}>${esc(action)} ${uiGlyph('arrow')}</button></footer>
  </article>`;
}

function mountCloseInspector(card, observation, lang, previousTime) {
  const chart = card.querySelector('.sig-live-chart');
  if (!chart) return;
  const svg = chart.querySelector('svg');
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

export function mountStrategyCards(host, { lang = 'zh', onSelect, onExecute, onEvidence, onRendered } = {}) {
  host.classList.add('sig-tracking', 'lite-strategy-deck');
  let rows = [];
  let byId = new Map();
  let settings = {};
  const rendered = new Map();
  const doc = host.ownerDocument;
  const reducedMotion = doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
  const motionAllowed = () => !doc.hidden && doc.documentElement.dataset.reducedMotion !== 'true' && !reducedMotion.matches;
  const template = doc.createElement('template');
  let expiryTimer;
  let mounted = true;

  function setRows(nextRows, nextSettings = {}) {
    if (!mounted) return;
    clearTimeout(expiryTimer);
    rows = nextRows;
    settings = nextSettings;
    const { selectedId, holdings = [], busy = false } = settings;
    const now = Date.now();
    const visible = new Set();
    const focused = host.contains(doc.activeElement) && doc.activeElement.closest('[data-ls]');
    const focusedCard = focused && focused.closest('article');
    const motion = motionAllowed();
    byId = new Map();
    for (const observation of rows) {
      const key = observation.mode + '/' + observation.symbol;
      const previous = rendered.get(key);
      const stale = observation.validUntil <= now;
      if (stale && (previous?.id !== observation.id || now >= cardDisplayUntil(observation))) continue;
      const holding = holdings.find((position) => position.symbol === observation?.symbol);
      const strategy = stale ? previous.strategy : strategyForSignal(observation, holding, lang, now);
      if (!strategy || byId.has(observation.id)) continue;
      const row = liveSignalRow(observation);
      if (!row) continue;
      if (visible.has(key)) continue;
      const index = visible.size;
      visible.add(key);
      byId.set(observation.id, observation);
      const selected = observation.id === selectedId;
      const markup = liteStrategyCard(row, { selected, strategy, busy, stale, lang, quickOrder: settings.quickOrder });
      let card = previous?.card;
      if (markup !== previous?.markup) {
        template.innerHTML = markup;
        const next = template.content.firstElementChild;
        if (card) {
          for (const attribute of next.attributes) card.setAttribute(attribute.name, attribute.value);
          card.replaceChildren(...next.childNodes);
        } else {
          card = next;
        }
        const pointTime = focusedCard === card && focused.dataset.ls === 'chart' ? Number(focused.dataset.closeAt) : null;
        mountCloseInspector(card, observation, lang, pointTime);
        rendered.set(key, { card, markup, strategy, id: observation.id, closedAt: observation.closedAt, selected });
      }
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
      if (motion && (!previous || observation.closedAt > previous.closedAt)) {
        card.animate([{ opacity: .55, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, delay: index * 35, easing: 'ease-out', fill: 'backwards' });
      } else if (motion && selected && !previous.selected) {
        card.querySelector('.sig-current-marker')?.animate([{ transform: 'scale(.7)' }, { transform: 'scale(1)' }],
          { duration: 180, easing: 'ease-out' });
      }
    }
    for (const [key, { card }] of rendered) {
      if (!visible.has(key)) {
        card.remove();
        rendered.delete(key);
      }
    }
    host.hidden = !visible.size;
    onRendered?.(Array.from(byId.values(), (row) => row.symbol));
    if (focusedCard?.isConnected && doc.activeElement !== focused) {
      focusedCard.querySelector('[data-ls="' + focused.dataset.ls + '"]:not(:disabled)')?.focus({ preventScroll: true });
    }
    if (byId.size) {
      const nextExpiry = Math.min(...Array.from(byId.values(), (row) =>
        row.validUntil > now ? row.validUntil : cardDisplayUntil(row)
      ));
      expiryTimer = setTimeout(() => setRows(rows, settings), Math.max(0, nextExpiry - Date.now()));
    }
  }

  function click(event) {
    const card = event.target.closest('article[data-lite-id]');
    if (!card || !host.contains(card) || event.target.closest('a')) return;
    if (settings.busy || event.defaultPrevented) return;
    const selection = host.ownerDocument.getSelection();
    if (!event.target.closest('button') && !selection?.isCollapsed && card.contains(selection?.anchorNode)) return;
    const row = byId.get(card.dataset.liteId);
    if (!row || row.validUntil <= Date.now()) {
      setRows(rows, settings);
      return;
    }
    const executeButton = event.target.closest('[data-ls="execute"]');
    if (executeButton) {
      if (!executeButton.disabled && event.detail <= 1) {
        onExecute?.(row, executeButton.dataset.side, Number(executeButton.dataset.amount));
      }
    } else if (event.target.closest('[data-ls="evidence"]')) {
      onEvidence?.(row);
    } else {
      onSelect?.(row);
      if (card.isConnected && motionAllowed()) {
        card.animate([
          { boxShadow: 'inset 0 0 0 2px var(--lite-edge)' },
          { boxShadow: 'inset 0 0 0 0 transparent' }
        ], { duration: 320, easing: 'ease-out' });
      }
    }
  }

  host.addEventListener('click', click);
  host.hidden = true;
  return {
    setRows,
    destroy() {
      mounted = false;
      clearTimeout(expiryTimer);
      host.removeEventListener('click', click);
      rendered.clear();
      host.replaceChildren();
      host.hidden = true;
    }
  };
}
