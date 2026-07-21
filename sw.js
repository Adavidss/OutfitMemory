/**
 * sw.js — offline support for OutfitMemory.
 *
 * Cache-first for the app shell: every asset is same-origin and versioned
 * by CACHE below (bump it on any deploy that changes files). User photos
 * are NOT here — they live in the user's folder / IndexedDB and never
 * touch the network at all.
 */

const CACHE = 'outfitmemory-v3';

// On localhost, serve network-first so local development always sees fresh
// files (cache still works as an offline fallback). Production stays
// cache-first for instant loads.
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/components.css',
  './css/themes.css',
  './js/theme-init.js',
  './js/app.js',
  './js/store.js',
  './js/backup.js',
  './js/shareCard.js',
  './js/imagePipeline.js',
  './js/colors.js',
  './js/ui/dom.js',
  './js/ui/icons.js',
  './js/util/dates.js',
  './js/util/idb.js',
  './js/util/zip.js',
  './js/storage/folderStorage.js',
  './js/storage/browserStorage.js',
  './js/views/onboarding.js',
  './js/views/gallery.js',
  './js/views/calendar.js',
  './js/views/statsView.js',
  './js/views/wrapped.js',
  './js/views/detail.js',
  './js/views/capture.js',
  './js/views/settingsView.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // CSP blocks these anyway

  if (DEV) {
    // no-store also bypasses the HTTP heuristic cache, so edits show up
    // on plain reload even under python -m http.server (no Cache-Control).
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() =>
        caches.match(request).then((hit) => hit || caches.match('./index.html'))
      )
    );
    return;
  }

  // Navigations always resolve to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          // Opportunistically cache same-origin fetches (e.g. new assets
          // after a deploy) so the next offline visit has them.
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
    )
  );
});
