/**
 * imagePipeline.js — camera photo → optimized archive files.
 *
 * A phone photo comes in at 3–12 MB. The pipeline:
 *   1. decode (honoring EXIF orientation)
 *   2. downscale to ≤1600 px long edge (progressive halving for quality)
 *   3. encode WebP (JPEG fallback where the browser can't encode WebP),
 *      stepping quality/size down until the file is ≤ ~500 KB
 *   4. render a 320 px thumbnail for fast grid scrolling
 *   5. run the color analyzer on the thumbnail canvas
 *
 * Privacy bonus: re-encoding through a canvas strips ALL metadata —
 * EXIF, GPS location, device model — from the saved files.
 */

import { extractColors } from './colors.js';
// Side-effect import: registers the skin/background-aware sampler that
// extractColors delegates to, so faces and walls stay out of palettes.
import './segment.js';

const LONG_EDGES = [1600, 1400, 1200]; // fall back smaller if size budget missed
const QUALITIES = [0.86, 0.8, 0.72, 0.64, 0.58];
const MAX_BYTES = 500 * 1024;
const THUMB_EDGE = 320;
const THUMB_QUALITY = 0.8;
const ITEM_EDGE = 360;      // wardrobe item crops
const ITEM_QUALITY = 0.82;

const toBlob = (canvas, mime, q) => new Promise((r) => canvas.toBlob(r, mime, q));

/* ---------- encoder detection (Safari can't always encode WebP) ---------- */

let encoderPromise = null;

export function getEncoder() {
  return (encoderPromise ??= (async () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      const b = await toBlob(c, 'image/webp', 0.8);
      if (b && b.type === 'image/webp') return { mime: 'image/webp', ext: 'webp' };
    } catch { /* fall through */ }
    return { mime: 'image/jpeg', ext: 'jpg' };
  })());
}

/* ---------- decode ---------- */

async function decodeSource(fileOrBlob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close?.() };
    } catch {
      try {
        const bmp = await createImageBitmap(fileOrBlob);
        return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close?.() };
      } catch { /* fall through to <img> */ }
    }
  }
  const url = URL.createObjectURL(fileOrBlob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    src: img,
    w: img.naturalWidth,
    h: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/* ---------- scale ---------- */

/**
 * Draw `src` (bitmap/img/canvas) scaled so its long edge is ≤ targetLong.
 * Halves repeatedly before the final draw — one giant downscale step
 * produces visibly aliased results in several browsers.
 */
function drawScaled(src, w, h, targetLong) {
  const scale = Math.min(1, targetLong / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  let cur = src, cw = w, ch = h;
  while (cw / tw >= 2 && ch / th >= 2) {
    const half = document.createElement('canvas');
    half.width = Math.round(cw / 2);
    half.height = Math.round(ch / 2);
    const g = half.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half; cw = half.width; ch = half.height;
  }

  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, tw, th);
  return out;
}

/* ---------- public API ---------- */

/**
 * processPhoto(file) → { blob, thumbBlob, ext, width, height, colors, palette }
 * Throws if the image can't be decoded (e.g. desktop HEIC in Chrome).
 */
export async function processPhoto(file) {
  const { mime, ext } = await getEncoder();
  const s = await decodeSource(file);
  try {
    let canvas = null;
    let blob = null;

    outer:
    for (const edge of LONG_EDGES) {
      canvas = drawScaled(s.src, s.w, s.h, edge);
      for (const q of QUALITIES) {
        const b = await toBlob(canvas, mime, q);
        if (!b) continue;
        blob = b;
        if (b.size <= MAX_BYTES) break outer;
      }
    }
    if (!blob) throw new Error('encode failed');

    const thumbCanvas = drawScaled(canvas, canvas.width, canvas.height, THUMB_EDGE);
    const thumbBlob = await toBlob(thumbCanvas, mime, THUMB_QUALITY);
    const colorInfo = extractColors(thumbCanvas);

    return {
      blob,
      thumbBlob,
      ext,
      width: canvas.width,
      height: canvas.height,
      ...colorInfo,
    };
  } finally {
    s.release();
  }
}

/**
 * cropToItem(source, rect) — cut a wardrobe item out of an outfit photo.
 * `source` is any drawable (decoded <img>/bitmap/canvas); `rect` is in
 * the source's own pixel coordinates. Returns a small WebP crop plus the
 * colors detected inside it, ready for store.addItem().
 */
export async function cropToItem(source, rect, colorOverride = null) {
  const { mime, ext } = await getEncoder();
  const scale = Math.min(1, ITEM_EDGE / Math.max(rect.w, rect.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.w * scale));
  canvas.height = Math.max(1, Math.round(rect.h * scale));
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  const blob = await toBlob(canvas, mime, ITEM_QUALITY);
  // Prefer colors from segmentation (it knows which pixels are fabric);
  // otherwise read the crop, which still filters skin and background.
  const { colors, palette } = colorOverride?.colors?.length
    ? colorOverride
    : extractColors(canvas, { inset: false });
  return { blob, ext, colors, palette, width: canvas.width, height: canvas.height };
}

/**
 * Rebuild derived data (thumbnail + colors + dimensions) for an EXISTING
 * archive photo without re-encoding the full image. Used when rescanning
 * a folder whose metadata.json is missing entries.
 */
export async function deriveFromExisting(blob) {
  const { mime, ext } = await getEncoder();
  const s = await decodeSource(blob);
  try {
    const thumbCanvas = drawScaled(s.src, s.w, s.h, THUMB_EDGE);
    const thumbBlob = await toBlob(thumbCanvas, mime, THUMB_QUALITY);
    const colorInfo = extractColors(thumbCanvas);
    return { thumbBlob, thumbExt: ext, width: s.w, height: s.h, ...colorInfo };
  } finally {
    s.release();
  }
}
