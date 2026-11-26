import { uiGlyph } from './product-composition.mjs';

const STORAGE_KEY = 'astarter.lite.signal-chat.v1';
const SCOPE_KEY = 'astarter.lite.chat-scope';
const MAX_THREADS = 12;
const MAX_TURNS = 12;
const MAX_QUESTION = 1200;
const inFlight = new Set();
const updates = new EventTarget();
const sessions = new Map();

const copy = (lang, zh, en) => (lang === 'en' ? en : zh);
const threadKey = (context) => context ? context.mode + '/' + context.symbol : 'general';

function restoreThread(key, signal) {
  if (sessions.has(key)) return sessions.get(key);
  let saved;
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    saved = data.find((item) => item?.key === key) ||
      (signal && data.find((item) => item?.key === signal.mode + '/' + signal.id));
  } catch {}
  const thread = {
    key,
    draft: typeof saved?.draft === 'string' ? saved.draft.slice(0, MAX_QUESTION) : '',
    turns: (Array.isArray(saved?.turns) ? saved.turns : [])
      .slice(-MAX_TURNS)
      .filter(
        (turn) =>
          turn &&
          typeof turn.id === 'string' &&
          typeof turn.question === 'string' &&
          typeof turn.text === 'string' &&
          ['facts', 'model', 'pending', 'error'].includes(turn.kind)
      )
      .map((turn) => (turn.kind === 'pending' ? { ...turn, kind: 'error', code: 'INTERRUPTED' } : turn))
  };
  for (const oldKey of sessions.keys()) {
    if (sessions.size < MAX_THREADS) break;
    if (!inFlight.has(oldKey)) sessions.delete(oldKey);
  }
  sessions.set(key, thread);
  return thread;
}

function persist(thread) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const rest = Array.isArray(saved) ? saved.filter((item) => item?.key !== thread.key) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify([thread, ...rest].slice(0, MAX_THREADS)));
  } catch {}
}

const time = (ms, lang) =>
  Number.isSafeInteger(ms) && ms > 0
    ? new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
        hour12: false
      }) + ' UTC'
    : '—';
const number = (value, lang) =>
  Number.isFinite(value)
    ? value.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { maximumSignificantDigits: 6 })
    : '—';
const promptText = (lang, type) =>
  type === 'why'
    ? copy(lang, '为什么出现这条信号？', 'Why did this signal appear?')
    : copy(lang, '这条信号何时失效？', 'When does this signal expire?');

