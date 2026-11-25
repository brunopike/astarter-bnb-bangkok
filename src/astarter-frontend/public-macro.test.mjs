import test from 'node:test';
import assert from 'node:assert/strict';
import {publicMacroRequest, publicMacroSeriesRequest, validatePublicMacro, validatePublicMacroSeries} from './public-macro.mjs';

const checkedAt = Date.parse('2026-11-01T03:30:00Z');
const request = () => publicMacroRequest(new URLSearchParams(), checkedAt);
const wrapBea = content => 'BEGIN:VCALENDAR\r\n' + content + 'END:VCALENDAR\r\n';
const wrapFred = content => '<div id="release-dates-pager">' + content + '</div>All times are US Central Time';
const emptyFred = wrapFred('No release dates are available for the selected options.');
const meeting = (month, date) => `<div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div>
<div class="fomc-meeting__date col-xs-4">${date}</div>`;
const wrapFed = content => '<a id="1">2026 FOMC Meetings</a>' + content;
const bea = wrapBea('BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:GDP\\, advance\r\n  estimate\r\nDTSTART;VALUE=DATE-TIME:20261101T013000Z\r\nEND:VEVENT\r\n'
  + 'BEGIN:VEVENT\r\nUID:2\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n'
  + 'BEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Date only\r\nDTSTART;VALUE=DATE:20261031\r\nEND:VEVENT\r\n');
const fed = wrapFed(meeting('October/November','31-1*'));
const fred = wrapFred(`<span>Friday October 30, 2026</span> <span>Updated</span></td></tr>
<tr><td>7:30 am</td><td><a href="/release?rid=10">Consumer Price Index</a>
<span>Monday November 02, 2026</span></td></tr>
<tr><td>7:30 am</td><td><a href="/release?rid=10">Consumer Price Index</a>
Releases 1 - 2 of 2`);

test('macro exposes fixed source policies and preserves official date precision', () => {
  const {key,resource,policy,decode} = request();
  assert.equal(key, 'macro');
  assert.equal(resource, 'macro');
  assert.equal(policy.format, 'text');
  assert.equal(policy.parallel, true);
  assert.equal(policy.urls.length, 4);
  assert.ok(policy.urls.every(source => source.optional));
  assert.equal(publicMacroRequest(new URLSearchParams('url=https://example.com'), checkedAt), null);
  const body = validatePublicMacro(decode([bea, fed, fred, emptyFred]));
  assert.equal(body.timeZone, 'America/New_York');
  assert.equal(body.calendarStart, '2026-10-01');
  assert.equal(body.calendarEnd, '2027-01-29');
  assert.deepEqual(body.events.map(({title,date,time,scheduledAt,precision}) => [title,date,time,scheduledAt,precision]), [
    ['Consumer Price Index','2026-10-30','08:30','2026-10-30T12:30:00.000Z','time'],
    ['GDP, advance estimate','2026-10-31','21:30','2026-11-01T01:30:00.000Z','time'],
    ['Date only','2026-10-31',null,null,'date'],
    ['FOMC meeting concludes','2026-11-01',null,null,'date'],
    ['Consumer Price Index','2026-11-02','08:30','2026-11-02T13:30:00.000Z','time'],
  ]);
  for (const {actual,previous,forecast} of body.events) assert.deepEqual([actual,previous,forecast], [null,null,null]);
});

test('macro distinguishes valid empty dates from broken upstream documents', () => {
  const {decode} = request();
  const empty = decode([wrapBea(''), wrapFed(meeting('January','27-28')), emptyFred, emptyFred]);
  assert.deepEqual(empty.events, []);
  assert.ok(empty.sources.every(source => source.status === 'available'));

  const partial = validatePublicMacro(decode(['<html>Access Denied</html>', fed, fred, null]));
  assert.deepEqual(partial.sources.map(source => source.status), ['unavailable','available','partial']);
  assert.deepEqual(partial.events.map(event => event.source), ['fred','fed','fred']);

  assert.throws(() => decode([bea.replace('20261101','20261131'), '<html>Access Denied</html>',
    fred.replace('1 - 2 of 2','1 - 2 of 4'), null]), /INVALID_DATA/);
  assert.throws(() => decode([null, null, null, null]), /INVALID_DATA/);
});

