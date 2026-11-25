import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptSummary,createCoreReports} from './core-reports.mjs';
const receipt=(job,key='job:1')=>({stage:'acknowledge',key,context:{job}});
test('raw information never becomes a trading conclusion',()=>{
 const r=receipt({route:'direct',source:'chain',symbol:'ETH'});
 const research={task:()=>({phase:'complete',outcome:'candidate',symbol:'ETH'})};
 assert.match(receiptSummary(r,research).text,/交叉核对/);
 assert.equal(receiptSummary({...r,stage:'read'},research),null);
});
test('report distinguishes rejected checks, unconfirmed orders and credited amounts',()=>{
 assert.match(receiptSummary(receipt({business:true,taskType:'validation',result:'blocked'})).text,/不执行/);
 assert.match(receiptSummary(receipt({business:true,taskType:'execution',result:'unknown'})).text,/不重复下单/);
 assert.match(receiptSummary(receipt({business:true,taskType:'credits',settled:16,released:4})).text,/16.*4/);
 assert.match(receiptSummary(receipt({business:true,taskType:'review',result:'filled'}),null,'en').text,/Local fill confirmed/);
});
test('conclusions require completed research and TradFi remains research only',()=>{
 const r=receipt({symbol:'XAU'}),task={phase:'core',outcome:'candidate',domain:'TradFi',symbol:'XAU'},research={task:()=>task};
 assert.match(receiptSummary(r,research).text,/正在比对/);task.phase='complete';
 assert.match(receiptSummary(r,research).text,/仅研究观察/);
});
test('bubble expires, deduplicates and leaves quiet intervals; locale can change while visible',()=>{
 const show=createCoreReports(),r=receipt({business:true,taskType:'credits',settled:16,released:4});
 assert.match(show({time:0,epoch:1,receipt:r}).text,/16/);
 assert.match(show({time:1,epoch:1,receipt:r,locale:'en'}).text,/credits/);
 assert.equal(show({time:6,epoch:1,receipt:r}),null);
 assert.equal(show({time:7,epoch:1,receipt:receipt({route:'direct'},'job:2')}),null);
 assert.ok(show({time:12,epoch:1,receipt:null}));
 assert.equal(show({time:18,epoch:1,receipt:r}),null);
});

test('new completed research reports its result without replaying restored history',()=>{
 const show=createCoreReports(),task={phase:'core',symbol:'SOL',outcome:'conflict'},research={tasks:[task],task:()=>task,revision:()=> 'SOL:v2'};
 assert.equal(show({time:0,epoch:1,research}),null);task.phase='complete';
 assert.match(show({time:1,epoch:1,research}).text,/分歧/);
 assert.equal(show({time:8,epoch:1,research}),null);
 assert.equal(createCoreReports()({time:9,epoch:2,research}),null);
});
