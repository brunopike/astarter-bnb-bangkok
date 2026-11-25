import {captureWalletReferral} from './wallet-session.mjs';
const LABELS={
 zh:['钱包登录','切换到 BSC','钱包账户','加载钱包','重试连接','钱包服务暂时不可用','正在连接','签名验证失败，请重试',"签名登录","已登录","正在退出","退出未完成，请重试","切换网络未完成，请重试","仅验证钱包地址，不授权交易或转账。","重试退出","钱包恢复超时，请重新连接"],
 en:['Sign in','Switch to BSC','Wallet account','Loading wallet','Retry connection','Wallet service unavailable','Connecting','Signature verification failed. Retry.',"Sign to log in","Signed in","Signing out","Sign-out failed. Please retry.","Network switch failed. Please retry.","Verify your wallet address only. No trading or transfers are authorized.","Retry sign-out","Wallet recovery timed out. Reconnect to continue."],
 ja:['ウォレットでログイン','BSC に切り替え','ウォレット','読み込み中','再試行','ウォレットサービスを利用できません','接続中','署名を確認できません。再試行してください。',"署名してログイン","ログイン済み","ログアウト中","ログアウトできません。再試行してください。","ネットワークを切り替えられません。再試行してください。","アドレスのみを確認します。取引や送金は許可されません。","ログアウトを再試行","ウォレットの復元がタイムアウトしました。再接続してください。"],
 ko:['지갑 로그인','BSC로 전환','지갑 계정','불러오는 중','다시 시도','지갑 서비스를 사용할 수 없습니다','연결 중','서명 확인에 실패했습니다. 다시 시도하세요.',"서명하여 로그인","로그인됨","로그아웃 중","로그아웃하지 못했습니다. 다시 시도하세요.","네트워크를 전환하지 못했습니다. 다시 시도하세요.","지갑 주소만 확인합니다. 거래나 송금을 승인하지 않습니다.","로그아웃 다시 시도","지갑 복원 시간이 초과되었습니다. 다시 연결하세요."],
 vi:['Đăng nhập ví','Chuyển sang BSC','Tài khoản ví','Đang tải ví','Thử lại','Dịch vụ ví tạm không khả dụng','Đang kết nối','Xác minh chữ ký thất bại. Hãy thử lại.',"Ký để đăng nhập","Đã đăng nhập","Đang đăng xuất","Đăng xuất thất bại. Hãy thử lại.","Chuyển mạng thất bại. Hãy thử lại.","Chỉ xác minh địa chỉ ví, không cấp quyền giao dịch hay chuyển tiền.","Thử đăng xuất lại","Khôi phục ví đã hết thời gian. Hãy kết nối lại."],
 es:['Iniciar sesión','Cambiar a BSC','Cuenta de billetera','Cargando billetera','Reintentar','Servicio no disponible','Conectando','No se pudo verificar la firma. Reintenta.',"Firmar para entrar","Sesión iniciada","Cerrando sesión","No se pudo cerrar la sesión. Reintenta.","No se pudo cambiar de red. Reintenta.","Solo se verifica tu dirección. No se autorizan operaciones ni transferencias.","Reintentar salida","Se agotó el tiempo de recuperación. Vuelve a conectar."],
 fr:['Se connecter','Passer à BSC','Compte du portefeuille','Chargement','Réessayer','Service indisponible','Connexion','Échec de la vérification de la signature. Réessayez.',"Signer pour se connecter","Connecté","Déconnexion","Échec de la déconnexion. Réessayez.","Échec du changement de réseau. Réessayez.","Seule votre adresse est vérifiée. Aucune transaction ni aucun transfert ne sont autorisés.","Réessayer la déconnexion","La restauration du portefeuille a expiré. Reconnectez-vous."],
 ru:['Войти','Переключить на BSC','Кошелёк','Загрузка','Повторить','Сервис недоступен','Подключение','Подпись не подтверждена. Повторите попытку.',"Подписать для входа","Вход выполнен","Выход","Не удалось выйти. Повторите попытку.","Не удалось сменить сеть. Повторите попытку.","Проверяется только адрес кошелька. Торговля и переводы не разрешаются.","Повторить выход","Время восстановления кошелька истекло. Подключитесь снова."]
};
export const walletLabels=lang=>LABELS[String(lang).split('-')[0]]||LABELS.en;
const STATUS_LABELS={
 zh:['重试登录','登录服务暂不可用，请稍后重试','钱包组件加载失败，请重试'],
 en:['Retry sign-in','Sign-in is temporarily unavailable. Please retry later.','Wallet component failed to load. Please retry.'],
 ja:['ログインを再試行','ログインを一時的に利用できません。後でもう一度お試しください。','ウォレットを読み込めません。再試行してください。'],
 ko:['로그인 다시 시도','지금은 로그인할 수 없습니다. 잠시 후 다시 시도하세요.','지갑을 불러오지 못했습니다. 다시 시도하세요.'],
 vi:['Thử đăng nhập lại','Đăng nhập tạm không khả dụng. Hãy thử lại sau.','Không tải được ví. Hãy thử lại.'],
 es:['Reintentar acceso','El inicio de sesión no está disponible. Reintenta más tarde.','No se pudo cargar la billetera. Reintenta.'],
 fr:['Réessayer la connexion','La connexion est temporairement indisponible. Réessayez plus tard.','Impossible de charger le portefeuille. Réessayez.'],
 ru:['Повторить вход','Вход временно недоступен. Повторите попытку позже.','Не удалось загрузить кошелёк. Повторите попытку.']
};
export const walletStatusLabels=lang=>STATUS_LABELS[String(lang).split('-')[0]]||STATUS_LABELS.en;
export function walletEntryAction({busy,error,address,wrongNetwork,reconnectSlow}){
 if(reconnectSlow)return 'reset';
 if(wrongNetwork)return 'network';
 if(busy&&!(busy==='session'&&!address))return 'wait';
 if(address&&(error==='logout'||error==='service'))return 'retry-session';
 return 'connect';
}
const MENU_LABELS={
 zh:['账户菜单','当前钱包','个人中心','外观','语言','复制地址','已复制','在区块浏览器查看','管理钱包','断开连接','复制失败，请重试'],
 en:['Account menu','Current wallet','Account center','Appearance','Language','Copy address','Copied','View in explorer','Manage wallet','Disconnect','Could not copy. Please retry.'],
 ja:['アカウントメニュー','現在のウォレット','アカウント','表示','言語','アドレスをコピー','コピーしました','エクスプローラーで表示','ウォレットを管理','接続を解除','コピーできません。再試行してください。'],
 ko:['계정 메뉴','현재 지갑','계정 센터','화면 설정','언어','주소 복사','복사됨','탐색기에서 보기','지갑 관리','연결 해제','복사하지 못했습니다. 다시 시도하세요.'],
 vi:['Menu tài khoản','Ví hiện tại','Tài khoản','Giao diện','Ngôn ngữ','Sao chép địa chỉ','Đã sao chép','Xem trên trình khám phá','Quản lý ví','Ngắt kết nối','Không thể sao chép. Hãy thử lại.'],
 es:['Menú de cuenta','Billetera actual','Mi cuenta','Apariencia','Idioma','Copiar dirección','Copiado','Ver en el explorador','Gestionar billetera','Desconectar','No se pudo copiar. Reintenta.'],
 fr:['Menu du compte','Portefeuille actuel','Mon compte','Apparence','Langue','Copier l’adresse','Copié','Voir dans l’explorateur','Gérer le portefeuille','Déconnecter','Copie impossible. Réessayez.'],
 ru:['Меню аккаунта','Текущий кошелёк','Мой аккаунт','Оформление','Язык','Копировать адрес','Скопировано','Открыть в обозревателе','Управление кошельком','Отключить','Не удалось скопировать. Повторите попытку.']
};
export const walletMenuLabels=lang=>MENU_LABELS[String(lang).split('-')[0]]||MENU_LABELS.en;
export function walletMenuPosition(anchor,{width,height}){
 return {right:Math.max(12,Math.min(width-anchor.right,width-Math.min(344,width-24)-12)),top:Math.max(12,Math.min(anchor.bottom+10,height-120))};
}
export const walletAuthenticated=(session,address,chainId,connectionStatus)=>Boolean(connectionStatus==='connected'&&chainId===56&&session?.chain===56&&session.expires>Date.now()&&address&&session.address?.toLowerCase()===address.toLowerCase());
export async function reauthenticateWalletProfile(auth,requiredProfile,isCurrent=()=>true){
 let result=await auth.reauthenticate();if(!result||!isCurrent())return null;
 if(requiredProfile==='private-ui-v2'&&result.session&&(result.session.authVersion!==2||result.session.permissionProfile!=='private-ui-v2')){
  if(!await auth.adapter.signOut()||!isCurrent())return null;
  result=await auth.reauthenticate();
 }
 if(!result||!isCurrent())return null;
 if(requiredProfile==='private-ui-v2'&&result.session!==null&&(result.session?.authVersion!==2||result.session?.permissionProfile!=='private-ui-v2'))return null;
 return result;
}
// An explicit profile request may wait for a connector or BSC switch, never a different account.
export function walletProfileContinuation(intent,{address,chainId,status},cancelled=false){
 if(intent?.requiredProfile!=='private-ui-v2')return {intent:null,resume:false};
 const current=typeof address==='string'?address.toLowerCase():null;
 if(intent.address&&(current&&current!==intent.address||status==='disconnected')||intent.connecting&&status==='disconnected')return {intent:null,resume:false};
 const next={...intent,address:intent.address||current,connecting:Boolean(intent.connecting||status==='connecting'||status==='reconnecting')};
 if(next.stage==='connect'&&current&&chainId===56&&status==='connected')return {intent:next,resume:true};
 if(cancelled&&next.stage!=='refresh'&&!['connecting','reconnecting'].includes(status))return {intent:null,resume:false};
 return {intent:next,resume:false};
}
export function deferWalletAuthentication(target,load){
 let requiredProfile=null;
 const authenticate=event=>{if(event.detail?.requiredProfile!=='private-ui-v2')return;event.preventDefault();requiredProfile='private-ui-v2';void load();};
 const cancel=()=>{requiredProfile=null;};
 const ready=()=>{target.removeEventListener('astarter:authenticate-wallet',authenticate);target.removeEventListener('astarter:wallet-ui-ready',ready);target.removeEventListener('astarter:wallet-flow-end',cancel);target.removeEventListener('pagehide',cancel);if(requiredProfile)target.dispatchEvent(new CustomEvent('astarter:authenticate-wallet',{detail:{requiredProfile},cancelable:true}));};
 target.addEventListener('astarter:authenticate-wallet',authenticate);target.addEventListener('astarter:wallet-ui-ready',ready);
 target.addEventListener('astarter:wallet-flow-end',cancel);target.addEventListener('pagehide',cancel);
}
export function mountWalletEntry(header,before){
 captureWalletReferral();
 const host=document.createElement('div');host.className='header-wallet';host.setAttribute('data-localized-ui','');
 const button=document.createElement('button');button.className='wallet-login';button.type='button';host.append(button);header.insertBefore(host,before);
 let loading=false;
 const label=()=>{const text=walletLabels(document.documentElement.lang)[loading?3:0];button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 8V5H5a3 3 0 0 0 0 6h15v10H3V8m17 4h-6v5h6m-3-2.5h.1"/></svg><span>'+text+'</span>';button.setAttribute('aria-label',text);};
 label();document.addEventListener('hive:locale',label);
 const load=async(autoOpen=false)=>{if(loading)return;loading=true;label();button.disabled=true;try{const css=new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/wallet-ui/header-wallet.css';link.onload=resolve;link.onerror=()=>{link.remove();reject(Error('wallet-styles'));};document.head.append(link);});const [ui]=await Promise.all([import('/wallet-ui/header-wallet.js'),css]);document.removeEventListener('hive:locale',label);ui.mount(host,{autoOpen});}catch{loading=false;button.disabled=false;const text=walletLabels(document.documentElement.lang);button.setAttribute('aria-label',text[4]);button.title=walletStatusLabels(document.documentElement.lang)[2];button.querySelector('span').textContent=text[4];window.dispatchEvent(new CustomEvent('astarter:wallet-flow-end',{detail:{error:'service'}}));}};
 deferWalletAuthentication(window,()=>load());
 button.onclick=()=>load(true);
 // Load outside the scene's startup path; retry remains available if the chunk fails.
 if('requestIdleCallback' in window)requestIdleCallback(()=>load(),{timeout:2000});else setTimeout(()=>load(),0);
}
