import {evidenceProcess} from './evidence-process.mjs';
const NS='http://www.w3.org/2000/svg';
const clamp=n=>Math.max(0,Math.min(1,n));

// Read receipts and completed research, never derive business success from animation time.
export function evidenceLightLinks(model,states,center,receipt){
 const links=[],sender=receipt&&states.find(s=>s.id===receipt.id),grip={x:center.x,y:center.y+38};
 if(sender&&['receive','release','handoff'].includes(receipt.stage)){
  const peer=receipt.stage==='handoff'&&states.find(s=>s.id===receipt.team?.peers?.[0]);
  const person=s=>({x:s.x+(s.x<center.x?12:-12),y:s.y+12});
  if(receipt.stage!=='handoff'||peer)links.push({key:receipt.key,kind:receipt.stage,from:receipt.stage==='release'?grip:person(sender),to:peer?person(peer):receipt.stage==='release'?person(sender):grip,progress:clamp(receipt.progress),color:sender.color});
 }
 const research=model.multiResearch,core=research?.core,task=core&&research.tasks?.find(t=>t.symbol===core.symbol&&t.version===core.version),age=core?model.elapsed-core.at:-1;
 if(task&&age>=4&&age<7){
  const group=states.find(s=>s.job?.symbol===task.symbol&&s.leader),p=(age-4)/3;
  for(const [i,e]of task.evidence.filter(e=>e.status!=='na').entries()){
   const retained=e.status==='retain'||e.status==='context';
   links.push({key:`${task.symbol}:${task.version}:${e.key}`,kind:retained?'retain':'defer',from:{x:center.x+(i-2.5)*10,y:center.y+66},to:{x:center.x+(retained?0:(i-2.5)*21),y:center.y+(retained?42:83)},progress:clamp(p),color:group?.color||sender?.color||'#adc9df'});
  }
 }
 if(task?.phase==='complete'&&age>=7&&age<8.5)links.push({key:`result:${task.symbol}:${task.version}`,kind:'result',asset:task.symbol,from:grip,to:null,progress:(age-7)/1.5,color:'#d9edff'});
 return links;
}

export function createEvidenceMotion(container,colorFor,scope=document){
 const layer=document.createElement('div');layer.className='evidence-motion';layer.setAttribute('aria-hidden','true');
 const svg=document.createElementNS(NS,'svg');svg.classList.add('evidence-threads');layer.append(svg);container.append(layer);
 const pool=new Map();let priorTarget='',targetNode=null;
 const attrs=(node,values)=>{for(const [k,v]of Object.entries(values))node.setAttribute(k,String(v));};
 function update(model,states,center,{reduced=false,stopped=false,receipt=null}={}){
  const state=evidenceProcess(model),w=container.clientWidth,h=container.clientHeight;svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const links=reduced||stopped?[]:evidenceLightLinks(model,states,center,receipt),used=new Set();
  const dark=document.documentElement.dataset.theme==='dark';
  for(const link of links){
   if(link.kind==='result'){
    if(priorTarget!==link.asset||!targetNode?.isConnected){priorTarget=link.asset;targetNode=[...scope.querySelectorAll('[data-terminal-symbol]')].find(n=>n.dataset.terminalSymbol===link.asset);}
    if(!targetNode)continue;const r=targetNode.getBoundingClientRect(),c=container.getBoundingClientRect(),parent=targetNode.parentElement.getBoundingClientRect();
    if(r.right>parent.right+1||r.left<parent.left-1||r.width<1)continue;
    link.to={x:r.left+r.width/2-c.left,y:r.top-c.top+5};
   }
   used.add(link.key);let group=pool.get(link.key);
   if(!group){group=document.createElementNS(NS,'g');for(let i=0;i<9;i++){const p=document.createElementNS(NS,'path');attrs(p,{fill:'none','stroke-linecap':'round',pathLength:1});group.append(p);}svg.append(group);pool.set(link.key,group);}
   group.dataset.flow=link.kind;group.dataset.ref=link.key;
   const p=clamp(link.progress),fade=Math.sin(Math.PI*p)*(link.kind==='defer'?.48:1),{from:a,to:b}=link;
   for(let i=0;i<9;i++){
    const strand=Math.floor(i/3)-1,layerIndex=i%3,bend=strand*(link.kind==='retain'?7:11),dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
    const d=`M${a.x} ${a.y} Q${(a.x+b.x)/2-dy/length*bend} ${(a.y+b.y)/2+dx/length*bend} ${b.x} ${b.y}`;
    const end=Math.min(1,p*1.25),start=Math.max(0,end-.32);
    attrs(group.children[i],{d,stroke:layerIndex===2&&dark?'#effbff':link.color,'stroke-width':layerIndex===0?(dark?7:4):layerIndex===1?2.1:.7,opacity:fade*(layerIndex===0?(dark?.10:.06):layerIndex===1?.8:.9),'stroke-dasharray':`${Math.max(.001,end-start)} 2`,'stroke-dashoffset':-start});
   }
  }
  for(const [key,node]of pool)if(!used.has(key)){node.remove();pool.delete(key);}
  Object.assign(layer.dataset,{ready:String(state.ready),resolved:String(state.resolved),arrived:String(state.arrived),revision:state.revision,phase:String(state.phase),lightLinks:String(used.size)});return state;
 }
 return {update,dispose(){pool.clear();layer.remove();}};
}
