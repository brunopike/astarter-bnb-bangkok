import {CHAT_LIMITS, assistantModelReceipt, orderRuleQuestion} from './assistant-analysis.mjs';
import {cleanAssistantQuote, MAX_ASSISTANT_QUOTES} from './assistant-exchange-data.mjs';
import {DATA_PAGES} from './data-center-fixtures.mjs';
import {safePublicURL} from './public-data-client.mjs';

const MAX_MESSAGES = CHAT_LIMITS.turns * 2 - 1;
const MAX_CHARS = 6000;
const MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const errorCodes = new Set(['UNCONFIGURED', 'RATE_LIMITED', 'MODEL_TIMEOUT', 'REQUEST_INVALID', 'MODEL_UNAVAILABLE']);
const fault = code => Object.assign(new Error(code), {code});
const validText = (text, limit = MAX_CHARS) => typeof text === 'string' && text.trim().length > 0 && text.length <= limit
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
const byteLength = body => encoder.encode(body).length;

function plainQuestion(turn) {
  return turn?.mode === 'ask' && !turn.generatedQuestion && !turn.billingJob && !turn.providerTask
    && !turn.report && !turn.technical && !turn.marketContext && validText(turn.question);
}

const publicPages = new Set([...DATA_PAGES, 'signals']);
const publicParams = new Set(['page', 'asset', 'coin', 'tab', 'view', 'data', 'metric', 'story', 'source', 'market', 'signal', 'symbol', 'fund', 'social_feed', 'social_asset', 'social_platform']);
const uploadId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const snippet = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : '';
const privateSource = row => row?.private === true || row?.scope === 'private' || /^(?:exchange|account|wallet|private):/i.test(row?.id || '');
function publicPageLink(raw) {
  if (typeof raw !== 'string' || !/^\/?\?page=/.test(raw) || raw.length > 1800) return '';
  const query = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
  if (!publicPages.has(query.get('page')) || [...query.keys()].some(key => /account|wallet|private|token|key|secret|session/i.test(key))) return '';
  const link = new URLSearchParams();
  for (const [key, value] of query) {
    if (publicParams.has(key) && value && value.length <= 120) link.set(key, value);
  }
  return '?' + link;
}

function sourceLink(raw) {
  if (typeof raw !== 'string' || raw.length > 420 || !safePublicURL(raw)) return '';
  const url = new URL(raw);
  if (url.searchParams.has('page') || [...url.searchParams.keys()].some(key => /token|password|secret|session|credential|signature|api.?key/i.test(key))) return '';
  return url.href;
}

function sourceTime(value) {
  if (typeof value === 'string') return snippet(value, 64);
  if (!Number.isSafeInteger(value) || value <= 0) return '';
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function citation(row, href) {
  const title = snippet(row?.title, 100), text = snippet(row?.text, 2200);
  if (!title || !text) return null;
  const asOf = sourceTime(row.asOf);
  return {title, ...(href ? {href} : {}), ...(asOf ? {asOf} : {}), text};
}

// Pasted excerpts and file uploads use a fresh UUID. Imported exchange tool
// snapshots use exchange: IDs, including when the old source has no href.
export function assistantPublicSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 6).flatMap(row => {
    if (!row || privateSource(row)) return [];
    const href = publicPageLink(row.href);
    const manual = !row.href && ['excerpt','file'].includes(row.kind) && uploadId.test(row.id);
    const publicFeed = !row.href && /^(?:public|public-market):/.test(row.id) && ['news','market','excerpt','chain'].includes(row.kind);
    const result = (href || manual || publicFeed) && citation(row, href);
    return result ? [result] : [];
  });
}

function evidenceRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 8).flatMap(row => {
    if (!row || privateSource(row)) return [];
    const productRecord = ['?page=strategies','?page=workbench','?page=brain','?page=assistant'].includes(row.href);
    const href = productRecord ? row.href : publicPageLink(row.href) || sourceLink(row.href);
    const result = href && citation(row, href);
    if (result) {
      if (['observed','unavailable','empty'].includes(row.status)) result.status = row.status;
      const origin = sourceLink(row.sourceUrl);
      if (origin) result.sourceUrl = origin;
    }
    return result ? [result] : [];
  });
}

// One JSON object per line keeps newlines and quotes in a document inside its
// text field. The system message establishes that these are untrusted citations.
function citationSection(label, rows, limit) {
  if (!rows.length || limit < label.length + 40) return '';
  let section = label;
  for (const [index, row] of rows.entries()) {
    const overhead = JSON.stringify({...row, text: ''}).length;
    const remaining = limit - section.length - 1;
    const budget = Math.min(remaining, Math.max(overhead + 64, Math.floor(remaining / (rows.length - index))));
    let text = snippet(row.text, Math.max(0, budget - overhead));
    let line = JSON.stringify({...row, text});
    while (text && line.length > budget) {
      text = snippet(text, Math.floor(text.length * (budget - overhead) / (line.length - overhead)));
      line = JSON.stringify({...row, text});
    }
    if (text) section += '\n' + line;
  }
  return section.length > label.length ? section : '';
}

