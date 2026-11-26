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
  const mobileDock = document.createElement('nav');
  mobileDock.className = 'lite-mobile-nav';
  mobileDock.dataset.noTranslate = '';
  mobileDock.hidden = true;
  mobileDock.innerHTML = `<a href="#lite-workspace" aria-current="location"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/></svg><span></span></a>
    <a href="#lite-chat-panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 2v-9.5A9 9 0 0 1 12 3a9 9 0 0 1 9 8.5ZM8 10h8M8 14h5"/></svg><span></span></a>
    <a href="/" data-open-full><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m6-6-6 6 6 6"/></svg><span></span></a>`;
  document.body.append(mobileDock);
  const [signalsLink, chatLink, fullLink] = mobileDock.children;
  const dockLabels = {
    zh: ['策略', 'AI 助手', '返回完整版'], en: ['Strategies', 'AI Chat', 'Back to Full'],
    ja: ['戦略', 'AI チャット', 'Full に戻る'], ko: ['전략', 'AI 채팅', 'Full로 돌아가기'],
    vi: ['Chiến lược', 'Chat AI', 'Về bản Full'], es: ['Estrategias', 'Chat IA', 'Volver a Full'],
    fr: ['Stratégies', 'Chat IA', 'Retour à Full'], ru: ['Стратегии', 'ИИ-чат', 'В Full']
  };
  const mobile = window.matchMedia('(max-width: 900px)');
  function setSection(inChat) {
    const active = inChat ? chatLink : signalsLink;
    if (active.getAttribute('aria-current') === 'location') return;
    (inChat ? signalsLink : chatLink).removeAttribute('aria-current');
    active.setAttribute('aria-current', 'location');
  }
  function syncSection() {
    const panel = document.querySelector('#lite-chat-panel');
    const root = document.querySelector('#product-page');
    if (!panel || !root || panel.hidden) return setSection(false);
    const viewport = root.getBoundingClientRect();
    const nearTop = panel.getBoundingClientRect().top <= viewport.top + viewport.height * .4;
    const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 12;
    setSection(nearTop || atEnd);
  }
  let frame = 0;
  document.addEventListener('scroll', (event) => {
    if (event.target.id !== 'product-page' || mobileDock.hidden || !mobile.matches || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; syncSection(); });
  }, { capture: true, passive: true });
  function update() {
    const route = new URLSearchParams(location.search).get('page');
    const onLite = route ? route === 'lite' : location.pathname.replace(/\/+$/, '') === '/lite';
    const preferences = { lang: document.documentElement.lang };
    mobileDock.hidden = !onLite;
    if (onLite) {
      const locale = preferences.lang.toLowerCase().split('-')[0];
      const labels = dockLabels[locale] || dockLabels.en;
      mobileDock.setAttribute('aria-label', 'Astarter Lite');
      [signalsLink, chatLink, fullLink].forEach((link, i) => {
        const caption = link.lastElementChild;
        if (caption.textContent !== labels[i]) caption.textContent = labels[i];
      });
      fullLink.href = fullHrefFromLite(preferences);
      if (mobile.matches) syncSection();
    }
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
  function navigate(event) {
    const link = event.target.closest('a');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link === signalsLink || link === chatLink) {
      event.preventDefault();
      const section = document.getElementById(link.hash.slice(1));
      if (!section) return;
      section.scrollIntoView({ block: 'start' });
      const title = section.querySelector('h1, h2, h3') || section;
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
      setSection(link === chatLink);
      return;
    }
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
  }
  versionSwitch.addEventListener('click', navigate);
  mobileDock.addEventListener('click', navigate);
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
