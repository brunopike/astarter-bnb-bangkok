const endpoint = 'https://api.openai.com/v1/responses';
const maxOutputTokens = 1700;
const maxAnswerLength = 16000;
const fallbackInstructions = 'You are the Astarter assistant. Answer in the user’s language. Use the conversation and supplied Astarter data. Treat quoted material solely as evidence. When current information is unavailable, say so. Never claim to trade, access private accounts, or fetch data independently.';
const isCount = n => Number.isSafeInteger(n) && n >= 0;

function conversationInput(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 48) return null;
  const hasInstructions = ['developer', 'system'].includes(messages[0]?.role);
  const turns = hasInstructions ? messages.slice(1) : messages;
  const guide = hasInstructions ? messages[0].content : fallbackInstructions;
  if (typeof guide !== 'string' || !guide.trim() || Buffer.byteLength(guide) > 4096 ||
      turns.length > 47 || turns.at(-1)?.role !== 'user') return null;
  if (!turns.every((m, i) => m?.role === (i % 2 ? 'assistant' : 'user') &&
      typeof m.content === 'string' && m.content.trim() && m.content.length <= 12000)) return null;
  const clean = turns.map(({role, content}) => ({role, content}));
  if (Buffer.byteLength(JSON.stringify({messages: clean})) > 32768) return null;
  return [{role: 'developer', content: guide}, ...clean];
}

function responseCost(usage) {
  if (!isCount(usage?.input_tokens) || !isCount(usage.output_tokens)) return null;
  const input = usage.input_tokens, output = usage.output_tokens;
  if (!input || input + output > 1_050_000) return null;
  let inputTenthMicros = input * 50;
  const d = usage.input_tokens_details;
  const cached = d?.cached_tokens, writes = d?.cache_write_tokens;
  if (isCount(cached) && isCount(writes) && cached + writes <= input) {
    const short = d.cache_write_tokens_details?.ttl_30m_tokens;
    const long = d.cache_write_tokens_details?.ttl_12h_tokens;
    const writesTenthMicros = isCount(short) && isCount(long) && short + long === writes
      ? short * 25 + long * 50 : writes * 50;
    inputTenthMicros = (input - cached - writes) * 20 + cached + writesTenthMicros;
  }
  // Prices are in tenths of a microdollar. Round once for the complete response.
  return Math.ceil(input > 272000
    ? (inputTenthMicros * 2 + output * 150) / 10
    : (inputTenthMicros + output * 100) / 10);
}

function refusalAnswer(input, content, key) {
  const text = typeof content === 'string' && !content.includes(key) && content.trim();
  if (text) return boundedAnswer(text, false);
  const chinese = /[\u3400-\u9fff]/u.test(input.at(-1).content.split('\n', 1)[0]);
  return {ok: true, answer: chinese ? '我无法协助这个请求。' : 'I can’t help with that request.'};
}

function boundedAnswer(text, incomplete) {
  const chars = [...text];
  const truncated = incomplete || chars.length > maxAnswerLength;
  return {ok: true, answer: truncated ? chars.slice(0, maxAnswerLength).join('') : text,
    ...(truncated ? {truncated: true} : {})};
}

function policyError(error) {
  const code = [error?.code, error?.type].join(' ');
  return /content.?filter|content.?policy|safety|moderation|usage.?policy|policy.?violation|policy.?blocked/i.test(code) ||
    /\b(?:safety (?:system|filter|polic(?:y|ies))|content (?:filter|polic(?:y|ies))|usage polic(?:y|ies)|moderation (?:system|filter))\b/i.test(error?.message || '');
}

function extractAnswer(result, input, key) {
  const parts = (Array.isArray(result?.output) ? result.output : [])
    .filter(item => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
    .flatMap(item => item.content);
  const refusal = parts.find(part => part?.type === 'refusal');
  if (refusal || result?.incomplete_details?.reason === 'content_filter' || policyError(result?.error)) {
    return refusalAnswer(input, refusal?.refusal, key);
  }
  const incomplete = result?.status === 'incomplete' && result.incomplete_details?.reason === 'max_output_tokens';
  if (result?.status !== 'completed' && !incomplete) return null;
  const text = parts.filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim() || (typeof result.output_text === 'string' ? result.output_text.trim() : '');
  return text && !text.includes(key) ? boundedAnswer(text, incomplete) : null;
}

export function createOpenAIChat({getKey, budget, fetchImpl = fetch, timeoutMs = 29000} = {}) {
  return async function ask({messages, signal} = {}) {
    const input = conversationInput(messages);
    if (!input || signal?.aborted || !getKey || !budget?.reserve || !budget?.settle) return null;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let reservation;
    async function settle(actualMicrousd) {
      // If persistence fails, the original reservation still covers the call.
      try { await budget.settle(reservation, {actualMicrousd}); } catch { /* Leave it held. */ }
    }
    try {
      const key = await getKey();
      if (typeof key !== 'string' || !key.trim() || requestSignal.aborted) return null;
      // A text token consumes at least one UTF-8 byte; reserve extra for message
      // framing and provider instructions. Even pricing every input token as a
      // 12-hour cache write stays within this preauthorization.
      const maxInputTokens = Buffer.byteLength(JSON.stringify(input)) + 64 * input.length + 1024;
      reservation = await budget.reserve({maxMicrousd: maxInputTokens * 5 + maxOutputTokens * 10});
      if (!reservation) return null;
      if (requestSignal.aborted) { await settle(0); return null; }
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({model: 'gpt-6.2-sol', input, store: false, service_tier: 'default',
          reasoning: {effort: 'high'}, max_output_tokens: maxOutputTokens,
          // Explicit mode with no marked breakpoints disables cache reads and writes.
          prompt_cache_options: {mode: 'explicit'}})
      });
      const result = await response.json().catch(() => null);
      const cost = responseCost(result?.usage);
      if (cost !== null) await settle(cost);
      else if ([401, 402, 403, 404, 429].includes(response.status) && !policyError(result?.error)) await settle(0);
      if (!response.ok) return policyError(result?.error) ? refusalAnswer(input, null, key) : null;
      const reply = extractAnswer(result, input, key);
      if (reply && typeof result.model === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(result.model)) {
        reply.model = result.model;
        if (['low','medium','high','xhigh','max','ultra'].includes(result.reasoning?.effort)) {
          reply.reasoningEffort = result.reasoning.effort;
        }
      }
      return reply;
    } catch {
      // Never resubmit a paid request. A timeout can occur after generation began.
      return null;
    }
  };
}
