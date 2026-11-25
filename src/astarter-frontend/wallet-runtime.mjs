import {createPrivateIssuerClient} from './private-service-client.mjs';
import {createPrivateWalletAuth} from './wallet-private-auth.mjs';

export function createWalletRuntime({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const distinct=env.ASTARTER_PRIVATE_ISSUER_TOKEN&&env.ASTARTER_PRIVATE_ISSUER_TOKEN!==env.ASTARTER_PRIVATE_RUNTIME_TOKEN;
 const issuer=createPrivateIssuerClient({origin:env.ASTARTER_PRIVATE_SERVICE_ORIGIN,token:distinct?env.ASTARTER_PRIVATE_ISSUER_TOKEN:'',fetchImpl});
 return createPrivateWalletAuth({issuer,now,authVersion:env.ASTARTER_PRIVATE_UI_ENABLED==='1'?2:1});
}
