import {archiveCounter} from './brain-raw-archive.mjs';

const titles={whale:{en:'Whale & Smart Money Trades',zh:'巨鲸与聪明钱成交'},rwa:{en:'RWA Records',zh:'RWA 记录'}};
const string=value=>typeof value==='string'&&value.trim().length>0;
const copy=value=>string(value)||(string(value?.en)&&string(value?.zh));
const locale=(value,en)=>typeof value==='object'?value[en?'en':'zh']:value;
const quantity=value=>Number.isFinite(value)||copy(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const amount=value=>(typeof value==='number'||string(value))&&Number.isFinite(Number(value))&&Number(value)>=0;
function httpsLink(value){
  if(!string(value))return false;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}
}
function dateString(value){
  if(!string(value)||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return false;
  return Number.isFinite(Date.parse(value))&&new Date(value.slice(0,10)).toISOString().slice(0,10)===value.slice(0,10);
}
export function validateResearchArchive(data){
  if(!data||!count(data.count)||!dateString(data.asOf)||
     !dateString(data.startDate)||!dateString(data.endDate)||Date.parse(data.startDate)>Date.parse(data.endDate)||
     !copy(data.unit)||!copy(data.sourceName)||!httpsLink(data.sourceUrl)||!copy(data.methodology)||
     (data.analysis!=null&&!copy(data.analysis))||!Array.isArray(data.stats)||!Array.isArray(data.samples)||
     data.samples.length>data.count||data.stats.some(row=>!copy(row?.label)||!quantity(row?.value))||
     data.samples.some(row=>!string(row?.id)||!dateString(row?.date)||!copy(row?.label)||!quantity(row?.value)||!httpsLink(row?.url))||
     (data.topMarkets!=null&&(!Array.isArray(data.topMarkets)||data.topMarkets.some(row=>!string(row?.coin)||!count(row.matches)||!amount(row.notionalUSDC))))||
     (data.assetContracts!=null&&(!Array.isArray(data.assetContracts)||data.assetContracts.some(row=>!string(row?.symbol)||!count(row.count)||!Number.isSafeInteger(row.chainId)||row.chainId<=0||!httpsLink(row.issuerUrl))))||
     (data.attribution!=null&&(!copy(data.attribution.name)||!httpsLink(data.attribution.url)||!copy(data.attribution.license)||!httpsLink(data.attribution.licenseUrl)))||
     (data.sources!=null&&(!Array.isArray(data.sources)||data.sources.some(row=>!copy(row?.name)||!httpsLink(row?.url))))){
    throw Error('INVALID_RESEARCH_ARCHIVE');
  }
  return data;
}
const prettyDate=value=>value.length===10?value:new Date(value).toISOString().slice(0,16).replace('T',' ')+' UTC';

export function mountResearchArchives(root,en,heroReady){
  const doc=root.ownerDocument,heading=root.querySelector('.ct-archive-counts'),board=root.querySelector('.brain-board');
  const fmt=new Intl.NumberFormat(en?'en':'zh'),t=(zh,english)=>en?english:zh;
  const make=(tag,text)=>{const node=doc.createElement(tag);if(text!=null)node.textContent=text;return node;};
  const display=value=>typeof value==='number'?fmt.format(value):locale(value,en);
  const link=(label,url)=>{const a=make('a',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
  const lifetime=new AbortController(),entries=new Map();
  const dialog=make('dialog');dialog.id='brain-research-records';dialog.dataset.rawDialog='';
  dialog.setAttribute('aria-labelledby','brain-research-title');
  const head=make('header');head.className='br-raw-head';
  const title=make('h2');title.id='brain-research-title';
  const close=make('button','×');close.type='button';close.autofocus=true;close.setAttribute('aria-label',t('关闭','Close'));
  const content=make('div');content.className='br-research-content';
  head.append(title,close);dialog.append(head,content);board.append(dialog);
  let active=null,idle,opening;

  function section(label,body){
    const section=make('section');section.append(make('h3',label),body);return section;
  }
  function breakdown(data){
    const markets=data.topMarkets?.length,assets=data.assetContracts?.length;
    if(!markets&&!assets)return null;
    const box=make('details');box.className='br-research-breakdown';
    const summary=make('summary',markets?t('按成交笔数查看市场','Markets by Trade Count'):t('按资产查看事件','Events by Asset'));
    summary.append(make('small',markets?t('前 '+markets+' 个','Top '+markets):t(assets+' 个合约',assets+' contracts')));
    box.append(summary);
    const table=make('table'),thead=table.createTHead().insertRow(),body=table.createTBody();
    const columns=markets?[t('市场','Market'),t('成交笔数','Trades'),t('名义金额 · USDC','Notional · USDC')]:
      [t('资产 / 链','Asset / chain'),t('发行方','Issuer'),t('事件数','Events')];
    for(const label of columns){const th=make('th',label);th.scope='col';thead.append(th);}
    if(markets){
      const usdc=new Intl.NumberFormat(en?'en':'zh',{minimumFractionDigits:2,maximumFractionDigits:2});
      for(const row of [...data.topMarkets].sort((a,b)=>b.matches-a.matches)){
        const tr=body.insertRow();tr.insertCell().textContent=row.coin;
        tr.insertCell().textContent=fmt.format(row.matches);tr.insertCell().textContent=usdc.format(row.notionalUSDC);
      }
    }else{
      const chainName=id=>({1:'Ethereum',56:'BNB Chain'})[id]||t('链 '+id,'Chain '+id);
      for(const row of [...data.assetContracts].sort((a,b)=>a.chainId-b.chainId||b.count-a.count||a.symbol.localeCompare(b.symbol))){
        const tr=body.insertRow(),asset=tr.insertCell(),url=new URL(row.issuerUrl);
        const issuer=url.hostname.endsWith('.ondo.finance')||url.hostname==='ondo.finance'?'Ondo Finance':
          url.hostname==='tether.to'?'Tether':url.hostname==='github.com'&&url.pathname.startsWith('/paxosglobal/')?'Paxos':url.hostname;
        asset.append(make('strong',row.symbol),make('small',chainName(row.chainId)));
        tr.insertCell().append(link(issuer+' ↗',row.issuerUrl));tr.insertCell().textContent=fmt.format(row.count);
      }
    }
    box.append(table);return box;
  }
  function render(key){
    if(active!==key||!dialog.open)return;
    const {data,error}=entries.get(key);content.replaceChildren();
    if(!data){
      const status=make('p',error?t('暂时无法读取档案。','Archive unavailable.'):t('正在读取档案…','Loading archive…'));
      status.setAttribute('role','status');content.append(status);
      if(error){const retry=make('button',t('重试','Retry'));retry.type='button';retry.onclick=()=>load(key);content.append(retry);}
      return;
    }
    const stats=make('dl');stats.className='br-market-counts';
    const metric=(label,value)=>{const cell=make('div');cell.append(make('dt',label),make('dd',value));stats.append(cell);};
    metric(display(data.unit),fmt.format(data.count));
    for(const row of data.stats)metric(display(row.label),display(row.value));
    const dates=make('p',t('覆盖日期','Coverage')+' · '+data.startDate.slice(0,10)+' – '+data.endDate.slice(0,10));
    const asOf=make('time',t('数据截至','Data as of')+' · '+prettyDate(data.asOf));asOf.dateTime=data.asOf;
    const sources=make('div');sources.className='br-research-sources';
    const distinct=new Map([[data.sourceUrl,display(data.sourceName)]]);
    for(const row of data.sources||[])distinct.set(row.url,display(row.name));
    if(data.attribution){
      const {url,name,licenseUrl,license}=data.attribution;
      distinct.set(url,display(name));distinct.set(licenseUrl,display(license));
    }
    for(const [url,name] of distinct)sources.append(link(name+' ↗',url));
    content.append(stats,dates,asOf,section(t('统计口径','Methodology'),make('p',display(data.methodology))));
    if(data.analysis)content.append(section(t('数据解读','Analysis'),make('p',display(data.analysis))));
    const details=breakdown(data);if(details)content.append(details);
    const samples=make('ul');samples.className='br-research-samples';
    for(const row of data.samples){
      const li=make('li'),a=link(display(row.label)+' ↗',row.url),at=make('time',prettyDate(row.date));
      a.title=row.id;at.dateTime=row.date;
      li.append(a,make('strong',display(row.value)),at);samples.append(li);
    }
    content.append(section(t('原始记录样本','Source samples'),data.samples.length?samples:make('p',t('本期无样本','No samples for this period.'))),section(t('数据来源','Sources'),sources));
  }
  function load(key){
    const entry=entries.get(key);
    if(entry.task||entry.data||lifetime.signal.aborted)return;
    const request=new AbortController();entry.request=request;
    const timer=setTimeout(()=>request.abort(),12000);
    entry.error=false;entry.open.setAttribute('aria-busy','true');render(key);
    entry.task=(async()=>{
      try{
        const res=await fetch('/data/research-archives/'+key+'.json',{signal:request.signal,credentials:'same-origin',cache:'no-cache'});
        if(!res.ok)throw Error('ARCHIVE_UNAVAILABLE');
        const data=validateResearchArchive(await res.json());
        if(lifetime.signal.aborted)return;
        entry.data=data;entry.open.removeAttribute('title');entry.counter(data.count,' '+locale(titles[key],en),key);
      }catch{
        if(!lifetime.signal.aborted){
          entry.error=true;entry.counter(null,'— '+locale(titles[key],en),key);
          entry.open.title=t('档案暂不可用，点开可重试。','Archive unavailable. Open to retry.');
        }
      }finally{
        clearTimeout(timer);entry.task=null;entry.open.removeAttribute('aria-busy');
        if(!lifetime.signal.aborted)render(key);
      }
    })();
  }
  for(const [key,label] of Object.entries(titles)){
    const open=make('button');open.type='button';open.dataset.rawOpen=key;
    open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-controls',dialog.id);
    const caption=make('span'),arrow=make('span','↗');arrow.setAttribute('aria-hidden','true');open.append(caption,arrow);
    const counter=archiveCounter(open,fmt,lifetime.signal);counter(null,locale(label,en),key);
    entries.set(key,{open,counter,request:null,task:null,data:null,error:false});heading.append(open);
    open.onclick=()=>{
      // A linked dialog must acquire and restore focus after the splash releases the page.
      if(doc.body.classList.contains('app-loading')){
        opening?.disconnect();
        const hash=doc.location.hash;
        opening=new MutationObserver(()=>{
          if(doc.body.classList.contains('app-loading'))return;
          opening.disconnect();
          if(doc.location.hash===hash&&!doc.querySelector('dialog[open]'))open.click();
        });
        opening.observe(doc.body,{attributes:true,attributeFilter:['class']});return;
      }
      active=key;title.textContent=locale(label,en);dialog.showModal();content.scrollTop=0;
      render(key);if(!entries.get(key).error)load(key);
    };
  }
  close.onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
  dialog.addEventListener('close',()=>{const button=entries.get(active)?.open;active=null;if(button?.isConnected)button.focus({preventScroll:true});});
  function prefetch(){if(!doc.hidden&&!lifetime.signal.aborted)for(const key of entries.keys())load(key);}
  Promise.resolve(heroReady).then(()=>{
    if(lifetime.signal.aborted)return;
    idle=setTimeout(prefetch,0);doc.addEventListener('visibilitychange',prefetch,{signal:lifetime.signal});
  });
  return ()=>{lifetime.abort();opening?.disconnect();clearTimeout(idle);for(const entry of entries.values()){entry.request?.abort();entry.open.remove();}dialog.remove();};
}