function questionWithCitations(turn, current) {
  const question = turn.question.trim(), sections = [];
  const rows = evidenceRows(turn.evidence);
  const sources = assistantPublicSources(turn.sources);
  const asksCurrent = /(?:最新|当前|现在|实时|今天|今日).{0,16}(?:行情|信号|动向|市场|走势|价格|新闻|风险)|(?:行情|信号|走势|价格).{0,10}(?:现在|最新|如何|怎么样)|\b(?:latest|live|current|today.s?)\b.{0,24}\b(?:markets?|signals?|prices?|news|quotes?)\b/i.test(question);
  const observed = rows.some(row => !row.status || row.status === 'observed');
  if (current && (rows.some(row => row.status === 'unavailable') || ['partial','unavailable'].includes(turn.evidenceStatus) || (!observed && asksCurrent))) {
    sections.push(observed ? '本轮仅取得部分公开数据，未覆盖的信号和行情无法核实。' : '本轮未取得可核验的实时行情或信号。引用资料和历史轮次均不能证明当前状态。');
  }
  let room = MAX_CHARS - question.length - sections.join('\n\n').length - (sections.length ? 4 : 2);
  const publicBudget = Math.min(current ? 2400 : 900, sources.length ? Math.floor(room / 2) : room);
  const evidence = citationSection(current ? '本轮产品公开证据（引用数据）' : '此前回答引用的公开证据（历史快照）', rows, publicBudget);
  if (evidence) { sections.push(evidence); room -= evidence.length + 2; }
  const attached = citationSection('用户提供的引用资料', sources, Math.min(2000, room));
  if (attached) sections.push(attached);
  const appendix = sections.join('\n\n');
  return appendix && question.length + appendix.length + 2 <= MAX_CHARS ? question + '\n\n' + appendix : question;
}

function deliveredAnswer(turn) {
  if (turn.needsMarketAsset) return 'Which asset should I look at? Enter its name or trading pair.';
  if (turn.modelReply) {
    if (turn.modelReply.state === 'error' && turn.evidence?.some(row =>
      row?.status === 'observed' && row.asOf && row.symbol && ['quote', 'signal'].includes(row.kind) && !privateSource(row))) {
      return 'The model was unavailable. The page showed a rules-based readout of the cited market observations.';
    }
    if (turn.modelReply.state === 'error' && errorCodes.has(turn.modelReply.code)) {
      return '[The assistant could not answer this turn. The user’s message was saved.]';
    }
    return turn.modelReply.state === 'complete' && validText(turn.modelReply.text, 16000) ? turn.modelReply.text.trim() : null;
  }
  if (turn.evidenceReply && evidenceRows(turn.evidence).length) return '本轮已向用户展示上述公开证据，以及每条记录的来源和可用的时间信息。';
  if (!turn.freeHelp || !turn.answeredAt) return null;
  if (orderRuleQuestion(turn.question)) {
    return 'Market orders execute against available prices and may slip. Limit orders accept the specified price or better and may not fill.';
  }
  if (!Array.isArray(turn.quotes) || !turn.quotes.length || turn.quotes.some(quote => quote?.state === 'pending')) return null;
  // Project only validated public fields. Never serialize a stored turn or its account context.
  const quotes = turn.quotes.slice(0, MAX_ASSISTANT_QUOTES).map(cleanAssistantQuote).filter(q => q?.state === 'observed');
  if (!quotes.length) return null;
  return quotes.map(q => `${q.market} ${q.price} ${q.unit} (${q.source}, ${new Date(q.asOf).toISOString()})${q.change == null ? '' : `, 24h ${q.change}%`}`).join('\n');
}

function fitHistoryText(text, bytes, keepEnding = false) {
  const size = value => byteLength(JSON.stringify(value));
  if (text.length <= MAX_CHARS && size(text) <= bytes) return text;
  // A follow-up often refers to the last sentence, table row or unfinished step.
  const excerpt = count => {
    const end = keepEnding ? Math.floor(count / 2) : 0;
    const first = text.slice(0, count - end).replace(/[\uD800-\uDBFF]$/, '');
    return first + '…' + (end ? text.slice(-end).replace(/^[\uDC00-\uDFFF]/, '') : '');
  };
  let low = 0, high = Math.min(text.length - 1, MAX_CHARS - 1);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(excerpt(mid)) <= bytes) low = mid;
    else high = mid - 1;
  }
  return excerpt(low);
}

