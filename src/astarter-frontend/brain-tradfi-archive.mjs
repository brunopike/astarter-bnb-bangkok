const url='/brain-evidence/tradfi/';
const groups={stock:['股票','Stocks'],metals:['贵金属','Precious metals'],fx:['外汇','FX'],oil:['原油','Crude oil'],commodities:['大宗商品','Commodities'],index:['指数','Indices'],etf:['ETF','ETFs'],rates:['国债收益率','Treasury yields']};
const types={close:['收盘价','Closing price'],monthlyMean:['月均价','Monthly average'],reference:['参考汇率','Reference rate'],spot:['现货价','Spot price'],index:['指数值','Index value'],oracle:['链上报价','On-chain oracle'],yield:['国债收益率','Treasury yield'],dilutedEps:['季度摊薄每股收益','Quarterly diluted EPS']};
const explorer={ethereum:'https://etherscan.io',arbitrum:'https://arbiscan.io',avax:'https://build.avax.network/explorer/mainnet/c-chain'};
types.reportedValuePerShare=['13F 期末申报估值／股','13F quarter-end reported value per share'];
types.reportedInsiderTradePrice=['内部人披露成交价','Insider-reported trade price'];
const pageSize=14;
export function validateSeries(data){
  if(data?.version!==1||!Array.isArray(data.series)||!data.series.length)throw Error('Invalid catalog');
  const ids=new Set();
  for(const s of data.series){
    if(!/^[a-z][a-z0-9-]{0,48}$/.test(s.id)||ids.has(s.id)||!Object.hasOwn(groups,s.group)||!Object.hasOwn(types,s.statistic)
      ||!Number.isSafeInteger(s.count)||s.count<1||!/^https:\/\//.test(s.sourceUrl)||!/^[0-9a-f]{64}$/.test(s.sha256)
      ||(s.statistic==='dilutedEps'&&!/^\d{10}$/.test(s.cik))
      ||(s.statistic==='oracle'&&(!Object.hasOwn(explorer,s.network)||!/^0x[0-9a-fA-F]{40}$/.test(s.contract))))throw Error('Invalid market');
    ids.add(s.id);
  }
  return data.series;
}
export async function readSeries(s,signal){
  const res=await fetch(url+s.id+'.json?v='+s.sha256,{signal,cache:'no-cache'});
  if(!res.ok)throw Error('Market unavailable');
  const bytes=await res.arrayBuffer();
  const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  if(checksum!==s.sha256)throw Error('Market checksum');
  const data=JSON.parse(new TextDecoder().decode(bytes));
  if(data.id!==s.id||data.rows?.length!==s.count||data.rows[0][0]!==s.start||data.rows.at(-1)[0]!==s.end)throw Error('Market coverage');
  let prior='';
  for(const r of data.rows){
    if(!/^\d{4}-\d\d-\d\d$/.test(r[0])||r[0]<=prior||!Number.isFinite(r[1])||
      (s.statistic==='dilutedEps'&&(!/^\d{4}-\d\d-\d\d$/.test(r[2])||r[2]>r[0]||!/^\d{10}-\d{2}-\d{6}$/.test(r[3])))||
      (s.statistic==='reportedValuePerShare'&&(!/^\d{4}-\d\d-\d\d$/.test(r[2])||r[2]>r[0]||!(r[3]>0)||![1,1000].includes(r[4])||
        !(r[5]>0)||!/^\d{10}-\d{2}-\d{6}$/.test(r[6])||!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i.test(r[7])))||
      (s.statistic==='reportedInsiderTradePrice'&&(!/^\d{4}-\d\d-\d\d$/.test(r[2])||r[2]>r[0]||!['P','S'].includes(r[3])||
        !(r[4]>0)||!/^\d{10}-\d{2}-\d{6}$/.test(r[6])||!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i.test(r[7])))||
      (s.statistic==='oracle'&&(!Number.isSafeInteger(r[2])||!/^0x[0-9a-f]{64}$/.test(r[3])||!Number.isSafeInteger(r[4])||!/^\d+$/.test(r[5]))))throw Error('Market observation');
    prior=r[0];
  }
  return data.rows;
}
export function mountTradfiArchive(root,en){
  const doc=root.ownerDocument,t=(zh,eng)=>en?eng:zh;
  const el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const link=(label,href)=>{const a=el('a',label);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;};
  const open=el('button');open.type='button';open.dataset.rawOpen='tradfi';open.setAttribute('aria-haspopup','dialog');
  open.setAttribute('aria-controls','brain-tradfi-dialog');open.append(el('span',t('传统市场','Traditional markets')),el('span','↗'));
  root.querySelector('.ct-heading').append(open);
  const dialog=el('dialog');dialog.id='brain-tradfi-dialog';dialog.dataset.rawDialog='';dialog.setAttribute('aria-labelledby','br-market-title');
  dialog.innerHTML=`<header class="br-raw-head"><h2 id="br-market-title">${t('传统市场历史','Traditional market history')}</h2><button type="button" data-close aria-label="${t('关闭','Close')}">×</button></header>
    <div class="br-raw-filters"><label>${t('市场与标的','Market and instrument')}<select data-instrument></select></label><label>${t('年份','Year')}<select data-year></select></label></div>
    <div class="br-raw-provenance" data-provenance></div><div class="br-raw-status" role="status"><span data-status></span> <button type="button" data-retry hidden>${t('重试','Retry')}</button></div>
    <div class="br-raw-scroll"><table><thead><tr></tr></thead><tbody></tbody></table></div>
    <footer class="br-raw-pages"><button type="button" data-prev aria-label="${t('上一页','Previous page')}">←</button><span data-page></span><button type="button" data-next aria-label="${t('下一页','Next page')}">→</button></footer>`;
  root.querySelector('.brain-board').append(dialog);
  const q=sel=>dialog.querySelector(sel),instrument=q('[data-instrument]'),year=q('[data-year]'),status=q('[data-status]'),
    info=q('[data-provenance]'),tbody=q('tbody'),paging=q('footer'),retry=q('[data-retry]');
  const number=new Intl.NumberFormat(en?'en':'zh',{maximumFractionDigits:8}),cache=new Map();
  let series=[],rows=[],page=0,controller,revision=0;
  const chosen=()=>series.find(s=>s.id===instrument.value);
  const clear=()=>{rows=[];tbody.replaceChildren();q('thead tr').replaceChildren();paging.hidden=true;year.replaceChildren();info.replaceChildren();};
  function render(){
    const s=chosen();if(!s||!rows.length)return;
    const yearRows=rows.filter(r=>r[0].startsWith(year.value)).toReversed(),pages=Math.ceil(yearRows.length/pageSize);
    page=Math.max(0,Math.min(page,pages-1));const oracle=s.statistic==='oracle',holding=s.statistic==='reportedValuePerShare',
      trade=s.statistic==='reportedInsiderTradePrice',filing=holding||trade||s.statistic==='dilutedEps';
    const exchangeReports=Array.isArray(s.sourcePeriods)&&Array.isArray(s.reports);
    q('thead tr').replaceChildren(...[filing?t('披露日','Filed'):t('日期','Date'),s.unit,...(oracle?[t('读取区块','Read block')]:trade?[t('成交日','Traded')]:filing?[t('报告期末','Quarter ended')]:exchangeReports?[t('来源','Source')]:[])].map(v=>el('th',v)));
    tbody.replaceChildren(...yearRows.slice(page*pageSize,(page+1)*pageSize).map(r=>{
      const tr=el('tr');tr.append(el('td',s.statistic==='monthlyMean'?r[0].slice(0,7):r[0]),el('td',number.format(r[1])));
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
        const td=el('td');if(/^https:\/\//.test(href))td.append(link(t('报表 ↗','Report ↗'),href));tr.append(td);
      }
      return tr;
    }));
    status.textContent=s.start+' — '+s.end+' · '+number.format(s.count)+t(' 条记录',' observations')+
      (oracle?t(' · 历史按月末抽样，近期按日读取；时间为预言机报价时间。',' · Month-end samples, then daily reads. Quote times come from the oracle.'):'')+
      (s.coverageMode==='sampled-trading-days'?t(' · 已核验 '+s.checkedTradingDays+' / '+s.calendarTradingDays+' 个交易日，其余日期陆续补录。',' · '+s.checkedTradingDays+' / '+s.calendarTradingDays+' trading days checked. Historical backfill is ongoing.'):'')+
      (holding?t(' · 伯克希尔 13F 季末持仓市值除以申报股数，按披露日排列。',' · Berkshire’s quarter-end position value divided by reported shares, ordered by filing date.'):'')+
      (trade?t(' · 每月选一笔 Form 4 披露的实际成交，按披露日排列。原表可查成交价或加权均价。',' · One Form 4 trade per covered filing month. The original filing gives the reported price or weighted average.'):'');
    paging.hidden=false;q('[data-page]').textContent=(page+1)+' / '+pages;
    q('[data-prev]').disabled=page===0;q('[data-next]').disabled=page+1>=pages;q('.br-raw-scroll').scrollTop=0;
  }
  function describe(s){
    const parts=[el('span',t(...types[s.statistic])+(s.network?' · '+({ethereum:'Ethereum',arbitrum:'Arbitrum One',avax:'Avalanche C-Chain'}[s.network]):'')),link(s.source+' ↗',s.sourceUrl)];
    if(s.id==='oracle-nvda')parts.push(link(t('英伟达历史收盘价 ↗','NVIDIA historical closes ↗'),'https://investor.nvidia.com/stock-info/historical-price-lookup/default.aspx'));
    const underlying=o=>(o.related??o.symbol?.toLowerCase()??o.id).replace(/^oracle-/,'').replace(/-(eps|13f-value|insider-trade)$/,'');
    for(const other of series.filter(o=>o.id!==s.id&&underlying(o)===underlying(s))){
      const label=other.network?t('查看链上报价','View oracle rounds'):t(...types[other.statistic]);
      const b=el('button',label);b.type='button';b.onclick=()=>{instrument.value=other.id;load();};parts.push(b);
    }
    if(s.licenseUrl==='https://data.gov.tw/license'){
      const details=el('details');details.className='br-market-attribution';
      details.append(el('summary',t('数据来源与授权','Sources and license')),
        el('span',s.attribution??'Taiwan Stock Exchange / Securities and Futures Bureau, FSC (Taiwan)'));
      const reportNames={daily:['每日个股收盘','Daily share closes'],rank:['成交量前二十名','Top 20 by volume'],foreign:['第一上市外资股收盘行情','Foreign issuers’ closing prices'],valuation:['个股收盘价与估值','Share closes and valuations']};
      for(const report of s.reports??[]){
        if(Object.hasOwn(reportNames,report.id)&&/^https:\/\/data\.gov\.tw\/dataset\/\d+$/.test(report.datasetUrl)){
          details.append(link(t(...reportNames[report.id])+' ↗',report.datasetUrl));
        }
      }
      if(s.earlyCoverage?.method==='top20-volume')details.append(el('span',t('2017 年 4 月 13 日前仅收录进入成交量前二十名的交易日。','Before 13 April 2017, closes cover days in the top 20 by volume.')));
      details.append(link(t('开放资料授权 1.0','Open Data License 1.0'),s.licenseUrl));parts.push(details);
    }
    info.replaceChildren(...parts);
  }
  async function load(refresh=false){
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++revision;
    clear();retry.hidden=true;status.textContent=t('正在读取历史数据…','Loading history…');
    try{
      if(!series.length||refresh===true){
        const previous=instrument.value;
        const res=await fetch(url+'catalog.json',{signal,cache:'no-cache'});if(!res.ok)throw Error();
        const all=validateSeries(await res.json());if(id!==revision)return;series=all;instrument.replaceChildren();
        for(const [group,names] of Object.entries(groups)){
          const opts=el('optgroup');opts.label=t(...names);
          const rank=s=>s.statistic==='oracle'?2:s.statistic==='dilutedEps'||s.statistic==='reportedValuePerShare'?1:0;
          for(const s of series.filter(v=>v.group===group).sort((a,b)=>rank(a)-rank(b))){
            const opt=el('option',(en?s.en:s.zh)+(s.network?' · '+s.source:''));opt.value=s.id;opts.append(opt);
          }
          if(opts.children.length)instrument.append(opts);
        }
        if(all.some(s=>s.id===previous))instrument.value=previous;
      }
      const s=chosen();describe(s);
      const records=cache.get(s.sha256)??await readSeries(s,signal);if(id!==revision)return;
      rows=records;if(cache.size>=8)cache.delete(cache.keys().next().value);cache.set(s.sha256,rows);
      const years=Array.from(new Set(rows.map(r=>r[0].slice(0,4)))).reverse();
      year.replaceChildren(...years.map(y=>el('option',y)));page=0;render();
    }catch{if(!signal.aborted){status.textContent=t('未能读取或校验行情。','Could not load or verify this series.');retry.hidden=false;}}
  }
  open.onclick=()=>{dialog.showModal();load();};instrument.onchange=load;year.onchange=()=>{page=0;render();};retry.onclick=()=>load(true);
  q('[data-prev]').onclick=()=>{page--;render();};q('[data-next]').onclick=()=>{page++;render();};q('[data-close]').onclick=()=>dialog.close();
  dialog.onclose=()=>{revision++;controller?.abort();open.focus({preventScroll:true});};
  return ()=>{revision++;controller?.abort();dialog.remove();open.remove();};
}
