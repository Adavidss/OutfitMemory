/**
 * queryBuilder.js — attributes → a shopping phrase worth searching.
 *
 * The difference between a useful search and a useless one is specificity:
 * "green shirt" returns a million results, "olive oversized linen
 * button-up shirt" returns the thing you're actually looking for. So we
 * stack confident modifiers in the order a shopper would say them and drop
 * anything the model wasn't sure about — a wrong adjective is worse than a
 * missing one, because it filters out the right results.
 */

/** Adjective order that reads naturally in English retail search. */
const ORDER = ['color', 'fit', 'pattern', 'material', 'sleeve', 'neckline', 'garment'];

/** Modifiers that would be redundant next to certain garments. */
const REDUNDANT = [
  [/hoodie|hooded sweatshirt/i, 'neckline', /hooded/i],
  [/turtleneck/i, 'neckline', /turtleneck/i],
  [/jeans|denim shorts|denim jacket/i, 'material', /denim/i],
  [/leather jacket|leather boots/i, 'material', /leather/i],
  [/tank top|sleeveless/i, 'sleeve', /sleeveless/i],
  [/t-shirt/i, 'sleeve', /short sleeve/i],
  [/long-sleeve t-shirt/i, 'sleeve', /long sleeve/i],
];

/**
 * buildQuery({ color, attributes, brand }) → { text, parts, dropped }
 * `attributes` is the array from clothingParser.buildAttributes().
 */
export function buildQuery({ color = '', attributes = [], brand = '' } = {}) {
  const byKey = Object.fromEntries(attributes.map((a) => [a.key, a]));
  const garment = byKey.garment?.label || 'clothing';

  const parts = [];
  const dropped = [];

  for (const key of ORDER) {
    if (key === 'garment') { parts.push({ key, label: garment }); continue; }
    if (key === 'color') {
      if (color) parts.push({ key, label: color });
      continue;
    }
    const attr = byKey[key];
    if (!attr) continue;
    if (!attr.used) { dropped.push({ ...attr, reason: 'low confidence' }); continue; }

    // Skip modifiers already implied by the garment word.
    const redundant = REDUNDANT.some(([gRe, k, lRe]) =>
      k === key && gRe.test(garment) && lRe.test(attr.label));
    if (redundant) { dropped.push({ ...attr, reason: 'implied by garment' }); continue; }

    parts.push({ key, label: attr.label });
  }

  // "regular fit"/"solid" style filler adds nothing to a search box.
  const words = parts.map((p) => p.label);
  if (brand) words.unshift(brand);

  return {
    text: dedupeWords(words.join(' ')).trim(),
    parts,
    dropped,
  };
}

/** Collapse repeated words ("denim denim jacket" → "denim jacket"). */
function dedupeWords(s) {
  const seen = new Set();
  return s
    .split(/\s+/)
    .filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(' ');
}

/**
 * Alternative phrasings, ranked. Gives the user a broader and a narrower
 * option than the default without making them retype anything.
 */
export function alternativeQueries({ color = '', attributes = [], primary = '' } = {}) {
  const byKey = Object.fromEntries(attributes.map((a) => [a.key, a]));
  const garment = byKey.garment?.label || 'clothing';
  const out = [];

  // Broader: colour + garment only.
  const broad = dedupeWords([color, garment].filter(Boolean).join(' '));
  if (broad && broad !== primary) out.push({ text: broad, kind: 'Broader' });

  // Runner-up garment, when the model wasn't certain what it was.
  const alt = byKey.garment?.alternatives?.[0];
  if (alt && byKey.garment.confidence < 0.75) {
    const q = buildQuery({ color, attributes: attributes.map((a) =>
      a.key === 'garment' ? { ...a, label: alt.label } : a) }).text;
    if (q !== primary) out.push({ text: q, kind: `If it's a ${alt.label}` });
  }

  // Narrower: add the style descriptor back in.
  const style = byKey.style;
  if (style && primary) {
    const q = dedupeWords(`${primary} ${style.label}`);
    if (q !== primary) out.push({ text: q, kind: 'More specific' });
  }

  return out.slice(0, 3);
}
