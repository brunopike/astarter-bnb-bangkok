import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {appendFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readWalletSession} from './wallet-auth.mjs';
import {strategyPlan} from './strategy-execution-data.mjs';
import {createMemoryFeedbackStore} from './memory-feedback-store.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const API='https://api.livingbrain.com';
const MARKETS=new Set(['cex-spot','cex-perp','dex-spot','dex-perp','dex-lp','tradfi']);
const STRATEGIES=['S00','S01','S02','S03','S04','S05','S06','S07','S08','S09-A','S09-L','RX01','RX02-P','RX02-A','RX03-S','RX03-B','RX04','RX05'];
const TRADFI=new Set(['SPX','NDX','XAU','DXY','US10Y']);

let envLoaded=false;
export function loadLivingBrainEnv(){
 if(envLoaded)return;
 envLoaded=true;
 const file=process.env.LIVING_BRAIN_ENV||path.join(root,'.env.living-brain');
 let text='';
 try{text=readFileSync(file,'utf8');}catch{return;}
 for(const line of text.split('\n')){
  const trimmed=line.trim();
  if(!trimmed||trimmed.startsWith('#')||!trimmed.includes('='))continue;
  const i=trimmed.indexOf('=');
  const key=trimmed.slice(0,i),value=trimmed.slice(i+1);
  if(process.env[key]===undefined)process.env[key]=value;
 }
}
export function livingBrainConfigured(){
 loadLivingBrainEnv();
 return Boolean(process.env.LIVING_BRAIN_API_KEY&&process.env.LIVING_BRAIN_SUBJECT_ID&&process.env.LIVING_BRAIN_BRAIN_ID);
}
export function userKey(address){
 return createHash('sha256').update(String(address||'').toLowerCase()).digest('hex').slice(0,16);
}
export function redactMemoryText(value){
 return String(value??'')
  .replace(/lbk_[A-Za-z0-9_-]+/g,'')
  .replace(/0x[a-fA-F0-9]{40}/g,'')
  .replace(/\b\d{11,}\b/g,'')
  .slice(0,4000);
}
export function marketTypeOf(input,instrument){
 const market=String(input||'');
 if(MARKETS.has(market))return market;
 const symbol=String(instrument||'').split('/')[0].toUpperCase();
 if(TRADFI.has(symbol)||(!String(instrument||'').includes('/')&&symbol))return 'tradfi';
 return '';
}

async function livingBrain(pathname,{method='GET',body}={}){
 loadLivingBrainEnv();
 if(!livingBrainConfigured())throw Error('living-brain-unconfigured');
 const response=await fetch(API+pathname,{
  method,
  headers:{
   Accept:'application/json',
   'x-api-key':process.env.LIVING_BRAIN_API_KEY,
   'x-subject-id':process.env.LIVING_BRAIN_SUBJECT_ID,
   ...(body?{'Content-Type':'application/json'}:{})
  },
  body:body?JSON.stringify(body):undefined
 });
 const text=await response.text();
 let data=null;
 if(text){try{data=JSON.parse(text);}catch{data={message:text.slice(0,180)};}}
 if(!response.ok){
  const error=Error(data?.message||'living-brain-failed');
  error.status=response.status;
  throw error;
 }
 return data;
}
function brainPath(suffix=''){loadLivingBrainEnv();return `/v1/brains/${process.env.LIVING_BRAIN_BRAIN_ID}${suffix}`;}

