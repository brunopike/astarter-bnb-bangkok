import {randomBytes,createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {createSiweMessage} from 'viem/siwe';
import {isAddress,getAddress,verifyMessage} from 'viem';

const ORIGIN='https://astarter.imstark.site',HOST='astarter.imstark.site',CHAIN=56;
const CHALLENGE_MS=300000,SESSION_MS=7*86400000,MAX_BYTES=16384;
// Issuer records use the database clock; clock tolerance never extends expiry.
const CLOCK_SKEW_MS=5000;
const SESSION_COOKIE='__Host-astarter_session',CHALLENGE_COOKIE='__Host-astarter_challenge';
const PERMISSIONS=['research:analyze'];
const UI_PERMISSIONS=['research:analyze','notifications:read','notifications:write','workspace:read','workspace:write'];
const UI_PROFILE={authVersion:2,permissionProfile:'private-ui-v2'};
const UI_RESOURCE='urn:astarter:permission-profile:private-ui-v2';
const METHODS=['issueChallenge','getChallenge','prepareChallenge','consumeChallenge','issueSession','resolveSession','revokeSession','revokeChallenge'];
const STATEMENT='Sign in to Astarter. This signature does not authorize trades, token approvals or transfers.';
const PUBLIC_ERROR=Symbol('wallet-http-error');
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const plain=value=>value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,[PUBLIC_ERROR]:true});};

function origin(req){
 if(req.headers?.host!==HOST||req.headers.origin!==undefined&&req.headers.origin!==ORIGIN||req.headers['sec-fetch-site']==='cross-site')fail('origin',403);
 if(req.method==='POST'&&req.headers.origin!==ORIGIN)fail('origin',403);
}
function token(req,name){
 const header=req.headers?.cookie;if(header===undefined)return null;
 if(typeof header!=='string'||Buffer.byteLength(header)>8192)fail('invalid-cookie',400);
 const matches=header.split(';').map(value=>value.trim()).filter(value=>value.startsWith(name+'='));
 if(matches.length>1)fail('invalid-cookie',400);
 const value=matches[0]?.slice(name.length+1);return hex(value)?value:null;
}
function cookie(res,name,value,maxAge){
 const previous=res.getHeader('Set-Cookie'),values=Array.isArray(previous)?previous:previous?[previous]:[];
 res.setHeader('Set-Cookie',[...values,`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`]);
}
async function readBody(req){
 if(typeof req.headers['content-type']!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']))fail('invalid-content-type',415);
 const length=req.headers['content-length'];
 if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>MAX_BYTES))fail('body-too-large',413);
 if(length!==undefined&&Number(length)===0)fail('invalid-body');
 let body;
 if(req.body!==undefined){
  if(plain(req.body)){
   let serialized;try{serialized=JSON.stringify(req.body);}catch{fail('invalid-body');}
   if(Buffer.byteLength(serialized)>MAX_BYTES)fail('body-too-large',413);body=req.body;
  }else if(typeof req.body==='string'||Buffer.isBuffer(req.body)){
   const size=Buffer.byteLength(req.body);if(size>MAX_BYTES)fail('body-too-large',413);if(length!==undefined&&Number(length)!==size)fail('invalid-body');try{body=JSON.parse(String(req.body));}catch{fail('invalid-json');}
  }else fail('invalid-body');
 }else{
  const chunks=[];let size=0;
  for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.byteLength;if(size>MAX_BYTES)fail('body-too-large',413);chunks.push(bytes);}
  if(length!==undefined&&Number(length)!==size)fail('invalid-body');
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid-json');}
 }
 if(!plain(body))fail('invalid-body');return body;
}
function profile(record){
 if(!plain(record))return 0;
 const version=Object.hasOwn(record,'authVersion'),name=Object.hasOwn(record,'permissionProfile');
 if(!version&&!name)return 1;return version&&name&&record.authVersion===2&&record.permissionProfile===UI_PROFILE.permissionProfile?2:0;
}
const profileFields=record=>profile(record)===2?{...UI_PROFILE}:{};
const permissionsFor=record=>profile(record)===2?UI_PERMISSIONS:PERMISSIONS;
const sameProfile=(a,b)=>profile(a)>0&&profile(a)===profile(b);
const messageFor=challenge=>createSiweMessage({address:challenge.address,chainId:CHAIN,domain:HOST,uri:ORIGIN,version:'1',nonce:challenge.nonce,issuedAt:new Date(challenge.issuedAt),expirationTime:new Date(challenge.expires),statement:STATEMENT,...(profile(challenge)===2?{resources:[UI_RESOURCE]}:{})});
function challengeValid(record,key,at,prepared=false){
 const version=profile(record);
 if(!integer(at)||!version||!exact(record,['challengeHash','nonce','origin','issuedAt','expires','address','chain','message',...(version===2?['authVersion','permissionProfile']:[])])||record.challengeHash!==key||!hex(record.nonce)||record.origin!==ORIGIN||!integer(record.issuedAt)||record.issuedAt>at+CLOCK_SKEW_MS||record.expires!==record.issuedAt+CHALLENGE_MS||record.expires<=at)return false;
 if(!prepared)return record.address===null&&record.chain===null&&record.message===null||challengeValid(record,key,at,true);
 return typeof record.address==='string'&&isAddress(record.address)&&record.address===getAddress(record.address)&&record.chain===CHAIN&&record.message===messageFor(record);
}
function sessionValid(record,key,at){
 const version=profile(record),permissions=permissionsFor(record);
 return Boolean(integer(at)&&version&&exact(record,['tokenHash','address','chain','origin','subjectId','scopeId','issuedAt','expires','permissions',...(version===2?['authVersion','permissionProfile']:[])])&&record.tokenHash===key&&record.origin===ORIGIN&&typeof record.address==='string'&&isAddress(record.address)&&record.address===getAddress(record.address)&&record.chain===CHAIN&&identity(record.subjectId)&&identity(record.scopeId)&&integer(record.issuedAt)&&record.issuedAt<=at+CLOCK_SKEW_MS&&integer(record.expires)&&record.expires>at&&record.expires<=record.issuedAt+SESSION_MS&&Array.isArray(record.permissions)&&record.permissions.length===permissions.length&&permissions.every((permission,i)=>record.permissions[i]===permission));
}
const publicSession=record=>record?{address:record.address,chain:record.chain,expires:record.expires,...profileFields(record)}:null;
const sessionResponse=record=>({session:publicSession(record),security:record?{address:record.address,method:'siwe',chain:record.chain,expires:record.expires,capabilities:{email:false,totp:false},email:null,totp:null}:null,invitation:null,capabilities:{invitation:false,email:false,totp:false}});

