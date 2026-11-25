// Binds S01 and S02 to the checked Binance spot account. This module does not place orders.
export function spotBotStrategy(clientOrderId){
 const id=String(clientOrderId||'');
 if(id.startsWith('astarter-s01-')||/^as01[0-9a-f]{16}$/.test(id))return 'S01';
 if(id.startsWith('astarter-s02-'))return 'S02';
 return '';
}
export function spotBotBinding(orders){
 const list=Array.isArray(orders)?orders:[];
 const owned=strategy=>list.filter(row=>row?.strategy===strategy);
 return {
  accountId:'BINANCE-SPOT',
  connectionId:'binance-spot',
  pair:'BTC/USDT',
  withdraw:false,
  executionAuthority:'NONE',
  S01:{strategy:'S01',bound:true,orders:owned('S01')},
  S02:{strategy:'S02',bound:true,orders:owned('S02')}
 };
}
