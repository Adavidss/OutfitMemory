/**
 * dom.js — tiny DOM helpers: element builder, overlays, sheets,
 * confirm dialogs, toasts, haptics. No frameworks.
 *
 * CSP note: the app ships with style-src 'self', which blocks style=""
 * attributes in markup. Dynamic styling therefore always goes through
 * the CSSOM (element.style.prop = …), which `el({style:{…}})` does.
 */

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * el('div', {class:'card', text:'hi', on:{click:fn}}, child1, child2)
 * Special keys: class, text, html (trusted markup only), dataset,
 * style (object → CSSOM), on{event→handler}. `true` → bare attribute.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        p.startsWith('--') ? node.style.setProperty(p, val) : (node.style[p] = val);
      }
    } else if (k === 'on' && typeof v === 'object') {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    } else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  add(children);
  return node;
}

/**
 * Append children to an existing node, skipping null / undefined / false.
 *
 * The native `append()` stringifies anything that isn't a Node, so a
 * conditional child that evaluates to null renders the literal word
 * "null" on screen. `el()` already guards against this — use `mount()`
 * for any direct append whose arguments might be conditional.
 */
export function mount(parent, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    parent.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return parent;
}

/* ---------- Overlay stack (Esc / back handling) ---------- */

const stack = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    stack[stack.length - 1].close();
  }
});

/**
 * Open a full-viewport overlay layer. `variant`: 'sheet' | 'center' | 'full'.
 * Returns { root, close }. Clicking the scrim closes sheet/center overlays.
 */
export function openOverlay(content, { variant = 'sheet', onClose } = {}) {
  const layer = $('#layer');
  const root = el('div', { class: `overlay ${variant === 'sheet' ? '' : variant}`.trim() }, content);
  const entry = {
    close() {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      root.remove();
      onClose?.();
    },
  };
  if (variant !== 'full') {
    root.addEventListener('click', (e) => { if (e.target === root) entry.close(); });
  }
  stack.push(entry);
  layer.append(root);
  return { root, close: () => entry.close() };
}

/* ---------- Action sheet ---------- */

/**
 * sheet({title, body, actions:[{label, sub, icon, danger, onPick}]})
 * Resolves after an action is picked or the sheet is dismissed.
 */
export function sheet({ title, body, actions = [], cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const card = el('div', { class: 'sheet-card', role: 'dialog', 'aria-label': title || 'Menu' });
    card.append(el('div', { class: 'sheet-grip' }));
    if (title) card.append(el('div', { class: 'sheet-title', text: title }));
    if (body) card.append(el('div', { class: 'sheet-body', text: body }));
    const { close } = openOverlay(card, { onClose: () => resolve(null) });
    for (const a of actions) {
      const btn = el('button', { class: `sheet-btn${a.danger ? ' danger' : ''}` },
        a.icon ? icon(a.icon) : null,
        el('span', {},
          a.label,
          a.sub ? el('span', { class: 'sub', text: a.sub }) : null));
      // Resolve BEFORE close(): close() triggers onClose → resolve(null),
      // and a promise keeps its first resolution.
      btn.addEventListener('click', () => { resolve(a); close(); a.onPick?.(); });
      card.append(btn);
    }
    const cancel = el('button', { class: 'sheet-cancel', text: cancelLabel });
    cancel.addEventListener('click', () => close());
    card.append(cancel);
  });
}

/** Centered confirm dialog. Resolves true / false. */
export function confirmDialog({ title, body, okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: okLabel });
    const no = el('button', { class: 'btn', text: 'Cancel' });
    const card = el('div', { class: 'modal-card', role: 'alertdialog' },
      el('h3', { text: title }),
      body ? el('p', { text: body }) : null,
      el('div', { class: 'modal-actions' }, no, ok));
    const { close } = openOverlay(card, { variant: 'center', onClose: () => resolve(false) });
    ok.addEventListener('click', () => { resolve(true); close(); });
    no.addEventListener('click', () => { resolve(false); close(); });
  });
}

/* ---------- Toasts ---------- */

export function toast(msg, { ms = 2600 } = {}) {
  const t = el('div', { class: 'toast', role: 'status', text: msg });
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Toast with a tappable action button (e.g. "Backup due — Back up"). */
export function actionToast(msg, btnLabel, onClick, { ms = 12000 } = {}) {
  const btn = el('button', { class: 'toast-btn', text: btnLabel });
  const t = el('div', { class: 'toast toast-action', role: 'status' },
    el('span', { text: msg }), btn);
  btn.addEventListener('click', () => { t.remove(); onClick(); });
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
  return t;
}

/** Persistent toast for long operations. Returns {update, done}. */
export function progressToast(initial) {
  const t = el('div', { class: 'toast', role: 'status', text: initial });
  $('#toasts').append(t);
  return {
    update(msg) { t.textContent = msg; },
    done(msg, ms = 2200) {
      if (msg) t.textContent = msg;
      setTimeout(() => {
        t.classList.add('out');
        setTimeout(() => t.remove(), 300);
      }, ms);
    },
  };
}

/* ---------- Delight ---------- */

export function haptic(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

const CONFETTI_COLORS = ['#7c5cff', '#ff7aa2', '#ffd166', '#06d6a0', '#4cc9f0'];

/** Small celebratory burst (streak milestones). */
export function confetti(count = 16) {
  const box = el('div', { class: 'confetti' });
  for (let i = 0; i < count; i++) {
    box.append(el('i', {
      style: {
        '--dx': `${(Math.random() * 2 - 1) * 46}vw`,
        '--rot': `${Math.round(Math.random() * 720 - 360)}deg`,
        '--clr': CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        animationDelay: `${Math.random() * 0.25}s`,
        left: `${45 + Math.random() * 10}%`,
      },
    }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2100);
}
