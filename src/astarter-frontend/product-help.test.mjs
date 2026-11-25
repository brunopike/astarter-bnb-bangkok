import test from 'node:test';
import assert from 'node:assert/strict';
import {infoPopoverPosition,enhanceProductCopy,formatSimulationTime,bindInfoPopovers,normalizeInfoControls} from './product-help.mjs';

test('simulation clocks use bounded duration units instead of giant minutes or a calendar date',()=>{
 assert.equal(formatSimulationTime(77273),'运行 21时27分');
 assert.equal(formatSimulationTime(90061),'运行 1天1时');
 assert.equal(formatSimulationTime(62),'运行 1分2秒');
 assert.equal(formatSimulationTime(0),'运行 0秒');
 for(const value of [undefined,NaN,Infinity,'77273'])assert.equal(formatSimulationTime(value),'—');
});

test('info bubbles stay inside both edges of a narrow viewport',()=>{
 const viewport={width:320,height:740},panel={width:280,height:140};
 for(const left of [0,12,150,288]){
  const anchor={left,width:32,top:100,bottom:132};
  const placed=infoPopoverPosition(anchor,panel,viewport);
  assert.ok(placed.left>=12);
  assert.ok(placed.left+panel.width<=viewport.width-12);
  assert.ok(placed.top>=anchor.bottom);
 }
});

test('a bubble near the bottom opens above its trigger',()=>{
 const anchor={left:100,width:32,top:680,bottom:712},panel={width:280,height:180};
 const placed=infoPopoverPosition(anchor,panel,{width:390,height:740});
 assert.ok(placed.top+panel.height<anchor.top);
});

test('help normally opens below and keeps its right edge aligned with the trigger',()=>{
 const placed=infoPopoverPosition({left:270,width:32,top:350,bottom:382},{width:200,height:140},{width:390,height:740});
 assert.deepEqual(placed,{left:102,top:390});
});

