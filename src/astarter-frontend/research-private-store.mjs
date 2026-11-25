import {createHash} from 'node:crypto';
import {RESEARCH_MODEL_LIMITS,validateResearchBilling} from './research-analysis-service.mjs';

export const RESEARCH_PRIVATE_CONTRACT='ASTARTER_PRIVATE_RESEARCH_V1';
export const RESEARCH_AUDIENCE='astarter-research';
export const RESEARCH_SESSION_COOKIE='__Host-astarter_session';
export const RESEARCH_PRIVATE_ENV=Object.freeze(['ASTARTER_PRIVATE_SERVICE_ORIGIN','ASTARTER_PRIVATE_RUNTIME_TOKEN','ASTARTER_PRIVATE_ISSUER_TOKEN','ASTARTER_RESEARCH_LEASE_JSON','ASTARTER_RESEARCH_MODEL','ASTARTER_RESEARCH_MODEL_ENABLED','ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED','OPENROUTER_API_KEY']);
const fault=code=>{throw Error(code);};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s);
const sqlId=s=>typeof s==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(s);
const digest=s=>createHash('sha256').update(s).digest('hex');
const ownIdentity=(record,identity)=>record&&record.subjectId===identity.subjectId&&record.scopeId===identity.scopeId&&record.requestId===identity.requestId;
const leaseKeys=['leaseId','targetId','database','schema','runtimeRole','audience','budgetId','model','expiresAt'];
const policyKeys=['id','from','until','tokenLimit','requestLimit'];

// Only one opaque credential is accepted. Browser identity headers are never used.
export function researchCredentialDigest(request){
 const headers=request?.headers||{},authorization=headers.authorization,cookies=headers.cookie;
 if(authorization!==undefined&&typeof authorization!=='string'||cookies!==undefined&&typeof cookies!=='string'||(cookies?.length||0)>8192)fault('AUTH_REQUIRED');
 if(Array.isArray(request?.rawHeaders)&&request.rawHeaders.filter((v,i)=>i%2===0&&String(v).toLowerCase()==='authorization').length>1)fault('AUTH_REQUIRED');
 const matches=(cookies||'').split(';').map(v=>v.trim()).filter(v=>v.split('=')[0]===RESEARCH_SESSION_COOKIE);
 if(matches.length>1||authorization!==undefined&&matches.length)fault('AUTH_REQUIRED');
 const token=authorization!==undefined?/^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(authorization)?.[1]:matches[0]?.slice(RESEARCH_SESSION_COOKIE.length+1);
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(token))fault('AUTH_REQUIRED');
 return digest(token);
}

export function reserveResearchMicrousd(tokens=RESEARCH_MODEL_LIMITS.reservedTokens){
 if(!integer(tokens))fault('BUDGET_UNAVAILABLE');
 const maxPrice=BigInt(Math.max(RESEARCH_MODEL_LIMITS.promptMicrousdPerMillion,RESEARCH_MODEL_LIMITS.completionMicrousdPerMillion));
 const amount=(BigInt(tokens)*maxPrice+999999n)/1000000n;
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))fault('BUDGET_UNAVAILABLE');
 return Number(amount);
}

