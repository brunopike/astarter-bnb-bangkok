// Public-data worker. It owns a private copy of the daily archive and only writes simulation records.
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,link,unlink,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {collectSourceObservations} from '../brain-source-observations.mjs';
import {forwardDirectory,recordForwardProofs} from '../brain-proof-forward.mjs';

const dir=forwardDirectory(),root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(dir,{recursive:true,mode:0o700});
const archivePath=path.join(dir,'daily-markets.json');
let raw;
try{raw=await readFile(archivePath,'utf8');}
catch(error){
  if(error.code!=='ENOENT')throw error;
  const temp=archivePath+'.'+randomUUID();
  await copyFile(path.join(root,'brain-evidence','daily-markets.json'),temp);
  try{await link(temp,archivePath);}catch(e){if(e.code!=='EEXIST')throw e;}finally{await unlink(temp);}
}
// Always reconcile successfully collected markets, even if one venue is temporarily unavailable.
let status=0;
if(process.argv.includes('--refresh')){
  const child=spawnSync('python3',[path.join(root,'scripts','brain-daily-update.py'),'--archive',archivePath],{stdio:'inherit',timeout:300000});
  status=child.status??1;
  raw=null;
}
const archiveBytes=raw??await readFile(archivePath);
const archive=JSON.parse(archiveBytes);
const {counts}=await collectSourceObservations(archiveBytes,{dir});
const result=await recordForwardProofs(archive,{dir});
result.sourceObservations=counts;
console.log(JSON.stringify({mode:'forward_paper',...result}));
process.exitCode=result.failed.length?1:status;
