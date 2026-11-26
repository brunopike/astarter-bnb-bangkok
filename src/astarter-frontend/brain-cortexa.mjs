import {mountCortexaGraph,maxZoom} from './brain-cortexa-graph.mjs';
import {mountParticlePortrait} from './brain-particle-portrait.mjs';
import {uiGlyph} from './product-composition.mjs';
import {opticalFace} from './workbench-optical-header.mjs';
import {watchAssetIcon} from './market-watchlist.mjs';
import {brainCatalog,savedBrainRanking,brainAssetKey,canonicalBrainScope,readSavedBrainAsset,preferBrainEvidence,searchBrainAssets,refreshBrainAsset,refreshBrainCatalog} from './brain-asset-data.mjs';
import {createResearchScope,brainChainName} from './brain-research-scope.mjs';
import {mountAssetPicker,networkScope,archiveScope} from './brain-asset-picker.mjs';

function markup({t,brainLayerTitle,thinkingSection,executionSection,nodeButtons,zoomButtons,noteTabs,reader,legend}) {
  return `<link rel="stylesheet" href="/brain-cortexa.css">
    <section class="ct-hero" data-layer="brain" aria-labelledby="ct-brain-layer">
      <div class="space" data-expanded="false">
        <div class="ct-particles" aria-hidden="true"><canvas data-sky></canvas><canvas data-portrait></canvas></div>
        <canvas class="ct-graph-canvas" aria-hidden="true"></canvas>${nodeButtons}
        <header class="ct-heading">
          <h1 id="ct-brain-layer" lang="en" data-no-translate>${opticalFace(brainLayerTitle,'span')}</h1>
          <div class="ct-archive-counts"></div>
        </header>
        <div class="ct-case"><button type="button" class="ct-scope-button" data-asset-picker aria-haspopup="dialog" aria-expanded="false">
          <i aria-hidden="true">${uiGlyph('layers')}</i><span class="ct-scope-label"><span class="ct-scope-action">${t('研究资产','Research asset')}</span><b>${t('全网资产','All assets')}</b><span data-scope-chain hidden></span></span>${uiGlyph('chevron')}</button></div>
        <div class="ct-note-panel">${noteTabs}<div class="ct-note-body">${reader}${legend}</div></div>
        <div class="ct-tools">
          <div class="scene-controls"><button type="button" data-lens-toggle>${uiGlyph('compass')}<span></span></button>${zoomButtons}</div>
        </div>
        <button type="button" class="ct-next" data-next aria-label="${t('研判与执行','Research & execution')}" title="${t('研判与执行','Research & execution')}"><span class="ct-next-label">${t('研判与执行','Research & execution')}</span><span class="ct-next-icon" aria-hidden="true">↓</span></button>
      </div>
    </section>
    <div class="br-workspace ct-workspace" tabindex="-1" aria-label="${t('研判与执行','Research and execution')}">${thinkingSection}${executionSection}</div>`;
}

