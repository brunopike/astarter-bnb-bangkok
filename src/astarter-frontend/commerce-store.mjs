import {buildResearchReport} from './assistant-analysis.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {EventEmitter} from 'node:events';
import {PLANS,PROFILES,VERSION,DAY,estimate,credits,visibleTurn,BILLING_INTERVALS,subscriptionPrice,addBillingMonths,subscriptionPeriods} from './commerce-catalog.mjs';
const id=()=>randomUUID(),hash=v=>createHash('sha256').update(v).digest('hex');
const json=JSON.stringify,parse=v=>v?JSON.parse(v):null;
const integer=(v,min=0,max=1000000)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const day=t=>Math.floor((t+8*3600000)/DAY);
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export class CommerceStore{
 constructor(file,{now=Date.now,jobDelay=2500}={}){
  this.now=now;this.jobDelay=jobDelay;this.events=new EventEmitter();if(file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(file);if(file!==':memory:'){chmodSync(dirname(file),0o700);chmodSync(file,0o600);}this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person TEXT NOT NULL REFERENCES people(id));
   CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, owner TEXT NOT NULL REFERENCES people(id), plan TEXT NOT NULL DEFAULT 'free', until_at INTEGER NOT NULL DEFAULT 0, active_order TEXT, queued_order TEXT, auto_enabled INTEGER NOT NULL DEFAULT 0, daily_budget INTEGER NOT NULL DEFAULT 0, single_limit INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS members(scope TEXT NOT NULL REFERENCES scopes(id), person TEXT NOT NULL REFERENCES people(id), role TEXT NOT NULL, budget INTEGER NOT NULL DEFAULT 0 CHECK(budget>=0), PRIMARY KEY(scope,person));
   CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),actor TEXT NOT NULL,kind TEXT NOT NULL,product TEXT NOT NULL,cents INTEGER NOT NULL CHECK(cents>0),credits INTEGER NOT NULL CHECK(credits>=0),status TEXT NOT NULL,created INTEGER NOT NULL,start_at INTEGER,end_at INTEGER,refunded INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,ref TEXT NOT NULL UNIQUE,total INTEGER NOT NULL CHECK(total>=0),remaining INTEGER NOT NULL CHECK(remaining>=0),held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=remaining),expires INTEGER);
   CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,actor TEXT NOT NULL,profile TEXT NOT NULL,rate INTEGER NOT NULL,normal INTEGER NOT NULL,high INTEGER NOT NULL,max INTEGER NOT NULL,payers TEXT NOT NULL,input TEXT NOT NULL,mode TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,actor TEXT NOT NULL,quote TEXT NOT NULL UNIQUE REFERENCES quotes(id),profile TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,reserved INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,due INTEGER NOT NULL,ended INTEGER,outcome TEXT NOT NULL,artifact TEXT,liability_pico INTEGER NOT NULL DEFAULT 0,reason TEXT);
   CREATE TABLE IF NOT EXISTS allocations(job TEXT NOT NULL REFERENCES jobs(id),lot TEXT NOT NULL REFERENCES lots(id),amount INTEGER NOT NULL CHECK(amount>0),PRIMARY KEY(job,lot));
   CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,ref TEXT NOT NULL,event TEXT UNIQUE NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS operations(scope TEXT NOT NULL,actor TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,actor,key));
   CREATE TABLE IF NOT EXISTS resources(scope TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(scope,kind,key));
   CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,scope TEXT NOT NULL,expires INTEGER NOT NULL,used_by TEXT);
   CREATE INDEX IF NOT EXISTS jobs_scope_created ON jobs(scope,created);
   CREATE INDEX IF NOT EXISTS lots_scope ON lots(scope);
  `);
  this.tx(()=>{const columns=new Set(this.all('PRAGMA table_info(orders)').map(c=>c.name));
   if(!columns.has('billing_interval'))this.db.exec("ALTER TABLE orders ADD COLUMN billing_interval TEXT NOT NULL DEFAULT 'legacy' CHECK(billing_interval IN ('legacy','monthly','quarterly','yearly'))");
   if(!columns.has('base_cents'))this.db.exec('ALTER TABLE orders ADD COLUMN base_cents INTEGER NOT NULL DEFAULT 0 CHECK(base_cents>=0)');
  });
 }
 get(sql,...args){return this.db.prepare(sql).get(...args);}
 all(sql,...args){return this.db.prepare(sql).all(...args);}
 run(sql,...args){return this.db.prepare(sql).run(...args);}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
 session(token){
  const known=token&&this.get('SELECT person FROM sessions WHERE token=?',hash(token));if(known)return {person:known.person};
  return this.tx(()=>{const person=id(),scope=id(),cookie=randomBytes(32).toString('hex');this.run('INSERT INTO people VALUES(?,?)',person,this.now());this.run('INSERT INTO sessions VALUES(?,?)',hash(cookie),person);this.run('INSERT INTO scopes(id,name,type,owner) VALUES(?,?,?,?)',scope,'Personal','personal',person);this.run('INSERT INTO members VALUES(?,?,?,?)',scope,person,'owner',1000000);this.grant(scope,'welcome','welcome:'+person,600,this.now()+14*DAY);return {person,cookie};});
 }
 scope(person,scope){const s=scope?this.get('SELECT s.*,m.role,m.budget member_budget FROM scopes s JOIN members m ON s.id=m.scope WHERE s.id=? AND m.person=?',scope,person):this.get("SELECT s.*,m.role,m.budget member_budget FROM scopes s JOIN members m ON s.id=m.scope WHERE s.owner=? AND s.type='personal' AND m.person=?",person,person);if(!s)fail('workspace-forbidden',403);return s;}
 admin(s){if(!['owner','admin'].includes(s.role))fail('admin-required',403);}
 event(scope,kind,amount,ref,event){this.run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)',id(),scope,kind,amount,ref,event,this.now());}
 grant(scope,kind,ref,amount,expires){if(this.get('SELECT id FROM lots WHERE ref=?',ref))return;this.run('INSERT INTO lots(id,scope,kind,ref,total,remaining,expires) VALUES(?,?,?,?,?,?,?)',id(),scope,kind,ref,amount,amount,expires);this.event(scope,'grant',amount,ref,'grant:'+ref);}
 planEnd(o,start){return BILLING_INTERVALS[o.billing_interval]?addBillingMonths(start,BILLING_INTERVALS[o.billing_interval].months):start+30*DAY;}
 grantMonths(o){for(const period of subscriptionPeriods(o)){if(period.from>this.now())break;this.grant(o.scope,'included',period.index?o.id+':month:'+period.index:o.id,o.credits,period.until);}}
 activate(o,start){const p=PLANS[o.product],end=this.planEnd(o,start);this.run('UPDATE scopes SET plan=?,until_at=?,active_order=?,queued_order=NULL,auto_enabled=0,daily_budget=?,single_limit=? WHERE id=?',o.product,end,o.id,p.default_auto_daily,p.default_auto_single,o.scope);this.run("UPDATE orders SET status='delivered',start_at=?,end_at=? WHERE id=?",start,end,o.id);this.grantMonths({...o,start_at:start,end_at:end});}
 fulfill(o){if(o.status!=='paid')return o;if(o.kind==='topup'){this.grant(o.scope,'purchased',o.id,o.credits,null);this.run("UPDATE orders SET status='delivered' WHERE id=?",o.id);}else{const s=this.get('SELECT * FROM scopes WHERE id=?',o.scope);if(s.queued_order&&s.queued_order!==o.id)fail('renewal-already-queued');if(s.until_at>this.now()){this.run("UPDATE orders SET status='queued',start_at=?,end_at=? WHERE id=?",s.until_at,this.planEnd(o,s.until_at),o.id);this.run('UPDATE scopes SET queued_order=? WHERE id=?',o.id,o.scope);}else this.activate(o,this.now());}return this.get('SELECT * FROM orders WHERE id=?',o.id);}
 reconcile(scope){
  let s=this.get('SELECT * FROM scopes WHERE id=?',scope);
  if(!s.until_at&&s.queued_order){const o=this.get('SELECT * FROM orders WHERE id=?',s.queued_order);if(o.start_at<=this.now()){this.activate(o,o.start_at);s=this.get('SELECT * FROM scopes WHERE id=?',scope);}}
  if(s.until_at&&s.until_at<=this.now()){if(s.queued_order){this.activate(this.get('SELECT * FROM orders WHERE id=?',s.queued_order),s.until_at);s=this.get('SELECT * FROM scopes WHERE id=?',scope);}if(s.until_at<=this.now())this.run("UPDATE scopes SET plan='free',until_at=0,active_order=NULL,auto_enabled=0,daily_budget=0,single_limit=0 WHERE id=?",scope);}
  if(s.active_order)this.grantMonths(this.get('SELECT * FROM orders WHERE id=?',s.active_order));
  for(const j of this.all("SELECT * FROM jobs WHERE scope=? AND status IN ('reserved','unknown')",scope)){
   if(j.status==='unknown'){if(j.created+DAY<=this.now())this.finish(j,'released',null,'usage-unknown-24h');continue;}
   if(j.due>this.now())continue;
   const q=this.get('SELECT * FROM quotes WHERE id=?',j.quote),p=PROFILES[j.profile],payers=parse(q.payers);
   const liability=(payers.model==='own'?0:p.normal[0])+(payers.data==='own'?0:p.normal[1]);
   this.run('UPDATE jobs SET liability_pico=? WHERE id=?',liability,j.id);
   if(j.outcome==='unknown'){if(j.created+DAY<=this.now())this.finish(j,'released',null,'usage-unknown-24h');else this.run("UPDATE jobs SET status='unknown' WHERE id=?",j.id);continue;}
   if(j.outcome==='failed'){this.finish(j,'failed',null,'no-qualified-artifact');continue;}
   const input=parse(q.input),artifact={kind:'simulation-fixture',version:VERSION,title:input.title||p.zh,profile:j.profile,created:this.now(),source:'Local designed fixture; no model or paid data call',input,summary:'模拟流程完成；此结果用于验证任务恢复与结算，不代表真实投研结论。'};
   try{
    if(input.symbol&&input.source!=='assistant'){artifact.report=buildResearchReport({scope:'assets',assets:[input.symbol],window:'7d'});if(!artifact.report.rows.some(r=>r.analysis))throw Error('fixture-data-missing');artifact.summary='基于站内历史样例生成的研究快照；不是实时模型结论。';}
    artifact.usageBasis={modelPico:payers.model==='own'?0:p.normal[0],dataPico:payers.data==='own'?0:p.normal[1],rate:q.rate,source:'designed-normal-fixture'};
    this.finish(j,'complete',artifact,'qualified-simulation-artifact');
   }catch{this.finish(j,'failed',null,'fixture-artifact-unavailable');}
  }
 }
 finish(j,status,artifact,reason){
  if(!['reserved','unknown'].includes(j.status))return;
  const q=this.get('SELECT * FROM quotes WHERE id=?',j.quote),cost=status==='complete'&&artifact?credits(PROFILES[j.profile].normal,q.rate,parse(q.payers)):0;
  if(cost>j.reserved)fail('cost-cap');let left=cost;
  for(const a of this.all('SELECT a.*,l.expires FROM allocations a JOIN lots l ON l.id=a.lot WHERE job=? ORDER BY COALESCE(l.expires,9007199254740991),l.rowid',j.id)){const used=Math.min(left,a.amount);left-=used;this.run('UPDATE lots SET held=held-?,remaining=remaining-? WHERE id=?',a.amount,used,a.lot);}
  this.run('UPDATE jobs SET status=?,settled=?,ended=?,artifact=?,reason=? WHERE id=?',status,cost,this.now(),artifact?json(artifact):null,reason,j.id);this.event(j.scope,'settle',cost,j.id,'settle:'+j.id);this.event(j.scope,'release',j.reserved-cost,j.id,'release:'+j.id);
  // Notify after the surrounding synchronous transaction has committed.
  queueMicrotask(()=>this.events.emit('task-finished',{id:j.id,scope:j.scope,person:j.actor,status}));
 }
 snapshot(person,scope){return this.tx(()=>{let s=this.scope(person,scope);this.reconcile(s.id);s=this.scope(person,s.id);return this.view(person,s);});}
 view(person,s){const now=this.now(),lots=this.all('SELECT * FROM lots WHERE scope=? ORDER BY expires IS NULL,expires,rowid',s.id),jobs=this.all('SELECT * FROM jobs WHERE scope=? ORDER BY created DESC,rowid DESC LIMIT 200',s.id);const active=jobs.filter(j=>['reserved','unknown'].includes(j.status)),today=this.all('SELECT * FROM jobs WHERE scope=? AND created>=?',s.id,day(now)*DAY-8*3600000);const auto=today.filter(j=>j.mode==='auto');
  const usageFrom=(day(now)-30)*DAY-8*3600000,order=s.active_order?this.get("SELECT * FROM orders WHERE id=? AND scope=? AND status='delivered'",s.active_order,s.id):null,period=order?subscriptionPeriods(order).find(p=>p.from<=now&&p.until>now):null;
  const usageRows=from=>this.all("SELECT CAST((ended+28800000)/86400000 AS INTEGER)*86400000-28800000 day,profile,SUM(settled) credits,COUNT(*) tasks FROM jobs WHERE scope=? AND status='complete' AND ended>=? AND ended<=? GROUP BY day,profile ORDER BY day",s.id,from,now);
  return {
   version:VERSION,mode:'simulation-only',realPayments:false,person,scope:s.id,scopeName:s.name,scopeType:s.type,role:s.role,memberBudget:s.member_budget,plan:s.plan,planUntil:s.until_at,queued:s.queued_order,now,
   subscription:order&&period?{id:order.id,interval:order.billing_interval,from:order.start_at,until:order.end_at,cents:order.cents,monthlyCredits:order.credits,creditFrom:period.from,creditUntil:period.until,nextGrantAt:period.until<order.end_at?period.until:null}:null,
   scopes:this.all('SELECT s.id,s.name,s.type,m.role FROM scopes s JOIN members m ON s.id=m.scope WHERE m.person=?',person),
   entitlements:PLANS[s.plan],balance:{available:lots.reduce((a,l)=>a+(!l.expires||l.expires>now?l.remaining-l.held:0),0),reserved:lots.reduce((a,l)=>a+l.held,0),spent:this.get("SELECT COALESCE(SUM(settled),0) n FROM jobs WHERE scope=?",s.id).n},
   budget:{spent:auto.reduce((a,j)=>a+j.settled,0),reserved:auto.filter(j=>['reserved','unknown'].includes(j.status)).reduce((a,j)=>a+j.reserved,0)},preferences:{autoEnabled:!!s.auto_enabled,autoBudget:s.daily_budget,singleLimit:s.single_limit,byok:false},
   lots,orders:this.all('SELECT * FROM orders WHERE scope=? ORDER BY created DESC,rowid DESC',s.id),tasks:jobs.map(j=>({...j,cost:j.settled,artifact:parse(j.artifact),input:(()=>{const input=parse(this.get('SELECT input FROM quotes WHERE id=?',j.quote).input);if(input.turn)input.turn=visibleTurn({...input.turn,billingJob:j.id},j.status);return input;})(),labelZh:PROFILES[j.profile].zh,labelEn:PROFILES[j.profile].en,priceVersion:VERSION})),
   ledger:this.all('SELECT * FROM ledger WHERE scope=? ORDER BY created DESC,rowid DESC LIMIT 300',s.id),resources:this.all('SELECT kind,key FROM resources WHERE scope=?',s.id),
   usage:{from:usageFrom,rows:usageRows(usageFrom),period:period?{from:period.from,until:period.until,rows:usageRows(period.from)}:null},
   members:this.all('SELECT person,role,budget FROM members WHERE scope=?',s.id),activeJobs:this.get("SELECT COUNT(*) n FROM jobs WHERE scope=? AND status IN ('reserved','unknown')",s.id).n,dailyJobs:today.length
  };}
 purchaseQuote(s,p){
  this.admin(s);let price,product,kind=p.kind;
  const method=p.paymentMethod??'simulation';if(method!=='simulation')fail('payment-method',400);
  if(p.id){const o=this.get('SELECT * FROM orders WHERE id=? AND scope=?',p.id,s.id);if(!o)fail('not-found',404);kind=o.kind;product=o.product;price={interval:o.billing_interval,months:BILLING_INTERVALS[o.billing_interval]?.months||1,baseCents:o.base_cents||o.cents,cents:o.cents,credits:o.credits};}
  else if(kind==='topup'){if(p.interval!==undefined)fail('billing-interval',400);if(!integer(p.dollars,10,1000))fail('topup-range',400);product=String(p.dollars);price={interval:'legacy',months:0,baseCents:p.dollars*100,cents:p.dollars*100,credits:p.dollars*1000};}
  else if(kind==='plan'&&Object.hasOwn(PLANS,p.product)&&p.product!=='free'){
   product=p.product;if((product==='team')!==(s.type==='team'))fail('workspace-plan-mismatch');
   if(p.interval===undefined)price={interval:'legacy',months:1,baseCents:PLANS[product].priceCents,cents:PLANS[product].priceCents,credits:PLANS[product].included_credits};else price=subscriptionPrice(product,p.interval);
  }else fail('invalid-product',400);
  const start=kind==='plan'?Math.max(this.now(),s.until_at):null,end=kind==='plan'?this.planEnd({billing_interval:price.interval},start):null;
  return {...price,kind,product,discountCents:price.baseCents-price.cents,paymentMethod:method,paymentAvailable:method==='simulation',planUntil:s.until_at,start_at:start,end_at:end};
 }
 command(person,scope,key,action,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof action!=='string')fail('invalid-command',400);
  if(typeof key!=='string'||key.length<8||key.length>100)fail('idempotency-key',400);
  return this.tx(()=>{let s=this.scope(person,scope);this.reconcile(s.id);s=this.scope(person,s.id);const fingerprint=hash(json(stable({action,payload}))),old=this.get('SELECT * FROM operations WHERE scope=? AND actor=? AND key=?',s.id,person,key);if(old){if(old.fingerprint!==fingerprint)fail('idempotency-conflict');return {result:parse(old.result),state:this.view(person,s)};}
   const result=this.perform(person,s,action,payload);this.run('INSERT INTO operations VALUES(?,?,?,?,?)',s.id,person,key,fingerprint,json(result));return {result,state:this.view(person,this.scope(person,s.id))};
  });
 }
 perform(person,s,action,p){
  for(const key of ['kind','product','profile','id','quote','key','person','token','replaceKey','interval','paymentMethod'])if(p[key]!==undefined&&(typeof p[key]!=='string'||!p[key].length||p[key].length>200))fail('invalid-field',400);
  for(const key of ['enabled','remove'])if(p[key]!==undefined&&typeof p[key]!=='boolean')fail('invalid-field',400);
  if(['order-pay','order-recover','refund-quote','refund','job-cancel'].includes(action)&&typeof p.id!=='string')fail('invalid-field',400);
  if(action==='job-start'&&typeof p.quote!=='string')fail('invalid-field',400);
  const plan=PLANS[s.plan],now=this.now(),owned=(table,ident)=>{const row=this.get(`SELECT * FROM ${table} WHERE id=? AND scope=?`,ident,s.id);if(!row)fail('not-found',404);return row;};
  if(action==='order-quote')return this.purchaseQuote(s,p);
  if(action==='order-create'){
   if(p.id!==undefined)fail('invalid-field',400);const q=this.purchaseQuote(s,p);if(!q.paymentAvailable)fail('payment-unavailable');
   if(q.kind==='plan'&&s.queued_order)fail('renewal-already-queued');
   if(q.kind==='plan'&&p.expectedPlanUntil!==undefined&&p.expectedPlanUntil!==s.until_at)fail('order-quote-changed');
   if(p.expectedCents!==undefined&&(!integer(p.expectedCents,1,100000)||p.expectedCents!==q.cents))fail('order-quote-changed');
   const pending=this.get("SELECT id FROM orders WHERE scope=? AND status IN ('pending','failed','paid') AND kind=? AND product=? AND billing_interval=? AND cents=? AND credits=? AND (base_cents=0 OR base_cents=?)",s.id,q.kind,q.product,q.interval,q.cents,q.credits,q.baseCents);if(pending)return owned('orders',pending.id);
   const oid=id();this.run('INSERT INTO orders(id,scope,actor,kind,product,cents,credits,status,created,billing_interval,base_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?)',oid,s.id,person,q.kind,q.product,q.cents,q.credits,'pending',now,q.interval,q.baseCents);return owned('orders',oid);
  }
  if(action==='order-pay'||action==='order-recover'){
   this.admin(s);let o=owned('orders',p.id);if(['delivered','queued','refunded'].includes(o.status))return o;
   if(o.kind==='plan'&&p.expectedPlanUntil!==undefined&&p.expectedPlanUntil!==s.until_at)fail('order-quote-changed');
   if(action==='order-recover'){if(o.status!=='paid')fail('payment-not-confirmed');return this.fulfill(o);}
   if(!['pending','failed'].includes(o.status))return o;
   const outcome=p.outcome||'paid';if(!['paid','paid-unfulfilled','pending','failed','cancelled'].includes(outcome))fail('invalid-outcome',400);
   this.run('UPDATE orders SET status=? WHERE id=?',outcome.startsWith('paid')?'paid':outcome,o.id);o=owned('orders',o.id);return outcome==='paid'?this.fulfill(o):o;
  }
  if(action==='refund-quote'||action==='refund'){
   this.admin(s);const o=owned('orders',p.id);if(o.status==='refunded')return {id:o.id,cents:o.refunded,refunded:true};if(!['paid','delivered','queued'].includes(o.status))fail('order-not-refundable');
   const lots=this.all('SELECT * FROM lots WHERE scope=? AND (ref=? OR ref LIKE ?)',s.id,o.id,o.id+':month:%'),lot=lots.find(l=>l.ref===o.id);if(lots.some(l=>l.held))fail('credit-reserved');let cents=o.cents;
   if(o.kind==='topup'&&o.status==='delivered')cents=Math.floor(o.cents*(lot?.remaining||0)/o.credits);
   else if(o.status==='delivered'&&BILLING_INTERVALS[o.billing_interval]){
    const periods=subscriptionPeriods(o),creditRatio=Math.min(1,o.credits*periods.length/((o.base_cents||o.cents)*10));cents=0;
    for(const period of periods){const value=Math.floor(o.cents*(period.index+1)/periods.length)-Math.floor(o.cents*period.index/periods.length);
     if(period.from>now){cents+=value;continue;}if(period.until<=now)continue;
     const current=lots.find(l=>l.ref===(period.index?o.id+':month:'+period.index:o.id)),creditValue=Math.floor(value*creditRatio),serviceValue=value-creditValue;
     cents+=Math.floor(creditValue*(current?.remaining||0)/o.credits)+Math.floor(serviceValue*(period.until-now)/(period.until-period.from));
    }
   }else if(o.status==='delivered'){const remaining=Math.max(0,(lot?.expires||0)>now?lot.remaining:0);const creditCents=o.credits/10,serviceCents=o.cents-creditCents;cents=Math.floor(remaining/10)+Math.floor(serviceCents*Math.max(0,o.end_at-now)/(o.end_at-o.start_at));}
   if(action==='refund-quote')return {id:o.id,cents,creditsRevoked:lots.length?lots.filter(l=>!l.expires||l.expires>now).reduce((n,l)=>n+l.remaining,0):o.credits*(BILLING_INTERVALS[o.billing_interval]?.months||1)};
   if(!integer(p.expectedCents,0,100000)||p.expectedCents!==cents)fail('refund-quote-changed');
   for(const l of lots){this.run('UPDATE lots SET remaining=0 WHERE id=?',l.id);this.event(s.id,'revoke',l.remaining,o.id,'revoke:'+l.ref);}
   this.run("UPDATE orders SET status='refunded',refunded=? WHERE id=?",cents,o.id);
   if(s.queued_order===o.id)this.run('UPDATE scopes SET queued_order=NULL WHERE id=?',s.id);
   if(s.active_order===o.id)this.run("UPDATE scopes SET plan='free',until_at=0,active_order=NULL,auto_enabled=0,daily_budget=0,single_limit=0 WHERE id=?",s.id);
   this.event(s.id,'refund-cents',cents,o.id,'refund:'+o.id);return {id:o.id,cents,refunded:true};
  }
  if(action==='quote'){
   const profile=Object.hasOwn(PROFILES,p.profile)?PROFILES[p.profile]:null;if(!profile)fail('profile',400);
   if(p.mode!==undefined&&!['manual','auto'].includes(p.mode))fail('mode',400);
   const payers=p.payers||{model:'official',data:'official'};if(!['official','own'].includes(payers.model)||!['official','own'].includes(payers.data))fail('payer',400);
   const input=p.input||{};if(typeof input!=='object'||Array.isArray(input)||json(input).length>60000)fail('input-too-large',400);
   const bounds=profile.scope,sectorMode=input.scope==='sectors';
   for(const [key,max]of [['days',bounds.max_days||180],['bars',bounds.max_bars||1000],['calls',12],['positions',bounds.max_positions||10],['fills',bounds.max_fills||100]])if(input[key]!==undefined&&!integer(input[key],1,max))fail('scope-too-large',400);
   if(input.scope!==undefined&&!['assets','sectors'].includes(input.scope))fail('scope-too-large',400);
   for(const key of ['assets','sectors'])if(input[key]!==undefined&&(!Array.isArray(input[key])||input[key].some(x=>typeof x!=='string'||!x.length||x.length>100)||new Set(input[key]).size!==input[key].length))fail('scope-too-large',400);
   const cap=sectorMode?(bounds.max_sector_sample_assets_total||bounds.max_sector_sample_assets||0):(bounds.assets||10);
   if((input.assets?.length||0)>cap||(input.sectors?.length||0)>(sectorMode?(bounds.sector_count||0):0)||input.sector_count!==undefined)fail('scope-too-large',400);
   const e=estimate(p.profile,s.plan,payers),qid=id();this.run('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',qid,s.id,person,p.profile,plan.rate,e.normal,e.high,e.max,json(payers),json(input),p.mode||'manual',now,now+120000);return {...e,id:qid,profile:p.profile,payers,expires:now+120000,version:VERSION};
  }
  if(action==='job-start'){
   const q=owned('quotes',p.quote);if(q.actor!==person)fail('quote-owner',403);const existing=this.get('SELECT * FROM jobs WHERE quote=?',q.id);if(existing)return {id:existing.id,reserved:existing.reserved,status:existing.status};
   if(q.expires<now||q.rate!==plan.rate)fail('quote-expired');
   if(s.role==='viewer')fail('viewer-read-only',403);if(s.type==='team'&&s.plan!=='team'&&s.role!=='owner')fail('team-required');
   const input=parse(q.input);if(input.symbol&&this.get("SELECT j.id FROM jobs j JOIN quotes q ON q.id=j.quote WHERE j.scope=? AND j.status IN ('reserved','unknown') AND json_extract(q.input,'$.symbol')=?",s.id,input.symbol))fail('asset-job-active');
   const state=this.view(person,s);if(state.activeJobs>=plan.parallel_jobs)fail('capacity');if(state.dailyJobs>=plan.daily_dispatched_jobs)fail('daily-dispatch-limit');
   if(q.mode==='auto'){if(!plan.auto_research||!PROFILES[q.profile].automatic)fail('plan-required');if(!s.auto_enabled)fail('auto-paused');if(q.max>s.single_limit)fail('single-limit');if(state.budget.spent+state.budget.reserved+q.max>s.daily_budget)fail('budget');}
   if(!['owner','admin'].includes(s.role)){const used=this.get("SELECT COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN reserved ELSE settled END),0) n FROM jobs WHERE scope=? AND actor=? AND created>=?",s.id,person,day(now)*DAY-8*3600000).n;if(used+q.max>s.member_budget)fail('member-budget');}
   const recent=this.all("SELECT status FROM jobs WHERE scope=? AND profile=? AND ended IS NOT NULL ORDER BY ended DESC LIMIT 50",s.id,q.profile);if(recent.length===50&&recent.filter(j=>j.status==='failed').length>=10)fail('profile-circuit-open');
   if(state.balance.available<q.max)fail('insufficient');const outcome=p.outcome||'complete';if(!['complete','failed','unknown'].includes(outcome))fail('invalid-outcome',400);
   const jid=id();this.run('INSERT INTO jobs(id,scope,actor,quote,profile,mode,status,reserved,created,due,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?)',jid,s.id,person,q.id,q.profile,q.mode,'reserved',q.max,now,now+this.jobDelay,outcome);
   let left=q.max;for(const lot of this.all('SELECT * FROM lots WHERE scope=? AND remaining>held AND (expires IS NULL OR expires>?) ORDER BY expires IS NULL,expires,rowid',s.id,now)){const take=Math.min(left,lot.remaining-lot.held);if(!take)continue;this.run('UPDATE lots SET held=held+? WHERE id=?',take,lot.id);this.run('INSERT INTO allocations VALUES(?,?,?)',jid,lot.id,take);left-=take;if(!left)break;}
   if(left)fail('insufficient');this.event(s.id,'reserve',q.max,jid,'reserve:'+jid);return {id:jid,reserved:q.max,status:'reserved'};
  }
  if(action==='job-cancel'){const j=owned('jobs',p.id);if(j.actor!==person)this.admin(s);this.finish(j,'cancelled',null,'user-cancelled');return {id:j.id};}
  if(action==='preferences'){this.admin(s);if(!integer(p.daily)||!integer(p.single))fail('budget-range',400);if(p.enabled&&!plan.auto_research)fail('plan-required');this.run('UPDATE scopes SET daily_budget=?,single_limit=?,auto_enabled=? WHERE id=?',p.daily,p.single,p.enabled?1:0,s.id);return {saved:true};}
  if(action==='resource'){
   const caps={asset:plan.tracked_assets,strategy:plan.saved_strategies,address:plan.observed_addresses,running:plan.running_instances};if(!Object.hasOwn(caps,p.kind)||typeof p.key!=='string'||!p.key.length||p.key.length>180)fail('resource',400);
   if(s.role==='viewer')fail('viewer-read-only',403);if(p.remove){this.run('DELETE FROM resources WHERE scope=? AND kind=? AND key=?',s.id,p.kind,p.key);return {removed:true};}
   if(s.role==='viewer')fail('viewer-read-only',403);if(s.type==='team'&&s.plan!=='team'&&s.role!=='owner')fail('team-required');if(p.kind==='running'&&!plan.running_instances)fail('plan-required');const replacement=p.kind==='address'&&p.replaceKey&&p.replaceKey!==p.key&&this.get('SELECT key FROM resources WHERE scope=? AND kind=? AND key=?',s.id,p.kind,p.replaceKey);if(this.get('SELECT key FROM resources WHERE scope=? AND kind=? AND key=?',s.id,p.kind,p.key)){if(replacement)this.run('DELETE FROM resources WHERE scope=? AND kind=? AND key=?',s.id,p.kind,p.replaceKey);return {saved:true};}
   if(p.kind==='running'&&!plan.running_instances)fail('plan-required');if(this.get('SELECT COUNT(*) n FROM resources WHERE scope=? AND kind=?',s.id,p.kind).n-(replacement?1:0)>=caps[p.kind])fail('resource-limit');
   if(replacement)this.run('DELETE FROM resources WHERE scope=? AND kind=? AND key=?',s.id,p.kind,p.replaceKey);this.run('INSERT INTO resources VALUES(?,?,?)',s.id,p.kind,p.key);return {saved:true};
  }
  if(action==='team-create'){if(s.type!=='personal')fail('personal-workspace-required');const existing=this.get("SELECT id FROM scopes WHERE type='team' AND owner=?",person);if(existing)return existing;const sid=id();this.run('INSERT INTO scopes(id,name,type,owner) VALUES(?,?,?,?)',sid,'Team','team',person);this.run('INSERT INTO members VALUES(?,?,?,?)',sid,person,'owner',1000000);return {id:sid};}
  if(action==='team-invite'){this.admin(s);if(s.type!=='team'||s.plan!=='team')fail('team-required');const token=randomBytes(24).toString('hex');this.run('INSERT INTO invites VALUES(?,?,?,NULL)',hash(token),s.id,now+DAY);return {token,expires:now+DAY};}
  if(action==='team-join'){const inv=this.get('SELECT * FROM invites WHERE token=?',hash(String(p.token||'')));if(!inv||inv.expires<now||inv.used_by)fail('invite-invalid');const team=this.get('SELECT * FROM scopes WHERE id=?',inv.scope);if(team.plan!=='team'||team.until_at<=now)fail('team-required');if(this.get('SELECT person FROM members WHERE scope=? AND person=?',inv.scope,person))fail('already-member');if(this.get('SELECT COUNT(*) n FROM members WHERE scope=?',inv.scope).n>=5)fail('seats-full');this.run('INSERT INTO members VALUES(?,?,?,?)',inv.scope,person,'member',0);this.run('UPDATE invites SET used_by=? WHERE token=?',person,hash(p.token));return {id:inv.scope};}
  if(action==='member-update'){this.admin(s);if(p.person===s.owner)fail('owner-protected');if(!['member','viewer'].includes(p.role)||!integer(p.budget))fail('member-policy',400);if(!this.get('SELECT person FROM members WHERE scope=? AND person=?',s.id,p.person))fail('not-found',404);this.run('UPDATE members SET role=?,budget=? WHERE scope=? AND person=?',p.role,p.budget,s.id,p.person);return {saved:true};}
  fail('unknown-action',400);
 }
}
