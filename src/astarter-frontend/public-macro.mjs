const ZONE = 'America/New_York';
const BEA_URL = 'https://www.bea.gov/news/schedule';
const BEA_FEED = BEA_URL + '/ics/online-calendar-subscription.ics';
const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const FRED_URL = 'https://fred.stlouisfed.org/releases/calendar';
const SOURCES = [
  {id:'bea', name:'U.S. Bureau of Economic Analysis', url:BEA_URL},
  {id:'fed', name:'Federal Reserve Board', url:FED_URL},
  {id:'fred', name:'FRED · BLS releases', url:FRED_URL},
];
const pad = value => String(value).padStart(2, '0');
const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthNumber = name => monthNames.findIndex(month => month.startsWith(name.toLowerCase())) + 1;
const dayKey = (year, month, day) => year + '-' + pad(month) + '-' + pad(day);
const dayValid = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
const addDays = (day, delta) => new Date(Date.parse(day) + delta * 86_400_000).toISOString().slice(0, 10);
const ny = new Intl.DateTimeFormat('sv-SE', {timeZone:ZONE, dateStyle:'short', timeStyle:'medium'});
const chicago = new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Chicago', dateStyle:'short', timeStyle:'medium'});

function invalid() {
  throw new Error('INVALID_DATA');
}

function event(source, id, title, sourceUrl, date, scheduledAt = null) {
  const time = scheduledAt ? ny.format(Date.parse(scheduledAt)).slice(11, 16) : null;
  return {id:source + ':' + id, title, source, sourceUrl, date, time, scheduledAt,
    precision:time ? 'time' : 'date', actual:null, previous:null, forecast:null};
}

function beaEvents(text) {
  const calendar = text.trim().replace(/\r?\n[ \t]/g, '');
  if (!/^BEGIN:VCALENDAR\r?\n/.test(calendar) || !/\r?\nEND:VCALENDAR$/.test(calendar)) invalid();
  const events = [];
  const blocks = [...calendar.matchAll(/^BEGIN:VEVENT\r?\n([\s\S]*?)^END:VEVENT\r?$/gm)];
  if (blocks.length !== (calendar.match(/^BEGIN:VEVENT\r?$/gm) || []).length) invalid();
  for (const [,block] of blocks) {
    if (/^STATUS:CANCELLED\r?$/m.test(block)) continue;
    const id = block.match(/^UID:([^\r\n]+)/m)?.[1];
    const title = block.match(/^SUMMARY:([^\r\n]+)/m)?.[1]
      ?.replace(/\\([\\,;nN])/g, (_, char) => /^n$/i.test(char) ? ' ' : char).trim();
    const start = block.match(/^DTSTART(?:;VALUE=(?:DATE-TIME|DATE))?:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?\r?$/m);
    if (!id || !title || !start) invalid();
    const [,year,month,day,hour,minute,second] = start;
    const date = dayKey(year, month, day);
    if (!dayValid(date)) invalid();
    if (!hour) {
      events.push(event('bea', id, title, BEA_URL, date));
      continue;
    }
    if (+hour > 23 || +minute > 59 || +second > 59) invalid();
    const instant = Date.parse(date + 'T' + hour + ':' + minute + ':' + second + 'Z');
    events.push(event('bea', id, title, BEA_URL, ny.format(instant).slice(0, 10), new Date(instant).toISOString()));
  }
  return events;
}

function fedEvents(text) {
  const sections = text.split(/<a id="(\d+)">\s*(\d{4}) FOMC Meetings<\/a>/);
  if (sections.length < 4) invalid();
  const events = [];
  const re = /fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)(?:\/([A-Za-z]+))?<\/strong>\s*<\/div>\s*<div[^>]*fomc-meeting__date[^>]*>\s*([\d*-]+)\s*<\/div>/g;
  for (let i = 1; i < sections.length; i += 3) {
    const [anchor, year, body] = sections.slice(i, i + 3);
    const meetings = [...body.matchAll(re)];
    const count = [...body.matchAll(/fomc-meeting__date[^>]*>(?![^<]*notation vote)/g)].length;
    if (!meetings.length || meetings.length !== count) invalid();
    for (const [,startMonth,endMonth,range] of meetings) {
      const date = dayKey(year, monthNumber(endMonth || startMonth), range.replace('*', '').split('-').at(-1));
      if (!dayValid(date)) invalid();
      events.push(event('fed', date, 'FOMC meeting concludes', FED_URL + '#' + anchor, date));
    }
  }
  return events;
}

