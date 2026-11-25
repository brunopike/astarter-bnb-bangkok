import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationSettings} from './notification-settings.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const snapshot=(scope,status='queued')=>({scope,events:['risk'],services:{email:{available:true},telegram:{available:false}},channels:{email:{enabled:1,verified:1,label:'fixture@example.invalid'},telegram:{enabled:0,verified:0}},deliveries:[{id:scope,channel:'email',title:scope+' delivery',status,error:'',created:1800000000000,updated:1800000000000}]});
function element(){const save={},log={open:false};return {isConnected:true,innerHTML:'',querySelector(selector){return selector==='[data-notice-save]'?save:selector==='.cc-notice-log'?log:null;},querySelectorAll(){return [];}};}
function fixture(t,reply){
 t.mock.timers.enable({apis:['setInterval']});
 t.mock.method(globalThis,'fetch',reply);
 const before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
 t.after(()=>{if(before)Object.defineProperty(globalThis,'document',before);else delete globalThis.document;});
 let scope='fixture-a';const settings=createNotificationSettings({getScope:()=>scope});t.after(()=>settings.close());
 return {settings,root:element(),switchScope(next){scope=next;}};
}

test('reopening pending history polls once, then stops after a terminal receipt',async t=>{
 let reads=0;const f=fixture(t,async()=>new Response(JSON.stringify(snapshot('fixture-a',++reads===1?'queued':'delivered'))));
 await f.settings.mount(f.root);assert.equal(reads,1);
 t.mock.timers.tick(4000);await flush();assert.equal(reads,2);assert.match(f.root.innerHTML,/Delivered|delivered|已送达/);
 t.mock.timers.tick(12000);await flush();assert.equal(reads,2);
});

test('close aborts the active request and reopening has one polling loop',async t=>{
 const pending=[];let reads=0;const f=fixture(t,async(_url,options)=>{reads++;if(reads===1)return new Response(JSON.stringify(snapshot('fixture-a')));return new Promise(resolve=>pending.push({resolve,signal:options.signal}));});
 await f.settings.mount(f.root);t.mock.timers.tick(4000);await flush();assert.equal(pending.length,1);
 t.mock.timers.tick(8000);await flush();assert.equal(pending.length,1,'one refresh may be in flight');
 f.settings.close();assert.equal(pending[0].signal.aborted,true);const closedReads=reads;t.mock.timers.tick(12000);await flush();assert.equal(reads,closedReads);
 const next=element(),opening=f.settings.mount(next);await flush();assert.equal(pending.length,2);pending[1].resolve(new Response(JSON.stringify(snapshot('fixture-a'))));await opening;
 t.mock.timers.tick(4000);await flush();assert.equal(pending.length,3);pending[0].resolve(new Response(JSON.stringify(snapshot('fixture-a','failed'))));await flush();assert.doesNotMatch(next.innerHTML,/Failed|发送失败/);
});

test('a scope switch aborts polling and an old response never repaints the new scope',async t=>{
 let resolveOld,oldSignal,reads=0;const f=fixture(t,async(_url,options)=>{reads++;if(reads===2){oldSignal=options.signal;return new Promise(resolve=>{resolveOld=resolve;});}return new Response(JSON.stringify(snapshot(reads===1?'fixture-a':'fixture-b')));});
 await f.settings.mount(f.root);t.mock.timers.tick(4000);await flush();assert.equal(reads,2);
 f.switchScope('fixture-b');t.mock.timers.tick(4000);await flush();assert.equal(oldSignal.aborted,true);assert.equal(reads,2);
 const next=element();await f.settings.mount(next);assert.match(next.innerHTML,/fixture-b delivery/);resolveOld(new Response(JSON.stringify(snapshot('fixture-a','failed'))));await flush();assert.doesNotMatch(next.innerHTML,/fixture-a delivery|Failed|发送失败/);
 t.mock.timers.tick(4000);await flush();assert.equal(reads,4);
});

test('a scope change between mount capture and dispatch makes zero HTTP requests',async t=>{
 let reads=0,lookups=0;t.mock.method(globalThis,'fetch',async()=>{reads++;return new Response(JSON.stringify(snapshot('fixture-a')));});
 const root=element(),query=root.querySelector.bind(root),retry={};root.querySelector=selector=>selector==='[data-notice-retry]'?retry:query(selector);
 const settings=createNotificationSettings({getScope:()=>++lookups===1?'fixture-a':'fixture-b'});t.after(()=>settings.close());
 await settings.mount(root);assert.equal(reads,0);assert.match(root.innerHTML,/role="alert"/);assert.match(root.innerHTML,/workspace changed|工作区已切换/i);
});

const bindState=scope=>({...snapshot(scope),services:{email:{available:true},telegram:{available:true}},deliveries:[]});
function bindElement(){
 const root=element(),base=root.querySelector,feedback={textContent:'',dataset:{},setAttribute(name,value){this[name]=value;}},button={addEventListener(type,listener){if(type==='click')this.click=listener;}};
 root.querySelector=selector=>selector==='[data-notice-telegram]'?button:selector==='[data-notice-feedback]'?feedback:base(selector);
 return Object.assign(root,{button,feedback});
}
function bindFixture(t){let answer=null;const f=fixture(t,async(_url,options)=>new Response(JSON.stringify(options.method==='POST'?answer:bindState('fixture-a'))));const root=bindElement();return {...f,root,async bind(next){answer=next;await root.button.click();}};}
const unavailableText=/Notifications are unavailable|通知服务暂时不可用/;

