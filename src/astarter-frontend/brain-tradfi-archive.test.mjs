import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSeries,validateRows,validateSummary,validateShards,validateWholesale,validateMarketQuarters,validateMarketTickers,matchingSeries,marketCountRows,linkedTaiwanBars,marketGroupCoverage,relatedSeries,settlementReleaseUrl} from './brain-tradfi-archive.mjs';
const read=name=>readFileSync(new URL('./brain-evidence/tradfi/'+name+'.json',import.meta.url));
const all=validateSeries(JSON.parse(read('catalog')));
test('published market observations match instrument, units, dates, and checksum',()=>{
  assert.deepEqual(new Set(all.map(s=>s.group==='commodity'?'commodities':s.group)),new Set(['stock','index','metals','fx','oil','commodities','rates','etf']));
  for(const s of all){
    const bytes=read(s.id),data=JSON.parse(bytes),{id,rows}=data;
    if(s.statistic==='exchangeActivity'){
      assert.equal(createHash('sha256').update(bytes).digest('hex'),s.sha256);
      for(const quarter of validateMarketQuarters(s,data)){
        const index=read(quarter.tickerFile.slice(0,-5));
        assert.equal(createHash('sha256').update(index).digest('hex'),quarter.tickerSha256);
        validateMarketTickers(s,quarter,JSON.parse(index));
      }
      continue;
    }
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
    const years=new Set(all.filter(s=>s.group===group&&s.statistic!=='oracle'&&!['wholesaleRange','wholesaleModal','exchangeActivity'].includes(s.statistic)).flatMap(s=>JSON.parse(read(s.id)).rows.map(r=>Number(r[0].slice(0,4)))));
    assert.ok(years.size>=10,group);
    for(let year=2016;year<=Math.max(...years);year++)assert.ok(years.has(year),group+' '+year);
  }
});
test('current catalog excludes Indian domestic series and keeps US source coverage',()=>{
  assert.deepEqual(all.filter(s=>s.id.startsWith('mandi-')||s.id==='eurinr').map(s=>s.id),[]);
  assert.equal(validateSummary(JSON.parse(read('summary'))).wholesaleQuotes,0);
  const usda=new Set(all.filter(s=>s.statistic==='wholesaleCutout').map(s=>s.id));
  for(const name of ['beef-choice','beef-select','pork-carcass','pork-loin','pork-butt','pork-picnic','pork-rib','pork-ham','pork-belly'])
    assert.ok(usda.has('usda-'+name),name);
  for(const [id,tickers] of [['sec-midas-equities',['AAPL']],['sec-midas-etp',['SPY','INDA']]]){
    const quarter=JSON.parse(read(id)).quarters.find(q=>q.quarter==='2026Q3');
    const reported=new Set(JSON.parse(read(quarter.tickerFile.slice(0,-5))).rows.map(row=>row[1]));
    for(const ticker of tickers)assert.ok(reported.has(ticker),ticker);
  }
});
test('SEC activity counts original venue records exactly once across the two security classes',()=>{
  const funds=all.find(s=>s.id==='sec-midas-etp'),stocks=all.find(s=>s.id==='sec-midas-equities');
  assert.ok(stocks&&funds);
  const security=JSON.parse(read(stocks.id)),products=JSON.parse(read(funds.id));
  for(const [i,q] of security.quarters.entries()){
    const other=products.quarters[i];
    assert.deepEqual([q.quarter,q.url,q.sha256,q.size],[other.quarter,other.url,other.sha256,other.size]);
    assert.ok(q.tickerCount<q.count && other.tickerCount<other.count);
    const observations=JSON.parse(read(q.tickerFile.slice(0,-5))).rows;
    const byTicker=new Map(observations.map(row=>[row[1],row]));
    for(const sample of q.sample)assert.deepEqual(sample,byTicker.get(sample[1]));
  }
  const corrupt=structuredClone(security);corrupt.quarters[0].rawRows++;
  assert.throws(()=>validateMarketQuarters(stocks,corrupt),/monthly totals/);
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
  const catalog=JSON.parse(read('catalog')),file='tw-stock-sources.json';
  const digest=catalog.supportingFiles?.[file];
  const receipt=digest?read('tw-stock-sources'):null;
  if(digest)assert.equal(createHash('sha256').update(receipt).digest('hex'),digest);
  const links=receipt?JSON.parse(receipt):{};
  for(const s of all){
    const bucket=['wholesaleRange','wholesaleModal'].includes(s.statistic)?'wholesaleQuotes':s.statistic==='oracle'?'oracleReads':
       ['ohlcv','ohlc'].includes(s.statistic)||s.fields?.slice(0,5).join(',')==='date,close,open,high,low'?'dailyBars':'otherObservations';
    groups[bucket]+=s.count;
    if(s.statistic==='close'&&links.ohlcvByIssuer?.[s.ticker]){
      const verified=linkedTaiwanBars(s.ticker,JSON.parse(read(s.id)).rows,links);
      const listed=all.find(m=>m.id==='tw-stock-twse-'+s.ticker);
      if(listed)assert.equal(JSON.parse(read(listed.id)).rows.some(([day])=>verified.has(day)),false);
      assert.equal(s.linkedDailyBars,verified.size);
      groups.otherObservations-=verified.size;
      groups.dailyBars+=verified.size;
    }else assert.equal(s.linkedDailyBars??0,0);
  }
  for(const [key,count] of Object.entries(groups))assert.equal(sum[key],count);
  assert.equal(sum.exchangeActivityRecords??0,all.filter(s=>s.statistic==='exchangeActivity').reduce((n,s)=>n+s.count,0));
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
test('rendered counts omit empty wholesale coverage and reconcile the remaining records',()=>{
  const base={version:1,series:2,catalogSha256:'a'.repeat(64),dailyBars:10,oracleReads:1,otherObservations:31,
    exchangeActivityRecords:25,wholesaleQuotes:0,wholesaleRangeQuotes:0,weightedMarketQuotes:0,count:42};
  const values=data=>marketCountRows(validateSummary(data)).map(([[,label],count])=>[label,count]);
  const current=values(base);
  assert.deepEqual(current,[['Exchange activity',25],['Daily bars',10],['Oracle reads',1],['Other observations',6]]);
  assert.equal(current.reduce((sum,[,n])=>sum+n,0),base.count);
  const older=values({...base,wholesaleQuotes:8,wholesaleRangeQuotes:3,weightedMarketQuotes:5,count:50});
  assert.ok(older.some(([label,n])=>label==='Wholesale quotes'&&n===8));
  assert.throws(()=>values({...base,weightedMarketQuotes:1}),/Unbalanced wholesale/);
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
  entries.push({id:'wheat-futures',en:'Wheat futures',zh:'小麦',group:'commodity'});
  assert.equal(matchingSeries(entries,'','').matches.length,75);
  assert.equal(matchingSeries(entries,'','').count,3202);
  assert.equal(matchingSeries(entries,'xyz','stock').matches[0].id,'us-wiki-xyz');
  assert.equal(matchingSeries(entries,'小麦','commodities').matches[0].id,'wheat-futures');
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


test('supplemental Taiwan bars match the close archive, daily range and source',()=>{
  const day='2026-11-26',prices=[2145,2150,2170,2120,45892693],closes=[[day,2145]];
  const source='https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data';
  const receipt={days:{['twse-'+day]:{[source]:'a'.repeat(64)}},ohlcvByIssuer:{'2330':{[day]:prices}}};
  assert.deepEqual(linkedTaiwanBars('2330',closes,receipt).get(day),{values:prices,source});
  assert.throws(()=>linkedTaiwanBars('2330',[[day,2140]],receipt),/Invalid/);
  assert.throws(()=>linkedTaiwanBars('2330',closes,{...receipt,days:{}}),/source/);
  assert.throws(()=>linkedTaiwanBars('2330',closes,{...receipt,ohlcvByIssuer:{2330:{[day]:[2145,2150,2148,2120,1]}}}),/Invalid/);
  assert.equal(linkedTaiwanBars('2330',closes,{days:receipt.days}).size,0);
});
