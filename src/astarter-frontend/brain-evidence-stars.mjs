// Pick, draw and label from the same projected coordinates. The portrait still owns its 14 GPU landmarks.
function seed(id){
  let h=2166136261;
  for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619);
  return h>>>0;
}
function uniform(n){
  n=Math.imul(n^(n>>>16),0x21f0aaad);n=Math.imul(n^(n>>>15),0x735a2d97);
  return ((n^(n>>>15))>>>0)/4294967296;
}
export function createEvidenceStars(space,en,onPick){
  let records=[],details=[],projected=[],captions=[],active=null,activeRecord=null,branch=-1,lastOver=null;
  const families=new Map(),branches=new Map();
  const halos=new Map(),projectionPool=[],hubs=new Map();
  const captionWidths=[new Map(),new Map()];
  let tipWidth=0,tipHeight=0,tipViewport=0;
  function haloFor(parent,color){
    let halo=halos.get(parent);
    if(!halo){
      const canvas=space.ownerDocument.createElement('canvas');
      canvas.width=canvas.height=48;
      halo={canvas,ctx:canvas.getContext('2d'),color:null};
      halos.set(parent,halo);
    }
    if(halo.color!==color){
      const gradient=halo.ctx.createRadialGradient(24,24,0,24,24,24);
      for(const [offset,alpha] of [[0,'88'],[.28,'56'],[.58,'20'],[1,'00']])gradient.addColorStop(offset,color+alpha);
      halo.ctx.clearRect(0,0,48,48);
      halo.ctx.fillStyle=gradient;halo.ctx.fillRect(0,0,48,48);halo.color=color;
    }
    return halo.canvas;
  }
  const doc=space.ownerDocument,tip=doc.createElement('div');
  tip.className='ct-star-tip';tip.hidden=true;tip.setAttribute('aria-hidden','true');
  const title=doc.createElement('b'),context=doc.createElement('span');
  tip.append(title,context);space.append(tip);
  const total=doc.createElement('output');total.className='ct-star-count';total.hidden=true;total.setAttribute('aria-live','off');space.querySelector('.ct-heading').append(total);
  function setData(rows){
    records=[];details=[];families.clear();branches.clear();
    projectionPool.length=0;hubs.clear();captionWidths.forEach(cache=>cache.clear());
    for(const item of rows){
      const h=seed(item.id),family=seed(item.record),group=item.child<0;
      const theta=uniform(family)*Math.PI*2,rad=Math.sqrt(uniform(family+1))*.50;
      const orbit=uniform(h+3)*Math.PI*2,r=group?0:(.025+.15*uniform(h+4));
      const u=.5+rad*Math.cos(theta)+r*Math.cos(orbit),v=.5+rad*Math.sin(theta)+r*Math.sin(orbit);
      (group?records:details).push({item,u,v,weight:uniform(h+2),group});
    }
    records.sort((a,b)=>a.weight-b.weight);details.sort((a,b)=>a.weight-b.weight);
    for(const list of [records,details])list.forEach((point,index)=>{
      point.rank=index;
      if(!families.has(point.item.record))families.set(point.item.record,[]);
      families.get(point.item.record).push(point);
      if(point.group){
        if(!branches.has(point.item.parent))branches.set(point.item.parent,[]);
        branches.get(point.item.parent).push(point);
      }
    });
    active=null;activeRecord=null;projected=[];captions=[];lastOver=null;tip.hidden=true;
    total.textContent=new Intl.NumberFormat(en?'en':'zh').format(rows.length)+(en?' evidence nodes':' 个证据节点');
  }
  function hit(x,y,touch=false){
    const label=captions.find(c=>x>=c.x&&x<=c.right&&Math.abs(c.y-y)<=7);
    if(label)return label.point;
    let best=null,nearest=touch?144:64;
    for(const star of projected){
      const dx=star.x-x,dy=star.y-y,distance=dx*dx+dy*dy;
      if(distance<nearest){best=star;nearest=distance;}
    }
    return best;
  }
  function draw(ctx,frame){
    const {bounds,centers,sites,mix,zoom,panX,panY,width,height,light,pointer,blocked}=frame;
    projected.length=0;captions.length=0;hubs.clear();
    const hideCount=mix<.98||!records.length;
    if(total.hidden!==hideCount)total.hidden=hideCount;
    if(!ctx||mix<.57||!records.length){if(!tip.hidden)tip.hidden=true;return;}
    const reveal=Math.min(1,(mix-.57)/.43),spread=Math.max(1,zoom/2.1);
    const compact=width<700,density=Math.ceil(Math.max(compact?300:500,bounds.w*bounds.h/660)*spread*spread);
    const left=bounds.cx-bounds.w/2,top=bounds.cy-bounds.h/2;
    const groupLimit=Math.ceil(density*.4);
    const right=left+bounds.w,bottom=top+bounds.h,clearance=compact?144:289;
    function project(star){
      const {item}=star,origin=centers[item.parent],s=sites[item.parent];
      const nx=star.u*.85+s.x*.15,ny=star.v*.85+s.y*.15;
      const destX=bounds.cx+(nx-.5)*bounds.w*spread+panX,destY=bounds.cy+(ny-.5)*bounds.h*spread+panY;
      const x=origin.x+(destX-origin.x)*reveal,y=origin.y+(destY-origin.y)*reveal;
      if(x<left||x>right||y<top||y>bottom)return;
      for(const center of centers){
        const dx=center.x-x,dy=center.y-y;
        if(dx*dx+dy*dy<clearance)return;
      }
      const index=projected.length;
      const point=projectionPool[index]??(projectionPool[index]={});
      point.x=x;point.y=y;point.star=star;point.item=item;point.color=s.color;
      projected.push(point);
      if(star.group)hubs.set(item.record,point);
    }
    const groupCount=Math.min(records.length,groupLimit),detailCount=Math.min(details.length,density);
    for(let i=0;i<groupCount;i++)project(records[i]);
    for(let i=0;i<detailCount;i++)project(details[i]);
    // The selected family can include evidence beyond the normal density cutoff.
    for(const hub of branches.get(branch)||[]){
      if(hub.rank>=groupLimit)project(hub);
    }
    for(const member of families.get(activeRecord)||[]){
      const alreadyDrawn=member.group?(member.rank<groupLimit||member.item.parent===branch):member.rank<density;
      if(!alreadyDrawn)project(member);
    }
    let hovered=!blocked&&pointer?hit(pointer[0],pointer[1]):null;
    // A few short links reveal the related observations without a web of crossing strokes.
    const highlighted=hovered?.item.record||activeRecord;
    for(const p of projected){
      const hub=hubs.get(p.item.record);
      if(!hub||hub===p||(!(p.star.weight<.035)&&highlighted!==p.item.record))continue;
      ctx.strokeStyle=p.color;ctx.globalAlpha=reveal*(highlighted===p.item.record ? .28 : .095);ctx.lineWidth=.8;
      ctx.beginPath();ctx.moveTo(hub.x,hub.y);ctx.lineTo(p.x,p.y);ctx.stroke();
    }
    const origin=hubs.get(highlighted);
    if(origin && origin.item.relations?.length){
      ctx.strokeStyle=origin.color;ctx.globalAlpha=.55*reveal;ctx.lineWidth=1.1;
      ctx.beginPath();
      for(const id of origin.item.relations){
        const target=hubs.get(id);
        if(target){ctx.moveTo(origin.x,origin.y);ctx.lineTo(target.x,target.y);}
      }
      ctx.stroke();
    }
    for(const p of projected){
      const own=p.item.id===active,hot=p===hovered,related=Boolean(highlighted&&p.item.record===highlighted);
      const radius=hot||own?3.6:p.star.group?(compact?1.85:2.45):1+.65*p.star.weight;
      if(p.star.group||hot||own){
        const extent=radius*3.4;
        ctx.globalAlpha=reveal*(hot||own ? .96 : .72);
        ctx.drawImage(haloFor(p.item.parent,p.color),p.x-extent,p.y-extent,2*extent,2*extent);
      }
      ctx.fillStyle=p.color;
      ctx.globalAlpha=reveal*(hot||own?1:p.star.group ? .95 : related ? .92 : light ? .80 : .73);
      ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fill();
      if((hot||own)&&mix>.98){
        ctx.globalAlpha=.55;ctx.strokeStyle=p.color;ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(centers[p.item.parent].x,centers[p.item.parent].y);ctx.stroke();
      }
    }
    ctx.globalAlpha=1;
    if(mix>.98){
      const occupied=centers.map(p=>[p.x-43,p.y-14,p.x+43,p.y+28]);
      const seen=new Set(), categories=new Set();
      const candidates=[...hubs.values()];
      // Give different subjects a name at the opening scale. Zoom reveals individual observations.
      const featured=candidates.filter(p=>{
        const key=p.item.captionGroup;
        if(categories.has(key))return false;
        categories.add(key);return true;
      });
      const nearby=spread>1.9?projected.filter(p=>!p.star.group):[];
      const order=spread>1.9?[...featured,...nearby,...candidates]:[...featured,...candidates];
      const widths=captionWidths[compact?0:1];
      let printed=0;
      ctx.save();ctx.font=(compact?'10':'12')+'px system-ui, sans-serif';ctx.textBaseline='middle';
      for(const p of order){
        const full=p.item.caption||p.item.label;
        if(!full||seen.has(full))continue;
        const limit=compact?19:30;
        const caption=full.length>limit?full.slice(0,limit-1)+'…':full;
        const x=p.x+7,y=p.y-5;
        let w=widths.get(caption);
        if(w===undefined){w=ctx.measureText(caption).width;widths.set(caption,w);}
        if(x+w>left+bounds.w||x<left||y<top+8||y>top+bounds.h-7||occupied.some(b=>x<b[2]&&x+w>b[0]&&y-6<b[3]&&y+6>b[1]))continue;
        occupied.push([x-12,y-12,x+w+12,y+12]);seen.add(full);
        captions.push({x,y,right:x+w,point:p});
        ctx.lineJoin='round';ctx.lineWidth=3;ctx.strokeStyle=light?'#f8f7f4':'#080a0e';ctx.strokeText(caption,x,y);
        ctx.fillStyle=light?'#354052':'#bcc5d2';ctx.fillText(caption,x,y);
        if(++printed>=(compact?(spread>1.9?3:2):(spread>1.9?14:9)))break;
      }
      ctx.restore();
    }
    if(!blocked&&pointer)hovered=hit(pointer[0],pointer[1]);
    if(hovered&&mix>.98){
      const changed=lastOver!==hovered.item.id;
      if(changed){title.textContent=hovered.item.label;context.textContent=hovered.item.context;lastOver=hovered.item.id;}
      if(tip.hidden)tip.hidden=false;
      tip.style.setProperty('--star-ink',hovered.color);
      if(changed||tipViewport!==width){
        tipWidth=tip.offsetWidth;tipHeight=tip.offsetHeight;tipViewport=width;
      }
      const tx=Math.min(width-tipWidth-8,Math.max(8,hovered.x+12)),ty=hovered.y-tipHeight-12;
      tip.style.transform='translate('+Math.round(tx)+'px,'+Math.round(ty>=4?ty:Math.min(height-tipHeight-4,hovered.y+10))+'px)';
    }else if(!tip.hidden)tip.hidden=true;
    if(space.dataset.visibleStars!==String(projected.length))space.dataset.visibleStars=String(projected.length);
    return Boolean(hovered);
  }
  function focusRecord(id,child=-1){
    activeRecord=families.has(id)?id:null;
    active=activeRecord && (child<0?id:id+'@'+child);
  }
  function visibleGlints(limit){
    const count=Math.min(limit,projected.length);
    return Array.from({length:count},(_,i)=>projected[Math.floor((i+.5)*projected.length/count)]);
  }
  return {setData,draw,focusRecord,visibleGlints,setBranch(id){branch=id;focusRecord(null);},pick(x,y,touch){
    const p=hit(x,y,touch);
    if(!p)return false;
    onPick(p.item);focusRecord(p.item.record,p.item.child);return true;
  },clear(){focusRecord(null);},dispose(){tip.remove();total.remove();}};
}
