import test from 'node:test';
import assert from 'node:assert/strict';
import {commerceFixture} from './commerce-test-fixture.mjs';
import {checkout,confirmTask,modal,taskCreditSummary,commerceContext,commerceContextLink,contextTasks,taskCreditDetails} from './commerce-ui.mjs';
import {createMembership,planChoice,creditParts,usageSummary,usageSeries,usageTasks,commerceCsv} from './membership.mjs';
function dom(t){
 const saved={document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame},dialogs=[];
 const node=()=>({disabled:false,textContent:'',innerHTML:'',isConnected:true,focus(){}});
 class Dialog{
  constructor(){this.nodes=new Map();this.handlers={};this.attrs={};this.open=false;}
  set innerHTML(html){this.html=html;this.nodes.set('[data-close]',node());this.nodes.set('[role=alert]',node());this.nodes.set('.commerce-body',node());for(const m of html.matchAll(/<button[^>]*data-action="([^"]+)"[^>]*>/g))this.nodes.set(`[data-action="${m[1]}"]`,{...node(),disabled:m[0].includes('disabled')});}
  querySelector(key){return this.nodes.get(key)||null;}
  querySelectorAll(){return [...this.nodes].filter(([key])=>key.startsWith('[data-')).map(([,n])=>n);}
  setAttribute(key,value){this.attrs[key]=value;}
  removeAttribute(key){delete this.attrs[key];}
  addEventListener(key,fn){this.handlers[key]=fn;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){this.removed=true;}
 }
 globalThis.document={activeElement:node(),documentElement:{lang:'zh-CN'},querySelector:()=>node(),createElement:()=>new Dialog(),body:{append(d){dialogs.push(d);}}};
 globalThis.requestAnimationFrame=fn=>fn();
 t.after(()=>{Object.assign(globalThis,saved);});
 return {dialogs,latest:()=>dialogs.at(-1),click:(d,id)=>d.querySelector(`[data-action="${id}"]`).onclick(),escape:d=>d.handlers.cancel({preventDefault(){}})};
}
function membershipDom(){
 let html='',buttons=[],inputs=[];
 const root={classList:{add(){}},querySelector(selector){const value=selector.match(/\[value="([^"]+)"\]/)?.[1];return value?inputs.find(n=>n.value===value&&selector.includes(n.marker)):null;},
 querySelectorAll(selector){return selector==='[data-commerce]'?buttons:inputs.filter(n=>selector==='['+n.marker+']');},
 get innerHTML(){return html;},set innerHTML(value){html=value;
  buttons=[...value.matchAll(/<button[^>]*data-commerce="([^"]+)"[^>]*>/g)].map(m=>({dataset:{commerce:m[1],id:m[0].match(/data-id="([^"]+)"/)?.[1]},disabled:m[0].includes('disabled'),isConnected:true,focus(){root.focused=this;}}));
  inputs=[...value.matchAll(/<input[^>]*value="([^"]+)"[^>]*(data-plan-choice|data-billing-interval)[^>]*>/g)].map(m=>({value:m[1],marker:m[2],focus(){root.focused=this;}}));
 }};
 return {root,choose(marker,value){const node=inputs.find(n=>n.marker===marker&&n.value===value);assert.ok(node);node.onchange();},button(action){return buttons.find(n=>n.dataset.commerce===action);}};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('opening and dismissing checkout creates no order or credit movement',async t=>{
 const f=await commerceFixture(t),ui=dom(t),pending=checkout(f.account,{kind:'topup',dollars:10});await flush();
 assert.equal(f.account.s.orders.length,0);assert.ok(ui.latest().attrs['aria-labelledby']);assert.doesNotMatch(ui.latest().html,/工作区|workspace/i);
 assert.doesNotMatch(ui.latest().html,/commerce-payment-test|data-outcome|测试支付异常|Test payment outcomes/);
 assert.equal(ui.latest().querySelector('select'),null);
 ui.escape(ui.latest());assert.equal(await pending,null);assert.equal(f.account.available,600);assert.equal(f.account.s.orders.length,0);
});
test('failed checkout retry targets the same order and grants credits once',async t=>{
 const f=await commerceFixture(t),ui=dom(t),command=f.account.command.bind(f.account);let attempts=0;
 f.account.command=(action,payload)=>{
  if(action!=='order-pay')return command(action,payload);
  assert.equal(Object.hasOwn(payload,'outcome'),false,'the UI cannot choose a payment result');
  return command(action,{...payload,...(++attempts===1?{outcome:'failed'}:{})});
 };
 const pending=checkout(f.account,{kind:'topup',dollars:10});await flush();
 await ui.click(ui.latest(),'pay');const failed=await pending;assert.equal(failed.status,'failed');assert.equal(f.account.available,600);
 const retry=checkout(f.account,{kind:'topup',dollars:10},failed);await flush();await ui.click(ui.latest(),'pay');const paid=await retry;
 assert.equal(paid.id,failed.id);assert.equal(f.account.s.orders.length,1);assert.equal(f.account.available,10600);
});
test('Escape and repeated clicks cannot dismiss or duplicate an in-flight payment',async t=>{
 const f=await commerceFixture(t),ui=dom(t),command=f.account.command.bind(f.account);let release;
 f.account.command=async(action,...args)=>{if(action==='order-pay')await new Promise(r=>release=r);return command(action,...args);};
 let ended=false;const result=checkout(f.account,{kind:'topup',dollars:10}).then(x=>{ended=true;return x;});await flush();
 const dialog=ui.latest(),click=ui.click(dialog,'pay');await new Promise(r=>setImmediate(r));ui.escape(dialog);await ui.click(dialog,'pay');
 assert.equal(ended,false);assert.equal(dialog.open,true);release();await click;assert.equal((await result).status,'delivered');assert.equal(f.account.s.orders.length,1);assert.equal(f.account.available,10600);
});
test('top-up inside a quote returns to review without starting the job',async t=>{
 const f=await commerceFixture(t),ui=dom(t),result=confirmTask(f.account,{profile:'R3',mode:'manual',payers:{model:'official',data:'official'},input:{title:'Deep research'}});
 await new Promise(r=>setImmediate(r));const quote=ui.latest();assert.equal(quote.querySelector('[data-action="start"]').disabled,true);
 const replenish=ui.click(quote,'back');await flush();assert.notEqual(ui.latest(),quote);await ui.click(ui.latest(),'pay');await replenish;
 assert.equal(f.account.available,10600);assert.equal(f.account.s.tasks.length,0);assert.equal(quote.open,true);assert.equal(quote.querySelector('[data-action="start"]').disabled,false);ui.escape(quote);assert.equal(await result,null);
});
test('plan choices distinguish new activation, future change, renewals, teams and read-only roles',()=>{
 const s={scopeType:'personal',role:'owner',plan:'pro'};
 assert.equal(planChoice(s,'starter'),'next');assert.equal(planChoice(s,'pro'),'renew');assert.equal(planChoice(s,'team'),'team');
 assert.equal(planChoice({...s,plan:'free'},'starter'),'activate');assert.equal(planChoice({...s,queued:'next'},'starter'),'queued');assert.equal(planChoice({...s,role:'viewer'},'pro'),'readonly');assert.equal(planChoice({...s,scopeType:'team',plan:'team'},'pro'),'personal');
});

