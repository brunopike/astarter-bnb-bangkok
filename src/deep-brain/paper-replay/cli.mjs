import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {bundledMarket, readMemory, selectCase, writeMemory} from './replay.mjs';
import {explainMemory,syncMemory} from './connections.mjs';
import {paperPageHTML} from './page.mjs';

const {values,positionals:[command='demo',id,...extra]}=parseArgs({allowPositionals:true,options:{
  store:{type:'string',default:join(homedir(),'.local','share','astarter','paper-replay')},
  archive:{type:'string'},asset:{type:'string',default:'coin:bitcoin'},days:{type:'string',default:'90'},
  session:{type:'string'},port:{type:'string',default:'4317'},remote:{type:'boolean'},help:{type:'boolean'}}});
const output=value=>console.log(JSON.stringify(value,null,2));
async function serve() {
  const port=Number(values.port);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const {createBrainProofService}=await import('../api/brain-proof-service.mjs');
  const proof=createBrainProofService();
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/brain/proof'){await proof(req,res);return;}
      if(url.pathname!=='/' || !['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
      const en=url.searchParams.get('lang')!=='zh';
      const html=await paperPageHTML(en);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:html);
    }catch{res.writeHead(503);res.end('Proof unavailable');}
  });
  server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/'));
  const stop=()=>{server.close();void proof.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
async function main(){
  if(values.help){console.log('demo [--archive FILE --asset KEY --session YYYY-MM-DD --days 90] [--store DIR]\nrecall|sync|explain ID [--store DIR] [--remote for explain]\nserve [--port 4317]');return;}
  if(extra.length)throw Error('Unexpected positional argument');
  if(command==='serve'&&!id)return serve();
  if(command==='demo'&&!id){
    const archive=JSON.parse(await readFile(values.archive??bundledMarket,'utf8'));
    const record=selectCase(archive,{asset:values.asset,days:values.days==='all'?'all':Number(values.days),session:values.session});
    const memoryId=await writeMemory(values.store,record);
    const recalled=await readMemory(values.store,memoryId);
    output({memoryId,market:recalled.asset.market,session:recalled.decision.barOpenAt,mode:recalled.mode,
      selected:recalled.decision.selected,risk:recalled.decision.risk,receipt:recalled.decision.execution,attribution:recalled.attribution});
    return;
  }
  if(!['recall','sync','explain'].includes(command)||!id)throw Error('Use --help for commands');
  const record=await readMemory(values.store,id);
  if(command==='recall')output(record);
  if(command==='sync'){const {content,...result}=await syncMemory(record);output(result);}
  if(command==='explain'){
    const options=values.remote?{content:(await syncMemory(record)).content}:{};
    output(await explainMemory(record,options));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
