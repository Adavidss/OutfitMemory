/**
 * browserStorage.js — IndexedDB fallback adapter.
 *
 * Used where the File System Access API doesn't exist (iOS/iPadOS Safari,
 * Firefox, all Android browsers as of 2026). Photos are stored as Blobs in
 * IndexedDB under the same archive-relative paths a folder would use, so:
 *   - export produces a ZIP with the exact canonical folder layout, and
 *   - migrating to a real folder later is a straight path→file copy.
 *
 * Still fully private and on-device — nothing is uploaded anywhere.
 * We request persistent storage to protect the data from eviction.
 */

import { idbGet, idbSet, idbDel, idbKeys, idbClear } from '../util/idb.js';

const META_KEY = 'metadata';

export class BrowserStorage {
  kind = 'browser';

  label() {
    return 'Private browser storage';
  }

  async writeFile(path, blob) {
    await idbSet('files', path, blob);
  }

  async readFile(path) {
    return (await idbGet('files', path)) ?? null;
  }

  async deleteFile(path) {
    await idbDel('files', path);
  }

  async loadMetadata() {
    return (await idbGet('kv', META_KEY)) ?? null;
  }

  async saveMetadata(meta) {
    // Deep-clone through JSON so IndexedDB never holds live references.
    await idbSet('kv', META_KEY, JSON.parse(JSON.stringify(meta)));
  }

  async listFiles() {
    return idbKeys('files');
  }

  /** Remove every photo blob and the metadata record. */
  async wipe() {
    await idbClear('files');
    await idbDel('kv', META_KEY);
  }

  static async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  }

  static async persisted() {
    try { return await navigator.storage?.persisted?.(); } catch { return false; }
  }

  static async estimate() {
    try { return await navigator.storage?.estimate?.(); } catch { return null; }
  }
}
