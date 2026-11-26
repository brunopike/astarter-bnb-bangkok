import { mountParticlePortrait } from './brain-particle-portrait.mjs';
import { courierFigure } from './collection-motion.mjs';

const preferenceKey = 'astarter.lite.crew.hidden';
const crews = [
  ['#5d9ee9', '#9d83e3'],
  ['#ebad55', '#ed936f'],
  ['#30ae97', '#d67cb8'],
];

function readHidden() {
  try { return localStorage.getItem(preferenceKey) === 'true'; }
  catch { return false; }
}

function pairMarkup(colors, pair) {
  return colors.map((color, member) => `<span class="lite-crew-runner" data-pair="${pair}" data-member="${member}" style="--agent-color:${color}">
    <span class="lite-crew-figure">${courierFigure}</span>
    <span class="lite-crew-thought">${member ? '✓' : '···'}</span>
  </span>`).join('');
}

function mountBrainSky(host, signal) {
  const main = host.closest('.lite-main');
  const layer = document.createElement('div');
  layer.className = 'lite-brain-sky';
  layer.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  layer.append(canvas);
  main.prepend(layer);
  const portrait = mountParticlePortrait(canvas);
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const contrast = matchMedia('(forced-colors: active)');
  const refresh = () => {
    const reduced = motion.matches || root.dataset.reducedMotion === 'true';
    const visible = !document.hidden && !contrast.matches;
    layer.dataset.paused = String(!visible || reduced);
    portrait.update({ visible, reduced, light: root.dataset.theme === 'light' });
  };
  const observer = new MutationObserver(refresh);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-reduced-motion'] });
  for (const preference of [motion, contrast]) preference.addEventListener('change', refresh, { signal });
  document.addEventListener('visibilitychange', refresh, { signal });
  refresh();
  return () => {
    observer.disconnect();
    portrait.dispose();
    layer.remove();
  };
}

export function mountLiteCrew(host, { lang = 'en' } = {}) {
  const zh = /^zh/i.test(lang);
  const hiddenText = zh ? '显示采集小队' : 'Show signal crew';
  const visibleText = zh ? '隐藏采集小队' : 'Hide signal crew';
  const root = document.createElement('div');
  root.className = 'lite-crew';
  root.innerHTML = `<div class="lite-crew-stage" aria-hidden="true">
    ${crews.map(pairMarkup).join('')}
    <div class="lite-crew-captain"><span class="mascot-orb"><i></i><i></i></span><span class="lite-crew-receipt"></span><span class="lite-crew-hand"></span><span class="lite-crew-hand"></span></div>
  </div><button type="button" class="lite-crew-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.75"/><path class="lite-crew-slash" d="m4 3.5 16 17"/></svg></button>`;
  host.append(root);
  const button = root.querySelector('button');
  const controller = new AbortController();
  const removeSky = mountBrainSky(host, controller.signal);
  let hidden = readHidden();
  let inView = true;

  function sync() {
    root.dataset.hidden = String(hidden);
    root.dataset.running = String(!hidden && inView && !document.hidden);
    button.title = button.ariaLabel = hidden ? hiddenText : visibleText;
  }
  function setHidden(value) {
    hidden = value;
    try { localStorage.setItem(preferenceKey, String(hidden)); } catch {}
    sync();
  }
  function setActive(active) {
    root.dataset.active = String(active);
  }
  const listener = { signal: controller.signal };
  button.addEventListener('click', () => setHidden(!hidden), listener);
  button.addEventListener('contextmenu', (event) => {
    if (hidden) return;
    event.preventDefault();
    setHidden(true);
  }, listener);
  document.addEventListener('visibilitychange', sync, listener);
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); })
    : null;
  observer?.observe(root);
  setActive(false);
  sync();
  return {
    setActive,
    destroy() {
      controller.abort();
      removeSky();
      observer?.disconnect();
      root.remove();
    },
  };
}
