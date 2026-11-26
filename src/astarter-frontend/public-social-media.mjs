import {pair as L} from './locale.mjs';
import {publicRetryDelay} from './public-data-client.mjs';

const handlePattern=/^[A-Za-z0-9_]{1,15}$/,idPattern=/^[1-9]\d{0,19}$/;
const xHosts=new Set(['x.com','www.x.com','twitter.com','www.twitter.com']);
const selector='article[data-social-post][data-social-x-handle][data-social-x-creator]';
const roots=new WeakMap(),cache=new Map();
const ttl=5*60_000,maxBytes=256*1024;
let limitedUntil=0;

function postMatches(link,id,handle){
 try{
  const u=new URL(link),match=/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/.exec(u.pathname);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&xHosts.has(u.hostname)&&
   match?.[1].toLowerCase()===handle.toLowerCase()&&match[2]===id;
 }catch{return false;}
}

export function socialMediaAttributes(item){
 const d=item?.data,handle=d?.author?.acct,creator=/^twitter::([1-9]\d{0,19})$/.exec(d?.kol?.creatorId||d?.creator_id||'');
 if(item?.provider_id!=='lunarcrush-v4'||d?.metric_kind!=='LUNARCRUSH_POST'||d.platform!=='X'||!creator||
   typeof handle!=='string'||!handlePattern.test(handle)||typeof d.post_id!=='string'||!idPattern.test(d.post_id)||!postMatches(d.url,d.post_id,handle))return '';
 return ` data-social-x-handle="${handle}" data-social-x-creator="${creator[1]}"`;
}

function cdnImage(value,avatar=false){
 try{
  const url=new URL(value);
  if(url.origin!=='https://pbs.twimg.com'||url.username||url.password)return null;
  if(avatar)return /^\/profile_images\/\d{1,20}\/[\w-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)?url.origin+url.pathname:null;
  const photo=/^\/media\/([\w-]+)(?:\.(jpg|jpeg|png|webp))?$/i.exec(url.pathname);
  const format=photo&&(photo[2]||url.searchParams.get('format'))?.toLowerCase();
  if(!['jpg','jpeg','png','webp'].includes(format))return null;
  return url.origin+'/media/'+photo[1]+'?format='+(format==='jpeg'?'jpg':format)+'&name=small';
 }catch{return null;}
}

function focalMedia(body,{id,handle,creator}){
 const post=body?.status,author=post?.author;
 if(body?.code!==200||post?.type!=='status'||post.provider!=='twitter'||post.id!==id||!postMatches(post.url,id,handle)||
   author?.protected!==false||author.id!==creator||typeof author.screen_name!=='string'||author.screen_name.toLowerCase()!==handle.toLowerCase()||
   post.possibly_sensitive===true||post.community?.is_nsfw===true)return null;
 const photos=[],seen=new Set();
 if(post.possibly_sensitive===false&&Array.isArray(post.media?.photos)){
  for(const [index,photo] of post.media.photos.slice(0,4).entries()){
   const url=photo?.type==='photo'&&cdnImage(photo.url);
   if(!url||seen.has(url))continue;
   seen.add(url);photos.push({url,index:index+1,alt:typeof photo.altText==='string'?photo.altText.trim().slice(0,1500):''});
  }
 }
 return {avatar:cdnImage(author.avatar_url,true),photos,failed:new Set()};
}

async function readMedia(win,identity,signal){
 const response=await win.fetch('https://api.fxtwitter.com/2/status/'+identity.id,{
  method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal
 });
 if(response.status===429)limitedUntil=Date.now()+Math.max(60_000,publicRetryDelay(response.headers.get('Retry-After'),Date.now())||0);
 if(!response.ok||!response.headers.get('Content-Type')?.startsWith('application/json')||Number(response.headers.get('Content-Length'))>maxBytes)return null;
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let text='',size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>maxBytes){await reader.cancel();return null;}
   text+=decoder.decode(value,{stream:true});
  }
 }finally{reader.releaseLock();}
 return focalMedia(JSON.parse(text+decoder.decode()),identity);
}

// Keep the following post under the reader's eyes if an earlier photo changes height.
function preserveReadingPosition(root,card,change){
 const anchor=card.nextElementSibling||card.querySelector('footer');
 const viewport=root.scrollTop>0&&root.getBoundingClientRect?.();
 const before=viewport&&anchor?.getBoundingClientRect?.().top;
 const reading=Number.isFinite(before)&&before<=viewport.top+Math.min(120,viewport.height/4);
 change();
 if(reading){
  const shift=anchor.getBoundingClientRect().top-before;
  if(Math.abs(shift)>.5)root.scrollTop+=shift;
 }
}

