import {L} from './execution-views.mjs';
import {uiGlyph} from './product-composition.mjs';

// The team reads the existing research clock; opening it never starts research or trading.
export function createAssistantTeam({getContext,loadScene=()=>import('./reactor.js')}){
 let dialog=null,scope=null,canvas=null,labels=null,scene=null,origin=null,theme=null;
 let frame=0,previous=0,generation=0,createScene=null,lastReduced=false,lastElapsed=null,paintNeeded=true;
 function stopFrames(){cancelAnimationFrame(frame);frame=0;previous=0;}
 function close(restoreFocus=true){
  generation++;stopFrames();scene?.dispose();scene=null;
  theme?.disconnect();theme=null;
  document.removeEventListener('visibilitychange',visibility);
  document.removeEventListener('hive:locale',paintCopy);
  window.removeEventListener('pagehide',leave);
  const prior=dialog;dialog=null;prior?.close();prior?.remove();
  scope=canvas=labels=null;
  if(restoreFocus)(origin?.isConnected?origin:document.querySelector('[data-chat-team]'))?.focus();
  origin=null;
 }
 function leave(){close(false);}
 function paintCopy(){
  if(!dialog)return;
  dialog.querySelector('[data-team-title]').textContent=L('AI 小队','AI squad');
  dialog.querySelector('[data-team-status]').textContent=L('演示','Demo');
  dialog.querySelector('[data-team-close]').setAttribute('aria-label',L('关闭 AI 小队','Close AI squad'));
  dialog.querySelector('[data-team-reset]').setAttribute('aria-label',L('恢复视角','Reset view'));
  dialog.querySelector('[data-team-retry]').textContent=L('重新加载','Try again');
  scope.setAttribute('aria-label',L('AI 小队协作场景','AI squad collaboration scene'));
 }
 function unavailable(){
  stopFrames();scene?.dispose();scene=null;
  if(!dialog)return;
  dialog.querySelector('[data-team-loading]').hidden=false;
  dialog.querySelector('[data-team-message]').textContent=L('小队暂不可用','The squad is unavailable');
  dialog.querySelector('[data-team-retry]').hidden=false;
 }
 function mount(context){
  scene?.dispose();scene=null;lastReduced=Boolean(context.reducedMotion);
  scope.dataset.multiResearch=String(Boolean(context.model.multiResearch));
  scope.dataset.stopped='false';scope.dataset.paused=String(!context.running);
  scene=createScene(canvas,labels,{scope,reducedMotion:lastReduced,onSelect:id=>scene?.focus(id,false)});
  scene.setRotate(false);lastElapsed=null;paintNeeded=true;
 }
 function tick(now){
  frame=0;
  if(!dialog?.open)return;
  if(document.body.dataset.page!=='assistant'){close(false);return;}
  if(document.hidden)return;
  try{
   const context=getContext();if(!context?.model){unavailable();return;}
   if(lastReduced!==Boolean(context.reducedMotion))mount(context);
   const dt=previous?Math.min(.1,Math.max(0,(now-previous)/1000)):.016;previous=now;
   scope.dataset.paused=String(!context.running);
   if(paintNeeded||scene.needsRender||context.model.elapsed!==lastElapsed||context.running&&!lastReduced){
    scene.update(context.model,dt,context.running&&!lastReduced,{ambient:false});lastElapsed=context.model.elapsed;paintNeeded=false;
   }
   frame=requestAnimationFrame(tick);
  }catch{unavailable();}
 }
 function visibility(){
  stopFrames();
  if(dialog?.open&&scene&&!document.hidden){paintNeeded=true;frame=requestAnimationFrame(tick);}
 }
 async function load(){
  const ticket=++generation;
  dialog.querySelector('[data-team-loading]').hidden=false;
  dialog.querySelector('[data-team-message]').textContent=L('正在载入小队…','Loading the squad…');
  dialog.querySelector('[data-team-retry]').hidden=true;
  try{
   const module=await loadScene();
   if(ticket!==generation||!dialog?.open)return;
   const context=getContext();if(!context?.model){unavailable();return;}
   createScene=module.createReactor;mount(context);
   dialog.querySelector('[data-team-loading]').hidden=true;
   visibility();
  }catch{if(ticket===generation)unavailable();}
 }
 function open(trigger){
  if(dialog?.open)return;
  origin=trigger;dialog=document.createElement('dialog');dialog.className='assistant-team-dialog';
  dialog.setAttribute('aria-labelledby','assistant-team-title');dialog.setAttribute('data-localized-ui','');
  dialog.innerHTML=`<header><div><h2 id="assistant-team-title" data-team-title></h2><span data-team-status></span></div><div class="assistant-team-actions"><button type="button" data-team-reset>${uiGlyph('refresh')}</button><button type="button" data-team-close autofocus>${uiGlyph('close')}</button></div></header><section class="assistant-team-scene" data-team-stage><div class="assistant-team-canvas" data-team-canvas></div><div class="assistant-team-labels" data-team-labels></div><div class="assistant-team-loading" data-team-loading role="status"><span data-team-message></span><button type="button" data-team-retry hidden></button></div></section>`;
  scope=dialog.querySelector('[data-team-stage]');canvas=dialog.querySelector('[data-team-canvas]');labels=dialog.querySelector('[data-team-labels]');
  const current=dialog;
  dialog.querySelector('[data-team-close]').onclick=()=>close();
  dialog.querySelector('[data-team-reset]').onclick=()=>{scene?.reset();paintNeeded=true;};
  dialog.querySelector('[data-team-retry]').onclick=load;
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(dialog===current)close();});
  paintCopy();document.body.append(dialog);dialog.showModal();
  document.addEventListener('visibilitychange',visibility);
  document.addEventListener('hive:locale',paintCopy);
  window.addEventListener('pagehide',leave);
  theme=new MutationObserver(()=>{scene?.setTheme();paintNeeded=true;});
  theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  load();
 }
 return {open,close};
}
