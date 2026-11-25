import {createPrivateUIClient,createPrivateDraftClient} from './private-service-client.mjs';
import {researchCredentialDigest,validResearchPrivateLease} from './research-private-store.mjs';
import {createPrivateUIService} from './private-ui-service.mjs';
import {validatePrivateNotificationState,validatePrivateNotificationStateV2,validatePrivateWorkspaceState,validatePrivateUICommandResult,validatePrivateUIWorkspaceInput,validatePrivateUINotificationCommand} from './private-ui-data.mjs';
import {createPrivateDraftService} from './private-draft-service.mjs';
import {validatePrivateDraftPreviewInput,validatePrivateDraftAdoptInput,validatePrivateDraftDocument,validatePrivateDraftPreview,validatePrivateDraftCommandResult} from './private-draft-data.mjs';

const PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=(code,outcomeUnknown=false)=>{throw Object.assign(Error(code),{code,outcomeUnknown});};
function draftReference(input,key,pattern){
 const descriptor=input&&typeof input==='object'&&Object.getOwnPropertyDescriptor(input,key);
 if(!descriptor||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==1||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string'||!pattern.test(descriptor.value))fail('PRIVATE_REQUEST_INVALID');
 return {[key]:descriptor.value};
}

// The only identity input is the outer request's opaque session credential.
// Account preferences grant no model budget, execution or delivery permission.
export function createPrivateUIRuntime({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
 let lease;try{if(typeof env.ASTARTER_RESEARCH_LEASE_JSON==='string'&&env.ASTARTER_RESEARCH_LEASE_JSON.length<=8192)lease=JSON.parse(env.ASTARTER_RESEARCH_LEASE_JSON);}catch{}
 const options={origin:env.ASTARTER_PRIVATE_SERVICE_ORIGIN,token:env.ASTARTER_PRIVATE_RUNTIME_TOKEN,fetchImpl,timeoutMs:5000};
 const base=createPrivateUIClient(options),configured=Boolean(env.ASTARTER_PRIVATE_UI_ENABLED==='1'&&base.configured&&validResearchPrivateLease(lease,now())&&(!env.ASTARTER_PRIVATE_ISSUER_TOKEN||env.ASTARTER_PRIVATE_ISSUER_TOKEN!==env.ASTARTER_PRIVATE_RUNTIME_TOKEN));
 async function authorize(request,permission,clientFactory=createPrivateUIClient){
  if(!configured||!validResearchPrivateLease(lease,now()))fail('PRIVATE_UNCONFIGURED');
  let sessionDigest;try{sessionDigest=researchCredentialDigest(request);}catch{fail('AUTH_REQUIRED');}
  const dal=clientFactory({...options,sessionDigest}),binding={leaseId:lease.leaseId,targetId:lease.targetId,audience:lease.audience};
  // The Core resolver checks the actual lease, PG clock and session without
  // requiring a paid research budget for account preferences.
  const p=await dal.resolveSession({...binding,tokenDigest:sessionDigest,now:now()}),at=now();
  if(!validResearchPrivateLease(lease,at))fail('PRIVATE_UNCONFIGURED');
  if(!p||!integer(at)||!/^wallet:56:0x[0-9a-f]{40}$/.test(p.subjectId)||p.tenantId!==p.subjectId||p.scopeId!==p.tenantId||p.audience!==lease.audience||!integer(p.notBefore)||!integer(p.expiresAt)||p.notBefore>at+5000||p.expiresAt<=at||p.revokedAt!==null)fail('AUTH_REQUIRED');
  if(p.authVersion!==2||p.permissionProfile!=='private-ui-v2'||JSON.stringify(p.permissions)!==JSON.stringify(PERMISSIONS)||!p.permissions.includes(permission))fail('PRIVATE_FORBIDDEN');
  return {dal,binding,owner:p.scopeId};
 }
 async function read(request,method,input,domain,command=false){
  const {dal,binding,owner}=await authorize(request,domain+':read');
  const result=await dal[method]({...binding,...input});
  if(command)return result===null?null:validatePrivateUICommandResult(result,domain,input.requestId,owner);
  return domain==='workspace'?validatePrivateWorkspaceState(result,owner):(input.responseVersion===2?validatePrivateNotificationStateV2:validatePrivateNotificationState)(result,owner);
 }
 async function write(request,method,input,domain){
  const canonical=domain==='workspace'?validatePrivateUIWorkspaceInput(input):validatePrivateUINotificationCommand(input);
  const {dal,binding,owner}=await authorize(request,domain+':write');
  const result=await dal[method]({...binding,...canonical});
  try{
   const verified=validatePrivateUICommandResult(result,domain,canonical.requestId,owner);
   if(verified.request.baseRevision!==canonical.baseRevision)fail('PRIVATE_UI_PROTOCOL');return verified;
  }catch{fail('PRIVATE_COMMIT_UNKNOWN',true);}
 }
 const backend={
  notificationsState:(request,input)=>read(request,'notificationsState',input,'notifications'),
  notificationsCommand:(request,input)=>write(request,'notificationsCommand',input,'notifications'),
  notificationsRequest:(request,input)=>read(request,'notificationsRequest',input,'notifications',true),
  workspaceState:request=>read(request,'workspaceState',{},'workspace'),
  workspaceSave:(request,input)=>write(request,'workspaceSave',input,'workspace'),
  workspaceRequest:(request,input)=>read(request,'workspaceRequest',input,'workspace',true)
 };
 const draftsConfigured=configured&&env.ASTARTER_PRIVATE_DRAFTS_ENABLED==='1';
 async function readDraft(request,method,input){
  const {dal,binding,owner}=await authorize(request,'workspace:read',createPrivateDraftClient),result=await dal[method]({...binding,...input});
  if(method==='draftsGet')return result===null?null:validatePrivateDraftDocument(result,owner);
  if(method==='draftsRequest')return result===null?null:validatePrivateDraftCommandResult(result,input.requestId,owner);
  return validatePrivateDraftPreview(result,owner);
 }
 const draftBackend=draftsConfigured?{
  draftsPreview:(request,input)=>readDraft(request,'draftsPreview',validatePrivateDraftPreviewInput(input)),
  draftsGet:(request,input)=>readDraft(request,'draftsGet',draftReference(input,'draftId',/^[A-Za-z0-9:_-]{1,96}$/)),
  draftsRequest:(request,input)=>readDraft(request,'draftsRequest',draftReference(input,'requestId',/^[A-Za-z0-9:_-]{8,96}$/)),
  async draftsAdopt(request,input){
   const canonical=validatePrivateDraftAdoptInput(input),{dal,binding,owner}=await authorize(request,'workspace:write',createPrivateDraftClient);
   const result=await dal.draftsAdopt({...binding,...canonical});
   try{return validatePrivateDraftCommandResult(result,canonical.requestId,owner);}catch{fail('PRIVATE_COMMIT_UNKNOWN',true);}
  }
 }:undefined;
 return {configured,backend,handle:createPrivateUIService({backend:configured?backend:undefined,now}),draftsConfigured,draftBackend,handleDrafts:createPrivateDraftService({backend:draftBackend})};
}
