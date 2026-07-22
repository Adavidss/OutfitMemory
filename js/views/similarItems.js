/**
 * similarItems.js — the "Find Similar Items" dialog.
 *
 * Shows what the on-device model thinks each garment is, the shopping
 * phrase built from that, and one-tap searches at each retailer. The
 * phrase is editable, and edits drive every link — the model's guess is a
 * starting point, not a verdict.
 *
 * Results are saved into the outfit's metadata, so re-opening is instant
 * and inference only ever runs once per outfit.
 */

import { store } from '../store.js';
import { el, openOverlay, toast, sheet, confirmDialog } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { catLabel, catEmoji } from '../wardrobe.js';
import { analyzeOutfit, inferenceSupport, hasWebGPU, MODEL_REGISTRY } from '../models/fashionModel.js';
import { buildQuery, alternativeQueries } from '../search/queryBuilder.js';
import { RETAILERS } from '../search/shoppingSearch.js';
import { guessSeason } from '../utils/clothingParser.js';

export function openSimilarItems(entryId) {
  const entry = store.entryById(entryId);
  if (!entry) return;

  const body = el('div', { class: 'sim-body' });
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
  const root = el('div', { class: 'lightbox' },
    el('div', { class: 'lb-top' },
      closeBtn,
      el('div', { class: 'lb-title' },
        el('b', { text: 'Find similar items' }),
        el('span', { text: 'Analyzed on your device' })),
      el('span', { class: 'icon-btn-spacer' })),
    body);

  const { close } = openOverlay(root, { variant: 'full' });
  closeBtn.addEventListener('click', close);

  const saved = entry.shopping;
  if (saved?.results?.length) renderResults(body, entry, saved, close);
  else renderIntro(body, entry, close);
}

/* ---------- intro / consent ---------- */

function renderIntro(body, entry, close) {
  const support = inferenceSupport();

  if (!support.ok) {
    body.replaceChildren(el('div', { class: 'empty' },
      el('div', { class: 'empty-art' }, icon('info')),
      el('h2', { text: 'Not supported in this browser' }),
      el('p', { text: `${support.reasons.join(' ')} Try a recent Chrome, Edge, Firefox or Safari — nothing else about OutfitMemory is affected.` })));
    return;
  }

  const runBtn = el('button', { class: 'btn btn-hero btn-block' }, icon('sparkles'), 'Analyze this outfit');
  runBtn.addEventListener('click', () => runAnalysis(body, entry, close));

  body.replaceChildren(
    el('div', { class: 'sim-intro' },
      el('div', { class: 'empty-art' }, icon('search')),
      el('h2', { text: 'What am I wearing?' }),
      el('p', { text: 'A clothing model runs right here in your browser to describe each piece, then builds shopping searches you can run at any store.' }),
      el('ul', { class: 'ob-points' },
        point('🔒', 'Your photo never leaves this device',
          'The model is downloaded to your browser and runs locally. Nothing is uploaded — not the photo, not the results.'),
        point('📦', `One-time download, about ${hasWebGPU() ? '165' : '85'} MB`,
          `${MODEL_REGISTRY[0].label} is cached afterwards, so later outfits take a second or two and work offline.`),
        point('⚡', hasWebGPU() ? 'WebGPU acceleration available' : 'Runs on WebAssembly',
          hasWebGPU() ? 'Your browser can run this on the GPU.' : 'Your browser has no WebGPU, so it will use the CPU — slower, but it works.')),
      runBtn));
}

function point(emoji, title, sub) {
  return el('li', {},
    el('span', { class: 'ob-emoji', text: emoji }),
    el('span', {}, el('b', { text: title }), el('span', { text: sub })));
}

/* ---------- progress ---------- */

const PHASE_TEXT = {
  library: 'Loading inference runtime…',
  device: 'Initializing…',
  tokenizer: 'Loading tokenizer…',
  vision: 'Downloading clothing model…',
  text: 'Preparing clothing vocabulary…',
  analyze: 'Analyzing clothing…',
};

async function runAnalysis(body, entry, close) {
  const label = el('div', { class: 'sim-phase', text: 'Starting…' });
  const detail = el('div', { class: 'sim-detail', text: 'First run downloads the model — later outfits skip this.' });
  const bar = el('i');
  const track = el('div', { class: 'sim-bar' }, bar);

  body.replaceChildren(el('div', { class: 'sim-loading' },
    el('div', { class: 'spinner' }), label, track, detail));

  const onProgress = (p) => {
    label.textContent = PHASE_TEXT[p.phase] || p.detail || 'Working…';
    if (p.detail) detail.textContent = p.detail;
    if (typeof p.pct === 'number') {
      const pct = p.pct > 1 ? p.pct : p.pct * 100;
      track.classList.add('has-value');
      bar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    } else {
      track.classList.remove('has-value');
    }
  };

  try {
    const { results, model } = await analyzeOutfit(entry, onProgress);
    const payload = {
      results,
      model: model.label,
      modelId: model.id,
      device: model.device,
      analyzedAt: new Date().toISOString(),
    };
    // Cache on the outfit so this never runs twice for the same photo.
    await store.updateOutfit(entry.id, { shopping: payload });
    renderResults(body, store.entryById(entry.id), payload, close);
  } catch (err) {
    renderError(body, entry, close, err);
  }
}

