import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadNotificationConfig} from './notification-config.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CommerceStore} from './commerce-store.mjs';
import {NotificationService,NotificationTransport,createNotificationHandler} from './notification-service.mjs';
import {notificationEvent,createNotificationPublisher,notificationRequest,notificationSummary} from './notification-settings.mjs';
const fixtureEvent={id:'order-1',type:'orders',title:'Astarter · 模拟交易',body:'ETH/USDT 模拟成交 100 USDT',mode:'simulation-only'};
async function fixture(t){
 let time=1800000000000;const sent=[],updates=[],keys=new Map();let loseNextEmail=false,failTelegram=false;
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const data=raw?JSON.parse(raw):{};let result;
  if(req.url.endsWith('/getMe'))result={ok:true,result:{username:'AstarterFixtureBot'}};
  else if(req.url.endsWith('/getWebhookInfo'))result={ok:true,result:{url:''}};
  else if(req.url.endsWith('/getUpdates'))result={ok:true,result:updates.splice(0)};
  else if(req.url.endsWith('/sendMessage')){sent.push({channel:'telegram',...data});result={ok:true,result:{message_id:sent.length}};}
  else if(req.url==='/emails'&&req.method==='POST'){const key=req.headers['idempotency-key'];if(!keys.has(key)){keys.set(key,'email-'+keys.size);sent.push({channel:'email',key,...data});}result={id:keys.get(key)};}
  else if(req.url.startsWith('/emails/'))result={last_event:'delivered'};
  else {res.writeHead(404);res.end('{}');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const request=async(url,options)=>{if(failTelegram&&url.endsWith('/sendMessage'))throw TypeError('fixture network interrupted');const response=await fetch('http://127.0.0.1:'+provider.address().port+new URL(url).pathname,options);if(loseNextEmail&&new URL(url).pathname==='/emails'){loseNextEmail=false;throw TypeError('fixture response lost');}return response;};
 const store=new CommerceStore(':memory:',{now:()=>time}),session=store.session(),scope=store.scope(session.person).id;
 const transport=new NotificationTransport({env:{ASTARTER_TELEGRAM_BOT_TOKEN:'fixture-not-a-real-token',ASTARTER_RESEND_API_KEY:'fixture-not-a-real-key',ASTARTER_NOTIFICATION_FROM:'Astarter <notify@example.com>'},request});
 const service=new NotificationService(store,{transport,now:()=>time});
 t.after(()=>{service.close();store.close();provider.closeAllConnections();provider.close();});
 return {store,service,session,scope,sent,updates,keys,advance(ms){time+=ms;},loseEmail(){loseNextEmail=true;},failTelegram(){failTelegram=true;}};
}
async function bindEmail(f){const requested=await f.service.requestEmail(f.session.person,f.scope,'trader@example.com'),message=f.sent.findLast(x=>x.channel==='email'),code=message.text.match(/\b\d{6}\b/)[0];f.service.verifyEmail(f.session.person,f.scope,requested.challenge,code);return {requested,code};}
async function bindTelegram(f){const link=await f.service.telegramLink(f.session.person,f.scope),token=new URL(link.url).searchParams.get('start');f.updates.push({update_id:7,message:{text:'/start '+token,chat:{id:123456789,type:'private'},from:{id:123456789,username:'fixture_trader'}}});await f.service.pollTelegram();return link;}

test('email verification, durable outbox and provider delivery receipt form one path',async t=>{
 const f=await fixture(t),{service:s,store,session,scope}=f;
 assert.throws(()=>s.save(session.person,scope,{events:['orders'],enabled:{email:true,telegram:false}}),{code:'channel-not-verified'});
 const {requested,code}=await bindEmail(f);
 assert.doesNotMatch(JSON.stringify(s.state(session.person,scope)),new RegExp(code));
 assert.equal(store.get('SELECT secret FROM notice_challenges WHERE id=?',requested.challenge),undefined);
 assert.equal(s.state(session.person,scope).channels.email.enabled,0);
 s.save(session.person,scope,{events:['orders'],enabled:{email:true,telegram:false}});
 assert.equal(s.enqueue(session.person,scope,fixtureEvent).queued,1);assert.equal(s.enqueue(session.person,scope,fixtureEvent).queued,0);
 assert.throws(()=>s.enqueue(session.person,scope,{...fixtureEvent,body:'different payload'}),{code:'event-id-conflict'});
 await s.pump();assert.equal(s.state(session.person,scope).deliveries[0].status,'accepted');
 assert.equal(f.sent.findLast(x=>x.channel==='email').text,fixtureEvent.body);
 f.advance(16000);await s.checkReceipt();assert.equal(s.state(session.person,scope).deliveries[0].status,'delivered');
});

test('Telegram start link proves ownership without accepting a caller-supplied Chat ID',async t=>{
 const f=await fixture(t);await bindTelegram(f);const s=f.service.state(f.session.person,f.scope);
 assert.equal(s.channels.telegram.target,'123456789');assert.equal(s.channels.telegram.enabled,0);
 f.service.save(f.session.person,f.scope,{events:['orders'],enabled:{telegram:true,email:false}});
 f.service.enqueue(f.session.person,f.scope,fixtureEvent);await f.service.pump();
 assert.equal(f.sent.at(-1).chat_id,'123456789');assert.match(f.sent.at(-1).text,/模拟交易/);
 assert.equal(f.service.state(f.session.person,f.scope).deliveries[0].status,'sent');
 assert.equal(f.store.get("SELECT value FROM notice_meta WHERE key='telegram-offset:AstarterFixtureBot'").value,'8');
});

test('verification is scoped, expires, rejects replay and limits brute force',async t=>{
 const f=await fixture(t),s=f.service,other=f.store.session(),otherScope=f.store.scope(other.person).id;
 const requested=await s.requestEmail(f.session.person,f.scope,'trader@example.com'),code=f.sent.at(-1).text.match(/\b\d{6}\b/)[0];
 assert.throws(()=>s.verifyEmail(other.person,f.scope,requested.challenge,code),/workspace-forbidden/);
 assert.throws(()=>s.verifyEmail(other.person,otherScope,requested.challenge,code),{code:'verification-expired'});
 for(let i=0;i<5;i++)assert.throws(()=>s.verifyEmail(f.session.person,f.scope,requested.challenge,'000000'),{code:'verification-code-invalid'});
 assert.throws(()=>s.verifyEmail(f.session.person,f.scope,requested.challenge,code),{code:'verification-expired'});
 f.advance(61000);const again=await s.requestEmail(f.session.person,f.scope,'trader@example.com');f.advance(600001);
 assert.throws(()=>s.verifyEmail(f.session.person,f.scope,again.challenge,'000000'),{code:'verification-expired'});
 const link=await s.telegramLink(f.session.person,f.scope),token=new URL(link.url).searchParams.get('start');
 assert.equal(s.consumeTelegram({message:{text:'/start '+token,chat:{id:-1001,type:'group'},from:{id:123}}}),false);
 f.advance(600001);assert.equal(s.consumeTelegram({message:{text:'/start '+token,chat:{id:123,type:'private'},from:{id:123}}}),false);
});

test('notification filters and disabling a channel prevent queued messages from being sent',async t=>{
 const f=await fixture(t);await bindEmail(f);const s=f.service;
 s.save(f.session.person,f.scope,{events:['risk'],enabled:{telegram:false,email:true}});
 assert.equal(s.enqueue(f.session.person,f.scope,fixtureEvent).queued,0);
 assert.equal(s.enqueue(f.session.person,f.scope,{...fixtureEvent,id:'risk-1',type:'risk'}).queued,1);
 s.save(f.session.person,f.scope,{events:[],enabled:{telegram:false,email:false}});await s.pump();
 assert.equal(s.state(f.session.person,f.scope).deliveries[0].status,'cancelled');assert.equal(f.sent.length,1);
});

test('server-completed research triggers notification without any browser event',async t=>{
 const f=await fixture(t);await bindEmail(f);f.service.save(f.session.person,f.scope,{events:['research'],enabled:{email:true,telegram:false}});
 const quote=f.store.command(f.session.person,f.scope,randomUUID(),'quote',{profile:'R1'}).result;
 f.store.command(f.session.person,f.scope,randomUUID(),'job-start',{quote:quote.id});f.advance(5000);f.store.snapshot(f.session.person,f.scope);
 await new Promise(resolve=>setImmediate(resolve));
 const state=f.service.state(f.session.person,f.scope);assert.equal(state.deliveries.length,1);assert.match(state.deliveries[0].title,/研究完成/);
 await f.service.pump();assert.equal(f.service.state(f.session.person,f.scope).deliveries[0].status,'accepted');
 f.store.snapshot(f.session.person,f.scope);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.service.state(f.session.person,f.scope).deliveries.length,1);
});

