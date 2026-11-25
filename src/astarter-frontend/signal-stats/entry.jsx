import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AdvancedStats} from './advanced-stats.jsx';

export function mountAdvancedStats(container,records) {
  const roots=[];
  for(const host of container.querySelectorAll('[data-signal-stats]')) {
    const data=records.get(host.dataset.signalStats);if(!data)continue;
    const root=createRoot(host);roots.push({root,host,data});
  }
  if(!roots.length)return ()=>{};
  let observer,disposed=false;
  // The tracker keeps this function until the next Signals render; drop the unmounted roots so the old page can be collected.
  const dispose=()=>{if(disposed)return;disposed=true;observer?.disconnect();for(const {root} of roots)root.unmount();roots.length=0;};
  // Native route replacement bypasses the signal renderer; release roots and motion observers there too.
  const paint=()=>flushSync(()=>{for(const {root,data} of roots)root.render(<AdvancedStats data={data} reducedMotion={document.documentElement.dataset.reducedMotion==='true'}/>);});
  paint();
  observer=new MutationObserver(changes=>{if(container.hidden||roots.some(({host})=>!host.isConnected))dispose();else if(changes.some(change=>change.type==='attributes'&&change.attributeName==='data-reduced-motion'))paint();});
  observer.observe(container.parentNode||container,{childList:true,subtree:true});
  observer.observe(container,{attributes:true,attributeFilter:['hidden']});
  observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-reduced-motion']});
  return dispose;
}