test('macro client validator checks source URLs and event-time consistency', () => {
  const body = request().decode([bea, fed, fred, emptyFred]);
  const [row] = body.events;
  for (const changes of [
    {time:'09:00'}, {actual:0}, {sourceUrl:'https://example.com'}, {sourceUrl:'javascript:alert(1)'},
  ]) assert.throws(() => validatePublicMacro({...body, events:[{...row,...changes}]}), /INVALID_DATA/);
});

test('macro series allows only fixed BLS selections and preserves months and official missing observations', () => {
  for (const query of ['','series=cpi&series=cpi','series=cpi&url=https://example.com','series=CPI','series=__proto__']) {
    assert.equal(publicMacroSeriesRequest(new URLSearchParams(query), checkedAt), null);
  }
  const definitions = [['cpi','CUSR0000SA0','index'],['unemployment','LNS14000000','percent'],
    ['payrolls','CES0000000001','thousands']];
  for (const [series,seriesId,unit] of definitions) {
    const request = publicMacroSeriesRequest(new URLSearchParams({series}), checkedAt);
    assert.equal(request.key, 'macro-series:' + series);
    assert.equal(request.resource, 'macro-series');
    assert.equal(request.policy.url, 'https://api.bls.gov/publicAPI/v2/timeseries/data/' + seriesId);
    const body = request.validate(request.decode([{
      status:'REQUEST_SUCCEEDED',
      Results:{series:[{seriesID:seriesId, data:[
        {year:'2026', period:'M10', value:'4.1', footnotes:[{code:'P',text:'Preliminary.'}]},
        {year:'2025', period:'M13', value:'3.9', footnotes:[]},
        {year:'2025', period:'M10', value:'-', footnotes:[{code:'X',text:'Data unavailable'}]},
      ]}]},
    }]), checkedAt);
    assert.equal(body.seriesId, seriesId);
    assert.equal(body.unit, unit);
    assert.deepEqual(body.observations, [
      {period:'2025-10',value:null,preliminary:false},
      {period:'2026-10',value:4.1,preliminary:true},
    ]);
  }
});

test('macro series rejects BLS errors, unexpected series and invalid observation revisions', () => {
  const request = publicMacroSeriesRequest(new URLSearchParams('series=unemployment'), checkedAt);
  const record = {year:'2026',period:'M10',value:'4.1',footnotes:[{}]};
  const data = (seriesID, records) => ({status:'REQUEST_SUCCEEDED', Results:{series:[{seriesID,data:records}]}});
  for (const input of [{status:'REQUEST_NOT_PROCESSED'}, data('CUSR0000SA0',[record]),
    data('LNS14000000',[{...record,value:'NaN'}]), data('LNS14000000',[{...record,period:'M14'}])]) {
    assert.throws(() => request.decode([input]), /INVALID_DATA/);
  }
  const body = request.decode([data('LNS14000000',[record])]);
  const [observation] = body.observations;
  assert.throws(() => validatePublicMacroSeries(body, 'cpi', checkedAt), /INVALID_DATA/);
  assert.throws(() => request.validate({...body,url:'https://example.com'},checkedAt), /INVALID_DATA/);
  for (const observationList of [
    [], [observation,observation], [{...observation,value:null}], [{...observation,value:101}],
    [{...observation,period:'2026-11'}], [{...observation,preliminary:'true'}],
  ]) assert.throws(() => request.validate({...body,observations:observationList},checkedAt), /INVALID_DATA/);
});

