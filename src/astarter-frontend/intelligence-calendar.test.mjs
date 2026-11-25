import assert from 'node:assert/strict';
import test from 'node:test';
import {renderIntelligenceCalendar} from './intelligence-calendar.mjs';
import {getLocale} from './locale.mjs';

const expected = (en, zh) => getLocale() === 'zh' ? zh : en;

const now = Date.parse('2026-11-29T15:00:00Z');
const source = {id:'bea', url:'https://www.bea.gov/news/schedule', status:'available'};
const event = {
  source:'bea', sourceUrl:source.url, title:'Personal income & outlays',
  date:'2026-11-29', scheduledAt:'2026-11-29T20:30:00.000Z', actual:null, previous:null, forecast:null,
};
const snapshot = {calendarStart:'2026-10-30', calendarEnd:'2027-02-27', sources:[source], events:[event]};
const render = (data, options) => renderIntelligenceCalendar(data, {now, ...options});

test('seven calendar days follow Shanghai midnight and keep the original card layout', () => {
  const html = render(snapshot);
  assert.equal((html.match(/data-intelligence-day="/g) || []).length, 7);
  assert.match(html, /data-intelligence-day="2026-11-29" aria-pressed="false"/);
  assert.match(html, /data-intelligence-day="2026-11-30" aria-pressed="true"/);
  assert.match(html, /data-intelligence-day="2026-12-05"/);
  assert.match(html, /<time datetime="2026-11-29T20:30:00.000Z">04:30<\/time>/);
  assert.match(html, /class="df-economic-event"/);
  assert.ok(html.includes(`class="df-quiet" data-dc-link href="?page=intelligence&amp;view=calendar">${expected('Full calendar', '完整日历')}</a>`));
  assert.match(html, /Personal income &amp; outlays/);
  assert.match(html, /href="https:\/\/www.bea.gov\/news\/schedule"/);
  const afterMidnight = render(snapshot, {now:Date.parse('2026-11-29T16:00:00Z')});
  assert.doesNotMatch(afterMidnight, /data-intelligence-day="2026-11-29"/);
  assert.match(afterMidnight, /data-intelligence-day="2026-12-06"/);
});

test('explicitly selected dates stay selected even when another date has events', () => {
  const html = render(snapshot, {selectedDay:'2026-12-01'});
  assert.match(html, /data-intelligence-day="2026-12-01" aria-pressed="true"/);
  assert.match(html, expected(/0 events/, /0 项事件/));
  assert.doesNotMatch(html, /class="df-economic-event"/);
});

test('date-only releases retain their official Eastern day and report no fictitious local time', () => {
  const untimed = {...event, date:'2026-11-30', scheduledAt:null, title:'FOMC meeting concludes'};
  const html = render({...snapshot, events:[untimed, event]});
  assert.match(html, /data-intelligence-day="2026-11-30" aria-pressed="true"/);
  const dateOnly = expected('Date only', '仅日期'), zone = expected('US Eastern date', '按美东日期');
  assert.ok(html.indexOf('04:30</time>') < html.indexOf(`>${dateOnly}</time>`));
  assert.ok(html.includes(`<time datetime="2026-11-30">${dateOnly}</time><span class="df-economic-impact">${zone}`));
  assert.match(html, expected(/2 events/, /2 项事件/));
});

test('snapshot outages and incomplete calendars display unknown counts instead of zeroes', () => {
  const loading = render(null, {pending:true});
  const unavailable = render(null);
  assert.match(loading, expected(/Loading official calendar/, /正在读取官方日历/));
  assert.match(unavailable, expected(/Official calendar unavailable/, /官方日历暂不可用/));
  assert.doesNotMatch(unavailable, />0<\/span>|0 events|0 项事件/);
  const partial = render({...snapshot, sources:[source, {id:'fred', status:'partial', url:'https://fred.stlouisfed.org/'}]}, {stale:true});
  assert.match(partial, expected(/Cached calendar.*FRED · Incomplete coverage/, /缓存日历.*FRED · 数据不完整/));
  assert.match(partial, new RegExp(`data-intelligence-day="2026-11-30" aria-pressed="true" aria-label="[^"]*${expected('1 event','1 项事件')}"`));
  assert.match(partial, expected(/Count unavailable/, /数量待确认/));
  assert.doesNotMatch(render({...snapshot,events:[],calendarEnd:'2026-11-20'}), /0 events|0 项事件/);
});

test('official release values and vintage links are preserved, including zero and missing observations', () => {
  const report = {...event, source:'fred', title:'Consumer Price Index', actual:0, release:{
    metric:'CPI_U_MOM_SA', period:'2026-10', url:'https://www.bls.gov/news.release/', vintageUrl:'https://alfred.stlouisfed.org/',
  }};
  const html = render({...snapshot, events:[report]});
  assert.match(html, expected(/CPI month over month \(SA\) · 2026-10/, /CPI 环比（季调） · 2026-10/));
  assert.ok(html.includes(`<dt>${expected('Actual','公布值')}</dt><dd>0%</dd>`));
  assert.ok(html.includes(`<dt>${expected('Forecast','预期')}</dt><dd>—</dd>`));
  assert.ok(html.includes(`<dt>${expected('Previous','前值')}</dt><dd>—</dd>`));
  assert.match(html, /href="https:\/\/alfred.stlouisfed.org\//);
});

test('the first Eastern date and the Shanghai day following the last Eastern date only have partial coverage', () => {
  const zeroEvents = {...snapshot, events:[], calendarStart:'2026-11-29', calendarEnd:'2026-12-01'};
  for (const selectedDay of ['2026-11-29', '2026-12-02']) {
    const html = render(zeroEvents, {selectedDay});
    assert.match(html, expected(/Calendar covers part of this date/, /官方日历仅覆盖当天部分时段/));
    assert.match(html, new RegExp(`data-intelligence-day="${selectedDay}" aria-pressed="true" aria-label="[^"]*${expected('Count unavailable', '数量待确认')}`));
  }
  assert.match(render(zeroEvents, {selectedDay:'2026-11-30'}), expected(/No events listed for this date/, /官方日历当天暂无安排/));
  assert.match(render(zeroEvents, {selectedDay:'2026-12-03'}), expected(/Outside calendar coverage/, /超出日历覆盖范围/));
});
