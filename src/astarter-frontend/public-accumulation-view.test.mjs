import test from 'node:test';
import assert from 'node:assert/strict';
import {publicAccumulationView} from './public-accumulation-view.mjs';

test('accumulation uses the fixed, credited chart and its official methodology in both languages',()=>{
 for(const en of [false,true]){
  const html=publicAccumulationView((zh,english)=>en?english:zh);
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match=>match[1]),[
   'https://algoros.ai/embed/accumulation-addresses/','https://algoros.ai/metrics/accumulation-addresses/'
  ]);
  assert.equal((html.match(/<iframe\b/g)||[]).length,1);
  assert.match(html,/width="100%" height="480" loading="lazy"/);assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  assert.match(html,en?/at least 10 BTC/:/至少 10 BTC/);assert.match(html,en?/never spent funds or received a coinbase output/:/从未支出且从未收到挖矿奖励输出/);
  assert.doesNotMatch(html,/api\/market-hub|\/data\/|<script|10,589,912|signal|交易信号/i);
 }
});
