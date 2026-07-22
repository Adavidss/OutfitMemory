/**
 * modelCache.js — what the clothing model has stored on this device, and
 * how to get rid of it.
 *
 * Two caches are involved:
 *   • Cache API 'transformers-cache' — the ONNX weights themselves, put
 *     there by transformers.js. This is what makes the feature work
 *     offline after the first run.
 *   • IndexedDB 'outfitmemory-ml' — our embedded fashion vocabulary, so
 *     the 60 MB text encoder never has to be downloaded twice.
 *
 * Both are ordinary browser storage on the user's machine. Clearing them
 * loses nothing but download time.
 */

const TRANSFORMERS_CACHE = 'transformers-cache';
const ML_DB = 'outfitmemory-ml';

/** Rough size + entry count of the downloaded model weights. */
export async function modelCacheStatus() {
  const out = { cached: false, bytes: 0, entries: 0, vocabCached: false };
  try {
    if (!('caches' in self)) return out;
    const has = await caches.has(TRANSFORMERS_CACHE);
    if (has) {
      const cache = await caches.open(TRANSFORMERS_CACHE);
      const keys = await cache.keys();
      out.entries = keys.length;
      out.cached = keys.length > 0;
      // Sum content-length where the browser exposes it.
      for (const req of keys) {
        const res = await cache.match(req);
        const len = Number(res?.headers?.get('content-length') || 0);
        if (len) out.bytes += len;
        else if (res) {
          try { out.bytes += (await res.clone().arrayBuffer()).byteLength; } catch { /* skip */ }
        }
      }
    }
    out.vocabCached = await hasVocab();
  } catch { /* report what we managed to gather */ }
  return out;
}

async function hasVocab() {
  try {
    const db = await new Promise((resolve, reject) => {
      const rq = indexedDB.open(ML_DB);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      rq.onupgradeneeded = () => { /* created empty — nothing cached yet */ };
    });
    if (!db.objectStoreNames.contains('textEmbeds')) { db.close(); return false; }
    const n = await new Promise((resolve) => {
      const tx = db.transaction('textEmbeds', 'readonly');
      const rq = tx.objectStore('textEmbeds').count();
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(0);
    });
    db.close();
    return n > 0;
  } catch { return false; }
}

/** Delete the downloaded weights and the cached vocabulary. */
export async function clearModelCache() {
  try { await caches.delete(TRANSFORMERS_CACHE); } catch { /* ignore */ }
  try {
    await new Promise((resolve) => {
      const rq = indexedDB.deleteDatabase(ML_DB);
      rq.onsuccess = rq.onerror = rq.onblocked = () => resolve();
    });
  } catch { /* ignore */ }
}

export function formatBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}
