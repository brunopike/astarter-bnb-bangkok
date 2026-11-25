// Proposed UI routing policy. The server must independently authorize every protected action.
export const SECURITY_ACTIONS = Object.freeze({
  browse: 'public', preferences: 'session', purchase: 'session',
  'pause-new-orders': 'protect', 'revoke-trading': 'protect', 'sign-out': 'protect',
  'link-social': 'reauth', 'unlink-social': 'reauth', 'link-email': 'reauth',
  'change-email': 'strong', 'link-wallet': 'strong', 'unlink-wallet': 'strong',
  'disable-2fa': 'strong', 'replace-2fa': 'strong', 'regenerate-recovery': 'strong',
  'add-trading-key': 'strong', 'increase-permissions': 'strong',
  'start-live-trading': 'strong', 'increase-budget': 'strong',
  'change-payment-destination': 'strong', 'delete-account': 'strong',
});

export function verificationPlan(action, {signedIn=false, totp=false, risk='normal', lastLoginMethod=false}={}) {
  const level=SECURITY_ACTIONS[action];
  if (!level) return {screen:'blocked',reason:'unknown-action'};
  if (level==='public') return {screen:'continue',reason:'public'};
  if (!signedIn) return {screen:'login',reason:'session-required'};
  if (lastLoginMethod && ['unlink-wallet','unlink-social'].includes(action)) return {screen:'blocked',reason:'last-login-method'};
  // Reducing authority must stay available to the current authenticated owner during an incident.
  if (level==='protect') return {screen:'confirm',reason:'protective-action'};
  if (level==='strong') return {screen:totp?'verify':'two-factor',reason:'sensitive-action',primaryReauth:true};
  if (risk!=='normal') return {screen:totp?'verify':'reauth',reason:'risk-event',primaryReauth:true};
  if (level==='reauth') return {screen:totp?'verify':'reauth',reason:'account-change',primaryReauth:true};
  return {screen:'confirm',reason:'normal-session'};
}

export function normalizeOtp(value) {
  const code=String(value??'').replace(/[\s-]/g,'');
  return /^[0-9]{6}$/.test(code)?code:null;
}

export function safeAccountReturn(value, fallback='?page=security') {
  if (typeof value!=='string' || !value.startsWith('?') || /[\\\r\n]/.test(value)) return fallback;
  const params=new URLSearchParams(value);
  const pages=['workbench','profile','security','social','account-social','sessions','plans','topup','usage','billing','settings','strategies','execution','logs','assets'];
  return pages.includes(params.get('page')) ? '?'+params.toString() : fallback;
}
