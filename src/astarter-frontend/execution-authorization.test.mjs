import test from 'node:test';
import assert from 'node:assert/strict';
import {executionAuthorization,liveOrderAllowed,mandateMatches} from './execution-authorization.mjs';

const beforeDeadline=Date.parse('2026-11-23T15:59:59.999Z');
const order={
 connectionId:'binance-spot',
 accountId:'BINANCE-SPOT',
 venue:'binance',
 market:'spot',
 pair:'BTC/USDT',
 symbol:'BTCUSDT',
 notional:'5',
 notionalAsset:'USDT',
 withdraw:false
};

test('the written mandate is the checked Binance spot account, BTC/USDT, 5 USDT, through 2026-11-23 Asia/Shanghai',()=>{
 assert.equal(executionAuthorization.connectionId,'binance-spot');
 assert.equal(executionAuthorization.accountId,'BINANCE-SPOT');
 assert.equal(executionAuthorization.symbol,'BTCUSDT');
 assert.equal(executionAuthorization.maxNotional,'5');
 assert.equal(executionAuthorization.notionalAsset,'USDT');
 assert.equal(executionAuthorization.deadline,'2026-11-23T15:59:59.999Z');
 assert.equal(executionAuthorization.withdraw,false);
 assert.equal(executionAuthorization.ordersEnabled,false);
 assert.equal(executionAuthorization.executionAuthority,'NONE');
});

test('a matching order is inside the written range and still cannot be sent',()=>{
 assert.equal(mandateMatches(order,beforeDeadline),true);
 assert.equal(mandateMatches({...order,notional:'5.0'},beforeDeadline),true);
 assert.equal(mandateMatches({...order,notional:'0.5'},beforeDeadline),true);
 assert.equal(liveOrderAllowed(order,beforeDeadline),false);
 assert.equal(liveOrderAllowed(),false);
});

test('a different account, pair, amount, or time is outside the written range',()=>{
 assert.equal(mandateMatches({...order,symbol:'ETHUSDT'},beforeDeadline),false);
 assert.equal(mandateMatches({...order,notional:'5.01'},beforeDeadline),false);
 assert.equal(mandateMatches({...order,notional:'0'},beforeDeadline),false);
 assert.equal(mandateMatches({...order,connectionId:'okx-spot'},beforeDeadline),false);
 assert.equal(mandateMatches({...order,withdraw:true},beforeDeadline),false);
 assert.equal(mandateMatches(order,beforeDeadline+1),false);
 assert.equal(liveOrderAllowed({...order,notional:'5'},beforeDeadline),false);
});