function connect(root) {
  const hero=root.querySelector('.ct-hero');
  const space=hero.querySelector('.space');
  const note=hero.querySelector('.ct-note-panel');
  const zoomControls=hero.querySelector('.scene-controls');
  const zoomReadout=zoomControls.querySelector('[data-zoom]');
  // A frame-by-frame camera value should remain readable without generating
  // an announcement on every animation frame.
  zoomReadout.setAttribute('aria-live','off');
  const bar=document.querySelector('.topbar');
  const scrollport=root.closest('#product-page');
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  const stack=matchMedia('(max-width: 760px)');
  const shortLandscape=matchMedia('(orientation:landscape) and (max-height:540px)');
  const controls=new AbortController();
  const {signal}=controls;
  let measureFrame=0;
  const reduced=()=>preference.matches || document.documentElement.dataset.reducedMotion==='true';
  const portrait=mountParticlePortrait(space.querySelector('[data-portrait]'));
  let sky=null,skyRequested=false,onscreen=false,pickerOpen=false,atMap=false;
  function syncScene(){
    const state={visible:onscreen && !document.hidden && !pickerOpen && !atMap,reduced:reduced(),light:document.documentElement.dataset.theme==='light'};
    portrait.update(state);
    sky?.update({...state,visible:state.visible && !state.reduced});
    if(!skyRequested && state.visible && !state.reduced && !navigator.connection?.saveData){
      skyRequested=true;
      import('./brain-particle-dust.mjs').then(({mountParticleDust})=>{
        if(signal.aborted)return;
        const compact=stack.matches || shortLandscape.matches || matchMedia('(pointer:coarse)').matches;
        sky=mountParticleDust(space.querySelector('[data-sky]'),{compact});
        syncScene();
      }).catch(()=>{});
    }
  }
  const visibility=new IntersectionObserver(entries=>{onscreen=entries.at(-1).isIntersecting;syncScene();});
  visibility.observe(hero);
  const theme=new MutationObserver(syncScene);
  theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-reduced-motion']});
  document.addEventListener('visibilitychange',syncScene,{signal});
  preference.addEventListener('change',syncScene,{signal});
  root.addEventListener('cortexa-picker',({detail})=>{pickerOpen=detail;syncScene();},{signal});
  space.addEventListener('cortexa-graph',({detail:graph})=>{
    const percentage=Math.round(graph.zoom*100)+'%';
    if(zoomReadout.textContent!==percentage) zoomReadout.textContent=percentage;
    const reading=!graph.entering && (space.dataset.reading==='true'?graph.mix>.66:graph.mix>=.74);
    space.dataset.graphSettled=String(graph.mix===1);
    if(atMap!== (graph.mix===1)){atMap=graph.mix===1;syncScene();}
    space.dataset.reading=String(reading);
    note.inert=!reading;
  },{signal});
  function measure() {
    measureFrame=0;
    const setPixels=(el,key,value)=>{
      const next=value+'px';
      if(el.style.getPropertyValue(key)===next)return false;
      el.style.setProperty(key,next);return true;
    };
    if(bar) setPixels(hero,'--ct-header-height',bar.offsetHeight);
    if(scrollport && (stack.matches || shortLandscape.matches)) setPixels(hero,'--ct-scrollport-height',scrollport.clientHeight);
    const noteRect=note.getBoundingClientRect(), area=space.getBoundingClientRect();
    // The graph reads these pixels when placing nodes around the note reader.
    const stacked=stack.matches && !shortLandscape.matches;
    const rightChanged=setPixels(space,'--graph-inset-right',stacked?20:Math.ceil(area.right-noteRect.left+15));
    // Reserve the persistent controls so reading a different note never shifts the graph.
    const bottom=stacked?space.clientHeight-note.offsetTop+10:zoomControls.offsetHeight+(shortLandscape.matches?12:96);
    const bottomChanged=setPixels(space,'--graph-inset-bottom',Math.max(shortLandscape.matches?40:72,bottom));
    if(rightChanged || bottomChanged)space.dispatchEvent(new Event('cortexa-layout'));
  }
  function requestMeasure() {
    if(!measureFrame) measureFrame=requestAnimationFrame(measure);
  }
  const size=new ResizeObserver(requestMeasure);
  for(const el of [note,space,bar,scrollport]) if(el)size.observe(el);
  shortLandscape.addEventListener('change',requestMeasure,{signal});
  stack.addEventListener('change',requestMeasure,{signal});
  hero.querySelector('[data-next]').addEventListener('click',()=>{
    const target=root.querySelector('.ct-workspace');
    target.focus({preventScroll:true});
    target.scrollIntoView({behavior:reduced()?'instant':'smooth',block:'start'});
  },{signal});
  measure();
  return ()=>{
    controls.abort();
    visibility.disconnect();theme.disconnect();portrait.dispose();sky?.dispose();
    size.disconnect();
    cancelAnimationFrame(measureFrame);
  };
}