function showMedia(root,card,identity,media){
 const doc=card.ownerDocument,avatar=card.querySelector('[data-social-avatar]'),gallery=card.querySelector('[data-social-photos]');
 const current=()=>identity.painted?.media===media&&root.isConnected!==false&&root.contains(card)&&card.dataset.socialPost===identity.id&&
  card.dataset.socialXHandle===identity.handle&&card.dataset.socialXCreator===identity.creator;
 function image(url,alt,onLoad,onSettled){
  if(media.failed.has(url)){onSettled?.();return;}
  const img=doc.createElement('img');img.alt=alt;img.decoding='async';img.crossOrigin='anonymous';img.referrerPolicy='no-referrer';
  img.onload=()=>{if(current())onLoad(img);onSettled?.();};
  img.onerror=()=>{media.failed.add(url);onSettled?.();};
  img.src=url;
 }
 if(avatar&&media.avatar)image(media.avatar,'',img=>avatar.replaceChildren(img));
 if(!gallery)return;
 const anchors=[];
 const expected=media.photos.filter(photo=>!media.failed.has(photo.url)).length;
 let photosPending=media.photos.length;
 function photoSettled(){
  if(--photosPending||!current())return;
  const count=gallery.childElementCount;
  if(count&&String(count)!==gallery.dataset.count){
   preserveReadingPosition(root,card,()=>{gallery.dataset.count=String(count);});
  }
  if(identity.left)gallery.scrollLeft=identity.left;
 }
 for(const photo of media.photos)image(photo.url,photo.alt,img=>{
  const link=doc.createElement('a');link.href='https://x.com/'+identity.handle+'/status/'+identity.id+'/photo/'+photo.index;
  link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';
  if(!photo.alt)link.setAttribute('aria-label',L('前往来源','View source')+' · '+photo.index);
  link.append(img);
  preserveReadingPosition(root,card,()=>{
   gallery.insertBefore(link,anchors.slice(photo.index).find(Boolean)||null);
   anchors[photo.index-1]=link;
   gallery.dataset.count=String(expected);gallery.hidden=false;
  });
 },photoSettled);
}

function resetMedia(root,card,row){
 row.painted=null;
 const avatar=card.querySelector('[data-social-avatar]'),gallery=card.querySelector('[data-social-photos]');
 if(avatar)avatar.replaceChildren(...row.fallback);
 if(gallery&&!gallery.hidden)preserveReadingPosition(root,card,()=>{
  gallery.replaceChildren();gallery.hidden=true;delete gallery.dataset.count;
 });
}

function observe(root){
 const doc=root.ownerDocument,win=doc.defaultView,targets=new Map(),pending=new Map();
 let currentRoute=win.location?.search;
 const observer=new win.IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries){const row=targets.get(target);if(row)row.visible=isIntersecting;}
  pump();
 });
 function cancel(key){
  const controller=pending.get(key);pending.delete(key);controller.abort();
 }
 function pause(){for(const key of pending.keys())cancel(key);}
 function visibility(){if(doc.hidden)pause();else pump();}
 const afterNavigation=()=>queueMicrotask(()=>bindSocialPostMedia(root));
 doc.addEventListener('visibilitychange',visibility);
 win.addEventListener('pagehide',pause);win.addEventListener('pageshow',visibility);win.addEventListener('popstate',afterNavigation);
 function pump(){
  if(doc.hidden||root.isConnected===false)return;
  for(const [card,row] of targets){
   if(!row.visible||!root.contains(card))continue;
   const hit=cache.get(row.key);
   if(hit&&Date.now()<hit.until){
    if(row.painted===hit)continue;
    row.painted=hit;if(hit.media)showMedia(root,card,row,hit.media);
    continue;
   }
   if(row.painted)resetMedia(root,card,row);
   if(pending.has(row.key)||pending.size>=3||Date.now()<limitedUntil)continue;
   const controller=new AbortController();pending.set(row.key,controller);
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
   void readMedia(win,row,signal).catch(()=>null).then(media=>{
    if(pending.get(row.key)!==controller)return;
    pending.delete(row.key);
    cache.delete(row.key);cache.set(row.key,{media,until:Date.now()+ttl});
    if(cache.size>128)cache.delete(cache.keys().next().value);
    pump();
   });
  }
 }
 return {
  sync(cards){
   const present=new Set(cards),keys=new Set(),positions=new Map(),sameRoute=currentRoute===win.location?.search;
   currentRoute=win.location?.search;
   for(const [card,row] of targets)if(!present.has(card)){
    if(sameRoute&&row.left)positions.set(row.key,row.left);
    row.painted=null;targets.delete(card);observer.unobserve(card);
   }
   for(const card of present){
    const {socialPost:id,socialXHandle:handle,socialXCreator:creator}=card.dataset;
    if(!idPattern.test(id)||!idPattern.test(creator)||typeof handle!=='string'||!handlePattern.test(handle))continue;
    const key=[id,handle.toLowerCase(),creator].join(':');keys.add(key);
    const previous=targets.get(card);if(previous?.key===key)continue;
    if(previous)resetMedia(root,card,previous);
    const fallback=Array.from(card.querySelector('[data-social-avatar]')?.childNodes||[]);
    const row={id,handle,creator,key,visible:false,painted:null,fallback,left:positions.get(key)||0};
    const gallery=card.querySelector('[data-social-photos]');
    if(gallery)gallery.onscroll=()=>{if(!gallery.hidden)row.left=gallery.scrollLeft;};
    targets.set(card,row);observer.observe(card);
   }
   for(const key of pending.keys())if(!keys.has(key))cancel(key);
   pump();
  },
  stop(){
   observer.disconnect();for(const row of targets.values())row.painted=null;targets.clear();pause();
   doc.removeEventListener('visibilitychange',visibility);
   win.removeEventListener('pagehide',pause);win.removeEventListener('pageshow',visibility);win.removeEventListener('popstate',afterNavigation);
  }
 };
}

export function bindSocialPostMedia(root){
 if(!root?.ownerDocument?.defaultView?.IntersectionObserver)return;
 const cards=root.isConnected===false?[]:root.querySelectorAll(selector);
 let state=roots.get(root);
 if(!cards.length){state?.stop();roots.delete(root);return;}
 if(!state){state=observe(root);roots.set(root,state);}
 state.sync(cards);
}
