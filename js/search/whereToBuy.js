/**
 * whereToBuy.js — optional online item lookup through the user's OWN
 * Gemini API key (free tier from Google AI Studio).
 *
 * This is the one feature that sends image data off the device, and it is
 * built so that can only happen deliberately:
 *   • It does nothing — and its buttons don't even render — until the user
 *     pastes their own key in Settings, next to a plain-language warning.
 *   • Only the tight ITEM CROP is sent, never the full outfit photo.
 *   • The key lives in localStorage on this device. It is not part of
 *     metadata.json, so exports/backups/mirrors never contain it.
 *
 * Grounding: the request enables Gemini's google_search tool, so the
 * response carries real, non-hallucinated web sources; those become the
 * "possible purchase links". Identification text comes from the model.
 * gemini-2.5-flash's free tier includes both image input and search
 * grounding at personal-use volumes.
 */

import { store } from '../store.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

export const hasGeminiKey = () => !!(store.settings.geminiKey || '').trim();

/** Very light shape check so obvious paste accidents fail fast. */
export function looksLikeGeminiKey(k) {
  return /^AIza[0-9A-Za-z_-]{20,}$/.test((k || '').trim());
}

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * identifyItem(cropBlob, hints) → {
 *   text,            // model's identification (name, brand if visible, terms)
 *   links: [{title, uri}],   // grounded web sources — real URLs
 *   queries: [string],       // the searches the model actually ran
 * }
 * Throws Error with a user-readable message on failure.
 */
export async function identifyItem(cropBlob, hints = {}) {
  const key = (store.settings.geminiKey || '').trim();
  if (!key) throw new Error('No API key configured.');

  const parts = [
    {
      text:
        'Identify this clothing item for shopping purposes. ' +
        (hints.name ? `The owner calls it "${hints.name}". ` : '') +
        (hints.color ? `Its dominant color is ${hints.color}. ` : '') +
        'Reply in at most 4 short lines: ' +
        '1) what it is (cut/style/material if visible), ' +
        '2) brand or likely brand ONLY if a logo or distinctive design is visible, otherwise say "brand not identifiable", ' +
        '3) one strong shopping search phrase, ' +
        '4) an alternate cheaper-search phrase. ' +
        'Then use Google Search to find where this item or close matches can be bought online.',
    },
    { inline_data: { mime_type: cropBlob.type || 'image/webp', data: await blobToBase64(cropBlob) } },
  ];

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });
  } catch {
    throw new Error('Could not reach the Gemini API — are you online?');
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error('Gemini rejected the API key. Check it in Settings → Online item search.');
    }
    if (res.status === 429) {
      throw new Error('Free-tier quota reached for now — try again later.');
    }
    throw new Error(`Gemini error ${res.status}.`);
  }

  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  const gm = cand?.groundingMetadata || {};
  const seen = new Set();
  const links = (gm.groundingChunks || [])
    .map((c) => c.web)
    .filter(Boolean)
    .filter((w) => {
      const k = w.title || w.uri;
      if (!w.uri || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((w) => ({ title: w.title || 'source', uri: w.uri }))
    .slice(0, 8);

  return {
    text: text || 'No description returned.',
    links,
    queries: gm.webSearchQueries || [],
  };
}
