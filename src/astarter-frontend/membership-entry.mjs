import {localeReady,initLocale,pair} from './locale.mjs';
import {MembershipAccount} from './membership-account.mjs';
import {createMembership} from './membership.mjs';
import {createNumberInputs} from './product-number-input.mjs';
await localeReady;
document.querySelector('.membership-return').setAttribute('aria-label',pair('返回','Back')+' · Astarter');
createNumberInputs();
createMembership({root:document.getElementById('membership-app'),account:new MembershipAccount({storage:localStorage})});

initLocale();
