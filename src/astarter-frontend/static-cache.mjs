const STATIC_EXT=new Set(['.css','.js','.mjs','.svg','.png','.webp','.woff2','.glb']);
const DAY='public, max-age=86400, stale-while-revalidate=604800';
const IMMUTABLE='public, max-age=31536000, immutable';
const REVALIDATE='no-cache';

function contentHashed(name,url){
 if(/^fonts\/[a-z-]+-[0-9a-f]{12}\.woff2$/.test(name)||/^boot\/part-[A-Z0-9]+\.js$/.test(name))return true;
 const query=String(url||'').split('?')[1]||'';
 return /(?:^|&)v=[0-9a-f]{12}(?:&|$)/.test(query);
}

export function staticCacheControl(file,url=''){
 const name=String(file||'').split('?')[0];
 const dot=name.lastIndexOf('.');
 const ext=dot<0?'':name.slice(dot).toLowerCase();
 if(name==='brain-evidence/daily-markets.json')return REVALIDATE;
 if(!STATIC_EXT.has(ext))return 'no-store';
 if(contentHashed(name,url))return IMMUTABLE;
 if(ext==='.js'||ext==='.mjs'||ext==='.css')return REVALIDATE;
 return DAY;
}

export function staticEtag(size,mtimeMs){
 return `"${Number(size).toString(16)}-${Math.floor(Number(mtimeMs)).toString(16)}"`;
}

const opaque=value=>String(value||'').trim().replace(/^W\//,'');
export function staticNotModified(header,etag){
 const expected=opaque(etag);
 return expected.length>0&&String(header||'').split(',').some(item=>opaque(item)===expected);
}
