import test from 'node:test';
import assert from 'node:assert/strict';
import {newsBookmarkSnapshots, filterIntelligenceNews, renderIntelligenceNewsFeed, renderIntelligenceNewsAside, createNewsDeliveryReader, newsDeliveryBrief} from './intelligence-news-feed.mjs';

const blockbeats = 'blockbeats-news-v1';
const coindesk = 'coindesk-rss-v1';
function item(id, provider_id, iso, title, data = {}) {
  return {record_id: id, provider_id, quality: 'fresh', data: {
    title, published_at_ms: Date.parse(iso), asset_ids: [], url: 'https://example.org/' + id, ...data,
  }};
}
const rows = [
  item('earlier', blockbeats, '2026-11-17T15:59:59Z', 'Original ETH headline', {asset_ids: ['ethereum']}),
  item('middle', coindesk, '2026-11-17T16:00:01Z', 'Overnight release', {symbols: ['BTC']}),
  item('latest', blockbeats, '2026-11-17T17:00:00Z', 'Spot markets', {symbols: ['DXY']}),
];

test('a live poll delivers one matching headline and remembers each publisher across filters and unchanged polls', () => {
  const next = createNewsDeliveryReader();
  const snapshot = {mode:'live_readonly',sources:[blockbeats,coindesk].map(provider_id=>({provider_id,status:'OK'})),items:rows};
  assert.equal(next({snapshot},{publisher:coindesk}),rows[1]);
  assert.equal(next({snapshot}),null);
  const tied=item('same-time',blockbeats,'2026-11-17T17:00:00Z','Another dispatch');
  const expanded={...snapshot,items:[tied,...rows]};
  assert.equal(next({snapshot:expanded}),tied);
  assert.equal(next({snapshot:expanded}),null);
  const late=item('archive',coindesk,'2026-11-17T12:00:00Z','Archive item');
  assert.equal(next({snapshot:{...snapshot,items:[late]}}),null);
  assert.equal(newsDeliveryBrief(tied).href,tied.data.url);
  assert.equal(newsDeliveryBrief(tied).title,'Another dispatch');
});

test('offline, fixture, stale and unavailable providers never produce a news delivery', () => {
  const next=createNewsDeliveryReader(),snapshot={mode:'live_readonly',sources:[{provider_id:coindesk,status:'OK'}],items:[rows[1]]};
  for(const state of [{}, {snapshot,offline:true}, {snapshot,error:'DATA_TIMEOUT'},
    {snapshot:{...snapshot,mode:'offline_fixture'}},{snapshot:{...snapshot,sources:[]}},
    {snapshot:{...snapshot,items:[{...rows[1],quality:'stale'}]}},
    {snapshot:{...snapshot,items:[{...rows[1],data:{...rows[1].data,url:'javascript:void(0)'}}]}}]){
    assert.equal(next(state),null);
  }
  assert.equal(next({snapshot}),rows[1]);
});

test('uses source timestamps, Shanghai publication dates and declared assets for filters', () => {
  const ids = options => filterIntelligenceNews(rows, options).map(row => row.record_id);
  assert.deepEqual(ids(), ['latest','middle','earlier']);
  assert.deepEqual(ids({date:'2026-11-18', source:blockbeats}), ['latest']);
  assert.deepEqual(ids({search:'bTc', source:coindesk}), ['middle']);
  assert.deepEqual(ids({search:' ethereum '}), []);
  assert.deepEqual(ids({search:' eth ', date:'2026-11-17'}), ['earlier']);
  assert.equal(rows[0].record_id, 'earlier');
  const feed = renderIntelligenceNewsFeed(rows, {date:'2026-11-18', limit:50});
  assert.match(feed, /df-news-tools/);
  assert.match(feed, /<option value="2026-11-18" selected>/);
  assert.match(feed, /<option value="50" selected>/);
  assert.match(feed, /datetime="2026-11-17T16:00:01.000Z".*?>00:00</);
  assert.match(feed, /aria-label="2026-11-18 00:00 UTC\+8">00:00</);
  assert.equal((feed.match(/class="df-day-separator"/g)||[]).length, 1);
  assert.match(feed, /asset=BTC/);
  assert.doesNotMatch(feed, /asset=DXY|Original ETH headline/);
});

