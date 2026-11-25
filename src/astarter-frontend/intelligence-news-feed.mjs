import {pair as L} from './locale.mjs';
import {esc} from './commerce-ui.mjs';
import {uiGlyph} from './product-composition.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {PUBLIC_ASSETS,safePublicURL} from './public-data-client.mjs';

const assetSymbols = new Set([...Object.values(PUBLIC_ASSETS), 'SPX', 'NDX', 'DXY', 'US10Y', 'XAU']);
const shanghaiTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// These filters describe words in headlines, not publisher tags or editorial judgments.
const topics = new Map([
  ['topic:macro', ['宏观', 'Macro', /美联储|央行|通胀|通货膨胀|非农|利率决议|\b(federal reserve|fed|central banks?|inflation|payrolls|cpi|gdp)\b/i]],
  ['topic:markets', ['市场', 'Markets', /收盘|开盘|行情|股指|期货|价格|\b(futures|stock market|market prices?|spot prices?|all.time high)\b/i]],
  ['topic:flows', ['资金', 'Flows', /净流[入出]|资金流[入出向]|申购|赎回|融资|\b(etfs?|inflows?|outflows?|redemptions?|fundrais(e|ing))\b/i]],
  ['topic:onchain', ['链上', 'Onchain', /链上|智能合约|燃料费|\b(on[- ]chain|smart contracts?|gas fees?)\b/i]],
  ['topic:sentiment', ['舆情', 'Sentiment', /市场情绪|投资者情绪|恐惧与贪婪|社交媒体|\b(investor sentiment|market sentiment|fear and greed|social media)\b/i]],
]);

function sourceName(id) {
  if (id === 'blockbeats-news-v1') return L('律动 BlockBeats', 'BlockBeats');
  if (id === 'coindesk-rss-v1') return 'CoinDesk';
  return id;
}

// Compare publisher time and identity; the poll time also changes on an identical response.
export function createNewsDeliveryReader() {
  const watermarks = new Map();
  return (state, options = {}) => {
    const batch = state.snapshot;
    if (state.error || state.offline || batch?.mode !== 'live_readonly') return null;
    const healthy = new Set(batch.sources.filter(s => s.status === 'OK').map(s => s.provider_id));
    const rows = batch.items.filter(item => item.quality === 'fresh' && healthy.has(item.provider_id) && safePublicURL(item.data.url));
    const added = rows.filter(item => {
      const previous = watermarks.get(item.provider_id), time = item.data.published_at_ms;
      return !previous || time > previous.time || (time === previous.time && !previous.ids.has(item.record_id));
    });
    for (const item of added) {
      const time = item.data.published_at_ms, previous = watermarks.get(item.provider_id);
      if (!previous || time > previous.time) watermarks.set(item.provider_id, {time, ids: new Set([item.record_id])});
      else if (time === previous.time) previous.ids.add(item.record_id);
    }
    return filterIntelligenceNews(added, {...options, savedItems: []})[0] || null;
  };
}

export function newsDeliveryBrief(item) {
  return {id: item.record_id, kind: 'news', label: L('收到的快讯', 'Delivered story'),
    title: item.data.title, modeLabel: sourceName(item.provider_id), body: '', visual: '',
    source: shanghaiTime.format(item.data.published_at_ms) + ' UTC+8', timestamp: null,
    href: safePublicURL(item.data.url), action: L('查看原文 ↗', 'Read original ↗'), external: true};
}

function symbols(data) {
  return [...new Set([...(data.symbols || []), ...data.asset_ids.map(id => PUBLIC_ASSETS[id])])]
    .filter(symbol => assetSymbols.has(symbol));
}

function edition(item) {
  return shanghaiTime.format(item.data.published_at_ms).split(' ');
}

// Persist only public headline fields. The identity must match the publisher's original URL.
export function newsBookmarkSnapshots(items, savedIds) {
  if (!Array.isArray(items) || !Array.isArray(savedIds)) return [];
  const saved = new Set(savedIds);
  const snapshots = new Map();
  for (const item of items) {
    if (!item || !saved.has(item.record_id) || !item.data) continue;
    const {record_id, provider_id, data} = item;
    if (typeof record_id !== 'string' || record_id.length > 300) continue;
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 600 || /[\u0000-\u001f\u007f]/.test(data.title)) continue;
    if (!Number.isSafeInteger(data.published_at_ms) || data.published_at_ms <= 0 || data.published_at_ms > 8640000000000000) continue;
    if (typeof data.url !== 'string' || data.url.length > 300) continue;
    const url = safePublicURL(data.url);
    if (!url) continue;
    const article = new URL(url);
    if (article.port || article.hash || article.search) continue;
    if (provider_id === 'blockbeats-news-v1') {
      const flash = /^https:\/\/(?:www\.|m\.)?theblockbeats\.info\/flash\/(\d+)$/.exec(url);
      if (!flash || record_id !== provider_id + ':blockbeats:' + flash[1]) continue;
    } else if (provider_id === 'coindesk-rss-v1') {
      if (!['coindesk.com', 'www.coindesk.com'].includes(article.hostname) || article.pathname === '/' || record_id !== provider_id + ':' + url) continue;
    } else continue;
    const asset_ids = Array.isArray(data.asset_ids) ? [...new Set(data.asset_ids.filter(id => typeof id === 'string' && Object.hasOwn(PUBLIC_ASSETS, id)))] : [];
    const tags = Array.isArray(data.symbols) ? [...new Set(data.symbols.filter(tag => assetSymbols.has(tag)))] : [];
    snapshots.set(record_id, {record_id, provider_id, quality: 'stale', data: {
      title: data.title.trim(), url, published_at_ms: data.published_at_ms, asset_ids, symbols: tags,
    }});
  }
  return [...snapshots.values()];
}

