// Explicit local fixtures. These profiles do not assert connected venue capability.
export const ORDER_MARKETS = Object.freeze({
 'cex-spot': {id:'cex-spot',venueId:'binance',venue:'Binance',venueType:'CEX',marketType:'SPOT',currency:'USDT',feeRate:.001,leverageMax:1},
 'cex-perp': {id:'cex-perp',venueId:'binance',venue:'Binance',venueType:'CEX',marketType:'PERPETUAL',currency:'USDT',feeRate:.0005,leverageMax:10},
 'dex-spot': {id:'dex-spot',venueId:'uniswap',venue:'Uniswap',venueType:'DEX',marketType:'SPOT',currency:'USDC',chain:'Arbitrum',feeRate:.003,gas:.25,leverageMax:1},
 'dex-perp': {id:'dex-perp',venueId:'hyperliquid',venue:'Hyperliquid',venueType:'DEX',marketType:'PERPETUAL',currency:'USDC',chain:'Hyperliquid',feeRate:.0005,leverageMax:10}
});
export const orderMarket=t=>ORDER_MARKETS[t?.profileId||'cex-spot']||null;
export const isPerp=p=>p?.marketType==='PERPETUAL';
export const orderAuthorizationKey=t=>JSON.stringify(['profileId','accountId','connectionId','scopeGeneration','accessRevision','walletIdentity','network','market','sourceId','revision','direction','amount','cap','leverage','slippage','quotePrice','quotedAt','maxGap','stopLoss','takeProfit'].map(key=>t[key]??null));
export function orderWalletStep(ticket){
 const p=orderMarket(ticket);
 if(p?.venueType!=='DEX')return null;
 if(!ticket.walletConnected)return 'connect';
 if(ticket.network!==p.chain)return 'network';
 if(!ticket.rpcReady)return 'reconnect';
 if(!ticket.walletAuthorized||ticket.walletRefused||ticket.authorizationKey!==orderAuthorizationKey(ticket))return 'review';
 return null;
}
export const positionPnl=p=>isPerp(p)?((p.markPrice??p.price)-p.price)*p.qty*(p.direction==='short'?-1:1):0;
export const positionValue=p=>!p?0:isPerp(p)?p.margin+Math.max(-p.margin,positionPnl(p)):p.qty*p.price;
export function orderTerms(t,price=t.quotePrice){
 const p=orderMarket(t);if(!p)return null;
 const perp=isPerp(p),leverage=perp?Number(t.leverage||1):1,notional=Number(t.amount)*leverage;
 const direction=perp?t.direction||'long':'long',sign=direction==='short'?-1:1;
 return {profile:p,perp,leverage,notional,direction,quantity:notional/price,fee:notional*p.feeRate,gas:p.gas||0,
  loss:notional*Math.abs(price-t.stopLoss)/price+notional*p.feeRate*2+(p.gas||0)*2,
  liquidationPrice:perp?price*(1-sign*(1/leverage-.005)):null,
  minReceived:notional/price*(1-Number(t.slippage||.5)/100)};
}
export function marketTicketError(t,price,{cap=3000,dailyLoss=Infinity,cash=Infinity,market='',wallet=true}={}){
 const p=orderMarket(t),v=orderTerms(t,price);
 if(!p||!v)return '不支持的下单市场。 / Unsupported market.';
 if(t.market&&market&&t.market!==market)return '交易资产已变化，请重新检查这笔交易。 / The asset changed. Review this trade again.';
 if(!Number.isFinite(price)||price<=0)return '报价不可用，请刷新。 / Refresh the quote.';
 if(!Number.isFinite(t.amount)||t.amount<10||t.amount>1000||!Number.isFinite(t.cap)||t.cap<t.amount||t.cap>Math.min(3000,cap))return '单笔需 10–1,000，且不能超过账户额度。 / Check order size and account limits.';
 if(!v.perp&&t.direction&&t.direction!=='long')return '现货只能卖出已有数量，不能开空。 / Spot cannot open a short.';
 if(!Number.isInteger(v.leverage)||v.leverage<1||v.leverage>p.leverageMax||!['long','short'].includes(v.direction))return '请检查方向与杠杆。 / Check direction and leverage.';
 if(v.notional>Math.min(t.cap,cap))return '交易总额超过上限，请减少金额或杠杆。 / Notional exceeds your limit.';
 const short=v.direction==='short';
 if(!Number.isFinite(t.stopLoss)||!Number.isFinite(t.takeProfit)||t.stopLoss<=0||t.takeProfit<=0||(short?!(t.takeProfit<price&&price<t.stopLoss):!(t.stopLoss<price&&price<t.takeProfit)))return short?'做空需：止盈价 < 当前价 < 止损价。 / Short: target < price < stop.':'买入需：止损价 < 当前价 < 止盈价。 / Long: stop < price < target.';
 if(v.perp&&(short?t.stopLoss>=v.liquidationPrice:t.stopLoss<=v.liquidationPrice))return '止损需设在模拟强平线之前。 / Set the stop before the demo liquidation level.';
 if(v.loss>dailyLoss)return '预计止损与费用超过亏损上限，请缩小金额。 / Estimated loss exceeds the account limit.';
 if(t.amount+v.fee+v.gas>cash)return '可用模拟余额不足以覆盖本金和费用。 / Insufficient demo balance including costs.';
 if(p.id==='dex-spot'&&!['ETH/USDT','BTC/USDT'].includes(market))return '该 Arbitrum 样例只支持 WETH 与 WBTC。 / This Arbitrum fixture supports WETH and WBTC only.';
 if(p.id==='dex-spot'&&(!Number.isFinite(t.slippage)||t.slippage<.1||t.slippage>2))return '兑换滑点需在 0.1%–2% 之间。 / Swap slippage must be 0.1–2%.';
 if(p.id==='dex-spot'&&Number.isFinite(t.quotePrice)&&t.amount/price<t.amount/t.quotePrice*(1-t.slippage/100)-1e-12)return '价格变化后低于最少收到数量，请刷新兑换报价。 / Output below your minimum; refresh the swap quote.';
 if(wallet&&p.venueType==='DEX'){
  if(!t.walletConnected)return '请先连接模拟钱包。 / Connect the demo wallet.';
  if(t.network!==p.chain)return '钱包网络不匹配，请切换模拟网络。 / Switch the demo wallet network.';
  if(!t.walletAuthorized)return p.marketType==='SPOT'?'请先检查本次 USDC 授权。 / Approve the demo USDC amount.':'请先确认模拟交易授权。 / Authorize this demo session.';
  if(t.authorizationKey!==orderAuthorizationKey(t))return '交易设置已变化，请重新确认本次授权。 / Trade settings changed. Review this authorization again.';
  if(t.walletRefused)return '你取消了模拟签名，尚未提交。 / Signature declined; nothing submitted.';
  if(!t.rpcReady)return '模拟连接不可用，尚未提交。 / Demo connection unavailable.';
 }
 return null;
}
export const orderSideLabel=(o,english=false)=>isPerp(o)?(english?`${o.intent==='close'?'Close':'Open'} ${o.direction==='short'?'short':'long'}`:`${o.intent==='close'?'平':'开'}${o.direction==='short'?'空':'多'}`):(o.side==='buy'?(english?'Buy':'买入'):(english?'Sell':'卖出'));
export const marketLabel=o=>`${o.venue||'Binance'} · ${o.venueType||'CEX'} ${isPerp(o)?'PERP':'SPOT'}`;

// Simplified isolated settlement: the allocated margin includes closing costs.
export function closeSettlement(o,qty){const margin=qty*o.marginPerUnit,fee=Math.min(margin,qty*o.price*(o.feeRate??.001)),pnl=Math.max(-margin+fee,(o.price-o.entryPrice)*qty*(o.direction==='short'?-1:1));return {margin,fee,pnl};}
