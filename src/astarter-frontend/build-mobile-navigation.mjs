import {build} from 'esbuild';
import {mkdir,writeFile,rename} from 'node:fs/promises';
const result=await build({entryPoints:['mobile-navigation.jsx'],outfile:'navigation-ui/mobile-navigation.js',bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},write:false});
await mkdir('navigation-ui',{recursive:true});
for(const file of result.outputFiles){await writeFile(file.path+'.tmp',file.contents);await rename(file.path+'.tmp',file.path);}
console.log(`Mobile navigation: ${result.outputFiles.find(file=>file.path.endsWith('.js')).contents.length} bytes`);
