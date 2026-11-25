import {orderSideLabel} from './order-markets.mjs';
import {decorateIdentity} from './brand-icons.mjs';
// Product adaptation of Roman Vasnev's Web3Bento and Ruixen's Pill Morph Tabs.
// Source references and untouched React originals: .goodway/bento-system-v034/.
// Native modules preserve the existing simulation, chart and route contracts.
import {CRYPTO} from './data-center-fixtures.mjs';
import {L} from './execution-views.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:2});
const signed=n=>(n>0?'+':'')+n.toFixed(2)+'%';
let bound=false,marketExtrasOpen=false;
function wireReadout(host,selector,initial,read){
 const output=host.querySelector('[data-bento-readout]');if(!output)return;
 const update=ev=>{const item=ev.target.closest(selector);if(item&&host.contains(item))output.textContent=read(item);};
 host.addEventListener('pointerover',update);host.addEventListener('focusin',update);
 host.addEventListener('pointerleave',()=>{if(!host.contains(document.activeElement))output.textContent=initial;});
 host.addEventListener('focusout',ev=>{if(!host.contains(ev.relatedTarget))output.textContent=initial;});
}
export function marketPulse(){
 const up=CRYPTO.filter(a=>a.change>0).length,down=CRYPTO.filter(a=>a.change<0).length,max=Math.max(...CRYPTO.map(a=>Math.abs(a.change)),.01);
 const initial=L('点选色柱查看行情','Select a bar to open its market');
 return `<section class="bento-pulse" data-localized-ui><header><h2>${L('涨跌分布','Market breadth')} <details class="dc-info"><summary aria-label="${L('了解涨跌分布','About market breadth')}">i</summary><div>${L('仅统计这里的 24 个加密资产样本，不代表全市场。每根色柱对应一个资产，高度为 24h 涨跌幅的绝对值，绿色上涨、红色下跌。','Counts the 24 demo crypto assets shown here, not the entire market. Each bar is one asset; its height is the absolute 24h change, green for gains and red for losses.')}</div></details></h2><span>24h</span></header><div class="bento-pulse-title"><div><strong>${up}<small> / ${CRYPTO.length}</small></strong><span>${L('个资产上涨','assets rising')}</span></div></div><div class="bento-bars" aria-label="${L('样例资产 24 小时涨跌','Demo asset changes over 24 hours')}">${CRYPTO.map((a,i)=>`<a href="?page=markets&asset=${a.symbol}" class="${a.change>=0?'up':'down'}" style="--bar-height:${18+Math.abs(a.change)/max*82}%;--bar-delay:${i*14}ms" data-pulse-asset="${a.symbol}" aria-label="${a.symbol} ${signed(a.change)}"><span></span></a>`).join('')}</div><footer><span data-bento-readout>${initial}</span><span><i></i>${up} ${L('涨','up')}<i class="down"></i>${down} ${L('跌','down')}</span></footer></section>`;
}
function creditMeter(root,w){
 const summary=root.querySelector('.ux-metrics,.biz-stats');if(!summary||!w)return;
 summary.classList.add('bento-credit-summary');
 const amount=Math.max(0,w.available),held=Math.max(0,w.reserved),used=Math.max(0,w.spent),total=amount+held+used||1;
 const bar=document.createElement('div');bar.className='bento-credit-track';bar.setAttribute('role','img');bar.setAttribute('aria-label',L(`可用 ${amount}，暂占 ${held}，已用 ${used}`,`Available ${amount}, held ${held}, used ${used}`));
 bar.innerHTML=`<i style="width:${amount/total*100}%"></i><i style="width:${held/total*100}%"></i><i style="width:${used/total*100}%"></i>`;summary.append(bar);
}
function adaptMobileMarket(root){
 if(!root)return;
 const data=root.querySelector('[data-data-center="markets"]'),ranks=data?.querySelector('.dc-rank-grid');
 if(!ranks)return;
 const compact=matchMedia('(max-width:900px)').matches,fold=data.querySelector('.dc-phone-market-fold');
 if(compact&&!fold){
  const list=data.querySelector('.dc-market-toolbar')?.closest('.dc-panel');if(!list)return;
  const slot=document.createElement('span');slot.hidden=true;slot.dataset.marketRankSlot='';ranks.before(slot);
  const details=document.createElement('details');details.className='dc-phone-market-fold';details.open=marketExtrasOpen;
  const summary=document.createElement('summary');summary.textContent=L('市场概况与排行榜','Market overview & rankings');details.append(summary);
  const pulse=data.querySelector('.bento-market-kpis>.bento-pulse');
  if(pulse){const pulseSlot=document.createElement('span');pulseSlot.hidden=true;pulseSlot.dataset.marketPulseSlot='';pulse.before(pulseSlot);details.append(pulse);}
  details.append(ranks);list.after(details);
  const grid=data.querySelector('.bento-market-kpis');if(grid){grid.tabIndex=0;grid.setAttribute('role','region');grid.setAttribute('aria-label',L('市场指标，可左右滑动','Market metrics, swipe horizontally'));}
  details.addEventListener('toggle',()=>{if(details.isConnected)marketExtrasOpen=details.open;});
 }else if(!compact&&fold){
  const pulse=fold.querySelector('.bento-pulse');if(pulse)data.querySelector('[data-market-pulse-slot]')?.replaceWith(pulse);
  data.querySelector('[data-market-rank-slot]')?.replaceWith(ranks);fold.remove();
  const grid=data.querySelector('.bento-market-kpis');if(grid){grid.removeAttribute('tabindex');grid.removeAttribute('role');grid.removeAttribute('aria-label');}
 }
}
export function decorateBento(root,page,{account=null,credits=null}={}){
 decorateIdentity(root);
 if(!bound){bound=true;window.addEventListener('resize',()=>adaptMobileMarket(document.getElementById('product-page')),{passive:true});}
 for(const link of document.querySelectorAll('.biz-mobile-nav [data-page]')){
  if(link.querySelector('svg'))continue;
  const icon=document.querySelector(`.product-nav a[data-page="${link.dataset.page}"] svg`);if(icon)link.prepend(icon.cloneNode(true));
 }
 if(page==='workbench')return;
 // These page headers label a workspace; their generic introductions repeat its controls.
 if(['execution','logs','assets','opportunities','tracking','derivatives','etf','settings','usage','mandate','contributions','inbox','validation'].includes(page))root.querySelectorAll('.p-head>div:first-child>p,.tc-head>div:first-child>p').forEach(p=>p.remove());
 if(page==='contributions')root.querySelector('.ux-copy-banner')?.remove();
 if(page==='strategies'){
  const intro=root.querySelector('.sc-intro-row');
  intro?.querySelector('.sc-intro-main')?.remove();intro?.classList.add('compact-strategy-intro');
 }
 // Keep the active secondary route reachable on compact screens.
 requestAnimationFrame(()=>{for(const nav of root.querySelectorAll('.biz-subnav,.dc-section-nav:not(.data-subtabs)')){const active=nav.querySelector('[aria-current=page],.selected');if(active&&nav.scrollWidth>nav.clientWidth){const n=nav.getBoundingClientRect(),a=active.getBoundingClientRect();if(a.right>n.right||a.left<n.left)nav.scrollLeft+=a.left-n.left-(nav.clientWidth-a.width)/2;}}});
 if(page==='markets'&&!new URLSearchParams(location.search).get('asset')){
  const grid=root.querySelector('.dc-compact-kpis');
  if(grid&&!grid.querySelector('.bento-pulse')){grid.classList.add('bento-market-kpis');grid.insertAdjacentHTML('afterbegin',marketPulse());const pulse=grid.querySelector('.bento-pulse');wireReadout(pulse,'[data-pulse-asset]',pulse.querySelector('[data-bento-readout]').textContent,el=>{const a=CRYPTO.find(a=>a.symbol===el.dataset.pulseAsset);return `${a.symbol} · ${fmt(a.price)} ${a.unit} · ${signed(a.change)}`;});}
  adaptMobileMarket(root);
 }
 if(page==='usage')creditMeter(root,credits);
}