export async function updateBrainProfile(){
 return livingBrain(brainPath('/profile'),{method:'PATCH',body:{
  whoTheyAre:'Astarter shared memory for 18 strategies',
  whatTheyDo:'Record saved plans on spot, perpetual, on-chain and TradFi outlets',
  focus:'Parameter iteration from repeated choices',
  goals:'Shared strategy rules and lessons separated by market type',
  currentProjects:STRATEGIES.join(' '),
  vaultOrganization:'strategy pages in projects, user plan and decision pages in notes, lessons in ideas',
  directives:{custom:'Terms are strategy ids. User plans are raw material for the next parameter iteration. A wallet address and BINANCE-SPOT are not the brain subject. Memory never places an order.'}
 }});
}
export async function captureBatch(items){
 return livingBrain(brainPath('/captures/batch'),{method:'POST',body:{items}});
}
export function runBrief(){return livingBrain(brainPath('/brief'),{method:'POST'});}
export function archivePage(slug){return livingBrain(brainPath(`/pages/${encodeURIComponent(slug)}/archive`),{method:'POST'});}
export function pageVersions(slug){return livingBrain(brainPath(`/pages/${encodeURIComponent(slug)}/versions`));}
export async function listPages(query=''){
 const data=await livingBrain(brainPath('/pages'+(query?`?${query}`:'')));
 return Array.isArray(data)?data:data?.items||[];
}
export async function ensureWebhook(){
 loadLivingBrainEnv();
 const url='https://ipfund.art/api/memory/webhook';
 const existing=await livingBrain('/v1/webhooks');
 const rows=Array.isArray(existing)?existing:existing?.items||[];
 if(rows.some(row=>row.url===url&&row.active!==false))return {created:false};
 if(!process.env.LIVING_BRAIN_WEBHOOK_SECRET)process.env.LIVING_BRAIN_WEBHOOK_SECRET=randomBytes(24).toString('hex');
 await livingBrain('/v1/webhooks',{method:'POST',body:{url,events:['brain.page.updated'],secret:process.env.LIVING_BRAIN_WEBHOOK_SECRET}});
 return {created:true,secret:process.env.LIVING_BRAIN_WEBHOOK_SECRET};
}

function json(res,status,body){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
 res.end(body===undefined?'':JSON.stringify(body));
}
function readBody(req){
 return new Promise((resolve,reject)=>{
  const chunks=[];
  req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>resolve(Buffer.concat(chunks)));
  req.on('error',reject);
 });
}
function sessionUser(req){
 const session=readWalletSession(req);
 if(!session?.address)return null;
 return {key:userKey(session.address)};
}
function originOf(page){
 const body=String(page?.body||'');
 const line=body.split('\n').find(row=>row.startsWith('originRef: '));
 return line?line.slice('originRef: '.length).trim():'';
}
function pageView(page){
 const originRef=originOf(page);
 const marketType=(originRef.split(':')[2]&&originRef.startsWith('lesson:'))?originRef.split(':')[2]:(String(page.body||'').match(/^市场类型: (.+)$/m)||[])[1]||'';
 return {title:redactMemoryText(page.title||''),body:redactMemoryText(page.body||''),status:page.status||'active',originRef,marketType,slug:page.slug||''};
}
async function pagesFor(query){
 const found=await livingBrain(brainPath('/search'),{method:'POST',body:{query,topK:8,minSimilarity:0.2}});
 const rows=Array.isArray(found)?found:[];
 const pages=[];
 for(const row of rows){
  if(!row?.slug)continue;
  try{pages.push(await livingBrain(brainPath('/pages/'+encodeURIComponent(row.slug))));}catch{/* a missing page is skipped */}
 }
 return pages.map(pageView);
}

let sharedFeedbackStore;
function feedbackStore(){
 if(!sharedFeedbackStore)sharedFeedbackStore=createMemoryFeedbackStore();
 return sharedFeedbackStore;
}
function feedbackNumber(value,min,max,fallback){
 if(value==null||value==='')return fallback;
 const number=Number(value);
 return Number.isFinite(number)?Math.min(max,Math.max(min,number)):fallback;
}
export async function collectMemoryFeedback(user,input={},deps={}){
 const query=redactMemoryText(input.query).trim().slice(0,200);
 if(!query)return {status:400,body:{error:'query-required'}};
 const client=Object.hasOwn(deps,'client')?deps.client:livingBrain;
 if(!client)return {status:200,body:{saved:false,memory:false,results:[]}};
 const topK=Math.round(feedbackNumber(input.topK,1,8,5));
 const minSimilarity=feedbackNumber(input.minSimilarity,0,1,0.35);
 let search;
 try{search=await client(brainPath('/search'),{method:'POST',body:{query,topK,minSimilarity}});}
 catch{return {status:200,body:{saved:false,memory:false,results:[]}};}
 const rows=Array.isArray(search)?search:[];
 const store=deps.store||feedbackStore();
 const results=[];
 for(const row of rows){
  if(!row?.slug)continue;
  let page;
  try{page=await client(brainPath('/pages/'+encodeURIComponent(row.slug)));}
  catch{continue;}
  if(!page)continue;
  const origins=new Set([page.originRef,...String(page.body||'').split('\n')
   .filter(line=>line.startsWith('originRef: ')).map(line=>line.slice('originRef: '.length).trim())].filter(Boolean));
  if(origins.size!==1)continue;
  const [originRef]=origins;
  if(typeof originRef!=='string'||!(originRef.startsWith('strategy:')||originRef.startsWith('lesson:')||originRef.startsWith(`user:${user.key}:`)))continue;
  const view=pageView(page);
  const record={pageId:String(row.pageId||''),slug:row.slug,title:view.title,summary:redactMemoryText(row.summary||''),pageType:String(row.pageType||''),status:row.status||view.status,similarity:row.similarity,matchedOn:String(row.matchedOn||''),originRef,body:view.body};
  store.save({requester:user.key,kind:'page',query,slug:row.slug,payload:record});
  results.push(record);
 }
 const id=store.save({requester:user.key,kind:'search',query,slug:'',payload:results.map(({body,...hit})=>hit)});
 return {status:200,body:{saved:true,memory:true,id,query,results}};
}

