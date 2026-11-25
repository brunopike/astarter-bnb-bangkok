import {build} from 'esbuild';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
let local={};try{local=parseEnv(await readFile('.env.wallet.local','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const projectId=(process.env.WALLETCONNECT_PROJECT_ID??local.WALLETCONNECT_PROJECT_ID??'').trim();
if(projectId&&!/^[a-f0-9]{32}$/i.test(projectId))throw Error('WALLETCONNECT_PROJECT_ID must be the 32-character Astarter Reown project ID.');
// RainbowKit 2.2 puts discovered extensions and recent wallets ahead of configured groups.
// Apply the preference after discovery so the actual injected connector and keyboard order stay intact.
const walletPicker={name:'astarter-wallet-picker',setup(builder){
 builder.onLoad({filter:/[\\/]@rainbow-me[\\/]rainbowkit[\\/]dist[\\/]index\.js$/},async({path})=>{
  const source=await readFile(path,'utf8'),anchor='return walletConnectors;';
  if(source.split(anchor).length!==2)throw Error('Check the RainbowKit wallet ordering hook after upgrading.');
  const localeCalls=/^(\s*)setLocale\((locale|browserLocale)\);$/gm;
  if(source.match(localeCalls)?.length!==2)throw Error('Check the RainbowKit picker locale effect after upgrading.');
  const helper=fileURLToPath(new URL('./wallet-options.mjs',import.meta.url));
  const contents=source.replace(anchor,'return prioritizeBinanceWallets(walletConnectors,isMobile());')
   .replace(localeCalls,'$1return bindWalletLocale(i18n, $2, fetchTranslations);');
  return {contents:`import {prioritizeBinanceWallets,bindWalletLocale} from ${JSON.stringify(helper)};\n`+contents,loader:'js'};
 });
}};
const result=await build({entryPoints:['header-wallet.jsx'],outdir:'wallet-ui',entryNames:'header-wallet',bundle:true,plugins:[walletPicker],external:['/wallet-ui/*'],metafile:true,write:false,splitting:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"','__WALLETCONNECT_PROJECT_ID__':JSON.stringify(projectId)},loader:{'.svg':'dataurl','.png':'dataurl'},logLevel:'info'});
await mkdir('wallet-ui',{recursive:true});
// Keep old hashed chunks usable by open tabs; publish the entry only after its dependencies exist.
for(const file of result.outputFiles.sort((a,b)=>Number(a.path.endsWith('/header-wallet.js'))-Number(b.path.endsWith('/header-wallet.js')))){
 await writeFile(file.path+'.tmp',file.contents);await rename(file.path+'.tmp',file.path);
}

await writeFile('wallet-ui/build-meta.json',JSON.stringify(result.metafile));
console.log(projectId?'WalletConnect configured; validate the project origin and mobile connection.':'Browser wallets enabled; WalletConnect awaits Astarter Reown configuration.');
