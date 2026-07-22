/**
 * wardrobeView.js — the optional closet: every tagged item, searchable and
 * sortable, plus closet insights and the door into the outfit builder.
 *
 * Deliberately empty until the user tags something. The photo journal is
 * the product; this is a layer on top for people who want it.
 */

import { store } from '../store.js';
import { el, mount, toast, confirmDialog, openOverlay, sheet, haptic } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { fmtLong, relDay } from '../util/dates.js';
import {
  CATEGORIES, catLabel, catEmoji, itemStats, pairsWith, insights,
  formatPrice, safeUrl, linkHost, canSuggest,
} from '../wardrobe.js';
import { itemForm, openAddItem } from './itemTagger.js';
import { openOutfitBuilder } from './outfitBuilder.js';
import { openDetail } from './detail.js';
import { hasGeminiKey, identifyItem } from '../search/whereToBuy.js';
import { RETAILERS } from '../search/shoppingSearch.js';
import { shareOutfit } from './shareOutfit.js';
import { openCapture } from './capture.js';

// Survives re-renders, not reloads. `wish` switches between the clothes you
// own and the ones you want.
const filter = { q: '', cat: '', sort: 'recent', wish: false };

/**
 * Outfit-building selection. When `on`, tapping a card adds/removes it
 * instead of opening its detail — building an outfit is then just
 * "tap the things you're wearing", with no separate screen to learn.
 */
const picking = { on: false, ids: new Set() };

const SORTS = {
  recent: { label: 'Recently added', fn: (a, b) => (b.item.createdAt || '').localeCompare(a.item.createdAt || '') },
  worn: { label: 'Most worn', fn: (a, b) => b.wears - a.wears },
  value: { label: 'Best value', fn: (a, b) => (a.costPerWear ?? 1e9) - (b.costPerWear ?? 1e9) },
  dusty: { label: 'Longest unworn', fn: (a, b) => (b.daysSince ?? 1e9) - (a.daysSince ?? 1e9) },
  price: { label: 'Most expensive', fn: (a, b) => (b.item.price ?? -1) - (a.item.price ?? -1) },
};

