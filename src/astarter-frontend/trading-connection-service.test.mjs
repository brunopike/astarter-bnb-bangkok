import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTradingConnectionStore,createTradingConnectionService} from './trading-connection-service.mjs';
import {applyCheckedTradingConnection} from './connection-options.mjs?v=20261120c';
import {TradingAccess} from './trading-access.mjs?v=20261120c';

const KEY='test-key-12345678';
const SECRET='secret-SHOULD-NOT-LEAK-0123456789';
const OTHER='other-SHOULD-NOT-LEAK-9876543210';
const restrictions=overrides=>({enableReading:true,enableWithdrawals:false,enableInternalTransfer:false,permitsUniversalTransfer:false,enableSpotAndMarginTrading:false,enableFutures:false,enableMargin:false,...overrides});
const account=overrides=>({canTrade:false,canWithdraw:true,balances:[{asset:'USDT',free:'12.50',locked:'0'}],...overrides});
function fetchFor(script,{fail}={}){
 const calls=[];
 const fetchImpl=async url=>{
  calls.push(String(url).split('?')[0]);
  if(fail)throw Object.assign(Error('timed out'),{name:'TimeoutError'});
  const path=calls.at(-1).replace('https://api.binance.com','');
  if(path==='/api/v3/time')return json({serverTime:1_700_000_000_000});
  const step=script[path];
  if(!step)throw Error('unexpected '+path);
  return json(step);
 };
 return {fetchImpl,calls};
}
function json(data){return {ok:true,async text(){return JSON.stringify(data);}};}
function storeWith(fetchImpl){return createTradingConnectionStore({encryptionKey:'test-connection-key',now:()=>1_700_000_000_100,fetchImpl});}
const OPERATOR={address:'0x1111111111111111111111111111111111111111',chain:56,expires:Date.now()+60_000};
function openService(options={}){return createTradingConnectionService({sessionOf:()=>OPERATOR,...options,env:{ASTARTER_TRADING_OPERATORS:OPERATOR.address,...(options.env||{})}});}
const spotInput=(secret=SECRET)=>({ownerId:'alice',venue:'binance',market:'spot',key:KEY,secret});

test('two owners cannot read each other, and a failed check keeps the draft',async()=>{
 const {fetchImpl}=fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 const store=storeWith(fetchImpl);
 const draft={amount:100,protection:{id:'original',version:'strategy-original'}},before=structuredClone(draft);
 const alice=await store.saveAndCheck(spotInput());
 assert.equal(store.readOne('bob',alice.connectionId),null);
 assert.equal(store.list('bob').length,0);
 const bob=await store.saveAndCheck({...spotInput(OTHER),ownerId:'bob'});
 assert.equal(JSON.stringify(store.readOne('bob',alice.connectionId)).includes(SECRET),false);
 assert.equal(JSON.stringify(store.protectedSecrets('bob')).includes(SECRET),false);
 assert.equal(JSON.stringify(store.protectedSecrets('alice')).includes(OTHER),false);
 assert.notEqual(store.protectedSecrets('alice')[0].data,store.protectedSecrets('bob')[0].data);
 assert.deepEqual(draft,before);
 assert.equal(JSON.stringify(store.list('alice')).includes(SECRET),false);
 assert.equal(JSON.stringify(store.list('bob')).includes(OTHER),false);
 for(const box of store.protectedSecrets('alice'))assert.equal(JSON.stringify(box).includes(SECRET),false);
});

test('spot and perp are separate records and an expired preferred is not replaced',async()=>{
 const {fetchImpl}=fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true,enableFutures:true})});
 const store=storeWith(fetchImpl);
 const spot=await store.saveAndCheck(spotInput());
 const perp=await store.saveAndCheck({...spotInput(),market:'perp'});
 assert.notEqual(spot.connectionId,perp.connectionId);
 assert.equal(store.list('alice').length,2);
 assert.equal(store.preferred('alice','cex-spot').connectionId,'binance-spot');
 assert.equal(store.preferred('alice','cex-perp').connectionId,'binance-perp');
 store.mark('alice','binance-spot','expired');
 assert.equal(store.preferred('alice','cex-spot'),null);
 assert.equal(store.preferred('alice','cex-perp').connectionId,'binance-perp');
 assert.equal(store.readOne('alice','binance-spot').status,'expired');
});

