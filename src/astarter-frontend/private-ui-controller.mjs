import {createPrivateWorkspaceClient,createPrivateNotificationsClient} from './private-workspace-client.mjs';
import {pair as L,getLocale,localeInfo} from './locale.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const profile='private-ui-v2';
const labels={idle:['尚未读取云端','Cloud state not loaded'],loading:['正在读取','Loading'],ready:['已读取账户数据','Account data loaded'],saving:['正在保存','Saving'],conflict:['云端已有新版本，请重新读取','Cloud state changed. Load it again.'],unknown:['结果待确认，请查询原请求','Unconfirmed. Check the original request.'],'auth-required':['请登录后继续','Sign in to continue'],forbidden:['当前登录未获账户访问权限','This session cannot access account settings'],error:['暂时无法连接，请重试读取','Unavailable. Try loading again.']};
const button=(action,text,disabled=false)=>`<button type="button" class="p-button" data-private-action="${action}"${disabled?' disabled':''}>${text}</button>`;
const events=[['risk','风险提醒','Risk alerts'],['research','研究完成','Research ready']];
const notificationPreferences=value=>({inapp:value.inapp,events:[...value.events]});
const samePreferences=(a,b)=>Boolean(a&&b&&a.inapp===b.inapp&&JSON.stringify(a.events)===JSON.stringify(b.events));