export function renderWardrobe(container) {
  container.replaceChildren();

  const owned = store.items(false);
  const wished = store.items(true);
  if (!owned.length && !wished.length) return container.append(emptyState());

  // One action in the header. Building an outfit lives on the card below,
  // where there's room to say what it does.
  const addBtn = el('button', { class: 'icon-btn', 'aria-label': 'Add an item', title: 'Add an item' },
    icon('plus'));
  addBtn.addEventListener('click', () => openAddItem({ wish: filter.wish }));

  const doneBtn = el('button', { class: 'btn btn-sm btn-primary', text: 'Done' });
  doneBtn.addEventListener('click', () => { stopPicking(); renderWardrobe(container); });

  container.append(el('div', { class: 'view-head' },
    el('h1', { class: 'view-title', text: picking.on ? 'Pick your outfit' : 'Wardrobe' }),
    picking.on ? doneBtn : addBtn));

  // Owned ⇄ Wishlist. The wishlist is deliberately separate: wanted items
  // must never be suggested as something you could wear today. Hidden while
  // picking — you can only wear what you own.
  if (!picking.on) {
    const seg = el('div', { class: 'segmented', role: 'tablist' },
      [[false, `Owned${owned.length ? ` ${owned.length}` : ''}`],
       [true, `Wishlist${wished.length ? ` ${wished.length}` : ''}`]].map(([v, label]) => {
        const b = el('button', {
          class: `seg${filter.wish === v ? ' on' : ''}`, role: 'tab',
          'aria-selected': filter.wish === v ? 'true' : 'false',
        }, label);
        b.addEventListener('click', () => { filter.wish = v; renderWardrobe(container); });
        return b;
      }));
    container.append(seg);
  }

  const items = filter.wish ? wished : owned;
  if (!items.length) {
    container.append(el('div', { class: 'empty' },
      el('div', { class: 'empty-art' }, icon(filter.wish ? 'heart' : 'hanger')),
      el('h2', { text: filter.wish ? 'Nothing on the wishlist yet' : 'No items yet' }),
      el('p', { text: filter.wish
        ? 'Saw something you want? Copy its picture from the shop and add it here — it stays separate from what you own.'
        : 'Tag pieces from your outfit photos, or add one from a picture.' }),
      (() => {
        const b = el('button', { class: 'btn btn-hero' }, icon('plus'),
          filter.wish ? 'Add a wanted item' : 'Add an item');
        b.addEventListener('click', () => openAddItem({ wish: filter.wish }));
        return b;
      })()));
    return;
  }

  // Builder + plans + insights describe clothes you actually own.
  if (!filter.wish && !picking.on) {
    const buildBtn = el('button', { class: 'wardrobe-cta' },
      el('span', { class: 'grow' },
        el('b', { text: 'Create an outfit' }),
        el('span', { text: canSuggest()
          ? 'Tap the pieces you want — or shuffle for ideas'
          : 'Add a couple of items to unlock this' })),
      icon('sparkles'));
    buildBtn.disabled = !canSuggest();
    buildBtn.addEventListener('click', () => {
      picking.on = true;
      picking.ids.clear();
      renderWardrobe(container);
    });
    container.append(buildBtn);

    const plansBox = plansCard(container);
    if (plansBox) container.append(plansBox);
  }

  container.append(filterBar(() => renderGrid(grid)));
  const grid = el('div', { class: 'item-grid' });
  container.append(grid);
  renderGrid(grid);

  if (picking.on) container.append(pickBar(container));

  if (!filter.wish && !picking.on) {
    const ins = insightsCard();
    if (ins) container.append(ins);
  } else if (filter.wish) {
    const total = items.reduce((s, i) => s + (Number.isFinite(i.price) ? i.price : 0), 0);
    if (total > 0) {
      container.append(el('div', { class: 'card' },
        el('div', { class: 'stat-card-title', text: 'Wishlist total' }),
        el('div', { class: 'tile-value', text: formatPrice(total, store.settings.currency || 'USD') }),
        el('div', { class: 'tile-label', text: `${items.length} wanted item${items.length === 1 ? '' : 's'}` })));
    }
  }
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

  // Sort is a rare, deliberate choice — an icon beside the search box that
  // opens a list, rather than a permanent dropdown competing with the
  // category chips for the same row.
  const sortBtn = el('button', {
    class: `icon-btn${filter.sort !== 'recent' ? ' on-accent' : ''}`,
    'aria-label': `Sort: ${SORTS[filter.sort].label}`, title: `Sort: ${SORTS[filter.sort].label}`,
  }, icon('chart'));
  sortBtn.addEventListener('click', () => sheet({
    title: 'Sort by',
    actions: Object.entries(SORTS).map(([k, s]) => ({
      label: `${filter.sort === k ? '✓ ' : ''}${s.label}`,
      icon: 'chart',
      onPick: () => { filter.sort = k; onChange(); },
    })),
  }));

  const used = new Set(store.items(filter.wish).map((i) => i.category));
  const chips = el('div', { class: 'chip-row' },
    CATEGORIES.filter((c) => used.has(c.id)).map((c) => {
      const chip = el('button', { class: `chip${filter.cat === c.id ? ' active' : ''}` },
        `${c.emoji} ${c.label}`);
      chip.addEventListener('click', () => {
        filter.cat = filter.cat === c.id ? '' : c.id;
        chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        if (filter.cat) chip.classList.add('active');
        onChange();
      });
      return chip;
    }));

  return el('div', { class: 'filters' },
    el('div', { class: 'search-row' },
      el('div', { class: 'search' }, icon('search'), search),
      sortBtn),
    chips.children.length > 1 ? chips : null);
}

/* ---------- outfit picking ---------- */

export function stopPicking() {
  picking.on = false;
  picking.ids.clear();
}

/** The items currently picked, in head-to-toe order. */
function pickedItems() {
  return [...picking.ids].map((id) => store.itemById(id)).filter(Boolean)
    .sort((a, b) => CATEGORIES.findIndex((c) => c.id === a.category)
      - CATEGORIES.findIndex((c) => c.id === b.category));
}

/**
 * Sticky bar summarising the outfit being built. Everything you can do
 * with the selection lives here, so the grid above stays uncluttered.
 */
