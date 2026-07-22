/**
 * shareOutfit.js — share a combination of wardrobe items.
 *
 * An outfit is a picture *and* a list of things: what each piece is, the
 * brand, what it cost. The picture alone can't be pasted into a message or
 * searched later, so both are offered — together where the platform
 * supports it, separately where it doesn't.
 *
 * Everything is composed locally; nothing leaves the device unless the
 * user picks a destination in the system share sheet.
 */

import { buildOutfitCard, outfitSummary } from '../shareCard.js';
import { el, sheet, toast } from '../ui/dom.js';

/** Save a blob to disk (fallback when file sharing isn't available). */
function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function shareBoth(items, title) {
  const text = outfitSummary(items, title);
  let blob;
  try {
    blob = await buildOutfitCard(items, title);
  } catch {
    return shareText(items, title);
  }
  const file = new File([blob], 'outfit.png', { type: 'image/png' });

  try {
    // Card + details in one share where the platform allows both.
    if (navigator.canShare?.({ files: [file], text })) {
      await navigator.share({ files: [file], text, title });
      return;
    }
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // user dismissed the sheet
  }

  download(blob, 'outfit.png');
  toast('Outfit card saved ✓');
}

async function shareText(items, title) {
  const text = outfitSummary(items, title);
  try {
    if (navigator.share) {
      await navigator.share({ text, title });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  await copyText(text);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Outfit details copied ✓');
  } catch {
    toast('Could not copy — try sharing instead');
  }
}

/**
 * shareOutfit(items, title) — offers the card, the written details, or a
 * copy of the details. Falls straight through to a download / clipboard
 * when the browser has no share sheet.
 */
export async function shareOutfit(items, title = 'Outfit idea') {
  const list = (items || []).filter(Boolean);
  if (!list.length) return toast('Nothing to share yet');

  await sheet({
    title: 'Share outfit',
    actions: [
      {
        label: 'Card + details', icon: 'share',
        sub: 'Picture of the pieces, with names and prices',
        onPick: () => shareBoth(list, title),
      },
      {
        label: 'Details only', icon: 'tag',
        sub: 'Just the written list — easy to paste anywhere',
        onPick: () => shareText(list, title),
      },
      {
        label: 'Copy details', icon: 'check',
        onPick: () => copyText(outfitSummary(list, title)),
      },
    ],
  });
}
