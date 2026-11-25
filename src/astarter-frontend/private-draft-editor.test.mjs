import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {emptyPrivateDraftFields,privateDraftFormInput,renderPrivateDraftDiff,createPrivateDraftEditor} from './private-draft-editor.mjs';
import {createPrivateDraftClient} from './private-draft-client.mjs';
import {validatePrivateDraftPreviewInput} from './private-draft-data.mjs';
import {createPrivateUIController} from './private-ui-controller.mjs';

const bytes=readFileSync(new URL('./private-draft-contract-fixtures.json',import.meta.url)),wire=JSON.parse(bytes),copy=value=>structuredClone(value);
const OWNER='wallet:56:0x'+'a'.repeat(40),OTHER='wallet:56:0x'+'b'.repeat(40),NOW=wire.source.createdAt+1000,TOKEN='b'.repeat(64),ID='editor-adopt-01';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}),settle=()=>new Promise(resolve=>setImmediate(resolve));
const responseContent=fields=>({catalogVersion:'private-paper-draft-v1',templateVersion:fields.planVariant+'@paper-v1',parameterOrigin:'user-confirmed',source:copy(wire.source),fields:copy(fields),missingFields:Object.entries(fields).filter(([,value])=>value===null).map(([key])=>key).sort(),executionAuthority:'NONE'});
const document=(fields=wire.previewGrid.fields,scope=OWNER,id='draft-01')=>({schema:'private-strategy-draft-v1',scope,draftId:id,revision:1,savedAt:NOW,content:responseContent(fields)});
const preview=(fields=wire.previewGrid.fields,scope=OWNER,id='draft-01')=>({schema:'private-draft-preview-v1',scope,draftId:id,expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN,listed:false,current:null,proposal:responseContent(fields),changedFields:copy(wire.changedFieldsOrder)});
function receipt(input,scope=OWNER){const content=responseContent(input.fields);content.source.sourceRequestId=input.sourceRequestId;return {schema:'private-draft-command-v1',scope,request:{requestId:input.requestId,draftId:input.draftId,status:'applied',expectedRevision:input.expectedRevision,revision:input.expectedRevision+1,workspaceBaseRevision:input.workspaceRevision,workspaceRevision:input.workspaceRevision+1,appliedAt:NOW},draft:{schema:'private-strategy-draft-v1',scope,draftId:input.draftId,revision:input.expectedRevision+1,savedAt:NOW,content}};}
function formFor(fields){
 const values={name:fields.name,amount:fields.amount??'',cap:fields.cap??'',researchBudget:fields.researchBudget??'',protection:fields.protection?.version==='astarter-research-v0.1/sim-3'?'custom':fields.protection?.id==='original'?'original':fields.protection?.mode||'',connection:fields.executionRoute?.connectionId||''};
 const keys=fields.strategy==='S01'?['lower','upper','count','spacing','triggerPrice','takeProfitPrice','stopLossPrice']:['deviationPct','sizeMultiplier','maxEntries','takeProfitPct','stopLossPct','triggerPrice'];
 for(const key of keys)values['param_'+key]=fields.botParameters?.[key]??'';
 if(fields.protection?.parameters)for(const [key,value]of Object.entries(fields.protection.parameters))values['risk_'+key]=value*100;
 const controls=new Map(Object.entries(values).map(([name,value])=>[name,{name,value:String(value),validity:{badInput:false}}]));
 return {controls,elements:{namedItem:name=>controls.get(name)||null}};
}
const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
function attributes(raw){return Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,decode(value)]));}
// A pure form/event adapter, with no document, window, chart mount or actual network surface.
function surface(){
 let html='',form=null,adopt=null,writes=0;const scroll={scrollTop:0},returnButton={},statusNode={textContent:''};
 const host={isConnected:true,ownerDocument:{activeElement:null},contains:()=>false,querySelectorAll:()=>[],querySelector(selector){if(selector==='form')return form;if(selector==='.bot-settings-scroll')return scroll;if(selector==='.pd-footer [role="status"]')return statusNode;if(selector==='[data-pd="adopt"]')return adopt;if(selector==='.pd-diff')return html.includes('class="pd-diff"')?{remove(){html=html.replace(/<section class="pd-diff"[\s\S]*?<\/section>/,'');}}:null;const name=selector.match(/^\[name="([^"]+)"\]$/)?.[1];return name?form?.elements.namedItem(name)||null:null;}};
 Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){
  writes++;html=value;const body=html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/)?.[1];form=null;
  if(body!==undefined){const controls=new Map();for(const [,raw]of body.matchAll(/<input\b([^>]*)>/g)){const a=attributes(raw);if(a.name)controls.set(a.name,{name:a.name,value:a.value??'',validity:{badInput:false}});}for(const [,raw,options]of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)){const a=attributes(raw),items=[...options.matchAll(/<option\b([^>]*)>/g)],selected=items.find(([,attrs])=>/\sselected(?:\s|$)/.test(attrs))||items[0];if(a.name)controls.set(a.name,{name:a.name,value:selected?attributes(selected[1]).value||'':'',validity:{badInput:false}});}form={controls,elements:{namedItem:name=>controls.get(name)||null},contains:node=>Boolean(node&&[...controls.values()].includes(node))};}
  const button=html.match(/<button\b[^>]*data-pd="adopt"[^>]*>/)?.[0];adopt=button?{disabled:/\sdisabled(?:\s|>)/.test(button)}:null;
 }});
 const container={querySelector:selector=>selector==='[data-private-draft-editor]'?host:selector==='[data-private-draft-return]'?returnButton:null};
 return {host,container,get form(){return form;},get html(){return html;},get writes(){return writes;},get feedback(){return statusNode.textContent;},set(name,value){const control=form?.elements.namedItem(name);assert.ok(control,'form control '+name);control.value=String(value);},async change(kind,value){return host.onchange({target:{dataset:{pdChange:kind},value}});},edit(name,value){this.set(name,value);const target=form.elements.namedItem(name);target.closest=selector=>selector==='form'?form:null;host.oninput({target});},async click(action){const match=html.match(new RegExp('<button\\b[^>]*data-pd="'+action+'"[^>]*>'));if(!match||/\sdisabled(?:\s|>)/.test(match[0])||action==='adopt'&&adopt?.disabled)return false;const button={dataset:{pd:action},disabled:false};host.onclick({target:{closest:()=>button}});await settle();return true;}};
}
function memory(){const entries=new Map();return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,String(value))};}
function editorFixture(t,{fetchImpl,directory=[],onSaved=()=>{}}={}){
 const calls=[],saved=[],storage=memory(),view=surface();let seq=0,scope=OWNER,storedDraft=null;
 const editor=createPrivateDraftEditor({storage,now:()=>NOW,getDirectory:()=>directory,getConnections:()=>null,onSaved:value=>{saved.push(value);onSaved(value);},clientFactory:options=>createPrivateDraftClient({...options,makeRequestId:()=>ID+'-'+(++seq),fetchImpl:async(url,init)=>{calls.push({url,init});if(fetchImpl)return fetchImpl(url,init,scope);if(url.includes('/get?'))return reply(storedDraft?.scope===scope?storedDraft:document(wire.previewGrid.fields,scope));const input=JSON.parse(init.body);if(url.endsWith('/preview')){const value=preview(input.fields,scope,input.draftId);value.proposal.source.sourceRequestId=input.sourceRequestId;return reply(value);}if(url.endsWith('/adopt')){const value=receipt(input,scope);storedDraft=copy(value.draft);return reply(value);}return reply(null);}})});
 t.after(()=>editor.dispose());return {editor,view,calls,saved,storage,setOwner(value=OWNER){scope=value;editor.setIdentity({ownerRef:value,expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'});},async mount(input={draftId:'draft-01',sourceRequestId:'research-01',symbol:'BTC'}){assert.equal(editor.mount(view.container,input),true);await settle();}};
}

test('shared b682 fixture stays fixed and empty templates never infer allocation, parameters, protection or accounts',()=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'b682a71bdcb41635db6002441300010b8e44bdc1ae3dc407abc266f9384def03');assert.equal(wire.evidenceGrade,'SYNTHETIC_WIRE_ONLY');
 for(const strategy of ['S01','S02'])for(const symbol of ['BTC','ETH','SOL']){const fields=emptyPrivateDraftFields(strategy,symbol);assert.equal(fields.strategy,strategy);assert.equal(fields.planVariant,strategy+'-SIM');assert.equal(fields.market,symbol+'/USDT');assert.equal(fields.environment,'DEMO');for(const key of ['amount','cap','researchBudget','botParameters','protection','executionRoute'])assert.equal(fields[key],null);assert.deepEqual(validatePrivateDraftPreviewInput({draftId:'draft-01',sourceRequestId:'research-01',fields}).fields,fields);}
 for(const [strategy,symbol]of [['S03','BTC'],['Q08','BTC'],['S01','SPX'],['S02','']])assert.throws(()=>emptyPrivateDraftFields(strategy,symbol),/PRIVATE_REQUEST_INVALID/);
});

test('blank amount and parameter controls remain null; nonempty fields preserve numeric units and do not mutate the base',()=>{
 for(const strategy of ['S01','S02']){const fields=emptyPrivateDraftFields(strategy,'BTC'),form=formFor(fields),before=copy(fields),result=privateDraftFormInput(form,fields);assert.deepEqual(result,fields);assert.deepEqual(fields,before);assert.equal(result.amount,null);assert.equal(result.botParameters,null);}
 const fields=copy(wire.previewGrid.fields),form=formFor(fields);form.controls.get('amount').value='';form.controls.get('researchBudget').value='0';form.controls.get('param_lower').value='60001.25';const parsed=privateDraftFormInput(form,fields);assert.equal(parsed.amount,null);assert.equal(parsed.researchBudget,0);assert.equal(parsed.botParameters.lower,60001.25);assert.equal(parsed.botParameters.triggerPrice,null);assert.equal(fields.amount,20);
});

test('invalid numeric controls fail instead of turning bad input into a zero allocation',()=>{
 for(const raw of ['NaN','Infinity','bad-number']){const fields=copy(wire.previewGrid.fields),form=formFor(fields);form.controls.get('amount').value=raw;assert.throws(()=>privateDraftFormInput(form,fields),/PRIVATE_REQUEST_INVALID/);}
 const fields=emptyPrivateDraftFields('S02','BTC'),form=formFor(fields);form.controls.get('cap').validity.badInput=true;assert.throws(()=>privateDraftFormInput(form,fields),/PRIVATE_REQUEST_INVALID/);form.controls.delete('param_maxEntries');assert.throws(()=>privateDraftFormInput(form,fields),/PRIVATE_REQUEST_INVALID/);
});

test('custom protection edits use fractions while percent-based basket parameters retain percent units',()=>{
 const fields=copy(wire.previewBasket.fields);fields.protection={id:'astarter',version:'astarter-research-v0.1/sim-3',mode:'conservative',parameters:{episode:.0025,notional:.1,daily:.02,epoch:.05,soft:.03,hard:.08}};const form=formFor(fields);form.controls.get('risk_daily').value='1';form.controls.get('param_stopLossPct').value='8';const parsed=privateDraftFormInput(form,fields);assert.equal(parsed.protection.parameters.daily,.01);assert.equal(parsed.botParameters.stopLossPct,8);assert.equal(parsed.protection.mode,'conservative');assert.equal(fields.protection.parameters.daily,.02);
});

test('pre-adopt differences cover all thirteen contract groups, missing fields and escaped user content',()=>{
 const value=preview();value.proposal.fields.name='<img src=x onerror="bad()">';const html=renderPrivateDraftDiff(value);assert.equal((html.match(/<dt>/g)||[]).length,13);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/Trading does not start|不会开始交易/);assert.equal(value.changedFields.length,13);
 const missing=preview(wire.previewEmpty.fields),empty=renderPrivateDraftDiff(missing);assert.match(empty,/Still needed|尚待补充/);assert.doesNotMatch(empty,/APPROVED|批准交易/);assert.equal(renderPrivateDraftDiff(null),'');
 const same=preview();same.current=document();same.expectedRevision=1;same.changedFields=[];assert.match(renderPrivateDraftDiff(same),/Parameters match|参数与已保存版本一致/);
});

test('historical directory loading reads the full private document and never fabricates a local save or execution',async t=>{
 const f=editorFixture(t,{directory:[{id:'draft-01',strategyId:'S01',name:'Directory metadata only'}]});f.setOwner();assert.equal(f.calls.length,0);assert.match(f.editor.render(),/data-private-draft-editor/);assert.equal(f.calls.length,0);
 await f.mount({draftId:'draft-01',sourceRequestId:null,symbol:null});assert.deepEqual(f.calls.map(c=>[c.init.method,c.url]),[['GET','/api/strategy-drafts/get?draftId=draft-01']]);assert.equal(f.view.form.elements.namedItem('amount').value,'20');assert.equal(f.view.form.elements.namedItem('name').value,wire.previewGrid.fields.name);assert.equal(f.saved.length,0);assert.equal(f.storage.entries.size,0);assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.editor.client.snapshot().canAdopt,false);assert.equal(await f.view.click('adopt'),false);
});

