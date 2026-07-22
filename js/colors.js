/**
 * colors.js — lightweight dominant-color analysis.
 *
 * This is the first "analyzer" in what is designed to become a pluggable
 * analysis pipeline (see README → Future AI). It runs entirely on-device
 * on the already-decoded thumbnail canvas, costs ~1 ms, and fills the
 * `colors` / `palette` metadata fields that power stats, filtering and
 * Wrapped. A future embedding/segmentation model would slot in beside it
 * and simply write additional metadata fields.
 */

/** Representative hex for each named bucket (used for UI dots/swatches). */
export const NAME_HEX = {
  black: '#1f1f24',
  white: '#f2f0ec',
  gray: '#8e8e93',
  beige: '#d3bd97',
  brown: '#7a5230',
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

function rgbToHsl(r, g, b) {
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
function classify(h, s, l) {
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
  if (h < 68) {
    if (l < 0.35) return 'brown';
    if (s < 0.45 && l > 0.6) return 'beige';
    return 'yellow';
  }
  if (h < 165) return 'green';
  if (h < 198) return 'teal';
  if (h < 262) return l < 0.28 ? 'navy' : 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

/**
 * extractColors(canvas, {inset}) → { colors: ['navy', …], palette: [{name, hex, share}] }
 *
 * Samples a center-weighted crop (outfit photos are usually a person mid-
 * frame against a wall/mirror, so margins are mostly background) and
 * histograms the pixels into named buckets. Pass `inset: false` when the
 * canvas is already a tight crop (a wardrobe item) and every pixel counts.
 */
export function extractColors(sourceCanvas, { inset = true } = {}) {
  try {
    const S = 48;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    // Central 64% width, 80% height — trims wall/ceiling/floor margins.
    if (inset) g.drawImage(sourceCanvas, sw * 0.18, sh * 0.1, sw * 0.64, sh * 0.8, 0, 0, S, S);
    else g.drawImage(sourceCanvas, 0, 0, sw, sh, 0, 0, S, S);
    const data = g.getImageData(0, 0, S, S).data;

    const buckets = new Map();
    let total = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        if (data[i + 3] < 200) continue;
        const r = data[i], gr = data[i + 1], b = data[i + 2];
        const [h, s, l] = rgbToHsl(r, gr, b);
        const name = classify(h, s, l);
        // Weight the very center ×2 — that's where the outfit lives.
        const dx = x / S - 0.5, dy = y / S - 0.5;
        const w = dx * dx + dy * dy < 0.09 ? 2 : 1;
        const bk = buckets.get(name) || { n: 0, r: 0, g: 0, b: 0 };
        bk.n += w; bk.r += r * w; bk.g += gr * w; bk.b += b * w;
        buckets.set(name, bk);
        total += w;
      }
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
  } catch {
    // Color analysis is a nice-to-have; never let it block saving a photo.
    return { colors: [], palette: [] };
  }
}
