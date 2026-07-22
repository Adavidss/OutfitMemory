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

/**
 * Candidate models, tried in order. Model ids churn, so a 404/NOT_FOUND on
 * one simply moves to the next rather than presenting the user with a dead
 * feature. The first one that answers is remembered for the session.
 */
const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
let workingModel = null;

export const hasGeminiKey = () => !!(store.settings.geminiKey || '').trim();

/**
 * Shape check only — deliberately NOT prefix-based.
 *
 * Google has issued at least two key formats ("AIza…" and the newer
 * "AQ.…"), and hard-coding either one rejects perfectly valid keys. The
 * only reliable validator is the API itself, so this just catches obvious
 * paste accidents (empty, whitespace, a pasted URL) and lets the request
 * be the real test.
 */
export function looksLikeGeminiKey(k) {
  const s = (k || '').trim();
  return s.length >= 20 && !/\s/.test(s) && /^[A-Za-z0-9._~+/-]+=*$/.test(s);
}

/**
 * POST to generateContent, walking MODELS until one exists. Translates
 * transport and HTTP failures into messages a user can act on.
 * Returns the parsed JSON body.
 */
async function callGemini(key, body, { signal } = {}) {
  const order = workingModel ? [workingModel, ...MODELS.filter((m) => m !== workingModel)] : MODELS;
  let lastNotFound = null;

  for (const model of order) {
    let res;
    try {
      res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new Error('Could not reach the Gemini API — are you online?');
    }

    if (res.ok) {
      workingModel = model;
      return res.json();
    }

    // Read the server's own explanation; it's far more useful than a code.
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* non-JSON error body */ }

    if (res.status === 404 || /not found|not supported/i.test(detail)) {
      lastNotFound = `${model}: ${detail || 'not found'}`;
      continue; // try the next model id
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Gemini rejected the API key. Check it in Settings → Online item search.');
    }
    if (res.status === 400) {
      throw new Error(
        /api key/i.test(detail)
          ? 'Gemini rejected the API key. Check it in Settings → Online item search.'
          : `Gemini rejected the request: ${detail || 'bad request'}`,
      );
    }
    if (res.status === 429) throw new Error('Free-tier quota reached for now — try again later.');
    throw new Error(`Gemini error ${res.status}${detail ? `: ${detail}` : ''}.`);
  }
  throw new Error(`No available Gemini model accepted the request (${lastNotFound || 'all 404'}).`);
}

/**
 * verifyKey(key) → { ok, model } — a tiny text-only ping used by Settings
 * so the user can confirm their key works without spending an image call
 * or wondering whether a later failure was the key or the photo.
 */
export async function verifyKey(key) {
  const k = (key || '').trim();
  if (!k) throw new Error('Enter a key first.');
  await callGemini(k, {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
    generationConfig: { maxOutputTokens: 512 },
  });
  return { ok: true, model: workingModel };
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

  const data = await callGemini(key, {
    contents: [{ role: 'user', parts }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });

  const cand = data?.candidates?.[0];
  // A safety block returns candidates with no content — say so plainly
  // rather than rendering an empty card.
  if (!cand || (cand.finishReason && cand.finishReason !== 'STOP' && !cand.content)) {
    const why = cand?.finishReason || data?.promptFeedback?.blockReason || 'no response';
    throw new Error(`Gemini returned nothing for this image (${why}).`);
  }
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  // Grounding chunks carry the real sources. Accept either shape the API
  // uses (`web` or `retrievedContext`) so a response-format change degrades
  // to "no links" rather than throwing.
  const gm = cand?.groundingMetadata || {};
  const seen = new Set();
  const links = (gm.groundingChunks || [])
    .map((c) => c?.web || c?.retrievedContext)
    .filter((w) => w?.uri)
    .filter((w) => {
      const k = w.title || w.uri;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((w) => ({ title: w.title || new URL(w.uri).hostname, uri: w.uri }))
    .slice(0, 8);

  return {
    text: text || 'No description returned.',
    links,
    queries: gm.webSearchQueries || [],
  };
}
