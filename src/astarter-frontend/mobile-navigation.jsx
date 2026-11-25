// Adapted from https://21st.dev/@arunachalam/components/bottom-nav-bar.
// Keep its Motion interactions; the product owns routing and labels.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {motion,useReducedMotion,animate} from 'motion/react';

function BottomNavItems({items,icons,labels,hrefs,section,reducedMotion,onNavigate}){
 const prefersReducedMotion=useReducedMotion(),reduce=reducedMotion||prefersReducedMotion;
 return items.map((item,index)=>{
  const active=section===item.id;
  return <motion.a key={item.id} href={hrefs[index]} className="mobile-nav-item" data-mobile-section={item.id} data-page={item.home} aria-label={labels[index]} aria-current={active?'page':undefined} whileTap={reduce?undefined:{scale:.97}} onClick={event=>onNavigate(item.id,event)}>
   <motion.span layout={reduce?false:'position'} layoutDependency={section} transition={{layout:{duration:.26,ease:[.2,.7,.1,1]}}} className="mobile-nav-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html:icons[item.id]}}/>
   <span className="mobile-nav-label" aria-hidden="true">{labels[index]}</span>
  </motion.a>;
 });
}

export function mountMobileNavigation(host,{items,icons,onNavigate}){
 const root=createRoot(host);let previous='',entrance=null;
 return {update({section,labels,hrefs,label,reducedMotion}){
  const next=JSON.stringify([section,labels,hrefs,label,reducedMotion]);if(next===previous)return;
  const first=!previous;previous=next;host.setAttribute('aria-label',label);
  flushSync(()=>root.render(<BottomNavItems items={items} icons={icons} labels={labels} hrefs={hrefs} section={section} reducedMotion={reducedMotion} onNavigate={onNavigate}/>));
  if(reducedMotion){entrance?.stop();host.style.transform='';host.style.opacity='';}
  if(first&&host.offsetHeight&&!reducedMotion&&!matchMedia('(prefers-reduced-motion:reduce)').matches)entrance=animate(host,{scale:[.9,1],opacity:[0,1]},{type:'spring',stiffness:300,damping:26});
 },destroy(){entrance?.stop();root.unmount();host.style.transform='';host.style.opacity='';}};
}