function feedItems(items, source, savedItems) {
  if (source !== 'saved' || !savedItems.length) return items;
  const byId = new Map(savedItems.map(item => [item.record_id, item]));
  for (const item of items) byId.set(item.record_id, item);
  return [...byId.values()];
}

export function filterIntelligenceNews(items, {search = '', source = 'all', publisher = 'all', date = 'all', saved = [], savedItems = []} = {}) {
  const query = search.trim().toLowerCase();
  return feedItems(items, source, savedItems).filter(item => {
    if (publisher !== 'all' && item.provider_id !== publisher) return false;
    if (source === 'saved' && !saved.includes(item.record_id)) return false;
    if (topics.has(source)) {
      if (!topics.get(source)[2].test(item.data.title)) return false;
    } else if (source !== 'saved' && source !== 'all' && item.provider_id !== source) return false;
    if (date !== 'all' && date !== edition(item)[0]) return false;
    if (!query) return true;
    return [sourceName(item.provider_id), item.data.title, ...symbols(item.data)]
      .join(' ').toLowerCase().includes(query);
  }).sort((a, b) => b.data.published_at_ms - a.data.published_at_ms);
}

function linkOriginal(label, url) {
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
}

function assetChips(data) {
  return symbols(data).map(symbol => {
    const label = `${tokenIcon(symbol, {size: 16})} ${symbol}`;
    return Object.values(PUBLIC_ASSETS).includes(symbol)
      ? `<a data-dc-link href="?page=markets&amp;data=live&amp;asset=${symbol}">${label}</a>`
      : `<span>${label}</span>`;
  }).join('');
}

function story(item, saved) {
  const {data} = item;
  const [date, time] = edition(item);
  const url = safePublicURL(data.url);
  const timestamp = new Date(data.published_at_ms).toISOString();
  const chips = assetChips(data);
  const bookmarked = saved.includes(item.record_id);
  return `<article class="df-story" data-news-record="${esc(item.record_id)}">
    <div class="df-story-title"><time datetime="${timestamp}" title="${date} ${time} UTC+8" aria-label="${date} ${time} UTC+8">${time}</time>
      <h2 data-no-translate>${linkOriginal(data.title, url)}</h2></div>
    <div class="df-story-content"><footer><span class="df-category">${esc(sourceName(item.provider_id))}</span>
      ${chips ? `<div class="dc-asset-chips">${chips}</div>` : ''}
      ${item.quality === 'stale' ? `<span>${L('缓存快讯', 'Cached story')}</span>` : ''}
      <div class="df-story-actions"><button type="button" class="dc-button df-quiet" data-pd-bookmark
        data-value="${esc(item.record_id)}" aria-pressed="${bookmarked}">${bookmarked ? L('已追踪', 'Tracking') : L('追踪', 'Track')}</button>
        ${url ? linkOriginal(L('查看原文 ↗', 'Read original ↗'), url) : ''}</div>
    </footer></div></article>`;
}