test('template switching preserves user-owned common fields but clears incompatible parameter contracts',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();f.view.edit('name','My edited basket');f.view.edit('amount','30');f.view.edit('cap','500');f.view.edit('researchBudget','7');await f.view.change('template','S02');
 assert.equal(f.view.form.elements.namedItem('name').value,'My edited basket');assert.equal(f.view.form.elements.namedItem('amount').value,'30');assert.equal(f.view.form.elements.namedItem('cap').value,'500');assert.equal(f.view.form.elements.namedItem('researchBudget').value,'7');assert.equal(f.view.form.elements.namedItem('protection').value,'original');assert.equal(f.view.form.elements.namedItem('connection').value,'sim-connection');assert.equal(f.view.form.elements.namedItem('param_lower'),null);assert.equal(f.view.form.elements.namedItem('param_maxEntries').value,'');assert.ok(f.editor.beforeLeave());assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 await f.view.click('preview');const request=JSON.parse(f.calls.at(-1).init.body);assert.equal(request.fields.strategy,'S02');assert.equal(request.fields.planVariant,'S02-SIM');assert.equal(request.fields.amount,30);assert.equal(request.fields.botParameters,null);assert.equal(request.fields.market,'BTC/USDT');
});

test('saving requires an explicit verified preview of current fields and binds the exact thirteen-group server proposal',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();assert.equal(await f.view.click('adopt'),false);f.view.edit('name','User-approved name');await f.view.click('preview');assert.equal(f.editor.client.snapshot().status,'preview');assert.equal((f.view.html.match(/<dt>/g)||[]).length>=13,true);assert.equal(f.calls.at(-1).url,'/api/strategy-drafts/preview');assert.equal(f.calls.at(-1).init.method,'POST');
 await f.view.click('adopt');const adopted=f.calls.filter(c=>c.url.endsWith('/adopt'));assert.equal(adopted.length,1);assert.deepEqual(JSON.parse(adopted[0].init.body),{draftId:'draft-01',sourceRequestId:'research-01',fields:{...wire.previewGrid.fields,name:'User-approved name'},requestId:ID+'-1',expectedRevision:0,workspaceRevision:2,proposalRevision:TOKEN});assert.equal(f.saved.length,1);assert.equal(f.saved[0].content.executionAuthority,'NONE');assert.equal(f.editor.beforeLeave(),null);
});

