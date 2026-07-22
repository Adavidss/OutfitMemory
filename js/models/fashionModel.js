/**
 * fashionModel.js — main-thread facade over the inference worker.
 *
 * Owns the model registry, the worker lifecycle, and the crops that get
 * analyzed. Swapping in a different clothing model later means adding an
 * entry to MODEL_REGISTRY — nothing else in the app changes.
 */

import { store } from '../store.js';
import { segmentGarment } from '../segment.js';

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

/* ---------- garment crops ---------- */

/** Standard body zones, used when an outfit has no tagged items. */
const ZONES = [
  { slot: 'top', y: 0.26, h: 0.28 },
  { slot: 'bottom', y: 0.55, h: 0.30 },
  { slot: 'shoes', y: 0.87, h: 0.11 },
];

const CROP_EDGE = 336; // a little above CLIP's 224 input, leaves room to resize

/** Decode an archive image path to a bitmap. */
async function bitmapFor(path) {
  const blob = await store.adapter.readFile(path);
  if (!blob) return null;
  return createImageBitmap(blob);
}

async function cropBitmap(source, rect) {
  const scale = Math.min(1, CROP_EDGE / Math.max(rect.w, rect.h));
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return createImageBitmap(c);
}

/**
 * Work out what to analyze for an outfit.
 * Tagged items win (the user already told us where the clothes are);
 * otherwise fall back to segmenting the standard body zones.
 */
export async function collectGarments(entry) {
  const tagged = store.itemsFor(entry);
  const out = [];

  if (tagged.length) {
    for (const item of tagged) {
      const bmp = item.thumb ? await bitmapFor(item.thumb) : null;
      if (!bmp) continue;
      out.push({
        slot: item.category, itemId: item.id, name: item.name,
        color: item.color || '', hex: item.hex || '', bitmap: bmp,
      });
    }
    if (out.length) return out;
  }

  const photo = await bitmapFor(entry.image);
  if (!photo) return out;
  const NW = photo.width;
  const NH = photo.height;

  for (const zone of ZONES) {
    const drawn = {
      x: Math.round(NW * 0.22), y: Math.round(NH * zone.y),
      w: Math.round(NW * 0.56), h: Math.round(NH * zone.h),
    };
    let seg = null;
    try {
      seg = segmentGarment(photo, NW, NH, drawn);
    } catch { /* use the raw zone */ }
    const rect = seg?.ok ? seg.bbox : drawn;
    // A zone that segmented to almost nothing probably isn't a garment.
    if (seg && !seg.ok && zone.slot === 'shoes') continue;
    out.push({
      slot: zone.slot,
      itemId: null,
      name: null,
      color: seg?.colors?.[0] || '',
      hex: seg?.palette?.[0]?.hex || '',
      bitmap: await cropBitmap(photo, rect),
    });
  }
  photo.close?.();
  return out;
}

/* ---------- public API ---------- */

/**
 * analyzeOutfit(entry, onProgress) → { results, model }
 * Each result: { slot, itemId, color, hex, attributes[] }
 */
export async function analyzeOutfit(entry, onProgress) {
  const support = inferenceSupport();
  if (!support.ok) throw new Error(support.reasons.join(' '));

  const garments = await collectGarments(entry);
  if (!garments.length) throw new Error('Could not read this outfit photo.');

  const w = ensureWorker();
  const id = ++seq;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(
      {
        type: 'analyze',
        id,
        registry: MODEL_REGISTRY,
        devicePref: hasWebGPU() ? 'auto' : 'wasm',
        garments: garments.map((g) => ({
          slot: g.slot, itemId: g.itemId, color: g.color, hex: g.hex, bitmap: g.bitmap,
        })),
      },
      garments.map((g) => g.bitmap), // transfer, don't copy
    );
  });
}
