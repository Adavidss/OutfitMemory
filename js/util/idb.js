/**
 * idb.js — minimal promise wrapper around IndexedDB.
 * Stores:
 *   'kv'    — settings-adjacent blobs: directory handle, metadata (browser mode)
 *   'files' — photo/thumbnail blobs keyed by archive-relative path (browser mode)
 */

const DB_NAME = 'outfitmemory';
const DB_VERSION = 1;

let dbPromise = null;

function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function op(storeName, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(storeName, mode);
        const rq = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(rq ? rq.result : undefined);
        tx.onabort = tx.onerror = () => reject(tx.error || rq?.error);
      })
  );
}

export const idbGet = (store, key) => op(store, 'readonly', (s) => s.get(key));
export const idbSet = (store, key, val) => op(store, 'readwrite', (s) => s.put(val, key));
export const idbDel = (store, key) => op(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store) => op(store, 'readonly', (s) => s.getAllKeys());
export const idbClear = (store) => op(store, 'readwrite', (s) => s.clear());
