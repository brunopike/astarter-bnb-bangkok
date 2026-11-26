const CHAIN_ID=56;
const LIFETIME_SECONDS=300;
const ADDRESS_SLOT='<YOUR_BSC_AGENTIC_WALLET_ADDRESS>';
const PURPOSE='No transaction or spending authorization.';
function proofPurpose(owner) {
 return (owner ? 'Link this BSC agent address to the named Astarter account. ' : 'Remember this verified BSC agent address in this browser for seven days. ') + PURPOSE;
}
const issued=new WeakMap();

function error(code){return Object.assign(new Error(code),{code});}
function normalizedAddress(value){
 if(typeof value!=='string'||!/^0x[0-9a-f]{40}$/i.test(value)||/^0x0{40}$/i.test(value))throw error('INVALID_ADDRESS');
 return value.toLowerCase();
}
function normalizedOwner(value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string')throw error('INVALID_OWNER');
 try{return normalizedAddress(value.replace(/^wallet:56:/i,''));}catch{throw error('INVALID_OWNER');}
}
function checkedOrigin(value){
 let url;
 try{url=new URL(value);}catch{throw error('INVALID_ORIGIN');}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.origin!==value||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))throw error('INVALID_ORIGIN');
 return url.origin;
}
function randomNonce(){
 if(!globalThis.crypto?.getRandomValues)throw error('RANDOMNESS_UNAVAILABLE');
 return '0x'+Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function walletProofTypedData(challenge,agentWallet){
 return {
  domain:{name:'Astarter Wallet Address Proof',version:'1',chainId:CHAIN_ID},
  types:{AstarterWalletProof:[
   {name:'site',type:'string'},{name:'siteAccount',type:'string'},{name:'agentWallet',type:'address'},{name:'purpose',type:'string'},
   {name:'nonce',type:'bytes32'},{name:'issuedAt',type:'uint64'},{name:'expiresAt',type:'uint64'}
  ]},
  primaryType:'AstarterWalletProof',
  message:{site:challenge.origin,siteAccount:challenge.siteOwner||'guest',agentWallet,purpose:proofPurpose(challenge.siteOwner),nonce:challenge.nonce,
   issuedAt:challenge.issuedAt/1000,expiresAt:challenge.expiresAt/1000},
 };
}

// The RPC signer and the address shown in the signed message must agree.
export function agentWalletTypedData(challenge,address){
 if(!issued.has(challenge))throw error('INVALID_CHALLENGE');
 return walletProofTypedData(challenge,normalizedAddress(address));
}
function rpcTemplate(challenge){
 const data=walletProofTypedData(challenge,ADDRESS_SLOT);
 const types={EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'}],...data.types};
 return Object.freeze({method:'eth_signTypedData_v4',params:Object.freeze([ADDRESS_SLOT,JSON.stringify({...data,types})])});
}
function instructionsFor(rpc,locale){
 const json=JSON.stringify(rpc);
 return /^zh/i.test(locale)
  ? '请用我已配对的 Binance Agentic Wallet 验证 Astarter 地址。读取本机钱包在 BNB Smart Chain（56）的地址，将以下 JSON 中两处 '+ADDRESS_SLOT+'（签名人和消息里的 agentWallet）都替换为该地址，其余字段逐字保留。用 Binance 官方 sign-message 流程预览 EIP712 消息，向我展示站点、站内账户、Agent 钱包地址、用途和有效期，等我明确确认后再签名。如果需要，请在 Binance App 完成开发者模式设置。请只返回 {"address":"0x…","signature":"0x…"}。\n\n'+json
  : 'Use my paired Binance Agentic Wallet to prove its address to Astarter. Read its BNB Smart Chain (56) address locally and replace both instances of '+ADDRESS_SLOT+' in the JSON below with that address (the signer and the agentWallet message field). Keep every other field unchanged. Preview this EIP712 message using the official Binance sign-message flow. Show me the site, site account, agent wallet address, purpose and expiry and wait for my explicit confirmation before signing. If required, I will enable Developer Mode in the Binance App. Return only {"address":"0x…","signature":"0x…"}.\n\n'+json;
}
export function createAgentWalletProof({origin=globalThis.location?.origin,siteOwner=null,locale='zh',now=Date.now}={}){
 const issuedAt=Math.floor(now()/1000)*1000;
 const fields={chainId:CHAIN_ID,origin:checkedOrigin(origin),siteOwner:normalizedOwner(siteOwner),nonce:randomNonce(),
  issuedAt,expiresAt:issuedAt+LIFETIME_SECONDS*1000};
 const rpcRequest=rpcTemplate(fields);
 const challenge=Object.freeze({...fields,rpcRequest,instructions:instructionsFor(rpcRequest,locale)});
 issued.set(challenge,'ready');
 return challenge;
}
export async function verifyAgentWalletProof({challenge,address,signature,origin=globalThis.location?.origin,siteOwner=null,verifyTypedData}={}){
 const state=issued.get(challenge);
 if(!state)throw error('INVALID_CHALLENGE');
 if(challenge.origin!==checkedOrigin(origin)||challenge.siteOwner!==normalizedOwner(siteOwner))throw error('SCOPE_CHANGED');
 if(Date.now()>=challenge.expiresAt)throw error('CHALLENGE_EXPIRED');
 if(state==='used')throw error('CHALLENGE_USED');
 if(state==='checking')throw error('CHECK_IN_PROGRESS');
 const signer=normalizedAddress(address);
 if(typeof signature!=='string'||!/^0x[0-9a-f]{130}$/i.test(signature))throw error('INVALID_SIGNATURE');
 if(typeof verifyTypedData!=='function')throw error('VERIFIER_UNAVAILABLE');
 issued.set(challenge,'checking');
 try{
  const valid=await verifyTypedData({address:signer,...walletProofTypedData(challenge,signer),signature});
  if(valid!==true)throw error('INVALID_SIGNATURE');
  const verifiedAt=Date.now();
  if(verifiedAt>=challenge.expiresAt)throw error('CHALLENGE_EXPIRED');
  issued.set(challenge,'used');
  return Object.freeze({address:signer,chainId:CHAIN_ID,verifiedAt,expiresAt:challenge.expiresAt});
 }catch(cause){
  issued.set(challenge,'ready');
  throw error(cause?.code==='CHALLENGE_EXPIRED'?'CHALLENGE_EXPIRED':'INVALID_SIGNATURE');
 }
}
