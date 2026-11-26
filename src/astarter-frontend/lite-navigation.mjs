const experienceKey = 'astarter.experience.v1';
const locales = new Set(['zh', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'ru']);

function rememberExperience(version) {
  try {
    globalThis.localStorage?.setItem(experienceKey, version);
  } catch {}
}

function homeHref(path, { lang } = {}) {
  let locale = lang || new URLSearchParams(globalThis.location?.search).get('lang');
  try {
    locale ||= globalThis.localStorage?.getItem('hive.locale');
  } catch {}
  locale = (locale || globalThis.document?.documentElement.lang || '').toLowerCase().split('-')[0];
  return locales.has(locale) ? path + '?lang=' + locale : path;
}

export const fullHrefFromLite = (preferences) => homeHref('/', preferences);
export const liteHrefFromFull = (preferences) => homeHref('/lite', preferences);

const versionSwitch = globalThis.document?.querySelector('.experience-switch');
if (versionSwitch) {
  const menu = versionSwitch.querySelector('details');
  const summary = menu.querySelector('summary');
  function update() {
    const onLite = location.pathname.replace(/\/+$/, '') === '/lite';
    const preferences = { lang: document.documentElement.lang };
    for (const link of versionSwitch.querySelectorAll('a')) {
      const isLite = link.hasAttribute('data-open-lite');
      const active = onLite === isLite;
      link.href = active ? location.pathname + location.search : isLite ? liteHrefFromFull(preferences) : fullHrefFromLite(preferences);
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
    const version = link.hasAttribute('data-open-lite') ? 'lite' : 'full';
    const destination = new URL(link.href);
    const navigation = new CustomEvent('astarter:experience-navigate', { cancelable: true, detail: { href: destination.href } });
    if (!document.dispatchEvent(navigation)) {
      event.preventDefault();
      if (location.pathname !== destination.pathname) return;
    }
    rememberExperience(version);
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
  let currentPage;
  document.addEventListener('astarter:experience-page', (event) => {
    if (currentPage && (event.detail === 'lite') !== (currentPage === 'lite')) {
      rememberExperience(event.detail === 'lite' ? 'lite' : 'full');
    }
    currentPage = event.detail;
    update();
  });
  document.addEventListener('hive:locale', update);
  window.addEventListener('popstate', update);
}