test('keeps source links, escapes all external text and omits proprietary bodies and synthetic insights', () => {
  const record = item('escape', coindesk, '2026-11-18T08:00:00Z', '<img src=x>', {url:'javascript:alert(1)',summary:'publisher-body-must-not-leak'});
  const html = renderIntelligenceNewsFeed([record], {search:'"><script>'});
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
  assert.match(html, /data-pd-news-reset/);
  for (const view of [renderIntelligenceNewsFeed, renderIntelligenceNewsAside]) {
    assert.match(view([record]), /&lt;img src=x&gt;/);
    assert.doesNotMatch(view([record]), /href="javascript:|<img|publisher-body-must-not-leak|AI insight|AI 解读/);
    assert.match(view(rows), /href="https:\/\/example.org\/latest" target="_blank" rel="noopener noreferrer"/);
  }
});

test('keeps loading and upstream failure distinct from search misses and shows the most recent real article per publisher', () => {
  assert.match(renderIntelligenceNewsFeed([], {empty:'<p role="status">Waiting for provider</p>'}), /Waiting for provider/);
  assert.doesNotMatch(renderIntelligenceNewsFeed(rows, {search:'missing', empty:'upstream-error'}), /upstream-error/);
  assert.match(renderIntelligenceNewsFeed(rows, {source:'absent'}), /data-pd-news-source="absent" aria-pressed="true"/);
  assert.match(renderIntelligenceNewsFeed(rows, {date:'2026-11-15'}), /value="2026-11-15" selected/);
  const aside = renderIntelligenceNewsAside(rows, '<section id="sentiment"></section>');
  assert.match(aside, /class="df-aside"/);
  assert.match(aside, /id="sentiment"/);
  assert.match(aside, /Overnight release/);
  assert.match(aside, /Spot markets/);
  assert.match(aside, /Original ETH headline/);
  assert.equal((aside.match(/class="df-developing"/g) || []).length, 1);
});

test('saved stories use persistent source-qualified IDs, support unbookmarking and favor the live version', () => {
  const older = item('prior', blockbeats, '2026-11-15T08:00:00Z', 'Saved history');
  const saved = ['middle', 'prior'];
  const savedItems = [older, {...rows[1], data:{...rows[1].data, title:'Earlier edition'}}];
  const selected = filterIntelligenceNews(rows, {source:'saved', saved, savedItems});
  assert.deepEqual(selected.map(x=>x.record_id), ['middle','prior']);
  const feed = renderIntelligenceNewsFeed(rows, {source:'saved', saved, savedItems});
  assert.match(feed,/data-pd-news-source="saved" aria-pressed="true"/);
  assert.match(feed,/data-pd-bookmark\s+data-value="middle" aria-pressed="true"/);
  assert.match(feed,/Overnight release/);
  assert.match(feed,/Saved history/);
  assert.doesNotMatch(feed,/Earlier edition|Spot markets/);
  assert.deepEqual(filterIntelligenceNews(rows, {source:'saved',saved:[],savedItems}), []);
});

test('bookmark storage drops unknown fields, wrong publishers, mismatched IDs, invalid times and unsafe URLs', () => {
  const flashId = blockbeats + ':blockbeats:42';
  const deskUrl = 'https://www.coindesk.com/markets/report';
  const flash = item(flashId, blockbeats, '2026-11-18T08:00:00Z', 'Published story', {
    url:'https://m.theblockbeats.info/flash/42', asset_ids:['bitcoin', {'toString':42}, 'invalid'], symbols:['BTC', 'XAU', null],
    summary:'no body in storage', secret:'not allowed',
  });
  const desk = item(coindesk + ':' + deskUrl, coindesk, '2026-11-18T08:05:00Z', '<em>Article</em>', {url:deskUrl});
  const saved = [desk.record_id,flashId];
  const badInputs = [
    null, [], {record_id: flashId, data:null},
    {...flash, provider_id:'wrong-source'},
    {...flash, data:{...flash.data, url:'https://m.theblockbeats.info/flash/43'}},
    {...desk, data:{...desk.data, url:'https://coindesk.com.attacker.invalid/news'}},
    {...desk, data:{...desk.data, url:'https://coindesk.com@attacker.invalid/news'}},
    {...flash, data:{...flash.data, url:'javascript:alert(1)'}},
    {...flash, data:{...flash.data, published_at_ms:9e15}},
    {...flash, data:{...flash.data, title:' '}},
  ];
  const clean = newsBookmarkSnapshots([flash,desk,...badInputs], saved);
  assert.equal(clean.length, 2);
  assert.deepEqual(clean[0].data, {title:'Published story',url:flash.data.url,published_at_ms:flash.data.published_at_ms,asset_ids:['bitcoin'],symbols:['BTC','XAU']});
  assert.equal(clean[0].quality,'stale');
  assert.deepEqual(newsBookmarkSnapshots(clean, [desk.record_id]).map(row=>row.record_id),[desk.record_id]);
  assert.deepEqual(newsBookmarkSnapshots({rows:clean}, saved), []);
  assert.deepEqual(newsBookmarkSnapshots(clean, null), []);
  assert.deepEqual(newsBookmarkSnapshots(badInputs, saved), []);
  const view = renderIntelligenceNewsFeed([], {source:'saved', saved, savedItems:clean});
  assert.match(view,/&lt;em&gt;Article&lt;\/em&gt;/);
  assert.doesNotMatch(view,/<em>Article|no body in storage|not allowed/);
});

test('renders one shared brand mark per distinct tagged instrument, with live navigation only for covered spot assets', () => {
  const multi = item('fixture', coindesk, '2026-11-18T08:00:00Z', 'Coverage', {
    asset_ids:['ethereum', 'bitcoin'], symbols:['BTC','DXY','ETH','XAU'],
  });
  const view = renderIntelligenceNewsFeed([multi]);
  assert.equal((view.match(/data-logo-state="known"/g)||[]).length, 4);
  for (const symbol of ['BTC','ETH']) assert.match(view, new RegExp('asset='+symbol+'">\\s*<span class="brand-mark'));
  for (const symbol of ['DXY','XAU']) assert.doesNotMatch(view, new RegExp('asset='+symbol));
  assert.match(view,/US Dollar Index/);
});

test('keeps one tracking rail and stable topic tabs, independently filtered by publisher', () => {
  const macro = item('rates', blockbeats, '2026-11-18T08:05:00Z', '美联储利率决议', {symbols:['ETH','SPX']});
  const cash = item('cash', coindesk, '2026-11-18T08:00:00Z', 'ETF inflows', {summary:'market sentiment'});
  const records = [macro,cash];
  assert.deepEqual(filterIntelligenceNews(records,{source:'topic:flows'}).map(x=>x.record_id), ['cash']);
  assert.deepEqual(filterIntelligenceNews(records,{source:'topic:sentiment'}), []);
  const feed = renderIntelligenceNewsFeed(records);
  assert.match(feed, /data-pd-news-source="topic:macro"[^>]* title=/);
  assert.match(feed, /data-pd-news-source="topic:flows"/);
  assert.match(feed,/data-pd-news-source="topic:sentiment"/);
  assert.match(feed,/data-pd-news-publisher/);
  assert.deepEqual(filterIntelligenceNews(records,{source:'topic:flows',publisher:blockbeats}), []);
  assert.deepEqual(filterIntelligenceNews(records,{source:'topic:flows',publisher:coindesk}), [cash]);
  const tracking = renderIntelligenceNewsAside(records,'',{saved:['rates']});
  assert.match(tracking,/美联储/);
  assert.match(tracking,/dc-asset-chips/);
  assert.match(tracking,/asset=ETH/);
  assert.doesNotMatch(tracking,/ETF inflows/);
  const latest = renderIntelligenceNewsAside(records, '<section id="markets"></section>');
  assert.match(latest,/最新快讯|Latest news/);
  assert.match(latest,/美联储[\s\S]*ETF inflows[\s\S]*id="markets"/);
  assert.doesNotMatch(latest,/暂无追踪|No tracked stories/);
  const crowded = Array.from({length:6}, (_,i)=>item('flash'+i,blockbeats,`2026-11-19T08:0${i}:00Z`,'Flash '+i));
  const rail = renderIntelligenceNewsAside([...crowded,cash]);
  assert.equal((rail.match(/<div data-no-translate>/g)||[]).length, 4);
  assert.match(rail,/Flash 5[\s\S]*Flash 4[\s\S]*Flash 3[\s\S]*ETF inflows/);
});

test('publisher wording is preserved in the timeline, source rail and tracked list', () => {
  const story = item('slack', blockbeats, '2026-11-19T10:00:00Z', '让 Agent 接管任务');
  assert.match(renderIntelligenceNewsFeed([story]), /<h2 data-no-translate><a [^>]+>让 Agent 接管任务<\/a><\/h2>/);
  for (const opts of [{}, {saved:['slack']}]) {
    assert.match(renderIntelligenceNewsAside([story], '', opts), /<div data-no-translate><time[^>]*>[^<]*<\/time>\s*<a [^>]+>让 Agent 接管任务<\/a>/);
  }
});