test('yearly review uses the server subtotal and discount and delivers only the first monthly grant',async t=>{
 const f=await commerceFixture(t),ui=dom(t),pending=checkout(f.account,{kind:'plan',product:'pro',interval:'yearly'});await flush();
 assert.match(ui.latest().html,/\$348/);assert.match(ui.latest().html,/−\$104\.40/);assert.match(ui.latest().html,/\$243\.60/);assert.match(ui.latest().html,/12,000/);assert.doesNotMatch(ui.latest().html,/144,000/);
 assert.equal(f.account.s.orders.length,0);await ui.click(ui.latest(),'pay');const order=await pending;
 assert.equal(order.billing_interval,'yearly');assert.equal(order.cents,24360);assert.equal(f.account.available,12600);assert.equal(f.account.s.realPayments,false);
});
test('a slow quote cannot open duplicate checkout dialogs',async t=>{
 const f=await commerceFixture(t),ui=dom(t),command=f.account.command.bind(f.account);let release,quotes=0;
 f.account.command=async(action,...args)=>{if(action==='order-quote'){quotes++;await new Promise(r=>release=r);}return command(action,...args);};
 const first=checkout(f.account,{kind:'topup',dollars:30}),second=checkout(f.account,{kind:'topup',dollars:30});assert.equal(first,second);assert.equal(quotes,1);release();await flush();assert.equal(ui.dialogs.length,1);ui.escape(ui.latest());await first;
 assert.equal(f.account.s.orders.length,0);const third=checkout(f.account,{kind:'topup',dollars:10});release();await flush();ui.escape(ui.latest());await third;assert.equal(quotes,2);
});
test('selected plan and interval survive leaving the page and cancelling review',async t=>{
 const f=await commerceFixture(t),dialogs=dom(t),ui=membershipDom(),page=createMembership({root:ui.root,account:f.account,navigate(){}});
 page.render('plans');ui.choose('data-billing-interval','quarterly');ui.choose('data-plan-choice','starter');page.render('usage');page.render('plans');
 assert.match(ui.root.innerHTML,/value="quarterly" data-billing-interval checked/);assert.match(ui.root.innerHTML,/data-id="starter"/);assert.match(ui.root.innerHTML,/\$24\.30/);
 const pending=ui.button('plan').onclick();await flush();assert.match(dialogs.latest().html,/\$24\.30/);dialogs.escape(dialogs.latest());await pending;
 assert.equal(f.account.s.orders.length,0);assert.match(ui.root.innerHTML,/value="quarterly" data-billing-interval checked/);
});
test('loading the account does not overwrite the initial current-plan selection',async t=>{
 const f=await commerceFixture(t);dom(t);await f.buy('starter');const loaded=f.account.s,ui=membershipDom(),page=createMembership({root:ui.root,account:f.account,navigate(){}});
 f.account.s={plan:'free',orders:[]};page.render('plans');f.account.s=loaded;page.render('plans');assert.match(ui.root.innerHTML,/value="starter" data-plan-choice checked/);assert.match(ui.root.innerHTML,/data-id="starter"/);
});
test('a changed subscription start cannot silently pay a quote from another tab',async t=>{
 const f=await commerceFixture(t),ui=dom(t),pending=checkout(f.account,{kind:'plan',product:'pro',interval:'yearly'});await flush();const dialog=ui.latest();
 await f.buy('starter');await ui.click(dialog,'pay');assert.equal(dialog.open,true);assert.match(dialog.querySelector('[role=alert]').textContent,/价格|price/);
 assert.equal(f.account.s.orders.length,1);assert.equal(f.account.s.plan,'starter');ui.escape(dialog);await pending;
});
test('billing shows the purchased term price and monthly Credit rather than a monthly list price',async t=>{
 const f=await commerceFixture(t);dom(t);const order=await f.account.command('order-create',{kind:'plan',product:'pro',interval:'quarterly'});await f.account.command('order-pay',{id:order.id});
 const ui=membershipDom(),page=createMembership({root:ui.root,account:f.account,navigate(){}});page.render('billing');
 const overview=ui.root.innerHTML.match(/<section class="commerce-plan-overview"[\s\S]*?<\/section>/)[0];
 assert.match(overview,/\$78\.30/);assert.match(overview,/季付/);assert.match(overview,/每月 Credit/);assert.doesNotMatch(overview,/\$29|30 天/);assert.equal(f.account.s.orders.length,1);
});

