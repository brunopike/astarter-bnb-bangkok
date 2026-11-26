const experienceKey = 'astarter.experience.v1';
const returnKey = 'astarter.lite.practice-return.v1';
const locales = new Set(['zh', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'ru']);

export function rememberExperience(version, context = {}) {
  if (version !== 'lite' && version !== 'full') return;
  try {
    globalThis.localStorage?.setItem(experienceKey, version);
    if (version === 'full' && context.mode === 'practice')
      globalThis.sessionStorage?.setItem(returnKey, context.asset || '');
    else
      globalThis.sessionStorage?.removeItem(returnKey);
  } catch {}
}

function versionHref(path, { asset, signalId, lang } = {}) {
  const query = new URLSearchParams();
  if (path === '/signals') query.set('data', 'live');
  const symbol = String(asset ?? '')
    .trim()
    .toUpperCase();
  if (/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(symbol)) {
    query.set('asset', symbol);
    if (
      typeof signalId === 'string' &&
      signalId.startsWith(symbol + ':') &&
      /^[a-z\d.:-]{1,120}$/i.test(signalId)
    )
      query.set('signalId', signalId);
  }
  let locale = lang || new URLSearchParams(globalThis.location?.search).get('lang');
  try {
    locale ||= globalThis.localStorage?.getItem('hive.locale');
  } catch {}
  locale = (locale || globalThis.document?.documentElement.lang || '').toLowerCase().split('-')[0];
  if (locales.has(locale)) query.set('lang', locale);
  return path + (query.size ? '?' + query : '');
}

export const fullHrefFromLite = (context) => versionHref('/signals', context);
export function liteHrefFromFull(context = {}) {
  try {
    const previous = globalThis.sessionStorage?.getItem(returnKey);
    if (
      previous != null &&
      previous === (context.asset || '') &&
      globalThis.location?.pathname === '/signals'
    ) {
      const href = versionHref('/lite', { ...context, signalId: null });
      return href + (href.includes('?') ? '&' : '?') + 'mode=practice';
    }
  } catch {}
  return versionHref('/lite', context);
}

const versionSwitch = globalThis.document?.querySelector('.experience-switch');
if (versionSwitch) {
  const menu = versionSwitch.querySelector('details');
  const summary = menu.querySelector('summary');
  let liteContext = null;
  function contextFor(onLite) {
    const params = new URLSearchParams(location.search);
    const context = {
      asset: params.get('asset'),
      signalId: params.get('signalId'),
      mode: params.get('mode'),
      lang: document.documentElement.lang
    };
    if (onLite) {
      const current = document.querySelector('[data-lite-host] .lite-main')?.dataset;
      context.asset = current?.liteAsset || liteContext?.asset || context.asset;
      context.signalId = current?.liteSignal ?? liteContext?.signalId ?? context.signalId;
      context.mode = current?.liteMode || liteContext?.mode || context.mode;
    } else {
      const selected = document.querySelector('.sig-live-observation[aria-current="true"]')?.dataset;
      context.asset = selected?.liteAsset || context.asset;
      context.signalId = selected?.liteId || context.signalId;
    }
    return context;
  }
  function update() {
    const onLite = location.pathname === '/lite';
    if (!onLite) liteContext = null;
    const context = contextFor(onLite);
    for (const link of versionSwitch.querySelectorAll('a')) {
      const isLite = link.hasAttribute('data-open-lite');
      const active = onLite === isLite;
      link.href = active ? location.pathname + location.search : isLite ? liteHrefFromFull(context) : fullHrefFromLite(context);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const label = onLite ? 'Lite' : 'Full';
    summary.firstChild.nodeValue = label + ' ';
    summary.setAttribute('aria-label', 'Astarter version: ' + label);
  }
  update();
  versionSwitch.addEventListener('focusin', update);
  versionSwitch.addEventListener('pointerenter', update);
  versionSwitch.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    update();
    menu.open = false;
    if (link.getAttribute('aria-current') === 'page') {
      event.preventDefault();
      return;
    }
    const onLite = location.pathname === '/lite';
    const version = link.hasAttribute('data-open-lite') ? 'lite' : 'full';
    const context = contextFor(onLite);
    const navigation = new CustomEvent('astarter:experience-navigate', { cancelable: true, detail: { href: link.href } });
    if (!document.dispatchEvent(navigation)) {
      event.preventDefault();
      if (location.pathname !== new URL(link.href).pathname) return;
    }
    rememberExperience(version, context);
    update();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  versionSwitch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      summary.focus();
    }
  });
  document.addEventListener('astarter:lite-context', (event) => { liteContext = event.detail; update(); });
  let currentPage;
  document.addEventListener('astarter:experience-page', (event) => {
    if (event.detail !== 'lite' && currentPage === 'lite') rememberExperience('full');
    currentPage = event.detail;
    update();
  });
  document.addEventListener('hive:locale', update);
  window.addEventListener('popstate', update);
}
