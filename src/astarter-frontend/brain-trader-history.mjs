import gains from './brain-evidence/trader-gains.json' with {type:'json'};
import losses from './brain-evidence/trader-losses.json' with {type:'json'};
import positions from './brain-evidence/trader-positions.json' with {type:'json'};
import exits from './brain-evidence/perp-exits.json' with {type:'json'};

const coinIds={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',HYPE:'hyperliquid',NEAR:'near',ZEC:'zcash',LTC:'litecoin',AAVE:'aave',TAO:'bittensor',HBAR:'hedera-hashgraph',ZRO:'layerzero',WLD:'worldcoin-org',FARTCOIN:'fartcoin',VVV:'venice-token',ASTER:'aster-2',kPEPE:'pepe',PURR:'purr-2',LIT:'lighter'};
const format=new Intl.NumberFormat('en-US',{maximumSignificantDigits:8});
const money=new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const f=value=>format.format(value);
const m=value=>money.format(value);
const pair=(a,b)=>[a,b];
const signed=value=>(value>0?'+':'')+m(value);
const date=ms=>new Date(ms).toISOString();
export const gainNode=14,lossNode=15;

function perpCase(batch){
  const {coin,wallet,direction,orderId,hash,time,fills}=batch;
  const long=direction==='Close Long',actor=wallet.slice(0,8)+'…'+wallet.slice(-5);
  const sum=ix=>fills.reduce((total,fill)=>total+Number(fill[ix]),0);
  const size=sum(2),pnl=sum(4),fees=sum(5),avg=fills.reduce((a,row)=>a+Number(row[2])*Number(row[3]),0)/size;
  const before=Math.abs(Number(fills[0][1])),remaining=Math.max(0,before-size);
  const share=100*size/before,flat=remaining<1e-8;
  const op=long?'卖出平多':'买入平空',opEn=long?'Sell to close long':'Buy to close short';
  const amount=signed(pnl)+' USDC',unit=f(size)+' '+coin;
  return {
    id:'hl/'+wallet+'/'+orderId+'/'+hash,actor,date:date(time).slice(0,10),knownAt:exits.retrievedAt,eventAt:date(time),
    chains:['hyperliquid'],assets:coinIds[coin]?['coin:'+coinIds[coin]]:[],outcome:pnl>0?'gain':'loss',basis:'closed-fill',venue:'Hyperliquid',
    title:pair(coin+' 永续 · '+op+' '+unit,coin+' perpetual · '+opEn+' '+unit),
    amount:pair(amount,amount),
    outcomeTags:{action:pair(op,opEn),size:pair(unit,unit),pnl:pair('本批费前 '+amount,'Pre-fee batch P&L '+amount)},
    summary:pair(actor+' 在同一笔交易、同一委托中'+op+'，成交均价 $'+f(avg)+'，交易所逐笔 closedPnl 合计 '+amount+'。',
      actor+' closed '+unit+' at a weighted average of $'+f(avg)+'. The fills in this transaction and order report '+amount+' in closedPnl.'),
    logic:pair(op+'降低了已有'+(long?'多头':'空头')+'敞口。本组成交占成交前仓位的 '+m(share)+'%，'+(flat?'仓位减至零。':'其余 '+f(remaining)+' '+coin+' 仍留在仓位中。'),
      opEn+' reduced the existing position by '+m(share)+'%. '+(flat?'The position reached zero.':f(remaining)+' '+coin+' remained.')),
    lesson:pair(flat?'仓位已经归零。要复盘整笔策略，还需找到开仓、历次加减仓和期间资金费。':'核对减仓后的剩余数量，才能判断账户还承担多少方向风险。',
      flat?'To reconstruct the full trade, trace the opening, prior changes and funding over the holding period.':'Use the remaining size to measure how much directional exposure persisted.'),
    limits:pair('盈亏采用交易所 closedPnl 字段；另列成交费。这里只覆盖本批成交，开仓动机、链外对冲和全账户净收益未知。',
      'P&L uses the venue’s closedPnl field. The fill fee is reported separately. Entry motive, external hedges and net account return are unknown.'),
    steps:[
      {label:pair('成交前仓位','Starting position'),detail:pair(f(before)+' '+coin+' · '+(long?'多头':'空头'),f(before)+' '+coin+' · '+(long?'long':'short')),source:0},
      {label:pair('本次平仓','Closing fills'),detail:pair(unit+' · '+fills.length+' 笔成交 · 加权均价 $'+f(avg),unit+' · '+fills.length+' fills · VWAP $'+f(avg)),source:0},
      {label:pair('平仓盈亏 / 成交费','Closed P&L / fill fee'),detail:pair(amount+' / '+f(fees)+' USDC',amount+' / '+f(fees)+' USDC'),source:0}],
    sources:[{label:'Hyperliquid · Tx',url:'https://app.hyperliquid.xyz/explorer/tx/'+hash},{label:'Hyperliquid · '+actor,url:'https://app.hyperliquid.xyz/explorer/address/'+wallet},
      {label:'Hyperliquid · userFills',url:'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#retrieve-a-users-fills'}],
    batch
  };
}
function record(trader,collection) {
  const node=trader.outcome==='gain'?gainNode:lossNode;
  const keys=trader.assets.filter(k=>k.startsWith('coin:')||k.startsWith('ca:'));
  return {id:'trader/'+trader.id,kind:'trader',collection,trader,nodes:[node,3,4,13],scopeKeys:keys.length?keys:['all'],
    eventAt:trader.eventAt||trader.date+'T00:00:00Z',knownAt:trader.knownAt,title:trader.title,body:trader.summary,
    source:trader.sources[0].label,sourceUrl:trader.sources[0].url,references:trader.sources.slice(1)};
}
export const traderRecords=[
  ...gains.concat(losses).map(c=>record(c,'wallet')),
  ...positions.map(c=>record(c,'prediction')),
  ...exits.batches.map(b=>record(perpCase(b),'perps'))
];
