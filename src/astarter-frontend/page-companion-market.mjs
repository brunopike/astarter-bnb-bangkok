import {createMarketHubClient, HUB_ASSET_IDS, HUB_RESOURCES} from './market-hub-data.mjs';
import {candleRequest, subscribeCandles} from './trading-chart-data.mjs';
import {L} from './execution-views.mjs';
import {escapeUI as esc} from './product-experience.mjs';

const minute = 60_000;
const priceText = n => n.toLocaleString('en-US', {maximumFractionDigits: n < 1 ? 8 : 2});
const timeText = at => new Date(at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const percent = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

function sparkline(bars) {
  if (bars.length < 2) return '';
  const values = bars.map(bar => bar.close);
  const low = Math.min(...values), range = Math.max(...values) - low;
  const points = values.map((v, i) => (260*i/(values.length-1)).toFixed(1) + ',' + (range ? 40-36*(v-low)/range : 22).toFixed(1));
  return '<svg class="pet-spark" viewBox="0 0 260 44" role="img" aria-label="' +
    esc(L('最近 '+bars.length+' 根一分钟 K 线','Last '+bars.length+' one-minute candles')) +
    '"><polyline points="'+points.join(' ')+'"/></svg>';
}

export function marketCompanionBrief({symbol, ticker, streamQuote, bars, now, failed, analysis = false}) {
  const quote = streamQuote && (!ticker || streamQuote.asOf > ticker.asOf) ? streamQuote : ticker;
  const href = '?'+new URLSearchParams({page:'markets',asset:symbol,coin:HUB_ASSET_IDS[symbol]});
  const label = analysis ? L('行情观察','Market observation') : L('现货行情','Spot quote');
  if (!quote || now-quote.asOf > 24*60*minute) {
    return {kind:'status',label,modeLabel:L('公开数据','Public data'),title:symbol+'/USDT',
      body:failed || quote ? L('报价暂不可用，正在重试。','Quote unavailable. Retrying.') : L('正在读取报价…','Loading quote…'),
      visual:'',source:'Binance Spot',timestamp:null,href,action:L('市场详情','Market details')};
  }
  const stale = now-quote.asOf > HUB_RESOURCES.tickers.stale || (failed && quote === ticker);
  const recentBars = bars.length && Math.abs(quote.asOf - bars.at(-1).time*1000) <= 2*minute ? bars : [];
  // A rolling 24h percentage belongs to its ticker. Never infer one from a minute candle.
  const change = ticker && Math.abs(ticker.asOf-quote.asOf) <= HUB_RESOURCES.tickers.stale ? ticker.change : null;
  const changeText = Number.isFinite(change) ? percent(change) : '';
  const timestamp = timeText(quote.asOf);
  const modeLabel = stale ? L('延迟报价','Delayed quote') : quote === streamQuote ? L('实时','Live') : L('最新报价','Latest quote');
  const name = symbol+'/USDT', amount = priceText(quote.price);
  let body = '';
  if (analysis && recentBars.length > 1) {
    const min = Math.min(...recentBars.map(b=>b.low)), max = Math.max(...recentBars.map(b=>b.high));
    body = L('近 '+recentBars.length+' 分钟区间','Last '+recentBars.length+' min range')+'  '+priceText(min)+' – '+priceText(max)+' USDT';
  }
  const visual = '<div class="pet-quote"><strong>'+amount+'</strong><small class="pet-unit">USDT</small>'+
    (changeText ? '<span class="'+(change>=0?'positive':'negative')+'">'+changeText+' <small>24h</small></span>' : '')+
    '</div>'+sparkline(recentBars);
  const sourceText = [name, amount+' USDT', changeText && '24h '+changeText, body, 'Binance Spot', timestamp, modeLabel].filter(Boolean).join(' · ');
  return {kind:analysis?'analysis':'data',label,modeLabel,title:name,body,visual,source:'Binance Spot',timestamp,href,
    action:L('看完整行情','Open chart'),askSource:{id:'spot:'+symbol+':'+quote.asOf,title:name,text:sourceText,href,kind:'excerpt'}};
}

// Subscribe only while a quote card is open. The 24h ticker shares the footer's REST feed;
// the single selected pair supplies the live price and the one-minute chart.
export function createCompanionMarket({onChange, now=Date.now, subscribe=subscribeCandles}){
  const ticker=createMarketHubClient({resources:['tickers'],refreshSeconds:30,WebSocketImpl:null,onChange,now});
  let symbol='', bars=[], streamQuote=null, stopCandles=null, timer=null;
  function stop(){
    symbol='';stopCandles?.();stopCandles=null;clearInterval(timer);timer=null;
    ticker.setActive(false);bars=[];streamQuote=null;
  }
  function select(next){
    if(next===symbol)return;
    stop();
    if(!Object.hasOwn(HUB_ASSET_IDS,next))return;
    symbol=next;ticker.setActive(true);
    stopCandles=subscribe(candleRequest({market:symbol+'/USDT',period:'1m'}),{
      onSnapshot(rows){if(symbol===next){bars=rows.slice(-30);onChange();}},
      onBar(bar){
        if(symbol!==next)return;
        bars=[...bars.filter(row=>row.time<bar.time).slice(-29),bar];
      },
      onStatus(status){
        if(symbol!==next)return;
        if(status.state==='live'&&bars.length&&Number.isFinite(status.asOf)&&status.asOf<=now()+30000){
          streamQuote={price:bars.at(-1).close,asOf:status.asOf};
        }
        onChange();
      }
    });
    timer=setInterval(()=>{ticker.tick();onChange();},1000);
  }
  return {select,stop,brief(analysis){
    const state=ticker.read('tickers');
    const q=state.snapshot?.data.find(row=>row.symbol===symbol);
    return marketCompanionBrief({symbol,ticker:q,streamQuote,bars,analysis,now:now(),failed:!!state.error||globalThis.navigator?.onLine===false});
  }};
}
