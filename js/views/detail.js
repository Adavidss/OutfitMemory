/**
 * detail.js — full-screen outfit view: photo, date, favorite, notes,
 * tags, colors, share/download/delete, and prev/next navigation
 * (buttons, arrow keys, swipe).
 */

import { store } from '../store.js';
import { el, toast, actionToast, confirmDialog, sheet, openOverlay } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtLong, relDay } from '../util/dates.js';
import { buildMemoryCard } from '../shareCard.js';

export function openDetail(id, contextIds) {
  const ids = contextIds?.length ? [...contextIds] : store.entries().map((e) => e.id);
  let idx = Math.max(0, ids.indexOf(id));
  let currentUrl = null;

  const root = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Outfit details' });
  const { close } = openOverlay(root, { variant: 'full', onClose: () => detachKeys() });

  function render() {
    const entry = store.entryById(ids[idx]);
    if (!entry) return close();

    const img = el('img', { alt: `Outfit from ${fmtLong(entry.date)}` });
    store.imageURL(entry).then((u) => { currentUrl = u; if (u) img.src = u; });

    const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
    closeBtn.addEventListener('click', close);

    const favBtn = el('button', { class: `icon-btn${entry.favorite ? ' on' : ''}`, 'aria-label': 'Favorite' },
      icon(entry.favorite ? 'heartFill' : 'heart'));
    favBtn.addEventListener('click', async () => {
      const on = await store.toggleFavorite(entry.id);
      favBtn.classList.toggle('on', on);
      favBtn.replaceChildren(icon(on ? 'heartFill' : 'heart'));
    });

    const stage = el('div', { class: 'lb-stage' }, img);
    if (ids.length > 1) {
      const prev = el('button', { class: 'lb-nav prev', 'aria-label': 'Previous outfit' }, icon('chevL'));
      const next = el('button', { class: 'lb-nav next', 'aria-label': 'Next outfit' }, icon('chevR'));
      prev.addEventListener('click', () => nav(1));  // older (list is newest-first)
      next.addEventListener('click', () => nav(-1)); // newer
      stage.append(prev, next);
    }

    // Swipe navigation
    let touchX = null;
    stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 48) nav(dx > 0 ? -1 : 1);
    }, { passive: true });

    const notes = el('textarea', {
      class: 'lb-notes', rows: '2', placeholder: 'Add a note about this look…',
      'aria-label': 'Notes',
    });
    notes.value = entry.notes || '';
    notes.addEventListener('change', () => store.updateOutfit(entry.id, { notes: notes.value.trim() }));

    const tags = el('input', {
      class: 'lb-tags', type: 'text', placeholder: 'Tags, comma separated (work, date night…)',
      'aria-label': 'Tags', list: 'omTagList',
    });
    tags.value = (entry.tags || []).join(', ');
    tags.addEventListener('change', () =>
      store.updateOutfit(entry.id, {
        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      }));
    // Autocomplete from tags used elsewhere in the archive.
    const tagList = el('datalist', { id: 'omTagList' },
      store.allTags().slice(0, 20).map((t) => el('option', { value: t })));

    const meta = el('div', { class: 'lb-meta' },
      (entry.palette || []).map((p) =>
        el('i', { class: 'mini-dot', title: p.name, style: { background: p.hex } })),
      el('span', { text: (entry.colors || []).join(' · ') }),
      entry.bytes ? el('span', { text: `· ${(entry.bytes / 1024).toFixed(0)} KB` }) : null);

    const shareBtn = el('button', { class: 'icon-btn', 'aria-label': 'Share' }, icon('share'));
    shareBtn.addEventListener('click', () =>
      sheet({
        title: 'Share',
        actions: [
          { label: 'Share photo', icon: 'image', onPick: () => shareEntry(entry) },
          {
            label: 'Share as memory card', icon: 'sparkles',
            sub: 'Polaroid-framed card with the date',
            onPick: () => shareCard(entry),
          },
        ],
      }));

    const dlBtn = el('button', { class: 'icon-btn', 'aria-label': 'Download photo' }, icon('download'));
    dlBtn.addEventListener('click', () => downloadEntry(entry));

    const delBtn = el('button', { class: 'icon-btn', 'aria-label': 'Delete outfit' }, icon('trash'));
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete this outfit?',
        body: 'The photo and thumbnail files will be removed from your archive.',
        okLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      // Hold the blobs so Undo can put everything back.
      const imgBlob = await store.imageBlob(entry);
      const thumbBlob = await store.adapter.readFile(entry.thumbnail);
      const snapshot = { ...entry, tags: [...(entry.tags || [])], colors: [...(entry.colors || [])] };
      await store.deleteOutfit(entry.id);
      ids.splice(idx, 1);
      actionToast('Outfit deleted', 'Undo', async () => {
        await store.restoreOutfit(snapshot, imgBlob, thumbBlob);
        toast('Outfit restored ✓');
      }, { ms: 8000 });
      if (!ids.length) return close();
      idx = Math.min(idx, ids.length - 1);
      render();
    });

    root.replaceChildren(
      el('div', { class: 'lb-top' },
        closeBtn,
        el('div', { class: 'lb-title' },
          el('b', { text: relDay(entry.date) }),
          el('span', { text: `${fmtLong(entry.date, { weekday: true })}${entry.time ? ` · ${entry.time}` : ''}` })),
        favBtn),
      stage,
      el('div', { class: 'lb-panel' },
        el('div', { class: 'lb-actions' }, shareBtn, dlBtn, delBtn),
        notes,
        tags,
        tagList,
        meta));
  }

  function nav(delta) {
    const n = idx + delta;
    if (n < 0 || n >= ids.length) return;
    idx = n;
    render();
  }

  const onKey = (e) => {
    if (e.key === 'ArrowLeft') nav(1);
    if (e.key === 'ArrowRight') nav(-1);
  };
  document.addEventListener('keydown', onKey);
  const detachKeys = () => document.removeEventListener('keydown', onKey);

  render();
}

async function shareEntry(entry) {
  try {
    const blob = await store.imageBlob(entry);
    if (!blob) return toast('Photo file not found');
    const ext = entry.image.split('.').pop();
    const file = new File([blob], `outfit-${entry.date}.${ext}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: `Outfit · ${fmtLong(entry.date)}` });
    } else {
      downloadEntry(entry);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Sharing is not available here');
  }
}

async function shareCard(entry) {
  try {
    const blob = await buildMemoryCard(entry);
    const file = new File([blob], `memory-card-${entry.date}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: `Outfit · ${fmtLong(entry.date)}` });
    } else {
      const a = el('a', { href: URL.createObjectURL(blob), download: file.name });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      toast('Memory card saved ✓');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Could not build the card');
  }
}

async function downloadEntry(entry) {
  const blob = await store.imageBlob(entry);
  if (!blob) return toast('Photo file not found');
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: entry.image.split('/').pop(),
  });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