test('editing after preview invalidates the old proposal and prevents adopting stale parameters',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();await f.view.click('preview');assert.equal(f.editor.client.snapshot().canAdopt,true);f.view.edit('amount','25');assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.editor.client.snapshot().canAdopt,false);assert.equal(await f.view.click('adopt'),false);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);assert.ok(f.editor.beforeLeave());
});

test('unknown adoption keeps the original ID, disables editing and only queries the original request',async t=>{
 let result,confirm=false;const f=editorFixture(t,{fetchImpl:async(url,init,owner)=>{if(url.includes('/get?'))return reply(document());if(url.endsWith('/preview')){const input=JSON.parse(init.body);return reply(preview(input.fields));}if(url.endsWith('/adopt')){result=receipt(JSON.parse(init.body),owner);throw Error('offline committed response lost');}return reply(confirm?result:null);}});f.setOwner();await f.mount();await f.view.click('preview');await f.view.click('adopt');assert.equal(f.editor.client.snapshot().status,'unknown');const original=f.editor.client.snapshot().requestId;assert.equal(original,ID+'-1');assert.match(f.view.html,new RegExp(original));assert.match(f.view.html,/<fieldset disabled>/);assert.equal(await f.view.click('adopt'),false);
 f.view.set('amount','99');f.view.host.oninput({target:{closest:()=>f.view.form}});assert.equal(f.editor.client.snapshot().localInput.fields.amount,20);await f.view.change('template','S02');assert.equal(f.editor.client.snapshot().requestId,original);
 await f.view.click('query');assert.equal(f.editor.client.snapshot().status,'unknown');assert.equal(f.saved.length,0);assert.equal(f.calls.filter(c=>c.url.includes('/get?')).length,1,'GET null cannot trigger a draft reload before commit is confirmed');confirm=true;await f.view.click('query');assert.equal(f.saved.length,1);assert.equal(f.saved[0].draftId,'draft-01');assert.equal(f.saved[0].content.fields.amount,20);assert.equal(f.calls.filter(c=>c.url.includes('/get?')).length,2,'only the confirmed original receipt adds one same-draft verification read');assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,1);assert.deepEqual(f.calls.filter(c=>c.url.includes('/request?')).map(c=>[c.init.method,c.url]),Array.from({length:2},()=>['GET','/api/strategy-drafts/request?requestId='+original]));
});

