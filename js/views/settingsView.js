/**
 * settingsView.js — themes, storage management, backup/restore,
 * privacy explainer, reset.
 */

import { store } from '../store.js';
import { FolderStorage } from '../storage/folderStorage.js';
import { BrowserStorage } from '../storage/browserStorage.js';
import { el, $, toast, progressToast, confirmDialog, sheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { todayStr } from '../util/dates.js';
import { applyTheme } from '../app.js';

const THEMES = [
  { id: 'auto', name: 'Auto', colors: ['#ffffff', '#0b0b0f', '#6a5ae0'] },
  { id: 'light', name: 'Light', colors: ['#ffffff', '#f5f5f7', '#6a5ae0'] },
  { id: 'dark', name: 'Dark', colors: ['#0b0b0f', '#17171d', '#8b7bff'] },
  { id: 'mono', name: 'Mono', colors: ['#ffffff', '#000000', '#999999'] },
  { id: 'magazine', name: 'Magazine', colors: ['#f6f1e7', '#191612', '#c8372d'] },
  { id: 'polaroid', name: 'Polaroid', colors: ['#efe7da', '#fffdf8', '#d96a4e'] },
];

export function renderSettings(container) {
  container.replaceChildren();
  container.append(el('h1', { class: 'view-title', text: 'Settings' }));

  container.append(themeGroup(container));
  container.append(storageGroup(container));
  container.append(backupGroup());
  container.append(aboutGroup());
  container.append(dangerGroup());
}

/* ---------- themes ---------- */

function themeGroup(container) {
  const grid = el('div', { class: 'theme-grid' }, THEMES.map((t) => {
    const card = el('button', { class: `theme-card${store.settings.theme === t.id ? ' active' : ''}` },
      el('span', { class: 'theme-prev' }, t.colors.map((c) => el('i', { style: { background: c } }))),
      el('span', { text: t.name }));
    card.addEventListener('click', () => {
      store.saveSettings({ theme: t.id });
      applyTheme();
      renderSettings(container);
    });
    return card;
  }));
  return group('Appearance', grid);
}

/* ---------- storage ---------- */

function storageGroup(container) {
  const card = el('div', { class: 'set-card' });
  const isFolder = store.adapter?.kind === 'folder';

  card.append(el('div', { class: 'set-row' },
    icon(isFolder ? 'folder' : 'lock'),
    el('span', { class: 'grow' },
      isFolder ? `Folder · “${store.adapter.label()}”` : 'Private browser storage',
      el('span', { class: 'sub', text: isFolder
        ? 'Photos are real files in your folder — yours forever.'
        : 'Photos live in this browser\'s protected storage on this device.' })),
    el('span', { text: `${store.meta.entries.length} outfits` })));

  if (!isFolder) {
    // Show usage + persistence state.
    const usageRow = el('div', { class: 'set-row' }, icon('info'),
      el('span', { class: 'grow', text: 'Checking storage…' }));
    card.append(usageRow);
    (async () => {
      const est = await BrowserStorage.estimate();
      const persisted = await BrowserStorage.persisted();
      const mb = est?.usage ? (est.usage / (1024 * 1024)).toFixed(1) : '?';
      usageRow.querySelector('.grow').replaceChildren(
        `${mb} MB used`,
        el('span', { class: 'sub', text: persisted
          ? 'Storage is persistent — the browser won\'t auto-evict it.'
          : 'Tip: install the app / bookmark it so the browser protects this data.' }));
    })();

    if (store.supportsFolder) {
      card.append(rowButton('folder', 'Move archive to a folder…',
        'Copies everything into a folder you choose, then uses it.', async () => {
          const ad = await FolderStorage.pick();
          if (!ad) return;
          const pt = progressToast('Copying archive…');
          await store.migrateTo(ad, (i, n) => pt.update(`Copying ${i}/${n}…`));
          pt.done('Archive moved to your folder ✓');
          renderSettings(container);
        }));
    }
  } else {
    card.append(rowButton('refresh', 'Rescan folder',
      'Finds photos added to the folder outside the app.', async () => {
        const pt = progressToast('Scanning folder…');
        const { added, scanned } = await store.rescanFolder((i, n) => pt.update(`Processing ${i}/${n}…`));
        pt.done(added ? `Added ${added} outfit${added === 1 ? '' : 's'} from your folder` : scanned ? 'Scan finished — nothing new to add' : 'No new photos found');
      }));
    card.append(rowButton('folder', 'Change folder…',
      'Point OutfitMemory at a different archive folder.', () => changeFolder(container)));
  }

  return group('Storage', card,
    'Nothing ever leaves your device. There is no server, no account and no analytics — the app cannot phone home (enforced by its Content-Security-Policy).');
}

async function changeFolder(container) {
  const ad = await FolderStorage.pick();
  if (!ad) return;
  const existing = await ad.loadMetadata();
  const choice = await sheet({
    title: `Use “${ad.label()}”?`,
    body: existing
      ? `This folder already contains an OutfitMemory archive (${existing.entries?.length ?? 0} outfits).`
      : 'This folder has no archive yet.',
    actions: [
      existing && { label: 'Open the archive in this folder', icon: 'folder', sub: 'Switch without copying anything' },
      { label: 'Copy my current archive there', icon: 'upload', sub: 'Duplicates all photos into the new folder' },
    ].filter(Boolean),
  });
  if (!choice) return;
  if (choice.label.startsWith('Open')) {
    await store.adoptFolder(ad);
    toast(`Opened archive in “${ad.label()}”`);
  } else {
    const pt = progressToast('Copying archive…');
    await store.migrateTo(ad, (i, n) => pt.update(`Copying ${i}/${n}…`));
    pt.done('Archive copied ✓');
  }
  renderSettings(container);
}

/* ---------- backup ---------- */

function backupGroup() {
  const card = el('div', { class: 'set-card' });

  card.append(rowButton('download', 'Export metadata (JSON)',
    'Dates, notes, tags, colors — no photos.', () => {
      downloadBlob(store.metadataBlob(), `OutfitMemory-metadata-${todayStr()}.json`);
    }));

  card.append(rowButton('download', 'Export full archive (ZIP)',
    'metadata.json + all photos & thumbnails.', async () => {
      const pt = progressToast('Packing archive…');
      try {
        const blob = await store.exportArchive((phase, i, n) =>
          pt.update(phase === 'read' ? `Reading photos ${i}/${n}…` : `Zipping ${i}/${n}…`));
        downloadBlob(blob, `OutfitMemory-archive-${todayStr()}.zip`);
        pt.done('Archive exported ✓');
      } catch (err) {
        pt.done(`Export failed: ${err?.message || 'unknown error'}`);
      }
    }));

  card.append(rowButton('upload', 'Import / restore…',
    'Restore an archive ZIP or merge a metadata.json.', () => {
      const input = $('#fileImport');
      input.value = '';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const pt = progressToast('Importing…');
        try {
          const r = await store.importFrom(file, (i, n) => pt.update(`Importing ${i}/${n}…`));
          pt.done(`Imported: ${r.added} entr${r.added === 1 ? 'y' : 'ies'} added` +
            (r.filesWritten ? `, ${r.filesWritten} files restored` : ''));
        } catch (err) {
          pt.done(`Import failed: ${err?.message || 'not a valid archive'}`);
        }
      };
      input.click();
    }));

  return group('Backup', card,
    'Your archive is portable: the ZIP contains plain WebP/JPEG files and a human-readable metadata.json.');
}

