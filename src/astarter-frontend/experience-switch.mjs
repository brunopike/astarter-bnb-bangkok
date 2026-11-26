import {getLocale} from './locale.mjs';

const picker=document.querySelector('.experience-switch');
const menu=picker.querySelector('details');
const trigger=menu.querySelector('summary');

function updateLiteLinks(){
 const url=new URL('https://dapp.ipfund.art/lite');
 url.searchParams.set('lang',getLocale());
 for(const link of picker.querySelectorAll('[data-open-lite]'))link.href=url.href;
}
updateLiteLinks();
document.addEventListener('hive:locale',updateLiteLinks);
picker.addEventListener('click',event=>{
 if(!event.target.closest('a[aria-current="page"]')||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
 event.preventDefault();
 if(menu.open){menu.open=false;trigger.focus();}
});
picker.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&menu.open){menu.open=false;trigger.focus();event.preventDefault();}
});
document.addEventListener('pointerdown',event=>{if(menu.open&&!picker.contains(event.target))menu.open=false;});
document.addEventListener('focusin',event=>{if(menu.open&&!picker.contains(event.target))menu.open=false;});