function blsRelease({kind='cpi',title='CONSUMER PRICE INDEX',previous='0.6',actual='0.4',date='November 10, 2026',reference='OCTOBER 2026',prior='Sep.',current='Oct.'}={}){
 const cpi=kind==='cpi',id=cpi?'cpi_pressa':'cps_empsit_sum',rowId=cpi?'cpi_pressa.r.1':'cps_empsit_sum.r.2.1.3.1',group=cpi?' headers="cpi_pressa.h.1.2"':'';
 return `<pre>Transmission of material in this news release is embargoed until
8:30 a.m. (ET) Tuesday, ${date}
${title} - ${reference}
</pre><table id="${id}"><caption>${cpi?'Seasonally adjusted changes from preceding month':'Summary table A. Household data, seasonally adjusted'}</caption>
<thead><tr><th${group} id="p">${prior}<br>2026</th><th${group} id="a">${current}<br>2026</th></tr></thead><tbody><tr><th id="${rowId}">${cpi?'All items':'Unemployment rate'}</th>
<td headers="${rowId} p">${previous}</td><td headers="${rowId} a">${actual}</td></tr></tbody></table>`;
}
const releaseAt=Date.parse('2026-11-18T12:00:00Z');
const datedFred=(rid,title,day)=>wrapFred(`<span>Friday November ${day}, 2026</span></td></tr><tr><td>7:30 am</td><td><a href="/release?rid=${rid}">${title}</a></td></tr>Releases 1 - 1 of 1`);
function releaseCalendar(){
 const r=publicMacroRequest(new URLSearchParams(),releaseAt);
 const body=r.decode([wrapBea(''),wrapFed(meeting('October','27-28')+meeting('December','8-9')),datedFred(10,'Consumer Price Index',10),datedFred(50,'Employment Situation',6)]);
 return {r,body,archives:r.archives(body,releaseAt)};
}
const fedDecision=body=>`<p class="article__time">October 28, 2026</p><h3 class="title">Federal Reserve issues FOMC statement</h3><p>${body}</p>`;
test('matched date-specific official releases preserve original month values, reported zero, and pre-decision range',()=>{
 const {r,body,archives}=releaseCalendar();
 assert.deepEqual(archives.map(a=>a.url),[
  'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm',
  'https://www.bls.gov/news.release/archives/empsit_11062026.htm','https://www.bls.gov/news.release/archives/cpi_11102026.htm'
 ]);
 r.applyArchives(body,archives,[fedDecision('The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.'),
  blsRelease({kind:'empsit',title:'THE EMPLOYMENT SITUATION',date:'November 6, 2026',actual:'4.1',previous:'4.2'}),blsRelease({actual:'0.0'})]);
 validatePublicMacro(body,releaseAt);
 const [fed,jobs,cpi,future]=body.events;
 assert.deepEqual([fed.actual,fed.previous],[[3.75,4],[4,4.25]]);
 assert.deepEqual([jobs.actual,jobs.previous,jobs.release.period],[4.1,4.2,'2026-10']);assert.deepEqual([cpi.actual,cpi.previous],[0,0.6]);
 assert.ok(body.events.every(e=>e.forecast===null));assert.equal(future.actual,null);
 for(const patch of [{release:{...cpi.release,url:jobs.release.url}},{release:{...cpi.release,period:'2026-12'}},{actual:'0'},{forecast:0.5}]){
  assert.throws(()=>validatePublicMacro({...body,events:[{...cpi,...patch}]},releaseAt),/INVALID_DATA/);
 }
 assert.throws(()=>validatePublicMacro({...body,events:[cpi]},Date.parse('2026-11-10T12:00Z')),/INVALID_DATA/);
});
test('a missing, wrongly dated or mismatched archive leaves the schedule intact and cannot supply a value',()=>{
 const {r,body,archives}=releaseCalendar(),event=body.events[2];
 for(const wrong of [blsRelease({date:'November 11, 2026'}),blsRelease({reference:'DECEMBER 2026'}),blsRelease({current:'Aug.'}),blsRelease().replace('All items','All items less food and energy'),blsRelease().replace('id="cpi_pressa.r.1"','id="other"'),null]){
  r.applyArchives(body,[archives[2]],[wrong]);assert.equal(event.actual,null);
 }
 r.applyArchives(body,[archives[2]],[blsRelease({previous:'-'})]);assert.deepEqual([event.actual,event.previous],[0.4,null]);
 const fed=body.events[0];r.applyArchives(body,[archives[0]],[fedDecision('One member preferred to raise the target range for the federal funds rate to 5 to 5-1/4 percent.')]);assert.equal(fed.actual,null);
 r.applyArchives(body,[archives[0]],[fedDecision('The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent.')]);assert.deepEqual(fed.actual,fed.previous);
});

