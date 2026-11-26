import {isMainThread,parentPort,Worker,workerData} from 'node:worker_threads';

const unavailable={
  status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},
  body:JSON.stringify({error:{code:'PROOF_UNAVAILABLE',message:'Proof data is temporarily unavailable.'}})
};

function createProofQueue(options,limit=Infinity){
  let active=null,nextId=0;
  function release(state){
    if(active===state)active=null;
    for(const {resolve} of state.pending.values())resolve(unavailable);
    state.pending.clear();state.byQuery.clear();
  }
  function acquire(){
    if(active)return active;
    const worker=new Worker(new URL(import.meta.url),{workerData:{brainProof:true,options},execArgv:[]});
    const state={worker,pending:new Map(),byQuery:new Map()};
    active=state;
    worker.on('message',({id,response})=>{
      const task=state.pending.get(id);
      if(!task)return;
      state.pending.delete(id);state.byQuery.delete(task.key);
      if(!state.pending.size)worker.unref();
      task.resolve(response);
    });
    worker.on('error',()=>release(state));
    worker.on('exit',()=>release(state));
    worker.unref();
    return state;
  }
  function query(method,url){
    const state=acquire(),key=method+' '+url;
    const existing=state.byQuery.get(key);
    if(existing)return existing;
    if(state.pending.size>=limit)return Promise.resolve(unavailable);
    const id=++nextId;
    const promise=new Promise(resolve=>{
      state.pending.set(id,{resolve,key});
    });
    state.byQuery.set(key,promise);
    state.worker.ref();
    try{state.worker.postMessage({id,method,url});}catch{release(state);}
    return promise;
  }
  async function close(){
    if(!active)return;
    const state=active;release(state);
    await state.worker.terminate();
  }
  return {query,close};
}

// Briefs and the assistant share one lazy worker, independent of expensive cohort replays.
const agentQueue=createProofQueue({},12);
function canonicalAgentUrl(params){
  const ordered=new URLSearchParams(params);
  ordered.sort();
  return '/api/brain/proof?'+ordered;
}
export async function readAgentBrief(assetKey,{date,signal}={}){
  signal?.throwIfAborted();
  if(typeof assetKey!=='string' || !assetKey.length || assetKey.length>128)throw new Error('BAD_QUERY');
  const params=new URLSearchParams({brief:'1',asset:assetKey});
  if(date!=null)params.set('date',date);
  const work=agentQueue.query('GET',canonicalAgentUrl(params));
  let abort;
  try{
    const response=signal?await Promise.race([work,new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
    })]):await work;
    const result=JSON.parse(response.body);
    if(response.status!==200 || result.version!=='brain-agent-brief-v1')throw new Error(result.error?.code || 'PROOF_UNAVAILABLE');
    return result;
  }finally{
    if(abort)signal.removeEventListener('abort',abort);
  }
}

export function createBrainProofService(options={}){
  const full=createProofQueue(options);
  const brief=Object.keys(options).length?createProofQueue(options,12):agentQueue;
  async function handle(req,res){
    let response;
    try{
      const {searchParams}=new URL(req.url,'http://localhost');
      response=searchParams.has('brief') || searchParams.has('tool')?
        await brief.query(req.method,canonicalAgentUrl(searchParams)):await full.query(req.method,req.url);
    }catch{response=unavailable;}
    if(res.destroyed)return;
    res.writeHead(response.status,response.headers);
    res.end(req.method==='HEAD'?undefined:response.body);
  }
  handle.close=async()=>{
    await full.close();
    if(brief!==agentQueue)await brief.close();
  };
  return handle;
}

if(!isMainThread && workerData?.brainProof){
  const {createBrainProofHandler}=await import('./brain-proof.mjs');
  const read=createBrainProofHandler(workerData.options);
  let queue=Promise.resolve();
  parentPort.on('message',({id,method,url})=>{
    queue=queue.then(async()=>{
      let status,headers,body;
      await read({method,url},{
        writeHead(code,values){status=code;headers=values;},
        end(payload){body=payload;}
      });
      parentPort.postMessage({id,response:{status,headers,body}});
    }).catch(()=>parentPort.postMessage({id,response:unavailable}));
  });
}