function fredEvents(text, rid, url) {
  if (!text.includes('id="release-dates-pager"') || !text.includes('All times are US Central Time')) invalid();
  if (text.includes('No release dates are available for the selected options.')) return [];
  const re = new RegExp('<span[^>]*>\\s*[A-Za-z]+ ([A-Za-z]+) (\\d{1,2}), (\\d{4})\\s*</span>[^<]*(?:<span[^>]*>Updated</span>\\s*)?</td>\\s*</tr>\\s*<tr>\\s*<td[^>]*>\\s*(\\d{1,2}:\\d{2} [ap]m|N/A)\\s*</td>\\s*<td[^>]*>\\s*<a href="/release\\?rid=' + rid + '">([^<]+)</a>', 'gi');
  const records = [...text.matchAll(re)];
  const count = Number(text.match(/Releases\s+1\s*-\s*\d+\s+of\s+(\d+)/)?.[1]);
  if (!count || records.length !== count) invalid();
  return records.map(([,month,day,year,time,title]) => {
    const date = dayKey(year, monthNumber(month), day);
    if (!dayValid(date)) invalid();
    if (time === 'N/A') return event('fred', rid + ':' + date, title, url, date);
    const [,hour,minute,period] = time.match(/^(\d{1,2}):(\d{2}) ([ap]m)$/i);
    if (+hour < 1 || +hour > 12 || +minute > 59) invalid();
    const local = date + ' ' + pad(hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0)) + ':' + minute + ':00';
    // US Central alternates between UTC-5 and UTC-6. Check the local time so DST follows the event date.
    const instant = [5, 6].map(offset => Date.parse(local.replace(' ', 'T') + 'Z') + offset * 3_600_000)
      .find(at => chicago.format(at) === local);
    if (instant === undefined) invalid();
    return event('fred', rid + ':' + date, title, url, ny.format(instant).slice(0, 10), new Date(instant).toISOString());
  });
}

const releaseTypes = {
  cpi:{rid:10,title:'Consumer Price Index',table:'cpi_pressa',rowId:'cpi_pressa.r.1',row:'All items',heading:'CONSUMER PRICE INDEX',metric:'CPI_U_MOM_SA',series:'CPIAUCSL'},
  empsit:{rid:50,title:'Employment Situation',table:'cps_empsit_sum',rowId:'cps_empsit_sum.r.2.1.3.1',row:'Unemployment rate',heading:'THE EMPLOYMENT SITUATION',metric:'UNEMPLOYMENT_RATE_SA',series:'UNRATE'},
};

function archiveFor(item) {
  if (!dayValid(item.date)) return null;
  const [year,month,day]=item.date.split('-');
  if (item.source==='fed' && item.id==='fed:'+item.date && item.title==='FOMC meeting concludes') {
    return {kind:'fed',url:`https://www.federalreserve.gov/newsevents/pressreleases/monetary${year}${month}${day}a.htm`};
  }
  for (const [kind,type] of Object.entries(releaseTypes)) {
    if (item.source==='fred' && item.id===`fred:${type.rid}:${item.date}` && item.title===type.title) {
      return {kind,url:`https://www.bls.gov/news.release/archives/${kind}_${month}${day}${year}.htm`};
    }
  }
  return null;
}

