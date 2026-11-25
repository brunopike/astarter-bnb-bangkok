import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY,PRICE_VERSION,PLANS,PACKS,TASKS,STAKE_RULES,createState,upgradeState,currentPlan,balance,purchaseQuote,newOrder,payOrder,quote,startTask,settleTask,budgetUsage,setBudget,stakeQuote,stake,claim,requestUnlock,withdraw,advance,rewardPoolLeft} from './membership-state.mjs';
const now=1793037600000;
const pro=()=>{const s=createState(now);payOrder(s,newOrder(s,'plan','pro').id);return s;};
const auto=s=>{s.preferences.autoEnabled=true;return s;};
test('P0.3 purchase prices grant full credits and no pack bonus for all payment rails',()=>{
 assert.equal(PRICE_VERSION,'P0.3');assert.deepEqual(PACKS.map(p=>p.credits),[5000,10000,30000,100000]);
 for(const [id,price,credits] of [['starter',7.2,3000],['pro',23.2,12000],['team',79.2,45000]]){const q=purchaseQuote('plan',id,'token');assert.equal(q.price,price);assert.equal(q.credits,credits);}
 assert.equal(purchaseQuote('pack','medium','token').price,24);assert.equal(purchaseQuote('pack','medium','usdc').price,30);assert.equal(purchaseQuote('pack','medium','card').price,30);
});
test('custom top-up validates whole USD before any mutation, then $15 token payment grants 15000',()=>{
 const s=createState(now),before=JSON.stringify(s);
 for(const n of [0,4,5.5,NaN,10001])assert.throws(()=>newOrder(s,'pack','custom','token',n),/invalid-topup/);
 assert.throws(()=>newOrder(s,'plan','free'));assert.throws(()=>newOrder(s,'pack','small','crypto'));assert.throws(()=>newOrder(s,'x','small'));assert.equal(JSON.stringify(s),before);
 const o=newOrder(s,'pack','custom','token',15);assert.equal(o.price,12);assert.equal(o.tokenAmount,60);payOrder(s,o.id);assert.equal(balance(s).available,15600);assert.equal(s.wallet,9940);
});
test('failed, pending and cancelled payments do not spend tokens or grant entitlement',()=>{
 const s=createState(now),o=newOrder(s,'plan','pro');payOrder(s,o.id,'failed');assert.equal(newOrder(s,'plan','pro').id,o.id);payOrder(s,o.id,'pending');assert.equal(s.wallet,10000);assert.equal(balance(s).available,600);assert.equal(currentPlan(s).id,'free');payOrder(s,o.id,'cancelled');payOrder(s,o.id);assert.equal(s.wallet,10000);assert.equal(balance(s).available,600);
});
test('successful token payment debits once, grants once and freezes original price snapshot',()=>{
 const s=createState(now),o=newOrder(s,'pack','medium');payOrder(s,o.id);payOrder(s,o.id);assert.equal(s.wallet,9880);assert.equal(balance(s).available,30600);assert.equal(o.tokenAmount,120);assert.equal(o.price,24);assert.equal(o.priceVersion,'P0.3');assert.equal(s.lots.length,2);
});
test('locked token balance cannot fund a payment, failure keeps order recoverable',()=>{
 const s=createState(now);stake(s,10000,30);const o=newOrder(s,'plan','pro');assert.throws(()=>payOrder(s,o.id),/token-insufficient/);assert.equal(o.status,'pending');assert.equal(balance(s).available,600);payOrder(s,newOrder(s,'plan','pro','usdc').id);assert.equal(currentPlan(s).id,'pro');assert.equal(s.wallet,0);
});
test('Pro task quotes match agreed independent prices and BYOK applies only to AI',()=>{
 const s=pro();for(const [id,a,b] of [['question',18,15],['brief',27,22],['lite',90,72],['research',270,216],['portfolio',270,216],['strategy',450,360],['review',1080,864],['backtest',270,270],['deep',3600,2880],['flagship',4500,3600]]){assert.equal(quote(s,id).cost,a,id);assert.equal(quote(s,id,true).cost,b,id);}
});
test('all profiles fit their own bounded platform cost and personal-key routes retain cost ceiling',()=>{
 const s=createState(now);payOrder(s,newOrder(s,'plan','team','usdc').id);for(const x of TASKS){for(const byok of [false,true]){const q=quote(s,x.id,byok);assert.ok(q.platformEstimate<=q.costLimit,x.id);}}
});
test('reservation and settlement conserve credits; cancel/failed jobs release once',()=>{
 const s=pro(),a=startTask(s,'research',true);assert.deepEqual(balance(s),{total:12600,reserved:216,available:12384,spent:0});settleTask(s,a.id);settleTask(s,a.id);assert.equal(s.lots[0].remaining,384);assert.equal(balance(s).spent,216);const b=startTask(s,'research');settleTask(s,b.id,'failed');settleTask(s,b.id,'failed');assert.equal(balance(s).available,12384);assert.equal(balance(s).reserved,0);
});
test('manual confirmation uses credits but never consumes automatic research budget',()=>{
 const s=auto(pro());setBudget(s,0,0);const a=startTask(s,'review');settleTask(s,a.id);assert.equal(balance(s).spent,1080);assert.deepEqual(budgetUsage(s),{spent:0,reserved:0,limit:0,remaining:0});
});
test('automatic research requires entitlement, enabled state and per-task authorization',()=>{
 const s=createState(now);s.preferences.autoEnabled=true;assert.throws(()=>startTask(s,'lite',false,{mode:'auto'}),/plan-required/);
 const p=pro();assert.throws(()=>startTask(p,'research',false,{mode:'auto'}),/auto-paused/);auto(p);setBudget(p,300,100);assert.throws(()=>startTask(p,'research',false,{mode:'auto'}),/single-limit/);setBudget(p,300,300);const a=startTask(p,'research',false,{mode:'auto'});assert.equal(a.cost,270);
});
test('daily automatic reservation, spend and cancellation share the same budget',()=>{
 const s=auto(pro()),a=startTask(s,'research',false,{mode:'auto'});assert.deepEqual(budgetUsage(s),{spent:0,reserved:270,limit:300,remaining:30});assert.throws(()=>startTask(s,'research',false,{mode:'auto'}),/budget/);settleTask(s,a.id);const b=startTask(s,'brief',false,{mode:'auto'});settleTask(s,b.id);assert.equal(budgetUsage(s).spent,297);assert.throws(()=>startTask(s,'question',false,{mode:'auto'}),/budget/);advance(s,1);assert.equal(budgetUsage(s).remaining,300);const c=startTask(s,'research',false,{mode:'auto'});settleTask(s,c.id,'cancelled');assert.equal(budgetUsage(s).remaining,300);
});
test('same event is deduplicated before rechecking changed budget, no second charge',()=>{
 const s=auto(pro()),a=startTask(s,'research',false,{mode:'auto',requestKey:'evidence-1'});settleTask(s,a.id);setBudget(s,0,0);assert.equal(startTask(s,'research',true,{mode:'auto',requestKey:'evidence-1'}).id,a.id);assert.equal(s.tasks.length,1);assert.equal(balance(s).spent,270);
});
test('insufficient balance and concurrency are enforced without altering allocation',()=>{
 const s=createState(now);assert.throws(()=>startTask(s,'review'),/insufficient/);const a=startTask(s,'research');assert.throws(()=>startTask(s,'question'),/capacity/);settleTask(s,a.id,'cancelled');assert.equal(balance(s).available,600);
});
test('over-cost completion fails without charging credits, preserving recorded incident cost',()=>{
 const s=pro(),a=startTask(s,'review');assert.throws(()=>settleTask(s,a.id,'complete',NaN),/invalid-cost/);assert.equal(a.status,'reserved');settleTask(s,a.id,'complete',10);assert.equal(a.status,'failed');assert.equal(a.failure,'cost-limit');assert.equal(a.actualCost,10);assert.equal(balance(s).spent,0);assert.equal(balance(s).available,12600);
});
test('invalid budgets do not change stored limits',()=>{
 const s=pro();for(const pair of [[-1,100],[20,1.2],[NaN,30],[1e7,100]])assert.throws(()=>setBudget(s,...pair),/invalid-budget/);assert.equal(s.preferences.autoBudget,300);setBudget(s,0,0);assert.equal(s.preferences.autoBudget,0);
});
test('prepaid plan queues; second plan cannot debit; next period receives exactly one allowance',()=>{
 const s=pro(),o=newOrder(s,'plan','team');payOrder(s,o.id);assert.equal(currentPlan(s).id,'pro');assert.equal(balance(s).available,12600);const wallet=s.wallet;const b=newOrder(s,'plan','starter');assert.throws(()=>payOrder(s,b.id),/already-scheduled/);assert.equal(wallet,s.wallet);assert.equal(b.status,'pending');advance(s,30);assert.equal(currentPlan(s).id,'team');assert.equal(s.preferences.autoBudget,1200);assert.equal(balance(s).available,45000);payOrder(s,o.id);assert.equal(balance(s).available,45000);
});
test('purchased credits survive subscription expiry and do not grant membership',()=>{
 const s=pro();payOrder(s,newOrder(s,'pack','medium').id);advance(s,31);assert.equal(balance(s).available,30000);assert.equal(currentPlan(s).id,'free');assert.throws(()=>startTask(auto(s),'lite',false,{mode:'auto'}),/plan-required/);
});
test('expiry does not make authorized reservations negative or turn released expired credit permanent',()=>{
 const s=createState(now),a=startTask(s,'lite');s.now+=15*DAY;assert.deepEqual(balance(s),{total:100,reserved:100,available:0,spent:0});settleTask(s,a.id,'cancelled');assert.deepEqual(balance(s),{total:0,reserved:0,available:0,spent:0});
});
test('legacy migration preserves historical money, bonus credits, prices, pending allocations and wallet',()=>{
 const old={version:1,now,seq:9,plan:'pro',planUntil:now+30*DAY,queued:null,wallet:9000.12,positions:[],orders:[{id:'old-paid',kind:'pack',sku:'medium',method:'usdc',price:30,credits:31500,status:'paid',priceVersion:'P0.1'}],tasks:[{id:'old-task',task:'research',base:100,cost:72,status:'complete',created:now,allocations:[]}],lots:[{id:'old-lot',kind:'purchased',total:31500,remaining:31428,expires:null}],ledger:[],preferences:{budget:1000}};
 const s=upgradeState(old);assert.equal(s.version,3);assert.equal(s.wallet,9000.12);assert.equal(s.orders[0].credits,31500);assert.equal(s.tasks[0].cost,72);assert.equal(balance(s).available,31428);assert.equal(quote(s,'research',true).cost,216);const twice=upgradeState(s);assert.deepEqual(twice,s);assert.equal(old.version,1);
});
test('pending orders and tasks survive storage round-trip without duplicate grants',()=>{
 const s=pro();newOrder(s,'pack','small');const a=startTask(s,'lite');const v=upgradeState(JSON.parse(JSON.stringify(s)));assert.equal(v.orders[0].status,'pending');assert.equal(balance(v).reserved,90);assert.equal(v.tasks[0].id,a.id);assert.equal(v.lots.length,2);
});
test('staking uses the same spendable token balance and quote agrees with next-day reward',()=>{
 const s=createState(now);assert.throws(()=>stake(s,10001,30));assert.throws(()=>stake(s,100.5,30));const q=stakeQuote(s,1000,30),p=stake(s,1000,30);assert.equal(s.wallet,9000);assert.equal(q.credits,82);advance(s,1);assert.ok(Math.abs(p.reward-q.reward)<1e-9);assert.equal(p.credits,82);claim(s,p.id);assert.equal(balance(s).available,682);assert.equal(s.lots.at(-1).expires,s.now+30*DAY);assert.throws(()=>claim(s,p.id),/nothing-to-claim/);
});
test('splitting stake cannot exceed per-account daily reward credit cap',()=>{
 const s=createState(now);stake(s,5000,30);stake(s,5000,30);advance(s,1);assert.ok(s.positions.reduce((n,p)=>n+p.credits,0)<=100);assert.ok(s.rewardPool.credits<=100);
});
test('finite period pools stop new accrual; claiming reserved rewards does not consume twice',()=>{
 const s=createState(now);s.rewardPool.credits=STAKE_RULES.creditPeriod-40;s.rewardPool.tokens=STAKE_RULES.tokenPeriod-.01;const p=stake(s,1000,30);advance(s,1);assert.equal(p.credits,40);assert.ok(Math.abs(p.reward-.01)<1e-9);advance(s,1);assert.equal(p.credits,40);assert.equal(rewardPoolLeft(s).credits,0);const allocated=s.rewardPool.credits;claim(s,p.id);assert.equal(s.rewardPool.credits,allocated);assert.equal(balance(s).available,640);
});
test('lock, one-day wait and single withdrawal hold; unlock stops reward accrual',()=>{
 const s=createState(now),p=stake(s,1000,30);assert.throws(()=>requestUnlock(s,p.id),/locked/);advance(s,30);assert.equal(s.poolHistory.length,1);assert.ok(s.poolHistory[0].credits<=250000);requestUnlock(s,p.id);assert.throws(()=>withdraw(s,p.id),/waiting/);const r=p.reward,c=p.credits;advance(s,1);assert.equal(p.reward,r);assert.equal(p.credits,c);withdraw(s,p.id);assert.equal(s.wallet,10000);assert.throws(()=>withdraw(s,p.id));claim(s,p.id);assert.ok(s.wallet>10000);assert.ok(balance(s).available>0);
});
test('expiry pauses automatic research; paying again restores entitlement without restarting it',()=>{
 const s=auto(pro());advance(s,31);assert.equal(currentPlan(s).id,'free');assert.equal(s.preferences.autoEnabled,false);payOrder(s,newOrder(s,'plan','pro','usdc').id);assert.equal(currentPlan(s).id,'pro');assert.equal(s.preferences.autoEnabled,false);assert.throws(()=>startTask(s,'lite',false,{mode:'auto'}),/auto-paused/);s.preferences.autoEnabled=true;assert.equal(startTask(s,'lite',false,{mode:'auto'}).cost,90);
});
