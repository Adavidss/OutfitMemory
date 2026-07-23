/**
 * detail.js — full-screen outfit view: photo, date, favorite, notes,
 * tags, colors, share/download/delete, and prev/next navigation
 * (buttons, arrow keys, swipe).
 */

import { store } from '../store.js';
import { el, toast, actionToast, confirmDialog, sheet, openOverlay, haptic } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtLong, relDay } from '../util/dates.js';
import { buildMemoryCard } from '../shareCard.js';
import { openItemTagger } from './itemTagger.js';
import { openItemDetail } from './wardrobeView.js';
import { openCapture } from './capture.js';

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

    // Double-tap the photo to favorite it — Instagram-style, with a heart
    // burst. Always favorites (never un-favorites); the heart button is
    // there for toggling off.
    let lastTap = 0;
    img.addEventListener('click', async (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        lastTap = 0;
        const cur = store.entryById(entry.id);
        if (cur && !cur.favorite) {
          await store.toggleFavorite(entry.id);
          favBtn.classList.add('on');
          favBtn.replaceChildren(icon('heartFill'));
        }
        heartBurst(stage, e);
        haptic();
      } else {
        lastTap = now;
      }
    });

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

    /* Wardrobe items worn in this outfit — optional, empty unless tagged. */
    const worn = store.itemsFor(entry);
    const tagBtn = el('button', { class: 'btn btn-sm lb-tag-btn' },
      icon('hanger'), worn.length ? 'Edit clothing' : 'Tag clothing');
    tagBtn.addEventListener('click', () => openItemTagger(entry.id));

    const itemRow = el('div', { class: 'lb-items' },
      worn.map((item) => {
        const thumb = el('img', { alt: '' });
        store.itemThumbURL(item).then((u) => { if (u) thumb.src = u; });
        const chip = el('button', { class: 'lb-item-chip' }, thumb, el('b', { text: item.name }));
        chip.addEventListener('click', () => openItemDetail(item.id));
        return chip;
      }),
      tagBtn);

    /* "More like this" — outfits sharing clothing items or colors.
       Pure local scoring: shared item ×3, shared color name ×1. */
    const similar = store.entries()
      .filter((x) => x.id !== entry.id)
      .map((x) => {
        const sharedItems = (x.items || []).filter((i) => (entry.items || []).includes(i)).length;
        const sharedColors = (x.colors || []).filter((c) => (entry.colors || []).includes(c)).length;
        return { x, score: sharedItems * 3 + sharedColors };
      })
      .filter((s) => s.score >= (entry.items?.length ? 3 : 2))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const likeThis = similar.length
      ? el('div', { class: 'lb-similar' },
          el('div', { class: 'stat-card-title', text: 'More like this' }),
          el('div', { class: 'lb-similar-row' }, similar.map(({ x }) => {
            const t = el('img', { alt: `Outfit from ${fmtLong(x.date)}`, loading: 'lazy' });
            store.thumbURL(x).then((u) => { if (u) t.src = u; });
            const b = el('button', { class: 'lb-similar-card', title: fmtLong(x.date) }, t,
              el('span', { text: x.date.slice(5) }));
            b.addEventListener('click', () => {
              const j = ids.indexOf(x.id);
              if (j >= 0) { idx = j; render(); }
              else { close(); openDetail(x.id); }
            });
            return b;
          })))
      : null;

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

    // Wear this outfit again: start a fresh capture for today with the same
    // pieces already tagged (and note carried over as a starting point).
    const againBtn = el('button', { class: 'icon-btn', 'aria-label': 'Wear this outfit again', title: 'Wear again' },
      icon('refresh'));
    againBtn.addEventListener('click', () => {
      const items = [...(entry.items || [])];
      close();
      openCapture({ items, notes: entry.notes || '' });
    });

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
        el('div', { class: 'lb-actions' }, againBtn, shareBtn, dlBtn, delBtn),
        itemRow,
        notes,
        tags,
        tagList,
        meta,
        likeThis));
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

/** A heart that pops where the user double-tapped, then fades. */
function heartBurst(stage, ev) {
  const r = stage.getBoundingClientRect();
  const x = (ev?.clientX ?? r.left + r.width / 2) - r.left;
  const y = (ev?.clientY ?? r.top + r.height / 2) - r.top;
  const heart = el('div', { class: 'heart-burst', style: { left: `${x}px`, top: `${y}px` } },
    icon('heartFill'));
  stage.append(heart);
  setTimeout(() => heart.remove(), 900);
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
