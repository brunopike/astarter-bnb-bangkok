import {newsBookmarkSnapshots} from './intelligence-news-feed.mjs';
import {createPublicDataClient, currentPublicEnvelope} from './public-data-client.mjs';

const pageHref = '?page=intelligence&data=live';
const cache = new WeakMap();

// Invoked only when the companion opens a news card. "Another one" shares
// this short-lived read; each selection still checks publisher expiry.
export async function readCompanionNews({cursor = 0, locale = 'zh', fetchImpl = globalThis.fetch, now = Date.now, signal} = {}) {
  signal?.throwIfAborted();
  const zh = String(locale).startsWith('zh');
  const label = zh ? '新闻快讯' : 'News brief';
  const status = (reason, title) => ({kind: 'status', reason, label, title, body: '', visual: '',
    modeLabel: '', source: '', timestamp: null, href: pageHref, pageHref, external: false,
    action: zh ? '查看快讯' : 'View news', askSource: null});
  const unavailable = () => status('unavailable', zh ? '快讯暂不可用' : 'News temporarily unavailable');
  const stale = () => status('stale', zh ? '快讯已过期' : 'Latest headlines have expired');
  const at = now();
  let entry = cache.get(fetchImpl);
  if (!entry || at < entry.readAt || at - entry.readAt >= 60000) {
    const client = createPublicDataClient({fetchImpl, now, timeoutMs: 6000});
    const cancel = () => client.cancel('news');
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const result = await client.load('news', {limit: 20});
      signal?.throwIfAborted();
      const body = result?.snapshot;
      if (result?.error || body?.mode !== 'live_readonly' || body.coverage.scope !== 'NEWS_FEED' ||
          body.requested_at_ms > now() + 5000 || body.quality === 'unavailable') return unavailable();
      entry = {body, readAt: now()};
      cache.set(fetchImpl, entry);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  const time = now(), batch = currentPublicEnvelope(entry.body, time);
  if (batch.quality === 'stale') return stale();
  const healthy = new Set(batch.sources.filter(s => s.status === 'OK').map(s => s.provider_id));
  if (!healthy.size) return unavailable();
  if (!batch.items.length) return status('empty', zh ? '暂无快讯' : 'No headlines available');
  const rows = batch.items.filter(row => row.quality === 'fresh' && healthy.has(row.provider_id) &&
    row.data.published_at_ms <= time && row.valid_until_ms > time);
  const stories = newsBookmarkSnapshots(rows, rows.map(row => row.record_id))
    .sort((a, b) => b.data.published_at_ms - a.data.published_at_ms || a.record_id.localeCompare(b.record_id));
  if (!stories.length) return batch.items.every(row => row.valid_until_ms <= time) ? stale() : unavailable();
  const index = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor % stories.length : 0;
  const {record_id: id, provider_id: provider, data} = stories[index];
  const source = provider === 'blockbeats-news-v1' ? (zh ? '律动 BlockBeats' : 'BlockBeats') : 'CoinDesk';
  const publishedAt = data.published_at_ms;
  const timestamp = new Date(publishedAt).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const askSource = {id: 'public:news:' + id, kind: 'news', title: data.title, href: pageHref,
    asOf: publishedAt, text: [data.title, source + ' · ' + timestamp, data.url].join('\n')};
  return {id, kind: 'news', label, title: data.title, body: '', visual: '', modeLabel: zh ? '公开报道' : 'Public news',
    source, timestamp, publishedAt, href: data.url, sourceUrl: data.url, pageHref,
    external: true, action: zh ? '查看原文 ↗' : 'Read original ↗', askSource};
}