test('hover-open explanations pin on click, toggle closed, and dismiss outside',()=>{
 const saved={document:globalThis.document,window:globalThis.window,Element:globalThis.Element,MutationObserver:globalThis.MutationObserver},events=new Map();
 class Element{matches(selector){return selector.startsWith('details:');}}
 let visible=false;const summary={textContent:'i',parentElement:null,getAttribute:()=> 'About data',setAttribute(){},getBoundingClientRect:()=>({left:270,width:32,top:350,bottom:382}),closest:()=>summary};
 const panel={classList:{add(){}},style:{},isConnected:true,showPopover(){visible=true;},hidePopover(){visible=false;},matches:()=>visible,setAttribute(){},getBoundingClientRect:()=>({width:200,height:140})};
 const details=new Element();Object.assign(details,{tagName:'DETAILS',open:true,children:[summary,panel],contains:node=>node===summary||node===panel,querySelector:selector=>selector==='summary'?summary:panel,setAttribute(){},removeAttribute(){}});summary.parentElement=details;
 const root={querySelectorAll:()=>[],addEventListener:(name,fn)=>events.set(name,fn)};let close;
 try{
  globalThis.Element=Element;globalThis.document={activeElement:null};globalThis.window={innerWidth:390,innerHeight:740,addEventListener(){}};globalThis.MutationObserver=class{observe(){}};
  close=bindInfoPopovers(root);events.get('toggle')({target:details});assert.equal(visible,true);
  assert.equal(panel.popover,'manual','native light-dismiss must not race a click on the hover-open trigger');
  const click=events.get('click');assert.equal(typeof click,'function');
  const event={target:summary,preventDefault(){this.prevented=true;},stopPropagation(){}};
  click(event);assert.equal(event.prevented,true);assert.equal(details.open,true);assert.equal(visible,true);
  click(event);assert.equal(details.open,false);assert.equal(visible,false);
  details.open=true;events.get('toggle')({target:details});click(event);
  click({target:{closest:()=>null}});assert.equal(details.open,false);assert.equal(visible,false);
 }finally{close?.();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('long explanations use the viewport inset when neither side fits',()=>{
 const panel={width:280,height:716};
 const placed=infoPopoverPosition({left:0,width:32,top:300,bottom:332},panel,{width:320,height:740});
 assert.equal(placed.top,12);
 assert.ok(placed.top+panel.height<=728);
});

test('normalizing an existing card help control does not move it again on observer updates',()=>{
 let moves=0;const classes={add(){},contains:()=>false},heading={textContent:'Market',classList:classes,contains:()=>false};
 const summary={textContent:'i',setAttribute(){}},body={textContent:'Source and original time'};
 const header={tagName:'HEADER',classList:classes,firstElementChild:heading,querySelector:()=>heading,append(){moves++;}};heading.parentElement=header;
 const card={children:[header]},source={tagName:'DETAILS',parentElement:header,classList:classes,querySelector:selector=>selector==='summary'?summary:body,setAttribute(){},matches:selector=>selector==='.hub-source',closest:selector=>selector==='.hub-panel'||selector==='section,article'?card:null};
 const root={querySelectorAll:()=>[source]};normalizeInfoControls(root);normalizeInfoControls(root);
 assert.equal(moves,0,'normalization must settle rather than feed its own observer');assert.equal(body.textContent,'Source and original time');
});

test('a hidden page-title explanation joins its visible source disclosure without losing either content',()=>{
 const classes={add(){},contains:name=>name==='ux-info'},paragraphs=[{textContent:'Original source time'}],body={prepend:node=>paragraphs.unshift(node),ownerDocument:{createElement:()=>({})}};
 const source={children:[{tagName:'SUMMARY'},body]},actions={querySelector:()=>source},page={querySelector:()=>actions};
 const header={classList:{add(){},contains:name=>name==='layout-context-only'},closest:()=>page},heading={parentElement:header,closest:()=>header,classList:classes};
 let removed=false;const control={tagName:'BUTTON',classList:classes,dataset:{info:'chain'},textContent:'',parentElement:heading,setAttribute(){},remove(){removed=true;},matches:selector=>selector==='button.ux-info',closest:selector=>selector==='h1,h2,h3'?heading:null};
 normalizeInfoControls({querySelectorAll:()=>[control]});
 assert.equal(removed,true);assert.equal(paragraphs.length,2);assert.match(paragraphs[0].textContent,/转账只能说明资产发生了移动/);assert.equal(paragraphs[1].textContent,'Original source time');
});

test('source timestamps use one explicit time zone and reject invalid dates',async()=>{
 const {formatDataTime}=await import('./product-help.mjs');
 assert.equal(formatDataTime('2026-11-04T16:05:06Z'),'2026-11-05 00:05:06 UTC+8');
 for(const value of [null,undefined,'',Infinity,1e30,'invalid'])assert.equal(formatDataTime(value),'—');
});


test('copy polishing preserves chat drafts and explicitly quoted source text',()=>{
 const saved={document:globalThis.document,NodeFilter:globalThis.NodeFilter};
 const make=marker=>({nodeValue:'账户权益',parentElement:{closest:selector=>marker&&selector.includes(marker)?{}:null}});
 const draft=make('textarea'),quote=make('[data-no-translate]'),label=make(null),nodes=[draft,quote,label];let index=0;
 try{
  globalThis.NodeFilter={SHOW_TEXT:4};globalThis.document={createTreeWalker:()=>({nextNode:()=>nodes[index++]||null})};
  enhanceProductCopy({querySelectorAll:()=>[]});
  assert.equal(draft.nodeValue,'账户权益');assert.equal(quote.nodeValue,'账户权益');assert.equal(label.nodeValue,'总资产');
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});


test('generic available and held balances do not explain research credits',()=>{
 const saved={document:globalThis.document,NodeFilter:globalThis.NodeFilter,Node:globalThis.Node};
 const labels=['Available','Held','Available credits','Held credits'].map(title=>({
  childNodes:[{nodeType:3,textContent:title}],html:'',querySelector:()=>null,closest:()=>null,
  insertAdjacentHTML(_where,html){this.html=html;}
 }));
 try{
  globalThis.Node={TEXT_NODE:3};globalThis.NodeFilter={SHOW_TEXT:4};
  globalThis.document={createTreeWalker:()=>({nextNode:()=>null})};
  enhanceProductCopy({querySelectorAll:selector=>selector==='label.p-field'?[]:labels});
  assert.equal(labels[0].html,'');assert.equal(labels[1].html,'');
  assert.match(labels[2].html,/data-info="credits"/);assert.match(labels[3].html,/data-info="credits"/);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

function titleExplanation({hidden,caveat}){
 const node=(tagName,classes=[],extra={})=>Object.assign({tagName,children:[],parentElement:null,dataset:{},textContent:'',classList:{add:name=>classes.push(name),contains:name=>classes.includes(name)},
  matches(selector){return selector.split(',').some(part=>{const [name,...names]=part.trim().split('.');return (name.startsWith('#')?this.id===name.slice(1):!name||this.tagName===name.toUpperCase())&&names.every(c=>classes.includes(c));});},
  closest(selector){for(let at=this;at;at=at.parentElement)if(at.matches(selector))return at;return null;},
  querySelector(selector){for(const child of this.children){if(child.matches(selector))return child;const found=child.querySelector(selector);if(found)return found;}return null;},
  append(...nodes){for(const child of nodes){child.parentElement?.children.splice(child.parentElement.children.indexOf(child),1);child.parentElement=this;this.children.push(child);}},
  prepend(...nodes){for(const child of nodes.reverse()){child.parentElement?.children.splice(child.parentElement.children.indexOf(child),1);child.parentElement=this;this.children.unshift(child);}},
  setAttribute(){}},extra);
 const hint=(classes,label,text)=>{const details=node('DETAILS',classes);details.append(node('SUMMARY',[],{textContent:'i',label}),node('DIV',[],{textContent:text}));return details;};
 const page=node('MAIN',['product-page'],{id:'product-page'}),header=node('HEADER',['p-head','pd-heading','layout-page-head',...(hidden?['layout-context-only']:[])]),title=node('DIV',['layout-heading-title']),h1=node('H1',[],{textContent:'News feed'}),line=node('SPAN');
 const actions=node('DIV',['layout-heading-actions']),group=node('DIV',['pd-actions','layout-action-group']),modebar=node('DIV',['pd-modebar','in-heading','layout-action-group']),switchLine=node('SPAN');
 const source=hint(['pd-info','data-header-info'],'Source and time','Data as of 11-17 20:00:00 UTC+8 · Update failed'),switchHint=hint(['pd-info'],'About this data','Read-only data comes from the data service.'),control=hint(['pd-info'],'About this data',caveat);
 page.append(header);header.append(title);title.append(h1,line);line.append(control);
 actions.append(group,modebar);group.append(source);modebar.append(node('NAV'),switchLine);switchLine.append(switchHint);
 if(hidden){const row=node('DIV',['layout-navigation-row']),menu=node('DETAILS',['layout-actions-menu']);page.append(row);row.append(menu);menu.append(node('SUMMARY',[],{label:'Page actions'}),actions);}else header.append(actions);
 const actionsOrder=()=>actions.children.map(c=>c===control?'title hint':c===group?'source and time':c===modebar?'data switch':'other');
 const named=()=>{const found=[];const walk=at=>{for(const child of at.children){if(child.tagName==='SUMMARY'&&child.label==='About this data')found.push(child.parentElement===control?'title hint':child.parentElement===switchHint?'switch hint':'other');walk(child);}};walk(page);return found;};
 return {h1,line,actions,control,body:control.children[1],sourceBody:source.children[1],actionsOrder,named};
}

test('an explanation beside a hidden page title moves to the visible page actions and stays there',()=>{
 for(const caveat of ['Publisher and publication time are retained. Reporting is not a verified market fact.','Spot 24-hour statistics only. These are not executable quotes.']){
  const {line,actions,control,body,sourceBody,actionsOrder}=titleExplanation({hidden:true,caveat});
  normalizeInfoControls({querySelectorAll:()=>[control]});
  assert.equal(control.parentElement===actions,true,'a visually hidden heading must not hold the only way to open this explanation');
  assert.equal(line.children.length,0);assert.deepEqual(actionsOrder(),['title hint','source and time','data switch']);
  assert.equal(body.parentElement===control,true);assert.equal(body.textContent,caveat);assert.equal(sourceBody.textContent,'Data as of 11-17 20:00:00 UTC+8 · Update failed');
  normalizeInfoControls({querySelectorAll:()=>[control]});
  assert.deepEqual(actionsOrder(),['title hint','source and time','data switch'],'observer updates must not move it again');
 }
});

test('a moved title explanation keeps its order among same-named hints, so a repaint restores focus to the same one',()=>{
 const {control,named}=titleExplanation({hidden:true,caveat:'Publisher and publication time are retained. Reporting is not a verified market fact.'});
 const fresh=named();normalizeInfoControls({querySelectorAll:()=>[control]});
 assert.deepEqual(fresh,['title hint','switch hint']);assert.deepEqual(named(),fresh);
});

test('an explanation beside a visible page title stays in its heading',()=>{
 const {line,control,actionsOrder}=titleExplanation({hidden:false,caveat:'Spot 24-hour statistics only. These are not executable quotes.'});
 normalizeInfoControls({querySelectorAll:()=>[control]});
 assert.equal(control.parentElement===line,true,'a visible heading keeps its explanation in place');assert.equal(line.children.length,1);assert.deepEqual(actionsOrder(),['source and time','data switch']);
});

test('an explanation inside a hidden page title keeps its place after the page actions',()=>{
 const {h1,control,actionsOrder}=titleExplanation({hidden:true,caveat:'Spot 24-hour statistics only. These are not executable quotes.'});
 h1.append(control);normalizeInfoControls({querySelectorAll:()=>[control]});
 assert.deepEqual(actionsOrder(),['source and time','data switch','title hint']);
});
