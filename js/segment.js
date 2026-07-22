/**
 * segment.js — on-device garment segmentation. No model, no network.
 *
 * The problem: a rectangle drawn over a photo contains the garment *plus*
 * the wearer's skin and the wall behind them, so naive color extraction
 * reports "beige" for a face and the wall for a shirt.
 *
 * The approach, in order:
 *   1. Work on a small copy of the photo (long edge ~240 px) — plenty of
 *      signal for color decisions, cheap enough to run synchronously.
 *   2. Learn the background from the image border. A mirror selfie has the
 *      room around the edges, so border colors are a good background model.
 *   3. Mark skin with a standard YCbCr + RGB rule pair.
 *   4. Region-grow from the middle of the user's box across pixels of
 *      similar color, treating skin and background as hard walls.
 *   5. Tighten the box to what actually grew, and read colors from those
 *      pixels only.
 *
 * If the grown region is implausibly small (an unusual garment, a bad
 * drag), we relax progressively rather than returning nonsense — the
 * user's rectangle is always honored as a fallback.
 */

import { summarizeColors, rawSample, _setGarmentSampler } from './colors.js';
import { parsePerson, garmentPixels, CLASS } from './models/personParser.js';

const WORK_EDGE = 240;      // long edge of the analysis copy
const MIN_COVERAGE = 0.10;  // fraction of the drawn box the region must fill

/* ---------- working copy ---------- */

function toWork(source, nw, nh) {
  const scale = Math.min(1, WORK_EDGE / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, w, h };
}

/* ---------- skin ---------- */

/**
 * Kovac-style skin rules combined with a YCbCr chroma gate. Requiring both
 * keeps warm beige fabrics from being written off as skin — and even when
 * one slips through, region growing recovers it (see relax passes below).
 */
export function isSkin(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  if (!(cb >= 77 && cb <= 133 && cr >= 133 && cr <= 176)) return false;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const daylight = r > 95 && g > 40 && b > 20 && max - min > 15 &&
    Math.abs(r - g) > 15 && r > g && r > b;
  const flash = r > 220 && g > 210 && b > 170 &&
    Math.abs(r - g) <= 15 && r > b && g > b;
  return daylight || flash;
}

/* ---------- background ---------- */

const BG_BUCKET = 26;       // quantization step for border colors
const BG_TOLERANCE = 46;    // RGB distance that still counts as background

/**
 * Learn background colors from the image border. Returns a test function.
 * Buckets holding at least 4% of border pixels become prototypes, so a
 * busy border contributes several and a plain wall contributes one.
 */
function backgroundModel(data, w, h) {
  const bw = Math.max(1, Math.round(w * 0.07));
  const bh = Math.max(1, Math.round(h * 0.06));
  const hist = new Map();
  let n = 0;

  const add = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 200) return;
    const key = `${(data[i] / BG_BUCKET) | 0},${(data[i + 1] / BG_BUCKET) | 0},${(data[i + 2] / BG_BUCKET) | 0}`;
    const e = hist.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
    hist.set(key, e);
    n++;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) { add(x, y); add(w - 1 - x, y); }
  for (let x = 0; x < w; x++) for (let y = 0; y < bh; y++) { add(x, y); add(x, h - 1 - y); }

  const protos = [...hist.values()]
    .filter((e) => e.n / n >= 0.04)
    .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);

  // Squared distance throughout — this runs once per pixel per prototype,
  // and Math.hypot is an order of magnitude slower than a plain multiply.
  const tol2 = BG_TOLERANCE * BG_TOLERANCE;
  return (r, g, b) => {
    for (let i = 0; i < protos.length; i++) {
      const dr = r - protos[i][0], dg = g - protos[i][1], db = b - protos[i][2];
      if (dr * dr + dg * dg + db * db < tol2) return true;
    }
    return false;
  };
}

/* ---------- region growing ---------- */

/**
 * Grow outward from seed pixels across colors close to the running mean.
 * `blocked` marks pixels the region may never enter (skin/background).
 */
