import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSeries,validateRows,validateSummary,validateShards,validateWholesale,matchingSeries,marketGroupCoverage,relatedSeries,settlementReleaseUrl} from './brain-tradfi-archive.mjs';
const read=name=>readFileSync(new URL('./brain-evidence/tradfi/'+name+'.json',import.meta.url));
const all=validateSeries(JSON.parse(read('catalog')));
test('published market observations match instrument, units, dates, and checksum',()=>{
  assert.deepEqual(new Set(all.filter(s=>s.statistic!=='oracle').map(s=>s.group==='commodity'?'commodities':s.group)),new Set(['stock','index','metals','fx','oil','commodities','rates']));
  for(const s of all){
    const bytes=read(s.id),data=JSON.parse(bytes),{id,rows}=data;
    if(['wholesaleRange','wholesaleModal'].includes(s.statistic)){
      assert.equal(createHash('sha256').update(bytes).digest('hex'),s.sha256);
      for(const shard of validateShards(s,data)){
        const payload=read(s.id+'-'+shard.month);
        assert.equal(createHash('sha256').update(payload).digest('hex'),shard.sha256);
        validateWholesale(s,shard,JSON.parse(payload));
      }
      continue;
    }
    validateRows(s,data);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),s.sha256);
    assert.equal(id,s.id);assert.equal(rows.length,s.count);assert.equal(rows[0][0],s.start);assert.equal(rows.at(-1)[0],s.end);
    let last='';
    for(const r of rows){
      assert.ok(r[0]>last&&Number.isFinite(r[1]));last=r[0];
      if(s.statistic==='reportedValuePerShare'){
        assert.ok(r[2]<=r[0]&&Number.isSafeInteger(r[3])&&Number.isSafeInteger(r[5])&&r[5]>0);
        assert.ok([1,1000].includes(r[4])&&Math.abs(r[1]-r[3]*r[4]/r[5])<0.000001);
        assert.match(r[7],/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i);
      }
      if(s.statistic==='oracle'){
        assert.match(r[3],/^0x[a-f0-9]{64}$/);assert.ok(r[2]>0&&Number.isSafeInteger(r[2]));
        assert.ok(r[4]<Date.parse(r[0])/1000+86400);assert.match(r[5],/^\d+$/);
      }
    }
    if(s.coverageMode==='sampled-trading-days'){
      assert.ok(s.count<=s.checkedTradingDays&&s.checkedTradingDays<s.calendarTradingDays);
      assert.ok(s.checkedTradingRanges.length>0&&s.sourcePeriods.length>0);
      for(const [day] of rows){
        assert.ok(s.checkedTradingRanges.some(([a,b])=>a<=day&&day<=b));
        assert.ok(s.sourcePeriods.some(([a,b])=>a<=day&&day<=b));
      }
    }else if(s.statistic==='settlementReference'){
      assert.equal(s.unit,'USD/share');assert.ok(s.start>='2016-01-01'&&s.count>0);
      for(const r of rows)assert.ok(['a','b'].some(half=>r[3]===r[0].slice(0,7).replace('-','')+half));
    }else if(s.statistic==='retailMedian'){
      assert.equal(s.unit,'EUR/L');assert.deepEqual(s.fields,['date','value','reportingStations']);
      assert.ok(s.start>='2016-01-01');
      assert.ok(rows.every(r=>r.length===3&&r[1]>0&&Number.isSafeInteger(r[2])&&r[2]>0));
    }else if(s.statistic==='dayAheadGas'){
      assert.equal(s.unit,'AUD/GJ');assert.equal(s.start,'2016-01-01');
      assert.equal(s.count,Math.round((Date.parse(s.end)-Date.parse(s.start))/86400000)+1);
    }else if(s.statistic==='ohlcv'||s.statistic==='ohlc'){
      assert.ok(s.count>=1);
      if(s.sourceStatus==='discontinued'&&s.id.startsWith('us-wiki-')){
        assert.ok(s.start>='2016-01-01'&&s.end<='2018-03-27');assert.equal(s.priceBasis,'unadjusted');
      }
    }else if(s.statistic!=='oracle'){
      if(s.id==='eurisk')assert.equal(s.start,'2018-02-01');else assert.equal(s.start.slice(0,4),'2016');
      if(s.statistic==='reportedInsiderTradePrice'){
        assert.equal(new Set(rows.map(r=>r[0].slice(0,7))).size,rows.length);
        for(const r of rows){
          assert.ok(['P','S'].includes(r[3])&&r[1]>0&&r[4]>0&&r[2]<=r[0]);
          assert.match(r[7],/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i);
        }
        assert.equal(new Set(rows.map(r=>r[0].slice(0,4))).size,Number(s.end.slice(0,4))-2016+1);
      }else{
        assert.ok(s.count>=(['dilutedEps','reportedValuePerShare'].includes(s.statistic)?30:120));
      }
    }
  }
});
test('every requested asset class includes observations in every calendar year from 2016',()=>{
  for(const group of ['stock','index','metals','fx','oil','commodities']){
    const years=new Set(all.filter(s=>s.group===group&&s.statistic!=='oracle'&&!['wholesaleRange','wholesaleModal'].includes(s.statistic)).flatMap(s=>JSON.parse(read(s.id)).rows.map(r=>Number(r[0].slice(0,4)))));
    assert.ok(years.size>=10,group);
    for(let year=2016;year<=Math.max(...years);year++)assert.ok(years.has(year),group+' '+year);
  }
});
test('related oracle pricing keeps futures, reference rates, stocks and ETFs identifiable',()=>{
  const by=id=>all.find(s=>s.id===id);
  assert.equal(by('wti').statistic,'spot');assert.ok(JSON.parse(read('wti')).rows.some(([day,v])=>day==='2020-04-20'&&v<0));
  assert.equal(by('oracle-wti').network,'arbitrum');assert.match(by('oracle-wti').en,/futures/i);
  assert.deepEqual(relatedSeries(all,by('wti')).map(s=>s.id),['oracle-wti']);
  assert.ok(relatedSeries(all,by('gold')).every(s=>s.group==='metals'));
  assert.ok(relatedSeries(all,by('oracle-aapl')).some(s=>s.id==='us-wiki-aapl'));
  const apple=relatedSeries(all,by('oracle-aapl'));
  if(by('sec-settlement-aapl'))assert.ok(apple.some(s=>s.id==='sec-settlement-aapl'));
  const taiwan=by('tw-stock-twse-2330');
  if(taiwan&&by('tsmc'))assert.ok(relatedSeries(all,taiwan).some(s=>s.id==='tsmc'));

  assert.equal(by('oracle-spy').group,'etf');assert.equal(by('oracle-gold').related,'gold');
  assert.throws(()=>validateSeries({version:1,series:[{...all[0],id:'../other'}]}));
});