function renderError(body, entry, close, err) {
  const retry = el('button', { class: 'btn btn-primary' }, icon('refresh'), 'Try again');
  retry.addEventListener('click', () => runAnalysis(body, entry, close));
  body.replaceChildren(el('div', { class: 'empty' },
    el('div', { class: 'empty-art' }, icon('info')),
    el('h2', { text: 'Couldn’t analyze this outfit' }),
    el('p', { text: err?.message || 'The clothing model failed to load.' }),
    el('p', { class: 'set-note', text: 'This usually means the model download was interrupted. Your photos and wardrobe are unaffected.' }),
    retry));
}

/* ---------- results ---------- */

function renderResults(body, entry, payload, close) {
  body.replaceChildren();

  const redo = el('button', { class: 'link-btn', text: 'Re-analyze' });
  redo.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Analyze again?',
      body: 'Runs the model over this outfit once more and replaces the saved descriptions. Any edits you made will be lost.',
      okLabel: 'Re-analyze',
    });
    if (ok) runAnalysis(body, entry, close);
  });

  body.append(el('div', { class: 'sim-meta' },
    el('span', { text: `${payload.model} · ${payload.device === 'webgpu' ? 'WebGPU' : 'WASM'} · on-device` }),
    redo));

  for (const result of payload.results) body.append(garmentCard(entry, payload, result));

  body.append(el('p', { class: 'set-note',
    text: 'Descriptions are generated by a model and can be wrong — edit any of them before searching. Search links open the retailer’s own search page; OutfitMemory sends them nothing but the words you see here.' }));
}

function garmentCard(entry, payload, result) {
  const { slot, attributes = [], color } = result;
  const q = buildQuery({ color, attributes });
  // An edited phrase wins over the freshly-built one.
  let query = result.query || q.text;

  const garment = attributes.find((a) => a.key === 'garment');
  const confidence = garment ? Math.round(garment.confidence * 100) : null;

  /* thumbnail */
  const thumb = el('img', { class: 'sim-thumb', alt: '' });
  if (result.itemId) {
    const item = store.itemById(result.itemId);
    if (item) store.itemThumbURL(item).then((u) => { if (u) thumb.src = u; });
  } else {
    store.thumbURL(entry).then((u) => { if (u) thumb.src = u; });
  }

  /* attribute chips */
  const chips = el('div', { class: 'sim-chips' },
    color ? el('span', { class: 'sim-chip' },
      el('i', { class: 'mini-dot', style: { background: NAME_HEX[color] || result.hex || '#999' } }),
      color) : null,
    attributes
      .filter((a) => a.key !== 'garment' && a.used)
      .map((a) => el('span', { class: 'sim-chip', text: a.label })),
    el('span', { class: 'sim-chip subtle', text: guessSeason(attributes) }));

  /* low-confidence hint */
  const alt = garment?.alternatives?.[0];
  const hint = garment && garment.confidence < 0.6 && alt
    ? el('p', { class: 'sim-hint', text: `This may also be ${withArticle(alt.label)}.` })
    : null;

  /* editable query */
  const input = el('input', {
    class: 'sim-query', type: 'text', value: query,
    'aria-label': `Search phrase for ${catLabel(slot)}`,
  });
  const links = el('div', { class: 'sim-retailers' });

  const renderLinks = () => {
    links.replaceChildren(...RETAILERS.map((r) =>
      el('a', {
        class: 'sim-retailer', href: r.url(query),
        target: '_blank', rel: 'noopener noreferrer',
      }, el('span', { text: r.emoji }), r.name)));
  };

  let saveTimer;
  input.addEventListener('input', () => {
    query = input.value.trim() || q.text;
    renderLinks();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistQuery(entry, payload, slot, result.itemId, query), 600);
  });
  renderLinks();

  const copyBtn = el('button', { class: 'btn btn-sm' }, icon('check'), 'Copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(query);
      toast('Search phrase copied ✓');
    } catch {
      input.select();
      toast('Press ⌘/Ctrl + C to copy');
    }
  });

  /* alternative phrasings */
  const alts = alternativeQueries({ color, attributes, primary: query });
  const altRow = alts.length
    ? el('div', { class: 'sim-alts' }, alts.map((a) => {
        const b = el('button', { class: 'chip', title: a.kind }, a.text);
        b.addEventListener('click', () => {
          input.value = a.text;
          input.dispatchEvent(new Event('input'));
        });
        return b;
      }))
    : null;

  return el('div', { class: 'sim-card' },
    el('div', { class: 'sim-head' },
      thumb,
      el('div', { class: 'grow' },
        el('span', { class: 'sim-slot', text: `${catEmoji(slot)} ${catLabel(slot)}` }),
        el('b', { class: 'sim-name', text: garment?.label || 'clothing' }),
        confidence != null
          ? el('span', { class: `sim-conf${confidence < 60 ? ' low' : ''}`,
              text: `Confidence: ${confidence}%` })
          : null)),
    hint,
    chips,
    el('div', { class: 'sim-query-row' }, input, copyBtn),
    altRow,
    links);
}

/**
 * "a hoodie" / "an oxford shirt" / "jeans" — garment names like trousers
 * and sneakers are already plural and take no article.
 */
function withArticle(label) {
  if (/(s|shorts|jeans|chinos)$/i.test(label) && !/dress|blouse$/i.test(label)) return label;
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** Persist an edited phrase back into the outfit's metadata. */
async function persistQuery(entry, payload, slot, itemId, query) {
  const next = {
    ...payload,
    results: payload.results.map((r) =>
      (r.slot === slot && r.itemId === itemId) ? { ...r, query } : r),
  };
  Object.assign(payload, next);
  await store.updateOutfit(entry.id, { shopping: next });
}
