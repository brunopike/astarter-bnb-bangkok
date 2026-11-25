import {createWalletRuntime} from '../wallet-runtime.mjs';
import {createPrivateApiRoute} from '../private-api-route.mjs';
let route;
export default function handler(req,res){route||=createPrivateApiRoute('wallet',createWalletRuntime().handle);return route(req,res);}
