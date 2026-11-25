import {createResearchRuntime} from '../research-runtime.mjs';
import {createPrivateApiRoute} from '../private-api-route.mjs';
let route;
export default function handler(req,res){route||=createPrivateApiRoute('research',createResearchRuntime().handle);return route(req,res);}
