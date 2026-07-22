/**
 * backup.js — automatic mirrored backups into a second, user-chosen folder.
 *
 * Strategy: incremental mirror, not snapshots. Photo/thumbnail files are
 * immutable once written, so each run only copies files the backup folder
 * doesn't have yet, then rewrites metadata.json. The result is that the
 * backup folder is itself a complete, valid OutfitMemory archive — you can
 * point the app straight at it ("Choose Outfit Folder") to restore.
 * Deleted outfits' files are intentionally kept in the mirror (it's a
 * backup); metadata.json always reflects the current state.
 *
 * Presets: off · after every change (debounced) · daily · weekly.
 * Runs are gated on metadata.updatedAt, so a due check with no changes
 * is a no-op. Requires the File System Access API (Chromium desktop);
 * elsewhere Settings points at manual ZIP export instead.
 */

import { store } from './store.js';
import { idbGet, idbSet, idbDel } from './util/idb.js';
import { toast, actionToast } from './ui/dom.js';

const HANDLE_KEY = 'backupDir';
const CHANGE_DEBOUNCE_MS = 8000;

export const PRESET_LABELS = {
  off: 'Off',
  change: 'After every change',
  daily: 'Daily',
  weekly: 'Weekly',
};

export const backupSupported = () =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/* ---------- backup folder handle ---------- */

export async function getBackupHandle() {
  return (await idbGet('kv', HANDLE_KEY).catch(() => null)) || null;
}

/** Show the picker. Returns the handle, or null if cancelled/refused. */
export async function pickBackupFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'outfitmemory-backup' });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
  // Refuse the live archive folder itself — mirroring a folder onto
  // itself is a no-op that would masquerade as a backup.
  if (store.adapter?.kind === 'folder') {
    try {
      if (await store.adapter.root.isSameEntry(handle)) {
        toast('That folder IS your archive — pick a different one for backups.');
        return null;
      }
    } catch { /* isSameEntry unsupported — allow */ }
  }
  await idbSet('kv', HANDLE_KEY, handle);
  store.saveSettings({ backup: { ...store.settings.backup, folderName: handle.name } });
  return handle;
}

export async function forgetBackupFolder() {
  await idbDel('kv', HANDLE_KEY).catch(() => {});
}

async function permission(handle, request = false) {
  try {
    const q = await handle.queryPermission?.({ mode: 'readwrite' });
    if (q === 'granted' || q === undefined) return 'granted'; // undefined: OPFS/older impls
    if (q === 'prompt' && request) {
      return (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
    }
    return q;
  } catch {
    return 'granted';
  }
}

/* ---------- mirror primitives ---------- */

async function dirIn(root, parts, create) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

async function existsIn(root, path) {
  try {
    const parts = path.split('/');
    const name = parts.pop();
    const dir = await dirIn(root, parts, false);
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function writeTo(root, path, blob) {
  const parts = path.split('/');
  const name = parts.pop();
  const dir = await dirIn(root, parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

/* ---------- backup runs ---------- */

/**
 * Mirror the archive into the backup folder.
 * Returns { ok, copied } or { ok:false, reason:'nofolder'|'locked' }.
 */
export async function backupNow({ interactive = false, onProgress } = {}) {
  const handle = await getBackupHandle();
  if (!handle) return { ok: false, reason: 'nofolder' };
  if ((await permission(handle, interactive)) !== 'granted') return { ok: false, reason: 'locked' };

  // allFilePaths() covers photos, thumbnails and wardrobe item crops.
  const paths = store.allFilePaths();
  let copied = 0;
  let i = 0;
  for (const path of paths) {
    i++;
    onProgress?.(i, paths.length);
    if (await existsIn(handle, path)) continue;
    const blob = await store.adapter.readFile(path);
    if (blob) {
      await writeTo(handle, path, blob);
      copied++;
    }
  }
  await writeTo(handle, 'metadata.json', store.metadataBlob());
  store.saveSettings({ backup: { ...store.settings.backup, lastRun: new Date().toISOString() } });
  return { ok: true, copied };
}

/** Is an automatic run warranted right now? */
export function isDue() {
  const b = store.settings.backup || {};
  if (!b.preset || b.preset === 'off') return false;
  if (!b.lastRun) return true;
  // ISO strings compare lexicographically — nothing changed, nothing to do.
  if (!(store.meta?.updatedAt > b.lastRun)) return false;
  if (b.preset === 'change') return true;
  const age = Date.now() - Date.parse(b.lastRun);
  if (b.preset === 'daily') return age > 20 * 3600e3;   // ~daily, forgiving
  if (b.preset === 'weekly') return age > 6.5 * 86400e3;
  return false;
}

/* ---------- automatic scheduling ---------- */

let wired = false;
let debounceTimer = null;

/** Call once when the app reaches 'ready'. Checks at boot, then after
 *  every metadata change (debounced so a burst of edits runs once). */
export function initAutoBackup() {
  if (wired || !backupSupported()) return;
  wired = true;
  maybeRun();
  store.addEventListener('change', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeRun, CHANGE_DEBOUNCE_MS);
  });
}

async function maybeRun() {
  if (!isDue()) return;
  const handle = await getBackupHandle();
  if (!handle) return;
  if ((await permission(handle)) !== 'granted') {
    // Re-granting needs a user gesture — offer one tap, don't nag.
    actionToast('Backup due — the backup folder needs one tap', 'Back up', async () => {
      const r = await backupNow({ interactive: true });
      if (r.ok) toast(`Backed up ✓ ${r.copied} new file${r.copied === 1 ? '' : 's'}`);
      else toast('Backup skipped — permission not granted');
    });
    return;
  }
  const r = await backupNow();
  if (r.ok && r.copied) toast(`Backed up ✓ ${r.copied} new file${r.copied === 1 ? '' : 's'}`);
}
