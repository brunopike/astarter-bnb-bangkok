import {serveSitePage} from './site-seo.mjs';
import {handleWalletAuth,readWalletSession} from './wallet-auth.mjs';
import http from 'node:http';
import handleAssistantChat from './api/assistant-chat.mjs';
import {handleCommerce} from './commerce-api.mjs';
import {handleNotifications,startNotifications} from './notification-service.mjs';
import {loadNotificationConfig} from './notification-config.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import { fileURLToPath } from 'node:url';
import {handlePublicData} from './public-data-proxy.mjs';
import {handleAssistantExchange} from './assistant-exchange-relay.mjs';
import {handleMarketHub} from './licensed-feeds.mjs';
import handleWealthMarket from './api/wealth-market.mjs';
import {allowed,walletAsset} from './public-assets.mjs';
import {createLocalSimHandler} from './local-sim-api.mjs';
import {createTradingConnectionService} from './trading-connection-service.mjs';
import {handleMemory} from './living-brain.mjs';
import {handleAtlasFeeds} from './atlas-feed-master.mjs';
import {handleAtlasPrices} from './market-source-adapters.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4188);
let localSimOwner;
if(process.env.LOCAL_SIM_DB||process.env.LOCAL_SIM_FIXTURE){
  if(!process.env.LOCAL_SIM_DB||!process.env.LOCAL_SIM_FIXTURE)throw Error('LOCAL_SIM_CONFIGURATION_INCOMPLETE');
  const {createLocalSimOwner}=await import('./local-sim-owner.mjs');
  localSimOwner=createLocalSimOwner({databasePath:process.env.LOCAL_SIM_DB,fixtureId:process.env.LOCAL_SIM_FIXTURE});
  localSimOwner.start();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{localSimOwner.close();process.exit(0);});
}
const handleLocalSim=createLocalSimHandler({owner:localSimOwner,origin:`http://127.0.0.1:${port}`});
const tradingConnections=createTradingConnectionService({persistPath:process.env.ASTARTER_CONNECTION_STORE||path.join(homedir(),'.config/astarter/trading-connections.json'),sessionOf:readWalletSession});
if(tradingConnections.configured)tradingConnections.check().catch(()=>{});
if(!localSimOwner){
  loadNotificationConfig({legacyFile:path.join(root,'.env.notifications.local')});
  startNotifications();
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.txt':'text/plain; charset=utf-8' };
http.createServer(async (req, res) => {
  const file = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
  res.setHeader('X-App-Build', 'hive-motion-0.35-integrated');
  res.setHeader('X-App-Mode', 'simulation-only');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', /^fonts\/[a-z-]+-[0-9a-f]{12}\.woff2$/.test(file)?'public, max-age=31536000, immutable':'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://s3.tradingview.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com https://cdn.dexscreener.com https://pbs.twimg.com https://avatars.githubusercontent.com https://api.web3modal.com https://api.web3modal.org; connect-src 'self' https://api.fxtwitter.com https://swolecharts.com https://api.routescan.io https://mempool.space https://www.tradingview-widget.com https://api.dexscreener.com https://api.coingecko.com https://api.llama.fi https://stablecoins.llama.fi https://api.alternative.me https://data-api.binance.vision wss://data-stream.binance.vision wss://fstream.binance.com wss://stream.bybit.com https://bsc-dataseed.binance.org https://rpc.walletconnect.com https://rpc.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://api.web3modal.com https://api.web3modal.org; font-src 'self'; frame-src 'self' https://algoros.ai https://www.tradingview-widget.com https://verify.walletconnect.com https://verify.walletconnect.org; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  if(['account-access.html','membership.html','crystal-character.html'].includes(file)||file.startsWith('vendor/')&&file.endsWith('.html'))res.setHeader('X-Robots-Tag','noindex, follow');
  // An isolated acceptance process must not lazily open the user's stores or notification transport.
  if(localSimOwner){
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  }
  if(localSimOwner)res.setHeader('X-Robots-Tag','noindex, follow');
  if(await serveSitePage(req,res,path.join(root,'index.html')))return;
  if(localSimOwner&&file.startsWith('api/')&&!file.startsWith('api/local-sim/')){
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({error:'LOCAL_SIMULATION_ISOLATED',mode:'simulation-only'}));return;
  }
  if(file==='api/assistant/chat'){await handleAssistantChat(req,res);return;}
  if(await handleWalletAuth(req,res))return;
  if(await handleMemory(req,res))return;
  if(await handleAtlasFeeds(req,res))return;
  if(await handleAtlasPrices(req,res))return;
  if(await handleCommerce(req,res))return;
  if(await handleNotifications(req,res))return;
  if(await handleMarketHub(req,res))return;
  if(file==='api/wealth/market'||file==='api/wealth-market'){
    await handleWealthMarket(req,res);return;
  }
  if(await handleAssistantExchange(req,res,{port}))return;
  if(await handleLocalSim(req,res))return;
  if(await tradingConnections.handle(req,res))return;
  if(await handlePublicData(req,res,{port}))return;
  if (file === 'favicon.ico') { res.writeHead(204); res.end(); return; }
  if (file === 'release.json') {
    try {
      const content = await readFile(path.join(root, 'dist', 'release.json'));
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }
  const rawFile=req.url.split('?')[0].slice(1);
  if (rawFile.startsWith('wallet-ui/')?!walletAsset(rawFile):!allowed.has(file)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Type': path.extname(file)==='.glb'?'model/gltf-binary':types[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Hive motion study: http://127.0.0.1:${port} · SIMULATION ONLY`));