test('Free is an included status, never a subscription command or an assistant shortcut',async t=>{
 const f=await commerceFixture(t);dom(t);const ui=membershipDom(),page=createMembership({root:ui.root,account:f.account,navigate(){assert.fail('a plan selection must not navigate');}});
 for(const product of ['free','pro']){
  if(product==='pro')await f.buy('pro');
  page.render('plans');ui.choose('data-plan-choice','free');const before=JSON.stringify(f.account.s),html=ui.root.innerHTML;
  const free=html.match(/<label[^>]*data-plan="free"[\s\S]*?<\/label>/)?.[0];
  assert.ok(free);assert.doesNotMatch(free,/<button|data-commerce=/);assert.match(html,/commerce-plan-status/);
  assert.match(html,product==='free'?/当前方案/:/免费权益已包含/);assert.match(html,/订阅/);assert.doesNotMatch(html,/会员/);assert.equal(JSON.stringify(f.account.s),before);
 }
});
test('cancelling a subscription review preserves the original card and does not report a mutation',async t=>{
 const f=await commerceFixture(t),ui=dom(t),frames=[];let writes=0,changes=0,renders=0,buttons=[],focused='';globalThis.requestAnimationFrame=fn=>frames.push(fn);
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(selector){return selector==='[data-commerce]'?buttons:[];},
  set innerHTML(value){writes++;buttons=[...value.matchAll(/<button[^>]*data-commerce="([^"]+)"[^>]*data-id="([^"]+)"[^>]*>/g)].map(m=>({dataset:{commerce:m[1],id:m[2]},disabled:false,isConnected:true,focus(){focused=m[2];}}));}};
 const page=createMembership({root,account:f.account,navigate(){},onChange(){changes++;},onRender(){renders++;}});page.render('plans');
 const origin=buttons.find(b=>b.dataset.commerce==='plan'&&b.dataset.id==='pro'),before=JSON.stringify(f.account.s),initialWrites=writes;
 assert.ok(origin);const pending=origin.onclick();await flush();ui.escape(ui.latest());await pending;
 for(const frame of frames)frame();assert.equal(focused,'pro');assert.equal(writes,initialWrites);assert.equal(changes,0);assert.equal(renders,0);assert.equal(origin.disabled,false);assert.equal(JSON.stringify(f.account.s),before);
});

