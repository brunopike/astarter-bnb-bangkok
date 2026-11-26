import {archiveCounter,followArchive} from './brain-raw-archive.mjs';
const url='/brain-evidence/tradfi/';
const groups={stock:['股票','Stocks'],metals:['贵金属','Precious metals'],fx:['外汇','FX'],oil:['原油','Crude oil'],commodities:['大宗商品','Commodities'],index:['指数','Indices'],etf:['ETF','ETFs'],rates:['国债收益率','Treasury yields']};
groups.commodity=groups.commodities;
const types={
  close:['收盘价','Closing price'],monthlyMean:['月均价','Monthly average'],reference:['参考汇率','Reference rate'],
  spot:['现货价','Spot price'],index:['指数值','Index value'],oracle:['链上报价','On-chain oracle'],
  yield:['国债收益率','Treasury yield'],dilutedEps:['季度摊薄每股收益','Quarterly diluted EPS'],
  reportedValuePerShare:['13F 期末申报估值／股','13F quarter-end reported value per share'],
  reportedInsiderTradePrice:['内部人披露成交价','Insider-reported trade price'],
  ohlc:['日线四价','Daily OHLC'],ohlcv:['日线与成交量','Daily OHLCV'],
  accountingPrice:['央行贵金属记账价','Central bank metals accounting price'],
  wholesaleCutout:['批发分割估值','Wholesale cutout estimate'],
  retailMedian:['地区燃油零售价中位数','Regional retail fuel price median'],
  dayAheadGas:['天然气日前出清价','Day-ahead gas clearing price'],
  bankBidAsk:['银行黄金买卖牌价','Bank gold bid and ask'],
  goldSpotTrade:['黄金现货成交行情','Gold spot trades'],
  settlementReference:['SEC 结算参考价','SEC settlement price reference'],
  wholesaleRange:['市场批发报价','Reported wholesale market prices'],
  wholesaleModal:['市场加权主流价','Weighted market modal price']
};
const explorer={ethereum:'https://etherscan.io',arbitrum:'https://arbiscan.io',avax:'https://build.avax.network/explorer/mainnet/c-chain'};
const countLabels={dailyBars:['交易日线','Daily bars'],wholesaleQuotes:['批发报价','Wholesale quotes'],
  oracleReads:['预言机读取','Oracle reads'],otherObservations:['其他观测','Other observations']};
const wholesale=s=>s.statistic==='wholesaleRange'||s.statistic==='wholesaleModal';
const digestPattern=/^[a-f0-9]{64}$/;
const pageSize=14;
const resultLimit=75;
const isoDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const barSeries=s=>s.statistic==='ohlc'||s.statistic==='ohlcv'||s.fields?.slice(1,5).join(',')==='close,open,high,low';

const taiwanCloses={2330:'tsmc',2317:'honhai',1590:'airtac',4958:'zhending'};
function linkedBarCount(s){
  const n=s.linkedDailyBars??0;
  if(!Number.isSafeInteger(n)||n<0||n>s.count||(n&&(s.statistic!=='close'||s.group!=='stock'||taiwanCloses[s.ticker]!==s.id)))
    throw Error('Invalid linked daily-bar count');
  return n;
}
export function marketGroupCoverage(entries){
  const result={};
  for(const s of entries){
    const key=s.group==='commodity'?'commodities':s.group;
    const g=result[key]??={count:0,dailyBars:0,start:s.start,end:s.end};
    g.count+=s.count;
    const linked=linkedBarCount(s);
    g.dailyBars+=barSeries(s)?s.count:linked;
    if(s.start<g.start)g.start=s.start;
    if(s.end>g.end)g.end=s.end;
  }
  return result;
}

