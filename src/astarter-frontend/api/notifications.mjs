import {createPrivateUIRuntime} from '../private-ui-runtime.mjs';
import {createPrivateApiRoute} from '../private-api-route.mjs';
let route;
export default function handler(req,res){route||=createPrivateApiRoute('notifications',createPrivateUIRuntime().handle);return route(req,res);}
