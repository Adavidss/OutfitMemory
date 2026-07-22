/**
 * wardrobeView.js — the optional closet: every tagged item, searchable and
 * sortable, plus closet insights and the door into the outfit builder.
 *
 * Deliberately empty until the user tags something. The photo journal is
 * the product; this is a layer on top for people who want it.
 */

import { store } from '../store.js';
import { el, toast, confirmDialog, openOverlay, sheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { fmtLong, relDay } from '../util/dates.js';
import {
  CATEGORIES, catLabel, catEmoji, itemStats, pairsWith, insights,
  formatPrice, safeUrl, linkHost, canSuggest,
} from '../wardrobe.js';
import { itemForm } from './itemTagger.js';
import { openOutfitBuilder } from './outfitBuilder.js';
import { openDetail } from './detail.js';

// Survives re-renders, not reloads.
const filter = { q: '', cat: '', sort: 'recent' };

const SORTS = {
  recent: { label: 'Recently added', fn: (a, b) => (b.item.createdAt || '').localeCompare(a.item.createdAt || '') },
  worn: { label: 'Most worn', fn: (a, b) => b.wears - a.wears },
  value: { label: 'Best value', fn: (a, b) => (a.costPerWear ?? 1e9) - (b.costPerWear ?? 1e9) },
  dusty: { label: 'Longest unworn', fn: (a, b) => (b.daysSince ?? 1e9) - (a.daysSince ?? 1e9) },
  price: { label: 'Most expensive', fn: (a, b) => (b.item.price ?? -1) - (a.item.price ?? -1) },
};

export function renderWardrobe(container) {
  container.replaceChildren();

  const items = store.items();
  if (!items.length) return container.append(emptyState());

  container.append(el('h1', { class: 'view-title', text: 'Wardrobe' }));

  // Build an outfit — the payoff for tagging.
  const buildBtn = el('button', { class: 'wardrobe-cta' },
    el('span', { class: 'grow' },
      el('b', { text: 'Build an outfit' }),
      el('span', { text: canSuggest()
        ? 'Shuffle your own clothes into something to wear'
        : 'Tag a top and a bottom to unlock suggestions' })),
    icon('shuffle'));
  buildBtn.disabled = !canSuggest();
  buildBtn.addEventListener('click', () => openOutfitBuilder());
  container.append(buildBtn);

  container.append(filterBar(() => renderGrid(grid)));
  const grid = el('div', { class: 'item-grid' });
  container.append(grid);
  renderGrid(grid);

  const ins = insightsCard();
  if (ins) container.append(ins);
}

/* ---------- filters ---------- */

function filterBar(onChange) {
  const search = el('input', {
    type: 'search', value: filter.q, placeholder: 'Search items, brands…',
    'aria-label': 'Search wardrobe',
  });
  let deb;
  search.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { filter.q = search.value; onChange(); }, 180);
  });

  const sortSel = el('select', { 'aria-label': 'Sort items' },
    Object.entries(SORTS).map(([k, s]) =>
      el('option', { value: k, text: s.label, selected: filter.sort === k || null })));
  sortSel.addEventListener('change', () => { filter.sort = sortSel.value; onChange(); });

  const used = new Set(store.items().map((i) => i.category));
  const chips = el('div', { class: 'chip-row' },
    el('label', { class: 'chip active' }, icon('chart'), sortSel),
    CATEGORIES.filter((c) => used.has(c.id)).map((c) => {
      const chip = el('button', { class: `chip${filter.cat === c.id ? ' active' : ''}` },
        `${c.emoji} ${c.label}`);
      chip.addEventListener('click', () => {
        filter.cat = filter.cat === c.id ? '' : c.id;
        chips.querySelectorAll('.chip').forEach((x, i) => { if (i) x.classList.remove('active'); });
        if (filter.cat) chip.classList.add('active');
        onChange();
      });
      return chip;
    }));

  return el('div', { class: 'filters' },
    el('div', { class: 'search-row' }, el('div', { class: 'search' }, icon('search'), search)),
    chips);
}

function renderGrid(grid) {
  const q = filter.q.trim().toLowerCase();
  const rows = store.items()
    .map((item) => ({ item, ...itemStats(item) }))
    .filter(({ item }) => {
      if (filter.cat && item.category !== filter.cat) return false;
      if (!q) return true;
      return `${item.name} ${item.brand || ''} ${item.color || ''}`.toLowerCase().includes(q);
    })
    .sort(SORTS[filter.sort].fn);

  grid.replaceChildren();
  if (!rows.length) {
    grid.append(el('p', { class: 'set-note', text: 'No items match.' }));
    return;
  }
  for (const row of rows) grid.append(itemCard(row));
}