test('owner switching and late old-owner reads cannot populate the next owner editor',async t=>{
 let release;const hold=new Promise(resolve=>{release=resolve;});const privateA={...wire.previewGrid.fields,name:'Private Owner A edits'},privateB={...wire.previewGrid.fields,name:'Private Owner B draft'};
 const f=editorFixture(t,{fetchImpl:async(url,_init,owner)=>{if(url.includes('draft-A')){await hold;return reply(document(privateA,OWNER,'draft-A'));}return reply(document(privateB,owner,'draft-B'));}});f.setOwner();assert.equal(f.editor.mount(f.view.container,{draftId:'draft-A',sourceRequestId:null,symbol:null}),true);await settle();f.setOwner(OTHER);assert.doesNotMatch(f.view.html,/Private Owner A edits/);await f.mount({draftId:'draft-B',sourceRequestId:null,symbol:null});assert.ok(f.view.form,JSON.stringify({status:f.editor.client.snapshot().status,error:f.editor.client.snapshot().error,calls:f.calls.map(c=>c.url),markup:f.view.html.slice(-900)}));assert.equal(f.view.form.elements.namedItem('name').value,privateB.name);release();await settle();assert.equal(f.view.form.elements.namedItem('name').value,privateB.name);assert.doesNotMatch(f.view.html,/Private Owner A edits/);assert.equal(f.saved.length,0);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
});

