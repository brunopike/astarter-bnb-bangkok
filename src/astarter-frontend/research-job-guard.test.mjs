import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchJobClient,validateResearchJob,renderResearchJob} from './research-job-client.mjs';
import {validateResearchEvidence} from './research-analysis-service.mjs';

// Page guard for research answers: a failure never appears as a conclusion.
// Offline doubles only; no model, source or private service is called.
const NOW=Date.UTC(2026,10,16,12),DAY=86400,ID='research-guard-0001';
const row=(symbol='BTC')=>({symbol,source:'Binance Spot',timezone:'UTC',unit:'USDT',feedState:'snapshot',state:'ready',paused:false,x:1.25,y:57.8,price:90500,change:1.5,closedAt:Math.floor(NOW/1000/DAY)*DAY,sampleAt:Math.floor(NOW/1000/DAY)*DAY-DAY,validUntil:Math.floor(NOW/1000/DAY)*DAY+DAY,period:'1D',methodVersion:'ema20-atr14-rsi14-v1',bars:299});
function report(){
 const sources=validateResearchEvidence([row()],['BTC'],NOW);
 return {method:'ai',model:'openai/gpt-4.1-mini',responseId:'offline-guard-receipt',usage:{inputTokens:100,outputTokens:40,totalTokens:140},billing:null,output:{outcome:'watch',headline:'Offline guard headline',summary:'Offline guard summary.',claims:[{text:'RSI14 is 57.8.',evidenceIds:[sources[0].id]}]},sources,missingDimensions:['depth','macro','social','chain','risk'],createdAt:NOW,validUntil:Math.min(...sources.map(source=>source.validUntil*1000)),executionAuthority:'NONE',methodVersion:'closed-market-research-v1'};
}
const answers={
 failed:{requestId:ID,state:'failed',createdAt:NOW,fresh:false,error:'EVIDENCE_UNAVAILABLE',queryOriginalRequest:false},
 unknown:{requestId:ID,state:'unknown',createdAt:NOW,fresh:false,error:'MODEL_TIMEOUT',queryOriginalRequest:true},
 pending:{requestId:ID,state:'pending',createdAt:NOW,fresh:false}
};
const context={requestId:ID,symbols:['BTC'],now:NOW};

test('validateResearchJob rejects failed, unknown and pending answers that carry a result or claim to be fresh',async()=>{
 assert.equal((await validateResearchJob({requestId:ID,state:'complete',createdAt:NOW,fresh:true,result:report()},context)).state,'complete');
 for(const [state,answer] of Object.entries(answers)){
  assert.deepEqual(await validateResearchJob(structuredClone(answer),context),answer,state);
  for(const changed of [{...answer,result:report()},{...answer,fresh:true},{...answer,ok:true},{...answer,result:report(),fresh:true,ok:true}])await assert.rejects(()=>validateResearchJob(changed,context),{message:'RESEARCH_RESPONSE_INVALID'},state);
 }
});

test('a non-complete answer that carries a report never reaches the page as a conclusion',async()=>{
 for(const answer of Object.values(answers)){
  const body={...answer,result:report()},calls=[],entries=new Map();
  const page=createResearchJobClient({storage:{getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value))},ownerRef:'offline-owner',symbols:['BTC'],now:()=>NOW,makeRequestId:()=>ID,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});}});
  await page.start();const snapshot=page.snapshot(),html=renderResearchJob(snapshot);
  assert.equal(calls.length,1);assert.equal(snapshot.status,'unknown');assert.equal(snapshot.error,'RESEARCH_RESPONSE_INVALID');assert.equal(snapshot.result,null);assert.equal(snapshot.canQuery,true);
  assert.doesNotMatch(html,/Offline guard headline|Offline guard summary|data-research-source=/);page.destroy();
 }
});
