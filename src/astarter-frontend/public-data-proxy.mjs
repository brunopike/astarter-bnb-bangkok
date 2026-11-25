import {randomUUID} from 'node:crypto';
import {PUBLIC_RESOURCES,publicQuery,validatePublicEnvelope,publicRetryDelay} from './public-data-client.mjs';
const UPSTREAM='http://127.0.0.1:8765';
const WEB_ORIGIN='http://127.0.0.1:4188';
const paths=new Map(Object.entries(PUBLIC_RESOURCES).map(([key,path])=>['/api/v1/data/'+path,key]));
const errors={INVALID_QUERY:'The requested filters are invalid.',DATA_SERVICE_UNAVAILABLE:'Data service is unavailable.',DATA_INTERNAL_ERROR:'Data service returned an invalid response.',METHOD_NOT_ALLOWED:'Only GET is available.',INVALID_HOST:'This endpoint is local only.',NOT_FOUND:'This data endpoint is unavailable.'};
export async function handlePublicData(req,res,{port=4188,fetchImpl=globalThis.fetch,timeoutMs=7000,maxBytes=1000000}={}){
 if(!req.url?.startsWith('/api/'))return false;
 let selection=0;
 const fail=(status,code,retryAfter=null)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(retryAfter===null?{}:{'Retry-After':String(Math.ceil(retryAfter/1000))}),...(status===405?{Allow:'GET'}:{})});res.end(JSON.stringify({schema_version:'AstarterPublicDataError.v1',request_id:randomUUID(),selection_version:selection,code,message:errors[code],retryable:status===503}));return true;};
 if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))return fail(403,'INVALID_HOST');
 if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))return fail(403,'INVALID_HOST');
 if(req.method!=='GET')return fail(405,'METHOD_NOT_ALLOWED');
 let url,resource,query;
 try{
  if(req.url.length>2000)throw new Error('INVALID_QUERY');url=new URL(req.url,WEB_ORIGIN);resource=paths.get(url.pathname);
  if(!resource)return fail(404,'NOT_FOUND');query=publicQuery(resource,url.searchParams);selection=query.selection_version;
 }catch{return fail(400,'INVALID_QUERY');}
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const target=new URL('/v1/data/'+PUBLIC_RESOURCES[resource],UPSTREAM);target.search=new URLSearchParams(query).toString();
  const response=await fetchImpl(target,{method:'GET',headers:{Accept:'application/json',Origin:WEB_ORIGIN},redirect:'manual',signal:controller.signal});
  if(response.status===503||response.status===429)return fail(503,'DATA_SERVICE_UNAVAILABLE',publicRetryDelay(response.headers.get('Retry-After')));
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return fail(500,'DATA_INTERNAL_ERROR');
  const reader=response.body?.getReader();if(!reader)return fail(500,'DATA_INTERNAL_ERROR');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();return fail(500,'DATA_INTERNAL_ERROR');}chunks.push(value);}
  let body;try{body=JSON.parse(Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8'));validatePublicEnvelope(body,resource,query);}catch{return fail(500,'DATA_INTERNAL_ERROR');}
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;
 }catch{return fail(503,'DATA_SERVICE_UNAVAILABLE');}
 finally{clearTimeout(timer);controller.abort();}
}
