/**
 * outfitBuilder.js — "what should I wear?" built from clothes you own.
 *
 * Slot-machine mechanics: shuffle rerolls every unlocked slot, a lock pins
 * a piece you've already decided on, and tapping a slot swaps it by hand.
 * The suggestion engine (wardrobe.js) favors pieces you haven't worn in a
 * while and colors that sit together, and won't hand back a combination
 * you literally wore in the last three weeks.
 *
 * "Wear this today" hands the picks straight to the camera flow, which
 * closes the loop: suggestion → photo → wear counts → better suggestions.
 */

import { store } from '../store.js';
import { el, openOverlay, sheet, toast, haptic } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { CATEGORIES, catLabel, catEmoji, itemStats, suggestOutfit } from '../wardrobe.js';
import { openCapture } from './capture.js';

const SLOT_ORDER = ['outerwear', 'top', 'dress', 'bottom', 'shoes', 'accessory'];

export function openOutfitBuilder() {
  /** category → item (pinned by the user, kept across shuffles) */
  const locked = {};
  let picks = {};

  const slotsBox = el('div', { class: 'builder-slots' });
  const shuffleBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('shuffle'), 'Shuffle');
  const wearBtn = el('button', { class: 'btn btn-block' }, icon('camera'), 'Wear this today');
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));

  const root = el('div', { class: 'builder' },
    el('div', { class: 'lb-top' },
      closeBtn,
      el('div', { class: 'lb-title' },
        el('b', { text: "Today's outfit" }),
        el('span', { text: 'Tap a piece to swap · lock what you like' })),
      el('span', { class: 'icon-btn-spacer' })),
    slotsBox,
    el('div', { class: 'builder-actions' }, shuffleBtn, wearBtn));

  const { close } = openOverlay(root, { variant: 'full' });
  closeBtn.addEventListener('click', close);

  function shuffle() {
    picks = suggestOutfit({ locked }).picks;
    haptic();
    render();
  }

  function render() {
    slotsBox.replaceChildren();
    const shown = SLOT_ORDER.filter((slot) => picks[slot] || locked[slot]);

    if (!shown.length) {
      slotsBox.append(el('p', { class: 'set-note', text: 'No items to combine yet — tag a few pieces first.' }));
      return;
    }
    for (const slot of shown) slotsBox.append(slotRow(slot, picks[slot]));

    // Offer empty slots the user could still fill by hand.
    const missing = SLOT_ORDER.filter(
      (s) => !picks[s] && s !== 'dress' && store.items().some((i) => i.category === s));
    for (const slot of missing) slotsBox.append(emptyRow(slot));
  }

  function slotRow(slot, item) {
    if (!item) return emptyRow(slot);
    const stats = itemStats(item);
    const img = el('img', { class: 'builder-thumb', alt: '' });
    store.itemThumbURL(item).then((u) => { if (u) img.src = u; });

    const isLocked = locked[slot]?.id === item.id;
    const lockBtn = el('button', {
      class: `icon-btn${isLocked ? ' on-accent' : ''}`,
      'aria-label': isLocked ? 'Unlock this piece' : 'Lock this piece',
      'aria-pressed': isLocked ? 'true' : 'false',
    }, icon(isLocked ? 'lock' : 'lockOpen'));
    lockBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isLocked) delete locked[slot];
      else locked[slot] = item;
      render();
    });

    const swatch = item.hex || NAME_HEX[item.color];
    const row = el('div', { class: `builder-row${isLocked ? ' locked' : ''}` },
      el('button', { class: 'builder-main', 'aria-label': `Swap ${catLabel(slot)}` },
        img,
        el('span', { class: 'grow' },
          el('span', { class: 'builder-slot-label', text: `${catEmoji(slot)} ${catLabel(slot)}` }),
          el('b', { text: item.name }),
          el('span', { class: 'builder-sub',
            text: stats.wears === 0 ? 'never worn — give it a go'
              : stats.daysSince != null ? `last worn ${stats.daysSince === 0 ? 'today' : `${stats.daysSince}d ago`}`
              : `${stats.wears} wears` })),
        swatch ? el('i', { class: 'mini-dot', style: { background: swatch } }) : null),
      lockBtn);
    row.querySelector('.builder-main').addEventListener('click', () => swapSlot(slot));
    return row;
  }

  function emptyRow(slot) {
    const row = el('button', { class: 'builder-row empty' },
      el('span', { class: 'builder-empty-icon', text: catEmoji(slot) }),
      el('span', { class: 'grow', text: `Add ${catLabel(slot).toLowerCase()}` }),
      icon('plus'));
    row.addEventListener('click', () => swapSlot(slot));
    return row;
  }

  /** Manual override: pick any item of that category (or clear the slot). */
  async function swapSlot(slot) {
    const pool = store.items().filter((i) => i.category === slot);
    if (!pool.length) return toast(`No ${catLabel(slot).toLowerCase()} tagged yet`);
    await sheet({
      title: catLabel(slot),
      actions: [
        ...(picks[slot] ? [{
          label: 'Remove from this outfit', icon: 'x', danger: true,
          onPick: () => { delete picks[slot]; delete locked[slot]; render(); },
        }] : []),
        ...pool.slice(0, 30).map((item) => {
          const s = itemStats(item);
          return {
            label: `${picks[slot]?.id === item.id ? '✓ ' : ''}${item.name}`,
            sub: s.wears ? `${s.wears} wears · last ${s.daysSince}d ago` : 'never worn',
            icon: 'grid',
            onPick: () => {
              picks[slot] = item;
              locked[slot] = item; // a deliberate choice stays put
              render();
            },
          };
        }),
      ],
    });
  }

  shuffleBtn.addEventListener('click', shuffle);

  wearBtn.addEventListener('click', () => {
    const ids = Object.values(picks).filter(Boolean).map((i) => i.id);
    if (!ids.length) return toast('Shuffle up an outfit first ✨');
    close();
    openCapture({ items: ids });
  });

  shuffle();
}
