import {normalizeLocale} from './locale-registry.mjs';

// Only transitions already present in the research/receipt state can produce a cue.
export function createSceneCueTracker(){
 let epoch,initialized=false,last=-Infinity;const seen=new Set();
 const track=({epoch:run,time=0,active=false,states=[],receipt,research})=>{
  if(epoch!==run){epoch=run;initialized=false;seen.clear();last=-Infinity;}
  const events=[];
  for(const s of states){
   const j=s.job,key=s.event?.id||j?.id,result=String(j?.result||'').toLowerCase();
   if(key&&(s.phase===1||s.workPhase==='visit'&&(j?.progress||0)>=.12))events.push(['collect',`collect:${s.id}:${key}`,1]);
   if(j?.business&&j.taskType==='review'&&result==='filled')events.push(['fill',`fill:${j.id}`,5]);
   if(j?.business&&['blocked','rejected','unknown','impaired'].includes(result))events.push(['warning',`warning:${j.id}:${result}`,4]);
  }
  if(receipt?.stage==='read')events.push(['receive',`receipt:${receipt.key}`,2]);
  for(const t of research?.tasks||[])if(t.phase==='complete')events.push(['decision',`result:${research.revision?.(t)||t.revision||t.symbol+':'+t.version}`,3]);
  const fresh=events.filter(([,key])=>!seen.has(key));
  for(const [,key]of events){seen.delete(key);seen.add(key);}while(seen.size>256)seen.delete(seen.values().next().value);
  const first=!initialized;initialized=true;
  if(!active||first||time-last<.65)return null;
  const cue=fresh.sort((a,b)=>b[2]-a[2])[0];if(!cue)return null;last=time;return cue[0];
 };
 track.reset=()=>{initialized=false;seen.clear();last=-Infinity;};return track;
}

const NOTES={
 enable:[[523.25,.07],[659.25,.07],[1046.5,.12]],collect:[[659.25,.055],[987.77,.075]],
 receive:[[392,.07],[783.99,.10]],decision:[[523.25,.07],[659.25,.07],[1046.5,.13]],
 fill:[[659.25,.07],[783.99,.07],[1046.5,.14]],warning:[[440,.09],[329.63,.12]]
};
export function createChipSynth(context){
 const master=context.createGain();master.gain.value=.18;master.connect(context.destination);const voices=new Set();let disposed=false;
 function stop(){for(const o of voices){try{o.stop(context.currentTime);}catch{}o.disconnect();}voices.clear();}
 return {play(kind){
  if(disposed)return;stop();let at=context.currentTime+.008;
  for(const [i,[frequency,duration]]of (NOTES[kind]||[]).entries()){
   const oscillator=context.createOscillator(),gain=context.createGain();oscillator.type=i%2?'triangle':'square';oscillator.frequency.setValueAtTime(frequency,at);
   gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.28,at+.006);gain.gain.exponentialRampToValueAtTime(.0001,at+duration);
   oscillator.connect(gain);gain.connect(master);voices.add(oscillator);
   oscillator.onended=()=>{voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};oscillator.start(at);oscillator.stop(at+duration+.012);at+=duration+.018;
  }
 },stop,dispose(){if(disposed)return;disposed=true;stop();master.disconnect();}};
}
const COPY={zh:['开启音效','关闭音效','浏览器不支持音效'],en:['Enable sound','Mute sound','Sound unavailable'],ja:['効果音をオン','効果音をオフ','効果音は利用できません'],ko:['효과음 켜기','효과음 끄기','효과음을 사용할 수 없습니다'],vi:['Bật âm thanh','Tắt âm thanh','Âm thanh không khả dụng'],es:['Activar sonido','Silenciar','Sonido no disponible'],fr:['Activer le son','Couper le son','Son indisponible'],ru:['Включить звук','Выключить звук','Звук недоступен']};
const speaker='<path d="M11 5 6 9H3v6h3l5 4Z"/>';
export function createSceneAudio(host){
 const button=document.createElement('button');button.type='button';button.className='scene-audio';button.setAttribute('data-localized-ui','');host?.append(button);
 const Audio=window.AudioContext||window.webkitAudioContext,track=createSceneCueTracker();
 let context,synth,wanted=false,enabled=false,disposed=false,generation=0,painted='',error=false;
 function paint(){const copy=COPY[normalizeLocale(document.documentElement.lang)],label=!Audio||error?copy[2]:enabled?copy[1]:copy[0],stamp=label+enabled;
  if(painted===stamp)return;painted=stamp;button.setAttribute('aria-label',label);button.title=label;button.setAttribute('aria-pressed',String(enabled));button.disabled=!Audio;
  button.dataset.audioState=error?'unavailable':!context?'idle':enabled?context.state:'muted';
  button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${speaker}${enabled?'<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>':'<path d="m16 9 5 6m0-6-5 6"/>'}</svg>`;
 }
 button.onclick=async()=>{
  wanted=!wanted;error=false;const ticket=++generation;track.reset();
  if(!wanted){enabled=false;synth?.stop();paint();return;}
  try{
   if(!context){context=new Audio();synth=createChipSynth(context);}
   await context.resume();if(disposed||ticket!==generation||!wanted)return;
   if(context.state!=='running')throw new Error('Audio context did not start');
   enabled=true;paint();if(!document.hidden&&document.body.dataset.page==='workbench'){synth.play('enable');button.dataset.audioCue='enable';button.dataset.audioCueAt=context.currentTime.toFixed(3);}button.dataset.audioState=context.state;
  }catch{if(ticket===generation){wanted=false;enabled=false;error=true;button.dataset.audioState='unavailable';paint();}}
 };
 const silent=()=>{if(document.hidden||document.body.dataset.page!=='workbench'||document.body.dataset.paused==='true'){synth?.stop();track.reset();}};
 const observer=new MutationObserver(silent);observer.observe(document.body,{attributes:true,attributeFilter:['data-page','data-paused']});document.addEventListener('visibilitychange',silent);document.addEventListener('hive:locale',paint);paint();
 return {update(frame){
  if(disposed)return;paint();const active=enabled&&!document.hidden&&document.body.dataset.page==='workbench'&&document.body.dataset.paused!=='true';
  const cue=track({...frame,active});if(active&&cue&&context?.state==='running'){synth.play(cue);button.dataset.audioCue=cue;button.dataset.audioCueAt=frame.time.toFixed(3);}
  button.dataset.audioState=error?'unavailable':!context?'idle':enabled?context.state:'muted';
 },dispose(){if(disposed)return;disposed=true;generation++;observer.disconnect();document.removeEventListener('visibilitychange',silent);document.removeEventListener('hive:locale',paint);synth?.dispose();context?.close().catch(()=>{});button.remove();}};
}
