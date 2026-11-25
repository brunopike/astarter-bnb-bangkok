import {strategyById} from './strategy-catalog.mjs';
import {sameWatchAssetKey} from './market-watchlist.mjs';

const INPUT='PRIVATE_REQUEST_INVALID',OUTPUT='PRIVATE_UI_PROTOCOL';
const EVENTS=['orders','risk','research'],CHANNELS=['telegram','email'];
const SECRET=/\bBearer\s+[A-Za-z0-9._-]{16,}|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@|\b0x[0-9a-fA-F]{64}\b/;
const fail=code=>{throw Object.assign(Error(code),{code,status:code===INPUT?400:502});};
const check=(condition,code)=>{if(!condition)fail(code);};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const milliseconds=value=>integer(value)&&value<=253402300799999;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9:._-]{1,128}$/.test(value)&&!SECRET.test(value);
const draftId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,96}$/.test(value)&&!SECRET.test(value);
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{8,96}$/.test(value)&&!SECRET.test(value);
const text=(value,max,empty=false)=>typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0)&&!/[\u0000-\u001f\u007f]/.test(value)&&!SECRET.test(value)&&(!value.isWellFormed||value.isWellFormed());
const watchKey=value=>sameWatchAssetKey(value,value)&&!SECRET.test(value.startsWith('ca:')?value.split(':')[1]:value);
function exact(value,keys,code){
 check(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 check(own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable),code);
}
function list(value,max,code){
 check(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length<=max,code);
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 check(keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(?:0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&Object.hasOwn(descriptors[key],'value')),code);
}
function eventList(value,code,canonical=false){
 list(value,3,code);check(value.every(event=>EVENTS.includes(event))&&new Set(value).size===value.length,code);
 const ordered=EVENTS.filter(event=>value.includes(event));if(canonical)check(JSON.stringify(value)===JSON.stringify(ordered),code);return ordered;
}
function workspaceFields(value,code){
 const p=value.preferences;exact(p,['workbenchFilter','workbenchFocusAsset','watchedAssets'],code);
 check(['all','scan','tracked'].includes(p.workbenchFilter)&&(p.workbenchFocusAsset===null||typeof p.workbenchFocusAsset==='string'&&/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(p.workbenchFocusAsset)),code);
 list(p.watchedAssets,200,code);check(p.watchedAssets.every(watchKey)&&new Set(p.watchedAssets).size===p.watchedAssets.length,code);
 list(value.drafts,50,code);const ids=new Set();
 for(const draft of value.drafts){
  exact(draft,['id','strategyId','name'],code);check(draftId(draft.id)&&Boolean(strategyById(draft.strategyId))&&text(draft.name,120)&&!ids.has(draft.id),code);ids.add(draft.id);
 }
 check(value.selectedDraftId===null||ids.has(value.selectedDraftId),code);
 return {preferences:structuredClone(p),drafts:structuredClone(value.drafts),selectedDraftId:value.selectedDraftId};
}
function scope(value,owner,code){check(identifier(value)&&value.length<=128&&(owner===undefined||value===owner),code);}
function bounded(value,max,code){check(new TextEncoder().encode(JSON.stringify(value)).byteLength<=max,code);return value;}

