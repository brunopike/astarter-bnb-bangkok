import assert from 'node:assert/strict';
import test from 'node:test';
import {PUBLIC_LIGHTNING_SOURCE,LIGHTNING_MAX_AGE,publicLightningRequest,normalizeLightningSources,normalizeLightningStatistics,validateLightningStatistics} from './public-lightning.mjs';
import {createMarketHubRelay} from './market-hub-relay.mjs';
import {liveDataRoute,validateLiveDataResponse} from './data-live-views.mjs';
const DAY=86400000,NOW=Date.UTC(2026,10,18,6),AS_OF=Date.UTC(2026,9,21);
const raw=()=>[{added:AS_OF/1000,channel_count:22680,total_capacity:253094023783},{added:(AS_OF-DAY)/1000,channel_count:22000,total_capacity:250000000001},{added:(AS_OF-2*DAY)/1000,channel_count:3,total_capacity:22494023}];
const SERIES_URL='https://mempool.space/api/v1/lightning/statistics/1m',LATEST_URL='https://mempool.space/api/v1/lightning/statistics/latest';
const EMZY_SERIES='https://mempool.emzy.de/api/v1/lightning/statistics/1m',EMZY_LATEST='https://mempool.emzy.de/api/v1/lightning/statistics/latest';
const latest=(at=AS_OF,channels=22681,sats=253094023784)=>({latest:{added:new Date(at).toISOString(),channel_count:channels,total_capacity:sats,node_count:13777}});
const decode=(parts,metric='lightning')=>normalizeLightningSources(parts,metric,NOW);
test('the two existing metrics use only the fixed public one-month source and reject arbitrary input',()=>{
 for(const metric of ['lightning','channels']){
  const r=publicLightningRequest(new URLSearchParams({metric}));assert.equal(r.resource,'chain-insight');assert.equal(r.key,'chain-insight:'+metric);assert.equal(r.policy,PUBLIC_LIGHTNING_SOURCE);assert.equal(r.policy.url,EMZY_SERIES);assert.equal(r.policy.interval,600000);assert.equal(r.policy.stale,3*DAY);
 }
 for(const query of ['', 'metric=fees','metric=lightning&metric=channels','metric=lightning&url=https://bad.test','metric=channels&timespan=all'])assert.equal(publicLightningRequest(new URLSearchParams(query)),null);
});
test('capacity and channel metrics share actual dates while preserving exact satoshis and source order independence',()=>{
 const source=raw(),before=structuredClone(source),capacity=normalizeLightningStatistics(source,'lightning',NOW),channels=normalizeLightningStatistics(source,'channels',NOW);
 assert.deepEqual(source,before);assert.equal(capacity.unit,'BTC');assert.equal(channels.unit,'channels');assert.equal(capacity.rows.length,3);assert.deepEqual(capacity.rows.map(r=>r.at),[AS_OF-2*DAY,AS_OF-DAY,AS_OF]);assert.equal(capacity.rows.at(-1).value,2530.94023783);assert.equal(channels.rows.at(-1).value,22680);assert.equal(capacity.rows.at(-1).capacitySats,'253094023783');assert.equal(capacity.rows.at(-1).capacityBtc,'2530.94023783');assert.equal(capacity.rows.at(-1).channelCount,22680);
 assert.equal(validateLightningStatistics(capacity,'lightning',NOW),true);assert.equal(validateLightningStatistics(channels,'channels',NOW),true);
});
test('a successful fetch of old history does not become a fresh network observation',()=>{
 const body=normalizeLightningStatistics(raw(),'lightning',NOW);
 assert.equal(body.asOf,AS_OF);assert.equal(body.receivedAt,NOW);assert.equal(body.validUntil,AS_OF+LIGHTNING_MAX_AGE);assert.ok(body.validUntil<NOW);assert.equal(validateLightningStatistics(body,'lightning',NOW+DAY),true);assert.equal(body.rows.length,3);
 assert.deepEqual(body.coverage,{scope:'PUBLIC_LIGHTNING_GOSSIP_SNAPSHOT',observer:'mempool.space',networkCoverageComplete:false,privateChannelsIncluded:false,fundingTransactionsResolvedOnly:true,timeBasis:'provider_daily_snapshot'});
 assert.equal(body.nodeCount,undefined);assert.equal(body.paymentVolume,undefined);assert.equal(body.allActiveChannels,undefined);
});
test('malformed or partial histories cannot produce empty or zero-filled successful statistics',()=>{
 for(const value of [null,[],{latest:raw()[0]},new Array(3),raw().concat(raw()[0]),[{...raw()[0],added:(AS_OF+DAY*40)/1000}],Array.from({length:41},(_,i)=>({...raw()[0],added:(AS_OF-i*DAY)/1000}))])assert.throws(()=>normalizeLightningStatistics(value,'lightning',NOW),/INVALID_LIGHTNING_STATISTICS/);
 for(const key of ['channel_count','total_capacity'])for(const value of [null,undefined,'0',-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  const source=raw();source[0][key]=value;assert.throws(()=>normalizeLightningStatistics(source,'channels',NOW),/INVALID_LIGHTNING_STATISTICS/);
 }
 for(const added of [null,'1792540800',AS_OF/1000+.5,(AS_OF+1)/1000,0]){const source=raw();source[0].added=added;assert.throws(()=>normalizeLightningStatistics(source,'lightning',NOW),/INVALID_LIGHTNING_STATISTICS/);}
});
test('genuine zero snapshots remain zero and missing source values do not',()=>{
 const body=normalizeLightningStatistics([{added:AS_OF/1000,channel_count:0,total_capacity:0}],'lightning',NOW);assert.equal(body.rows[0].value,0);assert.equal(body.rows[0].capacityBtc,'0');assert.equal(validateLightningStatistics(body,'lightning',NOW),true);
 assert.throws(()=>normalizeLightningStatistics([{added:AS_OF/1000,channel_count:0,total_capacity:1}],'channels',NOW),/INVALID_LIGHTNING_STATISTICS/);
 assert.throws(()=>normalizeLightningStatistics([{added:AS_OF/1000,channel_count:1,total_capacity:0}],'channels',NOW),/INVALID_LIGHTNING_STATISTICS/);
});
test('canonical validators reject forged identity, units, counts, authority and refreshed source deadlines',()=>{
 const original=normalizeLightningStatistics(raw(),'lightning',NOW);
 for(const patch of [b=>{b.metric='channels';},b=>{b.unit='USD';},b=>{b.url='https://bad.test';},b=>{b.source='Bitview';},b=>{b.asOf=NOW;},b=>{b.validUntil=NOW+LIGHTNING_MAX_AGE;},b=>{b.rows[0].capacitySats='1';},b=>{b.rows[0].value++;},b=>{b.rows[0].capacityBtc='0';},b=>{b.rows[0].channelCount=-1;},b=>{b.coverage.networkCoverageComplete=true;},b=>{b.executionAuthority='TRADE';},b=>{b.rows.reverse();}]){
  const body=structuredClone(original);patch(body);assert.equal(validateLightningStatistics(body,'lightning',NOW),false);
 }
 assert.equal(validateLightningStatistics(original,'channels',NOW),false);assert.equal(validateLightningStatistics(original,'lightning',NOW-1001),false);
 assert.throws(()=>normalizeLightningStatistics(raw(),'fees',NOW),/INVALID_LIGHTNING_STATISTICS/);
});
test('fallback accepts a valid latest snapshot when the one-month endpoint is empty, failed or invalid',()=>{
 for(const invalid of [[],null,{error:'unavailable'},[{added:AS_OF/1000,channel_count:-1,total_capacity:1}]]){
  const body=decode([invalid,latest()],'channels');assert.equal(body.rows.length,1);assert.equal(body.rows[0].value,22681);assert.equal(body.asOf,AS_OF);assert.equal(body.url,LATEST_URL);assert.equal(body.rows[0].sourceUrl,LATEST_URL);assert.deepEqual(body.provenance,[{url:LATEST_URL,asOf:AS_OF}]);assert.equal(body.validUntil,AS_OF+3*DAY);assert.equal(validateLightningStatistics(body,'channels',NOW),true);
 }
});
test('the public relay prefers fresh Emzy snapshots and keeps the two observers in distinct histories',async ()=>{
 const today=Date.UTC(2026,10,18),request=publicLightningRequest(new URLSearchParams({metric:'channels'}));
 const collect=async upstream=>{
  const calls=[];
  const body=await request.collect(async spec=>{calls.push(spec.url);assert.equal(spec.optional,true);return upstream[spec.url]??null;},()=>NOW);
  return {body,calls};
 };
 const fresh=await collect({[EMZY_LATEST]:latest(today,26494,309737667700)});
 assert.deepEqual(fresh.calls,[EMZY_SERIES,EMZY_LATEST]);
 assert.equal(fresh.body.coverage.observer,'mempool.emzy.de');
 assert.equal(fresh.body.asOf,today);
 assert.equal(fresh.body.rows[0].value,26494);
 assert.ok(validateLightningStatistics(fresh.body,'channels',NOW));
 const fallback=await collect({[EMZY_SERIES]:raw(),[LATEST_URL]:latest(today,25589,307000000000)});
 assert.deepEqual(fallback.calls,[EMZY_SERIES,EMZY_LATEST,SERIES_URL,LATEST_URL]);
 assert.equal(fallback.body.source,'mempool.space');
 assert.deepEqual(fallback.body.rows.map(row=>row.sourceUrl),[LATEST_URL]);
 const mixed=structuredClone(fresh.body);mixed.rows[0].sourceUrl=LATEST_URL;
 assert.equal(validateLightningStatistics(mixed,'channels',NOW),false);
 const stale=await collect({[EMZY_SERIES]:raw()});
 assert.ok(stale.body.validUntil<NOW);
 assert.equal(stale.body.source,'mempool.emzy.de');
});
test('a later relay timestamp does not invalidate a freshly collected Lightning measurement',async ()=>{
 let clock=NOW,status,envelope;
 const relay=createMarketHubRelay({now:()=>++clock,fetchImpl:async url=>
  Response.json(url===EMZY_LATEST?latest(Date.UTC(2026,10,18),26494,309737667700):[])});
 await relay({url:'/api/market-hub?resource=chain-insight&metric=lightning',method:'GET'},
  {writeHead(code){status=code;},end(text){envelope=JSON.parse(text);}});
 assert.equal(status,200);
 assert.ok(envelope.receivedAt>envelope.body.receivedAt);
 assert.equal(validateLiveDataResponse(envelope,liveDataRoute('tracking','metric=lightning'),clock).body.source,'mempool.emzy.de');
});
test('the same UTC date deterministically prefers the complete latest observation while retaining real series dates',()=>{
 const body=decode([raw(),latest()]);assert.equal(body.rows.length,3);assert.equal(body.rows.at(-1).capacitySats,'253094023784');assert.equal(body.rows.at(-1).channelCount,22681);assert.equal(body.url,LATEST_URL);assert.deepEqual(body.provenance,[{url:SERIES_URL,asOf:AS_OF-DAY},{url:LATEST_URL,asOf:AS_OF}]);assert.equal(validateLightningStatistics(body,'lightning',NOW),true);
 const channels=decode([raw(),latest()],'channels');assert.equal(channels.rows.at(-1).value,22681);assert.equal(channels.rows.at(-1).capacitySats,'253094023784');
});
test('older or newer instance snapshots select by original source day and never by retrieval time',()=>{
 const older=decode([raw(),latest(Date.UTC(2026,5,1))]);assert.equal(older.rows.length,3);assert.equal(older.url,SERIES_URL);assert.equal(older.asOf,AS_OF);assert.deepEqual(older.provenance,[{url:SERIES_URL,asOf:AS_OF}]);
 const newer=decode([raw(),latest(AS_OF+DAY)]);assert.equal(newer.rows.length,4);assert.equal(newer.asOf,AS_OF+DAY);assert.equal(newer.url,LATEST_URL);assert.equal(newer.validUntil,AS_OF+4*DAY);assert.ok(newer.validUntil<NOW);
});
test('latest timestamps require a real ISO UTC midnight and invalid latest does not erase valid history',()=>{
 for(const added of ['2026-10-21','2026-10-21T00:00:00+00:00','2026-10-21T01:00:00.000Z','2026-02-30T00:00:00.000Z','2026-12-01T00:00:00.000Z',AS_OF,null]){
  const source=latest();source.latest.added=added;const body=decode([raw(),source]);assert.equal(body.url,SERIES_URL);assert.deepEqual(body.provenance,[{url:SERIES_URL,asOf:AS_OF}]);assert.throws(()=>decode([[],source]),/INVALID_LIGHTNING_STATISTICS/);
 }
 const source=latest();source.latest.added='2026-10-21T00:00:00Z';assert.equal(decode([[],source]).asOf,AS_OF);
 for(const key of ['channel_count','total_capacity'])for(const value of [null,'0',-1,.5,Infinity,Number.MAX_SAFE_INTEGER+1]){const source=latest();source.latest[key]=value;assert.equal(decode([raw(),source]).url,SERIES_URL);assert.throws(()=>decode([[],source]),/INVALID_LIGHTNING_STATISTICS/);}
 const zero=decode([[],latest(AS_OF,0,0)]);assert.equal(zero.rows[0].value,0);assert.equal(zero.rows[0].capacitySats,'0');
});
test('both unusable endpoints fail rather than manufacture empty, current or zero statistics',()=>{
 for(const parts of [[[],null],[null,{latest:null}],[{error:'429'},{error:'503'}],[raw().concat(raw()[0]),{latest:{added:'bad'}}]])assert.throws(()=>decode(parts),/INVALID_LIGHTNING_STATISTICS/);
 const original=decode([raw(),latest()]);
 for(const mutate of [b=>{b.provenance.reverse();},b=>{b.provenance[0].asOf++;},b=>{b.rows[0].sourceUrl='https://bad.test';},b=>{b.url=SERIES_URL;},b=>{b.provenance.push({url:SERIES_URL,asOf:NOW});}]){const body=structuredClone(original);mutate(body);assert.equal(validateLightningStatistics(body,'lightning',NOW),false);}
 const forged=structuredClone(original);forged.rows[0].sourceUrl=LATEST_URL;assert.equal(validateLightningStatistics(forged,'lightning',NOW),false);
});