test('scheduled subscriptions expose their billing action and retain the active plan',async t=>{
 const f=await commerceFixture(t);dom(t);await f.buy('pro');await f.buy('starter');const ui=membershipDom(),page=createMembership({root:ui.root,account:f.account,navigate(){}});
 const before=JSON.stringify(f.account.s);page.render('plans');
 const starter=ui.root.innerHTML.match(/<label[^>]*data-plan="starter"[\s\S]*?<\/label>/)[0],pro=ui.root.innerHTML.match(/<label[^>]*data-plan="pro"[\s\S]*?<\/label>/)[0];
 assert.match(starter,/下期生效/);assert.match(pro,/当前订阅/);assert.match(ui.root.innerHTML,/查看下期订阅/);assert.equal(ui.button('plan'),undefined);assert.equal(JSON.stringify(f.account.s),before);
});
test('viewing a scheduled subscription clears an unrelated billing filter',async t=>{
 const f=await commerceFixture(t);dom(t);await f.buy('pro');await f.buy('starter');let html='',buttons=[];
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(selector){return selector==='[data-commerce]'?buttons:[];},get innerHTML(){return html;},
  set innerHTML(value){html=value;buttons=[...value.matchAll(/<button[^>]*data-commerce="([^"]+)"[^>]*data-id="([^"]+)"[^>]*>/g)].map(m=>({dataset:{commerce:m[1],id:m[2]},disabled:false}));}};
 const page=createMembership({root,account:f.account,navigate:id=>page.render(id)});page.render('billing');
 await buttons.find(b=>b.dataset.commerce==='order-filter'&&b.dataset.id==='closed').onclick();assert.match(html,/暂无相关订单/);
 page.render('plans');await buttons.find(b=>b.dataset.commerce==='navigate'&&b.dataset.id==='billing').onclick();
 assert.match(html,/订阅 · Starter/);assert.match(html,/data-id="all" aria-pressed="true"/);assert.equal(f.account.s.plan,'pro');
});

test('cancelling a top-up review preserves the form and restores its controls',async t=>{
 const f=await commerceFixture(t),ui=dom(t),saved=globalThis.FormData;let writes=0,changes=0,focused=null;const frames=[];globalThis.requestAnimationFrame=fn=>frames.push(fn);
 globalThis.document.activeElement={isConnected:true,focus(){focused='body';}};
 globalThis.FormData=class{constructor(){return new Map();}};t.after(()=>{globalThis.FormData=saved;});
 const controls=[{disabled:false,isConnected:true,focus(){focused=this;}},{disabled:true}],error={textContent:''},form={dataset:{form:'topup'},querySelectorAll(){return controls;},querySelector(){return error;}};
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(selector){return selector==='[data-form]'?[form]:[];},set innerHTML(value){writes++;}};
 const page=createMembership({root,account:f.account,navigate(){},onChange(){changes++;}});page.render('topup');const initialWrites=writes,before=JSON.stringify(f.account.s);
 const pending=form.onsubmit({preventDefault(){},submitter:controls[0]});await flush();ui.escape(ui.latest());await pending;
 for(const frame of frames)frame();assert.equal(focused,controls[0],'restore the actual submit button when clicking left the body active');
 assert.equal(writes,initialWrites);assert.equal(changes,0);assert.deepEqual(controls.map(c=>c.disabled),[false,true]);assert.equal(JSON.stringify(f.account.s),before);
});

