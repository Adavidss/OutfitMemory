/**
 * inferenceWorker.js — FashionCLIP inference, off the main thread.
 *
 * Runs as a module worker so the UI never freezes while a ~90 MB model
 * downloads and a few hundred million multiply-adds happen.
 *
 * Pipeline
 * --------
 *  1. Text side (once, ever): embed ~100 fashion prompts and store the
 *     vectors in IndexedDB. The text encoder is then never needed again —
 *     which is the whole reason a second visit is fast, and why the
 *     61 MB text model can be evicted afterwards.
 *  2. Image side (per garment): embed the crop with the vision encoder.
 *  3. Compare: cosine similarity against the cached text vectors, softmaxed
 *     per attribute axis, giving a label and a confidence for each.
 *
 * Everything is local. Model weights are *downloaded* from the CDN on
 * first use; no image, embedding or query is ever uploaded anywhere.
 */

import {
  allPrompts, axesFor, labelsForAxis, vocabVersion, buildAttributes,
} from '../utils/clothingParser.js';

/* ---------- transformers.js (loaded lazily from CDN, then cached) ---------- */

const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js';

let tf = null;          // the transformers.js module namespace
let textModel = null;
let visionModel = null;
let tokenizer = null;
let processor = null;
let activeModel = null; // the registry entry we actually loaded
let textVectors = null; // Map<prompt, Float32Array>

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (phase, detail = '', pct = null) =>
  post({ type: 'progress', phase, detail, pct });

/* ---------- text-embedding cache (IndexedDB) ---------- */

const DB_NAME = 'outfitmemory-ml';
const STORE = 'textEmbeds';

function idb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function cacheGet(key) {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result ?? null);
      rq.onerror = () => reject(rq.error);
    });
  } catch { return null; }
}

async function cacheSet(key, value) {
  try {
    const d = await idb();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* cache is an optimization; failure just means slower next time */ }
}

/* ---------- model loading ---------- */

async function loadTransformers() {
  if (tf) return tf;
  progress('library', 'Loading inference runtime…');
  tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  // Never look for models on our own origin — they live on the HF CDN.
  tf.env.allowLocalModels = false;
  // Let transformers.js keep weights in the Cache API so a second visit is
  // instant and works fully offline.
  tf.env.useBrowserCache = true;
  return tf;
}

/** Pick a device the browser can actually run. */
async function pickDevice(preferred) {
  if (preferred === 'wasm') return 'wasm';
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch { /* fall through */ }
  return 'wasm';
}

/**
 * Load one candidate model. Throws if it can't be loaded, so the caller
 * can move down the registry.
 */
/** Registry entries may carry per-device weights; resolve to one string. */
function dtypeFor(entry, device) {
  return typeof entry.dtype === 'string'
    ? entry.dtype
    : (entry.dtype?.[device] || entry.dtype?.wasm || 'q8');
}

async function loadModel(entry, device) {
  const T = await loadTransformers();
  const opts = { dtype: dtypeFor(entry, device), device };

  progress('tokenizer', `Loading tokenizer (${entry.label})…`);
  tokenizer = await T.AutoTokenizer.from_pretrained(entry.id);
  processor = await T.AutoProcessor.from_pretrained(entry.id);

  progress('vision', `Downloading vision model (${entry.label})…`);
  visionModel = await T.CLIPVisionModelWithProjection.from_pretrained(entry.id, {
    ...opts,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file?.includes('vision')) {
        progress('vision', 'Downloading vision model…', p.progress ?? null);
      }
    },
  });
  activeModel = entry;
  return entry;
}

async function ensureTextModel(entry, device) {
  if (textModel) return;
  const T = await loadTransformers();
  progress('text', 'Downloading text model (one time only)…');
  textModel = await T.CLIPTextModelWithProjection.from_pretrained(entry.id, {
    dtype: dtypeFor(entry, device),
    device,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file?.includes('text')) {
        progress('text', 'Downloading text model (one time only)…', p.progress ?? null);
      }
    },
  });
}

/* ---------- embeddings ---------- */

