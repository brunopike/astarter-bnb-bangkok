import {createConnector, injected} from 'wagmi';

const binanceIcon={iconUrl:'/brand/binance-wallet.svg',iconBackground:'#000000'};
const walletPage='https://www.binance.com/en/web3wallet';
function binanceProvider(win){
 const providers=Array.isArray(win?.ethereum?.providers)?win.ethereum.providers:[];
 return [win?.binancew3w?.ethereum,...providers,win?.ethereum].find(provider=>
  typeof provider?.request==='function'&&(provider===win?.binancew3w?.ethereum||provider.isBinance)
 );
}

// Extension-only builds can still log in with Binance or direct users to its official download.
export function binanceBrowserWallet(){
 const id='binance',name='Binance Wallet';
 return {id,name,rdns:'com.binance.wallet',...binanceIcon,
  installed:Boolean(binanceProvider(globalThis.window)),downloadUrls:{mobile:walletPage,browserExtension:walletPage},
  createConnector:details=>createConnector(config=>({
   ...injected({target:{id,name,provider:binanceProvider}})(config),...details
  }))
 };
}

export function prioritizeBinanceWallets(wallets,mobile){
 const first=[],others=[];
 const discovered=mobile&&wallets.find(wallet=>wallet.id==='com.binance.wallet'&&wallet.ready);
 for(const wallet of wallets){
  if(wallet.id!=='binance'&&wallet.id!=='com.binance.wallet'){others.push(wallet);continue;}
  const option={...wallet,...binanceIcon,name:'Binance Wallet',groupName:'Recommended',groupIndex:-1};
  if(discovered&&wallet.id==='binance'){
   // RainbowKit's mobile list renders branded entries even when EIP-6963 found the extension.
   Object.assign(option,{ready:true,connect:discovered.connect,getMobileUri:undefined});
  }else if(!wallet.ready&&wallet.mobileDownloadUrl){
   if(mobile){
    option.ready=true;
    option.connect=()=>window.location.assign(wallet.mobileDownloadUrl);
   }else option.extensionDownloadUrl??=wallet.mobileDownloadUrl;
  }
  first.push(option);
 }
 return [...first,...others];
}

// RainbowKit loads picker translations in a separate chunk. Keep the current language until the requested one is ready.
export function bindWalletLocale(i18n,locale,fetchTranslations,target=window){
 let active=true;
 function stop(){
  active=false;
  target.removeEventListener('online',apply);
  target.removeEventListener('astarter:wallet-modal-open',apply);
 }
 async function apply(){
  if(!active)return;
  if(i18n.isLocaleCached(locale)){i18n.updateLocale(locale);stop();return;}
  if(target.navigator?.onLine===false)return;
  try{
   const translations=JSON.parse(await fetchTranslations(locale));
   if(active){i18n.setTranslations(locale,translations);stop();}
  }catch{/* Reconnect or reopen the picker to retry the same local language file. */}
 }
 target.addEventListener('online',apply);
 target.addEventListener('astarter:wallet-modal-open',apply);
 void apply();
 return stop;
}
