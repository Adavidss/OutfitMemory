/**
 * clothingParser.js — the fashion vocabulary, and how raw model scores
 * become readable clothing attributes.
 *
 * FashionCLIP is a *zero-shot* model: it doesn't have a fixed list of
 * classes, it scores how well an image matches an arbitrary sentence. So
 * "recognition" here means scoring the crop against a curated list of
 * fashion phrases and keeping the best one per attribute axis.
 *
 * Each axis is scored independently — garment type, fit, material and so
 * on are separate softmaxes, which is why one can be confident while
 * another is a guess. Prompts are written the way image captions read
 * ("a photo of a …"), because that's the distribution CLIP was trained on.
 *
 * Colour deliberately does NOT come from the model: segment.js reads it
 * straight off the garment pixels, which is both more accurate and free.
 */

/** Garment vocabularies per wardrobe slot. */
const GARMENTS = {
  top: [
    't-shirt', 'long-sleeve t-shirt', 'polo shirt', 'button-up shirt', 'oxford shirt',
    'flannel shirt', 'blouse', 'sweater', 'knit sweater', 'cardigan', 'hoodie',
    'sweatshirt', 'turtleneck', 'tank top', 'crop top', 'henley shirt', 'jersey', 'vest',
  ],
  bottom: [
    'jeans', 'chinos', 'trousers', 'dress pants', 'cargo pants', 'joggers',
    'sweatpants', 'leggings', 'shorts', 'denim shorts', 'cargo shorts',
    'skirt', 'mini skirt', 'midi skirt', 'maxi skirt',
  ],
  outerwear: [
    'denim jacket', 'leather jacket', 'bomber jacket', 'blazer', 'trench coat',
    'overcoat', 'parka', 'puffer jacket', 'windbreaker', 'raincoat', 'peacoat',
    'fleece jacket', 'varsity jacket',
  ],
  shoes: [
    'sneakers', 'running shoes', 'canvas sneakers', 'leather boots', 'chelsea boots',
    'combat boots', 'loafers', 'dress shoes', 'sandals', 'heels', 'ballet flats', 'mules',
  ],
  dress: [
    'sundress', 'maxi dress', 'midi dress', 'mini dress', 'wrap dress',
    'shirt dress', 'slip dress', 'cocktail dress', 'jumpsuit', 'romper',
  ],
  accessory: [
    'baseball cap', 'beanie', 'bucket hat', 'scarf', 'belt', 'tote bag',
    'backpack', 'crossbody bag', 'sunglasses', 'watch', 'necklace',
  ],
};

const PATTERNS = [
  'solid', 'striped', 'plaid', 'checked', 'floral', 'polka dot',
  'camouflage', 'graphic print', 'tie-dye', 'animal print', 'houndstooth',
];

const MATERIALS = [
  'cotton', 'denim', 'leather', 'linen', 'wool', 'knit', 'fleece',
  'corduroy', 'silk', 'satin', 'suede', 'nylon', 'cashmere',
];

const FITS = [
  'oversized', 'relaxed fit', 'regular fit', 'slim fit',
  'fitted', 'baggy', 'cropped', 'boxy',
];

const STYLES = [
  'streetwear', 'casual', 'business casual', 'formal', 'athletic',
  'vintage', 'minimalist', 'techwear', 'preppy', 'bohemian', 'grunge',
];

const SLEEVES = ['short sleeve', 'long sleeve', 'sleeveless', 'three-quarter sleeve'];
const NECKLINES = ['crew neck', 'v-neck', 'turtleneck', 'collared', 'hooded', 'scoop neck'];

