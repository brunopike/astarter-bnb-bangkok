import {brainAssetKey,filterBrainCatalog,searchBrainAssets,savedBrainRanking,fetchBrainRanking} from './brain-asset-data.mjs';
import {watchAssetIcon} from './market-watchlist.mjs';
import {brainChainName} from './brain-research-scope.mjs';
import {uiGlyph} from './product-composition.mjs';

export const networkScope='all';
export const archiveScope='eth-merge';

export function mountAssetPicker(button,{getCatalog,en,onChoose,getKey,onOpenChange}){
  const doc=button.ownerDocument, win=doc.defaultView;
  const t=(zh,english)=>en?english:zh;
  const compactUSD=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2});
  let dialog=null,controller=null,timer=0,serial=0,ranking=savedBrainRanking;
  function stopQuery(){win.clearTimeout(timer);controller?.abort();controller=null;serial++;}
  function open(){
    if(dialog?.open)return;
    const catalog=getCatalog();
    const modal=doc.createElement('dialog');
    dialog=modal;
    modal.className='product-dialog ct-asset-dialog';
    modal.setAttribute('aria-labelledby','ct-asset-title');
    modal.innerHTML=`<header class="p-dialog-head"><h2 id="ct-asset-title">${t('研究资产','Research assets')}</h2><button class="p-dialog-close" type="button" aria-label="${t('关闭','Close')}">${uiGlyph('close')}</button></header>
    <div class="p-dialog-body"><label class="ct-asset-query">${uiGlyph('search')}<input type="search" autofocus autocomplete="off" spellcheck="false" maxlength="500" placeholder="${t('代币、网络或合约地址','Token, network or contract address')}" aria-label="${t('搜索标的','Search assets')}"></label>
    <nav class="ct-scope-shortcuts" aria-label="${t('研究范围','Research scope')}"></nav>
    <div class="ct-chain-filter"><h3></h3><select aria-label="${t('筛选网络','Filter network')}"></select></div>
    <div class="ct-asset-list" aria-label="${t('资产','Assets')}"></div><div class="ct-search-status" role="status"></div><footer class="ct-ranking-source"><span></span><time></time></footer></div>`;
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
    let current=new Map(),lastRows=[],lastQuery='',rankingCached=true;
    function localAssets(){
      const rows=new Map(ranking.rows.map(asset=>[brainAssetKey(asset),asset]));
      for(const asset of catalog)if(!rows.has(brainAssetKey(asset)))rows.set(brainAssetKey(asset),asset);
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
    const all=option(networkScope,t('全网资产','All assets'),'',uiGlyph('layers'));
    shortcuts.append(all);
    function render(items,query){
      const focusKey=list.contains(doc.activeElement)?doc.activeElement.closest('[data-scope-key]')?.dataset.scopeKey:null;
      const previousScroll=list.scrollTop;
      const filter=networks.value;
      const ranked=!query && !filter;
      const visibleItems=ranked?ranking.rows:(!query?localAssets():items);
      lastRows=items;lastQuery=query;
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
      const rows=[];
      for(const item of visibleItems.filter(a=>!filter||a.chain===filter).slice(0,80)){
        const key=brainAssetKey(item);
        const network=item.chain?brainChainName(item.chain):t('聚合资产','Market aggregate');
        const address=item.address?item.address.slice(0,6)+'…'+item.address.slice(-5):'';
        const detail=[...new Set([item.name===item.symbol?'':item.name,network,address].filter(Boolean))].join(' · ');
        const row=option(key,item.symbol,ranked?item.name:detail,watchAssetIcon(item,26),item);
        if(ranked){
          row.classList.add('ct-ranked-asset');
          const rank=doc.createElement('span');rank.className='ct-asset-rank';rank.textContent=String(item.rank);
          const cap=doc.createElement('span');cap.className='ct-asset-cap';cap.textContent='$'+compactUSD.format(item.cap);
          cap.title=new Intl.NumberFormat(en?'en-US':'zh-CN',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(item.cap);
          row.prepend(rank);row.append(cap);
        }
        rows.push(row);
      }
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
    networks.onchange=()=>{status.textContent=render(lastRows,lastQuery)?'':t('此网络暂无匹配资产','No matching assets on this network');};
    function search(immediate){
      stopQuery();
      const query=input.value.trim(),own=serial;
      status.textContent='';
      if(!query){render([], '');return;}
      const local=filterBrainCatalog(localAssets(),query,brainChainName);
      render(local,query);
      if(!local.length)status.textContent=t('查询中…','Searching…');
      async function fetchMatches(){
        controller=new AbortController();
        try{
          const remote=await searchBrainAssets(query,{signal:controller.signal});
          if(serial!==own||!modal.open)return;
          const merged=new Map(remote.map(asset=>[brainAssetKey(asset),asset]));
          for(const item of local)if(!merged.has(brainAssetKey(item)))merged.set(brainAssetKey(item),item);
          const count=render([...merged.values()],query);
          status.textContent=count?'':t('没有匹配的资产','No matching assets');
        }catch{
          if(serial!==own||!modal.open)return;
          status.textContent=t('外部查询暂不可用','External search unavailable');
        }
      }
      if(immediate)fetchMatches();else timer=win.setTimeout(fetchMatches,320);
    }
    modal.addEventListener('click',event=>{
      const row=event.target.closest('[data-scope-key]');
      if(!row)return;
      const key=row.dataset.scopeKey,asset=current.get(key)??null;
      modal.close();
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
    modal.querySelector('.p-dialog-close').onclick=()=>modal.close();
    modal.addEventListener('click',event=>{if(event.target!==modal)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();});
    modal.addEventListener('close',()=>{stopQuery();rankRequest.abort();modal.remove();if(dialog===modal)dialog=null;button.setAttribute('aria-expanded','false');onOpenChange?.(false);if(button.isConnected)button.focus({preventScroll:true});},{once:true});
    render([], '');
    button.setAttribute('aria-expanded','true');modal.showModal();onOpenChange?.(true);
    if(!touchMenu)input.focus({preventScroll:true});
    fetchBrainRanking({signal:rankRequest.signal}).then(result=>{
      if(!modal.open || rankRequest.signal.aborted)return;
      if(result.at>=ranking.at){ranking=result;rankingCached=false;}
      if(!input.value.trim())render([], '');
    }).catch(()=>{/* The dated cache stays available throughout an outage. */});
  }
  button.addEventListener('click',open);
  return ()=>{button.removeEventListener('click',open);stopQuery();dialog?.close();};
}
