/**
 * store.js — central app state: metadata, storage adapter, settings.
 *
 * Single source of truth. Views subscribe via store.addEventListener:
 *   'change' — entries/metadata mutated → re-render
 *   'status' — boot status changed (onboarding → locked → ready)
 *
 * Metadata schema (metadata.json — see README for the full contract):
 * {
 *   app: "OutfitMemory", schema: 1, createdAt, updatedAt,
 *   entries: [{
 *     id: "2026-07-21-001", date: "2026-07-21", time: "08:12",
 *     image: "Photos/2026/07/outfit_2026-07-21.webp",
 *     thumbnail: "Thumbnails/2026/07/outfit_2026-07-21_thumb.webp",
 *     favorite, notes, tags[], colors[], palette[], weather,
 *     width, height, bytes, addedAt
 *   }]
 * }
 * Unknown top-level/entry fields are preserved on load+save, so future
 * (AI) features can extend entries without a migration.
 */

import { FolderStorage } from './storage/folderStorage.js';
import { BrowserStorage } from './storage/browserStorage.js';
import { todayStr, nowTime, computeStreaks } from './util/dates.js';
import { zipFiles, readZip } from './util/zip.js';
import { idbDel } from './util/idb.js';
import { deriveFromExisting } from './imagePipeline.js';

const SETTINGS_KEY = 'om.settings';
const META_CACHE_KEY = 'om.metaCache';

const DEFAULT_SETTINGS = {
  theme: 'auto',          // auto | light | dark | mono | magazine | polaroid
  setupDone: false,
  storageKind: null,      // 'folder' | 'browser'
  lastView: 'gallery',
  memoryDismissed: '',    // date the "on this day" banner was dismissed
  backup: { preset: 'off', lastRun: '', folderName: '' }, // see js/backup.js
};

function freshMeta() {
  const now = new Date().toISOString();
  return { app: 'OutfitMemory', schema: 1, createdAt: now, updatedAt: now, entries: [] };
}

class Store extends EventTarget {
  status = 'boot'; // boot | onboarding | locked | ready
  adapter = null;
  meta = null;
  supportsFolder = FolderStorage.supported();
  #urls = new Map(); // archive path → object URL (session-lifetime cache)

  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    try {
      Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch { /* fresh start */ }
  }

  saveSettings(patch = {}) {
    Object.assign(this.settings, patch);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  emit(type = 'change') {
    this.dispatchEvent(new Event(type));
  }

  /* ================= boot ================= */

  async init() {
    if (!this.settings.setupDone) {
      this.status = 'onboarding';
      return this.status;
    }
    if (this.settings.storageKind === 'folder' && this.supportsFolder) {
      const adapter = await FolderStorage.resume();
      if (!adapter) {
        // Handle lost (browser data cleared) — run setup again.
        this.status = 'onboarding';
        return this.status;
      }
      this.adapter = adapter;
      const perm = await adapter.permission();
      if (perm === 'granted') {
        await this.#load();
        this.status = 'ready';
      } else {
        // Re-granting permission requires a user gesture → show unlock screen.
        this.status = 'locked';
      }
    } else {
      this.adapter = new BrowserStorage();
      await this.#load();
      this.status = 'ready';
    }
    return this.status;
  }

  /** Folder mode: request permission (must run inside a user gesture). */
  async unlock() {
    const perm = await this.adapter.requestPermission();
    if (perm !== 'granted') return false;
    await this.#load();
    this.status = 'ready';
    this.emit('status');
    return true;
  }

  async #load() {
    this.meta = (await this.adapter.loadMetadata()) || this.#cachedMeta() || freshMeta();
    if (!Array.isArray(this.meta.entries)) this.meta.entries = [];
    this.#cacheMeta();
  }