test('custom top-up validity uses the page message and clears it when the amount is edited',async t=>{
 const f=await commerceFixture(t);dom(t);const input={value:'9',message:'',setCustomValidity(value){this.message=value;}},total={textContent:''};let html='';
 const root={classList:{add(){}},querySelector(selector){return selector==='input[name="dollars"]'?input:selector==='[data-topup-credits]'?total:null;},querySelectorAll(){return [];},set innerHTML(value){html=value;}};
 const page=createMembership({root,account:f.account,navigate(){}});page.render('topup');const before=JSON.stringify(f.account.s);
 input.oninvalid();assert.equal(input.message,'输入 $10–$1,000 的整数金额');
 input.value='10';input.oninput();assert.equal(input.message,'');assert.equal(total.textContent,'10,000 Credit');
 input.value='10.5';input.oninput();assert.equal(total.textContent,'— Credit');input.oninvalid();assert.equal(input.message,'输入 $10–$1,000 的整数金额');
 assert.doesNotMatch(html,/novalidate/);assert.equal(JSON.stringify(f.account.s),before);
});

test('subscription reviews distinguish activation, renewal and a next-period change',async t=>{
 const f=await commerceFixture(t),ui=dom(t);
 let pending=checkout(f.account,{kind:'plan',product:'pro'});await flush();assert.match(ui.latest().html,/确认订阅/);ui.escape(ui.latest());await pending;
 await f.buy('pro');pending=checkout(f.account,{kind:'plan',product:'pro'});await flush();assert.match(ui.latest().html,/确认续订/);ui.escape(ui.latest());await pending;
 pending=checkout(f.account,{kind:'plan',product:'starter'});await flush();assert.match(ui.latest().html,/确认下期换档/);ui.escape(ui.latest());await pending;assert.equal(f.account.s.plan,'pro');assert.equal(f.account.s.orders.length,1);
});
test('credit breakdown excludes expired and reserved credits without changing the ledger',()=>{
 const s={now:100,lots:[{kind:'included',expires:101,remaining:90,held:20},{kind:'welcome',expires:99,remaining:600,held:0},{kind:'purchased',expires:null,remaining:1000,held:0}]};const before=JSON.stringify(s);
 const parts=creditParts(s);assert.equal(parts.find(p=>p.kind==='included').available,70);assert.equal(parts.find(p=>p.kind==='welcome').available,0);assert.equal(parts.find(p=>p.kind==='purchased').available,1000);assert.equal(JSON.stringify(s),before);
});
test('account view never presents a failed initial read as a confirmed zero balance',t=>{
 dom(t);const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(){return [];},innerHTML:''};
 const account={s:{plan:'free',orders:[],scopes:[]},error:'Offline'};const page=createMembership({root,account,navigate(){}});page.render('usage');
 assert.match(root.innerHTML,/账户余额尚未确认|balance is not confirmed/);assert.doesNotMatch(root.innerHTML,/commerce-metrics/);assert.match(root.innerHTML,/data-commerce="refresh"/);
});
test('refresh failure notifies subscribers while preserving the last confirmed balance',async t=>{
 const f=await commerceFixture(t);let events=0;const stop=f.account.subscribe(()=>events++),fetch=f.account.fetch;
 f.account.fetch=async()=>{throw Error('Offline');};await f.account.refresh();assert.equal(events,1);assert.equal(f.account.available,600);assert.equal(f.account.error,'Offline');await f.account.refresh();assert.equal(events,1);
 f.account.fetch=fetch;await f.account.refresh();assert.equal(f.account.error,'');assert.equal(events,2);stop();
});

