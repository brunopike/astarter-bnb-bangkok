const archivePath='/brain-evidence/archive/';
const perPage=12;
const chains={
  BTC:{scope:'coin:bitcoin',name:'Bitcoin',explorer:'https://mempool.space/block/'},
  ETH:{scope:'coin:ethereum',name:'Ethereum',explorer:'https://eth.blockscout.com/block/'},
  BNB:{scope:'coin:binancecoin',name:'BNB Smart Chain',explorer:'https://bscscan.com/block/'},
  SOL:{scope:'coin:solana',name:'Solana',explorer:'https://explorer.solana.com/block/'},
  HYPE:{scope:'coin:hyperliquid',name:'HyperCore',explorer:'https://app.hyperliquid.xyz/explorer/block/'}
};
const isoDay=/^\d{4}-\d{2}-\d{2}$/;
const number=n=>Number.isSafeInteger(n)&&n>=0;

function validDay(day){
  if(typeof day!=='string'||!isoDay.test(day))return false;
  const at=Date.parse(day+'T00:00:00Z');
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===day;
}

export function explorerBlockUrl(asset,height){
  if(!Object.hasOwn(chains,asset)||!/^\d+$/.test(String(height))||!number(Number(height)))return null;
  return chains[asset].explorer+Number(height);
}

const sampled=series=>['sampled','daily-sample'].includes(series.coverageMode);

function validSeriesFormat(series){
  if(!Array.isArray(series.fields))return false;
  const fields=series.fields.join();
  if(fields!=='height,timestamp,transactions'&&(series.asset!=='SOL'||fields!=='slot,timestamp,transactions'))return false;
  if(series.asset==='SOL')return sampled(series)&&series.heightKind==='slot';
  if(series.asset==='HYPE')return sampled(series)&&series.network==='HyperCore';
  return !series.coverageMode||series.coverageMode==='full';
}

