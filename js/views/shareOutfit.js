/**
 * shareOutfit.js — share a combination of wardrobe items as an image.
 *
 * Used by the outfit builder and by saved plans. The card is composed on a
 * canvas locally; it only goes anywhere if the user picks a destination in
 * the system share sheet. Browsers without file sharing get a download.
 */

import { buildOutfitCard } from '../shareCard.js';
import { el, toast } from '../ui/dom.js';

export async function shareOutfit(items, title = 'Outfit idea') {
  let blob;
  try {
    blob = await buildOutfitCard(items, title);
  } catch (err) {
    return toast(err?.message === 'nothing to share' ? 'Nothing to share yet' : 'Could not build the card');
  }

  const file = new File([blob], 'outfit.png', { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // user dismissed the share sheet
  }

  const a = el('a', { href: URL.createObjectURL(blob), download: 'outfit.png' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  toast('Outfit card saved ✓');
}