test('a directory-only missing document never synthesizes saved amounts or a successful adoption',async t=>{
 const f=editorFixture(t,{fetchImpl:async()=>reply(null),directory:[{id:'metadata-only',strategyId:'S01',name:'Directory-only seed'}]});f.setOwner();await f.mount({draftId:'metadata-only',sourceRequestId:null,symbol:null});assert.equal(f.view.form,null);assert.equal(f.editor.client.snapshot().draft,null);assert.equal(f.saved.length,0);assert.equal(f.storage.entries.size,0);assert.match(f.view.html,/no readable full private draft|没有可读取的完整私人草稿/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');
});

test('a new report waits for a user-selected template and keeps all missing amounts and parameters null through preview',async t=>{
 const f=editorFixture(t,{fetchImpl:async(url,init,owner)=>{if(url.includes('/get?'))return reply(null);const input=JSON.parse(init.body);const value=preview(input.fields,owner,input.draftId);value.proposal.source.sourceRequestId=input.sourceRequestId;return reply(value);}});f.setOwner();await f.mount({draftId:'report-draft-01',sourceRequestId:'research-01',symbol:'BTC'});assert.equal(f.view.form,null);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 await f.view.change('template','S01');assert.equal(f.view.form.elements.namedItem('amount').value,'');assert.equal(f.view.form.elements.namedItem('cap').value,'');assert.equal(f.view.form.elements.namedItem('param_lower').value,'');assert.equal(f.view.form.elements.namedItem('param_spacing').value,'');assert.equal(f.view.form.elements.namedItem('protection').value,'');assert.equal(f.view.form.elements.namedItem('connection').value,'');await f.view.click('preview');
 const request=JSON.parse(f.calls.at(-1).init.body);for(const key of ['amount','cap','researchBudget','botParameters','protection','executionRoute'])assert.equal(request.fields[key],null);assert.equal(f.editor.client.snapshot().preview.proposal.executionAuthority,'NONE');assert.equal(f.saved.length,0);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);
});

test('reverting unsaved edits restores server-loaded values without a save, while dirty navigation remains guarded',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();assert.equal(f.editor.beforeLeave(),null);f.view.edit('amount','30');assert.ok(f.editor.beforeLeave());assert.equal(await f.view.click('discard'),true);assert.equal(f.view.form.elements.namedItem('amount').value,'20');assert.equal(f.editor.beforeLeave(),null);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);assert.equal(f.saved.length,0);
});

test('private editor requires the exact v2 profile before any draft read, preview or adoption',async t=>{
 for(const [authVersion,permissionProfile]of [[1,'legacy'],[3,'private-ui-v2'],[2,'other-profile'],[undefined,undefined]]){
  const f=editorFixture(t);f.editor.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000,authVersion,permissionProfile});await f.mount({draftId:'draft-01',sourceRequestId:null,symbol:null});assert.equal(f.calls.length,0);assert.equal(f.view.form,null);assert.match(f.view.html,/data-pd="authenticate"/);assert.equal(await f.view.click('preview'),false);assert.equal(await f.view.click('adopt'),false);
  f.setOwner();await settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');assert.equal(f.view.form.elements.namedItem('name').value,wire.previewGrid.fields.name);assert.equal(f.saved.length,0);
 }
});

test('same-owner renewal preserves unsaved user edits and does not automatically reload the old server values',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();f.view.edit('name','My renewed-session edits');f.view.edit('amount','31');assert.ok(f.editor.beforeLeave());const count=f.calls.length;
 f.editor.setIdentity({ownerRef:OWNER,expiresAt:NOW+120000,authVersion:2,permissionProfile:'private-ui-v2'});await settle();assert.equal(f.calls.length,count);assert.equal(f.view.form.elements.namedItem('name').value,'My renewed-session edits');assert.equal(f.view.form.elements.namedItem('amount').value,'31');assert.ok(f.editor.beforeLeave());assert.equal(f.saved.length,0);
});

test('explicit reload of a directory-only item remains a GET and never writes a local substitute',async t=>{
 const f=editorFixture(t,{fetchImpl:async()=>reply(null)});f.setOwner();await f.mount({draftId:'metadata-only',sourceRequestId:null,symbol:null});assert.equal(await f.view.click('reload'),true);assert.deepEqual(f.calls.map(c=>[c.init.method,c.url]),Array.from({length:2},()=>['GET','/api/strategy-drafts/get?draftId=metadata-only']));assert.equal(f.saved.length,0);assert.equal(f.storage.entries.size,0);assert.equal(f.view.form,null);
});

test('bad numeric browser input invalidates an existing preview before capture and cannot POST the old amount',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();await f.view.click('preview');assert.equal(f.editor.client.snapshot().canAdopt,true);
 const amount=f.view.form.elements.namedItem('amount');amount.value='';amount.validity.badInput=true;amount.closest=selector=>selector==='form'?f.view.form:null;f.view.host.oninput({target:amount});
 assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.editor.client.snapshot().canAdopt,false);assert.ok(f.editor.beforeLeave());assert.equal(await f.view.click('adopt'),false);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);assert.equal(f.saved.length,0);
});

test('adopt confirmation re-reads current fields and demands another preview for changes without an input event',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();await f.view.click('preview');f.view.set('amount','25');assert.equal(await f.view.click('adopt'),true);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.editor.client.snapshot().canAdopt,false);assert.ok(f.editor.beforeLeave());assert.equal(f.saved.length,0);assert.match(f.view.html,/inputs changed|输入已变化/);
});

