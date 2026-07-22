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
import { smartSegment } from '../segment.js';
import { warmParser } from '../models/personParser.js';
import { el, openOverlay, toast, sheet, haptic } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { CATEGORIES, catLabel, safeUrl } from '../wardrobe.js';

/**
 * Starter tags offered as one-tap chips, alongside whatever the user has
 * already used elsewhere in their wardrobe.
 */
const QUICK_TAGS = [
  'work', 'casual', 'going out', 'formal', 'gym', 'comfy',
  'summer', 'winter', 'rain', 'travel', 'layering',
];

const MIN_BOX = 0.045; // ignore accidental micro-drags (fraction of image)

/**
 * The painted area of an object-fit:contain image. The <img> element now
 * fills its stage and letterboxes inside it, so the element's own rect is
 * NOT the picture — every crop coordinate has to come from this.
 */
function paintedRect(img) {
  const r = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return { left: r.left, top: r.top, width: r.width, height: r.height };
  const scale = Math.min(r.width / nw, r.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return {
    left: r.left + (r.width - width) / 2,
    top: r.top + (r.height - height) / 2,
    width,
    height,
  };
}

/* ================= tagger ================= */

/** Open the tagging surface for one outfit entry. */
export function openItemTagger(entryId) {
  const entry = store.entryById(entryId);
  if (!entry) return;
  warmParser(); // start the person-parser download while the photo decodes

  const img = el('img', { alt: 'Outfit photo', draggable: 'false' });
  const marquee = el('div', { class: 'tag-marquee', hidden: true });
  // Overlay that highlights the garment smart-select actually found.
  const highlight = el('canvas', { class: 'tag-highlight' });
  const stage = el('div', { class: 'tag-stage' }, img, highlight, marquee);
  const chipRow = el('div', { class: 'tag-chips' });

  const hint = el('p', { class: 'tag-hint' },
    icon('sparkles'), 'Drag roughly over a piece — it snaps to the garment');

  const pickBtn = el('button', { class: 'btn btn-sm' }, icon('grid'), 'From wardrobe');
  const doneBtn = el('button', { class: 'btn btn-sm btn-primary' }, icon('check'), 'Done');
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));

  // The hint + chips scroll; the action buttons sit outside that scroller so
  // a wardrobe with many tagged pieces can never push them off-screen.
  const root = el('div', { class: 'tagger' },
    el('div', { class: 'lb-top' },
      closeBtn,
      el('div', { class: 'lb-title' }, el('b', { text: 'Tag clothing' })),
      el('span', { class: 'icon-btn-spacer' })),
    stage,
    el('div', { class: 'tag-panel' },
      el('div', { class: 'tag-scroll' }, hint, chipRow),
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

  const imgBox = () => paintedRect(img);

  const clampToImage = (cx, cy) => {
    const r = imgBox();
    return {
      x: Math.min(Math.max(cx, r.left), r.left + r.width),
      y: Math.min(Math.max(cy, r.top), r.top + r.height),
    };
  };

  const drawMarquee = (a, b) => {
    const sr = stage.getBoundingClientRect();
    marquee.hidden = false;
    marquee.style.left = `${Math.min(a.x, b.x) - sr.left}px`;
    marquee.style.top = `${Math.min(a.y, b.y) - sr.top}px`;
    marquee.style.width = `${Math.abs(a.x - b.x)}px`;
    marquee.style.height = `${Math.abs(a.y - b.y)}px`;
  };

  /** Paint the detected garment mask over the photo, then fade it out. */
  function showHighlight(seg) {
    if (!seg?.mask) return;
    const sr = stage.getBoundingClientRect();
    highlight.width = Math.round(sr.width);
    highlight.height = Math.round(sr.height);
    const g = highlight.getContext('2d');
    g.clearRect(0, 0, highlight.width, highlight.height);

    // Mask lives in work-space; scale it onto the painted picture.
    const pr = imgBox();
    const cell = document.createElement('canvas');
    cell.width = seg.maskW; cell.height = seg.maskH;
    const cg = cell.getContext('2d');
    const px = cg.createImageData(seg.maskW, seg.maskH);
    for (let p = 0; p < seg.mask.length; p++) {
      if (!seg.mask[p]) continue;
      const i = p * 4;
      px.data[i] = 124; px.data[i + 1] = 92; px.data[i + 2] = 255; px.data[i + 3] = 150;
    }
    cg.putImageData(px, 0, 0);

    g.imageSmoothingEnabled = true;
    g.drawImage(cell, pr.left - sr.left, pr.top - sr.top, pr.width, pr.height);
    highlight.classList.add('on');
    setTimeout(() => highlight.classList.remove('on'), 1100);
  }

  stage.addEventListener('pointerdown', (ev) => {
    if (!img.naturalWidth) return;
    const r = imgBox();
    if (ev.clientX < r.left || ev.clientX > r.left + r.width ||
        ev.clientY < r.top || ev.clientY > r.top + r.height) return;
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

    // A tap (rather than a drag) means "grab a sensible box around here" —
    // smart select then grows it out to the garment's real edges.
    if (w < MIN_BOX || h < MIN_BOX) {
      const cx = (from.x - r.left) / r.width;
      const cy = (from.y - r.top) / r.height;
      w = 0.30; h = 0.16;
      x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w);
      y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
    }
    haptic();
    await createFromCrop(entryId, img, { x0, y0, w, h }, renderChips, showHighlight);
  };

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', () => { start = null; marquee.hidden = true; });
}

async function createFromCrop(entryId, img, frac, onDone, onHighlight) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const drawn = {
    x: Math.round(frac.x0 * nw),
    y: Math.round(frac.y0 * nh),
    w: Math.round(frac.w * nw),
    h: Math.round(frac.h * nh),
  };

  // Smart select: person-parser mask first (skin/hair excluded by pixel
  // classification), color heuristics only as its fallback.
  let seg = null;
  try {
    seg = await smartSegment(img, nw, nh, drawn);
    onHighlight?.(seg);
  } catch {
    /* fall through to the drawn rectangle */
  }
  const rect = seg?.ok ? seg.bbox : drawn;

  let crop;
  try {
    crop = await cropToItem(img, rect, seg);
  } catch {
    return toast('Could not read that part of the photo');
  }

  // Name and category are left for the user. Auto-guessing both was worse
  // than useless: a confident wrong label is harder to notice and correct
  // than an empty field. Detected colour is still offered, since it comes
  // from the actual garment pixels rather than a guess.
  const color = crop.colors?.[0] || '';

  const fields = await itemForm({
    title: 'New item',
    crop,
    initial: {
      name: '',
      category: '',
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

/* ================= add an item without an outfit photo ================= */

/**
 * openAddItem({ wish }) — create a wardrobe or wishlist item from a picture
 * that isn't one of your outfit photos: a product shot from a shop, a
 * screenshot, anything.
 *
 * Paste / upload / drop rather than "fetch this URL", deliberately:
 *   • fetching arbitrary URLs would need the app to reach any host on the
 *     web, which is exactly the capability this app is built not to have;
 *   • and it wouldn't even work — shop CDNs rarely send CORS headers, so
 *     the canvas would be tainted and the image un-encodable.
 * Copying an image (long-press → Copy on mobile, right-click → Copy on
 * desktop) and pasting it here keeps everything local and always works.
 */
export function openAddItem({ wish = false } = {}) {
  const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const drop = el('div', { class: 'drop-zone', tabindex: '0', role: 'button',
    'aria-label': 'Paste, drop or choose an image' },
    icon('image'),
    el('b', { text: 'Paste an image' }),
    el('span', { text: 'Copy a photo from a shop, then paste here (⌘/Ctrl+V). You can also drop a file or tap to browse.' }));

  const uploadBtn = el('button', { class: 'btn btn-block' }, icon('upload'), 'Choose image');
  const skipBtn = el('button', { class: 'link-btn', text: wish ? 'Add without a picture' : 'Add without a picture' });
  const cancelBtn = el('button', { class: 'sheet-cancel', text: 'Cancel' });

  const card = el('div', { class: 'sheet-card', role: 'dialog' },
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-title', text: wish ? 'Add a wanted item' : 'Add an item' }),
    drop, uploadBtn, skipBtn, cancelBtn, fileInput);

  const { close } = openOverlay(card, {
    onClose: () => document.removeEventListener('paste', onPaste),
  });
  cancelBtn.addEventListener('click', () => close());

  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const f = item.getAsFile();
    if (f) handle(f);
  };

  const handle = async (blob) => {
    close();
    await buildFromImage(blob, wish);
  };

  uploadBtn.addEventListener('click', () => fileInput.click());
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handle(f);
  });

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) handle(f);
    else toast('That wasn’t an image');
  });

  document.addEventListener('paste', onPaste);

  skipBtn.addEventListener('click', async () => {
    close();
    const fields = await itemForm({ title: wish ? 'Wanted item' : 'New item', wish });
    if (!fields) return;
    await store.addItem(fields, null);
    toast(wish ? 'Added to your wishlist ✓' : 'Added to your wardrobe ✓');
  });
}

