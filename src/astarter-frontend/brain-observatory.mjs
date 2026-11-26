import {mountProofView} from './brain-proof-view.mjs';
import mergeBlockEvidence from './brain-evidence/BLOCK-15537394-AT-MERGE@1.json' with {type:'json'};
import {mountTradfiArchive} from './brain-tradfi-archive.mjs';
import {mountBlockArchive} from './brain-raw-archive.mjs';
import {mountMemory} from './brain-memory.mjs';
import {notes as mergeNotes,directions,detailEdges} from './brain-case-notes.mjs';
import {escapeUI} from './product-experience.mjs';
import {uiGlyph} from './product-composition.mjs';
import {cortexaView} from './brain-cortexa.mjs';
import {brainChainName} from './brain-research-scope.mjs';
import replay from './brain-merge-case.json' with {type:'json'};
import {mountThinking} from './brain-thinking.mjs';
import {createHalftoneFace} from './workbench-optical-header.mjs';
import {tokenIcon} from './brand-icons.mjs';
import {candlestickChart,sparkline} from './product-charts.mjs';
import snapshotCandles from './brain-evidence/COINBASE-ETH-USD-0644@1.json' with {type:'json'};
import reviewCandles from './brain-evidence/COINBASE-ETH-USD-0649@1.json' with {type:'json'};
const observation=replay.outcome.marketObservation;
const price=value=>Number(value).toLocaleString('en-US',{style:'currency',currency:observation.currency});
const charts = [snapshotCandles, [...snapshotCandles, ...reviewCandles]].map(rows => {
  const bars = [...rows].sort((a,b) => a[0]-b[0]).map(([time,low,high,open,close,volume]) =>
    ({time,low,high,open,close,volume}));
  return candlestickChart(bars, {width:460,height:234,period:'1m'});
});
const layers = [
  {key:'thinking', title:'Thinking Layer'},
  {key:'brain', title:'Brain Layer'},
  {key:'execution', title:'Execution Layer'}
];
const files={
 block:'https://etherscan.io/block/15537394',
 candles:'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=2022-09-15T06:42:00Z&end=2022-09-15T06:43:00Z',
 review:'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=2022-09-15T06:44:00Z&end=2022-09-15T06:48:00Z'
};
const pinned={block:'BLOCK-15537394@1',candles:'COINBASE-ETH-USD-0644@1',review:'COINBASE-ETH-USD-0649@1'};
const pinnedFile=key=>'/brain-evidence/'+pinned[key]+'.json';
const refIndex = new Map(replay.nodes.map((n,i)=>[n.ref,i]));
const coreEdges = [...replay.edges.map(({from,to})=>[refIndex.get(to),refIndex.get(from)]),...detailEdges];
const caseNotes=[
  {title:['盈利案例','Historical gains'],body:['查看公开账户的建仓、退出和可核对的收益。','Inspect public positions, exits and reported gains.'],group:'review',tone:'gain',level:2,color:'#6ed8a1',mapSite:[.34,.50],portraitParent:4},
  {title:['亏损案例','Historical losses'],body:['查看亏损发生的过程、仓位大小和损失口径。','Trace the position size, exit and loss basis.'],group:'review',tone:'loss',level:2,color:'#f68d9e',mapSite:[.58,.78],portraitParent:4}
];
class AstarterBrain extends HTMLElement {
  connectedCallback() {
    if(this.controller)return;
    this.dataset.view='cortexa';
    this.mount();
  }
  mount(){
    const root=this;
    const en=!this.dataset.locale?.startsWith('zh');
    const t=(zh,english)=>en?english:zh, say=value=>Array.isArray(value)?value[en?1:0]:value;
    let selection=cortexaView.initialSelection();
    const pageNotes=value=>[...(value?.research?.notes??mergeNotes),...caseNotes];
    let notes=pageNotes(selection);
    const edges=[...coreEdges,[0,14],[0,15],[3,14],[4,15]];
    const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
    const prefersLess=()=>motionQuery.matches || document.documentElement.dataset.reducedMotion==='true';
    const reduced=prefersLess();
    const iconButton=(attr,name,content)=>`<button type="button" class="brain-icon" ${attr} aria-label="${name}" title="${name}">${content}</button>`;
    const groupLegend=directions.map(g=>`<span><i style="--dot:var(--memory-${g.key},${g.color})"></i>${say(g.title)}</span>`).join('');
    const layerHeader = layer => `<header class="br-layer-head">
      <div class="br-layer-title"><h2 id="br-${layer.key}-title" lang="en">${layer.title}</h2></div></header>`;
    const nodeButtons=notes.map((n,i)=>`<button class="neuron" data-node="${i}" data-group="${n.group}" data-level="${n.level}" aria-label="${escapeUI(say(n.title))}"><i></i><span>${escapeUI(say(n.title))}</span></button>`).join('');
    const zoomButtons=`<div class="br-zoom">${iconButton('data-minus',t('缩小图谱','Zoom out'),'−')}<output data-zoom>100%</output>${iconButton('data-plus',t('放大图谱','Zoom in'),'+')}</div>`;
    const noteTabs=`<nav class="note-tabs" role="tablist" aria-label="${t('已打开的记忆','Open memories')}" hidden></nav>`;
    const reader=`<section class="br-reader" aria-label="${t('节点记忆','Node memory')}"><div id="br-memory-panel" role="tabpanel"><div class="note-heading">${uiGlyph('file')}<h3 id="br-memory-title" data-inspect-title></h3><span class="br-library">${t('Astarter 研究知识库','Astarter Knowledge Base')}</span></div><p data-inspect-copy></p><button type="button" class="br-replay-link" data-note-replay hidden></button><div class="ct-note-evidence" hidden><a data-inspect-source target="_blank" rel="noopener noreferrer"></a><time data-inspect-time hidden></time></div><section class="br-history" data-note-history hidden></section><div class="related"></div></div></section>`;
    const legend=`<div class="br-legend">${groupLegend}<span class="hierarchy"><i></i><i></i><i></i>${t('主题 / 分支 / 笔记','Topic / branch / note')}</span></div>`;
    const thinkingSection=`<section class="br-layer br-thinking" id="br-thinking" data-layer="thinking" aria-labelledby="br-thinking-title">
          ${layerHeader(layers[0])}<div data-thinking></div>
        </section>`;
    const executionSection=`<section class="br-layer br-execution" id="br-execution" data-layer="execution" aria-labelledby="br-execution-title">
          ${layerHeader(layers[2])}
          <nav class="br-execution-routes" aria-labelledby="br-execution-title">
            <a class="br-execution-route" data-brain-route="signals" href="?page=signals">
              <span class="br-route-name">${uiGlyph('pulse')}<strong>${t('智选信号','Smart Signals')}</strong></span>
              <span class="br-route-mode">${t('查看信号，自行下单','You place the order')}</span>
              <span class="br-route-status" data-signal></span>${uiGlyph('chevron')}
            </a>
            <a class="br-execution-route" data-brain-route="workbench" href="?page=workbench">
              <span class="br-route-name">${uiGlyph('orbit')}<strong>${t('AI 交易','LensWave')}</strong></span>
              <span class="br-route-mode">${t('授权后自动下单','Automated after authorization')}</span>
              <span class="br-route-status" data-lens></span>${uiGlyph('chevron')}
            </a>
          </nav>
          <section class="br-market"><div class="ops-section-heading"><h3>${t('参考行情','Spot Reference')}</h3><span>Coinbase · ETH/USD</span></div><div class="br-quote"><strong data-price></strong><span data-gain></span></div>
          <div class="br-chart"></div><div class="br-axis"><span>${t('数据截止','Data cutoff')}</span><span data-window></span></div></section>
          <a class="br-feedback" href="/paper-replay?lang=${en?'en':'zh'}">${uiGlyph('file')}<b>${t('模拟成交复盘','Paper trade review')}</b><span>BTC/USDT</span>${uiGlyph('chevron')}</a>
          <button type="button" class="br-feedback" data-return>${uiGlyph('history')}<b>${t('复盘回流','Memory return')}</b><span data-feedback></span>${uiGlyph('chevron')}</button>
        </section>`;
    const sections={brainLayerTitle:layers[1].title,thinkingSection,executionSection,nodeButtons,zoomButtons,noteTabs,reader,legend,t,en};
    root.innerHTML=`<link rel="stylesheet" href="/brain-observatory.css"><link rel="stylesheet" href="/brain-proof.css"><article class="brain-board ct-board">${cortexaView.markup(sections)}<section class="mem-section" tabindex="-1"></section><section class="br-proof" aria-labelledby="br-proof-title"></section><section class="br-proof br-backtest br-layer" id="backtest-review" aria-labelledby="br-backtest-title"></section><section class="br-proof br-learning br-layer" id="agent-learning" aria-labelledby="br-learning-title"></section></article>`;
    const q=s=>root.querySelector(s), all=s=>[...root.querySelectorAll(s)];
    const proof=mountProofView(q('.br-proof'),q('#backtest-review'),q('#agent-learning'),en);
    const faces=all('.lw-dot-face').map((el,i)=>createHalftoneFace(el,i===0));
    for(const domain of directions) q('.brain-board').style.setProperty('--brain-'+domain.key,domain.color);
    const markers=all('[data-node]'), tabs=q('.note-tabs'), related=q('.related');
    const notePanel=q('.ct-note-body');
    let readingOffsets=new Map();
    const notebooks=new Map();
    let lastPhase=-1, playing=!reduced, selected=0, zoom=1;
    let opened=[0];
    let graph;
    const blockArchive=mountBlockArchive(root,en);
    const disposeMarkets=mountTradfiArchive(root,en);
    const openLinkedArchive=()=>{
      const target={'#traditional-markets':'tradfi','#historical-blocks':'heading'}[location.hash];
      if(target&&root.isConnected&&!root.querySelector('dialog[open]'))root.querySelector('[data-raw-open="'+target+'"]')?.click();
    };
    window.addEventListener('hashchange',openLinkedArchive);
    queueMicrotask(openLinkedArchive);
    const mergeBlock={scopeKeys:['coin:ethereum'],blockHeight:mergeBlockEvidence.block.height,eventAt:mergeBlockEvidence.block.timestamp};
    const blockFallback=()=>!selection.research&&[0,1,5].includes(selected)?mergeBlock:null;
    const replayCutoff=()=>reviewNode()&&lastPhase===4?replay.reviewAsOf:replay.decisionCutoff;
    const historyHost=q('[data-note-history]'),replayAction=q('[data-note-replay]');
    const reviewNode=()=>!selection?.research && [4,11,12,13].includes(selected);
    replayAction.onclick=()=>thinking.seek(lastPhase===4?0:4);
    let historyView=null,historyLoading=false,makeStars=null,starKey='';
    function syncHistory(){
      if(!historyHost.isConnected || zoom<1.6)return;
      if(reviewNode() && lastPhase!==4){
        historyHost.hidden=true;
        return;
      }
      if(historyView){
        historyHost.hidden=false;
        const archive=!selection?.research;
        const cutoff=archive
          ?([4,11,12,13].includes(selected)?replay.reviewAsOf:replay.decisionCutoff)
          :new Date().toISOString();
        const scope=archive?'eth-merge':selection.key,chain=selection?.asset?.chain;
        const key=scope+'/'+(archive?cutoff:'current');
        historyView(scope,selected,cutoff,chain);
        if(graph?.setEvidence && starKey!==key){
          starKey=key;
          graph.setEvidence(makeStars(scope,cutoff,chain,en),item=>{
            showNote(item.parent);
            historyView.open(item.record,item.child);
            const target=item.child>=0?historyHost.querySelector('[data-child-detail]'):
              historyHost.querySelector('[data-case-outcome]:not([hidden])')||historyHost.querySelector('[data-history-choices]:not([hidden]),[data-history-title]:not([hidden])');
            if(target && notePanel){
              const delta=target.getBoundingClientRect().top-notePanel.getBoundingClientRect().top;
              if(delta>notePanel.clientHeight*.65 || delta<0)notePanel.scrollTop+=delta-16;
            }
          });
        }
        return;
      }
      if(historyLoading)return;
      historyLoading=true;
      import('./brain-history-reader.mjs').then(({mountHistoryReader,graphEvidence})=>{
        if(!historyHost.isConnected)return;
        historyView=mountHistoryReader(historyHost,en,(id,child)=>graph?.focusEvidence?.(id,child),
          record=>blockArchive.record(record,blockFallback()));makeStars=graphEvidence;
        syncHistory();
      }).catch(()=>{
        if(!historyHost.isConnected)return;
        const retry=document.createElement('button');
        retry.type='button';retry.textContent=t('重新加载历史依据','Reload historical evidence');
        retry.onclick=syncHistory;
        historyHost.hidden=false;historyHost.replaceChildren(retry);
      }).finally(()=>{historyLoading=false;});
    }
    function showNote(i,restore=false) {
      const changed=i!==selected;
      if(changed && notePanel) readingOffsets.set(selected,notePanel.scrollTop);
      selected=i;
      blockArchive.update(selection.key,i,selection.research?null:replayCutoff(),blockFallback());
      if(!opened.includes(i)) opened.push(i);
      const n=notes[i];
      markers.forEach((b,k)=>b.setAttribute('aria-pressed',String(k===i)));
      const heading=q('[data-inspect-title]'),body=q('[data-inspect-copy]');
      if(heading.textContent!==say(n.title))heading.textContent=say(n.title);
      const pending=reviewNode() && lastPhase!==4;
      const copy=pending?t('当前快照为 06:44 UTC，复盘窗口在 06:49 结束。','The snapshot is at 06:44 UTC. The review window closes at 06:49.'):say(n.body);
      if(body.textContent!==copy)body.textContent=copy;
      replayAction.hidden=!reviewNode();
      if(reviewNode())replayAction.textContent=pending?t('查看 06:49 复盘','Open 06:49 review'):t('回到 06:44 快照','Return to 06:44 snapshot');
      const source=q('[data-inspect-source]');
      if(source){
        source.parentElement.hidden=!n.sourceUrl;
        if(n.sourceUrl){
          const asset=selection.research.asset;
          source.href=n.sourceUrl;source.textContent=(asset.provider||t('来源','Source'))+' ↗';
          const stamp=asset.asOf||asset.receivedAt;
          const time=q('[data-inspect-time]');
          time.hidden=!stamp;
          if(stamp){
            time.dateTime=stamp;
            time.textContent=(asset.asOf?t('数据时间','As of'):t('采集时间','Captured'))+' '+stamp.slice(0,16).replace('T',' ')+' UTC';
          }
        }
        else source.removeAttribute('href');
      }
      tabs.hidden=opened.length<2;
      for(const index of opened) {
        const existing=tabs.querySelector(`[data-note="${index}"]`);
        if(existing){
          const label=say(notes[index].title);
          if(existing.textContent!==label)existing.textContent=label;
          continue;
        }
        const btn=document.createElement('button');
        btn.dataset.note=String(index);btn.textContent=say(notes[index].title);
        btn.type='button';btn.id='br-memory-tab-'+index;btn.setAttribute('role','tab');
        btn.setAttribute('aria-controls','br-memory-panel');
        btn.onclick=()=>showNote(index);tabs.append(btn);
      }
      for(const btn of tabs.children){
        const current=Number(btn.dataset.note)===i;
        btn.setAttribute('aria-selected',String(current));
        btn.tabIndex=current?0:-1;
      }
      q('#br-memory-panel').setAttribute('aria-labelledby',tabs.hidden?'br-memory-title':'br-memory-tab-'+i);
      const adjacent=edges.filter(([a,b])=>a===i||b===i).map(([a,b])=>a===i?b:a);
      const links=related.querySelectorAll('button');
      if(links.length!==adjacent.length || adjacent.some((k,j)=>links[j].dataset.related!==String(k) || links[j].textContent!==say(notes[k].title))){
        related.innerHTML=`<span>${t('相关记忆','Related memories')}</span>`+adjacent.map(k=>`<button data-related="${k}">${escapeUI(say(notes[k].title))}</button>`).join('');
      }
      syncHistory();
      if((changed||restore) && notePanel){
        notePanel.scrollTop=readingOffsets.get(i)??0;
        if(tabs.scrollWidth>tabs.clientWidth){
          const strip=tabs.getBoundingClientRect();
          const active=tabs.querySelector('[aria-selected=true]').getBoundingClientRect();
          // Move only the tab strip, keeping the graph and page under the pointer.
          if(active.left<strip.left) tabs.scrollLeft+=active.left-strip.left;
          else if(active.right>strip.right) tabs.scrollLeft+=active.right-strip.right;
        }
      }
      graph?.setState(selected,playing);
    }
    tabs.onkeydown=event=>{
      const pos=opened.indexOf(selected), n=opened.length;
      const next={ArrowLeft:(pos+n-1)%n, ArrowRight:(pos+1)%n, Home:0, End:n-1}[event.key];
      if(next===undefined || event.altKey || event.ctrlKey || event.metaKey)return;
      event.preventDefault();
      showNote(opened[next]);
      tabs.querySelector('[aria-selected=true]').focus({preventScroll:true});
    };
    related.onclick=e=>{const btn=e.target.closest('[data-related]');if(btn){showNote(+btn.dataset.related);q(`[data-note="${selected}"]`)?.focus({preventScroll:true});}};
    function showZoom(n) {
      const opening=zoom<1.6 && n>=1.6;
      zoom=n;
      if(opening)syncHistory();
      q('[data-minus]').disabled=n<=cortexaView.minZoom+.001;q('[data-plus]').disabled=n>=cortexaView.maxZoom-.001;
      const lensLabel=q('[data-lens-toggle] span');
      const label=n<1.6?t('探索','Explore'):t('返回','Back');
      const labelText=lensLabel.firstChild;
      if(!labelText) lensLabel.append(label);
      else if(labelText.data!==label) labelText.data=label;
      q('.space').dataset.expanded=String(n>=1.6);
    }
    graph=cortexaView.mountGraph(q('.space>canvas'),markers,edges,reduced,showNote,showZoom,notes);
    q('[data-plus]').onclick=()=>graph.stepZoom(1);
    q('[data-minus]').onclick=()=>graph.stepZoom(-1);
    q('[data-lens-toggle]').onclick=()=>graph.setZoom(zoom<1.6?2.1:1);
    const board=q('.brain-board');
    const marketSection=q('.br-market');
    const archiveMarket=marketSection.innerHTML;
    const usd=value=>Number.isFinite(value)?Number(value).toLocaleString('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:7}):'—';
    const percent=new Intl.NumberFormat(en?'en-US':'zh-CN',{maximumFractionDigits:2,signDisplay:'exceptZero'});
    function renderMarketRows(table,rows){
      const body=table.tBodies[0];
      const scale=Math.max(0,...rows.map(row=>Number.isFinite(row.change)?Math.abs(row.change):0));
      while(body.rows.length>rows.length)body.deleteRow(-1);
      rows.forEach((item,i)=>{
        const row=body.rows[i]??body.insertRow();
        if(!row.cells.length){
          row.innerHTML='<th scope="row"></th><td></td><td><i aria-hidden="true"></i><span></span></td>';
        }
        const [asset,price,change]=row.cells;
        const identity=JSON.stringify([item.id,item.symbol,item.chain]);
        if(asset.dataset.identity!==identity){
          asset.dataset.identity=identity;
          asset.innerHTML=`<span>${tokenIcon(item,{size:18})}<b>${escapeUI(item.symbol)}</b>${item.chain?`<small>${escapeUI(brainChainName(item.chain))}</small>`:''}</span>`;
          asset.title=[item.name,brainChainName(item.chain)].filter(Boolean).join(' · ');
        }
        price.textContent=usd(item.price);
        const measured=Number.isFinite(item.change);
        change.dataset.direction=measured?String(Math.sign(item.change)):'';
        change.lastElementChild.textContent=measured?percent.format(item.change)+'%':'—';
        change.firstElementChild.hidden=!measured;
        change.style.setProperty('--change-width',(measured&&scale?50*Math.abs(item.change)/scale:0)+'%');
      });
      table.hidden=!rows.length;
      table.nextElementSibling.hidden=Boolean(rows.length);
    }
    function renderScopeMarket(scope){
      const asset=scope.asset;
      const isPool=asset?.kind==='contract';
      const kind=asset?'asset':'network';
      if(marketSection.dataset.kind!==kind){
        marketSection.dataset.kind=kind;
        marketSection.innerHTML=`<div class="ops-section-heading"><h3>${t('行情快照','Market Snapshot')}</h3><span></span></div>
          ${asset?`<div class="br-quote"><strong data-price></strong><div class="br-price-trend" hidden><span>7D</span><div data-trend-chart></div></div></div><dl class="ct-quote-table"></dl>`:
          `<table class="br-market-list"><thead><tr><th scope="col">${t('资产','Asset')}</th><th scope="col">${t('价格','Price')}</th><th scope="col">${t('24h 涨跌','24h change')}</th></tr></thead><tbody></tbody></table><p hidden>${t('暂无报价','Quotes unavailable')}</p>`}
          <div class="br-axis"><span>${t('采集时间','Captured')}</span><time></time></div>`;
      }
      const write=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
      write(marketSection.querySelector('.ops-section-heading span'),say(scope.marketLabel));
      if(asset){
        write(marketSection.querySelector('[data-price]'),usd(asset.price));
        const trend=marketSection.querySelector('.br-price-trend');
        const series=Array.isArray(asset.series)?asset.series.filter(value=>Number.isFinite(value) && value>0):[];
        trend.hidden=series.length<2;
        const seriesKey=series.join(',');
        if(trend.renderedSeries!==seriesKey){
          trend.renderedSeries=seriesKey;
          const chart=trend.querySelector('[data-trend-chart]');
          if(trend.hidden){
            chart.replaceChildren();
          }else {
            const first=series[0],last=series.at(-1);
            trend.dataset.direction=String(Math.sign(last-first));
            chart.innerHTML=sparkline(series,{width:250,height:76,color:'var(--chart-accent)'});
            chart.firstElementChild.setAttribute('aria-label',t(`7 日走势，从 ${usd(first)} 至 ${usd(last)}`,`7-day price trend, ${usd(first)} to ${usd(last)}`));
          }
        }
      }
      if(asset){
        const metrics=[
          [t('24h 涨跌','24h change'),say(scope.change)],
          [isPool?t('池内 24h 成交额','Pool 24h volume'):t('24h 成交额','24h volume'),say(scope.volume)],
          [isPool?t('池内流动性','Pool liquidity'):t('流动性','Liquidity'),say(scope.liquidity)]
        ];
        const table=marketSection.querySelector('dl');
        metrics.forEach(([label,value],i)=>{
          let row=table.children[i];
          if(!row){row=document.createElement('div');row.append(document.createElement('dt'),document.createElement('dd'));table.append(row);}
          row.dataset.direction=String(i===0 && Number.isFinite(asset.change)?Math.sign(asset.change):0);
          write(row.firstElementChild,label);write(row.lastElementChild,value);
        });
      }else renderMarketRows(marketSection.querySelector('table'),scope.marketRows.slice(0,5));
      const time=marketSection.querySelector('time');
      write(time,scope.asOf?scope.asOf.slice(0,16).replace('T',' ')+' UTC':'—');
      if(scope.asOf)time.dateTime=scope.asOf;else time.removeAttribute('datetime');
      write(q('[data-signal]'),'');
      write(q('[data-lens]'),'');
      q('[data-feedback]').textContent=t('查看 A18 记忆','Open A18 memory');
    }
    function paintPhase(phase,active,step){
      if(playing!==active || lastPhase<0){
        playing=active;
        board.dataset.playing=String(active);
        graph.setState(selected,playing);
      }
      const reviewing=phase===4;
      // Replay publishes at "Show signal" and saves the review at "Archive review".
      const published=phase>3 || (phase===3 && step>=4);
      const filed=reviewing && step>=8;
      const status=filed?'filed':reviewing?'review':published?'published':phase===3?'ready':'pending';
      if(status!==board.dataset.status){
        board.dataset.status=status;
        q('[data-signal]').textContent=reviewing?t('观察到期','Watch expired'):published?t('已展示 · 观察','Published · watch'):phase===3?t('待发布','Pending publication'):t('待研判','Awaiting review');
        q('[data-lens]').textContent=published?t('未授权 · 无订单','No mandate · no orders'):t('等待策略','Awaiting strategy');
        q('[data-feedback]').textContent=filed?t('已归档','Filed'):reviewing?t('复盘中','In review'):t('等待到期','Pending expiry');
      }
      if(phase===lastPhase)return;
      if(lastPhase>=0) graph.signal?.(phase);
      const reviewChanged=lastPhase<0 || (lastPhase===4)!==reviewing;
      lastPhase=phase;
      if(reviewNode() && reviewChanged)showNote(selected);
      board.dataset.phase=String(phase);
      q('[data-price]').textContent=price(reviewing?observation.endClose:observation.startClose);
      q('[data-gain]').textContent=reviewing?'+'+observation.changePct+'%':'';
      q('[data-window]').textContent=(reviewing?replay.reviewAsOf:replay.decisionCutoff).slice(11,16)+' UTC';
      const chart=q('.br-chart');
      const period=reviewing?'review':'snapshot';
      if(chart.dataset.period!==period){
        chart.dataset.period=period;
        chart.innerHTML=charts[reviewing?1:0];
        const count=snapshotCandles.length+(reviewing?reviewCandles.length:0);
        chart.querySelector('svg').setAttribute('aria-label',t(`Coinbase ETH/USD，${count} 根一分钟 K 线与成交量`,`Coinbase ETH/USD, ${count} one-minute candles and volume`));
      }
    }
    const scrollTo=el=>el.scrollIntoView({behavior:prefersLess()?'instant':'smooth',block:'start'});
    let memory,thinking;
    function mountWorkspace(playback){
      proof.setScope(selection.key,selection.asset?.symbol);
      thinking?.dispose();
      const scope=selection?.research;
      lastPhase=-1;
      delete board.dataset.status;
      marketSection.classList.toggle('ct-scope-market',Boolean(scope));
      if(scope)renderScopeMarket(scope);else {delete marketSection.dataset.kind;marketSection.innerHTML=archiveMarket;}
      if(!memory?.refreshSnapshot(scope?.memory)){
        memory?.dispose();
        memory=mountMemory(q('.mem-section'),{en,pinnedFile,files,researchScope:scope?.memory,getNodes:()=>notes,
          onOpenNode:index=>{graph.openNode(index);scrollTo(q('.ct-hero'));},onBack:()=>{
          scrollTo(q('.ct-hero'));q('[data-lens-toggle]').focus({preventScroll:true});
        }});
      }
      thinking=mountThinking(q('[data-thinking]'),{en,reduced:prefersLess(),tape:scope?.tape,playback,onPhaseChange:scope?(phase,active)=>{
        board.dataset.phase=String(phase);board.dataset.playing=String(active);graph.setState(selected,active);
      }:paintPhase});
    }
    function updateSelection(next){
      const changed=selection?.key!==next.key;
      if(!changed && selection===next)return;
      let playback=thinking?.getPlaybackState?.();
      const focused=document.activeElement;
      const activeRole=!changed?focused?.closest('.mw-seat')?.dataset.roleId:null;
      const activeRelated=!changed?focused?.closest('[data-related]')?.dataset.related:null;
      const activeToggle=!changed&&focused?.matches('.ast-thinking__toggle');
      const activePhase=!changed?focused?.closest('.ast-thinking__stop')?.dataset.phaseIndex:null;
      if(changed){
        readingOffsets.set(selected,notePanel.scrollTop);
        notebooks.delete(selection.key);
        notebooks.set(selection.key,{selected,opened,offsets:readingOffsets,playback});
        if(notebooks.size>64)notebooks.delete(notebooks.keys().next().value);
        const saved=notebooks.get(next.key);
        playback=saved?.playback;
        selected=saved?.selected??0;opened=saved?.opened??[0];readingOffsets=saved?.offsets??new Map();
        tabs.replaceChildren();
      }
      selection=next;
      notes=pageNotes(next);
      markers.forEach((node,i)=>{
        const title=say(notes[i].title);
        node.setAttribute('aria-label',title);node.querySelector('span').textContent=title;
      });
      showNote(selected,changed);mountWorkspace(playback);
      if(activeRole)q(`.mw-seat[data-role-id="${activeRole}"]`)?.focus({preventScroll:true});
      else if(activeToggle)q('.ast-thinking__toggle')?.focus({preventScroll:true});
      else if(activePhase!=null)q(`.ast-thinking__stop[data-phase-index="${activePhase}"]`)?.focus({preventScroll:true});
      else if(activeRelated)q(`[data-related="${activeRelated}"]`)?.focus({preventScroll:true});
    }
    mountWorkspace();
    function showMemory(section){section.focus({preventScroll:true});scrollTo(section);}
    const disposeScene=cortexaView.connect(root);
    const disposePicker=cortexaView.bindSelection(root,selection,updateSelection);
    q('[data-return]').onclick=()=>{thinking.seek(4);showMemory(memory.selectReview());};
    this.controller=()=>{window.removeEventListener('hashchange',openLinkedArchive);disposeMarkets();blockArchive.dispose();proof.dispose();disposePicker();disposeScene();thinking.dispose();memory.dispose();graph.dispose();faces.forEach(f=>f.dispose());};
    showZoom(1);showNote(0);
    graph.setZoom(2.1);
  }
  disconnectedCallback(){this.controller?.();this.controller=null;}
}
customElements.define('astarter-brain',AstarterBrain);
