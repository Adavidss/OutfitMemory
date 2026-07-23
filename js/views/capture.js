/**
 * capture.js — the "Add Today's Outfit" flow.
 *
 * Native file inputs do the heavy lifting: on phones, the capture input
 * opens the system camera directly (best quality + zero custom camera UI),
 * the other opens the photo library. After processing, a full-screen
 * preview offers Save / Retake. Nothing is required except the photo.
 */

import { store } from '../store.js';
import { processPhoto } from '../imagePipeline.js';
import { el, $, sheet, toast, progressToast, confirmDialog, openOverlay, haptic, confetti } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { todayStr, relDay, pad2 } from '../util/dates.js';

const STREAK_MILESTONES = new Set([7, 14, 30, 50, 100, 200, 365]);

/**
 * Entry point.
 * opts.date  — back-fill a specific day
 * opts.items — wardrobe item ids to attach on save (from the outfit builder)
 */
export function openCapture(opts = {}) {
  const camera = $('#fileCamera');
  const library = $('#fileLibrary');
  const arm = (input) => {
    input.value = ''; // allow re-picking the same file
    input.onchange = () => {
      const files = [...(input.files || [])];
      if (files.length > 1) bulkImport(files);
      else if (files[0]) handleFile(files[0], opts);
    };
    input.click();
  };
  sheet({
    title: opts.date && opts.date !== todayStr()
      ? `Add an outfit for ${relDay(opts.date)}`
      : "Add today's outfit",
    actions: [
      { label: 'Take Photo', icon: 'camera', onPick: () => arm(camera) },
      {
        label: 'Choose from Library', icon: 'image',
        sub: 'Pick several to back-fill past days at once',
        onPick: () => arm(library),
      },
    ],
  });
}

/** Local "YYYY-MM-DD" from a file's modified time (≈ capture time for
 *  camera-roll exports). Falls back to today for bogus timestamps. */
function dateFromFile(file) {
  const t = file.lastModified;
  if (!t || t < Date.parse('2000-01-01')) return todayStr();
  const d = new Date(t);
  const s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return s > todayStr() ? todayStr() : s;
}

/** Multi-select back-fill: one entry per photo, dated by file timestamp. */
async function bulkImport(files) {
  const ok = await confirmDialog({
    title: `Add ${files.length} outfits?`,
    body: 'Each photo becomes its own entry, dated from the photo file\'s date. You can adjust dates or delete any of them afterwards.',
    okLabel: `Add ${files.length}`,
  });
  if (!ok) return;
  const pt = progressToast(`Importing 1/${files.length}…`);
  let added = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    pt.update(`Importing ${i + 1}/${files.length}…`);
    try {
      const processed = await processPhoto(files[i]);
      await store.addOutfit(processed, { date: dateFromFile(files[i]) });
      added++;
    } catch {
      failed++; // unreadable file — keep going
    }
  }
  pt.done(`Added ${added} outfit${added === 1 ? '' : 's'}${failed ? ` · ${failed} skipped` : ''} ✓`);
  if (added >= 5) confetti();
  haptic();
}

async function handleFile(file, opts) {
  const busy = el('div', { class: 'processing' },
    el('div', { class: 'processing-card' },
      el('div', { class: 'spinner' }),
      el('span', { text: 'Optimizing photo…' })));
  document.body.append(busy);
  let processed;
  try {
    processed = await processPhoto(file);
  } catch {
    busy.remove();
    toast('Could not read that image — try a JPEG or PNG.');
    return;
  }
  busy.remove();
  openPreview(processed, opts);
}

function openPreview(processed, opts) {
  const previewUrl = URL.createObjectURL(processed.blob);
  // opts.favorite / opts.notes pre-fill the form (e.g. "Wear this again").
  let favorite = !!opts.favorite;

  const img = el('img', { src: previewUrl, alt: 'Outfit preview' });

  const dateInput = el('input', {
    type: 'date',
    value: opts.date || todayStr(),
    max: todayStr(),
    'aria-label': 'Outfit date',
  });
  const noteInput = el('input', {
    type: 'text',
    value: opts.notes || '',
    placeholder: 'Add a note (optional)',
    'aria-label': 'Note',
    maxlength: '300',
  });

  const favBtn = el('button', { class: `fav-toggle${favorite ? ' on' : ''}`, 'aria-label': 'Mark as favorite' },
    icon(favorite ? 'heartFill' : 'heart'));
  favBtn.addEventListener('click', () => {
    favorite = !favorite;
    favBtn.classList.toggle('on', favorite);
    favBtn.replaceChildren(icon(favorite ? 'heartFill' : 'heart'));
  });

  const retakeBtn = el('button', { class: 'btn' }, icon('camera'), 'Retake');
  const saveBtn = el('button', { class: 'btn btn-hero' }, icon('check'), 'Save Outfit');

  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Discard' }, icon('x'));

  // Came from the outfit builder — show what will be tagged on save.
  const preTagged = (opts.items || [])
    .map((id) => store.itemById(id)).filter(Boolean);
  const tagNote = preTagged.length
    ? el('div', { class: 'cap-tagged' }, icon('hanger'),
        el('span', { text: preTagged.map((i) => i.name).join(' · ') }))
    : null;

  const root = el('div', { class: 'capture' },
    el('div', { class: 'cap-stage' }, img),
    el('div', { class: 'cap-panel' },
      tagNote,
      el('div', { class: 'cap-row' },
        el('label', { class: 'field' }, icon('calendar'), dateInput),
        favBtn),
      el('label', { class: 'field' }, icon('sparkles'), noteInput),
      el('div', { class: 'cap-buttons' }, retakeBtn, saveBtn)));

  // Discard button floats over the photo at the top of the stage.
  root.querySelector('.cap-stage').append(el('div', { class: 'lb-top cap-top' }, closeBtn));

  const { close } = openOverlay(root, {
    variant: 'full',
    onClose: () => URL.revokeObjectURL(previewUrl),
  });

  closeBtn.addEventListener('click', close);
  retakeBtn.addEventListener('click', () => {
    close();
    openCapture(opts);
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const date = dateInput.value || todayStr();
      await store.addOutfit(processed, {
        date, notes: noteInput.value.trim(), favorite, items: opts.items || [],
      });
      close();
      haptic();
      celebrate();
      if (!location.hash || location.hash === '#/gallery') window.scrollTo({ top: 0 });
      else location.hash = '#/gallery';
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.replaceChildren(icon('check'), 'Save Outfit');
      toast(`Could not save: ${err?.message || 'storage error'}`);
    }
  });
}

function celebrate() {
  const total = store.meta.entries.length;
  const { current } = store.streaks();
  if (total === 1) {
    toast('First outfit saved — welcome to your style memory 🎉');
    confetti();
  } else if (current >= 2) {
    toast(`Saved · 🔥 ${current}-day streak`);
    if (STREAK_MILESTONES.has(current)) confetti();
  } else {
    toast('Outfit saved ✓');
  }
}
