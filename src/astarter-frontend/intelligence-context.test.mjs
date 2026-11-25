import test from 'node:test';
import assert from 'node:assert/strict';
import {CROSS_MARKETS} from './cross-market-data.mjs';
import {createIntelligenceContext,renderIntelligenceMarkets} from './intelligence-context.mjs';

const now=Date.parse('2026-11-19T18:40:00Z');
const day=86400000, json=(body,options)=>new Response(JSON.stringify(body),options);
function packet(symbol){
 const market=CROSS_MARKETS[symbol];
 const bars=[4,4.1,25].map((close,i)=>{
  const start=(Date.parse('2026-11-17T14:00:00Z')+i*day)/1000;
  return {time:start,closedAt:start+7*3600,validUntil:start+day+7*3600,closeTimeBasis:'source-session',open:close,high:close,low:close,close,volume:null};
 });
 const last=bars[1];
 const body={schema:'cross-market-daily-v1',symbol,source:market.source,timezone:market.timezone,unit:market.unit,period:'1D',volumeKind:'unavailable',session:'delayed',receivedAt:now,sessionDate:'2026-11-18',quoteAsOf:now/1000-100,closedAt:last.closedAt,validUntil:last.validUntil,closeTimeBasis:last.closeTimeBasis,bars};
 return {schema:'public-market-relay-v1',resource:'cross-candles',receivedAt:now,body};
}

test('context reads the calendar and four independent closes, keeps last records on rate limits and skips hidden routes',async()=>{
 const urls=[];let limited=false;
 const context=createIntelligenceContext({now:()=>now,fetchImpl:async(url,opts)=>{
  urls.push(url);assert.equal(opts.credentials,'omit');
  if(limited)return json({}, {status:429,headers:{'Retry-After':'900'}});
  const symbol=new URLSearchParams(url.split('?')[1]).get('symbol');
  return symbol?json(packet(symbol)):json({schema:'invalid'});
 }});
 await context.tick(false);assert.equal(urls.length,0);
 await context.tick(true);assert.equal(urls.length,5);
 const {calendar,quotes}=context.read();
 assert.equal(calendar.snapshot,null);
 assert.deepEqual(Object.keys(quotes).sort(),['DXY','SPX','US10Y','XAU']);
 assert.ok(Object.values(quotes).every(s=>s.snapshot?.sessionDate==='2026-11-18'));
 const html=renderIntelligenceMarkets(quotes);
 assert.match(html,/class="df-market-list"/);
 assert.match(html,/4\.100%/);assert.match(html,/\+10\.00 bp/);
 assert.match(html,/\+2\.50%/);assert.doesNotMatch(html,/25\.00/);
 assert.match(html,/page=markets&amp;asset=XAU/);
 await context.tick(true);assert.equal(urls.length,5);
 limited=true;await context.tick(true,true);assert.equal(urls.length,9);
 assert.ok(Object.values(context.read().quotes).every(s=>s.stale&&s.snapshot));
 await context.tick(true,true);assert.equal(urls.length,9);
 context.dispose();
});

test('departing mid-fetch discards delayed packets',async()=>{
 const pending=[];
 const ctx=createIntelligenceContext({now:()=>now,fetchImpl:(url,{signal})=>new Promise(resolve=>pending.push({url,signal,resolve}))});
 const request=ctx.tick(true);
 assert.equal(ctx.read().calendar.pending,true);
 ctx.tick(false);assert.ok(pending.every(p=>p.signal.aborted));
 for(const p of pending)p.resolve(json(packet('SPX')));
 await request;assert.ok(Object.values(ctx.read().quotes).every(s=>!s.pending&&!s.snapshot));
});
