/**
 * colors.js — named-color classification and dominant-color summaries.
 *
 * Two jobs:
 *   1. classifyRGB()      — map a pixel to a clothing-ish color name
 *   2. summarizeColors()  — turn weighted pixel samples into a palette
 *
 * Actually deciding WHICH pixels to look at is segment.js's job: skin and
 * wall pixels have to be thrown out first, or an outfit photo reports the
 * wearer's face as "beige" and the wall as the shirt color.
 */

/** Representative hex for each named bucket (used for UI dots/swatches). */
export const NAME_HEX = {
  black: '#1f1f24',
  white: '#f2f0ec',
  gray: '#8e8e93',
  beige: '#d3bd97',
  brown: '#7a5230',
  olive: '#6b6a3f',
  red: '#d64545',
  orange: '#e8853d',
  yellow: '#e3c53a',
  green: '#4e9a51',
  teal: '#3aa8a0',
  blue: '#3b78d8',
  navy: '#26324f',
  purple: '#7b5cd6',
  pink: '#e37bae',
};

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/** Map an HSL pixel to a named clothing-ish color bucket. */
function classifyHSL(h, s, l) {
  if (l < 0.11) return 'black';
  if (l > 0.93 && s < 0.3) return 'white';
  if (s < 0.13) {
    if (l > 0.82) return 'white';
    if (l < 0.25) return 'black';
    return 'gray';
  }
  if (h < 15 || h >= 345) return l < 0.22 ? 'brown' : 'red';
  if (h < 45) {
    if (l < 0.42) return 'brown';
    if (s < 0.5 && l > 0.55) return 'beige';
    return 'orange';
  }
  // Yellow-green: muted and mid-dark reads as olive, a staple clothing
  // color that would otherwise be lumped in with brown.
  if (h < 75) {
    if (s < 0.55 && l < 0.5) return 'olive';
    if (l < 0.32) return 'brown';
    if (s < 0.45 && l > 0.6) return 'beige';
    return 'yellow';
  }
  if (h < 165) return 'green';
  if (h < 198) return 'teal';
  if (h < 262) return l < 0.28 ? 'navy' : 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

export function classifyRGB(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return classifyHSL(h, s, l);
}

/**
 * summarizeColors(samples) → { colors: ['navy', …], palette: [{name,hex,share}] }
 * `samples` is a flat array of [r, g, b, weight] tuples.
 */
export function summarizeColors(samples) {
  const buckets = new Map();
  let total = 0;
  for (const [r, g, b, w = 1] of samples) {
    const name = classifyRGB(r, g, b);
    const bk = buckets.get(name) || { n: 0, r: 0, g: 0, b: 0 };
    bk.n += w; bk.r += r * w; bk.g += g * w; bk.b += b * w;
    buckets.set(name, bk);
    total += w;
  }
  if (!total) return { colors: [], palette: [] };

  const ranked = [...buckets.entries()]
    .map(([name, bk]) => ({
      name,
      share: bk.n / total,
      hex: '#' + [bk.r, bk.g, bk.b]
        .map((v) => Math.round(v / bk.n).toString(16).padStart(2, '0'))
        .join(''),
    }))
    .sort((a, b) => b.share - a.share);

  const top = ranked.filter((r, i) => i === 0 || r.share >= 0.08).slice(0, 3);
  return {
    colors: top.map((t) => t.name),
    palette: top.map((t) => ({ name: t.name, hex: t.hex, share: +t.share.toFixed(3) })),
  };
}

/**
 * extractColors(canvas, {inset}) → { colors, palette }
 *
 * Whole-image color read for an outfit photo. Delegates pixel selection to
 * segment.js so skin and background never colour the result; falls back to
 * a plain center-weighted sample if segmentation finds nothing usable.
 */
export function extractColors(sourceCanvas, { inset = true } = {}) {
  try {
    // Imported lazily to keep this module free of circular dependencies.
    return garmentColorsOf(sourceCanvas, inset);
  } catch {
    // Color analysis is a nice-to-have; never let it block saving a photo.
    return { colors: [], palette: [] };
  }
}

// Wired up by segment.js at import time (avoids a circular static import).
let garmentColorsOf = (canvas, inset) => rawSample(canvas, inset);

export function _setGarmentSampler(fn) {
  garmentColorsOf = fn;
}

/** Last-resort sampler: plain grid over the image (optionally inset). */
export function rawSample(sourceCanvas, inset = true) {
  const S = 48;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (inset) g.drawImage(sourceCanvas, sw * 0.18, sh * 0.1, sw * 0.64, sh * 0.8, 0, 0, S, S);
  else g.drawImage(sourceCanvas, 0, 0, sw, sh, 0, 0, S, S);
  const data = g.getImageData(0, 0, S, S).data;

  const samples = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    samples.push([data[i], data[i + 1], data[i + 2], 1]);
  }
  return summarizeColors(samples);
}
