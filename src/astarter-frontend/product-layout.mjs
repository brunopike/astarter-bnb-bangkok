import {L} from './execution-views.mjs';
import {uiGlyph} from './product-composition.mjs';

export function interceptNavigation(event){
 if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return false;
 event.preventDefault();return true;
}

function includesRoute(target,current){
 if(target.origin!==current.origin||target.pathname!==current.pathname||target.hash!==current.hash)return false;
 return [...current.searchParams].every(([key,value])=>target.searchParams.getAll(key).includes(value));
}
export function isCurrentDataLink(link,current){
 // A selected tab may spell out defaults like BTC. Dropping a fund filter is a real navigation.
 return link.href===current.href||(link.matches('.data-subtabs>[aria-current=page]')&&includesRoute(new URL(link.href),current));
}

function revealCurrentTab(strip,tab,inset=4){
 if(!tab||!strip.clientWidth||strip.scrollWidth<=strip.clientWidth)return;
 const bounds=strip.getBoundingClientRect(),item=tab.getBoundingClientRect();
 if(item.left<bounds.left+inset)strip.scrollLeft+=item.left-bounds.left-inset;
 else if(item.right>bounds.right-inset)strip.scrollLeft+=item.right-bounds.right+inset;
}

export function readDataTabScroll(root){
 const saved=new Map();
 for(const strip of root.querySelectorAll('.data-subtabs')){
  const tab=strip.querySelector('[aria-current=page]');
  if(!tab||!strip.clientWidth||strip.scrollWidth<=strip.clientWidth)continue;
  const frame=strip.getBoundingClientRect(),item=tab.getBoundingClientRect();
  saved.set(strip.getAttribute('aria-label'),{href:tab.href,left:strip.scrollLeft,visible:item.left>=frame.left-1&&item.right<=frame.right+1});
 }
 return saved;
}

// Subview buttons and channel links are rebuilt on navigation. Animate a single
// surface in the new strip so the text and hit targets keep their final positions.
function captureSelection(strip,current,underline=false){
 const surface=strip.querySelector('.layout-tab-glide')||current;
 const from=surface.getBoundingClientRect(),frame=strip.getBoundingClientRect();
 const wasVisible=from.right>frame.left&&from.left<frame.right;
 return (nextStrip,tab)=>{
  if(!tab?.clientWidth||!tab.animate||document.documentElement.dataset.reducedMotion==='true'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const bounds=nextStrip.getBoundingClientRect(),end=tab.getBoundingClientRect();
  const delta=wasVisible?from.left-frame.left+bounds.left-end.left:0;
  const glide=document.createElement('i');glide.className='layout-tab-glide';glide.setAttribute('aria-hidden','true');
  Object.assign(glide.style,{
   left:(end.left-bounds.left-nextStrip.clientLeft+nextStrip.scrollLeft)+'px',
   top:((underline?end.bottom-2:end.top)-bounds.top-nextStrip.clientTop)+'px',
   width:end.width+'px',height:(underline?2:end.height)+'px'
  });
  nextStrip.append(glide);
  const animation=glide.animate([
   {transform:`translateX(${delta}px) scaleX(${wasVisible?from.width/end.width:1})`,opacity:wasVisible?1:0},
   {transform:'none',opacity:1}
  ],{duration:195,easing:'cubic-bezier(.2,.75,.25,1)'});
  animation.finished.then(()=>glide.remove(),()=>glide.remove());
 };
}

export function captureDataTab(root,href){
 const strips=[...root.querySelectorAll('.data-subtabs')],destination=new URL(href);
 if(!strips.some(strip=>[...strip.querySelectorAll('a[href]')].some(link=>includesRoute(new URL(link.href),destination))))return null;
 const before=new Map();
 for(const strip of strips){
  const current=strip.querySelector('[aria-current=page]');
  if(current)before.set(strip.getAttribute('aria-label'),{href:current.href,scroll:strip.scrollLeft,play:captureSelection(strip,current)});
 }
 return ()=>{
  const pairs=[];
  for(const strip of root.querySelectorAll('.data-subtabs')){
   const prior=before.get(strip.getAttribute('aria-label')),tab=strip.querySelector('[aria-current=page]');
   if(prior&&tab?.clientWidth)pairs.push({strip,tab,prior});
  }
  // The implicit ETH ETF route also selects Holdings. Back from its archive belongs
  // to the lower data-mode strip, even though the upper ETH link matches the URL.
  const changed=pairs.filter(({tab,prior})=>tab.href!==prior.href);
  const match=changed.find(({tab})=>tab.href===href)||changed[0]||pairs.find(({tab})=>tab.href===href);
  if(!match)return false;
  const {strip,tab,prior}=match;
  strip.scrollLeft=prior.scroll;
  revealCurrentTab(strip,tab);
  tab.focus({preventScroll:true});
  if(tab.href!==prior.href)prior.play(strip,tab);
  return true;
 };
}

export function captureDataChannel(root){
 if(!matchMedia('(min-width:901px)').matches)return null;
 const strip=root.querySelector('.layout-data-menu>.layout-section-tabs'),current=strip?.querySelector('[aria-current=page]');
 if(!current?.clientWidth)return null;
 const play=captureSelection(strip,current,true);
 return ()=>{
  const next=root.querySelector('.layout-data-menu>.layout-section-tabs'),tab=next?.querySelector('[aria-current=page]');
  if(tab&&tab.dataset.go!==current.dataset.go)play(next,tab);
 };
}

const menuEvents=new Set();let mediaEvents;
function bindHeaderMenu(menu,trigger){
 let ownedEvents;
 menu.addEventListener('toggle',()=>{
  ownedEvents?.abort();menuEvents.delete(ownedEvents);const floating=!(menu.matches('.layout-actions-menu,.layout-data-menu')&&matchMedia('(min-width:901px)').matches);menu.toggleAttribute('data-info-open',menu.open&&floating);
  if(!floating)return;
  if(!menu.open||!menu.isConnected)return;
  ownedEvents=new AbortController();menuEvents.add(ownedEvents);
  const closeOutside=event=>{if(!menu.contains(event.target)&&!event.target.closest?.('.liquid-select-portal-slot'))menu.open=false;};
  document.addEventListener('pointerdown',closeOutside,{signal:ownedEvents.signal});
  document.addEventListener('focusin',closeOutside,{signal:ownedEvents.signal});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!menu.querySelector('[data-liquid-open]')){menu.open=false;trigger.focus();}},{signal:ownedEvents.signal});
 });
}

