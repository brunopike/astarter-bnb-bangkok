import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSocialPostMedia,socialMediaAttributes} from './public-social-media.mjs';
import {canAutoRefresh} from './product-composition.mjs';

const handle='Sample_User',creator='445566',cdn='https://pbs.twimg.com',settle=()=>new Promise(r=>setImmediate(r));
const avatar=cdn+'/profile_images/334455/user_200x200.jpg';
const photo=(name,altText)=>({type:'photo',url:cdn+'/media/'+name+'.jpg?name=orig',altText});
const status=(id,photos=[])=>({code:200,status:{type:'status',provider:'twitter',id,url:'https://x.com/'+handle+'/status/'+id,
 author:{id:creator,screen_name:handle,protected:false,avatar_url:avatar},possibly_sensitive:false,media:{photos}}});
function harness(fetch){
 const doc=new EventTarget(),win=new EventTarget(),images=[],calls=[];let observer;
 doc.defaultView=win;doc.hidden=false;
 win.fetch=(url,init)=>{calls.push({url,init});return fetch(url,init);};
 win.IntersectionObserver=class{
  constructor(callback){this.callback=callback;this.observed=new Set();observer=this;}
  observe(target){this.observed.add(target);}
  unobserve(target){this.observed.delete(target);}
  disconnect(){this.observed.clear();}
 };
 function element(tag){
  const node={tag,ownerDocument:doc,dataset:{},childNodes:[],setAttribute(key,value){this[key]=value;},
   focus(){doc.activeElement=this;},get childElementCount(){return this.childNodes.length;},
   replaceChildren(...nodes){if(this.childNodes.includes(doc.activeElement))doc.activeElement=null;this.childNodes=nodes;},
   append(node){this.childNodes.push(node);},insertBefore(node,next){this.childNodes.splice(next?this.childNodes.indexOf(next):this.childNodes.length,0,node);}};
  if(tag==='img')images.push(node);
  return node;
 }
 doc.createElement=element;
 const root={isConnected:true,ownerDocument:doc,cards:[],querySelectorAll(){return this.cards;},contains(card){return this.cards.includes(card);}};
 function card(id,screenName=handle,userId=creator){
  const el=element('article'),face=element('span'),gallery=element('div');
  el.dataset={socialPost:id,socialXHandle:screenName,socialXCreator:userId};face.childNodes=[screenName[0]];gallery.hidden=true;
  el.face=face;el.gallery=gallery;el.querySelector=s=>s==='[data-social-avatar]'?face:s==='[data-social-photos]'?gallery:null;return el;
 }
 return {root,doc,win,images,calls,card,bind(...cards){root.cards=cards;bindSocialPostMedia(root);},
  visible(...cards){observer.callback(cards.map(target=>({target,isIntersecting:true})));}};
}

test('media markers require a curated X record, a matching source permalink, account and native ID',()=>{
 const data={platform:'X',metric_kind:'LUNARCRUSH_POST',post_id:'12345',url:'https://x.com/sample_user/status/12345',author:{acct:handle},kol:{creatorId:'twitter::'+creator}};
 const attrs=(patch={},provider_id='lunarcrush-v4')=>socialMediaAttributes({provider_id,data:{...data,...patch}});
 assert.match(attrs(),/data-social-x-handle="Sample_User" data-social-x-creator="445566"/);
 for(const patch of [{platform:'YouTube'},{post_id:'bad'},{author:{acct:'" onload="'}},{kol:{creatorId:'twitter::unknown'}},
  ...['http://x.com/sample_user/status/12345','https://x.com.evil.test/sample_user/status/12345','https://evil@x.com/sample_user/status/12345','https://x.com/other/status/12345','https://x.com/sample_user/status/456'].map(url=>({url}))])assert.equal(attrs(patch),'');
 assert.equal(attrs({},'mastodon-tag-v1'),'');
});

test('background refresh waits for the keyboard to leave the gallery',t=>{
 const original=globalThis.document;
 t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original;});
 const focusedPhoto={matches:selector=>selector.includes('.pd-post-media a')};
 globalThis.document={querySelector:()=>null,activeElement:focusedPhoto};
 const root={contains:node=>node===focusedPhoto,querySelector:()=>null,querySelectorAll:()=>[]};
 assert.equal(canAutoRefresh(root),false);
 globalThis.document.activeElement=null;assert.equal(canAutoRefresh(root),true);
});

