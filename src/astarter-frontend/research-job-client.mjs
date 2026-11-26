import {crossMarketSource} from './cross-market-data.mjs';
import {ASSETS} from './product-data.mjs';
import {candleRequest} from './trading-chart-data.mjs';
import {pair as L} from './locale.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const MODEL='openai/gpt-4.1-mini',MISSING=['depth','macro','social','chain','risk'];
const REQUEST=/^[A-Za-z0-9:_-]{8,96}$/,PREFIX='/api/research',STORAGE='astarter.research-job.v1:';
const assets=new Map(ASSETS.map(([symbol,,domain])=>[symbol,{domain,request:candleRequest(domain==='Crypto'?{market:symbol+'/USDT',period:'1D'}:{market:symbol,period:'1D',profileId:'public-market',venueId:'yahoo'})}]));
const codes=new Set(['UNCONFIGURED','AUTH_REQUIRED','SCOPE_EXPIRED','REQUEST_INVALID','REQUEST_CONFLICT','REQUEST_NOT_FOUND','BUDGET_EXCEEDED','BUDGET_UNAVAILABLE','EVIDENCE_UNAVAILABLE','EVIDENCE_INVALID','EVIDENCE_EXPIRED','MODEL_UNAVAILABLE','MODEL_INVALID_RESPONSE','MODEL_TIMEOUT','REQUEST_PENDING','OUTCOME_UNKNOWN','BODY_TOO_LARGE','JSON_REQUIRED','ORIGIN_DENIED','METHOD_NOT_ALLOWED','SERVICE_UNAVAILABLE']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const text=(value,max=160)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const check=value=>{if(!value)throw Error('RESEARCH_RESPONSE_INVALID');};
const selection=value=>{
 if(!Array.isArray(value)||!value.length||value.length>8||new Set(value).size!==value.length||value.some(symbol=>!assets.has(symbol)))throw Error('RESEARCH_SELECTION_INVALID');
 return [...value].sort();
};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const ownerValid=value=>typeof value==='string'&&/^[A-Za-z0-9:_@.\-]{1,256}$/.test(value);
const clone=value=>structuredClone(value);

// This validates the existing service DTO; it does not authenticate an owner.
// Ownership stays with the same-origin session and the caller's verified ownerRef.
export async function validateResearchJob(body,{requestId,symbols,now=Date.now()}={}){
 const selected=selection(symbols);
 check(REQUEST.test(requestId)&&integer(now)&&body&&typeof body==='object'&&!Array.isArray(body));
 check(Object.keys(body).every(key=>['ok','requestId','state','result','error','queryOriginalRequest','createdAt','fresh'].includes(key)));
 check(body.requestId===requestId&&['pending','complete','failed','unknown'].includes(body.state)&&typeof body.fresh==='boolean'&&integer(body.createdAt)&&body.createdAt<=now);
 if(Object.hasOwn(body,'ok'))check(body.ok===(body.state==='complete'));
 if(Object.hasOwn(body,'error'))check(codes.has(body.error));
 if(Object.hasOwn(body,'queryOriginalRequest'))check(typeof body.queryOriginalRequest==='boolean');
 if(body.state!=='complete'){
  check(!body.result&&!body.fresh);
  if(body.state==='unknown')check(codes.has(body.error)&&body.queryOriginalRequest===true);
  if(body.state==='failed')check(codes.has(body.error)&&body.queryOriginalRequest===false);
  return clone(body);
 }
 const result=body.result;
 check(keys(result,['method','model','responseId','usage','billing','output','sources','missingDimensions','createdAt','validUntil','executionAuthority','methodVersion']));
 check(result.method==='ai'&&result.model===MODEL&&text(result.responseId)&&result.executionAuthority==='NONE'&&result.methodVersion==='closed-market-research-v1');
 check(integer(result.createdAt)&&result.createdAt>=body.createdAt&&result.createdAt<=now&&integer(result.validUntil));
 check(keys(result.usage,['inputTokens','outputTokens','totalTokens'])&&Object.values(result.usage).every(integer)&&result.usage.outputTokens<=800&&result.usage.totalTokens===result.usage.inputTokens+result.usage.outputTokens&&result.usage.totalTokens<=13056);
 check(result.billing===null||keys(result.billing,['provider','responseId','model','costMicrousd','isByok'])&&result.billing.provider==='openrouter'&&result.billing.responseId===result.responseId&&result.billing.model===result.model&&integer(result.billing.costMicrousd)&&result.billing.isByok===false);
 check(Array.isArray(result.missingDimensions)&&same([...result.missingDimensions].sort(),[...MISSING].sort()));
 check(Array.isArray(result.sources)&&result.sources.length===selected.length&&new Set(result.sources.map(source=>source?.symbol)).size===selected.length);
 const ids=new Set();
 for(const source of result.sources){
  check(keys(source,['id','symbol','source','timezone','unit','period','methodVersion','sampleAt','closedAt','validUntil','metrics','bars']));
  const asset=assets.get(source.symbol),request=crossMarketSource(source.symbol,source.source)||asset?.request;
  check(selected.includes(source.symbol)&&request&&source.source===(request.source||'Binance Spot')&&source.timezone===(request.timezone||'UTC')&&source.unit===(request.unit||'USDT')&&source.period==='1D'&&source.methodVersion==='ema20-atr14-rsi14-v1');
  check(keys(source.metrics,['close','changePercent','ema20DeviationAtr14','rsi14'])&&Object.values(source.metrics).every(Number.isFinite)&&source.metrics.close>0&&source.metrics.changePercent>-100&&source.metrics.rsi14>=0&&source.metrics.rsi14<=100);
  check(Number.isInteger(source.bars)&&source.bars>=250&&source.bars<=500&&[source.sampleAt,source.closedAt,source.validUntil].every(Number.isFinite)&&source.sampleAt>=0&&source.sampleAt<source.closedAt&&source.closedAt*1000<=now&&source.validUntil>source.closedAt);
  if(asset.domain==='Crypto')check(source.sampleAt%86400===0&&source.closedAt===source.sampleAt+86400&&source.validUntil===source.closedAt+86400);
  const canonical={symbol:source.symbol,source:source.source,timezone:source.timezone,unit:source.unit,period:source.period,methodVersion:source.methodVersion,sampleAt:source.sampleAt,closedAt:source.closedAt,validUntil:source.validUntil,metrics:{close:source.metrics.close,changePercent:source.metrics.changePercent,ema20DeviationAtr14:source.metrics.ema20DeviationAtr14,rsi14:source.metrics.rsi14},bars:source.bars};
  const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical)));
  check(source.id==='market-'+[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,32)&&!ids.has(source.id));ids.add(source.id);
 }
 check(result.validUntil===Math.min(...result.sources.map(source=>source.validUntil*1000)));
 const output=result.output;
 check(keys(output,['outcome','headline','summary','claims'])&&['watch','conflict','insufficient'].includes(output.outcome)&&text(output.headline,120)&&text(output.summary,1200)&&Array.isArray(output.claims)&&output.claims.length>0&&output.claims.length<=6);
 for(const claim of output.claims)check(keys(claim,['text','evidenceIds'])&&text(claim.text,500)&&Array.isArray(claim.evidenceIds)&&claim.evidenceIds.length>0&&claim.evidenceIds.length<=ids.size&&new Set(claim.evidenceIds).size===claim.evidenceIds.length&&claim.evidenceIds.every(id=>ids.has(id)));
 return clone(body);
}

