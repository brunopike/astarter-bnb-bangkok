import {build} from 'esbuild';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';

const result=await build({entryPoints:['signal-stats/entry.jsx'],outfile:'signal-ui/advanced-stats.js',bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},write:false});
await mkdir('signal-ui',{recursive:true});
const license=await readFile('signal-stats/LICENSE','utf8');
for(const file of [...result.outputFiles].sort((a,b)=>Number(a.path.endsWith('.js'))-Number(b.path.endsWith('.js')))){await writeFile(file.path+'.tmp',file.path.endsWith('.LEGAL.txt')?file.text+'\n\nUI Layouts Advanced Stats\n'+license:file.contents);await rename(file.path+'.tmp',file.path);}
console.log(`Advanced Stats: ${result.outputFiles.find(file=>file.path.endsWith('.js')).contents.length} bytes`);
