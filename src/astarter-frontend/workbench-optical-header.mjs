import {L} from './execution-views.mjs';
import {workbenchAccount} from './workbench-insights.mjs';

const walletAmount=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const walletDetailAmount=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:18});
const walletWhole=new Intl.NumberFormat('en-US');

function walletAmounts({usdt,exactUsdt}){
 const parts=typeof exactUsdt==='string'&&/^(\d+)(?:\.(\d{1,18}))?$/.exec(exactUsdt);
 if(parts){
  const whole=BigInt(parts[1]),fraction=parts[2]||'';
  const cents=whole*100n+BigInt(fraction.padEnd(2,'0').slice(0,2));
  const rounded=cents+(Number(fraction[2]||0)>=5?1n:0n);
  const subCent=cents===0n&&/[1-9]/.test(fraction);
  const amount=subCent?'<0.01':walletWhole.format(rounded/100n)+'.'+String(rounded%100n).padStart(2,'0');
  return {amount,detail:walletWhole.format(whole)+'.'+fraction.replace(/0+$/,'').padEnd(2,'0')};
 }
 if(!Number.isFinite(usdt)||usdt<0)return null;
 return {amount:usdt>0&&usdt<.01?'<0.01':walletAmount.format(usdt),detail:walletDetailAmount.format(usdt)};
}

export function workbenchWalletMetric(snapshot){
 const name=L('钱包余额','Wallet balance')+' · USDT',source=L('BSC 链上余额','BSC on-chain balance');
 if(snapshot?.status==='guest')return {label:name,amount:'0.00',description:[name,'0.00',source,L('登录钱包','Sign in to wallet')].join(' · ')};
 const reading=snapshot?.status==='ready'?walletAmounts(snapshot):null;
 if(!reading){
  const state=snapshot?.status==='loading'?L('读取中','Loading'):L('读取失败','Read failed');
  return {label:name+' · '+state,amount:'—',description:[name,state,source].join(' · ')};
 }
 const readAt=Number.isFinite(snapshot.updatedAt)?new Date(snapshot.updatedAt):null;
 const timestamp=readAt&&Number.isFinite(readAt.getTime())?readAt.toISOString():'';
 const readTime=timestamp?L('读取于','Read at')+' '+timestamp.slice(0,10)+' '+timestamp.slice(11,19)+' UTC':L('读取时间未知','Read time unavailable');
 return {label:name+' · BSC'+(timestamp?'\u00a0'+readAt.toTimeString().slice(0,5):''),amount:reading.amount,description:[name,reading.detail,source,readTime].join(' · ')};
}

export function workbenchEquityLabel(account){
 const environment=account?.accountSummary?.environment||account?.environment||'DEMO';
 return environment==='DEMO'?L('模拟盘权益','Paper equity'):L('账户权益','Account equity');
}

// Halftone springs and coverage sampling adapted from Kedhareswer's MIT 21st component (37628).
export function halftoneStep(x,y,vx,vy,hx,hy,px,py,radius){
 const dx=x-px,dy=y-py,d2=dx*dx+dy*dy;
 if(radius>0&&d2<radius*radius){const d=Math.sqrt(d2)+.001,f=(1-d/radius)*.35;vx+=dx/d*f;vy+=dy/d*f;}
 vx=(vx+(hx-x)*.05)*.84;vy=(vy+(hy-y)*.05)*.84;
 return [x+vx,y+vy,vx,vy];
}
export function opticalHeaderMetrics(tasks=[],trade={}){
 const assets=new Set(),inputs=new Set(),domains=new Set();
 for(const task of tasks){
  assets.add(task.symbol);
  for(const item of task.evidence||[]){
   if(['na','pending','missing'].includes(item.status))continue;
   inputs.add(`${task.symbol}:${item.key}:${item.sourceId||''}`);domains.add(item.key);
  }
 }
 const account=workbenchAccount({orders:[],totalFees:0,...trade});
 return {equity:account.equity,
  positionValue:account.held,
  inputs:inputs.size,assets:assets.size,domains:domains.size,
  candidates:tasks.filter(t=>t.phase==='complete'&&t.outcome==='candidate').length};
}

