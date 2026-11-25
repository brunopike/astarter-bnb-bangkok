import test from 'node:test';
import assert from 'node:assert/strict';
import {riskPreview} from './risk-strategy.mjs';
import {friendlyText,helpContent} from './product-help.mjs';
test('a concentrated portfolio uses the smallest remaining risk budget',()=>{
 const p=riskPreview('crowded');
 assert.equal(p.requested,25);assert.equal(p.allowed,5);
 assert.deepEqual(p.binding,['asset','group']);
 assert.equal(p.budgets.find(b=>b.id==='account').remaining,45);
 assert.equal(p.budgets.find(b=>b.id==='asset').used,45);
});
test('conservative sizing reduces new risk but normal mode cannot clear a hard lock',()=>{
 assert.equal(riskPreview('normal','normal').allowed,25);
 assert.equal(riskPreview('normal','conservative').allowed,12.5);
 assert.equal(riskPreview('drawdown','normal').allowed,12.5);
 for(const mode of ['normal','conservative']){const p=riskPreview('halt',mode);assert.equal(p.allowed,0);assert.equal(p.locked,true);}
});
test('unconfirmed orders keep their risk holds while new entries wait',()=>{
 const p=riskPreview('unknown');assert.equal(p.allowed,0);assert.equal(p.action,'reconcile');
 assert.equal(p.budgets.find(b=>b.id==='account').pending,5);
 assert.equal(p.budgets.find(b=>b.id==='asset').remaining,45);
 assert.equal(riskPreview('event').allowed,0);
});
test('profit reserve is a separate fixture and never compounds across repeated reads',()=>{
 const p=riskPreview('profit');assert.equal(p.reserve,400);assert.equal(p.tradeable,11600);
 assert.equal(p.equity,p.reserve+p.tradeable);assert.deepEqual(riskPreview('profit'),p);
 assert.equal(riskPreview('normal').reserve,0);
});
test('display wording preserves numbers and identifiers and does not corrupt review labels',()=>{
 const original='回执未知 · SIM-ORD-187 · 0.0046071 ETH / 23 USDT';
 const text=friendlyText(original);assert.ok(text.includes('SIM-ORD-187 · 0.0046071 ETH / 23 USDT'));
 assert.equal(friendlyText(text),text);assert.equal(friendlyText('复盘口径'),'查看统计方式');
 assert.equal(friendlyText('盘口深度'),'盘口深度');assert.equal(helpContent('missing'),null);
});