test('a Telegram bind answer that is not an https t.me address without a user part shows the unavailable message and no link',async t=>{
 const f=bindFixture(t);await f.settings.mount(f.root);const linked=[];
 for(const url of ['http://t.me/fixture_bot?start=fixture','tg://resolve?domain=fixture_bot&start=fixture','javascript:void(0)','data:text/plain,fixture','https://t.me.example.invalid/fixture_bot?start=fixture','https://t.mе/fixture_bot?start=fixture','https://example.invalid/t.me/fixture_bot?start=fixture','https://t.me@example.invalid/fixture_bot?start=fixture','https://fixture@t.me/fixture_bot?start=fixture','https://fixture:fixture@t.me/fixture_bot?start=fixture','https://t.me:8443/fixture_bot?start=fixture','//t.me/fixture_bot?start=fixture','',undefined]){
  await f.bind({url,expires:1800000600000});
  if(/<a\b/.test(f.root.innerHTML)||!unavailableText.test(f.root.feedback.textContent)||f.root.feedback.dataset.error!=='true')linked.push(String(url));
 }
 assert.deepEqual(linked,[]);
});

test('a valid t.me bind link keeps noopener noreferrer, and a later bad answer removes it',async t=>{
 const f=bindFixture(t);await f.settings.mount(f.root);
 await f.bind({url:'https://t.me/fixture_bot?start=fixture-token_1',expires:1800000600000});
 assert.match(f.root.innerHTML,/<a class="p-button p-primary" href="https:\/\/t\.me\/fixture_bot\?start=fixture-token_1" target="_blank" rel="noopener noreferrer">/);
 assert.match(f.root.feedback.textContent,/Open Telegram and press Start|请打开 Telegram 并点击 Start/);assert.equal(f.root.feedback.dataset.error,'false');
 await f.bind({url:'https://t.me.example.invalid/fixture_bot?start=fixture-token_2',expires:1800000600000});
 assert.doesNotMatch(f.root.innerHTML,/<a\b|fixture-token/);
 assert.match(f.root.feedback.textContent,unavailableText);assert.equal(f.root.feedback.dataset.error,'true');
});

test('a t.me bind answer without its two slashes renders the parsed https://t.me address, never one the page resolves against its own origin',async t=>{
 const f=bindFixture(t);await f.settings.mount(f.root);const wrong=[];
 for(const url of ['https:t.me/fixture_bot?start=fixture-token_3','https:/t.me/fixture_bot?start=fixture-token_3','https:\\t.me/fixture_bot?start=fixture-token_3','https:t.me/../fixture_bot?start=fixture-token_3']){
  await f.bind({url,expires:1800000600000});
  const hrefs=[...f.root.innerHTML.matchAll(/href="([^"]*)"/g)].map(m=>m[1]);
  if(hrefs.length!==1||hrefs[0]!=='https://t.me/fixture_bot?start=fixture-token_3'||f.root.feedback.dataset.error!=='false')wrong.push(url+' -> '+hrefs.join(' '));
 }
 assert.deepEqual(wrong,[]);
});

const preferenceState=(scope,channels={})=>({...bindState(scope),channels:{telegram:{enabled:0,verified:0},email:{enabled:0,verified:0},...channels}});
function formElement(){
 const root=bindElement(),base=root.querySelector,input=(hook,key)=>{const tag=root.innerHTML.match(new RegExp('<input[^>]*'+hook+'[^>]*>'))?.[0];return tag?{get checked(){return key in root.form?root.form[key]:/\schecked\b/.test(tag);}}:null;};
 root.form={};
 root.querySelector=selector=>{const id=selector.match(/^\[data-notice-enable="(\w+)"\]$/)?.[1];return id?input(`data-notice-enable="${id}"`,id):selector==='[data-notice-inapp]'?input('data-notice-inapp','inapp'):base(selector);};
 root.querySelectorAll=selector=>selector==='[data-notice-event]:checked'?(root.form.events??[...root.innerHTML.matchAll(/<input[^>]*data-notice-event="(\w+)"[^>]*>/g)].filter(m=>/\schecked\b/.test(m[0])).map(m=>m[1])).map(noticeEvent=>({dataset:{noticeEvent}})):[];
 return root;
}
function preferenceFixture(t,reply){
 const sent=[],saved=[],changes=[];t.mock.timers.enable({apis:['setInterval']});
 t.mock.method(globalThis,'fetch',async(_url,options)=>{const body=options.body?JSON.parse(options.body):null;if(body)sent.push(body);return new Response(JSON.stringify(reply(body)));});
 const before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false,dispatchEvent(event){changes.push(event.type);return true;}}});
 t.after(()=>{if(before)Object.defineProperty(globalThis,'document',before);else delete globalThis.document;});
 const settings=createNotificationSettings({getScope:()=>'fixture-a',getLocal:()=>({}),saveLocal(value){saved.push(value);return null;}});t.after(()=>settings.close());
 const root=formElement();return {settings,root,sent,saved,changes,save:()=>root.querySelector('[data-notice-save]').onclick()};
}

