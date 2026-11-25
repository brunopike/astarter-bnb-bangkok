import test from 'node:test';
import assert from 'node:assert/strict';

test('spot depth exports its pure normalizer and verifier',async()=>{
 const module=await import('./spot-depth-data.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};
  throw error;
 });
 assert.equal(typeof module.normalizeSpotDepth,'function');
 assert.equal(typeof module.validateSpotDepthSnapshot,'function');
});

const START=1_800_000_000_000;
const times={requestStartedAt:START,receivedAt:START+250};
const raw=()=>({lastUpdateId:8675309,bids:[['99.5','2'],['99','3'],['98.9','8']],asks:[['100.5','4'],['101','5'],['101.1','9']]});
const api=()=>import('./spot-depth-data.mjs');

test('independent hand calculation: only prices within mid ±1% contribute',async()=>{
 const {normalizeSpotDepth}=await api();
 const body=raw(),before=structuredClone(body),result=normalizeSpotDepth(body,'BTC',times);
 assert.deepEqual(result,{
  schema:'spot-depth-v1',symbol:'BTC',market:'BTC/USDT',source:'Binance Spot',unit:'USDT',methodVersion:'spot-depth-100-v1',
  ...times,validUntil:START+30000,lastUpdateId:8675309,bestBid:99.5,bestAsk:100.5,mid:100,spreadBps:100,
  bidNotional:496,askNotional:907,bidCoverageComplete:true,askCoverageComplete:true,bidLevels:3,askLevels:3,
  bids:before.bids,asks:before.asks
 });
 assert.deepEqual(body,before);
 body.bids[0][0]='1';assert.equal(result.bids[0][0],'99.5');
 result.asks[0][1]='100';assert.equal(body.asks[0][1],'4');
 assert.equal('eventTime' in result,false);
 assert.equal('signal' in result,false);
 assert.equal('authorization' in result,false);
});

test('each supported asset has an exact fixed identity; URLs and pairs are not symbols',async()=>{
 const {normalizeSpotDepth}=await api();
 for(const symbol of ['BTC','ETH','SOL']){
  const result=normalizeSpotDepth({...raw(),source:'Injected',market:'evil',symbol:'OTHER'},symbol,times);
  assert.equal(result.symbol,symbol);assert.equal(result.market,symbol+'/USDT');assert.equal(result.source,'Binance Spot');
 }
 for(const symbol of ['btc','BTCUSDT','BTC/USDT','BNB','https://evil.test','BTC?limit=1',null,undefined])assert.throws(()=>normalizeSpotDepth(raw(),symbol,times),/INVALID_SPOT_DEPTH/);
});

test('partial 100-level coverage is a measured lower bound, not invented depth',async()=>{
 const {normalizeSpotDepth}=await api();
 const body={lastUpdateId:0,bids:Array.from({length:100},(_,i)=>[(99.5-i/1000).toFixed(3),'1']),asks:Array.from({length:100},(_,i)=>[(100.5+i/1000).toFixed(3),'1'])};
 const result=normalizeSpotDepth(body,'ETH',times);
 assert.equal(result.bidLevels,100);assert.equal(result.askLevels,100);
 assert.equal(result.bidCoverageComplete,false);assert.equal(result.askCoverageComplete,false);
 // Arithmetic progressions: 100 * (first + last) / 2, with quantity one.
 assert.ok(Math.abs(result.bidNotional-9945.05)<1e-8);
 assert.ok(Math.abs(result.askNotional-10054.95)<1e-8);
 const sparse=normalizeSpotDepth({lastUpdateId:1,bids:[['50','1']],asks:[['150','1']]},'SOL',times);
 assert.equal(sparse.bidNotional,0);assert.equal(sparse.askNotional,0);
 assert.equal(sparse.bidCoverageComplete,true);assert.equal(sparse.askCoverageComplete,true);
});

