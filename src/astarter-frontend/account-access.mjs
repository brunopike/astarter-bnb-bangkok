// Independent review entry. Production services are deliberately not connected here.
import {mountAccountSecurity,SECURITY_PAGES} from './account-security.mjs';
const params=new URLSearchParams(location.search);
let locale=params.get('lang')==='en'?'en':'zh';
document.documentElement.lang=locale==='zh'?'zh-CN':'en';
document.documentElement.dataset.theme=params.get('theme')==='light'?'light':'dark';
const theme=document.querySelector('#access-theme'),picker=document.querySelector('#access-locale');
function labels(){
  picker.value=locale;
  const current=new URL(location.href);current.searchParams.set('lang',locale);current.searchParams.set('theme',document.documentElement.dataset.theme);history.replaceState(null,'',current);
  document.querySelectorAll('.access-header a').forEach(link=>{const page=new URL(link.href).searchParams.get('page');const url=new URL(current);url.searchParams.set('page',page);link.href=url;});
  theme.textContent=document.documentElement.dataset.theme==='dark'?(locale==='zh'?'浅色':'Light'):(locale==='zh'?'深色':'Dark');
  document.querySelector('[data-label=login]').textContent=locale==='zh'?'登录 / 注册':'Sign in / Join';
  document.querySelector('[data-label=security]').textContent=locale==='zh'?'安全中心':'Security';
}
const app=mountAccountSecurity(document.querySelector('#security-root'),{getLocale:()=>locale,navigate:(page,options)=>{
  const url=new URL(location.href);url.searchParams.set('page',page);history.pushState(null,'',url);if(options?.returnTo)app.show(SECURITY_PAGES.includes(page)?page:'security');window.scrollTo(0,0);
}});
const route=()=>{const page=new URLSearchParams(location.search).get('page');app.show(SECURITY_PAGES.includes(page)?page:'login');};
theme.onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';labels();};
picker.onchange=()=>{locale=picker.value;document.documentElement.lang=locale==='zh'?'zh-CN':'en';labels();app.render();};
window.addEventListener('popstate',route);
window.addEventListener('pagehide',()=>app.destroy(),{once:true});
labels();route();
