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
import { el, $, sheet, toast, openOverlay, haptic, confetti } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { todayStr, relDay } from '../util/dates.js';

const STREAK_MILESTONES = new Set([7, 14, 30, 50, 100, 200, 365]);

/** Entry point. opts: { date? } to back-fill a specific day. */
export function openCapture(opts = {}) {
  const camera = $('#fileCamera');
  const library = $('#fileLibrary');
  const arm = (input) => {
    input.value = ''; // allow re-picking the same file
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (file) handleFile(file, opts);
    };
    input.click();
  };
  sheet({
    title: opts.date && opts.date !== todayStr()
      ? `Add an outfit for ${relDay(opts.date)}`
      : "Add today's outfit",
    actions: [
      { label: 'Take Photo', icon: 'camera', onPick: () => arm(camera) },
      { label: 'Choose from Library', icon: 'image', onPick: () => arm(library) },
    ],
  });
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
  let favorite = false;

  const img = el('img', { src: previewUrl, alt: 'Outfit preview' });

  const dateInput = el('input', {
    type: 'date',
    value: opts.date || todayStr(),
    max: todayStr(),
    'aria-label': 'Outfit date',
  });
  const noteInput = el('input', {
    type: 'text',
    placeholder: 'Add a note (optional)',
    'aria-label': 'Note',
    maxlength: '300',
  });

  const favBtn = el('button', { class: 'fav-toggle', 'aria-label': 'Mark as favorite' }, icon('heart'));
  favBtn.addEventListener('click', () => {
    favorite = !favorite;
    favBtn.classList.toggle('on', favorite);
    favBtn.replaceChildren(icon(favorite ? 'heartFill' : 'heart'));
  });

  const retakeBtn = el('button', { class: 'btn' }, icon('camera'), 'Retake');
  const saveBtn = el('button', { class: 'btn btn-hero' }, icon('check'), 'Save Outfit');

  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Discard' }, icon('x'));

  const root = el('div', { class: 'capture' },
    el('div', { class: 'cap-stage' }, img),
    el('div', { class: 'cap-panel' },
      el('div', { class: 'cap-row' },
        el('label', { class: 'field' }, icon('calendar'), dateInput),
        favBtn),
      el('label', { class: 'field' }, icon('sparkles'), noteInput),
      el('div', { class: 'cap-buttons' }, retakeBtn, saveBtn)));

  // Discard button floats over the photo via the top of the stage.
  root.querySelector('.cap-stage').append(
    el('div', { class: 'lb-top', style: { position: 'absolute', top: '0', left: '0', right: '0', zIndex: '3' } }, closeBtn));

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
      await store.addOutfit(processed, { date, notes: noteInput.value.trim(), favorite });
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