test('confirmed adoption verifies the same private draft with one additional GET and never starts execution',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();f.view.edit('name','Confirmed then read back');await f.view.click('preview');await f.view.click('adopt');assert.deepEqual(f.calls.map(c=>[c.init.method,c.url]),[['GET','/api/strategy-drafts/get?draftId=draft-01'],['POST','/api/strategy-drafts/preview'],['POST','/api/strategy-drafts/adopt'],['GET','/api/strategy-drafts/get?draftId=draft-01']]);assert.equal(f.saved.length,1);assert.equal(f.saved[0].content.fields.name,'Confirmed then read back');assert.equal(f.editor.client.snapshot().draft.content.fields.name,'Confirmed then read back');assert.equal(f.editor.client.snapshot().executionAuthority,'NONE');
});

test('a BTC report cannot quietly replace an ETH target draft market or generate new parameters',async t=>{
 const ethFields={...copy(wire.previewGrid.fields),name:'Existing ETH draft',market:'ETH/USDT'};
 const eth=document(ethFields,OWNER,'eth-draft');eth.content.source.symbol='ETH';
 const f=editorFixture(t,{fetchImpl:async()=>reply(eth),directory:[{id:'eth-draft',strategyId:'S01',name:'ETH target'}]});f.setOwner();await f.mount({draftId:'eth-draft',sourceRequestId:'research-01',symbol:'BTC'});assert.equal(f.view.form,null);assert.equal(f.saved.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');assert.match(f.view.html,/BTC/);assert.match(f.view.html,/different|not match|incompatible|不一致|不兼容|不同/i);assert.doesNotMatch(f.view.html,/<input name="amount"/);assert.equal(await f.view.click('preview'),false);assert.equal(await f.view.click('adopt'),false);
});

function rawInvalidEdit(view){
 const form=view.form,name=form.elements.namedItem('name'),amount=form.elements.namedItem('amount');name.value='Owner A valid name still in this form';amount.value='';amount.validity.badInput=true;amount.closest=selector=>selector==='form'?form:null;view.host.oninput({target:amount});return {form,name,amount};
}

test('invalid numeric editing holds the original form and valid raw name across refresh, preview errors and change errors',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();await f.view.click('preview');const count=f.calls.length,writes=f.view.writes,raw=rawInvalidEdit(f.view);
 assert.equal(f.editor.holdRender(),true);assert.ok(f.editor.beforeLeave());assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.view.writes,writes);assert.strictEqual(f.view.form,raw.form);assert.match(f.view.feedback,/valid number|有效数字/);
 // Calling the public refresh seam models a locale-driven repaint; no native number text is asserted here.
 f.editor.refresh();assert.strictEqual(f.view.form,raw.form);assert.equal(raw.name.value,'Owner A valid name still in this form');assert.equal(raw.amount.validity.badInput,true);assert.equal(f.view.writes,writes);
 assert.equal(await f.view.click('preview'),true);assert.strictEqual(f.view.form,raw.form);assert.equal(raw.name.value,'Owner A valid name still in this form');assert.equal(f.editor.holdRender(),true);assert.equal(f.calls.length,count);assert.match(f.view.feedback,/Review amounts|核对金额/);
 await f.view.change('template','S02');assert.strictEqual(f.view.form,raw.form);assert.equal(raw.name.value,'Owner A valid name still in this form');assert.equal(f.editor.holdRender(),true);assert.equal(f.view.writes,writes);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);
 raw.amount.validity.badInput=false;f.view.edit('amount','25');assert.equal(f.editor.holdRender(),false);f.editor.refresh();assert.notStrictEqual(f.view.form,raw.form);assert.equal(f.view.form.elements.namedItem('name').value,'Owner A valid name still in this form');assert.equal(f.view.form.elements.namedItem('amount').value,'25');assert.ok(f.editor.beforeLeave());
});

test('discard releases raw-edit hold and restores the verified baseline without a save',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();const raw=rawInvalidEdit(f.view);assert.equal(f.editor.holdRender(),true);assert.equal(await f.view.click('discard'),true);assert.equal(f.editor.holdRender(),false);assert.notStrictEqual(f.view.form,raw.form);assert.equal(f.view.form.elements.namedItem('name').value,wire.previewGrid.fields.name);assert.equal(f.view.form.elements.namedItem('amount').value,'20');assert.equal(f.editor.beforeLeave(),null);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);assert.equal(f.saved.length,0);
});