test('ambiguous Telegram sends never retry blindly; email retries reuse the provider idempotency key',async t=>{
 const f=await fixture(t);await bindTelegram(f);await bindEmail(f);const s=f.service;
 s.save(f.session.person,f.scope,{events:['orders'],enabled:{telegram:true,email:true}});
 s.enqueue(f.session.person,f.scope,fixtureEvent);f.failTelegram();f.loseEmail();await s.pump();await s.pump();
 assert.equal(s.state(f.session.person,f.scope).deliveries.find(x=>x.channel==='telegram').status,'unknown');
 assert.equal(s.state(f.session.person,f.scope).deliveries.find(x=>x.channel==='email').status,'retry');
 f.advance(31000);await s.pump();assert.equal(f.keys.size,2);assert.equal(s.state(f.session.person,f.scope).deliveries.find(x=>x.channel==='email').status,'accepted');
 const telegram=f.store.get("SELECT attempts FROM notice_deliveries WHERE channel='telegram'");assert.equal(telegram.attempts,1);
});

test('unknown verification delivery preserves the challenge without exposing its code',async t=>{
 const f=await fixture(t);f.loseEmail();const result=await f.service.requestEmail(f.session.person,f.scope,'trader@example.com');assert.equal(result.status,'unknown');
 const code=f.sent[0].text.match(/\b\d{6}\b/)[0];assert.doesNotMatch(JSON.stringify(result),new RegExp(code));
 f.service.verifyEmail(f.session.person,f.scope,result.challenge,code);assert.ok(f.service.state(f.session.person,f.scope).channels.email.verified);
});

