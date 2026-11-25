// Standalone, simulation-only commercial state. No network or main-workspace account.
export const PRICE_VERSION='P0.3',DAY=86400000,TOKEN_USD=.20;
export const PLANS=[
 {id:'free',name:'Free',price:0,credits:600,factor:1,rate:100,assets:10,strategies:2,parallel:1,seats:1,running:0,addresses:1,auto:false,budget:0,single:0},
 {id:'starter',name:'Starter',price:9,credits:3000,factor:.95,rate:95,assets:30,strategies:10,parallel:1,seats:1,running:1,addresses:3,auto:true,budget:100,single:100},
 {id:'pro',name:'Pro',price:29,credits:12000,factor:.9,rate:90,assets:100,strategies:50,parallel:3,seats:1,running:3,addresses:10,auto:true,budget:300,single:300},
 {id:'team',name:'Team',price:99,credits:45000,factor:.85,rate:85,assets:300,strategies:200,parallel:5,seats:5,running:10,addresses:50,auto:true,budget:1200,single:1200}
];
export const PACKS=[{id:'mini',price:5,credits:5000},{id:'small',price:10,credits:10000},{id:'medium',price:30,credits:30000},{id:'large',price:100,credits:100000}];
export const TASKS=[
 {id:'question',zh:'简短追问',en:'Quick question',base:20,ai:true,estimate:.0021052,variable:.001,zhScope:'基于已有资料，回答一个问题',enScope:'One question using existing context'},
 {id:'brief',zh:'每日简报',en:'Daily brief',base:30,ai:true,estimate:.00342456,variable:.0015,zhScope:'把已有研究整理成一份简报',enScope:'A short update from existing research'},
 {id:'lite',zh:'轻量解读',en:'Quick insight',base:100,ai:true,estimate:.006564,variable:.003,zhScope:'整理已有资料，看看发生了什么',enScope:'A quick explanation of existing evidence'},
 {id:'research',zh:'标准私人研究',en:'Private research',base:300,ai:true,estimate:.04912024,variable:.004,zhScope:'围绕一项资产整理证据、分析并检查结论',enScope:'Evidence, analysis and a consistency check for one asset'},
 {id:'portfolio',zh:'持仓解读',en:'Portfolio review',base:300,ai:true,estimate:.0646278,variable:.006,zhScope:'一个账户，最多10项持仓',enScope:'One account, up to 10 positions'},
 {id:'strategy',zh:'策略草稿',en:'Strategy draft',base:500,ai:true,estimate:.0960308,variable:.008,zhScope:'生成或修改一份策略草稿',enScope:'Create or revise one strategy draft'},
 {id:'review',zh:'完整策略评审',en:'Full strategy review',base:1200,ai:true,estimate:.248096,variable:.02,zhScope:'检查证据、策略和风险，给出下一步建议',enScope:'Review evidence, strategy and risk, then suggest next steps'},
 {id:'backtest',zh:'标准回测',en:'Standard backtest',base:300,ai:false,estimate:.06,variable:.06,zhScope:'单策略、单资产，最多90天和3组参数',enScope:'One strategy and asset, up to 90 days and 3 parameter sets'},
 {id:'deep',zh:'深度评审',en:'Extended review',base:4000,ai:true,estimate:.932384,variable:.02,zhScope:'更多资料与推理，先看本次报价',enScope:'More evidence and reasoning; review the quote first'},
 {id:'flagship',zh:'旗舰模型评审',en:'Flagship review',base:5000,ai:true,estimate:1.16048,variable:.02,zhScope:'更高模型预算，单独确认后运行',enScope:'A larger model budget, confirmed before starting'}
];
// Finite preview pools, not issued-token identity, APR or real reward funding.
export const STAKE_RULES={pool:100000,rewardDaily:10,creditDaily:250000/30,creditCap:100,creditPeriod:250000,tokenPeriod:300,unlockDays:1};
const id=(s,p)=>p+'-'+String(++s.seq).padStart(4,'0');
const dayKey=v=>Math.floor((v+8*3600000)/DAY);
export function currentPlan(s){return PLANS.find(x=>x.id===(s.planUntil>s.now?s.plan:'free'))||PLANS[0];}
export function createState(now=Date.now()){
 return {version:3,now,seq:0,plan:'free',planUntil:0,queued:null,wallet:10000,positions:[],orders:[],tasks:[],lots:[{id:'welcome',kind:'trial',name:'Welcome',total:600,remaining:600,expires:now+14*DAY}],ledger:[],eventSeq:0,preferences:{payment:'token',byok:false,autoEnabled:false,autoBudget:0,singleLimit:0,budgetPlan:'free',customBudget:false},rewardPool:{start:now,credits:0,tokens:0},poolHistory:[]};
}
export function upgradeState(raw,now=Date.now()){
 if(!raw||![1,3].includes(raw.version)||!Array.isArray(raw.lots)||!Array.isArray(raw.orders))return createState(now);
 const s=structuredClone(raw);
 if(s.version===1){
  s.version=3;s.eventSeq=0;s.poolHistory=[];s.rewardPool={start:s.now,credits:0,tokens:0};
  const p=currentPlan(s);s.preferences={...s.preferences,payment:'token',byok:false,autoEnabled:false,autoBudget:p.budget,singleLimit:p.single,budgetPlan:p.id,customBudget:false};
  for(const t of s.tasks){t.priceVersion||='P0.1';t.mode||='manual';t.legacy=true;t.allocations||=[];if(t.task==='research'){t.labelZh||='资产轻量研究';t.labelEn||='Asset insight';}}
  for(const o of s.orders){o.standardPrice??=o.price;o.discount??=0;o.priceVersion||='P0.1';}
 }
 for(const t of s.tasks)if(t.legacy&&t.task==='research'){t.labelZh||='资产轻量研究';t.labelEn||='Asset insight';}
 if(!currentPlan(s).auto)s.preferences.autoEnabled=false;
 return s;
}
export function balance(s){
 const active=s.lots.filter(l=>!l.expires||l.expires>s.now),total=active.reduce((n,l)=>n+l.remaining,0);
 const pending=s.tasks.filter(t=>t.status==='reserved');
 const reserved=pending.reduce((n,t)=>n+t.cost,0);
 // A still-authorized reservation may finish after its source lot expires.
 const protectedExpired=pending.flatMap(t=>t.allocations).reduce((n,a)=>{const l=s.lots.find(x=>x.id===a.lotId);return n+(l?.expires&&l.expires<=s.now?a.amount:0);},0);
 return {total:total+protectedExpired,reserved,available:Math.max(0,total+protectedExpired-reserved),spent:s.tasks.filter(t=>t.status==='complete').reduce((n,t)=>n+t.cost,0)};
}
function log(s,type,amount,ref,detail=''){s.ledger.unshift({id:id(s,'EV'),type,amount,ref,detail,time:s.now});}
function lot(s,kind,name,amount,expires,ref){if(amount<=0)return;s.lots.push({id:id(s,'LOT'),kind,name,total:amount,remaining:amount,expires,ref});log(s,'credit',amount,ref,kind);}
function planDefaults(s,p){if(!s.preferences.customBudget||s.preferences.budgetPlan==='free'){s.preferences.autoBudget=p.budget;s.preferences.singleLimit=p.single;}s.preferences.budgetPlan=p.id;}
export function purchaseQuote(kind,sku,method='token',customUSD=null){
 if(!['token','usdc','card'].includes(method))throw Error('payment-unavailable');
 if(!['plan','pack'].includes(kind))throw Error('invalid-order');
 const custom=kind==='pack'&&sku==='custom';
 if(custom&&(!Number.isInteger(customUSD)||customUSD<5||customUSD>10000))throw Error('invalid-topup');
 const item=custom?{id:'custom',price:customUSD,credits:customUSD*1000}:(kind==='plan'?PLANS:PACKS).find(x=>x.id===sku);
 if(!item||!item.price)throw Error('invalid-order');
 const standardCents=Math.round(item.price*100),cents=method==='token'?standardCents*80/100:standardCents;
 return {kind,sku,method,standardPrice:standardCents/100,price:cents/100,credits:item.credits,discount:(standardCents-cents)/100,tokenAmount:method==='token'?Math.ceil(cents*100/(TOKEN_USD*100))/100:null,tokenUSD:method==='token'?TOKEN_USD:null,priceVersion:PRICE_VERSION};
}
export function newOrder(s,kind,sku,method='token',customUSD=null){
 const q=purchaseQuote(kind,sku,method,customUSD);
 const old=s.orders.find(o=>o.kind===kind&&o.sku===sku&&o.method===method&&o.standardPrice===q.standardPrice&&o.priceVersion===PRICE_VERSION&&['pending','failed'].includes(o.status));
 if(old)return old;
 const o={...q,id:id(s,'SIM'),status:'pending',created:s.now,autoRenew:false};s.orders.unshift(o);return o;
}
export function payOrder(s,orderId,outcome='paid'){
 const o=s.orders.find(x=>x.id===orderId);if(!o)throw Error('not-found');
 if(['paid','cancelled'].includes(o.status))return o;
 if(!['paid','failed','pending','cancelled'].includes(outcome))throw Error('invalid-state');
 if(outcome==='paid'){
  if(o.kind==='plan'&&s.planUntil>s.now&&s.queued)throw Error('already-scheduled');
  if(o.method==='token'&&o.tokenAmount>s.wallet+1e-9)throw Error('token-insufficient');
 }
 o.status=outcome;if(outcome!=='paid')return o;
 if(o.method==='token'){s.wallet=Math.round((s.wallet-o.tokenAmount)*1e8)/1e8;log(s,'payment-token',o.tokenAmount,o.id);}
 o.paid=s.now;
 if(o.kind==='pack'){lot(s,'purchased',o.sku,o.credits,null,o.id);o.delivery='active';}
 else{
  o.periodStart=Math.max(s.now,s.planUntil);o.periodEnd=o.periodStart+30*DAY;
  if(s.planUntil>s.now){s.queued={plan:o.sku,orderId:o.id,credits:o.credits};o.delivery='scheduled';}
  else{s.plan=o.sku;s.planUntil=o.periodEnd;s.preferences.autoEnabled=false;lot(s,'membership',o.sku,o.credits,s.planUntil,o.id);planDefaults(s,currentPlan(s));o.delivery='active';}
 }
 return o;
}
export function quote(s,taskId,byok=false){
 const t=TASKS.find(x=>x.id===taskId);if(!t)throw Error('invalid-task');const p=currentPlan(s),useKey=!!(t.ai&&byok);
 const memberCost=Math.ceil(t.base*p.rate/100),cost=Math.ceil(t.base*p.rate*(useKey?80:100)/10000);
 return {task:t.id,base:t.base,member:p.factor,key:useKey?.8:1,cost,memberCost,byok:useKey,priceVersion:PRICE_VERSION,labelZh:t.zh,labelEn:t.en,
  platformEstimate:useKey?t.variable:t.estimate,costLimit:cost*.00072*.4};
}
export function budgetUsage(s){
 const jobs=s.tasks.filter(t=>t.mode==='auto'&&dayKey(t.created)===dayKey(s.now));
 const spent=jobs.filter(t=>t.status==='complete').reduce((n,t)=>n+t.cost,0),reserved=jobs.filter(t=>t.status==='reserved').reduce((n,t)=>n+t.cost,0);
 const limit=s.preferences.autoBudget;return {spent,reserved,limit,remaining:Math.max(0,limit-spent-reserved)};
}
export function setBudget(s,budget,single){
 if(!Number.isInteger(budget)||!Number.isInteger(single)||budget<0||single<0||budget>1000000||single>1000000)throw Error('invalid-budget');
 s.preferences.autoBudget=budget;s.preferences.singleLimit=single;s.preferences.customBudget=true;
}
export function startTask(s,taskId,byok=false,options={}){
 const mode=options.mode||'manual';if(!['manual','auto'].includes(mode))throw Error('invalid-state');
 if(options.requestKey){const old=s.tasks.find(t=>t.requestKey===options.requestKey);if(old)return old;}
 const q=quote(s,taskId,byok);
 if(q.platformEstimate>q.costLimit+1e-10)throw Error('scope');
 if(mode==='auto'){
  if(!currentPlan(s).auto)throw Error('plan-required');
  if(!s.preferences.autoEnabled)throw Error('auto-paused');
  if(q.cost>s.preferences.singleLimit)throw Error('single-limit');
  if(q.cost>budgetUsage(s).remaining)throw Error('budget');
 }
 if(balance(s).available<q.cost)throw Error('insufficient');
 if(s.tasks.filter(t=>t.status==='reserved').length>=currentPlan(s).parallel)throw Error('capacity');
 const t={...q,id:id(s,'TASK'),status:'reserved',created:s.now,mode,requestKey:options.requestKey,allocations:[]};let needed=q.cost;
 const lots=[...s.lots].filter(l=>!l.expires||l.expires>s.now).sort((a,b)=>(a.expires||Infinity)-(b.expires||Infinity));
 for(const l of lots){const r=s.tasks.filter(t=>t.status==='reserved').flatMap(t=>t.allocations).filter(a=>a.lotId===l.id).reduce((n,a)=>n+a.amount,0);const take=Math.min(needed,l.remaining-r);if(take>0){t.allocations.push({lotId:l.id,amount:take});needed-=take;}if(!needed)break;}
 if(needed)throw Error('insufficient');s.tasks.unshift(t);log(s,'reserve',t.cost,t.id,taskId);return t;
}
export function settleTask(s,taskId,outcome='complete',actualCost=null){
 const t=s.tasks.find(t=>t.id===taskId);if(!t||t.status!=='reserved')return t;
 if(!['complete','cancelled','failed'].includes(outcome))throw Error('invalid-state');
 const c=actualCost??t.platformEstimate??0;
 if(!Number.isFinite(c)||c<0)throw Error('invalid-cost');
 if(outcome==='complete'&&t.costLimit!=null&&c>t.costLimit+1e-10){outcome='failed';t.failure='cost-limit';}
 if(outcome==='complete')for(const a of t.allocations){const l=s.lots.find(l=>l.id===a.lotId);l.remaining-=a.amount;}
 t.status=outcome;t.actualCost=c;t.completed=s.now;
 log(s,outcome==='complete'?'spend':'release',t.cost,t.id,t.task);return t;
}
export function rewardPoolLeft(s){return {credits:Math.max(0,STAKE_RULES.creditPeriod-s.rewardPool.credits),tokens:Math.max(0,STAKE_RULES.tokenPeriod-s.rewardPool.tokens),end:s.rewardPool.start+30*DAY};}
export function stakeQuote(s,amount,days){
 const current=s.positions.filter(p=>p.status==='locked').reduce((n,p)=>n+p.amount,0),share=amount/(STAKE_RULES.pool+current+amount),userShare=(current+amount)/(STAKE_RULES.pool+current+amount);
 const scale=Math.min(1,STAKE_RULES.creditCap/(userShare*STAKE_RULES.creditDaily||1)),left=rewardPoolLeft(s);
 return {share,reward:Math.min(share*STAKE_RULES.rewardDaily,left.tokens),credits:Math.min(Math.floor(share*STAKE_RULES.creditDaily*scale),left.credits),days};
}
export function stake(s,amount,days){
 if(!Number.isInteger(amount)||amount<100||amount>s.wallet||![30,90].includes(days))throw Error('invalid-stake');
 const p={id:id(s,'STAKE'),amount,days,start:s.now,end:s.now+days*DAY,lastDay:dayKey(s.now),reward:0,credits:0,claimedReward:0,claimedCredits:0,status:'locked'};
 s.wallet-=amount;s.positions.unshift(p);log(s,'stake',amount,p.id);return p;
}
export function claim(s,positionId){
 const p=s.positions.find(p=>p.id===positionId);if(!p||(!p.reward&&!p.credits))throw Error('nothing-to-claim');
 s.wallet+=p.reward;p.claimedReward+=p.reward;p.claimedCredits+=p.credits;lot(s,'staking',p.id,p.credits,s.now+30*DAY,p.id);if(p.reward)log(s,'reward',p.reward,p.id);p.reward=0;p.credits=0;
}
export function requestUnlock(s,positionId){const p=s.positions.find(p=>p.id===positionId);if(!p||p.status!=='locked'||s.now<p.end)throw Error('locked');p.status='unlocking';p.unlockAt=s.now+DAY;}
export function withdraw(s,positionId){const p=s.positions.find(p=>p.id===positionId);if(!p||p.status!=='unlocking'||s.now<p.unlockAt)throw Error('waiting');s.wallet+=p.amount;p.status='withdrawn';log(s,'withdraw',p.amount,p.id);}
export function advance(s,days=1){
 if(!Number.isInteger(days)||days<1||days>90)throw Error('invalid-days');
 for(let d=0;d<days;d++){
  s.now+=DAY;
  for(const t of s.tasks.filter(t=>t.status==='reserved'))settleTask(s,t.id,'cancelled');
  // The elapsed day's rewards belong to its original pool, then the next cycle opens.
  const active=s.positions.filter(p=>p.status==='locked'),user=active.reduce((n,p)=>n+p.amount,0),total=STAKE_RULES.pool+user;
  const scale=Math.min(1,STAKE_RULES.creditCap/(user/total*STAKE_RULES.creditDaily||1));
  for(const p of active){if(dayKey(s.now)<=p.lastDay)continue;p.lastDay=dayKey(s.now);const left=rewardPoolLeft(s),r=Math.min(p.amount/total*STAKE_RULES.rewardDaily,left.tokens),c=Math.min(Math.floor(p.amount/total*STAKE_RULES.creditDaily*scale),left.credits);p.reward+=r;p.credits+=c;s.rewardPool.tokens+=r;s.rewardPool.credits+=c;}
  if(s.now>=s.rewardPool.start+30*DAY){s.poolHistory.push({...s.rewardPool});s.rewardPool={start:s.now,credits:0,tokens:0};}
  if(s.queued&&s.now>=s.planUntil){const q=s.queued;s.plan=q.plan;s.planUntil=s.now+30*DAY;lot(s,'membership',q.plan,q.credits,s.planUntil,q.orderId);const o=s.orders.find(o=>o.id===q.orderId);if(o)o.delivery='active';s.queued=null;planDefaults(s,currentPlan(s));}
  if(!currentPlan(s).auto)s.preferences.autoEnabled=false;
 }
}
