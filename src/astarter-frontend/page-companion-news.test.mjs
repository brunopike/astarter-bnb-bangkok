import assert from 'node:assert/strict';
import test from 'node:test';
import {projectPublicNews} from './public-news.mjs';
import {readCompanionNews} from './page-companion-news.mjs';

const time = Date.UTC(2026, 10, 26, 12);
const newsItem = (id, title, publishedAt) => ({
  id: 'blockbeats:' + id, title, publishedAt, url: 'https://m.theblockbeats.info/flash/' + id, symbols: [], revision: null,
});
const items = [newsItem(31, 'Earlier headline', time - 8000), newsItem(32, 'Latest headline', time - 2500)];
function envelope(records = items) {
  const body = projectPublicNews({items: records, asOf: records.at(-1)?.publishedAt, receivedAt: time},
    {limit: 20, selection_version: 0}, time, 'blockbeats-news-v1');
  body.sources[0].provider_id = 'blockbeats-news-v1';
  return body;
}
const fetchBody = body => async () => Response.json(body);

test('sorts and rotates verified headlines, preserving original publication time and links for Ask AI', async () => {
  let reads = 0;
  const fetchImpl = async (url, options) => {
    reads++;
    assert.equal(url, '/api/market-hub?resource=news&selection_version=0&limit=20');
    assert.equal(options.credentials, 'omit');
    return Response.json(envelope());
  };
  const read = cursor => readCompanionNews({cursor, fetchImpl, now: () => time});
  const newest = await read(0), previous = await read(1);
  assert.equal(newest.title, 'Latest headline');
  assert.equal(newest.source, '律动 BlockBeats');
  assert.equal(newest.publishedAt, time - 2500);
  assert.equal(newest.askSource.href, newest.pageHref);
  assert.deepEqual(newest.askSource.text.split('\n'), [newest.title, newest.source + ' · ' + newest.timestamp, newest.href]);
  assert.equal(newest.href, items[1].url);
  assert.equal(previous.title, 'Earlier headline');
  assert.equal((await read(2)).id, newest.id);
  assert.equal(reads, 1);
});

test('checks expiry even on a cached read, and never sends old facts to chat', async () => {
  let clock = time;
  const body = envelope([newsItem(31, 'Expiring headline', time - 86400000 + 5000)]);
  const options = {fetchImpl: fetchBody(body), now: () => clock};
  assert.equal((await readCompanionNews(options)).kind, 'news');
  clock += 5000;
  const result = await readCompanionNews(options);
  assert.equal(result.reason, 'stale');
  assert.equal(result.askSource, null);
});

test('distinguishes empty publication, broken reads and invalid or untrusted publisher records', async () => {
  const empty = await readCompanionNews({fetchImpl: fetchBody(envelope([])), now: () => time, locale: 'en'});
  assert.equal(empty.reason, 'empty');
  assert.equal(empty.external, false);
  for (const mutate of [b => {b.mode = 'offline_fixture';}, b => {b.sources[0].status = 'FAILED';},
    b => {for (const row of b.items) row.data.url = 'https://example.org/story';},
    b => {for (const row of b.items) row.data.published_at_ms = time + 1000;},
    b => {b.schema_version = 'wrong';}]) {
    const body = envelope();
    mutate(body);
    const result = await readCompanionNews({fetchImpl: fetchBody(body), now: () => time});
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.askSource, null);
  }
  const failed = await readCompanionNews({fetchImpl: async () => new Response(null, {status: 502}), now: () => time});
  assert.equal(failed.reason, 'unavailable');
});

test('public GET is cancelled when the user closes or switches cards', async () => {
  const ctrl = new AbortController();
  let requestSignal;
  const fetchImpl = (_url, {signal}) => new Promise((_resolve, reject) => {
    requestSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });
  const pending = readCompanionNews({fetchImpl, signal: ctrl.signal});
  ctrl.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(requestSignal.aborted, true);
});