for(const kind of ['owner-change','logout','expired-identity'])test(kind+' immediately removes raw owner-A editing even while repaint is held',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();const raw=rawInvalidEdit(f.view);assert.equal(f.editor.holdRender(),true);
 if(kind==='owner-change')f.setOwner(OTHER);else if(kind==='logout')f.editor.setIdentity(null);else f.editor.setIdentity({ownerRef:OWNER,expiresAt:NOW,authVersion:2,permissionProfile:'private-ui-v2'});
 assert.equal(f.editor.holdRender(),false);assert.notStrictEqual(f.view.form,raw.form);assert.notEqual(f.view.form?.elements.namedItem('name')?.value,raw.name.value);assert.doesNotMatch(f.view.html,/Owner A valid name still in this form/);await settle();assert.equal(f.editor.holdRender(),false);assert.notEqual(f.view.form?.elements.namedItem('name')?.value,raw.name.value);assert.equal(f.saved.length,0);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);
});

test('ordinary input/change events preserve cross-field control identity and send every edited value in the next preview',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();await f.view.click('preview');const form=f.view.form,writes=f.view.writes;
 const edits=[['amount','25'],['cap','500'],['param_lower','61000'],['param_upper','71000'],['param_count','6'],['param_spacing','geometric'],['param_triggerPrice','62000'],['param_takeProfitPrice','72000'],['param_stopLossPrice','58000'],['researchBudget','9'],['name','Across fields preserved']];
 const controls=new Map(edits.map(([name])=>[name,form.elements.namedItem(name)]));
 for(const [name,value]of edits){
  const control=controls.get(name);assert.ok(control,name);control.dataset={};f.view.edit(name,value);await f.view.host.onchange({target:control});
  assert.strictEqual(f.view.form,form,'ordinary change keeps the form mounted: '+name);assert.strictEqual(f.view.form.elements.namedItem(name),control,'ordinary change keeps the native control adapter: '+name);assert.equal(f.view.writes,writes);assert.equal(control.value,value);
 }
 for(const [name,value]of edits)assert.equal(form.elements.namedItem(name).value,value,'all prior fields remain intact: '+name);
 assert.equal(f.editor.client.snapshot().preview,null);assert.equal(f.editor.client.snapshot().canAdopt,false);assert.equal(await f.view.click('adopt'),false);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);assert.ok(f.editor.beforeLeave());
 await f.view.click('preview');const posts=f.calls.filter(c=>c.url.endsWith('/preview'));assert.equal(posts.length,2);assert.deepEqual(JSON.parse(posts[1].init.body),{draftId:'draft-01',sourceRequestId:'research-01',fields:{...wire.previewGrid.fields,name:'Across fields preserved',amount:25,cap:500,researchBudget:9,botParameters:{lower:61000,upper:71000,count:6,spacing:'geometric',triggerPrice:62000,takeProfitPrice:72000,stopLossPrice:58000}}});assert.equal(f.editor.client.snapshot().status,'preview');assert.equal(f.saved.length,0);
 // This asserts the controller's real event adapter, not browser focus/Tab timing or native '-' text restoration.
});

test('post-adoption readback of a newer concurrent revision updates both current form values and the verified draft',async t=>{
 let adopted=false;const f=editorFixture(t,{fetchImpl:async(url,init,scope)=>{
  if(url.includes('/get?')){
   if(!adopted)return reply(null);
   const current=document({...wire.previewGrid.fields,amount:25},scope,'draft-01');current.revision=2;return reply(current);
  }
  const input=JSON.parse(init.body);
  if(url.endsWith('/preview')){const value=preview(input.fields,scope,input.draftId);value.proposal.source.sourceRequestId=input.sourceRequestId;return reply(value);}
  adopted=true;return reply(receipt(input,scope));
 }});f.setOwner();await f.mount();await f.view.change('template','S01');
 const grid=wire.previewGrid.fields;
 for(const [name,value]of Object.entries({name:grid.name,amount:20,cap:grid.cap,researchBudget:0,param_lower:60000,param_upper:70000,param_count:4,param_spacing:'arithmetic',protection:'original',connection:'sim-connection'}))f.view.set(name,value);
 await f.view.click('preview');await f.view.click('adopt');
 assert.equal(f.saved.length,1);assert.equal(f.saved[0].revision,1,'the original immutable applied receipt remains revision one');assert.equal(f.saved[0].content.fields.amount,20,'the applied receipt is not rewritten by a later read');
 assert.equal(f.editor.client.snapshot().draft.revision,2);assert.equal(f.editor.client.snapshot().draft.content.fields.amount,25);
 assert.equal(f.view.form.elements.namedItem('amount').value,'25','current form must follow the verified revision-two readback, not retain revision-one inputs');
 assert.equal(f.editor.beforeLeave(),null,'the latest confirmed read becomes the clean baseline');assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,1);
});