export function validateSummary(data){
  if(data?.version!==1||!Number.isSafeInteger(data.series)||data.series<1||!Number.isSafeInteger(data.count)||
    data.count<1||!digestPattern.test(data.catalogSha256))throw Error('Invalid market summary');
  const summary={...data,wholesaleQuotes:data.wholesaleQuotes??0};
  if(!Object.keys(countLabels).every(key=>Number.isSafeInteger(summary[key])&&summary[key]>=0)||
    Object.keys(countLabels).reduce((total,key)=>total+summary[key],0)!==summary.count)throw Error('Unbalanced market summary');
  if(data.wholesaleRangeQuotes!==undefined||data.weightedMarketQuotes!==undefined){
    const {wholesaleRangeQuotes,weightedMarketQuotes}=data;
    if(![wholesaleRangeQuotes,weightedMarketQuotes].every(n=>Number.isSafeInteger(n)&&n>=0)||
      wholesaleRangeQuotes+weightedMarketQuotes!==summary.wholesaleQuotes)throw Error('Unbalanced wholesale quotes');
  }
  if(data.perGroup!==undefined){
    let total=0,bars=0;
    if(!data.perGroup||typeof data.perGroup!=='object'||Array.isArray(data.perGroup))throw Error('Invalid market group coverage');
    for(const [key,g] of Object.entries(data.perGroup)){
      if(key==='commodity'||!Object.hasOwn(groups,key)||!Number.isSafeInteger(g?.count)||g.count<=0||
        !Number.isSafeInteger(g.dailyBars)||g.dailyBars<0||g.dailyBars>g.count||!isoDate(g.start)||!isoDate(g.end)||g.start>g.end)
        throw Error('Invalid market group coverage');
      total+=g.count;bars+=g.dailyBars;
    }
    if(total!==data.count||bars!==data.dailyBars)throw Error('Unbalanced market group coverage');
  }
  return summary;
}
export function validateSeries(data){
  if(data?.version!==1||!Array.isArray(data.series)||!data.series.length)throw Error('Invalid catalog');
  const ids=new Set();
  for(const s of data.series){
    if(!/^[a-z][a-z0-9-]{0,48}$/.test(s.id)||ids.has(s.id)||!Object.hasOwn(groups,s.group)||!Object.hasOwn(types,s.statistic)
      ||!Number.isSafeInteger(s.count)||s.count<1||!/^https:\/\//.test(s.sourceUrl)||!digestPattern.test(s.sha256)
      ||!isoDate(s.start)||!isoDate(s.end)||s.start>s.end
      ||(s.statistic==='dilutedEps'&&!/^\d{10}$/.test(s.cik))
      ||(s.statistic==='oracle'&&(!Object.hasOwn(explorer,s.network)||!/^0x[0-9a-fA-F]{40}$/.test(s.contract))))throw Error('Invalid market');
    if(s.releaseOverrides!==undefined){
      if(s.statistic!=='settlementReference'||s.releaseOverrides===null||Array.isArray(s.releaseOverrides)||typeof s.releaseOverrides!=='object')throw Error('Invalid SEC release list');
      for(const period of Object.keys(s.releaseOverrides))settlementReleaseUrl(period,s.releaseOverrides);
    }
    ids.add(s.id);
  }
  return data.series;
}
export function settlementReleaseUrl(release,overrides={}){
  if(!/^\d{4}(0[1-9]|1[012])[ab]$/.test(release))throw Error('Invalid SEC release');
  if(Object.hasOwn(overrides,release)){
    const href=overrides[release];
    const file=new RegExp('^https://www\\.sec\\.gov/files/(?:[a-zA-Z0-9_-]+/)+cnsfails'+release+'(?:_0)?\\.zip$');
    if(typeof href!=='string'||!file.test(href))throw Error('Invalid SEC release link');
    return href;
  }
  const directory=release<='201706a'?'frequently-requested-foia-document-fails-deliver-data':'fails-deliver-data';
  return 'https://www.sec.gov/files/data/'+directory+'/cnsfails'+release+'.zip';
}
export function relatedSeries(entries,selected){
  function identifiers(s){
    const references=Array.isArray(s.related)?s.related:[s.related];
    return [...references,s.symbol,s.ticker,s.id].filter(v=>typeof v==='string'&&v).map(v=>
      v.toLowerCase().replace(/^oracle-/,'').replace(/-(eps|13f-value|insider-trade)$/,''));
  }
  const normalized=new Set(identifiers(selected));
  return entries.filter(s=>s.id!==selected.id&&s.group===selected.group&&identifiers(s).some(id=>normalized.has(id)));
}
export function matchingSeries(entries,query,group,limit=resultLimit){
  const words=(query||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches=[];
  for(const s of entries){
    if(group&&(s.group==='commodity'?'commodities':s.group)!==group)continue;
    const text=[s.id,s.symbol,s.ticker,s.en,s.zh,s.source,s.unit].filter(Boolean).join(' ').toLowerCase();
    if(words.every(word=>text.includes(word)))matches.push(s);
  }
  if(words.length){
    const rank=s=>[s.symbol,s.ticker,s.id,s.en,s.zh].some(v=>v?.toLowerCase()===words.join(' '))?0:1;
    matches.sort((a,b)=>rank(a)-rank(b));
  }
  return {matches:matches.slice(0,limit),count:matches.length};
}
async function checkedFile(name,sha,signal){
  const res=await fetch(url+name+'.json?v='+sha,{signal,cache:'no-cache'});
  if(!res.ok)throw Error('Market data unavailable');
  const bytes=await res.arrayBuffer();
  const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  if(checksum!==sha)throw Error('Market checksum');
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function validateShards(s,data){
  if(data.id!==s.id||!Array.isArray(data.shards)||!data.shards.length)throw Error('Market shard index');
  let count=0,prior='';
  for(const sh of data.shards){
    if(!/^\d{4}-(0[1-9]|1[012])$/.test(sh.month)||sh.month<=prior||!digestPattern.test(sh.sha256)||
      !isoDate(sh.start)||!isoDate(sh.end)||sh.start>sh.end||!sh.start.startsWith(sh.month+'-')||!sh.end.startsWith(sh.month+'-')||
      !Number.isSafeInteger(sh.count)||sh.count<1)throw Error('Bad market shard');
    count+=sh.count;prior=sh.month;
  }
  if(data.shards[0].start!==s.start||data.shards.at(-1).end!==s.end||count!==s.count)throw Error('Market shard coverage');
  return data.shards;
}
export function validateWholesale(s,shard,data){
  const aggregate=s.statistic==='wholesaleModal';
  if(data.id!==s.id||data.month!==shard.month||!Array.isArray(data.locations)||!Array.isArray(data.rows)||
    data.rows.length!==shard.count||!data.rows.length||!data.locations.every(v=>Array.isArray(v)&&v.length===(aggregate?3:5)&&v.every(x=>typeof x==='string')))throw Error('Wholesale month');
  const maxDay=new Date(Date.UTC(Number(shard.month.slice(0,4)),Number(shard.month.slice(5)),0)).getUTCDate();
  let first=32,last=0;
  for(const row of data.rows){
    if(!Array.isArray(row)||row.length!==(aggregate?3:5))throw Error('Wholesale row');
    const [day,loc,modal,low,high]=row;
    if(!Number.isInteger(day)||day<1||day>maxDay||!Number.isInteger(loc)||loc<0||loc>=data.locations.length||
      !Number.isFinite(modal)||modal<=0||(!aggregate&&(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||low>modal||modal>high)))throw Error('Wholesale value');
    first=Math.min(first,day);last=Math.max(last,day);
  }
  if(first!==Number(shard.start.slice(-2))||last!==Number(shard.end.slice(-2)))throw Error('Wholesale coverage');
  return data;
}
export function validateRows(s,data){
  if(data.id!==s.id||data.rows?.length!==s.count||data.rows[0][0]!==s.start||data.rows.at(-1)[0]!==s.end)throw Error('Market coverage');
  let prior='';
  for(const r of data.rows){
    if(!isoDate(r[0])||r[0]<=prior||!Number.isFinite(r[1])||
      (s.statistic==='dilutedEps'&&(!isoDate(r[2])||r[2]>r[0]||!/^\d{10}-\d{2}-\d{6}$/.test(r[3])))||
      (s.statistic==='reportedValuePerShare'&&(!isoDate(r[2])||r[2]>r[0]||!(r[3]>0)||![1,1000].includes(r[4])||
        !(r[5]>0)||!/^\d{10}-\d{2}-\d{6}$/.test(r[6])||!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i.test(r[7])))||
      (s.statistic==='reportedInsiderTradePrice'&&(!isoDate(r[2])||r[2]>r[0]||!['P','S'].includes(r[3])||
        !(r[4]>0)||!/^\d{10}-\d{2}-\d{6}$/.test(r[6])||!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i.test(r[7])))||
      (s.statistic==='oracle'&&(!Number.isSafeInteger(r[2])||!/^0x[a-f0-9]{64}$/.test(r[3])||!Number.isSafeInteger(r[4])||!/^\d+$/.test(r[5]))))throw Error('Market observation');
    if(s.statistic==='settlementReference'){
      const month=r[0].slice(0,7).replace('-','');
      if(r.length!==4||r[1]<=0||!Number.isSafeInteger(r[2])||r[2]<=0||![month+'a',month+'b'].includes(r[3]))
        throw Error('Invalid SEC settlement record');
    }
    if(s.statistic==='goldSpotTrade'){
      const [,last,high,low,vwap,volume,turnover,trades,reported]=r;
      if(r.length!==9||![last,high,low,vwap].every(n=>Number.isFinite(n)&&n>0)||
        low>last||last>high||vwap<low||vwap>high||![volume,turnover,trades,reported].every(n=>Number.isSafeInteger(n)&&n>0)||
        volume!==reported*(r[0]<'2025-10-01'?10:1))throw Error('Invalid gold spot trade');
    }
    if(s.statistic==='bankBidAsk'&&(r.length!==3||!Number.isFinite(r[2])||r[1]<=0||r[2]<r[1]))throw Error('Invalid bank bid and ask');
    if(s.statistic==='dayAheadGas'&&r.length!==2)throw Error('Invalid gas clearing price');
    if(s.statistic==='retailMedian'&&(r.length!==3||r[1]<=0||!Number.isSafeInteger(r[2])||r[2]<=0))throw Error('Invalid retail median');
    if(barSeries(s)){
      const [,close,open,high,low,volume]=r;
      if(![open,high,low].every(Number.isFinite)||low>Math.min(open,close)||high<Math.max(open,close)||
        (s.statistic==='ohlcv'&&(!Number.isSafeInteger(volume)||volume<0)))throw Error('Invalid trading bar');
      if(s.priceBasis==='nearestTradedFuturesMonth'&&(!/^\d{4}(0[1-9]|1[012])$/.test(r[6])||
        ![r[7],r[8]].every(n=>Number.isSafeInteger(n)&&n>=0)||r[7]+r[8]!==volume))throw Error('Futures session coverage');
    }
    prior=r[0];
  }
  return data.rows;
}
export function linkedTaiwanBars(stock,closeRows,proof){
  const closeByDate=new Map(closeRows.map(([day,value])=>[day,value]));
  const stored=proof.ohlcvByIssuer?.[stock]??{};
  const bars=new Map();
  for(const [day,values] of Object.entries(stored)){
    const [close,open,high,low,volume]=values;
    if(!isoDate(day)||values.length!==5||closeByDate.get(day)!==close||
      ![close,open,high,low].every(value=>Number.isFinite(value)&&value>0)||
      low>Math.min(open,close)||high<Math.max(open,close)||!Number.isSafeInteger(volume)||volume<1)
      throw Error('Invalid linked Taiwan daily bar');
    const sources=Object.entries(proof.days['twse-'+day]??{}).filter(([href,sum])=>
      /^https:\/\//.test(href)&&digestPattern.test(sum)&&(!href.includes('STOCK_FIRST')||['1590','4958'].includes(stock)));
    if(!sources.length)throw Error('Missing Taiwan bar source');
    bars.set(day,{values,source:sources[0][0]});
  }
  return bars;
}
export async function readSeries(s,signal){
  const data=await checkedFile(s.id,s.sha256,signal);
  return wholesale(s)?validateShards(s,data):validateRows(s,data);
}
export function mountTradfiArchive(root,en){
  const doc=root.ownerDocument,t=(zh,eng)=>en?eng:zh;
  const el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const option=(value,label)=>{const node=el('option',label);node.value=value;return node;};
  const link=(label,href)=>{const a=el('a',label);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;};
  const open=el('button');open.type='button';open.dataset.rawOpen='tradfi';open.setAttribute('aria-haspopup','dialog');
  const title=el('span',t('传统市场档案','TradFi Markets')),arrow=el('span','↗');arrow.setAttribute('aria-hidden','true');
  open.setAttribute('aria-controls','brain-tradfi-dialog');open.append(title,arrow);
  (root.querySelector('.ct-archive-counts')??root.querySelector('.ct-heading')).append(open);
  const dialog=el('dialog');dialog.id='brain-tradfi-dialog';dialog.dataset.rawDialog='';dialog.setAttribute('aria-labelledby','br-market-title');
  dialog.innerHTML=`<header class="br-raw-head"><h2 id="br-market-title">${t('传统市场历史','Traditional market history')}</h2><button type="button" data-close aria-label="${t('关闭','Close')}">×</button></header>
    <dl class="br-market-counts" data-counts hidden></dl>
    <p class="br-market-count-detail" data-wholesale-count hidden></p>
    <details class="br-market-coverage" data-category-coverage open hidden>
      <summary>${t('类别覆盖','Coverage by market')} <span data-active-category></span></summary>
      <p>${t('数字为各类别记录数。日期从该类首条观测到最新一条，各标的覆盖期不同。','Counts cover all records per category. Dates run from first to latest across its series. Individual instruments may cover shorter periods.')}</p>
      <div class="br-category-grid" data-coverage-options></div>
    </details>
    <p class="br-market-stock-coverage" data-stock-coverage hidden>${t('美股 WIKI 日线截至 2018-03-27。此后部分美股可查 SEC 上日收盘参考价或链上报价，日期以各标的序列为准。','U.S. WIKI daily bars end on 2018-03-27. Later SEC previous-close references and on-chain quotes cover selected U.S. stocks. Dates vary by instrument.')}</p>
    <div class="br-raw-filters br-market-search">
      <label>${t('搜索标的','Find an instrument')}<input data-search type="search" autocomplete="off" placeholder="${t('代码、名称或数据来源','Ticker, name or source')}"></label>
      <label>${t('市场类别','Market category')}<select data-group></select></label>
    </div>
    <div class="br-raw-filters br-market-choices">
      <label>${t('数据序列','Series')}<select data-instrument></select></label>
      <label data-year-wrap>${t('年份','Year')}<select data-year></select></label>
      <label data-month-wrap hidden>${t('报价月份','Quote month')}<select data-month></select></label>
    </div>
    <div class="br-market-match"><small data-match aria-live="polite"></small> <button type="button" data-more-series hidden>${t('显示更多序列','Show more series')}</button></div>
    <div class="br-raw-filters br-market-places" data-places hidden>
      <label>${t('查找市场','Find a market')}<input type="search" data-place-search autocomplete="off" placeholder="${t('邦、地区或市场','State, district or market')}"></label>
      <label>${t('报价市场','Reporting market')}<select data-market></select></label>
    </div>
    <div class="br-raw-provenance" data-provenance></div><div class="br-raw-status" role="status"><span data-status></span> <button type="button" data-retry hidden>${t('重试','Retry')}</button></div>
    <div class="br-raw-scroll"><table><thead><tr></tr></thead><tbody></tbody></table></div>
    <footer class="br-raw-pages" hidden><button type="button" data-prev aria-label="${t('上一页','Previous page')}">←</button><span data-page></span><button type="button" data-next aria-label="${t('下一页','Next page')}">→</button></footer>`;
  root.querySelector('.brain-board').append(dialog);
  const q=sel=>dialog.querySelector(sel),instrument=q('[data-instrument]'),year=q('[data-year]'),status=q('[data-status]'),
    info=q('[data-provenance]'),tbody=q('tbody'),paging=q('footer'),retry=q('[data-retry]'),search=q('[data-search]'),
    group=q('[data-group]'),month=q('[data-month]'),market=q('[data-market]'),placeSearch=q('[data-place-search]');
  const number=new Intl.NumberFormat(en?'en':'zh',{maximumFractionDigits:8});
  const cache=new Map(),lifetime=new AbortController();
  let series=[],rows=[],page=0,controller,revision=0,searchTimer,placeTimer,shards=[],monthData=null,markets=[],filteredQuotes=[];
  let summary,summaryRequest,catalogHash='',checkedAt=0,optionLimit=resultLimit;
  let twProofHash,linkedBars=new Map();
  const coverage=q('[data-category-coverage]'),coverageOptions=q('[data-coverage-options]');
  function showCoverage(values){
    if(!values)return;
    coverage.hidden=false;
    coverageOptions.replaceChildren(...Object.entries(groups).filter(([key])=>key!=='commodity'&&values[key]).map(([key,label])=>{
      const g=values[key],button=el('button');
      button.type='button';button.dataset.category=key;button.disabled=!series.length;
      button.setAttribute('aria-pressed',String(key===group.value));
      const head=el('span');head.className='br-category-head';head.append(el('strong',t(...label)),el('b',number.format(g.count)));
      const bars=el('span',t('日线 ','OHLC ')+number.format(g.dailyBars));
      const dates=el('span');dates.className='br-category-dates';
      const start=el('time',g.start),end=el('time',g.end);
      start.dateTime=g.start;end.dateTime=g.end;dates.append(start,el('span','→'),end);
      button.append(head,bars,dates);
      return button;
    }));
  }
  function syncCoverage(){
    q('[data-stock-coverage]').hidden=group.value!=='stock';
    q('[data-active-category]').textContent=group.value&&groups[group.value]?'· '+t(...groups[group.value]):'';
    for(const button of coverageOptions.children){
      button.disabled=!series.length;button.setAttribute('aria-pressed',String(group.value===button.dataset.category));
    }
  }
  const setCount=archiveCounter(open,number,lifetime.signal);
  function showCounts(s){
    setCount(s.count,t(' 条传统市场记录',' TradFi Markets'),'tradfi');
    open.title=t(number.format(s.count)+' 条历史观测，覆盖 '+number.format(s.series)+' 个序列',
      number.format(s.count)+' historical observations across '+number.format(s.series)+' series');
    open.setAttribute('aria-label',open.title+' · '+t('打开传统市场','Open TradFi markets'));
    const counts=q('[data-counts]');counts.hidden=false;
    counts.replaceChildren(...Object.entries(countLabels).map(([key,label])=>{
      const cell=el('div');cell.append(el('dt',t(...label)),el('dd',number.format(s[key])));return cell;
    }));
    showCoverage(s.perGroup);
    const detail=q('[data-wholesale-count]');
    detail.hidden=s.wholesaleRangeQuotes===undefined;
    if(!detail.hidden)detail.textContent=t('批发报价中，品种／等级报价 '+number.format(s.wholesaleRangeQuotes)+' 条 · 市场加权报价 '+number.format(s.weightedMarketQuotes)+' 条',
      'Wholesale breakdown · Variety / grade quotes '+number.format(s.wholesaleRangeQuotes)+' · Weighted market quotes '+number.format(s.weightedMarketQuotes));
  }
  function getSummary(force=false){
    if(!force&&summary&&Date.now()-checkedAt<60_000)return Promise.resolve(summary);
    if(!summaryRequest)summaryRequest=fetch(url+'summary.json',{signal:lifetime.signal,cache:'no-cache'}).then(async res=>{
      if(!res.ok)throw Error('Market summary unavailable');
      summary=validateSummary(await res.json());checkedAt=Date.now();showCounts(summary);return summary;
    }).finally(()=>{summaryRequest=null;});
    return summaryRequest;
  }
  followArchive(doc,lifetime.signal,()=>{void getSummary(true).catch(()=>{});});
  async function getCatalog(signal,force){
    const totals=await getSummary(force);
    if(catalogHash===totals.catalogSha256&&series.length)return;
    const catalog=await checkedFile('catalog',totals.catalogSha256,signal),entries=validateSeries(catalog);
    twProofHash=catalog.supportingFiles?.['tw-stock-sources.json'];
    if(twProofHash!==undefined&&!digestPattern.test(twProofHash))throw Error('Invalid Taiwan source index');
    if(entries.length!==totals.series||entries.reduce((n,s)=>n+s.count,0)!==totals.count)throw Error('Market summary coverage');
    const oldGroup=group.value;
    group.replaceChildren(option('',t('全部市场','All markets')),...Object.entries(groups)
      .filter(([key])=>key!=='commodity'&&entries.some(s=>(s.group==='commodity'?'commodities':s.group)===key))
      .map(([key,label])=>option(key,t(...label))));
    if([...group.options].some(opt=>opt.value===oldGroup))group.value=oldGroup;
    const observed=marketGroupCoverage(entries);
    if(totals.perGroup&&Object.entries(observed).some(([key,g])=>{
      const actual=totals.perGroup[key];return !actual||['count','dailyBars','start','end'].some(field=>g[field]!==actual[field]);
    }))throw Error('Market group coverage mismatch');
    series=entries;catalogHash=totals.catalogSha256;
    if(!totals.perGroup)showCoverage(observed);
    syncCoverage();
  }
  const chosen=()=>series.find(s=>s.id===instrument.value);
  function selectMatches(preferred){
    const {matches,count}=matchingSeries(series,search.value,group.value,optionLimit);
    instrument.replaceChildren(...matches.map(s=>option(s.id,(en?s.en:s.zh)+(s.network?' · '+s.source:'')+(s.sourceStatus==='discontinued'?t(' · 截至 ',' · through ')+s.end.slice(0,4):''))));
    q('[data-more-series]').hidden=matches.length>=count;
    instrument.disabled=!matches.length;
    if(matches.some(s=>s.id===preferred))instrument.value=preferred;
    q('[data-match]').textContent=count>matches.length?t('显示前 '+matches.length+' / '+number.format(count)+' 项，输入名称可继续缩小范围。',
      'Showing '+matches.length+' of '+number.format(count)+'. Type a name to narrow the list.'):count?t('匹配 '+count+' 项',count+' matching series'):'';
    return chosen();
  }
  const clear=()=>{rows=[];linkedBars=new Map();shards=[];monthData=null;filteredQuotes=[];tbody.replaceChildren();q('thead tr').replaceChildren();paging.hidden=true;
    year.replaceChildren();month.replaceChildren();market.replaceChildren();info.replaceChildren();q('[data-places]').hidden=true;
    q('[data-year-wrap]').hidden=false;q('[data-month-wrap]').hidden=true;};
  const remember=(key,value)=>{if(cache.size>=8&&!cache.has(key))cache.delete(cache.keys().next().value);cache.set(key,value);return value;};
  function pages(total){
    const count=Math.ceil(total/pageSize);page=Math.max(0,Math.min(page,count-1));paging.hidden=count===0;
    q('[data-page]').textContent=count?(page+1)+' / '+number.format(count):'';
    q('[data-prev]').disabled=page===0;q('[data-next]').disabled=page+1>=count;q('.br-raw-scroll').scrollTop=0;
  }
  function renderWholesale(){
    const s=chosen();if(!s||!monthData)return;
    const aggregate=s.statistic==='wholesaleModal';
    const heads=aggregate?[t('日期','Date'),t('市场','Market'),t('市场加权主流价','Weighted market modal')]:
      [t('日期','Date'),t('市场 · 品种 / 品级','Market · variety / grade'),t('主流价','Modal'),t('最低','Low'),t('最高','High')];
    q('thead tr').replaceChildren(...heads.map(v=>el('th',v)));
    pages(filteredQuotes.length);
    tbody.replaceChildren(...filteredQuotes.slice(page*pageSize,(page+1)*pageSize).map(([day,loc,modal,low,high])=>{
      const [state,district,name,variety,grade]=monthData.locations[loc],tr=el('tr'),place=el('td',name);
      place.className='br-market-location';place.append(el('small',[state,district].filter(Boolean).join(' · ')));
      if(!aggregate)place.append(el('small',[variety,grade].filter(Boolean).join(' / ')));
      tr.append(el('td',month.value+'-'+String(day).padStart(2,'0')),place,...(aggregate?[modal]:[modal,low,high]).map(v=>el('td',number.format(v))));return tr;
    }));
    status.textContent=month.value+' · '+number.format(filteredQuotes.length)+t(' 条报价',' quotes')+' · '+s.unit+' · '+t('归档截止 ','Archive through ')+s.end;
  }
  function filterPlaces(){
    if(!monthData)return;
    const words=placeSearch.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const selected=market.value,available=markets.filter(m=>words.every(w=>m.label.toLowerCase().includes(w)));
    market.replaceChildren(option('',t('全部匹配市场','All matching markets')),...available.slice(0,resultLimit).map(m=>option(m.key,m.label)));
    if(available.slice(0,resultLimit).some(m=>m.key===selected))market.value=selected;
    const allowed=new Set((market.value?available.filter(m=>m.key===market.value):available).flatMap(m=>m.locations));
    filteredQuotes=monthData.rows.filter(r=>allowed.has(r[1])).sort((a,b)=>b[0]-a[0]||a[1]-b[1]);
    page=0;renderWholesale();
  }
  function render(){
    const s=chosen();if(s&&wholesale(s)){renderWholesale();return;}if(!s||!rows.length)return;
    const yearRows=rows.filter(r=>r[0].startsWith(year.value)).toReversed(),pages=Math.ceil(yearRows.length/pageSize);
    page=Math.max(0,Math.min(page,pages-1));const oracle=s.statistic==='oracle',holding=s.statistic==='reportedValuePerShare',
      trade=s.statistic==='reportedInsiderTradePrice',filing=holding||trade||s.statistic==='dilutedEps';
    const exchangeReports=Array.isArray(s.sourcePeriods)&&Array.isArray(s.reports);
    const bars=barSeries(s),futures=s.priceBasis==='nearestTradedFuturesMonth',volume=s.statistic==='ohlcv';
    const barHeads=[t('日期','Date'),t('收盘','Close'),t('开盘','Open'),t('最高','High'),t('最低','Low'),...(volume?[t('成交量','Volume')]:[]),
      ...(futures?[t('合约月份','Expiry'),t('盘后量','After-hours vol.'),t('常规时段量','Regular vol.')]:[])];
    const retail=s.statistic==='retailMedian',bank=s.statistic==='bankBidAsk',gas=s.statistic==='dayAheadGas';
    const gold=s.statistic==='goldSpotTrade',settlement=s.statistic==='settlementReference';
    const titles=settlement?[t('结算日','Settlement date'),t('上日收盘参考价','Previous closing price')+' · '+s.unit,
      t('截至结算日未交付股数','Undelivered shares at settlement'),t('原表','Source file')]:gold?[t('日期','Date'),t('最后成交','Last trade'),t('最高','High'),t('最低','Low'),t('加权均价','VWAP'),
      t('成交量 · 台钱','Volume · mace'),t('成交额 · TWD','Turnover · TWD'),t('成交笔数','Trades')]:bank?[t('日期','Date'),t('银行买入','Bank bid')+' · '+s.unit,t('银行卖出','Bank ask')+' · '+s.unit]:
      gas?[t('交易日','Gas day'),t('日前出清价','Day-ahead clearing price')+' · '+s.unit]:
      retail?[t('日期','Date'),t('地区中位数','Regional median')+' · '+s.unit,t('报价站数','Reporting stations')]:bars?barHeads:[filing?t('披露日','Filed'):t('日期','Date'),s.unit,...(oracle?[t('读取区块','Read block')]:trade?[t('成交日','Traded')]:filing?[t('报告期末','Quarter ended')]:exchangeReports?[t('来源','Source')]:[])];
    q('thead tr').replaceChildren(...titles.map(v=>el('th',v)));
    tbody.replaceChildren(...yearRows.slice(page*pageSize,(page+1)*pageSize).map(r=>{
      const tr=el('tr'),dayCell=el('td',s.statistic==='monthlyMean'?r[0].slice(0,7):r[0]);
      if(gold){
        const day=r[0].replaceAll('-','');
        dayCell.replaceChildren(link(r[0]+' ↗','https://www.tpex.org.tw/storage/ch/gold/historical/daily/'+day.slice(0,4)+'/'+day.slice(0,6)+'/EMdes410.'+day+'-C.csv'));
      }
      const linked=linkedBars.get(r[0]);
      if(linked&&bars)dayCell.replaceChildren(link(r[0]+' ↗',linked.source));
      tr.append(dayCell,el('td',number.format(r[1])));
      if(settlement){
        const file=el('td');file.append(link(r[3]+' ↗',settlementReleaseUrl(r[3],s.releaseOverrides)));
        tr.append(el('td',number.format(r[2])),file);
      }
      if(gold){
        tr.append(...r.slice(2,5).map(v=>el('td',number.format(v))));
        const size=el('td',number.format(r[5])),raw=el('details');raw.className='br-oracle-round';
        raw.append(el('summary',t('原表成交量','Reported volume')),el('small',number.format(r[8])+(r[0]<'2025-10-01'?t(' 台两',' taels'):t(' 台钱',' mace'))));size.append(raw);
        tr.append(size,el('td',number.format(r[6])),el('td',number.format(r[7])));
      }
      if(retail||bank)tr.append(el('td',number.format(r[2])));
      if(bars){
        tr.append(...r.slice(2,5).map(v=>el('td',number.format(v))));
        if(volume)tr.append(el('td',number.format(r[5])));
        if(futures)tr.append(el('td',String(r[6]).slice(0,4)+'-'+String(r[6]).slice(4)),el('td',number.format(r[7])),el('td',number.format(r[8])));
      }
      if(oracle){
        const td=el('td'),a=link('#'+r[2],explorer[s.network]+'/block/'+r[3]);td.append(a);
        const at=new Date(r[4]*1000).toISOString().replace('T',' ').slice(0,19);
        const details=el('details');details.className='br-oracle-round';details.append(el('summary',t('报价详情','Round details')),
          el('small',at+' UTC'),el('small',t('轮次 ','Round ')+r[5]));td.append(details);tr.append(td);
      }
      if(holding){
        const td=el('td');td.append(link(r[2]+' ↗',r[7]));
        const details=el('details');details.className='br-oracle-round';
        details.append(el('summary',t('申报明细','Filing details')),el('small',number.format(r[3]*r[4])+' USD'),el('small',number.format(r[5])+t(' 股',' shares')));
        td.append(details);tr.append(td);
      }else if(trade){
        const td=el('td');td.append(link(r[2]+' ↗',r[7]));
        const details=el('details');details.className='br-oracle-round';
        details.append(el('summary',r[5]==='reportedWeightedAverage'?t('加权均价','Weighted average'):t('申报价格','Reported price')),
          el('small',(r[3]==='P'?t('买入','Purchase'):t('卖出','Sale'))+' · '+number.format(r[4])+t(' 股',' shares')));
        td.append(details);tr.append(td);
      }else if(filing){
        const href='https://www.sec.gov/Archives/edgar/data/'+Number(s.cik)+'/'+r[3].replaceAll('-','')+'/'+r[3]+'-index.htm';
        const td=el('td');td.append(link(r[2]+' ↗',href));tr.append(td);
      }else if(exchangeReports){
        const period=s.sourcePeriods.find(([a,b])=>a<=r[0]&&r[0]<=b);
        const report=s.reports.find(o=>o.id===period?.[2]);
        const href=s.archivedSourceUrls?.[r[0]]??report?.downloadUrl?.replace('{YYYYMMDD}',r[0].replaceAll('-',''));
        const td=el('td');if(/^https:\/\//.test(href))td.append(link(t('报表 ↗','Report ↗'),href));
        if(linked){
          const [,o,h,l,v]=linked.values,details=el('details');details.className='br-oracle-round';
          details.append(el('summary',t('当日成交','Trading details')),el('small',t('开盘 ','Open ')+number.format(o)),
            el('small',t('最高 ','High ')+number.format(h)),el('small',t('最低 ','Low ')+number.format(l)),
            el('small',t('成交量 ','Volume ')+number.format(v)+t(' 股',' shares')),link(t('成交来源 ↗','Price source ↗'),linked.source));
          td.append(details);
        }
        tr.append(td);
      }
      return tr;
    }));
    status.textContent=rows[0][0]+' — '+rows.at(-1)[0]+' · '+number.format(rows.length)+t(' 条记录',' observations')+
      (bars&&linkedBars.size?t(' · 含 '+linkedBars.size+' 个已计入收盘档案的交易日。',' · Includes '+linkedBars.size+' trading days counted in the closing-price archive.'):'')+
      (bars?' · '+s.unit:'')+
      (s.sourceStatus==='discontinued'?t(' · 历史档案，来源已停止更新。',' · Historical archive. This source is discontinued.'):'')+
      (futures?t(' · 未复权近月期货，成交量单位为手。',' · Unadjusted front-month contract. Volume in contracts.'):'')+
      (s.statistic==='accountingPrice'?t(' · 每次央行定价取首个生效日，早期仅保留记账价变动。',' · First effective date per calculation. Earlier data retain observed price changes.'):'')+
      (settlement?t(' · 价格取自 SEC 文件中的上一交易日收盘价。股数是该证券在 CNS 系统截至结算日的未交付净余额。',
        ' · The SEC file supplies the previous trading day’s closing price. Shares represent the outstanding net CNS fail balance on the settlement date.'):'')+
      (gold?t(' · 实际成交价格，以新台币／台钱（3.75 克）计。2025‑10‑01 前原表成交量为台两，已按 1 台两＝10 台钱统一换算。',
        ' · Actual trades, priced in TWD per mace (3.75 g). Before 1 Oct 2025 the reported volume was in taels, converted at 10 mace per tael.'):'')+
      (bank?t(' · 台湾银行黄金存折在当日营业时间内的最后一组牌价，单位为新台币／克。',' · Bank of Taiwan Gold Passbook’s last bid and ask during business hours, in TWD per gram.'):'')+
      (gas?t(' · AEMO 按交易中心及天然气交易日公布的日前出清价。',' · AEMO day-ahead clearing price for the selected gas hub and gas day.'):'')+
      (retail?t(' · 各站每天取最后一次上报价格，再计算地区中位数；站数为当日实际报价站点。',' · Regional median of each station’s last reported price that day. Station counts include only reporting sites.'):'')+
      (s.statistic==='wholesaleCutout'?t(' · 美国农业部午后批发分割估值，每百磅美元。',' · USDA afternoon cutout estimate, dollars per hundredweight.'):'')+
      (oracle?t(' · 历史按月末抽样，近期按日读取；时间为预言机报价时间。',' · Month-end samples, then daily reads. Quote times come from the oracle.'):'')+
      (s.coverageMode==='sampled-trading-days'?t(' · 已核验 '+s.checkedTradingDays+' / '+s.calendarTradingDays+' 个交易日，其余日期陆续补录。',' · '+s.checkedTradingDays+' / '+s.calendarTradingDays+' trading days checked. Historical backfill is ongoing.'):'')+
      (holding?t(' · 伯克希尔 13F 季末持仓市值除以申报股数，按披露日排列。',' · Berkshire’s quarter-end position value divided by reported shares, ordered by filing date.'):'')+
      (trade?t(' · 每月选一笔 Form 4 披露的实际成交，按披露日排列。原表可查成交价或加权均价。',' · One Form 4 trade per covered filing month. The original filing gives the reported price or weighted average.'):'');
    paging.hidden=false;q('[data-page]').textContent=(page+1)+' / '+pages;
    q('[data-prev]').disabled=page===0;q('[data-next]').disabled=page+1>=pages;q('.br-raw-scroll').scrollTop=0;
  }
  function describe(s){
    const sourceLabel=s.licenseUrl===s.sourceUrl&&s.license?s.source+' · '+s.license:s.source;
    const parts=[el('span',t(...types[s.statistic])+(s.network?' · '+({ethereum:'Ethereum',arbitrum:'Arbitrum One',avax:'Avalanche C-Chain'}[s.network]):'')),link(sourceLabel+' ↗',s.sourceUrl)];
    if(s.id==='oracle-nvda')parts.push(link(t('英伟达历史收盘价 ↗','NVIDIA historical closes ↗'),'https://investor.nvidia.com/stock-info/historical-price-lookup/default.aspx'));
    for(const other of relatedSeries(series,s)){
      const label=other.network?t('查看链上报价','View oracle rounds'):t(...types[other.statistic]);
      const b=el('button',label);b.type='button';b.onclick=()=>{search.value=other.id;group.value='';load(false,other.id);};parts.push(b);
    }
    const details=el('details');details.className='br-market-attribution';
    details.append(el('summary',t('数据来源与授权','Sources and license')));
    const seen=new Set([s.sourceUrl]);
    const addLink=(label,href)=>{
      if(!/^https:\/\//.test(href)||seen.has(href))return;
      seen.add(href);details.append(link(label+' ↗',href));
    };
    if(s.attribution)details.append(el('span',s.attribution));
    if(s.licenseUrl==='https://data.gov.tw/license'){
      const reportNames={daily:['每日个股收盘','Daily share closes'],rank:['成交量前二十名','Top 20 by volume'],foreign:['第一上市外资股收盘行情','Foreign issuers’ closing prices'],valuation:['个股收盘价与估值','Share closes and valuations']};
      for(const report of s.reports??[]){
        if(Object.hasOwn(reportNames,report.id)&&/^https:\/\/data\.gov\.tw\/dataset\/\d+$/.test(report.datasetUrl))addLink(t(...reportNames[report.id]),report.datasetUrl);
      }
      if(s.earlyCoverage?.method==='top20-volume')details.append(el('span',t('2017 年 4 月 13 日前仅收录进入成交量前二十名的交易日。','Before 13 April 2017, closes cover days in the top 20 by volume.')));
    }
    addLink(t('数据集','Source dataset'),s.datasetUrl);
    addLink(t('原始观测','Raw observations'),s.observationUrl);
    if(s.archiveUrl){
      const credit=s.archiveAttribution||(/^https:\/\/www\.kaggle\.com\/datasets\/khandelwalmanas\//.test(s.archiveUrl)?'Manas Khandelwal':'');
      addLink(t('历史归档','Historical archive')+(credit?' · '+credit:''),s.archiveUrl);
    }
    const recent=s.recentSource;
    if(recent){
      addLink(t('近期数据 · 发布方','Recent data · Publisher'),recent.sourceUrl);
      if(recent.snapshotUrl)addLink(t('近期快照','Recent snapshot')+(recent.mirror?' · '+recent.mirror:''),recent.snapshotUrl);
      else addLink(t('近期镜像','Recent mirror'),recent.mirrorUrl);
    }
    addLink(t('许可 · ','License · ')+(s.license||t('使用条款','Terms of use')),s.licenseUrl);
    for(const supplement of s.supplementalSources??[]){
      const attribution=el('span',supplement.attribution||supplement.mirror);
      details.append(attribution);
      addLink(supplement.mirror||t('补充数据提供方','Supplemental source'),supplement.mirrorUrl);
      addLink(t('原始数据集','Original dataset'),supplement.sourceUrl);
      addLink(t('归档快照','Archived snapshot')+' · '+supplement.mirror,supplement.snapshotUrl);
      addLink(t('补充数据许可 · ','Supplemental license · ')+supplement.license,supplement.licenseUrl);
      addLink(t('原始数据许可 · ','Original data license · ')+supplement.underlyingLicense,supplement.underlyingLicenseUrl);
      if(supplement.changes)details.append(el('small',t('处理说明 · ','Changes · ')+supplement.changes));
    }
    if(details.children.length>1)parts.push(details);
    info.replaceChildren(...parts);
  }
  async function getMonth(s,signal,id){
    const shard=shards.find(x=>x.month===month.value);if(!shard)throw Error('Market month unavailable');
    monthData=null;markets=[];filteredQuotes=[];tbody.replaceChildren();paging.hidden=true;retry.hidden=true;
    q('[data-places]').hidden=true;status.textContent=t('正在读取当月报价…','Loading monthly quotes…');
    const data=cache.get(shard.sha256)??validateWholesale(s,shard,await checkedFile(s.id+'-'+shard.month,shard.sha256,signal));
    if(id!==revision||signal.aborted)return;
    monthData=remember(shard.sha256,data);
    const places=new Map();
    for(let i=0;i<data.locations.length;i++){
      const names=data.locations[i].slice(0,3),key=JSON.stringify(names);
      if(!places.has(key))places.set(key,{key,label:[names[2],names[1],names[0]].filter(Boolean).join(' · '),locations:[]});
      places.get(key).locations.push(i);
    }
    markets=[...places.values()].sort((a,b)=>a.label.localeCompare(b.label));
    placeSearch.value='';market.replaceChildren();q('[data-places]').hidden=false;filterPlaces();
  }
  function failure(signal){
    if(!signal.aborted){status.textContent=t('未能读取或校验行情。','Could not load or verify this series.');retry.hidden=false;}
  }
  async function load(force=false,preferred=instrument.value){
    clearTimeout(searchTimer);clearTimeout(placeTimer);
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++revision;
    const priorMonth=chosen()?.id===preferred?month.value:'';
    clear();retry.hidden=true;status.textContent=t('正在读取历史数据…','Loading history…');
    try{
      await getCatalog(signal,force===true);if(id!==revision||signal.aborted)return;
      syncCoverage();
      const s=selectMatches(preferred);
      if(!s){status.textContent=t('没有匹配的数据序列。','No matching series.');return;}
      describe(s);
      const data=cache.get(s.sha256)??await readSeries(s,signal);if(id!==revision||signal.aborted)return;
      remember(s.sha256,data);
      if(wholesale(s)){
        shards=data;q('[data-year-wrap]').hidden=true;q('[data-month-wrap]').hidden=false;
        month.replaceChildren(...[...shards].reverse().map(sh=>option(sh.month,sh.month)));
        if(shards.some(sh=>sh.month===priorMonth))month.value=priorMonth;
        await getMonth(s,signal,id);
      }else{
        rows=data;
        const closeSeries=s.statistic==='close'&&s.ticker?s:
          s.exchange==='TWSE'&&s.related?.length===1?series.find(other=>other.id===s.related[0]&&other.statistic==='close'):null;
        if(twProofHash&&closeSeries&&taiwanCloses[closeSeries.ticker]===closeSeries.id){
          const proof=cache.get(twProofHash)??await checkedFile('tw-stock-sources',twProofHash,signal);
          if(id!==revision||signal.aborted)return;
          remember(twProofHash,proof);
          if((closeSeries.linkedDailyBars??0)!==Object.keys(proof.ohlcvByIssuer?.[closeSeries.ticker]??{}).length)
            throw Error('Taiwan bar index differs from receipt');
          if(proof.ohlcvByIssuer?.[closeSeries.ticker]){
            const closes=closeSeries===s?data:cache.get(closeSeries.sha256)??await readSeries(closeSeries,signal);
            if(id!==revision||signal.aborted)return;
            remember(closeSeries.sha256,closes);
            linkedBars=linkedTaiwanBars(closeSeries.ticker,closes,proof);
            if(closeSeries!==s){
              if(rows.some(r=>linkedBars.has(r[0])))throw Error('Duplicate Taiwan daily bar');
              rows=[...rows,...Array.from(linkedBars,([day,v])=>[day,...v.values])].sort((a,b)=>a[0].localeCompare(b[0]));
            }
          }
        }
        const years=[...new Set(rows.map(r=>r[0].slice(0,4)))].reverse();
        year.replaceChildren(...years.map(y=>option(y,y)));page=0;render();
      }
    }catch{failure(signal);}
  }
  async function changeMonth(){
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++revision;
    try{await getMonth(chosen(),signal,id);}catch{failure(signal);}
  }
  const refreshFilters=()=>{optionLimit=resultLimit;clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(false,instrument.value),150);};
  open.onclick=()=>{dialog.showModal();load();};
  coverageOptions.onclick=event=>{
    const choice=event.target.closest('[data-category]');if(!choice||choice.disabled)return;
    group.value=group.value===choice.dataset.category?'':choice.dataset.category;
    search.value='';optionLimit=resultLimit;syncCoverage();
    if(group.value&&doc.defaultView.matchMedia('(max-width:660px)').matches){
      coverage.open=false;coverage.querySelector('summary').focus({preventScroll:true});
    }
    load();
  };
  search.oninput=refreshFilters;group.onchange=()=>{optionLimit=resultLimit;load();};
  q('[data-more-series]').onclick=()=>{optionLimit+=resultLimit;selectMatches(instrument.value);};
  instrument.onchange=()=>load();year.onchange=()=>{page=0;render();};month.onchange=changeMonth;
  placeSearch.oninput=()=>{clearTimeout(placeTimer);placeTimer=setTimeout(filterPlaces,120);};market.onchange=filterPlaces;
  retry.onclick=()=>load(true);q('[data-prev]').onclick=()=>{page--;render();};q('[data-next]').onclick=()=>{page++;render();};
  q('[data-close]').onclick=()=>dialog.close();
  dialog.onkeydown=event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();dialog.close();}};
  dialog.onclose=()=>{clearTimeout(searchTimer);clearTimeout(placeTimer);revision++;controller?.abort();open.focus({preventScroll:true});};
  return ()=>{clearTimeout(searchTimer);clearTimeout(placeTimer);revision++;controller?.abort();lifetime.abort();dialog.remove();open.remove();};
}
