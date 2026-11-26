import {getNodeHistory,getMemoryIndex,defaultHistoryRecord} from './brain-history.mjs';
import {sparkline} from './product-charts.mjs';
import {evidenceChildren} from './brain-evidence-nodes.mjs';
import {gainNode,lossNode} from './brain-trader-history.mjs';
export {graphEvidence} from './brain-evidence-nodes.mjs';

export function mountHistoryReader(host,en,onInspect) {
  const doc=host.ownerDocument;
  const t=(zh,english)=>en?english:zh;
  const say=value=>Array.isArray(value)?value[en?1:0]:value;
  host.innerHTML='<header><h4></h4><span data-history-count></span></header><button type="button" data-case-scope hidden></button><p data-case-empty hidden></p><input type="search" data-memory-query hidden><div data-history-choices><select data-history-picker></select></div><strong data-history-title></strong><div data-history-chart></div><div data-case-outcome hidden></div><p data-history-body></p><div data-case-insight hidden></div><details data-child-list hidden><summary></summary><ol></ol><p data-child-detail></p><nav><button type="button" data-child-prev>←</button><span></span><button type="button" data-child-next>→</button></nav></details><div data-memory-relations hidden></div><footer><time></time><span data-history-links></span></footer>';
  const pick=host.querySelector('select'),title=host.querySelector('strong'),body=host.querySelector('[data-history-body]');
  const choices=host.querySelector('[data-history-choices]');
  const chart=host.querySelector('[data-history-chart]'),when=host.querySelector('time'),links=host.querySelector('[data-history-links]');
  const count=host.querySelector('[data-history-count]');
  host.querySelector('h4').textContent=t('历史依据','Historical evidence');
  pick.setAttribute('aria-label',t('选择历史记录','Select a historical record'));
  title.tabIndex=-1;
  const saved=new Map();
  const search=host.querySelector('[data-memory-query]'),relations=host.querySelector('[data-memory-relations]');
  search.placeholder=t('搜索事件、资产或来源','Search events, assets or sources');
  search.setAttribute('aria-label',search.placeholder);
  let list=[],matches=[],note=-1,pageKey=null;

  const scopeButton=host.querySelector('[data-case-scope]'),empty=host.querySelector('[data-case-empty]');
  const outcome=host.querySelector('[data-case-outcome]'),insight=host.querySelector('[data-case-insight]');
  const children=host.querySelector('[data-child-list]'),childDetail=host.querySelector('[data-child-detail]');
  const headline=host.querySelector('h4'),footer=host.querySelector('footer');
  const prev=children.querySelector('[data-child-prev]'),next=children.querySelector('[data-child-next]');
  prev.setAttribute('aria-label',t('上一页明细','Previous detail page'));next.setAttribute('aria-label',t('下一页明细','Next detail page'));
  let args=[],globalCases=false,recordShown=null,childIndex=-1,page=0;
  const pageSize=8;
  function node(tag,text){const el=doc.createElement(tag);el.textContent=text;return el;}
  const basis={realized:['已实现','Realized'],unrealized:['未实现','Unrealized'],estimated:['估算','Estimated'],gross:['毛额','Gross'],mixed:['含持仓估值','Mixed basis'],liquidation:['清算记录','Liquidation'], 'closed-fill':['本批平仓盈亏','Batch closed P&L']};
  const linked=new Set();
  function appendLink(label,url) {
    if(!url)return;
    const target=new URL(url,doc.baseURI);
    const local=target.origin===location.origin && (target.pathname.startsWith('/brain-evidence/') || target.pathname==='/brain-merge-case.json');
    if((target.protocol!=='https:' && !local) || linked.has(target.href))return;
    linked.add(target.href);
    const link=doc.createElement('a');
    link.href=target.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=label+' ↗';
    links.append(link);
  }
  function remember(){
    saved.delete(pageKey);saved.set(pageKey,{record:recordShown.id,child:childIndex,page,query:search.value,open:children.open});
    if(saved.size>256)saved.delete(saved.keys().next().value);
  }
  function paintChildren(){
    const c=evidenceChildren(recordShown);
    children.hidden=!c.length;
    if(!c.length)return;
    const label=recordShown.trader?t('操作与成交','Actions and fills'):recordShown.memoryEvidence?t('证据明细','Evidence details'):t('数据明细','Underlying observations');
    children.querySelector('summary').textContent=label+' · '+c.length;
    const pages=Math.ceil(c.length/pageSize);page=Math.max(0,Math.min(page,pages-1));
    const list=children.querySelector('ol');list.replaceChildren();list.start=page*pageSize+1;
    c.slice(page*pageSize,(page+1)*pageSize).forEach((part,i)=>{
      const idx=page*pageSize+i,li=doc.createElement('li'),button=node('button',say(part.label));
      button.type='button';button.dataset.child=String(idx);button.setAttribute('aria-pressed',String(idx===childIndex));
      li.append(button);
      if(idx===childIndex){
        childDetail.textContent=say(part.detail);
        const src=part.reference||(recordShown.trader?recordShown.trader.sources[part.source]:{url:recordShown.sourceUrl,label:recordShown.source});
        if(src && /^https:\/\//.test(src.url)){const a=node('a',say(src.label)+' ↗');a.href=src.url;a.target='_blank';a.rel='noopener noreferrer';childDetail.append(' ',a);}
        li.append(childDetail);
      }
      list.append(li);
    });
    const nav=children.querySelector('nav');nav.hidden=pages<=1;
    nav.querySelector('span').textContent=(page+1)+' / '+pages;
    prev.disabled=page===0;next.disabled=page===pages-1;
  }
  children.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||!recordShown)return;
    if(b===prev)page--;
    else if(b===next)page++;
    else if(b.dataset.child!==undefined)childIndex=Number(b.dataset.child);
    else return;
    paintChildren();remember();
    if(b.dataset.child!==undefined){
      onInspect?.(recordShown.id,childIndex);
      children.querySelector('[aria-pressed=true]')?.focus({preventScroll:true});
    }
  });
  function caseHighlights(record) {
    const c=record.trader;
    const tags=doc.createElement('ul');
    tags.className='br-case-tags';
    tags.setAttribute('aria-label',t('案例摘要','Case highlights'));
    const fields=c.outcomeTags ?? (record.collection==='prediction' && c.basis==='realized'
      ? {action:t('预测仓位平仓','Prediction position closed'),pnl:t('已实现 ','Realized P&L ')+say(c.amount)}
      : {context:say(c.amount)});
    for (const [kind,label] of Object.entries(fields)) {
      const tag=node('li',say(label));
      tag.dataset.caseTag=kind;
      tags.append(tag);
    }
    return tags;
  }
  function paintRelations(record){
    relations.replaceChildren();
    for(const link of record.relations??[]){
      const target=list.find(r=>r.id===link.id);
      if(!target)continue;
      const btn=node('button','');
      btn.type='button';btn.dataset.relatedRecord=target.id;
      btn.append(node('small',say(link.label)),node('span',shortLabel(target)));
      relations.append(btn);
    }
    relations.hidden=!relations.childElementCount;
  }
  relations.addEventListener('click',event=>{
    const button=event.target.closest('button[data-related-record]');
    if(!button)return;
    show.open(button.dataset.relatedRecord,-1);
    onInspect?.(button.dataset.relatedRecord,-1);
    (choices.hidden?title:pick).focus({preventScroll:true});
  });
  function draw(record,detail=-1,restore=null) {
    recordShown=record;childIndex=detail;page=detail>=0?Math.floor(detail/pageSize):restore?.page||0;
    const c=record.trader;
    outcome.hidden=!c;insight.hidden=!c&&!record.memorySections?.length;
    if(record.memorySections?.length){
      const rows=doc.createElement('dl');
      for(const part of record.memorySections)rows.append(node('dt',say(part.label)),node('dd',say(part.value)));
      insight.replaceChildren(rows);
    }
    paintRelations(record);
    if(c){
      outcome.dataset.outcome=c.outcome;
      const info=[c.actor,c.venue||({prediction:'Polymarket'}[record.collection]||c.chains.join(' · ')),say(basis[c.basis]||[c.basis,c.basis])];
      outcome.replaceChildren(caseHighlights(record),node('span',info.filter(Boolean).join(' · ')));
      insight.replaceChildren();
      for(const [name,text] of [[t('操作逻辑','Position logic'),c.logic],[t('复盘要点','Review'),c.lesson],[t('核算范围','Coverage'),c.limits]]){
        const line=doc.createElement('p');line.append(node('b',name+' '),doc.createTextNode(say(text)));insight.append(line);
      }
    }
    children.open=detail>=0||Boolean(restore?.open)||Boolean(c);
    paintChildren();
    host.dataset.historyRecord=record.id;
    pick.value=record.id;
    title.textContent=shortLabel(record);
    const only=matches.length===1;
    choices.hidden=only;title.hidden=!only;
    body.textContent=say(record.facets?.[note]??record.body);
    const prices=record.closes||record.samplePrices;
    const plot=prices && (note===2 || note===6);
    chart.hidden=!plot;
    if(plot){
      chart.innerHTML=sparkline(prices,{width:280,height:45,fill:false});
      chart.querySelector('svg').setAttribute('aria-label',record.samplePrices?t('七日价格样本','Seven-day price samples'):t('窗口内逐日收盘价','Daily closes in the observation window'));
    }else chart.replaceChildren();
    when.dateTime=record.knownAt;
    const prefix=record.availabilityBasis?.includes('reconstruction')?t('重建截止 ','Reconstructed as of '):t('资料截至 ','As of ');
    when.textContent=prefix+dateLabel(record.knownAt,record.precision);
    links.replaceChildren();linked.clear();
    appendLink(say(record.source),record.sourceUrl);
    if(record.upstreamUrl && record.upstreamUrl!==record.sourceUrl)appendLink(t('原始来源','Upstream'),record.upstreamUrl);
    if(record.baselineUrl)appendLink(t('基准','Baseline'),record.baselineUrl);
    for(const ref of record.references??[]){
      const url=ref.url||ref.sourceUrl;
      if(url && url!==record.sourceUrl && url!==record.baselineUrl)appendLink(say(ref.label||ref.source)||t('佐证','Evidence'),url);
    }
  }
  function dateLabel(value,precision){
    const iso=new Date(value).toISOString();
    return precision==='day'?iso.slice(0,10)+' UTC':iso.slice(0,16).replace('T',' ')+' UTC';
  }
  function shortLabel(record){
    const start=record.eventDay||record.eventAt.slice(0,10),end=record.eventDay?null:record.observationEndAt?.slice(0,10);
    const range=end?start+' – '+(end.slice(0,4)===start.slice(0,4)?end.slice(5):end):start;
    return range+' · '+say(record.title);
  }
  pick.addEventListener('change',()=>{
    const record=list.find(item=>item.id===pick.value);
    if(!record)return;
    draw(record);remember();onInspect?.(record.id,-1);
  });
  scopeButton.onclick=()=>{globalCases=!globalCases;show(...args);};
  function show(scope,node,asOf,network) {
    if(scope!==args[0])globalCases=false;
    args=[scope,node,asOf,network];
    const caseNode=node===gainNode||node===lossNode;
    const key=scope+'/'+node+(caseNode&&globalCases?'/all':'');
    const effectiveScope=caseNode&&globalCases?'all':scope;
    const isIndex=node===4 && scope!=='eth-merge';
    const next=isIndex?getMemoryIndex(effectiveScope,asOf,network):getNodeHistory(effectiveScope,node,asOf,network);
    const relevant=caseNode && scope!=='all';
    headline.textContent=caseNode?t('交易者档案','Trader cases'):t('历史依据','Historical evidence');
    scopeButton.hidden=!relevant;
    scopeButton.textContent=globalCases?t('返回当前资产','Back to this asset'):t('查看全网案例','Browse network cases');
    scopeButton.setAttribute('aria-pressed',String(globalCases));
    empty.hidden=!caseNode||next.length>0;
    if(!empty.hidden)empty.textContent=t('此范围及时间内尚无已核实案例。','No verified case for this scope and cutoff.');
    host.hidden=!next.length&&!caseNode;
    if(key===pageKey && list.length===next.length && list.every((record,i)=>record===next[i]))return;
    if(key!==pageKey)search.value='';
    pageKey=key;note=node;list=next;
    search.hidden=!isIndex||!list.length;
    for(const el of [choices,title,body,footer])el.hidden=!list.length;
    if(!list.length){delete host.dataset.historyRecord;recordShown=null;pick.replaceChildren();count.textContent='';chart.hidden=outcome.hidden=insight.hidden=children.hidden=relations.hidden=true;return;}
    if(scope==='eth-merge')count.textContent=t(list.length+' 条',String(list.length));
    else {
      const newest=dateLabel(list[0].knownAt,list[0].precision);
      count.textContent=t(list.length+' 条 · 截至 '+newest,list.length+' · through '+newest);
    }
    if(caseNode)count.textContent=(effectiveScope==='all'?t('全网','All markets'):t('当前范围','This scope'))+' · '+list.length;
    if(!search.hidden)search.value=saved.get(key)?.query??search.value;
    const state=saved.get(key);
    paintChoices(state?.record,state?.child,state);
  }
  function paintChoices(preferred,detail=-1,state=null){
    const query=search.hidden?'':search.value.trim().toLowerCase();
    matches=query?list.filter(record=>{
      const fields=[record.title,record.topic,record.source,record.scopeKeys,record.body,record.trader?.actor];
      return fields.flat().some(value=>typeof value==='string' && value.toLowerCase().includes(query));
    }):list;
    if(!search.hidden)count.textContent=query?t(matches.length+' / '+list.length+' 条',matches.length+' / '+list.length):t(list.length+' 条',String(list.length));
    empty.hidden=Boolean(matches.length);
    if(!matches.length)empty.textContent=t('没有匹配的记忆。','No matching memories.');
    for(const el of [choices,title,body,footer])el.hidden=!matches.length;
    if(!matches.length){
      recordShown=null;delete host.dataset.historyRecord;pick.replaceChildren();
      chart.hidden=outcome.hidden=insight.hidden=children.hidden=relations.hidden=true;
      return;
    }
    const options=doc.createDocumentFragment();
    let year='',group;
    for(const record of [...matches].sort((a,b)=>Date.parse(b.eventAt)-Date.parse(a.eventAt))){
      const current=record.eventAt.slice(0,4);
      if(current!==year){year=current;group=doc.createElement('optgroup');group.label=year;options.append(group);}
      const option=doc.createElement('option');option.textContent=(record.trader?say(record.trader.amount)+' · ':'')+shortLabel(record);option.value=record.id;group.append(option);
    }
    pick.replaceChildren(options);
    const found=matches.find(item=>item.id===preferred);
    draw(found||defaultHistoryRecord(matches,note),found?detail:-1,found?state:null);
  }
  search.addEventListener('input',()=>{
    paintChoices(recordShown?.id);
    if(recordShown){remember();onInspect?.(recordShown.id,-1);}
    else saved.delete(pageKey);
  });
  show.open=(id,child)=>{
    let record=list.find(item=>item.id===id);
    if(!record && globalCases){globalCases=false;show(...args);record=list.find(item=>item.id===id);}
    if(record){
      if(!matches.includes(record)){search.value='';paintChoices(id,child);}
      else draw(record,child);
      remember();
    }
  };
  return show;
}
