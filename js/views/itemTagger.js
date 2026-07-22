/**
 * itemTagger.js — turn parts of an outfit photo into wardrobe items.
 *
 * Friction budget: drag a box around a garment and the app fills in the
 * rest — category guessed from where the box sits on the body, color read
 * from the pixels, name written from those two. Confirm and you're done;
 * brand/price/link are optional extras for people who want them.
 *
 * Also hosts the item form, reused by the wardrobe view for editing.
 */

import { store } from '../store.js';
import { cropToItem } from '../imagePipeline.js';
import { el, openOverlay, toast, sheet, haptic } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { CATEGORIES, catLabel, safeUrl } from '../wardrobe.js';

const MIN_BOX = 0.045; // ignore accidental micro-drags (fraction of image)

/* ================= tagger ================= */

/** Open the tagging surface for one outfit entry. */
export function openItemTagger(entryId) {
  const entry = store.entryById(entryId);
  if (!entry) return;

  const img = el('img', { alt: 'Outfit photo', draggable: 'false' });
  const marquee = el('div', { class: 'tag-marquee', hidden: true });
  const stage = el('div', { class: 'tag-stage' }, img, marquee);
  const chipRow = el('div', { class: 'tag-chips' });

  const hint = el('p', { class: 'tag-hint' },
    icon('sparkles'), 'Drag a box around one piece of clothing');

  const pickBtn = el('button', { class: 'btn btn-sm' }, icon('grid'), 'From wardrobe');
  const doneBtn = el('button', { class: 'btn btn-sm btn-primary' }, icon('check'), 'Done');
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));

  const root = el('div', { class: 'tagger' },
    el('div', { class: 'lb-top' },
      closeBtn,
      el('div', { class: 'lb-title' }, el('b', { text: 'Tag clothing' })),
      el('span', { class: 'icon-btn-spacer' })),
    stage,
    el('div', { class: 'tag-panel' }, hint, chipRow,
      el('div', { class: 'tag-actions' }, pickBtn, doneBtn)));

  const { close } = openOverlay(root, { variant: 'full' });
  closeBtn.addEventListener('click', close);
  doneBtn.addEventListener('click', close);
  pickBtn.addEventListener('click', () => pickExisting(entryId, renderChips));

  store.imageURL(entry).then((u) => { if (u) img.src = u; });

  /* ---------- linked-item chips ---------- */
  function renderChips() {
    const linked = store.itemsFor(store.entryById(entryId));
    chipRow.replaceChildren();
    if (!linked.length) {
      chipRow.append(el('span', { class: 'tag-empty', text: 'No items tagged yet.' }));
      return;
    }
    for (const item of linked) {
      const thumb = el('img', { alt: '' });
      store.itemThumbURL(item).then((u) => { if (u) thumb.src = u; });
      const rm = el('button', { class: 'tag-chip-x', 'aria-label': `Remove ${item.name}` }, icon('x'));
      rm.addEventListener('click', async () => {
        await store.toggleItemLink(entryId, item.id);
        renderChips();
      });
      chipRow.append(el('span', { class: 'tag-chip' }, thumb, el('b', { text: item.name }), rm));
    }
  }
  renderChips();

  /* ---------- drag to select ---------- */
  let start = null;

  const imgBox = () => img.getBoundingClientRect();

  const clampToImage = (cx, cy) => {
    const r = imgBox();
    return {
      x: Math.min(Math.max(cx, r.left), r.right),
      y: Math.min(Math.max(cy, r.top), r.bottom),
    };
  };

  const drawMarquee = (a, b) => {
    const r = imgBox();
    marquee.hidden = false;
    marquee.style.left = `${Math.min(a.x, b.x) - r.left + img.offsetLeft}px`;
    marquee.style.top = `${Math.min(a.y, b.y) - r.top + img.offsetTop}px`;
    marquee.style.width = `${Math.abs(a.x - b.x)}px`;
    marquee.style.height = `${Math.abs(a.y - b.y)}px`;
  };

  stage.addEventListener('pointerdown', (ev) => {
    if (!img.naturalWidth) return;
    const r = imgBox();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    ev.preventDefault();
    // Capture keeps the drag alive if the finger leaves the stage; it's an
    // optimization, not a requirement, so a rejection must not break the drag.
    try { stage.setPointerCapture(ev.pointerId); } catch { /* keep going */ }
    start = clampToImage(ev.clientX, ev.clientY);
    drawMarquee(start, start);
  });

  stage.addEventListener('pointermove', (ev) => {
    if (!start) return;
    drawMarquee(start, clampToImage(ev.clientX, ev.clientY));
  });

  const finish = async (ev) => {
    if (!start) return;
    const end = clampToImage(ev.clientX, ev.clientY);
    const from = start;
    start = null;
    marquee.hidden = true;

    const r = imgBox();
    let x0 = (Math.min(from.x, end.x) - r.left) / r.width;
    let y0 = (Math.min(from.y, end.y) - r.top) / r.height;
    let w = Math.abs(from.x - end.x) / r.width;
    let h = Math.abs(from.y - end.y) / r.height;

    // A tap (rather than a drag) means "grab a sensible box around here".
    if (w < MIN_BOX || h < MIN_BOX) {
      const cx = (from.x - r.left) / r.width;
      const cy = (from.y - r.top) / r.height;
      w = 0.42; h = 0.24;
      x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w);
      y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
    }
    haptic();
    await createFromCrop(entryId, img, { x0, y0, w, h }, renderChips);
  };

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', () => { start = null; marquee.hidden = true; });
}

/**
 * Guess the garment slot from where the box sits vertically on the body.
 * Zones follow a typical full-length mirror shot: head to ~0.3, torso to
 * ~0.6, legs to ~0.85, feet below that. It's only a default — the form
 * puts the category picker right there.
 */
