/**
 * folderStorage.js — File System Access API adapter.
 *
 * The user's photos live in a real folder THEY chose (e.g. ~/Pictures/
 * OutfitMemory). The browser only holds a handle to it. This is the
 * preferred storage mode: files survive browser resets, sync via any
 * folder-sync tool the user already runs, and are readable forever
 * without this app.
 *
 * Layout inside the chosen folder:
 *   Photos/YYYY/MM/outfit_YYYY-MM-DD.webp
 *   Thumbnails/YYYY/MM/outfit_YYYY-MM-DD_thumb.webp
 *   metadata.json
 *
 * Availability (2026): Chromium desktop only. Safari/Firefox/mobile fall
 * back to BrowserStorage (see browserStorage.js).
 */

import { idbGet, idbSet, idbDel } from '../util/idb.js';

const HANDLE_KEY = 'dirHandle';

export class FolderStorage {
  kind = 'folder';

  constructor(rootHandle) {
    this.root = rootHandle;
  }

  static supported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  /** Show the native folder picker. Returns null if the user cancels. */
  static async pick() {
    try {
      const root = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'outfitmemory',
        startIn: 'pictures',
      });
      return new FolderStorage(root);
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  }

  /** Persist the handle so the archive reopens on the next visit. */
  async remember() {
    await idbSet('kv', HANDLE_KEY, this.root);
  }

  /** Restore the handle saved by remember(). Null if none. */
  static async resume() {
    const h = await idbGet('kv', HANDLE_KEY).catch(() => null);
    return h ? new FolderStorage(h) : null;
  }

  static async forget() {
    await idbDel('kv', HANDLE_KEY).catch(() => {});
  }

  /** 'granted' | 'prompt' | 'denied' */
  async permission() {
    try {
      return await this.root.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'granted'; // older impls without queryPermission
    }
  }

  /** Must be called from a user gesture. */
  async requestPermission() {
    try {
      return await this.root.requestPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  label() {
    return this.root.name;
  }

  async _dir(path, create = false) {
    let dir = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async writeFile(path, blob) {
    const i = path.lastIndexOf('/');
    const dir = i < 0 ? this.root : await this._dir(path.slice(0, i), true);
    const fh = await dir.getFileHandle(path.slice(i + 1), { create: true });
    // createWritable writes to a temp file and swaps on close() — a crash
    // mid-write never corrupts the existing file.
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async readFile(path) {
    try {
      const i = path.lastIndexOf('/');
      const dir = i < 0 ? this.root : await this._dir(path.slice(0, i), false);
      const fh = await dir.getFileHandle(path.slice(i + 1));
      return await fh.getFile();
    } catch {
      return null;
    }
  }

  async deleteFile(path) {
    try {
      const i = path.lastIndexOf('/');
      const dir = i < 0 ? this.root : await this._dir(path.slice(0, i), false);
      await dir.removeEntry(path.slice(i + 1));
    } catch {
      /* already gone — fine */
    }
  }

  async loadMetadata() {
    const f = await this.readFile('metadata.json');
    if (!f) return null;
    try {
      return JSON.parse(await f.text());
    } catch {
      // Corrupt JSON: preserve the evidence, let the caller fall back
      // (cached copy / rescan), never overwrite it silently.
      try { await this.writeFile('metadata.corrupt.json', f); } catch { /* best effort */ }
      return null;
    }
  }

  async saveMetadata(meta) {
    const blob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
    await this.writeFile('metadata.json', blob);
  }

  /** Yield {path, handle} for every file under Photos/ (for rescans). */
  async *walkPhotos() {
    const photos = await this._dir('Photos').catch(() => null);
    if (!photos) return;
    for await (const [yName, yh] of photos.entries()) {
      if (yh.kind !== 'directory') continue;
      for await (const [mName, mh] of yh.entries()) {
        if (mh.kind !== 'directory') continue;
        for await (const [fName, fh] of mh.entries()) {
          if (fh.kind === 'file') yield { path: `Photos/${yName}/${mName}/${fName}`, handle: fh };
        }
      }
    }
  }
}