test('homepage totals reconcile with independently categorized actual observations and the catalog hash',()=>{
  const sum=validateSummary(JSON.parse(read('summary')));
  assert.equal(sum.catalogSha256,createHash('sha256').update(read('catalog')).digest('hex'));
  assert.equal(sum.series,all.length);
  const groups={dailyBars:0,wholesaleQuotes:0,oracleReads:0,otherObservations:0};
  for(const s of all){
    const bucket=['wholesaleRange','wholesaleModal'].includes(s.statistic)?'wholesaleQuotes':s.statistic==='oracle'?'oracleReads':
       ['ohlcv','ohlc'].includes(s.statistic)||s.fields?.slice(0,5).join(',')==='date,close,open,high,low'?'dailyBars':'otherObservations';
    groups[bucket]+=s.count;
  }
  for(const [key,count] of Object.entries(groups))assert.equal(sum[key],count);
  if(sum.wholesaleRangeQuotes!==undefined){
    const countType=type=>all.reduce((n,s)=>n+(s.statistic===type?s.count:0),0);
    assert.equal(sum.wholesaleRangeQuotes,countType('wholesaleRange'));
    assert.equal(sum.weightedMarketQuotes,countType('wholesaleModal'));
  }
  assert.throws(()=>validateSummary({...sum,count:sum.count+1}));
  assert.throws(()=>validateSummary({...sum,wholesaleRangeQuotes:0,weightedMarketQuotes:sum.wholesaleQuotes+1}));
  const grouped=validateSummary({...sum,wholesaleRangeQuotes:sum.wholesaleQuotes,weightedMarketQuotes:0});
  assert.equal(grouped.wholesaleRangeQuotes,sum.wholesaleQuotes);
});
test('category overview preserves mixed instruments, actual ranges and bar counts',()=>{
  const meta=validateSummary(JSON.parse(read('summary'))),actual=marketGroupCoverage(all);
  assert.deepEqual(validateSummary({...meta,perGroup:actual}).perGroup,actual);
  assert.equal(Object.values(actual).reduce((n,g)=>n+g.count,0),meta.count);
  assert.equal(Object.values(actual).reduce((n,g)=>n+g.dailyBars,0),meta.dailyBars);
  assert.ok(actual.stock.count>actual.stock.dailyBars&&actual.commodities.count>actual.commodities.dailyBars);
  assert.ok(!Object.hasOwn(actual,'commodity'));
  for(const key of ['stock','metals','oil','fx','index','commodities','etf','rates']){
    const data=all.filter(s=>(s.group==='commodity'?'commodities':s.group)===key);
    assert.equal(actual[key].start,data.map(s=>s.start).sort()[0]);
    assert.equal(actual[key].end,data.map(s=>s.end).sort().at(-1));
    if(meta.perGroup)for(const field of ['count','dailyBars','start','end'])assert.equal(meta.perGroup[key][field],actual[key][field]);
  }
  assert.throws(()=>validateSummary({...meta,perGroup:{...actual,oil:{...actual.oil,count:actual.oil.count+1}}}));
  assert.throws(()=>validateSummary({...meta,perGroup:{...actual,oil:{...actual.oil,start:'invalid'}}}));
});
test('search finds exact tickers beyond the display window and handles aliases and Chinese names',()=>{
  const entries=Array.from({length:3200},(_,i)=>({id:'asset-'+i,group:'stock',en:'Asset '+i,zh:'样本'}));
  entries.push({id:'us-wiki-xyz',symbol:'XYZ',en:'Mint XYZ',zh:'薄荷',group:'stock'});
  entries.push({id:'mandi-wheat',en:'India wholesale · Wheat',zh:'小麦',group:'commodity'});
  assert.equal(matchingSeries(entries,'','').matches.length,75);
  assert.equal(matchingSeries(entries,'','').count,3202);
  assert.equal(matchingSeries(entries,'xyz','stock').matches[0].id,'us-wiki-xyz');
  assert.equal(matchingSeries(entries,'小麦','commodities').matches[0].id,'mandi-wheat');
  assert.equal(matchingSeries(entries,'xyz','commodities').count,0);
});
test('reject corrupt market-month references and invalid venue sessions',()=>{
  const sha='a'.repeat(64),s={id:'sample',start:'2024-02-29',end:'2024-02-29',count:1};
  const sh={month:'2024-02',start:s.start,end:s.end,count:1,sha256:sha};
  assert.equal(validateShards(s,{id:s.id,shards:[sh]}).length,1);
  assert.throws(()=>validateShards(s,{id:s.id,shards:[{...sh,month:'../../bad'}]}));
  const market={id:s.id,month:sh.month,locations:[['A','B','M','V','G']],rows:[[29,0,4,3,5]]};
  assert.equal(validateWholesale(s,sh,market),market);
  for(const row of [[30,0,4,3,5],[29,1,4,3,5],[29,0,4,5,3],[29,0,4,0,5]])
    assert.throws(()=>validateWholesale(s,sh,{...market,rows:[row]}));
  const aggregate={...s,statistic:'wholesaleModal'};
  const weighted={...market,locations:[['State','District','Market']],rows:[[29,0,12.5]]};
  assert.equal(validateWholesale(aggregate,sh,weighted),weighted);
  assert.throws(()=>validateWholesale(aggregate,sh,market));
  const bullion={id:'gold-market',statistic:'goldSpotTrade',count:2,start:'2016-01-04',end:'2026-11-26'};
  const bullionRows={id:bullion.id,rows:[[bullion.start,4251.6,4251.6,4230.1,4235.3,240,1016469,8,24],[bullion.end,14238,14345,14187,14275.4,2090,29835683,271,2090]]};
  assert.equal(validateRows(bullion,bullionRows),bullionRows.rows);
  assert.throws(()=>validateRows(bullion,{...bullionRows,rows:bullionRows.rows.map(r=>[...r.slice(0,8),1])}));
  assert.equal(settlementReleaseUrl('201601a'),'https://www.sec.gov/files/data/frequently-requested-foia-document-fails-deliver-data/cnsfails201601a.zip');
  assert.match(settlementReleaseUrl('201706a'),/document-fails-deliver-data\/cnsfails201706a.zip$/);
  assert.equal(settlementReleaseUrl('201706b'),'https://www.sec.gov/files/data/fails-deliver-data/cnsfails201706b.zip');
  assert.throws(()=>settlementReleaseUrl('201613b'));
  const amended='https://www.sec.gov/files/data/other/fails-deliver-data/cnsfails202308b_0.zip';
  assert.equal(settlementReleaseUrl('202308b',{'202308b':amended}),amended);
  for(const href of [amended.replace('sec.gov','sec.gov.example'),amended.replace('202308b','202308a'),amended+'?unsafe=1'])
    assert.throws(()=>settlementReleaseUrl('202308b',{'202308b':href}));
  const settlement={...s,statistic:'settlementReference'},position={id:s.id,rows:[[s.start,10.25,500,'202402b']]};
  assert.equal(validateRows(settlement,position),position.rows);
  for(const r of [[s.start,10,500,'202403a'],[s.start,10,0,'202402b'],[s.start,0,500,'202402b']])
    assert.throws(()=>validateRows(settlement,{...position,rows:[r]}));
  const bank={...s,statistic:'bankBidAsk'},quote={id:s.id,rows:[[s.start,1305,1324]]};
  assert.equal(validateRows(bank,quote),quote.rows);
  for(const row of [[s.start,0,10],[s.start,10,9],[s.start,10]])assert.throws(()=>validateRows(bank,{...quote,rows:[row]}));
  const gas={...s,statistic:'dayAheadGas'},clearing={id:s.id,rows:[[s.start,4.559]]};
  assert.equal(validateRows(gas,clearing),clearing.rows);
  assert.throws(()=>validateRows(gas,{...clearing,rows:[[s.start,4,3]]}));
  const retail={...s,statistic:'retailMedian'};
  const median={id:s.id,rows:[[s.start,1.68,12]]};
  assert.equal(validateRows(retail,median),median.rows);
  for(const row of [[s.start,0,12],[s.start,1.68,0],[s.start,1.68,1.5],[s.start,1.68]])assert.throws(()=>validateRows(retail,{...median,rows:[row]}));
  const item={...s,statistic:'ohlcv',priceBasis:'nearestTradedFuturesMonth'};
  const good={id:s.id,rows:[[s.start,10,9,11,8,50,'202402',20,30]]};
  assert.equal(validateRows(item,good),good.rows);
  assert.throws(()=>validateRows(item,{id:s.id,rows:[[s.start,10,9,8,8,50,'202402',20,30]]}));
  assert.throws(()=>validateRows(item,{id:s.id,rows:[[s.start,10,9,11,8,55,'202402',20,30]]}));
});
