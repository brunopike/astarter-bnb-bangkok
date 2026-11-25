import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTradingConnections,CONNECTION_OPTIONS} from './connection-options.mjs';
import * as connectionUI from './connections.mjs';
import {getLocale,initLocale} from './locale.mjs';

test('overview states that the preferred connection applies to new drafts, not to existing runs',()=>{
  const [record]=normalizeTradingConnections([{id:'perp',kind:'exchange',service:'binance',market:'perp',accountId:'FUTURES-2',label:'Perp account'}]);
  const html=connectionUI.connectionOverview({tradingAccounts:[record],preferredTradingConnection:record.id},{getAccess:()=>null});
  assert.match(html,/data-preferred-scope/);
  assert.match(html,/首选接入只用于新建草稿；已有运行继续使用原接入。|Preferred is used for new drafts only\. Existing runs keep their original connection\./);
});

test('overview shows no preferred-scope note when no connection is preferred',()=>{
  const html=connectionUI.connectionOverview({tradingAccounts:[],preferredTradingConnection:''},{getAccess:()=>null});
  assert.doesNotMatch(html,/data-preferred-scope/);
});

// A small page fake for the connections dialog: it parses the dialog's own markup and matches the selectors the dialog uses, so a test can press the dialog's own buttons. Network calls are recorded locally, including the public ticker read from the shared page footer.
const VOID_TAGS=new Set(['area','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const decodeText=value=>value.replace(/&(amp|lt|gt|quot|#39);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));
const MARKUP=/<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=\/>"]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)|</g;
const SELECTOR_PART=/([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]"]*)))?\]|(:checked)/y;
const selectorCache=new Map();
function parseSelector(selector){
  if(!selectorCache.has(selector))selectorCache.set(selector,selector.split(',').map(one=>one.trim().split(/\s+/).map(text=>{
    const parts=[];SELECTOR_PART.lastIndex=0;
    while(SELECTOR_PART.lastIndex<text.length){const match=SELECTOR_PART.exec(text);if(!match)throw new Error('selector not supported by the page fake: '+selector);parts.push(match);}
    return parts;
  })));
  return selectorCache.get(selector);
}
const matchesPart=(node,parts)=>node?.nodeType===1&&parts.every(([,tag,id,className,attribute,quoted,bare,checked])=>tag?node.localName===tag.toLowerCase():id?node.getAttribute('id')===id:className?Boolean(node.getAttribute('class')?.split(/\s+/).includes(className)):attribute?node.hasAttribute(attribute)&&(quoted??bare??node.getAttribute(attribute))===node.getAttribute(attribute):Boolean(checked&&node.checked));
function matchesSelector(node,selector){
  return parseSelector(selector).some(chain=>{
    if(!matchesPart(node,chain.at(-1)))return false;
    let index=chain.length-2;
    for(let parent=node.parentNode;index>=0&&parent?.nodeType===1;parent=parent.parentNode)if(matchesPart(parent,chain[index]))index--;
    return index<0;
  });
}
class FakeText{
  constructor(text){this.nodeType=3;this.data=text;this.parentNode=null;}
  get textContent(){return this.data;}
  set textContent(value){this.data=String(value);}
  remove(){if(this.parentNode){this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}}
}
class FakeElement{
  constructor(tag,page){Object.assign(this,{nodeType:1,localName:tag.toLowerCase(),tagName:tag.toUpperCase(),ownerDocument:page,attrs:new Map(),childNodes:[],parentNode:null,events:{},style:{},scrollTop:0});}
  get children(){return this.childNodes.filter(node=>node.nodeType===1);}
  get firstChild(){return this.childNodes[0]||null;}
  get isConnected(){let node=this;while(node.parentNode)node=node.parentNode;return node===this.ownerDocument;}
  get id(){return this.getAttribute('id')||'';}
  set id(value){this.setAttribute('id',value);}
  get className(){return this.getAttribute('class')||'';}
  set className(value){this.setAttribute('class',value);}
  get title(){return this.getAttribute('title')||'';}
  set title(value){this.setAttribute('title',value);}
  get type(){return this._type??this.getAttribute('type')??(this.localName==='input'?'text':'');}
  set type(value){this._type=String(value);}
  get value(){
    if(this._value!==undefined)return this._value;
    if(this.localName!=='select')return this.getAttribute('value')??'';
    const options=this.querySelectorAll('option'),selected=options.find(option=>option.hasAttribute('selected'))||options[0];
    return selected?selected.getAttribute('value')??selected.textContent:'';
  }
  set value(value){this._value=String(value);}
  get dataset(){
    const name=key=>'data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
    return new Proxy({},{get:(_,key)=>typeof key==='string'?this.attrs.get(name(key)):undefined,set:(_,key,value)=>{this.attrs.set(name(key),String(value));return true;},has:(_,key)=>typeof key==='string'&&this.attrs.has(name(key))});
  }
  get textContent(){return this.childNodes.map(node=>node.textContent).join('');}
  set textContent(value){this.replaceChildren(...(String(value)?[new FakeText(String(value))]:[]));}
  get innerHTML(){return this.childNodes.map(node=>node.nodeType===3?node.data:node.outerHTML).join('');}
  set innerHTML(html){this.replaceChildren(...parseMarkup(String(html),this.ownerDocument));}
  get outerHTML(){return `<${this.localName}${[...this.attrs].map(([key,value])=>` ${key}="${value}"`).join('')}>${VOID_TAGS.has(this.localName)?'':this.innerHTML+`</${this.localName}>`}`;}
  set outerHTML(html){const nodes=parseMarkup(String(html),this.ownerDocument),parent=this.parentNode;parent.childNodes.splice(parent.childNodes.indexOf(this),1,...nodes);for(const node of nodes)node.parentNode=parent;this.parentNode=null;}
  setAttribute(key,value){this.attrs.set(key,String(value));}
  getAttribute(key){return this.attrs.has(key)?this.attrs.get(key):null;}
  hasAttribute(key){return this.attrs.has(key);}
  removeAttribute(key){this.attrs.delete(key);}
  toggleAttribute(key,force=!this.attrs.has(key)){if(force)this.attrs.set(key,'');else this.attrs.delete(key);return force;}
  append(...nodes){for(let node of nodes){if(typeof node==='string')node=new FakeText(node);node.remove();node.parentNode=this;this.childNodes.push(node);}}
  replaceChildren(...nodes){for(const node of this.childNodes)node.parentNode=null;this.childNodes=[];this.append(...nodes);}
  remove(){if(this.parentNode){this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}}
  querySelectorAll(selector){const found=[],walk=node=>{for(const child of node.children){if(matchesSelector(child,selector))found.push(child);walk(child);}};walk(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){for(let node=this;node?.nodeType===1;node=node.parentNode)if(matchesSelector(node,selector))return node;return null;}
  addEventListener(type,listener){(this.events[type]||=[]).push(listener);}
  removeEventListener(){}
  focus(){this.ownerDocument.activeElement=this;}
  blur(){}
  scrollIntoView(){}
  getBoundingClientRect(){return {left:0,top:0,right:0,bottom:0,width:0,height:0};}
  showModal(){this.open=true;}
  close(){if(!this.open)return;this.open=false;for(const listener of this.events.close||[])listener({type:'close',target:this});}
}
for(const key of ['hidden','open','disabled','checked'])Object.defineProperty(FakeElement.prototype,key,{get(){return this.attrs.has(key);},set(value){if(value)this.attrs.set(key,'');else this.attrs.delete(key);}});
function parseMarkup(html,page){
  const root=new FakeElement('template',page),open=[root];
  for(const match of html.matchAll(MARKUP)){
    const [,closing,tag,attributes,selfClosing,text]=match;
    if(closing){const index=open.findLastIndex(node=>node.localName===closing.toLowerCase());if(index>0)open.length=index;}
    else if(tag){const node=new FakeElement(tag,page);for(const [,key,value]of attributes.matchAll(/([^\s=\/>"]+)(?:\s*=\s*"([^"]*)")?/g))node.attrs.set(key,decodeText(value??''));open.at(-1).append(node);if(!selfClosing&&!VOID_TAGS.has(node.localName))open.push(node);}
    else if(text!==undefined)open.at(-1).append(new FakeText(decodeText(text)));
    else throw new Error('markup not supported by the page fake: '+html.slice(match.index,match.index+80));
  }
  return [...root.childNodes];
}
function connectionHarness(stored,{getAccess}={}){
  const listeners={},page={nodeType:9,hidden:false,activeElement:null,
    addEventListener:(type,listener)=>{(listeners[type]||=[]).push(listener);},removeEventListener(){},
    dispatchEvent:event=>{for(const listener of listeners[event.type]||[])listener(event);return true;},
    createElement:tag=>new FakeElement(tag,page),
    querySelector:selector=>page.documentElement.querySelector(selector),querySelectorAll:selector=>page.documentElement.querySelectorAll(selector)};
  page.documentElement=new FakeElement('html',page);page.documentElement.parentNode=page;
  page.body=new FakeElement('body',page);page.documentElement.append(page.body);
  page.body.dataset.page='setup';
  const mobileNav=new FakeElement('nav',page);mobileNav.className='mobile-nav';page.body.append(mobileNav);
  const prior=Object.fromEntries(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const restore=()=>{for(const [key,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];};
  let current=connectionUI.normalizeConnections(stored);
  const saves=[],requests=[];
  const recordRequest=async(input,options={})=>{
    requests.push({url:typeof input==='string'?input:input.url,method:options.method??input.method??'GET'});
    throw new Error('Offline connection dialog test');
  };
  for(const [key,value]of Object.entries({document:page,window:{innerWidth:1440,addEventListener(){},removeEventListener(){}},fetch:recordRequest}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  try{
    const center=connectionUI.createConnectionCenter({get:()=>current,onSave:(next,category)=>{current=connectionUI.normalizeConnections(next);saves.push(category);return null;},getAccess});
    const dialog=page.querySelector('#connection-dialog'),find=selector=>{const node=dialog.querySelector(selector);assert.ok(node,'no element for '+selector);return node;};
    return {center,dialog,page,saves,restore,
      stored:()=>current,
      replaceStored:value=>{current=connectionUI.normalizeConnections(value);},
      press:selector=>find(selector).onclick(),
      choose:(selector,value)=>{const node=find(selector);node.value=value;for(const type of ['input','change'])for(const listener of node.events[type]||[])listener({type,target:node});},
      pressed:selector=>find(selector).getAttribute('aria-pressed'),
      feedback:()=>(dialog.querySelector('#cc-inline-feedback')||find('#connection-feedback')).textContent,
      preferredIds:()=>dialog.querySelectorAll('.cc-account-row').filter(row=>row.querySelector('.cc-source-chip')).map(row=>row.querySelector('[data-connection-edit]').getAttribute('data-connection-edit')),
      assertOnlyPublicTickerRead:()=>assert.deepEqual(requests,[{url:'/api/market-hub?resource=tickers',method:'GET'}])};
  }catch(error){restore();throw error;}
}
const UNSAVED_HINT=/^(?:有未保存的更改，保存后才会生效。|Unsaved changes\. They apply only after you save\.)$/;
const SPOT_CARD=/^Binance · (?:现货|Spot)$/;

test('saving Research data keeps an unsaved AI model edit and its hint, and the kept edit can be saved',()=>{
  const ui=connectionHarness({});
  try{
    ui.center.open('ai');
    assert.equal(ui.pressed('[data-ai-mode="balanced"]'),'true');
    ui.press('[data-ai-mode="fast"]');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-setting="data"]');
    assert.equal(ui.feedback(),'');
    ui.press('#connections-save');
    assert.deepEqual(ui.saves,['data']);
    assert.equal(ui.stored().preferences.ai.model,'balanced');
    ui.press('[data-setting="ai"]');
    assert.equal(ui.pressed('[data-ai-mode="fast"]'),'true');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('#connections-save');
    assert.deepEqual(ui.saves,['data','ai']);
    assert.equal(ui.stored().preferences.ai.model,'fast');
    assert.equal(ui.feedback(),'');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('shared Binance connection exposes its status without a writable credential form',()=>{
 const ui=connectionHarness({});
 try{
  ui.center.open('exchange');ui.press('[data-provider="binance"]');
  assert.match(ui.dialog.textContent,/只读|Read only/);
  assert.equal(ui.dialog.querySelector('[data-credential]'),null);
  assert.equal(ui.dialog.querySelector('footer').hidden,true);
 }finally{ui.restore();}
});
test('with no stored list, the SIM-01 card and its form show the stored settings, not an unsaved market edit',()=>{
  const ui=connectionHarness({},{getAccess:({profileId})=>({code:profileId==='cex-spot'?'read-only':'connection-market'})});
  try{
    const card=()=>ui.dialog.querySelector('.cc-account-identity div span').textContent,status=()=>ui.dialog.querySelector('.cc-account-status').getAttribute('data-access-code'),market=()=>ui.dialog.querySelector('[data-pref="exchange.market"]').value;
    ui.center.open('exchange');
    assert.match(card(),SPOT_CARD);
    assert.equal(status(),'read-only');
    ui.press('[data-connection-edit="legacy-exchange"]');
    assert.equal(market(),'spot');
    ui.choose('[data-pref="exchange.market"]','perp');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-cc="back"]');
    assert.match(card(),SPOT_CARD);
    assert.equal(status(),'read-only');
    ui.press('[data-connection-edit="legacy-exchange"]');
    assert.equal(market(),'spot');
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    assert.equal(ui.stored().preferences.exchange.market,'spot');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('saving a trading connection keeps an unsaved AI model edit and its hint, also after an access refresh',()=>{
  const accounts=normalizeTradingConnections([{id:'spot-b',kind:'exchange',service:'okx',market:'spot',accountId:'UNCONNECTED',label:'Spot B'}]);
  const ui=connectionHarness({tradingAccounts:accounts,preferredTradingConnection:'spot-b'});
  try{
    ui.center.open('ai');
    ui.press('[data-ai-mode="fast"]');
    ui.press('[data-setting="exchange"]');
    ui.press('[data-connection-edit="spot-b"]');
    ui.choose('[data-pref="exchange.market"]','perp');
    ui.press('[data-cc="fill"]');
    ui.press('#connections-save');
    assert.equal(ui.saves.length,1);
    assert.equal(ui.saves[0].operation,'verify');
    assert.equal(ui.stored().tradingAccounts[0].market,'perp');
    assert.equal(ui.stored().preferences.ai.model,'balanced');
    ui.page.dispatchEvent(new CustomEvent('hive:access'));
    ui.press('[data-setting="ai"]');
    assert.equal(ui.pressed('[data-ai-mode="fast"]'),'true');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('#connections-save');
    assert.equal(ui.stored().preferences.ai.model,'fast');
    assert.equal(ui.stored().tradingAccounts[0].market,'perp');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('making a connection preferred or disconnecting it keeps an unsaved AI model edit, and the list marks the stored preferred connection',()=>{
  const accounts=normalizeTradingConnections([{id:'spot-a',kind:'exchange',service:'binance',market:'spot',accountId:'SIM-01',label:'Spot A'},{id:'perp-b',kind:'exchange',service:'okx',market:'perp',accountId:'UNCONNECTED',label:'Perp B'}]);
  const ui=connectionHarness({tradingAccounts:accounts,preferredTradingConnection:'spot-a'},{getAccess:()=>({code:'read-only'})});
  try{
    ui.center.open('ai');
    ui.press('[data-ai-mode="fast"]');
    ui.press('[data-setting="exchange"]');
    assert.deepEqual(ui.preferredIds(),['spot-a']);
    // The stored settings can change while the dialog is open; the list and its Preferred mark follow the stored settings.
    ui.replaceStored({...ui.stored(),preferredTradingConnection:'perp-b'});
    ui.press('[data-access-tab="exchange"]');
    assert.deepEqual(ui.preferredIds(),['perp-b']);
    ui.press('[data-connection-prefer="spot-a"]');
    assert.equal(ui.saves.at(-1).operation,'prefer');
    assert.equal(ui.stored().preferredTradingConnection,'spot-a');
    assert.deepEqual(ui.preferredIds(),['spot-a']);
    ui.press('[data-setting="ai"]');
    assert.equal(ui.pressed('[data-ai-mode="fast"]'),'true');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-setting="exchange"]');
    ui.press('[data-connection-disconnect="perp-b"]');
    assert.equal(ui.saves.at(-1).operation,'disconnect');
    ui.press('[data-setting="ai"]');
    assert.equal(ui.pressed('[data-ai-mode="fast"]'),'true');
    assert.match(ui.feedback(),UNSAVED_HINT);
    assert.equal(ui.stored().preferences.ai.model,'balanced');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('a saved section shows no unsaved-changes hint after Back to settings',()=>{
  const accounts=normalizeTradingConnections([{id:'spot-b',kind:'exchange',service:'okx',market:'spot',accountId:'UNCONNECTED',label:'Spot B'}]);
  const ui=connectionHarness({tradingAccounts:accounts,preferredTradingConnection:'spot-b'});
  try{
    ui.center.open('ai');
    ui.press('[data-ai-mode="fast"]');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('#connections-save');
    ui.press('[data-cc="back"]');
    assert.equal(ui.pressed('[data-ai-mode="fast"]'),'true');
    assert.equal(ui.feedback(),'');
    ui.press('[data-setting="exchange"]');
    ui.press('[data-connection-edit="spot-b"]');
    ui.choose('[data-pref="exchange.market"]','perp');
    ui.press('[data-cc="fill"]');
    ui.press('#connections-save');
    assert.equal(ui.saves.at(-1).operation,'verify');
    ui.press('[data-cc="back"]');
    ui.press('[data-provider="okx"]');
    assert.equal(ui.feedback(),'');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('Research data shows no unsaved-changes hint after the dialog drops a provider pick, and keeps it for a removed source',()=>{
  const ui=connectionHarness({preferences:{data:{source:'custom',services:['coinglass','blockbeats']}}});
  try{
    const pick=()=>ui.dialog.querySelector('#cc-service').value;
    ui.center.open('data');
    assert.equal(pick(),'');
    ui.choose('#cc-service','lunarcrush');
    assert.equal(pick(),'lunarcrush');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-setting="ai"]');
    ui.press('[data-setting="data"]');
    assert.equal(pick(),'');
    assert.equal(ui.feedback(),'');
    ui.press('[data-remove-source="blockbeats"]');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-setting="ai"]');
    ui.press('[data-setting="data"]');
    assert.match(ui.feedback(),UNSAVED_HINT);
    assert.deepEqual(ui.saves,[]);
    ui.press('#connections-save');
    assert.deepEqual(ui.saves,['data']);
    assert.deepEqual(ui.stored().preferences.data.services,['coinglass']);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('a new connection form shows no unsaved-changes hint after the back arrow drops the typed name, and compares a picked market with the stored one',()=>{
  const ui=connectionHarness({});
  try{
    const name=()=>ui.dialog.querySelector('[data-connection-label]').value,market=()=>ui.dialog.querySelector('[data-pref="exchange.market"]').value;
    ui.center.open('exchange');
    ui.press('[data-provider="okx"]');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-connection-label]','Desk two');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-cc="back"]');
    ui.press('[data-provider="okx"]');
    assert.equal(name(),'');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-pref="exchange.market"]','perp');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-cc="back"]');
    ui.press('[data-provider="okx"]');
    assert.equal(market(),'perp');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.choose('[data-pref="exchange.market"]','spot');
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('the wallet form shows no unsaved-changes hint after the Hyperliquid card puts back view only access',()=>{
  const ui=connectionHarness({});
  try{
    const access=()=>ui.dialog.querySelector('[data-pref="wallet.access"]').value;
    ui.center.open('wallet');
    ui.press('[data-provider="metamask"]');
    ui.choose('[data-pref="wallet.access"]','confirm');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-cc="back"]');
    ui.press('[data-access-tab="exchange"]');
    ui.press('[data-provider="hyperliquid"]');
    assert.equal(access(),'read');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-pref="wallet.access"]','confirm');
    assert.match(ui.feedback(),UNSAVED_HINT);
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('in the form of a saved connection the unsaved-changes hint compares with that connection',()=>{
  const accounts=normalizeTradingConnections([{id:'perp-b',kind:'exchange',service:'okx',market:'perp',access:'read',accountId:'UNCONNECTED',label:'Perp B'}]);
  const ui=connectionHarness({tradingAccounts:accounts,preferredTradingConnection:'perp-b'});
  try{
    const market=()=>ui.dialog.querySelector('[data-pref="exchange.market"]').value;
    ui.center.open('exchange');
    ui.press('[data-connection-edit="perp-b"]');
    assert.equal(market(),'perp');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-pref="exchange.market"]','spot');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.choose('[data-pref="exchange.market"]','perp');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-connection-label]','Perp C');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.choose('[data-connection-label]','Perp B');
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('the remove button of a saved data source names the provider, not its id',()=>{
  const ui=connectionHarness({preferences:{data:{source:'custom',services:['coinglass','blockbeats']}}});
  try{
    ui.center.open('data');
    const buttons=ui.dialog.querySelectorAll('[data-remove-source]');
    assert.deepEqual(buttons.map(button=>button.getAttribute('data-remove-source')),['coinglass','blockbeats']);
    assert.match(buttons[0].getAttribute('aria-label'),/^(?:移除|Remove) CoinGlass$/);
    assert.match(buttons[1].getAttribute('aria-label'),/^(?:移除|Remove) BlockBeats$/);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('a custom agent model id shows the unsaved-changes hint at once, and the stored id typed back removes it',()=>{
  const ui=connectionHarness({preferences:{ai:{source:'custom',service:'openrouter',agents:{A01:{model:'acme/custom-one',version:'v1'}}}}});
  try{
    ui.center.open('ai');
    const input=ui.dialog.querySelector('[data-agent-input="model"][data-agent-id="A01"]');
    assert.equal(input.value,'acme/custom-one');
    assert.equal(ui.feedback(),'');
    input.value='acme/custom-two';input.oninput();
    assert.match(ui.feedback(),UNSAVED_HINT);
    input.value='acme/custom-one';input.oninput();
    assert.equal(ui.feedback(),'');
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('the wallet form offers BSC only and does not ask for another network',()=>{
  const ui=connectionHarness({});
  try{
    ui.center.open('wallet');
    assert.equal(ui.dialog.querySelector('[data-provider="phantom"]'),null);
    assert.match(ui.dialog.querySelector('[data-provider="metamask"]').textContent,/BSC|BNB Chain/);
    ui.press('[data-provider="metamask"]');
    assert.equal(ui.dialog.querySelector('[data-pref="wallet.chain"]'),null);
    assert.match(ui.dialog.innerHTML,/BNB Chain/);
    assert.doesNotMatch(ui.dialog.innerHTML,/Arbitrum|Ethereum|Base|Solana/);
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('Research data with a stored own-API source shows the unsaved-changes hint for Astarter data, and not after own API is picked again',()=>{
  const ui=connectionHarness({preferences:{data:{source:'custom',services:['coinglass']}}});
  try{
    ui.center.open('data');
    assert.equal(ui.pressed('[data-source-mode="custom"]'),'true');
    assert.equal(ui.feedback(),'');
    ui.press('[data-source-mode="official"]');
    assert.equal(ui.pressed('[data-source-mode="official"]'),'true');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.press('[data-source-mode="custom"]');
    assert.equal(ui.pressed('[data-source-mode="custom"]'),'true');
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

test('a new exchange connection form shows the unsaved-changes hint for trade access, and not after view only is picked again',()=>{
  const ui=connectionHarness({});
  try{
    const access=()=>ui.dialog.querySelector('[data-pref="exchange.access"]').value;
    ui.center.open('exchange');
    ui.press('[data-provider="okx"]');
    assert.equal(access(),'read');
    assert.equal(ui.feedback(),'');
    ui.choose('[data-pref="exchange.access"]','trade');
    assert.equal(access(),'trade');
    assert.match(ui.feedback(),UNSAVED_HINT);
    ui.choose('[data-pref="exchange.access"]','read');
    assert.equal(access(),'read');
    assert.equal(ui.feedback(),'');
    assert.deepEqual(ui.saves,[]);
    ui.assertOnlyPublicTickerRead();
  }finally{ui.restore();}
});

// Selects the app language the way the language picker does (locale.mjs initLocale().set), on a throwaway page, so the dialog renders in that language.
async function selectAppLanguage(id){
  const keys=['document','MutationObserver','NodeFilter','localStorage'],prior=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const page=Object.assign(new EventTarget(),{body:{nodeType:1,querySelectorAll:()=>[]},documentElement:{dataset:{},style:{setProperty(){}}},createTreeWalker:()=>({nextNode:()=>null}),querySelector:()=>null,querySelectorAll:()=>[]});
  const values={document:page,MutationObserver:class{observe(){}disconnect(){}},NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=>null,setItem(){}}};
  for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:values[key]});
  try{await initLocale().set(id);}finally{keys.forEach((key,i)=>prior[i]?Object.defineProperty(globalThis,key,prior[i]):delete globalThis[key]);}
  assert.equal(getLocale(),id);
}

test('the remove button of a saved data source puts the provider name where each language puts it, unchanged and outside the page translator',async()=>{
  const before=getLocale();
  // Japanese and Korean put the object before the verb ("CoinGlassを削除", "CoinGlass 제거"); the other languages put the verb first.
  const expected={zh:['移除 ',''],en:['Remove ',''],ja:['','を削除'],ko:['',' 제거'],vi:['Gỡ ',''],es:['Quitar ',''],fr:['Retirer ',''],ru:['Убрать ','']};
  try{
    for(const [id,[lead,tail]]of Object.entries(expected)){
      await selectAppLanguage(id);
      const ui=connectionHarness({preferences:{data:{source:'custom',services:['coinglass','blockbeats']}}});
      try{
        ui.center.open('data');
        const buttons=ui.dialog.querySelectorAll('[data-remove-source]');
        assert.deepEqual(buttons.map(button=>button.getAttribute('data-remove-source')),['coinglass','blockbeats']);
        for(const button of buttons){
          const name=CONNECTION_OPTIONS.data.find(option=>option.id===button.getAttribute('data-remove-source')).name;
          assert.equal(button.getAttribute('aria-label'),lead+name+tail,id);
          // The page translator (locale.mjs initLocale) skips the label, so it cannot rewrite the provider name.
          assert.ok(button.hasAttribute('data-no-translate'),id);
        }
        ui.assertOnlyPublicTickerRead();
      }finally{ui.restore();}
    }
  }finally{await selectAppLanguage(before);}
});