const plainCell = html => html.replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();
function sourceDay(month,day,year) {
  const index=monthNames.indexOf(month.toLowerCase());
  return index<0?null:dayKey(year,index+1,Number(day));
}
function blsObservation(html,kind,event) {
  const type=releaseTypes[kind],pre=html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1]||'';
  const stamp=pre.match(/Transmission of material in this (?:news )?release is embargoed until[\s\S]{0,160}?\(ET\)\s+\w+,\s+([a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  const periodMatch=pre.match(new RegExp('^\\s*'+type.heading+'\\s*[-–—]\\s*([a-z]+)\\s+(\\d{4})\\s*$','im'));
  if (!stamp||sourceDay(stamp[1],stamp[2],stamp[3])!==event.date||!periodMatch) return null;
  const first=sourceDay(periodMatch[1],1,periodMatch[2]);
  if (!first||first>=event.date||Date.parse(event.date)-Date.parse(first)>120*86400000) return null;
  const period=first.slice(0,7),prior=addDays(first,-1).slice(0,7);
  const table=html.match(new RegExp('<table\\b[^>]*\\bid="'+type.table+'"[^>]*>([\\s\\S]*?)</table>','i'))?.[1];
  if (!table||!(kind==='cpi'?/Seasonally adjusted changes from preceding month/i:/Household data, seasonally adjusted/i).test(table)) return null;
  const monthColumns=new Map();
  for (const match of table.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)){
    const label=plainCell(match[2]).match(/^([a-z]{3,9})\.? (\d{4})$/i),id=match[1].match(/\bid="([^"]+)"/)?.[1];
    if (id&&label&&monthNumber(label[1])>0&&(kind!=='cpi'||/headers="cpi_pressa\.h\.1\.2"/.test(match[1])))monthColumns.set(id,label[2]+'-'+pad(monthNumber(label[1])));
  }
  for(const [,row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const name=row.match(/<th\b([^>]*)>([\s\S]*?)<\/th>/i);
    if(!name||name[1].match(/\bid="([^"]+)"/)?.[1]!==type.rowId||plainCell(name[2])!==type.row)continue;
    const values=new Map();
    for(const m of row.matchAll(/<td\b[^>]*\bheaders="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)){
      const columns=m[1].split(/\s+/).filter(id=>monthColumns.has(id)),number=plainCell(m[2]);
      if(columns.length!==1||!regexpDecimal.test(number))continue;
      const month=monthColumns.get(columns[0]);if(values.has(month))return null;
      values.set(month,Number(number));
    }
    if(!values.has(period))return null;
    return {metric:type.metric,period,actual:values.get(period),previous:values.get(prior)??null};
  }
  return null;
}
const regexpDecimal=/^-?\d{1,3}(?:\.\d{1,2})?$/;
function vintageUrls(kind,date) {
  const month=date.slice(0,7)+'-01',start=addDays(month,-180).slice(0,7)+'-01';
  return [addDays(date,-1),date].map(vintage_date=>'https://alfred.stlouisfed.org/graph/alfredgraph.csv?'+new URLSearchParams({
    id:releaseTypes[kind].series,cosd:start,coed:month,vintage_date
  }));
}
function vintageSeries(text,series,date) {
  if(typeof text!=='string')return null;
  const [header,...rows]=text.trim().split(/\r?\n/);
  if(header!=='observation_date,'+series+'_'+date.replaceAll('-','')||!rows.length||rows.length>8)return null;
  const values=new Map();
  let previous='';
  for(const row of rows){
    const [month,value,...extra]=row.split(',');
    if(extra.length||!dayValid(month)||!month.endsWith('-01')||month<=previous||month>=date||
      (value!=='.'&& !/^\d{1,6}(?:\.\d{1,8})?$/.test(value||'')))return null;
    previous=month;
    if(value!=='.')values.set(month,Number(value));
  }
  return values.size?values:null;
}
function blsVintageObservation(documents,kind,event) {
  if(!documents?.length)return null;
  const type=releaseTypes[kind];
  const before=vintageSeries(documents[0],type.series,addDays(event.date,-1));
  const current=vintageSeries(documents[1],type.series,event.date);
  if(!before||!current)return null;
  const newest=[...current.keys()].at(-1);
  // A period already present the day before cannot be attributed to this release.
  if([...before.keys()].at(-1)>=newest)return null;
  const previous=addDays(newest,-1).slice(0,7)+'-01',value=current.get(newest),prior=current.get(previous);
  if(kind==='empsit')return {metric:type.metric,period:newest.slice(0,7),actual:value,previous:prior??null};
  if(!(value>0&&prior>0))return null;
  const earlier=current.get(addDays(previous,-1).slice(0,7)+'-01');
  const change=(n,d)=>{
    const percentage=(n/d-1)*100;
    return Math.sign(percentage)*Math.round(Math.abs(percentage)*10)/10;
  };
  return {metric:type.metric,period:newest.slice(0,7),actual:change(value,prior),previous:earlier>0?change(prior,earlier):null};
}
const ratePart='(?:\\d+-)?[123]/[248]|\\d+(?:\\.\\d+)?';
function rateNumber(token) {
  const fraction=token.match(/^(?:(\d+)-)?(\d)\/(\d)$/);
  return fraction?Number(fraction[1]||0)+Number(fraction[2])/Number(fraction[3]):Number(token);
}
function fedObservation(html,event) {
  const day=html.match(/<p class="article__time">\s*([a-z]+) (\d{1,2}), (\d{4})\s*<\/p>/i);
  if(!day||sourceDay(day[1],day[2],day[3])!==event.date||!/<h3 class="title">\s*Federal Reserve issues FOMC statement\s*<\/h3>/i.test(html))return null;
  const clause=new RegExp('\\bthe Committee decided to (maintain|raise|lower) the target range for the federal funds rate(?: by ('+ratePart+') percentage points?)? (at|to) ('+ratePart+') to ('+ratePart+') percent\\b','i');
  for(const [,block] of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)){
    const match=plainCell(block).replace(/[‐‑–−]/g,'-').match(clause);
    if(!match)continue;
    const action=match[1].toLowerCase(),keep=action==='maintain';
    if(keep!==!match[2]||match[3].toLowerCase()!==(keep?'at':'to'))return null;
    const actual=[rateNumber(match[4]),rateNumber(match[5])],change=keep?0:rateNumber(match[2])*(action==='raise'?1:-1);
    return {metric:'FED_FUNDS_TARGET_RANGE',period:event.date,actual,previous:actual.map(value=>value-change)};
  }
  return null;
}
function validObservation(item,archive) {
  const o=item.release;
  if(!archive||!o||o.url!==archive.url||item.forecast!==null)return false;
  if(o.vintageUrl!==undefined&&(archive.kind==='fed'||o.vintageUrl!==vintageUrls(archive.kind,item.date)[1]))return false;
  if(archive.kind==='fed'){
    const bounds=v=>Array.isArray(v)&&v.length===2&&v.every(n=>Number.isFinite(n)&&n>=0&&n<=30)&&v[0]<v[1]&&v[1]-v[0]<=1;
    return o.metric==='FED_FUNDS_TARGET_RANGE'&&o.period===item.date&&bounds(item.actual)&&bounds(item.previous)
      &&item.actual[1]-item.actual[0]===item.previous[1]-item.previous[0];
  }
  if(typeof o.period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.period))return false;
  const first=o.period+'-01',validNumber=v=>Number.isFinite(v)&&(archive.kind==='cpi'?Math.abs(v)<=100:v>=0&&v<=100);
  return o.metric===releaseTypes[archive.kind].metric&&first<item.date&&Date.parse(item.date)-Date.parse(first)<=120*86400000
    &&validNumber(item.actual)&&(item.previous===null||validNumber(item.previous));
}

