import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access,readdir} from 'node:fs/promises';
import path from 'node:path';
import {releaseAssets as allowed,walletAsset} from './public-assets.mjs';
import unavailable from './api/unavailable.mjs';
const privateModules=['api/wallet.mjs','api/research.mjs','research-analysis-service.mjs','research-private-store.mjs','wallet-private-auth.mjs','wallet-runtime.mjs','private-service-client.mjs','private-api-route.mjs','research-runtime.mjs','research-provider-budget.mjs','research-market-evidence.mjs','strategy-s03.mjs','private-ui-runtime.mjs','private-ui-service.mjs','api/notifications.mjs','api/workspace.mjs'];
privateModules.push('api/strategy-drafts.mjs','private-draft-service.mjs');
privateModules.push('api/wealth-market.mjs','wealth-public-market.mjs','wealth-market.mjs','trading-connection-service.mjs');

test('cloud proxy exposes only public data and disables response caching',async()=>{
  const config=JSON.parse(await readFile(new URL('./vercel.json',import.meta.url),'utf8'));
  const external=config.rewrites.filter(rule=>/^https?:/.test(rule.destination));
  assert.deepEqual(external,[{source:'/api/v1/data/:path*',destination:'https://api.ipfund.art/v1/data/:path*'}]);
  const fallback=config.rewrites.findIndex(rule=>rule.source==='/api/v1/:path*'&&rule.destination==='/api/unavailable');
  assert.ok(fallback>config.rewrites.indexOf(external[0]));
  for(const service of ['commerce','local-sim','assistant','wealth'])assert.ok(config.rewrites.some(rule=>rule.source===`/api/${service}/:path*`&&rule.destination==='/api/unavailable'));
  for(const service of ['wallet','research','notifications','workspace','strategy-drafts']){
    assert.ok(config.rewrites.some(rule=>rule.source===`/api/${service}/:route*`&&rule.destination===`/api/${service}?route=:route*`));
    assert.ok(config.headers.find(rule=>rule.source===`/api/${service}/:path*`)?.headers.some(h=>h.key==='Cache-Control'&&h.value==='no-store'));
  }
  assert.equal(config.functions['api/wallet.mjs'].maxDuration,30);assert.equal(config.functions['api/research.mjs'].maxDuration,60);assert.equal(config.functions['api/workspace.mjs'].maxDuration,30);assert.equal(config.functions['api/notifications.mjs'].maxDuration,30);
  assert.equal(config.functions['api/strategy-drafts.mjs'].maxDuration,30);
  const headers=config.headers.find(rule=>rule.source==='/api/v1/data/:path*')?.headers;
  assert.ok(headers?.some(header=>header.key==='Cache-Control'&&header.value==='no-store'));
  assert.ok(headers?.some(header=>header.key==='x-vercel-enable-rewrite-caching'&&header.value==='0'));
});

test('wealth opens only the public market read before the unavailable funding fallback',async()=>{
  const config=JSON.parse(await readFile(new URL('./vercel.json',import.meta.url),'utf8'));
  const read=config.rewrites.findIndex(rule=>rule.source==='/api/wealth/market'&&rule.destination==='/api/wealth-market');
  const fallback=config.rewrites.findIndex(rule=>rule.source==='/api/wealth/:path*'&&rule.destination==='/api/unavailable');
  assert.ok(read>=0&&fallback>read);
  assert.equal(config.functions['api/wealth-market.mjs'].maxDuration,15);
  assert.ok(config.headers.find(rule=>rule.source==='/api/wealth/market')?.headers.some(header=>header.key==='Cache-Control'&&header.value==='no-store'));
  assert.equal(allowed.has('wealth-market-data.mjs'),true);
});

test('release assets exist and exclude private state, server modules and tests',async()=>{
  for(const file of allowed){
    assert.ok(!/(^\.|\.test\.|\.sqlite|\.env|(?:^|\/)server\.mjs|commerce-store|wallet-auth|notification-service|\.orig$)/.test(file),file);
    await access(new URL(file,import.meta.url));
  }
  for(const file of privateModules)assert.equal(allowed.has(file),false,file+' must remain server-only');
  assert.equal(walletAsset('wallet-ui/../.env.local'),false);
  assert.equal(walletAsset('wallet-ui/build-meta.json'),false);
});