async function json(response,bounded){
 if(response.redirected||!response.headers?.get('content-type')?.includes('application/json')||!response.body)throw Error('RESEARCH_RESPONSE_INVALID');
 const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];let bytes=0,complete=false;
 try{
  for(;;){const chunk=await bounded(reader.read());if(chunk.done){complete=true;break;}if(!(chunk.value instanceof Uint8Array))throw Error('RESEARCH_RESPONSE_INVALID');bytes+=chunk.value.length;if(bytes>65536)throw Error('RESEARCH_RESPONSE_INVALID');parts.push(decoder.decode(chunk.value,{stream:true}));}
  parts.push(decoder.decode());return JSON.parse(parts.join(''));
 }finally{if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}try{reader.releaseLock?.();}catch{}}
}

export function createResearchJobClient({fetchImpl=globalThis.fetch,storage,ownerRef=null,symbols=[],now=Date.now,makeRequestId=()=>globalThis.crypto.randomUUID(),timeoutMs=15000,onChange=()=>{}}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('RESEARCH_TIMEOUT_INVALID');
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{storage=null;}
 let owner=ownerValid(ownerRef)?ownerRef:null,selected=symbols.length?selection(symbols):[],intent=null,result=null,status=owner?'waiting':'auth-required',error=null,active=true,destroyed=false,generation=0,controller=null,inFlight=null,terminal=false,retryable=false,invalidSaved=false;
 const key=()=>STORAGE+encodeURIComponent(owner);
 function restore(){
  intent=null;result=null;terminal=false;retryable=false;invalidSaved=false;error=null;status=owner?'waiting':'auth-required';
  if(!owner)return;
  let raw;try{raw=storage?.getItem(key());}catch{invalidSaved=true;}
  if(!raw){if(invalidSaved){status='service-unavailable';error='REQUEST_STORAGE_UNAVAILABLE';}return;}
  try{
   check(typeof raw==='string'&&raw.length<=4096);const saved=JSON.parse(raw);check(keys(saved,['version','ownerRef','requestId','symbols','createdAt'])&&saved.version===1&&saved.ownerRef===owner&&REQUEST.test(saved.requestId)&&integer(saved.createdAt)&&saved.createdAt<=now());
   saved.symbols=selection(saved.symbols);intent=saved;selected=[...saved.symbols];status='unknown';error='RESUME_REQUIRED';
  }catch{invalidSaved=true;status='service-unavailable';error='REQUEST_STATE_INVALID';}
 }
 function snapshot(){
  if(status==='complete'&&result&&result.validUntil<=now())status='expired';
  return clone({status,ownerRef:owner,requestId:intent?.requestId||null,symbols:intent?.symbols||selected,createdAt:intent?.createdAt||null,result:active?result:null,error,mode:'live_readonly',executionAuthority:'NONE',canStart:active&&!destroyed&&Boolean(owner)&&!invalidSaved&&!inFlight&&(!intent||terminal),canQuery:active&&!destroyed&&Boolean(owner&&intent)&&!inFlight,canRetryOriginal:active&&!destroyed&&Boolean(owner&&intent&&intent.ownerRef===owner)&&!invalidSaved&&!inFlight&&!terminal&&retryable,queryOriginalRequest:Boolean(intent&&!terminal)});
 }
 const emit=()=>onChange(snapshot());
 function abort(){generation++;retryable=false;controller?.abort();controller=null;inFlight=null;}
 async function send(method){
  if(destroyed||!active||!owner||!intent)return snapshot();
  if(inFlight)return inFlight;
  const revision=generation,currentOwner=owner,request=clone(intent),aborter=new AbortController();controller=aborter;status='processing';error=null;terminal=false;retryable=false;
  let expired=false,rejectDeadline;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});deadline.catch(()=>{});
  const interrupted=()=>rejectDeadline(Error('RESEARCH_REQUEST_ABORTED'));
  aborter.signal.addEventListener('abort',interrupted,{once:true});
  const timeout=setTimeout(()=>{expired=true;aborter.abort();},timeoutMs),bounded=promise=>Promise.race([promise,deadline]);
  // Start on the next microtask so synchronous transport failures also release inFlight.
  const pending=Promise.resolve().then(async()=>{
   try{
    if(revision!==generation||owner!==currentOwner||destroyed||!active||aborter.signal.aborted)return snapshot();
    const init={method,credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:aborter.signal};
    if(method==='POST'){init.headers['Content-Type']='application/json';init.body=JSON.stringify({requestId:request.requestId,symbols:request.symbols});}
    const exchange=Promise.resolve(fetchImpl(method==='POST'?PREFIX+'/analyze':PREFIX+'/requests/'+encodeURIComponent(request.requestId),init));
    // Late transports remain observed, but can neither publish a result nor keep an unused body open.
    void exchange.then(value=>{if(expired||revision!==generation||owner!==currentOwner||destroyed||!active)try{Promise.resolve(value?.body?.cancel?.()).catch(()=>{});}catch{}},()=>{});
    const response=await bounded(exchange);
    const body=await bounded(json(response,bounded));
    if(revision!==generation||owner!==currentOwner||destroyed||!active)return snapshot();
    if(body?.requestId!==undefined){
     const value=await bounded(validateResearchJob(body,{requestId:request.requestId,symbols:request.symbols,now:now()}));
     if(revision!==generation||owner!==currentOwner||destroyed||!active)return snapshot();
     check(response.status>=200&&response.status<300||value.state==='failed');
     result=value.result||null;error=value.error||null;terminal=['complete','failed'].includes(value.state);
     status=value.state==='complete'?value.fresh&&result.validUntil>now()?'complete':'expired':value.state==='pending'?'processing':value.state==='unknown'?'unknown':'service-unavailable';
    }else{
     check(body&&body.ok===false&&body.executionAuthority==='NONE'&&codes.has(body.error)&&Object.keys(body).every(key=>['ok','error','executionAuthority'].includes(key)));
     error=body.error;status=['AUTH_REQUIRED','SCOPE_EXPIRED'].includes(error)?'auth-required':error==='OUTCOME_UNKNOWN'?'unknown':'service-unavailable';
     if(method==='GET'&&error==='REQUEST_NOT_FOUND'){
      check(response.status===404);
      // The original POST may still be before its atomic claim. Absence permits
      // only an explicit replay of this identity, never a new request ID.
      terminal=false;retryable=true;result=null;status='unknown';
     }
    }
   }catch(cause){
    if(revision!==generation||owner!==currentOwner||destroyed||!active)return snapshot();
    error=expired?'REQUEST_TIMEOUT':cause?.message==='RESEARCH_RESPONSE_INVALID'?'RESEARCH_RESPONSE_INVALID':'REQUEST_UNCONFIRMED';status='unknown';
   }finally{
    clearTimeout(timeout);
    aborter.signal.removeEventListener('abort',interrupted);
    if(revision===generation&&owner===currentOwner){controller=null;inFlight=null;emit();}
   }
   return snapshot();
  });
  inFlight=pending;emit();return pending;
 }
 restore();
 return {
  snapshot,
  select(value){if(intent&&!terminal||inFlight)return false;selected=selection(value);emit();return true;},
  async start(value=selected){
   if(destroyed||!active||!owner)return snapshot();
   if(inFlight)return inFlight;
   if(invalidSaved||intent&&!terminal)throw Error('ORIGINAL_REQUEST_PENDING');
   const values=selection(value),id=makeRequestId();if(!REQUEST.test(id)||id===intent?.requestId)throw Error('RESEARCH_REQUEST_ID_INVALID');
   const next={version:1,ownerRef:owner,requestId:id,symbols:values,createdAt:now()};
   if(!integer(next.createdAt))throw Error('RESEARCH_CLOCK_INVALID');
   try{if(!storage?.setItem)throw Error();storage.setItem(key(),JSON.stringify(next));}catch{status='service-unavailable';error='REQUEST_STORAGE_UNAVAILABLE';emit();return snapshot();}
   intent=next;selected=values;result=null;terminal=false;return send('POST');
  },
  query(){return send('GET');},
  async retryOriginal(){
   if(destroyed||!active||!owner)return snapshot();
   if(inFlight)return inFlight;
   if(!intent||intent.ownerRef!==owner||terminal||!retryable||invalidSaved)throw Error('ORIGINAL_REQUEST_RETRY_UNAVAILABLE');
   return send('POST');
  },
  resume(){if(destroyed)return Promise.resolve(snapshot());active=true;status=intent?'unknown':owner?'waiting':'auth-required';return intent?send('GET'):Promise.resolve(snapshot());},
  setOwner(value){const next=ownerValid(value)?value:null;if(next===owner)return snapshot();abort();owner=next;selected=[];restore();if(!active)status='cancel-view';emit();return snapshot();},
  leave(){abort();active=false;status='cancel-view';result=null;emit();return snapshot();},
  destroy(){abort();active=false;destroyed=true;status='cancel-view';result=null;}
 };
}

