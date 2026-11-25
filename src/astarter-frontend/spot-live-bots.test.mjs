import test from 'node:test';
import assert from 'node:assert/strict';
import {spotBotStrategy,spotBotBinding} from './spot-live-bots.mjs';
import {publicSpotBook} from './connection-options.mjs';

test('open orders are tagged only for the S01 and S02 client ids',()=>{
 assert.equal(spotBotStrategy('astarter-s01-20261121-1'),'S01');
 assert.equal(spotBotStrategy('as01'+'a'.repeat(16)),'S01');
 assert.equal(spotBotStrategy('astarter-s02-20261121-1'),'S02');
 assert.equal(spotBotStrategy('as01'),'');
 assert.equal(spotBotStrategy('other-order'),'');
 const binding=spotBotBinding([{strategy:'S01'},{strategy:'S02'},{strategy:''}]);
 assert.equal(binding.accountId,'BINANCE-SPOT');
 assert.equal(binding.withdraw,false);
 assert.equal(binding.executionAuthority,'NONE');
 assert.equal(binding.S01.bound,true);
 assert.equal(binding.S01.orders.length,1);
 assert.equal(binding.S02.orders.length,1);
});

test('the public book keeps the strategy tag and drops anything else',()=>{
 const book=publicSpotBook({symbol:'BTCUSDT',usdt:9.91,usdtLocked:15.6,btc:0.00007992,orders:[{orderId:1,side:'BUY',price:'56251.89',origQty:'0.00009',status:'NEW',strategy:'S01',clientOrderId:'astarter-s01-20261121-1'},{orderId:2,side:'BUY',price:'1',origQty:'1',status:'NEW',strategy:'S09-A'}]});
 assert.equal(book.orders[0].strategy,'S01');
 assert.equal(book.orders[0].clientOrderId,undefined);
 assert.equal(book.orders[1].strategy,undefined);
 assert.deepEqual(book.history,[]);
 const history=publicSpotBook({...book,history:[{orderId:'68874446964',side:'BUY',type:'LIMIT_MAKER',price:'56251.89000000',origQty:'0.00009000',executedQty:'0.00009000',status:'FILLED',time:1763700000000,strategy:'S01',clientOrderId:'astarter-s01-20261121-1'},{orderId:'68871608690',side:'BUY',type:'MARKET',price:'0',origQty:'0.00008000',executedQty:'0.00008000',status:'FILLED',time:1763690000000,strategy:'',clientOrderId:'astarter-btc-5-20261121'},{orderId:'7',side:'BUY',price:'1',origQty:'1',executedQty:'0',status:'NEW',strategy:'S01'}]});
 assert.equal(history.history.length,2);
 assert.equal(history.history[0].orderId,'68874446964');
 assert.equal(history.history[0].strategy,'S01');
 assert.equal(history.history[0].clientOrderId,undefined);
 assert.equal(history.history[1].strategy,undefined);
 assert.equal(JSON.stringify(history).includes('astarter-s01'),false);
 const priced=publicSpotBook({symbol:'BTCUSDT',usdt:9.91,usdtLocked:0,btc:0.00035964,btcPrice:56000,orders:[]});
 assert.equal(priced.btcPrice,56000);
 assert.equal(publicSpotBook({symbol:'BTCUSDT',usdt:1,usdtLocked:0,btc:0,btcPrice:-1,orders:[]}).btcPrice,undefined);
});