/** Shared tail: encode the picked image, then collect details. */
async function buildFromImage(blob, wish) {
  let crop;
  try {
    const bmp = await createImageBitmap(blob);
    crop = await cropToItem(bmp, { x: 0, y: 0, w: bmp.width, h: bmp.height });
    bmp.close?.();
  } catch {
    return toast('Could not read that image');
  }
  const color = crop.colors?.[0] || '';
  const fields = await itemForm({
    title: wish ? 'Wanted item' : 'New item',
    crop,
    wish,
    initial: { name: '', category: '', color, hex: crop.palette?.[0]?.hex || NAME_HEX[color] || '' },
  });
  if (!fields) return;
  await store.addItem(fields, crop);
  toast(wish ? 'Added to your wishlist ✓' : 'Added to your wardrobe ✓');
}

/* ================= item form (create + edit) ================= */

/**
 * itemForm({ title, crop, initial, wish }) → fields | null
 * Shared by the tagger, the "add item" flow and the wardrobe editor.
 *
 * Nothing about the garment is guessed. Category is a row of tap targets
 * (faster than a dropdown on a phone, and it starts unset so an unnoticed
 * default can't be saved), tags are one-tap chips, and notes are inline.
 */
export function itemForm({ title = 'Item', crop = null, initial = {}, thumbURL = null, wish = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const name = el('input', { type: 'text', value: initial.name || '', maxlength: '80',
      placeholder: wish ? 'What do you want? e.g. black leather boots' : 'Name this item',
      'aria-label': 'Item name' });

    /* ---- category: quick-tap chips, no default ---- */
    let category = initial.category || '';
    const catRow = el('div', { class: 'pick-row', role: 'group', 'aria-label': 'Category' },
      CATEGORIES.map((c) => {
        const b = el('button', {
          class: `pick${category === c.id ? ' on' : ''}`,
          'aria-pressed': category === c.id ? 'true' : 'false',
        }, `${c.emoji} ${c.label}`);
        b.addEventListener('click', () => {
          category = c.id;
          catRow.querySelectorAll('.pick').forEach((x) => {
            x.classList.remove('on');
            x.setAttribute('aria-pressed', 'false');
          });
          b.classList.add('on');
          b.setAttribute('aria-pressed', 'true');
        });
        return b;
      }));

    /* ---- tags: quick chips + free text ---- */
    const chosen = new Set(initial.tags || []);
    const tagInput = el('input', { type: 'text', placeholder: 'Add your own tag…',
      'aria-label': 'Custom tag' });
    const suggestions = [...new Set([...store.itemTags(), ...QUICK_TAGS])].slice(0, 16);
    const tagRow = el('div', { class: 'pick-row', role: 'group', 'aria-label': 'Tags' });

    const paintTags = () => {
      const all = [...new Set([...chosen, ...suggestions])];
      tagRow.replaceChildren(...all.map((t) => {
        const on = chosen.has(t);
        const b = el('button', { class: `pick${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false' }, t);
        b.addEventListener('click', () => {
          chosen.has(t) ? chosen.delete(t) : chosen.add(t);
          paintTags();
        });
        return b;
      }));
    };
    paintTags();

    tagInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const t = tagInput.value.trim().toLowerCase();
      if (t) { chosen.add(t); tagInput.value = ''; paintTags(); }
    });

    const notes = el('textarea', { class: 'lb-notes', rows: '2',
      placeholder: 'Notes (fit, where it came from, what it goes with…)',
      'aria-label': 'Notes' });
    notes.value = initial.notes || '';

    const brand = el('input', { type: 'text', value: initial.brand || '', maxlength: '60',
      placeholder: 'Brand (optional)', 'aria-label': 'Brand' });

    const price = el('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
      value: Number.isFinite(initial.price) ? String(initial.price) : '',
      placeholder: 'Price', 'aria-label': 'Price',
    });

    const link = el('input', { type: 'url', value: initial.link || '',
      placeholder: wish ? 'Product link' : 'Where to buy / product link (optional)',
      'aria-label': 'Link' });

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

    const saveBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('check'),
      wish ? 'Add to wishlist' : 'Save item');
    const cancelBtn = el('button', { class: 'sheet-cancel', text: 'Cancel' });

    // Header and buttons stay put; only the fields scroll. On a short phone
    // — or with the keyboard open — the whole card used to run off-screen
    // and Save became unreachable.
    const card = el('div', { class: 'sheet-card item-form', role: 'dialog', 'aria-label': title },
      el('div', { class: 'sheet-grip' }),
      el('div', { class: 'item-form-head' },
        (crop?.blob || thumbURL) ? preview : null,
        el('div', { class: 'grow' },
          el('div', { class: 'sheet-title', text: title }),
          swatch ? el('div', { class: 'item-form-color' },
            el('i', { class: 'mini-dot', style: { background: swatch } }),
            el('span', { text: initial.color || 'color detected' })) : null)),
      el('div', { class: 'item-form-body' },
        el('label', { class: 'field' }, icon('sparkles'), name),
        el('div', { class: 'form-label', text: 'Category' }),
        catRow,
        el('div', { class: 'form-label', text: 'Tags' }),
        tagRow,
        el('label', { class: 'field' }, icon('tag'), tagInput),
        el('div', { class: 'form-label', text: 'Notes' }),
        notes,
        el('div', { class: 'cap-row' },
          el('label', { class: 'field' }, icon('palette'), brand),
          el('label', { class: 'field field-price' }, el('span', { class: 'cur', text: currencySymbol() }), price)),
        el('label', { class: 'field' }, icon('link'), link)),
      el('div', { class: 'item-form-foot' }, saveBtn, cancelBtn));

    const { close } = openOverlay(card, { onClose: () => done(null) });
    cancelBtn.addEventListener('click', () => close());

    saveBtn.addEventListener('click', () => {
      if (!name.value.trim()) { name.focus(); return toast('Give it a name first'); }
      if (!category) return toast('Pick a category');
      const raw = link.value.trim();
      if (raw && !safeUrl(raw)) return toast('That link doesn’t look like a web address');
      const parsed = parseFloat(price.value);
      done({
        name: name.value.trim(),
        category,
        color: initial.color || '',
        hex: initial.hex || '',
        brand: brand.value.trim(),
        price: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
        link: raw ? safeUrl(raw) : '',
        notes: notes.value.trim(),
        tags: [...chosen],
        wish,
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