test('built frontend contains the complete release allowlist and local module dependencies',async()=>{
  const root=new URL('./dist/',import.meta.url);
  for(const file of allowed)await access(new URL(file,root));
  const scripts=[...allowed].filter(file=>/\.(mjs|js)$/.test(file)&&!file.startsWith('node_modules/'));
  for(const file of await readdir(new URL('wallet-ui/',root)))if(file.endsWith('.js'))scripts.push('wallet-ui/'+file);
  for(const file of scripts){
    const text=await readFile(new URL(file,root),'utf8');
    for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]((?:\.{1,2}\/|\/)[^'"\n]+)['"]/g)){
      const target=match[1].startsWith('/')?match[1].slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));
      assert.ok(!target.startsWith('../'),file+' → '+target);
      await assert.doesNotReject(access(new URL(target,root)),file+' → '+target);
    }
  }
  for(const file of ['.env.wallet.local','.env.notifications.local','server.mjs','commerce-store.mjs','wallet-auth.mjs',...privateModules,'test-locale.mjs','test-fixtures/wealth-strategy-config.draft-20261113.1.json','package.json','.git/config'])await assert.rejects(access(new URL(file,root)));
});

test('production UI bundles expose the entry points called by the browser',async()=>{
  const root=new URL('./dist/',import.meta.url);
  const bundles={
    'signal-ui/advanced-stats.js':'mountAdvancedStats',
    'navigation-ui/mobile-navigation.js':'mountMobileNavigation',
    'liquid-select-ui/liquid-select.js':'mountLiquidSelects',
    'wallet-ui/header-wallet.js':'mount',
  };
  for(const [file,entry] of Object.entries(bundles)){
    const source=await readFile(new URL(file,root),'utf8');
    const names=[...source.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(match=>
      match[1].split(',').map(binding=>binding.trim().split(/\s+as\s+/).at(-1)));
    assert.ok(names.includes(entry),file+' must export '+entry);
  }
});

test('unconnected cloud services never acknowledge reads or writes as success',()=>{
  for(const method of ['GET','POST']){
    const result={};const res={writeHead(status,headers){Object.assign(result,{status,headers});},end(body){result.body=JSON.parse(body);}};
    unavailable({method,url:'/api/unavailable?selection_version=12'},res);
    assert.equal(result.status,503);assert.equal(result.body.selection_version,12);
    assert.equal(result.body.real_trading_connected,false);assert.equal(result.headers['Cache-Control'],'no-store');
    assert.equal(result.body.code,'DATA_SERVICE_UNAVAILABLE');
  }
});

test('the local server allow list serves the account access page and every file it loads',async()=>{
  const {allowed:served,releaseAssets}=await import('./public-assets.mjs');
  // Walk the page the way a browser loads it from server.mjs: page links, module imports, stylesheet imports and fonts.
  const seen=new Set(),queue=['account-access.html'];
  while(queue.length){
    const file=queue.shift();if(seen.has(file))continue;seen.add(file);
    if(!/\.(?:html|mjs|js|css)$/.test(file))continue;
    const text=await readFile(new URL(file,import.meta.url),'utf8'),found=[];
    for(const match of text.matchAll(/\b(?:src|href)="(\/[^"?#]+)"/g))found.push(match[1]);
    if(file.endsWith('.css'))for(const match of text.matchAll(/url\(\s*['"]?([^'")#]+)['"]?\s*\)/g))if(!/^(?:data:|https?:)/.test(match[1]))found.push(match[1]);
    if(/\.m?js$/.test(file))for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]((?:\.{1,2}\/|\/)[^'"\n]+)['"]/g))found.push(match[1]);
    for(const ref of found){
      const target=ref.startsWith('/')?ref.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(file),ref));
      assert.ok(!target.startsWith('../'),file+' → '+target);queue.push(target);
    }
  }
  for(const file of ['account-access.html','account-access.mjs','account-security.mjs','account-security-policy.mjs','account-security.css','brand/account-mark-dark.svg','brand/account-mark-light.svg'])assert.ok(seen.has(file),file+' is loaded by the page');
  for(const file of ['typography.css','bento-system.css','fonts/faces.css'])assert.ok(seen.has(file),file+' is loaded by the page');
  // The release build stays as it was: the account access page and its files are served by the local server only.
  for(const file of ['account-access.html','account-access.mjs','account-security.mjs','account-security-policy.mjs','account-security.css','brand/account-mark-dark.svg','brand/account-mark-light.svg'])assert.equal(releaseAssets.has(file),false,file+' must stay out of the release build');
  // server.mjs answers 404 for any path outside this set (L58-59) and reads the file from the app folder.
  for(const file of seen){
    assert.equal(file.startsWith('wallet-ui/')?walletAsset(file):served.has(file),true,file+' must be served by the local server');
    await access(new URL(file,import.meta.url));
  }
});
