import assert from 'node:assert/strict';
import test from 'node:test';
import {BLOCKBEATS_URL,fetchBlockBeats,parseBlockBeats} from './public-blockbeats.mjs';

const article={id:42,title:'比特币与 ETH',content:'do not publish',url:'https://external.example/42',link:'https://m.theblockbeats.info/flash/42',create_time:'2025-11-18 12:34:58'};
const packet=(...rows)=>({status:0,data:{data:rows}});
test('BlockBeats reads the fixed authenticated Chinese feed; projects only attributable headline fields',async()=>{
 const key='test-key-not-a-real-token',signal=AbortSignal.timeout(5000);
 const items=await fetchBlockBeats(async(url,options)=>{
  assert.equal(url,BLOCKBEATS_URL);assert.equal(options.headers['api-key'],key);assert.equal(options.redirect,'error');assert.equal(options.signal,signal);
  return Response.json(packet(article,article));
 },key,signal);
 assert.deepEqual(items,[{id:'blockbeats:42',title:article.title,url:article.link,publishedAt:Date.parse('2025-11-18T04:34:58Z'),symbols:['BTC','ETH'],revision:null}]);
 assert.deepEqual(parseBlockBeats(packet()),[]);
});
test('rejects application errors delivered as HTTP 200, clock overflow, substitutions and oversized responses',async()=>{
 await assert.rejects(fetchBlockBeats(()=>assert.fail(),' '),/UNCONFIGURED/);
 await assert.rejects(fetchBlockBeats(async()=>Response.json({status:100,message:'Missing API key',data:null}),'sample-key'),/API_REJECTED/);
 await assert.rejects(fetchBlockBeats(async()=>Response.json(packet({...article,title:'sample-key'})),'sample-key'),/INVALID_RESPONSE/);
 for(const row of [{link:'https://m.theblockbeats.info.evil.test/flash/42'},{link:'https://m.theblockbeats.info/flash/43'},{create_time:'2025-02-30 01:10:10'},{create_time:'2999-01-01 10:10:10'},{id:0}])assert.throws(()=>parseBlockBeats(packet({...article,...row})),/INVALID_RESPONSE/);
 await assert.rejects(fetchBlockBeats(async()=>new Response(' '.repeat(384001),{headers:{'content-type':'application/json'}}),'sample-key'),/INVALID_RESPONSE/);
});
