import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WagmiProvider,createConfig,http,useAccount,useDisconnect} from 'wagmi';
import {bsc} from 'wagmi/chains';
import {OptionsController} from '@reown/appkit-controllers';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {RainbowKitProvider,RainbowKitAuthenticationProvider,ConnectButton,createAuthenticationAdapter,connectorsForWallets,lightTheme,darkTheme,useConnectModal,useChainModal} from '@rainbow-me/rainbowkit';
import {injectedWallet,rabbyWallet,metaMaskWallet,okxWallet,trustWallet,bitgetWallet,rainbowWallet,walletConnectWallet,binanceWallet,tokenPocketWallet,safepalWallet,oneKeyWallet,coin98Wallet,zerionWallet,ledgerWallet,imTokenWallet} from '@rainbow-me/rainbowkit/wallets';
import {walletLabels,walletMenuLabels,walletMenuPosition,walletAuthenticated,walletEntryAction,walletStatusLabels,reauthenticateWalletProfile,walletProfileContinuation} from './wallet-entry.mjs';
import {createWalletSession} from './wallet-session.mjs';
import {binanceBrowserWallet} from './wallet-options.mjs';
import '@rainbow-me/rainbowkit/styles.css';
import './wallet-header.css';

const projectId=__WALLETCONNECT_PROJECT_ID__;
// shortcut: QR/mobile connectors stay unavailable until Astarter supplies its own Reown project ID.
const walletGroups=projectId?[
 {groupName:'Recommended',wallets:[binanceWallet]},
 {groupName:'Popular',wallets:[metaMaskWallet,okxWallet,trustWallet,bitgetWallet,rabbyWallet,rainbowWallet,walletConnectWallet]},
 {groupName:'More',wallets:[tokenPocketWallet,safepalWallet,oneKeyWallet,coin98Wallet,zerionWallet,ledgerWallet,imTokenWallet,injectedWallet]}
]:[{groupName:'Recommended',wallets:[binanceBrowserWallet]},{groupName:'BSC',wallets:[injectedWallet,rabbyWallet]}];
// shortcut: legacy QR options discard analytics; use provider options when EthereumProvider forwards AppKit features.
OptionsController.setFeatures({analytics:false});
const config=createConfig({chains:[bsc],transports:{[bsc.id]:http('https://bsc-dataseed.binance.org',{timeout:8000,retryCount:0})},connectors:connectorsForWallets(walletGroups,{appName:'Astarter',projectId}),ssr:false});
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const icon=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 8V5H5a3 3 0 0 0 0 6h15v10H3V8m17 4h-6v5h6m-3-2.5h.1"/></svg>;
const locales={zh:'zh-CN',en:'en-US',ja:'ja-JP',ko:'ko-KR',vi:'vi-VN',es:'es-419',fr:'fr-FR',ru:'ru-RU'};
const menuGlyph=path=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>;
const chevron=menuGlyph('m9 5 7 7-7 7');
export function WalletAccountMenu({address,displayName,description,lang,busy,onManage,onDisconnect}){
 const trigger=useRef(null),panel=useRef(null),profile=useRef(null),appearance=useRef(null),language=useRef(null);
 const [expanded,setExpanded]=useState(false),[copied,setCopied]=useState('');
 const labels=walletMenuLabels(lang),name=displayName||address.slice(0,6)+'…'+address.slice(-4);
 const close=(restore=false)=>{if(panel.current?.matches(':popover-open'))panel.current.hidePopover();if(restore)trigger.current?.focus({preventScroll:true});};
 useLayoutEffect(()=>{
  const menu=panel.current,button=trigger.current,moved=[];
  // Move the existing controls so their navigation, locale and scene-theme handlers stay intact.
  for(const [selector,slot] of [['.header-settings',profile.current],['.theme-switch',appearance.current],['.language-picker',language.current]]){
   const node=document.querySelector('.topbar>'+selector);if(!node)continue;
   const marker=document.createComment('wallet-menu-control');node.before(marker);slot.append(node);moved.push([node,marker]);
  }
  const position=()=>{const {right,top}=walletMenuPosition(button.getBoundingClientRect(),{width:innerWidth,height:innerHeight});menu.style.right=right+'px';menu.style.top=top+'px';menu.style.setProperty('--wallet-menu-top',top+'px');};
  const before=event=>{if(event.newState==='open')position();};
  const toggle=event=>{const open=event.newState==='open';setExpanded(open);if(!open){setCopied('');const picker=language.current?.querySelector('details');if(picker)picker.open=false;}};
  const resize=()=>close(),navigate=()=>close(true);
  menu.addEventListener('beforetoggle',before);menu.addEventListener('toggle',toggle);profile.current.addEventListener('click',navigate);window.addEventListener('resize',resize);
  return()=>{
   const hadFocus=menu.contains(document.activeElement)||document.activeElement===button;menu.removeEventListener('beforetoggle',before);menu.removeEventListener('toggle',toggle);profile.current?.removeEventListener('click',navigate);window.removeEventListener('resize',resize);
   for(const [node,marker] of moved)marker.replaceWith(node);
   if(hadFocus)requestAnimationFrame(()=>document.querySelector('.header-wallet .wallet-login')?.focus({preventScroll:true}));
  };
 },[]);
 useEffect(()=>{const button=profile.current?.querySelector('button');if(!button)return;let text=button.querySelector('.wallet-account-label');if(!text){text=document.createElement('span');text.className='wallet-account-label';button.append(text);}text.textContent=labels[2];return()=>text.remove();},[lang]);
 return <><button ref={trigger} type="button" className="wallet-login is-authenticated" popoverTarget="wallet-account-menu" aria-haspopup="dialog" aria-expanded={expanded} aria-controls="wallet-account-menu" aria-label={description} aria-disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={event=>{if(busy)event.preventDefault();}}><span className="wallet-avatar" aria-hidden="true"/><span className="wallet-name">{name}</span>{chevron}</button>
 <div ref={panel} id="wallet-account-menu" className="wallet-account-menu" popover="auto" role="dialog" aria-label={labels[0]} onKeyDownCapture={event=>{const picker=language.current?.querySelector('details[open]');if(event.key==='Escape'&&picker){event.preventDefault();event.stopPropagation();picker.open=false;picker.querySelector('summary')?.focus();}}}>
  <section className="wallet-menu-identity"><p className="wallet-menu-eyebrow">{labels[1]}</p><div className="wallet-menu-address"><span className="wallet-avatar" aria-hidden="true"/><div><strong title={address}>{name}</strong><span>BSC <i aria-hidden="true"/> {walletLabels(lang)[9]}</span></div><button type="button" className="wallet-menu-icon" aria-label={labels[8]} title={labels[8]} onClick={()=>{close(true);onManage();}}>{menuGlyph('M5 12h.01M12 12h.01M19 12h.01')}</button></div><div className="wallet-menu-address-actions"><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(address);setCopied('ok');}catch{setCopied('error');}}}>{menuGlyph(copied==='ok'?'m5 12 4 4L19 6':'M9 5V3h12v12h-2M3 9h12v12H3Z')}<span>{labels[copied==='ok'?6:5]}</span></button><a href={'https://bscscan.com/address/'+address} target="_blank" rel="noopener noreferrer" aria-label={labels[7]} title={labels[7]}>{menuGlyph('M14 3h7v7M21 3 11 13M10 3H3v18h18v-7')}</a></div>{copied==='error'&&<p className="wallet-menu-copy-error" role="alert">{labels[10]}</p>}<span className="sr-only" role="status">{copied==='ok'?labels[6]:''}</span></section>
  <div ref={profile} className="wallet-menu-profile"/>
  <div className="wallet-menu-preferences"><div className="wallet-menu-preference"><span>{labels[3]}</span><div ref={appearance}/></div><div className="wallet-menu-preference wallet-menu-language"><span>{labels[4]}</span><div ref={language}/></div></div>
  <button type="button" className="wallet-menu-disconnect" disabled={Boolean(busy)} onClick={()=>{close(true);onDisconnect();}}>{menuGlyph('M9 4H4v16h5M9 12h12m-4-4 4 4-4 4')}<span>{labels[9]}</span></button>
 </div></>;
}
function OpenOnMount({switchNetwork=false}){
 const {openConnectModal}=useConnectModal(),{openChainModal}=useChainModal(),open=switchNetwork?openChainModal:openConnectModal,opened=useRef(false);
 useEffect(()=>{if(!opened.current&&open){opened.current=true;document.querySelector('.header-wallet .wallet-login')?.focus();open();}},[open]);
 return null;
}
const finishWalletFlow=error=>window.dispatchEvent(new CustomEvent('astarter:wallet-flow-end',{detail:{error}}));
function WalletOverlayLifecycle({onClose}={}){
 const {connectModalOpen}=useConnectModal(),{chainModalOpen}=useChainModal(),wasOpen=useRef(false),open=connectModalOpen||chainModalOpen;
 useEffect(()=>{
  if(open){
   if(!wasOpen.current)window.dispatchEvent(new Event('astarter:wallet-modal-open'));
   wasOpen.current=true;return;
  }
  if(!wasOpen.current)return;
  // Allow a chain-to-connect transition and the wallet's focus cleanup to settle.
  const frame=requestAnimationFrame(()=>{wasOpen.current=false;if(onClose?.()!==false)finishWalletFlow();});
  return()=>cancelAnimationFrame(frame);
 },[open,onClose]);
 return null;
}
function WalletHeader({autoOpen}){
 const {address,chainId,status:connectionStatus}=useAccount();
 const {disconnect}=useDisconnect();
 const [narrow,setNarrow]=useState(()=>window.matchMedia('(max-width:767px)').matches);
 const [reconnectSlow,setReconnectSlow]=useState(false),[connectRequest,setConnectRequest]=useState(0);
 const [{session,error,busy},setAuth]=useState({session:undefined,error:null,busy:false}),[ui,setUI]=useState(()=>({lang:document.documentElement.lang,dark:document.documentElement.dataset.theme==='dark'}));
 const auth=useMemo(()=>{let storage;try{storage=window.localStorage;}catch{}return createWalletSession({update:setAuth,storage});},[]),accountKey=useRef();
 const labels=walletLabels(ui.lang),statusLabels=walletStatusLabels(ui.lang),currentWallet=useRef();
 currentWallet.current=[address,chainId,connectionStatus].join(':');
 const theme=useMemo(()=>{
  const surface=ui.dark?'#0b0d10':'#fff',ink=ui.dark?'#ecebe6':'#0b0d10',muted=ui.dark?'#8b8f96':'#555b64',soft=ui.dark?'#111419':'#f4f6f8',border=ui.dark?'#ecebe61f':'#0b0d101f';
  const base=(ui.dark?darkTheme:lightTheme)({accentColor:ink,accentColorForeground:surface,fontStack:'system',borderRadius:'medium',overlayBlur:'small'});
  return {...base,fonts:{body:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'},colors:{...base.colors,modalBackground:surface,modalText:ink,modalTextDim:muted,modalTextSecondary:muted,modalBorder:border,generalBorder:border,generalBorderDim:border,actionButtonBorder:border,actionButtonBorderMobile:border,actionButtonSecondaryBackground:soft,menuItemBackground:soft,closeButton:muted,closeButtonBackground:soft,downloadTopCardBackground:soft,downloadBottomCardBackground:soft,modalBackdrop:'rgba(5,6,8,.65)'}};
 },[ui.dark]);
 // RainbowKit detects mobile devices; also adapt when a desktop window becomes narrow.
 useEffect(()=>{const media=window.matchMedia('(max-width:767px)'),read=()=>setNarrow(media.matches);read();media.addEventListener('change',read);return()=>media.removeEventListener('change',read);},[]);
 useEffect(()=>{const read=()=>setUI({lang:document.documentElement.lang,dark:document.documentElement.dataset.theme==='dark'});const observer=new MutationObserver(read);observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang','data-theme']});return()=>observer.disconnect();},[]);
 useEffect(()=>{void auth.refresh();},[auth]);
 useEffect(()=>{setReconnectSlow(false);if(connectionStatus!=='reconnecting')return;const timer=setTimeout(()=>setReconnectSlow(true),10000);return()=>clearTimeout(timer);},[connectionStatus]);
 useEffect(()=>{
  if(connectionStatus==='reconnecting'||connectionStatus==='connecting')return;
  const key=address?address.toLowerCase()+':'+chainId:null;
  if(accountKey.current&&accountKey.current!==key)void auth.adapter.signOut();
  accountKey.current=key;
 },[address,chainId,connectionStatus,auth]);
 useEffect(()=>{
  if(!session)return;
  const refresh=()=>void auth.refresh(),timer=setTimeout(auth.expire,Math.max(0,session.expires-Date.now()));
  window.addEventListener('focus',refresh);
  return()=>{clearTimeout(timer);window.removeEventListener('focus',refresh);};
 },[session,auth]);
 useEffect(()=>{const sync=event=>{if(event.key==='astarter.wallet.logout'){auth.expire();void auth.refresh();}};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);},[auth]);
 const adapter=useMemo(()=>createAuthenticationAdapter(auth.adapter),[auth]);
 const wrongNetwork=Boolean(address&&chainId!==56),authenticated=walletAuthenticated(session,address,chainId,connectionStatus),status=session===undefined&&address?'loading':authenticated?'authenticated':'unauthenticated';
 useEffect(()=>{
  window.dispatchEvent(new CustomEvent('astarter:identity',{detail:{ownerRef:authenticated?'wallet:56:'+address.toLowerCase():null,expiresAt:authenticated?session.expires:null,authVersion:authenticated?session.authVersion||1:null,permissionProfile:authenticated?session.permissionProfile||null:null}}));
 },[authenticated,address,session]);
 useEffect(()=>{const hide=()=>{auth.profileIntent=null;auth.profileRequest={};auth.expire();},show=event=>{if(event.persisted)void auth.refresh();};window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);return()=>{window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);};},[auth]);
 useEffect(()=>{
  const authenticate=event=>{
   event.preventDefault();const menu=document.getElementById('wallet-account-menu');if(menu?.matches(':popover-open'))menu.hidePopover();
   window.dispatchEvent(new CustomEvent('astarter:identity',{detail:{ownerRef:null,expiresAt:null}}));
   const requiredProfile=event.detail?.requiredProfile,request={};auth.profileRequest=request;
   auth.profileIntent=requiredProfile==='private-ui-v2'?{requiredProfile,address:address?.toLowerCase()||null,stage:'connect'}:null;
   if(!address||wrongNetwork||connectionStatus!=='connected'){setConnectRequest(n=>n+1);return;}
   if(auth.profileIntent)auth.profileIntent.stage='refresh';
   const wallet=currentWallet.current;
   void reauthenticateWalletProfile(auth,requiredProfile,()=>wallet===currentWallet.current&&request===auth.profileRequest).then(result=>{if(request!==auth.profileRequest)return;if(!result||wallet!==currentWallet.current){auth.profileIntent=null;if(requiredProfile==='private-ui-v2')auth.expire?.();finishWalletFlow(wallet===currentWallet.current?'service':undefined);return;}if(walletAuthenticated(result.session,address,chainId,connectionStatus)){auth.profileIntent=null;window.dispatchEvent(new CustomEvent('astarter:identity',{detail:{ownerRef:'wallet:56:'+address.toLowerCase(),expiresAt:result.session.expires,authVersion:result.session.authVersion||1,permissionProfile:result.session.permissionProfile||null}}));finishWalletFlow();}else{if(auth.profileIntent)auth.profileIntent.stage='sign';setConnectRequest(n=>n+1);}});
  };
  window.addEventListener('astarter:authenticate-wallet',authenticate);
  window.dispatchEvent(new CustomEvent('astarter:wallet-ui-ready'));
  return()=>window.removeEventListener('astarter:authenticate-wallet',authenticate);
 },[auth,address,chainId,connectionStatus,wrongNetwork]);
 const continueProfile=()=>{
  const pending=auth.profileIntent;if(!pending)return;
  const next=walletProfileContinuation(pending,{address,chainId,status:connectionStatus});auth.profileIntent=next.intent;
  if(!next.intent){auth.profileRequest={};auth.expire();return;}
  if(next.resume){next.intent.stage='refresh';window.dispatchEvent(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:next.intent.requiredProfile},cancelable:true}));return;}
  if(next.intent.stage==='sign'&&authenticated){auth.profileIntent=null;const compatible=session?.authVersion===2&&session?.permissionProfile==='private-ui-v2';if(!compatible)auth.expire();finishWalletFlow(compatible?undefined:'service');}
 };
 useEffect(continueProfile,[auth,address,chainId,connectionStatus,connectRequest,authenticated,session]);
 const profileOverlayClosed=()=>{
  const pending=auth.profileIntent;if(!pending)return true;
  const next=walletProfileContinuation(pending,{address,chainId,status:connectionStatus},true);auth.profileIntent=next.intent;
  if(!next.intent){auth.profileRequest={};auth.expire();return true;}
  if(next.resume){next.intent.stage='refresh';window.dispatchEvent(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile:next.intent.requiredProfile},cancelable:true}));}
  return false;
 };
 const appInfo=useMemo(()=>({appName:'Astarter',disclaimer:({Text})=><Text>{walletLabels(ui.lang)[13]}</Text>}),[ui.lang]);
 return <RainbowKitAuthenticationProvider adapter={adapter} status={status} enabled={!wrongNetwork&&error!=='service'&&error!=='logout'&&busy!=='logout'}><RainbowKitProvider locale={locales[ui.lang.split('-')[0]]||'en-US'} modalSize={narrow?'compact':'wide'} id="astarter_wallet" theme={theme} appInfo={appInfo} initialChain={bsc} showRecentTransactions={false}>
 <WalletOverlayLifecycle onClose={profileOverlayClosed}/>
 {(autoOpen||connectRequest>0)&&<OpenOnMount key={connectRequest} switchNetwork={wrongNetwork}/>}
 <ConnectButton.Custom>{({account,chain,mounted,openConnectModal,openChainModal,openAccountModal})=>{
  const loading=!mounted||(connectionStatus==='reconnecting'&&!reconnectSlow),action=walletEntryAction({busy,error,address,wrongNetwork,reconnectSlow}),showError=Boolean(reconnectSlow||error&&!(error==='service'&&!address)),label=loading?labels[3]:action==='wait'?labels[busy==='logout'?10:3]:reconnectSlow?labels[4]:wrongNetwork?labels[1]:error==='logout'?labels[14]:error==='service'&&address?statusLabels[0]:authenticated?account?.displayName||address:address?labels[8]:labels[0];
  const description=authenticated?labels[9]+' · BSC · '+address:label;
  // Reset a stalled connector independently; pending server sign-out still blocks all new sign-in attempts.
  return <div className="wallet-control" data-wallet-state={loading?'loading':reconnectSlow?'reconnecting':wrongNetwork?'wrong-network':authenticated?'authenticated':address?'connected':'disconnected'}>{authenticated?<WalletAccountMenu key={address} address={address} displayName={account?.displayName} description={description} lang={ui.lang} busy={busy} onManage={openAccountModal} onDisconnect={disconnect}/>:<button type="button" className="wallet-login" disabled={loading} aria-disabled={Boolean(loading||action==='wait')} aria-label={description} aria-busy={Boolean(loading||action==='wait')} aria-describedby={showError?'wallet-error':undefined} title={description} onClick={async()=>{if(action==='wait')return;if(action==='reset'){void auth.adapter.signOut();config.setState(state=>state.status==='reconnecting'?{...state,connections:new Map(),current:null,status:'disconnected'}:state);setConnectRequest(n=>n+1);return;}if(action==='retry-session'){if(await auth.refresh())setConnectRequest(n=>n+1);return;}if(action==='network')openChainModal();else openConnectModal();}}>{icon}<span>{label}</span></button>}{showError&&<span id="wallet-error" className="wallet-error" role="alert">{error==='service'?statusLabels[1]:labels[error==='logout'?11:reconnectSlow?15:error==='verify'?7:5]}</span>}</div>;
 }}</ConnectButton.Custom>
 </RainbowKitProvider></RainbowKitAuthenticationProvider>;
}
export function mount(host,{autoOpen=false}={}){createRoot(host).render(<WagmiProvider config={config}><QueryClientProvider client={queryClient}><WalletHeader autoOpen={autoOpen}/></QueryClientProvider></WagmiProvider>);}
