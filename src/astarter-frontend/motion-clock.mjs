// Presentation time can continue after a finite research run. It never advances evidence.
export function createMotionClock(){
 let epoch=null,lastElapsed=0,time=0;
 return {update(model,delta,{ambient=false,reduced=false}={}){
  if(epoch!==model.epoch){epoch=model.epoch;lastElapsed=model.elapsed;time=reduced?0:model.elapsed;}
  const advance=Math.max(0,model.elapsed-lastElapsed);lastElapsed=model.elapsed;
  if(!reduced)time+=advance+(ambient?Math.max(0,Math.min(delta,.1))*.38:0);
  return time;
 }};
}
