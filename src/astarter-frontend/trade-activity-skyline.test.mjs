import test from 'node:test';
import assert from 'node:assert/strict';
import {activityOrders,skylineGeometry,tradeActivityView,mountTradeActivity} from './trade-activity-skyline.mjs';
const entry=(id,patch={})=>({kind:'trade',item:{id,accountId:'SIM-01',runId:'A',market:'BTC/USDT',side:'buy',status:'filled',qty:2,price:10,filled:1,...patch}});

test('confirmed fill values deduplicate orders, preserve cancelled partial fills and exclude strategy events',()=>{
 const a=entry('1'),partial=entry('2',{side:'sell',filled:.5,status:'partial-cancelled'}),m=activityOrders([a,a,partial,{kind:'strategy',item:{at:42,text:'策略已暂停'}}]);
 assert.equal(m.total,2);assert.equal(m.amount,30);assert.equal(m.shown,2);assert.equal(m.groups[0].amount,10);assert.equal(JSON.stringify(m).includes('1970'),false);
 assert.match(tradeActivityView([partial]),/部分成交后撤销/);
});
test('unknown, invalid fills and unsupported quotes are explicit rather than zero dollars',()=>{
 const m=activityOrders([entry('1',{status:'unknown',filled:0}),entry('2',{filled:NaN}),entry('3',{market:'ETH/BTC',currency:'BTC'}),entry('4',{status:'unknown',filled:.25}),entry('5',{filled:null})]);
 assert.equal(m.unpriced,4);assert.equal(m.amount,5);assert.equal(m.groups.find(o=>o.id==='1').amount,null);assert.equal(m.groups.find(o=>o.id==='3').quoted,20);
 const html=tradeActivityView([entry('1',{status:'unknown',filled:0}),entry('3',{market:'ETH/BTC',currency:'BTC'})]);assert.match(html,/成交额待确认/);assert.match(html,/20 BTC/);assert.match(html,/未折算/);
 assert.equal(activityOrders([entry('unknown',{status:'unknown',filled:0})]).amount,null);
 assert.match(html,/已成交额 — USD eq\./);
 assert.equal(activityOrders([entry('unknown-side',{side:'unverified'})]).groups[0].kind,'other');
});
test('filtered scope and recent cap preserve exact order lookup rather than inventing dates',()=>{
 const m=activityOrders(Array.from({length:90},(_,i)=>entry('ORDER-'+i)));assert.equal(m.total,90);assert.equal(m.shown,84);assert.equal(m.groups[0].id,'ORDER-83');
 const html=tradeActivityView([entry('EXACT-1',{market:'SOL/USDT',side:'sell'})],{query:'SOL',side:'卖出'});assert.match(html,/data-activity-query="EXACT-1"/);assert.match(html,/data-activity-side="全部"/);assert.match(html,/data-activity-reset/);assert.doesNotMatch(html,/win rate|1970|streak|利润/);
});
test('empty/strategy-only states and source labels remain truthful and escaped',()=>{
 const empty=tradeActivityView([]);assert.match(empty,/暂无交易足迹/);assert.doesNotMatch(empty,/data-activity-cell=/);
 assert.equal(tradeActivityView([],{filter:'策略操作'}),'');assert.equal(activityOrders([entry('1'),entry('1',{accountId:'OTHER'})]).total,2);
 const html=tradeActivityView([entry('<img onerror=1>',{market:'<b>USDT</b>'})]);assert.doesNotMatch(html,/<img|<b>/);assert.match(html,/&lt;img onerror=1&gt;/);
});
test('flat and isometric views share finite geometry including single, zero and empty scenes',()=>{
 const groups=activityOrders([entry('1'),entry('2',{side:'sell',filled:.5})]).groups;
 const flat=skylineGeometry(groups,0),iso=skylineGeometry(groups,1);assert.equal(flat.length,2);assert.equal(iso.length,2);assert.notDeepEqual(flat[0].paths,iso[0].paths);assert.equal(JSON.stringify(iso).includes('NaN'),false);assert.deepEqual(skylineGeometry([],1),[]);assert.equal(skylineGeometry(groups.slice(0,1),1).length,1);assert.equal(JSON.stringify(skylineGeometry([{count:0,x:0,y:0}],1)).includes('NaN'),false);
});
test('mount settles hidden/product/OS reduced motion and disposes its short animation and observers',()=>{
 const keys=['document','matchMedia','ResizeObserver','MutationObserver','requestAnimationFrame','cancelAnimationFrame'],previous=Object.fromEntries(keys.map(k=>[k,globalThis[k]])),frames=new Map();let seq=0,settings,resize,picked;
 class Element extends EventTarget{constructor(dataset={}){super();this.dataset=dataset;this.attrs={};}setAttribute(k,v){this.attrs[k]=v;}focus(){this.dispatchEvent(new Event('focus'));}}
 const paths=[new Element(),new Element(),new Element()],cell=new Element({activityCell:'0',activityX:'0',activityY:'0',activityCount:'20',activityQuery:'EXACT-1',activitySide:'全部',activityFilter:'交易记录'}),flat=new Element({activityMode:'2d'}),iso=new Element({activityMode:'3d'}),readout={textContent:''},svg=new Element(),host=new Element({activityView:'3d'}),media=new EventTarget(),doc=new EventTarget();
 cell.querySelectorAll=()=>paths;cell.querySelector=()=>({textContent:'BTC/USDT · 20 USD eq.'});svg.getBoundingClientRect=()=>({width:288,height:230});host.querySelector=s=>s==='.trade-activity-stage svg'?svg:s==='[data-activity-readout]'?readout:null;host.querySelectorAll=s=>s==='[data-activity-cell]'?[cell]:[flat,iso];doc.hidden=false;doc.documentElement={dataset:{reducedMotion:'false'}};media.matches=false;
 try{
  globalThis.document=doc;globalThis.matchMedia=()=>media;globalThis.requestAnimationFrame=f=>{frames.set(++seq,f);return seq;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
  globalThis.ResizeObserver=class{constructor(cb){this.cb=cb;resize=this;}observe(){}disconnect(){this.disconnected=true;}};
  globalThis.MutationObserver=class{constructor(cb){this.cb=cb;settings=this;}observe(){}disconnect(){this.disconnected=true;}};
  const dispose=mountTradeActivity({querySelector:()=>host},{onPick:x=>{picked=x;}});assert.equal(frames.size,0);assert.equal(svg.attrs.viewBox,'0 0 288 230');
  flat.dispatchEvent(new Event('click'));assert.equal(frames.size,1);iso.dispatchEvent(new Event('click'));assert.equal(frames.size,1);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(frames.size,0);
  doc.hidden=false;doc.documentElement.dataset.reducedMotion='true';settings.cb();flat.dispatchEvent(new Event('click'));assert.equal(frames.size,0);
  doc.documentElement.dataset.reducedMotion='false';media.matches=true;media.dispatchEvent(new Event('change'));iso.dispatchEvent(new Event('click'));assert.equal(frames.size,0);
  media.matches=false;flat.dispatchEvent(new Event('click'));assert.equal(frames.size,1);cell.dispatchEvent(new Event('click'));assert.deepEqual(picked,{query:'EXACT-1',side:'全部',filter:'交易记录'});
  dispose();assert.equal(frames.size,0);assert.equal(settings.disconnected,true);assert.equal(resize.disconnected,true);iso.dispatchEvent(new Event('click'));assert.equal(frames.size,0);
 }finally{for(const k of keys){if(previous[k]===undefined)delete globalThis[k];else globalThis[k]=previous[k];}}
});
