import { canSubmitLiteOrder, cardDisplayUntil, liteOrderLabel, mountStrategyCard, strategyForSignal, strategyLabelForId } from './lite-strategy-cards.mjs';
import { ORDER_MARKETS } from './order-markets.mjs';
import { createLiteDesk } from './lite-desk-data.mjs';
import { mountLiteChat } from './lite-chat.mjs';
import { mountLiteCrew } from './lite-crew.mjs';
import { uiGlyph } from './product-composition.mjs';
import { tokenIcon } from './brand-icons.mjs';

const desk = createLiteDesk();
const assets = ['BTC', 'ETH', 'SOL'];
const names = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana' };
function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem('astarter.lite.' + key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem('astarter.lite.' + key, JSON.stringify(value));
  } catch {}
}
function shared(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function mountLiteWorkspace(host, { lang: locale = 'zh', mountAssistant } = {}) {
  const english = !/^zh/i.test(locale);
  const lang = english ? 'en' : 'zh';
  const t = (zh, en) => (english ? en : zh);
  const query = new URLSearchParams(location.search);
  const lifetime = new AbortController();
  const styles = ['lite', 'lite-strategy-cards', 'lite-crew'].map((name) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/' + name + '.css?v=20261127-lite-trading-desk';
    document.head.append(link);
    return link;
  });
  host.innerHTML = `<div class="lite-main" data-no-translate>
    <header class="lite-command">
      <div class="lite-heading">
        <h1 id="lite-signals-title" tabindex="-1">${t('智选信号', 'Signals')}</h1>
      </div>
      <div id="lite-crew"></div>
      <div class="lite-command-group">
        <details class="lite-menu" id="lite-settings-menu"><summary title="${t('信号设置', 'Signal settings')}" aria-label="${t('信号设置', 'Signal settings')}" aria-describedby="lite-feed-label"><span id="lite-feed-label"></span>${uiGlyph('sliders')}</summary><div class="lite-popover"><div id="lite-settings"></div><button id="lite-mode-button" class="lite-text" type="button"></button></div></details>
      </div>
    </header>
    <div id="lite-workspace" class="lite-workspace" tabindex="-1">
      <div class="lite-asset-bar">
        <div id="lite-deck-summary" role="group" aria-label="${t('选择策略标的', 'Choose a strategy asset')}"></div>
        <span class="lite-summary-period">${t('1 分钟 K 线', '1m candles')}</span>
      </div>
      <section id="lite-ticket" aria-labelledby="lite-signals-title">
        <div id="lite-strategy-host" class="lite-strategy-deck"></div>
        <div id="lite-archive" class="lite-archive" hidden></div>
        <div id="lite-empty" class="lite-empty" role="status" hidden></div>
      </section>
      <aside class="order-dock" id="lite-controls" aria-labelledby="lite-controls-title">
        <div class="dock-title"><h2 id="lite-controls-title" tabindex="-1">${t('操作台', 'Order ticket')} <span id="lite-order-symbol"></span></h2>
          <details id="lite-account-menu" class="lite-menu"><summary>${t('练习账户', 'Practice account')}${uiGlyph('chevron')}</summary><div class="lite-popover" id="lite-account-info"></div></details>
        </div>
        <div id="lite-trade-panel"></div>
        <div id="lite-queue-tools" class="lite-queue"></div>
        <div class="market-tools" id="lite-inspect" hidden><button type="button" data-cmd="evidence" aria-controls="lite-evidence" aria-expanded="false">${uiGlyph('layers')}${t('信号依据', 'Evidence')}</button></div>
        <div id="lite-evidence" class="lite-disclosure" inert><div class="lite-disclosure-clip"><div id="lite-evidence-content" class="lite-inline"></div></div></div>
        <details id="lite-history" class="lite-history"><summary><span class="history-label">${uiGlyph('history')}${t('最近操作', 'Recent activity')}</span><span class="history-end"><span id="lite-history-count"></span>${uiGlyph('chevron')}</span></summary><div id="lite-history-list"></div></details>
      </aside>
    </div>
    <section class="lite-brain-floor" aria-label="${t('AI 助手', 'AI assistant')}"><div id="lite-chat-panel"></div></section>
    <p class="sr-only" role="status" id="lite-announcement"></p>
  </div>`;
  const view = host.firstElementChild;
  const el = (id) => view.querySelector('#lite-' + id);
  const fmt = (n, d = 2) =>
    Number.isFinite(n)
      ? n.toLocaleString(english ? 'en-US' : 'zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
      : '—';
  const clock = (ms) =>
    new Date(ms).toLocaleTimeString(english ? 'en-GB' : 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  const day = (ms) =>
    new Date(ms).toLocaleDateString(english ? 'en-GB' : 'zh-CN', { month: 'short', day: 'numeric' });
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  function button(action, label, cls = 'lite-text', disabled = false) {
    if (action === 'buy' || action === 'sell') {
      const mark = busy
        ? '<span class="ticket-spinner"></span>'
        : `<span class="ticket-arrow-window">${uiGlyph('arrow')}${uiGlyph('arrow')}</span>`;
      return `<button type="button" class="ops-button ops-primary lite-action lite-submit" data-cmd="${action}"${disabled ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}><span class="ticket-submit-label">${esc(label)}</span><span class="ticket-submit-cap" aria-hidden="true">${mark}</span></button>`;
    }
    const classes = cls === 'lite-action' ? 'ops-button ops-primary lite-action' : cls === 'secondary-btn' ? 'ops-button secondary-btn' : cls;
    return `<button type="button" class="${classes}" data-cmd="${action}"${disabled ? ' disabled' : ''}>${esc(label)}${cls === 'lite-action' ? uiGlyph('arrow') : ''}</button>`;
  }
  function readSymbols() {
    const saved = load('symbols', null);
    if (Array.isArray(saved) && saved.some((s) => assets.includes(s)))
      return assets.filter((s) => saved.includes(s));
    try {
      const watch = JSON.parse(shared('hive.market.watch-assets.v1') || '[]');
      const known = assets.filter((s) =>
        watch.some((a) => !a.address && a.symbol === s && a.id === names[s].toLowerCase())
      );
      if (known.length) return known;
    } catch {}
    return [...assets];
  }
  let symbols = readSymbols();
  let requestedAsset = query.get('asset')?.toUpperCase();
  if (assets.includes(requestedAsset) && !symbols.includes(requestedAsset)) symbols.push(requestedAsset);
  let mode = query.get('mode') === 'practice' ? 'practice' : 'live';
  let rows = [],
    failed = [],
    current = null,
    account = null,
    receipt = null;
  const chat = mountLiteChat(el('chat-panel'), { lang, mountAssistant });
  let busy = false,
    loading = false,
    formError = '',
    accountError = false,
    request = null;
  let skipped = [],
    undoId = null,
    skippedRow = null,
    wantedId = null,
    wantedSymbol = null,
    restoreReceipt = null,
    latestOnly = false;
  let nextReadAt = 0;
  let failedReads = 0;
  let blockedObservation = null;
  let handoffNotice = '';

  let selectedStrategy = null;
  let draftTouched = false;
  const feeRate = ORDER_MARKETS['cex-spot'].feeRate;
  const currentHolding = () => account?.holdings?.find((position) => position.symbol === current?.symbol);
  const editingAmount = () => document.activeElement === el('order-amount');
  function readDraft() {
    const value = Number(amountDraft);
    return /^\d+(?:\.\d{1,2})?$/.test(amountDraft ?? '') && value >= 10 && value <= 1000 ? value : null;
  }
  const amount = () => {
    const saved = load('amount', 50);
    return typeof saved === 'number' && saved >= 10 && saved <= 1000 ? saved : 50;
  };
  let amountDraft = String(amount());
  function readCursor() {
    const cursor = load('cursor.' + mode, {}) || {};
    skipped = load('skips.' + mode, []);
    if (!Array.isArray(skipped)) skipped = [];
    undoId = null;
    skippedRow = null;
    wantedSymbol = assets.includes(requestedAsset) ? requestedAsset : cursor.symbol;
    const signalId = new URLSearchParams(location.search).get('signalId');
    wantedId = signalId || (!requestedAsset || requestedAsset === cursor.symbol ? cursor.id : null);
    restoreReceipt =
      (!requestedAsset || requestedAsset === cursor.symbol) && (!signalId || signalId === cursor.id)
        ? cursor.receiptId
        : null;
  }
  function storeCursor() {
    save('cursor.' + mode, {
      id: current?.id || receipt?.signalId,
      symbol: current?.symbol || receipt?.symbol,
      receiptId: receipt?.id
    });
  }
  function setLink() {
    const active = current || receipt;
    const asset = active?.symbol || '';
    const signalId = mode === 'live' ? current?.id || receipt?.signalId || '' : '';
    view.dataset.liteAsset = asset;
    view.dataset.liteSignal = signalId;
    view.dataset.liteMode = mode;
    host.dispatchEvent(
      new CustomEvent('astarter:lite-context', { bubbles: true, detail: { asset, signalId, mode, lang } })
    );
  }
  function closeDetails() {
    el('evidence').inert = true;
    el('evidence-content').replaceChildren();
    view.querySelector('[data-cmd=evidence]').setAttribute('aria-expanded', 'false');
    formError = '';
  }
  function sourceLabel(row) {
    if (row.mode === 'practice' && row.id.startsWith('practice:exit:'))
      return t('本机卖出演练', 'Local exit scenario');
    return row.mode === 'practice' ? t('本机演练行情', 'Local practice feed') : row.source;
  }
  const showStrategy = mountStrategyCard(el('strategy-host'), lang);
  const assetButtons = new Map();
  function renderCards() {
    const at = Date.now();
    const candidates = new Map(queue(true).map((row) => [row.symbol, row]));
    const activeSymbol = receipt?.symbol || current?.symbol;
    const activeAsset = receipt || current;
    if (!receipt && current?.validUntil > at && !candidates.has(current.symbol)) candidates.set(current.symbol, current);
    const summary = el('deck-summary');
    for (const [symbol, item] of assetButtons) {
      if (!symbols.includes(symbol)) {
        item.remove();
        assetButtons.delete(symbol);
      }
    }
    for (const symbol of symbols) {
      let item = assetButtons.get(symbol);
      if (!item) {
        item = document.createElement('button');
        item.type = 'button';
        item.className = 'lite-summary-asset';
        item.dataset.liteChoice = symbol;
        item.setAttribute('aria-controls', 'lite-ticket lite-controls');
        item.innerHTML = tokenIcon(symbol, { size: 18 }) + '<span>' + symbol + '</span><i aria-hidden="true"></i>';
        assetButtons.set(symbol, item);
        summary.insertBefore(item, summary.children[symbols.indexOf(symbol)] || null);
      }
      const row = candidates.get(symbol);
      const fresh = Boolean(row && row.validUntil > at);
      const previousId = item.dataset.signalId;
      const newer = fresh && activeSymbol === symbol && row.id !== (receipt?.signalId || current?.id);
      item.dataset.signalId = row?.id || '';
      item.dataset.freshness = newer ? 'new' : fresh ? 'current' : 'waiting';
      item.setAttribute('aria-pressed', String(activeSymbol === symbol));
      const description = newer ? t('新收盘，查看最新策略', 'New close, view updated strategy') :
        fresh ? clock(row.closedAt) : t('等待新收盘', 'Awaiting close');
      item.title = symbol + ' · ' + description;
      item.setAttribute('aria-label', item.title);
      item.disabled = busy || !fresh;
      if (fresh && previousId && previousId !== row.id && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.reducedMotion !== 'true')
        item.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 450 });
    }
    crew.setActive([...candidates.values()].some((row) => row.validUntil > at));
    const showReading = !receipt && current && (cardDisplayUntil(current) > at || candidates.get(current.symbol)?.validUntil > at);
    const displayPlan = showReading && (selectedStrategy || strategyForSignal(current, currentHolding(), lang, current.closedAt));
    showStrategy(showReading ? current : null, displayPlan);
    el('inspect').hidden = !displayPlan || Boolean(receipt);
    const archive = el('archive');
    archive.hidden = !receipt;
    if (receipt && archive.dataset.receipt !== receipt.id) {
      archive.dataset.receipt = receipt.id;
      archive.innerHTML = `<div class="lite-plan-pair">${tokenIcon(receipt.symbol, { size: 28 })}${esc(receipt.market)}</div>
        <h3 class="lite-plan-title">${esc(strategyLabelForId(receipt.strategyId, lang) || t('操作记录', 'Activity'))}</h3>
        <span>${t('成交价', 'Fill price')}</span><strong class="dot-number">${fmt(receipt.price)} <small>USDT</small></strong>
        <p>${day(receipt.filledAt)} · ${clock(receipt.filledAt)}</p>`;
    }
    const empty = el('empty');
    empty.hidden = Boolean(receipt || displayPlan);
    if (!empty.hidden) {
      const message = loading ? t('正在读取信号…', 'Loading signals…') : failed.length
        ? t('暂时无法读取行情。', 'Market data is unavailable.')
        : t('等待下一根 K 线收盘…', 'Waiting for the next candle close…');
      empty.innerHTML = message + (loading ? '' : ' ' + button('refresh', t('刷新', 'Refresh')));
    }
    el('ticket').setAttribute('aria-busy', String(loading && !activeAsset));
  }
  const viewport = host.closest('#product-page');
  function reveal(section, align = 'nearest') {
    const area = viewport.getBoundingClientRect();
    const item = section.getBoundingClientRect();
    if (align === 'start' || item.top < area.top || item.height > area.height) {
      viewport.scrollTop += item.top - area.top - 8;
    } else if (item.bottom > area.bottom) {
      viewport.scrollTop += item.bottom - area.bottom + 8;
    }
  }
  function focusCard() {
    const choice = assetButtons.get(current?.symbol || receipt?.symbol);
    const target = choice && !choice.disabled ? choice : el('signals-title');
    target.focus({ preventScroll: true });
    reveal(target);
  }
  function renderEvidence() {
    const row = current;
    if (!row) return;
    const data = [
      [t('数据来源', 'Source'), sourceLabel(row)],
      [t('K 线收盘', 'Candle close'), day(row.closedAt) + ' ' + clock(row.closedAt)],
      ['EMA 20', fmt(row.ema20) + ' USDT'],
      ['RSI 14', fmt(row.rsi14, 1)],
      [t('近 5 根涨跌幅', 'Five-bar change'), fmt(row.momentumPct) + '%']
    ];
    if (Number.isFinite(row.volumeRatio))
      data.push([t('相对成交量', 'Relative volume'), fmt(row.volumeRatio) + '×']);
    el('evidence-content').innerHTML =
      `<div class="inline-heading"><h3>${t('信号依据', 'Signal evidence')}</h3>${button('evidence', t('收起', 'Close'))}</div>${data.map(([a, b]) => `<div class="lite-detail-row"><span>${a}</span><strong>${esc(b)}</strong></div>`).join('')}<p class="risk-copy">${row.mode === 'practice' ? t('这组演练数据固定 15 分钟，供熟悉操作流程。', 'This practice scenario stays fixed for 15 minutes.') : t('下一根收盘后重新计算。方向改变或观察到期后，需要核对新信号。', 'Recalculated after the next close. A direction change or expiry requires a fresh observation.')}</p>`;
  }
  const errors = {
    EXPIRED: ['这条观察已经过期，请读取新信号。', 'This observation expired. Refresh before continuing.'],
    SIGNAL_CHANGED: ['信号已变，请重新核对。', 'The signal changed. Review the latest observation.'],
    QUOTE_CHANGED: [
      '报价已偏离这条信号，请等待下一根收盘后再读取。',
      'The quote moved away from this signal. Refresh after the next close.'
    ],
    INSUFFICIENT_FUNDS: ['可用资金不足，请调低金额。', 'Insufficient funds. Lower the amount.'],
    INVALID_AMOUNT: [
      '请输入 10 至 1,000 USDT，最多两位小数。',
      'Enter 10–1,000 USDT with up to two decimal places.'
    ],
    UNAVAILABLE: ['暂时无法核对最新报价，请稍后再试。', 'A fresh quote is unavailable. Try again shortly.'],
    DUST_POSITION: [
      '该持仓的预计卖出所得不足 0.01 USDT。',
      'Estimated proceeds for this position are below 0.01 USDT.'
    ],
    POSITION_CHANGED: [
      '持仓已变动，请核对最新数量后再确认。',
      'Your position changed. Review the updated quantity before confirming.'
    ],
    NO_POSITION: [
      '此账户已无该资产持仓。',
      'This account no longer holds this asset.'
    ],
    STORAGE_UNAVAILABLE: [
      '无法读取本机账户，请检查浏览器存储设置后重试。',
      'Device storage is unavailable. Check browser storage settings and retry.'
    ]
  };
  const errorText = (code) => t(...(errors[code] || errors.UNAVAILABLE));
  function orderLine(label, value) {
    return `<div class="order-line"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }
  function validPlan() {
    if (!current || !selectedStrategy || selectedStrategy.signalId !== current.id) return null;
    const latest = strategyForSignal(current, currentHolding(), lang);
    return latest?.actionable && latest.id === selectedStrategy.id ? latest : null;
  }
  function syncEstimate(showError = false, highlight = false) {
    const input = el('order-amount');
    if (!input) return;
    const value = readDraft();
    const invalid = value === null;
    const insufficient = !invalid && account && value > account.balance;
    const fee = value !== null ? Math.round((value * 100 * feeRate) / (1 + feeRate)) / 100 : null;
    const estimate = value !== null && current?.price > 0 ? (value - fee) / current.price : null;
    el('order-fee').textContent = fmt(fee) + ' USDT';
    const quantity = el('order-quantity');
    const nextQuantity = fmt(estimate, 6) + ' ' + current.symbol;
    if (quantity.textContent !== nextQuantity) {
      quantity.textContent = nextQuantity;
      if (
        highlight &&
        !invalid &&
        !insufficient &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches &&
        !view.closest('[data-reduced-motion="true"]')
      ) {
        for (const effect of quantity.getAnimations()) effect.cancel();
        quantity.animate([{ opacity: 0.66 }, { opacity: 1 }], { duration: 170, easing: 'ease-out' });
      }
    }
    const action = el('trade-panel').querySelector('[data-cmd=buy]');
    if (action) {
      action.disabled = busy || !canSubmitLiteOrder(current, validPlan(), account?.balance, value, blockedObservation?.id);
      if (!busy)
        action.querySelector('.ticket-submit-label').textContent = liteOrderLabel('buy', current.symbol, value, lang);
    }
    input.setAttribute('aria-invalid', String(Boolean(showError && (invalid || insufficient))));
    for (const preset of el('trade-panel').querySelectorAll('[data-cmd=preset]'))
      preset.setAttribute('aria-pressed', String(Number(preset.value) === value));
    if (showError) {
      const error = invalid ? 'INVALID_AMOUNT' : insufficient ? 'INSUFFICIENT_FUNDS' : formError;
      el('order-note').textContent = error ? errorText(error) : '';
    }
  }
  function renderTrade() {
    const target = el('trade-panel');
    el('order-symbol').textContent = receipt?.symbol || current?.symbol || '';
    if (receipt) {
      const sold = receipt.side === 'sell';
      const exercise =
        mode === 'practice' && !sold && account?.holdings.some((h) => h.symbol === receipt.symbol);
      const planLabel = strategyLabelForId(receipt.strategyId, lang);
      const details =
        orderLine(t('成交价', 'Fill price'), fmt(receipt.price) + ' USDT') +
        orderLine(
          sold ? t('净收回', 'Net proceeds') : t('总支出', 'Total spent'),
          fmt(receipt.amount) + ' USDT'
        ) +
        orderLine(t('手续费', 'Fee'), fmt(receipt.fee) + ' USDT');
      target.innerHTML = `<div class="fill-state"><div class="fill-heading"><span class="fill-check" aria-hidden="true">${uiGlyph('check')}</span><h3>${sold ? t('已记录卖出', 'Sell recorded') : t('已记录买入', 'Buy recorded')}</h3></div>
    ${planLabel ? `<p class="fill-strategy">${esc(planLabel)}</p>` : ''}<strong class="fill-size">${fmt(receipt.quantity, 6)} ${esc(receipt.symbol)}</strong>
    <div class="order-values">${details}</div><div class="dock-actions">${exercise ? button('practice-exit', t('练习卖出', 'Practice selling'), 'lite-action') : ''}${button('next', t('下一条信号', 'Next signal') + ' →', 'secondary-btn')}</div></div>`;
      return;
    }
    const holding = currentHolding();
    const plan = validPlan();
    const buy = plan?.side === 'buy',
      sell = plan?.side === 'sell';
    const expired = current && Date.now() >= current.validUntil;
    const needsRefresh = expired || ['EXPIRED', 'QUOTE_CHANGED', 'SIGNAL_CHANGED'].includes(formError);
    const label =
      (!expired && selectedStrategy?.label) ||
      (expired ? t('信号已到期', 'Signal expired') : t('等待可执行信号', 'Waiting for a trade signal'));
    const balance = orderLine(t('可用资金', 'Available funds'), fmt(account?.balance) + ' USDT');
    const symbol = current?.symbol || '—';
    const form = buy
      ? `<label class="field-label" for="lite-order-amount">${t('投入金额', 'Order amount')}</label>
    <div class="lite-amount-controls"><div class="order-input"><input id="lite-order-amount" name="amount" aria-describedby="lite-order-note" inputmode="decimal" autocomplete="off" value="${esc(amountDraft)}" ${busy ? 'disabled' : ''}><span>USDT</span></div>
    <div class="amount-presets">${[25, 50, 100].map((v) => `<button type="button" data-cmd="preset" value="${v}" aria-label="${v} USDT" ${busy ? 'disabled' : ''}>${v}<span class="preset-unit"> USDT</span></button>`).join('')}</div></div>`
      : sell
        ? `<div class="field-label">${t('卖出持仓', 'Position to sell')}</div><div class="sell-amount">${fmt(holding?.quantity, 6)} <small>${esc(symbol)}</small></div>`
        : '';
    const lines = buy
      ? `<div class="order-line"><span>${t('预计获得', 'Estimated quantity')}</span><strong id="lite-order-quantity"></strong></div><div class="order-line"><span>${t('预估手续费', 'Est. fee')}</span><strong id="lite-order-fee"></strong></div>`
      : sell
        ? orderLine(t('参考收盘价', 'Reference close'), fmt(current.price) + ' USDT')
        : '';
    const idle = !current
      ? loading
        ? t('正在读取信号…', 'Reading signals…')
        : t('可操作的推荐将显示在这里。', 'The next actionable strategy will appear here.')
      : t(
          '当前信号适合观察。可以看下一条，或展开信号依据。',
          'Watch this signal, view the evidence, or move to the next one.'
        );
    const act = needsRefresh
      ? button('fresh', t('读取最新信号', 'Refresh signal'), 'lite-action', busy)
      : buy || sell
        ? button(
            sell ? 'sell' : 'buy',
            busy
              ? t('正在核对…', 'Checking…')
              : liteOrderLabel(sell ? 'sell' : 'buy', symbol, readDraft(), lang),
            'lite-action',
            busy || !account
          )
        : current
          ? button(
              queue().some((r) => r.id !== current.id) ? 'cycle' : 'refresh',
              queue().some((r) => r.id !== current.id)
                ? t('查看下一条信号', 'View next signal')
                : t('刷新信号', 'Refresh signals'),
              'secondary-btn',
              busy
            )
          : button('refresh', t('刷新信号', 'Refresh signals'), 'secondary-btn', busy || loading);
    target.innerHTML = `<div class="order-config">
    ${!current || expired ? '<div class="order-plan"><h3>' + esc(label) + '</h3></div>' : ''}
    ${form}
    ${!plan && !needsRefresh ? `<p class="order-idle">${idle}</p>` : ''}
    <div class="order-values">${balance}${lines}</div>
    <div class="dock-actions">${act}</div>
    <p class="trade-note error" id="lite-order-note" role="status">${formError ? errorText(formError) : accountError ? errorText('STORAGE_UNAVAILABLE') : ''}</p></div>`;
    syncEstimate();
  }
  function queue(includePreviousClose = false) {
    const handled = new Set([...(account?.receipts || []).map((r) => r.signalId), ...skipped]);
    const at = Date.now();
    return rows.filter((row) => (includePreviousClose ? cardDisplayUntil(row) : row.validUntil) > at && !handled.has(row.id));
  }
  function expiryLabel() {
    const seconds = Math.max(0, Math.ceil((current.validUntil - Date.now()) / 1000));
    const countdown = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    return seconds ? t('有效期剩余 ', 'Expires in ') + countdown : t('观察已过期', 'Observation expired');
  }
  function renderQueue() {
    renderCards();
    const unavailable = failed.length > 0 && !rows.some((row) => row.validUntil > Date.now());
    const pending = loading && !rows.length;
    const state = pending
      ? t('读取行情中', 'Loading feed')
      : unavailable
        ? t('行情暂缺', 'Feed unavailable')
        : mode === 'practice'
          ? t('演练行情', 'Practice feed')
          : t('实时行情', 'Live feed');
    el('feed-label').innerHTML =
      `<i class="status-dot ${pending ? 'pending' : unavailable ? 'unavailable' : mode}"></i>${state}${failed.length && !pending && !unavailable ? ' · ' + esc(t('缺少 ', 'Missing ') + failed.map((f) => f.symbol).join(' / ')) : ''}`;
    el('mode-button').textContent =
      mode === 'practice' ? t('返回实时行情', 'Back to live feed') : t('体验演练', 'Try practice');
    el('mode-button').disabled = busy;
    const items = [];
    if (current && !receipt) items.push(`<span id="lite-expires-countdown">${expiryLabel()}</span>`);
    const actions = [];
    if (current && !receipt)
      actions.push(button('skip', t('跳过此信号', 'Dismiss signal'), 'lite-text', busy));
    if (undoId) actions.push(button('undo', t('撤销跳过', 'Undo dismiss'), 'lite-text', busy));
    if (actions.length) items.push('<span class="queue-actions">' + actions.join('') + '</span>');
    if (handoffNotice) items.push('<span>' + esc(handoffNotice) + '</span>');
    el('queue-tools').innerHTML = items.join('');
  }
  function renderAccount() {
    const receipts = account?.receipts || [];
    const feed = mode === 'practice' ? t('演练行情', 'Practice feed') : t('实时行情', 'Live feed');
    const holdings = account?.holdings || [];
    const positions = holdings.length
      ? `<div class="account-holdings"><small>${t('持仓', 'Positions')}</small>${holdings.map((h) => `<div><b>${esc(h.symbol)}</b><span>${fmt(h.quantity, 6)}</span>${mode === 'practice' ? `<button type="button" data-cmd="practice-exit" data-symbol="${esc(h.symbol)}">${t('练习卖出', 'Practice selling')}</button>` : ''}</div>`).join('')}</div>`
      : '';
    el('account-info').innerHTML =
      `<h3>${t('本机练习账户', 'Local practice account')}</h3><small>${feed} · ${t('可用余额', 'Available')}</small><strong class="account-number">${fmt(account?.balance)} USDT</strong>${positions}<p>${t('两种行情独立记账。操作仅记录在此浏览器。', 'Each feed has its own balance. Trades are recorded only in this browser.')}</p>`;
    el('history-count').textContent = String(receipts.length);
    el('history-list').innerHTML = receipts.length
      ? receipts
          .map(
            (r) =>
              `<div class="history-item"><div><b>${esc((r.side === 'sell' ? t('卖出 ', 'Sell ') : t('买入 ', 'Buy ')) + r.symbol)}</b><small>${day(r.filledAt)} ${clock(r.filledAt)} · ${fmt(r.quantity, 6)} ${esc(r.symbol)}</small><small>${t('成交价 ', 'Fill price ')}${fmt(r.price)} USDT</small></div><div class="history-amount">${r.side === 'sell' ? '+' : '−'}${fmt(r.amount)} USDT<small>${t('含手续费 ', 'Incl. fee ')}${fmt(r.fee, 3)} USDT</small></div></div>`
          )
          .join('')
      : `<p class="history-empty">${accountError ? errorText('STORAGE_UNAVAILABLE') : t('暂无操作记录。', 'No activity yet.')}</p>`;
  }
  function settings() {
    el('settings').innerHTML =
      `<fieldset><legend>${t('关注标的', 'Signal assets')}</legend>${assets.map((symbol) => `<label class="asset-option"><input type="checkbox" value="${symbol}" ${symbols.includes(symbol) ? 'checked' : ''} ${busy ? 'disabled' : ''}>${tokenIcon(symbol, { size: 18 })}${esc(names[symbol])}<small>${symbol}</small></label>`).join('')}</fieldset>`;
  }
  function paint() {
    renderTrade();
    renderQueue();
    renderAccount();
    setLink();
    chat.setSignal(current, current || receipt);
  }
  function pick(row, fill = null) {
    closeDetails();
    current = row ?? null;
    receipt = fill;
    draftTouched = false;
    selectedStrategy = current && !fill ? strategyForSignal(current, currentHolding(), lang) : null;
    if (blockedObservation && current?.id === blockedObservation.id) formError = blockedObservation.code;
    else blockedObservation = null;
    storeCursor();
    paint();
  }
  async function refresh({ replace = false, focusAfter = false } = {}) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    const timer = setTimeout(() => controller.abort(), 13000);
    if (!current && !receipt) paint();
    const [feed, book] = await Promise.allSettled([
      desk.readSignals({ mode, symbols, signal: controller.signal }),
      desk.getAccount(mode)
    ]);
    clearTimeout(timer);
    if (lifetime.signal.aborted || request !== controller) return;
    request = null;
    loading = false;
    const at = Date.now();
    const incoming = feed.status === 'fulfilled' ? feed.value.rows : [];
    const latest = new Map(rows.filter((row) => cardDisplayUntil(row) > at).map((row) => [row.symbol, row]));
    for (const row of incoming) {
      if (row.closedAt >= (latest.get(row.symbol)?.closedAt ?? 0)) latest.set(row.symbol, row);
    }
    rows = Array.from(latest.values()).filter((row) => symbols.includes(row.symbol));
    failed = feed.status === 'fulfilled' ? feed.value.failed : symbols.map((symbol) => ({ symbol }));
    const previousAccount = account;
    account = book.status === 'fulfilled' ? book.value : null;
    accountError = !account;
    const balanceChanged =
      previousAccount?.balance !== account?.balance ||
      previousAccount?.receipts.length !== account?.receipts.length;
    failedReads = failed.length ? Math.min(failedReads + 1, 4) : 0;
    const retryDelay = failedReads ? Math.min(30_000, 5_000 * 2 ** (failedReads - 1)) : Infinity;
    nextReadAt = Math.min(
      at + retryDelay,
      ...incoming.map((row) => row.validUntil),
      at + (mode === 'practice' ? 30_000 : 60_000)
    );
    if (
      mode === 'practice' &&
      wantedId &&
      wantedSymbol &&
      account?.holdings?.some((h) => h.symbol === wantedSymbol)
    ) {
      const exercise = desk.practiceExit(wantedSymbol);
      if (exercise.id === wantedId && !rows.some((r) => r.id === exercise.id)) rows.push(exercise);
    }
    const available = queue().sort((a, b) => Number(b.direction === 'up') - Number(a.direction === 'up'));
    if (receipt) {
      renderQueue();
      renderAccount();
      if (balanceChanged) renderTrade();
      return;
    }
    const candidateId = current?.id || wantedId;
    const savedFill = account?.receipts.find((r) => r.id === restoreReceipt || r.signalId === candidateId);
    if (savedFill) {
      restoreReceipt = null;
      pick(
        rows.find((r) => r.id === savedFill.signalId),
        savedFill
      );
      return;
    }
    if (!replace && current) {
      const updated = available.find((row) => row.symbol === current.symbol && row.id !== current.id);
      const isReading =
        chat.isInteracting() ||
        draftTouched ||
        editingAmount() ||
        !el('evidence').inert ||
        el('ticket').contains(document.activeElement) ||
        el('controls').contains(document.activeElement);
      if (current.validUntil <= Date.now() && updated && !isReading) {
        pick(updated);
        updateSelectedLink();
        return;
      }
      renderQueue();
      renderAccount();
      if (balanceChanged) {
        selectedStrategy = strategyForSignal(current, currentHolding(), lang);
        if (editingAmount()) syncEstimate(true);
        else renderTrade();
      }
      return;
    }
    let next = available.find((r) => r.id === wantedId) || available.find((r) => r.symbol === wantedSymbol);
    if (!next && !latestOnly) next = available[0];
    if (
      wantedId &&
      next &&
      next.id !== wantedId &&
      new URLSearchParams(location.search).get('signalId') === wantedId
    ) {
      handoffNotice = t(
        '原观察已结束，现显示最新观察。',
        'The previous observation ended. Showing the latest reading.'
      );
    }
    wantedId = null;
    wantedSymbol = null;
    latestOnly = false;
    pick(next);
    if (focusAfter) {
      updateSelectedLink();
      focusCard();
    }
  }
  function updateSelectedLink() {
    const url = new URL(location.href);
    if (!url.searchParams.has('asset') && !url.searchParams.has('signalId')) return;
    requestedAsset = current?.symbol || receipt?.symbol;
    if (requestedAsset) url.searchParams.set('asset', requestedAsset);
    else url.searchParams.delete('asset');
    if (mode === 'live' && current) url.searchParams.set('signalId', current.id);
    else url.searchParams.delete('signalId');
    window.history.replaceState(window.history.state, '', url);
  }
  function advance() {
    handoffNotice = '';
    wantedSymbol = null;
    wantedId = null;
    restoreReceipt = null;
    pick(queue().sort((a, b) => Number(b.direction === 'up') - Number(a.direction === 'up'))[0]);
    updateSelectedLink();
    focusCard();
  }
  async function trade(side) {
    const strategy = validPlan();
    if (busy || receipt || strategy?.side !== side) return;
    const spend = readDraft();
    if (!canSubmitLiteOrder(current, strategy, account?.balance, spend, blockedObservation?.id)) {
      if (side === 'buy') syncEstimate(true);
      return;
    }
    if (side === 'buy') save('amount', spend);
    request?.abort();
    request = null;
    loading = false;
    busy = true;
    formError = '';
    renderTrade();
    renderQueue();
    settings();
    const row = current;
    save('cursor.' + mode, { id: row.id, symbol: row.symbol });
    try {
      const position = account?.holdings.find((h) => h.symbol === row.symbol);
      const result =
        side === 'sell'
          ? await desk.sell({ row, expectedQuantity: position?.quantity, strategyId: strategy.id })
          : await desk.buy({ row, amount: spend.toFixed(2), strategyId: strategy.id });
      if (lifetime.signal.aborted) return;
      receipt = result.receipt;
      storeCursor();
      try {
        account = await desk.getAccount(mode);
        accountError = false;
      } catch {
        account = null;
        accountError = true;
      }
      if (lifetime.signal.aborted) return;
      el('announcement').textContent =
        side === 'sell' ? t('已记录卖出', 'Sell recorded') : t('已记录买入', 'Buy recorded');
    } catch (e) {
      formError = e.message;
      if (['POSITION_CHANGED', 'NO_POSITION', 'INSUFFICIENT_FUNDS'].includes(formError)) {
        try {
          account = await desk.getAccount(mode);
        } catch {
          account = null;
          accountError = true;
        }
      }
      if (['QUOTE_CHANGED', 'SIGNAL_CHANGED', 'EXPIRED'].includes(formError))
        blockedObservation = { id: row.id, code: formError };
    } finally {
      busy = false;
      if (lifetime.signal.aborted) return;
      paint();
      settings();
      if (receipt) {
        el('trade-panel').querySelector('.fill-state')?.classList.add('fill-arrive');
        el('trade-panel').querySelector('[data-cmd=next]')?.focus({ preventScroll: true });
      }
    }
  }
  function changeMode() {
    if (busy) return;
    el('settings-menu').open = false;
    el('settings-menu').querySelector('summary').focus({ preventScroll: true });
    request?.abort();
    request = null;
    closeDetails();
    mode = mode === 'practice' ? 'live' : 'practice';
    const url = new URL(location.href);
    if (mode === 'practice') url.searchParams.set('mode', 'practice');
    else url.searchParams.delete('mode');
    url.searchParams.delete('signalId');
    window.history.replaceState(window.history.state, '', url);
    blockedObservation = null;
    amountDraft = String(amount());
    handoffNotice = '';
    current = null;
    receipt = null;
    rows = [];
    failed = [];
    account = null;
    accountError = false;
    nextReadAt = 0;
    failedReads = 0;
    latestOnly = false;
    readCursor();
    renderQueue();
    renderAccount();
    void refresh();
  }
  function doAction(action, element) {
    if (busy) return;
    switch (action) {
      case 'mode':
        changeMode();
        break;
      case 'refresh':
        void refresh({ replace: true, focusAfter: true });
        break;
      case 'fresh':
        wantedSymbol = current?.symbol;
        latestOnly = true;
        void refresh({ replace: true, focusAfter: true });
        break;
      case 'cycle': {
        const available = queue();
        if (!available.length) return;
        const index = available.findIndex((r) => r.id === current?.id);
        const next = available[(index + 1) % available.length];
        if (next.id !== current?.id) {
          pick(next);
          updateSelectedLink();
          focusCard();
        }
        break;
      }
      case 'skip':
        if (current) {
          skippedRow = current;
          undoId = current.id;
          skipped = [...new Set([...skipped, undoId])].slice(-120);
          save('skips.' + mode, skipped);
          advance();
        }
        break;
      case 'undo': {
        const id = undoId;
        undoId = null;
        skipped = skipped.filter((k) => k !== id);
        save('skips.' + mode, skipped);
        const row =
          queue().find((r) => r.id === id) ||
          (skippedRow?.id === id &&
          skippedRow.validUntil > Date.now() &&
          symbols.includes(skippedRow.symbol) &&
          !account?.receipts.some((r) => r.signalId === id)
            ? skippedRow
            : null);
        skippedRow = null;
        if (row) {
          pick(row);
          updateSelectedLink();
          focusCard();
        } else {
          renderQueue();
          el('announcement').textContent = t('原观察已到期', 'The skipped observation expired');
        }
        break;
      }
      case 'next':
        advance();
        break;
      case 'preset':
        if (!el('order-amount')) return;
        draftTouched = true;
        amountDraft = element.value;
        el('order-amount').value = amountDraft;
        formError = '';
        syncEstimate(true, true);
        renderCards();
        break;
      case 'buy':
      case 'sell':
        void trade(action);
        break;
      case 'practice-exit': {
        const symbol = element?.dataset.symbol || receipt?.symbol;
        if (mode !== 'practice' || !account?.holdings?.some((h) => h.symbol === symbol)) return;
        const exercise = desk.practiceExit(symbol);
        el('account-menu').open = false;
        pick(exercise);
        updateSelectedLink();
        focusCard();
        break;
      }
      case 'evidence': {
        const panel = el('evidence');
        const trigger = view.querySelector('#lite-inspect [data-cmd=evidence]');
        const opening = panel.inert;
        if (!opening) trigger.focus({ preventScroll: true });
        panel.inert = !opening;
        trigger.setAttribute('aria-expanded', String(opening));
        if (opening) {
          renderEvidence();
          const observation = current;
          Promise.allSettled(panel.getAnimations().map((animation) => animation.finished)).then(() => {
            if (panel.isConnected && !panel.inert && current === observation) reveal(panel);
          });
        }
        break;
      }
    }
  }
  const crew = mountLiteCrew(el('crew'), { lang });
  el('deck-summary').addEventListener('click', (event) => {
    const item = event.target.closest('[data-lite-choice]');
    if (!item || item.disabled || busy) return;
    const row = queue().find((entry) => entry.id === item.dataset.signalId && entry.symbol === item.dataset.liteChoice);
    if (!row || (!receipt && current?.id === row.id)) return;
    pick(row);
    updateSelectedLink();
  }, { signal: lifetime.signal });
  document.addEventListener(
    'click',
    (event) => {
      for (const menu of view.querySelectorAll('.lite-menu[open]'))
        if (!menu.contains(event.target)) menu.open = false;
    },
    { signal: lifetime.signal }
  );
  view.addEventListener(
    'click',
    (event) => {
      const control = event.target.closest('[data-cmd]');
      if (control) doAction(control.dataset.cmd, control);
    },
    { signal: lifetime.signal }
  );
  view.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      for (const menu of view.querySelectorAll('.lite-menu[open]')) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    },
    { signal: lifetime.signal }
  );
  el('mode-button').onclick = changeMode;
  el('settings').addEventListener('change', (event) => {
    if (busy || !event.target.matches('input[type=checkbox]')) return;
    const chosen = [...el('settings').querySelectorAll('input:checked')].map((i) => i.value);
    if (!chosen.length) {
      event.target.checked = true;
      return;
    }
    symbols = chosen;
    save('symbols', symbols);
    if (current && !symbols.includes(current.symbol)) pick(null);
    void refresh();
  });
  el('trade-panel').addEventListener('input', (event) => {
    if (event.target !== el('order-amount')) return;
    draftTouched = true;
    amountDraft = event.target.value;
    if (['INSUFFICIENT_FUNDS', 'INVALID_AMOUNT'].includes(formError)) formError = '';
    syncEstimate(true, true);
    renderCards();
  });
  readCursor();
  settings();
  paint();
  void refresh();
  let expiredId = null;
  function poll() {
    if (document.hidden) return;
    const countdown = el('expires-countdown');
    if (current && countdown) countdown.textContent = expiryLabel();
    const expired = current && Date.now() >= current.validUntil ? current.id : null;
    if (expired && expired !== expiredId && !busy && !receipt) {
      renderQueue();
      if (el('order-amount') && (draftTouched || editingAmount())) {
        syncEstimate();
        const actions = el('trade-panel').querySelector('.dock-actions');
        actions.querySelector('[data-cmd=buy]')?.setAttribute('disabled', '');
        if (!actions.querySelector('[data-cmd=fresh]')) {
          actions.insertAdjacentHTML('beforeend', button('fresh', t('读取最新信号', 'Refresh signal'), 'secondary-btn'));
        }
        el('order-note').textContent = t('上一根 K 线已结束，已保留输入金额。', 'The candle closed. Your amount is saved in this ticket.');
      } else renderTrade();
      expiredId = expired;
    }
    if (!request && !busy && Date.now() >= nextReadAt) void refresh();
  }
  const polling = setInterval(poll, 1000);
  document.addEventListener('visibilitychange', poll, { signal: lifetime.signal });
  return {
    destroy() {
      lifetime.abort();
      clearInterval(polling);
      request?.abort();
      request = null;
      chat?.destroy();
      crew.destroy();
      for (const style of styles) style.remove();
      if (host.contains(view)) view.remove();
    }
  };
}
