import {readFile} from 'node:fs/promises';
import {SITE_ORIGIN,routes,byPath,resolveSiteRoute,routeHref,pageMeta,alternatePaths,languagePath} from './site-routes.mjs';
import {seoLanguages,seoLanguage,noScriptLabels} from './site-languages.mjs';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const publicRoutes=routes.filter(r=>r.indexable);
const image=SITE_ORIGIN+'/brand/astarter-share.png';
const altLinks=(route,xml=false)=>alternatePaths(route).map(([lang,path])=>xml?
 '<xhtml:link rel="alternate" hreflang="'+lang+'" href="'+esc(SITE_ORIGIN+path)+'"/>':
 '<link rel="alternate" hreflang="'+lang+'" href="'+esc(SITE_ORIGIN+path)+'">').join('\n');
const sitemap='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'+
 publicRoutes.flatMap(r=>Object.keys(seoLanguages).map(lang=>'<url><loc>'+esc(SITE_ORIGIN+languagePath(r,lang))+'</loc>'+altLinks(r,true)+'</url>')).join('\n')+'</urlset>';
const tag=(key,value,og=false)=>'<meta '+(og?'property':'name')+'="'+key+'" content="'+esc(value)+'">';
export function pageHtml(template,route,url){
 const lang=seoLanguage(url.searchParams.get('lang')),m=pageMeta(route,lang,url.searchParams);
 const indexed=m.robots.startsWith('index'),social={'og:type':'website','og:site_name':'Astarter','og:title':m.title,'og:description':m.description,'og:url':m.canonical,'og:locale':m.ogLocale,'og:image':image,'og:image:width':'1200','og:image:height':'630','og:image:alt':'Astarter'};
 const schema={'@context':'https://schema.org','@type':'WebPage',url:m.canonical,name:m.name,description:m.description,inLanguage:m.language,isPartOf:{'@type':'WebSite',name:'Astarter',url:SITE_ORIGIN+'/'}};
 const head=['<title>'+esc(m.title)+'</title>',tag('description',m.description),tag('robots',m.robots),'<link rel="canonical" href="'+esc(m.canonical)+'">',
 indexed?altLinks(route):'',...Object.entries(social).map(([k,v])=>tag(k,v,true)),tag('twitter:card','summary_large_image'),tag('twitter:title',m.title),tag('twitter:description',m.description),tag('twitter:image',image),indexed?'<script type="application/ld+json">'+JSON.stringify(schema).replace(/</g,'\\u003c')+'</script>':''].join('\n');
 
 const nav=publicRoutes.map(r=>'<a href="'+esc(languagePath(r,lang))+'">'+esc(pageMeta(r,lang,url.searchParams).name)+'</a>').join(' · ');
 const fallback='<noscript><style>body.app-loading{overflow:auto}body.app-loading>noscript{display:block;visibility:visible!important}body.app-loading>:not(noscript){display:none!important}.site-directory{padding:2rem;max-width:60rem;margin:auto;line-height:1.7}.site-directory a{color:inherit}</style><main class="site-directory"><h1>'+esc(m.name)+'</h1><p>'+esc(m.description)+'</p><nav>'+nav+'</nav><p>'+noScriptLabels[lang]+'</p></main></noscript>';
 return template.replace(/<html lang="[^"]+"/,'<html lang="'+m.language+'"').replace(/<title>[^<]*<\/title>/,head).replace(/<body\b[^>]*>/,match=>match+fallback);
}
export async function serveSitePage(req,res,templateFile){
 if(req.method!=='GET'&&req.method!=='HEAD')return false;
 if(!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))return false;
 const url=new URL(req.url,SITE_ORIGIN),path=url.pathname;
 const send=(status,type,data)=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:data);};
 if(path==='/robots.txt'){send(200,'text/plain','User-agent: *\nDisallow: /api/\nSitemap: '+SITE_ORIGIN+'/sitemap.xml\n');return true;}
 if(path==='/sitemap.xml'){send(200,'application/xml',sitemap);return true;}
 const normalized=path.replace(/\/+$/,'')||'/';
 if(!byPath.has(normalized)&&!['/index.html','/deep-brain'].includes(normalized))return false;
 const route=resolveSiteRoute(url);
 if(!route){res.setHeader('X-Robots-Tag','noindex');send(404,'text/plain','Page not found');return true;}
 const dest=routeHref(url,SITE_ORIGIN);
 if(dest!==path+url.search){res.writeHead(308,{Location:dest});res.end();return true;}
 try{send(200,'text/html',pageHtml(await readFile(templateFile,'utf8'),route,url));}
 catch{send(503,'text/plain','Page temporarily unavailable');}
 return true;
}