export function publicMacroRequest(params, now = Date.now()) {
  if (params.size || !Number.isFinite(now)) return null;
  const today = ny.format(now).slice(0, 10);
  const calendarStart = addDays(today, -30);
  const calendarEnd = addDays(today, 90);
  const fred = rid => FRED_URL + '?rid=' + rid + '&vs=' + calendarStart + '&ve=' + calendarEnd;
  const urls = [BEA_FEED, FED_URL, fred(10), fred(50)].map(url => ({url, optional:true, timeoutMs:5_500}));
  const readers = [beaEvents, fedEvents, text => fredEvents(text, 10, urls[2].url), text => fredEvents(text, 50, urls[3].url)];
  return {
    key:'macro', resource:'macro',
    policy:{urls, timeoutMs:12_500, interval:3_600_000, stale:86_400_000, maxBytes:300_000, format:'text', parallel:true,
      headers:{Accept:'text/calendar, text/html;q=0.9'}},
    decode(parts) {
      if (!Array.isArray(parts) || parts.length !== urls.length) invalid();
      const feeds = parts.map((part,i) => {
        if (typeof part !== 'string') return null;
        try {
          return readers[i](part);
        } catch (error) {
          if (error.message !== 'INVALID_DATA') throw error;
          return null;
        }
      });
      if (feeds.every(feed => feed === null)) invalid();
      const sources = SOURCES.map((source,i) => {
        const expected = i === 2 ? 2 : 1;
        const available = feeds.slice(i, i + expected).filter(feed => feed !== null).length;
        return {...source, status:available === expected ? 'available' : available ? 'partial' : 'unavailable'};
      });
      const events = [...new Map(feeds.flatMap(feed => feed ?? []).filter(item => item.date >= calendarStart && item.date <= calendarEnd)
        .map(item => [item.id, item])).values()]
        .sort((a,b) => a.date.localeCompare(b.date) || (a.time ?? '99').localeCompare(b.time ?? '99') || a.title.localeCompare(b.title));
      return {edition:'us-selected', timeZone:ZONE, calendarStart, calendarEnd, sources, events};
    },
    archives(body,at) {
      const today=ny.format(at).slice(0,10);
      return body.events.filter(item=>item.date<=today&&(!item.scheduledAt||Date.parse(item.scheduledAt)<=at))
        .flatMap(item=>{const archive=archiveFor(item);return archive?[{...archive,eventId:item.id,optional:true,timeoutMs:3500,maxBytes:2400000,
          ...(archive.kind==='fed'?{}:{vintages:vintageUrls(archive.kind,item.date)})}]:[];}).slice(-6);
    },
    applyArchives(body,archives,documents,vintages=[]) {
      for(const [i,archive] of archives.entries()){
        const item=body.events.find(event=>event.id===archive.eventId),html=documents[i];
        if(!item)continue;
        const direct=typeof html==='string'?(archive.kind==='fed'?fedObservation(html,item):blsObservation(html,archive.kind,item)):null;
        const observation=direct??(archive.vintages?blsVintageObservation(vintages[i],archive.kind,item):null);
        if(!observation)continue;
        const {metric,period,actual,previous}=observation,release={metric,period,url:archive.url};
        if(!direct)release.vintageUrl=archive.vintages[1];
        if(validObservation({...item,actual,previous,release},archive))Object.assign(item,{actual,previous,release});
      }
    },
    async readArchives(body,load,at) {
      await Promise.all(this.archives(body,at).map(async archive=>{
        // Fetch both sources within the same deadline when the BLS host blocks a deployment region.
        const vintages=archive.vintages&&Promise.all(archive.vintages.map(url=>load({
          url,optional:true,timeoutMs:6000,maxBytes:3000,headers:{Accept:'text/csv'}
        })));
        this.applyArchives(body,[archive],[await load(archive)]);
        if(vintages&&!body.events.find(event=>event.id===archive.eventId)?.release){
          this.applyArchives(body,[archive],[],[await vintages]);
        }
      }));
    },
    validate:validatePublicMacro,
  };
}