function pickBar(container) {
  const chosen = pickedItems();

  const thumbs = el('div', { class: 'pickbar-thumbs' }, chosen.slice(0, 5).map((it) => {
    const img = el('img', { alt: '' });
    store.itemThumbURL(it).then((u) => { if (u) img.src = u; });
    return img;
  }));

  const label = chosen.length
    ? `${chosen.length} piece${chosen.length === 1 ? '' : 's'}`
    : 'Tap pieces to add them';

  const shuffleBtn = el('button', {
    class: 'btn btn-sm', 'aria-label': chosen.length ? 'Shuffle the rest around these' : 'Shuffle an outfit',
  }, icon('shuffle'), chosen.length ? 'Fill rest' : 'Shuffle');
  shuffleBtn.addEventListener('click', () => {
    // Hand the picks to the shuffle view pre-locked, so nothing already
    // chosen gets thrown away.
    const startWith = pickedItems();
    stopPicking();
    renderWardrobe(container);
    openOutfitBuilder({ startWith });
  });

  const nextBtn = el('button', { class: 'btn btn-sm btn-hero' }, icon('check'), 'Use outfit');
  nextBtn.disabled = !chosen.length;
  nextBtn.addEventListener('click', () => {
    const items = pickedItems();
    sheet({
      title: `${items.length} piece${items.length === 1 ? '' : 's'} selected`,
      actions: [
        {
          label: 'Wear this today', icon: 'camera', sub: 'Take the photo now, pieces already tagged',
          onPick: () => {
            const ids = items.map((i) => i.id);
            stopPicking();
            renderWardrobe(container);
            openCapture({ items: ids });
          },
        },
        {
          label: 'Save as idea', icon: 'heart', sub: 'Keep it for later without a photo',
          onPick: async () => {
            // Leave selection mode BEFORE saving: addPlan emits a change
            // that re-renders the view, and it must render the normal
            // wardrobe rather than the picker we're finished with.
            const ids = items.map((i) => i.id);
            stopPicking();
            await store.addPlan(ids);
            toast('Saved to planned outfits ✓');
          },
        },
        { label: 'Share outfit', icon: 'share', onPick: () => shareOutfit(items) },
      ],
    });
  });

  return el('div', { class: 'pickbar' },
    chosen.length ? thumbs : null,
    el('span', { class: 'pickbar-label', text: label }),
    el('span', { class: 'pickbar-actions' }, shuffleBtn, nextBtn));
}

