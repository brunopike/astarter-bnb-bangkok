import {SITE_ORIGIN,byId,pageMeta,alternatePaths} from './site-routes.mjs';
let last='';
export function syncSiteMeta(id,language,search){
 const route=byId.get(id);if(!route)return;
 const m=pageMeta(route,language,new URLSearchParams(search)),key=[id,m.language,m.robots].join('|');
 if(key===last)return;
 last=key;document.title=m.title;
 const put=(selector,attribute,value)=>document.head.querySelector(selector)?.setAttribute(attribute,value);
 put('link[rel="canonical"]','href',m.canonical);
 for(const [key,value] of Object.entries({description:m.description,robots:m.robots,'twitter:title':m.title,'twitter:description':m.description}))put('meta[name="'+key+'"]','content',value);
 for(const [key,value] of Object.entries({title:m.title,description:m.description,url:m.canonical,locale:m.ogLocale}))put('meta[property="og:'+key+'"]','content',value);
 for(const link of document.head.querySelectorAll('link[hreflang]'))link.remove();
 const old=document.head.querySelector('script[type="application/ld+json"]');old?.remove();
 if(!m.robots.startsWith('index'))return;
 for(const [lang,path] of alternatePaths(route)){
  const link=document.createElement('link');link.rel='alternate';link.hreflang=lang;link.href=SITE_ORIGIN+path;document.head.append(link);
 }
 const schema=document.createElement('script');schema.type='application/ld+json';
 schema.textContent=JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url:m.canonical,name:m.name,description:m.description,inLanguage:m.language,isPartOf:{'@type':'WebSite',name:'Astarter',url:SITE_ORIGIN+'/'}});
 document.head.append(schema);
}
