import assert from 'node:assert/strict';
import test from 'node:test';
import {marketTypeOf,redactMemoryText,userKey} from './living-brain.mjs';

test('user key is not the wallet address',()=>{
 const address='0x1111111111111111111111111111111111111111';
 const key=userKey(address);
 assert.equal(key.length,16);
 assert.doesNotMatch(key,/0x/i);
 assert.equal(userKey(address),userKey(address.toUpperCase()));
});

test('memory text drops keys, wallets and long order ids',()=>{
 const clean=redactMemoryText('lbk_secret 0x2222222222222222222222222222222222222222 order 68871608690');
 assert.equal(clean.includes('lbk_'),false);
 assert.equal(clean.includes('0x2222'),false);
 assert.equal(clean.includes('68871608690'),false);
});

test('market type keeps the saved outlet',()=>{
 assert.equal(marketTypeOf('cex-perp','BTC/USDT'),'cex-perp');
 assert.equal(marketTypeOf('','SPX'),'tradfi');
 assert.equal(marketTypeOf('wallet','BTC/USDT'),'');
});
