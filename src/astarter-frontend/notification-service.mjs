import {createHash,randomBytes,randomInt,randomUUID} from 'node:crypto';
import {getCommerceStore} from './commerce-api.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(code,status=400,extra={})=>{throw Object.assign(Error(code),{code,status,...extra});};
const events=['orders','risk','research'],channels=['telegram','email'];
const emailOK=v=>typeof v==='string'&&v.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
const plain=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u0008\u000b-\u001f]/.test(v);

export class NotificationTransport{
 constructor({env=process.env,request=fetch}={}){this.token=env.ASTARTER_TELEGRAM_BOT_TOKEN||'';this.key=env.ASTARTER_RESEND_API_KEY||'';this.from=env.ASTARTER_NOTIFICATION_FROM||'';this.request=request;}
 available(channel){return channel==='telegram'?Boolean(this.token):Boolean(this.key&&this.from);}
 async json(url,options={},channel='email'){
  let response,data;try{response=await this.request(url,{...options,signal:AbortSignal.timeout(15000)});data=await response.json();}catch{fail('delivery-unknown',502,{uncertain:true});}
  if(!response.ok||channel==='telegram'&&!data.ok){
   const status=channel==='telegram'?data.error_code:response.status;
   if(status===429)fail('provider-rate-limited',429,{retryAfter:Math.min(300,Math.max(5,Number(data.parameters?.retry_after)||30))});
   if(status===401||status===403)fail(channel==='telegram'?'telegram-access-denied':'email-sender-not-authorized',502);
   if(status>=500)fail('provider-unavailable',502,{uncertain:channel==='telegram',retryAfter:30});
   fail('provider-rejected',502);
  }return channel==='telegram'?data.result:data;
 }
 telegram(method,payload={}){
  if(!this.available('telegram'))fail('telegram-service-missing',503);
  return this.json(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},'telegram');
 }
 async bot(){const [me,hook]=await Promise.all([this.telegram('getMe'),this.telegram('getWebhookInfo')]);if(hook.url)fail('telegram-webhook-in-use',409);if(!/^[A-Za-z0-9_]+$/.test(me.username||''))fail('telegram-bot-invalid',502);return me.username;}
 async email(to,subject,text,key){
  if(!this.available('email'))fail('email-service-missing',503);
  const data=await this.json('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:this.from,to:[to],subject,text})});
  if(!data.id)fail('delivery-unknown',502,{uncertain:true});return String(data.id);
 }
 async send(channel,target,title,body,key){if(channel==='email')return this.email(target,title,body,key);const result=await this.telegram('sendMessage',{chat_id:target,text:title+'\n\n'+body});if(!result.message_id)fail('delivery-unknown',502,{uncertain:true});return String(result.message_id);}
 async receipt(id){const data=await this.json('https://api.resend.com/emails/'+encodeURIComponent(id),{headers:{Authorization:`Bearer ${this.key}`}});return data.last_event;}
}

