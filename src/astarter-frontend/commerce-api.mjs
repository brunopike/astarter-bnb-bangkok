import {CommerceStore} from './commerce-store.mjs';
import {fileURLToPath} from 'node:url';
const defaultFile=fileURLToPath(new URL('./.goodway/commerce/preview.sqlite',import.meta.url));
let sharedStore;
function requestOrigin(host){
 const name=String(host||'').toLowerCase();
 if(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(name))return `http://${name}`;
 if(/^(?:ipfund\.art|www\.ipfund\.art|dapp\.ipfund\.art|demo\.astarter\.io)(?::\d+)?$/.test(name))return `https://${name.replace(/:\d+$/,'')}`;
 return '';
}
export const getCommerceStore=()=>sharedStore||=new CommerceStore(defaultFile);
export function createCommerceHandler({store=new CommerceStore(defaultFile),autoRun=false}={}){
 if(autoRun){const worker=setInterval(()=>{try{for(const {scope}of store.all("SELECT DISTINCT scope FROM jobs WHERE (status='reserved' AND due<=?) OR (status='unknown' AND created<=?)",store.now(),store.now()-86400000))store.tx(()=>store.reconcile(scope));}catch(error){console.error('Commerce worker:',error.message);}},500);worker.unref();}
 return async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/api/commerce'))return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  try{
   const origin=requestOrigin(req.headers.host||'');if(!origin)throw Object.assign(Error('local-only'),{status:403});
   if(req.headers.origin&&req.headers.origin!==origin)throw Object.assign(Error('origin'),{status:403});
   if(req.method==='POST'&&(!req.headers.origin||req.headers['content-type']?.split(';')[0]!=='application/json'))throw Object.assign(Error('origin-or-content-type'),{status:403});
   const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('astarter_preview='))?.split('=')[1];
   const session=store.session(token);if(session.cookie)res.setHeader('Set-Cookie',`astarter_preview=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
   const scope=req.headers['x-workspace-id']||undefined;let result;
   if(url.pathname==='/api/commerce/state'&&req.method==='GET')result={state:store.snapshot(session.person,scope)};
   else if(url.pathname==='/api/commerce/command'&&req.method==='POST'){
    req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>70000)throw Object.assign(Error('body-too-large'),{status:413});}
    let p;try{p=JSON.parse(body);}catch{throw Object.assign(Error('json'),{status:400});}
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('invalid-command'),{status:400});
    result=store.command(session.person,scope,req.headers['idempotency-key'],p.action,p.payload);
   }else throw Object.assign(Error('not-found'),{status:404});
   res.writeHead(200);res.end(JSON.stringify(result));
  }catch(error){const status=error.status||500;res.writeHead(status);res.end(JSON.stringify({error:status===500?'service-unavailable':error.code||error.message,mode:'simulation-only'}));if(status===500)console.error('Commerce:',error.message);}
  return true;
 };
}
let handler;
export const handleCommerce=(req,res)=>{if(!req.url.startsWith('/api/commerce'))return false;handler||=createCommerceHandler({store:getCommerceStore(),autoRun:true});return handler(req,res);};
