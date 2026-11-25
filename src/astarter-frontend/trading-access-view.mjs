import {ACCESS_COPY} from './trading-access.mjs?v=20261120c';
import {L} from './execution-views.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function accessPanel(access,{compact=false}={}){
 if(!access)return '';
 const copy=ACCESS_COPY[access.code]||ACCESS_COPY['review-again'],readOnly=access.code==='read-only';
 const bound=Boolean(access.connectionId)&&!access.localFixture&&copy[4]!=='retry-read',resource=['data','ai'].includes(copy[4]);
 const recovery=bound?`data-connection-open="${resource?copy[4]:access.profileId?.startsWith('dex')?'wallet':'exchange'}" data-connection-id="${esc(access.connectionId)}"`:`data-access-action="${copy[4]}" data-access-profile="${esc(access.profileId)}"`;
 const recoveryLabel=bound&&!resource?L('管理此接入','Manage this connection'):L(copy[5],copy[6]);
 const explanation=readOnly?`<details class="tc-info access-info"><summary aria-label="${esc(L(copy[0],copy[1]))}">i</summary><div>${esc(L(copy[2],copy[3]))}</div></details>`:'';
 return `<section class="trading-access ${access.ready?'is-ready':'needs-action'} ${compact?'is-compact':''}" data-access-code="${esc(access.code)}" data-localized-ui role="status"><div><span class="access-dot" aria-hidden="true"></span><b>${L(copy[0],copy[1])}</b>${explanation}<span class="access-account">${esc(access.accountId||'—')}</span></div>${!readOnly&&(!compact||!access.ready)?`<p>${L(copy[2],copy[3])}</p>`:''}${copy[4]?`<button type="button" class="p-button" ${recovery}>${recoveryLabel}</button>`:''}</section>`;
}