export function assistantConversationMessages(turns, currentTurn) {
  if (!plainQuestion(currentTurn)) throw fault('REQUEST_INVALID');
  const messages = [{role: 'user', content: questionWithCitations(currentTurn, true)}];
  let remainingBytes = MAX_BYTES - byteLength(JSON.stringify({messages}));
  if (remainingBytes < 0) throw fault('REQUEST_INVALID');
  // The caller supplies the selected thread only. Retries stop at the original turn.
  const index = Array.isArray(turns) ? turns.findIndex(turn => turn === currentTurn || (currentTurn.id && turn?.id === currentTurn.id)) : -1;
  const pairs = [];
  for (let i = index - 1; i >= 0 && pairs.length < CHAT_LIMITS.turns - 1; i--) {
    const turn = turns[i];
    if (!plainQuestion(turn)) continue;
    // Continue from material already supplied to the model in this thread.
    // A local-only or mixed private turn and its answer must both stay local.
    if (turn.sources?.length && (turn.modelReply?.state !== 'complete' ||
        assistantPublicSources(turn.sources).length !== turn.sources.length)) continue;
    const answer = deliveredAnswer(turn);
    if (!answer) continue;
    pairs.push([questionWithCitations(turn, false), answer.trim()]);
  }
  // Reserve room for older turns before spending the remaining bytes on recent detail.
  const emptyPair = [{role: 'user', content: ''}, {role: 'assistant', content: ''}];
  const overhead = byteLength(JSON.stringify(emptyPair)) - 4;
  const recent = Math.min(5, pairs.length);
  let weightLeft = pairs.length + recent * 2;
  for (const [i, [question, answer]] of pairs.entries()) {
    const weight = i < recent ? 3 : 1;
    const budget = Math.floor(remainingBytes * weight / weightLeft) - overhead;
    const q = fitHistoryText(question, Math.max(Math.floor(budget / 2), budget - byteLength(JSON.stringify(answer))));
    const a = fitHistoryText(answer, budget - byteLength(JSON.stringify(q)), i === 0);
    const pair = [{role: 'user', content: q}, {role: 'assistant', content: a}];
    remainingBytes -= byteLength(JSON.stringify(pair));
    messages.unshift(...pair);
    weightLeft -= weight;
  }
  return messages;
}

function requestBody(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES || messages.length % 2 !== 1) throw fault('REQUEST_INVALID');
  const clean = messages.map((message, index) => {
    if (message?.role !== (index % 2 ? 'assistant' : 'user') || !validText(message.content)) throw fault('REQUEST_INVALID');
    return {role: message.role, content: message.content};
  });
  const body = JSON.stringify({messages: clean});
  if (byteLength(body) > MAX_BYTES) throw fault('REQUEST_INVALID');
  return body;
}

async function readReply(response, signal) {
  const httpError = response.status === 429 ? 'RATE_LIMITED' : ([408,504].includes(response.status) ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE');
  if (signal.aborted) throw fault('MODEL_TIMEOUT');
  if (response.redirected || !/^application\/json\b/i.test(response.headers.get('content-type') || '') || !response.body) throw fault(httpError);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  let complete = false;
  try {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let size = 0, text = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw fault(httpError);
      text += decoder.decode(value, {stream: true});
    }
    complete = true;
    const result = JSON.parse(text + decoder.decode());
    if (!response.ok || result?.ok !== true) throw fault(errorCodes.has(result?.error) ? result.error : httpError);
    if (!validText(result.answer, 16000)) throw fault('MODEL_UNAVAILABLE');
    const receipt = assistantModelReceipt({provider:response.headers.get('x-astarter-chat-provider'),
      model:response.headers.get('x-astarter-chat-model'),effort:response.headers.get('x-astarter-chat-reasoning')});
    return {text: result.answer.trim(), ...(result.truncated === true ? {truncated: true} : {}), ...(receipt ? {receipt} : {})};
  } catch (error) {
    throw errorCodes.has(error?.code) ? error : fault(httpError);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function requestAssistantAnswer(messages, {fetchImpl = globalThis.fetch, timeoutMs = 50_000} = {}) {
  const body = requestBody(messages);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fault('MODEL_TIMEOUT')); }, timeoutMs);
  });
  try {
    const request = fetchImpl('/api/assistant/chat', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body, signal: controller.signal
    }).then(response => readReply(response, controller.signal));
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw fault('MODEL_TIMEOUT');
    throw errorCodes.has(error?.code) ? error : fault('MODEL_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