export async function handleMemory(req,res,feedback={}){
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/api/memory/webhook'&&req.method==='POST')return verifyWebhook(req,res);
 if(url.pathname==='/api/memory/feedback'||url.pathname==='/api/memory/feedback/log'||url.pathname==='/api/memory/records')return feedbackRoute(url,req,res,feedback);
 if(url.pathname!=='/api/memory/plan'&&url.pathname!=='/api/memory/context')return false;
 const user=sessionUser(req);
 if(!user){json(res,401,{error:'sign-in-required'});return true;}
 if(url.pathname==='/api/memory/context'&&req.method==='GET')return readContext(url,res,user);
 if(url.pathname==='/api/memory/plan'&&req.method==='POST')return writePlan(req,res,user);
 json(res,405,{error:'method-not-allowed'});
 return true;
}
async function feedbackRoute(url,req,res,deps){
 const user=(deps.sessionUser||sessionUser)(req);
 if(!user){json(res,401,{error:'sign-in-required'});return true;}
 if(url.pathname==='/api/memory/records'){
  if(req.method!=='GET'){json(res,405,{error:'method-not-allowed'});return true;}
  const records=(deps.store||feedbackStore()).all(user.key);
  json(res,200,{total:records.length,records});
  return true;
 }
 if(url.pathname==='/api/memory/feedback/log'){
  if(req.method!=='GET'){json(res,405,{error:'method-not-allowed'});return true;}
  const limit=Math.round(feedbackNumber(url.searchParams.get('limit'),1,50,20));
  json(res,200,{records:(deps.store||feedbackStore()).list(user.key,limit)});
  return true;
 }
 if(req.method!=='GET'&&req.method!=='POST'){json(res,405,{error:'method-not-allowed'});return true;}
 let input={query:url.searchParams.get('query')||'',topK:url.searchParams.get('topK'),minSimilarity:url.searchParams.get('minSimilarity')};
 if(req.method==='POST'){
  let body={};
  try{body=JSON.parse((await readBody(req)).toString('utf8')||'{}');}catch{json(res,400,{error:'invalid-json'});return true;}
  input={...input,...body};
 }
 const outcome=await collectMemoryFeedback(user,input,deps);
 json(res,outcome.status,outcome.body);
 return true;
}

async function readContext(url,res,user){
 const strategy=url.searchParams.get('strategy')||'';
 const market=url.searchParams.get('market')||'';
 const empty={rules:[],lessons:[],choices:[]};
 if(!STRATEGIES.includes(strategy)){json(res,200,empty);return true;}
 if(!livingBrainConfigured()){json(res,200,empty);return true;}
 try{
  await livingBrain(brainPath('/index?limit=40'));
  const shared=await pagesFor(`strategy:${strategy}`);
  const lessons=await pagesFor(`lesson:${strategy}`);
  const found=await pagesFor(strategy);
  const prefix=`user:${user.key}:`;
  const choices=found.filter(page=>page.originRef.startsWith(prefix+'plan:')||page.originRef.startsWith(prefix+'decision:'));
  const rules=shared.filter(page=>page.originRef.startsWith('strategy:')&&!page.originRef.startsWith('user:'));
  const lessonPages=lessons.filter(page=>page.originRef.startsWith('lesson:')&&(!market||!page.marketType||page.marketType===market));
  json(res,200,{
   rules:rules.map(markAgainstCode(strategy)),
   lessons:lessonPages,
   choices:choices.filter(page=>!page.originRef.startsWith('user:')||page.originRef.startsWith(prefix))
  });
 }catch{json(res,200,empty);}
 return true;
}
function markAgainstCode(strategy){
 const plan=strategyPlan(strategy);
 const code=plan?String(plan.entry?.[0]||''):'';
 return page=>{
  const differs=Boolean(code&&page.body&&!page.body.includes(code.slice(0,24)));
  return {...page,codeRule:differs};
 };
}

