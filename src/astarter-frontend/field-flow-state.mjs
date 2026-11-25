// Visual evidence identities only; no market scores or model confidence.
import {smooth} from './strategy-state.mjs';
export const FIELD_REVISION_SECONDS=7.2;
export const EVIDENCE_PER_ROLE=24;
export const REPLACED_PER_ROLE=6;
export function fieldRecruitment(index,elapsed,reduced=false){
 return reduced?{detect:1,gather:1,assemble:1}:{detect:smooth((elapsed-.8-index*.18)/1.8),gather:smooth((elapsed-3.2-index*.2)/3.0),assemble:smooth((elapsed-7.0-index*.22)/3.7)};
}
export function fieldRevision(progress){
 return{arrive:smooth(progress/.28),gather:smooth((progress-.20)/.27),transfer:smooth((progress-.44)/.34),retire:smooth((progress-.72)/.22),stage:progress<.28?'locate':progress<.50?'gather':progress<.90?'replace':'resume'};
}
export function replacedSlot(generation,slot){return generation>0&&Math.floor(slot/REPLACED_PER_ROLE)===(generation-1)%4;}
export function evidenceStamp(generation,slot){
 if(generation<1)return 0;
 const last=generation-((generation-1-Math.floor(slot/REPLACED_PER_ROLE))%4+4)%4;
 return Math.max(0,last);
}
