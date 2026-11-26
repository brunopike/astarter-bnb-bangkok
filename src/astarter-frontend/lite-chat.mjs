const copy = (lang, zh, en) => (lang === 'en' ? en : zh);

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

// Only publish market readings to the assistant. The ticket and account stay local.
export function liteAssistantSource(signal, context, lang = 'zh', now = Date.now()) {
  const symbol = signal?.symbol || context?.symbol;
  if (!/^[A-Z0-9]{1,16}$/.test(symbol || '')) return null;
  const title = signal ? [symbol, signal.period, signal.mode === 'practice'
    ? copy(lang, '演练场景', 'Practice scenario')
    : signal.source].filter(Boolean).join(' · ') : symbol;
  if (!signal) return {
    id: 'public-market:lite:asset:' + symbol, kind: 'market', title, symbol,
    text: copy(lang, `当前选择的资产为 ${symbol}，没有可引用的策略卡。`,
      `The selected asset is ${symbol}. There is no active signal card.`)
  };
  const facts = liteSignalFacts(signal, 'why', lang, now);
  const expiry = liteSignalFacts(signal, 'expiry', lang, now);
  const practice = signal.mode === 'practice';
  return {
    id: 'public-market:lite:' + [signal.mode, symbol, signal.closedAt].join(':'),
    kind: 'market', title, symbol, asOf: signal.closedAt,
    status: signal.validUntil > now && !practice ? 'observed' : 'unavailable',
    href: practice ? '' : '?page=signals&data=live&asset=' + encodeURIComponent(symbol),
    text: [practice ? copy(lang, '演练卡使用本机样本数据。', 'This practice card uses local sample data.') : '',
      facts.citation, facts.text, expiry.text].filter(Boolean).join(' ')
  };
}

const oldHistoryKey = 'astarter.lite.signal-chat.v1';
const importedHistoryKey = 'astarter.lite.signal-chat.imported.v1';

export function legacyLiteThreads(raw, lang = 'zh') {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, 12).flatMap(thread => {
    if (typeof thread?.key !== 'string' || seen.has(thread.key)) return [];
    const match = /^(live|practice)\/(?:practice:(?:exit:)?)?([A-Z0-9]{1,16})(?::[a-zA-Z0-9:_-]+)?$/.exec(thread.key);
    if (!match && thread.key !== 'general') return [];
    seen.add(thread.key);
    const draft = typeof thread.draft === 'string' ? thread.draft : '';
    const turns = (Array.isArray(thread.turns) ? thread.turns : []).slice(-12).flatMap(turn => {
      if (typeof turn?.question !== 'string' || !turn.question.trim()) return [];
      const answered = ['facts','model'].includes(turn.kind) && typeof turn.text === 'string' && !!turn.text.trim();
      const source = liteAssistantSource(turn.reading, null, lang);
      return [{
        id: crypto.randomUUID(), question: turn.question, mode: 'ask', freeHelp: true,
        modelReply: answered ? {state:'complete', text:turn.text} : {state:'error', code:turn.code || 'MODEL_UNAVAILABLE'},
        sources: source ? [source] : []
      }];
    });
    if (!draft.trim() && !turns.length) return [];
    const symbol = match?.[2];
    const group = match?.[1] === 'practice' ? copy(lang, '练习', 'Practice') : match ? '' : copy(lang, '问答', 'Chat');
    return [{
      id: crypto.randomUUID(), legacyLiteKey: thread.key, mode: 'ask', asset: symbol,
      title: ['Lite', symbol, group, (turns[0]?.question || draft).slice(0, 30)].filter(Boolean).join(' · '),
      draft, turns
    }];
  });
}

function oldLocalHistory(lang) {
  try {
    if (localStorage.getItem(importedHistoryKey)) return [];
    return legacyLiteThreads(JSON.parse(localStorage.getItem(oldHistoryKey) || '[]'), lang);
  } catch { return []; }
}

export function mountLiteChat(host, { lang = 'zh', mountAssistant }) {
  let signal = null;
  let context = null;
  const assistant = mountAssistant(host, () => liteAssistantSource(signal, context, lang), oldLocalHistory(lang));
  if (assistant.importedHistory) {
    try { localStorage.setItem(importedHistoryKey, '1'); } catch {}
  }
  return {
    ...assistant,
    setSignal(next, selected = next) {
      signal = next;
      context = selected;
      assistant.updateContext();
    }
  };
}
