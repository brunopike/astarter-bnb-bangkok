import {createPrivateUIRuntime} from '../private-ui-runtime.mjs';
import {createPrivateApiRoute} from '../private-api-route.mjs';
let route;
export default function handler(req,res){route||=createPrivateApiRoute('strategy-drafts',createPrivateUIRuntime().handleDrafts);return route(req,res);}
