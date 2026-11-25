import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSiweMessage} from 'viem/siwe';
import {isAddress,getAddress,verifyMessage} from 'viem';
import {readBscSpotBalances} from './connection-options.mjs';

export const WALLET_CHAINS=[56];
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('hex');
const fail=(error,status=400)=>{throw Object.assign(Error(error),{status});};
const cookie=(req,name)=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
function requestOrigin(host){
 const name=String(host||'').toLowerCase();
 if(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(name))return `http://${name}`;
 if(name==='ipfund.art'||name==='www.ipfund.art'||name==='astarter.imstark.site')return `https://${name}`;
 return '';
}
export function createWalletAuth({file=fileURLToPath(new URL('./.goodway/wallet/auth.sqlite',import.meta.url)),now=Date.now,verifySignature=verifyMessage}={}){
 if(file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const db=new DatabaseSync(file);
 if(file!==':memory:')chmodSync(file,0o600);
 db.exec('CREATE TABLE IF NOT EXISTS challenges(token TEXT PRIMARY KEY,nonce TEXT NOT NULL,origin TEXT NOT NULL,message TEXT,address TEXT,chain INTEGER,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY,address TEXT NOT NULL,chain INTEGER NOT NULL,expires INTEGER NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS wallet_invitation_codes(address TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS wallet_referrals(invitee TEXT PRIMARY KEY,inviter TEXT NOT NULL,joined_at INTEGER NOT NULL,CHECK(invitee<>inviter));CREATE INDEX IF NOT EXISTS wallet_referrals_inviter ON wallet_referrals(inviter,joined_at)');
 const verifying=new Set();
 const invalidate=token=>{if(token){db.prepare('DELETE FROM challenges WHERE token=?').run(hash(token));verifying.delete(hash(token));}};
 const setCookie=(res,name,value,maxAge,secure)=>{
  const rows=[...(res.getHeader('Set-Cookie')||[])];
  const cookiePath=name==='astarter_wallet'?'/api':'/api/wallet';
  const suffix=`; HttpOnly; SameSite=Strict${secure?'; Secure':''}; Max-Age=`;
  if(name==='astarter_wallet')rows.push(`${name}=; Path=/api/wallet${suffix}0`);
  rows.push(`${name}=${value}; Path=${cookiePath}${suffix}${maxAge}`);
  res.setHeader('Set-Cookie',rows);
 };
 function session(req){
  const sessionToken=cookie(req,'astarter_wallet');
  if(!sessionToken)return null;
  return db.prepare('SELECT address,chain,expires FROM logins WHERE token=? AND expires>? AND chain=56').get(hash(sessionToken),now())||null;
 }
 const invitation=(session,origin)=>{
  const address=session.address.toLowerCase(),code=db.prepare('SELECT code FROM wallet_invitation_codes WHERE address=?').get(address)?.code;
  const joinedCount=db.prepare('SELECT COUNT(*) n FROM wallet_referrals WHERE inviter=?').get(address).n;
  const records=db.prepare('SELECT invitee,joined_at FROM wallet_referrals WHERE inviter=? ORDER BY joined_at DESC,invitee LIMIT 20').all(address).map(row=>({name:row.invitee.slice(0,6)+'…'+row.invitee.slice(-4),joinedAt:row.joined_at}));
  return {address:session.address,url:code?origin+'/?ref='+code:null,joinedCount,records};
 };
 const applyReferral=(address,code)=>{
  if(code===undefined)return null;
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(code))return 'invalid';
  const inviter=db.prepare('SELECT address FROM wallet_invitation_codes WHERE code=?').get(code)?.address;
  if(!inviter)return 'invalid';
  const invitee=address.toLowerCase();if(invitee===inviter)return 'self';
  const result=db.prepare('INSERT OR IGNORE INTO wallet_referrals(invitee,inviter,joined_at) VALUES(?,?,?)').run(invitee,inviter,now());
  return result.changes?'accepted':'already-linked';
 };
 async function handle(req,res){
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/wallet/'))return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  try{
   const host=req.headers.host||'',origin=requestOrigin(host);if(!origin)fail('origin',403);
   const secure=origin.startsWith('https://');
   if(req.headers.origin&&req.headers.origin!==origin)fail('origin',403);
   if(req.method==='POST'&&(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0]!=='application/json'))fail('origin',403);
   db.prepare('DELETE FROM challenges WHERE expires<=?').run(now());db.prepare('DELETE FROM logins WHERE expires<=?').run(now());
   const sessionToken=cookie(req,'astarter_wallet'),challengeToken=cookie(req,'astarter_wallet_challenge');let result;
   let body={};if(req.method==='POST'){
    req.setEncoding('utf8');let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16000)fail('body-too-large',413);}
    try{body=JSON.parse(raw);}catch{fail('invalid-json');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid-body');
   }
   if(url.pathname==='/api/wallet/session'&&req.method==='GET'){
    const s=sessionToken&&db.prepare('SELECT address,chain,expires FROM logins WHERE token=?').get(hash(sessionToken));
    if(s&&sessionToken&&s.chain===56&&s.expires>now())setCookie(res,'astarter_wallet',sessionToken,Math.max(0,Math.floor((s.expires-now())/1000)),secure);
    result={session:s||null,security:s?{address:s.address,method:'siwe',chain:s.chain,expires:s.expires,capabilities:{email:false,totp:false},email:null,totp:null}:null,invitation:s?invitation(s,origin):null};
   }else if(url.pathname==='/api/wallet/invitation'&&req.method==='POST'){
    const s=sessionToken&&db.prepare('SELECT address,chain,expires FROM logins WHERE token=? AND expires>? AND chain=56').get(hash(sessionToken),now());if(!s)fail('sign-in-required',401);
    if(Object.keys(body).length)fail('invalid-body');
    const address=s.address.toLowerCase();
    for(let attempt=0;attempt<3&&!db.prepare('SELECT code FROM wallet_invitation_codes WHERE address=?').get(address);attempt++)db.prepare('INSERT OR IGNORE INTO wallet_invitation_codes(address,code,created_at) VALUES(?,?,?)').run(address,randomBytes(24).toString('base64url'),now());
    const data=invitation(s,origin);if(!data.url)fail('invitation-unavailable',503);result={invitation:data};
   }else if(url.pathname==='/api/wallet/nonce'&&req.method==='POST'){
    invalidate(challengeToken);
    const token=random(),nonce=random();db.prepare('INSERT INTO challenges(token,nonce,origin,expires) VALUES(?,?,?,?)').run(hash(token),nonce,origin,now()+300000);setCookie(res,'astarter_wallet_challenge',token,300,secure);result={nonce};
   }else if(url.pathname==='/api/wallet/message'&&req.method==='POST'){
    const challenge=challengeToken&&db.prepare('SELECT * FROM challenges WHERE token=?').get(hash(challengeToken));
    if(!challenge||challenge.origin!==origin||challenge.nonce!==body.nonce)fail('challenge-expired',401);
    if(typeof body.address!=='string'||!isAddress(body.address)||!WALLET_CHAINS.includes(body.chainId))fail('invalid-account');
    const address=getAddress(body.address),message=createSiweMessage({address,chainId:body.chainId,domain:host,uri:origin,version:'1',nonce:challenge.nonce,issuedAt:new Date(now()),expirationTime:new Date(challenge.expires),statement:'Sign in to Astarter. This signature does not authorize trades, token approvals or transfers.'});
    db.prepare('UPDATE challenges SET message=?,address=?,chain=? WHERE token=?').run(message,address,body.chainId,challenge.token);result={message};
   }else if(url.pathname==='/api/wallet/verify'&&req.method==='POST'){
    const challenge=challengeToken&&db.prepare('SELECT * FROM challenges WHERE token=?').get(hash(challengeToken));
    if(!challenge||challenge.origin!==origin||!challenge.message)fail('challenge-expired',401);
    // Consume before asynchronous verification so concurrent requests cannot reuse a nonce.
    db.prepare('DELETE FROM challenges WHERE token=?').run(challenge.token);
    if(body.message!==challenge.message||typeof body.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(body.signature))fail('invalid-signature',401);
    // shortcut: EOA sign-in only; add EIP-1271 verification before admitting smart-account wallets.
    verifying.add(challenge.token);
    let valid=false;try{valid=await verifySignature({address:challenge.address,message:challenge.message,signature:body.signature});}catch{}
    if(!verifying.delete(challenge.token)||challenge.expires<=now())fail('challenge-expired',401);
    if(!valid)fail('invalid-signature',401);
    const token=random(),expires=now()+7*86400000;let referralApplied;
    db.exec('BEGIN IMMEDIATE');
    try{
     if(sessionToken)db.prepare('DELETE FROM logins WHERE token=?').run(hash(sessionToken));
     db.prepare('INSERT INTO logins VALUES(?,?,?,?)').run(hash(token),challenge.address,challenge.chain,expires);
     referralApplied=applyReferral(challenge.address,body.referralCode);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    setCookie(res,'astarter_wallet',token,7*86400,secure);setCookie(res,'astarter_wallet_challenge','',0,secure);result={session:{address:challenge.address,chain:challenge.chain,expires},referralApplied};
   }else if(url.pathname==='/api/wallet/spot'&&req.method==='GET'){
    const s=session(req);if(!s)fail('sign-in-required',401);
    const book=await readBscSpotBalances(s.address);if(!book)fail('balance-unavailable',502);
    result={usdt:book.usdt,btc:book.btc};
   }else if(url.pathname==='/api/wallet/logout'&&req.method==='POST'){
    if(sessionToken)db.prepare('DELETE FROM logins WHERE token=?').run(hash(sessionToken));
    invalidate(challengeToken);
    setCookie(res,'astarter_wallet','',0,secure);setCookie(res,'astarter_wallet_challenge','',0,secure);result={session:null};
   }else fail('not-found',404);
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){res.writeHead(error.status||500);res.end(JSON.stringify({error:error.status?error.message:'wallet-service-unavailable'}));}
  return true;
 }
 return {handle,session,close:()=>db.close()};
}
let service;
export function handleWalletAuth(req,res){if(!req.url.startsWith('/api/wallet/'))return false;service||=createWalletAuth();return service.handle(req,res);}
export function readWalletSession(req){try{service||=createWalletAuth();return service.session(req);}catch{return null;}}
