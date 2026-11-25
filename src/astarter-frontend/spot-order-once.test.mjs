import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {REQUEST_ID,reconcileFill,runAuthorizedSpotOrder} from './spot-order-once.mjs';

const KEY='test-key-12345678';
const SECRET='secret-SHOULD-NOT-LEAK-0123456789';
const NOW=Date.parse('2026-11-21T04:15:00.000Z');
const restrictions={enableReading:true,enableWithdrawals:false,enableInternalTransfer:false,permitsUniversalTransfer:false,enableSpotAndMarginTrading:true,enableFutures:false,enableMargin:false};
const account={canTrade:true,balances:[{asset:'USDT',free:'10',locked:'0'}]};
const info={symbols:[{symbol:'BTCUSDT',status:'TRADING',filters:[{filterType:'NOTIONAL',minNotional:'5.00000000'}]}]};
const placed={symbol:'BTCUSDT',orderId:1001,clientOrderId:REQUEST_ID,status:'FILLED',type:'MARKET',side:'BUY',executedQty:'0.00008000',cummulativeQuoteQty:'5.00000000',fills:[{price:'62500.00000000',qty:'0.00008000',commission:'0.00000008',commissionAsset:'BTC',tradeId:9001}]};
const trades=[{symbol:'BTCUSDT',id:9001,orderId:1001,price:'62500.00000000',qty:'0.00008000',quoteQty:'5.00000000',commission:'0.00000008',commissionAsset:'BTC',isBuyer:true}];

function json(data,status=200){return {ok:status<400,status,async text(){return JSON.stringify(data);}};}
function exchange(overrides={}){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const target=new URL(url);
  calls.push({method:options.method||'GET',path:target.pathname,query:target.searchParams,key:options.headers?.['X-MBX-APIKEY']||''});
  if(target.pathname==='/api/v3/time')return json({serverTime:NOW});
  if(target.pathname==='/api/v3/exchangeInfo')return json(overrides.info||info);
  if(target.pathname==='/api/v3/account')return json(overrides.account||account);
  if(target.pathname==='/sapi/v1/account/apiRestrictions')return json(overrides.restrictions||restrictions);
  if(target.pathname==='/api/v3/order/test')return json(overrides.test||{});
  if(target.pathname==='/api/v3/order')return json(overrides.order||placed,overrides.orderStatus||200);
  if(target.pathname==='/api/v3/myTrades')return json(overrides.trades||trades);
  throw Error('unexpected '+target.pathname);
 };
 return {fetchImpl,calls};
}
async function run(exchangeImpl,name){
 const dir=await mkdtemp(path.join(tmpdir(),'astarter-once-'));
 const receiptPath=path.join(dir,name);
 try{return {dir,receiptPath,result:await runAuthorizedSpotOrder({creds:{key:KEY,secret:SECRET},fetchImpl:exchangeImpl.fetchImpl,now:NOW,receiptPath,confirm:'once'})};}
 finally{await rm(dir,{recursive:true,force:true});}
}

test('a matching fill is reconciled only when the trade id, fee and quote amount agree',()=>{
 assert.equal(reconcileFill(placed,trades).reconciled,true);
 assert.equal(reconcileFill(placed,[{...trades[0],commission:'0.00000009'}]),null);
 assert.equal(reconcileFill({...placed,cummulativeQuoteQty:'5.01'},trades),null);
});

test('one validation and one 5 USDT order are sent, then a second run does not order',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'astarter-once-'));
 const receiptPath=path.join(dir,'receipt.json');
 const seen=exchange();
 try{
  const first=await runAuthorizedSpotOrder({creds:{key:KEY,secret:SECRET},fetchImpl:seen.fetchImpl,now:NOW,receiptPath,confirm:'once'});
  assert.equal(first.reconciled,true);
  assert.equal(first.orderId,1001);
  assert.equal(first.fills[0].tradeId,9001);
  assert.equal(first.fills[0].commission,'0.00000008');
  assert.equal(first.executionAuthority,'NONE');
  assert.equal(JSON.stringify(first).includes(SECRET),false);
  const posts=seen.calls.filter(call=>call.path==='/api/v3/order');
  assert.equal(posts.length,1);
  assert.equal(posts[0].query.get('quoteOrderQty'),'5');
  assert.equal(posts[0].query.get('newClientOrderId'),REQUEST_ID);
  assert.equal(seen.calls.some(call=>call.path==='/api/v3/order/test'),true);
  assert.ok(seen.calls.findIndex(call=>call.path==='/api/v3/order/test')<seen.calls.findIndex(call=>call.path==='/api/v3/order'));
  const later=exchange();
  const second=await runAuthorizedSpotOrder({creds:{key:KEY,secret:SECRET},fetchImpl:later.fetchImpl,now:NOW,receiptPath,confirm:'once'});
  assert.equal(second.orderId,1001);
  assert.equal(later.calls.some(call=>call.path==='/api/v3/order'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('withdraw, a short balance, or a failed validation never sends the order',async()=>{
 for(const overrides of [
  {restrictions:{...restrictions,enableWithdrawals:true}},
  {account:{canTrade:true,balances:[{asset:'USDT',free:'4',locked:'0'}]}},
  {test:{code:-1013,msg:'Filter failure'}}
 ]){
  const seen=exchange(overrides);
  const dir=await mkdtemp(path.join(tmpdir(),'astarter-once-'));
  await assert.rejects(runAuthorizedSpotOrder({creds:{key:KEY,secret:SECRET},fetchImpl:seen.fetchImpl,now:NOW,receiptPath:path.join(dir,'receipt.json'),confirm:'once'}));
  assert.equal(seen.calls.some(call=>call.path==='/api/v3/order'),false);
  await rm(dir,{recursive:true,force:true});
 }
});

test('the order is refused without the one-shot confirmation',async()=>{
 const seen=exchange();
 await assert.rejects(runAuthorizedSpotOrder({creds:{key:KEY,secret:SECRET},fetchImpl:seen.fetchImpl,now:NOW,receiptPath:path.join(tmpdir(),'missing.json'),confirm:''}),/CONFIRM_REQUIRED/);
 assert.equal(seen.calls.length,0);
});