test('missing fields and non-binance venues are not stored or called',async()=>{
 let calls=0;
 const store=storeWith(async()=>{calls++;return json({});});
 assert.equal((await store.saveAndCheck({ownerId:'alice',venue:'binance',key:KEY,secret:SECRET})).error,'invalid-connection');
 assert.equal((await store.saveAndCheck({ownerId:'alice',venue:'okx',market:'spot',key:KEY,secret:SECRET,passphrase:'missing-not-stored'})).error,'unsupported-venue');
 assert.equal(store.list('alice').length,0);
 assert.equal(calls,0);
});

test('read, trade and withdraw receipts keep the same connection id',async()=>{
 const cases=[
  [{enableReading:true},account(),'connected','read'],
  [{enableSpotAndMarginTrading:true},account({canTrade:true}),'connected','trade'],
  [{enableWithdrawals:true},account({canTrade:true}),'denied',null],
  [{permitsUniversalTransfer:true},account({canTrade:true}),'denied',null]
 ];
 for(const [flags,balances,status,permission] of cases){
  const seen=[];
  const store=storeWith(async url=>{seen.push(String(url).split('?')[0]);const path=seen.at(-1).replace('https://api.binance.com','');if(path==='/api/v3/time')return json({serverTime:1});if(path==='/api/v3/account')return json(balances);return json(restrictions(flags));});
  const first=await store.saveAndCheck(spotInput());
  const second=await store.saveAndCheck(spotInput());
  assert.equal(first.connectionId,'binance-spot');
  assert.equal(second.connectionId,first.connectionId);
  assert.equal(second.status,status);
  assert.equal(second.permission,permission);
  assert.equal(second.balanceChecked,true);
  if(status==='connected'){assert.equal(second.available,12.5);assert.equal(second.locked,0);}
  else assert.equal(Object.hasOwn(second,'available'),false);
  assert.equal(JSON.stringify(second).includes('12.50'),false);
  assert.equal(JSON.stringify(second).includes('withdraw'),false);
  assert.equal(seen.some(url=>url.includes('/api/v3/order')),false);
 }
});

test('a timeout retries the original connection id',async()=>{
 let fail=true;
 const store=storeWith(async url=>{
  if(fail)throw Object.assign(Error('timed out'),{name:'TimeoutError'});
  const path=String(url).split('?')[0].replace('https://api.binance.com','');
  if(path==='/api/v3/time')return json({serverTime:1});
  if(path==='/api/v3/account')return json(account());
  return json(restrictions());
 });
 const timedOut=await store.saveAndCheck(spotInput());
 assert.equal(timedOut.status,'disconnected');
 assert.equal(store.list('alice').length,1);
 fail=false;
 const again=await store.saveAndCheck(spotInput());
 assert.equal(again.connectionId,timedOut.connectionId);
 assert.equal(again.status,'connected');
 assert.equal(store.list('alice').length,1);
});

