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
import { renderWardrobe } from './views/wardrobeView.js';
import { renderOnboarding, renderLocked } from './views/onboarding.js';
import { openCapture } from './views/capture.js';
import { openDetail } from './views/detail.js';
import { initAutoBackup } from './backup.js';
import { toast } from './ui/dom.js';

const VIEWS = {
  gallery: { render: renderGallery, icon: 'grid', label: 'Photos' },
  calendar: { render: renderCalendar, icon: 'calendar', label: 'Calendar' },
  wardrobe: { render: renderWardrobe, icon: 'hanger', label: 'Wardrobe' },
  stats: { render: renderStats, icon: 'chart', label: 'Stats' },
  settings: { render: renderSettings, icon: 'settings', label: 'Settings' },
};

// Settings lives in the top bar, so the tab bar keeps four roomy targets.
const TABS = ['gallery', 'calendar', 'wardrobe', 'stats'];

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
  $('#topbar')?.classList.toggle('on-settings', route === 'settings');
  VIEWS[route].render($('#view'));
}

const $$tabs = () => [...document.querySelectorAll('.tab[data-route]')];

/* ---------- chrome ---------- */

function buildChrome() {
  const topbar = $('#topbar');

  // Flashback: open a random outfit from the archive.
  const shuffleBtn = el('button', { class: 'icon-btn', 'aria-label': 'Random outfit flashback', title: 'Flashback' },
    icon('shuffle'));
  shuffleBtn.addEventListener('click', () => {
    const entries = store.entries();
    if (!entries.length) return toast('Save an outfit first ✨');
    openDetail(entries[Math.floor(Math.random() * entries.length)].id);
  });

  // Streak chip doubles as a shortcut to Stats.
  const streakChip = el('button', { class: 'streak-chip', id: 'streakChip', hidden: true, 'aria-label': 'Current streak — open stats' });
  streakChip.addEventListener('click', () => { location.hash = '#/stats'; });

  const settingsBtn = el('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings' },
    icon('settings'));
  settingsBtn.addEventListener('click', () => { location.hash = '#/settings'; });

  // The wordmark is a home button — tapping it returns to Photos.
  const brand = el('button', { class: 'brand', 'aria-label': 'Go to Photos', title: 'Photos' },
    el('span', { class: 'brand-logo' }, icon('cameraHeart')),
    'OutfitMemory');
  brand.addEventListener('click', () => {
    if (currentRoute() === 'gallery') window.scrollTo({ top: 0, behavior: 'smooth' });
    else location.hash = '#/gallery';
  });

  topbar.replaceChildren(el('div', { class: 'topbar-inner' },
    brand,
    el('div', { class: 'topbar-right' }, streakChip, shuffleBtn, settingsBtn)));

  const mkTab = (route) => {
    const v = VIEWS[route];
    const b = el('button', { class: 'tab', dataset: { route }, 'aria-label': v.label },
      icon(v.icon), el('span', { text: v.label }));
    b.addEventListener('click', () => {
      // Re-tapping the active tab scrolls back to the top (mobile idiom).
      if (currentRoute() === route && location.hash === `#/${route}`) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        location.hash = `#/${route}`;
      }
    });
    return b;
  };
  const fab = el('button', { class: 'fab', 'aria-label': "Add Today's Outfit", title: "Add Today's Outfit" }, icon('plus'));
  fab.addEventListener('click', () => openCapture());

  $('#tabbar').replaceChildren(el('div', { class: 'tabbar-inner' },
    mkTab(TABS[0]), mkTab(TABS[1]), fab, mkTab(TABS[2]), mkTab(TABS[3])));

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
  initAutoBackup(); // no-op unless a schedule is configured (idempotent)
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
