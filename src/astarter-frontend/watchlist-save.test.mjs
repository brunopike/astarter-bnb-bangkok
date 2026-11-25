import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {watchlistEntries} from './watchlist-view.mjs';

const body=readFileSync(new URL('./watchlist-view.mjs',import.meta.url),'utf8').match(/async function save\(asset,remove\)\{([\s\S]*?)\n \}\n function open\(/)[1];
function fixture({keys=['BTC'],account=true,failure=false,quota=false,privateMode=false}={}){
 const rows=[{id:'bitcoin',symbol:'BTC',name:'Bitcoin',price:null,series:[]}],store=new Map([
  ['targets',JSON.stringify({watched:keys,filter:'scan'})],['hive.dc.assets',JSON.stringify(keys)],['metadata',JSON.stringify(rows)],
 ]),calls=[],notices=[];let touched=0,failed=false,resources=[...keys];
 const storage={getItem:key=>store.get(key)??null,setItem(key,value){if(failure&&key==='hive.dc.assets'&&!failed){failed=true;throw Error('STORAGE_FAILED');}store.set(key,value);},removeItem:key=>store.delete(key)};
 const w={storage,touch(){touched++;},account:account?{async resource(kind,key,remove){calls.push({kind,key,remove});if(quota)throw Error('Saved-item limit reached');resources=remove?resources.filter(x=>x!==key):[...new Set([...resources,key])];}}:null};
 let privateKeys=[...keys];w.privateUIOwner=()=>privateMode?'wallet:private':null;w.s={workbenchFilter:'scan',workbenchFocusAsset:null};w.applyPrivateUIPreferences=(owner,prefs)=>{assert.equal(owner,'wallet:private');privateKeys=[...prefs.watchedAssets];return null;};
 const getKeys=()=>privateMode?privateKeys:account?resources:JSON.parse(storage.getItem('targets')).watched;
 const context={keys:getKeys,canonical:key=>watchlistEntries([key])[0].key,isSaved:asset=>watchlistEntries(getKeys(),rows).some(entry=>entry.asset.id===asset.id),assetKey:a=>a.id==='bitcoin'?'BTC':'coin:'+a.id,entries:()=>watchlistEntries(getKeys(),rows),research:{task:()=>null},metadata:rows,w,notify:text=>notices.push(text),L:(_zh,en)=>en,WATCH_ASSETS_KEY:'metadata',WORKBENCH_TARGETS_KEY:'targets',document:{dispatchEvent(){}},CustomEvent:class{}};
 const save=Function(...Object.keys(context),`return async function(asset,remove){${body}}`)(...Object.values(context));
 return {save,store,calls,notices,keys:getKeys,touched:()=>touched};
}
test('removing a known alias removes each exact saved key without touching a same-symbol coin',async()=>{
 const f=fixture({keys:['BTC','coin:bitcoin','coin:other-btc']});
 await f.save({id:'bitcoin',symbol:'BTC',watchKeys:['BTC','coin:bitcoin']},true);
 assert.deepEqual(f.calls.map(call=>call.key),['BTC','coin:bitcoin']);
 assert.deepEqual(f.keys(),['coin:other-btc']);assert.equal(f.touched(),1);
});
test('account rejection keeps the prior collection and cache intact',async()=>{
 const f=fixture({quota:true}),before=new Map(f.store);
 await assert.rejects(f.save({id:'other-btc',symbol:'BTC',name:'Other',price:null,series:[]},false),{name:'WatchlistSaveError',message:'Saved-item limit reached'});
 assert.deepEqual(f.store,before);assert.deepEqual(f.keys(),['BTC']);assert.equal(f.touched(),0);
});
test('private watch changes update only the UI overlay, without membership calls or anonymous storage writes',async()=>{
 const f=fixture({keys:['BTC'],privateMode:true}),before=new Map(f.store);
 await f.save({id:'ethereum',symbol:'ETH',name:'Ethereum',price:null,series:[]},false);
 assert.deepEqual(f.keys(),['BTC','coin:ethereum']);assert.deepEqual(f.calls,[]);assert.deepEqual(f.store,before);assert.equal(f.touched(),0);
 await f.save({id:'bitcoin',symbol:'BTC',name:'Bitcoin',price:null,series:[]},true);
 assert.deepEqual(f.keys(),['coin:ethereum']);assert.deepEqual(f.store,before);
});
test('offline writes share both existing lists and preserve the research filter',async()=>{
 const f=fixture({account:false});
 await f.save({id:'other-btc',symbol:'BTC',name:'Other',price:null,series:[]},false);
 assert.deepEqual(JSON.parse(f.store.get('targets')),{watched:['BTC','coin:other-btc'],filter:'scan'});
 assert.deepEqual(JSON.parse(f.store.get('hive.dc.assets')),['BTC','coin:other-btc']);
 assert.equal(JSON.parse(f.store.get('metadata'))[1].price,null);
});
test('a failed offline write restores both lists and metadata rather than claiming success',async()=>{
 const f=fixture({account:false,failure:true}),before=new Map(f.store);
 await assert.rejects(f.save({id:'other-btc',symbol:'BTC',name:'Other',price:null,series:[]},false),{name:'WatchlistSaveError'});
 assert.deepEqual(f.store,before);assert.equal(f.touched(),0);
});
test('a cache failure after server success preserves the saved identity and reports the cache limitation',async()=>{
 const f=fixture({failure:true});
 await f.save({id:'other-btc',symbol:'BTC',name:'Other',price:null,series:[]},false);
 assert.deepEqual(f.keys(),['BTC','coin:other-btc']);assert.equal(f.notices.length,1);
 assert.match(f.notices[0],/Watchlist saved/);assert.equal(f.touched(),1);
});