export function liteSignalFacts(signal, type, lang = 'zh', now = Date.now()) {
  const t = (zh, en) => copy(lang, zh, en);
  const elapsed = Number.isFinite(signal.validUntil) && now >= signal.validUntil;
  const practice = signal.mode === 'practice';
  const source = practice ? t('本机演练数据', 'Local practice data') : signal.source;
  const stamp = time(signal.closedAt, lang);
  const citation = [source, stamp].filter(Boolean).join(' · ');
  if (type === 'expiry') {
    const until = time(signal.validUntil, lang);
    if (practice) {
      const text = elapsed
        ? t(
            `这个演练场景已于 ${until} 结束。请按最新的演练卡重新判断。`,
            `This practice scenario ended at ${until}. Review the new practice card before proceeding.`
          )
        : t(
            `这张演练卡可用到 ${until}。到期后按新场景重新核验，实际市场的下一根 K 线不会改变这组演练数据。`,
            `This practice card is valid until ${until}. Its sample readings stay fixed for the scenario. When it expires, review the next practice card.`
          );
      return { text, citation };
    }
    const text = elapsed
      ? t(
          `这条观察已于 ${until} 失效。原信号的依据只适用于当时，需要新的已收盘 K 线才能重新评估。`,
          `This observation expired at ${until}. Its readings apply to their own close. A new closed candle is needed to reassess it.`
        )
      : t(
          `这条观察的有效期到 ${until}。下一次收盘会重新检查价格、动量和 RSI，届时方向可能改变。`,
          `This observation is valid until ${until}. Price, momentum and RSI are checked again at the next close, so its direction can change.`
        );
    return { text, citation };
  }
  const trend =
    signal.direction === 'up'
      ? t('上行', 'upward')
      : signal.direction === 'down'
        ? t('下行', 'downward')
        : t('中性', 'neutral');
  const period = signal.period || '1m';
  const metrics = t(
    `收盘价 ${number(signal.price, lang)} ${signal.unit}，20 周期均价（EMA）${number(signal.ema20, lang)}。近 5 根涨跌幅 ${number(signal.momentumPct, lang)}%，RSI14 为 ${number(signal.rsi14, lang)}。`,
    `It closed at ${number(signal.price, lang)} ${signal.unit}, with a 20-period EMA of ${number(signal.ema20, lang)}. The five-bar change was ${number(signal.momentumPct, lang)}% and RSI14 was ${number(signal.rsi14, lang)}.`
  );
  const reason =
    signal.direction === 'neutral'
      ? t('三个条件没有同时指向同一方向。', 'The three indicators did not align.')
      : signal.direction === 'up'
        ? t(
            '收盘在均线上方、动量为正、RSI 高于 50，三项同时满足。',
            'The close was above its EMA, momentum was positive and RSI was above 50.'
          )
        : t(
            '收盘在均线下方、动量为负、RSI 低于 50，三项同时满足。',
            'The close was below its EMA, momentum was negative and RSI was below 50.'
          );
  const intro = t(
    `${signal.symbol} 在这根 ${period} K 线收盘时被判为${trend}。`,
    `The ${period} reading for ${signal.symbol} was ${trend} at this candle close.`
  );
  return { text: [intro, reason, metrics].join(lang === 'en' ? ' ' : ''), citation };
}