test('a swiped gallery restores its position through redraws only for the same route and verified post',async()=>{
 const id='100006',second='100007';
 const h=harness(async url=>Response.json(status(url.split('/').pop(),[photo('one'),photo('two'),photo('three')])));
 h.win.location={search:'?page=social'};
 const original=h.card(id);h.bind(original);h.visible(original);await settle();h.images.forEach(img=>img.onload());
 original.gallery.scrollLeft=240;original.gallery.onscroll();
 const waiting=h.card(id),same=h.card(id),other=h.card(second);
 h.bind(waiting);h.bind(other,same);h.visible(other,same);await settle();
 h.images.slice(4).forEach(img=>img.src.includes('/three?')?img.onerror():img.onload());
 assert.equal(same.gallery.scrollLeft,240);assert.equal(other.gallery.scrollLeft||0,0);
 const moved=h.card(id);h.win.location.search='?page=intelligence';
 h.bind(moved);h.visible(moved);await settle();h.images.slice(-3).forEach(img=>img.onload());
 assert.equal(moved.gallery.scrollLeft||0,0);h.bind();
});

test('viewport-gated cards attach only verified CDN photos in original order with source links and escaped DOM text',async()=>{
 const id='100001',body=status(id,[photo('first','<caption>'),photo('second'),{type:'photo',url:'https://pbs.twimg.com.evil.test/media/no.jpg'},photo('first')]);
 body.status.quote=status('999',[photo('quote')]).status;
 const h=harness(async()=>Response.json(body)),card=h.card(id);h.bind(card);assert.equal(h.calls.length,0);
 h.doc.hidden=true;h.visible(card);assert.equal(h.calls.length,0);
 h.doc.hidden=false;h.doc.dispatchEvent(new Event('visibilitychange'));await settle();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'https://api.fxtwitter.com/2/status/'+id);
 assert.equal(h.calls[0].init.credentials,'omit');assert.equal(h.calls[0].init.referrerPolicy,'no-referrer');assert.equal(h.calls[0].init.redirect,'error');
 assert.deepEqual(h.images.map(i=>i.src),[avatar,cdn+'/media/first?format=jpg&name=small',cdn+'/media/second?format=jpg&name=small']);
 assert.equal(card.gallery.hidden,true);assert.deepEqual(card.face.childNodes,['S']);
 h.images[2].onload();const focusedPhoto=card.gallery.childNodes[0];focusedPhoto.focus();
 h.images[1].onload();h.images[0].onload();assert.equal(h.doc.activeElement,focusedPhoto);
 assert.equal(card.gallery.hidden,false);assert.equal(card.gallery.dataset.count,'2');assert.equal(card.face.childNodes[0],h.images[0]);
 const [first,second]=card.gallery.childNodes;
 assert.equal(first.href,'https://x.com/'+handle+'/status/'+id+'/photo/1');assert.equal(first.childNodes[0].alt,'<caption>');
 assert.equal(second.href,'https://x.com/'+handle+'/status/'+id+'/photo/2');assert.equal(second.childNodes[0].alt,'');assert.match(second['aria-label'],/2$/);
 assert.ok(h.images.every(i=>i.crossOrigin==='anonymous'&&i.referrerPolicy==='no-referrer'));
 h.bind(card);h.visible(card);await settle();assert.equal(h.calls.length,1);assert.equal(h.images.length,3);h.bind();
});

test('repaint reuses the in-flight read and metadata, while ID or creator mismatches cannot borrow cached media',async()=>{
 const id='100002';let release;
 const h=harness(()=>new Promise(resolve=>{release=resolve;}));
 const old=h.card(id),next=h.card(id);h.bind(old);h.visible(old);h.bind(next);h.visible(next);assert.equal(h.calls.length,1);
 release(Response.json(status(id,[photo('real')])));await settle();h.images.forEach(i=>i.onload());
 assert.equal(old.gallery.hidden,true);assert.equal(next.gallery.dataset.count,'1');
 const copy=h.card(id);h.bind(copy);h.visible(copy);await settle();assert.equal(h.calls.length,1);
 const late=h.images.at(-1),other=h.card(id,'other_user');h.bind(other);h.visible(other);late.onload();assert.equal(other.gallery.hidden,true);
 assert.equal(h.calls.length,2);release(Response.json(status(id,[photo('wrong')])));await settle();
 assert.deepEqual(other.face.childNodes,['o']);assert.equal(other.gallery.hidden,true);
 const wrongId=h.card(id,handle,'9999');h.bind(wrongId);h.visible(wrongId);release(Response.json(status(id,[photo('wrong')])));await settle();assert.equal(wrongId.gallery.hidden,true);
 h.bind();
});