test('account refresh preserves expanded sections without opening unrelated records',async t=>{
 const f=await commerceFixture(t);dom(t);const job=await f.account.runTask({profile:'R1',input:{title:'Refresh-safe charge details'}});
 let details=[],html='';
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(selector){
  if(selector==='details[open][data-persist-key]')return details.filter(el=>el.open);
  if(selector==='details[data-persist-key]')return details;
  return [];
 },set innerHTML(value){html=value;details=[...value.matchAll(/<details[^>]*data-persist-key="([^"]+)"/g)].map(m=>({dataset:{persistKey:m[1]},open:false}));},get innerHTML(){return html;}};
 const page=createMembership({root,account:f.account,navigate(){}});page.openContext({taskId:job.id});page.render('usage');
 const expanded=['task-charge-'+job.id,'commerce-budget','commerce-prices'];
 for(const el of details)if(expanded.includes(el.dataset.persistKey))el.open=true;
 const previous=details;await f.account.refresh();page.render('usage');
 assert.notEqual(details,previous);assert.deepEqual(details.filter(el=>el.open).map(el=>el.dataset.persistKey),expanded);
 page.render('billing');assert.equal(details.some(el=>el.open),false);
});

test('usage ranges follow UTC+8 and count zero-credit completed tasks without changing source',()=>{
 const day=86400000,now=Date.UTC(2026,10,1,0),first=Date.UTC(2026,9,31,16),prior=first-day;
 const state={now,usage:{from:first-30*day,rows:[{day:prior,profile:'R1',credits:90,tasks:1},{day:first,profile:'R2',credits:359,tasks:1},{day:first,profile:'Q1',credits:0,tasks:2}]}};
 const before=JSON.stringify(state),month=usageSummary(state,'month'),week=usageSummary(state,'7');
 assert.equal(month.from,first);assert.equal(month.days.length,1);assert.equal(month.credits,359);assert.equal(month.tasks,3);assert.equal(month.services.length,2);
 assert.equal(week.credits,449);assert.equal(week.days.length,7);assert.equal(usageSummary(state,'30').days.length,30);assert.equal(JSON.stringify(state),before);assert.equal(usageSummary({now}),null);
});
test('CSV keeps amounts numeric and escapes formulas, quotes, commas and line breaks',()=>{
 const result=commerceCsv([['=SUM(A1)', '  +command', '@user', 'a,"b"\nc'],[12.5,-4,'safe']]);
 assert.ok(result.startsWith('\ufeff'));assert.ok(result.includes('"\'=SUM(A1)"'));assert.ok(result.includes('"\'  +command"'));assert.ok(result.includes('"\'@user"'));assert.ok(result.includes('"a,""b""\nc"'));assert.ok(result.endsWith('"12.5","-4","safe"'));
});

test('all four account pages omit workspace controls, team entry and settings',async t=>{
 const f=await commerceFixture(t);await f.account.command('team-create');dom(t);
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(){return [];},innerHTML:''};
 const page=createMembership({root,account:f.account,navigate(){}});
 for(const name of ['plans','topup','usage','billing']){page.render(name);assert.doesNotMatch(root.innerHTML,/工作区|workspace|data-scope|data-commerce="(?:team|personal|invite|member)"|data-form="join"|data-id="(?:settings|risk)"/i);}
 page.render('plans');assert.equal([...root.innerHTML.matchAll(/data-plan="/g)].length,3);assert.doesNotMatch(root.innerHTML,/data-plan="team"/);
});

test('cycle and service views keep exact boundaries, task counts and cumulative sums consistent',()=>{
 const day=86400000,first=Date.UTC(2026,10,5,16),start=first+12*3600000,now=first+18*3600000;
 const state={now,usage:{from:first-30*day,rows:[{day:first,profile:'Q1',credits:11,tasks:2},{day:first,profile:'R1',credits:20,tasks:1}],period:{from:start,until:start+30*day,rows:[{day:first,profile:'Q1',credits:8,tasks:1},{day:first,profile:'R1',credits:20,tasks:1}]}},tasks:[{id:'before',profile:'Q1',created:start-3000,ended:start-1},{id:'after',profile:'Q1',created:start-1000,ended:start+1},{id:'other',profile:'R1',created:start+2,ended:start+3},{id:'active',profile:'Q1',created:start+4,ended:null},{id:'future',profile:'Q1',created:now+1,ended:null}]};
 const before=JSON.stringify(state),cycle=usageSummary(state,'cycle'),filtered=usageSummary(state,'cycle','Q1');
 assert.equal(cycle.from,start);assert.equal(cycle.credits,28);assert.equal(usageSummary(state,'7').credits,31);assert.equal(filtered.credits,8);assert.equal(filtered.tasks,1);assert.deepEqual(filtered.services[0].days,[8]);
 assert.deepEqual(usageTasks(state,'cycle','Q1').map(j=>j.id),['after','active']);assert.equal(JSON.stringify(state),before);
 const days=[{credits:2},{credits:0},{credits:5}];assert.deepEqual(usageSeries(days),[2,0,5]);assert.deepEqual(usageSeries(days,true),[2,2,7]);assert.deepEqual(usageSeries([],true),[]);assert.deepEqual(days,[{credits:2},{credits:0},{credits:5}]);
});
test('free usage falls back to 30 days and zero-Credit services still show completed work',()=>{
 const day=86400000,now=Date.UTC(2026,10,7,0),first=Math.floor((now+8*3600000)/day)*day-8*3600000;
 const state={now,tasks:[],usage:{from:first-30*day,period:null,rows:[{day:first,profile:'Q1',credits:0,tasks:2},{day:first,profile:'R1',credits:4,tasks:1}]}};
 const result=usageSummary(state,'cycle','Q1');assert.equal(result.days.length,30);assert.equal(result.credits,0);assert.equal(result.tasks,2);assert.deepEqual(result.services[0].days.slice(-1),[0]);assert.deepEqual(usageTasks({now,tasks:[]},'cycle'),[]);
});

test('task costs distinguish held, settled and released Credits, including pending and invalid records',()=>{
 const active={status:'reserved',reserved:204,settled:0};
 assert.deepEqual(taskCreditSummary(active),{reserved:204,settled:0,held:204,released:0,pending:true});
 assert.deepEqual(taskCreditSummary({...active,status:'unknown'}),taskCreditSummary(active));
 assert.deepEqual(taskCreditSummary({...active,status:'complete',settled:90}),{reserved:204,settled:90,held:0,released:114,pending:false});
 assert.deepEqual(taskCreditSummary({...active,status:'cancelled'}),{reserved:204,settled:0,held:0,released:204,pending:false});
 for(const job of [null,{...active,settled:205},{...active,reserved:NaN},{...active,status:'unloaded'},{...active,reserved:'204'}])assert.equal(taskCreditSummary(job),null);
 assert.match(taskCreditDetails({...active,reserved:NaN}),/费用记录尚未核验|Charges are unconfirmed/);
});
test('account lists show customer charges and actions without internal bookkeeping or reference clutter',async t=>{
 const f=await commerceFixture(t),ui=dom(t),job=await f.account.runTask({profile:'R1',input:{title:'ETH research'}});
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(){return [];},innerHTML:'',contains(){return false;}};
 const page=createMembership({root,account:f.account});
 const table=(name)=>{const result=root.innerHTML.match(new RegExp(`<table[^>]*${name}[^>]*>[\\s\\S]*?</table>`));assert.ok(result);return result[0];};
 page.render('usage');
 assert.match(table('commerce-task-table'),/<td class="numeric"><b>—<\/b>/);
 assert.doesNotMatch(table('commerce-task-table').replace(/<[^>]*>/g,''),/查看编号|预留|释放|Reference|Reserved|Released|UTC/);
 assert.match(table('commerce-task-table'),/data-commerce="fee-context"/);
 assert.match(table('commerce-task-table'),/data-commerce="cancel"/);
 assert.doesNotMatch(root.innerHTML,/data-form="task"/);
 assert.match(root.innerHTML,/<details[^>]*data-persist-key="commerce-budget"/);
 await f.advance(1001);const before=JSON.stringify(f.account.s);page.render('usage');
 assert.match(table('commerce-task-table'),/<td class="numeric"><b>90<\/b>/);
 assert.doesNotMatch(table('commerce-task-table').replace(/<[^>]*>/g,''),new RegExp(job.id));
 assert.equal(JSON.stringify(f.account.s),before);
 const cancelled=await f.account.runTask({profile:'R1',input:{title:'Cancelled analysis'}});await f.account.cancel(cancelled.id);page.render('usage');
 assert.match(table('commerce-task-table').replace(/<[^>]*>/g,''),/已取消|Cancelled/);
 const legacy=f.account.s.tasks.find(j=>j.id===cancelled.id),originalStatus=legacy.status;
 // Older imported tasks can carry the ledger's released status.
 legacy.status='released';
 try{page.render('usage');assert.match(table('commerce-task-table').replace(/<[^>]*>/g,''),/已停止|Stopped/);assert.doesNotMatch(table('commerce-task-table').replace(/<[^>]*>/g,''),/查看编号|预留|释放|Reference|Reserved|Released|UTC/);}finally{legacy.status=originalStatus;}
 const pending=checkout(f.account,{kind:'topup',dollars:10});await flush();await ui.click(ui.latest(),'pay');const order=await pending;
 const billingBefore=JSON.stringify(f.account.s);page.render('billing');
 assert.doesNotMatch(table('commerce-order-table').replace(/<[^>]*>/g,''),new RegExp(order.id));
 assert.doesNotMatch(table('commerce-order-table').replace(/<[^>]*>/g,''),/查看编号|Reference|UTC/);
 assert.match(table('commerce-order-table'),/<td class="numeric"><b>\$10<\/b>/);
 assert.equal(JSON.stringify(f.account.s),billingBefore);
 const originalTasks=f.account.s.tasks;
 f.account.s.tasks=Array.from({length:200},(_,i)=>({...originalTasks[0],id:'history-'+i}));page.render('usage');
 assert.match(root.innerHTML,/当前时段 · 最近 200 条记录内|within the latest 200 records/);
 f.account.s.tasks=originalTasks;page.render('usage');
 assert.doesNotMatch(root.innerHTML,/当前时段 · 最近 200 条记录内|within the latest 200 records/);
});
test('charge links use exact task and run references without inferring an association from an asset',()=>{
 const tasks=[{id:'job-a',input:{runId:'run-a',ref:'U-1',symbol:'ETH'}},{id:'job-b',input:{runId:'run-b',symbol:'ETH'}},{id:'job-c',input:{symbol:'ETH'}}],before=JSON.stringify(tasks);
 assert.deepEqual(contextTasks(tasks,{runId:'run-a'}).map(j=>j.id),['job-a']);
 assert.deepEqual(contextTasks(tasks,{taskId:'job-b',runId:'run-a'}),[]);
 assert.deepEqual(contextTasks(tasks,{runId:'missing'}),[]);assert.deepEqual(contextTasks(tasks,{ref:'U-1'}).map(j=>j.id),['job-a']);
 assert.equal(commerceContextLink({taskId:'job-a',runId:'run-a'},'billing'),'?page=billing&task=job-a&run=run-a');
 assert.equal(commerceContextLink({taskId:'../secret'}),null);assert.equal(commerceContextLink({taskId:'job-a',runId:'../invalid'}),null);assert.equal(commerceContext(null),null);assert.equal(commerceContext({taskId:'a'.repeat(64)}),null);assert.equal(JSON.stringify(tasks),before);
});
test('fee drilldown reads the original ledger, survives settlement and never changes Credit or orders',async t=>{
 const f=await commerceFixture(t),ui=dom(t),job=await f.account.runTask({profile:'R1',input:{title:'ETH research',runId:'run-a',source:'workbench'}});
 const root={classList:{add(){}},querySelector(){return null;},querySelectorAll(){return [];},innerHTML:'',contains(){return false;}};
 const page=createMembership({root,account:f.account}),before=JSON.stringify(f.account.s);page.openContext({taskId:job.id});
 assert.match(root.innerHTML,/commerce-fee-context/);assert.match(root.innerHTML,new RegExp(job.id));assert.equal(JSON.stringify(f.account.s),before);assert.equal(ui.dialogs.length,0);
 assert.equal(taskCreditSummary(contextTasks(f.account.s.tasks,{taskId:job.id})[0]).held,204);
 await f.advance(1001);page.render('billing');assert.equal(taskCreditSummary(contextTasks(f.account.s.tasks,{taskId:job.id})[0]).released,114);
 assert.match(root.innerHTML,/ETH research/);assert.equal(f.account.spent,90);assert.equal(f.account.s.orders.length,0);
 page.openContext({runId:'unloaded-run'},'billing');assert.match(root.innerHTML,/缺少关联记录|missing association/);assert.equal(f.account.spent,90);
});