test('preferences and external-channel binding are separate groups: switches, events and Save first, then connect, verify, test and disconnect',async t=>{
 const f=preferenceFixture(t,()=>preferenceState('fixture-a',{telegram:{enabled:1,verified:1,label:'@fixture_user'}}));await f.settings.mount(f.root);
 const html=f.root.innerHTML,split=html.indexOf('data-notice-binding');assert.ok(split>0,'the binding group starts at its own marked heading');
 const preferences=html.slice(0,split),binding=html.slice(split),sections=binding.match(/<section class="cc-notice-channel">[\s\S]*?<\/section>/g)??[];
 for(const hook of ['data-notice-inapp','data-notice-enable="telegram"','data-notice-enable="email"','data-notice-event="risk"','data-notice-save']){assert.ok(preferences.includes(hook),hook);assert.ok(!binding.includes(hook),hook);}
 for(const hook of ['data-notice-test="telegram"','data-notice-disconnect="telegram"','data-notice-email ','data-notice-email-code'])assert.ok(binding.includes(hook),hook);
 assert.doesNotMatch(preferences,/data-notice-(?:telegram|email|test|disconnect|refresh|code)\b/);
 assert.equal(sections.length,2);for(const section of sections)assert.doesNotMatch(section,/data-notice-(?:enable|save|inapp|event)\b/);
 assert.match(preferences.match(/<input[^>]*data-notice-enable="email"[^>]*>/)[0],/\sdisabled\b/);assert.match(preferences,/未绑定|Not connected/);
 assert.doesNotMatch(preferences.match(/<input[^>]*data-notice-enable="telegram"[^>]*>/)[0],/\sdisabled\b/);
});

test('connecting a channel saves no preference, and a new binding stays off until the person saves it',async t=>{
 let bound=false;const f=preferenceFixture(t,body=>!body?preferenceState('fixture-a',bound?{telegram:{enabled:0,verified:1,label:'@fixture_user'}}:{}):body.action==='telegram-link'?{url:'https://t.me/fixture_bot?start=fixture-token_5',expires:1800000600000}:preferenceState('fixture-a',{telegram:{enabled:Number(body.payload.enabled.telegram),verified:1,label:'@fixture_user'}}));
 await f.settings.mount(f.root);f.root.form.inapp=false;f.root.form.events=['orders','risk'];
 await f.root.button.click();assert.deepEqual(f.sent.map(b=>b.action),['telegram-link']);assert.deepEqual(f.saved,[]);
 bound=true;t.mock.timers.tick(4000);await flush();
 assert.match(f.root.feedback.textContent,/Telegram connected\. Enable it and save|Telegram 已绑定。开启开关并保存/);
 assert.doesNotMatch(f.root.innerHTML.match(/<input[^>]*data-notice-enable="telegram"[^>]*>/)[0],/\schecked\b|\sdisabled\b/);
 assert.deepEqual(f.sent.map(b=>b.action),['telegram-link']);assert.deepEqual(f.saved,[]);assert.deepEqual(f.changes,[]);
 f.root.form.telegram=true;await f.save();
 assert.deepEqual(f.sent.at(-1),{action:'save',payload:{events:['orders','risk'],enabled:{telegram:true,email:false}}});
 assert.deepEqual(f.saved,[{inapp:false,events:['orders','risk']}]);assert.deepEqual(f.changes,['hive:notification-change']);
});

test('a saved in-app preference names only what the save turned on and never claims an external delivery',async t=>{
 const email=enabled=>({email:{enabled,verified:1,label:'fixture@example.invalid'}}),delivery=/sent|deliver|已发送|送达|已推送/i;
 const f=preferenceFixture(t,body=>preferenceState('fixture-a',email(body?.action==='save'?Number(body.payload.enabled.email):0)));await f.settings.mount(f.root);
 for(const [form,text] of [[{inapp:true,email:false},/^(?:In-app preferences saved\. External notifications are off\.|站内提醒已保存，外部通知未开启。)$/],[{inapp:false,email:false},/^(?:All notifications are off\.|所有通知已关闭。)$/],[{inapp:true,email:true},/^(?:Notification settings applied\.|通知设置已生效。)$/]]){
  Object.assign(f.root.form,form);await f.save();
  assert.match(f.root.feedback.textContent,text);assert.doesNotMatch(f.root.feedback.textContent,delivery);assert.equal(f.root.feedback.dataset.error,'false');
 }
 assert.deepEqual(f.sent.map(b=>[b.action,b.payload.enabled.telegram,b.payload.enabled.email]),[['save',false,false],['save',false,false],['save',false,true]]);
 assert.deepEqual(f.saved.map(v=>v.inapp),[true,false,true]);
});