function actualAppPrivateUIBridge(editor){
 const source=readFileSync(new URL('./app.js',import.meta.url),'utf8'),start=source.indexOf('onChange(value){const previous=',source.indexOf('privateUI=createPrivateUIController('));assert.ok(start>=0,'locate the actual private-UI App callback');
 const open=source.indexOf('{',start);let depth=0,quote=null,escaped=false,end=-1;
 for(let index=open;index<source.length;index++){const char=source[index];if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote=null;continue;}if(char==='"'||char==="'"||char==='`'){quote=char;continue;}if(char==='{')depth++;else if(char==='}'&&--depth===0){end=index+1;break;}}
 assert.ok(end>open,'extract the complete actual callback, without importing or starting App');const method=source.slice(start,end);let privateOwner=null;
 const effects={events:[],refreshes:0,statuses:[]},context={privateDrafts:editor,workspaceSim:{privateUIOwner:()=>privateOwner,setPrivateUIOwner:value=>{privateOwner=value;}},document:{dispatchEvent:event=>{effects.events.push(event.type);return true;}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},workbenchTerminal:{refresh(){effects.refreshes++;}}};
 const callback=runInNewContext('({'+method+'}).onChange',context);
 return {effects,onChange(value){effects.statuses.push(value.identityStatus);callback(value);}};
}
function privateWorkspaceState(){return {schema:'private-workspace-v1',scope:OWNER,revision:0,updatedAt:0,preferences:{workbenchFilter:'all',workbenchFocusAsset:null,watchedAssets:[]},drafts:[],selectedDraftId:null,executionAuthority:'NONE'};}
function privateNotificationState(){return {schema:'private-notifications-v2',scope:OWNER,revision:0,updatedAt:0,inapp:true,events:['risk','research'],services:Object.fromEntries(['telegram','email'].map(channel=>[channel,{available:false,error:'CHANNEL_DISABLED'}])),channels:Object.fromEntries(['telegram','email'].map(channel=>[channel,{channel,label:'',enabled:0,verified:0}])),deliveries:[],inbox:[],unreadCount:0,reminderUnreadCount:0,nextCursor:null,mode:'server-research-only'};}

for(const denied of ['workspace','notifications'])test('actual App auth bridge clears held private editing after '+denied+' returns 403 without an identity event',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();const raw=rawInvalidEdit(f.view),draftCalls=f.calls.length;assert.equal(f.editor.holdRender(),true);
 let deny=false;const bridge=actualAppPrivateUIBridge(f.editor),uiCalls=[];
 const controller=createPrivateUIController({storage:memory(),now:()=>NOW,eventTarget:null,onChange:bridge.onChange,fetchImpl:async url=>{uiCalls.push(url);if(deny&&url.includes('/'+denied+'/'))return reply({error:'PRIVATE_FORBIDDEN',executionAuthority:'NONE'},403);return reply(url.includes('/workspace/')?privateWorkspaceState():privateNotificationState());}});t.after(()=>controller.dispose());
 controller.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'});await settle();assert.strictEqual(f.view.form,raw.form);assert.equal(f.editor.holdRender(),true);deny=true;
 if(denied==='workspace')await controller.loadWorkspace();else await controller.loadNotifications();
 assert.equal(controller.snapshot().identityStatus,'forbidden');assert.ok(bridge.effects.statuses.includes('forbidden'));assert.equal(f.calls.length,draftCalls,'shared authentication failure must not cause a new draft read or write');assert.equal(f.saved.length,0);
 assert.deepEqual({owner:f.editor.client.snapshot().ownerRef,held:f.editor.holdRender(),samePrivateForm:f.view.form===raw.form},{owner:null,held:false,samePrivateForm:false},'the actual App callback must revoke the separate private-draft client and hide held owner-A inputs');assert.doesNotMatch(f.view.html,/Owner A valid name still in this form/);
});

test('actual App auth bridge preserves dirty held editing for ready reads and ordinary 503 failures',async t=>{
 const f=editorFixture(t);f.setOwner();await f.mount();const raw=rawInvalidEdit(f.view),draftCalls=f.calls.length;let unavailable=false;
 const bridge=actualAppPrivateUIBridge(f.editor),controller=createPrivateUIController({storage:memory(),now:()=>NOW,eventTarget:null,onChange:bridge.onChange,fetchImpl:async url=>unavailable&&url.includes('/workspace/')?reply({error:'PRIVATE_UNAVAILABLE',executionAuthority:'NONE'},503):reply(url.includes('/workspace/')?privateWorkspaceState():privateNotificationState())});t.after(()=>controller.dispose());
 controller.setIdentity({ownerRef:OWNER,expiresAt:NOW+60000,authVersion:2,permissionProfile:'private-ui-v2'});await settle();await controller.loadWorkspace();assert.equal(controller.snapshot().workspace.status,'ready');assert.equal(controller.snapshot().identityStatus,'ready');assert.strictEqual(f.view.form,raw.form);assert.equal(f.editor.holdRender(),true);
 unavailable=true;await controller.loadWorkspace();assert.equal(controller.snapshot().workspace.status,'error');assert.equal(controller.snapshot().identityStatus,'ready');assert.equal(f.editor.client.snapshot().ownerRef,OWNER);assert.strictEqual(f.view.form,raw.form);assert.equal(raw.name.value,'Owner A valid name still in this form');assert.equal(f.editor.holdRender(),true);assert.equal(f.calls.length,draftCalls);assert.equal(f.calls.filter(c=>c.url.endsWith('/adopt')).length,0);
});
