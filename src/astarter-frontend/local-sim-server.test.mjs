import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {once} from 'node:events';
import net from 'node:net';
import {createLocalSimOwner} from './local-sim-owner.mjs';

test('the actual isolated server entry cannot start legacy workers, read notification secrets or open user databases', {timeout:20000},async t=>{
 const root=dirname(fileURLToPath(import.meta.url)),dir=realpathSync(mkdtempSync(join(tmpdir(),'astarter-server-isolation-'))),databasePath=join(dir,'fixture.sqlite');
 const owner=createLocalSimOwner({databasePath,fixtureId:'server-isolation',create:true});owner.close();
 const trap=join(dir,'trap.mjs');
 writeFileSync(trap,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).includes('.env'))throw Error('FORBIDDEN_NOTIFICATION_CONFIG');return read.call(this,file,...args);};syncBuiltinESMExports();
 globalThis.fetch=()=>{console.error('FORBIDDEN_OUTSIDE_FETCH');throw Error('FORBIDDEN_OUTSIDE_FETCH');};`);
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const child=spawn(process.execPath,['--permission','--allow-fs-read=*','--allow-fs-write='+dir,'--import',pathToFileURL(trap).href,'server.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:dir,PORT:String(port),LOCAL_SIM_DB:databasePath,LOCAL_SIM_FIXTURE:'server-isolation'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('SERVER_START_TIMEOUT\n'+output));},10000);
  const data=()=>{if(output.includes('SIMULATION ONLY')){cleanup();resolve();}};
  const exit=()=>{cleanup();reject(Error('SERVER_EXITED\n'+output));};
  const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',data);child.off('exit',exit);};
  child.stdout.on('data',data);child.once('exit',exit);data();
 });
 const origin='http://127.0.0.1:'+port;
 for(const path of ['/api/notifications/state','/api/notifications/command','/api/commerce/state','/api/commerce/command','/api/commerce-extra','/api/wallet/session','/api/wallet/nonce','/api/assistant/exchanges/binance/connect','/api/market-hub/assets','/api/public-data/markets']){
  const response=await fetch(origin+path,{method:path.endsWith('command')||path.endsWith('nonce')||path.endsWith('connect')?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'}});
  assert.equal(response.status,503,path);assert.equal((await response.json()).error,'LOCAL_SIMULATION_ISOLATED',path);
 }
 const snapshot=await fetch(origin+'/api/local-sim/snapshot').then(r=>r.json());assert.equal(snapshot.snapshot.fixtureId,'server-isolation');assert.equal(snapshot.snapshot.capabilities.realTrading,false);
 const page=await fetch(origin+'/?page=strategies&localSim=server-isolation');assert.equal(page.status,200);
 assert.match(page.headers.get('content-security-policy'),/connect-src 'self';/);assert.match(page.headers.get('content-security-policy'),/frame-src 'none'/);assert.doesNotMatch(page.headers.get('content-security-policy'),/https:|wss:/);
 for(const path of ['local-sim-owner.mjs','local-sim-api.mjs','notification-config.mjs'])assert.equal((await fetch(origin+'/'+path)).status,404);
 assert.doesNotMatch(output,/FORBIDDEN_|ERR_ACCESS_DENIED/);
});
