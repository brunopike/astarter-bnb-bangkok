import {build} from 'esbuild';
import {mkdir,writeFile,rename} from 'node:fs/promises';
const result=await build({entryPoints:['liquid-select.jsx'],outfile:'liquid-select-ui/liquid-select.js',bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},write:false});
await mkdir('liquid-select-ui',{recursive:true});
for(const file of result.outputFiles){await writeFile(file.path+'.tmp',file.contents);await rename(file.path+'.tmp',file.path);}
console.log(`Liquid select: ${result.outputFiles.map(file=>`${file.path.split('/').pop()} ${file.contents.length} bytes`).join(', ')}`);