export function parseCatalog(data){
  if(data?.schemaVersion!==1 || !Array.isArray(data.datasets) || !data.datasets.length)throw Error('ARCHIVE_INDEX');
  const seen=new Set();
  for(const series of data.datasets){
    if(!Object.hasOwn(chains,series.asset)||seen.has(series.asset)||
      !Array.isArray(series.shards)||!series.shards.length||!number(series.count)||
      !validSeriesFormat(series)||
      !/^https:\/\//.test(series.sourceUrl)||typeof series.source!=='string')throw Error('ARCHIVE_SERIES');
    seen.add(series.asset);
    let count=0,previous='';
    for(const part of series.shards){
      const base=series.asset.toLowerCase()+'-'+part.start+'.json';
      if(!validDay(part.start)||part.start!==part.end||part.start<=previous||
        (part.file!==base&&part.file!==base+'.gz')||!number(part.count)||!part.count||
        typeof part.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(part.sha256))throw Error('ARCHIVE_SHARD');
      if(part.file.endsWith('.gz')&&part.encoding!==undefined&&part.encoding!=='delta-triples+gzip')throw Error('ARCHIVE_ENCODING');
      if((part.firstHeight!==undefined&&!number(part.firstHeight))||(part.lastHeight!==undefined&&!number(part.lastHeight))||
        (part.firstHeight!==undefined&&part.lastHeight!==undefined&&part.lastHeight-part.firstHeight+1<part.count))throw Error('ARCHIVE_HEIGHT');
      count+=part.count;previous=part.start;
    }
    if(count!==series.count||series.start!==series.shards[0].start||series.end!==previous)throw Error('ARCHIVE_COUNT');
  }
  if(data.count!==data.datasets.reduce((sum,s)=>sum+s.count,0))throw Error('ARCHIVE_TOTAL');
  return data.datasets;
}

export function parseArchiveSummary(data){
  if(data?.schemaVersion!==1||!Array.isArray(data.datasets)||!data.datasets.length)throw Error('ARCHIVE_SUMMARY');
  const seen=new Set();
  let total=0;
  for(const series of data.datasets){
    if(!Object.hasOwn(chains,series.asset)||seen.has(series.asset)||!number(series.count)||!series.count||
      !Array.isArray(series.ranges)||!series.ranges.length)throw Error('ARCHIVE_SERIES');
    seen.add(series.asset);
    let count=0,previous='';
    for(const range of series.ranges){
      if(!validDay(range.start)||!validDay(range.end)||range.start>range.end||range.start<=previous||
        !number(range.count)||!range.count)throw Error('ARCHIVE_PERIOD');
      count+=range.count;previous=range.end;
    }
    if(count!==series.count||series.start!==series.ranges[0].start||series.end!==previous)throw Error('ARCHIVE_COUNT');
    total+=count;
  }
  if(!number(total)||total!==data.count)throw Error('ARCHIVE_TOTAL');
  return data.datasets;
}

function coversDay(series,day){
  if(day>series.end||day<series.start)return false;
  return series.shards?series.shards.some(p=>p.start===day):series.ranges.some(p=>p.start<=day&&day<=p.end);
}

export function archiveScopeSeries(datasets,scope,cutoff){
  if(!datasets)return [];
  const relevant=datasets.filter(s=>scope==='all'||chains[s.asset]?.scope===scope||
    (scope==='eth-merge'&&s.asset==='ETH'));
  if(scope!=='eth-merge')return relevant;
  const at=Date.parse(cutoff);
  if(!Number.isFinite(at))return [];
  const day=new Date(at).toISOString().slice(0,10);
  return relevant.flatMap(series=>{
    if(!series.shards){
      const ranges=series.ranges.filter(range=>range.start<=day);
      if(!ranges.length)return [];
      const last=ranges.at(-1),partial=day<=last.end;
      return [{...series,ranges,end:partial?day:last.end,count:partial?null:ranges.reduce((sum,r)=>sum+r.count,0)}];
    }
    const shards=series.shards.filter(part=>part.start<=day);
    if(!shards.length)return [];
    const end=shards.at(-1).start;
    const count=end===day?null:shards.reduce((n,part)=>n+part.count,0);
    return [{...series,shards,end,count}];
  });
}

export function archiveRecordTarget(record){
  const asset=Object.keys(chains).find(key=>record?.scopeKeys?.includes(chains[key].scope));
  if(!asset||!Number.isFinite(Date.parse(record?.eventAt)))return null;
  if(asset==='HYPE'&&String(record.network??'').toLowerCase()!=='hypercore')return null;
  const height=asset==='SOL'?(record.slot??(record.heightKind==='slot'?record.blockHeight:undefined)):record.blockHeight;
  return number(height)?{asset,day:new Date(record.eventAt).toISOString().slice(0,10),height}:null;
}

export function pageForBlock(rows,height){
  const index=rows.findIndex(row=>row[0]===height);
  return index<0?null:Math.floor((rows.length-1-index)/perPage)+1;
}

export function rowsThrough(rows,cutoff){
  return cutoff?rows.filter(row=>row[1]*1000<=Date.parse(cutoff)):rows;
}

function expandBlockDeltas(data,count){
  if(!Array.isArray(data)||data.length!==3||!number(data[0])||!number(data[1]))throw Error('ARCHIVE_HEADER');
  const [initialHeight,initialTime,deltas]=data;
  if(!Array.isArray(deltas)||deltas.length!==count*3)throw Error('ARCHIVE_LENGTH');
  if(deltas[0]!==0||deltas[1]!==0)throw Error('ARCHIVE_ORIGIN');
  let height=initialHeight,time=initialTime;
  const rows=[];
  for(let i=0;i<deltas.length;i+=3){
    const dh=deltas[i],dt=deltas[i+1],tx=deltas[i+2];
    // Bitcoin block times can go backwards while height still increases.
    if(!number(dh)||!Number.isSafeInteger(dt)||!number(tx))throw Error('ARCHIVE_DELTA');
    height+=dh;time+=dt;
    rows.push([height,time,tx]);
  }
  return rows;
}

export async function readDay(part,signal,request=fetch){
  const response=await request(archivePath+part.file+'?v='+part.sha256,{signal,cache:'no-cache'});
  if(!response.ok)throw Error('ARCHIVE_DATA');
  const bytes=await response.arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hex=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  if(hex!==part.sha256.toLowerCase())throw Error('ARCHIVE_DIGEST');
  signal?.throwIfAborted();
  const compact=part.file.endsWith('.json.gz');
  let plain=bytes;
  if(compact){
    // The index authenticates the stored gzip file, including its header and trailer.
    if(typeof DecompressionStream!=='function')throw Error('ARCHIVE_GZIP_UNSUPPORTED');
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'),{signal});
    plain=await new Response(stream).arrayBuffer();
  }
  signal?.throwIfAborted();
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  const rows=compact?expandBlockDeltas(data,part.count):data;
  const midnight=Date.parse(part.start+'T00:00:00Z')/1000;
  let height=-1;
  if(!validDay(part.start)||part.start!==part.end||!Array.isArray(rows)||!rows.length||rows.length!==part.count)throw Error('ARCHIVE_LENGTH');
  for(const row of rows){
    if(!Array.isArray(row)||row.length!==3||!row.every(number)||row[0]<=height||
      row[1]<midnight||row[1]>=midnight+86400)throw Error('ARCHIVE_ROW');
    height=row[0];
  }
  if((part.firstHeight!==undefined&&rows[0][0]!==part.firstHeight)||
    (part.lastHeight!==undefined&&height!==part.lastHeight))throw Error('ARCHIVE_HEIGHT');
  return rows;
}

// Only animate toward a validated archive count. A scope change starts a new series.
export function archiveCounter(button,format,signal){
  const caption=button.firstElementChild,doc=button.ownerDocument;
  const touchFeedback=event=>{
    if(event.pointerType==='touch'&&event.isPrimary)
      button.toggleAttribute('data-count-pressed',event.type==='pointerdown');
  };
  for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture'])
    button.addEventListener(type,touchFeedback,{passive:true,signal});
  let frame=0,current=0,target,identity;
  signal.addEventListener('abort',()=>cancelAnimationFrame(frame),{once:true});
  return (total,unit,key)=>{
    if(total===target && key===identity && caption.dataset.unit===unit)return;
    cancelAnimationFrame(frame);
    const changedScope=identity!==undefined && key!==identity;
    target=total;identity=key;caption.dataset.unit=unit;
    const label=total===null?unit:format.format(total)+unit;
    button.setAttribute('aria-label',label);
    if(total===null){current=0;caption.textContent=label;return;}
    const start=current;
    const digits=doc.createElement('b'),value=doc.createElement('i');
    digits.className='ct-count-value';digits.dataset.total=format.format(total);digits.append(value);
    caption.replaceChildren(digits,doc.createTextNode(unit));
    const paint=n=>{current=n;value.textContent=format.format(n);};
    if(changedScope || total<=start || doc.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches ||
      doc.documentElement.dataset.reducedMotion==='true'){paint(total);return;}
    paint(start);
    let since;
    function tick(now){
      if(!doc.body.classList.contains('app-loading')){
        since??=now;
        const fraction=Math.min(1,(now-since)/(start?1000:1550));
        paint(Math.min(total,Math.round(start+(total-start)*(1-(1-fraction)**3))));
        if(fraction===1)return;
      }
      frame=requestAnimationFrame(tick);
    }
    frame=requestAnimationFrame(tick);
  };
}
export function followArchive(doc,signal,refresh){
  const visible=()=>{if(!doc.hidden && !signal.aborted)refresh();};
  const timer=setInterval(visible,60_000);
  signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
  doc.addEventListener('visibilitychange',visible,{signal});visible();
}

export function mountBlockArchive(root,en){
  const doc=root.ownerDocument,t=(zh,eng)=>en?eng:zh,fmt=new Intl.NumberFormat(en?'en':'zh');
  const make=(tag,copy)=>{const el=doc.createElement(tag);if(copy!==undefined)el.textContent=copy;return el;};
  const entry=kind=>{
    const b=make('button');b.type='button';b.dataset.rawOpen=kind;
    b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-controls','brain-raw-dialog');
    const caption=make('span'),arrow=make('span','↗');arrow.setAttribute('aria-hidden','true');
    b.append(caption,arrow);return b;
  };
  const heading=entry('heading'),note=entry('note');
  (root.querySelector('.ct-archive-counts')??root.querySelector('.ct-heading')).append(heading);
  root.querySelector('[data-note-history]').after(note);
  note.firstElementChild.textContent=t('查看历史区块','Browse historical blocks');
  const dialog=make('dialog');dialog.id='brain-raw-dialog';dialog.dataset.rawDialog='';
  dialog.setAttribute('aria-labelledby','brain-raw-title');
  dialog.innerHTML=`<header class="br-raw-head"><h2 id="brain-raw-title">${t('历史区块','Historical blocks')}</h2><button type="button" data-raw-close aria-label="${t('关闭','Close')}">×</button></header>
    <div class="br-raw-filters" hidden><label>${t('网络','Network')}<select data-raw-chain></select></label><label>${t('日期（UTC）','Date (UTC)')}<input data-raw-date type="date" required></label></div>
    <label class="br-raw-ranges" hidden><span>${t('归档时段','Archived periods')}</span><select data-raw-period></select></label>
    <div class="br-raw-provenance" hidden><span data-raw-coverage></span><a data-raw-source target="_blank" rel="noopener noreferrer"></a></div>
    <details class="br-raw-status" data-raw-inspect hidden><summary data-raw-lookup-title></summary>
      <form data-raw-lookup-form class="br-raw-filters"><label><span data-raw-lookup-label></span><input data-raw-height type="text" size="12" inputmode="numeric" pattern="[0-9]+" required autocomplete="off"></label><button type="submit">${t('查看区块 ↗','Open explorer ↗')}</button></form>
      <a data-raw-native-source hidden target="_blank" rel="noopener noreferrer">${t('下载当日原始采样文件 ↗','Download the native sample file ↗')}</a>
    </details>
    <div class="br-raw-status" role="status" aria-live="polite"><span data-raw-status></span> <button type="button" data-raw-retry hidden>${t('重试','Retry')}</button></div>
    <div class="br-raw-scroll" hidden><table><thead><tr><th scope="col" data-raw-height-heading></th><th scope="col">${t('时间（UTC）','Time (UTC)')}</th><th scope="col">${t('交易笔数','Transactions')}</th></tr></thead><tbody data-raw-body></tbody></table></div>
    <footer class="br-raw-pages" hidden><button type="button" data-raw-prev aria-label="${t('上一页','Previous page')}">←</button><label>${t('页码','Page')} <input type="number" min="1" inputmode="numeric" data-raw-page> <span data-raw-pages></span></label><button type="button" data-raw-next aria-label="${t('下一页','Next page')}">→</button></footer>`;
  root.querySelector('.brain-board').append(dialog);
  const q=s=>dialog.querySelector(s),asset=q('[data-raw-chain]'),date=q('[data-raw-date]'),body=q('[data-raw-body]');
  const pages=q('.br-raw-pages'),scroller=q('.br-raw-scroll'),retry=q('[data-raw-retry]'),pageInput=q('[data-raw-page]');
  const life=new AbortController(),cache=new Map();
  const setCount=archiveCounter(heading,fmt,life.signal);
  let cutoff=null,reference=null,target=null,focusHeight=null,matchedDay=false,pendingKey=null;
  let fillRevision=0,summary=null,catalog=null,indexRequest=null,request=null,rows=[],page=1,scope='all',node=0,opener=null;
  const available=()=>archiveScopeSeries(catalog??summary,scope,cutoff);
  const chosen=()=>available().find(series=>series.asset===asset.value);
  function entries(){
    const applicable=scope==='all'||scope==='eth-merge'||Object.values(chains).some(c=>c.scope===scope);
    const series=available();
    const headline=cutoff?series:archiveScopeSeries(summary??catalog,scope,cutoff);
    heading.hidden=!applicable||Boolean((catalog||summary)&&!headline.length);
    const matched=reference&&series.some(s=>s.asset===reference.asset&&coversDay(s,reference.day));
    note.hidden=heading.hidden||(!matched&&![1,5].includes(node));
    note.firstElementChild.textContent=matched?t('核对区块 #','Inspect block #')+reference.height:t('查看历史区块','Browse historical blocks');
    const units=headline.length&&headline.every(sampled)?t(' 个区块样本',' sampled blocks'):t(' 个历史区块',' historical blocks');
    const count=headline.length && headline.every(s=>s.count!==null)?headline.reduce((n,s)=>n+s.count,0):null;
    setCount(count,count===null?t('历史区块','Historical blocks'):units,scope+'|'+(cutoff??''));
  }
  function status(text,canRetry=false){
    q('[data-raw-status]').textContent=text;retry.hidden=!canRetry;
  }
  async function index(refresh=false){
    if(catalog&&!refresh)return true;
    if(!indexRequest)indexRequest=fetch(archivePath+'manifest.json',{signal:life.signal,cache:'no-cache'})
      .then(r=>{if(!r.ok)throw Error('ARCHIVE_INDEX');return r.json();})
      .then(data=>{catalog=parseCatalog(data);indexReadAt=Date.now();entries();return true;})
      .catch(()=>false).finally(()=>{indexRequest=null;});
    return indexRequest;
  }
  let readingSummary=false,indexReadAt=0;
  async function loadSummary(){
    if(readingSummary)return;
    readingSummary=true;
    try{
      const response=await fetch(archivePath+'summary.json',{signal:life.signal,cache:'no-cache'});
      if(response.status===404){await index();return;}
      if(!response.ok)return;
      const datasets=parseArchiveSummary(await response.json());
      if(life.signal.aborted)return;
      summary=datasets;entries();
    }catch{
      // Keep the last validated count on a transient error.
    }finally{readingSummary=false;}
  }
  function paint(){
    const series=chosen(),count=rows.length;
    if(!series||!count)return;
    const max=Math.ceil(count/perPage);page=Math.min(Math.max(1,page),max);
    const start=(page-1)*perPage,fragment=doc.createDocumentFragment();
    for(let i=start;i<Math.min(start+perPage,count);i++){
      const [height,at,tx]=rows[count-1-i],row=make('tr'),cell=make('td');
      if(height===focusHeight)row.setAttribute('aria-current','true');
      const link=make('a',fmt.format(height)+' ↗');
      link.href=explorerBlockUrl(series.asset,height);link.target='_blank';link.rel='noopener noreferrer';
      const iso=new Date(at*1000).toISOString(),time=make('time',iso.slice(11,19));
      time.dateTime=iso;time.title=iso;const timeCell=make('td');timeCell.append(time);
      cell.append(link);row.append(cell,timeCell,make('td',fmt.format(tx)));fragment.append(row);
    }
    body.replaceChildren(fragment);scroller.scrollTop=0;scroller.hidden=false;pages.hidden=false;
    pageInput.max=String(max);pageInput.value=String(page);q('[data-raw-pages]').textContent='/ '+fmt.format(max);
    q('[data-raw-prev]').disabled=page===1;q('[data-raw-next]').disabled=page===max;
    const prefix=cutoff?t('截至回放时间的区块 ','Blocks through replay cutoff: '):
      sampled(series)?t('当日收录样本 ','Archived samples: '):t('当日区块 ','Daily blocks: ');
    const absent=matchedDay&&focusHeight!==null&&pageForBlock(rows,focusHeight)===null;
    status(prefix+fmt.format(count)+(absent?t(' · 未找到所引区块',' · Referenced block unavailable'):''));
  }
  function clearRows(){
    request?.abort();request=null;pendingKey=null;rows=[];page=1;scroller.hidden=true;pages.hidden=true;body.replaceChildren();
  }
  async function load(){
    const series=chosen();
    const part=series?.shards.find(s=>s.start===date.value);
    const original=q('[data-raw-native-source]');
    const nativeUrl=series?.asset==='HYPE'&&part?.sources?.[0]?.url;
    original.hidden=true;original.removeAttribute('href');
    if(typeof nativeUrl==='string'&&nativeUrl.startsWith('https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/hyperliquid/mainnet/explorer_blocks/')){
      original.href=nativeUrl;original.hidden=false;
    }
    const cacheKey=part&&part.file+':'+part.sha256;
    if(request&&cacheKey===pendingKey)return;
    clearRows();
    if(!series)return;
    if(!part){status(t('该日期没有归档区块。','No archived blocks for this date.'));return;}
    const attempt=request=new AbortController();
    pendingKey=cacheKey;
    status(t('正在读取区块…','Loading blocks…'));
    try{
      let records=cache.get(cacheKey);
      if(!records){
        records=await readDay(part,attempt.signal);
        if(attempt.signal.aborted)return;
        if(cache.size>=3)cache.delete(cache.keys().next().value);
        cache.set(cacheKey,records);
      }
      if(attempt.signal.aborted)return;
      rows=rowsThrough(records,cutoff);
      if(!rows.length){status(t('截至回放时间，此日还没有已收录的区块。','No archived blocks on this date before the replay cutoff.'));return;}
      if(matchedDay)page=pageForBlock(rows,focusHeight)??1;
      paint();
    }catch(error){
      if(attempt.signal.aborted)return;
      if(error.message==='ARCHIVE_GZIP_UNSUPPORTED')status(t('请使用支持 gzip 解压的新版浏览器查看此日期。','Use a browser with gzip decompression support to view this date.'));
      else status(t('无法读取或验证这一天的区块。','This day’s blocks could not be loaded or verified.'),true);
    }finally{
      if(request===attempt){request=null;pendingKey=null;}
    }
  }
  function markPeriod(){
    const period=q('[data-raw-period]');
    const option=[...period.options].find(o=>o.dataset.start<=date.value&&date.value<=o.value);
    if(option)period.value=option.value;else period.selectedIndex=-1;
  }
  function selectSeries(keepDay,keepMissing=false){
    const series=chosen();if(!series)return;
    date.min=series.start;date.max=series.end;
    if(!keepDay||(!keepMissing&&!coversDay(series,date.value)))date.value=series.end;
    const periods=series.ranges?.filter(p=>p.start<=series.end)??[];
    const period=q('[data-raw-period]');
    period.replaceChildren(...periods.map(p=>{
      const end=p.end<series.end?p.end:series.end;
      const option=make('option',p.start===end?end:p.start+' — '+end);
      option.value=end;option.dataset.start=p.start;return option;
    }));
    period.parentElement.hidden=periods.length<2;markPeriod();
    matchedDay=Boolean(target&&target.asset===series.asset&&date.value===target.day);
    focusHeight=matchedDay?target.height:null;
    const slot=series.asset==='SOL',heightLabel=slot?'Slot':t('区块高度','Block height');
    q('[data-raw-height-heading]').textContent=heightLabel;
    q('[data-raw-lookup-title]').textContent=slot?t('按 Slot 查看原始区块','Look up a slot'):t('按高度查看原始区块','Look up a block height');
    q('[data-raw-lookup-label]').textContent=heightLabel;
    q('[data-raw-inspect]').hidden=Boolean(cutoff);
    let metric='';
    if(series.asset==='SOL')metric=t('每日一个已最终确认的区块，交易笔数含投票及失败交易。','One finalized block per day. Transactions include votes and failed transactions.');
    if(series.asset==='HYPE')metric=t('每日抽样至多 100 个原生区块，交易笔数按 HyperCore 浏览器展开的动作计数。','Up to 100 native blocks sampled per day. Transactions count individual actions as shown in the HyperCore explorer.');
    q('[data-raw-coverage]').textContent=(periods.length===1?series.start+' — '+series.end+' UTC · ':'')+
      fmt.format(series.shards.length)+t(' 个归档日',' archived dates')
      +(cutoff?' · '+t('回放截至 ','Replay through ')+cutoff.slice(0,16).replace('T',' ')+' UTC':'')
      +(metric?' · '+metric:'');
    const source=q('[data-raw-source]');source.textContent=series.source+' ↗';source.href=series.sourceUrl;
    load();
  }
  async function fill(refresh=false){
    const revision=++fillRevision;
    status(t('正在读取索引…','Loading index…'));
    const ok=await index(refresh);
    if(revision!==fillRevision||!dialog.open||life.signal.aborted)return;
    if(!ok){status(t('暂时无法读取区块索引。','The block index is unavailable.'),true);return;}
    const series=available();if(!series.length){status(t('当前研究范围没有区块记录。','No block records for this research scope.'));return;}
    if(target&&!series.some(s=>s.asset===target.asset&&coversDay(s,target.day)))target=null;
    const prior=asset.value;
    asset.replaceChildren(...series.map(s=>{const o=make('option',chains[s.asset].name+' · '+s.asset);o.value=s.asset;return o;}));
    asset.value=series.find(s=>s.asset===target?.asset)?.asset??series.find(s=>s.asset===prior)?.asset??series[0].asset;
    if(target?.asset===asset.value)date.value=target.day;
    asset.disabled=series.length===1;
    q('.br-raw-filters').hidden=false;q('.br-raw-provenance').hidden=false;selectSeries(Boolean(date.value),refresh&&prior===asset.value);
  }
  function open(event){
    if(dialog.open)return;opener=event.currentTarget;
    target=opener===note?reference:null;
    dialog.showModal();fill(Boolean(catalog) && Date.now()-indexReadAt>=60_000);
  }
  heading.onclick=note.onclick=open;q('[data-raw-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{
    fillRevision++;clearRows();q('[data-raw-inspect]').hidden=true;q('[data-raw-inspect]').open=false;q('[data-raw-height]').value='';q('.br-raw-ranges').hidden=true;q('.br-raw-filters').hidden=true;q('.br-raw-provenance').hidden=true;
    if(opener?.isConnected&&!opener.hidden)opener.focus({preventScroll:true});
    opener=null;
  });
  asset.onchange=()=>{target=null;q('[data-raw-height]').value='';selectSeries(true);};
  const heightInput=q('[data-raw-height]');
  heightInput.oninput=()=>heightInput.setCustomValidity('');
  q('[data-raw-lookup-form]').onsubmit=event=>{
    event.preventDefault();
    const url=explorerBlockUrl(asset.value,heightInput.value.trim());
    if(!url){
      heightInput.setCustomValidity(t('请输入有效的非负整数。','Enter a valid nonnegative integer.'));
      heightInput.reportValidity();return;
    }
    const link=make('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.click();
  };
  date.onchange=()=>{target=null;matchedDay=false;focusHeight=null;markPeriod();load();};
  q('[data-raw-period]').onchange=event=>{date.value=event.target.value;date.onchange();};
  q('[data-raw-prev]').onclick=()=>{page--;paint();};
  q('[data-raw-next]').onclick=()=>{page++;paint();};
  const go=()=>{const n=pageInput.valueAsNumber;if(Number.isSafeInteger(n))page=n;paint();};
  pageInput.onchange=go;pageInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();go();}};
  retry.onclick=()=>fill(Boolean(catalog));
  entries();followArchive(doc,life.signal,loadSummary);
  return {
    update(key,n,asOf,fallback){
      if(scope!==key||node!==n)reference=null;
      const changed=scope!==key||cutoff!==asOf;
      scope=key;node=n;cutoff=asOf;
      if(fallback)reference=archiveRecordTarget(fallback);
      entries();
      if(changed&&dialog.open)dialog.close();
    },
    record(record,fallback){reference=archiveRecordTarget(record)??archiveRecordTarget(fallback);entries();},
    dispose(){life.abort();clearRows();dialog.remove();heading.remove();note.remove();}
  };
}
