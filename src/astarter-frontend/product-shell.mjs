import {walletMenuLabels} from './wallet-entry.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {L,label} from './execution-views.mjs';
import {escapeUI as e} from './product-experience.mjs';
import {uiGlyph} from './product-composition.mjs';
export function createProductShell({workspace:w,desk,go,research,resize=()=>{}}){
 const host=document.createElement('section');host.className='ux-commandbar';host.setAttribute('data-localized-ui','');document.querySelector('.workspace').before(host);
 const rail=document.createElement('div');rail.className='cockpit-overview';rail.setAttribute('data-localized-ui','');document.querySelector('.status-panel').append(rail);
 let page='workbench',elapsed=0,last='';
 const navigate=ev=>{const b=ev.target.closest('[data-route]');if(b)go(b.dataset.route);const pane=ev.target.closest('[data-cockpit-pane]');if(pane){document.body.dataset.mobileView=pane.dataset.cockpitPane;for(const x of host.querySelectorAll('[data-cockpit-pane]'))x.setAttribute('aria-pressed',String(x===pane));resize();window.dispatchEvent(new Event('resize'));}};
 host.addEventListener('click',navigate);rail.addEventListener('click',navigate);
 function update(){host.hidden=page!=='workbench';if(host.hidden)return;const d=desk.snapshot(),armed=d.discovery?.armed,run=d.session;const tasks=research.tasks.filter(t=>research.accepts(t));const ready=tasks.filter(t=>t.phase==='complete'&&t.outcome==='candidate').length;const attention=(d.signal&&(run?.mode==='confirm'||run?.mode==='review'&&d.signal.side==='buy')?1:0)+(d.pending?.status==='unknown'?1:0)+(d.flow?.protections?.some(p=>['IMPAIRED','UNKNOWN'].includes(p.state)&&Number(p.targetQuantity)>0)?1:0);const state=armed?L('等待机会','Awaiting opportunity'):run?label(d.state):L('尚未启动交易','Trading not started');
 const groupNames=[['市场结构','Market'],['链上生态','On-chain'],['情绪异动','Sentiment'],['全球权益','Equities'],['避险轮动','Rotation'],['宏观事件','Macro']];
 const groupRows=groupNames.map(([zh,en],i)=>{const ts=tasks.filter(t=>t.group===i),active=ts.find(t=>t.phase!=='complete'),done=ts.filter(t=>t.phase==='complete').length;return `<div class="cockpit-team"><i style="--team:${RESEARCH_GROUPS[i].color}"></i><span>${L(zh,en)}<small>${active?L('正在研究','Researching'):done?L('已汇总','Reviewed'):L('等待线索','Watching')}</small></span><b>${active?Math.round(active.progress)+'%':done?'✓':'—'}</b></div>`;}).join('');
 const html=`<header class="cockpit-rail-head"><span>${L('运行概览','Overview')}</span><i class="ux-live"></i></header><div class="cockpit-run-state"><span>${L('交易状态','Trading state')}</span><strong>${state}</strong><small>${run?e(run.strategy)+' · '+e(run.market):'Crypto + TradFi'}</small></div><div class="cockpit-counts"><button data-route="opportunities"><strong>${ready}</strong><span>${L('新机会','Opportunities')} ↗</span></button><button data-route="inbox" class="${attention?'attention':''}"><strong>${attention}</strong><span>${L('待处理','To review')} ↗</span></button></div><div class="cockpit-section-heading"><b>${L('研究小组','Research teams')}</b><span>06</span></div><div class="cockpit-teams">${groupRows}</div><div class="cockpit-rail-bottom"><button class="cockpit-shortcut" data-route="risk">${uiGlyph('shield')}<span>${L('资金保护','Capital protection')}<small>${L('账户最多使用','Allocation limit')} ${w.s.risk.cap} USDT</small></span><b>›</b></button><button class="cockpit-shortcut" data-route="usage">${uiGlyph('credits')}<span>${L('研究积分','Research credits')}<small>${L('可用','Available')} ${w.available}</small></span><b>›</b></button><button class="p-button" data-route="my-strategies">${L('管理我的策略','Manage my strategies')} ↗</button></div>`;
 if(html!==last&&!rail.contains(document.activeElement)){rail.innerHTML=html;last=html;}
 const mobile=document.body.dataset.mobileView||'network';const locale=L('概览','Overview');if(host.dataset.locale!==locale){host.dataset.locale=locale;host.innerHTML=[['status','概览','Overview','pulse'],['network','AI 战队','AI team','orbit'],['console','操作台','Controls','sliders']].map(([key,zh,en,icon])=>`<button data-cockpit-pane="${key}" aria-pressed="${mobile===key}">${uiGlyph(icon)}${L(zh,en)}</button>`).join('');}for(const tab of host.querySelectorAll('[data-cockpit-pane]'))tab.setAttribute('aria-pressed',String(tab.dataset.cockpitPane===mobile));
 }
 return {render(p){page=p;update();},tick(dt){elapsed+=dt;if(elapsed>1){elapsed=0;update();}}};
}