/* ---------- about ---------- */

function aboutGroup() {
  const card = el('div', { class: 'set-card' });
  card.append(el('div', { class: 'set-row' }, icon('cameraHeart'),
    el('span', { class: 'grow' }, 'OutfitMemory',
      el('span', { class: 'sub', text: 'A private, local-first outfit journal. v1.0' }))));
  card.append(el('a', {
    class: 'set-row tappable', href: 'https://github.com/Adavidss/OutfitMemory',
    target: '_blank', rel: 'noopener',
  }, icon('info'), el('span', { class: 'grow', text: 'Source on GitHub' })));
  return group('About', card,
    'Photos are re-encoded on save, which strips EXIF metadata (including GPS location) from the stored files.');
}

/* ---------- danger ---------- */

function dangerGroup() {
  const card = el('div', { class: 'set-card' });
  const isBrowser = store.adapter?.kind === 'browser';
  card.append(rowButton('trash', 'Disconnect & start over', isBrowser
    ? 'Deletes ALL photos stored in this browser.'
    : 'Forgets the folder link. Your files stay on disk.', async () => {
    const ok = await confirmDialog({
      title: 'Start over?',
      body: isBrowser
        ? 'This permanently deletes every photo stored in this browser. Export your archive first if you want to keep it!'
        : `OutfitMemory will forget “${store.adapter.label()}”. The folder and all photos stay untouched on disk.`,
      okLabel: isBrowser ? 'Delete everything' : 'Disconnect',
      danger: true,
    });
    if (ok) await store.resetApp();
  }, true));
  return group('Danger zone', card);
}

/* ---------- helpers ---------- */

function group(title, content, note) {
  return el('div', { class: 'set-group' },
    el('div', { class: 'set-title', text: title }),
    content,
    note ? el('p', { class: 'set-note', text: note }) : null);
}

function rowButton(icn, label, sub, onClick, danger = false) {
  const b = el('button', { class: `set-row tappable${danger ? ' danger' : ''}` },
    icon(icn),
    el('span', { class: 'grow' }, label, sub ? el('span', { class: 'sub', text: sub }) : null),
    icon('chevR'));
  b.addEventListener('click', onClick);
  return b;
}

function downloadBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
