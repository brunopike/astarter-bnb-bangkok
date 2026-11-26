import test from 'node:test';
import assert from 'node:assert/strict';
import {CRYPTO} from './data-center-fixtures.mjs';
import {createDataCenter,DERIVATIVE_VIEWS} from './data-center.mjs';
import {liveDataRoute} from './data-live-views.mjs';
import {DERIVATIVE_VIEWS as LIVE_VIEWS,DERIVATIVE_SYMBOLS,publicDerivativesRequest} from './public-market-extended.mjs';

// Address text that is not a known derivatives view, asset or exchange must never reach the page as markup.
// The page has two paths: live data (the default) and preset data (data=demo). Each test checks both.
const MARKER='<b data-probe="dc">probe</b>';
// The live path upper-cases the asset, so the marker is matched without regard to case.
const PROBE=/data-probe/i,MARKUP=/<b data-probe/i,DEMO='&data=demo';
// The same four views: source keys on the live path, labels on the preset path.
const LABEL={funding:'资金费率',oi:'持仓量',liquidation:'清算',ratio:'多空比'};
const LIVE_NAV=/<nav class="dc-section-nav" aria-label="合约指标">([\s\S]*?)<\/nav>/,DEMO_NAV=/<nav class="dc-section-nav" aria-label="合约数据分类">([\s\S]*?)<\/nav>/;
const selected=(html,nav)=>{const link=(html.match(nav)?.[1]??'').match(/<a class="selected" data-dc-link href="\?([^"]*)">/);return link?new URLSearchParams(link[1]).get('view'):null;};

const renderAt=search=>{
 const old=globalThis.location;
 try{
  globalThis.location=new URL('http://localhost/?page=derivatives'+search);
  return createDataCenter({root:{scrollTop:0},rerender(){},notify(){},onResearch(){}}).render('derivatives');
 }finally{if(old)globalThis.location=old;else delete globalThis.location;}
};

// The address travels in one link on each page: "Preset" on the live page and "Read-only data"
// on the preset page. URLSearchParams encodes every markup character in that href, so the copy there is inert.
// Address text may appear nowhere else on the page.
const SWITCH=/<a class="dc-button" data-dc-link href="\?([^"]*)">(?:预设|只读数据)<\/a>/g;
function outsideSwitch(html,carried={}){
 const links=[...html.matchAll(SWITCH)];
 assert.equal(links.length,1,'one link to the other data path');
 assert.match(links[0][1],/^[A-Za-z0-9%+*._&=-]*$/,'the carried address is URL-encoded');
 const query=new URLSearchParams(links[0][1]);
 for(const [key,value] of Object.entries(carried))assert.equal(query.get(key),value,key);
 return html.replace(SWITCH,'');
}

