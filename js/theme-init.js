/**
 * theme-init.js — applies the saved theme before first paint to avoid a
 * light-mode flash. Loaded as a blocking classic script in <head>
 * (external file rather than inline so the CSP can stay `script-src 'self'`).
 */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('om.settings') || '{}');
    var t = s.theme || 'auto';
    if (t === 'auto') {
      t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* default light */ }
})();