/** Axis definitions: which labels, how they're phrased, and where they apply. */
export const AXES = [
  {
    key: 'garment',
    labelsFor: (slot) => GARMENTS[slot] || GARMENTS.top,
    prompt: (l) => `a photo of a ${l}`,
    required: true,
  },
  {
    key: 'pattern',
    labels: PATTERNS,
    prompt: (l) => `a photo of ${l} patterned clothing`,
    // "solid" is the default; only worth mentioning when it's something else.
    omitWhen: (l) => l === 'solid',
    minConfidence: 0.35,
  },
  {
    key: 'material',
    labels: MATERIALS,
    prompt: (l) => `a photo of a garment made of ${l}`,
    minConfidence: 0.32,
  },
  {
    key: 'fit',
    labels: FITS,
    prompt: (l) => `a photo of ${l} clothing`,
    omitWhen: (l) => l === 'regular fit',
    minConfidence: 0.3,
  },
  {
    key: 'sleeve',
    labels: SLEEVES,
    prompt: (l) => `a photo of a ${l} top`,
    appliesTo: ['top', 'dress', 'outerwear'],
    minConfidence: 0.4,
  },
  {
    key: 'neckline',
    labels: NECKLINES,
    prompt: (l) => `a photo of a top with a ${l}`,
    appliesTo: ['top', 'dress'],
    minConfidence: 0.4,
  },
  {
    key: 'style',
    labels: STYLES,
    prompt: (l) => `a photo of ${l} style clothing`,
    minConfidence: 0.28,
  },
];

/** Every distinct prompt the model needs to embed (order is stable). */
export function allPrompts() {
  const out = [];
  const seen = new Set();
  for (const axis of AXES) {
    const labelSets = axis.labels
      ? [axis.labels]
      : Object.keys(GARMENTS).map((slot) => axis.labelsFor(slot));
    for (const labels of labelSets) {
      for (const l of labels) {
        const p = axis.prompt(l);
        if (!seen.has(p)) { seen.add(p); out.push(p); }
      }
    }
  }
  return out;
}

/** A fingerprint of the vocabulary — invalidates cached text embeddings. */
export function vocabVersion() {
  const prompts = allPrompts();
  let h = 2166136261;
  for (const p of prompts.join('|')) {
    h ^= p.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return `v1-${prompts.length}-${(h >>> 0).toString(36)}`;
}

/** Which axes apply to a given wardrobe slot. */
export function axesFor(slot) {
  return AXES.filter((a) => !a.appliesTo || a.appliesTo.includes(slot));
}

/** Union of every garment label, with the wardrobe slot each belongs to. */
export function allGarments() {
  const out = [];
  for (const [slot, labels] of Object.entries(GARMENTS)) {
    for (const label of labels) out.push({ label, slot });
  }
  return out;
}

/** Labels for an axis in the context of a slot. */
export function labelsForAxis(axis, slot) {
  return axis.labels || axis.labelsFor(slot);
}

/**
 * Turn per-axis scored candidates into a tidy attribute set.
 * Each entry: { key, label, confidence, alternatives:[{label,confidence}] }
 */
export function buildAttributes(slot, scoresByAxis) {
  const out = [];
  for (const axis of axesFor(slot)) {
    const ranked = scoresByAxis[axis.key];
    if (!ranked?.length) continue;
    const [top, ...rest] = ranked;
    const drop = (axis.omitWhen && axis.omitWhen(top.label)) ||
      (axis.minConfidence && top.confidence < axis.minConfidence);
    out.push({
      key: axis.key,
      label: top.label,
      confidence: top.confidence,
      used: !drop && !(axis.required === undefined && drop),
      required: !!axis.required,
      alternatives: rest.slice(0, 2),
    });
  }
  return out;
}

/**
 * Rough season from what the garment is made of and what it is. Cheap
 * heuristic rather than another model pass — it's a hint, not a claim.
 */
export function guessSeason(attrs) {
  const g = attrs.find((a) => a.key === 'garment')?.label || '';
  const m = attrs.find((a) => a.key === 'material')?.label || '';
  const warm = /coat|parka|puffer|fleece|wool|cashmere|sweater|beanie|scarf|corduroy|boots/i;
  const cool = /linen|tank|shorts|sandals|sundress|crop top|silk/i;
  if (warm.test(`${g} ${m}`)) return 'fall / winter';
  if (cool.test(`${g} ${m}`)) return 'spring / summer';
  return 'all season';
}
