/**
 * statsView.js — the dashboard: stat tiles, most-photographed month,
 * top colors, a 12-month bar chart, and the door into Wrapped.
 *
 * Chart notes: single series → single accent hue, no legend (the card
 * title names the series), thin rounded-top bars on a hairline baseline,
 * selective direct labels (peak only), native tooltips on every bar.
 */

import { store } from '../store.js';
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { NAME_HEX } from '../colors.js';
import { pad2, fmtMonthYear, monthShort, todayStr } from '../util/dates.js';
import { openWrapped } from './wrapped.js';

export function renderStats(container) {
  container.replaceChildren();
  container.append(el('h1', { class: 'view-title', text: 'Stats' }));

  const entries = store.entries();
  if (!entries.length) {
    container.append(el('div', { class: 'empty' },
      el('div', { class: 'empty-art' }, icon('chart')),
      el('h2', { text: 'No numbers yet' }),
      el('p', { text: 'Save a few outfits and this page starts telling your story.' })));
    return;
  }

  const today = todayStr();
  const thisYear = today.slice(0, 4);
  const thisMonth = today.slice(0, 7);
  const { current, longest } = store.streaks();
  const favorites = entries.filter((e) => e.favorite).length;

  const tiles = [
    [entries.length, 'Outfits recorded'],
    [entries.filter((e) => e.date.startsWith(thisYear)).length, `In ${thisYear}`],
    [entries.filter((e) => e.date.startsWith(thisMonth)).length, 'This month'],
    [current, 'Current streak', 'days'],
    [longest, 'Longest streak', 'days'],
    [favorites, 'Favorites'],
  ];
  container.append(el('div', { class: 'tile-grid' },
    tiles.map(([v, label, unit]) => el('div', { class: 'tile' },
      el('div', { class: 'tile-value' }, String(v), unit ? el('small', { text: ` ${unit}` }) : null),
      el('div', { class: 'tile-label', text: label })))));

  const cards = el('div', { class: 'stat-cards' });
  container.append(cards);

  /* --- most photographed month (all-time) --- */
  const byMonth = countBy(entries, (e) => e.date.slice(0, 7));
  const [topMonth, topMonthN] = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  const byDow = countBy(entries, (e) => new Date(e.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }));
  const [topDow] = [...byDow.entries()].sort((a, b) => b[1] - a[1])[0];
  cards.append(el('div', { class: 'card' },
    el('div', { class: 'stat-card-title', text: 'Records' }),
    el('div', { class: 'swatches' },
      recordRow('calendar', 'Most photographed month', `${fmtMonthYear(topMonth)} · ${topMonthN}`),
      recordRow('sparkles', 'Busiest day of the week', topDow))));

  /* --- top colors --- */
  const colorCounts = countBy(entries.flatMap((e) => e.colors || []), (c) => c);
  const topColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (topColors.length) {
    cards.append(el('div', { class: 'card' },
      el('div', { class: 'stat-card-title', text: 'Your most-worn colors' }),
      el('div', { class: 'swatches' },
        topColors.map(([name, n]) => el('div', { class: 'swatch' },
          el('i', { style: { background: NAME_HEX[name] || '#999' } }),
          el('span', {}, el('b', { text: name }), ' ', el('span', { text: `×${n}` })))))));
  }

  /* --- last 12 months bar chart --- */
  cards.append(monthChart(byMonth));

  /* --- Wrapped CTA --- */
  const years = [...new Set(entries.map((e) => e.date.slice(0, 4)))].sort().reverse()
    .filter((y) => entries.filter((e) => e.date.startsWith(y)).length >= 3);
  if (years.length) {
    cards.append(el('div', { class: 'wrapped-cta' },
      el('h3', { text: 'OutfitMemory Wrapped' }),
      el('p', { text: 'Your year in outfits — big numbers, big feelings.' }),
      el('div', { class: 'year-chips' }, years.map((y) => {
        const chip = el('button', { class: 'year-chip', text: y });
        chip.addEventListener('click', () => openWrapped(y));
        return chip;
      }))));
  }
}

function recordRow(icn, label, value) {
  return el('div', { class: 'swatch' },
    icon(icn),
    el('span', {}, el('b', { text: value }), ' ', el('span', { text: label })));
}

function countBy(list, keyFn) {
  const m = new Map();
  for (const item of list) {
    const k = keyFn(item);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** Vertical bars for the last 12 calendar months. */
function monthChart(byMonth) {
  const months = [];
  const d = new Date();
  d.setDate(12);
  for (let i = 11; i >= 0; i--) {
    const dd = new Date(d.getFullYear(), d.getMonth() - i, 12);
    months.push({ key: `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}`, m: dd.getMonth() + 1 });
  }
  const values = months.map((m) => byMonth.get(m.key) || 0);
  const max = Math.max(...values, 1);
  const peakIdx = values.indexOf(Math.max(...values));

  const chart = el('div', { class: 'barchart', role: 'img',
    'aria-label': `Outfits per month, last 12 months. Peak: ${values[peakIdx]} in ${fmtMonthYear(months[peakIdx].key)}.` });
  months.forEach((m, i) => {
    const v = values[i];
    const bar = el('div', {
      class: `bar${v === 0 ? ' zero' : ''}`,
      style: { height: `${v === 0 ? 3 : Math.max(6, Math.round((v / max) * 72))}px` },
    });
    const col = el('div', { class: 'bar-col', title: `${fmtMonthYear(m.key)} — ${v} outfit${v === 1 ? '' : 's'}` },
      v > 0 && i === peakIdx ? el('span', { class: 'bar-v', text: String(v) }) : null,
      bar);
    chart.append(col);
  });

  return el('div', { class: 'card' },
    el('div', { class: 'stat-card-title', text: 'Outfits per month · last 12 months' }),
    chart,
    el('div', { class: 'bar-labels' }, months.map((m) => el('span', { text: monthShort(m.m)[0] }))));
}
