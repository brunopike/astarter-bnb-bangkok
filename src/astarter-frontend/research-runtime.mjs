import {createPrivateResearchClient} from './private-service-client.mjs';
import {createResearchPrivateAdapters,researchCredentialDigest,reserveResearchMicrousd} from './research-private-store.mjs';
import {createResearchAnalysisModel,createResearchAnalysisService,createResearchAnalysisHandler,RESEARCH_MODEL_LIMITS} from './research-analysis-service.mjs';
import {createResearchMarketEvidence} from './research-market-evidence.mjs';
import {createResearchProviderBudget} from './research-provider-budget.mjs';

export const RESEARCH_ORIGIN='https://astarter.imstark.site';
export function createResearchRuntime({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const modelEnabled=env.ASTARTER_RESEARCH_MODEL_ENABLED==='1',providerCapRequired=env.ASTARTER_RESEARCH_PROVIDER_CAP_REQUIRED!=='0';
 let lease;try{if(typeof env.ASTARTER_RESEARCH_LEASE_JSON==='string'&&env.ASTARTER_RESEARCH_LEASE_JSON.length<=8192)lease=JSON.parse(env.ASTARTER_RESEARCH_LEASE_JSON);}catch{}
 const options={origin:env.ASTARTER_PRIVATE_SERVICE_ORIGIN,token:env.ASTARTER_PRIVATE_RUNTIME_TOKEN,fetchImpl,timeoutMs:3000};
 const base=createPrivateResearchClient(options),model=createResearchAnalysisModel({apiKey:env.OPENROUTER_API_KEY,model:env.ASTARTER_RESEARCH_MODEL||RESEARCH_MODEL_LIMITS.model,fetchImpl,timeoutMs:8000});
 const source=createResearchMarketEvidence({fetchImpl,now,timeoutMs:8000});
 const budget=createResearchProviderBudget({apiKey:env.OPENROUTER_API_KEY,fetchImpl,now,timeoutMs:3000,maxMicrousd:50000000});
 // Reads of stored records never use the model key; only a new analysis needs it.
 const readable=Boolean(base.configured&&createResearchPrivateAdapters({dal:base,lease,now}).configured&&(!env.ASTARTER_PRIVATE_ISSUER_TOKEN||env.ASTARTER_PRIVATE_ISSUER_TOKEN!==env.ASTARTER_PRIVATE_RUNTIME_TOKEN));
 const configured=Boolean(readable&&model.configured);
 function serviceFor(request){
  // The page reads with its same-origin session cookie; no caller sends a bare Bearer header here.
  let sessionDigest;try{if(request?.headers?.authorization!==undefined)throw Error();sessionDigest=researchCredentialDigest(request);}catch{throw Object.assign(Error('AUTH_REQUIRED'),{status:401});}
  // Bind both the RPC credential and the principal set to this HTTP request.
  const dal=createPrivateResearchClient({...options,sessionDigest}),adapters=createResearchPrivateAdapters({dal,lease,now});
  return createResearchAnalysisService({model,store:adapters.store,loadEvidence:source.loadEvidence,now,
   async authorize(context){
    try{return await adapters.authorize(context);}catch(error){if(error?.message==='PRIVATE_AUTH_REQUIRED')throw Error('AUTH_REQUIRED');throw error;}
   },
   async admission(principal){
    if(!modelEnabled)throw Error('MODEL_UNAVAILABLE');
    const policy=await adapters.admission(principal);
    // Deferring the provider key cap never bypasses Core's atomic monthly reservation.
    if(providerCapRequired){const proof=await budget.verify();if(proof.remainingMicrousd<reserveResearchMicrousd())throw Error('BUDGET_UNAVAILABLE');}
    return policy;
   }
  });
 }
 const service=readable?{analyze(request,input){return serviceFor(request).analyze(request,input);},get(request,id){return serviceFor(request).get(request,id);}}:undefined;
 return {configured,handle:createResearchAnalysisHandler({service,origin:RESEARCH_ORIGIN})};
}