async function writePlan(req,res,user){
 const raw=await readBody(req);
 let input={};
 try{input=JSON.parse(raw.toString('utf8')||'{}');}catch{json(res,400,{error:'invalid-json'});return true;}
 const strategy=String(input.strategyId||'');
 const marketType=marketTypeOf(input.marketType,input.instrument);
 const venue=redactMemoryText(input.venue).trim();
 const instrument=redactMemoryText(input.instrument).trim();
 if(!STRATEGIES.includes(strategy)||!marketType||!venue||!instrument){res.writeHead(204);res.end();return true;}
 if(!livingBrainConfigured()){json(res,200,{saved:true,memory:false});return true;}
 const version=String(input.version||'1').replace(/[^A-Za-z0-9._-]/g,'').slice(0,40)||'1';
 const planId=String(input.planId||strategy).replace(/[^A-Za-z0-9:_-]/g,'').slice(0,80)||strategy;
 const parameters=(Array.isArray(input.parameters)?input.parameters:[]).map(name=>String(name)).filter(name=>/^[a-z0-9_]{1,40}$/.test(name)).slice(0,40);
 const amount=Number(input.amount),cap=Number(input.cap);
 const planOrigin=`user:${user.key}:plan:${planId}:${version}`;
 const decisionOrigin=`user:${user.key}:decision:${planId}:${version}`;
 const facts=[
  `策略编号: ${strategy}`,
  `市场类型: ${marketType}`,
  `交易平台: ${venue}`,
  `交易标的: ${instrument}`,
  `金额: ${Number.isFinite(amount)?amount:''}`,
  `上限: ${Number.isFinite(cap)?cap:''}`,
  `参数名: ${parameters.join(', ')}`
 ];
 const changed=redactMemoryText(input.changed)||`金额 ${facts[4].slice(4)}；上限 ${facts[5].slice(4)}；参数 ${parameters.join(', ')}`;
 const why=redactMemoryText(input.why)||`保存在 ${marketType} ${venue} ${instrument}`;
 const rejected=redactMemoryText(input.rejected)||'没有发送交易所订单';
 try{
  await captureBatch([
   {kind:'integration',bucket:'notes',label:`${strategy} ${marketType} ${instrument}`,originRef:planOrigin,content:[...facts,`originRef: ${planOrigin}`].join('\n')},
   {kind:'note',bucket:'notes',label:`${strategy} decision`,originRef:decisionOrigin,content:[`改了什么: ${changed}`,`为什么: ${why}`,`否决了什么: ${rejected}`,`originRef: ${decisionOrigin}`].join('\n')}
  ]);
  json(res,202,{saved:true,memory:true});
 }catch{json(res,200,{saved:true,memory:false});}
 return true;
}

function signatureMatches(secret,body,header){
 const given=String(header||'').replace(/^sha256=/,'');
 const hex=createHmac('sha256',secret).update(body).digest('hex');
 const b64=createHmac('sha256',secret).update(body).digest('base64');
 const match=candidate=>candidate.length===given.length&&timingSafeEqual(Buffer.from(candidate),Buffer.from(given));
 return match(hex)||match(b64);
}
async function verifyWebhook(req,res){
 loadLivingBrainEnv();
 const body=await readBody(req);
 const secret=process.env.LIVING_BRAIN_WEBHOOK_SECRET||'';
 if(!secret||!signatureMatches(secret,body,req.headers['x-brain-signature'])){json(res,401,{error:'invalid-signature'});return true;}
 let event={};
 try{event=JSON.parse(body.toString('utf8')||'{}');}catch{json(res,400,{error:'invalid-json'});return true;}
 if(event.type==='brain.page.updated'||event.event==='brain.page.updated'){
  const file=process.env.ASTARTER_MEMORY_LOG||path.join(homedir(),'.config/astarter/memory-webhook.jsonl');
  await mkdir(path.dirname(file),{recursive:true});
  await appendFile(file,JSON.stringify({at:new Date().toISOString(),event:'brain.page.updated',pageId:event.pageId||event.page?.id||null})+'\n');
 }
 json(res,200,{ok:true});
 return true;
}

export const STRATEGY_IDS=STRATEGIES;
