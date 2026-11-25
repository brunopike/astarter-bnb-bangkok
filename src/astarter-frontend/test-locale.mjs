// Chinese copy assertions use an explicit test locale; production still defaults to English.
const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
try{
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>key==='hive.locale'?'zh':null}});
 await (await import('./locale.mjs')).localeReady;
}finally{
 if(prior)Object.defineProperty(globalThis,'localStorage',prior);
 else delete globalThis.localStorage;
}
