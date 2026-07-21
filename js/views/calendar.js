/**
 * calendar.js — month grid with outfit thumbnails in day cells.
 * Tapping a day: opens the outfit, lists multiple outfits, or offers to
 * back-fill an empty past day. Weeks start on Monday.
 */

import { store } from '../store.js';
import { el, sheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { pad2, todayStr, fmtMonthYear, relDay } from '../util/dates.js';
import { openDetail } from './detail.js';
import { openCapture } from './capture.js';

const now = new Date();
const cursor = { y: now.getFullYear(), m: now.getMonth() + 1 }; // survives re-renders

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function renderCalendar(container) {
  container.replaceChildren();

  const title = el('button', { class: 'cal-title', title: 'Jump to current month', text: fmtMonthYear(`${cursor.y}-${pad2(cursor.m)}`) });
  title.addEventListener('click', () => {
    const d = new Date();
    cursor.y = d.getFullYear();
    cursor.m = d.getMonth() + 1;
    renderCalendar(container);
  });

  const nav = (delta, name, label) => {
    const b = el('button', { class: 'icon-btn', 'aria-label': label }, icon(name));
    b.addEventListener('click', () => {
      cursor.m += delta;
      if (cursor.m < 1) { cursor.m = 12; cursor.y--; }
      if (cursor.m > 12) { cursor.m = 1; cursor.y++; }
      renderCalendar(container);
    });
    return b;
  };

  container.append(el('div', { class: 'cal-head' },
    title,
    el('div', { class: 'cal-nav' }, nav(-1, 'chevL', 'Previous month'), nav(1, 'chevR', 'Next month'))));

  container.append(el('div', { class: 'cal-dow' }, DOW.map((d) => el('span', { text: d }))));

  const grid = el('div', { class: 'cal-grid' });
  const first = new Date(cursor.y, cursor.m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.y, cursor.m, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < offset; i++) grid.append(el('div', { class: 'cal-cell blank' }));

  let monthCount = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${cursor.y}-${pad2(cursor.m)}-${pad2(day)}`;
    const dayEntries = store.entriesByDate(date);
    monthCount += dayEntries.length;
    const isFuture = date > today;

    const cell = el('button', {
      class: [
        'cal-cell',
        dayEntries.length ? 'has' : '',
        date === today ? 'today' : '',
        isFuture ? 'future' : '',
      ].filter(Boolean).join(' '),
      'aria-label': `${relDay(date)}${dayEntries.length ? `, ${dayEntries.length} outfit${dayEntries.length > 1 ? 's' : ''}` : ''}`,
    }, el('span', { class: 'cal-num', text: String(day) }));

    if (dayEntries.length) {
      const img = el('img', { alt: '' });
      store.thumbURL(dayEntries[0]).then((u) => { if (u) img.src = u; });
      cell.prepend(img);
      if (dayEntries.length > 1) cell.append(el('span', { class: 'cal-count', text: `×${dayEntries.length}` }));
    }

    cell.addEventListener('click', () => onDayTap(date, dayEntries));
    grid.append(cell);
  }
  container.append(grid);

  container.append(el('p', { class: 'cal-summary',
    text: monthCount
      ? `${monthCount} outfit${monthCount === 1 ? '' : 's'} in ${fmtMonthYear(`${cursor.y}-${pad2(cursor.m)}`)}`
      : 'No outfits this month yet.' }));
}

function onDayTap(date, dayEntries) {
  if (dayEntries.length === 1) return openDetail(dayEntries[0].id);
  if (dayEntries.length > 1) {
    sheet({
      title: relDay(date),
      actions: dayEntries.map((e, i) => ({
        label: `Outfit ${i + 1}${e.time ? ` · ${e.time}` : ''}`,
        sub: e.notes || undefined,
        icon: 'image',
        onPick: () => openDetail(e.id),
      })),
    });
    return;
  }
  // Empty past day → offer back-fill.
  sheet({
    title: relDay(date),
    body: 'No outfit recorded for this day.',
    actions: [{ label: 'Add an outfit for this day', icon: 'camera', onPick: () => openCapture({ date }) }],
  });
}