test('a level exactly on the one-percent boundary is included and completes coverage',async()=>{
 const {normalizeSpotDepth}=await api();
 const body=raw();body.bids.pop();body.asks.pop();
 const result=normalizeSpotDepth(body,'SOL',times);
 assert.equal(result.bidCoverageComplete,true);assert.equal(result.askCoverageComplete,true);
 assert.equal(result.bidNotional,496);assert.equal(result.askNotional,907);
});

test('both sides require 1..100 well-formed price and quantity pairs',async()=>{
 const {normalizeSpotDepth}=await api();
 for(const side of ['bids','asks'])for(const levels of [null,{},[],Array(1),Array(101).fill(['100','1']),[['100']], [['100','1','extra']],[['100',1]],[[100,'1']],[null]]){
  assert.throws(()=>normalizeSpotDepth({...raw(),[side]:levels},'BTC',times),/INVALID_SPOT_DEPTH/);
 }
 for(const body of [null,undefined,[],{},'text'])assert.throws(()=>normalizeSpotDepth(body,'BTC',times),/INVALID_SPOT_DEPTH/);
});

test('decimal inputs reject signs, exponent notation, coercions, zero, non-finite and arithmetic overflow',async()=>{
 const {normalizeSpotDepth}=await api();
 for(const value of ['0','0.000','-1','+1',' 1','1 ','1e2','.1','1.','01','NaN','Infinity','0x10','9'.repeat(309),'0.'+'0'.repeat(325)+'1',null,1]){
  for(const position of [0,1]){
   const body=raw();body.bids[0][position]=value;
   assert.throws(()=>normalizeSpotDepth(body,'BTC',times),/INVALID_SPOT_DEPTH/);
  }
 }
 const overflowing=raw();overflowing.asks[0][1]='9'.repeat(308);
 assert.throws(()=>normalizeSpotDepth(overflowing,'BTC',times),/INVALID_SPOT_DEPTH/);
 const underflowing={lastUpdateId:1,bids:[['0.'+'0'.repeat(160)+'1','0.'+'0'.repeat(170)+'1']],asks:[['1','1']]};
 assert.throws(()=>normalizeSpotDepth(underflowing,'BTC',times),/INVALID_SPOT_DEPTH/);
});

test('price order is strict on each side and the best bid must be below the best ask',async()=>{
 const {normalizeSpotDepth}=await api();
 for(const side of ['bids','asks'])for(const change of ['reverse','duplicate']){
  const body=raw();if(change==='reverse')body[side].reverse();else body[side][1][0]=body[side][0][0];
  assert.throws(()=>normalizeSpotDepth(body,'BTC',times),/INVALID_SPOT_DEPTH/);
 }
 for(const ask of ['99.5','99.4']){
  const body=raw();body.asks[0][0]=ask;
  assert.throws(()=>normalizeSpotDepth(body,'BTC',times),/INVALID_SPOT_DEPTH/);
 }
 for(const lastUpdateId of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'123',Infinity,NaN,null])assert.throws(()=>normalizeSpotDepth({...raw(),lastUpdateId},'BTC',times),/INVALID_SPOT_DEPTH/);
});

test('request clocks must be safe monotonic milliseconds and cannot exceed an eight-second RTT',async()=>{
 const {normalizeSpotDepth}=await api();
 for(const bad of [undefined,null,{},
  {requestStartedAt:-1,receivedAt:1},
  {requestStartedAt:START+.5,receivedAt:START+1},
  {requestStartedAt:START,receivedAt:START-.5},
  {requestStartedAt:START,receivedAt:START-1},
  {requestStartedAt:START,receivedAt:START+8001},
  {requestStartedAt:START,receivedAt:Infinity},
  {requestStartedAt:Number.MAX_SAFE_INTEGER-1,receivedAt:Number.MAX_SAFE_INTEGER}
 ])assert.throws(()=>normalizeSpotDepth(raw(),'BTC',bad),/INVALID_SPOT_DEPTH/);
 const result=normalizeSpotDepth(raw(),'BTC',{requestStartedAt:START,receivedAt:START+8000});
 assert.equal(result.validUntil,START+30000);
});

