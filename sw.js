/* Terrain — service worker (offline support for the PWA)
   Strategy:
   - App shell (this page + icons + manifest): precached on install.
   - Navigations: network-first, fall back to the cached app shell when offline.
   - Other GETs (fonts, favicons, etc.): cache-first, then network, and cache
     the response for next time so the app looks right offline after first run.
   Bump CACHE when you change terrain.html so clients pick up the new version. */
const CACHE = 'terrain-v34';
const APP_SHELL = 'terrain.html';
const ASSETS = [
  APP_SHELL,
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Fetch each asset bypassing the HTTP cache so a freshly-installed version
    // never precaches a stale page. add()/default fetch can return an old copy
    // from the browser cache (a common cause of PWAs not updating on iOS).
    await Promise.allSettled(ASSETS.map(async a => {
      try { const res = await fetch(a, { cache: 'reload' }); if (res && (res.ok || res.type === 'opaque')) await cache.put(a, res); } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Never intercept Firebase / Google API traffic — it needs a live network
  // connection (auth, Firestore sync). Let the browser handle it directly.
  const url = new URL(req.url);
  if (/(^|\.)googleapis\.com$/.test(url.hostname) ||
      /(^|\.)firebaseio\.com$/.test(url.hostname) ||
      url.hostname === 'apis.google.com') return;

  // Navigations (opening/refreshing the app): try network, fall back to cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // Bypass the HTTP cache so we always get the newest page when online.
        const fresh = await fetch(req, { cache: 'reload' });
        const cache = await caches.open(CACHE);
        cache.put(APP_SHELL, fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match(APP_SHELL));
      }
    })());
    return;
  }

  // Everything else: cache-first, then network (and cache what comes back).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Cache successful same-origin and opaque cross-origin (fonts) responses.
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
