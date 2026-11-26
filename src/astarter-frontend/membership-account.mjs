import {L} from './execution-views.mjs';
import {estimate,PLANS} from './commerce-catalog.mjs';
export const MEMBERSHIP_KEY='astarter-membership-preview-v1';
const POLL_INTERVAL=4000,MAX_POLL_DELAY=60000;
const empty=()=>({plan:'free',preferences:{autoBudget:0,singleLimit:0,autoEnabled:false,byok:false},balance:{available:0,reserved:0,spent:0},budget:{spent:0,reserved:0},tasks:[],lots:[],orders:[],ledger:[],scopes:[],resources:[],members:[],entitlements:PLANS.free});
const errorZh=code=>({'billing-interval':'请选择月付、季付或年付。','payment-method':'请选择有效的支付方式。','payment-unavailable':'$AST 支付尚未开放，请使用模拟支付。','order-quote-changed':'订阅或价格已变化，请关闭后重新确认。','asset-job-active':'该资产已有研究任务，请先等待完成或取消。',insufficient:'Credit 不足，请先充值模拟余额。',capacity:'已有任务处理中，请等待完成或取消。','daily-dispatch-limit':'今日任务次数已用完。','plan-required':'此功能需要订阅权益，请到订阅页查看适用套餐。','auto-paused':'自动研究未开启。','single-limit':'超过单次 Credit 上限。',budget:'今日自动研究预算不足。','member-budget':'超过管理员设置的成员日预算。','resource-limit':'已达保存上限，请移除不用的项目或选择更高容量套餐。','quote-expired':'报价已过期或订阅状态变化，请重新报价。','scope-too-large':'研究范围超出此档位，请缩小范围或选择更高档。','admin-required':'只有工作区管理员可以操作。','viewer-read-only':'当前成员只有查看权限，请联系工作区管理员调整角色。','credit-reserved':'该订单的 Credit 正被预留，请先等待任务完成。','renewal-already-queued':'已有下一期订阅，请先处理该订单。','workspace-plan-mismatch':'Team 订阅请在 Team 工作区开通。','refund-quote-changed':'退款金额已变化，请重新查看退款报价。','profile-circuit-open':'此类任务失败率过高，已暂停新的付费任务。','invite-invalid':'邀请码无效、已使用或已过期，请向工作区管理员获取新邀请。','already-member':'你已加入该团队，请在工作区选择器中切换。','seats-full':'团队的 5 个席位已满，请联系管理员。','team-required':'该团队需要有效的 Team 订阅，请联系管理员续期。','topup-range':'请输入 10–1,000 美元的整数充值金额。','member-policy':'请选择有效角色，并填写非负整数的成员预算。','service-unavailable':'账本服务暂不可用，请刷新重试。','network-unknown':'网络中断，结果尚未确认。请刷新账单或任务记录，避免重复提交。'}[code]||`操作未完成（${code}）`);
const errorEn={'billing-interval':'Choose monthly, quarterly or yearly billing.','payment-method':'Choose a valid payment method.','payment-unavailable':'$AST payments are not available. Use simulated payment.','order-quote-changed':'Your subscription or price changed. Close and review it again.',insufficient:'Insufficient Credits. Add simulated credit to continue.',capacity:'Another task is processing. Wait for completion or cancel it.','asset-job-active':'Research for this asset is already running.','daily-dispatch-limit':'The daily task limit has been reached.','plan-required':'This feature requires a subscription.','auto-paused':'Automatic research is disabled.','single-limit':'This exceeds the per-job Credit limit.',budget:'The daily automatic research budget is insufficient.','member-budget':'This exceeds your member daily Credit budget.','resource-limit':'The saved-item limit has been reached. Remove unused items or choose a higher-capacity plan.','quote-expired':'The quote expired or your subscription changed. Request a new quote.','scope-too-large':'This research scope exceeds the selected profile. Reduce its scope.','admin-required':'Only a workspace administrator can perform this action.','viewer-read-only':'You have read-only access. Ask a workspace administrator to change your role.','credit-reserved':'Credits from this order are reserved. Wait for the task to finish.','renewal-already-queued':'One future subscription period is already scheduled.','workspace-plan-mismatch':'Choose the matching personal or Team workspace.','refund-quote-changed':'The refund amount changed. Review a new refund quote.','profile-circuit-open':'New tasks of this type are paused after repeated failures.','service-unavailable':'The ledger is unavailable. Please refresh and try again.','network-unknown':'The connection was interrupted. Refresh orders or task history before submitting again.','invite-invalid':'The invitation is invalid, used or expired. Ask the administrator for a new invitation.','already-member':'You already belong to this team. Switch to it using the workspace selector.','seats-full':'All five team seats are in use. Contact the administrator.','member-policy':'Choose a valid role and a non-negative whole-number budget.','team-required':'This workspace needs an active Team subscription. Ask its administrator to renew.','topup-range':'Enter a whole USD amount from 10 to 1,000.'};
export const commerceError=code=>L(errorZh(code),errorEn[code]||`Request could not be completed (${code}).`);
export class MembershipAccount{
 constructor({storage=null,fetchImpl=globalThis.fetch,base='/api/commerce'}={}){
  this.storage=storage;this.fetch=fetchImpl.bind(globalThis);this.base=base;this.s=empty();this.revision=0;this.error='';this.listeners=new Set();this.scope='';this.readSerial=0;this.epoch=0;this.mutating=false;this.payers={model:'official',data:'official'};
  // Legacy browser balances remain a read-only archive and never become server credit.
  try{this.legacy=JSON.parse(storage?.getItem(MEMBERSHIP_KEY)||'null');}catch{this.legacyError=true;}
  // Open the account's default ledger; previously created team ledgers stay intact.
  this.activeReads=0;this.pollDelay=POLL_INTERVAL;
  if(typeof window!=='undefined'){this.focus=()=>{if(!this.activeReads)this.refresh();};window.addEventListener('focus',this.focus);}
  this.ready=this.refresh();this.queue=Promise.resolve();
 }
 subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 update(state){this.s=state;this.scope=state.scope;this.revision++;this.error='';for(const fn of this.listeners)fn(state);}
 async request(path,init={}){const response=await this.fetch(this.base+path,{credentials:'same-origin',signal:AbortSignal.timeout(10000),...init,headers:{...(this.scope?{'X-Workspace-Id':this.scope}:{}),...init.headers}});const body=await response.json();if(!response.ok)throw Object.assign(Error(commerceError(body.error)),{code:body.error});return body;}
 schedulePoll(){
  if(!this.focus)return;
  this.poll=setTimeout(()=>{
   if(!this.mutating&&(document.visibilityState==='visible'||this.s.tasks.some(j=>['reserved','unknown'].includes(j.status))))this.refresh();
   else this.schedulePoll();
  },this.pollDelay);
 }
 async refresh(){
  if(this.mutating)return this.s;
  clearTimeout(this.poll);
  this.activeReads++;
  const scope=this.scope,epoch=this.epoch,serial=++this.readSerial;
  const current=()=>scope===this.scope&&epoch===this.epoch&&serial===this.readSerial;
  try{
   const r=await this.request('/state');
   if(current()){this.pollDelay=POLL_INTERVAL;this.update(r.state);}
   return this.s;
  }catch(e){
   if(!current())return null;
   if(e.code==='workspace-forbidden'&&!this.s.scope&&scope){this.scope='';this.scopeRecovered=true;try{this.storage?.removeItem('astarter.preview.workspace');}catch{}return this.refresh();}
   this.pollDelay=Math.min(this.pollDelay*2,MAX_POLL_DELAY);
   const error=e.message||commerceError('service-unavailable');
   if(this.error!==error){this.error=error;this.revision++;for(const fn of this.listeners)fn(this.s);}
   return null;
  }finally{
   this.activeReads--;
   if(this.activeReads===0)this.schedulePoll();
  }
 }
 command(action,payload={},key=crypto.randomUUID()){
  const scope=this.scope;
  const run=async()=>{if(this.scope!==scope)throw Error(L('账户状态已更新，请重新操作。','Your account changed. Please try again.'));this.mutating=true;this.epoch++;try{let r;for(let attempt=0;attempt<2;attempt++){try{r=await this.request('/command',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({action,payload})});break;}catch(e){if(e.code||attempt)throw e.code?e:Error(commerceError('network-unknown'));}}if(this.scope===scope)this.update(r.state);return r.result;}finally{this.mutating=false;this.epoch++;}};
  const result=this.queue.then(run);this.queue=result.catch(()=>{});return result;
 }
 async switchScope(id){await this.queue;const previous=this.scope;this.scope=id;const state=await this.refresh();if(!state){this.scope=previous;throw Error(this.error);}try{this.storage?.setItem('astarter.preview.workspace',id);}catch{}return state;}
 get available(){return this.s.balance.available;}get reserved(){return this.s.balance.reserved;}get spent(){return this.s.balance.spent;}get budget(){return this.s.budget;}
 price(base){if([4,16,20].includes(base))return 0;if([6,8].includes(base))return estimate('R1',this.s.plan,this.getPayers?.()||this.payers)[base===8?'max':'normal'];throw Error('unsupported-workflow');}
 async runTask({profile='R1',input={},mode='manual',payers=this.getPayers?.()||this.payers}={}){await this.ready;if(this.error)throw Error(this.error);const {confirmTask}=await import('./commerce-ui.mjs');return confirmTask(this,{profile,input,mode,payers});}
 async cancel(id){if(id)await this.command('job-cancel',{id});}
 async setBudget(values){try{await this.command('preferences',{daily:Number(values.daily),single:Number(values.single??this.s.preferences.singleLimit),enabled:values.enabled??this.s.preferences.autoEnabled});return null;}catch(e){return e.message;}}
 async resource(kind,key,remove=false){return this.command('resource',{kind,key,remove});}
 async checkout(kind,product,interval='monthly'){const {checkout}=await import('./commerce-ui.mjs');return checkout(this,kind==='plan'?{kind,product,interval}:{kind,dollars:product});}
 destroy(){clearTimeout(this.poll);if(this.focus){window.removeEventListener('focus',this.focus);this.focus=null;}}
}
