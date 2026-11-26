import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateSeries} from './brain-tradfi-archive.mjs';
const read=name=>readFileSync(new URL('./brain-evidence/tradfi/'+name+'.json',import.meta.url));
const all=validateSeries(JSON.parse(read('catalog')));
test('published market observations match instrument, units, dates, and checksum',()=>{
  assert.deepEqual(new Set(all.filter(s=>s.statistic!=='oracle').map(s=>s.group)),new Set(['stock','index','metals','fx','oil','commodities','rates']));
  for(const s of all){
    const bytes=read(s.id),{id,rows}=JSON.parse(bytes);
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
    }else if(s.statistic!=='oracle'){
      assert.equal(s.start.slice(0,4),'2016');
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
    const years=new Set(all.filter(s=>s.group===group&&s.statistic!=='oracle').flatMap(s=>JSON.parse(read(s.id)).rows.map(r=>Number(r[0].slice(0,4)))));
    assert.ok(years.size>=10,group);
    for(let year=2016;year<=Math.max(...years);year++)assert.ok(years.has(year),group+' '+year);
  }
});
test('related oracle pricing keeps futures, reference rates, stocks and ETFs identifiable',()=>{
  const by=id=>all.find(s=>s.id===id);
  assert.equal(by('wti').statistic,'spot');assert.ok(JSON.parse(read('wti')).rows.some(([day,v])=>day==='2020-04-20'&&v<0));
  assert.equal(by('oracle-wti').network,'arbitrum');assert.match(by('oracle-wti').en,/futures/i);
  assert.equal(by('oracle-spy').group,'etf');assert.equal(by('oracle-gold').related,'gold');
  assert.throws(()=>validateSeries({version:1,series:[{...all[0],id:'../other'}]}));
});
