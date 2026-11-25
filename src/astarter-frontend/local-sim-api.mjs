const prefix='/api/local-sim';
const limit=65536;
const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const invalid=new Set(['COMMAND_INVALID','PLAN_INVALID','RECEIPT_INVALID','PRICE_INVALID','PRICE_CLOCK_INVALID','FIXTURE_SCOPE_INVALID']);
function statusFor(code){
 if(code==='REQUEST_NOT_FOUND')return 404;
 if(code==='FIXTURE_SCOPE_MISMATCH'||code==='SCOPE_MISMATCH'||code==='RECEIPT_SCOPE_MISMATCH')return 403;
 if(invalid.has(code))return 400;
 if(['OWNER_FENCED','REVISION_CONFLICT','REQUEST_CONFLICT','RECEIPT_CONFLICT','STORE_CAS_CONFLICT'].includes(code))return 409;
 if(code==='OWNER_STOPPED'||code==='OUTCOME_UNKNOWN_QUERY'||code?.startsWith('STORE_'))return 503;
 return 422;
}
function write(res,status,payload){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(JSON.stringify(payload));
}
async function readBody(req){
 const announced=req.headers['content-length'];
 if(announced!==undefined&&(!/^\d+$/.test(announced)||Number(announced)>limit))throw Object.assign(Error('BODY_TOO_LARGE'),{status:413});
 let size=0;const parts=[];
 for await(const part of req){size+=part.length;if(size>limit)throw Object.assign(Error('BODY_TOO_LARGE'),{status:413});parts.push(part);}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(Error('COMMAND_INVALID'),{status:400});}
}

// The caller explicitly owns startup and storage; constructing a handler starts nothing.
export function createLocalSimHandler({owner,origin='http://127.0.0.1:4188'}={}){
 const expected=new URL(origin);
 if(expected.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(expected.hostname)||expected.origin!==origin)throw Error('LOCAL_ORIGIN_INVALID');
 return async function handleLocalSim(req,res){
  let target;
  try{target=new URL(req.url,origin);}catch{return false;}
  if(target.pathname!==prefix&&!target.pathname.startsWith(prefix+'/'))return false;
  if(target.origin!==origin||req.headers.host!==expected.host||!loopback(req.socket.remoteAddress)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin!==undefined&&req.headers.origin!==origin){write(res,403,{ok:false,code:'LOCAL_ORIGIN_DENIED'});return true;}
  const path=target.pathname.slice(prefix.length);
  if(req.method==='GET'&&path==='/snapshot'){
   if(!owner){write(res,503,{ok:false,code:'OWNER_STOPPED'});return true;}
   const snapshot=owner.snapshot(),running=snapshot.owner.state==='RUNNING';write(res,running?200:503,{ok:running,...(running?{}:{code:'OWNER_STOPPED'}),snapshot});return true;
  }
  if(req.method==='GET'&&path.startsWith('/requests/')){
   if(!owner){write(res,503,{ok:false,code:'OWNER_STOPPED'});return true;}
   let requestId;try{requestId=decodeURIComponent(path.slice('/requests/'.length));}catch{write(res,400,{ok:false,code:'COMMAND_INVALID'});return true;}
   const result=owner.request(requestId);write(res,result.ok?200:statusFor(result.code),result);return true;
  }
  if(path==='/commands'&&req.method==='POST'){
   if(req.headers.origin!==origin){write(res,403,{ok:false,code:'LOCAL_ORIGIN_DENIED'});return true;}
   if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||'')){write(res,415,{ok:false,code:'JSON_REQUIRED'});return true;}
   if(!owner){write(res,503,{ok:false,code:'OWNER_STOPPED'});return true;}
   let input;
   try{input=await readBody(req);}catch(e){write(res,e.status||400,{ok:false,code:e.status===413?'BODY_TOO_LARGE':'COMMAND_INVALID'});return true;}
   let result;try{result=owner.dispatch(input);}catch{write(res,503,{ok:false,code:'OUTCOME_UNKNOWN_QUERY',queryOriginalRequest:true});return true;}
   write(res,result.ok?200:statusFor(result.code),result);return true;
  }
  if(['/snapshot','/commands'].includes(path)||path.startsWith('/requests/')){write(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});return true;}
  write(res,404,{ok:false,code:'LOCAL_ROUTE_NOT_FOUND'});return true;
 };
}