  // localStorage mirror of metadata — instant boot + recovery if the
  // folder copy is ever corrupted. Tiny (JSON only, no images).
  #cachedMeta() {
    try { return JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null'); } catch { return null; }
  }
  #cacheMeta() {
    try { localStorage.setItem(META_CACHE_KEY, JSON.stringify(this.meta)); } catch { /* quota */ }
  }

  /** Finish onboarding with a chosen adapter. Adopts an existing archive
   *  if the folder already contains a metadata.json. */
  async completeSetup(adapter) {
    this.adapter = adapter;
    if (adapter.kind === 'folder') await adapter.remember();
    else BrowserStorage.persist(); // fire-and-forget; result shown in settings
    const existing = await adapter.loadMetadata();
    this.meta = existing || freshMeta();
    if (!Array.isArray(this.meta.entries)) this.meta.entries = [];
    if (!existing) await adapter.saveMetadata(this.meta);
    this.saveSettings({ setupDone: true, storageKind: adapter.kind });
    this.#cacheMeta();
    this.status = 'ready';
    this.emit('status');
    this.emit('change');
    return this.meta.entries.length;
  }

  async #saveMeta() {
    this.meta.updatedAt = new Date().toISOString();
    await this.adapter.saveMetadata(this.meta);
    this.#cacheMeta();
  }

  /* ================= queries ================= */

  /** All entries, newest date first (stable within a day). */
  entries() {
    return [...(this.meta?.entries || [])].sort((a, b) =>
      a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)
    );
  }

  entryById(id) {
    return this.meta?.entries.find((e) => e.id === id);
  }

  entriesByDate(date) {
    return (this.meta?.entries || [])
      .filter((e) => e.date === date)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  datesSet() {
    return new Set((this.meta?.entries || []).map((e) => e.date));
  }

  streaks() {
    return computeStreaks(this.datesSet());
  }

  /* ================= mutations ================= */

  #nextSeq(date) {
    let max = 0;
    for (const e of this.meta.entries) {
      if (e.date !== date) continue;
      const m = /^\d{4}-\d{2}-\d{2}-(\d+)$/.exec(e.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  #pathsFor(date, seq, ext) {
    const [y, m] = date.split('-');
    const suffix = seq > 1 ? `_${String(seq).padStart(3, '0')}` : '';
    return {
      image: `Photos/${y}/${m}/outfit_${date}${suffix}.${ext}`,
      thumbnail: `Thumbnails/${y}/${m}/outfit_${date}${suffix}_thumb.${ext}`,
    };
  }

  async addOutfit(processed, { date = todayStr(), notes = '', favorite = false } = {}) {
    const seq = this.#nextSeq(date);
    const id = `${date}-${String(seq).padStart(3, '0')}`;
    const { image, thumbnail } = this.#pathsFor(date, seq, processed.ext);

    await this.adapter.writeFile(image, processed.blob);
    await this.adapter.writeFile(thumbnail, processed.thumbBlob);

    const entry = {
      id,
      date,
      time: nowTime(),
      image,
      thumbnail,
      favorite,
      notes,
      tags: [],
      colors: processed.colors || [],
      palette: processed.palette || [],
      weather: null,
      width: processed.width,
      height: processed.height,
      bytes: processed.blob.size,
      addedAt: new Date().toISOString(),
    };
    this.meta.entries.push(entry);
    await this.#saveMeta();
    this.emit();
    return entry;
  }

  async updateOutfit(id, patch) {
    const e = this.entryById(id);
    if (!e) return null;
    Object.assign(e, patch);
    await this.#saveMeta();
    this.emit();
    return e;
  }

  async toggleFavorite(id) {
    const e = this.entryById(id);
    if (!e) return false;
    e.favorite = !e.favorite;
    await this.#saveMeta();
    this.emit();
    return e.favorite;
  }

  async deleteOutfit(id) {
    const e = this.entryById(id);
    if (!e) return;
    await this.adapter.deleteFile(e.image);
    await this.adapter.deleteFile(e.thumbnail);
    for (const p of [e.image, e.thumbnail]) {
      const u = this.#urls.get(p);
      if (u) { URL.revokeObjectURL(u); this.#urls.delete(p); }
    }
    this.meta.entries = this.meta.entries.filter((x) => x.id !== id);
    await this.#saveMeta();
    this.emit();
  }

  /* ================= image URLs ================= */

  async #url(path) {
    if (this.#urls.has(path)) return this.#urls.get(path);
    const blob = await this.adapter.readFile(path);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    this.#urls.set(path, u);
    return u;
  }

  /** Thumbnail object URL (falls back to the full image if missing). */
  async thumbURL(entry) {
    return (await this.#url(entry.thumbnail)) || this.#url(entry.image);
  }

  imageURL(entry) {
    return this.#url(entry.image);
  }

  imageBlob(entry) {
    return this.adapter.readFile(entry.image);
  }

  #dropUrlCache() {
    for (const u of this.#urls.values()) URL.revokeObjectURL(u);
    this.#urls.clear();
  }

  /* ================= backup / restore ================= */

  metadataBlob() {
    return new Blob([JSON.stringify(this.meta, null, 2)], { type: 'application/json' });
  }

  /** Full archive → ZIP (metadata.json + Photos/ + Thumbnails/). */
  async exportArchive(onProgress) {
    const files = [{ path: 'metadata.json', blob: this.metadataBlob() }];
    const list = this.entries().reverse(); // oldest first, tidy archive order
    let i = 0;
    for (const e of list) {
      i++;
      onProgress?.('read', i, list.length);
      const img = await this.adapter.readFile(e.image);
      if (img) files.push({ path: e.image, blob: img });
      const th = await this.adapter.readFile(e.thumbnail);
      if (th) files.push({ path: e.thumbnail, blob: th });
    }
    return zipFiles(files, (n, total) => onProgress?.('zip', n, total));
  }

  /** Import a metadata.json or a full archive ZIP. Merges by entry id. */
  async importFrom(file, onProgress) {
    let added = 0, skipped = 0, filesWritten = 0;

    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      const incoming = JSON.parse(await file.text());
      ({ added, skipped } = this.#mergeEntries(incoming?.entries));
    } else {
      const entries = await readZip(file);
      // Tolerate archives zipped with a wrapping folder ("OutfitMemory/…").
      const metaEntry = entries.find(
        (x) => x.path === 'metadata.json' || x.path.endsWith('/metadata.json')
      );
      const prefix =
        metaEntry && metaEntry.path !== 'metadata.json'
          ? metaEntry.path.slice(0, -'metadata.json'.length)
          : '';
      let i = 0;
      for (const en of entries) {
        i++;
        onProgress?.(i, entries.length);
        const rel = prefix && en.path.startsWith(prefix) ? en.path.slice(prefix.length) : en.path;
        if (!/^(Photos|Thumbnails)\//.test(rel)) continue;
        if (await this.adapter.readFile(rel)) continue; // never clobber existing
        await this.adapter.writeFile(rel, await en.getBlob());
        filesWritten++;
      }
      if (metaEntry) {
        const incoming = JSON.parse(await (await metaEntry.getBlob()).text());
        ({ added, skipped } = this.#mergeEntries(incoming?.entries));
      }
    }

    await this.#saveMeta();
    this.emit();
    return { added, skipped, filesWritten };
  }

  #mergeEntries(list) {
    let added = 0, skipped = 0;
    if (Array.isArray(list)) {
      for (const e of list) {
        if (e?.id && e.image && e.date && !this.entryById(e.id)) {
          this.meta.entries.push(e);
          added++;
        } else {
          skipped++;
        }
      }
    }
    return { added, skipped };
  }

  /* ================= folder maintenance ================= */

  /**
   * Folder mode: scan Photos/ for files metadata doesn't know about
   * (restored backups, files copied in by hand, recovered archives) and
   * regenerate entries + thumbnails for them.
   */
  async rescanFolder(onProgress) {
    if (this.adapter.kind !== 'folder') return { added: 0 };
    const known = new Set(this.meta.entries.map((e) => e.image));
    const candidates = [];
    for await (const f of this.adapter.walkPhotos()) {
      if (!known.has(f.path) && /\.(webp|jpe?g|png)$/i.test(f.path)) candidates.push(f);
    }
    let added = 0, i = 0;
    for (const f of candidates) {
      i++;
      onProgress?.(i, candidates.length);
      const name = f.path.split('/').pop() || '';
      const m = /outfit_(\d{4}-\d{2}-\d{2})(?:_\d+)?\./.exec(name);
      if (!m) continue;
      const date = m[1];
      try {
        const blob = await f.handle.getFile();
        const d = await deriveFromExisting(blob);
        const seq = this.#nextSeq(date);
        const id = `${date}-${String(seq).padStart(3, '0')}`;
        const thumbnail =
          f.path.replace(/^Photos\//, 'Thumbnails/').replace(/\.[^.]+$/, '') +
          `_thumb.${d.thumbExt}`;
        await this.adapter.writeFile(thumbnail, d.thumbBlob);
        this.meta.entries.push({
          id, date, time: '', image: f.path, thumbnail,
          favorite: false, notes: '', tags: [],
          colors: d.colors, palette: d.palette, weather: null,
          width: d.width, height: d.height, bytes: blob.size,
          addedAt: new Date().toISOString(),
        });
        added++;
      } catch {
        // Unreadable file — skip it, keep scanning.
      }
    }
    if (added) {
      await this.#saveMeta();
      this.emit();
    }
    return { added, scanned: candidates.length };
  }

  /** Copy the whole archive to another adapter and switch over. */
  async migrateTo(newAdapter, onProgress) {
    const list = this.entries().reverse();
    let i = 0;
    for (const e of list) {
      i++;
      onProgress?.(i, list.length);
      const img = await this.adapter.readFile(e.image);
      if (img) await newAdapter.writeFile(e.image, img);
      const th = await this.adapter.readFile(e.thumbnail);
      if (th) await newAdapter.writeFile(e.thumbnail, th);
    }
    await newAdapter.saveMetadata(this.meta);
    const old = this.adapter;
    this.adapter = newAdapter;
    if (newAdapter.kind === 'folder') await newAdapter.remember();
    this.saveSettings({ storageKind: newAdapter.kind });
    this.#dropUrlCache();
    if (old.kind === 'browser') await old.wipe(); // photos now live in the folder
    this.emit();
  }

  /** Switch to a folder that already contains an archive (no copying). */
  async adoptFolder(adapter) {
    this.adapter = adapter;
    await adapter.remember();
    this.saveSettings({ storageKind: 'folder' });
    this.#dropUrlCache();
    await this.#load();
    this.emit();
  }

  /**
   * Disconnect & reset. Folder mode: files stay on disk untouched.
   * Browser mode: optionally wipes the stored photos (they have nowhere
   * else to live, so the confirm dialog upstream is very loud about it).
   */
  async resetApp() {
    this.#dropUrlCache();
    if (this.adapter?.kind === 'browser') await this.adapter.wipe();
    await FolderStorage.forget();
    await idbDel('kv', 'backupDir').catch(() => {}); // backup folder link too
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(META_CACHE_KEY);
    } catch { /* best effort */ }
    location.reload();
  }
}

export const store = new Store();