export function renderResearchJob(snapshot){
 if(!snapshot||snapshot.status==='cancel-view')return '';
 const labels={waiting:L('准备研究','Ready to research'),'auth-required':L('请先验证身份','Verify your identity'),'service-unavailable':L('研究暂不可用','Research unavailable'),processing:L('正在研究','Researching'),complete:L('技术观察已完成','Technical review complete'),expired:L('依据已过期','Evidence expired'),unknown:L('结果待确认','Result unconfirmed')};
 const status=Object.hasOwn(labels,snapshot.status)?snapshot.status:'unknown',result=snapshot.result,report=result?.executionAuthority==='NONE'&&result.method==='ai'?result.output:null;
 const message=snapshot.canRetryOriginal?L('尚未查到原请求，可沿用原编号重试。','Original request not found. Retry using the same ID.'):snapshot.error==='MODEL_UNAVAILABLE'?L('模型暂不可用，原请求已保留。','The model is unavailable. The original request is retained.'):snapshot.error==='BUDGET_UNAVAILABLE'?L('研究额度尚未开通，原请求已保留。','Research allowance is not enabled. The original request is retained.'):snapshot.error==='BUDGET_EXCEEDED'?L('研究额度已用尽，原请求已保留。','Research allowance is exhausted. The original request is retained.'):snapshot.error==='REQUEST_STORAGE_UNAVAILABLE'?L('无法保存请求，请允许当前页面存储后重试。','The request could not be saved. Allow page storage before retrying.'):status==='unknown'?L('保留原研究请求，查询确认后再继续。','The original request is retained. Check its result before continuing.'):status==='auth-required'?L('登录后查询原请求，不会重复发起研究。','Sign in, then check the original request without starting it again.'):status==='service-unavailable'?L('服务尚未就绪，原请求与页面草稿保持保留。','The service is not ready. Your original request and page draft are retained.'):'';
 const action=status==='auth-required'?`<button type="button" class="p-button" data-research-job-action="authenticate">${L('验证身份','Verify identity')}</button>`:`${snapshot.canRetryOriginal?`<button type="button" class="p-button p-primary" data-research-job-action="retry">${L('重试原请求','Retry original request')}</button>`:''}${snapshot.canQuery?`<button type="button" class="p-button" data-research-job-action="query">${L('查询结果','Check result')}</button>`:''}`;
 return `<section class="p-card research-job-card" data-research-job-status="${status}" data-no-translate><header><h3>${L('AI 行情研究','AI market research')}</h3><span role="status">${labels[status]}</span></header>${report?`<h4>${esc(report.headline)}</h4><p>${esc(report.summary)}</p><ul>${report.claims.map(claim=>`<li>${esc(claim.text)} ${claim.evidenceIds.map(id=>`<a href="#research-source-${esc(snapshot.requestId)}-${esc(id)}">${esc(result.sources.find(source=>source.id===id).symbol)}</a>`).join(' / ')}</li>`).join('')}</ul><details><summary>${L('查看依据','View evidence')} · ${snapshot.symbols.map(esc).join(' / ')}</summary>${result.sources.map(source=>`<dl id="research-source-${esc(snapshot.requestId)}-${esc(source.id)}" data-research-source="${esc(source.id)}"><dt>${esc(source.symbol+' · '+source.source)}</dt><dd>${esc(source.metrics.close+' '+source.unit)} · EMA20 ${esc(source.metrics.ema20DeviationAtr14)} ATR14 · RSI14 ${esc(source.metrics.rsi14)}</dd><dd><time datetime="${new Date(source.closedAt*1000).toISOString()}">${esc(new Date(source.closedAt*1000).toISOString().slice(0,16).replace('T',' '))} UTC</time></dd></dl>`).join('')}<p>${L('流动性、宏观事件、舆情、链上与账户风险依据待补。','Liquidity, macro-event, sentiment, on-chain and account-risk evidence remains missing.')}</p></details>`:''}${message?`<p>${message}</p>`:''}<footer>${snapshot.canStart&&snapshot.symbols.length?`<button type="button" class="p-button p-primary" data-research-job-action="start">${status==='complete'||status==='expired'?L('重新研究','Research again'):L('开始研究','Start research')}</button>`:''}${action}</footer></section>`;
}
