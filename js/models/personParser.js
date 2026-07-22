/**
 * personParser.js — real person parsing via MediaPipe's multiclass selfie
 * segmenter. This replaces the hand-written skin/background heuristics as
 * the primary engine: rule-based skin detection provably fails on real
 * photos (skin tones vary far beyond any YCbCr box, and hair was never
 * handled at all), which is exactly the "it tags my skin and hair" bug.
 *
 * The model labels every pixel as one of:
 *   0 background · 1 hair · 2 body-skin · 3 face-skin · 4 clothes · 5 accessories
 * so "which pixels are clothing" stops being a guess.
 *
 * Cost: ~1.3 MB of WASM from jsdelivr + a 16 MB model from Google's public
 * model bucket, cached in the Cache API after first use (offline after
 * that). Inference is local; the photo never leaves the device. If the
 * model can't load (offline first run, blocked CDN), callers fall back to
 * the old heuristics in segment.js — worse, but never broken.
 */

const MP_VERSION = '0.10.35';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const CACHE_NAME = 'om-mediapipe';

export const CLASS = { BG: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHERS: 5 };

let segmenterPromise = null;

/** Fetch with an explicit Cache API layer so the 16 MB model is a one-time download. */
async function cachedFetch(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res.clone());
    return res;
  } catch {
    return fetch(url);
  }
}

/** True once the parser has been downloaded on this device. */
export async function parserCached() {
  try {
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(MODEL_URL));
  } catch {
    return false;
  }
}

export async function clearParserCache() {
  try { await caches.delete(CACHE_NAME); } catch { /* ignore */ }
}

/**
 * Lazily create the segmenter (idempotent). Rejects if the runtime or
 * model can't be fetched — callers treat that as "no parser, use fallback".
 */
export function getParser() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
      const model = await (await cachedFetch(MODEL_URL)).arrayBuffer();
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      return vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(model) },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'IMAGE',
      });
    })();
    // A failed load (offline first run, CDN hiccup) must not poison the
    // session — drop the rejected promise so the next call retries.
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

/** Fire-and-forget warmup (e.g. while the tagger's photo is decoding). */
export function warmParser() {
  getParser().catch(() => { /* fallback path handles it */ });
}

/**
 * parsePerson(source, w, h) → { classes: Uint8Array, w, h } | null
 * `classes[y*w + x]` is a CLASS value. Downscales internally — the mask
 * resolution is capped so parsing stays ~fast regardless of photo size.
 */
export async function parsePerson(source, sw, sh, edge = 512) {
  let segmenter;
  try {
    segmenter = await getParser();
  } catch {
    return null;
  }
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const w = Math.max(16, Math.round(sw * scale));
  const h = Math.max(16, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(source, 0, 0, w, h);

  const result = segmenter.segment(canvas);
  try {
    const mask = result.categoryMask;
    const classes = Uint8Array.from(mask.getAsUint8Array());
    return { classes, w, h };
  } finally {
    result.close();
  }
}

/**
 * garmentPixels(source, sw, sh) — colors of clothing pixels only.
 * Returns [r,g,b,weight][] samples plus mask stats, or null without parser.
 */
export async function garmentPixels(source, sw, sh) {
  const parsed = await parsePerson(source, sw, sh, 256);
  if (!parsed) return null;
  const { classes, w, h } = parsed;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  const samples = [];
  let clothes = 0;
  for (let p = 0; p < classes.length; p++) {
    if (classes[p] !== CLASS.CLOTHES) continue;
    clothes++;
    const i = p * 4;
    samples.push([px[i], px[i + 1], px[i + 2], 1]);
  }
  return { samples, clothesShare: clothes / classes.length };
}
