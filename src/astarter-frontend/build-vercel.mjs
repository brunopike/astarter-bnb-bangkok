import {cp,mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseAssets,walletAsset} from './public-assets.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const output=path.join(root,'dist');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
const files=new Set(releaseAssets);
for(const file of await readdir(path.join(root,'wallet-ui')))if(walletAsset('wallet-ui/'+file))files.add('wallet-ui/'+file);
for(const file of files){
  const target=path.join(output,file);
  await mkdir(path.dirname(target),{recursive:true});
  await cp(path.join(root,file),target);
}
await writeFile(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
const sourceDigest=process.env.ASTARTER_SOURCE_DIGEST,baseCommit=process.env.ASTARTER_BASE_COMMIT;
const artifact=/^[a-f0-9]{64}$/.test(sourceDigest||'')&&/^[a-f0-9]{40}$/.test(baseCommit||'')?{sourceDigest,baseCommit}:{};
await writeFile(path.join(output,'release.json'),JSON.stringify({app:'astarter',mode:'simulation-only',commit:process.env.VERCEL_GIT_COMMIT_SHA||null,...artifact,builtAt:new Date().toISOString()})+'\n');
console.log(`Astarter frontend: ${files.size} public files → dist/`);