test('an unsigned visitor cannot read the spot book or replace the saved connection',async()=>{
 const {fetchImpl,calls}=fetchFor({'/api/v3/account':account({canTrade:true}),'/api/v3/openOrders':[],'/api/v3/allOrders':[],'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 const service=createTradingConnectionService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const read=responseCapture();
 assert.equal(await service.handle({method:'GET',url:'/api/trading-connections'},read.res),true);
 assert.equal(read.res.status,401);
 const readBody=JSON.parse(read.chunks.join(''));
 assert.equal(readBody.error,'sign-in-required');
 assert.equal(readBody.spotBook,undefined);
 assert.equal(readBody.connections,undefined);
 const write=responseCapture();
 assert.equal(await service.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',apiKey:KEY,apiSecret:SECRET}},write.res),true);
 assert.equal(write.res.status,401);
 assert.equal(JSON.parse(write.chunks.join('')).error,'sign-in-required');
 assert.equal(calls.length,0);
 const outsider=createTradingConnectionService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key',ASTARTER_TRADING_OPERATORS:'0x2222222222222222222222222222222222222222'},fetchImpl,now:()=>1_700_000_000_100,sessionOf:()=>OPERATOR});
 const blocked=responseCapture();
 assert.equal(await outsider.handle({method:'GET',url:'/api/trading-connections'},blocked.res),true);
 assert.equal(blocked.res.status,401);
 assert.equal(calls.length,0);
 const signed=createTradingConnectionService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100,sessionOf:()=>OPERATOR});
 const replace=responseCapture();
 assert.equal(await signed.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',apiKey:KEY,apiSecret:SECRET}},replace.res),true);
 assert.equal(replace.res.status,403);
 assert.equal(JSON.parse(replace.chunks.join('')).error,'operator-required');
 const grid=responseCapture();
 assert.equal(await signed.handle({method:'POST',url:'/api/trading-connections/s01-grid',body:{lower:'58000',upper:'64000',count:4,spacing:'arithmetic',amount:'6',cap:'25'}},grid.res),true);
 assert.equal(grid.res.status,403);
 assert.equal(calls.length,0);
});

test('the http response and logs do not contain the key or secret',async()=>{
 const logs=[];
 const original=console.log,originalError=console.error;
 console.log=(...args)=>logs.push(args.join(' '));
 console.error=(...args)=>logs.push(args.join(' '));
 try{
  const service=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl:fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})}).fetchImpl,now:()=>1_700_000_000_100});
  const chunks=[];
  const result=await service.handle({method:'GET',url:'/api/trading-connections'},{writeHead(){},end(body){chunks.push(body);}});
  assert.equal(result,true);
  const body=chunks.join('');
  assert.equal(body.includes(KEY),false);
  assert.equal(body.includes(SECRET),false);
  assert.equal(logs.join('\n').includes(SECRET),false);
  assert.equal(JSON.parse(body).executionAuthority,'NONE');
  assert.equal(JSON.parse(body).connections[0].status,'connected');
  assert.equal(JSON.parse(body).connections[0].permission,'trade');
 }finally{console.log=original;console.error=originalError;}
});

