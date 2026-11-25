let binding;
export function bindLiquidSelects(root=document) {
 if(binding)return binding;
 binding=import('./liquid-select-ui/liquid-select.js').then(module=>{
  if(!getComputedStyle(root.documentElement).getPropertyValue('--lq-duration').trim())throw new Error('Liquid Select stylesheet unavailable');
  return module.mountLiquidSelects(root);
 }).catch(error=>{
  console.warn('Liquid select unavailable; native controls remain usable',error);
 });
 return binding;
}