function grow(data, w, h, box, blocked, seedColor, tolerance) {
  const mask = new Uint8Array(w * h);
  const queue = [];
  const { x0, y0, x1, y1 } = box;
  const tol2 = tolerance * tolerance;

  // Seed from the middle of the box wherever the color is close enough.
  const cx0 = Math.round(x0 + (x1 - x0) * 0.34);
  const cx1 = Math.round(x0 + (x1 - x0) * 0.66);
  const cy0 = Math.round(y0 + (y1 - y0) * 0.34);
  const cy1 = Math.round(y0 + (y1 - y0) * 0.66);
  // Accumulate the seed pixels' actual colors — the running mean below is
  // sum/count, so the sums must start from the same pixels as the count.
  let sr = 0, sg = 0, sb = 0, count = 0;
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const p = y * w + x;
      if (blocked[p] || mask[p]) continue;
      const i = p * 4;
      const dr = data[i] - seedColor[0];
      const dg = data[i + 1] - seedColor[1];
      const db = data[i + 2] - seedColor[2];
      if (dr * dr + dg * dg + db * db > tol2) continue;
      mask[p] = 1;
      queue.push(p);
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
      count++;
    }
  }
  if (!queue.length) return { mask, count: 0 };

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const px = p % w, py = (p / w) | 0;
    const mr = sr / count, mg = sg / count, mb = sb / count;
    for (let d = 0; d < 4; d++) {
      const nx = px + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = py + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const np = ny * w + nx;
      if (mask[np] || blocked[np]) continue;
      const i = np * 4;
      const dr = data[i] - mr, dg = data[i + 1] - mg, db = data[i + 2] - mb;
      if (dr * dr + dg * dg + db * db > tol2) continue;
      mask[np] = 1;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
      count++;
      queue.push(np);
    }
  }
  return { mask, count };
}

/** Median color of the box center, ignoring blocked pixels. */
function seedColorOf(data, w, box, blocked) {
  const { x0, y0, x1, y1 } = box;
  const cx0 = Math.round(x0 + (x1 - x0) * 0.3);
  const cx1 = Math.round(x0 + (x1 - x0) * 0.7);
  const cy0 = Math.round(y0 + (y1 - y0) * 0.3);
  const cy1 = Math.round(y0 + (y1 - y0) * 0.7);
  const rs = [], gs = [], bs = [];
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const p = y * w + x;
      if (blocked[p]) continue;
      const i = p * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return null;
  const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

/* ---------- public API ---------- */

/**
 * segmentGarment(source, nw, nh, rect) → {
 *   bbox,        // tightened rect in source pixel coords
 *   colors, palette,
 *   coverage,    // fraction of the drawn box the garment fills
 *   mask, maskW, maskH, maskBox,   // for the highlight overlay
 *   ok           // false when we fell back to the raw rectangle
 * }
 *
 * `rect` is the user's rectangle in source pixel coordinates. The result's
 * bbox may extend slightly beyond it — a garment usually continues past a
 * quick drag, and snapping outward is what makes the selection feel smart.
 */
export function segmentGarment(source, nw, nh, rect) {
  const { data, w, h } = toWork(source, nw, nh);
  const sx = w / nw, sy = h / nh;

  // Room to grow into. The floor is a fraction of the IMAGE, not of the
  // drag, so a quick tap can still expand across a whole garment while a
  // deliberate large drag stays roughly where it was drawn.
  const padX = Math.max(rect.w * 0.15, nw * 0.12);
  const padY = Math.max(rect.h * 0.15, nh * 0.12);
  const bx0 = Math.max(0, Math.floor((rect.x - padX) * sx));
  const by0 = Math.max(0, Math.floor((rect.y - padY) * sy));
  const bx1 = Math.min(w - 1, Math.ceil((rect.x + rect.w + padX) * sx));
  const by1 = Math.min(h - 1, Math.ceil((rect.y + rect.h + padY) * sy));
  const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

  // Coverage is judged against what the user actually drew — measuring it
  // against the padded box would make every expansion look like a failure.
  const drawnArea = Math.max(1, Math.round(rect.w * sx) * Math.round(rect.h * sy));

  const isBg = backgroundModel(data, w, h);

  // Pass 1: skin and background are both walls.
  const blockedFull = new Uint8Array(w * h);
  // Pass 2 fallback: only background blocks (the garment may be skin-toned).
  const blockedBg = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const bg = isBg(r, g, b);
    blockedBg[p] = bg ? 1 : 0;
    blockedFull[p] = bg || isSkin(r, g, b) ? 1 : 0;
  }

  const attempts = [
    { blocked: blockedFull, tol: 42 },
    { blocked: blockedFull, tol: 62 },
    { blocked: blockedBg, tol: 52 },
  ];

  let best = null;
  for (const a of attempts) {
    const seed = seedColorOf(data, w, box, a.blocked);
    if (!seed) continue;
    const r = grow(data, w, h, box, a.blocked, seed, a.tol);
    if (!best || r.count > best.count) best = { ...r, blocked: a.blocked };
    if (r.count / drawnArea >= MIN_COVERAGE * 3) break; // confident enough
  }

  const coverage = best ? best.count / drawnArea : 0;
  if (!best || coverage < MIN_COVERAGE) {
    // Segmentation didn't find a believable region — honor the raw box, but
    // still drop skin and background pixels from the color read.
    return {
      ok: false,
      coverage,
      bbox: { ...rect },
      ...colorsInBox(data, w, box, blockedFull),
      mask: null,
    };
  }

  // Tighten to what actually grew.
  let mnx = w, mny = h, mxx = 0, mxy = 0;
  const samples = [];
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const p = y * w + x;
      if (!best.mask[p]) continue;
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (y < mny) mny = y;
      if (y > mxy) mxy = y;
      const i = p * 4;
      samples.push([data[i], data[i + 1], data[i + 2], 1]);
    }
  }

  const bbox = {
    x: Math.round(mnx / sx),
    y: Math.round(mny / sy),
    w: Math.max(8, Math.round((mxx - mnx + 1) / sx)),
    h: Math.max(8, Math.round((mxy - mny + 1) / sy)),
  };

  return {
    ok: true,
    coverage,
    bbox,
    ...summarizeColors(samples),
    mask: best.mask,
    maskW: w,
    maskH: h,
    maskBox: box,
  };
}