function itemCard({ item, wears, costPerWear }) {
  const img = el('img', { class: 'item-thumb', alt: '', loading: 'lazy' });
  store.itemThumbURL(item).then((u) => { if (u) img.src = u; });

  const price = formatPrice(item.price, item.currency);
  const cpw = costPerWear != null ? `${formatPrice(costPerWear, item.currency)}/wear` : null;

  const card = el('button', { class: 'item-card', 'aria-label': item.name },
    el('div', { class: 'item-thumb-wrap' }, img,
      el('span', { class: 'item-cat', text: catEmoji(item.category) })),
    el('div', { class: 'item-meta' },
      el('b', { class: 'item-name', text: item.name }),
      el('span', { class: 'item-sub', text: item.brand || catLabel(item.category) }),
      el('span', { class: 'item-stat' },
        `${wears} wear${wears === 1 ? '' : 's'}`,
        cpw ? ` · ${cpw}` : price ? ` · ${price}` : '')));
  card.addEventListener('click', () => openItemDetail(item.id));
  return card;
}

/* ---------- insights ---------- */

function insightsCard() {
  const ins = insights();
  if (!ins.count) return null;

  const box = el('div', { class: 'stat-cards' });

  if (ins.priced) {
    box.append(el('div', { class: 'card' },
      el('div', { class: 'stat-card-title', text: 'Closet value' }),
      el('div', { class: 'tile-value', text: formatPrice(ins.totalValue, store.settings.currency || 'USD') || '—' }),
      el('div', { class: 'tile-label',
        text: `across ${ins.priced} priced item${ins.priced === 1 ? '' : 's'} of ${ins.count}` })));
  }

  const list = (title, rows, render) => {
    if (!rows.length) return null;
    return el('div', { class: 'card' },
      el('div', { class: 'stat-card-title', text: title }),
      el('div', { class: 'mini-list' }, rows.map((r) => {
        const img = el('img', { class: 'mini-thumb', alt: '' });
        store.itemThumbURL(r.item).then((u) => { if (u) img.src = u; });
        const row = el('button', { class: 'mini-row' }, img,
          el('span', { class: 'grow' },
            el('b', { text: r.item.name }),
            el('span', { class: 'sub', text: render(r) })));
        row.addEventListener('click', () => openItemDetail(r.item.id));
        return row;
      })));
  };

  box.append(
    list('Best value — your hardest workers', ins.bestValue,
      (r) => `${formatPrice(r.costPerWear, r.item.currency)} per wear · ${r.wears} wears`),
    list('Worth a rewear', ins.dusty,
      (r) => r.wears === 0 ? 'never worn yet' : `last worn ${r.daysSince} days ago`),
    list('Was it worth it?', ins.worstValue,
      (r) => `${formatPrice(r.costPerWear, r.item.currency)} per wear · only ${r.wears} wear${r.wears === 1 ? '' : 's'}`),
  );
  return box;
}

/* ---------- item detail ---------- */

