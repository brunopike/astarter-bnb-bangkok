import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TOKEN_ICONS,VENUE_ICONS,tokenLogo,venueLogo,tokenIcon,venueIcon,pairSymbols,pairIcon,approvedTokenImageURL,registerTokenMetadata} from './brand-icons.mjs';
import {BRAND_FILES} from './brand-icon-data.mjs';
import {HUB_SYMBOLS} from './market-hub-data.mjs';
import {MARKET,COIN_ICONS,EXCHANGES} from './data-center-fixtures.mjs';
import {TRACKING_CASES} from './signal-tracking.mjs';

test('all current market and signal asset identities have local icons',()=>{
 for(const a of MARKET)assert.ok(tokenLogo(a),a.symbol);
 for(const c of TRACKING_CASES)assert.ok(tokenLogo(c.id),c.id);
 for(const symbol of HUB_SYMBOLS)assert.ok(BRAND_FILES.includes(tokenLogo(symbol)?.slice(1)),symbol);
 for(const symbol of ['USDT','USDC','WBTC','WETH','CAKE','JUP'])assert.ok(TOKEN_ICONS[symbol],symbol);
 assert.equal(COIN_ICONS,TOKEN_ICONS);
});
test('API assets require matching canonical identity; a chain contract never borrows a symbol logo',()=>{
 assert.equal(tokenLogo({asset_id:'bitcoin',symbol:'BTC'}),TOKEN_ICONS.BTC);
 assert.equal(tokenLogo({asset_id:'ethereum',symbol:'ETH'}),TOKEN_ICONS.ETH);
 assert.equal(tokenLogo({asset_id:'solana',symbol:'SOL'}),TOKEN_ICONS.SOL);
 for(const value of [{asset_id:'wrapped-bitcoin',symbol:'BTC'},{asset_id:'other-btc',symbol:'BTC'},{symbol:'BTC',chain_id:'56',address:'0xexample'},{symbol:'ETH',contract_address:'0xexample'}])assert.equal(tokenLogo(value),null);
});
test('instrument identity is distinct from a token ticker, and SOL uses its official gradient',async()=>{
 const sol=await readFile(new URL('./vendor/crypto-icons/sol.svg',import.meta.url),'utf8');assert.match(sol,/linearGradient/);assert.match(sol,/#9945FF/i);assert.doesNotMatch(sol,/#66F9A1/i);assert.match(tokenIcon('SOL'),/brand-solana/);
 for(const [symbol,name]of Object.entries({NDX:'Nasdaq-100',SPX:'S&amp;P 500',XAU:'Gold · USD/oz',US10Y:'10Y yield'})){
  const html=tokenIcon(symbol);assert.match(html,/brand-instrument/);assert.ok(html.includes(name),symbol);
  assert.doesNotMatch(tokenIcon({symbol,asset_id:'other-'+symbol.toLowerCase()}),/brand-instrument|coins\/(?:spx|ndx|xau|us10y)/);
  assert.doesNotMatch(tokenIcon({symbol,chain_id:'1',address:'0x0001'}),/brand-instrument/);
 }
});
test('unknown identities use a neutral icon and never render a supplied remote logo URL',()=>{
 const html=tokenIcon({asset_id:'new-token',symbol:'NEW',image_url:'https://remote.test/secret',logo_ref:'javascript:bad()'});
 assert.match(html,/data-logo-state="unavailable"/);assert.match(html,/brand-fallback/);assert.doesNotMatch(html,/<img|remote\.test|javascript:/);
 const unsafe=tokenIcon({symbol:'<img src=x onerror=bad()>'});assert.doesNotMatch(unsafe,/<img src=x|title="<img/);assert.match(unsafe,/&lt;img/);
});
test('all exchange rows and supported API connector identities have brand marks',()=>{
 for(const name of EXCHANGES)assert.ok(venueLogo(name),name);
 assert.equal(venueLogo('binance-spot-demo'),VENUE_ICONS.binance);assert.equal(venueLogo('binance-perp'),VENUE_ICONS.binance);assert.equal(venueLogo('okex'),VENUE_ICONS.okx);assert.equal(venueLogo('bybit_spot'),VENUE_ICONS.bybit);
 assert.equal(venueLogo('Gate.io'),VENUE_ICONS.gate);assert.equal(venueLogo('DEX / Hyperliquid'),VENUE_ICONS.hyperliquid);
 assert.doesNotMatch(venueIcon('Binance'),/connected|连接成功|已验证/);
});
test('pair icons keep base and quote identities separate',()=>{
 assert.deepEqual(pairSymbols('BTC / USDT'),['BTC','USDT']);assert.deepEqual(pairSymbols('ETHUSDC'),['ETH','USDC']);assert.deepEqual(pairSymbols('SOL'),['SOL']);assert.deepEqual(pairSymbols('机会自动匹配'),[]);
 const html=pairIcon('BTC/USDT');assert.equal((html.match(/data-logo-state="known"/g)||[]).length,2);assert.match(html,/btc\.svg/);assert.match(html,/usdt\.webp/);
});
test('venue marks share canonical identity and local artwork across API, table and connector callers',()=>{
 const image='https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274';
 for(const identity of [' Binance ',{venueId:'BINANCE'},{venue_id:'binance-spot-demo'},{venue:'Binance',image_url:image}]){
  const html=venueIcon(identity,{size:40});
  assert.match(html,/brand-venue-binance/);assert.match(html,/<img src="\/vendor\/brand-assets\/exchanges\/binance.webp"/);assert.match(html,/--brand-size:40px/);
 }
 assert.match(venueIcon({venueId:' Gate.io '}),/brand-venue-gate/);
 assert.match(venueIcon({venue:'Binance',image_url:image}),/data-logo-fallback="https:\/\/coin-images.coingecko.com/);
 assert.doesNotMatch(venueIcon({venue:'Binance',image_url:'https://evil.test/image.png'}),/evil.test/);
 assert.match(venueIcon({venueId:'unknown'}),/data-logo-state="unavailable"/);
});
test('every allowed brand file exists, is bounded, and is an inert image',async()=>{
 assert.equal(new Set(BRAND_FILES).size,BRAND_FILES.length);
 for(const file of BRAND_FILES){
  assert.match(file,/^vendor\/(?:crypto-icons|brand-assets\/(?:coins|exchanges))\/[a-z0-9-]+\.(?:svg|webp)$/);
  const bytes=await readFile(new URL('./'+file,import.meta.url));assert.ok(bytes.length>30&&bytes.length<100000,file);
  if(file.endsWith('.svg'))assert.doesNotMatch(bytes.toString(),/<script|foreignObject|onload\s*=|onerror\s*=|href\s*=\s*["']https?:/i,file);
  else {assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');}
 }
});

test('API metadata renders six assets outside the local catalog without a symbol list change',async()=>{
 const {items}=JSON.parse(await readFile(new URL('./test-fixtures/api-logo-samples-20261029.json',import.meta.url)));
 assert.equal(items.length,6);
 for(const item of items){assert.equal(TOKEN_ICONS[item.symbol],undefined,item.symbol);assert.equal(tokenLogo(item),item.image_url);assert.match(tokenIcon(item),/<img/);}
 assert.match(tokenIcon(items[0]),/crossorigin="anonymous"/);assert.match(tokenIcon(items[0]),/referrerpolicy="no-referrer"/);
 registerTokenMetadata(items);
 for(const {asset_id,symbol,image_url} of items)assert.equal(tokenLogo({asset_id,symbol}),image_url);
 assert.equal(tokenLogo('ONDO'),null);assert.equal(tokenLogo({asset_id:'different-ondo',symbol:'ONDO'}),null);
 const known=tokenIcon({asset_id:'bitcoin',symbol:'BTC',image_url:items[0].image_url});assert.match(known,/data-logo-fallback="\/vendor\/crypto-icons\/btc.svg"/);
 assert.doesNotMatch(tokenIcon({asset_id:'other-bitcoin',symbol:'BTC',image_url:items[0].image_url}),/data-logo-fallback/);
});

test('dynamic logo URLs accept only the frozen public image policy',()=>{
 const good='https://coin-images.coingecko.com/coins/images/26580/large/ONDO.png?1696525656';assert.equal(approvedTokenImageURL(good),good);
 assert.ok(approvedTokenImageURL('https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png'));
 for(const url of ['http://coin-images.coingecko.com/coins/images/1/small/a.png','https://coin-images.coingecko.com.evil.test/coins/images/1/small/a.png','https://x@coin-images.coingecko.com/coins/images/1/small/a.png','https://coin-images.coingecko.com:443/coins/images/1/small/a.png','https://coin-images.coingecko.com/coins/images/1/small/a.png?key=secret','https://coin-images.coingecko.com/coins/images/1/small/a%2fsecret.png','https://coin-images.coingecko.com/coins/images/1/small/a.png#secret','https://coin-images.coingecko.com/markets/images/1/small/a.png','data:image/svg+xml,unsafe'])assert.equal(approvedTokenImageURL(url),null,url);
});

test('a dynamic contract logo stays isolated by chain, address and symbol and expires',()=>{
 const url='https://coin-images.coingecko.com/coins/images/26580/large/ONDO.png?1696525656',row={chain_id:'1',address:'0xAa11',symbol:'NEWC',image_url:url};
 registerTokenMetadata([row]);assert.equal(tokenLogo({chain_id:'1',address:'0xaa11',symbol:'NEWC'}),url);
 assert.equal(tokenLogo({chain_id:'56',address:'0xaa11',symbol:'NEWC'}),null);assert.equal(tokenLogo({chain_id:'1',address:'0xbb11',symbol:'NEWC'}),null);
 registerTokenMetadata([{asset_id:'expired-api-logo',symbol:'OLD',image_url:url}],{now:Date.now()-86400001});assert.equal(tokenLogo({asset_id:'expired-api-logo',symbol:'OLD'}),null);
});


test('account and strategy IDs never become token pairs',()=>{
 for(const value of ['SIM-01','SIM-02 · Unified paper account','S03-V4','API-KEY','DRAFT-01'])assert.deepEqual(pairSymbols(value),[],value);
 assert.deepEqual(pairSymbols('BTC-USDT'),['BTC','USDT']);
 assert.deepEqual(pairSymbols('NEWCOIN/USDC'),['NEWCOIN','USDC']);
 assert.equal(pairIcon('SIM-01'),'');
});
