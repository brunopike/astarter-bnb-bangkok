import {L} from './execution-views.mjs';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const telegramBindLink=value=>{if(typeof value!=='string')return null;try{const url=new URL(value);return url.protocol==='https:'&&url.host==='t.me'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const channelStates=new Map();
export function notificationSummary(scope,inapp){
 const state=channelStates.get(scope);if(!state)return {label:L('管理接收渠道','Manage destinations'),active:Boolean(inapp)};
 const names=inapp?[L('站内','In-app')]:[];for(const channel of ['telegram','email'])if(state.channels[channel]?.enabled&&state.channels[channel].verified&&state.services[channel].available)names.push(channel==='telegram'?'Telegram':L('邮件','Email'));
 const unavailable=['telegram','email'].some(channel=>state.channels[channel]?.enabled&&!state.services[channel].available);
 return {label:names.length?names.join(' · '):unavailable?L('外部推送暂不可用','External delivery unavailable'):L('通知已关闭','Notifications off'),active:names.length>0};
}
const errorText=code=>L(...({
 'telegram-service-missing':['平台尚未配置通知机器人，暂时不能绑定。','The platform notification bot is not configured yet.'],
 'email-service-missing':['平台尚未配置发件服务，暂时不能发送验证码。','The platform email sender is not configured yet.'],
 'telegram-webhook-in-use':['机器人正在被另一套服务使用，需要管理员调整接收方式。','This bot is in use by another service. Ask the administrator to adjust it.'],
 'telegram-access-denied':['机器人访问被拒绝，请检查平台配置或是否屏蔽了机器人。','Bot access was denied. Check the service configuration or whether you blocked the bot.'],
 'email-sender-not-authorized':['发件权限或发件域名未通过，请由管理员检查。','The sender is not authorized. Ask the administrator to check the key and domain.'],
 'verification-cooldown':['请等待 60 秒后再申请。','Wait 60 seconds before requesting another code or link.'],
 'verification-expired':['验证码已过期或尝试次数过多，请重新申请。','The code expired or has too many attempts. Request another.'],
 'verification-code-invalid':['验证码不正确，请重新输入。','That code is incorrect. Try again.'],
 'email-invalid':['请填写完整的邮箱地址。','Enter a valid email address.'],
 'channel-not-verified':['请先完成绑定或邮箱验证。','Bind your account or verify your email first.'],
 'notification-type-required':['请至少选择一种通知。','Choose at least one notification type.'],
 'notification-rate-limited':['发送太频繁，请稍后再试。','Too many notifications. Try again shortly.'],
 'delivery-unknown':['发送结果还未确认，请先查看收件箱，不要连续重发。','Delivery is unconfirmed. Check your inbox before sending again.'],
 'provider-rate-limited':['发送服务限流，稍后会再尝试。','The provider is rate limiting requests. Delivery will be retried.'],
 'provider-unavailable':['发送服务暂时没有响应，请稍后重试。','The delivery provider is unavailable. Try again shortly.'],
 'provider-rejected':['发送服务拒绝了请求，请检查接收账户和发件配置。','The provider rejected the request. Check the recipient and sender setup.'],
 'email-bounced':['邮件被退回，请检查邮箱地址。','The email bounced. Check the address.'],
 'email-complained':['收件人已将邮件标为垃圾邮件，请更换接收设置。','The email was marked as spam. Review the destination.'],
 'scope-changed':['工作区已切换，请重新打开通知设置。','The workspace changed. Reopen notification settings.'],
 'local-save-failed':['外部通知设置已保存，但站内提醒未能保存，请重试。','External preferences were saved, but in-app preferences were not. Try again.'],
 }[code]||['通知服务暂时不可用，请重试。','Notifications are unavailable. Try again.']));
export async function notificationRequest(action,payload,{scope='',request=fetch,signal}={}){
 const timeout=AbortSignal.timeout(20000);
 const response=await request('/api/notifications/'+(action?'command':'state'),{method:action?'POST':'GET',credentials:'same-origin',headers:{...(scope?{'X-Workspace-Id':scope}:{}),...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify({action,payload}),keepalive:action==='event'}:{}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
 const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'notification-service-unavailable'),{code:result.error});if(result.channels&&result.scope)channelStates.set(result.scope,result);return result;
}
const eventChoices=[['orders','策略、委托与成交','Strategies, orders & fills'],['risk','风险与运行异常','Risk & run alerts'],['research','研究完成与新机会','Research & opportunities']];
const statusLabel=status=>L(...({queued:['等待发送','Queued'],sending:['发送中','Sending'],retry:['等待重试','Retry scheduled'],accepted:['邮件服务已接收','Accepted by email provider'],sent:['已发送','Sent'],delivered:['邮件已送达','Email delivered'],failed:['发送失败','Failed'],unknown:['结果待确认','Unconfirmed'],cancelled:['已取消','Cancelled']}[status]||['等待发送','Queued']));

export function createNotificationSettings({getScope=()=>'',getLocal=()=>({}),saveLocal=()=>null}={}){
 let root=null,state=null,serial=0,busy=false,refreshing=false,poll=null,controller=null,link=null,challenge=null,scope='',draftEmail='',draftEvents=null,draftEnabled=null,draftInapp=true;
 const q=s=>root?.querySelector(s);
 async function call(action,payload){const epoch=serial,key=scope;if(key!==getScope())throw Error('scope-changed');const result=await notificationRequest(action,payload,{scope:key,signal:controller?.signal});if(epoch!==serial||key!==getScope())throw Error('scope-changed');return result;}
 function message(text,error=false){const el=q('[data-notice-feedback]');if(el){el.textContent=text;el.dataset.error=String(error);el.setAttribute('role',error?'alert':'status');}}
 function capture(){if(!root)return;draftEvents=[...root.querySelectorAll('[data-notice-event]:checked')].map(el=>el.dataset.noticeEvent);draftEnabled=Object.fromEntries(['telegram','email'].map(c=>[c,Boolean(q(`[data-notice-enable="${c}"]`)?.checked)]));draftInapp=Boolean(q('[data-notice-inapp]')?.checked);if(q('[data-notice-email]'))draftEmail=q('[data-notice-email]').value;}
 function render(){
  if(!root?.isConnected)return;const logOpen=q('.cc-notice-log')?.open;
  const status=id=>!state.services[id].available?L('服务未开通','Service not configured'):state.channels[id].verified?L('已绑定','Connected'):L('未绑定','Not connected');
  const delivery=(id,title)=>`<label class="connection-toggle"><span><b>${title}</b><small>${status(id)}</small></span><input type="checkbox" role="switch" data-notice-enable="${id}" aria-label="${L('开启','Enable')} ${title}" ${draftEnabled[id]?'checked':''} ${!state.services[id].available||!state.channels[id].verified?'disabled':''}></label>`;
  const channel=(id,title,description)=>{const c=state.channels[id],available=state.services[id].available;return `<section class="cc-notice-channel"><div class="cc-notice-channel-heading"><div><h4>${title}</h4><span>${status(id)}</span></div></div>${c.verified?`<p>${escape(c.label)}</p><div class="cc-notice-actions"><button type="button" class="p-button" data-notice-test="${id}" ${!available?'disabled':''}>${L('发送测试通知','Send test notification')}</button><button type="button" class="p-button" data-notice-disconnect="${id}">${L('解除绑定','Disconnect')}</button></div>`:id==='telegram'?`<p>${available?description:L('平台需要先建立通知机器人，开通后点击绑定即可。','The platform needs a notification bot. Once configured, connect it here.')}</p><button type="button" class="p-button" data-notice-telegram ${!available?'disabled':''}>${L('绑定 Telegram','Connect Telegram')}</button>${link?`<div class="cc-notice-bind"><a class="p-button p-primary" href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${L('打开 Telegram 并点击 Start','Open Telegram and press Start')} ↗</a><span>${L('完成后此处会自动更新，链接 10 分钟内有效。','This page updates automatically. The link expires in 10 minutes.')}</span><button type="button" class="p-button" data-notice-refresh>${L('我已完成，检查绑定','Check connection')}</button></div>`:''}`:`<label class="cc-field">${L('接收邮箱','Email address')}<input type="email" data-notice-email value="${escape(draftEmail)}" placeholder="name@example.com" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" ${!available?'disabled':''}></label>${!available?`<p>${L('平台需要开通邮件服务并验证发件域名。','The platform needs an email service and a verified sender domain.')}</p>`:''}<button type="button" class="p-button" data-notice-email-code ${!available?'disabled':''}>${challenge?L('重新发送验证码','Resend code'):L('发送验证码','Send verification code')}</button>${challenge?`<div class="cc-notice-code"><label class="cc-field">${L('邮箱验证码','Email verification code')}<input data-notice-code inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label><button type="button" class="p-button" data-notice-email-verify>${L('验证并绑定','Verify & connect')}</button></div>`:''}`}</section>`;};
  root.innerHTML=`<div class="cc-notification-service"><h3>${L('通知','Notifications')}</h3><label class="connection-toggle"><b>${L('站内提醒','In-app notices')}</b><input type="checkbox" role="switch" data-notice-inapp ${draftInapp?'checked':''}></label>${delivery('telegram','Telegram')}${delivery('email',L('邮件','Email'))}<fieldset class="cc-events"><legend>${L('接收哪些通知','What to receive')}</legend>${eventChoices.map(([id,z,en])=>`<label><input type="checkbox" data-notice-event="${id}" ${draftEvents.includes(id)?'checked':''}>${L(z,en)}</label>`).join('')}</fieldset><div class="cc-notice-save"><span data-notice-feedback role="status"></span><button type="button" class="p-button p-primary" data-notice-save>${L('保存通知设置','Save settings')}</button></div><h3 data-notice-binding>${L('管理接收渠道','Manage destinations')}</h3>${channel('telegram','Telegram',L('打开平台机器人，点击 Start 即可绑定，不需要填写 Chat ID。','Open the platform bot and press Start. No Chat ID is needed.'))}${channel('email',L('邮件','Email'),'')}<details class="cc-notice-log"><summary>${L('发送记录','Delivery history')} · ${state.deliveries.length}</summary>${state.deliveries.length?`<ol>${state.deliveries.map(d=>`<li><div><b>${escape(d.title)}</b><span>${d.channel==='telegram'?'Telegram':L('邮件','Email')} · ${new Date(d.created).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span></div><span>${statusLabel(d.status)}</span>${d.error?`<p>${escape(errorText(d.error))}</p>`:''}</li>`).join('')}</ol>`:`<p>${L('尚未发送通知。绑定后可以先发送一条测试。','No notifications sent yet. Connect a channel and send a test.')}</p>`}</details></div>`;
  if(logOpen)q('.cc-notice-log').open=true;
  q('[data-notice-save]').onclick=()=>run(async()=>{capture();const result=await call('save',{events:draftEvents,enabled:draftEnabled});const problem=saveLocal({inapp:draftInapp,events:draftEvents});state=result;if(problem)throw Error('local-save-failed');render();message(Object.values(draftEnabled).some(Boolean)?L('通知设置已生效。','Notification settings applied.'):draftInapp?L('站内提醒已保存，外部通知未开启。','In-app preferences saved. External notifications are off.'):L('所有通知已关闭。','All notifications are off.'));document.dispatchEvent(new CustomEvent('hive:notification-change'));});
  q('[data-notice-telegram]')?.addEventListener('click',()=>run(async()=>{capture();link=await call('telegram-link',{});const href=telegramBindLink(link?.url);if(!href){link=null;render();throw Error('notification-service-unavailable');}link={...link,url:href};render();message(L('请打开 Telegram 并点击 Start。','Open Telegram and press Start.'));startPoll();}));
  q('[data-notice-email-code]')?.addEventListener('click',()=>run(async()=>{capture();challenge=await call('email-code',{email:draftEmail});render();message(challenge.status==='unknown'?errorText('delivery-unknown'):L('验证码已交给邮件服务，请查看收件箱。','The email provider accepted the code. Check your inbox.'),challenge.status==='unknown');q('[data-notice-code]')?.focus();}));
  q('[data-notice-email-verify]')?.addEventListener('click',()=>run(async()=>{const code=q('[data-notice-code]').value;capture();state=await call('email-verify',{challenge:challenge.challenge,code});challenge=null;draftEnabled.email=false;render();message(L('邮箱已验证。开启邮件开关并保存后接收通知。','Email verified. Enable email and save to receive notifications.'));}));
  q('[data-notice-refresh]')?.addEventListener('click',()=>run(()=>refresh(true)));
  for(const b of root.querySelectorAll('[data-notice-test]'))b.onclick=()=>run(async()=>{capture();await call('test',{channel:b.dataset.noticeTest});await refresh();message(L('测试通知已进入发送队列，请查看接收端和发送记录。','Test notification queued. Check your destination and delivery history.'));q('.cc-notice-log').open=true;startPoll();});
  for(const b of root.querySelectorAll('[data-notice-disconnect]'))b.onclick=()=>run(async()=>{capture();const channel=b.dataset.noticeDisconnect;state=await call('disconnect',{channel});draftEnabled[channel]=false;link=null;render();message(L('已解除绑定，停止此渠道后续推送。','Disconnected. Future notifications to this channel are stopped.'));});
  for(const input of root.querySelectorAll('input'))input.addEventListener('input',()=>{capture();message('');});
 }
 async function run(fn){if(busy||!root?.isConnected)return;const epoch=serial,active=document.activeElement,attribute=active?.getAttributeNames?.().find(n=>n.startsWith('data-notice-')),selector=attribute?`[${attribute}${active.getAttribute(attribute)?'="'+CSS.escape(active.getAttribute(attribute))+'"':''}]`:'';busy=true;for(const b of root.querySelectorAll('button,input'))b.disabled=true;message(L('处理中…','Working…'));try{await fn();if(epoch!==serial||getScope()!==scope)throw Error('scope-changed');}catch(error){if(epoch===serial&&root?.isConnected)message(errorText(error.code||error.message),true);}finally{if(epoch===serial)busy=false;if(epoch===serial&&root?.isConnected){for(const b of root.querySelectorAll('button,input'))b.disabled=false;for(const id of ['telegram','email']){const available=state?.services[id].available;const toggle=q(`[data-notice-enable="${id}"]`);if(toggle)toggle.disabled=!available||!state?.channels[id].verified;if(!available)for(const b of root.querySelectorAll(id==='telegram'?'[data-notice-telegram],[data-notice-test="telegram"]':'[data-notice-email],[data-notice-email-code],[data-notice-test="email"]'))b.disabled=true;}if(selector&&!root.querySelector('input:focus'))q(selector)?.focus({preventScroll:true});}}}
 async function refresh(check=false){
  if(refreshing)return;const epoch=serial;refreshing=true;try{
  const next=await call(null,null);if(epoch!==serial||!root?.isConnected||getScope()!==scope)return;
  capture();const connected=link&&!state?.channels.telegram.verified&&next.channels.telegram.verified;state=next;if(connected){link=null;draftEnabled.telegram=false;}
  render();if(connected)message(L('Telegram 已绑定。开启开关并保存后接收通知。','Telegram connected. Enable it and save to receive notifications.'));else if(check)message(L('尚未收到绑定确认，请在 Telegram 点击 Start。','No connection yet. Press Start in Telegram.'));
  }finally{if(epoch===serial)refreshing=false;}
 }
 function startPoll(){clearInterval(poll);const epoch=serial,timer=setInterval(()=>{if(epoch!==serial||getScope()!==scope){clearInterval(timer);if(epoch===serial)controller?.abort();return;}if(!link&&!state?.deliveries.some(d=>['queued','retry','sending'].includes(d.status)||d.channel==='email'&&['accepted','sent'].includes(d.status))){clearInterval(timer);return;}if(root?.isConnected&&!document.hidden&&!busy&&!refreshing&&!root.querySelector('input:focus'))refresh().catch(error=>{if(epoch===serial&&getScope()===scope)message(errorText(error.code),true);});},4000);poll=timer;}
 return {
  async mount(element){this.close();root=element;scope=getScope();controller=new AbortController();const epoch=serial;root.innerHTML=`<p role="status">${L('正在读取通知设置…','Loading notification settings…')}</p>`;
   try{state=await call(null,null);if(epoch!==serial||!root?.isConnected||getScope()!==scope)return;const local=getLocal();draftInapp=local.inapp!==false;draftEvents=[...state.events];draftEnabled=Object.fromEntries(['telegram','email'].map(c=>[c,Boolean(state.channels[c].enabled)]));draftEmail='';render();startPoll();}catch(error){if(epoch===serial&&root?.isConnected){root.innerHTML=`<p role="alert">${escape(errorText(error.code||error.message))}</p><button class="p-button" data-notice-retry>${L('重试','Retry')}</button>`;q('[data-notice-retry]').onclick=()=>this.mount(root);}}
  },
  close(){serial++;clearInterval(poll);controller?.abort();controller=null;root=null;state=null;link=null;challenge=null;busy=false;refreshing=false;}
 };
}

export function notificationEvent(source,event){
 const type=source==='trade'?['order','fill','signal'].includes(event.kind)?'orders':event.kind==='risk'?'risk':null:event.kind==='research'?'research':event.kind==='risk'?'risk':event.kind==='execution'?'orders':null;
 if(!type||!event.text)return null;
 return {id:source+':'+(event.runId||'workspace')+':'+event.id+':'+(event.recordedAt||event.ref||event.at||0),type,title:'Astarter · '+({orders:'模拟交易动态',risk:'模拟风险提醒',research:'模拟研究完成'}[type]),body:event.text,mode:'simulation-only'};
}
export function createNotificationPublisher({getScope=()=>'',request=notificationRequest,onError=code=>document.dispatchEvent(new CustomEvent('hive:notification-error',{detail:code}))}={}){
 let scope=null,seen=new Set(),stamp='',reported=false;
 function deliver(item,key,attempt=0){request('event',item,{scope:key}).then(()=>{reported=false;}).catch(error=>{if(!reported){reported=true;onError(error.code||'notification-service-unavailable');}if(attempt<2&&getScope()===key&&(!error.code||['notification-service-unavailable','notification-rate-limited'].includes(error.code)))setTimeout(()=>{if(getScope()===key)deliver(item,key,attempt+1);},5000*(attempt+1));});}
 return {observe(trade=[],notices=[]){const current=getScope(),nextStamp=current+':'+trade[0]?.id+':'+notices[0]?.id;if(stamp===nextStamp)return;stamp=nextStamp;const items=[...trade.map(e=>notificationEvent('trade',e)),...notices.map(e=>notificationEvent('workspace',e))].filter(Boolean);
  if(current!==scope){scope=current;seen=new Set(items.map(e=>e.id));return;}
  for(const item of items){if(seen.has(item.id))continue;seen.add(item.id);if(!current)continue;deliver(item,current);}
  if(seen.size>1000)seen=new Set(items.map(e=>e.id));
 }};
}
