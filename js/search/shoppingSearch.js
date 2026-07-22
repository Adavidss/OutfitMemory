/**
 * shoppingSearch.js — retailer search links.
 *
 * No retailer APIs, no affiliate tags, no tracking, no keys: each entry is
 * just that site's public search URL with the query string appended. The
 * link is opened by the user in a new tab, so nothing about the outfit is
 * transmitted anywhere until they deliberately click.
 */

export const RETAILERS = [
  {
    id: 'google',
    name: 'Google Shopping',
    emoji: '🔎',
    url: (q) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`,
  },
  {
    id: 'amazon',
    name: 'Amazon',
    emoji: '📦',
    url: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  },
  {
    id: 'ebay',
    name: 'eBay',
    emoji: '🏷️',
    url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  },
  {
    id: 'grailed',
    name: 'Grailed',
    emoji: '👔',
    url: (q) => `https://www.grailed.com/shop?query=${encodeURIComponent(q)}`,
  },
  {
    id: 'depop',
    name: 'Depop',
    emoji: '🧵',
    url: (q) => `https://www.depop.com/search/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'poshmark',
    name: 'Poshmark',
    emoji: '💃',
    url: (q) => `https://poshmark.com/search?query=${encodeURIComponent(q)}`,
  },
];

/** Second-hand-first ordering, for people shopping used. */
export const RESALE_IDS = new Set(['grailed', 'depop', 'poshmark', 'ebay']);

export function searchUrl(retailerId, query) {
  const r = RETAILERS.find((x) => x.id === retailerId);
  return r ? r.url(query) : null;
}
