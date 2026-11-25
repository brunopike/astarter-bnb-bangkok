import {pair as L,getLocale} from './locale.mjs';

const scriptURL='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
const widgetOrigin='https://www.tradingview-widget.com';
const intervals={'1m':'1','5m':'5','15m':'15','1H':'60','4H':'240','1D':'D'};
const locales={zh:'zh_CN',en:'en',ja:'ja',ko:'kr',vi:'vi_VN',es:'es',fr:'fr',ru:'ru'};
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function hostedChartSymbol(config={}){
 if(config.hostedMarket!==true||config.profileId!=='cex-spot'||config.venueId!=='binance'||!/^([A-Z0-9]{2,18})\/USDT$/.test(config.market||''))return null;
 if(['trade','paper','recorded','snapshotError','identity','planRef','gridPreview','gridPlan','analysisLayers','analysisTask'].some(key=>config[key]))return null;
 return 'BINANCE:'+config.market.replace('/','');
}
export function hostedChartOptions(config,{theme='dark',locale='en'}={}){
 const symbol=hostedChartSymbol(config);if(!symbol)throw Error('HOSTED_CHART_REQUIRES_PUBLIC_MARKET');
 return {autosize:true,symbol,interval:intervals[config.period]||'60',timezone:'Asia/Shanghai',theme,style:'1',locale:locales[locale]||'en',withdateranges:true,hide_side_toolbar:false,hide_top_toolbar:false,hide_legend:false,hide_volume:false,allow_symbol_change:false,save_image:true,show_popup_button:true,popup_width:'1400',popup_height:'900',backgroundColor:theme==='dark'?'#10141c':'#ffffff',gridColor:theme==='dark'?'rgba(130,158,200,0.08)':'rgba(80,94,124,0.08)',studies:[],support_host:'https://www.tradingview.com'};
}
export function hostedChartPanel(key,config){
 const symbol=hostedChartSymbol(config);if(!symbol)throw Error('HOSTED_CHART_REQUIRES_PUBLIC_MARKET');
 const url='https://www.tradingview.com/chart/?symbol='+encodeURIComponent(symbol);
 return `<section class="trading-chart trading-chart-hosted" data-trading-chart="${esc(key)}" data-localized-ui aria-label="${esc(config.market)} TradingView ${L('当前行情','Current market')}"><header class="trading-chart-head"><span class="trading-chart-identity"><strong>${esc(config.market)}</strong><span>Binance · ${L('现货 · 当前行情','Spot · current market')}</span></span><span class="trading-chart-hosted-label">TradingView</span></header><div class="trading-chart-hosted-message" role="status"></div><div class="trading-chart-hosted-stage"><div class="tradingview-widget-container"></div></div><div class="trading-chart-hosted-fallback"></div><footer class="trading-chart-footer"><button type="button" data-tv-switch hidden disabled>${L('基础行情','Basic chart')}</button><button type="button" data-tv-retry hidden disabled>${L('重试','Retry')}</button><a class="trading-chart-hosted-link" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${L('在 TradingView 打开图表','Open chart in TradingView')}">TradingView ↗</a></footer></section>`;
}
export function mountHostedChart(host,config,{fallback=()=>()=>{}}={}){
 const slot=host.querySelector('.tradingview-widget-container'),message=host.querySelector('.trading-chart-hosted-message'),stage=host.querySelector('.trading-chart-hosted-stage'),basic=host.querySelector('.trading-chart-hosted-fallback'),switchButton=host.querySelector('[data-tv-switch]'),retryButton=host.querySelector('[data-tv-retry]');
 const events=new AbortController();let stopped=false,request=null,timer=0,attempt=0,stopFallback=null,showingBasic=false,frameEmbedded=false;
 const state=(name,text)=>{host.dataset.chartState=name;message.textContent=text;message.hidden=!text;retryButton.hidden=name!=='error';retryButton.disabled=name!=='error';};
 const updateSwitch=()=>{switchButton.textContent=showingBasic?L('显示 TradingView','Show TradingView'):L('基础行情','Basic chart');switchButton.hidden=!frameEmbedded;switchButton.disabled=showingBasic&&!frameEmbedded;};
 const showBasic=value=>{if(value&&!stopFallback)stopFallback=fallback();showingBasic=value;host.dataset.chartView=value?'basic':'widget';basic.hidden=!value;basic.inert=!value;stage.inert=value;stage.setAttribute('aria-hidden',String(value));updateSwitch();};
 const unavailable=()=>{state('error',L('TradingView 暂不可用，当前显示基础行情。','TradingView unavailable. Showing the basic chart.'));showBasic(true);};
 const clear=()=>{request?.abort();clearTimeout(timer);slot.replaceChildren();frameEmbedded=false;updateSwitch();};
 async function render(){
  showBasic(true);clear();const current=++attempt;request=new AbortController();let expired=false;
  const failed=()=>{if(stopped||current!==attempt||expired)return;expired=true;clearTimeout(timer);slot.replaceChildren();frameEmbedded=false;unavailable();request?.abort();};
  host.dataset.engine='tradingview-widget';state('loading',L('正在连接 TradingView…','Connecting to TradingView…'));
  timer=setTimeout(failed,3000);
  try{
   // A failed cross-origin iframe still fires load; check transport before showing an otherwise blank frame.
   await fetch(widgetOrigin+'/embed-widget/advanced-chart/',{method:'HEAD',mode:'no-cors',credentials:'omit',cache:'no-store',signal:request.signal});
   if(stopped||current!==attempt||expired)return;
   const theme=document.documentElement.dataset.theme==='light'?'light':'dark';
   // Isolate the official loader so removing a timed-out attempt also cancels its script execution.
   const frame=document.createElement('iframe');frame.title=config.market+' · TradingView';frame.setAttribute('allow','fullscreen');frame.style.cssText='width:100%;height:100%;border:0;display:block';
   const options=JSON.stringify(hostedChartOptions(config,{theme,locale:getLocale()})).replace(/</g,'\\u003c');
   frame.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${theme==='dark'?'#10141c':'#ffffff'}}.tradingview-widget-container{height:100%;width:100%}.tradingview-widget-container__widget{height:calc(100% - 32px);width:100%}.tradingview-widget-copyright{height:32px;text-align:center;line-height:32px;font:12px/32px Arial,sans-serif}.tradingview-widget-copyright a{color:${theme==='dark'?'#a4acb9':'#596375'};text-decoration:none}</style></head><body><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><div class="tradingview-widget-copyright"><a href="https://www.tradingview.com/symbols/${config.market.replace('/','')}/?exchange=BINANCE" target="_blank" rel="noopener nofollow">${config.market} chart by TradingView</a></div><script src="${scriptURL}" async>${options}</script></div></body></html>`;
   frame.addEventListener('load',()=>{if(stopped||current!==attempt||expired)return;if(!frame.contentDocument?.querySelector('iframe'))return failed();clearTimeout(timer);frameEmbedded=true;updateSwitch();state('embedded','');},{once:true,signal:events.signal});
   frame.addEventListener('error',failed,{once:true,signal:events.signal});slot.append(frame);
  }catch{
   failed();
  }
 }
 switchButton.addEventListener('click',()=>showBasic(!showingBasic),{signal:events.signal});
 retryButton.addEventListener('click',()=>{if(stopped||host.dataset.chartState!=='error')return;if(document.activeElement===retryButton)basic.querySelector('.trading-chart-canvas')?.focus({preventScroll:true});return render();},{signal:events.signal});
 // shortcut: hosted widgets cannot preserve custom layouts on remount; migrate to Advanced Charts when the licensed library arrives.
 const themeObserver=new MutationObserver(render);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});showBasic(true);render();
 return ()=>{stopped=true;attempt++;clear();stopFallback?.();stopFallback=null;events.abort();themeObserver.disconnect();};
}
