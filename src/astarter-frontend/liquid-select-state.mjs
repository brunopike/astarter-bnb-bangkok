export function selectOptions(select) {
 const groups=[...select.querySelectorAll('optgroup')];
 return [...select.options].map((option,index)=>({
  value:String(index),label:option.label,disabled:option.disabled||option.parentElement?.disabled||false,
  hidden:option.hidden||option.parentElement?.hidden||false,
  ...(option.parentElement?.tagName==='OPTGROUP'?{group:String(groups.indexOf(option.parentElement)+1),groupLabel:option.parentElement.label}:{})
 })).filter(option=>!option.hidden);
}

export function chooseOption(select,index) {
 const option=select.options[Number(index)];
 if(!option||select.matches(':disabled')||option.disabled||option.parentElement?.disabled||option.hidden||option.parentElement?.hidden||select.selectedIndex===Number(index))return false;
 select.selectedIndex=Number(index);
 const EventClass=select.ownerDocument.defaultView.Event;
 select.dispatchEvent(new EventClass('input',{bubbles:true}));
 select.dispatchEvent(new EventClass('change',{bubbles:true}));
 return true;
}

// A filter change may replace its entire page section inside its native change event.
export function replacementSelect(original,scope) {
 const identity=[...original.attributes].filter(({name})=>name==='id'||name==='name'||name==='aria-label'||name==='aria-labelledby'||name.startsWith('data-'));
 if(!identity.length)return null;
 const matches=[...scope.querySelectorAll('select')].filter(field=>identity.every(({name,value})=>field.getAttribute(name)===value));
 return matches.length===1?matches[0]:null;
}

export function selectLabel(select) {
 if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
 return [...(select.labels||[])].map(label=>{
  const copy=label.cloneNode(true);
  copy.querySelectorAll('select,button,input,textarea,.liquid-native-host,.brand-mark,.brand-select-leading').forEach(node=>node.remove());
  return copy.textContent.trim();
 }).filter(Boolean).join(' ')||select.title||'';
}
