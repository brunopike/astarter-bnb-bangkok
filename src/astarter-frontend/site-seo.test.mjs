import {sharedOutputURL} from './assistant-analysis.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {seoLanguages} from './site-languages.mjs';
import {routes,byId,routeHref,routeSearch,pageMeta,SITE_ORIGIN} from './site-routes.mjs';
import {pageHtml,serveSitePage} from './site-seo.mjs';
import {PAGES,routePage} from './product-data.mjs';
import {fullHrefFromLite,liteHrefFromFull} from './lite-navigation.mjs';
const shell='<!doctype html><html lang="en"><head><title>Astarter</title></head><body class="app-loading"></body></html>';
test('every product page or legacy alias has a reloadable address',()=>{
 for(const [page] of PAGES){
  const source=new URL('/?page='+page+'&view=grid#section',SITE_ORIGIN);
  const clean=new URL(routeHref(source),SITE_ORIGIN);
  assert.equal(clean.searchParams.has('page'),false,page);
  assert.equal(clean.searchParams.get('view'),'grid');
  const id=new URLSearchParams(routeSearch(clean)).get('page');assert.equal(id,({staking:'plans','my-strategies':'execution'})[page]||page);
  assert.equal(clean.hash,'#section');
 }
 assert.equal(routeHref('/?asset=ETH'),'/lenswave?asset=ETH');assert.equal(routeHref('/?page=brain'),'/');
 assert.equal(routeHref('/deep-brain/'),'/');assert.equal(routeHref('/?page=wealth&asset=BTC'),'/lenswave');
});
test('initial HTML contains one matching title, canonical, share image and useful no-script navigation',()=>{
 for(const r of routes)for(const lang of Object.keys(seoLanguages)){
  const u=new URL(r.path,SITE_ORIGIN);if(lang!=='en')u.searchParams.set('lang',lang);
  const m=pageMeta(r,lang,u.searchParams),html=pageHtml(shell,r,u);
  assert.equal(html.match(/<title>/g)?.length,1);
  assert.ok(html.includes('<title>'+m.title.replaceAll('&','&amp;')+'</title>'));
  assert.ok(html.includes('rel="canonical" href="'+m.canonical+'"'));assert.ok(html.includes('property="og:image"'));
  assert.ok(html.includes('<noscript>'));assert.ok(html.includes('href="/signals'));assert.ok(!html.includes('page='));
  assert.equal(html.includes('application/ld+json'),r.indexable);
 }
});
async function request(target,method='GET'){
 let status,headers={},body;
 const res={setHeader(k,v){headers[k]=v;},writeHead(s,h){status=s;Object.assign(headers,h);},end(v){body=v;}};
 const handled=await serveSitePage({url:target,method},res,new URL('./index.html',import.meta.url));return {status,headers,body,handled};
}
test('legacy links redirect once, private state is excluded and assets retain their handler',async()=>{
 for(const [source,want] of [['/?page=intelligence&view=calendar','/news?view=calendar'],['/signals/','/signals'],['/index.html','/']]){
  const r=await request(source);assert.equal(r.status,308);assert.equal(r.headers.Location,want);
  assert.equal((await request(want)).status,200);
 }
 const site=await request('/sitemap.xml');assert.match(site.headers['Content-Type'],/xml/);assert.equal((site.body.match(/<url>/g)||[]).length,Object.keys(seoLanguages).length*routes.filter(r=>r.indexable).length);
 for(const r of routes.filter(x=>!x.indexable))assert.ok(!site.body.includes('<loc>'+SITE_ORIGIN+r.path+'</loc>'));
 const risk=await request('/agents?privateDraft=one');assert.match(risk.body,/name="robots" content="noindex, follow"/);assert.ok(!risk.body.includes('privateDraft'));
 assert.equal((await request('/?page=absent')).status,404);
 assert.equal((await request('/api/assistant/chat')).handled,false);assert.equal((await request('/fonts/foo.woff2')).handled,false);
 assert.equal((await request('/signals','HEAD')).body,undefined);
 assert.match((await request('/robots.txt')).body,/Sitemap: https:\/\/demo\.astarter\.io\/sitemap\.xml/);
});

test('shared assistant links use the chat path and keep the conversation in the fragment',()=>{
 const u=new URL(sharedOutputURL(SITE_ORIGIN+'/profile?wallet=ignore','v1.abc','DEMO42'));
 assert.equal(u.pathname,'/chat');assert.equal(u.search,'?ref=DEMO42');assert.equal(u.hash,'#astarter-share=v1.abc');
});


test('edition switches open each home with only the chosen locale',async()=>{
 const page=await request('/lite?lang=zh');
 assert.equal(page.status,200);assert.match(page.body,/class="topbar"/);assert.match(page.body,/src="\/app\.js(?:\?|")/);
 assert.equal(routePage(routeSearch(new URL("/lite?mode=practice",SITE_ORIGIN))),"lite");
 assert.equal((await request('/?page=lite&mode=practice')).headers.Location,'/lite?mode=practice');
 const context={asset:'eth',signalId:'ETH:1m:1795000000000',lang:'zh',mode:'practice',wallet:'private'};
 const full=new URL(fullHrefFromLite(context),SITE_ORIGIN);
 assert.equal(full.pathname,'/');assert.equal(routePage(routeSearch(full)),'brain');
 assert.deepEqual(Object.fromEntries(full.searchParams),{lang:'zh'});
 const lite=new URL(liteHrefFromFull(context),SITE_ORIGIN);
 assert.equal(lite.pathname,'/lite');assert.deepEqual(Object.fromEntries(lite.searchParams),{lang:'zh'});
 assert.equal(fullHrefFromLite({...context,signalId:'practice:ETH:123'}),'/?lang=zh');
});
