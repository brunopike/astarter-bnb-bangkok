const routes={
 research:/^(?:analyze|requests\/[A-Za-z0-9:_-]{8,96})$/,
 wallet:/^(?:nonce|message|verify|session|logout|invitation)$/,
 notifications:/^(?:state|command|request)$/,
 workspace:/^(?:state|save|request)$/,
 'strategy-drafts':/^(?:preview|get|adopt|request)$/
};

// Vercel rewrites append one route query; native HTTP retains the original path.
export function createPrivateApiRoute(group,handle){
 if(!Object.hasOwn(routes,group)||typeof handle!=='function')throw Error('PRIVATE_ROUTE_CONFIGURATION');
 const prefix='/api/'+group;
 return async function route(req,res){
  const original=req.url;
  try{
   if(typeof original!=='string'||original.length>2048||!original.startsWith('/')||original.startsWith('//'))throw Error();
   const url=new URL(original,'https://astarter.imstark.site');if(url.hash)throw Error();let path,search='';
   const nativePath=url.pathname.startsWith(prefix+'/')?decodeURIComponent(url.pathname.slice(prefix.length+1)):null;
   if(['workspace','notifications','strategy-drafts'].includes(group)){
    if(url.searchParams.has('route')){
     const values=url.searchParams.getAll('route');if(values.length!==1)throw Error();
     if(url.pathname!==prefix&&nativePath!==values[0])throw Error();path=values[0];url.searchParams.delete('route');
    }else path=nativePath;
    search=url.searchParams.size?'?'+url.searchParams.toString():'';
   }else if(url.searchParams.size===1&&url.searchParams.has('route')){
    const rewritten=url.searchParams.get('route');
    if(url.pathname===prefix||nativePath===rewritten)path=rewritten;
   }
   else if(!url.search)path=nativePath;
   if(typeof path!=='string'||!routes[group].test(path))throw Error();
   req.url=prefix+'/'+path+search;
  }catch{
   res.writeHead(400,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.end(JSON.stringify({ok:false,error:'REQUEST_INVALID',executionAuthority:'NONE'}));return;
  }
  try{return await handle(req,res);}
  finally{req.url=original;}
 };
}