function renderGrid(grid) {
  const q = filter.q.trim().toLowerCase();
  const rows = store.items(filter.wish)
    .map((item) => ({ item, ...itemStats(item) }))
    .filter(({ item }) => {
      if (filter.cat && item.category !== filter.cat) return false;
      if (!q) return true;
      const hay = `${item.name} ${item.brand || ''} ${item.color || ''} ${(item.tags || []).join(' ')}`;
      return hay.toLowerCase().includes(q);
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

  const chosen = picking.on && picking.ids.has(item.id);

  const card = el('button', {
    class: `item-card${chosen ? ' picked' : ''}`,
    'aria-label': item.name,
    'aria-pressed': picking.on ? String(chosen) : null,
  },
    el('div', { class: 'item-thumb-wrap' },
      img,
      el('span', { class: 'item-cat', text: catEmoji(item.category) }),
      picking.on
        ? el('span', { class: `item-check${chosen ? ' on' : ''}` }, chosen ? icon('check') : null)
        : (item.wish ? el('span', { class: 'item-wish', title: 'On your wishlist' }, icon('heart')) : null)),
    el('div', { class: 'item-meta' },
      el('b', { class: 'item-name', text: item.name }),
      el('span', { class: 'item-sub', text: item.brand || catLabel(item.category) }),
      el('span', { class: 'item-stat' }, item.wish
        ? (price || 'wanted')
        : `${wears} wear${wears === 1 ? '' : 's'}${cpw ? ` · ${cpw}` : price ? ` · ${price}` : ''}`)));

  card.addEventListener('click', () => {
    if (!picking.on) return openItemDetail(item.id);
    picking.ids.has(item.id) ? picking.ids.delete(item.id) : picking.ids.add(item.id);
    haptic();
    // Re-render just the view so the card state and the bar stay in step.
    const view = card.closest('#view');
    if (view) renderWardrobe(view);
  });
  return card;
}

/* ---------- insights ---------- */

function insightsCard() {
  const ins = insights();
  if (!ins.count) return null;

  const box = el('div', { class: 'stat-cards' });

  if (ins.priced) {
    mount(box, el('div', { class: 'card' },
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

  // mount() — not append() — because each list() is null when it has no
  // rows, and native append would print the literal word "null".
  mount(box,
    list('Best value — your hardest workers', ins.bestValue,
      (r) => `${formatPrice(r.costPerWear, r.item.currency)} per wear · ${r.wears} wears`),
    list('Worth a rewear', ins.dusty,
      (r) => r.wears === 0 ? 'never worn yet' : `last worn ${r.daysSince} days ago`),
    list('Was it worth it?', ins.worstValue,
      (r) => `${formatPrice(r.costPerWear, r.item.currency)} per wear · only ${r.wears} wear${r.wears === 1 ? '' : 's'}`),
  );
  return box.children.length ? box : null;
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

    const edit = async () => {
      const thumbURL = await store.itemThumbURL(item);
      const fields = await itemForm({ title: 'Edit item', initial: item, thumbURL });
      if (!fields) return;
      await store.updateItem(id, fields);
      toast('Item updated ✓');
      render();
    };

    const remove = async () => {
      const ok = await confirmDialog({
        title: `Delete “${item.name}”?`,
        body: 'It will be removed from your wardrobe and untagged from every outfit. Your photos are not affected.',
        okLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      await store.deleteItem(id);
      toast('Item deleted');
      close();
    };

    // Edit / move / delete behind one menu instead of three competing
    // buttons: they're occasional actions, and the screen is about the item.
    const moreBtn = el('button', { class: 'icon-btn', 'aria-label': 'More actions' }, icon('more'));
    moreBtn.addEventListener('click', () => sheet({
      title: item.name,
      actions: [
        { label: 'Edit details', icon: 'tag', onPick: edit },
        {
          label: item.wish ? 'I bought this — move to wardrobe' : 'Move to wishlist',
          icon: item.wish ? 'check' : 'heart',
          onPick: async () => {
            await store.setWish(item.id, !item.wish);
            toast(item.wish ? `“${item.name}” moved to your wardrobe ✓` : `“${item.name}” moved to your wishlist`);
            render();
          },
        },
        { label: 'Delete item', icon: 'trash', danger: true, onPick: remove },
      ],
    }));

    /* stats tiles — wear history is meaningless for something you don't own */
    const tiles = el('div', { class: 'tile-grid' },
      item.wish ? null : tile(String(stats.wears), 'Times worn'),
      item.wish ? null : tile(stats.lastWorn ? relDay(stats.lastWorn) : '—', 'Last worn'),
      Number.isFinite(item.price)
        ? tile(formatPrice(item.price, item.currency), 'Price')
        : null,
      stats.costPerWear != null
        ? tile(formatPrice(stats.costPerWear, item.currency), 'Cost per wear')
        : null);

    /* Shopping actions share one row instead of stacking full-width. */
    const href = safeUrl(item.link);
    const shopBtns = [
      href && el('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' },
        icon('link'), linkHost(item.link)),
      hasGeminiKey() && (() => {
        const b = el('button', { class: 'btn' }, icon('search'),
          item.buy ? 'Where to buy' : 'Find where to buy');
        b.addEventListener('click', () => openWhereToBuy(item.id));
        return b;
      })(),
    ].filter(Boolean);
    const shopRow = shopBtns.length ? el('div', { class: 'btn-row' }, shopBtns) : null;

    /* Tags + notes */
    const tagsBox = (item.tags || []).length
      ? el('div', { class: 'sim-chips' }, item.tags.map((t) => el('span', { class: 'sim-chip', text: t })))
      : null;
    const notesBox = item.notes
      ? el('p', { class: 'item-notes', text: item.notes })
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
        moreBtn),
      el('div', { class: 'item-detail' },
        el('div', { class: 'item-hero-wrap' }, img,
          swatch ? el('i', { class: 'item-hero-dot', style: { background: swatch } }) : null),
        tagsBox,
        notesBox,
        tiles,
        shopRow,
        pairsBox,
        outfitBox));
  }

  const tile = (value, label) => el('div', { class: 'tile' },
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-label', text: label }));

  render();
}

/* ---------- planned outfits ---------- */

function plansCard(container) {
  const plans = store.plans();
  if (!plans.length) return null;

  const rows = plans.slice(0, 6).map((plan) => {
    const items = plan.items.map((id) => store.itemById(id)).filter(Boolean);
    if (!items.length) return null;

    const thumbs = el('span', { class: 'plan-thumbs' }, items.slice(0, 4).map((it) => {
      const img = el('img', { alt: '' });
      store.itemThumbURL(it).then((u) => { if (u) img.src = u; });
      return img;
    }));

    const wear = el('button', { class: 'icon-btn', 'aria-label': 'Wear this plan today' }, icon('camera'));
    wear.addEventListener('click', () => {
      openCapture({ items: plan.items });
    });
    const share = el('button', { class: 'icon-btn', 'aria-label': 'Share this outfit' }, icon('share'));
    share.addEventListener('click', () => shareOutfit(items, 'Outfit idea'));
    const del = el('button', { class: 'icon-btn', 'aria-label': 'Delete plan' }, icon('x'));
    del.addEventListener('click', async () => {
      await store.deletePlan(plan.id);
      toast('Plan removed');
    });

    return el('div', { class: 'plan-row' }, thumbs,
      el('span', { class: 'grow' },
        el('b', { text: items.map((i) => i.name).join(' + ') }),
        el('span', { class: 'sub', text: `saved ${new Date(plan.createdAt).toLocaleDateString()}` })),
      el('span', { class: 'plan-actions' }, share, wear, del));
  }).filter(Boolean);

  if (!rows.length) return null;
  return el('div', { class: 'card' },
    el('div', { class: 'stat-card-title', text: 'Planned outfits' }), rows);
}

/* ---------- where to buy (Gemini, user's own key) ---------- */

function openWhereToBuy(itemId) {
  const item = store.itemById(itemId);
  if (!item) return;

  const body = el('div', { class: 'buy-body' });
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
  const root = el('div', { class: 'lightbox' },
    el('div', { class: 'lb-top' },
      closeBtn,
      el('div', { class: 'lb-title' },
        el('b', { text: 'Where to buy' }),
        el('span', { text: item.name })),
      el('span', { class: 'icon-btn-spacer' })),
    body);
  const { close } = openOverlay(root, { variant: 'full' });
  closeBtn.addEventListener('click', close);

  if (item.buy?.text) renderBuyResult(body, item, item.buy);
  else runLookup(body, item);
}

async function runLookup(body, item) {
  body.replaceChildren(el('div', { class: 'sim-loading' },
    el('div', { class: 'spinner' }),
    el('div', { class: 'sim-phase', text: 'Asking Gemini…' }),
    el('div', { class: 'sim-detail', text: 'Only this item’s crop is sent — never the full photo.' })));
  try {
    const blob = item.thumb ? await store.adapter.readFile(item.thumb) : null;
    if (!blob) throw new Error('This item has no crop image to look up.');
    const result = await identifyItem(blob, { name: item.name, color: item.color });
    const payload = { ...result, at: new Date().toISOString() };
    await store.updateItem(item.id, { buy: payload });
    renderBuyResult(body, store.itemById(item.id), payload);
  } catch (err) {
    body.replaceChildren(el('div', { class: 'empty' },
      el('div', { class: 'empty-art' }, icon('info')),
      el('h2', { text: 'Lookup failed' }),
      el('p', { text: err?.message || 'Unknown error.' })));
  }
}

function renderBuyResult(body, item, payload) {
  body.replaceChildren();

  const redo = el('button', { class: 'link-btn', text: 'Look up again' });
  redo.addEventListener('click', () => runLookup(body, item));
  body.append(el('div', { class: 'sim-meta' },
    el('span', { text: `Gemini · ${new Date(payload.at).toLocaleDateString()}` }), redo));

  body.append(el('div', { class: 'buy-id-text', text: payload.text }));

  if (payload.links?.length) {
    body.append(el('div', { class: 'stat-card-title', text: 'Sources found by search' }),
      el('div', { class: 'buy-links' }, payload.links.map((l) =>
        el('a', { class: 'buy-link', href: l.uri, target: '_blank', rel: 'noopener noreferrer' },
          icon('link'), el('span', { text: l.title })))));
  }

  // Retailer searches using the model's own phrase (line 3 of its reply).
  const phrase = (payload.text.split('\n').find((s) => /search/i.test(s)) || item.name)
    .replace(/^[^:]*:\s*/, '').replace(/["""]/g, '').trim() || item.name;
  body.append(el('div', { class: 'stat-card-title', text: `Search “${phrase}” yourself` }),
    el('div', { class: 'sim-retailers' }, RETAILERS.map((r) =>
      el('a', { class: 'sim-retailer', href: r.url(phrase), target: '_blank', rel: 'noopener noreferrer' },
        el('span', { text: r.emoji }), r.name))));

  body.append(el('p', { class: 'set-note',
    text: 'Identification is AI-generated and may be wrong. Links are search results, not endorsements — check them like any web result.' }));
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