function l2normalize(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

/**
 * Load the vocabulary embeddings that ship with the app.
 *
 * The vocabulary is fixed at build time, so its text vectors are a build
 * artifact, not something every browser should recompute: 264 KB of
 * same-origin float32 instead of a 61 MB text encoder download plus a slow
 * encode pass. Returns null if the file is missing or was generated from a
 * different vocabulary, in which case we fall back to encoding at runtime.
 */
async function loadPrebuiltVectors(entry) {
  if (!entry.vocab) return null;
  try {
    const base = new URL(`../../${entry.vocab}`, import.meta.url);
    const manifest = await (await fetch(`${base}.json`)).json();
    if (manifest.model !== entry.id) return null;
    if (manifest.vocabVersion !== vocabVersion()) return null;

    const buf = await (await fetch(`${base}.bin`)).arrayBuffer();
    const { prompts, dim } = manifest;
    if (buf.byteLength !== prompts.length * dim * 4) return null;

    const all = new Float32Array(buf);
    const map = new Map();
    for (let i = 0; i < prompts.length; i++) {
      map.set(prompts[i], all.subarray(i * dim, (i + 1) * dim));
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Embed every prompt in the vocabulary, or load them from IndexedDB.
 * Returns Map<prompt, Float32Array>.
 */
async function ensureTextVectors(entry, device) {
  if (textVectors) return textVectors;

  // Fast path: precomputed vectors shipped with the app.
  const prebuilt = await loadPrebuiltVectors(entry);
  if (prebuilt) {
    progress('text', 'Loading clothing vocabulary…');
    textVectors = prebuilt;
    return textVectors;
  }

  const key = `${entry.id}::${vocabVersion()}`;
  const cached = await cacheGet(key);
  if (cached && cached.dim && cached.data) {
    progress('text', 'Using cached clothing vocabulary…');
    const map = new Map();
    const { prompts, dim, data } = cached;
    for (let i = 0; i < prompts.length; i++) {
      map.set(prompts[i], new Float32Array(data.buffer, i * dim * 4, dim));
    }
    textVectors = map;
    return map;
  }

  await ensureTextModel(entry, device);
  const prompts = allPrompts();
  progress('text', `Encoding ${prompts.length} clothing descriptions…`);

  const vectors = [];
  const BATCH = 16;
  for (let i = 0; i < prompts.length; i += BATCH) {
    const batch = prompts.slice(i, i + BATCH);
    // CLIP's exported ONNX graph has a FIXED 77-token context. Padding to
    // the longest string in the batch (transformers.js's default) produces
    // a 12-wide tensor and ORT rejects it, so pad every sequence to 77.
    const inputs = tokenizer(batch, {
      padding: 'max_length',
      max_length: 77,
      truncation: true,
    });
    const { text_embeds } = await textModel(inputs);
    const dim = text_embeds.dims[1];
    const flat = text_embeds.data;
    for (let b = 0; b < batch.length; b++) {
      vectors.push(l2normalize(flat.slice(b * dim, (b + 1) * dim)));
    }
    progress('text', 'Encoding clothing descriptions…', (i + batch.length) / prompts.length);
  }

  const dim = vectors[0].length;
  const packed = new Float32Array(prompts.length * dim);
  vectors.forEach((v, i) => packed.set(v, i * dim));
  await cacheSet(`${entry.id}::${vocabVersion()}`, { prompts, dim, data: packed });

  textVectors = new Map(prompts.map((p, i) => [p, vectors[i]]));

  // The text encoder has done its one job — let it go so the tab isn't
  // sitting on 60 MB of weights it will never use again this session.
  textModel = null;
  return textVectors;
}

async function embedImage(bitmap) {
  const T = await loadTransformers();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const image = new T.RawImage(new Uint8ClampedArray(data), width, height, 4);

  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  return l2normalize(image_embeds.data);
}

/* ---------- scoring ---------- */

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Softmax with CLIP's standard logit scale. */
function softmax(sims, scale = 100) {
  const logits = sims.map((s) => s * scale);
  const max = Math.max(...logits);
  const exp = logits.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0) || 1;
  return exp.map((e) => e / sum);
}

/** Score one image embedding against every axis for a slot. */
function scoreAxes(imageVec, slot) {
  const out = {};
  for (const axis of axesFor(slot)) {
    const labels = labelsForAxis(axis, slot);
    const sims = labels.map((l) => {
      const v = textVectors.get(axis.prompt(l));
      return v ? dot(imageVec, v) : -1;
    });
    const probs = softmax(sims);
    out[axis.key] = labels
      .map((label, i) => ({ label, confidence: probs[i], similarity: sims[i] }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 4);
  }
  return out;
}

/* ---------- message handling ---------- */

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'analyze') return;

  const { id, garments, registry, devicePref } = msg;
  try {
    const device = await pickDevice(devicePref);
    progress('device', device === 'webgpu' ? 'Initializing WebGPU…' : 'Initializing WASM runtime…');

    // Walk the registry until one model loads — this is the automatic
    // fallback: if the preferred FashionCLIP can't run here, the next
    // candidate takes over without the user seeing a difference.
    let loaded = null;
    const failures = [];
    for (const entry of registry) {
      try {
        loaded = await loadModel(entry, device);
        break;
      } catch (err) {
        failures.push(`${entry.id}: ${err?.message || err}`);
        visionModel = null;
        tokenizer = null;
        processor = null;
      }
    }
    if (!loaded) throw new Error(`No clothing model could be loaded. ${failures.join(' | ')}`);

    await ensureTextVectors(loaded, device);

    progress('analyze', 'Analyzing clothing…');
    const results = [];
    for (let i = 0; i < garments.length; i++) {
      const g = garments[i];
      progress('analyze', `Analyzing ${g.slot}…`, (i + 0.5) / garments.length);
      const vec = await embedImage(g.bitmap);
      const scores = scoreAxes(vec, g.slot);
      results.push({
        slot: g.slot,
        itemId: g.itemId || null,
        color: g.color || '',
        hex: g.hex || '',
        attributes: buildAttributes(g.slot, scores),
      });
      g.bitmap.close?.();
    }

    post({
      type: 'result', id, results,
      model: { id: loaded.id, label: loaded.label, device, fallback: failures.length > 0 },
    });
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) });
  }
};
