/**
 * shareCard.js — compose an outfit photo into a shareable "memory card":
 * brand gradient background, white polaroid frame, cover-cropped photo,
 * date caption (+ favorite heart), tiny wordmark. Runs entirely on a
 * canvas — nothing leaves the device unless the user shares the result.
 */

import { store } from './store.js';
import { fmtLong } from './util/dates.js';

const W = 1080;
const H = 1620;

function roundedRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draw src covering the given rect (center crop). */
function drawCover(g, src, sw, sh, x, y, w, h) {
  const scale = Math.max(w / sw, h / sh);
  const cw = w / scale;
  const ch = h / scale;
  g.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

/** Build the card as a PNG blob for the given entry. */
export async function buildMemoryCard(entry) {
  const blob = await store.imageBlob(entry);
  if (!blob) throw new Error('photo missing');
  const bmp = await createImageBitmap(blob);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // Brand gradient backdrop + soft glow
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#7c5cff');
  grad.addColorStop(1, '#ff7aa2');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.3, H * 0.2, 80, W * 0.3, H * 0.2, W);
  glow.addColorStop(0, 'rgba(255,255,255,0.16)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // White polaroid frame (slight tilt for charm)
  const frameW = 860;
  const photoW = frameW - 64;
  const photoH = Math.round(photoW * 4 / 3);
  const frameH = photoH + 64 + 150; // padding + caption band
  const fx = (W - frameW) / 2;
  const fy = (H - frameH) / 2 - 30;

  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-1.6 * Math.PI / 180);
  g.translate(-W / 2, -H / 2);

  g.shadowColor = 'rgba(30, 10, 60, 0.45)';
  g.shadowBlur = 60;
  g.shadowOffsetY = 26;
  g.fillStyle = '#fffdf8';
  roundedRectPath(g, fx, fy, frameW, frameH, 14);
  g.fill();
  g.shadowColor = 'transparent';

  drawCover(g, bmp, bmp.width, bmp.height, fx + 32, fy + 32, photoW, photoH);
  bmp.close?.();

  // Caption: date (+ heart when favorited)
  g.fillStyle = '#4a4238';
  g.font = '600 52px "Bradley Hand", "Marker Felt", "Segoe Print", cursive';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const caption = fmtLong(entry.date) + (entry.favorite ? '  ♥' : '');
  g.fillText(caption, fx + frameW / 2, fy + frameH - 78);
  g.restore();

  // Wordmark
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = '700 34px -apple-system, "Segoe UI", Roboto, sans-serif';
  g.textAlign = 'center';
  g.fillText('OutfitMemory', W / 2, H - 74);

  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
}
