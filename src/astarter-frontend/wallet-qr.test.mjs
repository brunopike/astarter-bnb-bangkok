import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {binanceBrowserWallet,prioritizeBinanceWallets,bindWalletLocale} from './wallet-options.mjs';

const require=createRequire(import.meta.url);
// shortcut: RainbowKit 2.2.11 pins the broken QR renderer; remove its cuer override once RainbowKit ships the fix.
const rainbowRequire=createRequire(require.resolve('@rainbow-me/rainbowkit'));
const {Cuer}=await import(pathToFileURL(rainbowRequire.resolve('cuer')).href);
const pairing='wc:TEST_PAIRING_TOPIC@2?relay-protocol=irn&symKey=TEST_ONLY_NOT_A_REAL_KEY';

test('wallet picker retries its language on reconnect or on opening, without changing an active selection',async()=>{
 const target=new EventTarget();target.navigator={onLine:false};
 const applied=[],cache=new Map([['en-US',{}]]);
 const i18n={isLocaleCached:code=>cache.has(code),updateLocale:code=>applied.push(code),
  setTranslations(code,dict){cache.set(code,dict);applied.push(code);}};
 let attempts=0;
 const stop=bindWalletLocale(i18n,'zh-CN',async()=>{
  if(++attempts===1)throw Error('offline');
  return '{"title":"连接钱包"}';
 },target);
 assert.equal(attempts,0);
 target.navigator.onLine=true;target.dispatchEvent(new Event('online'));await Promise.resolve();
 assert.deepEqual(applied,[]);
 target.dispatchEvent(new Event('astarter:wallet-modal-open'));await Promise.resolve();
 assert.equal(cache.get('zh-CN').title,'连接钱包');
 target.dispatchEvent(new Event('online'));stop();
 assert.equal(attempts,2);
 let finish;
 const cancel=bindWalletLocale(i18n,'fr-FR',()=>new Promise(resolve=>{finish=resolve;}),target);
 cancel();
 target.navigator.onLine=false;
 bindWalletLocale(i18n,'en-US',()=>assert.fail('cached language should not read a chunk'),target);
 finish('{}');await Promise.resolve();
 assert.deepEqual(applied,['zh-CN','en-US']);
});

test('RainbowKit QR renderer accepts pairing and wallet deep-link payloads',()=>{
 for(const value of [pairing,'https://metamask.app.link/wc?uri='+encodeURIComponent(pairing)]){
  const markup=renderToStaticMarkup(createElement(Cuer,{value}));
  assert.match(markup,/<svg\b/);
  assert.ok((markup.match(/M /g)||[]).length>100,'QR must contain rendered module paths');
 }
});

test('Binance stays first across recent and discovered wallets, retaining the discovered connection on mobile',()=>{
 const connect=()=>{},other={id:'metaMask',recent:true},installed={id:'com.binance.wallet',ready:true,connect},branded={id:'binance',ready:true,getMobileUri:()=>{}};
 const desktop=prioritizeBinanceWallets([other,installed],false);
 assert.deepEqual(desktop.map(wallet=>wallet.id),['com.binance.wallet','metaMask']);
 assert.equal(desktop[0].groupIndex,-1);
 assert.equal(desktop[0].iconUrl,'/brand/binance-wallet.svg');
 assert.equal(desktop[1],other);
 const mobile=prioritizeBinanceWallets([other,installed,branded],true).filter(wallet=>wallet.id!=='com.binance.wallet');
 assert.deepEqual(mobile.map(wallet=>wallet.id),['binance','metaMask']);
 assert.equal(mobile[0].connect,connect);
 assert.equal(mobile[0].getMobileUri,undefined);
 const wallet=binanceBrowserWallet(),download=wallet.downloadUrls.mobile;
 assert.equal(mobile[0].iconUrl,wallet.iconUrl);
 assert.equal(desktop[0].iconBackground,wallet.iconBackground);
 const fallback={...wallet,ready:false,mobileDownloadUrl:download};
 assert.equal(prioritizeBinanceWallets([other,fallback],false)[0].extensionDownloadUrl,download);
 assert.equal(prioritizeBinanceWallets([other,fallback],true)[0].ready,true);
});
