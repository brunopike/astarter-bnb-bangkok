import assert from 'node:assert/strict';
import test from 'node:test';
import {publicEtfRequest,validatePublicEtf} from './public-etf.mjs';
import {liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';

const now = Date.parse('2026-11-18T04:00:00Z');
const license = 'https://creativecommons.org/licenses/by/4.0/';
const request = asset => publicEtfRequest(new URLSearchParams({asset}), now);
const archive = () => publicEtfRequest(new URLSearchParams({asset:'eth', series:'archive'}));
const bitcoin = (...days) => ({license, units:'USD', days, updatedThrough:days.map(x => x.date).sort().at(-1)});
const ethereum = (...daily) => ({
  license:'CC-BY-4.0', units:'US$ millions', funds:['ETHA','FETH'],
  coverage:[daily[0].date, daily.at(-1).date], daily
});

test('ETF relay accepts exactly one supported asset and uses fixed public sources', () => {
  assert.equal(request('BTC').key, 'etf:btc');
  assert.equal(request('eth').resource, 'etf');
  assert.equal(request('btc').policy.url, 'https://www.tftc.io/bitcoin-etf-flows/data.json');
  assert.equal(request('eth').policy.url, 'https://coinclass.com/eth-etf');
  assert.equal(request('eth').policy.format, 'text');
  assert.equal(archive().policy.url, 'https://growyourethereum.com/datasets/eth-etf-flows.json');
  for (const query of ['', 'asset=sol', 'asset=btc&asset=eth', 'asset=btc&url=example.com', 'asset=btc&series=archive', 'asset=eth&series=unpublished', 'asset=eth&series=archive&series=archive']) {
    assert.equal(publicEtfRequest(new URLSearchParams(query), now), null);
  }
});

test('bitcoin retains exact source amounts, zeros and missing fund reports', () => {
  const data = bitcoin(
    {date:'2026-11-17', netFlowUsd:null, perEtfUsd:{IBIT:null}},
    {date:'2026-11-16', netFlowUsd:-1234567.5, perEtfUsd:{IBIT:-1234567.5, FBTC:0}},
    {date:'2026-11-13', netFlowUsd:0, perEtfUsd:null}
  );
  const body = request('btc').decode([data], now);
  assert.equal(body.unit, 'USD');
  assert.equal(body.coverage.latestStatus, 'pending');
  assert.equal(body.coverage.sessions, 3);
  assert.deepEqual(body.funds, ['FBTC','IBIT']);
  assert.deepEqual(body.days, [
    {date:'2026-11-13', totalUsd:0, funds:{FBTC:null, IBIT:null}},
    {date:'2026-11-16', totalUsd:-1234567.5, funds:{FBTC:0, IBIT:-1234567.5}},
    {date:'2026-11-17', totalUsd:null, funds:{FBTC:null, IBIT:null}}
  ]);
});

test('ether converts reported millions to USD and labels older data historical', () => {
  const data = ethereum({date:'2026-10-23', total:4.4, funds:{ETHA:null, FETH:4.4}});
  const body = archive().decode([data], now);
  assert.equal(body.coverage.latestStatus, 'historical');
  assert.equal(body.coverage.datasetThrough, '2026-10-23');
  assert.equal(body.source.licenseUrl, license);
  assert.deepEqual(body.days, [{date:'2026-10-23', totalUsd:4400000, funds:{ETHA:null, FETH:4400000}}]);
});

test('latest 60 source sessions are sorted by date', () => {
  const dates = Array.from({length:100}, (_, i) => new Date(Date.UTC(2026, 5, i + 1)))
    .filter(date => date.getUTCDay() > 0 && date.getUTCDay() < 6)
    .map(date => date.toISOString().slice(0, 10));
  const rows = dates.toReversed().map(date => ({date, netFlowUsd:1}));
  const {days} = request('btc').decode([bitcoin(...rows)], now);
  assert.deepEqual(days.map(day => day.date), dates.slice(-60));
});

test('bad or unrelated source payloads fail closed', () => {
  const valid = {date:'2026-11-16', netFlowUsd:0};
  for (const input of [
    {},
    bitcoin(),
    bitcoin(valid, valid),
    bitcoin({...valid, netFlowUsd:'0'}),
    bitcoin({...valid, netFlowUsd:null}),
    bitcoin({...valid, perEtfUsd:{'<<':1}}),
    bitcoin({...valid, date:'2026-11-31'}),
    bitcoin({date:valid.date, totalNetAssetsUsd:12, volume:1}),
    {...bitcoin(valid), license:'reserved'},
    {...bitcoin(valid), updatedThrough:'2026-11-17'}
  ]) {
    assert.throws(() => request('btc').decode([input], now), /ETF/);
  }
});

function matrix(headers, rows) {
  return '<section id="matrix"><h2>Daily Flow Matrix — Last 10 Sessions</h2><p>Net flow per fund per day · million USD</p><table><thead><tr>'+
    headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(cells=>'<tr>'+cells.map(v=>'<td class="flow">'+v+'</td>').join('')+'</tr>').join('')+'</tbody></table></section>';
}

const headers=['Date','ETHA','ETHB','ETHW','TETH','TOTAL'];
const latest=['2026-11-17','-27.6','-2.8','1.3','0.0','-29.1'];
const previous=['2026-11-16','—','0.0','0.0','1.2','1.3'];

test('current ETH cash quotes the dated matrix, preserves source precision, totals and missing reports, and leaves history distinct',()=>{
  const html='<table><tr><td>TETH</td><td>1.2</td></tr></table>'+matrix(headers,[previous,latest,['2026-11-13','0','0','0','0','0']]);
  const data=request('eth').decode([html],now);
  assert.equal(data.source.name,'CoinClass');
  assert.equal(data.source.url,'https://coinclass.com/eth-etf#matrix');
  assert.equal(data.source.precisionUsd,100000);
  assert.deepEqual(data.days,[
    {date:'2026-11-13',totalUsd:0,funds:{ETHA:0,ETHB:0,ETHW:0,TETH:0}},
    {date:'2026-11-16',totalUsd:1300000,funds:{ETHA:null,ETHB:0,ETHW:0,TETH:1200000}},
    {date:'2026-11-17',totalUsd:-29100000,funds:{ETHA:-27600000,ETHB:-2800000,ETHW:1300000,TETH:0}}
  ]);
  assert.equal(data.coverage.latestStatus,'reported');
  const route=liveDataRoute('etf','asset=eth&view=flows');
  assert.deepEqual(route.query,{asset:'eth'});
  const historical=liveDataRoute('etf','asset=eth&view=archive');
  assert.deepEqual(historical.query,{asset:'eth',series:'archive'});
  assert.deepEqual(liveDataRoute('etf','asset=eth&range=7').query,historical.query);
  assert.deepEqual(liveDataRoute('etf','fund=MSSE').query,{asset:'eth',fund:'MSSE'});
  const envelope={schema:'public-market-relay-v1',resource:'etf',receivedAt:now,body:data};
  assert.equal(validateLiveDataResponse(envelope,route,now).asOf,Date.parse('2026-11-17'));
  assert.throws(()=>validateLiveDataResponse(envelope,historical,now),/INVALID_DATA/);
  const wrong=structuredClone(data);wrong.source.url='https://example.org/';
  assert.equal(validatePublicEtf(wrong,'eth',now),false);
});

test('current ETF cash flags partial and old sessions and rejects source format drift',()=>{
  const pending=request('eth').decode([matrix(headers,[latest.map((v,i)=>i===1?'Pending':v)])],now);
  assert.equal(pending.coverage.latestStatus,'pending');
  assert.equal(pending.days[0].funds.ETHA,null);
  assert.equal(pending.days[0].totalUsd,-29100000);
  const old=request('eth').decode([matrix(headers,[latest])],now+10*86400000);
  assert.equal(old.coverage.latestStatus,'historical');
  for(const html of [matrix(headers,[latest]).replace('million USD','ETH'),matrix(headers,[latest]).replace('id="matrix"','id="funds"'),
    matrix(['Date','ETHA','ETHA','ETHW','TETH','TOTAL'],[latest]),matrix(headers,[latest,latest]),
    matrix(headers,[latest.slice(0,-1)]),matrix(headers,[[...latest.slice(0,-1),'29.1']]),matrix(headers,[['2026-11-19',...latest.slice(1)]]),matrix(headers,[latest.map((v,i)=>i===1?'unknown':v)])]){
    assert.throws(()=>request('eth').decode([html],now),/ETF/);
  }
});

test('fund history reconciles dated reports, handles a New Year boundary and never infers zero',async()=>{
  const at=Date.parse('2027-01-06T14:00:00Z');
  const matrixHtml=matrix(headers,[['2027-01-04','-2.0','0','0','0','-2.0'],['2027-01-05','—','0','0','0','0']]);
  const chart=entries=>'<link rel="canonical" href="https://coinclass.com/etf/fund/ETHA">'+
    '<section id="flows"><h2>ETHA<!-- --> Daily Net Flow — Last 60 Trading Days</h2>'+
    '<p>Creations above the line, redemptions below · million USD</p><svg>'+
    entries.map(entry=>'<rect><title>'+entry+'</title></rect>').join('')+'</svg></section>';
  const fund=publicEtfRequest(new URLSearchParams({asset:'eth',fund:'ETHA'}));
  const report=fund.decode([matrixHtml,chart(['Dec 31: +$1.2M net flow','Jan 4: -$2.0M net flow'])],at);
  assert.deepEqual(report.days.map(d=>[d.date,d.totalUsd,d.funds.ETHA]),[
    ['2026-12-31',null,1200000],['2027-01-04',null,-2000000],['2027-01-05',null,null]
  ]);
  assert.equal(report.coverage.latestStatus,'pending');
  assert.equal(report.source.fundUrl,'https://coinclass.com/etf/fund/etha');
  assert.ok(validatePublicEtf(report,'eth',at,undefined,'ETHA'));
  assert.equal(validatePublicEtf(report,'eth',at,undefined,'TETH'),false);
  for(const candidate of [null,chart(['Jan 4: -$1.9M net flow']),chart(['Dec 31: +$0.0M net flow']),chart(['Jan 4: -$2.0M net flow']).replace('ETHA<!--','ETHB<!--')]){
    const fallback=fund.decode([matrixHtml,candidate],at);
    assert.deepEqual(fallback.days.map(d=>d.date),['2027-01-04','2027-01-05']);
    assert.equal(fallback.source.fundUrl,null);
  }
  const lower='https://coinclass.com/etf/fund/etha',canonical='https://coinclass.com/etf/fund/ETHA';
  const valid=chart(['Dec 31: +$1.2M net flow','Jan 4: -$2.0M net flow']);
  for (const [primary,alternate,expectedUrl] of [[valid,valid,lower],[null,valid,canonical],[null,null,null]]) {
    const calls=[];
    const body=await fund.collect(async spec=>{
      if(typeof spec==='string')return matrixHtml;
      calls.push(spec.url);
      return spec.url===lower?primary:alternate;
    },()=>at);
    assert.deepEqual(calls,primary?[lower]:[lower,canonical]);
    assert.equal(body.source.fundUrl,expectedUrl);
    assert.equal(body.days.length,expectedUrl?3:2);
    assert.ok(validatePublicEtf(body,'eth',at,undefined,'ETHA'));
  }
  for(const params of ['asset=eth&fund=NOTAFUND','asset=eth&fund=ETHA&fund=ETHB','asset=btc&fund=ETHA','asset=eth&fund=ETHA&series=archive']){
    assert.equal(publicEtfRequest(new URLSearchParams(params)),null);
  }
});
