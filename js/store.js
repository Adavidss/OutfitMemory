/**
 * store.js — central app state: metadata, storage adapter, settings.
 *
 * Single source of truth. Views subscribe via store.addEventListener:
 *   'change' — entries/metadata mutated → re-render
 *   'status' — boot status changed (onboarding → locked → ready)
 *
 * Metadata schema (metadata.json — see README for the full contract):
 * {
 *   app: "OutfitMemory", schema: 2, createdAt, updatedAt,
 *   entries: [{
 *     id: "2026-07-21-001", date: "2026-07-21", time: "08:12",
 *     image: "Photos/2026/07/outfit_2026-07-21.webp",
 *     thumbnail: "Thumbnails/2026/07/outfit_2026-07-21_thumb.webp",
 *     favorite, notes, tags[], colors[], palette[], weather,
 *     items: ["itm_ab12cd"],          // schema 2 — optional wardrobe links
 *     shopping: {…},                  // schema 2 — cached "find similar" run
 *     width, height, bytes, addedAt
 *   }],
 *   items: [{                          // schema 2 — the optional wardrobe
 *     id: "itm_ab12cd", name: "Navy crew sweater", category: "top",
 *     color: "navy", hex: "#26324f", brand, price, currency, link, notes,
 *     thumb: "Items/itm_ab12cd.webp", createdAt
 *   }]
 * }
 * Unknown top-level/entry fields are preserved on load+save, so future
 * (AI) features can extend entries without a migration. Schema 1 archives
 * load unchanged — `items` is simply absent until the user tags something.
 */

import { FolderStorage } from './storage/folderStorage.js';
import { BrowserStorage } from './storage/browserStorage.js';
import { todayStr, nowTime, computeStreaks } from './util/dates.js';
import { zipFiles, readZip } from './util/zip.js';
import { idbDel } from './util/idb.js';
import { deriveFromExisting, recolorExisting } from './imagePipeline.js';

const SETTINGS_KEY = 'om.settings';
const META_CACHE_KEY = 'om.metaCache';

const DEFAULT_SETTINGS = {
  theme: 'auto',          // auto | light | dark | mono | magazine | polaroid
  setupDone: false,
  storageKind: null,      // 'folder' | 'browser'
  lastView: 'gallery',
  memoryDismissed: '',    // date the "on this day" banner was dismissed
  gridDensity: 'cozy',    // 'cozy' | 'compact' gallery grid
  backup: { preset: 'off', lastRun: '', folderName: '' }, // see js/backup.js
  autoIdentify: false,    // classify crops while tagging even if not cached yet
  geminiKey: '',          // user's own key for optional online lookup (never exported)
};

const SCHEMA = 2;

function freshMeta() {
  const now = new Date().toISOString();
  return { app: 'OutfitMemory', schema: SCHEMA, createdAt: now, updatedAt: now, entries: [], items: [] };
}

