import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {featuredCase,sha256} from './replay.mjs';

function required(env,key) {
  if(!env[key]?.trim())throw Error('Set '+key+' before using this connection');
  return env[key];
}
async function jsonRequest(url,init,fetchImpl) {
  const response=await fetchImpl(url,{...init,signal:AbortSignal.timeout(60000),redirect:'error'});
  if(!response.ok)throw Error('Provider returned HTTP '+response.status);
  return response.json();
}
export async function explainMemory(record,{env=process.env,fetchImpl=fetch,content=JSON.stringify(record)}={}) {
  const result=await jsonRequest('https://api.openai.com/v1/responses',{
    method:'POST',headers:{Authorization:'Bearer '+required(env,'OPENAI_API_KEY'),'Content-Type':'application/json'},
    body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-6.2-sol',store:false,max_output_tokens:2400,input:[
      {role:'developer',content:'Explain this historical paper replay using only the supplied memory. Trace the cutoff, candidate comparison, risk cap, modeled fills and costs. Reconcile P&L without counting slippage twice. Treat missing fills as skipped. Cite the receipt ID. Do not infer a real order, a win probability or guaranteed returns.'},
      {role:'user',content}]})
  },fetchImpl);
  const answer=(result.output??[]).filter(row=>row.type==='message'&&row.role==='assistant')
    .flatMap(row=>row.content??[]).filter(row=>row.type==='output_text').map(row=>row.text).join('\n');
  if(result.status!=='completed'||!answer.trim())throw Error('Model returned no complete explanation');
  return {model:result.model,inputSha256:sha256(content),receiptId:record.decision.execution.id,usage:result.usage,answer};
}
export async function syncMemory(record,{env=process.env,fetchImpl=fetch}={}) {
  const root='https://api.livingbrain.com/v1/brains/'+encodeURIComponent(required(env,'LIVING_BRAIN_BRAIN_ID'));
  const headers={'x-api-key':required(env,'LIVING_BRAIN_API_KEY'),'x-subject-id':required(env,'LIVING_BRAIN_SUBJECT_ID'),'Content-Type':'application/json'};
  let content=JSON.stringify(record),originRef='paper-replay:'+sha256(content);
  const {verification,...example}=await featuredCase();
  if(content===JSON.stringify(example)){
    content=await readFile(new URL('./example/memory.txt',import.meta.url),'utf8');
    if(sha256(content)!==verification.memory.contentSha256)throw Error('Reference memory checksum mismatch');
    originRef=JSON.parse(content.split('\n')[1]).originRef;
  }
  const digest=sha256(content);
  const request=(route,options={})=>jsonRequest(root+route,{headers,...options},fetchImpl);
  let source;
  for(let offset=0;!source;offset+=100){
    const page=await request('/sources?limit=100&offset='+offset);
    source=page.items.find(row=>row.originRef===originRef);
    if(page.items.length<100 || offset+page.items.length>=page.total)break;
  }
  if(!source){
    const result=await request('/captures/batch',{method:'POST',body:JSON.stringify({items:[{kind:'integration',bucket:'notes',
      label:record.asset.market+' paper replay '+record.decision.barOpenAt.slice(0,10),originRef,content}]})});
    source=result.sources?.[0];
  }
  if(!source?.id)throw Error('No memory source ID returned');
  for(let attempt=0;attempt<20;attempt++){
    const result=await request('/sources?ids='+encodeURIComponent(source.id));
    const row=result.items?.find(item=>item.id===source.id);
    if(row?.status==='failed')throw Error('Memory compilation failed for '+source.id);
    if(row?.status==='completed'){
      if(row.originRef!==originRef || typeof row.content!=='string' || sha256(row.content)!==digest)throw Error('Remote memory content mismatch');
      return {id:row.id,status:row.status,sha256:digest,compiledAt:row.compiledAt,content:row.content};
    }
    await delay(2000);
  }
  throw Error('Source '+source.id+' still compiling. Run sync again to check it.');
}
