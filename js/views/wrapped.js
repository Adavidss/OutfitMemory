/**
 * wrapped.js — "OutfitMemory Wrapped": a story-style, auto-advancing
 * yearly recap (big numbers, top month, palette, streak, collage).
 * Tap right to advance, left to go back, × or Esc to close.
 */

import { store } from '../store.js';
import { el, toast, openOverlay } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { fmtMonthYear, computeStreaks } from '../util/dates.js';

const SLIDE_MS = 5000;

const GRADIENTS = [
  'linear-gradient(160deg,#7c5cff,#ff7aa2)',
  'linear-gradient(160deg,#0f2027,#2c5364)',
  'linear-gradient(160deg,#c33764,#1d2671)',
  'linear-gradient(160deg,#11998e,#38ef7d)',
  'linear-gradient(160deg,#f7971e,#dd2476)',
  'linear-gradient(160deg,#41295a,#2f0743)',
  'linear-gradient(160deg,#ff512f,#dd2476)',
  'linear-gradient(160deg,#1a2980,#26d0ce)',
];

export function openWrapped(year) {
  const list = store.entries().filter((e) => e.date.startsWith(String(year)));
  if (list.length < 3) {
    toast('Log a few more outfits first ✨');
    return;
  }
  const slides = buildSlides(year, list);

  let idx = 0;
  let timer = null;

  const progress = el('div', { class: 'wr-progress' }, slides.map(() =>
    el('i', { style: { '--wr-ms': `${SLIDE_MS}ms` } }, el('b'))));
  const stage = el('div', { class: 'wr-slide' });
  const closeBtn = el('button', { class: 'wr-close', 'aria-label': 'Close' }, icon('x'));

  const zoneL = el('button', { class: 'wr-zone l', 'aria-label': 'Previous' });
  const zoneR = el('button', { class: 'wr-zone r', 'aria-label': 'Next' });

  const root = el('div', { class: 'wrapped' }, progress, closeBtn, stage, zoneL, zoneR);
  const { close } = openOverlay(root, { variant: 'full', onClose: () => clearTimeout(timer) });

  function show(i) {
    clearTimeout(timer);
    if (i >= slides.length) return close();
    idx = Math.max(0, i);
    const slide = slides[idx];
    root.style.background = slide.bg;
    [...progress.children].forEach((seg, j) => {
      seg.classList.toggle('done', j < idx);
      seg.classList.remove('on');
      if (j === idx) {
        // Restart the fill animation even when revisiting the segment.
        void seg.offsetWidth;
        seg.classList.add('on');
      }
    });
    stage.replaceChildren(...slide.nodes());
    timer = setTimeout(() => show(idx + 1), SLIDE_MS);
  }

  closeBtn.addEventListener('click', close);
  zoneR.addEventListener('click', () => show(idx + 1));
  zoneL.addEventListener('click', () => show(idx - 1));
  show(0);
}

function buildSlides(year, list) {
  const slides = [];
  const bg = (i) => GRADIENTS[i % GRADIENTS.length];
  const add = (nodes) => slides.push({ bg: bg(slides.length), nodes });

  /* intro */
  add(() => [
    kicker('OutfitMemory'),
    big(`Wrapped ${year}`),
    sub('Your year, one outfit at a time.'),
  ]);

  /* total count */
  const perWeek = (list.length / 52).toFixed(1);
  add(() => [
    kicker('You showed up'),
    big(String(list.length)),
    sub(`outfits logged in ${year} — about ${perWeek} a week.`),
  ]);

  /* top month */
  const byMonth = new Map();
  for (const e of list) byMonth.set(e.date.slice(0, 7), (byMonth.get(e.date.slice(0, 7)) || 0) + 1);
  const [topM, topN] = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  add(() => [
    kicker('Peak style era'),
    big(fmtMonthYear(topM).split(' ')[0]),
    sub(`${topN} outfits — your most photographed month.`),
  ]);

  /* streak */
  const { longest } = computeStreaks(new Set(list.map((e) => e.date)));
  if (longest >= 3) {
    add(() => [
      kicker('Consistency'),
      big(`${longest} days`),
      sub('your longest daily streak. Respect. 🔥'),
    ]);
  }

  /* colors */
  const colorCounts = new Map();
  for (const e of list) for (const c of e.colors || []) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
  const topColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topColors.length) {
    add(() => [
      kicker('Your palette'),
      el('div', { class: 'wr-swatch-row' }, topColors.map(([name]) =>
        el('div', { class: 'wr-swatch' },
          el('i', { style: { background: NAME_HEX[name] || '#999' } }),
          el('span', { text: name })))),
      big(topColors[0][0]),
      sub('was the color of your year.'),
    ]);
  }

  /* favorites */
  const favs = list.filter((e) => e.favorite);
  if (favs.length) {
    add(() => [
      kicker('Certified hits'),
      big(String(favs.length)),
      sub(`outfit${favs.length === 1 ? '' : 's'} you loved enough to ❤️`),
      collage(favs.slice(0, 4)),
    ]);
  }

  /* collage */
  add(() => [
    kicker(`${year} in outfits`),
    collage(shuffle([...list]).slice(0, 12)),
    sub('Every one of these is a day you got dressed and showed up.'),
  ]);

  /* outro */
  add(() => [
    kicker('That’s a wrap'),
    big('Same time tomorrow?'),
    sub('Your future self loves scrolling this.'),
  ]);

  return slides;
}

/* ---------- slide pieces ---------- */

const kicker = (t) => el('div', { class: 'wr-kicker', text: t });
const big = (t) => el('div', { class: 'wr-big', text: t });
const sub = (t) => el('div', { class: 'wr-sub', text: t });

function collage(entries) {
  const grid = el('div', { class: 'wr-collage' });
  for (const e of entries) {
    const img = el('img', { alt: '' });
    store.thumbURL(e).then((u) => { if (u) img.src = u; });
    grid.append(img);
  }
  return grid;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
