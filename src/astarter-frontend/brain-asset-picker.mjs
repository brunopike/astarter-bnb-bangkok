import {brainAssetKey,filterBrainCatalog,searchBrainAssets,savedBrainRanking,fetchBrainRanking} from './brain-asset-data.mjs';
import {watchAssetIcon} from './market-watchlist.mjs';
import {brainChainName} from './brain-research-scope.mjs';
import {uiGlyph} from './product-composition.mjs';

export const networkScope='all';
export const archiveScope='eth-merge';
const marketGlyphs={metals:'layers',energy:'pulse',stock:'chart',index:'columns',futures:'strategy',etf:'layers',fx:'refresh',rates:'credits'};

export function mountAssetPicker(button,{getCatalog,en,onChoose,getKey,onOpenChange}){
  const doc=button.ownerDocument, win=doc.defaultView;
  const t=(zh,english)=>en?english:zh;
  const compactUSD=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2});
  let dialog=null,controller=null,timer=0,serial=0,ranking=savedBrainRanking,tradfi=null;
  function stopQuery(){win.clearTimeout(timer);controller?.abort();controller=null;serial++;}
  function open(){
    if(dialog?.open)return;
    const catalog=getCatalog();
    const modal=doc.createElement('dialog');
    dialog=modal;
    modal.className='product-dialog ct-asset-dialog';
    modal.setAttribute('aria-labelledby','ct-asset-title');
    modal.innerHTML=`<header class="p-dialog-head"><h2 id="ct-asset-title">${t('研究资产','Research assets')}</h2><button class="p-dialog-close" type="button" aria-label="${t('关闭','Close')}">${uiGlyph('close')}</button></header>
    <div class="p-dialog-body"><div class="ct-asset-modes" role="group" aria-label="${t('资产类别','Asset class')}"><button type="button" data-asset-mode="all" data-no-translate>All</button><button type="button" data-asset-mode="crypto">Crypto</button><button type="button" data-asset-mode="tradfi">TradFi</button></div>
    <label class="ct-asset-query">${uiGlyph('search')}<input type="search" autofocus autocomplete="off" spellcheck="false" maxlength="500" placeholder="${t('代币、网络或合约地址','Token, network or contract address')}" aria-label="${t('搜索标的','Search assets')}"></label>
    <nav class="ct-scope-shortcuts" aria-label="${t('研究范围','Research scope')}"></nav>
    <div class="ct-chain-filter"><h3></h3><span class="ct-picked-asset" hidden></span><select aria-label="${t('筛选网络','Filter network')}"></select></div>
    <div class="ct-asset-list" aria-label="${t('资产','Assets')}"></div><div class="ct-search-status" role="status"></div><footer class="ct-ranking-source"><span></span><time></time></footer><a class="ct-tradfi-full" href="#traditional-markets" hidden>${t('浏览完整 TradFi 档案','Browse TradFi archive')}<span aria-hidden="true">↗</span></a></div>`;
    doc.body.append(modal);
    const input=modal.querySelector('input'),list=modal.querySelector('.ct-asset-list'),status=modal.querySelector('[role=status]');
    const touchMenu=win.matchMedia('(hover:none) and (pointer:coarse)').matches;
    if(touchMenu){
      input.autofocus=false;
      const heading=modal.querySelector('h2');heading.tabIndex=-1;heading.setAttribute('autofocus','');
    }
    const networks=modal.querySelector('select');
    const shortcuts=modal.querySelector('.ct-scope-shortcuts'),sectionLabel=modal.querySelector('.ct-chain-filter h3');
    const source=modal.querySelector('.ct-ranking-source'),rankRequest=new AbortController();
    let current=new Map(),lastRows=[],lastQuery='',rankingCached=true,rankStarted=false;
    let mode='all',catalogPending=false,catalogError=false,cryptoState='idle';
    const filters={all:{query:'',group:''},crypto:{query:'',group:''},tradfi:{query:'',group:''}};
    const modeButtons=[...modal.querySelectorAll('[data-asset-mode]')],fullArchive=modal.querySelector('.ct-tradfi-full');
    let browseAfterClose=false;
    const pickedLabel=modal.querySelector('.ct-picked-asset');
    const localized=value=>typeof value==='string'?value:value?.[en?'en':'zh'];
    function localAssets(){
      const rows=new Map(ranking.rows.map(asset=>[brainAssetKey(asset),asset]));
      for(const asset of catalog)if(asset.kind!=='tradfi'&&!rows.has(brainAssetKey(asset)))rows.set(brainAssetKey(asset),asset);
      return [...rows.values()];
    }
    function option(key,title,detail,icon,asset){
      const row=doc.createElement('button');row.type='button';row.className='ct-asset-option';
      row.dataset.scopeKey=key;row.setAttribute('aria-pressed',String(getKey()===key));
      const mark=doc.createElement('span');mark.className='ct-asset-mark';mark.innerHTML=icon;
      const copy=doc.createElement('span');copy.className='ct-asset-name';const name=doc.createElement('b');name.textContent=title;copy.append(name);
      if(detail){const sub=doc.createElement('small');sub.textContent=detail;copy.append(sub);}
      row.append(mark,copy);
      if(getKey()===key){const check=doc.createElement('span');check.className='ct-asset-check';check.textContent='✓';row.append(check);}
      if(asset)current.set(key,asset);
      return row;
    }
    const all=option(networkScope,'All','Crypto · TradFi',uiGlyph('layers'));
    all.dataset.noTranslate='';
    shortcuts.append(all);
    function cryptoRow(item,ranked){
      const key=brainAssetKey(item),network=item.chain?brainChainName(item.chain):t('聚合资产','Market aggregate');
      const address=item.address?item.address.slice(0,6)+'…'+item.address.slice(-5):'';
      const detail=[...new Set([item.name===item.symbol?'':item.name,network,address].filter(Boolean))].join(' · ');
      const row=option(key,item.symbol,ranked?item.name:detail,watchAssetIcon(item,26),item);
      if(ranked&&mode==='crypto'){
        row.classList.add('ct-ranked-asset');
        const rank=doc.createElement('span');rank.className='ct-asset-rank';rank.textContent=String(item.rank);
        const cap=doc.createElement('span');cap.className='ct-asset-cap';cap.textContent='$'+compactUSD.format(item.cap);
        cap.title=new Intl.NumberFormat(en?'en-US':'zh-CN',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(item.cap);
        row.prepend(rank);row.append(cap);
      }
      return row;
    }
    function marketRow(item){
      const name=en?item.name:item.nameZh||item.name,kind=localized(item.instrumentType);
      const row=option('tradfi:'+item.id,item.symbol,[kind,name].filter(Boolean).join(' · '),uiGlyph(marketGlyphs[item.group]||'chart'),item);
      row.title=[name,kind,item.provider].filter(Boolean).join(' · ');row.dataset.assetGroup=item.group;
      return row;
    }
    function tagged(row,kind){
      const label=doc.createElement('small');label.className='ct-asset-kind';label.textContent=kind;
      row.dataset.assetClass=kind;row.append(label);return row;
    }
    function marketMatches(query,group=''){
      if(!tradfi)return [];
      if(query.startsWith('tradfi:')){
        const item=tradfi.getTradfiAsset(query.slice(7));return item&&(!group||item.group===group)?[item]:[];
      }
      return tradfi.searchTradfiAssets(query,group);
    }
    function updatePicked(){
      const key=getKey(),asset=key?.startsWith('tradfi:')?tradfi?.getTradfiAsset(key.slice(7)):localAssets().find(item=>brainAssetKey(item)===key);
      const label=asset?.symbol||(key===archiveScope?t('以太坊合并','Ethereum Merge'):'');
      pickedLabel.hidden=!label||mode!=='all';
      if(label)pickedLabel.textContent=t('已选 · ','Selected · ')+label;
    }
    function renderAll(items,query){
      const coins=query?items.slice(0,80):ranking.rows,markets=marketMatches(query),rows=[];
      current=new Map();
      for(let i=0;i<Math.max(coins.length,markets.length);i++){
        if(coins[i])rows.push(tagged(cryptoRow(coins[i],!query),'Crypto'));
        if(markets[i])rows.push(tagged(marketRow(markets[i]),'TradFi'));
      }
      sectionLabel.textContent='Crypto '+coins.length+' · TradFi '+(tradfi?markets.length:'—');
      updatePicked();showRows(rows);
      if(catalogError){showCatalogError();}
      else if(cryptoState==='unavailable')status.textContent=t('外部加密资产搜索暂不可用','External crypto search unavailable');
      else if(!rows.length)status.textContent=cryptoState==='pending'||catalogPending?t('查询中…','Searching…'):t('没有匹配的资产','No matching assets');
      else status.textContent='';
      return rows.length;
    }
    function render(items,query){
      lastRows=items;lastQuery=query;
      if(mode==='all')return renderAll(items,query);
      const filter=networks.value,ranked=!query&&!filter;
      const visibleItems=ranked?ranking.rows:(!query?localAssets():items);
      sectionLabel.textContent=ranked?t('市值前 20','Top 20 by market cap'):query?t('搜索结果','Search results'):t('网络资产','Network assets');
      source.hidden=!ranked;
      if(ranked){
        const stamp=new Date(ranking.at).toISOString().slice(0,16).replace('T',' ');
        source.querySelector('span').textContent='CoinGecko'+(rankingCached?t(' · 缓存',' · Cached'):'');
        const time=source.querySelector('time');time.dateTime=new Date(ranking.at).toISOString();time.textContent=stamp+' UTC';
      }
      const choices=new Set([...localAssets(),...items].map(a=>a.chain).filter(Boolean));
      if(filter)choices.add(filter);
      const chainOptions=[new Option(t('全部网络','All networks'),'')];
      for(const chain of [...choices].sort((a,b)=>brainChainName(a).localeCompare(brainChainName(b))))chainOptions.push(new Option(brainChainName(chain),chain));
      networks.replaceChildren(...chainOptions);networks.value=filter;
      current=new Map();
      return showRows(visibleItems.filter(a=>!filter||a.chain===filter).slice(0,80).map(item=>cryptoRow(item,ranked)));
    }
    function showRows(rows){
      const focusKey=list.contains(doc.activeElement)?doc.activeElement.closest('[data-scope-key]')?.dataset.scopeKey:null;
      const previousScroll=list.scrollTop;
      list.replaceChildren(...rows);
      if(focusKey){
        const focused=rows.find(row=>row.dataset.scopeKey===focusKey);
        (focused??input).focus({preventScroll:true});
        list.scrollTop=previousScroll;
        if(focused){
          const frame=list.getBoundingClientRect(),item=focused.getBoundingClientRect();
          if(item.top<frame.top)list.scrollTop+=item.top-frame.top;
          else if(item.bottom>frame.bottom)list.scrollTop+=item.bottom-frame.bottom;
        }
      }
      return rows.length;
    }
    function renderTradfi(){
      if(!tradfi)return;
      const {tradfiGroups}=tradfi;
      const group=filters.tradfi.group,query=input.value.trim();
      const groups=new Map(tradfiGroups.map(item=>[item.id,localized(item.label)]));
      networks.replaceChildren(new Option(t('全部类别','All categories'),''),...Array.from(groups,([id,label])=>new Option(label,id)));
      networks.disabled=false;networks.value=group;
      current=new Map();
      const items=marketMatches(query,group);
      sectionLabel.textContent=(query?t('搜索结果','Search results'):group?groups.get(group):t('代表资产','Featured assets'))+' · '+items.length;
      const rows=items.map(marketRow);showRows(rows);
      status.textContent=rows.length?'':t('没有匹配的传统金融资产','No matching TradFi assets');
    }
    function showCatalogError(){
      status.textContent=t('TradFi 目录暂不可用。','TradFi directory unavailable. ');
      const retry=doc.createElement('button');retry.type='button';retry.textContent=t('重试','Retry');retry.onclick=loadTradfi;status.append(retry);
    }
    function refreshDirectory(){
      if(mode==='all')renderAll(lastRows,lastQuery);
      else if(mode==='tradfi')renderTradfi();
    }
    async function loadTradfi(){
      if(tradfi){refreshDirectory();return;}
      if(catalogPending)return;
      catalogPending=true;catalogError=false;
      try{tradfi=await import('./brain-tradfi-assets.mjs');}
      catch{catalogError=true;if(mode!=='crypto'&&modal.open)showCatalogError();return;}
      finally{catalogPending=false;}
      if(modal.open)refreshDirectory();
    }
    networks.onchange=()=>{
      filters[mode].group=networks.value;
      if(mode==='tradfi'){renderTradfi();return;}
      status.textContent=render(lastRows,lastQuery)?'':t('此网络暂无匹配资产','No matching assets on this network');
    };
    function search(immediate){
      stopQuery();
      const query=input.value.trim(),own=serial;
      filters[mode].query=query;
      status.textContent='';
      if(mode==='tradfi'){renderTradfi();return;}
      cryptoState=query?'pending':'idle';
      if(!query){render([], '');return;}
      const local=filterBrainCatalog(localAssets(),query,brainChainName);
      render(local,query);
      if(!local.length&&mode==='crypto')status.textContent=t('查询中…','Searching…');
      async function fetchMatches(){
        controller=new AbortController();
        try{
          const remote=await searchBrainAssets(query,{signal:controller.signal});
          if(serial!==own||!modal.open)return;
          const merged=new Map(remote.filter(asset=>asset.kind!=='tradfi').map(asset=>[brainAssetKey(asset),asset]));
          for(const item of local)if(!merged.has(brainAssetKey(item)))merged.set(brainAssetKey(item),item);
          cryptoState='ready';const count=render([...merged.values()],query);
          if(mode==='crypto')status.textContent=count?'':t('没有匹配的资产','No matching assets');
        }catch{
          if(serial!==own||!modal.open)return;
          cryptoState='unavailable';if(mode==='all')renderAll(lastRows,lastQuery);else status.textContent=t('外部查询暂不可用','External search unavailable');
        }
      }
      if(immediate)fetchMatches();else timer=win.setTimeout(fetchMatches,320);
    }
    modal.addEventListener('click',event=>{
      const row=event.target.closest('[data-scope-key]');
      if(!row)return;
      const key=row.dataset.scopeKey,asset=current.get(key)??null;
      modal.close();
      if(win.location.hash==='#traditional-markets'){
        const url=new URL(win.location.href);url.hash='';win.history.replaceState(win.history.state,'',url);
      }
      onChoose(key,asset);
    });
    input.oninput=()=>search(false);
    input.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();modal.close();return;}
      if(event.key==='Enter'){event.preventDefault();search(true);}
      if(event.key==='ArrowDown'){event.preventDefault();list.querySelector('button')?.focus();}
    };
    list.onkeydown=event=>{
      if(event.key!=='ArrowUp' && event.key!=='ArrowDown')return;
      event.preventDefault();
      const row=event.target.closest('button'),next=event.key==='ArrowUp'?row?.previousElementSibling:row?.nextElementSibling;
      (next||(event.key==='ArrowUp'?input:row))?.focus();
    };
    fullArchive.onclick=event=>{
      if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      event.preventDefault();browseAfterClose=true;modal.close();
    };
    modal.querySelector('.p-dialog-close').onclick=()=>modal.close();
    modal.addEventListener('click',event=>{if(event.target!==modal)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();});
    modal.addEventListener('close',()=>{
      stopQuery();rankRequest.abort();modal.remove();if(dialog===modal)dialog=null;
      button.setAttribute('aria-expanded','false');onOpenChange?.(false);
      if(!button.isConnected)return;
      if(!browseAfterClose){button.focus({preventScroll:true});return;}
      if(win.location.hash===fullArchive.hash)button.closest('astarter-brain')?.querySelector('[data-raw-open="tradfi"]')?.click();
      else win.location.hash=fullArchive.hash;
    },{once:true});
    function loadRanking(){
      if(rankStarted)return;
      rankStarted=true;
      fetchBrainRanking({signal:rankRequest.signal}).then(result=>{
        if(!modal.open || rankRequest.signal.aborted)return;
        if(result.at>=ranking.at){ranking=result;rankingCached=false;}
        if(mode!=='tradfi'&&!input.value.trim())render([], '');
      }).catch(()=>{/* The dated cache stays available throughout an outage. */});
    }
    function showMode(next){
      stopQuery();current=new Map();mode=next;modal.dataset.assetMode=mode;
      for(const tab of modeButtons)tab.setAttribute('aria-pressed',String(tab.dataset.assetMode===mode));
      input.placeholder=mode==='all'?t('名称、代码、类别或地址','Name, symbol, category or address'):
        mode==='crypto'?t('代币、网络或合约地址','Token, network or contract address'):t('名称、代码或类别','Name, symbol or category');
      input.value=filters[mode].query;source.hidden=true;fullArchive.hidden=mode==='crypto';
      pickedLabel.hidden=true;networks.hidden=mode==='all';
      status.textContent='';list.replaceChildren();list.scrollTop=0;
      networks.setAttribute('aria-label',mode==='crypto'?t('筛选网络','Filter network'):t('筛选资产类别','Filter asset category'));
      networks.replaceChildren(new Option('',filters[mode].group));networks.disabled=false;
      if(mode!=='tradfi'){
        search(false);loadRanking();if(mode==='all')loadTradfi();
      }else{
        sectionLabel.textContent=t('代表资产','Featured assets');networks.disabled=true;
        if(!tradfi)status.textContent=t('正在读取资产目录…','Loading asset directory…');
        loadTradfi();
      }
    }
    for(const tab of modeButtons){
      tab.onclick=()=>{if(mode!==tab.dataset.assetMode)showMode(tab.dataset.assetMode);};
      tab.onkeydown=event=>{
        const index=modeButtons.indexOf(tab),next={ArrowLeft:(index+2)%3,ArrowRight:(index+1)%3,Home:0,End:2}[event.key];
        if(next==null)return;
        event.preventDefault();modeButtons[next].focus();modeButtons[next].click();
      };
    }
    button.setAttribute('aria-expanded','true');modal.showModal();onOpenChange?.(true);
    showMode(mode);
    if(!touchMenu)input.focus({preventScroll:true});
  }
  button.addEventListener('click',open);
  return ()=>{button.removeEventListener('click',open);stopQuery();dialog?.close();};
}