test('failed media and text-only posts stay text-only through repaints',async()=>{
 const id='100003';let enabled=false;
 const h=harness(async()=>enabled?Response.json(status(id)):new Response('{}',{status:502}));
 const a=h.card(id);h.bind(a);h.visible(a);await settle();assert.equal(h.images.length,0);
 const retry=h.card(id);h.bind(retry);h.visible(retry);await settle();assert.equal(h.calls.length,1);
 enabled=true;const textId='100004',text=status(textId);delete text.status.possibly_sensitive;
 h.win.fetch=async()=>Response.json(text);
 const plain=h.card(textId);h.bind(plain);h.visible(plain);await settle();assert.deepEqual(h.images.map(i=>i.src),[avatar]);
 h.images[0].onerror();assert.deepEqual(plain.face.childNodes,['S']);assert.equal(plain.gallery.hidden,true);
 const again=h.card(textId);h.bind(again);h.visible(again);await settle();assert.equal(h.images.length,1);assert.equal(again.gallery.hidden,true);h.bind();
});

test('tombstones, protected authors, sensitive posts and unsafe URLs cannot surface attachments',async()=>{
 const patches=[{type:'tombstone'},{possibly_sensitive:true},{community:{is_nsfw:true}},
  {author:{id:creator,screen_name:handle,avatar_url:avatar,protected:true}},{id:'9999'},{url:'https://x.com/other/status/100005'}];
 for(const [i,patch] of patches.entries()){
  const id=String(200000+i),body=status(id,[photo('private')]);Object.assign(body.status,patch);
  const h=harness(async()=>Response.json(body)),card=h.card(id);h.bind(card);h.visible(card);await settle();
  assert.equal(h.images.length,0);assert.equal(card.gallery.hidden,true);h.bind();
 }
 const id='200099',body=status(id,[{type:'photo',url:'https://evil@pbs.twimg.com/media/bad.jpg'},{type:'photo',url:cdn+'/profile_images/12/file.jpg'},{type:'video',url:cdn+'/media/still.png'}]);
 body.status.author.avatar_url='https://evil.test/fallback.png';const h=harness(async()=>Response.json(body)),card=h.card(id);h.bind(card);h.visible(card);await settle();assert.equal(h.images.length,0);h.bind();
});

test('navigating away aborts visible reads, ignores their late answers and releases the observer',async()=>{
 let reply;const h=harness(()=>new Promise(r=>{reply=r;})),card=h.card('300001');h.bind(card);h.visible(card);h.bind();
 assert.equal(h.calls[0].init.signal.aborted,true);reply(Response.json(status('300001',[photo('late')])));await settle();
 assert.equal(h.images.length,0);assert.equal(card.gallery.hidden,true);
});

test('expired media is removed before rechecking the visible post and a deletion cannot restore old photos',async t=>{
 let at=Date.now();t.mock.method(Date,'now',()=>at);
 const id='300002',prior=status(id,[photo('old')]),removed={code:200,status:{type:'tombstone',reason:'deleted',id}};
 const replies=[prior,removed],h=harness(async()=>Response.json(replies.shift())),card=h.card(id);
 h.bind(card);h.visible(card);await settle();h.images.forEach(img=>img.onload());assert.equal(card.gallery.dataset.count,'1');
 at+=300001;h.bind(card);assert.equal(card.gallery.hidden,true);assert.deepEqual(card.face.childNodes,['S']);await settle();
 h.images.at(-1).onload();assert.equal(h.calls.length,2);assert.equal(card.gallery.hidden,true);h.bind();
});

test('rate limiting protects other visible posts and oversized metadata cannot supply images',async t=>{
 let at=Date.now();t.mock.method(Date,'now',()=>at);
 const id='300003',oversized='x'.repeat(256*1024+1);
 const responses=[new Response('',{status:429,headers:{'Retry-After':'120'}}),new Response(oversized,{headers:{'Content-Type':'application/json'}})];
 const h=harness(async()=>responses.shift()),a=h.card(id),b=h.card('300004');h.bind(a);h.visible(a);await settle();
 h.bind(b);h.visible(b);assert.equal(h.calls.length,1);at+=119999;h.bind(b);assert.equal(h.calls.length,1);
 at+=2;h.bind(b);await settle();assert.equal(h.calls.length,2);assert.equal(h.images.length,0);assert.equal(b.gallery.hidden,true);h.bind();
});
