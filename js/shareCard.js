/**
 * shareCard.js — compose an outfit photo into a shareable "memory card":
 * brand gradient background, white polaroid frame, cover-cropped photo,
 * date caption (+ favorite heart), tiny wordmark. Runs entirely on a
 * canvas — nothing leaves the device unless the user shares the result.
 */

import { store } from './store.js';
import { fmtLong } from './util/dates.js';
import { catLabel, formatPrice } from './wardrobe.js';

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

/**
 * Build a shareable card for a *combination* of wardrobe items — the
 * outfit builder's suggestion, or a saved plan. Each piece's crop is laid
 * out on the brand gradient with its name underneath.
 */
export async function buildOutfitCard(items, title = 'Outfit idea') {
  const list = items.filter(Boolean).slice(0, 6);
  if (!list.length) throw new Error('nothing to share');

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#7C5CFF');
  grad.addColorStop(1, '#FF7AA2');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = '700 68px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  g.fillText(title, W / 2, 150);

  const cols = list.length <= 2 ? 1 : 2;
  const rows = Math.ceil(list.length / cols);
  const pad = 70;
  const gap = 40;
  const tileW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const tileH = Math.min(430, (H - 330 - gap * (rows - 1)) / rows);
  const startY = 230;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const cx = pad + (i % cols) * (tileW + gap);
    const cy = startY + Math.floor(i / cols) * (tileH + gap);
    const imgH = tileH - 74;

    g.save();
    roundedRectPath(g, cx, cy, tileW, imgH, 28);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fill();
    g.clip();
    const blob = item.thumb ? await store.adapter.readFile(item.thumb) : null;
    if (blob) {
      const bmp = await createImageBitmap(blob);
      drawCover(g, bmp, bmp.width, bmp.height, cx, cy, tileW, imgH);
      bmp.close?.();
    }
    g.restore();

    // Name, then the details line (type · brand · price) beneath it.
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = '600 33px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    g.fillText(ellipsize(item.name, 24), cx + tileW / 2, cy + imgH + 44);

    const detail = [
      catLabel(item.category),
      item.brand,
      formatPrice(item.price, item.currency),
    ].filter(Boolean).join(' · ');
    if (detail) {
      g.globalAlpha = 0.82;
      g.font = '500 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      g.fillText(ellipsize(detail, 32), cx + tileW / 2, cy + imgH + 80);
      g.globalAlpha = 1;
    }
  }

  // Total, when enough pieces are priced to make it meaningful.
  const priced = list.filter((i) => Number.isFinite(i.price));
  if (priced.length >= 2) {
    const total = priced.reduce((s, i) => s + i.price, 0);
    g.globalAlpha = 0.92;
    g.font = '700 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    g.fillText(
      `${formatPrice(total, priced[0].currency)}${priced.length < list.length ? ' (priced items)' : ''}`,
      W / 2, H - 118);
    g.globalAlpha = 1;
  }

  g.globalAlpha = 0.85;
  g.font = '600 30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  g.fillText('OutfitMemory', W / 2, H - 60);
  g.globalAlpha = 1;

  return new Promise((res) => c.toBlob(res, 'image/png'));
}

const ellipsize = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Plain-text description of an outfit, for sharing or copying alongside
 * (or instead of) the image — the part a photo can't carry.
 */
export function outfitSummary(items, title = 'Outfit idea') {
  const lines = [title, ''];
  for (const i of items.filter(Boolean)) {
    const bits = [catLabel(i.category), i.brand, formatPrice(i.price, i.currency)].filter(Boolean);
    lines.push(`• ${i.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
    if (i.link) lines.push(`  ${i.link}`);
  }
  const priced = items.filter((i) => i && Number.isFinite(i.price));
  if (priced.length >= 2) {
    const total = priced.reduce((s, i) => s + i.price, 0);
    lines.push('', `Total: ${formatPrice(total, priced[0].currency)}` +
      (priced.length < items.length ? ' (priced items only)' : ''));
  }
  return lines.join('\n');
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