function createHalftoneFace(brand,isWordmark=false){
 const canvas=brand.querySelector('canvas'),ctx=canvas.getContext('2d'),label=brand.querySelector('.dot-text');
 const reduced=matchMedia('(prefers-reduced-motion:reduce)');let word=label.textContent;
 let w=0,h=0,inkWidth=1,dpr=1,dots=new Float32Array(0),raf=0,visible=true,disposed=false,paused=false,hovered=false,focused=false,px=-1e5,py=-1e5,ring={x:0,y:0,at:-1e5},ink='',spectrum=[],sweepAt=-1e5,nextSweepAt=performance.now()+8000;
 const motionAllowed=()=>!paused&&!reduced.matches&&document.documentElement.dataset.reducedMotion!=='true'&&!document.hidden;
 function draw(now){
  if(!ctx)return;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const movingAllowed=motionAllowed(),age=now-ring.at,neon=hovered||focused,sweep=isWordmark&&movingAllowed&&now-sweepAt<1200;let moving=false;
  ctx.fillStyle=ink;
  for(let j=0;j<dots.length;j+=7){
   let [x,y,vx,vy,hx,hy,r]=dots.subarray(j,j+7);
   if(movingAllowed){
    if(age<900){const dx=hx-ring.x,dy=hy-ring.y,d=Math.hypot(dx,dy)+.001,band=1-Math.min(1,Math.abs(d-age*.7)/24),f=band*2.2*(1-age/900);vx+=dx/d*f;vy+=dy/d*f;}
    [x,y,vx,vy]=halftoneStep(x,y,vx,vy,hx,hy,px,py,32);
    if(Math.abs(vx)+Math.abs(vy)>.02||Math.abs(x-hx)+Math.abs(y-hy)>.05)moving=true;
    else{x=hx;y=hy;vx=vy=0;}
    dots.set([x,y,vx,vy],j);
   }
   ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
  if(neon){
   const shift=movingAllowed?Math.sin(now/1100)*inkWidth*.04:0,gradient=ctx.createLinearGradient(-inkWidth*.06+shift,0,inkWidth*1.06+shift,0);
   spectrum.forEach((color,i)=>gradient.addColorStop(i/6,color));
   ctx.save();ctx.globalCompositeOperation='source-atop';ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);ctx.restore();
   ctx.save();ctx.globalCompositeOperation='destination-over';ctx.globalAlpha=.45;ctx.filter='blur(3px)';ctx.drawImage(canvas,0,0,w,h);ctx.restore();
  }else if(sweep){
   const center=(now-sweepAt)/1200*(w+100)-50,left=center-38,right=center+38;
   const gradient=ctx.createLinearGradient(left,0,right,0);gradient.addColorStop(0,'transparent');spectrum.forEach((color,i)=>gradient.addColorStop(.12+i*.76/6,color));gradient.addColorStop(1,'transparent');
   ctx.save();ctx.globalCompositeOperation='source-atop';ctx.fillStyle=gradient;ctx.fillRect(left,0,right-left,h);ctx.restore();
  }
  brand.dataset.rendered=String(dots.length>0);canvas.dataset.dotCount=String(dots.length/7);canvas.dataset.sweeping=String(sweep&&!neon);canvas.dataset.neon=String(neon);
  if(movingAllowed&&(moving||age<900||px>-1e4||sweep||neon))wake();
 }
 function frame(now){raf=0;if(!disposed&&visible)draw(now);}
 function wake(){if(!raf&&!disposed&&visible&&!document.hidden)raf=requestAnimationFrame(frame);}
 function layout(){
  if(!ctx||disposed||!word)return;
  const b=brand.getBoundingClientRect();if(!b.width||!b.height)return;
  w=Math.round(b.width);h=Math.round(b.height);dpr=Math.min(devicePixelRatio||1,2);
  const style=getComputedStyle(brand);ink=style.color;spectrum=Array.from({length:7},(_,i)=>style.getPropertyValue('--s'+(i+1)).trim()||ink);
  canvas.width=w*dpr;canvas.height=h*dpr;
  const mask=document.createElement('canvas');mask.width=w;mask.height=h;const m=mask.getContext('2d',{willReadFrequently:true});
  const face=isWordmark?'900 100px "Arial Black", "Helvetica Neue", Arial, sans-serif':'600 100px "IBM Plex Mono", monospace';m.font=face;
  const size=Math.min(w*.98/m.measureText(word).width*100,h*1.2,isWordmark?64:44);m.font=face.replace('100px',size+'px');
  const box=m.measureText(word),ascent=box.actualBoundingBoxAscent||size*.72,descent=box.actualBoundingBoxDescent||0;
  inkWidth=Math.max(1,Math.min(w,box.actualBoundingBoxRight||box.width));
  m.fillText(word,0,(h+ascent-descent)/2);
  const pixels=m.getImageData(0,0,w,h).data,gap=isWordmark?2.15:1.65,points=[];
  for(let y=gap/2;y<h;y+=gap)for(let x=gap/2;x<w;x+=gap){
   let sum=0;for(let sy=-1;sy<=1;sy++)for(let sx=-1;sx<=1;sx++){const xx=Math.max(0,Math.min(w-1,Math.floor(x+sx*gap/3))),yy=Math.max(0,Math.min(h-1,Math.floor(y+sy*gap/3)));sum+=pixels[(yy*w+xx)*4+3];}
   const coverage=sum/(9*255);if(coverage>=.06)points.push(x,y,0,0,x,y,Math.sqrt(coverage)*gap*.43);
  }
  dots=new Float32Array(points);draw(performance.now());
 }
 function pointer(e){hovered=true;const b=brand.getBoundingClientRect();px=e.clientX-b.left;py=e.clientY-b.top;wake();}
 function leave(){hovered=false;px=py=-1e5;wake();}
 function focus(){focused=true;wake();}
 function blur(){focused=false;wake();}
 function down(e){if(!motionAllowed())return;pointer(e);ring={x:px,y:py,at:performance.now()};wake();}
 const ro=new ResizeObserver(layout);ro.observe(brand);
 const io=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(visible)wake();else{cancelAnimationFrame(raf);raf=0;}});io.observe(brand);
 const theme=new MutationObserver(layout);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-reduced-motion']});
 function visibility(){if(document.hidden){cancelAnimationFrame(raf);raf=0;}else wake();}
 const target=brand.closest('button')||brand;
 target.addEventListener('pointerenter',pointer);target.addEventListener('pointermove',pointer);target.addEventListener('pointerleave',leave);target.addEventListener('pointerdown',down);target.addEventListener('focus',focus);target.addEventListener('blur',blur);
 document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',layout);document.fonts?.ready.then(()=>{if(!disposed)layout();});layout();
 return {setValue(value,isPaused){const changedPause=paused!==isPaused;paused=isPaused;const now=performance.now();if(isWordmark&&visible&&motionAllowed()&&now>=nextSweepAt){sweepAt=now;nextSweepAt=now+8000;wake();}if(changedPause)wake();if(word!==value){word=value;label.textContent=value;layout();if(motionAllowed())ring={x:w*.5,y:h*.5,at:now};wake();}},dispose(){disposed=true;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();theme.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',layout);target.removeEventListener('pointerenter',pointer);target.removeEventListener('pointermove',pointer);target.removeEventListener('pointerleave',leave);target.removeEventListener('pointerdown',down);target.removeEventListener('focus',focus);target.removeEventListener('blur',blur);}};
}
export function createOpticalHeader(root){
 const face=(value,tag='strong')=>`<${tag} class="lw-dot-face"><span class="dot-text">${value}</span><canvas aria-hidden="true"></canvas></${tag}>`;
 root.innerHTML=`<div class="lw-halftone-brand">${face('LENSWAVE','h1')}</div><div class="lw-header-metrics"><button type="button" data-terminal-action="wallet" aria-haspopup="dialog"><small></small>${face('—')}<span></span></button><div><small></small>${face('—')}<span></span></div><div class="lw-header-candidates"><small></small>${face('—')}<span></span></div></div>`;
 const fields=[...root.querySelector('.lw-header-metrics').children],surfaces=[...root.querySelectorAll('.lw-dot-face')].map((node,i)=>createHalftoneFace(node,i===0));
 return {update(tasks,balance,paused,scanRows=[]){
  const ready=scanRows.filter(r=>r.state==='ready'),samples=ready.reduce((n,row)=>n+row.bars,0),signals=ready.filter(r=>r.signal&&r.signal!=='balanced').length;
  const rows=[
   [balance.label,balance.amount,''],
   [L('已扫描 K 线','Candles analysed'),ready.length?samples.toLocaleString('en-US'):'—',`${ready.length} / ${scanRows.length||new Set(tasks.map(task=>task.symbol)).size} ${L('标的 · 日线核验','assets · daily study')}`],
   [L('技术观察','Technical watch'),ready.length?String(signals):'—',paused?L('已暂停','Paused'):L('突破 / RSI 极值','Breakouts / RSI extremes')]
  ];
  surfaces[0].setValue('LENSWAVE',paused);
  rows.forEach((values,i)=>{fields[i].firstElementChild.textContent=values[0];fields[i].lastElementChild.textContent=values[2];fields[i].lastElementChild.hidden=true;fields[i].setAttribute('aria-label',i===0?balance.description:values.join(' · '));surfaces[i+1].setValue(values[1],paused);});
  fields[0].title=balance.description;
 },dispose(){surfaces.forEach(surface=>surface.dispose());}};
}
