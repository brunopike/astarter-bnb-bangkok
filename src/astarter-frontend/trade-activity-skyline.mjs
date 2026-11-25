// Adapted from Contribution Skyline by Kedhareswer Naidu (MIT).
// https://21st.dev/@kedhareswer/components/contribution-skyline
import {pair as L} from './locale.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf=n=>Number(n).toLocaleString('en-US');
const clamp=v=>Math.max(0,Math.min(1,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>{t=clamp(t);return t<.5?4*t*t*t:1-(-2*t+2)**3/2;};
const riseAt=(t,week,weeks,day)=>{const delay=(weeks>1?week/(weeks-1):0)*.36+day/6*.06;return 1-(1-clamp((t-delay)/.58))**3;};
const barHeight=(count,max)=>count>0&&max>0?.2+count/max*2.8:.2;
const camera=e=>{const yaw=lerp(0,Math.PI/4,e),elev=lerp(Math.PI/2,34*Math.PI/180,e);return {cs:Math.cos(yaw),sn:Math.sin(yaw),se:Math.sin(elev),ce:Math.cos(elev)};};
const project=(c,x,y,z)=>[x*c.cs-y*c.sn,(x*c.sn+y*c.cs)*c.se-z*c.ce];
const rowName=kind=>kind==='buy'?L('买入','Buy'):kind==='sell'?L('卖出','Sell'):kind==='strategy'?L('策略操作','Strategy activity'):L('其他订单','Other orders');

export function activityOrders(entries=[],limit=84){
 const orders=[],seen=new Set();
 for(const {kind,item} of entries){
  if(kind!=='trade'||!item?.id)continue;
  const key=[item.accountId,item.runId,item.id].join(':');if(seen.has(key))continue;seen.add(key);
  const market=String(item.displayMarket||item.market||''),currency=String(item.currency||market.split('/').at(-1)||'').toUpperCase(),qty=item.qty,price=item.price,filled=item.filled;
  const known=Number.isFinite(qty)&&qty>=0&&Number.isFinite(price)&&price>0&&Number.isFinite(filled)&&filled>=0&&filled<=1&&!(item.status==='unknown'&&filled===0);
  const quoted=known&&Number.isFinite(qty*filled*price)?qty*filled*price:null,amount=['USD','USDT','USDC'].includes(currency)&&Number.isFinite(quoted)?quoted:null;
  orders.push({id:String(item.id),market,currency,amount,quoted,status:String(item.status||''),direction:item.side==='sell'?'sell':item.side==='buy'?'buy':'other',kind:amount===null||!['buy','sell'].includes(item.side)?'other':item.side,filter:'交易记录',side:'全部'});
 }
 const shown=orders.slice(0,limit).reverse(),rows=shown.length<=18?2:6;
 return {total:orders.length,shown:shown.length,amount:shown.some(o=>o.amount!==null)?shown.reduce((n,o)=>n+(o.amount??0),0):null,unpriced:shown.filter(o=>o.amount===null).length,groups:shown.map((o,index)=>({...o,count:o.amount??0,x:Math.floor(index/rows),y:index%rows}))};
}

export function skylineGeometry(groups,t=1,viewportWidth=1000,viewportHeight=310){
 if(!groups.length)return [];
 const e=ease(t),cam=camera(e),max=Math.max(...groups.map(g=>g.count)),columns=Math.max(...groups.map(g=>g.x))+1,w=lerp(.78,.9,e),off=(1-w)/2;
 const raw=groups.map((g,index)=>{
  const x=g.x+off,y=g.y+off,z=barHeight(g.count,max)*riseAt(t,g.x,columns,g.y);
  const p=(a,b,c)=>project(cam,a,b,c);
  return {index,depth:g.x*cam.sn+g.y*cam.cs,faces:[
   [p(x,y+w,0),p(x+w,y+w,0),p(x+w,y+w,z),p(x,y+w,z)],
   [p(x+w,y,0),p(x+w,y+w,0),p(x+w,y+w,z),p(x+w,y,z)],
   [p(x,y,z),p(x+w,y,z),p(x+w,y+w,z),p(x,y+w,z)]
  ]};
 });
 const points=raw.flatMap(r=>r.faces.flat()),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
 const minX=Math.min(...xs),minY=Math.min(...ys),width=Math.max(.01,Math.max(...xs)-minX),height=Math.max(.01,Math.max(...ys)-minY),scale=Math.min((viewportWidth-32)/width,(viewportHeight-32)/height),ox=(viewportWidth-width*scale)/2,oy=(viewportHeight-height*scale)/2;
 return raw.sort((a,b)=>a.depth-b.depth).map(r=>({index:r.index,paths:r.faces.map(points=>'M'+points.map(([x,y])=>(ox+(x-minX)*scale).toFixed(2)+','+(oy+(y-minY)*scale).toFixed(2)).join('L')+'Z')}));
}

export function tradeActivityView(entries=[],{query='',side='全部',filter='全部',view='3d'}={}){
 if(filter==='策略操作')return '';
 const model=activityOrders(entries),geometry=skylineGeometry(model.groups,view==='2d'?0:1),hasScope=Boolean(query||side!=='全部'||filter!=='全部');
 const amount=o=>o.amount!==null?`${nf(Number(o.amount.toFixed(4)))} USD eq.`:o.quoted!==null?`${nf(Number(o.quoted.toFixed(6)))} ${o.currency} · ${L('未折算','Not converted')}`:L('成交额待确认','Fill value pending');
 const status=s=>({unknown:L('结果待确认','Result pending'),filled:L('已成交','Filled'),partial:L('部分成交','Partially filled'),'partial-cancelled':L('部分成交后撤销','Partially filled · cancelled'),cancelled:L('已撤销','Cancelled'),submitted:L('待成交','Open'),rejected:L('已拒绝','Rejected')})[s]||L('订单记录','Order record');
 const labels=model.groups.map(g=>`${g.market} · ${rowName(g.direction)} · ${amount(g)} · ${status(g.status)} · ${g.id}`);
 return `<section class="trade-activity" data-trade-activity data-activity-view="${view==='2d'?'2d':'3d'}" data-localized-ui aria-label="${L('交易足迹','Trade footprint')}">
  <header class="trade-activity-head"><div><h2>${L('交易足迹','Trade footprint')}</h2><span>${model.total>model.shown?L('最近','Latest')+' ':''}${nf(model.shown)} ${L('笔订单','orders')}${model.shown?' · '+L('已成交额','Confirmed fills')+' '+(model.amount===null?'—':nf(Number(model.amount.toFixed(2))))+' USD eq.':''}</span></div><div class="trade-activity-controls">${hasScope?`<button type="button" class="p-button" data-activity-reset>${L('清除筛选','Clear filters')}</button>`:''}<div role="group" aria-label="${L('图表视图','Chart view')}">${[['2d',L('平面','2D')],['3d',L('立体','3D')]].map(([mode,label])=>`<button type="button" data-activity-mode="${mode}" aria-pressed="${mode===view}">${label}</button>`).join('')}</div></div></header>
  ${model.shown?`<div class="trade-activity-stage"><svg viewBox="0 0 1000 310" aria-label="${L('一格一笔订单，高度为已成交额；方向键查看，回车定位','One cell per order, height is confirmed fill value. Arrow keys explore; Enter locates the order.')}" role="group">${geometry.map(({index,paths})=>{const g=model.groups[index];return `<g data-activity-cell="${index}" data-activity-x="${g.x}" data-activity-y="${g.y}" data-activity-count="${g.count}" data-activity-kind="${g.kind}" data-activity-query="${esc(g.id)}" data-activity-side="${g.side}" data-activity-filter="${g.filter}" role="button" tabindex="${index===0?'0':'-1'}" aria-label="${esc(labels[index]+' · '+L('定位订单','Locate order'))}"><title>${esc(labels[index])}</title>${paths.map((path,i)=>`<path data-activity-face="${i}" d="${path}"/>`).join('')}</g>`;}).join('')}</svg></div><div class="trade-activity-readout" aria-live="polite"><strong data-activity-readout>${L('按订单顺序排列，点击查看记录','In order sequence. Select a cell to locate its record.')}</strong><span>${L('柱高：已成交额 · USD eq.','Height: confirmed fill value · USD eq.')}</span></div>`:`<div class="trade-activity-empty"><span aria-hidden="true">${Array.from({length:12},()=>'<i></i>').join('')}</span><p>${hasScope?L('没有匹配的订单','No matching orders'):L('暂无交易足迹','No trade footprint yet')}</p></div>`}
  ${model.shown?`<div class="trade-activity-legend">${['buy','sell','other'].filter(kind=>model.groups.some(g=>g.kind===kind)).map(kind=>`<span><i data-activity-kind="${kind}"></i>${kind==='other'?L('待确认 / 未折算','Pending / unconverted'):rowName(kind)}</span>`).join('')}${model.unpriced?`<span>${nf(model.unpriced)} ${L('笔未计入金额','excluded from fill value')}</span>`:''}</div>`:''}
 </section>`;
}

export function mountTradeActivity(root,{onPick=()=>{},onViewChange=()=>{}}={}){
 const host=root.querySelector('[data-trade-activity]');if(!host)return ()=>{};
 const cells=[...host.querySelectorAll('[data-activity-cell]')],groups=cells.map(el=>({el,index:Number(el.dataset.activityCell),x:Number(el.dataset.activityX),y:Number(el.dataset.activityY),count:Number(el.dataset.activityCount)})).sort((a,b)=>a.index-b.index);
 const controller=new AbortController(),signal=controller.signal,reduce=matchMedia('(prefers-reduced-motion: reduce)'),svg=host.querySelector('.trade-activity-stage svg');let raf=0,t=host.dataset.activityView==='2d'?0:1,target=t,last=0;
 const draw=()=>{if(!svg)return;const {width,height}=svg.getBoundingClientRect();if(width<40||height<40)return;svg.setAttribute('viewBox',`0 0 ${width} ${height}`);for(const {index,paths}of skylineGeometry(groups,t,width,height))groups[index].el.querySelectorAll('path').forEach((el,i)=>el.setAttribute('d',paths[i]));};
 const quiet=()=>reduce.matches||document.hidden||document.documentElement.dataset.reducedMotion==='true';
 const frame=now=>{if(quiet()){raf=0;t=target;draw();return;}const dt=Math.max(0,Math.min(50,now-last));last=now;t+=Math.sign(target-t)*Math.min(Math.abs(target-t),dt/650);draw();raf=Math.abs(t-target)>.0001?requestAnimationFrame(frame):0;};
 const settle=()=>{if(quiet()){cancelAnimationFrame(raf);raf=0;t=target;draw();}};
 reduce.addEventListener('change',settle,{signal});
 document.addEventListener('visibilitychange',settle,{signal});
 const settings=new MutationObserver(settle);settings.observe(document.documentElement,{attributes:true,attributeFilter:['data-reduced-motion']});
 const show=el=>{host.querySelector('[data-activity-readout]').textContent=el.querySelector('title').textContent;for(const cell of cells)cell.setAttribute('data-active',String(cell===el));};
 const pick=el=>onPick({query:el.dataset.activityQuery,side:el.dataset.activitySide,filter:el.dataset.activityFilter});
 for(const el of cells){
  el.addEventListener('pointerenter',()=>show(el),{signal});el.addEventListener('focus',()=>show(el),{signal});el.addEventListener('click',()=>pick(el),{signal});
  el.addEventListener('keydown',event=>{
   if(event.key==='Enter'||event.key===' '){event.preventDefault();pick(el);return;}
   if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
   event.preventDefault();const index=groups.findIndex(g=>g.el===el),next=event.key==='Home'?0:event.key==='End'?groups.length-1:Math.max(0,Math.min(groups.length-1,index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)));
   for(const cell of cells)cell.setAttribute('tabindex','-1');groups[next].el.setAttribute('tabindex','0');groups[next].el.focus();
  },{signal});
 }
 host.querySelector('[data-activity-reset]')?.addEventListener('click',()=>onPick({query:'',side:'全部',filter:'全部'}),{signal});
 for(const button of host.querySelectorAll('[data-activity-mode]'))button.addEventListener('click',()=>{
  const mode=button.dataset.activityMode;host.dataset.activityView=mode;target=mode==='3d'?1:0;onViewChange(mode);
  for(const b of host.querySelectorAll('[data-activity-mode]'))b.setAttribute('aria-pressed',String(b===button));
  if(!cells.length)return;if(quiet()){settle();return;}if(!raf){last=performance.now();raf=requestAnimationFrame(frame);}
 },{signal});
 const resize=svg?new ResizeObserver(draw):null;resize?.observe(svg);draw();
 return ()=>{controller.abort();cancelAnimationFrame(raf);resize?.disconnect();settings.disconnect();};
}