/** Colors inside a work-space box, skipping blocked (skin/bg) pixels. */
function colorsInBox(data, w, box, blocked) {
  const samples = [];
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const p = y * w + x;
      if (blocked[p]) continue;
      const i = p * 4;
      samples.push([data[i], data[i + 1], data[i + 2], 1]);
    }
  }
  // Everything was skin or wall — fall back to the raw pixels so we return
  // *something* rather than an empty palette.
  if (samples.length < 24) {
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const i = (y * w + x) * 4;
        samples.push([data[i], data[i + 1], data[i + 2], 1]);
      }
    }
  }
  return summarizeColors(samples);
}

/**
 * Whole-photo garment colors: everything except skin, background and the
 * outer margins. This is what the outfit-level `colors` field uses, and
 * it's why faces and walls no longer show up in the palette.
 */
export function garmentColors(sourceCanvas, inset = true) {
  try {
    const nw = sourceCanvas.width;
    const nh = sourceCanvas.height;
    const { data, w, h } = toWork(sourceCanvas, nw, nh);
    const isBg = backgroundModel(data, w, h);

    // For a full outfit photo, ignore the outer frame; for a tight item
    // crop (inset=false) every pixel is fair game.
    const x0 = inset ? Math.round(w * 0.12) : 0;
    const x1 = inset ? Math.round(w * 0.88) : w - 1;
    const y0 = inset ? Math.round(h * 0.08) : 0;
    const y1 = inset ? Math.round(h * 0.96) : h - 1;

    const samples = [];
    let skipped = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 200) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (isBg(r, g, b) || isSkin(r, g, b)) { skipped++; continue; }
        // Center column carries the outfit — weight it up.
        const fx = x / w;
        samples.push([r, g, b, fx > 0.3 && fx < 0.7 ? 2 : 1]);
      }
    }
    if (samples.length < 40) return rawSample(sourceCanvas, inset);
    return summarizeColors(samples);
  } catch {
    return rawSample(sourceCanvas, inset);
  }
}

// Let colors.js delegate to the segmentation-aware sampler without a
// circular static import.
_setGarmentSampler(garmentColors);

/* ================= model-backed paths (preferred) ================= */

/**
 * smartColors(canvas) — outfit colors from ACTUAL clothing pixels, using
 * the MediaPipe person parser. Falls back to the heuristic garmentColors()
 * when the parser isn't available or finds no clothes (photo of a flat-lay,
 * cartoon, etc.). This is the fix for skin and hair polluting palettes:
 * the model labels those pixel classes explicitly and we simply never
 * sample them.
 */