/** Short, collision-proof-enough id for a wardrobe item. */
function itemId() {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return `itm_${rnd[0].toString(36)}${rnd[1].toString(36)}`.slice(0, 14);
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
    this.#normalize();
    this.#cacheMeta();
  }

  /** Bring any loaded archive up to the current schema (purely additive). */
  #normalize() {
    if (!Array.isArray(this.meta.entries)) this.meta.entries = [];
    if (!Array.isArray(this.meta.items)) this.meta.items = [];
    if (!Array.isArray(this.meta.plans)) this.meta.plans = [];
    this.meta.schema = Math.max(SCHEMA, Number(this.meta.schema) || 0);
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
    this.#normalize();
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

  async addOutfit(processed, { date = todayStr(), notes = '', favorite = false, items = [] } = {}) {
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
      items: items.filter((id) => this.itemById(id)),
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

  /** Put a just-deleted outfit back (Undo). Blobs were captured pre-delete. */
  async restoreOutfit(entry, imageBlob, thumbBlob) {
    if (this.entryById(entry.id)) return; // already back somehow
    if (imageBlob) await this.adapter.writeFile(entry.image, imageBlob);
    if (thumbBlob) await this.adapter.writeFile(entry.thumbnail, thumbBlob);
    this.meta.entries.push(entry);
    await this.#saveMeta();
    this.emit();
  }

  /* ================= wardrobe items (optional layer) ================= */

  /** Every wardrobe item, newest first. Empty until the user tags one. */
  items() {
    return [...(this.meta?.items || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  itemById(id) {
    return this.meta?.items?.find((i) => i.id === id) || null;
  }

  /** Items linked to an outfit, in wardrobe order. */
  itemsFor(entry) {
    return (entry?.items || []).map((id) => this.itemById(id)).filter(Boolean);
  }

  /** Outfits featuring an item, newest first. */
  entriesWithItem(id) {
    return this.entries().filter((e) => (e.items || []).includes(id));
  }

  /**
   * Create an item from a crop taken out of an outfit photo.
   * `crop` is { blob, ext } from imagePipeline.cropToItem().
   */
  async addItem(fields, crop, linkToEntryId = null) {
    const id = itemId();
    let thumb = '';
    if (crop?.blob) {
      thumb = `Items/${id}.${crop.ext || 'webp'}`;
      await this.adapter.writeFile(thumb, crop.blob);
    }
    const item = {
      id,
      name: (fields.name || 'Item').trim(),
      category: fields.category || 'top',
      color: fields.color || '',
      hex: fields.hex || '',
      brand: (fields.brand || '').trim(),
      price: Number.isFinite(fields.price) ? fields.price : null,
      currency: fields.currency || this.settings.currency || 'USD',
      link: fields.link || '',
      notes: (fields.notes || '').trim(),
      thumb,
      createdAt: new Date().toISOString(),
    };
    this.meta.items.push(item);
    if (linkToEntryId) {
      const e = this.entryById(linkToEntryId);
      if (e) {
        if (!Array.isArray(e.items)) e.items = [];
        if (!e.items.includes(id)) e.items.push(id);
      }
    }
    await this.#saveMeta();
    this.emit();
    return item;
  }

  async updateItem(id, patch) {
    const it = this.itemById(id);
    if (!it) return null;
    Object.assign(it, patch);
    await this.#saveMeta();
    this.emit();
    return it;
  }

  /** Delete an item and unlink it from every outfit (photos untouched). */
  async deleteItem(id) {
    const it = this.itemById(id);
    if (!it) return;
    if (it.thumb) {
      await this.adapter.deleteFile(it.thumb);
      const u = this.#urls.get(it.thumb);
      if (u) { URL.revokeObjectURL(u); this.#urls.delete(it.thumb); }
    }
    this.meta.items = this.meta.items.filter((x) => x.id !== id);
    for (const e of this.meta.entries) {
      if (e.items?.includes(id)) e.items = e.items.filter((x) => x !== id);
    }
    await this.#saveMeta();
    this.emit();
  }

  /** Link/unlink an existing item to an outfit. Returns the new link state. */
  async toggleItemLink(entryId, id) {
    const e = this.entryById(entryId);
    if (!e || !this.itemById(id)) return false;
    if (!Array.isArray(e.items)) e.items = [];
    const has = e.items.includes(id);
    e.items = has ? e.items.filter((x) => x !== id) : [...e.items, id];
    await this.#saveMeta();
    this.emit();
    return !has;
  }

  /** Set an outfit's full item list at once (used by the outfit builder). */
  async setEntryItems(entryId, ids) {
    const e = this.entryById(entryId);
    if (!e) return null;
    e.items = [...new Set(ids)].filter((id) => this.itemById(id));
    await this.#saveMeta();
    this.emit();
    return e;
  }

  itemThumbURL(item) {
    return item?.thumb ? this.#url(item.thumb) : Promise.resolve(null);
  }

  /* ================= planned outfits ================= */

  /** Saved outfit ideas from the builder (no photo yet), newest first. */
  plans() {
    return [...(this.meta?.plans || [])].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async addPlan(itemIds, note = '') {
    const plan = {
      id: `plan_${Date.now().toString(36)}`,
      items: [...new Set(itemIds)].filter((id) => this.itemById(id)),
      note: note.trim(),
      createdAt: new Date().toISOString(),
    };
    if (!plan.items.length) return null;
    this.meta.plans.push(plan);
    await this.#saveMeta();
    this.emit();
    return plan;
  }

  async deletePlan(id) {
    this.meta.plans = (this.meta.plans || []).filter((p) => p.id !== id);
    await this.#saveMeta();
    this.emit();
  }

  /* ================= color maintenance ================= */

  /**
   * Re-run color detection over every outfit and item crop. Exists because
   * detection improves over time (person-parsing replaced heuristics) and
   * old palettes keep whatever the old engine saw — skin included.
   */
  async recalcAllColors(onProgress) {
    const entries = this.meta.entries;
    let done = 0, changed = 0;
    for (const e of entries) {
      done++;
      onProgress?.(done, entries.length + this.meta.items.length);
      const blob = await this.adapter.readFile(e.thumbnail) || await this.adapter.readFile(e.image);
      if (!blob) continue;
      try {
        const c = await recolorExisting(blob);
        if (c.colors.length && JSON.stringify(c.colors) !== JSON.stringify(e.colors)) changed++;
        if (c.colors.length) { e.colors = c.colors; e.palette = c.palette; }
      } catch { /* keep old colors for unreadable files */ }
    }
    for (const it of this.meta.items) {
      done++;
      onProgress?.(done, entries.length + this.meta.items.length);
      if (!it.thumb) continue;
      const blob = await this.adapter.readFile(it.thumb);
      if (!blob) continue;
      try {
        const c = await recolorExisting(blob);
        if (c.colors[0]) { it.color = c.colors[0]; it.hex = c.palette[0]?.hex || it.hex; }
      } catch { /* ignore */ }
    }
    await this.#saveMeta();
    this.emit();
    return { changed, total: entries.length };
  }

  /** All distinct tags, most-used first (for autocomplete). */
  allTags() {
    const counts = new Map();
    for (const e of this.meta?.entries || []) {
      for (const t of e.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
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

  /**
   * Every archive-relative file path the app owns, oldest entry first.
   * Single source of truth for export, backup mirroring and migration —
   * so a new file kind (item crops) is never silently left behind.
   */
  allFilePaths() {
    const paths = [];
    for (const e of this.entries().reverse()) paths.push(e.image, e.thumbnail);
    for (const it of this.meta?.items || []) if (it.thumb) paths.push(it.thumb);
    return paths.filter(Boolean);
  }

  /** Full archive → ZIP (metadata.json + Photos/ + Thumbnails/ + Items/). */
  async exportArchive(onProgress) {
    const files = [{ path: 'metadata.json', blob: this.metadataBlob() }];
    const paths = this.allFilePaths();
    let i = 0;
    for (const p of paths) {
      i++;
      onProgress?.('read', i, paths.length);
      const blob = await this.adapter.readFile(p);
      if (blob) files.push({ path: p, blob });
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
        if (!/^(Photos|Thumbnails|Items)\//.test(rel)) continue;
        if (await this.adapter.readFile(rel)) continue; // never clobber existing
        await this.adapter.writeFile(rel, await en.getBlob());
        filesWritten++;
      }
      if (metaEntry) {
        const incoming = JSON.parse(await (await metaEntry.getBlob()).text());
        ({ added, skipped } = this.#mergeEntries(incoming?.entries));
        this.#mergeItems(incoming?.items);
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

  /** Merge wardrobe items by id (existing items always win). */
  #mergeItems(list) {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const it of list) {
      if (it?.id && !this.itemById(it.id)) {
        this.meta.items.push(it);
        added++;
      }
    }
    return added;
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
    const paths = this.allFilePaths();
    let i = 0;
    for (const p of paths) {
      i++;
      onProgress?.(i, paths.length);
      const blob = await this.adapter.readFile(p);
      if (blob) await newAdapter.writeFile(p, blob);
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
