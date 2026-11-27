export const LOCALES = Object.freeze([
  {id:'zh',tag:'zh-CN',name:'中文',short:'中'},
  {id:'en',tag:'en',name:'English',short:'EN'},
  {id:'ja',tag:'ja-JP',name:'日本語',short:'日'},
  {id:'ko',tag:'ko-KR',name:'한국어',short:'한'},
  {id:'vi',tag:'vi-VN',name:'Tiếng Việt',short:'VI'},
  {id:'es',tag:'es',name:'Español',short:'ES'},
  {id:'fr',tag:'fr-FR',name:'Français',short:'FR'},
  {id:'ru',tag:'ru-RU',name:'Русский',short:'RU'}
]);
export const normalizeLocale=value=>LOCALES.find(x=>x.id===String(value).toLowerCase().split('-')[0])?.id||'en';
export const localeInfo=value=>LOCALES.find(x=>x.id===normalizeLocale(value));

const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const slots=value=>[...value.matchAll(/\{p(\d+)\}/g)].map(x=>Number(x[1]));
function template(source,target){
  const parts=source.split(/(\{p\d+\})/g),indices=slots(source);
  if(!indices.length)return null;
  const literal=parts.filter((_,i)=>i%2===0).sort((a,b)=>b.trim().length-a.trim().length)[0];
  const countOnly=indices.length===1&&/^[\s\{p\d\}]*[个条笔项组根秒次天日][\s\{p\d\}]*$/.test(source);
  if(literal.trim().length<2&&!countOnly)return null;
  const pattern=new RegExp('^'+parts.map((part,i)=>i%2?(countOnly?'([+-]?\\d[\\d,.]*)':'([\\s\\S]*?)'):escape(part)).join('')+'$');
  return {source,target,indices,literal,pattern,weight:source.replace(/\{p\d+\}/g,'').length};
}

// Translate messages as units. Captured prices, IDs and counts are carried through intact.
export function createMessageCatalog(messages){
  const english=new Map(messages.map(([source,en])=>[source.trim(),en])),known=new Map(messages.map(([,en])=>[en.trim(),en]));
  const patterns=messages.map(([source,en])=>template(source.trim(),en)).filter(Boolean).sort((a,b)=>b.weight-a.weight);
  const packs=new Map(),reverse=new Map(),reversePatterns=[],cache=new Map();
  const englishPatterns=[...known.values()].map(en=>template(en.trim(),en)).filter(Boolean).sort((a,b)=>b.weight-a.weight);
  function register(locale,pack){
    packs.set(locale,pack);
    for(const [en,value]of Object.entries(pack)){
      known.set(en.trim(),en);
      if(!reverse.has(value))reverse.set(value.trim(),en);
      const p=template(value.trim(),en);if(p)reversePatterns.push(p);
    }
    reversePatterns.sort((a,b)=>b.weight-a.weight);cache.clear();
  }
  function match(text,list){
    for(const p of list){if(!text.includes(p.literal))continue;const m=p.pattern.exec(text);if(m){const values={};p.indices.forEach((id,i)=>values[id]=m[i+1]);return {en:p.target,values};}}
    return null;
  }
  function resolve(text,locale,depth=0){
    if(typeof text!=='string'||!text||locale==='zh')return text;
    const key=locale+'\0'+text;if(cache.has(key))return cache.get(key);
    const whitespace=text.match(/^(\s*)([\s\S]*?)(\s*)$/),trimmed=whitespace[2];
    let en=english.get(trimmed)||(known.get(trimmed)||reverse.get(trimmed)),values;
    if(!en){const m=match(trimmed,patterns)||match(trimmed,englishPatterns)||match(trimmed,reversePatterns);if(m){en=m.en;values=m.values;}}
    if(!en&&depth<6){
      const prefix=trimmed.match(/^([\p{P}\p{S}\p{M}\s]+|[A-Z0-9._:-]{1,20}(?:\/[A-Z0-9._:-]{1,20})?\s+)(.+)$/u);
      const version=trimmed.match(/^(.+?)(\s+v\d+(?:\.\d+)*)$/);
      let composed=null;
      if(prefix){const value=resolve(prefix[2],locale,depth+1);if(value!==null)composed=prefix[1]+value;}
      if(composed===null&&version){const value=resolve(version[1],locale,depth+1);if(value!==null)composed=value+version[2];}
      if(composed===null){const parts=trimmed.split(/(\s[·→|]\s|\s\/\s|[:：]\s)/);if(parts.length>1){let changed=false;const result=parts.map((part,i)=>{if(i%2)return part;const value=resolve(part,locale,depth+1);if(value!==null&&value!==part)changed=true;return value??part;}).join('');if(changed)composed=result;}}
      if(composed!==null)return whitespace[1]+composed+whitespace[3];
    }
    if(!en)return null;
    let result=(locale==='en'?en:packs.get(locale)?.[en])??en;
    if(values)result=result.replace(/\{p(\d+)\}/g,(_,id)=>depth<6?(resolve(values[id],locale,depth+1)??values[id]):values[id]);
    result=whitespace[1]+result.trim()+whitespace[3];
    if(cache.size>4096)cache.clear();cache.set(key,result);return result;
  }
  return {register,resolve,has:locale=>packs.has(locale)};
}
