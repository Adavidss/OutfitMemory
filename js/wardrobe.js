/**
 * wardrobe.js — the optional clothing layer: analytics + the outfit
 * recombination engine. Pure logic over store data; no DOM.
 *
 * Everything here is derived from two facts the photo journal already
 * knows: which items are in an outfit, and when that outfit was worn.
 * That's what lets OutfitMemory answer things a shopping app can't —
 * real cost-per-wear, what you've actually stopped wearing, and which
 * combinations you keep coming back to.
 */

import { store } from './store.js';
import { todayStr, parseDate } from './util/dates.js';

/** Wardrobe slots. `rank` orders an outfit head-to-toe. */
export const CATEGORIES = [
  { id: 'outerwear', label: 'Outerwear', rank: 0, emoji: '🧥' },
  { id: 'top', label: 'Top', rank: 1, emoji: '👕' },
  { id: 'dress', label: 'Dress / one-piece', rank: 1, emoji: '👗' },
  { id: 'bottom', label: 'Bottom', rank: 2, emoji: '👖' },
  { id: 'shoes', label: 'Shoes', rank: 3, emoji: '👟' },
  { id: 'accessory', label: 'Accessory', rank: 4, emoji: '🧢' },
];

export const catLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || 'Item';
export const catEmoji = (id) => CATEGORIES.find((c) => c.id === id)?.emoji || '👕';
const catRank = (id) => CATEGORIES.find((c) => c.id === id)?.rank ?? 9;

/** Colors that go with anything — the backbone of the harmony score. */
const NEUTRALS = new Set(['black', 'white', 'gray', 'beige', 'navy', 'brown']);

/* ---------- small helpers ---------- */

/**
 * Only ever hand an http(s) URL to an <a href>. A stored "javascript:" or
 * "data:" link would otherwise run in the app's own origin when tapped.
 */
