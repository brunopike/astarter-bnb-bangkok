import {getLocale, localeInfo, pair as L} from './locale.mjs';
import {safePublicURL} from './public-data-client.mjs';

const dayMs = 86_400_000;
const shanghai = new Intl.DateTimeFormat('sv-SE', {
  timeZone:'Asia/Shanghai', dateStyle:'short', timeStyle:'short',
});
const htmlEntities = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const esc = value => String(value).replace(/[&<>"']/g, character => htmlEntities[character]);
const agency = {bea:'BEA', fed:'Fed', fred:'FRED'};
const knownTitles = new Map([
  ['FOMC meeting concludes', '美联储议息会议结束'],
  ['Consumer Price Index', '美国消费者价格指数'],
  ['Employment Situation', '美国就业报告'],
]);
const metricLabels = {
  CPI_U_MOM_SA:['CPI 环比（季调）', 'CPI month over month (SA)'],
  UNEMPLOYMENT_RATE_SA:['失业率（季调）', 'Unemployment rate (SA)'],
  FED_FUNDS_TARGET_RANGE:['联邦基金利率目标区间', 'Federal funds target range'],
};

function sourceLink(name, url) {
  const href = safePublicURL(url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>` : '';
}

function eventCard({event, local}, numberFormat) {
  const {release, title, date} = event;
  const metric = release && metricLabels[release.metric];
  const region = [L('美国', 'United States'), metric && L(...metric), release?.period !== date && release?.period].filter(Boolean).join(' · ');
  const time = local ? local.slice(11, 16) : L('仅日期', 'Date only');
  const fields = [
    [L('公布值', 'Actual'), event.actual], [L('预期', 'Forecast'), event.forecast], [L('前值', 'Previous'), event.previous],
  ];
  const formatPercent = value => {
    if (value == null) return '—';
    return (Array.isArray(value) ? value.map(n => numberFormat.format(n)).join('–') : numberFormat.format(value)) + '%';
  };
  const primary = release ? sourceLink(event.source === 'fed' ? 'Fed' : 'BLS', release.url) : sourceLink(agency[event.source], event.sourceUrl);
  return `<article class="df-economic-event">
    <header><time datetime="${esc(event.scheduledAt || date)}">${time}</time>${local ? '' : `<span class="df-economic-impact">${L('按美东日期', 'US Eastern date')}</span>`}</header>
    <div class="df-economic-name"><h3 data-no-translate>${esc(knownTitles.has(title) ? L(knownTitles.get(title), title) : title)}</h3><span class="df-economic-area">${esc(region)}</span></div>
    <dl>${fields.map(([name, value]) => `<div><dt>${name}</dt><dd>${formatPercent(value)}</dd></div>`).join('')}</dl>
    <footer>${primary}${release?.vintageUrl ? sourceLink('ALFRED', release.vintageUrl) : ''}</footer>
  </article>`;
}

// Receives the validated body of resource=macro. A date-only release retains its official US date.
export function renderIntelligenceCalendar(snapshot, {now = Date.now(), selectedDay = null, pending = false, stale = false} = {}) {
  const today = shanghai.format(now).slice(0, 10);
  const start = Date.parse(today);
  const days = Array.from({length:7}, (_, offset) => new Date(start + offset * dayMs).toISOString().slice(0, 10));
  const groups = new Map(days.map(day => [day, []]));
  for (const event of snapshot?.events ?? []) {
    const local = event.scheduledAt ? shanghai.format(Date.parse(event.scheduledAt)) : null;
    const day = local ? local.slice(0, 10) : event.date;
    groups.get(day)?.push({event, local});
  }
  const selected = groups.has(selectedDay) ? selectedDay : days.find(day => groups.get(day).length) ?? today;
  const records = groups.get(selected).sort((a, b) =>
    (a.event.scheduledAt ?? '9999').localeCompare(b.event.scheduledAt ?? '9999') || a.event.title.localeCompare(b.event.title));
  const locale = localeInfo(getLocale()).tag;
  const month = new Intl.DateTimeFormat(locale, {timeZone:'UTC', year:'numeric', month:'long'});
  const shortDate = new Intl.DateTimeFormat(locale, {timeZone:'UTC', month:'short', day:'numeric'});
  const weekday = new Intl.DateTimeFormat(locale, {timeZone:'UTC', weekday:'short'});
  const monthTitle = month.formatRange(start, Date.parse(days[6]));
  const incomplete = (snapshot?.sources || []).filter(item => item.status !== 'available');
  // A complete Shanghai day spans two US Eastern dates: the preceding date and the date on the tab.
  const inRange = day => snapshot && day > snapshot.calendarStart && day <= snapshot.calendarEnd;
  const boundaryDay = snapshot && (selected === snapshot.calendarStart || Date.parse(selected) === Date.parse(snapshot.calendarEnd) + dayMs);
  const countKnown = day => inRange(day) && !incomplete.length;
  const countText = n => L(`${n} 项事件`, `${n} ${n === 1 ? 'event' : 'events'}`);
  const buttons = days.map(day => {
    const count = groups.get(day).length;
    const confirmed = count > 0 || countKnown(day);
    const label = shortDate.format(Date.parse(day)) + ' · ' + (confirmed ? countText(count) : L('数量待确认', 'Count unavailable'));
    return `<button type="button" data-intelligence-day="${day}" aria-pressed="${day === selected}" aria-label="${esc(label)}"><small>${weekday.format(Date.parse(day))}</small><b>${Number(day.slice(-2))}</b><span class="df-day-events" aria-hidden="true"><i class="${count ? 'has-event' : ''}"></i>${confirmed ? count : '—'}</span></button>`;
  }).join('');
  let status = '';
  if (!snapshot) status = pending ? L('正在读取官方日历', 'Loading official calendar') : L('官方日历暂不可用', 'Official calendar unavailable');
  else if (boundaryDay) status = L('官方日历仅覆盖当天部分时段', 'Calendar covers part of this date');
  else if (!inRange(selected)) status = L('超出日历覆盖范围', 'Outside calendar coverage');
  else if (incomplete.length) status = incomplete.map(item => agency[item.id]).join(' / ') + ' · ' + L('数据不完整', 'Incomplete coverage');
  const selectedCount = (records.length || countKnown(selected)) ? countText(records.length) : '';
  const numberFormat = new Intl.NumberFormat(locale, {maximumFractionDigits:3});
  const credits = (snapshot?.sources || []).map(item => sourceLink(agency[item.id], item.url)).join(' · ');
  const details = records.length
    ? records.map(item => eventCard(item, numberFormat)).join('')
    : `<div class="df-calm">${status || L('官方日历当天暂无安排', 'No events listed for this date')}${credits ? `<small>${credits}</small>` : ''}</div>`;
  const heading = [stale && L('缓存日历', 'Cached calendar'), records.length && status].filter(Boolean).join(' · ');
  return `<section class="dc-panel df-side-panel df-economic-calendar"><header><h2>${L('经济日历', 'Economic calendar')}</h2>${heading ? `<span>${esc(heading)}</span>` : ''}<a class="df-quiet" data-dc-link href="?page=intelligence&amp;view=calendar">${L('完整日历', 'Full calendar')}</a></header>
    <div class="df-calendar-top"><span>${monthTitle}</span><small>UTC+8</small></div>
    <div class="df-calendar" role="group" aria-label="${L('事件日期', 'Event date')}">${buttons}</div>
    <div class="df-calendar-selection"><h3>${shortDate.format(Date.parse(selected))}</h3><span>${selectedCount}</span></div>
    <div class="df-economic-events" role="region" aria-label="${L('经济事件', 'Economic events')}" data-calendar-source="official-us">${details}</div>
  </section>`;
}
