// Visual choreography only. Counts are rendered filaments, not market evidence.
export const STRANDS_PER_BRANCH = 16;
export const REVISION_SECONDS = 4.3;
const clamp=x=>Math.max(0,Math.min(1,x));
export const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
export function branchSpecs(model){
 const sink=model.config.actors.at(-1);
 return model.config.actors.filter(role=>role!==sink).map((role,index)=>({role,sink,index,delay:2.2+index*.58,duration:4.6}));
}
export function recruitment(spec,elapsed,reduced=false){
 return{select:reduced?1:smooth((elapsed-spec.delay+1.6)/1.15),gather:reduced?1:smooth((elapsed-spec.delay)/spec.duration)};
}
export function revisionEnvelope(progress){
 const q=clamp(progress);
 return{incoming:smooth(q/.24),gather:smooth((q-.12)/.68),outgoing:1-smooth((q-.38)/.56),stage:q<.24?'locate':q<.58?'gather':q<.86?'replace':'resume'};
}
export function revisionGain(role,generation,revision){
 const gain=g=>g===0?1:1+Math.sin(role+g*1.7)*.13;
 if(typeof role!=='number')return 1;
 return revision&&revision.role===role?gain(generation)+(gain(generation+1)-gain(generation))*revisionEnvelope(revision.progress).gather:gain(generation);
}
export class StrategyUpdates{
 constructor({duration=REVISION_SECONDS}={}){this.duration=duration;this.epoch=-1;this.key='';this.seen=new Set();this.queue=[];this.generations=new Map();this.active=null;this.availableAt=12;}
 reset(model){this.epoch=model.epoch;this.key=model.key;this.specs=branchSpecs(model);this.seen.clear();this.queue=[];this.generations=new Map(this.specs.map(s=>[s.role,0]));this.active=null;this.availableAt=12;}
 update(model){
  if(model.epoch!==this.epoch||model.key!==this.key)this.reset(model);
  for(const e of [...model.events].reverse()){
   if(this.seen.has(e.id))continue;this.seen.add(e.id);
   if(e.from===null||e.at<12&&!e.text.startsWith('手动注入'))continue;
   const role=this.generations.has(e.to)?e.to:this.generations.has(e.from)?e.from:null;
   if(role===null)continue;
   const next={...e,role},queued=this.queue.findIndex(q=>q.role===role);
   if(queued>=0)this.queue[queued]=next;else this.queue.push(next);
  }
  const visible=new Set(model.events.map(e=>e.id));for(const id of this.seen)if(!visible.has(id))this.seen.delete(id);
  for(let i=0;i<8;i++){
   if(this.active){
    if(model.elapsed<this.active.startedAt+this.duration)break;
    this.generations.set(this.active.role,this.active.generation);this.availableAt=this.active.startedAt+this.duration;this.active=null;
   }
   const e=this.queue[0];if(!e)break;
   const startedAt=Math.max(12,e.at,this.availableAt);if(model.elapsed<startedAt)break;
   this.queue.shift();this.active={id:e.id,role:e.role,startedAt,generation:this.generations.get(e.role)+1};
  }
  return this.active?{...this.active,progress:clamp((model.elapsed-this.active.startedAt)/this.duration)}:null;
 }
}