export function mountHeaderPreferences(header, profileIcon, openProfile) {
  const theme = header.querySelector('.theme-switch');
  const language = header.querySelector('.language-picker');
  const versionSwitch = header.querySelector('.experience-switch');
  const versionAnchor = versionSwitch.nextSibling;
  const desktopAnchor = language.nextSibling;
  const menu = document.createElement('details');
  menu.className = 'header-preferences';
  menu.innerHTML = `<summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></summary>
    <div class="header-preferences-panel">
      <div class="header-version-row"><span class="preference-label"></span></div>
      <div class="header-theme-row"><span class="preference-label"></span></div>
      <div class="header-language-row"><span class="preference-label"></span></div>
      <button class="header-profile-link" type="button"><span></span><i aria-hidden="true">›</i></button>
    </div>`;
  const trigger = menu.querySelector('summary');
  const versionRow = menu.querySelector('.header-version-row');
  const themeRow = menu.querySelector('.header-theme-row');
  const languageRow = menu.querySelector('.header-language-row');
  const profile = menu.querySelector('.header-profile-link');
  profile.prepend(profileIcon.cloneNode(true));
  header.append(menu);

  function syncLabels() {
    const [menuName, , accountName, appearance, languageName] = walletMenuLabels(document.documentElement.lang);
    trigger.setAttribute('aria-label', menuName);
    trigger.title = menuName;
    versionRow.firstElementChild.textContent = L('版本', 'Version');
    versionSwitch.setAttribute('aria-label', versionRow.firstElementChild.textContent);
    themeRow.firstElementChild.textContent = appearance;
    languageRow.firstElementChild.textContent = languageName;
    profile.querySelector('span').textContent = accountName;
  }
  const compact = matchMedia('(max-width: 900px)');
  function syncLayout() {
    const focus = document.activeElement;
    const versionFocused = versionSwitch.contains(focus);
    const focusedControl = theme.contains(focus) || language.contains(focus);
    const hadFocus = focusedControl || versionFocused || menu.contains(focus);
    menu.open = false;
    language.open = false;
    versionSwitch.querySelector('details').open = false;
    if (compact.matches) {
      versionRow.append(versionSwitch);
      themeRow.append(theme);
      languageRow.append(language);
      if (hadFocus) trigger.focus();
    } else {
      header.insertBefore(versionSwitch, versionAnchor);
      header.insertBefore(theme, desktopAnchor);
      header.insertBefore(language, desktopAnchor);
      if (versionFocused) {
        const current = versionSwitch.querySelector('a[aria-current="page"]');
        (current.getClientRects().length ? current : versionSwitch.querySelector('summary')).focus();
      } else if (hadFocus) {
        (focusedControl && focus.getClientRects().length ? focus : language.querySelector('summary')).focus();
      }
    }
  }
  function close() {
    menu.open = false;
    language.open = false;
  }
  versionRow.addEventListener('click', event => {
    if (!event.target.closest('a') || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const returnFocus = menu.contains(document.activeElement) || document.activeElement === document.body;
    close();
    if (returnFocus) trigger.focus({preventScroll: true});
  });
  profile.onclick = () => {
    close();
    trigger.focus({preventScroll: true});
    openProfile();
  };
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    if (language.open) {
      language.open = false;
      language.querySelector('summary').focus();
    } else {
      close();
      trigger.focus();
    }
  });
  menu.addEventListener('toggle', () => { if (!menu.open && compact.matches) language.open = false; });
  document.addEventListener('pointerdown', event => { if (menu.open && !menu.contains(event.target)) close(); });
  document.addEventListener('focusin', event => { if (menu.open && !menu.contains(event.target)) close(); });
  document.addEventListener('hive:locale', () => {
    syncLabels();
    if (menu.open && language.contains(document.activeElement)) language.querySelector('summary').focus();
  });
  compact.addEventListener('change', syncLayout);
  syncLabels();
  syncLayout();
  return trigger;
}