export async function smartColors(sourceCanvas) {
  try {
    const got = await garmentPixels(sourceCanvas, sourceCanvas.width, sourceCanvas.height);
    // Under 2% clothing pixels means the parser didn't find a dressed
    // person — trust the heuristic instead of an empty read.
    if (got && got.clothesShare > 0.02 && got.samples.length >= 40) {
      return summarizeColors(got.samples);
    }
  } catch { /* fall through */ }
  return garmentColors(sourceCanvas, true);
}

/**
 * smartSegment(source, nw, nh, rect) — like segmentGarment(), but the
 * garment mask comes from the person parser: clothing+accessory pixels
 * intersected with (a padded version of) the user's box, tightened to the
 * connected region they actually pointed at. Hair, skin and background are
 * excluded by classification, not by color rules.
 *
 * Returns the same shape as segmentGarment(); falls back to it entirely
 * when the parser is unavailable.
 */
export async function smartSegment(source, nw, nh, rect) {
  let parsed = null;
  try {
    parsed = await parsePerson(source, nw, nh, 384);
  } catch { /* no parser */ }
  if (!parsed) return segmentGarment(source, nw, nh, rect);

  const { classes, w, h } = parsed;
  const sx = w / nw, sy = h / nh;

  // Padded box in mask coordinates (same growth allowance as the fallback).
  const padX = Math.max(rect.w * 0.15, nw * 0.12);
  const padY = Math.max(rect.h * 0.15, nh * 0.12);
  const bx0 = Math.max(0, Math.floor((rect.x - padX) * sx));
  const by0 = Math.max(0, Math.floor((rect.y - padY) * sy));
  const bx1 = Math.min(w - 1, Math.ceil((rect.x + rect.w + padX) * sx));
  const by1 = Math.min(h - 1, Math.ceil((rect.y + rect.h + padY) * sy));

  const wearable = (p) => classes[p] === CLASS.CLOTHES || classes[p] === CLASS.OTHERS;

  // Flood-fill the wearable region connected to the box centre, so tapping
  // the shirt doesn't also grab the trousers (separate garment, separate
  // connected component — they touch, so also stop at a horizontal gap
  // where the user's box ends... in practice the box bounds the fill).
  const mask = new Uint8Array(w * h);
  const queue = [];
  const cx0 = Math.round((rect.x + rect.w * 0.3) * sx);
  const cx1 = Math.round((rect.x + rect.w * 0.7) * sx);
  const cy0 = Math.round((rect.y + rect.h * 0.3) * sy);
  const cy1 = Math.round((rect.y + rect.h * 0.7) * sy);
  for (let y = Math.max(by0, cy0); y <= Math.min(by1, cy1); y++) {
    for (let x = Math.max(bx0, cx0); x <= Math.min(bx1, cx1); x++) {
      const p = y * w + x;
      if (wearable(p) && !mask[p]) { mask[p] = 1; queue.push(p); }
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const px = p % w, py = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = px + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = py + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue;
      const np = ny * w + nx;
      if (mask[np] || !wearable(np)) continue;
      mask[np] = 1;
      queue.push(np);
    }
  }

  const drawnArea = Math.max(1, Math.round(rect.w * sx) * Math.round(rect.h * sy));
  if (queue.length / drawnArea < 0.08) {
    // The parser found nearly no clothing where the user pointed —
    // heuristics may still manage (e.g. product shots with no person).
    return segmentGarment(source, nw, nh, rect);
  }

  // Tight bbox + garment-only color samples from the photo itself.
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  let mnx = w, mny = h, mxx = 0, mxy = 0;
  const samples = [];
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (y < mny) mny = y;
      if (y > mxy) mxy = y;
      const i = p * 4;
      samples.push([px[i], px[i + 1], px[i + 2], 1]);
    }
  }

  return {
    ok: true,
    engine: 'parser',
    coverage: queue.length / drawnArea,
    bbox: {
      x: Math.round(mnx / sx),
      y: Math.round(mny / sy),
      w: Math.max(8, Math.round((mxx - mnx + 1) / sx)),
      h: Math.max(8, Math.round((mxy - mny + 1) / sy)),
    },
    ...summarizeColors(samples),
    mask, maskW: w, maskH: h,
    maskBox: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
  };
}