import {createMarketHubRelay} from './market-hub-relay.mjs';
import {createLiveDataViews} from './data-live-views.mjs';
test('ALFRED restores release-day CPI and employment observations when BLS archives return 403',async ()=>{
 const source={
  CPIAUCSL:{'2026-11-09':['334.131','336.298'],'2026-11-10':['334.131','336.298','337.476']},
  UNRATE:{'2026-11-05':['4.1','4.2'],'2026-11-06':['4.1','4.2','4.1']},
 };
 const at=Date.parse('2026-11-10T15:00:00Z');
 for(const sameLatest of [false,true]){
  const requestedVintages=new Set(),vintagesDuringArchive=[];
  const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url)=>{
   const parsed=new URL(url),key=parsed.searchParams.get('id'),date=parsed.searchParams.get('vintage_date');
   if(parsed.hostname==='alfred.stlouisfed.org'){
    requestedVintages.add(key+':'+date);
    const values=sameLatest&&key==='CPIAUCSL'&&date==='2026-11-09'?source.CPIAUCSL['2026-11-10']:source[key][date];
    const rows=values.map((value,i)=>'2026-'+String(8+i).padStart(2,'0')+'-01,'+value);
    return new Response(['observation_date,'+key+'_'+date.replaceAll('-',''),...rows].join('\n'));
   }
   if(url.includes('bea.gov'))return new Response(wrapBea(''));
   if(url.includes('fomccalendars'))return new Response(wrapFed(meeting('October','27-28')));
   if(url.includes('rid=10'))return new Response(datedFred(10,'Consumer Price Index',10));
   if(url.includes('rid=50'))return new Response(datedFred(50,'Employment Situation',6));
   if(parsed.hostname==='www.bls.gov'){
    await new Promise(resolve=>setImmediate(resolve));
    const key=parsed.pathname.includes('/cpi_')?'CPIAUCSL':'UNRATE';
    vintagesDuringArchive.push([...requestedVintages].filter(request=>request.startsWith(key+':')).length);
    return new Response('',{status:403});
   }
   return new Response('',{status:503});
  }});
  let receipt;
  await handle({url:'/api/market-hub?resource=macro',method:'GET'},{writeHead(status){assert.equal(status,200);},end(data){receipt=JSON.parse(data);}});
  assert.deepEqual(vintagesDuringArchive,[2,2]);
  const cpi=receipt.body.events.find(event=>event.id==='fred:10:2026-11-10');
  const jobs=receipt.body.events.find(event=>event.id==='fred:50:2026-11-06');
  assert.deepEqual([jobs.actual,jobs.previous,jobs.release?.period],[4.1,4.2,'2026-10']);
  assert.equal(new URL(jobs.release.vintageUrl).searchParams.get('vintage_date'),jobs.date);
  if(sameLatest){assert.equal(cpi.actual,null);assert.equal(cpi.release,undefined);continue;}
  assert.deepEqual([cpi.actual,cpi.previous,cpi.release?.period],[0.4,0.6,'2026-10']);
  assert.equal(new URL(cpi.release.vintageUrl).searchParams.get('vintage_date'),cpi.date);
  assert.throws(()=>validatePublicMacro({...receipt.body,events:[{...cpi,release:{...cpi.release,vintageUrl:jobs.release.vintageUrl}}]},at),/INVALID_DATA/);
 }
});
test('public relay and past calendar show sourced releases, with no forecast, and retain a failed archive as schedule-only',async t=>{
 const at=Date.parse('2026-11-10T15:00:00Z'),calls=[];
 const handle=createMarketHubRelay({now:()=>at,fetchImpl:async(url,options)=>{
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');calls.push(url);
  if(url.includes('bea.gov'))return new Response(wrapBea(''));
  if(url.includes('fomccalendars'))return new Response(wrapFed(meeting('October','27-28')));
  if(url.includes('rid=10'))return new Response(datedFred(10,'Consumer Price Index',10));
  if(url.includes('rid=50'))return new Response(datedFred(50,'Employment Situation',6));
  if(url.endsWith('monetary20261028a.htm'))return new Response(fedDecision('The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent.'));
  if(url.endsWith('cpi_11102026.htm'))return new Response(blsRelease());
  return new Response('',{status:503});
 }});
 let receipt;
 await handle({url:'/api/market-hub?resource=macro',method:'GET'},{writeHead(status){assert.equal(status,200);},end(data){receipt=JSON.parse(data);}});
 const vintageSeries=calls.filter(url=>url.includes('alfred.stlouisfed.org')).map(url=>new URL(url).searchParams.get('id'));
 assert.equal(calls.length,11);
 assert.deepEqual(vintageSeries.sort(),['CPIAUCSL','CPIAUCSL','UNRATE','UNRATE']);
 assert.equal(receipt.body.events.filter(e=>e.release).length,2);
 const keys=['document','location','navigator'],old=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
 for(const [k,v] of Object.entries({document:{hidden:false,addEventListener(){},querySelector(){return null;},activeElement:null},location:{search:'?page=intelligence&view=calendar&when=past'},navigator:{onLine:true}}))Object.defineProperty(globalThis,k,{configurable:true,value:v});
 t.after(()=>keys.forEach((key,i)=>{if(old[i])Object.defineProperty(globalThis,key,old[i]);else delete globalThis[key];}));
 let html='';
 const view=createLiveDataViews({now:()=>at,root:{contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]},link:name=>name,section:(title,content)=>title+content,table:(heads,rows)=>heads.join(' ')+rows.join(''),stat:()=>'',chartPanel:()=>'',empty:text=>text,rerender:()=>{html=view.render('intelligence');},fetchImpl:async()=>Response.json(receipt)});
 view.render('intelligence');await new Promise(resolve=>setImmediate(resolve));
 assert.match(html,/0\.4%.*0\.6%/);assert.match(html,/3\.75–4%/);assert.match(html,/2026-10/);
 assert.match(html,/href="https:\/\/www\.bls\.gov\/news\.release\/archives\/cpi_11102026\.htm"/);assert.match(html,/Consensus forecasts are unavailable|市场共识预期暂无来源/);assert.match(html,/Employment Situation/);
 const releaseRow=html.match(/<tr>[^]*?<\/tr>/g).find(entry=>entry.includes('cpi_11102026.htm'));
 assert.match(releaseRow,/<td class="dc-calendar-date">2026-11-10<\/td>/);
 assert.match(releaseRow,/<td class="dc-calendar-time">08:30<\/td>/);
 assert.match(releaseRow,/<td class="dc-calendar-event">[^<]*CPI/);
 assert.match(releaseRow,/<td class="dc-calendar-actual">.*0\.4%/);
 assert.match(releaseRow,/<td class="dc-calendar-previous">.*0\.6%/);
 assert.match(releaseRow,/<td class="dc-calendar-source"><a [^>]*href="[^"]*cpi_11102026.htm"/);
 globalThis.location.search='?page=intelligence&view=calendar&when=upcoming';html=view.render('intelligence');assert.doesNotMatch(html,/0\.4%|cpi_11102026/);
});