export function validatePublicMacro(body, at=Date.now()) {
  if (body?.edition !== 'us-selected' || body.timeZone !== ZONE || !dayValid(body.calendarStart)
    || !dayValid(body.calendarEnd) || addDays(body.calendarStart, 120) !== body.calendarEnd
    || !Array.isArray(body.sources) || body.sources.length !== SOURCES.length
    || !SOURCES.every((source,i) => Object.keys(source).every(key => body.sources[i]?.[key] === source[key]))
    || body.sources.some(source => !['available','unavailable'].includes(source.status)
      && !(source.id === 'fred' && source.status === 'partial'))
    || body.sources.every(source => source.status === 'unavailable')
    || !Array.isArray(body.events) || body.events.length > 500) invalid();
  const ids = new Set();
  for (const item of body.events) {
    if (!item || !dayValid(item.date) || item.date < body.calendarStart || item.date > body.calendarEnd
      || typeof item.id !== 'string' || !item.id.startsWith(item.source + ':') || ids.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 400
      || item.forecast !== null) invalid();
    if(item.release===undefined){
      if(item.actual!==null||item.previous!==null)invalid();
    }else if(!validObservation(item,archiveFor(item))||!Number.isFinite(at)||item.date>ny.format(at).slice(0,10)||item.scheduledAt&&Date.parse(item.scheduledAt)>at)invalid();
    const source = body.sources.find(source => source.id === item.source);
    if (!source || source.status === 'unavailable' || typeof item.sourceUrl !== 'string') invalid();
    const fredUrl = rid => FRED_URL + '?rid=' + rid + '&vs=' + body.calendarStart + '&ve=' + body.calendarEnd;
    if (item.source === 'bea' && item.sourceUrl !== BEA_URL) invalid();
    if (item.source === 'fed' && !(item.sourceUrl.startsWith(FED_URL + '#')
      && /^\d+$/.test(item.sourceUrl.slice(FED_URL.length + 1)))) invalid();
    if (item.source === 'fred' && ![fredUrl(10),fredUrl(50)].includes(item.sourceUrl)) invalid();
    if (item.precision === 'date') {
      if (item.time !== null || item.scheduledAt !== null) invalid();
    } else {
      const instant = Date.parse(item.scheduledAt);
      if (item.precision !== 'time' || !Number.isFinite(instant)
        || new Date(instant).toISOString() !== item.scheduledAt || ny.format(instant).slice(0, 16) !== item.date + ' ' + item.time) invalid();
    }
    ids.add(item.id);
  }
  return body;
}