export function validatePrivateUIWorkspaceInput(value){
 exact(value,['requestId','baseRevision','preferences','drafts','selectedDraftId'],INPUT);check(requestId(value.requestId)&&integer(value.baseRevision),INPUT);
 return bounded({requestId:value.requestId,baseRevision:value.baseRevision,...workspaceFields(value,INPUT)},16384,INPUT);
}
export function validatePrivateUINotificationCommand(value){
 exact(value,['requestId','baseRevision','action','payload'],INPUT);check(requestId(value.requestId)&&integer(value.baseRevision),INPUT);
 let payload;
 if(value.action==='save'){
  exact(value.payload,['events','enabled','inapp'],INPUT);exact(value.payload.enabled,CHANNELS,INPUT);
  check(CHANNELS.every(channel=>value.payload.enabled[channel]===false)&&typeof value.payload.inapp==='boolean',INPUT);
  payload={events:eventList(value.payload.events,INPUT),enabled:{telegram:false,email:false},inapp:value.payload.inapp};
 }else{
  check(value.action==='mark-read',INPUT);exact(value.payload,['ids'],INPUT);list(value.payload.ids,50,INPUT);
  check(value.payload.ids.length>0&&value.payload.ids.every(identifier)&&new Set(value.payload.ids).size===value.payload.ids.length,INPUT);payload={ids:[...value.payload.ids].sort()};
 }
 return bounded({requestId:value.requestId,baseRevision:value.baseRevision,action:value.action,payload},16384,INPUT);
}
export function validatePrivateWorkspaceState(value,ownerRef){
 exact(value,['schema','scope','revision','updatedAt','preferences','drafts','selectedDraftId','executionAuthority'],OUTPUT);
 check(value.schema==='private-workspace-v1'&&integer(value.revision)&&milliseconds(value.updatedAt)&&value.executionAuthority==='NONE',OUTPUT);scope(value.scope,ownerRef,OUTPUT);
 return bounded({schema:value.schema,scope:value.scope,revision:value.revision,updatedAt:value.updatedAt,...workspaceFields(value,OUTPUT),executionAuthority:'NONE'},65536,OUTPUT);
}
export const validatePrivateNotificationState=(value,ownerRef)=>notificationState(value,ownerRef,1);
export const validatePrivateNotificationStateV2=(value,ownerRef)=>notificationState(value,ownerRef,2);
function notificationState(value,ownerRef,version){
 exact(value,['schema','scope','revision','updatedAt','inapp','events','services','channels','deliveries','inbox','unreadCount','nextCursor','mode',...(version===2?['reminderUnreadCount']:[])],OUTPUT);
 check(value.schema==='private-notifications-v'+version&&value.mode==='server-research-only'&&integer(value.revision)&&milliseconds(value.updatedAt)&&typeof value.inapp==='boolean',OUTPUT);scope(value.scope,ownerRef,OUTPUT);
 const events=eventList(value.events,OUTPUT,true);exact(value.services,CHANNELS,OUTPUT);exact(value.channels,CHANNELS,OUTPUT);
 for(const channel of CHANNELS){
  const service=value.services[channel],binding=value.channels[channel];exact(service,['available','error'],OUTPUT);exact(binding,['channel','label','enabled','verified'],OUTPUT);
  check(typeof service.available==='boolean'&&(service.error===null||text(service.error,80))&&binding.channel===channel&&text(binding.label,160,true)&&[0,1].includes(binding.enabled)&&milliseconds(binding.verified),OUTPUT);
  check(!binding.enabled||service.available&&binding.verified>0,OUTPUT);
  check(service.available===false&&service.error==='CHANNEL_DISABLED'&&binding.label===''&&binding.enabled===0&&binding.verified===0,OUTPUT);
 }
 list(value.deliveries,20,OUTPUT);const deliveries=new Set();
 check(value.deliveries.length===0,OUTPUT);
 for(const d of value.deliveries){
  exact(d,['id','channel','title','status','error','created','updated'],OUTPUT);
  check(identifier(d.id)&&!deliveries.has(d.id)&&CHANNELS.includes(d.channel)&&text(d.title,160)&&['queued','sending','retry','accepted','sent','delivered','failed','unknown','cancelled'].includes(d.status)&&text(d.error,120,true)&&milliseconds(d.created)&&milliseconds(d.updated)&&d.updated>=d.created,OUTPUT);deliveries.add(d.id);
 }
 list(value.inbox,50,OUTPUT);const ids=new Set();let unread=0;
 for(const row of value.inbox){
  exact(row,['id','type','title','body','source','requestId','createdAt','readAt','executionAuthority'],OUTPUT);
  check(identifier(row.id)&&!ids.has(row.id)&&['research','risk'].includes(row.type)&&text(row.title,160)&&text(row.body,1200)&&row.source==='server-research'&&requestId(row.requestId)&&milliseconds(row.createdAt)&&(row.readAt===null||milliseconds(row.readAt)&&row.readAt>=row.createdAt)&&row.executionAuthority==='NONE',OUTPUT);ids.add(row.id);if(row.readAt===null)unread++;
 }
 check(integer(value.unreadCount)&&value.unreadCount>=unread&&(value.nextCursor===null||typeof value.nextCursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor)),OUTPUT);
 if(version===2){
  check(integer(value.reminderUnreadCount)&&value.reminderUnreadCount<=value.unreadCount,OUTPUT);
  const eligible=value.inapp?value.inbox.filter(row=>row.readAt===null&&events.includes(row.type)).length:0;
  check(value.reminderUnreadCount>=eligible&&(value.inapp&&events.some(type=>['research','risk'].includes(type))||value.reminderUnreadCount===0),OUTPUT);
  if(value.inapp&&['research','risk'].every(type=>events.includes(type)))check(value.reminderUnreadCount===value.unreadCount,OUTPUT);
 }
 return bounded({...structuredClone(value),events},65536,OUTPUT);
}
export function validatePrivateUICommandResult(value,domain,id,ownerRef){
 check(['notifications','workspace'].includes(domain)&&requestId(id),OUTPUT);exact(value,['request','state'],OUTPUT);
 const r=value.request;exact(r,['schema','domain','requestId','status','baseRevision','revision','appliedAt'],OUTPUT);
 check(r.schema==='private-ui-command-v1'&&r.domain===domain&&r.requestId===id&&r.status==='applied'&&integer(r.baseRevision)&&integer(r.revision)&&r.revision>=r.baseRevision&&milliseconds(r.appliedAt),OUTPUT);
 const state=domain==='workspace'?validatePrivateWorkspaceState(value.state,ownerRef):validatePrivateNotificationState(value.state,ownerRef);
 check(state.revision===r.revision&&state.updatedAt<=r.appliedAt,OUTPUT);
 return bounded({request:structuredClone(r),state},65536,OUTPUT);
}
