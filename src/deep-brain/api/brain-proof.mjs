import {createHash, randomUUID} from 'node:crypto';
import {access,link,mkdir,readFile,stat,unlink,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {gzip,gunzip} from 'node:zlib';
import {buildBrainProof,observedMarketSignals,validateProofMarket} from '../brain-proof-engine.mjs';
import {buildProofCohort} from '../brain-proof-cohort.mjs';
import {evaluateDecisionProof} from '../brain-decision-proof.mjs';
import {forwardDirectory,readForwardProof,readForwardRefusal} from '../brain-proof-forward.mjs';

import {summarizeForwardTrack} from '../brain-forward-track.mjs';
import {inspectForwardComparison} from '../brain-forward-comparison.mjs';
import {readSourceObservation,readSourceObservationArtifact} from '../brain-source-observations.mjs';
import {buildAgentBrief} from '../brain-agent-brief.mjs';
import {recallAgentMemory} from '../brain-agent-recall.mjs';

const bundledArchive=fileURLToPath(new URL('../brain-evidence/daily-markets.json',import.meta.url));
const windows=[30,90,180,365,'all'];
const digest=data=>createHash('sha256').update(data).digest('hex');
const pack=promisify(gzip),unpack=promisify(gunzip);
const isHash=value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
const assetInfo=({key,symbol,market,quote,venue})=>({key,symbol,market,quote,venue});
const agentTool={
  name:'get_deep_brain_brief',version:'brain-agent-brief-v1',readOnly:true,
  description:'Read a verified paper decision, its alternatives, risk limits, prior memory and execution status for one asset and UTC session.',
  inputSchema:{type:'object',additionalProperties:false,required:['asset'],properties:{
    asset:{type:'string',maxLength:128,description:'Exact key from the asset catalog, for example coin:bitcoin.'},
    date:{type:'string',format:'date',description:'Target UTC session. Defaults to the next UTC session.'}
  }},
  request:{method:'GET',path:'/api/brain/proof',query:{brief:'1'},inputLocation:'query'},
  assetCatalog:'/api/brain/proof'
};
const errors={
  BAD_QUERY:[400,'Invalid proof query.'],
  INVALID_WINDOW:[400,'Unsupported observation window.'],
  UNSUPPORTED_ASSET:[404,'No archived daily market for this asset.'],
  PROOF_NOT_FOUND:[404,'The requested proof was not found.'],
  INSUFFICIENT_EVIDENCE:[422,'The archive does not cover the required observation window.'],
  INVALID_EVIDENCE:[422,'The source did not pass the evidence checks.'],
  PROOF_UNAVAILABLE:[503,'Proof data is temporarily unavailable.']
};
function fail(code){throw Object.assign(new Error(code),{code});}
function assertKeys(params,allowed){
  for(const key of params.keys()){
    if(!allowed.includes(key) || params.getAll(key).length!==1)fail('BAD_QUERY');
  }
}
function parseDays(raw,allowAll){
  if(raw===null)return 90;
  if(raw==='all' && allowAll)return 'all';
  const days=Number(raw);
  if(!windows.includes(days) || String(days)!==raw)fail('INVALID_WINDOW');
  return days;
}
function validDate(date){
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date;
}
function currentUrl(asset,date,artifact=null,sha256=null){
  const params=new URLSearchParams({current:'1',asset,date});
  if(artifact){params.set('artifact',artifact);params.set('sha256',sha256);}
  return '/api/brain/proof?'+params;
}

const refusalGate=new Map([
  ['STALE_EVIDENCE','cutoff'],['INVALID_EVIDENCE','source'],
  ['SOURCE_OBSERVATION_MISSING','source'],['SOURCE_OBSERVATION_CONFLICT','source'],
  ['SOURCE_OBSERVATION_UNAVAILABLE','source'],['SOURCE_OBSERVATION_STALE','source'],
  ['INSUFFICIENT_EVIDENCE','source'],['MISSED_COMMIT_WINDOW','registration']
]);
function describeObservation(row){
  if(!row)return null;
  const params=new URLSearchParams({observation:row.id,asset:row.assetKey});
  const ref='/api/brain/proof?'+params;
  const {id,assetKey,venue,market,status,reason,matchedBars,totalBars,observedAt,rawSha256,archiveSha256,windowStartAt,windowEndAt}=row;
  return {id,assetKey,venue,market,status,reason,matchedBars,totalBars,observedAt,rawSha256,archiveSha256,windowStartAt,windowEndAt,
    documentUrl:ref+'&part=observation',responseUrl:row.httpStatus===200 && row.sourceUrl && ['matched','conflict','stale'].includes(status)?ref+'&part=response':null};
}
function applySourceRefusal(proof,record,assetKey,date,now){
  const doc=record.document,observed=Date.parse(doc?.observedAt);
  if(!['venue-refusal-v2','source-refusal-v1'].includes(doc?.version) || doc.assetKey!==assetKey || doc.targetDate!==date ||
    !refusalGate.has(doc.reason) || !isHash(doc.archiveSha256) || !Number.isFinite(observed) || observed>now ||
    digest(JSON.stringify(doc))!==record.sha256)fail('PROOF_UNAVAILABLE');
  const reason=doc.reason.toLowerCase();
  proof.status='blocked';proof.action='blocked';proof.reason=reason;
  proof.stages.brain='blocked';
  proof.targetOpenAt=date+'T00:00:00.000Z';
  for(const check of proof.checks){
    if(check.id===refusalGate.get(doc.reason)){
      check.status='blocked';check.reason=reason;
    }else check.reason='prerequisite_unverified';
  }
}

// A finished file becomes visible in one step. A second process publishing
// the same identity can safely keep the first, complete artifact.
async function publishImmutable(file,contents){
  for(const existing of [file+'.gz',file]){
    try{await access(existing);return;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const packed=file+'.gz',temp=packed+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temp,await pack(contents,{level:4}),{flag:'wx',mode:0o600,flush:true});
    try{await link(temp,packed);}catch(error){if(error.code!=='EEXIST')throw error;}
  }finally{
    await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}
async function readPublished(file){
  try{return await unpack(await readFile(file+'.gz'));}catch(error){if(error.code!=='ENOENT')throw error;}
  try{return await readFile(file);}catch(error){if(error.code==='ENOENT')fail('PROOF_NOT_FOUND');throw error;}
}

export function createBrainProofHandler({
  archiveFile=process.env.ASTARTER_BRAIN_DAILY_ARCHIVE,liveArchive=path.join(forwardDirectory(),'daily-markets.json'),fallbackArchive=bundledArchive,
  proofDir=process.env.ASTARTER_BRAIN_PROOF_DIR || path.join(homedir(),'.local','share','astarter','deep-brain','proof-replays'),
  build=buildBrainProof,cohort=buildProofCohort,forward=readForwardProof,refusal=readForwardRefusal,observation=readSourceObservation,artifactReader=readSourceObservationArtifact,clock=Date.now
}={}){
  let latest=null, lastRun=null;
  function location(type,id){return path.join(proofDir,type,id+'.json');}
  async function archive(){
    let file=archiveFile || liveArchive,info;
    try{info=await stat(file,{bigint:true});}catch(error){
      if(archiveFile || error.code!=='ENOENT')throw error;
      file=fallbackArchive;info=await stat(file,{bigint:true});
    }
    const stamp=[file,info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
    if(latest?.stamp===stamp)return latest.loading;
    const loading=readFile(file).then(bytes=>{
      const data=JSON.parse(bytes);
      if(!Array.isArray(data.assets) || !data.assets.length ||
        data.assets.some(asset=>typeof asset?.key!=='string' || !Array.isArray(asset.bars)) ||
        new Set(data.assets.map(asset=>asset.key)).size!==data.assets.length)fail('INVALID_EVIDENCE');
      return {data,bytes,sourceSha:digest(bytes),memo:new Map(),cohorts:new Map()};
    });
    latest={stamp,loading};
    try{return await loading;}catch(error){if(latest?.loading===loading)latest=null;throw error;}
  }
  function sourceRef(sourceSha){
    return {sha256:sourceSha,url:'/api/brain/proof?source='+sourceSha};
  }
  function saveSource(snapshot){
    snapshot.sourceSaved??=publishImmutable(location('sources',snapshot.sourceSha),snapshot.bytes)
      .catch(error=>{snapshot.sourceSaved=null;throw error;});
    return snapshot.sourceSaved;
  }
  async function sourceBytes(id){
    if(!isHash(id))fail('BAD_QUERY');
    const bytes=await readPublished(location('sources',id));
    if(digest(bytes)!==id)fail('PROOF_UNAVAILABLE');
    return bytes;
  }
  async function loadRun(id){
    if(!isHash(id))fail('BAD_QUERY');
    if(lastRun?.proof.runId===id)return lastRun;
    const record=JSON.parse(await readPublished(location('runs',id)));
    const {runId,...report}=record.proof;
    if(runId!==id || !isHash(record.sourceSha) || digest(JSON.stringify(report))!==id ||
      digest(JSON.stringify(record.proof))!==record.resultSha)fail('PROOF_UNAVAILABLE');
    lastRun=record;
    return record;
  }
  function index({proof,sourceSha,resultSha}){
    const {decisions,...header}=proof;
    return {...header,sourceArchive:sourceRef(sourceSha),resultSha256:resultSha,
      reportUrl:'/api/brain/proof?run='+header.runId+'&report=1',
      decisions:decisions.map(({id,asOf,barOpenAt,selected,execution})=>({
        id,asOf,barOpenAt,selected,status:execution.status,netPnl:execution.netPnl
      }))};
  }
  async function evaluate(snapshot,assetKey,days,computed=null){
    const key=JSON.stringify([assetKey,days]);
    if(snapshot.memo.has(key))return snapshot.memo.get(key);
    const task=(async()=>{
      const proof=computed ?? await build(snapshot.data,{assetKey,days});
      if(!isHash(proof.runId))fail('PROOF_UNAVAILABLE');
      // Publish the exact input bytes before publishing a run that points at them.
      await saveSource(snapshot);
      const resultSha=digest(JSON.stringify(proof));
      const record={sourceSha:snapshot.sourceSha,resultSha,proof};
      await publishImmutable(location('runs',proof.runId),JSON.stringify(record));
      // The engine can produce the same run when an unrelated market changes.
      // Serve the original archive that won publication, including after a restart.
      const stored=await loadRun(proof.runId);
      if(stored.resultSha!==resultSha)fail('PROOF_UNAVAILABLE');
      return index(stored);
    })();
    snapshot.memo.set(key,task);
    try{return await task;}catch(error){snapshot.memo.delete(key);throw error;}
  }
  async function evaluateCohort(snapshot,days){
    if(snapshot.cohorts.has(days))return snapshot.cohorts.get(days);
    const task=(async()=>{
      const runs=[];
      const result={...cohort(snapshot.data,{days,onRun:run=>runs.push(run)}),sourceArchive:sourceRef(snapshot.sourceSha)};
      await saveSource(snapshot);
      await Promise.all(runs.map(run=>evaluate(snapshot,run.asset.key,days,run)));
      // Retain the coverage denominator and reasons for exclusion alongside the winning and losing runs.
      const bytes=JSON.stringify(result),cohortId=digest(bytes);
      await publishImmutable(location('cohorts',cohortId),bytes);
      return {...result,cohortId,reportUrl:'/api/brain/proof?cohortId='+cohortId};
    })();
    snapshot.cohorts.set(days,task);
    try{return await task;}catch(error){snapshot.cohorts.delete(days);throw error;}
  }
  async function marketEvidence(params,reply){
    assertKeys(params,['marketEvidence','asset','date']);
    const key=params.get('asset'),now=clock(),today=new Date(now).toISOString().slice(0,10);
    const date=params.get('date')??today;
    if(params.get('marketEvidence')!=='1' || !key || key.length>128 || !validDate(date) || date>today)fail('BAD_QUERY');
    const row=await observation(key,{date,before:Math.min(now,Date.parse(date)+86400000-1)});
    if(!row && !(await archive()).data.assets.some(asset=>asset.key===key))fail('UNSUPPORTED_ASSET');
    const result={version:'market-evidence-v1',assetKey:key,date,today,observation:describeObservation(row),marketData:null};
    if(row?.status==='matched'){
      const raw=await artifactReader(key,{id:row.id,kind:'archive'});
      if(!raw || digest(raw)!==row.archiveBytesSha256)fail('INVALID_EVIDENCE');
      const {asset,bars}=validateProofMarket(JSON.parse(raw),key);
      const start=Date.parse(row.windowStartAt),end=Date.parse(row.windowEndAt);
      const closed=bars.filter(([at])=>at*1000>=start && (at+86400)*1000-1<=end);
      if(asset.market!==row.market || asset.venue!==row.venue || row.assetKey!==key ||
        row.matchedBars!==row.totalBars || closed.length!==row.totalBars ||
        closed.at(0)?.[0]*1000!==start || (closed.at(-1)?.[0]+86400)*1000-1!==end)fail('INVALID_EVIDENCE');
      result.marketData={market:asset.market,venue:asset.venue,quote:asset.quote,asOf:row.windowEndAt,barCount:closed.length,
        bars:closed,features:observedMarketSignals(closed)};
    }
    reply(200,result);
  }
  async function current(params,reply,brief=false){
    const mode=brief?'brief':'current';
    assertKeys(params,brief?[mode,'asset','date']:[mode,'asset','date','artifact','sha256']);
    const key=params.get('asset'),date=params.get('date'),artifact=params.get('artifact'),sha=params.get('sha256');
    if(params.get(mode)!=='1' || !key || key.length>128 || (date!==null && !validDate(date)))fail('BAD_QUERY');
    if(artifact!==null || sha!==null){
      if(!date || !['commit','evidence','dispatch'].includes(artifact) || !isHash(sha))fail('BAD_QUERY');
    }
    const now=clock(),checkedAt=new Date(now).toISOString();
    // The collector registers the next UTC session in advance. Never replace
    // its missing receipt or decision with yesterday's most recent result.
    const targetDate=date??new Date(now+86400000).toISOString().slice(0,10);
    const saved=await forward(key,{date:targetDate,includeEvidence:true});
    const refused=saved?null:await refusal(key,{date:targetDate});
    if(!saved && !refused && !(await archive()).data.assets.some(asset=>asset.key===key))fail('UNSUPPORTED_ASSET');
    const proof=evaluateDecisionProof(saved,{assetKey:key,date:targetDate,checkedAt,delivery:'paper',includeSensitivity:brief});
    if(refused)applySourceRefusal(proof,refused,key,targetDate,now);
    const verifiedBrain=Boolean(saved && proof.stages.brain==='verified' && proof.commitId===saved.id);
    const dispatch=verifiedBrain && proof.status!=='blocked' && saved.dispatch && proof.execution?.dispatchId===saved.dispatch.sha256?
      saved.dispatch:null;
    if(artifact!==null){
      // A pinned URL identifies the original bytes. The later reconciliation
      // lives in a separate record and cannot change an earlier commitment.
      const commit=saved?.commit?.document;
      if(commit?.intent?.assetKey!==key || commit.intent.scheduledOpenAt!==targetDate+'T00:00:00.000Z')fail('PROOF_NOT_FOUND');
      let document,expected;
      if(artifact==='commit'){
        document=commit;expected=saved.id;
      }else if(artifact==='evidence'){
        document=saved.archive;expected=commit.archiveSha256;
      }else{
        document=saved.dispatch?.document;expected=saved.dispatch?.sha256;
        if(document?.commitId!==saved.id || document.decisionId!==commit.intent.id || document.assetKey!==key ||
          document.targetOpenAt!==commit.intent.scheduledOpenAt)fail('PROOF_NOT_FOUND');
      }
      if(!document || sha!==expected)fail('PROOF_NOT_FOUND');
      if(!verifiedBrain || (artifact==='dispatch' && !dispatch))fail('INVALID_EVIDENCE');
      const bytes=Buffer.from(JSON.stringify(document));
      if(digest(bytes)!==sha)fail('PROOF_UNAVAILABLE');
      reply(200,bytes,{ETag:'"'+sha+'"'});return;
    }
    const receipt=date && dispatch && saved.receipt && proof.execution?.receiptId===saved.receipt.id &&
      proof.execution?.receiptHash===saved.receiptHash?saved.receipt:null;
    const captureDate=new Date(Date.parse(targetDate)-86400000).toISOString().slice(0,10);
    // A later recheck of an old registration is displayed separately from evidence bound before the decision.
    let review=saved?.vetoEvidence?.observation??saved?.venueEvidence?.observation;
    if(!review){
      const archiveSha256=saved?.archiveSha256??refused?.document.archiveSha256;
      const sourceId=refused?.document.sourceObservationId;
      const row=await observation(key,{date:captureDate,before:now,...(archiveSha256?{archiveSha256}:{}),...(sourceId?{id:sourceId}:{})});
      review=(!archiveSha256 || row?.archiveSha256===archiveSha256)?row:null;
    }
    const comparison=inspectForwardComparison(saved,saved?.comparisonPlan,{checkedAt:now});
    const result={comparison,venueReview:describeObservation(review),mode:date?'dated':'current',assetKey:key,checkedAt,targetDate,decisionProof:proof,
      commitId:verifiedBrain?saved.id:null,recordUrl:verifiedBrain?currentUrl(key,targetDate,'commit',saved.id):null,
      evidenceUrl:verifiedBrain?currentUrl(key,targetDate,'evidence',saved.commit.document.archiveSha256):null,
      handoffUrl:dispatch?currentUrl(key,targetDate,'dispatch',dispatch.sha256):null,
      reviewUrl:currentUrl(key,targetDate),dispatch,receipt,refusal:refused};
    if(!brief){reply(200,result);return;}
    const cutoff=verifiedBrain?proof.recordedAt:refused?.document.observedAt??checkedAt;
    const memory=await recallAgentMemory({assetKey:key,targetDate,cutoff,selected:proof.selected,
      market:proof.evidence?.market,quote:proof.evidence?.quote,read:forward,readRefusal:refusal});
    reply(200,buildAgentBrief(result,memory));
  }

  return async function handleBrainProof(req,res){
    function reply(status,data,headers={}){
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
      res.end(req.method==='HEAD'?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data));
    }
    if(!['GET','HEAD'].includes(req.method)){reply(405,{error:{code:'METHOD_NOT_ALLOWED',message:'Use GET or HEAD.'}},{Allow:'GET, HEAD'});return;}
    try{
      const params=new URL(req.url,'http://localhost').searchParams;
      if(params.has('example')){
        assertKeys(params,['example']);
        if(params.get('example')!=='btc-pullback')fail('PROOF_NOT_FOUND');
        const {featuredCase,bundledMarket}=await import('../paper-replay/replay.mjs');
        const example=await featuredCase();
        try{await loadRun(example.runId);}catch(error){
          if(error.code!=='PROOF_NOT_FOUND')throw error;
          const bytes=await readFile(bundledMarket),data=JSON.parse(bytes);
          const assetKey=example.asset.key,days=example.sample.observations;
          const proof=buildBrainProof(data,{assetKey,days});
          if(proof.runId!==example.runId)fail('PROOF_UNAVAILABLE');
          await evaluate({bytes,data,sourceSha:digest(bytes),memo:new Map()},assetKey,days,proof);
        }
        reply(200,example);return;
      }
      if(params.has('tool')){
        assertKeys(params,['tool']);
        if(params.get('tool')!=='1')fail('BAD_QUERY');
        reply(200,agentTool);return;
      }
      if(params.has('brief')){await current(params,reply,true);return;}
      if(params.has('outcomes')){
        assertKeys(params,['outcomes','asset','days']);
        const key=params.get('asset'),days=params.get('days')??'30';
        if(params.get('outcomes')!=='1' || !key || key.length>128 || !['7','30'].includes(days))fail('BAD_QUERY');
        const report=await summarizeForwardTrack(key,{days:Number(days),checkedAt:clock(),read:forward,readRefusal:refusal});
        if(!report.counts.registered && !report.counts.refused && !report.active?.registered && report.active?.status!=='refused'){
          // Older registrations can predate the selected calendar and outlive the current market catalog.
          let catalogError;
          const listed=await archive().then(s=>s.data.assets.some(asset=>asset.key===key),error=>{catalogError=error;return false;});
          if(!listed && (await forward(key,{includeEvidence:false}))?.intent?.assetKey!==key){
            if(catalogError)throw catalogError;
            fail('UNSUPPORTED_ASSET');
          }
        }
        reply(200,report);return;
      }
      if(params.has('observation')){
        assertKeys(params,['observation','asset','part']);
        const key=params.get('asset'),id=params.get('observation'),part=params.get('part');
        if(!isHash(id) || !key || key.length>128 || !['observation','response','archive'].includes(part))fail('BAD_QUERY');
        const row=await observation(key,{id});
        if(!row)fail('PROOF_NOT_FOUND');
        if(part==='response' && !describeObservation(row).responseUrl)fail('PROOF_NOT_FOUND');
        const bytes=await artifactReader(key,{id,kind:part});
        if(!bytes)fail('PROOF_NOT_FOUND');
        reply(200,bytes,{ETag:'"'+digest(bytes)+'"'});return;
      }
      if(params.has('marketEvidence')){await marketEvidence(params,reply);return;}
      if(params.has('current')){await current(params,reply);return;}
      if(params.has('cohortId')){
        assertKeys(params,['cohortId']);
        const id=params.get('cohortId');if(!isHash(id))fail('BAD_QUERY');
        const bytes=await readPublished(location('cohorts',id));
        if(digest(bytes)!==id)fail('PROOF_UNAVAILABLE');
        reply(200,bytes,{ETag:'"'+id+'"'});return;
      }
      if(params.has('source')){
        assertKeys(params,['source']);
        const id=params.get('source'),bytes=await sourceBytes(id);
        reply(200,bytes,{ETag:'"'+id+'"'});return;
      }
      if(params.has('run')){
        assertKeys(params,['run','decision','evidence','report']);
        const decisionId=params.get('decision');
        if(decisionId!==null && !isHash(decisionId))fail('BAD_QUERY');
        if(params.has('report') && (decisionId!==null || params.get('report')!=='1'))fail('BAD_QUERY');
        if(params.has('evidence') && (!decisionId || params.get('evidence')!=='1'))fail('BAD_QUERY');
        const record=await loadRun(params.get('run'));
        if(params.has('report')){reply(200,record.proof,{ETag:'"'+record.resultSha+'"'});return;}
        if(!decisionId){reply(200,index(record));return;}
        const decision=record.proof.decisions.find(item=>item.id===decisionId);
        if(!decision)fail('PROOF_NOT_FOUND');
        const ref={runId:record.proof.runId,sourceArchive:sourceRef(record.sourceSha)};
        if(params.has('evidence')){
          const {key,market,venue,quote}=record.proof.asset;
          const raw=JSON.parse(await sourceBytes(record.sourceSha)).assets.find(asset=>asset.key===key);
          const start=Date.parse(decision.evidenceStartAt)/1000,end=Date.parse(decision.asOf)/1000;
          const bars=raw?.bars.filter(([open])=>open>=start && open<end);
          if(!bars || digest(JSON.stringify([key,market,venue,quote,bars]))!==decision.snapshotId)fail('PROOF_UNAVAILABLE');
          reply(200,{...ref,decisionId,snapshotId:decision.snapshotId,asOf:decision.asOf,market,venue,quote,
            fields:['openTimeUnix','open','high','low','close','baseVolume'],bars});return;
        }
        reply(200,{...ref,evidenceUrl:'/api/brain/proof?run='+ref.runId+'&decision='+decisionId+'&evidence=1',decision});return;
      }
      const key=params.get('asset');
      if(params.has('forward')){
        assertKeys(params,['forward','asset','date','evidence']);
        const date=params.get('date'),evidence=params.get('evidence');
        if(!key || key.length>128 || params.get('forward')!=='1' || (evidence!==null && evidence!=='1'))fail('BAD_QUERY');
        if(date!==null && !validDate(date))fail('BAD_QUERY');
        const saved=await forward(key,{date:date??undefined,includeEvidence:evidence==='1'});
        if(!saved && !(await archive()).data.assets.some(asset=>asset.key===key))fail('UNSUPPORTED_ASSET');
        reply(200,{forward:saved});return;
      }
      const snapshot=await archive();
      if(params.has('cohort')){
        assertKeys(params,['cohort','days']);if(params.get('cohort')!=='1')fail('BAD_QUERY');
        const days=parseDays(params.get('days'),false);
        reply(200,await evaluateCohort(snapshot,days));return;
      }
      if(!params.size){reply(200,{assets:snapshot.data.assets.map(assetInfo),agentTool:'/api/brain/proof?tool=1',windows,defaultDays:90,
        retrievedAt:snapshot.data.updatedAt??snapshot.data.retrievedAt});return;}
      assertKeys(params,['asset','days']);
      if(!key || key.length>128)fail('BAD_QUERY');
      if(!snapshot.data.assets.some(asset=>asset.key===key))fail('UNSUPPORTED_ASSET');
      const days=parseDays(params.get('days'),true);
      const record=await evaluate(snapshot,key,days);
      try{reply(200,{...record,forward:await forward(key)});}
      catch{reply(200,{...record,forward:null,forwardError:'FORWARD_UNAVAILABLE'});}
    }catch(error){
      const code=Object.hasOwn(errors,error?.code)?error.code:'PROOF_UNAVAILABLE';
      const [status,message]=errors[code];
      reply(status,{error:{code,message}});
    }
  };
}
