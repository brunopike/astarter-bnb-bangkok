import test from 'node:test';
import assert from 'node:assert/strict';
import {subscribeSpotDepth} from './spot-depth-client.mjs';
import {normalizeSpotDepth} from './spot-depth-data.mjs';

const raw={lastUpdateId:123,bids:[['99.99','2'],['99.90','3']],asks:[['100.01','4'],['100.10','5']]};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetcher,afterSnapshot){
 let at=100000,id=0;const timers=new Map(),calls=[],snapshots=[],states=[];
 const snapshot=()=>normalizeSpotDepth(raw,'BTC',{requestStartedAt:at-10,receivedAt:at});
 const reply=body=>({ok:true,json:async()=>body});
 const stop=subscribeSpotDepth('BTC',{onSnapshot:s=>{snapshots.push(s);afterSnapshot?.();},onStatus:s=>states.push(s.state)},{now:()=>at,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:key=>timers.delete(key),fetchImpl:async(url,options)=>{calls.push({url,options});return fetcher?fetcher({snapshot,reply,options}):reply({schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:at,body:snapshot()});}});
 return {calls,snapshots,states,timers,stop,async tick(ms){const entry=[...timers].find(([,v])=>v.ms===ms);assert.ok(entry,'missing timer '+ms);timers.delete(entry[0]);at+=ms;entry[1].fn();await flush();}};
}

test('spot depth uses the fixed public relay and preserves source clocks across repeated reads',async()=>{
 let cached;const f=fixture(({snapshot,reply})=>{cached??={schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:100000,body:snapshot()};return reply(cached);});
 await flush();assert.equal(f.calls[0].url,'/api/market-hub?resource=spot-depth&symbol=BTC');
 assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.calls[0].options.method,'GET');
 assert.deepEqual(f.states,['loading','ready']);assert.equal(f.snapshots.length,1);assert.equal(f.snapshots[0].receivedAt,100000);
 await f.tick(15000);assert.equal(f.snapshots.length,2);assert.equal(f.snapshots[1].receivedAt,100000);
 await f.tick(15000);assert.equal(f.snapshots.length,2);assert.equal(f.states.at(-1),'error');f.stop();assert.equal(f.timers.size,0);
});

test('a real-shaped server snapshot 238ms ahead reaches the scanner and still expires at its original deadline',async()=>{
 const snapshot=normalizeSpotDepth(raw,'BTC',{requestStartedAt:100000,receivedAt:100238});
 const f=fixture(({reply})=>reply({schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:snapshot.receivedAt,body:snapshot}));
 await flush();assert.deepEqual(f.states,['loading','ready']);assert.equal(f.snapshots[0].receivedAt,100238);assert.equal(f.snapshots[0].validUntil,130000);
 await f.tick(15000);assert.equal(f.snapshots.length,2);assert.equal(f.snapshots[1].validUntil,130000);
 await f.tick(15000);assert.equal(f.states.at(-1),'error');assert.equal(f.snapshots.length,2);f.stop();
});

test('invalid envelope, derived metrics, identity and expired snapshots never reach the scanner',async()=>{
 for(const corrupt of [b=>({...b,resource:'candles'}),b=>({...b,receivedAt:1}),b=>({...b,body:{...b.body,symbol:'ETH'}}),b=>({...b,body:{...b.body,spreadBps:9000}}),b=>({...b,body:{...b.body,requestStartedAt:0,receivedAt:1,validUntil:30000},receivedAt:1})]){
  const f=fixture(({snapshot,reply})=>reply(corrupt({schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:100000,body:snapshot()})));
  await flush();assert.equal(f.snapshots.length,0);assert.equal(f.states.at(-1),'error');f.stop();assert.equal(f.timers.size,0);
 }
});

test('rate limits postpone polling and never report a successful snapshot',async()=>{
 const f=fixture(()=>({ok:false,headers:{get:()=> '120'}}));await flush();
 assert.deepEqual(f.states,['loading','error']);assert.equal(f.snapshots.length,0);assert.equal([...f.timers.values()][0].ms,120000);
 await f.tick(120000);assert.equal(f.calls.length,2);f.stop();
});

test('stop aborts pending requests, cancels every timer and ignores late responses',async()=>{
 let finish;const f=fixture(({snapshot,reply})=>new Promise(resolve=>{finish=()=>resolve(reply({schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:100000,body:snapshot()}));}));
 f.stop();assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.timers.size,0);finish();await flush();
 assert.equal(f.snapshots.length,0);assert.deepEqual(f.states,['loading']);assert.equal(f.timers.size,0);f.stop();
});

test('deadline rejects even a transport that resolves after cancellation',async()=>{
 let finish;const f=fixture(({snapshot,reply})=>new Promise(resolve=>{finish=()=>resolve(reply({schema:'public-market-relay-v1',resource:'spot-depth',receivedAt:108000,body:snapshot()}));}));
 await f.tick(8000);assert.equal(f.calls[0].options.signal.aborted,true);finish();await flush();
 assert.equal(f.snapshots.length,0);assert.equal(f.states.at(-1),'error');f.stop();assert.equal(f.timers.size,0);
});
test('fetch or body that never settles releases its pending slot on deadline',async()=>{
 for(const fetcher of [()=>new Promise(()=>{}),()=>({ok:true,json:()=>new Promise(()=>{})})]){
  const f=fixture(fetcher);await flush();await f.tick(8000);
  assert.equal(f.states.at(-1),'error');assert.equal(f.snapshots.length,0);
  await f.tick(15000);assert.equal(f.calls.length,2);f.stop();await flush();assert.equal(f.timers.size,0);
 }
});

test('unsupported symbols make no request',()=>{
 let calls=0;const states=[];const stop=subscribeSpotDepth('SPX',{onStatus:s=>states.push(s.state)},{fetchImpl:()=>{calls++;}});
 assert.equal(calls,0);assert.deepEqual(states,['unsupported']);stop();
});
test('a consumer stopping during snapshot delivery receives no subsequent ready callback',async()=>{
 const f=fixture(undefined,()=>f.stop());await flush();assert.equal(f.snapshots.length,1);assert.deepEqual(f.states,['loading']);assert.equal(f.timers.size,0);
});
test('a failed depth read cancels its unread body, even when cancelling fails, and keeps the same backoff',async()=>{
 for(const cancel of [()=>Promise.resolve(),()=>Promise.reject(Error('cancel failed')),()=>{throw Error('cancel failed');}]){
  let cancels=0;const f=fixture(()=>({ok:false,status:503,headers:{get:()=>null},body:{cancel(){cancels++;return cancel();}},json:async()=>{throw Error('must not parse error');}}));await flush();
  assert.equal(cancels,1);assert.deepEqual(f.states,['loading','error']);assert.equal(f.snapshots.length,0);assert.deepEqual([...f.timers.values()].map(t=>t.ms),[15000]);
  f.stop();await flush();assert.equal(f.timers.size,0);
 }
});