test('a restricted location does not send the key',async()=>{
 const calls=[];
 const store=storeWith(async(url,options)=>{
  calls.push([String(url).split('?')[0],options?.headers?.['X-MBX-APIKEY']||'']);
  return {status:451,ok:false,async text(){return '{"code":0,"msg":"restricted location"}';}};
 });
 const result=await store.saveAndCheck(spotInput());
 assert.equal(result.status,'disconnected');
 assert.equal(result.reason,'restricted-location');
 assert.ok(calls.length>=1);
 assert.ok(calls.every(([url,apiKey])=>url==='https://api.binance.com/api/v3/time'&&apiKey===''));
 assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('a checked binance account can be viewed and cannot submit an order',()=>{
 const connections=applyCheckedTradingConnection({exchange:true,tradingAccounts:[{id:'legacy-exchange',kind:'exchange',service:'binance',market:'spot',access:'trade',accountId:'SIM-01'}],preferredTradingConnection:'legacy-exchange'},{connections:[{connectionId:'binance-spot',venue:'binance',kind:'CEX',market:'spot',permission:'trade',status:'connected',checkedAt:10}]});
 const draft={amount:250,cap:1000,protection:{id:'original'}},before=structuredClone(draft);
 const access=new TradingAccess(connections).status({state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}},{connectionId:'binance-spot',profileId:'cex-spot',operation:'entry'});
 assert.equal(access.code,'exchange-trade-held');
 assert.equal(access.ready,false);
 assert.equal(access.trade,false);
 const observe=new TradingAccess(connections).status({state:'LIVE',generation:1,scope:{accountId:'SIM-01',environment:'DEMO'}},{connectionId:'binance-spot',profileId:'cex-spot',operation:'observe'});
 assert.equal(observe.code,'observe-ready');
 assert.equal(connections.preferredTradingConnection,'binance-spot');
 assert.equal(connections.tradingAccounts.find(record=>record.id==='legacy-exchange').accountId,'SIM-01');
 assert.deepEqual(draft,before);
});

function responseCapture(){
 const chunks=[];
 return {chunks,res:{writeHead(status,headers){this.status=status;this.headers=headers;},end(body){chunks.push(body);}}};
}

test('the spot book lists filled history without the client order id',async()=>{
 const history=[{orderId:68874446964,clientOrderId:'astarter-s01-20261121-1',side:'BUY',type:'LIMIT_MAKER',price:'56251.89000000',origQty:'0.00009000',executedQty:'0.00009000',status:'FILLED',time:1763700000000},{orderId:68874446969,clientOrderId:'astarter-s01-20261121-2',side:'BUY',type:'LIMIT_MAKER',price:'55763.36000000',origQty:'0.00009000',executedQty:'0',status:'NEW',time:1763700001000}];
 const {fetchImpl,calls}=fetchFor({'/api/v3/account':account({canTrade:true,balances:[{asset:'USDT',free:'9.91766770',locked:'0'},{asset:'BTC',free:'0.00035964',locked:'0'}]}),'/api/v3/openOrders':[],'/api/v3/allOrders':history,'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 const service=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const cap=responseCapture();
 assert.equal(await service.handle({method:'GET',url:'/api/trading-connections'},cap.res),true);
 const body=JSON.parse(cap.chunks.join(''));
 assert.equal(body.executionAuthority,'NONE');
 assert.equal(body.spotBook.orders.length,0);
 assert.equal(body.spotBook.history.length,1);
 assert.equal(body.spotBook.history[0].orderId,68874446964);
 assert.equal(body.spotBook.history[0].strategy,'S01');
 assert.equal(body.spotBook.history[0].clientOrderId,undefined);
 assert.equal(body.connections.find(row=>row.connectionId==='binance-spot').available,body.spotBook.usdt);
 assert.equal(JSON.stringify(body).includes('astarter-s01'),false);
 assert.equal(calls.some(url=>url.includes('/api/v3/order')&&!url.includes('/api/v3/openOrders')&&!url.includes('/api/v3/allOrders')),false);
 const traded=fetchFor({'/api/v3/account':account({canTrade:true,balances:[{asset:'USDT',free:'9.91766770',locked:'0'},{asset:'BTC',free:'0.00035964',locked:'0'}]}),'/api/v3/openOrders':[],'/api/v3/allOrders':history,'/api/v3/myTrades':[{id:9001,orderId:68874446964,price:'56251.89',qty:'0.00009',quoteQty:'5.0626701',commission:'0.00000009',commissionAsset:'BTC',isBuyer:true,time:1763700000000}],'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 const withTrades=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl:traded.fetchImpl,now:()=>1_700_000_000_100});
 const tradeCap=responseCapture();
 assert.equal(await withTrades.handle({method:'GET',url:'/api/trading-connections'},tradeCap.res),true);
 const tradeBody=JSON.parse(tradeCap.chunks.join(''));
 assert.equal(tradeBody.spotBook.trades.length,1);
 assert.equal(tradeBody.spotBook.trades[0].commissionAsset,'BTC');
 assert.equal(tradeBody.spotBook.trades[0].commission,'0.00000009');
 assert.equal(JSON.stringify(tradeBody).includes('clientOrderId'),false);
});

test('the S01 grid submits limit buys below the bid and a repeat does not add orders',async()=>{
 const placed=new Map();
 const posts=[];
 const fetchImpl=async(url,options={})=>{
  const path=String(url).split('?')[0].replace('https://api.binance.com','');
  const query=new URL(String(url)).searchParams;
  if(path==='/api/v3/time')return json({serverTime:1_700_000_000_000});
  if(path==='/api/v3/exchangeInfo')return json({symbols:[{symbol:'BTCUSDT',status:'TRADING',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.00001'},{filterType:'NOTIONAL',minNotional:'5'}]}]});
  if(path==='/api/v3/ticker/bookTicker')return json({bidPrice:'60000.00',askPrice:'60001.00'});
  if(path==='/api/v3/account')return json(account({canTrade:true,balances:[{asset:'USDT',free:'100.00',locked:'0'}]}));
  if(path==='/sapi/v1/account/apiRestrictions')return json(restrictions({enableSpotAndMarginTrading:true}));
  if(path==='/api/v3/order'&&options.method==='GET'){const known=placed.get(query.get('origClientOrderId'));return known?json(known):json({code:-2013,msg:'Order does not exist.'});}
  if(path==='/api/v3/order'&&options.method==='POST'){
   const order={orderId:70000000000+posts.length,price:query.get('price'),origQty:query.get('quantity'),status:'NEW',clientOrderId:query.get('newClientOrderId'),side:query.get('side'),type:query.get('type'),symbol:query.get('symbol')};
   posts.push(order);placed.set(order.clientOrderId,order);return json(order);
  }
  throw Error('unexpected '+path+' '+options.method);
 };
 const service=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const plan={lower:'58000',upper:'64000',count:4,spacing:'arithmetic',amount:'6',cap:'25'};
 const first=responseCapture();
 assert.equal(await service.handle({method:'POST',url:'/api/trading-connections/s01-grid',body:plan},first.res),true);
 const body=JSON.parse(first.chunks.join(''));
 assert.equal(first.res.status,200);
 assert.equal(body.ok,true);
 assert.equal(body.symbol,'BTCUSDT');
 assert.equal(body.side,'BUY');
 assert.equal(body.type,'LIMIT_MAKER');
 assert.equal(body.withdraw,false);
 assert.ok(body.orders.length>=1);
 assert.ok(body.orders.every(order=>Number(order.price)<60000));
 assert.equal(posts.length,body.orders.length);
 assert.equal(posts.every(order=>order.side==='BUY'&&order.type==='LIMIT_MAKER'&&order.symbol==='BTCUSDT'),true);
 assert.equal(JSON.stringify(body).includes(SECRET),false);
 assert.equal(JSON.stringify(body).includes('100.00'),false);
 const again=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/s01-grid',body:plan},again.res);
 assert.equal(JSON.parse(again.chunks.join('')).orders.length,body.orders.length);
 assert.equal(posts.length,body.orders.length);
 const small=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/s01-grid',body:{...plan,amount:'4'}},small.res);
 assert.equal(small.res.status,400);
 assert.equal(JSON.parse(small.chunks.join('')).error,'below-minimum');
 assert.equal(posts.length,body.orders.length);
 const large=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/s01-grid',body:{...plan,amount:'20',cap:'1000'}},large.res);
 assert.equal(large.res.status,400);
 assert.equal(JSON.parse(large.chunks.join('')).error,'demo-limit');
 assert.equal(posts.length,body.orders.length);
});

test('cancel removes one open S01 order and a repeat does not send another delete',async()=>{
 const orders=new Map([['68949351615',{symbol:'BTCUSDT',orderId:68949351615,clientOrderId:'as01'+'a'.repeat(16),side:'BUY',type:'LIMIT_MAKER',status:'NEW',price:'58418.19',origQty:'0.00012'}]]);
 const deletes=[];
 const fetchImpl=async(url,options={})=>{
  const path=String(url).split('?')[0].replace('https://api.binance.com','');
  const query=new URL(String(url)).searchParams;
  if(path==='/api/v3/time')return json({serverTime:1_700_000_000_000});
  if(path==='/api/v3/account')return json(account({canTrade:true,balances:[{asset:'USDT',free:'37.60',locked:'13.57'}]}));
  if(path==='/sapi/v1/account/apiRestrictions')return json(restrictions({enableSpotAndMarginTrading:true}));
  if(path==='/api/v3/order'&&options.method==='GET'){const known=orders.get(query.get('orderId'));return known?json(known):json({code:-2013,msg:'Order does not exist.'});}
  if(path==='/api/v3/order'&&options.method==='DELETE'){const known=orders.get(query.get('orderId'));if(!known)return json({code:-2011,msg:'Unknown order sent.'});known.status='CANCELED';deletes.push(query.get('orderId'));return json({...known,status:'CANCELED'});}
  throw Error('unexpected '+path+' '+options.method);
 };
 const service=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const first=responseCapture();
 assert.equal(await service.handle({method:'POST',url:'/api/trading-connections/cancel-order',body:{orderId:'68949351615'}},first.res),true);
 const body=JSON.parse(first.chunks.join(''));
 assert.equal(first.res.status,200);
 assert.deepEqual(body,{ok:true,orderId:'68949351615',status:'CANCELED',strategy:'S01',withdraw:false});
 assert.deepEqual(deletes,['68949351615']);
 assert.equal(JSON.stringify(body).includes(SECRET),false);
 assert.equal(JSON.stringify(body).includes('37.60'),false);
 assert.equal(JSON.stringify(body).includes('as01'),false);
 const again=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/cancel-order',body:{orderId:'68949351615'}},again.res);
 assert.equal(JSON.parse(again.chunks.join('')).status,'CANCELED');
 assert.deepEqual(deletes,['68949351615']);
 orders.set('700',{symbol:'BTCUSDT',orderId:700,clientOrderId:'manual-order',side:'BUY',status:'NEW'});
 const foreign=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/cancel-order',body:{orderId:'700'}},foreign.res);
 assert.equal(foreign.res.status,400);
 assert.equal(JSON.parse(foreign.chunks.join('')).error,'not-strategy');
 assert.deepEqual(deletes,['68949351615']);
 const shaped=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections/cancel-order',body:{orderId:'68949351615',symbol:'BTCUSDT',side:'SELL'}},shaped.res);
 assert.equal(shaped.res.status,400);
 assert.equal(JSON.parse(shaped.chunks.join('')).error,'invalid-order');
 assert.deepEqual(deletes,['68949351615']);
 const guest=responseCapture();
 assert.equal(await createTradingConnectionService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100}).handle({method:'POST',url:'/api/trading-connections/cancel-order',body:{orderId:'68949351615'}},guest.res),true);
 assert.equal(guest.res.status,401);
 assert.deepEqual(deletes,['68949351615']);
});

test('an order-shaped request is refused and does not reach Binance',async()=>{
 const {fetchImpl,calls}=fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 const service=openService({env:{ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const cap=responseCapture();
 const result=await service.handle({method:'POST',url:'/api/trading-connections',body:{symbol:'BTCUSDT',side:'BUY',notional:'1',order:true}},cap.res);
 assert.equal(result,true);
 assert.equal(cap.res.status,403);
 const payload=JSON.parse(cap.chunks.join(''));
 assert.equal(payload.error,'orders-disabled');
 assert.equal(payload.executionAuthority,'NONE');
 assert.equal(calls.some(url=>String(url).includes('/api/v3/order')),false);
});

test('POST saves encrypted secrets, checks immediately, and never returns them',async()=>{
 const logs=[];
 const original=console.log,originalError=console.error;
 console.log=(...args)=>logs.push(args.join(' '));
 console.error=(...args)=>logs.push(args.join(' '));
 const dir=await mkdtemp(path.join(tmpdir(),'astarter-conn-'));
 try{
  const {fetchImpl,calls}=fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
  const persistPath=path.join(dir,'trading-connections.json');
  const service=openService({env:{ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100,persistPath});
  const draft={amount:100,protection:{id:'original'}},before=structuredClone(draft);
  const cap=responseCapture();
  const result=await service.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',apiKey:KEY,apiSecret:SECRET,label:'Primary'}},cap.res);
  assert.equal(result,true);
  const payload=JSON.parse(cap.chunks.join(''));
  assert.equal(payload.executionAuthority,'NONE');
  assert.equal(payload.connections[0].status,'connected');
  assert.equal(payload.connections[0].permission,'trade');
  assert.equal(payload.connections[0].accountId,'BINANCE-SPOT');
  assert.equal(payload.connections[0].label,'Primary');
  assert.equal(JSON.stringify(payload).includes(KEY),false);
  assert.equal(JSON.stringify(payload).includes(SECRET),false);
  assert.equal(logs.join('\n').includes(SECRET),false);
  assert.equal(logs.join('\n').includes(KEY),false);
  assert.ok(calls.some(url=>url.endsWith('/api/v3/account')));
  const raw=await readFile(persistPath,'utf8');
  assert.equal(raw.includes(KEY),false);
  assert.equal(raw.includes(SECRET),false);
  const mode=(await stat(persistPath)).mode & 0o777;
  assert.equal(mode,0o600);
  const reloaded=openService({env:{ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl:fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})}).fetchImpl,now:()=>1_700_000_000_200,persistPath});
  const again=responseCapture();
  await reloaded.handle({method:'GET',url:'/api/trading-connections'},again.res);
  const listed=JSON.parse(again.chunks.join(''));
  assert.equal(listed.connections[0].status,'connected');
  assert.equal(listed.connections[0].accountId,'BINANCE-SPOT');
  assert.equal(JSON.stringify(listed).includes(SECRET),false);
  assert.deepEqual(draft,before);
 }finally{console.log=original;console.error=originalError;await rm(dir,{recursive:true,force:true});}
});

test('POST withdraw keys are denied, failed checks keep the draft, and GET never includes secrets',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'astarter-conn-'));
 try{
  const draft={amount:250,protection:{id:'kept'}},before=structuredClone(draft);
  const denied=openService({env:{ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl:fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableWithdrawals:true})}).fetchImpl,now:()=>1_700_000_000_100,persistPath:path.join(dir,'denied.json')});
  const cap=responseCapture();
  await denied.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',apiKey:KEY,apiSecret:SECRET}},cap.res);
  const deniedBody=JSON.parse(cap.chunks.join(''));
  assert.equal(deniedBody.connections[0].status,'denied');
  assert.equal(deniedBody.connections[0].permission,null);
  assert.equal(deniedBody.executionAuthority,'NONE');
  assert.equal(JSON.stringify(deniedBody).includes(SECRET),false);
  assert.deepEqual(draft,before);
  const failed=openService({env:{ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl:async()=>{throw Object.assign(Error('timed out'),{name:'TimeoutError'});},now:()=>1_700_000_000_100});
  const failCap=responseCapture();
  await failed.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',key:KEY,secret:SECRET}},failCap.res);
  const failedBody=JSON.parse(failCap.chunks.join(''));
  assert.equal(failedBody.connections[0].status,'disconnected');
  assert.equal(failedBody.connections[0].reason,'timeout');
  assert.equal(failedBody.connections[0].status==='connected',false);
  assert.deepEqual(draft,before);
  const getCap=responseCapture();
  await failed.handle({method:'GET',url:'/api/trading-connections'},getCap.res);
  const listed=JSON.parse(getCap.chunks.join(''));
  assert.equal(JSON.stringify(listed).includes(KEY),false);
  assert.equal(JSON.stringify(listed).includes(SECRET),false);
  const invalid=responseCapture();
  const invalidResult=await failed.handle({method:'POST',url:'/api/trading-connections',body:{venue:'okx',market:'spot',apiKey:KEY,apiSecret:SECRET}},invalid.res);
  assert.equal(invalidResult,true);
  assert.equal(invalid.res.status,400);
  assert.equal(JSON.parse(invalid.chunks.join('')).error,'unsupported-venue');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('UI-saved credentials become the source of truth after a successful save',async()=>{
 const envFetch=fetchFor({'/api/v3/account':account(),'/sapi/v1/account/apiRestrictions':restrictions({enableReading:true})});
 const uiFetch=fetchFor({'/api/v3/account':account({canTrade:true}),'/sapi/v1/account/apiRestrictions':restrictions({enableSpotAndMarginTrading:true})});
 let useUi=false;
 const fetchImpl=async(...args)=>useUi?uiFetch.fetchImpl(...args):envFetch.fetchImpl(...args);
 const service=openService({env:{BINANCE_API_KEY:KEY,BINANCE_API_SECRET:SECRET,ASTARTER_CONNECTION_KEY:'test-connection-key'},fetchImpl,now:()=>1_700_000_000_100});
 const first=responseCapture();
 await service.handle({method:'GET',url:'/api/trading-connections'},first.res);
 assert.equal(JSON.parse(first.chunks.join('')).connections[0].permission,'read');
 useUi=true;
 const posted=responseCapture();
 await service.handle({method:'POST',url:'/api/trading-connections',body:{venue:'binance',market:'spot',apiKey:KEY,apiSecret:OTHER}},posted.res);
 const body=JSON.parse(posted.chunks.join(''));
 assert.equal(body.connections[0].permission,'trade');
 assert.equal(body.connections[0].status,'connected');
 assert.equal(JSON.stringify(body).includes(OTHER),false);
});