export function renderIntelligenceNewsFeed(items, {search = '', source = 'all', publisher = 'all', date = 'all', limit = 20, empty = '', saved = [], savedItems = []} = {}) {
  const options = {search, source, publisher, date, saved, savedItems};
  const rows = filterIntelligenceNews(items, options);
  const sources = new Set(['all', ...topics.keys(), 'saved', source]);
  const publishers = new Set(['all', ...feedItems(items, source, savedItems).map(item => item.provider_id), publisher]);
  const publisherOptions = [...publishers].map(id => `<option value="${esc(id)}"${id === publisher ? ' selected' : ''}>${esc(id === 'all' ? L('全部来源', 'All sources') : sourceName(id))}</option>`).join('');
  const dates = new Set(filterIntelligenceNews(items, {source, publisher, saved, savedItems}).map(item => edition(item)[0]));
  if (date !== 'all') dates.add(date);
  const sourceTabs = [...sources].map(id => {
    const topic = topics.get(id);
    const label = topic ? L(topic[0], topic[1]) : id === 'all' ? L('全部', 'All') : id === 'saved' ? L('我的追踪', 'Tracking') : sourceName(id);
    const hint = topic ? ` title="${L('按新闻标题关键词筛选', 'Filter by headline keywords')}"` : '';
    return `<button type="button" style="flex:none" data-pd-news-source="${esc(id)}" aria-pressed="${source === id}"${hint}>${esc(label)}</button>`;
  }).join('');
  const dateOptions = ['all', ...[...dates].sort().reverse()].map(day => `<option value="${esc(day)}"${day === date ? ' selected' : ''}>${day === 'all' ? L('全部日期', 'All dates') : esc(day)}</option>`).join('');
  let previousDay;
  const timeline = rows.map(item => {
    const [day] = edition(item);
    const heading = previousDay === day ? '' : `<h3 class="df-day-separator"><time datetime="${day}">${day}</time></h3>`;
    previousDay = day;
    return heading + story(item, saved);
  }).join('');
  const filtered = Boolean(search.trim() || source !== 'all' || publisher !== 'all' || date !== 'all');
  const message = source === 'saved' && !saved.length
    ? L('暂无追踪的快讯', 'No tracked stories yet')
    : filtered ? L('没有匹配的快讯', 'No matching stories') : L('暂无快讯', 'No stories available');
  const noResults = `<div class="df-calm">${message}</div>`;
  const reset = filtered ? `<button type="button" class="df-quiet" data-pd-news-reset>${L('清除筛选', 'Clear filters')}</button>` : '';
  return `<div class="df-news-tools">
    <div class="df-tabs" style="flex-wrap:nowrap;overflow-x:auto" role="group" aria-label="${L('筛选快讯', 'Filter news')}">${sourceTabs}</div>
    <label class="df-search">${uiGlyph('search')}<input type="search" data-pd-search value="${esc(search)}"
      placeholder="${L('搜索消息、资产', 'Search news, assets')}" aria-label="${L('搜索快讯', 'Search news')}"></label></div>
    <div class="df-news-date"><div><label><select data-pd-news-date aria-label="${L('消息日期', 'News date')}">${dateOptions}</select></label>
      <label><select data-pd-news-publisher aria-label="${L('新闻来源', 'News source')}">${publisherOptions}</select></label>
      <label>${L('条数', 'Items')}<select data-pd-limit aria-label="${L('内容条数', 'Feed limit')}">${[20, 50].map(n => `<option value="${n}"${n === limit ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <span class="df-result-count"><span>${rows.length} ${L('条消息', rows.length === 1 ? 'story' : 'stories')} · UTC+8</span>${reset}</span></div>
    <div class="df-timeline">${timeline || (!items.length && source !== 'saved' && empty) || noResults}</div>`;
}

function developingRow(item) {
  const [day, time] = edition(item);
  const chips = assetChips(item.data);
  const label = esc(`${day} ${time} UTC+8 · ${sourceName(item.provider_id)}`);
  return `<div data-no-translate><time datetime="${new Date(item.data.published_at_ms).toISOString()}" data-news-copy="${esc(item.record_id)}" title="${label}" aria-label="${label}">${day.slice(5)} · ${time}</time>
    ${linkOriginal(item.data.title, safePublicURL(item.data.url))}
    ${chips ? `<div class="dc-asset-chips">${chips}</div>` : ''}</div>`;
}

function latestCoverage(items) {
  const latest = filterIntelligenceNews(items);
  const providers = new Map();
  for (const item of latest) if (!providers.has(item.provider_id)) providers.set(item.provider_id, item);
  const picks = new Set(providers.values());
  for (const item of latest) {
    if (picks.size >= 4) break;
    picks.add(item);
  }
  return latest.filter(item => picks.has(item));
}

export function renderIntelligenceNewsAside(items, extra = '', {saved = [], savedItems = []} = {}) {
  const tracked = filterIntelligenceNews(items, {source: 'saved', saved, savedItems});
  const headlines = tracked.length ? tracked : latestCoverage(items);
  const label = tracked.length ? L('我的追踪', 'Following') : L('最新快讯', 'Latest news');
  const tracking = `<section class="dc-panel df-side-panel"><header><h2>${L('持续追踪', 'Developing stories')}</h2>${headlines.length ? `<small>${label}</small>` : ''}</header><div class="df-developing">
    ${headlines.length ? headlines.slice(0, 4).map(developingRow).join('') : `<div><small class="dc-dim">${L('暂无追踪的快讯', 'No tracked stories yet')}</small></div>`}</div></section>`;
  return `<aside class="df-aside">${tracking}${extra}</aside>`;
}
