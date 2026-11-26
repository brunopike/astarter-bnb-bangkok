import { sparklinePoints } from './product-charts.mjs';
import { liveSignalCard, liveSignalRow, signalClosePrice } from './live-signal-view.mjs';

const markets = new Set(['BTC', 'ETH', 'SOL']);
const plans = {
  buy: { id: 'signals-spot-momentum-entry', label: ['现货动量跟随', 'Spot momentum entry'] },
  sell: { id: 'signals-spot-momentum-exit', label: ['现货持仓退出', 'Spot position exit'] },
  watch: { id: 'signals-watch', label: ['等待入场信号', 'Wait for an entry'] }
};

export function strategyLabelForId(id, lang = 'zh') {
  const plan = Object.values(plans).find((item) => item.id === id);
  return plan?.label[lang === 'en' ? 1 : 0] || '';
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

export function mountStrategyCards(host, { lang = 'zh', onSelect, onEvidence } = {}) {
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
      const holding = holdings.find((position) => position.symbol === observation?.symbol);
      const strategy = strategyForSignal(observation, holding, lang, now);
      if (!strategy || byId.has(observation.id)) continue;
      const row = liveSignalRow(observation);
      if (!row) continue;
      const key = observation.mode + '/' + observation.symbol;
      if (visible.has(key)) continue;
      const index = visible.size;
      visible.add(key);
      byId.set(observation.id, observation);
      const selected = observation.id === selectedId;
      const markup = liveSignalCard(row, { selected, strategy, busy });
      const previous = rendered.get(key);
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
        rendered.set(key, { card, markup, price: observation.price, closedAt: observation.closedAt, selected });
      }
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
      if (motion && !previous) {
        card.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }],
          { duration: 230, delay: index * 35, easing: 'ease-out', fill: 'backwards' });
      } else if (motion && markup !== previous?.markup) {
        if (selected && !previous.selected) {
          card.querySelector('.sig-current-marker')?.animate([{ transform: 'scale(.7)' }, { transform: 'scale(1)' }],
            { duration: 180, easing: 'ease-out' });
        }
        if (observation.closedAt > previous.closedAt && observation.price !== previous.price) {
          card.querySelector('.sig-stats-quote strong')?.animate([{ color: 'var(--lite-card-tone)' }, { color: 'var(--b-ink)' }],
            { duration: 680, easing: 'ease-out' });
        }
      }
    }
    for (const [key, { card }] of rendered) {
      if (!visible.has(key)) {
        card.remove();
        rendered.delete(key);
      }
    }
    host.hidden = !visible.size;
    if (focusedCard?.isConnected && doc.activeElement !== focused) {
      focusedCard.querySelector('[data-ls="' + focused.dataset.ls + '"]:not(:disabled)')?.focus({ preventScroll: true });
    }
    if (byId.size) {
      const nextExpiry = Math.min(...Array.from(byId.values(), (row) => row.validUntil));
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
    if (event.target.closest('[data-ls="evidence"]')) {
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
