import {CommerceStore} from './commerce-store.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {WorkspaceSim} from './workspace-sim.mjs';
import {MultiResearch} from './multi-research.mjs';
export async function commerceFixture(t,{storage}={}){
 let now=Date.UTC(2026,10,6,12);const store=new CommerceStore(':memory:',{now:()=>now,jobDelay:1000}),person=store.session().person;
 const fetchImpl=async(path,options={})=>{try{let body;if(path.endsWith('/state'))body={state:store.snapshot(person,options.headers?.['X-Workspace-Id'])};else{const p=JSON.parse(options.body);body=store.command(person,options.headers?.['X-Workspace-Id'],options.headers?.['Idempotency-Key'],p.action,p.payload);}return {ok:true,json:async()=>body};}catch(e){return {ok:false,json:async()=>({error:e.code||e.message})};}};
 const account=new MembershipAccount({storage,fetchImpl});await account.ready;const research=new MultiResearch(),workspace=new WorkspaceSim({account,research,storage});
 // Test UI confirmation is explicit in each caller; transport and ledger remain real.
 account.runTask=async request=>{const q=await account.command('quote',request);return account.command('job-start',{quote:q.id});};
 t.after(()=>{account.destroy();store.close();});
 return {store,person,account,research,workspace,fetchImpl,advance:async ms=>{now+=ms;await account.refresh();},buy:async(product='pro')=>{const o=await account.command('order-create',{kind:'plan',product});return account.command('order-pay',{id:o.id});}};
}
