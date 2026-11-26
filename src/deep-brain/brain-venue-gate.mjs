// New forward registrations require a second venue read of the decision's full input window.
// The Nov 27 UTC session had already been committed when this protocol was introduced.
import {verifySourceObservation} from './brain-source-observations.mjs';

export const venueProtocol='venue-observed-v2';
const firstRequiredSession='2026-11-28T00:00:00.000Z';
export function observationReason(record){
  if(!record)return 'SOURCE_OBSERVATION_MISSING';
  if(record.status==='matched')return null;
  return {conflict:'SOURCE_OBSERVATION_CONFLICT',unavailable:'SOURCE_OBSERVATION_UNAVAILABLE',
    stale:'SOURCE_OBSERVATION_STALE'}[record.status]??'SOURCE_OBSERVATION_INVALID';
}
export function checkVenueInputs(proof){
  const {intent,sourceObservationId,protocol}=proof.commit.document;
  if(protocol===undefined && sourceObservationId===undefined && intent.scheduledOpenAt<firstRequiredSession){
    return {status:'not_recorded_at_registration',reason:'legacy_registration'};
  }
  if(protocol!==venueProtocol || !/^[a-f0-9]{64}$/.test(sourceObservationId??'') || !proof.venueEvidence){
    return {status:'blocked',reason:'venue_observation_missing'};
  }
  const {observation,rawResponse,archiveText}=proof.venueEvidence;
  try{
    const row=verifySourceObservation(observation,rawResponse,archiveText,{id:sourceObservationId,
      assetKey:intent.assetKey,archiveSha256:proof.archiveSha256,before:intent.observedAt,date:intent.observedAt.slice(0,10)});
    if(row.status!=='matched' || row.totalBars!==intent.barCount || row.matchedBars!==intent.barCount ||
       row.windowStartAt!==intent.evidenceStartAt || row.windowEndAt!==intent.asOf ||
       row.market!==intent.market || row.venue!==intent.asset.venue || row.quote!==intent.quote){
      return {status:'blocked',reason:'venue_observation_mismatch'};
    }
    return {status:'verified',id:row.id,observedAt:row.observedAt,windowStartAt:row.windowStartAt,
      windowEndAt:row.windowEndAt,market:row.market,venue:row.venue,matchedBars:row.matchedBars,rawSha256:row.rawSha256};
  }catch{return {status:'blocked',reason:'venue_observation_invalid'};}
}

export function checkVenueVeto(proof,checkedAt){
  const {venueVeto,vetoEvidence}=proof;
  if(!venueVeto)return null;
  const doc=venueVeto.document,at=Date.parse(doc.issuedAt);
  if(!vetoEvidence || doc.version!=='venue-veto-v1' || doc.assetKey!==proof.intent.assetKey ||
     doc.commitId!==proof.id || doc.dispatchId!==proof.dispatch?.sha256 || doc.date!==proof.targetOpenAt.slice(0,10) ||
     !(Date.parse(proof.dispatch.document.issuedAt)<=at && at<Date.parse(proof.targetOpenAt) && at<=checkedAt)){
    return 'unverified_venue_veto';
  }
  try{
    const {observation,rawResponse,archiveText}=vetoEvidence;
    const row=verifySourceObservation(observation,rawResponse,archiveText,{assetKey:doc.assetKey,id:doc.observationId,
      before:at,date:proof.intent.observedAt.slice(0,10)});
    return row.status==='conflict' && row.observedAt>=proof.recordedAt && row.windowEndAt===proof.intent.asOf?
      'venue_conflict_veto':'unverified_venue_veto';
  }catch{return 'unverified_venue_veto';}
}

export function settlementCandleChecked(observation,targetOpenAt){
  return observation?.httpStatus===200 && ['matched','conflict'].includes(observation.status) &&
    Date.parse(observation.observedAt)>=Date.parse(targetOpenAt)+86400000 &&
    observation.checks.some(check=>check.openAt===targetOpenAt && check.status==='matched');
}
export function checkSettlementInputs(proof){
  const doc=proof.settlement.document;
  if(doc.protocol===undefined && doc.settlementObservationId===undefined && !proof.commit.document.protocol &&
     proof.targetOpenAt<firstRequiredSession)return {status:'not_recorded_at_settlement'};
  try{
    if(doc.protocol!=='venue-settlement-v2' || !/^[a-f0-9]{64}$/.test(doc.settlementObservationId??''))throw Error();
    const {observation,rawResponse,archiveText}=proof.settlementVenueEvidence;
    const row=verifySourceObservation(observation,rawResponse,archiveText,{assetKey:proof.intent.assetKey,
      id:doc.settlementObservationId,archiveSha256:doc.archiveSha256,before:doc.observedAt});
    if(!settlementCandleChecked(row,proof.targetOpenAt))throw Error();
    return {status:'verified',id:row.id,targetOpenAt:proof.targetOpenAt,observedAt:row.observedAt,rawSha256:row.rawSha256};
  }catch{return {status:'blocked',reason:'settlement_venue_observation_invalid'};}
}
