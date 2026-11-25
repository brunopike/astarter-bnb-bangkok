import {OPERATIONS,requestResearch,recordDisposition,researchAvailability} from './research-operations.mjs';
import {evidenceProcess} from './evidence-process.mjs';
import {ROLES} from './simulation.mjs';
const key='hive-research.records.v1';
export function createResearchDesk({model,market,onWork,onChange,notice}){
 const el=document.createElement('section');el.className='research-desk reactor-only';
 el.innerHTML='<div class="desk-heading"><h3>调度 Agent</h3><span>本轮研究</span></div><div class="desk-actions"><button data-work="sample"><b>↗</b><span>补充采样<small>收集新的环境证据</small></span></button><button data-work="challenge"><b>⇄</b><span>独立反证<small>检验当前结论的反向条件</small></span></button><button data-work="risk"><b>◇</b><span>风险复核<small>补查本轮保护条件</small></span></button></div><div class="desk-tasks" aria-label="研究任务状态"></div><div class="desk-heading"><h3>处理研究结果</h3><span class="desk-gate"></span></div><div class="desk-decisions"><button data-choice="watch">保留观察</button><button data-work="recheck">退回复核</button><button data-choice="hold">暂缓</button></div><p class="desk-feedback" role="status">证据筛选完成后，可处理本轮结果。</p><details class="desk-history"><summary>本地研究记录 <b>0</b></summary><ol></ol></details>';
 document.querySelector('#pane-run').append(el);
 let records=[];try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved))records=saved.filter(r=>r?.mode==='simulation-only'&&typeof r.id==='string').slice(0,12);}catch{}
 const feedback=el.querySelector('.desk-feedback');let lastSignature='';
 function update(){const p=evidenceProcess(model),tasks=p.history.filter(i=>i.event.operation).slice(-3),done=records.some(r=>r.id===`${model.runId}:${p.revision}`);
  el.querySelector('.desk-gate').textContent=done?'本版已记录':p.ready?'待处理':'采集与核验中';
  for(const b of el.querySelectorAll('[data-work]')){const available=researchAvailability(model,b.dataset.work);b.disabled=!available.ok;b.title=available.ok?'派发本地模拟研究任务':available.message;}
  for(const b of el.querySelectorAll('[data-choice]'))b.disabled=!p.ready||done||(b.dataset.choice==='watch'&&(p.counts.conflict>0||p.counts.missing>0));
  const signature=tasks.map(i=>i.id+':'+i.stage).join('|')+records.length;
  if(signature!==lastSignature){lastSignature=signature;const list=el.querySelector('.desk-tasks');list.replaceChildren();for(const item of tasks){const row=document.createElement('div');row.className='desk-task';const name=document.createElement('span');name.textContent=`${ROLES[item.role].id} · ${OPERATIONS[item.event.operation]}`;const status=document.createElement('small');status.textContent=['前往来源','正在采样','携回证据','递交核心','筛选中','已完成'][item.stage];row.append(name,status);row.dataset.stage=item.stage;list.append(row);}
   el.querySelector('summary b').textContent=records.length;const history=el.querySelector('.desk-history ol');history.replaceChildren();for(const r of records.slice(0,5)){const li=document.createElement('li');li.textContent=`${r.market} · ${r.choice==='watch'?'保留观察':'暂缓'} · ${r.title}`;history.append(li);}
  }
  if(done){const r=records.find(r=>r.id===`${model.runId}:${p.revision}`);document.querySelector('#research-result-label').textContent=r.choice==='watch'?'已保留观察 · 本地记录':'已暂缓 · 本地记录';}
  el.dataset.ready=p.ready;el.dataset.records=records.length;
 }
 for(const b of el.querySelectorAll('[data-work]'))b.onclick=()=>{const result=requestResearch(model,b.dataset.work);feedback.textContent=result.message;if(result.ok)onWork();notice(result.message);onChange();};
 for(const b of el.querySelectorAll('[data-choice]'))b.onclick=()=>{const result=recordDisposition(model,market(),b.dataset.choice,records);if(result.ok){const next=[result.record,...records].slice(0,12);try{const value=JSON.stringify(next);localStorage.setItem(key,value);if(localStorage.getItem(key)!==value)throw Error('readback');records=next;model.disposition=result.record;feedback.textContent=result.message+' · 已保存到本浏览器';}catch{feedback.textContent='保存失败，本轮仍可重新处理。';}}else feedback.textContent=result.message;onChange();};
 return {update,reset(){feedback.textContent='证据筛选完成后，可处理本轮结果。';lastSignature='';},get records(){return records;}};
}