// The live page as a visible browser tab loads it: the relay answers with `reply(query)`, or 503 when it returns nothing.
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function renderLive(search,reply=()=>null){
 const names=['location','document','navigator','fetch'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const requests=[];
 try{
  const stubs={location:new URL('http://localhost/?page=derivatives'+search),navigator:{onLine:true},
   document:{hidden:false,activeElement:null,body:{},addEventListener(){},querySelector(){return null;}},
   fetch:async url=>{
    const query=Object.fromEntries(new URL(url,'http://localhost').searchParams);requests.push(query);
    const body=reply(query);
    return body?Response.json({schema:'public-market-relay-v1',resource:query.resource,receivedAt:Date.now(),body}):new Response('{}',{status:503});
   }};
  for(const [name,value] of Object.entries(stubs))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  const root={scrollTop:0,contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}};
  const ui=createDataCenter({root,rerender(){},notify(){},onResearch(){}});
  ui.render('derivatives');await settle();await settle();
  return {html:ui.render('derivatives'),requests};
 }finally{for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
}
const derivativeBody=({view,symbol})=>{
 const at=Date.now()-1000;
 const rows=view==='liquidation'?[{at,position:'long',size:1,bankruptcyPrice:100}]:[{at:at-1000,value:1},{at,value:2}];
 return {source:'OKX',symbol,view,instrument:view==='ratio'?null:symbol+'-USDT-SWAP',rows,current:null};
};

test('derivatives view list is the four known views',()=>{
 assert.deepEqual(DERIVATIVE_VIEWS,['资金费率','持仓量','清算','多空比']);
 assert.deepEqual(LIVE_VIEWS,['funding','oi','liquidation','ratio']);
 assert.deepEqual(LIVE_VIEWS.map(key=>LABEL[key]),DERIVATIVE_VIEWS);
});

test('unknown derivatives view from the address falls back to the default view',async()=>{
 const symbol=CRYPTO[0].symbol;
 const searches=['&view='+encodeURIComponent(MARKER),'&view='+encodeURIComponent(MARKER)+'&asset='+symbol,'&view='+encodeURIComponent(MARKER)+'&exchange=Binance'];
 for(const search of searches){
  const html=renderAt(search+DEMO);
  assert.doesNotMatch(outsideSwitch(html,{view:MARKER}),PROBE,search);
  assert.doesNotMatch(html,MARKUP,search);
  assert.ok(html.includes(`<h2>${symbol} · 资金费率历史</h2>`),search);
 }
 assert.match(renderAt('&view='+encodeURIComponent(MARKER)+DEMO),/dc-funding-top/);
 // Live path.
 for(const search of searches){
  const html=renderAt(search);
  assert.doesNotMatch(outsideSwitch(html,{view:MARKER}),PROBE,search);
  assert.doesNotMatch(html,MARKUP,search);
  assert.equal(liveDataRoute('derivatives',search).query.view,'funding',search);
  assert.equal(selected(html,LIVE_NAV),'funding',search);
  assert.ok(html.includes(`<h2>${LABEL.funding}</h2>`),search);
 }
 const live=await renderLive('&view='+encodeURIComponent(MARKER),derivativeBody);
 assert.deepEqual(live.requests,[{resource:'derivatives',view:'funding',symbol}]);
 assert.doesNotMatch(outsideSwitch(live.html,{view:MARKER}),PROBE);
 assert.ok(live.html.includes(`<h2>${symbol}-USDT-SWAP · ${LABEL.funding}</h2>`));
});

test('known derivatives views still render their own titles as plain text',async()=>{
 const symbol=CRYPTO[0].symbol;
 assert.ok(DERIVATIVE_SYMBOLS.includes(symbol));
 for(const view of DERIVATIVE_VIEWS){
  const html=renderAt('&view='+encodeURIComponent(view)+'&asset='+symbol+DEMO);
  assert.ok(html.includes(`<h1>${symbol} · ${view}</h1>`),view);
  assert.ok(html.includes(`<h2>${symbol} · ${view}历史</h2>`),view);
  assert.ok(html.includes(`← ${view}总览`),view);
 }
 // Live path: the source key or the preset label opens the view, and its label is the title.
 for(const key of LIVE_VIEWS)for(const view of [key,LABEL[key]]){
  const search='&view='+encodeURIComponent(view)+'&asset='+symbol,html=renderAt(search);
  assert.equal(selected(html,LIVE_NAV),key,view);
  assert.ok(html.includes(`<h2>${LABEL[key]}</h2>`),view);
  const live=await renderLive(search,derivativeBody);
  assert.deepEqual(live.requests,[{resource:'derivatives',view:key,symbol}],view);
  assert.ok(live.html.includes(`<h2>${key==='ratio'?symbol:symbol+'-USDT-SWAP'} · ${LABEL[key]}</h2>`),view);
 }
});

test('unknown exchange or asset from the address leaves no trace on the derivatives page',async()=>{
 const symbol=CRYPTO[0].symbol;
 const exchangeOnly=renderAt('&exchange='+encodeURIComponent(MARKER)+DEMO);
 assert.doesNotMatch(outsideSwitch(exchangeOnly,{exchange:MARKER}),PROBE);
 assert.ok(exchangeOnly.includes(`<h2>${symbol} · 资金费率历史</h2>`));
 for(const [search,carried] of [['&asset='+symbol+'&exchange='+encodeURIComponent(MARKER),{exchange:MARKER}],['&asset='+encodeURIComponent(MARKER),{asset:MARKER}]]){
  const html=renderAt(search+DEMO);
  assert.doesNotMatch(outsideSwitch(html,carried),PROBE,search);
  assert.ok(html.includes(`<h1>${symbol} · 资金费率</h1>`),search);
  assert.ok(html.includes('<span>全部交易所</span>'),search);
  assert.ok(html.includes(`<option selected>${symbol}</option>`),search);
 }
 // Live path: an unknown venue or asset has no data connection, so nothing is requested and nothing from the address is shown.
 for(const [search,carried] of [['&exchange='+encodeURIComponent(MARKER),{exchange:MARKER}],['&asset='+symbol+'&exchange='+encodeURIComponent(MARKER),{exchange:MARKER}],['&asset='+encodeURIComponent(MARKER),{asset:MARKER}]]){
  const html=renderAt(search);
  assert.doesNotMatch(outsideSwitch(html,carried),PROBE,search);
  assert.doesNotMatch(html,MARKUP,search);
  assert.equal(liveDataRoute('derivatives',search).resource,null,search);
  assert.ok(html.includes(`<h2>${LABEL.funding}</h2>`),search);
  assert.ok(html.includes('当前交易所或标的暂无数据连接'),search);
  assert.ok(html.includes(`>查看 OKX ${symbol}</a>`),search);
  const live=await renderLive(search,derivativeBody);
  assert.deepEqual(live.requests,[],search);
  assert.doesNotMatch(outsideSwitch(live.html,carried),PROBE,search);
 }
});

test('the live derivatives page shows a source instrument name only after the relay check accepts it',async()=>{
 // The section title writes the instrument as given, so the response check is what keeps outside text out.
 const live=await renderLive('&asset=BTC',query=>({...derivativeBody(query),instrument:MARKER}));
 assert.equal(live.requests.length,1);
 assert.doesNotMatch(outsideSwitch(live.html),PROBE);
 assert.match(live.html,/来源暂不可用/);
 assert.match(live.html,/数据暂不可用/);
});

test('accepted derivatives views are exactly the views the page navigation links to',()=>{
 const views=html=>[...html.matchAll(/href="\?([^"]*)"/g)].map(m=>new URLSearchParams(m[1].replaceAll('&amp;','&'))).filter(p=>p.get('page')==='derivatives'&&p.has('view'));
 // A link opens its view on the path it leads to: the preset path with data=demo, the live path otherwise.
 const keyOf=view=>Object.keys(LABEL).find(key=>key===view||LABEL[key]===view);
 const opens=p=>p.get('data')==='demo'?selected(renderAt('&view='+encodeURIComponent(p.get('view'))+DEMO),DEMO_NAV):liveDataRoute('derivatives',p).query.view;
 const meant=p=>p.get('data')==='demo'?LABEL[keyOf(p.get('view'))]:keyOf(p.get('view'));
 const demoNav=renderAt(DEMO).match(DEMO_NAV);
 assert.ok(demoNav);
 assert.deepEqual(views(demoNav[1]).map(p=>p.get('view')),DERIVATIVE_VIEWS);
 for(const view of DERIVATIVE_VIEWS)for(const search of ['&view='+encodeURIComponent(view),'&view='+encodeURIComponent(view)+'&asset='+CRYPTO[0].symbol])
  for(const p of views(renderAt(search+DEMO))){
   assert.ok(DERIVATIVE_VIEWS.includes(p.get('view')),search+' -> '+p);
   assert.equal(opens(p),meant(p),search+' -> '+p);
  }
 // Live path. The relay also accepts the cross-venue liquidations view (BTC, ETH and SOL), outside DERIVATIVE_VIEWS.
 const liveLinked=[...LIVE_VIEWS,'venue-liquidations'];
 const accepted=view=>publicDerivativesRequest(new URLSearchParams({view,symbol:CRYPTO[0].symbol}))!==null;
 assert.deepEqual(liveLinked.filter(view=>!accepted(view)),[]);
 const liveNav=renderAt('').match(LIVE_NAV);
 assert.ok(liveNav);
 assert.deepEqual(views(liveNav[1]).map(p=>p.get('view')),liveLinked);
 for(const view of liveLinked)for(const search of ['&view='+view,'&view='+view+'&asset='+CRYPTO[0].symbol])
  for(const p of views(renderAt(search))){
   assert.ok(liveLinked.includes(p.get('view')),search+' -> '+p);
   // Today: the Preset has no cross-venue view, so this one Preset link opens the default Preset view (Funding rates).
   if(p.get('data')==='demo'&&p.get('view')==='venue-liquidations'){assert.equal(opens(p),LABEL.funding,search+' -> '+p);continue;}
   assert.equal(opens(p),meant(p)??p.get('view'),search+' -> '+p);
  }
});