function selection(key,asset=null,catalog=brainCatalog){
  const research=key===archiveScope?null:createResearchScope(asset,catalog);
  if(research) research.memory.id=key;
  return {key,asset,research};
}
const savedAssetsKey='astarter.brain.recent-assets.v1';
const recentLimit=24;
function loadRecentAssets(){
  try{
    const raw=sessionStorage.getItem(savedAssetsKey);
    if(!raw || raw.length>160000)return [];
    const rows=JSON.parse(raw);
    return Array.isArray(rows)?rows.slice(0,recentLimit).map(readSavedBrainAsset).filter(Boolean):[];
  }catch{return [];}
}
function saveRecentAsset(asset,recent){
  const key=brainAssetKey(asset);
  if(!key)return;
  recent.delete(key);recent.set(key,asset);
  if(recent.size>recentLimit)recent.delete(recent.keys().next().value);
  try{sessionStorage.setItem(savedAssetsKey,JSON.stringify([...recent.values()].reverse()));}catch{}
}
function initialSelection(){
  const key=canonicalBrainScope(new URL(location.href).searchParams.get('scope'));
  const recent=loadRecentAssets().reverse();
  const available=new Map(brainCatalog.map(row=>[brainAssetKey(row),row]));
  for(const item of savedBrainRanking.rows){
    const id=brainAssetKey(item);available.set(id,preferBrainEvidence(available.get(id),item));
  }
  for(const item of recent){
    const id=brainAssetKey(item),old=available.get(id);
    available.set(id,preferBrainEvidence(old,item));
  }
  const catalog=[...available.values()],asset=available.get(key);
  const activeKey=key===archiveScope?archiveScope:asset?key:networkScope;
  return {...selection(activeKey,asset,catalog),available,recent};
}
function bindSelection(root,initial,onChange){
  const en=!root.dataset.locale?.startsWith('zh'),button=root.querySelector('[data-asset-picker]');
  const cache=initial.available;
  const recent=new Map(initial.recent.map(item=>[brainAssetKey(item),item]));
  const refreshInterval=60_000;
  const fetched=new Map();
  let active=initial,request=null,lookup=null,notice=null,timer=0,disposed=false;
  const localCatalog=()=>[...cache.values()];
  function show(value){
    active=value;
    root.dataset.researchScope=value.key;
    const icon=button.querySelector('i');
    icon.innerHTML=value.asset?watchAssetIcon(value.asset,19):uiGlyph(value.key===archiveScope?'history':'layers');
    const name=value.asset?.symbol||(value.key===archiveScope?(en?'Ethereum Merge':'以太坊合并'):(en?'All assets':'全网资产'));
    button.querySelector('b').textContent=name;
    const chain=brainChainName(value.asset?.chain);
    const network=button.querySelector('[data-scope-chain]');
    network.hidden=!value.asset?.address||!chain;
    network.textContent=network.hidden?'':chain;
    button.setAttribute('aria-label',(en?'Select research asset, ':'选择研究资产，')+name+(chain?' · '+chain:''));
  }
  function storeKey(key){
    const url=new URL(location.href);
    if(key===networkScope)url.searchParams.delete('scope');
    else url.searchParams.set('scope',key);
    if(url.href!==location.href)history.replaceState(history.state,'',url);
  }
  function cancelRefresh(){
    clearTimeout(timer);timer=0;
    if(request) fetched.delete(active.key);
    request?.abort();request=null;
  }
  function schedule(){
    clearTimeout(timer);
    if(disposed || document.hidden || lookup || active.key===archiveScope)return;
    const due=(fetched.get(active.key)??0)+refreshInterval;
    timer=setTimeout(refresh,Math.max(0,due-Date.now()));
  }
  async function refresh(){
    if(disposed || document.hidden || request || active.key===archiveScope)return;
    const {key,asset}=active;
    const controller=request=new AbortController();
    fetched.set(key,Date.now());
    try{
      const rows=asset?[await refreshBrainAsset(asset,{signal:controller.signal})]:
        await refreshBrainCatalog(localCatalog(),{signal:controller.signal});
      if(controller.signal.aborted || active.key!==key || !root.isConnected)return;
      let changed=false;
      for(const item of rows){
        const id=brainAssetKey(item);
        if(!id || (asset && id!==key) || cache.get(id)===item)continue;
        cache.set(id,item);changed=true;
      }
      if(changed){
        const next=selection(key,asset?cache.get(key):null,localCatalog());
        if(next.asset)saveRecentAsset(next.asset,recent);
        show(next);onChange(next);
      }
    }catch(error){if(!controller.signal.aborted)console.warn('Brain market snapshot unavailable',error.name);}
    finally{
      if(request===controller){request=null;schedule();}
    }
  }
  function choose(key,asset){
    lookup?.abort();lookup=null;notice?.remove();notice=null;cancelRefresh();
    button.removeAttribute('aria-busy');
    const cached=cache.get(key);
    const row=preferBrainEvidence(cached,asset);
    if(!row && key!==networkScope && key!==archiveScope){schedule();return;}
    if(row){cache.set(key,row);saveRecentAsset(row,recent);}
    const chosen=selection(key,row,localCatalog());
    show(chosen);storeKey(key);onChange(chosen);schedule();
  }
  function visibility(){
    if(document.hidden){cancelRefresh();return;}
    schedule();
  }
  document.addEventListener('visibilitychange',visibility);
  const dispose=mountAssetPicker(button,{getCatalog:localCatalog,en,getKey:()=>active.key,onChoose:choose,
    onOpenChange:open=>root.dispatchEvent(new CustomEvent('cortexa-picker',{detail:open}))});
  show(initial);
  const linkedKey=new URL(location.href).searchParams.get('scope'),originalKey=canonicalBrainScope(linkedKey);
  if(originalKey===initial.key && originalKey!==linkedKey)storeKey(initial.key);
  function restoreLinkedAsset(){
    if(disposed || lookup)return;
    notice?.remove();notice=null;cancelRefresh();
    const controller=lookup=new AbortController();
    button.setAttribute('aria-busy','true');
    button.querySelector('b').textContent=en?'Looking up…':'查询标的…';
    function unavailable(message){
      if(controller.signal.aborted || !root.isConnected)return;
      lookup=null;show(initial);
      // Keep the shared link intact while its source is offline.
      notice=document.createElement('div');notice.className='ct-scope-notice';
      const status=document.createElement('span');status.setAttribute('role','status');status.textContent=message;
      const retry=document.createElement('button');retry.type='button';retry.textContent=en?'Retry':'重试';
      retry.addEventListener('click',restoreLinkedAsset,{once:true});
      notice.append(status,retry);button.after(notice);schedule();
    }
    searchBrainAssets(originalKey,{signal:controller.signal}).then(rows=>{
      if(controller.signal.aborted || !root.isConnected)return;
      const match=rows.find(row=>brainAssetKey(row)===originalKey);
      if(match)choose(originalKey,match);
      else unavailable(en?'No matching asset':'未找到该标的');
    }).catch(()=>unavailable(en?'Asset source unavailable':'标的数据源暂不可用'))
      .finally(()=>{if(lookup===controller||!lookup)button.removeAttribute('aria-busy');});
  }
  function reconnect(){if(notice && !lookup)restoreLinkedAsset();}
  window.addEventListener('online',reconnect);
  if(originalKey && originalKey!==initial.key && /^(coin:|ca:)/.test(originalKey) && originalKey.length<=500)restoreLinkedAsset();
  else schedule();
  return ()=>{
    disposed=true;lookup?.abort();cancelRefresh();document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('online',reconnect);notice?.remove();dispose();
  };
}
export const cortexaView={markup,mountGraph:mountCortexaGraph,connect,initialSelection,bindSelection,minZoom:.75,maxZoom};
