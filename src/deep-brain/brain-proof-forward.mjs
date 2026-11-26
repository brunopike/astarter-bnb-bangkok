import {createHash, randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,link,unlink,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {buildForwardIntent,settleForwardIntent,validateProofMarket} from './brain-proof-engine.mjs';

import {readSourceObservation,readSourceObservationEvidence} from './brain-source-observations.mjs';
import {observationReason,venueProtocol,settlementCandleChecked} from './brain-venue-gate.mjs';
import {createComparisonPlan} from './brain-forward-comparison.mjs';

const day=86400000;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const forwardDirectory=()=>process.env.ASTARTER_BRAIN_FORWARD_DIR || path.join(homedir(),'.local/share/astarter/deep-brain/forward');
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
function seriesDirectory(dir,key){
  return path.join(dir,'markets',digest(key));
}
// The forecasting collector uses the same immutable file envelopes as paper decisions.
export {seriesDirectory, storeDocument, readDocument};
async function optionalRead(file){
  try{return await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
// Link only complete files. Concurrent collectors and retries cannot replace the first publication.
async function publish(file,body){
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,body,{flag:'wx',mode:0o600,flush:true});
  try{await link(tmp,file);return true;}
  catch(error){if(error.code==='EEXIST')return false;throw error;}
  finally{await unlink(tmp);}
}
async function tradingDates(dir){
  try{return (await readdir(dir,{withFileTypes:true})).filter(e=>e.isDirectory() && datePattern.test(e.name)).map(e=>e.name).sort();}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
async function storeDocument(file,document){
  const sha256=digest(JSON.stringify(document));
  const saved=await publish(file,JSON.stringify({sha256,document}));
  return {saved,sha256};
}
async function readDocument(file){
  const raw=await optionalRead(file);
  if(raw===null)return null;
  const entry=JSON.parse(raw);
  if(digest(JSON.stringify(entry.document))!==entry.sha256)throw Error('Invalid stored proof digest');
  return entry;
}
// Delivery is a separate, write-once instruction to the paper execution worker.
async function handOff(assetKey,date,dir,clock){
  const destination=path.join(seriesDirectory(dir,assetKey),date,'dispatch.json');
  const proof=await readForwardProof(assetKey,{dir,date,includeEvidence:true});
  const {evaluateDecisionProof}=await import('./brain-decision-proof.mjs');
  const checkedAt=new Date(clock()).toISOString();
  const check=evaluateDecisionProof(proof,{assetKey,date,checkedAt});
  if(check.status==='blocked')throw Error(check.reason || 'DECISION_PROOF_BLOCKED');
  if(proof.dispatch)return false;
  if(!check.canIssuePaperHandoff || !['abstain','paper_only'].includes(check.action))throw Error('UNVERIFIED_HANDOFF');
  const {intent}=proof;
  const issuedAt=new Date(clock()).toISOString();
  if(Date.parse(issuedAt)+60000>=Date.parse(intent.scheduledOpenAt))throw Error('MISSED_HANDOFF_WINDOW');
  const dispatch={version:'paper-dispatch-v1',route:'paper',commitId:proof.id,decisionId:intent.id,
    snapshotId:intent.snapshotId,assetKey,targetOpenAt:intent.scheduledOpenAt,issuedAt,
    disposition:check.action==='abstain'?'hold_cash':'admit_paper',maxNotional:intent.risk.amount,quote:intent.quote};
  const entry={document:dispatch,sha256:digest(JSON.stringify(dispatch))};
  const admitted=evaluateDecisionProof({...proof,dispatch:entry},{assetKey,date,checkedAt:issuedAt});
  if(admitted.status==='blocked' || admitted.execution?.dispatchId!==entry.sha256)throw Error(admitted.reason || 'HANDOFF_BLOCKED');
  return (await storeDocument(destination,dispatch)).saved;
}
async function registerControls(assetKey,date,dir,clock){
  const folder=path.join(seriesDirectory(dir,assetKey),date);
  const proof=await readForwardProof(assetKey,{dir,date,includeEvidence:true});
  if(!proof?.dispatch)return;
  const now=new Date(clock()).toISOString();
  if(Date.parse(now)+60000>=Date.parse(proof.targetOpenAt))return;
  const latest=await readSourceObservation(assetKey,{dir,date:now.slice(0,10),before:now});
  if(latest?.status==='conflict' && latest.windowEndAt===proof.intent.asOf &&
      Date.parse(latest.observedAt)>=Date.parse(proof.recordedAt)){
    await storeDocument(path.join(folder,'venue-veto.json'),{version:'venue-veto-v1',assetKey,
      date,commitId:proof.id,dispatchId:proof.dispatch.sha256,observationId:latest.id,issuedAt:now});
    return;
  }
  if(!proof.comparisonPlan && !proof.venueVeto){
    const document=createComparisonPlan(proof,now);
    await storeDocument(path.join(folder,'comparison.json'),document);
  }
}

function lastClosedAt(asset){
  const timestamp=asset?.bars?.at(-1)?.[0]*1000+day-1;
  return Number.isSafeInteger(timestamp) && Math.abs(timestamp)<8.64e15?new Date(timestamp).toISOString():null;
}

export async function readForwardRefusal(assetKey,{dir=forwardDirectory(),date}={}){
  if(typeof assetKey!=='string' || !assetKey || !datePattern.test(date))return null;
  const saved=await readDocument(path.join(seriesDirectory(dir,assetKey),date,'refusal.json'));
  if(!saved)return null;
  const r=saved.document;
  const when=Date.parse(r.observedAt),open=Date.parse(date);
  if(!['source-refusal-v1','venue-refusal-v2'].includes(r.version) || r.assetKey!==assetKey || r.targetDate!==date ||
    !(when>=open-day && when<open) || !/^[a-f0-9]{64}$/.test(r.archiveSha256))throw Error('Invalid refusal scope');
  const bytes=await readFile(path.join(dir,'evidence',r.archiveSha256+'.json'));
  if(digest(bytes)!==r.archiveSha256)throw Error('Invalid refusal evidence');
  const archive=JSON.parse(bytes);
  if(r.asOf!==lastClosedAt(archive.assets.find(a=>a.key===assetKey)))throw Error('Invalid refusal cutoff');
  if(r.version==='venue-refusal-v2'){
    if(r.sourceObservationId===null && r.reason==='SOURCE_OBSERVATION_MISSING')return saved;
    if(!/^[a-f0-9]{64}$/.test(r.sourceObservationId??''))throw Error('Missing refusal observation id');
    const observation=await readSourceObservation(assetKey,{dir,date:r.observedAt.slice(0,10),
      archiveSha256:r.archiveSha256,before:r.observedAt,id:r.sourceObservationId});
    if(!observation || observationReason(observation)!==r.reason)throw Error('Venue refusal does not match observation');
    return saved;
  }
  let reason;
  try{buildForwardIntent(archive,{assetKey,observedAt:r.observedAt});}
  catch(error){reason=error.code;}
  if(r.reason==='MISSED_COMMIT_WINDOW'){
    if(reason || when+60000<open)throw Error('Invalid refusal time');
  }else if(!['STALE_EVIDENCE','INSUFFICIENT_EVIDENCE','INVALID_EVIDENCE'].includes(r.reason) || reason!==r.reason){
    throw Error('Source refusal could not be reproduced');
  }
  return saved;
}

export async function recordForwardProofs(archive,{dir=forwardDirectory(),clock=Date.now}={}){
  const result={registered:0,dispatched:0,settled:0,unchanged:0,unavailable:[],failed:[]};
  const evidenceBytes=JSON.stringify(archive), archiveSha256=digest(evidenceBytes);
  let snapshotStored=false;
  async function saveEvidence(){
    if(snapshotStored)return;
    await publish(path.join(dir,'evidence',archiveSha256+'.json'),evidenceBytes);
    snapshotStored=true;
  }
  for(const asset of archive.assets){
    const marketDir=seriesDirectory(dir,asset.key);
    const observedAt=new Date(clock()).toISOString();
    const today=observedAt.slice(0,10);
    const nextDate=new Date(Date.parse(today)+day).toISOString().slice(0,10);
    async function recordRefusal(reason,at,ref={}){
      await saveEvidence();
      await storeDocument(path.join(marketDir,nextDate,'refusal.json'),{version:'source-refusal-v1',
        assetKey:asset.key,targetDate:nextDate,observedAt:at,reason,asOf:lastClosedAt(asset),archiveSha256,...ref});
    }
    try{
      const verified=validateProofMarket(archive,asset.key);
      const captured=verified.fetched;
      if(captured>Date.parse(observedAt))throw Error('Invalid evidence capture clock');
      const dates=await tradingDates(marketDir);
      // A missing bar stays pending. Never substitute a later bar or a remembered quote.
      const bars=new Map(verified.bars.map(bar=>[bar[0]*1000,bar]));
      for(const date of dates){
        if(date>=today)continue;
        const receiptFile=path.join(marketDir,date,'receipt.json');
        if(await optionalRead(receiptFile)!==null)continue;
        const bar=bars.get(Date.parse(date));
        if(!bar){
          result.unavailable.push({asset:asset.key,date,reason:'SETTLEMENT_CANDLE_UNVERIFIED'});continue;
        }
        const proof=await readForwardProof(asset.key,{dir,date,includeEvidence:true});
        if(!proof)continue;
        if(proof.venueVeto){
          result.unavailable.push({asset:asset.key,date,reason:'VENUE_VETO'});continue;
        }
        if(!proof.dispatch){
          result.unavailable.push({asset:asset.key,date,reason:'NO_PREOPEN_HANDOFF'});continue;
        }
        const {evaluateDecisionProof}=await import('./brain-decision-proof.mjs');
        const options={assetKey:asset.key,date,checkedAt:observedAt};
        const decision=evaluateDecisionProof(proof,options);
        if(decision.status==='blocked')throw Error(decision.reason || 'PAPER_EXECUTION_BLOCKED');
        const {intent}=proof;
        if(['key','venue','market','quote'].some(field=>intent.asset[field]!==asset[field]))throw Error('Settlement market changed');
        if(captured<Date.parse(date)+day)throw Error('Settlement candle postdates its capture');
        const closingSource=await readSourceObservation(asset.key,{dir,archiveSha256,date:today,before:observedAt});
        if(!settlementCandleChecked(closingSource,intent.scheduledOpenAt)){
          result.unavailable.push({asset:asset.key,date,reason:'SETTLEMENT_CANDLE_UNVERIFIED'});continue;
        }
        const closingEvidence=await readSourceObservationEvidence(asset.key,{dir,id:closingSource.id});
        const execution=settleForwardIntent(intent,bar,{observedAt});
        if(execution.amount>proof.dispatch.document.maxNotional ||
          (proof.dispatch.document.disposition==='hold_cash' && execution.status!=='skipped'))throw Error('PAPER_LIMIT_BREACH');
        const receipt={protocol:'venue-settlement-v2',settlementObservationId:closingSource.id,commitSha256:proof.id,dispatchSha256:proof.dispatch.sha256,comparisonPlanSha256:proof.comparisonPlan?.sha256??null,archiveSha256,bar,capturedAt:new Date(captured).toISOString(),
          venue:asset.venue,market:asset.market,observedAt,execution};
        const receiptHash=digest(JSON.stringify(receipt));
        const reconciled=evaluateDecisionProof({...proof,status:'settled',receipt:execution,receiptHash,
          reconciledAt:observedAt,executionBar:bar,settlement:{document:receipt,sha256:receiptHash},settlementArchive:archive,settlementVenueEvidence:closingEvidence},options);
        if(reconciled.status!=='verified')throw Error(reconciled.reason || 'UNVERIFIED_RECEIPT');
        await saveEvidence();
        const stored=await storeDocument(receiptFile,receipt);
        if(stored.saved)result.settled++;
      }
      const commitFile=path.join(marketDir,nextDate,'commit.json');
      if(await optionalRead(commitFile)!==null){
        if(await readDocument(path.join(marketDir,nextDate,'dispatch.json'))===null){
          if(await handOff(asset.key,nextDate,dir,clock))result.dispatched++;
        }
        await registerControls(asset.key,nextDate,dir,clock);
        result.unchanged++;continue;
      }
      const intent=buildForwardIntent(archive,{assetKey:asset.key,observedAt});
      if(Date.parse(intent.scheduledOpenAt)!==Date.parse(nextDate))throw Error('Unexpected forward session');
      const source=await readSourceObservation(asset.key,{dir,date:today,archiveSha256,before:observedAt});
      const sourceFailure=observationReason(source);
      if(sourceFailure){
        await recordRefusal(sourceFailure,observedAt,{version:'venue-refusal-v2',sourceObservationId:source?.id??null});
        result.unavailable.push({asset:asset.key,reason:sourceFailure});continue;
      }
      await saveEvidence();
      // Take the server time again immediately before publishing the frozen intent.
      const recordedAt=new Date(clock()).toISOString();
      if(Date.parse(recordedAt)<Date.parse(observedAt) || Date.parse(recordedAt)+60000>=Date.parse(nextDate)){
        if(recordedAt>=observedAt && Date.parse(recordedAt)<Date.parse(nextDate))await recordRefusal('MISSED_COMMIT_WINDOW',recordedAt);
        result.unavailable.push({asset:asset.key,reason:'MISSED_COMMIT_WINDOW'});continue;
      }
      const stored=await storeDocument(commitFile,{recordedAt,archiveSha256,protocol:venueProtocol,sourceObservationId:source.id,intent});
      if(stored.saved)result.registered++;else result.unchanged++;
      if(await handOff(asset.key,nextDate,dir,clock))result.dispatched++;
      await registerControls(asset.key,nextDate,dir,clock);
    }catch(error){
      if(['STALE_EVIDENCE','INSUFFICIENT_EVIDENCE','INVALID_EVIDENCE'].includes(error.code)){
        await recordRefusal(error.code,observedAt);
      }
      if(['STALE_EVIDENCE','INSUFFICIENT_EVIDENCE'].includes(error.code)){
        result.unavailable.push({asset:asset.key,reason:error.code});
      }else{
        result.failed.push({asset:asset.key,reason:error.code || error.message});
      }
    }
  }
  return result;
}

export async function readForwardProof(assetKey,{dir=forwardDirectory(),date,includeEvidence=false}={}){
  if(typeof assetKey!=='string' || !assetKey || (date!==undefined && !datePattern.test(date)))return null;
  const marketDir=seriesDirectory(dir,assetKey);
  const dates=date?[date]:(await tradingDates(marketDir)).reverse();
  for(const targetDate of dates){
    const commit=await readDocument(path.join(marketDir,targetDate,'commit.json'));
    if(!commit)continue;
    const {intent,recordedAt,archiveSha256}=commit.document;
    const dispatch=await readDocument(path.join(marketDir,targetDate,'dispatch.json'));
    const receipt=await readDocument(path.join(marketDir,targetDate,'receipt.json'));
    if(receipt && receipt.document.commitSha256!==commit.sha256)throw Error('Receipt does not match commit');
    const folder=path.join(marketDir,targetDate);
    const [comparisonPlan,venueVeto]=await Promise.all(['comparison.json','venue-veto.json'].map(file=>readDocument(path.join(folder,file))));
    const proof={id:commit.sha256,dispatch,comparisonPlan,venueVeto,status:receipt?'settled':'pending',recordedAt,targetOpenAt:intent.scheduledOpenAt,
      selected:intent.selected,riskMode:intent.risk.mode,quote:intent.asset.quote,archiveSha256,intent,
      receipt:receipt?.document.execution??null,receiptHash:receipt?.sha256??null,
      reconciledAt:receipt?.document.observedAt??null,executionBar:receipt?.document.bar??null};
    if(!date){
      // The newest registration is usually pending. Keep completed trials reachable.
      proof.recent=[];
      for(const previous of dates.filter(d=>d<targetDate).slice(0,14)){
        const prior=await readDocument(path.join(marketDir,previous,'commit.json'));
        if(!prior)continue;
        const result=await readDocument(path.join(marketDir,previous,'receipt.json'));
        if(result && result.document.commitSha256!==prior.sha256)throw Error('Receipt does not match commit');
        proof.recent.push({date:previous,id:prior.sha256,selected:prior.document.intent.selected,
          status:result?'settled':'pending',action:result?.document.execution.status??null,netPnl:result?.document.execution.netPnl??null});
      }
    }
    if(includeEvidence){
      const bytes=await readFile(path.join(dir,'evidence',archiveSha256+'.json'));
      if(digest(bytes)!==archiveSha256)throw Error('Archived source failed digest verification');
      // Return the entire content-addressed input so its public digest can be recomputed.
      proof.archive=JSON.parse(bytes);
      proof.commit=commit;
      proof.settlement=receipt;
      if(commit.document.sourceObservationId)proof.venueEvidence=await readSourceObservationEvidence(assetKey,{dir,id:commit.document.sourceObservationId});
      if(venueVeto)proof.vetoEvidence=await readSourceObservationEvidence(assetKey,{dir,id:venueVeto.document.observationId});
      if(receipt){
        if(receipt.document.settlementObservationId)proof.settlementVenueEvidence=await readSourceObservationEvidence(assetKey,{dir,id:receipt.document.settlementObservationId});
        const sha=receipt.document.archiveSha256;
        const closing=await readFile(path.join(dir,'evidence',sha+'.json'));
        if(digest(closing)!==sha)throw Error('Settlement source failed digest verification');
        proof.settlementArchive=JSON.parse(closing);
      }
    }
    return proof;
  }
  return null;
}

// Rebuild a downloaded public record, including its frozen decision and the modeled fill.
export function verifyForwardProof(proof){
  const {archive,commit,settlement}=proof;
  if(!archive || !commit || digest(JSON.stringify(commit.document))!==commit.sha256 || proof.id!==commit.sha256)
    throw Error('Commit digest mismatch');
  const {intent,recordedAt,archiveSha256}=commit.document;
  if(digest(JSON.stringify(archive))!==archiveSha256)throw Error('Evidence digest mismatch');
  const observed=Date.parse(intent.observedAt),recorded=Date.parse(recordedAt);
  if(!(observed<=recorded && recorded<Date.parse(intent.scheduledOpenAt)))throw Error('Invalid commitment time');
  const rebuilt=buildForwardIntent(archive,{assetKey:intent.assetKey,observedAt:intent.observedAt});
  if(JSON.stringify(rebuilt)!==JSON.stringify(intent))throw Error('Decision replay mismatch');
  if(settlement){
    const row=settlement.document;
    if(digest(JSON.stringify(proof.settlementArchive))!==row.archiveSha256)throw Error('Settlement archive digest mismatch');
    const source=validateProofMarket(proof.settlementArchive,intent.assetKey);
    const candle=source.bars.find(bar=>bar[0]*1000===Date.parse(intent.scheduledOpenAt));
    if(digest(JSON.stringify(row))!==settlement.sha256 || row.commitSha256!==commit.sha256 ||
      source.asset.market!==row.market || source.asset.venue!==row.venue || source.fetched!==Date.parse(row.capturedAt) ||
      JSON.stringify(candle)!==JSON.stringify(row.bar) ||
      row.venue!==intent.asset.venue || row.market!==intent.market ||
      !(Date.parse(row.capturedAt)<=Date.parse(row.observedAt) && Date.parse(row.capturedAt)>=Date.parse(intent.scheduledOpenAt)+day))
      throw Error('Settlement digest or provenance mismatch');
    const rebuiltExecution=settleForwardIntent(intent,row.bar,{observedAt:row.observedAt});
    if(JSON.stringify(rebuiltExecution)!==JSON.stringify(row.execution))throw Error('Execution replay mismatch');
  }
  return {id:commit.sha256,asset:intent.assetKey,targetOpenAt:intent.scheduledOpenAt,status:settlement?'settled':'pending'};
}
