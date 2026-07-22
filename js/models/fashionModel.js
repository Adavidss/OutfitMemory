/**
 * fashionModel.js — main-thread facade over the inference worker.
 *
 * Owns the model registry, the worker lifecycle, and the crops that get
 * analyzed. Swapping in a different clothing model later means adding an
 * entry to MODEL_REGISTRY — nothing else in the app changes.
 */

import { store } from '../store.js';

/**
 * Candidates, best first. The worker walks this list and uses the first
 * one that loads, so an unavailable model degrades to the next instead of
 * breaking the feature.
 *
 * Requirements for an entry: ONNX weights laid out as
 * `onnx/{text,vision}_model_*.onnx`, a CLIP-style config and tokenizer.
 */
export const MODEL_REGISTRY = [
  {
    id: 'Marqo/marqo-fashionCLIP',
    label: 'Marqo FashionCLIP',
    // int8 kernels mostly fall back to scalar paths on WebGPU (measured ~6 s
    // per crop), while fp16 runs natively there. On CPU it's the reverse, so
    // the device picks the weights: 164 MB fp16 on GPU, 83 MB q8 on WASM.
    dtype: { webgpu: 'fp16', wasm: 'q8' },
    // Text embeddings for the fixed vocabulary are precomputed at build time
    // (scripts/build_vocab_embeddings.py) and shipped with the app, so only
    // the VISION encoder is ever downloaded. Regenerate this file whenever
    // the vocabulary in utils/clothingParser.js changes.
    vocab: 'models/fashion-vocab-marqo-fashionclip',
    note: 'Trained on fashion product imagery — best at garment types.',
  },
  {
    id: 'Xenova/clip-vit-base-patch32',
    label: 'CLIP ViT-B/32',
    dtype: { webgpu: 'fp16', wasm: 'q8' },
    vocab: 'models/fashion-vocab-clip-vit-b32',
    note: 'General-purpose fallback.',
  },
];

/* ---------- capability check ---------- */

export function inferenceSupport() {
  const reasons = [];
  if (typeof Worker === 'undefined') reasons.push('Web Workers are unavailable.');
  if (typeof WebAssembly === 'undefined') reasons.push('WebAssembly is unavailable.');
  if (typeof OffscreenCanvas === 'undefined') reasons.push('OffscreenCanvas is unavailable.');
  if (typeof createImageBitmap === 'undefined') reasons.push('createImageBitmap is unavailable.');
  return { ok: reasons.length === 0, reasons };
}

export const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

/* ---------- worker lifecycle ---------- */

let worker = null;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/inferenceWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      for (const p of pending.values()) p.onProgress?.(msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  };
  worker.onerror = (err) => {
    for (const p of pending.values()) {
      p.reject(new Error(err.message || 'Inference worker failed to start'));
    }
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Free the worker (and its model memory). */
export function releaseModel() {
  worker?.terminate();
  worker = null;
  pending.clear();
}

/* ---------- public API ---------- */

/**
 * Should the tagger auto-identify crops? Yes when the user enabled it in
 * Settings, or when the model is already downloaded (using something that
 * is already on disk costs nothing). Never triggers a surprise download.
 */
export async function classifierReady() {
  if (store.settings.autoIdentify) return true;
  try {
    if (!('caches' in window)) return false;
    const cache = await caches.open('transformers-cache');
    return (await cache.keys()).length > 0;
  } catch {
    return false;
  }
}

/**
 * classifyCrop(bitmap, slotHint, onProgress) →
 *   { garment, category, confidence, alternatives } | null
 *
 * One garment in, the single most probable label out. The bitmap is
 * transferred to the worker (unusable afterwards).
 */
export async function classifyCrop(bitmap, slotHint = 'top', onProgress) {
  const support = inferenceSupport();
  if (!support.ok) return null;

  const w = ensureWorker();
  const id = ++seq;

  const msg = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(
      {
        type: 'classify',
        id,
        registry: MODEL_REGISTRY,
        devicePref: hasWebGPU() ? 'auto' : 'wasm',
        slotHint,
        bitmap,
      },
      [bitmap],
    );
  });
  return msg.verdict || null;
}
