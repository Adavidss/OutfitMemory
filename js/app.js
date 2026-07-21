/**
 * app.js — boot, hash routing, tab bar, theme application, SW registration.
 *
 * Boot flow:
 *   store.init() → 'onboarding' (first run / handle lost)
 *                → 'locked'     (folder mode, permission needs a tap)
 *                → 'ready'      (render the app)
 */

import { store } from './store.js';
import { el, $ } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { renderGallery } from './views/gallery.js';
import { renderCalendar } from './views/calendar.js';
import { renderStats } from './views/statsView.js';
import { renderSettings } from './views/settingsView.js';
import { renderOnboarding, renderLocked } from './views/onboarding.js';
import { openCapture } from './views/capture.js';

const VIEWS = {
  gallery: { render: renderGallery, icon: 'grid', label: 'Photos' },
  calendar: { render: renderCalendar, icon: 'calendar', label: 'Calendar' },
  stats: { render: renderStats, icon: 'chart', label: 'Stats' },
  settings: { render: renderSettings, icon: 'settings', label: 'Settings' },
};

const THEME_BG = {
  light: '#ffffff', dark: '#0b0b0f', mono: '#ffffff',
  magazine: '#f6f1e7', polaroid: '#efe7da',
};

/* ---------- theme ---------- */

export function applyTheme() {
  const pref = store.settings.theme || 'auto';
  const resolved = pref === 'auto'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : pref;
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_BG[resolved] || '#ffffff');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((store.settings.theme || 'auto') === 'auto') applyTheme();
});

/* ---------- routing ---------- */

function currentRoute() {
  const h = location.hash.replace(/^#\//, '');
  if (VIEWS[h]) return h;
  return VIEWS[store.settings.lastView] ? store.settings.lastView : 'gallery';
}

function renderView() {
  if (store.status !== 'ready') return;
  const route = currentRoute();
  store.saveSettings({ lastView: route });
  for (const tab of $$tabs()) tab.classList.toggle('active', tab.dataset.route === route);
  VIEWS[route].render($('#view'));
}

const $$tabs = () => [...document.querySelectorAll('.tab[data-route]')];

/* ---------- chrome ---------- */

function buildChrome() {
  const topbar = $('#topbar');
  topbar.replaceChildren(el('div', { class: 'topbar-inner' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand-logo' }, icon('cameraHeart')),
      'OutfitMemory'),
    el('div', { class: 'streak-chip', id: 'streakChip', hidden: true })));

  const mkTab = (route) => {
    const v = VIEWS[route];
    const b = el('button', { class: 'tab', dataset: { route }, 'aria-label': v.label },
      icon(v.icon), el('span', { text: v.label }));
    b.addEventListener('click', () => { location.hash = `#/${route}`; });
    return b;
  };
  const fab = el('button', { class: 'fab', 'aria-label': "Add Today's Outfit", title: "Add Today's Outfit" }, icon('plus'));
  fab.addEventListener('click', () => openCapture());

  $('#tabbar').replaceChildren(el('div', { class: 'tabbar-inner' },
    mkTab('gallery'), mkTab('calendar'), fab, mkTab('stats'), mkTab('settings')));

  updateStreakChip();
}

function updateStreakChip() {
  const chip = $('#streakChip');
  if (!chip) return;
  const { current } = store.streaks();
  chip.hidden = current < 2;
  if (current >= 2) chip.textContent = `🔥 ${current} days`;
}

/* ---------- boot ---------- */

function showScreen(renderFn) {
  $('#app').hidden = true;
  const screen = $('#screen');
  screen.hidden = false;
  renderFn(screen);
}

function showApp() {
  const screen = $('#screen');
  screen.hidden = true;
  screen.replaceChildren();
  $('#app').hidden = false;
  buildChrome();
  renderView();
  handlePendingAction();
}

function handlePendingAction() {
  // PWA shortcut: OutfitMemory → "Add Today's Outfit" opens ?action=add
  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'add') {
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => openCapture(), 250);
  }
}

async function boot() {
  applyTheme();
  const status = await store.init();
  if (status === 'onboarding') showScreen(renderOnboarding);
  else if (status === 'locked') showScreen(renderLocked);
  else showApp();

  store.addEventListener('status', () => {
    if (store.status === 'ready') showApp();
  });

  store.addEventListener('change', () => {
    if (store.status !== 'ready' || $('#app').hidden) return;
    // Re-render the active view, preserving scroll (edits from overlays
    // like the detail panel shouldn't yank the page back to the top).
    const y = window.scrollY;
    renderView();
    window.scrollTo(0, y);
    updateStreakChip();
  });

  window.addEventListener('hashchange', renderView);

  // Offline support. Registration is skipped on file:// (dev convenience).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline-first is best-effort */ });
  }
}

boot();