export function createPrivateUIController({fetchImpl,storage,now=Date.now,timeoutMs=15000,eventTarget=globalThis.window,getWorkspaceInput=()=>null,applyWorkspaceInput=()=>null,onOpenDraft=null,onChange=()=>{}}={}){
 const listeners=new Set(),mounts=new Map();let identity=null,changing=false,disposed=false,feedback='',notificationDraft=null,notificationDraftBase=null,notificationDraftEdits=0,notificationReload=null,notificationEpoch=0,root=null,unbind=()=>{},workspaceAction='',appliedRevision=null,identityTimer=null,authFailure=null,operationEpoch=0;
 const clearNotificationDraft=()=>{notificationDraft=null;notificationDraftBase=null;notificationDraftEdits++;notificationReload=null;};
 function syncNotificationDraft(state,replace=false){
  if(!state)return;
  const editedDuringReload=notificationReload&&notificationReload.edits!==notificationDraftEdits;
  if(replace||!notificationDraft||!editedDuringReload&&samePreferences(notificationDraft,notificationDraftBase))notificationDraft=notificationPreferences(state);
  notificationDraftBase=notificationPreferences(state);
 }
 const changed=()=>{if(changing||disposed)return;const failure=[workspace.snapshot(),notifications.snapshot()].find(value=>value.ownerRef===identity?.ownerRef&&value.ownerRef&&['auth-required','forbidden'].includes(value.status));if(failure){operationEpoch++;notificationEpoch++;authFailure=failure.status;changing=true;workspace.setIdentity(null);notifications.setIdentity(null);changing=false;clearNotificationDraft();feedback='';appliedRevision=null;}syncNotificationDraft(notifications.snapshot().state);const value=snapshot();onChange(value);for(const fn of listeners)fn(value);paint();};
 const workspace=createPrivateWorkspaceClient({fetchImpl,storage,now,timeoutMs,onChange:changed}),notifications=createPrivateNotificationsClient({fetchImpl,storage,now,timeoutMs,onChange:changed});
 // Inbox auto-refresh: a 60 s GET of notification state while the inbox is on screen and idle. It skips perform(), so shown feedback and the operation epoch stay.
 let refreshTimer=null,autoReading=null;
 const hasBox=node=>Boolean(node)&&node.isConnected!==false&&(typeof node.getClientRects!=='function'||node.getClientRects().length>0),inboxOnScreen=()=>globalThis.document?.visibilityState!=='hidden'&&hasBox(root?.querySelector?.('[data-private-inbox]'));
 // A read redraws the element that holds the inbox, so a pressed button or a text selection anywhere in it also waits.
 const personBusy=()=>{const doc=globalThis.document,active=doc?.activeElement,panel=root?.querySelector?.('[data-private-inbox]')?.parentElement,selection=doc?.getSelection?.();return Boolean([...(doc?.querySelectorAll?.('dialog[open]')||[])].some(hasBox)||doc?.querySelector?.('[data-private-inbox] button:active,[data-private-notification-settings] button:active')||panel?.querySelector?.('button:active')||selection&&!selection.isCollapsed&&[selection.anchorNode,selection.focusNode].some(node=>node&&panel?.contains?.(node))||active?.matches?.('button,input,select,textarea,[contenteditable="true"]')&&active.closest?.('[data-private-inbox],[data-private-notification-settings]'));};
 function armRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refreshTick,60000);refreshTimer.unref?.();}
 function refreshTick(){refreshTimer=null;if(disposed||!usable())return;armRefresh();const value=notifications.snapshot();if(!value.canLoad||value.requestId!==null||['loading','saving'].includes(workspace.snapshot().status)||personBusy()||!inboxOnScreen())return;const token={status:value.status};autoReading=token;notifications.load().catch(()=>{}).finally(()=>{if(autoReading===token)autoReading=null;});}
 function identityStatus(){return authFailure||(typeof identity?.ownerRef!=='string'||!/^[A-Za-z0-9:_.@-]{1,128}$/.test(identity.ownerRef)||!Number.isSafeInteger(identity.expiresAt)||identity.expiresAt<=now()?'auth-required':identity.authVersion===2&&identity.permissionProfile===profile?'ready':'upgrade-required');}
 function snapshot(){return {identityStatus:identityStatus(),ownerRef:identity?.ownerRef||null,workspace:workspace.snapshot(),notifications:notifications.snapshot(),feedback,executionAuthority:'NONE'};}
 const usable=()=>identityStatus()==='ready';
 function setIdentity(value){
  if(disposed)return snapshot();const wasUsable=usable();operationEpoch++;changing=true;authFailure=null;
  const next=value?.ownerRef?{ownerRef:value.ownerRef,expiresAt:value.expiresAt,authVersion:value.authVersion,permissionProfile:value.permissionProfile}:null,changedIdentity=JSON.stringify(next)!==JSON.stringify(identity),changedOwner=identity?.ownerRef!==next?.ownerRef;identity=next;
  clearTimeout(identityTimer);identityTimer=null;if(identity?.expiresAt>now()){identityTimer=setTimeout(()=>setIdentity(identity?.expiresAt>now()?identity:null),Math.min(2147483647,identity.expiresAt-now()));identityTimer.unref?.();}
  const verified=usable()?{ownerRef:identity.ownerRef,expiresAt:identity.expiresAt}:null;
  if(changedIdentity||!wasUsable)notificationEpoch++;
  if(changedOwner||!verified){clearNotificationDraft();feedback='';appliedRevision=null;}
  if(!verified){clearTimeout(refreshTimer);refreshTimer=null;}else if(refreshTimer===null)armRefresh();
  workspace.setIdentity(verified);notifications.setIdentity(verified);changing=false;changed();if(verified&&(changedIdentity||!wasUsable)&&notifications.snapshot().requestId===null)void loadNotifications();return snapshot();
 }
 function gate(){const status=identityStatus();return `<p role="status">${status==='forbidden'?L('当前登录未获账户访问权限。','This session cannot access account settings.'):status==='upgrade-required'?L('更新登录后即可使用账户工作区和站内通知。','Update sign-in to use your account workspace and inbox.'):L('登录后读取账户偏好和研究通知。','Sign in to load account preferences and research notices.')}</p>${button('authenticate',identity?.ownerRef?L('更新登录','Update sign-in'):L('登录','Sign in'))}`;}
 function statusText(value){return L(...(labels[value.status]||labels.error));}
 async function perform(fn){if(!usable())return snapshot();const epoch=++operationEpoch;feedback='';try{await fn(epoch);}catch{if(epoch===operationEpoch&&!disposed)feedback=L('操作未完成，请核对当前设置后重试。','Not completed. Check the current settings and retry.');}if(epoch===operationEpoch&&!disposed)changed();return snapshot();}
 const loadWorkspace=()=>perform(async()=>{workspaceAction='load';await workspace.load();});
 const saveWorkspace=()=>perform(async()=>{workspaceAction='save';await workspace.save(getWorkspaceInput());});
 const queryWorkspace=()=>perform(async()=>{workspaceAction='query';await workspace.queryOriginal();});
 const applyWorkspace=()=>perform(async epoch=>{const value=workspace.snapshot();if(value.status!=='ready'||!value.state)throw Error();const result=await applyWorkspaceInput(structuredClone(value.state));if(epoch!==operationEpoch||disposed)return;if(typeof result==='string'&&result)throw Error();appliedRevision=value.state.revision;feedback=L('账户偏好已应用；草稿仅同步名称目录。','Account preferences applied; drafts sync as a name directory.');});
 const loadNotifications=({replaceDraft=false}={})=>perform(async()=>{
  armRefresh();
  const epoch=notificationEpoch,reload=replaceDraft?{edits:notificationDraftEdits}:null;if(reload)notificationReload=reload;
  try{
   await notifications.load();const value=notifications.snapshot();
   if(reload&&epoch===notificationEpoch&&!disposed&&value.status==='ready'&&reload.edits===notificationDraftEdits){syncNotificationDraft(value.state,true);paint();}
  }finally{if(reload&&notificationReload===reload)notificationReload=null;}
 });
 async function refreshConfirmedNotifications(operation,epoch){
  await operation();const value=notifications.snapshot();
  if(epoch===notificationEpoch&&!disposed&&usable()&&value.status==='ready'&&!value.requestId&&value.canLoad){armRefresh();await notifications.load();}
 }
 const saveNotifications=value=>perform(()=>refreshConfirmedNotifications(()=>notifications.save({action:'save',payload:{events:value.events,inapp:value.inapp,enabled:{telegram:false,email:false}}}),notificationEpoch));
 const markNotificationsRead=ids=>perform(async()=>{if(ids.length)await refreshConfirmedNotifications(()=>notifications.save({action:'mark-read',payload:{ids}}),notificationEpoch);});
 const queryNotifications=()=>perform(()=>refreshConfirmedNotifications(()=>notifications.queryOriginal(),notificationEpoch));
 function renderWorkspace(){
  if(!usable())return `<section class="cc-notice-channel"><h4>${L('账户工作区','Account workspace')}</h4>${gate()}</section>`;
  const value=workspace.snapshot(),cloud=value.state;
  const message=value.status==='ready'&&workspaceAction==='save'?L('已保存到当前账户','Saved to this account'):value.status==='ready'&&cloud?.revision===appliedRevision?L('已应用到本机','Applied on this device'):statusText(value);
  let local;try{local=getWorkspaceInput();}catch{}
  return `<section class="cc-notice-channel" data-private-workspace><div class="cc-notice-channel-heading"><h4>${L('账户工作区','Account workspace')}</h4><span role="status">${message}</span></div><p>${L('追踪标的','Tracked assets')} · ${local?.preferences?.watchedAssets?.length||0}</p><div class="cc-notice-actions">${button('workspace-load',L('读取云端','Load cloud'),!value.canLoad)}${cloud?button('workspace-apply',L('应用偏好','Apply preferences'),value.status!=='ready'):''}${button('workspace-save',L('保存当前偏好','Save current preferences'),!value.canSave)}${value.requestId?button('workspace-query',L('查询原请求','Check original request'),!value.canQuery):''}</div>${cloud?.drafts.length?`<details class="cc-private-directory"><summary>${L('云端草稿目录','Cloud draft directory')} · ${cloud.drafts.length}</summary><ul>${cloud.drafts.map(d=>`<li>${typeof onOpenDraft==='function'?`<button class="p-button" type="button" data-private-action="draft-open" data-private-id="${esc(d.id)}">${esc(d.name)} · ${esc(d.strategyId)}</button>`:esc(d.name)+' · '+esc(d.strategyId)}</li>`).join('')}</ul></details>`:''}${feedback?`<p role="status">${esc(feedback)}</p>`:''}</section>`;
 }
 function renderNotificationSettings(){
  if(!usable())return `<section class="cc-notice-channel"><h3>${L('账户通知','Account notifications')}</h3>${gate()}</section>`;
  const value=notifications.snapshot(),state=value.state;
  syncNotificationDraft(state);
  const draft=notificationDraft||{events:['risk','research'],inapp:true};
  return `<div class="cc-notification-service" data-private-notification-settings><div class="cc-heading"><h3>${L('账户通知','Account notifications')}</h3>${button('notifications-load',L('重新读取','Reload cloud'),!value.canLoad)}</div><p role="status">${statusText(value)}</p>${state?`<label class="connection-toggle"><b>${L('站内通知','In-app notices')}</b><input type="checkbox" role="switch" data-private-inapp${draft.inapp?' checked':''}></label><fieldset class="cc-events"><legend>${L('接收内容','What to receive')}</legend>${events.map(([id,zh,en])=>`<label><input type="checkbox" data-private-notice-event="${id}"${draft.events.includes(id)?' checked':''}>${L(zh,en)}</label>`).join('')}</fieldset><div class="cc-notice-actions">${button('notifications-save',L('保存通知偏好','Save notification preferences'),!value.canSave)}${value.requestId?button('notifications-query',L('查询原请求','Check original request'),!value.canQuery):''}</div>`:''}<section class="cc-notice-channel"><div class="cc-notice-channel-heading"><h4>${L('外部推送','External delivery')}</h4><span>${L('尚未启用','Not enabled')}</span></div><div class="cc-notice-actions"><button class="p-button" disabled>Telegram</button><button class="p-button" disabled>${L('邮件','Email')}</button></div></section>${feedback?`<p role="status">${esc(feedback)}</p>`:''}</div>`;
 }
 function renderInbox(){
  if(!usable())return `<section class="ops-notices-empty"><h3>${L('账户通知','Account inbox')}</h3>${gate()}</section>`;
  const value=notifications.snapshot(),state=value.state,unread=state?.inbox.filter(row=>row.readAt===null)||[],shown=autoReading&&state&&value.status==='loading'?autoReading.status:value.status,mark=state?shown==='error'?'stale':state.inbox.length?'list':'empty':['loading','error'].includes(shown)?shown:'idle',busy=['loading','saving'].includes(value.status);
  return (state?.nextCursor?`<p class="ops-field-help">${L('仅显示当前页','Showing the current page')} · ${state.inbox.length}</p>`:'')+`<div data-private-inbox data-inbox-state="${mark}"${busy?' aria-busy="true"':''}><header class="ops-section-heading"><h3>${L('账户通知','Account inbox')}${state?` · ${state.unreadCount} ${L('未读','unread')}`:''}</h3>${button('notifications-load',L('刷新','Refresh'),!value.canLoad)}</header><p class="ops-field-help" role="status">${mark==='stale'?L('暂时无法更新，已保留上次数据','Unable to update; previous data retained'):statusText({status:shown})}${state&&!value.requestId?` \u00b7 ${L('自动刷新：','Auto refresh: ')}60 ${L('秒','seconds')}`:''}</p>${feedback?`<p role="status">${esc(feedback)}</p>`:''}${value.requestId?button('notifications-query',L('查询原请求','Check original request'),!value.canQuery):''}${state?.inbox.length?`<div class="ops-notice-list">${state.inbox.map(row=>`<article class="ops-issue" data-notice-state="${row.readAt===null?'unread':'read'}"><span class="ops-issue-symbol"><b>${row.type==='risk'?L('风险提醒','Risk alert'):L('研究通知','Research notice')}</b><span>${row.readAt===null?L('未读','Unread'):L('已读','Read')}</span></span><h4>${esc(row.title)}</h4>${row.body?`<p>${esc(row.body)}</p>`:''}<time>${esc(new Date(row.createdAt).toLocaleString(localeInfo(getLocale()).tag))}</time>${row.readAt===null?`<button class="p-button" data-private-action="notice-read" data-private-id="${esc(row.id)}"${value.canSave?'':' disabled'}>${L('标为已读','Mark read')}</button>`:''}</article>`).join('')}</div>${unread.length?button('notices-read-page',L('本页标为已读','Mark this page read'),!value.canSave):''}`:state?`<div class="ops-notices-empty"><b>${L('暂无账户通知','No account notices yet')}</b></div>`:''}</div>`;
 }
 function paint(){for(const [node,kind]of mounts){if(node.isConnected===false){mounts.delete(node);continue;}const html=kind==='workspace'?renderWorkspace():kind==='settings'?renderNotificationSettings():renderInbox();if(node._privateHTML!==html){node._privateHTML=html;node.innerHTML=html;}}}
 function mount(node,kind='workspace'){mounts.set(node,kind);paint();if(kind==='settings'&&usable())void loadNotifications();return ()=>mounts.delete(node);}
 function requestAuthentication(){const unhandled=eventTarget?.dispatchEvent(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:profile},cancelable:true}));if(unhandled!==false)root?.querySelector('.header-wallet .wallet-login')?.click();}
 function bind(element){
  unbind();root=element;
  const capture=target=>{const form=target.closest?.('[data-private-notification-settings]');if(form){const next={inapp:Boolean(form.querySelector('[data-private-inapp]')?.checked),events:[...form.querySelectorAll('[data-private-notice-event]:checked')].map(node=>node.dataset.privateNoticeEvent)};if(!samePreferences(next,notificationDraft))notificationDraftEdits++;notificationDraft=next;}};
  const click=event=>{const control=event.target.closest?.('[data-private-action]');if(!control||control.disabled||!root.contains(control))return;const action=control.dataset.privateAction;
   if(action==='draft-open'){const value=workspace.snapshot(),id=control.dataset.privateId;if(usable()&&value.status==='ready'&&value.state?.drafts.some(d=>d.id===id)&&typeof onOpenDraft==='function'){control.closest('dialog')?.close();onOpenDraft(id);}return;}
   if(action==='authenticate'){control.closest('dialog')?.close();requestAuthentication();return;}
   const operations={'workspace-load':loadWorkspace,'workspace-save':saveWorkspace,'workspace-apply':applyWorkspace,'workspace-query':queryWorkspace,'notifications-load':()=>loadNotifications({replaceDraft:true}),'notifications-query':queryNotifications,'notifications-save':()=>{capture(control);return saveNotifications(notificationDraft);},'notice-read':()=>markNotificationsRead([control.dataset.privateId]),'notices-read-page':()=>markNotificationsRead(notifications.snapshot().state?.inbox.filter(row=>row.readAt===null).map(row=>row.id)||[])};
   if(operations[action])void operations[action]();
  };
  const change=event=>capture(event.target);element.addEventListener('click',click);element.addEventListener('change',change);
  unbind=()=>{element.removeEventListener('click',click);element.removeEventListener('change',change);};return unbind;
 }
 return {snapshot,setIdentity,loadWorkspace,saveWorkspace,applyWorkspace,queryWorkspace,loadNotifications,saveNotifications,markNotificationsRead,queryNotifications,requestAuthentication,renderWorkspace,renderNotificationSettings,renderInbox,mount,bind,
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
  researchCompleted(){if(usable()&&root?.querySelector('[data-private-inbox], [data-private-notification-settings]'))void loadNotifications();},
  leave(){operationEpoch++;notificationEpoch++;identity=null;clearTimeout(identityTimer);clearTimeout(refreshTimer);refreshTimer=null;changing=true;workspace.leave();notifications.leave();changing=false;clearNotificationDraft();feedback='';appliedRevision=null;changed();},
  dispose(){if(disposed)return;operationEpoch++;notificationEpoch++;disposed=true;identity=null;clearNotificationDraft();feedback='';clearTimeout(identityTimer);clearTimeout(refreshTimer);refreshTimer=null;unbind();workspace.dispose();notifications.dispose();listeners.clear();mounts.clear();}
 };
}
