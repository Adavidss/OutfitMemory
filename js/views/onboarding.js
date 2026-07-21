/**
 * onboarding.js — first-launch setup and the "locked" (re-grant
 * permission) screen for folder mode.
 *
 * Design goal: one decision, one tap, then straight into the app.
 */

import { store } from '../store.js';
import { FolderStorage } from '../storage/folderStorage.js';
import { BrowserStorage } from '../storage/browserStorage.js';
import { el, toast, sheet, confirmDialog } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;

export function renderOnboarding(screen) {
  screen.replaceChildren();

  const points = el('ul', { class: 'ob-points' },
    point('📷', 'One photo a day', 'Snap it, save it, done. No forms, no tagging homework.'),
    point('🔒', 'Photos never leave your device', 'No account, no cloud, no tracking. The app can\'t phone home.'),
    point('📁', 'You own the files', 'A plain folder of photos + one JSON file. Readable forever.'));

  const actions = el('div', { class: 'ob-actions' });

  if (store.supportsFolder) {
    const pickBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('folder'), 'Choose Outfit Folder');
    pickBtn.addEventListener('click', async () => {
      let adapter;
      try {
        adapter = await FolderStorage.pick();
      } catch {
        toast('Folder access failed — you can use browser storage instead.');
        return;
      }
      if (!adapter) return; // user cancelled the picker
      const existingCount = await store.completeSetup(adapter);
      toast(existingCount
        ? `Opened your archive — ${existingCount} outfits found 🎉`
        : `Archive created in “${adapter.label()}”`);
    });

    const fallbackBtn = el('button', { class: 'link-btn', text: 'Use private browser storage instead' });
    fallbackBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Use browser storage?',
        body: 'Photos will be kept in this browser\'s private storage instead of a folder you can see. You can move to a folder later in Settings.',
        okLabel: 'Use browser storage',
      });
      if (ok) await store.completeSetup(new BrowserStorage());
    });

    actions.append(pickBtn, fallbackBtn);
  } else {
    // iOS Safari / Firefox / Android: no folder picker available.
    const compat = el('div', { class: 'ob-compat' },
      el('b', { text: 'About storage on this browser: ' }),
      'this browser can\'t grant folder access yet, so your photos will be kept in its ',
      el('b', { text: 'private on-device storage' }),
      '. Nothing is uploaded — ever. Use Settings → Export anytime for a backup ZIP you fully own. ',
      '(On desktop Chrome or Edge, OutfitMemory can store straight into a real folder.)');
    const startBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('camera'), 'Start My Outfit Journal');
    startBtn.addEventListener('click', async () => {
      await store.completeSetup(new BrowserStorage());
    });
    actions.append(compat, startBtn);
  }

  const note = el('p', { class: 'ob-note', text: 'No account · No cloud · No tracking' });
  const install = IS_IOS && !IS_STANDALONE
    ? el('p', { class: 'ob-note', text: 'Tip: Share → “Add to Home Screen” installs OutfitMemory as an app (and its storage is most durable there).' })
    : null;

  screen.append(el('div', { class: 'onboard' },
    el('div', { class: 'ob-logo' }, icon('cameraHeart')),
    el('h1', { text: 'OutfitMemory' }),
    el('p', { class: 'ob-tag', text: 'Your personal style memory.' }),
    points, actions, note, install));
}

export function renderLocked(screen) {
  screen.replaceChildren();

  const openBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('folder'), 'Open My Archive');
  openBtn.addEventListener('click', async () => {
    const ok = await store.unlock();
    if (!ok) toast('OutfitMemory needs permission to read your outfit folder.');
  });

  const alt = el('button', { class: 'link-btn', text: 'Use a different folder…' });
  alt.addEventListener('click', async () => {
    const adapter = await FolderStorage.pick().catch(() => null);
    if (!adapter) return;
    await store.adoptFolder(adapter);
    store.status = 'ready';
    store.emit('status');
  });

  const reset = el('button', { class: 'link-btn', text: 'Start over' });
  reset.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Start over?',
      body: 'OutfitMemory forgets the folder link. Your files stay on disk.',
      okLabel: 'Start over', danger: true,
    });
    if (ok) await store.resetApp();
  });

  screen.append(el('div', { class: 'onboard' },
    el('div', { class: 'ob-logo' }, icon('lock')),
    el('h1', { text: 'Welcome back' }),
    el('p', { class: 'ob-tag' },
      `Your archive lives in “${store.adapter?.label() || 'your folder'}”. `,
      'The browser needs one tap to re-open it.'),
    el('div', { class: 'ob-actions' }, openBtn, alt, reset),
    el('p', { class: 'ob-note', text: 'Tip: choose “Allow on every visit” in the permission prompt to skip this screen.' })));
}

function point(emoji, title, sub) {
  return el('li', {},
    el('span', { class: 'ob-emoji', text: emoji }),
    el('span', {}, el('b', { text: title }), el('span', { text: sub })));
}