export function openItemDetail(id) {
  const root = el('div', { class: 'lightbox' });
  const { close } = openOverlay(root, { variant: 'full' });

  function render() {
    const item = store.itemById(id);
    if (!item) return close();
    const stats = itemStats(item);

    const img = el('img', { class: 'item-hero', alt: item.name });
    store.itemThumbURL(item).then((u) => { if (u) img.src = u; });

    const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
    closeBtn.addEventListener('click', close);

    const editBtn = el('button', { class: 'icon-btn', 'aria-label': 'Edit item' }, icon('tag'));
    editBtn.addEventListener('click', async () => {
      const thumbURL = await store.itemThumbURL(item);
      const fields = await itemForm({ title: 'Edit item', initial: item, thumbURL });
      if (!fields) return;
      await store.updateItem(id, fields);
      toast('Item updated ✓');
      render();
    });

    const delBtn = el('button', { class: 'icon-btn', 'aria-label': 'Delete item' }, icon('trash'));
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Delete “${item.name}”?`,
        body: 'It will be removed from your wardrobe and untagged from every outfit. Your photos are not affected.',
        okLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      await store.deleteItem(id);
      toast('Item deleted');
      close();
    });

    /* stats tiles */
    const tiles = el('div', { class: 'tile-grid' },
      tile(String(stats.wears), 'Times worn'),
      tile(stats.lastWorn ? relDay(stats.lastWorn) : '—', 'Last worn'),
      Number.isFinite(item.price)
        ? tile(formatPrice(item.price, item.currency), 'Price')
        : null,
      stats.costPerWear != null
        ? tile(formatPrice(stats.costPerWear, item.currency), 'Cost per wear')
        : null);

    /* buy / product link */
    const href = safeUrl(item.link);
    const linkRow = href
      ? el('a', { class: 'btn btn-block', href, target: '_blank', rel: 'noopener noreferrer' },
          icon('link'), `View at ${linkHost(item.link)}`)
      : null;

    /* pairs well with */
    const pairs = pairsWith(item.id);
    const pairsBox = pairs.length
      ? el('div', { class: 'card' },
          el('div', { class: 'stat-card-title', text: 'You usually wear it with' }),
          el('div', { class: 'mini-list' }, pairs.map(({ item: other, n }) => {
            const t = el('img', { class: 'mini-thumb', alt: '' });
            store.itemThumbURL(other).then((u) => { if (u) t.src = u; });
            const row = el('button', { class: 'mini-row' }, t,
              el('span', { class: 'grow' },
                el('b', { text: other.name }),
                el('span', { class: 'sub', text: `${n} outfit${n === 1 ? '' : 's'} together` })));
            row.addEventListener('click', () => { close(); openItemDetail(other.id); });
            return row;
          })))
      : null;

    /* outfits featuring this item */
    const outfits = stats.entries.slice(0, 12);
    const outfitBox = outfits.length
      ? el('div', { class: 'card' },
          el('div', { class: 'stat-card-title', text: `Worn in ${stats.wears} outfit${stats.wears === 1 ? '' : 's'}` }),
          el('div', { class: 'grid compact' }, outfits.map((e) => {
            const t = el('img', { class: 'thumb-img loaded', alt: '' });
            store.thumbURL(e).then((u) => { if (u) t.src = u; });
            const c = el('button', { class: 'thumb-card', 'aria-label': fmtLong(e.date) }, t);
            c.addEventListener('click', () => { close(); openDetail(e.id); });
            return c;
          })))
      : null;

    const swatch = item.hex || NAME_HEX[item.color];

    root.replaceChildren(
      el('div', { class: 'lb-top' },
        closeBtn,
        el('div', { class: 'lb-title' },
          el('b', { text: item.name }),
          el('span', { text: [item.brand, catLabel(item.category)].filter(Boolean).join(' · ') })),
        el('div', { class: 'lb-top-actions' }, editBtn, delBtn)),
      el('div', { class: 'item-detail' },
        el('div', { class: 'item-hero-wrap' }, img,
          swatch ? el('i', { class: 'item-hero-dot', style: { background: swatch } }) : null),
        tiles,
        linkRow,
        pairsBox,
        outfitBox));
  }

  const tile = (value, label) => el('div', { class: 'tile' },
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-label', text: label }));

  render();
}

/* ---------- empty state ---------- */

function emptyState() {
  const learn = el('button', { class: 'link-btn', text: 'How does this work?' });
  learn.addEventListener('click', () => sheet({
    title: 'The wardrobe is optional',
    body: 'OutfitMemory works perfectly as a plain photo journal — you never have to tag anything. '
      + 'But if you do: open any outfit, tap “Tag clothing”, and drag a box around a piece. '
      + 'The app cuts out the crop, reads its color and guesses the category for you. '
      + 'Once a few things are tagged you get real cost-per-wear, "worth a rewear" nudges, '
      + 'and a shuffle button that builds outfits from clothes you already own.',
    actions: [],
    cancelLabel: 'Got it',
  }));

  const go = el('button', { class: 'btn btn-hero' }, icon('grid'), 'Open a photo to tag');
  go.addEventListener('click', () => { location.hash = '#/gallery'; });

  return el('div', { class: 'empty' },
    el('div', { class: 'empty-art' }, icon('hanger')),
    el('h2', { text: 'Your wardrobe, built from photos' }),
    el('p', { text: 'Tag pieces straight off your outfit photos — no data entry, no barcode scanning. Then shuffle them into new outfits and see what each piece really costs per wear.' }),
    go, learn);
}