export class NotificationService{
 constructor(store,{transport=new NotificationTransport(),now=Date.now}={}){
  this.store=store;this.transport=transport;this.now=now;this.busy=false;this.polling=false;this.botName='';this.botError='';
  const schema=`
   CREATE TABLE IF NOT EXISTS notice_preferences(scope TEXT NOT NULL,person TEXT NOT NULL,events TEXT NOT NULL,PRIMARY KEY(scope,person),FOREIGN KEY(scope,person) REFERENCES members(scope,person));
   CREATE TABLE IF NOT EXISTS notice_channels(scope TEXT NOT NULL,person TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('telegram','email')),target TEXT NOT NULL,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),verified INTEGER NOT NULL,PRIMARY KEY(scope,person,channel),FOREIGN KEY(scope,person) REFERENCES members(scope,person));
   CREATE TABLE IF NOT EXISTS notice_challenges(id TEXT PRIMARY KEY,scope TEXT NOT NULL,person TEXT NOT NULL,channel TEXT NOT NULL,target TEXT NOT NULL,secret TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,FOREIGN KEY(scope,person) REFERENCES members(scope,person));
   CREATE TABLE IF NOT EXISTS notice_deliveries(id TEXT PRIMARY KEY,scope TEXT NOT NULL,person TEXT NOT NULL,channel TEXT NOT NULL,event_key TEXT NOT NULL,target TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',provider_id TEXT,UNIQUE(scope,person,channel,event_key),FOREIGN KEY(scope,person) REFERENCES members(scope,person));
   CREATE INDEX IF NOT EXISTS notice_delivery_due ON notice_deliveries(status,due);
   CREATE TABLE IF NOT EXISTS notice_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `.replaceAll('REFERENCES members(scope,person)','REFERENCES members(scope,person) ON DELETE CASCADE');
  const tables=['notice_preferences','notice_channels','notice_challenges','notice_deliveries'];
  if(store.all('PRAGMA foreign_key_list(notice_preferences)').some(row=>row.table==='members'&&row.on_delete!=='CASCADE'))store.tx(()=>{
   for(const table of tables)store.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy_fk`);
   store.db.exec(schema);
   for(const table of tables){store.db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_legacy_fk`);store.db.exec(`DROP TABLE ${table}_legacy_fk`);}
   store.db.exec('CREATE INDEX IF NOT EXISTS notice_delivery_due ON notice_deliveries(status,due)');
  });else store.db.exec(schema);
  store.run("UPDATE notice_deliveries SET status='unknown',error='interrupted-send' WHERE status='sending' AND updated<?",this.now()-120000);
  this.onTask=job=>{try{const saved=store.get('SELECT status,profile FROM jobs WHERE id=?',job.id);if(saved?.status!==job.status||!['complete','failed'].includes(job.status)||!['R1','R2','R3','S1','S2','A1','A2'].includes(saved.profile))return;this.enqueue(job.person,job.scope,{id:'research-job:'+job.id,type:job.status==='complete'?'research':'risk',title:job.status==='complete'?'Astarter · 模拟研究完成':'Astarter · 研究任务未完成',body:job.status==='complete'?'你的模拟研究已完成，请回到 Astarter 查看结果。':'研究任务未能完成，请回到 Astarter 查看原因与积分结算。',mode:'simulation-only'});}catch(error){console.error('Notification task:',error.code||'unavailable');}};
  store.events.on('task-finished',this.onTask);
 }
 scope(person,scope){return this.store.scope(person,scope).id;}
 preferences(person,scope){return JSON.parse(this.store.get('SELECT events FROM notice_preferences WHERE scope=? AND person=?',scope,person)?.events||JSON.stringify(events));}
 state(person,scope){
  const id=this.scope(person,scope),rows=this.store.all('SELECT channel,target,label,enabled,verified FROM notice_channels WHERE scope=? AND person=?',id,person);
  return {scope:id,events:this.preferences(person,id),services:{telegram:{available:this.transport.available('telegram'),error:this.botError},email:{available:this.transport.available('email')}},channels:Object.fromEntries(channels.map(channel=>[channel,rows.find(x=>x.channel===channel)||{channel,enabled:0,verified:0}])),deliveries:this.store.all('SELECT id,channel,title,status,error,created,updated FROM notice_deliveries WHERE scope=? AND person=? ORDER BY created DESC,rowid DESC LIMIT 20',id,person),mode:'simulation-only'};
 }
 cooldown(person,scope,channel){const last=this.store.get('SELECT created FROM notice_challenges WHERE scope=? AND person=? AND channel=? ORDER BY created DESC LIMIT 1',scope,person,channel);if(last&&last.created+60000>this.now())fail('verification-cooldown',429);}
 async telegramLink(person,scope){
  const id=this.scope(person,scope);this.cooldown(person,id,'telegram');
  try{this.botName=await this.transport.bot();this.botError='';}catch(error){this.botError=error.code||'provider-unavailable';throw error;}
  const token=randomBytes(24).toString('base64url'),expires=this.now()+600000;
  this.store.tx(()=>{this.store.run("DELETE FROM notice_challenges WHERE scope=? AND person=? AND channel='telegram'",id,person);this.store.run('INSERT INTO notice_challenges(id,scope,person,channel,target,secret,expires,created) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,person,'telegram','',hash(token),expires,this.now());});
  return {url:`https://t.me/${this.botName}?start=${token}`,expires};
 }
 async requestEmail(person,scope,email){
  const id=this.scope(person,scope);email=typeof email==='string'?email.trim():'';if(!emailOK(email))fail('email-invalid');this.cooldown(person,id,'email');
  if(!this.transport.available('email'))fail('email-service-missing',503);
  const challenge=randomUUID(),code=String(randomInt(100000,1000000)),expires=this.now()+600000;
  this.store.tx(()=>{this.store.run("DELETE FROM notice_challenges WHERE scope=? AND person=? AND channel='email'",id,person);this.store.run('INSERT INTO notice_challenges(id,scope,person,channel,target,secret,expires,created) VALUES(?,?,?,?,?,?,?,?)',challenge,id,person,'email',email,hash(challenge+code),expires,this.now());});
  try{await this.transport.email(email,'Astarter 邮箱验证 / Verify your email',`验证码 / Verification code: ${code}\n10 分钟内有效。请勿向他人提供验证码。\nExpires in 10 minutes. Do not share this code.`,'verify-'+challenge);}catch(error){if(error.uncertain)return {challenge,expires,status:'unknown'};this.store.run('UPDATE notice_challenges SET attempts=5 WHERE id=?',challenge);throw error;}
  return {challenge,expires,status:'sent'};
 }
 verifyEmail(person,scope,challenge,code){
  if(!plain(challenge,80)||typeof code!=='string')fail('verification-code-invalid');
  const id=this.scope(person,scope),c=this.store.get("SELECT * FROM notice_challenges WHERE id=? AND scope=? AND person=? AND channel='email'",challenge,id,person);
  if(!c||c.expires<=this.now()||c.attempts>=5)fail('verification-expired');
  if(!/^\d{6}$/.test(String(code))||hash(challenge+code)!==c.secret){this.store.run('UPDATE notice_challenges SET attempts=attempts+1 WHERE id=?',challenge);fail('verification-code-invalid');}
  this.bind(c,'email',c.target,c.target);return this.state(person,id);
 }
 bind(c,channel,target,label){this.store.tx(()=>{this.store.run('INSERT INTO notice_channels(scope,person,channel,target,label,verified) VALUES(?,?,?,?,?,?) ON CONFLICT(scope,person,channel) DO UPDATE SET target=excluded.target,label=excluded.label,verified=excluded.verified,enabled=0',c.scope,c.person,channel,target,label,this.now());this.store.run('DELETE FROM notice_challenges WHERE id=?',c.id);});}
 consumeTelegram(update){
  const m=update?.message,token=m?.text?.match(/^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{32})$/)?.[1];
  if(!token||m.chat?.type!=='private'||m.from?.id!==m.chat.id)return false;
  const c=this.store.get("SELECT * FROM notice_challenges WHERE secret=? AND channel='telegram' AND expires>?",hash(token),this.now());if(!c)return false;
  this.bind(c,'telegram',String(m.chat.id),m.from.username?'@'+m.from.username:'Telegram');return true;
 }
 save(person,scope,payload){
  const id=this.scope(person,scope);if(!payload||!Array.isArray(payload.events)||payload.events.some(x=>!events.includes(x))||!payload.enabled||channels.some(c=>typeof payload.enabled[c]!=='boolean'))fail('preferences-invalid');
  if(!payload.events.length&&channels.some(c=>payload.enabled[c]))fail('notification-type-required');
  this.store.tx(()=>{
   for(const channel of channels){const row=this.store.get('SELECT verified FROM notice_channels WHERE scope=? AND person=? AND channel=?',id,person,channel);if(payload.enabled[channel]&&!row?.verified)fail('channel-not-verified',409);if(payload.enabled[channel]&&!this.transport.available(channel))fail(channel+'-service-missing',503);}
   this.store.run('INSERT INTO notice_preferences VALUES(?,?,?) ON CONFLICT(scope,person) DO UPDATE SET events=excluded.events',id,person,JSON.stringify([...new Set(payload.events)]));
   for(const channel of channels){this.store.run('UPDATE notice_channels SET enabled=? WHERE scope=? AND person=? AND channel=?',Number(payload.enabled[channel]),id,person,channel);if(!payload.enabled[channel])this.store.run("UPDATE notice_deliveries SET status='cancelled',error='channel-disabled' WHERE scope=? AND person=? AND channel=? AND status IN ('queued','retry')",id,person,channel);}
  });return this.state(person,id);
 }
 disconnect(person,scope,channel){
  const id=this.scope(person,scope);if(!channels.includes(channel))fail('channel-invalid');
  this.store.tx(()=>{this.store.run('DELETE FROM notice_channels WHERE scope=? AND person=? AND channel=?',id,person,channel);this.store.run('DELETE FROM notice_challenges WHERE scope=? AND person=? AND channel=?',id,person,channel);this.store.run("UPDATE notice_deliveries SET status='cancelled',error='channel-disconnected' WHERE scope=? AND person=? AND channel=? AND status IN ('queued','retry')",id,person,channel);});return this.state(person,id);
 }
 enqueue(person,scope,event,{test=false,channel}={}){
  const id=this.scope(person,scope);if(!plain(event?.id,160)||!plain(event.title,160)||!plain(event.body,1200)||!events.includes(event.type)||event.mode!=='simulation-only')fail('event-invalid');
  if(!test&&!this.preferences(person,id).includes(event.type))return {queued:0};
  const targets=this.store.all('SELECT * FROM notice_channels WHERE scope=? AND person=? AND verified>0',id,person).filter(c=>test?c.channel===channel:c.enabled);
  if(test&&!targets.length)fail('channel-not-verified',409);
  let queued=0;
  this.store.tx(()=>{for(const c of targets){
   if(!this.transport.available(c.channel))fail(c.channel+'-service-missing',503);
   const prior=this.store.get('SELECT * FROM notice_deliveries WHERE scope=? AND person=? AND channel=? AND event_key=?',id,person,c.channel,event.id);
   if(prior){if(prior.title!==event.title||prior.body!==event.body)fail('event-id-conflict',409);continue;}
   const recent=this.store.get("SELECT COUNT(*) n FROM notice_deliveries WHERE scope=? AND person=? AND channel=? AND created>? AND (?=0 OR event_key LIKE 'test-%')",id,person,c.channel,this.now()-60000,Number(test)).n;
   if(recent>=(test?1:30))fail('notification-rate-limited',429);
   const time=this.now();this.store.run('INSERT INTO notice_deliveries(id,scope,person,channel,event_key,target,title,body,status,due,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),id,person,c.channel,event.id,c.target,event.title,event.body,'queued',time,time,time);queued++;
  }});return {queued};
 }
 async pump(){
  if(this.busy)return;this.busy=true;
  try{
   this.store.run("UPDATE notice_deliveries SET status='unknown',error='interrupted-send' WHERE status='sending' AND updated<?",this.now()-120000);
   const d=this.store.get("SELECT * FROM notice_deliveries WHERE status IN ('queued','retry') AND due<=? ORDER BY created,rowid LIMIT 1",this.now());if(!d)return;
   const c=this.store.get('SELECT * FROM notice_channels WHERE scope=? AND person=? AND channel=?',d.scope,d.person,d.channel);
   if(!c||c.target!==d.target||!c.verified){this.store.run("UPDATE notice_deliveries SET status='cancelled',error='binding-changed' WHERE id=?",d.id);return;}
   if(!this.store.run("UPDATE notice_deliveries SET status='sending',attempts=attempts+1,updated=? WHERE id=? AND status IN ('queued','retry')",this.now(),d.id).changes)return;
   try{const providerId=await this.transport.send(d.channel,d.target,d.title,d.body,d.id);this.store.run("UPDATE notice_deliveries SET status=?,provider_id=?,updated=?,error='' WHERE id=?",d.channel==='email'?'accepted':'sent',providerId,this.now(),d.id);}catch(error){
    const retry=(error.retryAfter&&!error.uncertain||d.channel==='email'&&error.uncertain)&&d.attempts<2;
    this.store.run('UPDATE notice_deliveries SET status=?,error=?,due=?,updated=? WHERE id=?',retry?'retry':error.uncertain?'unknown':'failed',error.code||'provider-unavailable',this.now()+(error.retryAfter||30)*1000,this.now(),d.id);
   }
  }finally{this.busy=false;}
 }
 async checkReceipt(){
  if(this.receiptBusy||!this.transport.available('email'))return;this.receiptBusy=true;
  try{
  const d=this.store.get("SELECT * FROM notice_deliveries WHERE channel='email' AND status IN ('accepted','sent') AND updated<? AND created>? ORDER BY updated LIMIT 1",this.now()-15000,this.now()-86400000);if(!d)return;
  try{const status=await this.transport.receipt(d.provider_id);this.store.run('UPDATE notice_deliveries SET status=?,error=?,updated=? WHERE id=?',['delivered','opened','clicked'].includes(status)?'delivered':['bounced','complained','failed'].includes(status)?'failed':status==='sent'?'sent':'accepted',['bounced','complained','failed'].includes(status)?'email-'+status:'',this.now(),d.id);}catch{this.store.run('UPDATE notice_deliveries SET updated=? WHERE id=?',this.now(),d.id);}
  }finally{this.receiptBusy=false;}
 }
 async pollTelegram(){
  if(this.polling||!this.transport.available('telegram'))return;this.polling=true;
  try{if(!this.botName)this.botName=await this.transport.bot();const key='telegram-offset:'+this.botName,offset=Number(this.store.get('SELECT value FROM notice_meta WHERE key=?',key)?.value)||0;
   const updates=await this.transport.telegram('getUpdates',{offset,timeout:10,allowed_updates:['message']});
   for(const update of updates){this.consumeTelegram(update);if(Number.isSafeInteger(update.update_id))this.store.run('INSERT INTO notice_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(update.update_id+1));}this.botError='';
  }catch(error){this.botError=error.code||'provider-unavailable';this.botName='';}finally{this.polling=false;}
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>{this.pump().catch(()=>{});this.checkReceipt().catch(()=>{});},1000);this.timer.unref();this.pollTimer=setInterval(()=>this.pollTelegram().catch(()=>{}),12000);this.pollTimer.unref();}
 close(){clearInterval(this.timer);clearInterval(this.pollTimer);this.store.events.off('task-finished',this.onTask);}
}

export function createNotificationHandler({store=getCommerceStore(),service=new NotificationService(store),autoRun=false}={}){
 if(autoRun)service.start();
 return async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/api/notifications/'))return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  try{
   const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))fail('local-only',403);
   if(req.headers.origin&&req.headers.origin!==`http://${host}`)fail('origin',403);
   if(req.method==='POST'&&(!req.headers.origin||req.headers['content-type']?.split(';')[0]!=='application/json'))fail('origin-or-content-type',403);
   const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('astarter_preview='))?.split('=')[1],session=store.session(token);
   if(session.cookie)res.setHeader('Set-Cookie',`astarter_preview=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
   const scope=service.scope(session.person,req.headers['x-workspace-id']||undefined);let result;
   if(req.method==='GET'&&url.pathname==='/api/notifications/state')result=service.state(session.person,scope);
   else if(req.method==='POST'&&url.pathname==='/api/notifications/command'){
    req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16000)fail('body-too-large',413);}let p;try{p=JSON.parse(body);}catch{fail('json');}if(!p||typeof p!=='object'||Array.isArray(p))fail('command-invalid');
    const {action,payload={}}=p;if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('command-invalid');
    if(action==='telegram-link')result=await service.telegramLink(session.person,scope);
    else if(action==='email-code')result=await service.requestEmail(session.person,scope,payload.email);
    else if(action==='email-verify')result=service.verifyEmail(session.person,scope,payload.challenge,payload.code);
    else if(action==='save')result=service.save(session.person,scope,payload);
    else if(action==='disconnect')result=service.disconnect(session.person,scope,payload.channel);
    else if(action==='event')result=service.enqueue(session.person,scope,payload);
    else if(action==='test')result=service.enqueue(session.person,scope,{id:'test-'+randomUUID(),title:'Astarter 通知测试 / Notification test',body:'这是一条测试通知。收到后，说明当前渠道可以接收消息。\nThis is a test notification from Astarter.',type:'risk',mode:'simulation-only'},{test:true,channel:payload.channel});
    else fail('action-invalid');
   }else fail('not-found',404);
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){res.writeHead(error.status||500);res.end(JSON.stringify({error:error.code||'notification-service-unavailable'}));}return true;
 };
}
let handler;
export function startNotifications(){handler||=createNotificationHandler({autoRun:true});return handler;}
export function handleNotifications(req,res){if(!req.url.startsWith('/api/notifications/'))return false;return startNotifications()(req,res);}
