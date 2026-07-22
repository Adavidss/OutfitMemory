/**
 * gallery.js — the home timeline: month-grouped photo grid with search,
 * favorites / month / color filters, and the "on this day" memory banner.
 *
 * Thumbnails load lazily through an IntersectionObserver; object URLs are
 * created only when a card approaches the viewport.
 */

import { store } from '../store.js';
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { fmtLong, fmtMonthYear, todayStr } from '../util/dates.js';
import { openDetail } from './detail.js';
import { openCapture } from './capture.js';

// Filter state survives re-renders (store changes) but not reloads.
const filter = { q: '', fav: false, month: '', color: '' };

let observer = null;

export function renderGallery(container) {
  observer?.disconnect();
  container.replaceChildren();

  const entries = store.entries();
  if (!entries.length) {
    container.append(emptyState());
    return;
  }

  const banner = memoryBanner();
  if (banner) container.append(banner);

  const list = el('div');
  container.append(filterBar(entries, () => renderList(list)), list);
  renderList(list);
}

/* ---------- filters ---------- */

function applyFilter(entries) {
  const q = filter.q.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter.fav && !e.favorite) return false;
    if (filter.month && !e.date.startsWith(filter.month)) return false;
    if (filter.color && !(e.colors || []).includes(filter.color)) return false;
    if (q) {
      // Searching also reaches the clothes tagged in the photo, so
      // "linen shirt" finds every outfit it appears in.
      const itemText = store.itemsFor(e).map((i) => `${i.name} ${i.brand || ''}`).join(' ');
      const hay = `${e.date} ${e.notes || ''} ${(e.tags || []).join(' ')} ${itemText}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function filterBar(entries, onChange) {
  const searchInput = el('input', {
    type: 'search', value: filter.q, 'aria-label': 'Search outfits',
    placeholder: store.items().length
      ? 'Search notes, clothes, dates…'
      : 'Search notes, tags, dates…',
  });
  let deb;
  searchInput.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { filter.q = searchInput.value; onChange(); }, 180);
  });

  const favChip = el('button', { class: `chip${filter.fav ? ' active' : ''}` }, icon('heart'), 'Favorites');
  favChip.addEventListener('click', () => {
    filter.fav = !filter.fav;
    favChip.classList.toggle('active', filter.fav);
    onChange();
  });

  // Month dropdown from the months that actually have outfits.
  const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))];
  const monthSel = el('select', { 'aria-label': 'Filter by month' },
    el('option', { value: '', text: 'All months' }),
    months.map((m) => el('option', { value: m, text: fmtMonthYear(m), selected: filter.month === m || null })));
  const monthChip = el('label', { class: `chip${filter.month ? ' active' : ''}` }, icon('calendar'), monthSel);
  monthSel.addEventListener('change', () => {
    filter.month = monthSel.value;
    monthChip.classList.toggle('active', !!filter.month);
    onChange();
  });

  // Color dots for the top colors present in the archive.
  const colorCounts = new Map();
  for (const e of entries) for (const c of e.colors || []) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
  const topColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);

  const chipRow = el('div', { class: 'chip-row' }, favChip, monthChip,
    topColors.map((c) => {
      const dot = el('button', {
        class: `dot-chip${filter.color === c ? ' active' : ''}`,
        title: c, 'aria-label': `Filter by ${c}`,
        style: { background: NAME_HEX[c] || '#999' },
      });
      dot.addEventListener('click', () => {
        filter.color = filter.color === c ? '' : c;
        chipRow.querySelectorAll('.dot-chip').forEach((d) => d.classList.remove('active'));
        if (filter.color) dot.classList.add('active');
        onChange();
      });
      return dot;
    }));

  // Cozy ⇄ compact grid density (persisted)
  const densityBtn = el('button', {
    class: 'icon-btn density-btn',
    'aria-label': 'Toggle grid size',
    'aria-pressed': store.settings.gridDensity === 'compact' ? 'true' : 'false',
    title: 'Grid size',
  }, icon('grid'));
  densityBtn.addEventListener('click', () => {
    const next = store.settings.gridDensity === 'compact' ? 'cozy' : 'compact';
    store.saveSettings({ gridDensity: next });
    densityBtn.setAttribute('aria-pressed', next === 'compact' ? 'true' : 'false');
    onChange();
  });

  return el('div', { class: 'filters' },
    el('div', { class: 'search-row' },
      el('div', { class: 'search' }, icon('search'), searchInput),
      densityBtn),
    chipRow);
}

/* ---------- list ---------- */

function renderList(listEl) {
  observer?.disconnect();
  observer = new IntersectionObserver(onIntersect, { rootMargin: '600px' });
  listEl.replaceChildren();

  const all = store.entries();
  const filtered = applyFilter(all);
  const active = filter.q || filter.fav || filter.month || filter.color;

  if (active) {
    const clear = el('button', { class: 'link-btn', text: 'Clear filters' });
    clear.addEventListener('click', () => {
      filter.q = ''; filter.fav = false; filter.month = ''; filter.color = '';
      renderGallery(listEl.closest('#view'));
    });
    listEl.append(el('div', { class: 'result-note' },
      `${filtered.length} outfit${filtered.length === 1 ? '' : 's'} match`, clear));
  }

  if (!filtered.length && active) {
    listEl.append(el('div', { class: 'empty' },
      el('h2', { text: 'Nothing matches' }),
      el('p', { text: 'Try clearing a filter or searching for something else.' })));
    return;
  }

  const contextIds = filtered.map((e) => e.id);

  // Group by month, newest first (entries are already sorted).
  let currentMonth = null;
  let grid = null;
  for (const e of filtered) {
    const month = e.date.slice(0, 7);
    if (month !== currentMonth) {
      currentMonth = month;
      const count = filtered.filter((x) => x.date.startsWith(month)).length;
      grid = el('div', { class: `grid${store.settings.gridDensity === 'compact' ? ' compact' : ''}` });
      listEl.append(el('section', { class: 'month-section' },
        el('div', { class: 'month-head' },
          el('h2', { text: fmtMonthYear(month) }),
          el('span', { text: `${count}` })),
        grid));
    }
    grid.append(card(e, contextIds));
  }
}

function card(e, contextIds) {
  const btn = el('button', {
    class: 'thumb-card',
    dataset: { id: e.id },
    'aria-label': `Outfit from ${fmtLong(e.date)}`,
  },
    el('div', { class: 'thumb-ph' }),
    el('img', { class: 'thumb-img', alt: '', loading: 'lazy' }),
    e.favorite ? el('span', { class: 'fav-badge' }, icon('heartFill')) : null,
    el('span', { class: 'thumb-cap', text: fmtLong(e.date) }));
  btn.addEventListener('click', () => openDetail(e.id, contextIds));
  observer.observe(btn);
  return btn;
}

async function onIntersect(items) {
  for (const it of items) {
    if (!it.isIntersecting) continue;
    observer.unobserve(it.target);
    const entry = store.entryById(it.target.dataset.id);
    if (!entry) continue;
    const url = await store.thumbURL(entry);
    const img = it.target.querySelector('img');
    if (url && img) {
      img.src = url;
      img.addEventListener('load', () => {
        img.classList.add('loaded');
        it.target.querySelector('.thumb-ph')?.remove();
      }, { once: true });
    }
  }
}

/* ---------- memory banner ---------- */

function memoryBanner() {
  const today = todayStr();
  if (store.settings.memoryDismissed === today) return null;
  const md = today.slice(5);
  const year = Number(today.slice(0, 4));
  const past = store.entries().filter(
    (e) => e.date.slice(5) === md && Number(e.date.slice(0, 4)) < year
  );
  if (!past.length) return null;
  const e = past[0]; // most recent prior year

  const img = el('img', { alt: '' });
  store.thumbURL(e).then((u) => { if (u) img.src = u; });

  const closeBtn = el('button', { class: 'icon-btn memory-close', 'aria-label': 'Dismiss memory' }, icon('x'));
  const banner = el('button', { class: 'memory-banner' },
    img,
    el('span', { class: 'grow' },
      el('span', { class: 'memory-kicker', text: 'Memories' }),
      el('span', { class: 'memory-title', text: `On this day in ${e.date.slice(0, 4)}` }),
      el('span', { class: 'memory-sub', text: e.notes || fmtLong(e.date, { weekday: true }) })));
  banner.append(closeBtn);
  banner.addEventListener('click', () => openDetail(e.id));
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    store.saveSettings({ memoryDismissed: today });
    banner.remove();
  });
  return banner;
}

/* ---------- empty state ---------- */

function emptyState() {
  const cta = el('button', { class: 'btn btn-hero' }, icon('camera'), "Add Today's Outfit");
  cta.addEventListener('click', () => openCapture());
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-art' }, icon('cameraHeart')),
    el('h2', { text: 'Your style memory starts here' }),
    el('p', { text: 'One photo a day. In a month you\'ll scroll back through looks you\'d already forgotten.' }),
    cta);
}