function guessCategory({ y0, h }) {
  const mid = y0 + h / 2;
  if (h > 0.55) return 'dress';        // a tall box covers a whole one-piece
  if (mid < 0.56) return 'top';
  if (mid < 0.85) return 'bottom';
  return 'shoes';
}

async function createFromCrop(entryId, img, frac, onDone) {
  const rect = {
    x: Math.round(frac.x0 * img.naturalWidth),
    y: Math.round(frac.y0 * img.naturalHeight),
    w: Math.round(frac.w * img.naturalWidth),
    h: Math.round(frac.h * img.naturalHeight),
  };
  let crop;
  try {
    crop = await cropToItem(img, rect);
  } catch {
    return toast('Could not read that part of the photo');
  }

  const color = crop.colors?.[0] || '';
  const category = guessCategory(frac);
  const suggested = color
    ? `${color[0].toUpperCase()}${color.slice(1)} ${catLabel(category).toLowerCase()}`
    : catLabel(category);

  const fields = await itemForm({
    title: 'New item',
    crop,
    initial: {
      name: suggested,
      category,
      color,
      hex: crop.palette?.[0]?.hex || NAME_HEX[color] || '',
    },
  });
  if (!fields) return;

  await store.addItem({ ...fields, color: fields.color, hex: fields.hex }, crop, entryId);
  toast(`“${fields.name}” added to your wardrobe ✓`);
  onDone?.();
}

/** Link an item that already exists in the wardrobe. */
async function pickExisting(entryId, onDone) {
  const all = store.items();
  if (!all.length) return toast('Tag something from a photo first ✨');
  const entry = store.entryById(entryId);
  const linked = new Set(entry?.items || []);

  await sheet({
    title: 'Add from wardrobe',
    actions: all.slice(0, 40).map((item) => ({
      label: `${linked.has(item.id) ? '✓ ' : ''}${item.name}`,
      sub: catLabel(item.category),
      icon: 'grid',
      onPick: async () => {
        const on = await store.toggleItemLink(entryId, item.id);
        toast(on ? `Tagged “${item.name}”` : `Removed “${item.name}”`);
        onDone?.();
      },
    })),
  });
}

/* ================= item form (create + edit) ================= */

/**
 * itemForm({ title, crop, initial }) → fields | null
 * Shared by the tagger and the wardrobe editor.
 */
export function itemForm({ title = 'Item', crop = null, initial = {}, thumbURL = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const name = el('input', { type: 'text', value: initial.name || '', maxlength: '80',
      placeholder: 'Name', 'aria-label': 'Item name' });

    const category = el('select', { 'aria-label': 'Category' },
      CATEGORIES.map((c) => el('option', {
        value: c.id, text: `${c.emoji}  ${c.label}`,
        selected: (initial.category || 'top') === c.id || null,
      })));

    const brand = el('input', { type: 'text', value: initial.brand || '', maxlength: '60',
      placeholder: 'Brand (optional)', 'aria-label': 'Brand' });

    const price = el('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      value: Number.isFinite(initial.price) ? String(initial.price) : '',
      placeholder: 'Price', 'aria-label': 'Price',
    });

    const link = el('input', { type: 'url', value: initial.link || '',
      placeholder: 'Where to buy / product link (optional)', 'aria-label': 'Link' });

    // Preview of the crop this item was cut from.
    const preview = el('img', { class: 'item-form-thumb', alt: '' });
    if (crop?.blob) {
      const u = URL.createObjectURL(crop.blob);
      preview.src = u;
      preview.addEventListener('load', () => URL.revokeObjectURL(u), { once: true });
    } else if (thumbURL) {
      preview.src = thumbURL;
    }

    const swatch = initial.hex || NAME_HEX[initial.color] || null;

    const saveBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('check'), 'Save item');
    const cancelBtn = el('button', { class: 'sheet-cancel', text: 'Cancel' });

    const card = el('div', { class: 'sheet-card item-form', role: 'dialog', 'aria-label': title },
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'item-form-head' },
        (crop?.blob || thumbURL) ? preview : null,
        el('div', { class: 'grow' },
          el('div', { class: 'sheet-title', text: title }),
          swatch ? el('div', { class: 'item-form-color' },
            el('i', { class: 'mini-dot', style: { background: swatch } }),
            el('span', { text: initial.color || 'color detected' })) : null)),
      el('label', { class: 'field' }, icon('sparkles'), name),
      el('label', { class: 'field' }, icon('grid'), category),
      el('div', { class: 'cap-row' },
        el('label', { class: 'field' }, icon('palette'), brand),
        el('label', { class: 'field field-price' }, el('span', { class: 'cur', text: currencySymbol() }), price)),
      el('label', { class: 'field' }, icon('link'), link),
      saveBtn, cancelBtn);

    const { close } = openOverlay(card, { onClose: () => done(null) });
    cancelBtn.addEventListener('click', () => close());

    saveBtn.addEventListener('click', () => {
      const raw = link.value.trim();
      if (raw && !safeUrl(raw)) return toast('That link doesn’t look like a web address');
      const parsed = parseFloat(price.value);
      done({
        name: name.value.trim() || initial.name || 'Item',
        category: category.value,
        color: initial.color || '',
        hex: initial.hex || '',
        brand: brand.value.trim(),
        price: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
        link: raw ? safeUrl(raw) : '',
        currency: store.settings.currency || 'USD',
      });
      close();
    });

    setTimeout(() => name.focus(), 60);
  });
}

function currencySymbol() {
  const cur = store.settings.currency || 'USD';
  try {
    return (0).toLocaleString(undefined, { style: 'currency', currency: cur })
      .replace(/[\d.,\s]/g, '') || cur;
  } catch {
    return cur;
  }
}