export function validResearchPrivateLease(lease,at){
 return lease&&leaseKeys.filter(k=>!['expiresAt','database','schema','runtimeRole','audience','model'].includes(k)).every(k=>id(lease[k]))&&sqlId(lease.database)&&sqlId(lease.schema)&&lease.schema!=='public'&&lease.schema!=='q08_research'&&sqlId(lease.runtimeRole)&&lease.audience===RESEARCH_AUDIENCE&&lease.model===RESEARCH_MODEL_LIMITS.model&&integer(lease.expiresAt)&&lease.expiresAt>at;
}
function identity(input){
 if(!input||!id(input.subjectId)||!id(input.scopeId)||typeof input.requestId!=='string'||!/^[A-Za-z0-9:_-]{8,96}$/.test(input.requestId))fault('REQUEST_INVALID');
 // scopeId is the canonical private tenant ID returned by the real session owner.
 return {subjectId:input.subjectId,scopeId:input.scopeId,tenantId:input.scopeId,requestId:input.requestId};
}
function policyValid(p,at,lease){
 if(!p||p.id!==lease.budgetId||!['from','until','tokenLimit','requestLimit','limitMicrousd','fixedServiceMicrousd','heldMicrousd','spentMicrousd','promptMicrousdPerMillion','completionMicrousdPerMillion'].every(k=>integer(p[k]))||p.blocked!==false||p.model!==lease.model||p.requestLimit<1||p.tokenLimit<RESEARCH_MODEL_LIMITS.reservedTokens||p.limitMicrousd<1||p.limitMicrousd>50000000||p.promptMicrousdPerMillion!==RESEARCH_MODEL_LIMITS.promptMicrousdPerMillion||p.completionMicrousdPerMillion!==RESEARCH_MODEL_LIMITS.completionMicrousdPerMillion)return false;
 const date=new Date(at),from=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()),until=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1);
 return p.from===from&&p.until===until&&BigInt(p.fixedServiceMicrousd)+BigInt(p.heldMicrousd)+BigInt(p.spentMicrousd)<=BigInt(p.limitMicrousd);
}
function recordValid(record,owner){
 return ownIdentity(record,owner)&&/^[a-f0-9]{64}$/.test(record.fingerprint)&&['pending','complete','failed','unknown'].includes(record.state)&&integer(record.createdAt)&&integer(record.expiresAt);
}

/**
 * Runtime boundary for the private DAL owned by the backend team. No connections,
 * DDL, token issuance, model dispatch or in-memory persistence are created here.
 *
 * DAL.inspectLease returns {contract,kind:'PRIVATE',...lease,now,policy}; it must
 * read the real database/role/lease within its owner-controlled connection.
 * DAL.resolveSession maps a digest + audience to an already verified session:
 * {subjectId,tenantId,audience,notBefore,expiresAt,revokedAt:null,permissions}.
 * DAL.get/claim/finish always bind tenantId AND subjectId. claim atomically locks
 * the shared monthly USD budget, checks exact policy+lease, reserves tokens/USD,
 * creates the idempotency record and appends audit. finish CASes claimToken.
 * UNKNOWN/pending/expired requests never auto-redispatch or release their holds.
 * Receipt reconciliation is a separate cost-owner capability. Runtime finish
 * holds USD for completed research until that owner settles a provider receipt.
 */