function evidence(signal, lang) {
  const facts = liteSignalFacts(signal, 'why', lang);
  const expiry = liteSignalFacts(signal, 'expiry', lang);
  const historical = signal.mode === 'practice' || signal.validUntil <= Date.now();
  const title = [
    signal.symbol,
    signal.mode === 'practice' ? copy(lang, '演练场景', 'Practice scenario') : signal.source,
    signal.period
  ].join(' · ');
  return {
    kind: 'signal',
    symbol: signal.symbol,
    status: historical ? 'unavailable' : 'observed',
    asOf: signal.closedAt,
    href: '?page=signals&data=live&asset=' + encodeURIComponent(signal.symbol),
    title,
    text:
      (signal.mode === 'practice'
        ? copy(
            lang,
            '以下读数来自本机演练场景，不代表市场行情。',
            'These readings are from a practice scenario and do not represent the market. '
          )
        : '') +
      facts.text +
      ' ' +
      expiry.text
  };
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
function button(cls, label, click) {
  const node = el('button', cls, label);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

function feedback(code, lang) {
  if (code === 'INTERRUPTED')
    return copy(lang, '页面在回答完成前关闭了。', 'The page closed before the reply finished.');
  if (code === 'RATE_LIMITED')
    return copy(lang, 'AI 请求较多，请稍后重试。', 'The AI service is busy. Try again shortly.');
  if (code === 'MODEL_TIMEOUT')
    return copy(lang, 'AI 回答超时，可重新提问。', 'The AI request timed out. You can retry.');
  return copy(lang, 'AI 服务暂时无法回答，请重试。', 'The AI service is unavailable. Please retry.');
}

function signalReading(signal) {
  if (!signal) return null;
  const { symbol, mode, source, period, unit, direction, price, ema20, momentumPct, rsi14, closedAt, validUntil } = signal;
  return { symbol, mode, source, period, unit, direction, price, ema20, momentumPct, rsi14, closedAt, validUntil };
}

export async function liteChatMessages(history, signal, lang, asset = '') {
  const { assistantConversationMessages } = await import('./assistant-chat-client.mjs');
  const turns = history
    .filter((item) => ['model', 'facts', 'pending'].includes(item.kind))
    .map((item) => {
      let question = item.question;
      const reading = item.reading ?? (item.kind === 'pending' ? signal : null);
      const cited = reading && evidence(reading, lang);
      if (reading?.mode === 'practice' && item.kind === 'pending') {
        question += '\n\n' + cited.text;
      } else if (!reading && asset && item.kind === 'pending') {
        question += '\n\n' + copy(lang, '当前标的 ', 'Selected asset: ') + asset;
      }
      return {
        id: item.id,
        mode: 'ask',
        question,
        ...(item.kind !== 'pending' ? { modelReply: { state: 'complete', text: item.text } } : {}),
        evidence: cited && reading.mode !== 'practice' ? [cited] : []
      };
    });
  return assistantConversationMessages(turns, turns.at(-1));
}

async function askModel(thread, signal, turn, lang, asset) {
  inFlight.add(thread.key);
  try {
    const { requestAssistantAnswer } = await import('./assistant-chat-client.mjs');
    const result = await requestAssistantAnswer(await liteChatMessages(thread.turns, signal, lang, asset));
    turn.text = result.text;
    turn.kind = 'model';
  } catch (error) {
    turn.kind = 'error';
    turn.code = error?.code || 'MODEL_UNAVAILABLE';
  } finally {
    inFlight.delete(thread.key);
    persist(thread);
    updates.dispatchEvent(new CustomEvent('reply', { detail: thread.key }));
  }
}

export function mountLiteChat(host, { signal = null, lang = 'zh' } = {}) {
  const t = (zh, en) => copy(lang, zh, en);
  let context = signal;
  let general = false;
  try { general = localStorage.getItem(SCOPE_KEY) === 'general'; } catch {}
  let thread = restoreThread(threadKey(general ? null : context), general ? null : signal);
  const panel = el('section', 'lite-chat');
  panel.setAttribute('aria-labelledby', 'lite-chat-title');
  const header = el('header', 'lite-chat-head');
  const heading = el('h2', 'lite-chat-title', t('AI 助手', 'AI assistant'));
  heading.id = 'lite-chat-title';
  heading.insertAdjacentHTML('afterbegin', uiGlyph('chat'));
  const scopes = el('div', 'lite-chat-scopes');
  scopes.setAttribute('role', 'group');
  scopes.setAttribute('aria-label', t('对话范围', 'Chat context'));
  const assetButton = button('', '', () => switchScope(false));
  const generalButton = button('', t('通用对话', 'General'), () => switchScope(true));
  scopes.append(assetButton, generalButton);
  header.append(heading, scopes);
  const log = el('div', 'lite-chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', t('对话记录', 'Conversation'));
  const prompts = el('div', 'lite-chat-prompts');
  for (const type of ['why', 'expiry'])
    prompts.append(button('', promptText(lang, type), () => submit(promptText(lang, type), type)));
  const form = el('form', 'lite-chat-ask');
  const input = el('input', 'lite-chat-input');
  let composing = false;
  input.type = 'text';
  input.maxLength = MAX_QUESTION;
  input.autocomplete = 'off';
  input.enterKeyHint = 'send';
  input.setAttribute('aria-label', t('向 AI 提问', 'Ask the assistant'));
  const send = el('button', 'lite-chat-send');
  send.innerHTML = uiGlyph('send');
  send.setAttribute('aria-label', t('发送', 'Send'));
  send.type = 'submit';
  form.append(input, send);
  panel.append(header, log, form, prompts);
  host.replaceChildren(panel);
  let renderedKey;
  function changeThread() {
    const key = threadKey(general ? null : context);
    if (key !== thread.key) {
      persist(thread);
      thread = restoreThread(key, general ? null : signal);
      input.value = thread.draft;
    }
    render();
  }
  function switchScope(next) {
    general = next;
    try { localStorage.setItem(SCOPE_KEY, next ? 'general' : 'asset'); } catch {}
    changeThread();
  }
  function syncSend() {
    send.disabled = inFlight.has(thread.key) || !input.value.trim();
  }
  function render(followLastTurn = false) {
    const previousTop = log.scrollTop;
    const atEnd = log.scrollHeight - log.clientHeight - previousTop < 4;
    const hasSignal = !general && Boolean(signal);
    scopes.hidden = !context;
    assetButton.textContent = context ? context.symbol + ' / USDT' : '';
    assetButton.setAttribute('aria-pressed', String(!general));
    generalButton.setAttribute('aria-pressed', String(general));
    input.placeholder = !general && context
      ? t('问问 ' + context.symbol + ' 的策略…', 'Ask about the ' + context.symbol + ' strategy…')
      : t('问 AI 一个问题…', 'Ask a question…');
    prompts.hidden = !hasSignal;
    log.hidden = !thread.turns.length;
    log.replaceChildren();
    for (const turn of thread.turns) {
      const item = el('div', 'lite-chat-message');
      item.append(el('p', 'lite-chat-question', turn.question));
      if (turn.kind === 'error') {
        item.append(el('p', 'lite-chat-error', feedback(turn.code, lang)));
        if (turn === thread.turns.at(-1) && !inFlight.has(thread.key)) {
          item.append(
            button('lite-chat-retry', t('重试', 'Retry'), () => {
              turn.kind = 'pending';
              persist(thread);
              void askModel(thread, general ? null : signal, turn, lang, general ? '' : context?.symbol);
              render();
            })
          );
        }
      } else if (turn.kind === 'pending') {
        item.append(el('p', 'lite-chat-status', t('正在回答…', 'Thinking…')));
      } else {
        item.append(el('p', 'lite-chat-answer', turn.text));
        if (turn.reading) {
          const { citation } = liteSignalFacts(turn.reading, 'why', lang);
          item.append(el('small', 'lite-chat-source', citation));
        }
      }
      log.append(item);
    }
    for (const option of prompts.children) option.disabled = inFlight.has(thread.key);
    syncSend();
    log.scrollTop = followLastTurn || atEnd || renderedKey !== thread.key ? log.scrollHeight : previousTop;
    renderedKey = thread.key;
  }
  function submit(question, type) {
    if (!question || inFlight.has(thread.key)) return;
    const reading = general ? null : signalReading(signal);
    const normalized = question.trim().replace(/[?？。!.！]+$/u, '').toLowerCase();
    const localType = reading && (type ||
      (/^(为什么(出现这条信号|触发|会触发|出现)?|why( did (this|the signal) (appear|trigger))?)$/u.test(normalized)
        ? 'why'
        : /^(这条信号何时失效|何时失效|什么时候(失效|过期)|when does (this|this signal|it) expire)$/u.test(normalized)
          ? 'expiry' : ''));
    const turn = {
      id: Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join('-'),
      question, kind: localType ? 'facts' : 'pending', text: '', reading
    };
    if (localType) turn.text = liteSignalFacts(reading, localType, lang).text;
    thread.turns = [...thread.turns.slice(1 - MAX_TURNS), turn];
    if (!type) thread.draft = input.value = '';
    persist(thread);
    if (!localType) void askModel(thread, reading, turn, lang, general ? '' : context?.symbol);
    render(true);
  }
  function notify(event) {
    if (event.detail === thread.key) render();
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!composing) submit(input.value.trim());
  });
  input.addEventListener('input', () => {
    thread.draft = input.value;
    syncSend();
  });
  input.addEventListener('change', () => persist(thread));
  function saveDraft() { persist(thread); }
  window.addEventListener('pagehide', saveDraft);
  updates.addEventListener('reply', notify);
  input.value = thread.draft;
  render();
  return {
    setSignal(next, assetContext = next) {
      if (signal?.id === next?.id && threadKey(context) === threadKey(assetContext)) return;
      if (!context && assetContext && (input.value || inFlight.has(thread.key) || document.activeElement === input)) general = true;
      signal = next;
      context = assetContext;
      changeThread();
    },
    isInteracting() {
      return !general && !!context && (panel.contains(document.activeElement) || inFlight.has(thread.key));
    },
    focus() { input.focus({ preventScroll: true }); },
    destroy() {
      persist(thread);
      updates.removeEventListener('reply', notify);
      window.removeEventListener('pagehide', saveDraft);
      panel.remove();
    }
  };
}