// The asynchronous issuer owns atomic nonce consumption, wallet-to-subject mapping,
// session rotation and revocation. No database, credentials or test verifier is created here.
export function createPrivateWalletAuth({issuer=null,now=Date.now,authVersion=1}={}){
 const configured=Boolean(issuer?.configured===true&&METHODS.every(name=>typeof issuer[name]==='function')&&typeof now==='function'&&[1,2].includes(authVersion));
 async function resolvePrincipal(req){
  if(!configured)return null;
  try{origin(req);const raw=token(req,SESSION_COOKIE);if(!raw)return null;const key=hash(raw),at=now(),record=await issuer.resolveSession({tokenHash:key,now:at});
   return sessionValid(record,key,now())?{subjectId:record.subjectId,scopeId:record.scopeId,expiresAt:record.expires,permissions:[...record.permissions],...profileFields(record)}:null;
  }catch{return null;}
 }
 async function handle(req,res){
  let url;try{url=new URL(req.url,ORIGIN);}catch{return false;}
  if(!url.pathname.startsWith('/api/wallet/'))return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   origin(req);if(url.origin!==ORIGIN)fail('origin',403);if(url.search)fail('invalid-body');
   const route=url.pathname.slice('/api/wallet/'.length),method=route==='session'?'GET':'POST';
   if(!['nonce','message','verify','session','logout','invitation'].includes(route))fail('not-found',404);
   if(req.method!==method){res.setHeader('Allow',method);fail('method-not-allowed',405);}
   if(!configured)fail('wallet-service-unavailable',503);
   const body=req.method==='POST'?await readBody(req):{};
   if(req.method==='GET'&&(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))fail('invalid-body');
   const at=now();if(!integer(at))fail('wallet-service-unavailable',503);
   const rawSession=token(req,SESSION_COOKIE),rawChallenge=token(req,CHALLENGE_COOKIE),sessionHash=rawSession?hash(rawSession):null,challengeHash=rawChallenge?hash(rawChallenge):null;
   let result;
   if(route==='session'){
    const record=sessionHash?await issuer.resolveSession({tokenHash:sessionHash,now:at}):null;
    const valid=sessionValid(record,sessionHash,now());if(rawSession&&!valid)cookie(res,SESSION_COOKIE,'',0);result=sessionResponse(valid?record:null);
   }else if(route==='nonce'){
    if(!exact(body,[]))fail('invalid-body');
    if(challengeHash&&!await issuer.revokeChallenge({challengeHash,now:at}))fail('wallet-service-unavailable',503);
    const issuedAt=now(),raw=random(),record={challengeHash:hash(raw),nonce:random(),origin:ORIGIN,issuedAt,expires:issuedAt+CHALLENGE_MS,address:null,chain:null,message:null,...(authVersion===2?UI_PROFILE:{})};
    const saved=await issuer.issueChallenge(record);
    if(!challengeValid(saved,record.challengeHash,now())||!sameProfile(saved,record)||saved.nonce!==record.nonce||Math.abs(saved.issuedAt-issuedAt)>CLOCK_SKEW_MS)fail('wallet-service-unavailable',503);
    cookie(res,CHALLENGE_COOKIE,raw,CHALLENGE_MS/1000);result={nonce:record.nonce};
   }else if(route==='message'){
    if(!exact(body,['nonce','address','chainId']))fail('invalid-body');
    if(!hex(body.nonce)||typeof body.address!=='string'||!isAddress(body.address)||body.chainId!==CHAIN)fail('invalid-account');
    const record=challengeHash?await issuer.getChallenge({challengeHash,now:at}):null;
    if(!challengeValid(record,challengeHash,now())||record.nonce!==body.nonce)fail('challenge-expired',401);
    const address=getAddress(body.address);
    if(record.address&&record.address!==address){await issuer.revokeChallenge({challengeHash,now:at});fail('challenge-expired',401);}
    const message=messageFor({...record,address});
    const saved=await issuer.prepareChallenge({challengeHash,nonce:record.nonce,address,chain:CHAIN,message,now:now(),...profileFields(record)});
    if(!challengeValid(saved,challengeHash,now(),true)||!sameProfile(saved,record)||saved.address!==address||saved.message!==message)fail('challenge-expired',401);
    result={message};
   }else if(route==='verify'){
    const keys=Object.hasOwn(body,'referralCode')?['message','signature','referralCode']:['message','signature'];
    if(!exact(body,keys)||typeof body.message!=='string'||body.message.length>4096||typeof body.signature!=='string'||body.referralCode!==undefined&&(typeof body.referralCode!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(body.referralCode)))fail('invalid-body');
    const record=challengeHash?await issuer.getChallenge({challengeHash,now:at}):null;
    if(!challengeValid(record,challengeHash,now(),true))fail('challenge-expired',401);
    // This is a DAL atomic consume, before any asynchronous EOA verification.
    const consumed=await issuer.consumeChallenge({challengeHash,nonce:record.nonce,address:record.address,chain:CHAIN,message:record.message,now:now(),...profileFields(record)});
    if(!identity(consumed?.claimToken)||!challengeValid(consumed?.challenge,challengeHash,now(),true)||!sameProfile(consumed.challenge,record)||consumed.challenge.message!==record.message)fail('challenge-expired',401);
    cookie(res,CHALLENGE_COOKIE,'',0);
    if(body.message!==record.message||!/^0x[0-9a-fA-F]{130}$/.test(body.signature))fail('invalid-signature',401);
    let valid=false;try{valid=await verifyMessage({address:record.address,message:record.message,signature:body.signature});}catch{}
    if(!valid)fail('invalid-signature',401);if(record.expires<=now())fail('challenge-expired',401);
    const raw=random(),issuedAt=now(),input={tokenHash:hash(raw),previousTokenHash:sessionHash,challengeHash,claimToken:consumed.claimToken,address:record.address,chain:CHAIN,origin:ORIGIN,issuedAt,expires:issuedAt+SESSION_MS,permissions:[...permissionsFor(record)],...profileFields(record)};
    const saved=await issuer.issueSession(input);
    if(!saved)fail('challenge-expired',401);
    if(record.expires<=now()){await issuer.revokeSession({tokenHash:input.tokenHash,now:now()});fail('challenge-expired',401);}
    if(!sessionValid(saved,input.tokenHash,now())||!sameProfile(saved,record)||saved.address!==record.address||Math.abs(saved.issuedAt-issuedAt)>CLOCK_SKEW_MS||saved.expires!==saved.issuedAt+SESSION_MS){await issuer.revokeSession({tokenHash:input.tokenHash,now:now()});fail('wallet-service-unavailable',503);}
    // A logout can commit while the issue RPC response is in flight. Re-read the
    // durable session before publishing its cookie; a revoked row is never a login.
    const current=await issuer.resolveSession({tokenHash:input.tokenHash,now:now()});
    if(!current){await issuer.revokeSession({tokenHash:input.tokenHash,now:now()});fail('challenge-expired',401);}
    if(!sessionValid(current,input.tokenHash,now())||!sameProfile(current,saved)||JSON.stringify(current.permissions)!==JSON.stringify(saved.permissions)||['address','chain','subjectId','scopeId','issuedAt','expires'].some(key=>current[key]!==saved[key])){await issuer.revokeSession({tokenHash:input.tokenHash,now:now()});fail('wallet-service-unavailable',503);}
    cookie(res,SESSION_COOKIE,raw,SESSION_MS/1000);result={...sessionResponse(saved),referralApplied:null};
   }else if(route==='logout'){
    if(!exact(body,[]))fail('invalid-body');
    const revoked=await Promise.all([sessionHash?issuer.revokeSession({tokenHash:sessionHash,now:at}):true,challengeHash?issuer.revokeChallenge({challengeHash,now:at}):true]);
    if(revoked.some(value=>value!==true))fail('wallet-service-unavailable',503);
    cookie(res,SESSION_COOKIE,'',0);cookie(res,CHALLENGE_COOKIE,'',0);result=sessionResponse(null);
   }else{
    if(!exact(body,[]))fail('invalid-body');fail('invitation-unavailable',503);
   }
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){const known=error?.[PUBLIC_ERROR]===true;res.writeHead(known?error.status:503);res.end(JSON.stringify({error:known?error.message:'wallet-service-unavailable',...(known&&error.message==='invitation-unavailable'?{invitation:null,capabilities:{invitation:false,email:false,totp:false}}:{})}));}
  return true;
 }
 return {configured,handle,resolvePrincipal};
}
