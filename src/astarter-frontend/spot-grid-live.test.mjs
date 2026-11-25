import test from 'node:test';
import assert from 'node:assert/strict';
import {planGrid} from './spot-grid-live.mjs';

test('the grid stays inside 20 USDT and each buy clears 5 USDT',()=>{
 const orders=planGrid({close:'56000',atr:'200',bid:'56010'});
 assert.ok(orders.length>=1&&orders.length<=4);
 let spent=0;
 for(const order of orders){
  const notional=Number(order.price)*Number(order.quantity);
  assert.ok(notional+1e-8>=5,order.price);
  assert.ok(Number(order.price)<56010);
  spent+=notional;
 }
 assert.ok(spent<=20.0000001);
});
