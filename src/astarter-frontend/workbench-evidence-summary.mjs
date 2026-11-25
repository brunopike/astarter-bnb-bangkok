import {pair as L} from './locale.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const states=[
 ['pending','待采集','Pending'],['collected','待核对','To review'],
 ['retain','已核对','Reviewed'],['context','背景参考','Context only'],
 ['conflict','存在冲突','Conflicting'],['missing','资料不足','More needed'],
 ['unknown','待核验','Unverified']
];
const knownStates=new Set([...states.map(([status])=>status),'na']);
const label=status=>{const [,zh,en]=states.find(row=>row[0]===status);return L(zh,en);};

export function summarizeEvidence(evidence){
 const sources=new Map();
 for(const item of Array.isArray(evidence)?evidence:[]){
  if(typeof item?.key!=='string'||!item.key.trim())continue;
  const key=item.key.trim(),status=knownStates.has(item.status)?item.status:'unknown';
  sources.set(key,sources.has(key)&&sources.get(key)!==status?'unknown':status);
 }
 const counts=new Map();
 for(const status of sources.values())counts.set(status,(counts.get(status)||0)+1);
 const notApplicable=counts.get('na')||0;
 return {total:sources.size,applicable:sources.size-notApplicable,notApplicable,
  segments:states.filter(([status])=>counts.has(status)).map(([status])=>({status,count:counts.get(status)}))};
}

export function workbenchEvidenceSummary(evidence,id='workbench-evidence'){
 const summary=summarizeEvidence(evidence);
 if(!summary.total)return `<p class="insight-evidence-empty">${esc(L('暂无依据','No evidence yet'))}</p>`;
 const maskId=String(id).replace(/[^a-zA-Z0-9_-]/g,'-')+'-dots-mask';
 let offset=0;
 const arcs=summary.segments.map(({status,count})=>{
  const portion=count/summary.applicable,gap=summary.segments.length>1?Math.min(.012,portion/4):0;
  const length=Number((portion-gap).toFixed(6)),dash=`${length} ${Number((1-length).toFixed(6))}`,start=Number((-(offset+gap/2)).toFixed(6));
  offset+=portion;
  return `<g class="insight-evidence-arc" data-evidence-state="${status}"><title>${esc(label(status))}: ${count}</title><circle class="insight-evidence-halo" cx="50" cy="50" r="40" pathLength="1" stroke-dasharray="${dash}" stroke-dashoffset="${start}"/><circle class="insight-evidence-dots" cx="50" cy="50" r="40" pathLength="1" stroke-dasharray="${dash}" stroke-dashoffset="${start}" mask="url(#${maskId})"/></g>`;
 }).join('');
 // Radial grain adapts the 21st Dither Donut's density layers without its random animation.
 let ring='';
 if(summary.applicable){
  const grain=[[36.2,.7,.24],[38.1,1.05,.62],[40,1.4,1],[41.9,1.05,.62],[43.8,.7,.24]].map(([r,width,opacity],index)=>{
   const spacing=2*Math.PI*r/Math.round(2*Math.PI*r/2.5);
   return `<circle class="insight-evidence-grain-row" cx="50" cy="50" r="${r}" stroke-width="${width}" opacity="${opacity}" stroke-dasharray=".001 ${Number((spacing-.001).toFixed(4))}" stroke-dashoffset="${index%2?Number((spacing/2).toFixed(4)):0}"/>`;
  }).join('');
  ring=`<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><g fill="none" stroke="white" stroke-linecap="round">${grain}</g></mask></defs><g transform="rotate(-90 50 50)">${arcs}</g></svg>`;
 }
 return `<div class="insight-evidence-summary" data-has-ring="${Boolean(summary.applicable)}"><div class="insight-evidence-total">${ring}<strong>${summary.applicable}</strong></div><div class="insight-evidence-breakdown"><p class="insight-evidence-label">${esc(L('适用来源','Applicable sources'))}</p><dl class="insight-evidence-counts">${summary.segments.map(({status,count})=>`<div data-evidence-state="${status}"><dt><i aria-hidden="true"></i>${esc(label(status))}</dt><dd>${count}</dd></div>`).join('')}</dl>${summary.notApplicable?`<p class="insight-evidence-na"><span>${esc(L('不适用','Not applicable'))}</span><strong>${summary.notApplicable}</strong></p>`:''}</div></div>`;
}
