/**
 * icons.js — inline SVG icon set (no icon fonts, no network).
 * All icons are 24×24 strokes using currentColor.
 */

const S = (paths, extra = '') =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const ICONS = {
  grid: S('<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>'),
  calendar: S('<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 2.8V7M16 2.8V7"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>'),
  chart: S('<path d="M4 20.5V14M10 20.5V9M16 20.5V4.5M4 20.5h17.5" /><path d="M22 20.5H2.5" opacity="0"/>'),
  settings: S('<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9" cy="16.5" r="2.2"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  camera: S('<path d="M4 8.2c0-1.2 1-2.2 2.2-2.2h1.4l1.2-1.8c.3-.4.7-.7 1.2-.7h4c.5 0 1 .3 1.2.7L16.4 6h1.4C19 6 20 7 20 8.2v8.6c0 1.2-1 2.2-2.2 2.2H6.2C5 19 4 18 4 16.8V8.2Z"/><circle cx="12" cy="12.4" r="3.4"/>'),
  cameraHeart: S('<path d="M4 8.2c0-1.2 1-2.2 2.2-2.2h1.4l1.2-1.8c.3-.4.7-.7 1.2-.7h4c.5 0 1 .3 1.2.7L16.4 6h1.4C19 6 20 7 20 8.2v8.6c0 1.2-1 2.2-2.2 2.2H6.2C5 19 4 18 4 16.8V8.2Z"/><path d="M12 15.4s-3-1.9-3-3.8c0-1 .8-1.8 1.7-1.8.6 0 1 .3 1.3.8.3-.5.7-.8 1.3-.8.9 0 1.7.8 1.7 1.8 0 1.9-3 3.8-3 3.8Z" fill="currentColor" stroke="none"/>'),
  image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4.5 17l4.5-4.5c.6-.6 1.5-.6 2.1 0L16 17.4M14 15.5l1.6-1.6c.6-.6 1.5-.6 2.1 0l2.4 2.3"/>'),
  heart: S('<path d="M12 20.2c-.3 0-.6-.1-.8-.3C7.7 17.4 3.5 14 3.5 9.9c0-2.6 2-4.6 4.4-4.6 1.6 0 3.1.8 4.1 2.3 1-1.5 2.5-2.3 4.1-2.3 2.4 0 4.4 2 4.4 4.6 0 4.1-4.2 7.5-7.7 10-.2.2-.5.3-.8.3Z"/>'),
  heartFill: S('<path d="M12 20.2c-.3 0-.6-.1-.8-.3C7.7 17.4 3.5 14 3.5 9.9c0-2.6 2-4.6 4.4-4.6 1.6 0 3.1.8 4.1 2.3 1-1.5 2.5-2.3 4.1-2.3 2.4 0 4.4 2 4.4 4.6 0 4.1-4.2 7.5-7.7 10-.2.2-.5.3-.8.3Z" fill="currentColor" stroke="none"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevL: S('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  chevR: S('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
  trash: S('<path d="M4.5 6.5h15M9.5 6V4.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1V6M6.3 6.5l.7 12c.1 1.1 1 2 2.1 2h5.8c1.1 0 2-.9 2.1-2l.7-12M10 10.5v6M14 10.5v6"/>'),
  share: S('<path d="M12 14.5V3.8M8.5 6.8L12 3.3l3.5 3.5"/><path d="M6.5 11H6c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2h-.5"/>'),
  download: S('<path d="M12 3.5v10.7M8.5 10.7L12 14.2l3.5-3.5"/><path d="M4 15.5v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3"/>'),
  upload: S('<path d="M12 14.2V3.5M8.5 7L12 3.5 15.5 7"/><path d="M4 15.5v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3"/>'),
  folder: S('<path d="M3.5 7c0-1.1.9-2 2-2h3.6c.6 0 1.2.3 1.6.8l1 1.2h7.8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-14c-1.1 0-2-.9-2-2V7Z"/>'),
  check: S('<path d="M4.5 12.5l5 5L19.5 6.5"/>'),
  search: S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  sparkles: S('<path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4Z"/><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2ZM5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" fill="currentColor" stroke="none"/>'),
  refresh: S('<path d="M20 12a8 8 0 1 1-2.5-5.8M20 3.5V7h-3.5"/>'),
  lock: S('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/>'),
  moon: S('<path d="M20 13.5A8.2 8.2 0 0 1 10.5 4 8.3 8.3 0 1 0 20 13.5Z"/>'),
  shuffle: S('<path d="M3.5 7h3.2c1.1 0 2.1.5 2.8 1.4l5 6.2c.7.9 1.7 1.4 2.8 1.4h3.2M17.5 13l3 3-3 3M3.5 16h3.2c1.1 0 2.1-.5 2.8-1.4l.9-1.1M17.5 4l3 3-3 3M20.5 7h-3.2c-1.1 0-2.1.5-2.8 1.4l-.9 1.1"/>'),
  info: S('<circle cx="12" cy="12" r="8.8"/><path d="M12 11v5.2"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>'),
  hanger: S('<path d="M12 8.2V7a2.1 2.1 0 1 1 2.6 2.05"/><path d="M12 8.2 3.7 15.1c-.9.7-.4 2.2.8 2.2h15c1.2 0 1.7-1.5.8-2.2L12 8.2Z"/>'),
  more: S('<circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none"/>'),
  tag: S('<path d="M11.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.4c0 .4-.2.8-.4 1l-8 8a1.5 1.5 0 0 1-2.1 0l-7.4-7.4a1.5 1.5 0 0 1 0-2.1l8-8c.3-.3.6-.4 1-.4Z"/><circle cx="16" cy="8" r="1.5"/>'),
  link: S('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.4"/>'),
  lockOpen: S('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 7.5-2"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/>'),
  palette: S('<path d="M12 21a9 9 0 1 1 9-9c0 2-1.3 3.2-3 3.2h-1.8c-1.4 0-2.2 1.4-1.4 2.6.8 1.2.2 3.2-2.8 3.2Z"/><circle cx="7.8" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.2" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>'),
};

/** Return a detached DOM node containing the requested icon. */
export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icn ${cls}`.trim();
  span.innerHTML = ICONS[name] || ICONS.info;
  const svg = span.firstElementChild;
  return svg || span;
}