// Move the original nodes after binding so navigation, drafts and action handlers stay intact.
export function unifyProductLayout(root,page,retainedTabs){
 if(!['workbench','setup'].includes(page)&&root.querySelector('.layout-page-head'))return;
 for(const events of menuEvents)events.abort();menuEvents.clear();
 mediaEvents?.abort();mediaEvents=null;
 delete root.dataset.layout;
 if(['workbench','setup'].includes(page))return;
 if(root.querySelector('.statements')){root.dataset.layout='unified';return;}
 if(root.querySelector('.commerce-page')){
  root.dataset.layout='unified';
  const tabs=root.querySelector(':scope>.biz-subnav');
  if(tabs){const row=document.createElement('div');row.className='layout-navigation-row';tabs.classList.add('layout-section-tabs');tabs.before(row);row.append(tabs);}
  return;
 }
 const head=[...root.querySelectorAll('.sc-heading,.sig-page-header,.chat-heading,.p-head,.page-head,.dc-market-heading,.dc-head,.df-page-head,.pd-heading')].find(n=>n.querySelector('h1'));
 if(!head)return;
 const title=head.querySelector('h1');
 const trading=root.querySelector(':scope>.trading-nav');
 if(trading)root.querySelector('.sc-market-tabs')?.remove();
 const dataSection=['markets','tracking','intelligence','social','derivatives','etf'].includes(page),fallbackViews=page==='markets'&&!root.querySelector('.market-hub')?head.querySelector(':scope>nav'):null;
 const section=trading||root.querySelector('.sc-market-tabs')||(dataSection?root.querySelector(':scope>.biz-subnav'):null)||head.querySelector(':scope>nav')||root.querySelector('.chat-modebar')||root.querySelector(':scope>.biz-subnav');
 if(section&&section!==root.querySelector(':scope>.biz-subnav'))root.querySelector(':scope>.biz-subnav')?.remove();
 head.querySelectorAll('.sc-overview,.sig-mobile-label,.chat-capability,.p-eyebrow').forEach(n=>n.remove());
 section?.remove();
 if(fallbackViews&&fallbackViews!==section)fallbackViews.remove();

 let titleGroup=[...head.children].find(n=>n!==title&&n.contains(title));
 if(!titleGroup){titleGroup=document.createElement('div');title.before(titleGroup);titleGroup.append(title);}
 titleGroup.classList.add('layout-heading-title');
 const actions=document.createElement('div');actions.className='layout-heading-actions';
 const history=head.querySelector('[data-chat-history]');if(history)actions.append(history);
 for(const node of [...head.children])if(node!==titleGroup){node.classList.add('layout-action-group');actions.append(node);}
 const pocket=actions.querySelector('.mascot-pocket');if(pocket)actions.append(pocket);
 head.append(actions);head.classList.add('layout-page-head');head.setAttribute('data-localized-ui','');
 root.prepend(head);

 if(section){
  const row=document.createElement('div');row.className='layout-navigation-row';
  section.classList.add('layout-section-tabs');row.append(section);head.after(row);
  if(dataSection||section.querySelectorAll('button,a').length>5){
   const menu=document.createElement('details');menu.className='layout-data-menu';
   const trigger=document.createElement('summary'),current=section.querySelector('[aria-current=page],[aria-pressed=true]');
   trigger.title=dataSection?L('切换数据页面','Switch data page'):L('切换页面','Switch page');
   const label=document.createElement('span');label.textContent=current?.textContent.trim()||title.textContent.trim();trigger.append(label);trigger.insertAdjacentHTML('beforeend',uiGlyph('chevron'));
   section.before(menu);menu.append(trigger,section);bindHeaderMenu(menu,trigger);
   const desktop=matchMedia('(min-width:901px)');menu.open=desktop.matches;mediaEvents??=new AbortController();desktop.addEventListener('change',event=>menu.open=event.matches,{signal:mediaEvents.signal});
   section.addEventListener('focusin',event=>{
    if(desktop.matches&&event.target.matches('a:focus-visible,button:focus-visible'))revealCurrentTab(section,event.target,8);
   });
  }
  if(section.classList.contains('sc-market-tabs'))for(const button of section.querySelectorAll(':scope>button')){
   button.setAttribute('aria-label',button.textContent.trim());const full=document.createElement('b');full.className='layout-tab-label-long';button.prepend(full);
   for(const node of [...button.childNodes])if(node.nodeType===3)full.append(node);
   const short=document.createElement('b');short.className='layout-tab-label-short';short.setAttribute('aria-hidden','true');short.textContent=button.dataset.id==='strategies'?L('发现','Discover'):L('我的','Mine');full.after(short);
  }
  const routeTitle=['strategies','my-strategies','signals','opportunities','execution','watchlist','logs','assets','assistant','tracking','intelligence','social','derivatives','etf','plans','topup','usage','staking','billing','settings','risk','mandate'].includes(page)||(page==='markets'&&!new URLSearchParams(root.ownerDocument.location.search).has('asset'));
  if(routeTitle){
   head.classList.add('layout-context-only');
   const status=titleGroup.querySelector('.hub-state');if(status)actions.prepend(status);
   const menu=document.createElement('details');menu.className='layout-actions-menu';
   const trigger=document.createElement('summary');trigger.innerHTML=uiGlyph('more');trigger.setAttribute('aria-label',L('页面操作','Page actions'));trigger.title=trigger.getAttribute('aria-label');
   menu.append(trigger,actions);row.append(menu);bindHeaderMenu(menu,trigger);
   const feedTabs=page==='intelligence'&&actions.querySelector('.pd-feed-tabs');
   if(feedTabs)menu.before(feedTabs);
   if(page==='assistant'&&history){history.classList.add('layout-history-shortcut');menu.before(history);}
   const provider=page==='assistant'&&actions.querySelector('[data-chat-tools]');if(provider){provider.classList.add('layout-provider-shortcut');menu.before(provider);}
   const advisor=actions.querySelector('.sc-advisor');if(advisor&&!trading){advisor.classList.add('layout-advisor-shortcut');menu.before(advisor);}
   const desktop=matchMedia('(min-width:901px)');menu.open=desktop.matches;mediaEvents??=new AbortController();desktop.addEventListener('change',event=>menu.open=event.matches,{signal:mediaEvents.signal});
  }
 }

 const hub=root.querySelector('.market-hub'),views=hub?.querySelector('.hub-nav')||fallbackViews,summary=hub?.querySelector('.hub-market-summary');
 if(views&&views!==section){const tools=document.createElement('div');tools.className='layout-market-tools';if(views.isConnected)views.before(tools);else root.querySelector('.dc-root')?.prepend(tools);tools.append(views);if(summary){tools.append(summary);summary.querySelector(':scope>.hub-source')?.remove();}}
 if(dataSection)for(const nav of root.querySelectorAll('.layout-market-tools>nav,.dc-root>.dc-section-nav')){nav.classList.add('data-subtabs');for(const a of nav.querySelectorAll('a'))a.setAttribute('aria-current',a.classList.contains('selected')?'page':'false');}
 root.querySelectorAll('.sc-toolbar,.sig-toolbar,.tc-filters,.df-toolbar,.dc-toolbar').forEach(n=>n.classList.add('layout-toolbar'));
 if(page==='assistant'&&root.querySelector('.chat-app.history-open')&&matchMedia('(max-width:900px)').matches){head.inert=true;root.querySelector('.layout-navigation-row').inert=true;}
 root.dataset.layout='unified';
 if(section){
  const revealCurrent=(saved=null)=>{
   if(!section.isConnected)return;
   revealCurrentTab(section,section.querySelector('[aria-current=page],[aria-selected=true],[aria-pressed=true],.active'),8);
   if(dataSection)for(const strip of root.querySelectorAll('.data-subtabs')){
    const tab=strip.querySelector('[aria-current=page]'),prior=saved?.get(strip.getAttribute('aria-label'));
    if(prior&&tab?.href===prior.href){
     strip.scrollLeft=prior.left;
     if(!prior.visible)continue;
    }
    revealCurrentTab(strip,tab);
   }
  };
  mediaEvents??=new AbortController();window.addEventListener('resize',()=>revealCurrent(),{signal:mediaEvents.signal});
  revealCurrent(retainedTabs);requestAnimationFrame(()=>revealCurrent(retainedTabs));
 }
 if(page==='settings'){
  const links=[...root.querySelectorAll('.ux-settings-index a[href^="#"]')];
  const select=link=>links.forEach(item=>item.setAttribute('aria-current',item===link?'location':'false'));
  select(links.find(link=>link.hash===root.ownerDocument.location.hash)||links[0]);
  for(const link of links)link.addEventListener('click',()=>select(link));
 }
}
