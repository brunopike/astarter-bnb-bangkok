import { ROLES } from './simulation.mjs';
import { researchSnapshot } from './research-state.mjs';
import {uiGlyph} from './product-composition.mjs';
const stamp=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const statusNames={idle:'本轮无采证任务',done:'输出已留存',running:'处理中',queued:'等待处理',cancelled:'已中止'};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createResearchJournal(stage){
  const process=document.createElement('nav');process.className='research-process reactor-only';process.setAttribute('aria-label','本轮研究过程');
  process.innerHTML=['采集回传','核心汇聚','证据筛选','结论形成'].map((name,i)=>`<button data-research-phase="${i}" type="button"><span>0${i+1}</span>${name}<i></i></button>`).join('');stage.append(process);
  const dialog=document.createElement('dialog');dialog.className='research-dialog';dialog.setAttribute('aria-labelledby','research-title');dialog.innerHTML='<header><div><p id="research-snapshot-label"></p><h2 id="research-title">研究记录</h2></div><button type="button" class="journal-close" aria-label="关闭研究记录">'+uiGlyph('close')+'</button></header><nav aria-label="研究记录分类"><button type="button" data-journal-tab="evidence">采集与交接</button><button type="button" data-journal-tab="roles">角色输出</button><button type="button" data-journal-tab="result">结论与下一步</button></nav><div class="research-dialog-content"></div><footer>查看时刻的模拟快照 · 关闭后继续观察最新状态</footer>';document.body.append(dialog);
  let latest=null,snapshot=null,tab='evidence',source=null,focus=null;
  const content=dialog.querySelector('.research-dialog-content');
  const eventsHtml=events=>events.length?`<ol class="journal-events">${events.map(e=>`<li><time>${stamp(e.at)}</time><div><strong>${e.from===null?'系统':`${ROLES[e.from].id} → ${ROLES[e.to].id}`}</strong><p>${escape(e.text)}</p></div></li>`).join('')}</ol>`:'<p class="journal-empty">本轮暂无相关交接。可关闭记录，观察下一次采集。</p>';
  function render(){
    dialog.querySelector('#research-snapshot-label').textContent=`${snapshot.market} 聚焦核验 · 第 ${snapshot.cycle} 轮 · ${stamp(snapshot.at)} · 模拟快照`;
    dialog.querySelector('#research-title').textContent=tab==='evidence'&&source?snapshot.sources.find(s=>s.key===source).name:'研究记录';
    for(const b of dialog.querySelectorAll('[data-journal-tab]'))b.setAttribute('aria-pressed',String(b.dataset.journalTab===tab));
    if(tab==='evidence'){
      const item=source?snapshot.sources.find(s=>s.key===source):null;
      content.innerHTML=(item?`<div class="journal-source"><span>示例读数</span><strong>${item.value}<small>${item.unit}</small></strong><p>${item.description}</p><dl><div><dt>来源</dt><dd>本地合成序列</dd></div><div><dt>相关参与者</dt><dd>${item.activeRoles.map(id=>ROLES[id].id).join(' · ')||'本轮未调度'}</dd></div></dl></div>`:'<p class="journal-lead">按时间查看当前轮次的示例证据交接。点击页面数据卡片，可查看该来源的口径与关联记录。</p>')+eventsHtml(snapshot.events.filter(e=>!item||(e.source?e.source===source:item.activeRoles.includes(e.from)||item.activeRoles.includes(e.to))));
    }else if(tab==='roles'){
      content.innerHTML='<p class="journal-lead">角色按当前方案参与。输出留存表示本次示例任务结束，不代表策略已获批准。</p>'+ROLES.map(role=>snapshot.roles.find(r=>r.id===role.index)||{id:role.index,name:role.name,code:role.id,status:'idle',output:'未生成本轮采证输出。'}).sort((a,b)=>Number(b.id===focus)-Number(a.id===focus)).map(r=>`<article class="journal-role ${focus===r.id?'is-focused':''}"><div><strong>${r.code} · ${r.name}</strong><span>${statusNames[r.status]}</span></div><p>${escape(ROLES[r.id].description)}</p><blockquote>${escape(r.output)}</blockquote>${(snapshot.coordination||[]).filter(j=>j.roles.includes(r.id)).map(j=>`<p class="journal-coordination"><b>当前协作示意 · ${escape(j.title)}</b><br>同伴 ${j.roles.filter(id=>id!==r.id).map(id=>ROLES[id].id).join('、')||'独立检查'}<br>关联 ${escape(j.trigger)}</p>`).join('')}</article>`).join('');
    }else{
      content.innerHTML=`<article class="journal-result"><span>${snapshot.disposition?(snapshot.disposition.choice==='watch'?'已保留观察 · 本地记录':'已暂缓 · 本地记录'):snapshot.interrupted?'中止记录':snapshot.complete?'本轮观察结论':'处理中 · 尚未形成结论'}</span><h3>${snapshot.result}</h3><p>${snapshot.detail}</p></article><div class="journal-evidence-decisions">${snapshot.process.items.filter(i=>i.stage===5).map(i=>`<p><b>${i.name} · ${i.label}</b><br>${i.reason}</p>`).join('')}</div><h3>下一步</h3><p class="journal-lead">${snapshot.next}</p><div class="journal-gates"><h3>从研究进入策略</h3><p>完整交易引擎流程尚未接入；右侧交易页可体验预设信号与成交回报的本地模拟。</p><ol><li><b>规则草稿</b><span>明确入场、退出、仓位与失效条件。</span></li><li><b>验证与 ABC</b><span>版本校验、规则回放、成本及异常情景。</span></li><li><b>绑定与审阅</b><span>绑定模拟账户后，完成同一预案的必需角色审阅。</span></li><li><b>用户激活</b><span>用户确认后才进入模拟运行，再复盘与迭代。</span></li></ol></div>`;
    }
    content.scrollTop=0;
  }
  function open(nextTab='evidence',key=null,role=null){if(!latest)return;snapshot=structuredClone(latest);tab=nextTab;source=key;focus=role??latest.selected;render();dialog.showModal();dialog.querySelector('.journal-close').focus();}
  dialog.querySelector('.journal-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  for(const b of dialog.querySelectorAll('[data-journal-tab]'))b.onclick=()=>{tab=b.dataset.journalTab;render();};
  for(const b of process.children)b.onclick=()=>open(Number(b.dataset.researchPhase)>1?'result':'evidence');
  return {open,update(model,market,options){latest=researchSnapshot(model,market,options);for(const [i,b] of [...process.children].entries()){b.dataset.state=i<latest.phase?'past':i===latest.phase?'current':'next';b.setAttribute('aria-current',i===latest.phase?'step':'false');}process.dataset.ended=String(latest.interrupted);return latest;},dispose(){process.remove();dialog.remove();}};
}