export function createResearchPrivateAdapters({dal,lease,now=Date.now}={}){
 const expected=lease?Object.freeze(Object.fromEntries(leaseKeys.map(k=>[k,lease[k]]))):null;
 const configured=Boolean(dal?.contract===RESEARCH_PRIVATE_CONTRACT&&['inspectLease','resolveSession','get','claim','finish'].every(k=>typeof dal[k]==='function')&&validResearchPrivateLease(expected,now()));
 const principals=new WeakSet();
 async function live(needPolicy=false){
  if(!configured||!validResearchPrivateLease(expected,now()))fault('UNCONFIGURED');
  const actual=await dal.inspectLease({leaseId:expected.leaseId,targetId:expected.targetId,audience:expected.audience});
  if(!actual||actual.contract!==RESEARCH_PRIVATE_CONTRACT||actual.kind!=='PRIVATE'||!integer(actual.now)||Math.abs(actual.now-now())>5000||!leaseKeys.every(k=>actual[k]===expected[k])||actual.expiresAt<=actual.now)fault('PRIVATE_TARGET_MISMATCH');
  if(needPolicy&&!policyValid(actual.policy,actual.now,expected))fault('BUDGET_UNAVAILABLE');
  return actual;
 }
 const ownerArgs=(owner)=>({...owner,leaseId:expected.leaseId,targetId:expected.targetId,audience:expected.audience});
 const store={
  async get(input){
   const owner=identity(input);await live();
   const record=await dal.get(ownerArgs(owner));
   if(record===null)return null;
   if(!recordValid(record,owner))fault('PRIVATE_RECORD_INVALID');
   return structuredClone(record);
  },
  async claim(input){
   const owner=identity(input),current=await live(true),p=current.policy;
   if(!input.policy||!policyKeys.every(k=>input.policy[k]===p[k])||!/^[a-f0-9]{64}$/.test(input.fingerprint)||input.reservedTokens!==RESEARCH_MODEL_LIMITS.reservedTokens||!integer(input.createdAt)||Math.abs(input.createdAt-current.now)>5000||!integer(input.expiresAt)||input.expiresAt<=current.now||input.expiresAt>Math.min(expected.expiresAt,p.until))fault('BUDGET_UNAVAILABLE');
   const reservedMicrousd=reserveResearchMicrousd(input.reservedTokens);
   // DAL checks existing idempotency records before rejecting a new reservation.
   // The snapshot is no lock; only its transaction can enforce the global cap.
   const result=await dal.claim({...ownerArgs(owner),fingerprint:input.fingerprint,createdAt:input.createdAt,expiresAt:input.expiresAt,reservedTokens:input.reservedTokens,reservedMicrousd,policy:{...input.policy,model:p.model,limitMicrousd:p.limitMicrousd,fixedServiceMicrousd:p.fixedServiceMicrousd,promptMicrousdPerMillion:p.promptMicrousdPerMillion,completionMicrousdPerMillion:p.completionMicrousdPerMillion}});
   if(result?.acquired===true&&typeof result.claimToken==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(result.claimToken))return {acquired:true,claimToken:result.claimToken};
   if(result?.acquired===false&&result.code==='BUDGET_EXCEEDED')return {acquired:false,code:'BUDGET_EXCEEDED'};
   if(result?.acquired===false&&recordValid(result.record,owner))return {acquired:false,record:structuredClone(result.record)};
   fault('PRIVATE_RECORD_INVALID');
  },
  async finish(input){
   const owner=identity(input);await live();
   if(typeof input.claimToken!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(input.claimToken)||!['complete','failed','unknown'].includes(input.state))fault('REQUEST_INVALID');
   let providerReceipt=null,settledMicrousd=null;
   if(input.state==='complete'){
    if(!integer(input.settledTokens)||input.settledTokens>RESEARCH_MODEL_LIMITS.reservedTokens||!input.result||input.result.model!==expected.model||input.result.executionAuthority!=='NONE')fault('REQUEST_INVALID');
    providerReceipt=validateResearchBilling(input.result.billing,input.result.responseId,input.result.model);
   }else if(input.state==='failed'){
    if(input.settledTokens!==0||input.result!==undefined)fault('REQUEST_INVALID');
    settledMicrousd=0;
   }else if(input.settledTokens!==null||input.result!==undefined||input.queryOriginalRequest!==true)fault('REQUEST_INVALID');
   const record=await dal.finish({...ownerArgs(owner),claimToken:input.claimToken,state:input.state,settledTokens:input.settledTokens,settledMicrousd,providerReceipt,...(input.result?{result:structuredClone(input.result)}:{}),...(input.error?{error:input.error}:{}),...(input.queryOriginalRequest?{queryOriginalRequest:true}:{})});
   if(!recordValid(record,owner)||record.state!==input.state)fault('PRIVATE_RECORD_INVALID');
   return structuredClone(record);
  }
 };
 return {configured,store,async authorize(request){
  const tokenDigest=researchCredentialDigest(request),current=await live();
  const s=await dal.resolveSession({tokenDigest,audience:expected.audience,leaseId:expected.leaseId,targetId:expected.targetId,now:current.now});
  if(!s||!id(s.subjectId)||!id(s.tenantId)||s.scopeId!==undefined&&s.scopeId!==s.tenantId||s.audience!==expected.audience||!integer(s.notBefore)||!integer(s.expiresAt)||s.notBefore>current.now||s.expiresAt<=current.now||s.revokedAt!==null||!Array.isArray(s.permissions)||!s.permissions.includes('research:analyze'))fault('AUTH_REQUIRED');
  const p=Object.freeze({subjectId:s.subjectId,tenantId:s.tenantId,scopeId:s.tenantId,audience:s.audience,expiresAt:Math.min(s.expiresAt,expected.expiresAt),permissions:Object.freeze(['research:analyze'])});
  principals.add(p);return p;
 },async admission(principal){
  if(!principals.has(principal)||principal.expiresAt<=now())fault('AUTH_REQUIRED');
  const {policy:p}=await live(true);return Object.freeze(Object.fromEntries(policyKeys.map(k=>[k,p[k]])));
 }};
}
