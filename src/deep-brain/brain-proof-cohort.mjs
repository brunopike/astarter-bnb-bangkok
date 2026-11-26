import {buildBrainProof,PROOF_VERSION} from './brain-proof-engine.mjs';

const DAY=86400000;
function median(values){
  if(!values.length)return null;
  const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2;
}
// Every market is counted once. USD and USDT results are compared as percentage returns.
export function buildProofCohort(archive,{days=90,onRun}={}){
  if(![30,90,180,365].includes(days))throw Object.assign(Error('Unsupported calendar window'),{code:'INVALID_WINDOW'});
  const capture=Date.parse(archive.updatedAt??archive.retrievedAt);
  if(!Number.isFinite(capture)||!Array.isArray(archive.assets))throw Error('Invalid daily market archive');
  const endExclusive=Math.floor(capture/DAY)*DAY;
  const startAt=new Date(endExclusive-days*DAY).toISOString(),endAt=new Date(endExclusive-1).toISOString();
  const rows=archive.assets.map(asset=>{
    const row={assetKey:asset.key,symbol:asset.symbol};
    if(asset.bars?.at(-1)?.[0]*1000!==endExclusive-DAY)return {...row,eligible:false,reason:'outside_common_window'};
    try{
      const run=buildBrainProof(archive,{assetKey:asset.key,days});
      const s=run.summary;
      if(s.startAt!==startAt||s.endAt!==endAt||s.observations!==days)return {...row,eligible:false,reason:'incomplete_window'};
      onRun?.(run);
      return {...row,eligible:true,runId:run.runId,trades:s.trades,netReturnPct:s.netReturnPct,
        buyHoldReturnPct:s.buyHoldReturnPct,excessPct:s.excessVsBuyHoldPct,maxDrawdownPct:s.maxDrawdownPct};
    }catch(error){
      if(!['INSUFFICIENT_EVIDENCE','INVALID_EVIDENCE','UNSUPPORTED_ASSET'].includes(error.code))throw error;
      return {...row,eligible:false,reason:error.code.toLowerCase()};
    }
  });
  const covered=rows.filter(row=>row.eligible);
  return {version:PROOF_VERSION,mode:'historical_replay',startAt,endAt,days,totalAssets:rows.length,coveredAssets:covered.length,
    positiveAssets:covered.filter(r=>r.netReturnPct>0).length,negativeAssets:covered.filter(r=>r.netReturnPct<0).length,
    flatAssets:covered.filter(r=>r.netReturnPct===0).length,beatHoldAssets:covered.filter(r=>r.excessPct>0).length,
    medianNetReturnPct:median(covered.map(r=>r.netReturnPct)),medianExcessPct:median(covered.map(r=>r.excessPct)),rows};
}