export function safeUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Hostname for display ("uniqlo.com"), or null. */
export function linkHost(raw) {
  const safe = safeUrl(raw);
  if (!safe) return null;
  try { return new URL(safe).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function formatPrice(amount, currency = 'USD') {
  if (!Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function daysBetween(fromDate, toDate = todayStr()) {
  if (!fromDate) return null;
  return Math.max(0, Math.round((parseDate(toDate) - parseDate(fromDate)) / 86400e3));
}

/* ---------- per-item stats ---------- */

/**
 * itemStats(item) → { wears, lastWorn, daysSince, costPerWear, firstWorn }
 * Wears are counted from the photo log, so they're real, not self-reported.
 */
export function itemStats(item) {
  const worn = store.entriesWithItem(item.id); // newest first
  const wears = worn.length;
  const lastWorn = worn[0]?.date || null;
  const firstWorn = worn[wears - 1]?.date || null;
  const costPerWear =
    Number.isFinite(item.price) && item.price > 0 && wears > 0 ? item.price / wears : null;
  return {
    wears,
    lastWorn,
    firstWorn,
    daysSince: daysBetween(lastWorn),
    costPerWear,
    entries: worn,
  };
}

/** Items most often worn alongside `id`, most frequent first. */
export function pairsWith(id, limit = 4) {
  const counts = new Map();
  for (const e of store.entriesWithItem(id)) {
    for (const other of e.items || []) {
      if (other !== id) counts.set(other, (counts.get(other) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([itemId, n]) => ({ item: store.itemById(itemId), n }))
    .filter((x) => x.item);
}

/**
 * Closet insights — recommendations drawn from the user's own wardrobe
 * rather than a shop. Each returns [] when there isn't enough data.
 */
export function insights() {
  const items = store.items().map((item) => ({ item, ...itemStats(item) }));

  const bestValue = items
    .filter((x) => x.costPerWear != null && x.wears >= 3)
    .sort((a, b) => a.costPerWear - b.costPerWear)
    .slice(0, 3);

  // Worn once or twice but expensive — the "was it worth it?" list.
  const worstValue = items
    .filter((x) => x.costPerWear != null && x.wears <= 2)
    .sort((a, b) => b.costPerWear - a.costPerWear)
    .slice(0, 3);

  const dusty = items
    .filter((x) => x.wears === 0 || (x.daysSince != null && x.daysSince >= 60))
    .sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999))
    .slice(0, 6);

  const mostWorn = items.filter((x) => x.wears > 0).sort((a, b) => b.wears - a.wears).slice(0, 3);

  const totalValue = items.reduce(
    (sum, x) => sum + (Number.isFinite(x.item.price) ? x.item.price : 0), 0);
  const priced = items.filter((x) => Number.isFinite(x.item.price)).length;

  return { bestValue, worstValue, dusty, mostWorn, totalValue, priced, count: items.length };
}

/* ---------- the recombination engine ---------- */

/**
 * Rediscovery weight: long-unworn and never-worn items float up.
 * Compressed with a square root so a piece you skipped for a year doesn't
 * out-shout one you skipped for a month — past a point, forgotten is
 * forgotten, and the shuffle should still feel varied.
 */
function freshnessScore(stats) {
  if (stats.wears === 0) return 45;              // new, but not an auto-win
  return Math.min(70, 11 * Math.sqrt(stats.daysSince ?? 81));
}

/** Neutral-anchored harmony: neutrals pair with anything, matching hues rhyme. */
function harmonyScore(item, picked) {
  const others = picked.filter(Boolean);
  if (!others.length) return 0;
  let score = 0;
  for (const o of others) {
    if (!item.color || !o.color) continue;
    if (NEUTRALS.has(item.color) || NEUTRALS.has(o.color)) score += 12;
    else if (item.color === o.color) score += 8;   // deliberate monochrome
    else score -= 4;                               // two loud colors: allowed, not favored
  }
  return score / others.length;
}

/**
 * Weighted pick — higher scores win more often, but nothing is impossible.
 * The generous offset and gentle exponent keep the favourite around 3–4×
 * likelier than an also-ran; squaring raw scores made shuffle repeat itself.
 */
function weightedPick(scored) {
  if (!scored.length) return null;
  const floor = Math.min(...scored.map((s) => s.score));
  const weights = scored.map((s) => (s.score - floor + 20) ** 1.25);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < scored.length; i++) {
    r -= weights[i];
    if (r <= 0) return scored[i].item;
  }
  return scored[scored.length - 1].item;
}

/** Signature of a set of item ids, for "did I just wear this?" checks. */
const comboKey = (ids) => [...ids].sort().join('|');

/**
 * suggestOutfit({ locked }) → { picks: {slot: item}, ids: [] }
 *
 * Builds a head-to-toe combination out of tagged items, favoring pieces
 * you haven't worn lately and colors that sit well together, and avoiding
 * anything you literally wore in the last three weeks. `locked` maps a
 * category to an item the user pinned; those are kept as-is.
 */
export function suggestOutfit({ locked = {} } = {}) {
  const all = store.items();
  const byCat = (cat) => all.filter((i) => i.category === cat);
  const statCache = new Map();
  const statsOf = (item) => {
    if (!statCache.has(item.id)) statCache.set(item.id, itemStats(item));
    return statCache.get(item.id);
  };

  // Combos worn recently — avoid suggesting today what you wore last week.
  const recent = new Set(
    store.entries()
      .filter((e) => (daysBetween(e.date) ?? 999) <= 21 && (e.items || []).length >= 2)
      .map((e) => comboKey(e.items))
  );

  /**
   * Every slot that has items is fair game — nothing is mutually
   * exclusive. A dress usually stands in for a top, but "dress over
   * trousers" and other layered combinations are real outfits, so the
   * engine keeps a chance of producing them rather than forbidding them.
   * Outerwear and accessories stay optional garnish.
   */
  const OPTIONAL = new Set(['outerwear', 'accessory']);
  const SLOTS = ['outerwear', 'dress', 'top', 'bottom', 'shoes', 'accessory'];

  const build = () => {
    const picks = {};
    for (const slot of SLOTS) {
      if (locked[slot]) { picks[slot] = locked[slot]; continue; }
      const pool = byCat(slot);
      if (!pool.length) continue;
      if (OPTIONAL.has(slot) && Math.random() < 0.45) continue;

      // A dress is worn sometimes rather than every time, and when one is
      // in play a separate top is usually (not always) redundant.
      if (slot === 'dress' && !locked.dress) {
        const hasSeparates = byCat('top').length && byCat('bottom').length;
        if (hasSeparates && Math.random() > 0.3) continue;
      }
      if (slot === 'top' && picks.dress && Math.random() < 0.8) continue;

      const chosen = Object.values(picks);
      const scored = pool.map((item) => ({
        item,
        score: freshnessScore(statsOf(item)) + harmonyScore(item, chosen) + Math.random() * 18,
      }));
      picks[slot] = weightedPick(scored);
    }
    return picks;
  };

  // A few attempts to dodge a recently-worn combination, then accept.
  let picks = build();
  for (let attempt = 0; attempt < 6; attempt++) {
    const ids = Object.values(picks).filter(Boolean).map((i) => i.id);
    if (ids.length < 2 || !recent.has(comboKey(ids))) break;
    picks = build();
  }

  const ordered = Object.values(picks)
    .filter(Boolean)
    .sort((a, b) => catRank(a.category) - catRank(b.category));

  return { picks, items: ordered, ids: ordered.map((i) => i.id) };
}

/**
 * Enough tagged to be worth shuffling? Deliberately permissive: any two
 * owned pieces make a combination worth looking at. Requiring a specific
 * pairing (top + bottom) locked people out of perfectly valid wardrobes.
 */
export function canSuggest() {
  return store.items(false).length >= 2;
}
