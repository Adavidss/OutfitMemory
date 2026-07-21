/**
 * dates.js — date helpers. All entry dates are local-calendar strings
 * ("YYYY-MM-DD"); never UTC ISO dates, so a photo taken at 23:30 stays
 * on the day the user experienced.
 */

export const pad2 = (n) => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function nowTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Parse "YYYY-MM-DD" as a local Date (noon, to dodge DST edges). */
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** "July 21, 2026" (+ optional weekday). */
export function fmtLong(s, { weekday = false } = {}) {
  return parseDate(s).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    ...(weekday ? { weekday: 'long' } : {}),
  });
}

/** "July 2026" from a "YYYY-MM" key. */
export function fmtMonthYear(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 12).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function monthShort(m /* 1-12 */) {
  return new Date(2026, m - 1, 12).toLocaleDateString('en-US', { month: 'short' });
}

/** "Today" / "Yesterday" / "July 21, 2026". */
export function relDay(s) {
  if (s === todayStr()) return 'Today';
  if (s === addDays(todayStr(), -1)) return 'Yesterday';
  return fmtLong(s);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Streaks over a Set of date strings.
 * current: consecutive days ending today (or yesterday, so the streak
 * isn't "broken" before the user had a chance to log today).
 */
export function computeStreaks(dateSet) {
  let current = 0;
  let cursor = dateSet.has(todayStr()) ? todayStr() : addDays(todayStr(), -1);
  while (dateSet.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of [...dateSet].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  return { current, longest };
}
