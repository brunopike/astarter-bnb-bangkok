import {createWealthPublicMarketHandler} from '../wealth-public-market.mjs';
let handler;
export default async function wealthMarket(req,res){
 const original=req.url;
 // Vercel may present its exact function path after the public rewrite.
 if(typeof original==='string'&&(original==='/api/wealth-market'||original.startsWith('/api/wealth-market?')))req.url='/api/wealth/market'+original.slice('/api/wealth-market'.length);
 try{handler||=createWealthPublicMarketHandler();return await handler(req,res);}finally{req.url=original;}
}