const BLS = 'U.S. Bureau of Labor Statistics';
const BLS_API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const MONTHLY_SERIES = new Map([
  ['cpi', {seriesId:'CUSR0000SA0', unit:'index'}],
  ['unemployment', {seriesId:'LNS14000000', unit:'percent'}],
  ['payrolls', {seriesId:'CES0000000001', unit:'thousands'}],
]);

export function publicMacroSeriesRequest(params, now = Date.now()) {
  const series = params.get('series');
  const definition = MONTHLY_SERIES.get(series);
  if (params.size !== 1 || !definition || !Number.isFinite(now)) return null;
  const {seriesId, unit} = definition;
  const url = BLS_API + seriesId;
  return {
    key:'macro-series:' + series, resource:'macro-series',
    policy:{url, interval:14_400_000, stale:86_400_000, maxBytes:50_000, format:'json'},
    decode([data]) {
      const records = data?.Results?.series;
      if (data?.status !== 'REQUEST_SUCCEEDED' || !Array.isArray(records) || records.length !== 1
        || records[0]?.seriesID !== seriesId || !Array.isArray(records[0].data)
        || records[0].data.length > 40) invalid();
      const observations = [];
      for (const record of records[0].data) {
        if (typeof record?.year !== 'string' || !/^\d{4}$/.test(record.year)
          || typeof record.period !== 'string' || !/^M(?:0[1-9]|1[0-3])$/.test(record.period)) invalid();
        if (record.period === 'M13') continue;
        if (typeof record.value !== 'string' || !/^(?:-|\d+(?:\.\d+)?)$/.test(record.value)
          || !Array.isArray(record.footnotes)
          || record.footnotes.some(note => !note || typeof note !== 'object' || Array.isArray(note))) invalid();
        observations.push({
          period:record.year + '-' + record.period.slice(1),
          value:record.value === '-' ? null : Number(record.value),
          preliminary:record.footnotes.some(note => note.code === 'P'),
        });
      }
      observations.sort((a,b) => a.period.localeCompare(b.period));
      return {series, seriesId, source:BLS, url, unit, observations};
    },
    validate:(body, at) => validatePublicMacroSeries(body, series, at),
  };
}

export function validatePublicMacroSeries(body, series, receivedAt) {
  const definition = MONTHLY_SERIES.get(series);
  if (!definition || !Number.isFinite(receivedAt) || receivedAt <= 0 || receivedAt > 8.64e15
    || body?.series !== series || body.seriesId !== definition.seriesId || body.source !== BLS
    || body.url !== BLS_API + definition.seriesId || body.unit !== definition.unit
    || !Array.isArray(body.observations) || body.observations.length > 36
    || !body.observations.some(row => row && Number.isFinite(row.value))) invalid();
  const through = ny.format(receivedAt).slice(0, 7);
  let previousPeriod = '';
  for (const row of body.observations) {
    if (typeof row?.period !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.period)
      || row.period <= previousPeriod || row.period > through || typeof row.preliminary !== 'boolean'
      || (row.value !== null && (!Number.isFinite(row.value) || row.value < 0
        || (series === 'unemployment' && row.value > 100)))) invalid();
    previousPeriod = row.period;
  }
  return body;
}