test('removing workspace membership removes its notification authority without blocking the membership change',async t=>{
 const f=await fixture(t);await bindEmail(f);f.service.save(f.session.person,f.scope,{events:['orders'],enabled:{email:true,telegram:false}});f.service.enqueue(f.session.person,f.scope,fixtureEvent);
 f.store.run('DELETE FROM members WHERE scope=? AND person=?',f.scope,f.session.person);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM notice_channels').n,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM notice_deliveries').n,0);
 assert.throws(()=>f.service.state(f.session.person,f.scope),/workspace-forbidden/);
});

test('real HTTP handler rejects cross-origin and foreign workspaces and reports missing services honestly',async t=>{
 const store=new CommerceStore(':memory:'),transport=new NotificationTransport({env:{}}),service=new NotificationService(store,{transport});
 const handle=createNotificationHandler({store,service}),server=http.createServer((req,res)=>handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{service.close();store.close();server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port,first=await fetch(origin+'/api/notifications/state'),cookie=first.headers.get('set-cookie').split(';')[0],state=await first.json();
 assert.equal(state.services.telegram.available,false);assert.equal(state.services.email.available,false);
 const post=(action,payload={},extra={})=>fetch(origin+'/api/notifications/command',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify({action,payload})});
 assert.equal((await post('telegram-link',{}, {Origin:'https://evil.example'})).status,403);
 assert.equal((await post('email-code',{email:'trader@example.com'})).status,503);
 assert.equal((await post('telegram-link')).status,503);
 const other=store.session(),otherScope=store.scope(other.person).id;
 assert.equal((await post('save',{events:['risk'],enabled:{telegram:false,email:false}},{'X-Workspace-Id':otherScope})).status,403);
 assert.equal((await post('event',{...fixtureEvent,mode:'live'})).status,400);
});

test('publisher sends new business events once and never replays history on workspace switches',async()=>{
 let scope='a';const posted=[],publisher=createNotificationPublisher({getScope:()=>scope,request:async(action,event,options)=>{posted.push({action,event,options});}});
 const old={id:1,kind:'fill',text:'old',recordedAt:1},fresh={id:2,kind:'fill',text:'new',recordedAt:2};
 publisher.observe([old]);publisher.observe([fresh,old]);publisher.observe([fresh,old]);assert.equal(posted.length,1);assert.equal(posted[0].event.mode,'simulation-only');
 scope='b';publisher.observe([fresh,old]);assert.equal(posted.length,1);
 publisher.observe([fresh,old],[{id:'N2',kind:'research',text:'研究完成',ref:'job-1'}]);assert.equal(posted.length,2);assert.equal(posted[1].event.type,'research');assert.equal(posted[1].options.scope,'b');
 assert.equal(notificationEvent('trade',{id:3,kind:'info',text:'internal animation progress'}),null);
});

test('queued notifications and verified destinations survive an actual SQLite reopen',async t=>{
 const f=await fixture(t),dir=mkdtempSync(join(tmpdir(),'astarter-notices-')),file=join(dir,'notifications.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let store=new CommerceStore(file,{now:f.service.now}),session=store.session(),scope=store.scope(session.person).id,service=new NotificationService(store,{transport:f.service.transport,now:f.service.now});
 try{
  await bindEmail({...f,store,session,scope,service});service.save(session.person,scope,{events:['orders'],enabled:{email:true,telegram:false}});service.enqueue(session.person,scope,fixtureEvent);service.close();store.close();
  store=new CommerceStore(file,{now:f.service.now});service=new NotificationService(store,{transport:f.service.transport,now:f.service.now});
  assert.equal(service.state(session.person,scope).deliveries[0].status,'queued');assert.equal(service.enqueue(session.person,scope,fixtureEvent).queued,0);await service.pump();assert.equal(service.state(session.person,scope).deliveries[0].status,'accepted');
 }finally{service.close();store.close();}
});

test('publisher retries transport failures with the same event identity and stops at a workspace change',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let scope='a',attempts=0,errors=0;const sent=[],publisher=createNotificationPublisher({getScope:()=>scope,onError(){errors++;},request:async(_action,event)=>{sent.push(event.id);if(++attempts<3)throw Error('network unavailable');}});
 publisher.observe();publisher.observe([{id:1,kind:'fill',text:'new fill',recordedAt:1}]);await Promise.resolve();await Promise.resolve();
 t.mock.timers.tick(5000);await Promise.resolve();await Promise.resolve();t.mock.timers.tick(10000);await Promise.resolve();await Promise.resolve();
 assert.equal(attempts,3);assert.equal(new Set(sent).size,1);assert.equal(errors,1);
 const blocked=createNotificationPublisher({getScope:()=>scope,onError(){},request:async()=>{attempts++;throw Error('network unavailable');}});blocked.observe();blocked.observe([{id:2,kind:'fill',text:'next fill',recordedAt:2}]);await Promise.resolve();await Promise.resolve();const count=attempts;scope='b';t.mock.timers.tick(10000);await Promise.resolve();assert.equal(attempts,count);
});

test('shared configuration summaries use server-confirmed channels and never imply delivery from a saved destination',async()=>{
 const scope='summary-fixture';assert.equal(notificationSummary(scope,false).active,false);
 const state={scope,channels:{telegram:{verified:1,enabled:1},email:{verified:0,enabled:0}},services:{telegram:{available:true},email:{available:true}}};
 await notificationRequest(null,null,{scope,request:async()=>new Response(JSON.stringify(state),{status:200})});assert.equal(notificationSummary(scope,false).label,'Telegram');assert.equal(notificationSummary(scope,false).active,true);
 state.services.telegram.available=false;await notificationRequest(null,null,{scope,request:async()=>new Response(JSON.stringify(state),{status:200})});assert.equal(notificationSummary(scope,false).active,false);
 assert.doesNotMatch(notificationSummary('different-workspace',false).label,/Telegram/);
});

function configFixture(t,{central,legacy}={}){
 const dir=mkdtempSync(join(tmpdir(),'astarter-notification-config-')),configFile=join(dir,'central.env'),legacyFile=join(dir,'legacy.env');
 if(central!==undefined)writeFileSync(configFile,central);
 if(legacy!==undefined)writeFileSync(legacyFile,legacy);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {configFile,legacyFile,load(env={}){loadNotificationConfig({env,configFile,legacyFile});return env;}};
}

test('notification config uses process, central, then legacy values per field and imports no unrelated variables',t=>{
 const f=configFixture(t,{central:'ASTARTER_RESEND_API_KEY=fixture-central\nASTARTER_NOTIFICATION_FROM="Central <central@example.com>"\nOPENAI_API_KEY=fixture-unrelated\nPORT=9999\nNODE_OPTIONS=fixture-unrelated\n',legacy:'ASTARTER_TELEGRAM_BOT_TOKEN=fixture-legacy-telegram\nASTARTER_RESEND_API_KEY=fixture-legacy-resend\nASTARTER_NOTIFICATION_FROM=legacy@example.com\n'});
 const env={ASTARTER_NOTIFICATION_FROM:'Process <process@example.com>',PORT:'4188'};
 assert.equal(f.load(env),env);
 assert.deepEqual(env,{ASTARTER_NOTIFICATION_FROM:'Process <process@example.com>',PORT:'4188',ASTARTER_RESEND_API_KEY:'fixture-central',ASTARTER_TELEGRAM_BOT_TOKEN:'fixture-legacy-telegram'});
 assert.equal(Object.hasOwn(env,'OPENAI_API_KEY'),false);assert.equal(Object.hasOwn(env,'NODE_OPTIONS'),false);
});

test('explicit empty process and central fields disable fallback instead of reviving old credentials',t=>{
 const f=configFixture(t,{central:"ASTARTER_RESEND_API_KEY=''\nASTARTER_NOTIFICATION_FROM=central@example.com\n",legacy:'ASTARTER_RESEND_API_KEY=fixture-old\nASTARTER_NOTIFICATION_FROM=legacy@example.com\nASTARTER_TELEGRAM_BOT_TOKEN=fixture-legacy\n'});
 const env=f.load({ASTARTER_NOTIFICATION_FROM:''});
 assert.equal(env.ASTARTER_RESEND_API_KEY,'');assert.equal(env.ASTARTER_NOTIFICATION_FROM,'');assert.equal(env.ASTARTER_TELEGRAM_BOT_TOKEN,'fixture-legacy');
});

test('missing central file falls back to the legacy file with native dotenv quoting and comments',t=>{
 const f=configFixture(t,{legacy:'export ASTARTER_RESEND_API_KEY="fixture#legacy" # comment\nASTARTER_NOTIFICATION_FROM="Astarter <notify@example.com>"\nASTARTER_TELEGRAM_BOT_TOKEN=fixture-tg\nUNRELATED=fixture-ignore\n'});
 assert.deepEqual(f.load(),{ASTARTER_TELEGRAM_BOT_TOKEN:'fixture-tg',ASTARTER_RESEND_API_KEY:'fixture#legacy',ASTARTER_NOTIFICATION_FROM:'Astarter <notify@example.com>'});
});

test('missing configuration files leave the provided environment unchanged',t=>{
 const f=configFixture(t),env={PORT:'4188'};assert.equal(f.load(env),env);assert.deepEqual(env,{PORT:'4188'});
});

test('a central read failure is surfaced and never replaced with legacy credentials',t=>{
 const f=configFixture(t,{legacy:'ASTARTER_RESEND_API_KEY=fixture-old\n'});mkdirSync(f.configFile);const env={};
 assert.throws(()=>f.load(env),error=>error.code==='EISDIR');assert.deepEqual(env,{});
});

test('a legacy read failure is surfaced when that file is needed for a missing field',t=>{
 const f=configFixture(t,{central:'ASTARTER_RESEND_API_KEY=fixture-central\n'});mkdirSync(f.legacyFile);
 assert.throws(()=>f.load(),error=>error.code==='EISDIR');
});

test('fully inherited configuration needs no file reads and preserves explicit empty values',t=>{
 const f=configFixture(t);mkdirSync(f.configFile);mkdirSync(f.legacyFile);
 const env={ASTARTER_TELEGRAM_BOT_TOKEN:'fixture-process',ASTARTER_RESEND_API_KEY:'',ASTARTER_NOTIFICATION_FROM:'process@example.com'};
 assert.equal(f.load(env),env);assert.equal(env.ASTARTER_RESEND_API_KEY,'');
});