test('snapshot verifier recomputes every identity, summary and original clock without mutation',async()=>{
 const {normalizeSpotDepth,validateSpotDepthSnapshot}=await api();
 const result=normalizeSpotDepth(raw(),'BTC',times),before=structuredClone(result);
 const verified=validateSpotDepthSnapshot(result,'BTC',START+29999);
 assert.deepEqual(verified,before);assert.notEqual(verified,result);assert.notEqual(verified.bids,result.bids);
 for(const [field,value] of Object.entries({schema:'other',symbol:'ETH',market:'BTC/USD',source:'Fake',unit:'USD',methodVersion:'next',validUntil:START+31000,lastUpdateId:'8675309',bestBid:99,bestAsk:101,mid:101,spreadBps:99,bidNotional:497,askNotional:908,bidLevels:4,askLevels:4,bidCoverageComplete:false,askCoverageComplete:false})){
  assert.throws(()=>validateSpotDepthSnapshot({...result,[field]:value},'BTC',START+1000),/INVALID_SPOT_DEPTH/,field);
 }
 const changed=structuredClone(result);changed.bids[0][1]='20';
 assert.throws(()=>validateSpotDepthSnapshot(changed,'BTC',START+1000),/INVALID_SPOT_DEPTH/);
 assert.throws(()=>validateSpotDepthSnapshot(result,'ETH',START+1000),/INVALID_SPOT_DEPTH/);
 assert.deepEqual(result,before);
});

test('expired or out-of-window future snapshots never acquire a newer receipt or a fresh TTL on validation',async()=>{
 const {normalizeSpotDepth,validateSpotDepthSnapshot}=await api();
 const snapshot=normalizeSpotDepth(raw(),'BTC',times);
 for(const at of [START+30000,START+90000])assert.throws(()=>validateSpotDepthSnapshot(snapshot,'BTC',at),/STALE_SPOT_DEPTH/);
 for(const at of [START-751,NaN,Infinity,-1,START+250.5])assert.throws(()=>validateSpotDepthSnapshot(snapshot,'BTC',at),/INVALID_SPOT_DEPTH/);
 const forgedReceipt={...snapshot,receivedAt:START+31000};
 assert.throws(()=>validateSpotDepthSnapshot(forgedReceipt,'BTC',START+31001),/INVALID_SPOT_DEPTH/);
 assert.equal(snapshot.receivedAt,START+250);assert.equal(snapshot.validUntil,START+30000);
 const serialized=JSON.parse(JSON.stringify(snapshot));
 assert.deepEqual(validateSpotDepthSnapshot(serialized,'BTC',START+1000),snapshot);
 assert.throws(()=>validateSpotDepthSnapshot(serialized,'BTC',START+30000),/STALE_SPOT_DEPTH/);
});

test('one-second cross-host skew accepts the observed 238ms offset without rewriting source clocks',async()=>{
 const {normalizeSpotDepth,validateSpotDepthSnapshot}=await api();
 const snapshot=normalizeSpotDepth(raw(),'BTC',times),before=structuredClone(snapshot);
 for(const skew of [1,238,1000])assert.deepEqual(validateSpotDepthSnapshot(snapshot,'BTC',snapshot.receivedAt-skew),before);
 for(const skew of [1001,30000])assert.throws(()=>validateSpotDepthSnapshot(snapshot,'BTC',snapshot.receivedAt-skew),/INVALID_SPOT_DEPTH/);
 assert.equal(validateSpotDepthSnapshot(snapshot,'BTC',START+29999).validUntil,START+30000);
 assert.throws(()=>validateSpotDepthSnapshot(snapshot,'BTC',START+30000),/STALE_SPOT_DEPTH/);
 assert.deepEqual(snapshot,before);
});
